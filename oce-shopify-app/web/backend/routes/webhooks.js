/**
 * Shopify Order Webhook Handler
 * Receives order/create webhooks from Shopify and forwards to OCE REST API
 */

import { PrismaClient } from "@prisma/client";
import { OceApiService } from "../services/oce-api.js";

const prisma = new PrismaClient();

/**
 * Process a Shopify orders/create webhook
 * Extracts order data and sends it to the OCE API for attribution
 */
export async function handleOrderCreated(shop, orderData) {
  const shopifyOrderId = String(orderData.id);

  console.log(`[OCE] Processing order ${shopifyOrderId} for shop ${shop}`);

  // 1. Get merchant's OCE settings
  const settings = await prisma.oceSettings.findUnique({ where: { shop } });

  if (!settings || !settings.apiKey || !settings.webhookEnabled) {
    console.log(`[OCE] Skipping order — webhook disabled or no API key for ${shop}`);
    return { status: "skipped", reason: "not_configured" };
  }

  // 2. Check if order already processed
  const existing = await prisma.orderSync.findUnique({
    where: { shop_shopifyOrderId: { shop, shopifyOrderId } },
  });

  if (existing && existing.status === "sent") {
    console.log(`[OCE] Order ${shopifyOrderId} already processed`);
    return { status: "skipped", reason: "already_processed" };
  }

  // 3. Create/update sync record
  const syncRecord = await prisma.orderSync.upsert({
    where: { shop_shopifyOrderId: { shop, shopifyOrderId } },
    create: {
      shop,
      shopifyOrderId,
      status: "pending",
      totalAmount: parseFloat(orderData.total_price),
    },
    update: {
      status: "pending",
      totalAmount: parseFloat(orderData.total_price),
    },
  });

  // 4. Extract exposure IDs from order note attributes or cart attributes
  const exposureIds = extractExposureIds(orderData);

  // 5. Build line items
  const lineItems = (orderData.line_items || []).map((item) => ({
    sku: item.sku || "",
    productId: String(item.product_id),
    variantId: String(item.variant_id),
    title: item.title,
    quantity: item.quantity,
    price: parseFloat(item.price),
  }));

  // 6. Send to OCE API
  const oceApi = new OceApiService(settings.apiKey);

  try {
    const result = await oceApi.sendOrder({
      orderId: shopifyOrderId,
      exposureIds,
      lineItems,
      totalAmount: parseFloat(orderData.total_price),
      currency: orderData.currency,
      customerEmail: orderData.email || orderData.customer?.email,
    });

    // 7. Update sync record with success
    await prisma.orderSync.update({
      where: { id: syncRecord.id },
      data: {
        status: "sent",
        oceOrderId: result?.order_id || null,
        exposureIds: JSON.stringify(exposureIds),
        commission: result?.commission || null,
      },
    });

    console.log(`[OCE] Order ${shopifyOrderId} sent successfully`);
    return { status: "sent", oceOrderId: result?.order_id };
  } catch (error) {
    // 8. Update sync record with failure
    await prisma.orderSync.update({
      where: { id: syncRecord.id },
      data: {
        status: "failed",
        errorMessage: error.message,
      },
    });

    console.error(`[OCE] Failed to send order ${shopifyOrderId}:`, error.message);
    return { status: "failed", error: error.message };
  }
}

/**
 * Extract OCE exposure IDs from Shopify order data
 * The OCE SDK stores exposure IDs in cart attributes during checkout
 */
function extractExposureIds(orderData) {
  const exposureIds = [];

  // Check note_attributes (set by cart attributes)
  const noteAttributes = orderData.note_attributes || [];
  for (const attr of noteAttributes) {
    if (attr.name === "_oce_exposure_ids" || attr.name === "oce_exposure_ids") {
      try {
        const ids = JSON.parse(attr.value);
        if (Array.isArray(ids)) exposureIds.push(...ids);
      } catch {
        // If not JSON, treat as comma-separated
        exposureIds.push(...attr.value.split(",").map((s) => s.trim()).filter(Boolean));
      }
    }
    if (attr.name === "_oce_exposure_id" || attr.name === "oce_exposure_id") {
      exposureIds.push(attr.value);
    }
  }

  // Check custom attributes on line items
  for (const item of orderData.line_items || []) {
    for (const prop of item.properties || []) {
      if (prop.name === "_oce_exposure_id") {
        exposureIds.push(prop.value);
      }
    }
  }

  return [...new Set(exposureIds)]; // Deduplicate
}

export default handleOrderCreated;
