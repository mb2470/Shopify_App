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
 * Update and validate the OCE API key
 */
export async function updateApiKey(shop, apiKey) {
  // Validate the key with OCE
  const oceApi = new OceApiService(apiKey);
  const validation = await oceApi.validateApiKey();

  if (!validation.valid) {
    return {
      success: false,
      error: "Invalid API key. Please check your key and try again.",
    };
  }

  await prisma.oceSettings.upsert({
    where: { shop },
    create: { shop, apiKey },
    update: { apiKey },
  });

  return { success: true, message: "API key validated and saved." };
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

export default { getSettings, updateSettings, updateApiKey, getIntegrationStatus };
