/**
 * Settings API Routes
 * CRUD operations for merchant OCE settings
 */

import { PrismaClient } from "@prisma/client";
import { OceApiService } from "../services/oce-api.js";

const prisma = new PrismaClient();

/**
 * GET /api/settings
 * Retrieve current merchant OCE settings
 */
export async function getSettings(shop) {
  let settings = await prisma.oceSettings.findUnique({ where: { shop } });

  if (!settings) {
    // Create default settings for new merchants
    settings = await prisma.oceSettings.create({
      data: {
        shop,
        apiKey: "",
        sdkEnabled: true,
        webhookEnabled: true,
        attributionModel: "last-touch",
        attributionWindow: 30,
        commissionRate: 10.0,
        trackImpressions: true,
        trackClicks: true,
        trackWatchProgress: true,
        minWatchPercent: 25,
      },
    });
  }

  // Mask API key for frontend display
  const maskedKey = settings.apiKey
    ? settings.apiKey.slice(0, 8) + "•".repeat(24) + settings.apiKey.slice(-4)
    : "";

  return {
    ...settings,
    apiKey: maskedKey,
    hasApiKey: !!settings.apiKey,
  };
}

/**
 * PUT /api/settings
 * Update merchant OCE settings
 */
export async function updateSettings(shop, updates) {
  const allowedFields = [
    "sdkEnabled",
    "webhookEnabled",
    "attributionModel",
    "attributionWindow",
    "commissionRate",
    "trackImpressions",
    "trackClicks",
    "trackWatchProgress",
    "minWatchPercent",
  ];

  // Filter to allowed fields only
  const data = {};
  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      data[field] = updates[field];
    }
  }

  const settings = await prisma.oceSettings.upsert({
    where: { shop },
    create: { shop, ...data },
    update: data,
  });

  return settings;
}

/**
 * PUT /api/settings/api-key
 * Update the OCE API key
 */
export async function updateApiKey(shop, apiKey) {
  await prisma.oceSettings.upsert({
    where: { shop },
    create: { shop, apiKey },
    update: { apiKey },
  });

  return { success: true, message: "API key saved successfully." };
}

/**
 * GET /api/settings/status
 * Get integration health status
 */
export async function getIntegrationStatus(shop) {
  const settings = await prisma.oceSettings.findUnique({ where: { shop } });

  if (!settings || !settings.apiKey) {
    return {
      overall: "not_configured",
      sdk: { status: "inactive", message: "API key required" },
      webhook: { status: "inactive", message: "API key required" },
      apiConnection: { status: "inactive", message: "No API key set" },
    };
  }

  // Test API connection
  const oceApi = new OceApiService(settings.apiKey);
  const apiCheck = await oceApi.validateApiKey();

  // Check recent order syncs
  const recentSyncs = await prisma.orderSync.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  const failedRecent = recentSyncs.filter((s) => s.status === "failed").length;
  const totalRecent = recentSyncs.length;

  return {
    overall: apiCheck.valid ? "healthy" : "error",
    sdk: {
      status: settings.sdkEnabled ? "active" : "disabled",
      message: settings.sdkEnabled
        ? "OCE SDK is injected into your storefront"
        : "SDK injection is disabled",
    },
    webhook: {
      status: settings.webhookEnabled ? "active" : "disabled",
      message: settings.webhookEnabled
        ? `${totalRecent} recent orders processed, ${failedRecent} failed`
        : "Order webhook is disabled",
    },
    apiConnection: {
      status: apiCheck.valid ? "connected" : "error",
      message: apiCheck.valid
        ? "Connected to OCE API"
        : `Connection failed: ${apiCheck.error}`,
    },
    recentOrders: recentSyncs.slice(0, 5),
  };
}

/**
 * Sync OCE settings to Shopify app metafields.
 * The theme app extension reads from app.metafields.oce.* — this function
 * writes those values via the GraphQL Admin API so the Liquid template
 * can inject the SDK script tag.
 */
export async function syncAppMetafields(shop, accessToken) {
  const settings = await prisma.oceSettings.findUnique({ where: { shop } });
  if (!settings) {
    console.error("[OCE] syncAppMetafields: no settings for", shop);
    return { success: false, error: "No settings found" };
  }

  const apiVersion = "2024-10";
  const graphqlUrl = `https://${shop}/admin/api/${apiVersion}/graphql.json`;
  const headers = {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token": accessToken,
  };

  // Step 1: Get the current app installation ID (owner for app metafields)
  let ownerId;
  try {
    const installRes = await fetch(graphqlUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: `{ currentAppInstallation { id } }`,
      }),
    });
    const installData = await installRes.json();
    ownerId = installData?.data?.currentAppInstallation?.id;
  } catch (err) {
    console.error("[OCE] Failed to fetch app installation ID:", err.message);
    return { success: false, error: "Could not reach Shopify API" };
  }

  if (!ownerId) {
    console.error("[OCE] No app installation ID returned");
    return { success: false, error: "Could not get app installation ID" };
  }

  // Step 2: Write both metafields the Liquid template expects
  const metafields = [
    {
      namespace: "oce",
      key: "api_key",
      type: "single_line_text_field",
      value: settings.apiKey || "",
      ownerId,
    },
    {
      namespace: "oce",
      key: "sdk_enabled",
      type: "single_line_text_field",
      value: String(settings.sdkEnabled),
      ownerId,
    },
  ];

  try {
    const setRes = await fetch(graphqlUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: `mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id namespace key }
            userErrors { field message }
          }
        }`,
        variables: { metafields },
      }),
    });
    const setData = await setRes.json();
    const userErrors = setData?.data?.metafieldsSet?.userErrors;

    if (userErrors && userErrors.length > 0) {
      console.error("[OCE] Metafield sync errors:", userErrors);
      return { success: false, error: userErrors[0].message };
    }

    console.log("[OCE] App metafields synced for", shop);
    return { success: true };
  } catch (err) {
    console.error("[OCE] Metafield sync fetch failed:", err.message);
    return { success: false, error: err.message };
  }
}

export default { getSettings, updateSettings, updateApiKey, getIntegrationStatus, syncAppMetafields };
