/**
 * Email Settings Routes
 * CRUD for per-merchant email outreach configuration
 * (Cloudflare credentials, Smartlead API key, Gmail OAuth, WHOIS info)
 */

import { PrismaClient } from "@prisma/client";
import { CloudflareService } from "../services/cloudflare-api.js";
import { SmartleadService } from "../services/smartlead-api.js";

const prisma = new PrismaClient();

/**
 * GET /api/email/settings
 * Returns the merchant's email settings (tokens masked for display)
 */
export async function getEmailSettings(shop) {
  let settings = await prisma.emailSettings.findUnique({ where: { shop } });

  if (!settings) {
    settings = await prisma.emailSettings.create({ data: { shop } });
  }

  return {
    ...settings,
    cloudflareApiToken: maskToken(settings.cloudflareApiToken),
    smartleadApiKey: maskToken(settings.smartleadApiKey),
    gmailAccessToken: undefined,
    gmailRefreshToken: undefined,
    hasCloudflare: !!settings.cloudflareApiToken && !!settings.cloudflareAccountId,
    hasSmartlead: !!settings.smartleadApiKey,
    hasGmail: !!settings.gmailRefreshToken,
  };
}

/**
 * PUT /api/email/settings
 * Update merchant email settings (whitelisted fields only)
 */
export async function updateEmailSettings(shop, updates) {
  const allowedFields = [
    "cloudflareAccountId",
    "cloudflareApiToken",
    "smartleadApiKey",
    "whoisFirstName",
    "whoisLastName",
    "whoisAddress1",
    "whoisCity",
    "whoisState",
    "whoisZip",
    "whoisCountry",
    "whoisPhone",
    "whoisEmail",
  ];

  const data = {};
  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      data[field] = updates[field];
    }
  }

  const settings = await prisma.emailSettings.upsert({
    where: { shop },
    create: { shop, ...data },
    update: data,
  });

  return { success: true, settings };
}

/**
 * POST /api/email/settings/test-cf
 * Test Cloudflare API token validity
 */
export async function testCloudflareConnection(shop) {
  const settings = await prisma.emailSettings.findUnique({ where: { shop } });
  if (!settings?.cloudflareApiToken || !settings?.cloudflareAccountId) {
    return { valid: false, error: "Cloudflare credentials not configured" };
  }

  const cf = new CloudflareService(settings.cloudflareApiToken, settings.cloudflareAccountId);
  return cf.verifyToken();
}

/**
 * POST /api/email/settings/test-sl
 * Test Smartlead API key validity
 */
export async function testSmartleadConnection(shop) {
  const settings = await prisma.emailSettings.findUnique({ where: { shop } });
  if (!settings?.smartleadApiKey) {
    return { valid: false, error: "Smartlead API key not configured" };
  }

  const sl = new SmartleadService(settings.smartleadApiKey);
  return sl.testConnection();
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Helper to load a merchant's EmailSettings and instantiate service clients.
 * Shared by other route modules that need Cloudflare/Smartlead access.
 */
export async function getServiceClients(shop) {
  const settings = await prisma.emailSettings.findUnique({ where: { shop } });
  if (!settings) {
    throw new Error("Email settings not configured. Set up credentials first.");
  }

  const clients = { settings };

  if (settings.cloudflareApiToken && settings.cloudflareAccountId) {
    clients.cloudflare = new CloudflareService(
      settings.cloudflareApiToken,
      settings.cloudflareAccountId
    );
  }

  if (settings.smartleadApiKey) {
    clients.smartlead = new SmartleadService(settings.smartleadApiKey);
  }

  return clients;
}

function maskToken(token) {
  if (!token) return "";
  if (token.length <= 12) return "•".repeat(token.length);
  return token.slice(0, 6) + "•".repeat(20) + token.slice(-4);
}
