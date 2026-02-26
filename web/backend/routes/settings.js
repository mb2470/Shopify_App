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
  console.log("[OCE] syncAppMetafields called for", shop, "token present:", !!accessToken);

  if (!accessToken) {
    console.error("[OCE] syncAppMetafields: no access token for", shop);
    return { success: false, error: "No access token" };
  }

  const settings = await prisma.oceSettings.findUnique({ where: { shop } });
  if (!settings) {
    console.error("[OCE] syncAppMetafields: no settings for", shop);
    return { success: false, error: "No settings found" };
  }

  console.log("[OCE] Settings loaded — apiKey length:", (settings.apiKey || "").length, "sdkEnabled:", settings.sdkEnabled);

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
    console.log("[OCE] AppInstallation response:", JSON.stringify(installData));
    ownerId = installData?.data?.currentAppInstallation?.id;
  } catch (err) {
    console.error("[OCE] Failed to fetch app installation ID:", err.message);
    return { success: false, error: "Could not reach Shopify API: " + err.message };
  }

  if (!ownerId) {
    console.error("[OCE] No app installation ID returned");
    return { success: false, error: "Could not get app installation ID" };
  }

  console.log("[OCE] AppInstallation ID:", ownerId);

  // Step 2: Ensure metafield definitions exist with storefront access
  // This is required for app.metafields.oce.* to be readable in Liquid
  await ensureMetafieldDefinitions(graphqlUrl, headers);

  // Step 3: Write both metafields the Liquid template expects
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
            metafields { id namespace key value }
            userErrors { field message }
          }
        }`,
        variables: { metafields },
      }),
    });
    const setData = await setRes.json();
    console.log("[OCE] metafieldsSet response:", JSON.stringify(setData));

    if (setData.errors) {
      console.error("[OCE] GraphQL errors:", JSON.stringify(setData.errors));
      return { success: false, error: setData.errors[0]?.message || "GraphQL error" };
    }

    const userErrors = setData?.data?.metafieldsSet?.userErrors;
    if (userErrors && userErrors.length > 0) {
      console.error("[OCE] Metafield sync user errors:", JSON.stringify(userErrors));
      return { success: false, error: userErrors[0].message };
    }

    const written = setData?.data?.metafieldsSet?.metafields || [];
    console.log("[OCE] App metafields synced for", shop, "— wrote", written.length, "metafields");
    return { success: true, metafields: written };
  } catch (err) {
    console.error("[OCE] Metafield sync fetch failed:", err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Ensure metafield definitions exist with PUBLIC_READ storefront access.
 * Without definitions, app metafields may not be accessible in Liquid.
 * Idempotent — silently ignores "already exists" errors.
 */
async function ensureMetafieldDefinitions(graphqlUrl, headers) {
  const definitions = [
    { name: "OCE API Key", namespace: "oce", key: "api_key" },
    { name: "OCE SDK Enabled", namespace: "oce", key: "sdk_enabled" },
  ];

  for (const def of definitions) {
    try {
      const res = await fetch(graphqlUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          query: `mutation CreateMetafieldDef($definition: MetafieldDefinitionInput!) {
            metafieldDefinitionCreate(definition: $definition) {
              createdDefinition { id }
              userErrors { field message code }
            }
          }`,
          variables: {
            definition: {
              name: def.name,
              namespace: def.namespace,
              key: def.key,
              type: "single_line_text_field",
              ownerType: "APP_INSTALLATION",
              access: {
                storefront: "PUBLIC_READ",
              },
            },
          },
        }),
      });
      const data = await res.json();
      const errors = data?.data?.metafieldDefinitionCreate?.userErrors || [];
      if (errors.length > 0 && !errors[0].message?.includes("already exists")) {
        console.warn("[OCE] Metafield definition warning for", def.key, ":", errors[0].message);
      } else if (data?.data?.metafieldDefinitionCreate?.createdDefinition) {
        console.log("[OCE] Created metafield definition:", def.namespace + "." + def.key);
      }
    } catch (err) {
      console.warn("[OCE] Could not create metafield definition for", def.key, ":", err.message);
    }
  }
}

/**
 * Read current app metafields for diagnostic purposes.
 */
export async function getAppMetafields(shop, accessToken) {
  if (!accessToken) {
    return { success: false, error: "No access token" };
  }

  const apiVersion = "2024-10";
  const graphqlUrl = `https://${shop}/admin/api/${apiVersion}/graphql.json`;

  try {
    const res = await fetch(graphqlUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query: `{
          currentAppInstallation {
            id
            metafields(first: 10) {
              edges {
                node {
                  namespace
                  key
                  value
                  type
                }
              }
            }
          }
        }`,
      }),
    });
    const data = await res.json();
    const metafields = data?.data?.currentAppInstallation?.metafields?.edges?.map(e => e.node) || [];
    return { success: true, metafields, raw: data };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export default { getSettings, updateSettings, updateApiKey, getIntegrationStatus, syncAppMetafields, getAppMetafields };
