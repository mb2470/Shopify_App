/**
 * OCE Shopify App — Remix Server Entry
 * Main server that handles:
 *  - Shopify OAuth & session management
 *  - Admin API routes (settings, video assets, reports)
 *  - Webhook processing (orders/create → OCE)
 *  - Script tag injection management
 */

import { json } from "@remix-run/node";
import { shopifyApp } from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { PrismaClient } from "@prisma/client";
import { handleOrderCreated } from "./backend/routes/webhooks.js";

const prisma = new PrismaClient();

// ─── Shopify App Setup ────────────────────────────────────────────

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: ["read_orders", "write_script_tags", "read_products", "read_customers"],
  appUrl: process.env.SHOPIFY_APP_URL || "https://shopify-app-q4bw.onrender.com",
  sessionStorage: new PrismaSessionStorage(prisma),
  webhooks: {
    ORDERS_CREATE: {
      deliveryMethod: "http",
      callbackUrl: "/webhooks/orders/create",
    },
    APP_UNINSTALLED: {
      deliveryMethod: "http",
      callbackUrl: "/webhooks/app/uninstalled",
    },
  },
  hooks: {
    afterAuth: async ({ session }) => {
      // Register webhooks after successful auth
      await shopify.registerWebhooks({ session });

      // Inject OCE script tag if merchant has it enabled
      await ensureScriptTag(session);
    },
  },
});

// ─── Script Tag Management ────────────────────────────────────────

async function ensureScriptTag(session) {
  const settings = await prisma.oceSettings.findUnique({
    where: { shop: session.shop },
  });

  if (!settings?.sdkEnabled || !settings?.apiKey) return;

  const client = new shopify.api.clients.Rest({ session });

  // Check existing script tags
  const { body: existing } = await client.get({ path: "script_tags" });
  const oceTag = existing.script_tags?.find((tag) =>
    tag.src.includes("onsiteaffiliate.com/sdk/oce.min.js")
  );

  if (!oceTag) {
    // Create the script tag
    await client.post({
      path: "script_tags",
      data: {
        script_tag: {
          event: "onload",
          src: `https://app.onsiteaffiliate.com/sdk/oce.min.js?key=${settings.apiKey}`,
          display_scope: "online_store",
        },
      },
    });
    console.log(`[OCE] Script tag injected for ${session.shop}`);
  }
}

// ─── Webhook Handlers ─────────────────────────────────────────────

export async function webhookOrdersCreate(topic, shop, body) {
  const orderData = JSON.parse(body);
  return handleOrderCreated(shop, orderData);
}

export async function webhookAppUninstalled(topic, shop) {
  // Clean up merchant data on uninstall
  console.log(`[OCE] App uninstalled from ${shop}`);

  await prisma.oceSettings.deleteMany({ where: { shop } });
  await prisma.orderSync.deleteMany({ where: { shop } });
  await prisma.videoAsset.deleteMany({ where: { shop } });
  await prisma.session.deleteMany({ where: { shop } });
}

export { shopify, prisma };
export default shopify;
