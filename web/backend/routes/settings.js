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
        interceptAttribution: true,
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
    "interceptAttribution",
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

  // Step 3: Write metafields the Liquid template expects (api_key, sdk_enabled, intercept_attribution)
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
    {
      namespace: "oce",
      key: "intercept_attribution",
      type: "single_line_text_field",
      value: String(settings.interceptAttribution !== false),
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
    { name: "OCE Intercept Attribution", namespace: "oce", key: "intercept_attribution" },
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

/**
 * GET /api/stats
 * Fetch stats overview from the OCE Management API
 */
export async function getStatsOverview(shop, periodDays = 30) {
  const settings = await prisma.oceSettings.findUnique({ where: { shop } });
  if (!settings || !settings.apiKey) {
    return { ok: false, error: "API key not configured" };
  }
  const oceApi = new OceApiService(settings.apiKey);
  return oceApi.getStats(periodDays);
}

/**
 * GET /api/creators
 * Fetch creators from OCE via the management API
 */
export async function getCreators(shop) {
  const settings = await prisma.oceSettings.findUnique({ where: { shop } });
  if (!settings?.apiKey) {
    return { ok: false, error: "API key not configured", creators: [] };
  }
  const oceApi = new OceApiService(settings.apiKey);
  const result = await oceApi.manage("creators.list", {});
  const creators = result?.data?.creators || result?.data || [];
  return { ok: true, creators: Array.isArray(creators) ? creators : [] };
}

/**
 * POST /api/assets/register
 * Register one or more assets with OCE and store locally
 */
export async function registerAssets(shop, assets) {
  const settings = await prisma.oceSettings.findUnique({ where: { shop } });
  if (!settings?.apiKey) {
    return { ok: false, error: "API key not configured" };
  }
  const oceApi = new OceApiService(settings.apiKey);

  const results = [];
  for (const asset of assets) {
    try {
      // Send only fields the OCE /assets-upsert API accepts
      const body = {
        asset_id: asset.asset_id,
        title: asset.title,
        skus: asset.skus || [],
      };
      if (asset.creator_id) body.creator_external_id = asset.creator_id;
      if (asset.creator_name) body.creator_name = asset.creator_name;
      const result = await oceApi.upsertAssets([body]);
      results.push({ asset_id: asset.asset_id, ok: true, result });

      // Store in local DB
      await prisma.videoAsset.upsert({
        where: { shop_assetId: { shop, assetId: asset.asset_id } },
        create: {
          shop,
          assetId: asset.asset_id,
          title: asset.title,
          creatorName: asset.creator_name,
          creatorId: asset.creator_id,
          skus: JSON.stringify(asset.skus || []),
          videoUrl: asset.source,
          platform: asset.metadata?.platform || "shopify",
          isActive: true,
        },
        update: {
          title: asset.title,
          creatorName: asset.creator_name,
          creatorId: asset.creator_id,
          skus: JSON.stringify(asset.skus || []),
          videoUrl: asset.source,
          isActive: true,
        },
      });
    } catch (err) {
      const detail = err.responseBody || "";
      console.error("[OCE] Asset registration failed for", asset.asset_id, ":", err.message, detail);
      results.push({ asset_id: asset.asset_id, ok: false, error: err.message + (detail ? " — " + detail : "") });
    }
  }

  const succeeded = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  return { ok: failed === 0, results, succeeded, failed };
}

/**
 * Get registered assets for a shop from local DB
 */
export async function getRegisteredAssets(shop) {
  return prisma.videoAsset.findMany({
    where: { shop, isActive: true },
    orderBy: { updatedAt: "desc" },
  });
}

/**
 * Discover videos tracked by the OCE SDK via the events.list management API.
 * Extracts unique asset_ids from exposure events and aggregates metadata.
 */
export async function getDiscoveredVideos(shop) {
  const settings = await prisma.oceSettings.findUnique({ where: { shop } });
  if (!settings?.apiKey) {
    return { ok: false, error: "API key not configured", videos: [] };
  }
  const oceApi = new OceApiService(settings.apiKey);

  try {
    const result = await oceApi.manage("events.list", { limit: 500 });
    const rawData = result?.data;
    // events.list may return { events: [...] } or an array directly
    const events = Array.isArray(rawData) ? rawData : (rawData?.events || rawData?.items || []);

    // Aggregate unique asset_ids from events
    const assetMap = {};
    for (const event of (Array.isArray(events) ? events : [])) {
      const aid = event.asset_id || event.assetId;
      if (!aid) continue;
      if (!assetMap[aid]) {
        assetMap[aid] = {
          assetId: aid,
          title: event.asset_title || event.title || null,
          skus: new Set(),
          exposureCount: 0,
          source: event.source_url || event.video_url || event.source || null,
          thumbnail: event.thumbnail_url || event.thumbnail || null,
          lastSeen: null,
        };
      }
      assetMap[aid].exposureCount++;
      if (event.sku) assetMap[aid].skus.add(event.sku);
      const ts = event.created_at || event.ts || event.timestamp;
      if (ts && (!assetMap[aid].lastSeen || ts > assetMap[aid].lastSeen)) {
        assetMap[aid].lastSeen = ts;
      }
    }

    const videos = Object.values(assetMap).map(v => ({
      ...v,
      skus: Array.from(v.skus),
    }));

    console.log("[OCE] getDiscoveredVideos:", videos.length, "unique videos from", events.length, "events");
    return { ok: true, videos };
  } catch (err) {
    console.error("[OCE] getDiscoveredVideos error:", err.message);
    return { ok: false, error: err.message, videos: [] };
  }
}

/**
 * Default creator portal copy — used when no custom content is saved.
 */
export const DEFAULT_PORTAL_CONTENT = {
  pageTitle: "Join {store} as an Onsite Creator",
  pageSubtitle: "Upload engaging video content about our products and if we place it on our site you can earn commissions on every sale that your videos help drive.",
  pageSubtitle2: "Log back in here to track your performance and get paid your commissions.",
  benefit1Title: "Upload Your Content",
  benefit1Desc: "Share your product videos and we will track every view, click, and engagement.",
  benefit2Title: "Real-Time Analytics",
  benefit2Desc: "See exactly how your video content performs with detailed attribution insights.",
  benefit3Title: "Earn Commissions",
  benefit3Desc: "Get paid for every sale attributed to your content. Transparent payouts, always.",
  termsHeading: "Key Terms Summary",
  term1Icon: "\ud83d\udcc4",
  term1Text: "You retain ownership of your video content. You grant us a license to sublicense for ecommerce placements.",
  term2Icon: "$",
  term2Text: "Commission rates and tracking terms are displayed on your Dashboard.",
  term3Icon: "\ud83d\udc41",
  term3Text: "Onsite placements are not guaranteed. {store} will exclusively decide which video content appears on their site.",
  term4Icon: "\u23f1",
  term4Text: "30-day removal window: After you remove a video from your Dashboard, {store} will remove it from their site within 30 days.",
  signupCardTitle: "Create Your Account",
  signupCardSubtitle: "Start earning in minutes",
  dashboardTitle: "Creator Dashboard",
  submitVideoTitle: "Submit a Video",
  yourVideosTitle: "Your Videos",
  showBenefits: true,
  showTerms: true,
  customCSS: "",
};

/**
 * GET /api/portal-content
 * Retrieve editable portal copy for a shop
 */
export async function getPortalContent(shop) {
  const settings = await prisma.oceSettings.findUnique({ where: { shop } });
  if (!settings) return { ...DEFAULT_PORTAL_CONTENT };
  try {
    const saved = JSON.parse(settings.portalContent || "{}");
    return { ...DEFAULT_PORTAL_CONTENT, ...saved };
  } catch {
    return { ...DEFAULT_PORTAL_CONTENT };
  }
}

/**
 * PUT /api/portal-content
 * Save editable portal copy for a shop
 */
export async function savePortalContent(shop, content) {
  const merged = { ...DEFAULT_PORTAL_CONTENT, ...content };
  await prisma.oceSettings.upsert({
    where: { shop },
    create: { shop, portalContent: JSON.stringify(merged) },
    update: { portalContent: JSON.stringify(merged) },
  });
  return { success: true, content: merged };
}

export default {
  getSettings, updateSettings, updateApiKey, getIntegrationStatus,
  syncAppMetafields, getAppMetafields, getStatsOverview,
  getCreators, registerAssets, getRegisteredAssets, getDiscoveredVideos,
  getPortalContent, savePortalContent, DEFAULT_PORTAL_CONTENT,
};
