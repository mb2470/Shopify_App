/**
 * OCE Shopify App — Express Server
 * Handles:
 *  - Shopify OAuth & session management
 *  - Admin UI serving
 *  - API routes (settings, status)
 *  - Webhook processing (orders/create → OCE)
 *  - Script tag injection
 */

import "dotenv/config";
import express from "express";
import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import { OceApiService } from "./backend/services/oce-api.js";
import { handleOrderCreated } from "./backend/routes/webhooks.js";
import {
  getSettings,
  updateSettings,
  updateApiKey,
  getIntegrationStatus,
  syncAppMetafields,
  getAppMetafields,
} from "./backend/routes/settings.js";

// ─── Email Outreach System Imports ───────────────────────────────
import {
  getEmailSettings,
  updateEmailSettings,
  testCloudflareConnection,
  testSmartleadConnection,
} from "./backend/routes/email-settings.js";
import {
  listDomains,
  getDomainStatus,
  searchDomains,
  purchaseDomain,
  provisionDns,
  verifyDns,
} from "./backend/routes/email-domains.js";
import {
  listEmailAccounts,
  createEmailAccount,
  toggleWarmup,
  getWarmupStats,
  assignToCampaign,
} from "./backend/routes/email-accounts.js";
import {
  listCampaigns,
  createCampaign,
  getCampaignDetail,
} from "./backend/routes/email-campaigns.js";
import {
  listConversations,
  getConversation,
  markAsRead,
  getInboxStats,
} from "./backend/routes/email-inbox.js";
import { GmailService } from "./backend/services/gmail-api.js";

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ────────────────────────────────────────────────────

app.post("/webhooks/*", express.raw({ type: "application/json" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Shopify Auth Helpers ─────────────────────────────────────────

const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const SHOPIFY_APP_URL = process.env.SHOPIFY_APP_URL;
const SCOPES =
  "read_orders,write_orders,read_customers,read_products,read_script_tags,write_script_tags";

// Startup diagnostics — shows if env vars are loaded
console.log("[env] SHOPIFY_API_KEY:", SHOPIFY_API_KEY ? SHOPIFY_API_KEY.substring(0, 8) + "..." : "MISSING!");
console.log("[env] SHOPIFY_API_SECRET:", SHOPIFY_API_SECRET ? "set (" + SHOPIFY_API_SECRET.length + " chars)" : "MISSING!");
console.log("[env] SHOPIFY_APP_URL:", SHOPIFY_APP_URL || "MISSING!");
if (!SHOPIFY_API_KEY) console.error("[env] FATAL: SHOPIFY_API_KEY is not set. App Bridge will fail to initialize.");

function verifyHmac(query) {
  const { hmac, ...rest } = query;
  if (!hmac) return false;
  const message = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${rest[key]}`)
    .join("&");
  const generated = crypto
    .createHmac("sha256", SHOPIFY_API_SECRET)
    .update(message)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(generated), Buffer.from(hmac));
  } catch {
    return false;
  }
}

function verifyWebhookHmac(body, hmacHeader) {
  const generated = crypto
    .createHmac("sha256", SHOPIFY_API_SECRET)
    .update(body)
    .digest("base64");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(generated),
      Buffer.from(hmacHeader)
    );
  } catch {
    return false;
  }
}

// ─── OAuth Routes ─────────────────────────────────────────────────

app.get("/auth", (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).send("Missing shop parameter");

  const nonce = crypto.randomBytes(16).toString("hex");
  const redirectUri = `${SHOPIFY_APP_URL}/auth/callback`;
  const installUrl =
    `https://${shop}/admin/oauth/authorize?` +
    `client_id=${SHOPIFY_API_KEY}&scope=${SCOPES}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${nonce}`;

  res.redirect(installUrl);
});

app.get("/auth/callback", async (req, res) => {
  const { shop, hmac, code, state } = req.query;

  if (!verifyHmac(req.query)) {
    return res.status(400).send("HMAC verification failed");
  }

  try {
    const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: SHOPIFY_API_KEY,
        client_secret: SHOPIFY_API_SECRET,
        code,
      }),
    });

    const { access_token } = await response.json();

    await prisma.session.upsert({
      where: { id: `offline_${shop}` },
      create: {
        id: `offline_${shop}`,
        shop,
        state: state || "",
        isOnline: false,
        accessToken: access_token,
        scope: SCOPES,
      },
      update: { accessToken: access_token, scope: SCOPES },
    });

    await prisma.oceSettings.upsert({
      where: { shop },
      create: { shop },
      update: {},
    });

    await registerWebhooks(shop, access_token);

    res.redirect(`https://${shop}/admin/apps/${SHOPIFY_API_KEY}`);
  } catch (error) {
    console.error("[Auth] Error:", error);
    res.status(500).send("Authentication failed");
  }
});

// Alias routes for redirect URL compatibility
app.get("/auth/shopify/callback", (req, res) => res.redirect(`/auth/callback?${new URLSearchParams(req.query)}`));
app.get("/api/auth/callback", (req, res) => res.redirect(`/auth/callback?${new URLSearchParams(req.query)}`));

// ─── Token Exchange Helper ────────────────────────────────────────
// Exchanges an App Bridge session token for an offline access token.
// Used by the authenticate middleware on first contact with a shop.

async function doTokenExchange(shop, sessionToken) {
  console.log("[OCE] Token exchange for", shop, "client_id:", SHOPIFY_API_KEY ? SHOPIFY_API_KEY.substring(0, 8) + "..." : "MISSING");
  try {
    const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: SHOPIFY_API_KEY,
        client_secret: SHOPIFY_API_SECRET,
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: sessionToken,
        subject_token_type: "urn:ietf:params:oauth:token-type:id-token",
        requested_token_type: "urn:shopify:params:oauth:token-type:offline-access-token",
      }),
    });

    console.log("[OCE] Token exchange response status:", response.status, "content-type:", response.headers.get("content-type"));

    // Read as text first to avoid JSON parse crash on HTML error pages
    const responseText = await response.text();

    let data;
    try {
      data = JSON.parse(responseText);
    } catch (parseErr) {
      console.error("[OCE] Token exchange returned non-JSON (status " + response.status + "):", responseText.substring(0, 500));
      return { success: false, error: "Shopify returned HTTP " + response.status + " (non-JSON). App may need to be reinstalled on this store." };
    }

    if (!response.ok || !data.access_token) {
      console.error("[OCE] Token exchange failed:", JSON.stringify(data));
      return { success: false, error: data.error_description || data.error || "Token exchange failed" };
    }

    await prisma.session.upsert({
      where: { id: `offline_${shop}` },
      create: {
        id: `offline_${shop}`,
        shop,
        state: "",
        isOnline: false,
        accessToken: data.access_token,
        scope: data.scope || SCOPES,
      },
      update: { accessToken: data.access_token, scope: data.scope || SCOPES },
    });

    await prisma.oceSettings.upsert({
      where: { shop },
      create: { shop },
      update: {},
    });

    await registerWebhooks(shop, data.access_token);

    console.log("[OCE] Token exchange complete for", shop, "— session stored");
    return { success: true };
  } catch (err) {
    console.error("[OCE] Token exchange error:", err);
    return { success: false, error: err.message };
  }
}

// ─── Webhook Registration ─────────────────────────────────────────

async function registerWebhooks(shop, accessToken) {
  const webhooks = [
    { topic: "orders/create", address: `${SHOPIFY_APP_URL}/webhooks/orders/create` },
    { topic: "app/uninstalled", address: `${SHOPIFY_APP_URL}/webhooks/app/uninstalled` },
  ];

  for (const wh of webhooks) {
    try {
      await fetch(`https://${shop}/admin/api/2024-10/webhooks.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ webhook: { topic: wh.topic, address: wh.address, format: "json" } }),
      });
      console.log(`[Webhook] Registered ${wh.topic} for ${shop}`);
    } catch (error) {
      console.error(`[Webhook] Failed ${wh.topic}:`, error.message);
    }
  }
}

// ─── Webhook Endpoints ────────────────────────────────────────────

app.post("/webhooks/orders/create", async (req, res) => {
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
  const shop = req.headers["x-shopify-shop-domain"];
  if (!hmacHeader || !verifyWebhookHmac(req.body, hmacHeader)) {
    return res.status(401).send("Unauthorized");
  }
  res.status(200).send("OK");
  try {
    const orderData = JSON.parse(req.body.toString());
    await handleOrderCreated(shop, orderData);
  } catch (error) {
    console.error("[Webhook] orders/create error:", error);
  }
});

app.post("/webhooks/app/uninstalled", async (req, res) => {
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
  const shop = req.headers["x-shopify-shop-domain"];
  if (!hmacHeader || !verifyWebhookHmac(req.body, hmacHeader)) {
    return res.status(401).send("Unauthorized");
  }
  res.status(200).send("OK");
  try {
    await prisma.emailConversation.deleteMany({ where: { shop } });
    await prisma.emailAccount.deleteMany({ where: { shop } });
    await prisma.emailDomain.deleteMany({ where: { shop } });
    await prisma.outreachCampaign.deleteMany({ where: { shop } });
    await prisma.emailSettings.deleteMany({ where: { shop } });
    await prisma.oceSettings.deleteMany({ where: { shop } });
    await prisma.orderSync.deleteMany({ where: { shop } });
    await prisma.videoAsset.deleteMany({ where: { shop } });
    await prisma.session.deleteMany({ where: { shop } });
  } catch (error) {
    console.error("[Webhook] uninstall error:", error);
  }
});

app.post("/webhooks/customers/delete", (req, res) => res.status(200).send("OK"));
app.post("/webhooks/customers/data-request", (req, res) => res.status(200).send("OK"));
app.post("/webhooks/shop/delete", (req, res) => res.status(200).send("OK"));

// ─── Smartlead Webhook (Email Reply Handler) ─────────────────────
// Receives inbound email replies from Smartlead. No HMAC — uses optional
// shared secret query param for basic validation.

app.post("/webhooks/smartlead/reply", express.json(), async (req, res) => {
  // Optional: validate shared secret
  const secret = process.env.SMARTLEAD_WEBHOOK_SECRET;
  if (secret && req.query.secret !== secret) {
    return res.status(401).json({ error: "Invalid webhook secret" });
  }

  res.status(200).json({ ok: true });

  try {
    const {
      from_email,
      to_email,
      email_body,
      email_body_html,
      subject,
      campaign_name,
      campaign_id,
      lead_id,
    } = req.body;

    if (!to_email) {
      console.warn("[Email Webhook] Missing to_email in payload");
      return;
    }

    // Look up shop by matching the to_email to an EmailAccount
    const emailAccount = await prisma.emailAccount.findUnique({
      where: { emailAddress: to_email },
    });

    if (!emailAccount) {
      console.warn("[Email Webhook] No account found for", to_email);
      return;
    }

    const shop = emailAccount.shop;

    // Find matching campaign by Smartlead campaign ID or name
    let localCampaignId = null;
    if (campaign_id) {
      const campaign = await prisma.outreachCampaign.findFirst({
        where: { shop, smartleadCampaignId: String(campaign_id) },
      });
      localCampaignId = campaign?.id || null;
    }

    // Store conversation
    const conversation = await prisma.emailConversation.create({
      data: {
        shop,
        campaignId: localCampaignId,
        fromEmail: from_email || "unknown",
        toEmail: to_email,
        subject: subject || null,
        body: email_body || "",
        bodyHtml: email_body_html || null,
        direction: "inbound",
        smartleadLeadId: lead_id ? String(lead_id) : null,
      },
    });

    console.log("[Email Webhook] Stored reply from", from_email, "→", to_email, "id:", conversation.id);

    // Update campaign reply count
    if (localCampaignId) {
      await prisma.outreachCampaign.update({
        where: { id: localCampaignId },
        data: { totalReplies: { increment: 1 } },
      });
    }

    // Forward to Gmail if configured
    const emailSettings = await prisma.emailSettings.findUnique({ where: { shop } });
    if (emailSettings?.gmailRefreshToken && emailSettings?.gmailEmail) {
      try {
        const gmail = new GmailService({
          accessToken: emailSettings.gmailAccessToken,
          refreshToken: emailSettings.gmailRefreshToken,
          clientId: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        });

        const result = await gmail.insertMessage({
          from: from_email || "unknown@unknown.com",
          to: emailSettings.gmailEmail,
          subject: subject || "(no subject)",
          body: email_body_html || email_body || "",
        });

        // Store Gmail message ID
        await prisma.emailConversation.update({
          where: { id: conversation.id },
          data: { gmailMessageId: result.id },
        });

        // If token was refreshed, persist it
        if (gmail.accessToken !== emailSettings.gmailAccessToken) {
          await prisma.emailSettings.update({
            where: { shop },
            data: { gmailAccessToken: gmail.accessToken },
          });
        }

        console.log("[Email Webhook] Forwarded to Gmail:", emailSettings.gmailEmail, "msgId:", result.id);
      } catch (gmailErr) {
        console.error("[Email Webhook] Gmail forward failed:", gmailErr.message);
      }
    }
  } catch (error) {
    console.error("[Email Webhook] Processing error:", error);
  }
});

// ─── Auth Middleware ──────────────────────────────────────────────

async function authenticate(req, res, next) {
  try {
    let shop = null;
    let sessionToken = null;

    // 1. Try Bearer session token from App Bridge (preferred for embedded apps)
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      sessionToken = authHeader.slice(7);
      try {
        // Decode JWT payload (base64url) to extract shop domain
        const parts = sessionToken.split(".");
        if (parts.length === 3) {
          const payload = JSON.parse(
            Buffer.from(parts[1], "base64url").toString()
          );
          // dest = "https://shop.myshopify.com" → extract domain
          shop =
            payload.dest?.replace("https://", "") ||
            payload.iss?.replace("https://", "").replace("/admin", "");
          console.log("[OCE] Auth: decoded session token for", shop);
        }
      } catch (decodeErr) {
        console.warn("[OCE] Auth: failed to decode session token:", decodeErr.message);
      }
    }

    // 2. Fallback to query param / header (for non-App-Bridge clients)
    if (!shop) {
      shop = req.query.shop || req.headers["x-shop-domain"];
    }

    if (!shop) {
      console.warn("[OCE] Auth failed: no shop for", req.method, req.path);
      return res.status(401).json({ error: "Missing shop" });
    }

    // 3. Look up stored session
    let session = await prisma.session.findUnique({
      where: { id: `offline_${shop}` },
    });

    // 4. No stored session? Auto-exchange the session token for an access token
    if ((!session || !session.accessToken) && sessionToken) {
      console.log("[OCE] Auth: no stored session for", shop, "— running token exchange");
      const result = await doTokenExchange(shop, sessionToken);
      if (result.success) {
        session = await prisma.session.findUnique({
          where: { id: `offline_${shop}` },
        });
      } else {
        console.error("[OCE] Auth: token exchange failed:", result.error);
        // Redirect to OAuth install flow so the merchant re-authorizes
        const redirectUri = `${SHOPIFY_APP_URL}/auth/callback`;
        const installUrl =
          `https://${shop}/admin/oauth/authorize?` +
          `client_id=${SHOPIFY_API_KEY}&scope=${SCOPES}` +
          `&redirect_uri=${encodeURIComponent(redirectUri)}`;
        return res.status(401).json({
          error: "Re-authorization required",
          reauthorize: installUrl,
        });
      }
    }

    if (!session || !session.accessToken) {
      console.warn("[OCE] Auth failed: no session for", shop);
      const redirectUri = `${SHOPIFY_APP_URL}/auth/callback`;
      const installUrl =
        `https://${shop}/admin/oauth/authorize?` +
        `client_id=${SHOPIFY_API_KEY}&scope=${SCOPES}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}`;
      return res.status(401).json({
        error: "Not authenticated",
        reauthorize: installUrl,
      });
    }

    req.shop = shop;
    req.session = session;
    next();
  } catch (err) {
    console.error("[OCE] Auth middleware error:", err);
    res.status(500).json({ error: "Authentication error", detail: err.message });
  }
}

// ─── API Routes ───────────────────────────────────────────────────

app.get("/api/settings", authenticate, async (req, res) => {
  try {
    res.json(await getSettings(req.shop));
  } catch (err) {
    console.error("[OCE] GET /api/settings error:", err);
    res.status(500).json({ error: "Failed to load settings", detail: err.message });
  }
});

app.put("/api/settings", authenticate, async (req, res) => {
  try {
    console.log("[OCE] PUT /api/settings for", req.shop);
    const settings = await updateSettings(req.shop, req.body);
    // Sync to Shopify app metafields so the Liquid theme extension can read them
    const syncResult = await syncAppMetafields(req.shop, req.session.accessToken);
    console.log("[OCE] Settings sync result:", JSON.stringify(syncResult));
    res.json({ success: true, settings, metafieldSync: syncResult });
  } catch (err) {
    console.error("[OCE] PUT /api/settings error:", err);
    res.status(500).json({ error: "Failed to save settings", detail: err.message });
  }
});

app.put("/api/settings/api-key", authenticate, async (req, res) => {
  try {
    console.log("[OCE] PUT /api/settings/api-key for", req.shop, "key length:", (req.body.apiKey || "").length);
    const result = await updateApiKey(req.shop, req.body.apiKey);
    // Sync to Shopify app metafields so the Liquid theme extension can read them
    const syncResult = await syncAppMetafields(req.shop, req.session.accessToken);
    console.log("[OCE] API key sync result:", JSON.stringify(syncResult));
    res.json({ ...result, metafieldSync: syncResult });
  } catch (err) {
    console.error("[OCE] PUT /api/settings/api-key error:", err);
    res.status(500).json({ error: "Failed to save API key", detail: err.message });
  }
});

app.get("/api/settings/status", authenticate, async (req, res) => {
  try {
    res.json(await getIntegrationStatus(req.shop));
  } catch (err) {
    console.error("[OCE] GET /api/settings/status error:", err);
    res.status(500).json({ error: "Failed to load status", detail: err.message });
  }
});

// ─── Debug / Diagnostic Endpoint ──────────────────────────────────

app.get("/api/debug/metafields", authenticate, async (req, res) => {
  try {
    console.log("[OCE] Debug metafields for", req.shop);
    const result = await getAppMetafields(req.shop, req.session.accessToken);
    res.json(result);
  } catch (err) {
    console.error("[OCE] Debug metafields error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Email Outreach API Routes ────────────────────────────────────

// Email Settings
app.get("/api/email/settings", authenticate, async (req, res) => {
  try { res.json(await getEmailSettings(req.shop)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/api/email/settings", authenticate, async (req, res) => {
  try { res.json(await updateEmailSettings(req.shop, req.body)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/email/settings/test-cf", authenticate, async (req, res) => {
  try { res.json(await testCloudflareConnection(req.shop)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/email/settings/test-sl", authenticate, async (req, res) => {
  try { res.json(await testSmartleadConnection(req.shop)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Domain Management
app.get("/api/email/domains", authenticate, async (req, res) => {
  try { res.json(await listDomains(req.shop)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/email/domains/search", authenticate, async (req, res) => {
  try { res.json(await searchDomains(req.shop, req.body.query)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/email/domains/purchase", authenticate, async (req, res) => {
  try { res.json(await purchaseDomain(req.shop, req.body.domain, req.body.years)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/email/domains/:id/provision", authenticate, async (req, res) => {
  try { res.json(await provisionDns(req.shop, req.params.id, req.body.provider)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/email/domains/:id/verify", authenticate, async (req, res) => {
  try { res.json(await verifyDns(req.shop, req.params.id)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/email/domains/:id", authenticate, async (req, res) => {
  try { res.json(await getDomainStatus(req.shop, req.params.id)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Email Accounts
app.get("/api/email/accounts", authenticate, async (req, res) => {
  try { res.json(await listEmailAccounts(req.shop)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/email/accounts", authenticate, async (req, res) => {
  try { res.json(await createEmailAccount(req.shop, req.body)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/email/accounts/:id/warmup", authenticate, async (req, res) => {
  try { res.json(await toggleWarmup(req.shop, req.params.id, req.body.enabled)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/email/accounts/:id/warmup", authenticate, async (req, res) => {
  try { res.json(await getWarmupStats(req.shop, req.params.id)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/email/accounts/:id/assign", authenticate, async (req, res) => {
  try { res.json(await assignToCampaign(req.shop, req.params.id, req.body.campaignId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Campaigns
app.get("/api/email/campaigns", authenticate, async (req, res) => {
  try { res.json(await listCampaigns(req.shop)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/email/campaigns", authenticate, async (req, res) => {
  try { res.json(await createCampaign(req.shop, req.body.name)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/email/campaigns/:id", authenticate, async (req, res) => {
  try { res.json(await getCampaignDetail(req.shop, req.params.id)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Inbox
app.get("/api/email/inbox", authenticate, async (req, res) => {
  try {
    const { campaignId, page, limit } = req.query;
    res.json(await listConversations(req.shop, {
      campaignId,
      page: page ? parseInt(page) : 1,
      limit: limit ? parseInt(limit) : 25,
    }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/email/inbox/stats", authenticate, async (req, res) => {
  try { res.json(await getInboxStats(req.shop)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/email/inbox/:id", authenticate, async (req, res) => {
  try { res.json(await getConversation(req.shop, req.params.id)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/api/email/inbox/:id/read", authenticate, async (req, res) => {
  try { res.json(await markAsRead(req.shop, req.params.id)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Admin UI ─────────────────────────────────────────────────────

app.get("/", (req, res) => {
  const { shop, host } = req.query;
  // Set Content-Security-Policy to allow Shopify Admin to embed this app
  res.setHeader(
    "Content-Security-Policy",
    "frame-ancestors https://*.myshopify.com https://admin.shopify.com;"
  );
  res.send(getAdminHTML(shop || "", host || ""));
});

function getAdminHTML(shop, host) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="shopify-api-key" content="${SHOPIFY_API_KEY}" />
  <title>Onsite Commission Engine</title>
  <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f6f6f7;color:#202223}
    .app{max-width:1000px;margin:0 auto;padding:24px 16px}
    .header{margin-bottom:24px;display:flex;justify-content:space-between;align-items:center}
    .header h1{font-size:24px;font-weight:600}
    .header p{color:#6d7175;margin-top:4px}
    .card{background:#fff;border-radius:12px;border:1px solid #e1e3e5;padding:20px;margin-bottom:16px}
    .card h2{font-size:16px;font-weight:600;margin-bottom:12px}
    .card-row{display:flex;justify-content:space-between;align-items:center}
    .grid-3{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:12px}
    .grid-2{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}
    .grid-4{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:12px}
    .status-box{background:#f6f6f7;border-radius:8px;padding:16px}
    .status-box h3{font-size:14px;font-weight:600;margin-bottom:8px}
    .badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:500}
    .b-ok{background:#aee9d1;color:#0b5e3b}.b-warn{background:#ffea8a;color:#595130}
    .b-err{background:#fed3d1;color:#6e1717}.b-info{background:#e4e5e7;color:#44474a}
    .form-g{margin-bottom:16px}
    .form-g label{display:block;font-size:14px;font-weight:500;margin-bottom:4px}
    .form-g .help{font-size:12px;color:#6d7175;margin-top:2px}
    input[type=text],input[type=password],input[type=number],select{width:100%;padding:8px 12px;border:1px solid #c9cccf;border-radius:8px;font-size:14px;outline:none}
    input:focus,select:focus{border-color:#005bd3;box-shadow:0 0 0 1px #005bd3}
    .btn{display:inline-block;padding:8px 16px;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;border:none}
    .btn-p{background:#005bd3;color:#fff}.btn-p:hover{background:#004bb5}.btn-p:disabled{background:#b5c7e3;cursor:not-allowed}
    .btn-s{background:#f6f6f7;color:#202223;border:1px solid #c9cccf}.btn-link{background:none;color:#005bd3;padding:4px 8px}
    .tog{display:flex;align-items:center;gap:8px;cursor:pointer}
    .tog-t{width:36px;height:20px;border-radius:10px;background:#c9cccf;position:relative;transition:background .2s}
    .tog-t.on{background:#005bd3}
    .tog-th{width:16px;height:16px;border-radius:50%;background:#fff;position:absolute;top:2px;left:2px;transition:left .2s}
    .tog-t.on .tog-th{left:18px}
    .code{background:#1e2124;color:#95c7f3;padding:12px 16px;border-radius:8px;font-family:'SF Mono',Monaco,monospace;font-size:13px;line-height:1.6;overflow-x:auto}
    hr{border:none;border-top:1px solid #e1e3e5;margin:16px 0}
    .cl-item{display:flex;gap:12px;align-items:flex-start;padding:12px 0}
    .cl-n{width:28px;height:28px;border-radius:50%;background:#f6f6f7;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;color:#6d7175;flex-shrink:0}
    .cl-c h4{font-size:14px;font-weight:600}.cl-c p{font-size:13px;color:#6d7175}
    .fs{background:#f6f6f7;border-radius:8px;padding:16px;text-align:center}
    .fs .ic{font-size:24px;margin-bottom:8px}.fs h4{font-size:14px;font-weight:600}.fs p{font-size:12px;color:#6d7175;margin-top:4px}
    .cb{display:flex;align-items:center;gap:8px;padding:8px 0}.cb input{width:16px;height:16px}
    .banner{border-radius:8px;padding:12px 16px;margin-bottom:16px;display:none}
    .banner-ok{background:#f1f8f5;border:1px solid #aee9d1;color:#0b5e3b}
    .banner-err{background:#fff4f4;border:1px solid #fed3d1;color:#6e1717}
    .o-row{display:flex;justify-content:space-between;padding:6px 0;font-size:13px;border-bottom:1px solid #f1f1f1}
    @media(max-width:768px){.grid-3,.grid-4,.grid-2{grid-template-columns:1fr}}
    a{color:#005bd3}
    .tabs{display:flex;gap:0;margin-bottom:24px;border-bottom:2px solid #e1e3e5}
    .tab{padding:10px 20px;font-size:14px;font-weight:600;cursor:pointer;border:none;background:none;color:#6d7175;border-bottom:2px solid transparent;margin-bottom:-2px;transition:color .2s,border-color .2s}
    .tab:hover{color:#202223}
    .tab.active{color:#005bd3;border-bottom-color:#005bd3}
    .tab .tab-badge{background:#e51c00;color:#fff;font-size:11px;padding:1px 6px;border-radius:8px;margin-left:6px;font-weight:600}
    .tab-content{display:none}.tab-content.active{display:block}
    .tbl{width:100%;border-collapse:collapse;font-size:13px;margin-top:12px}
    .tbl th{text-align:left;padding:8px 12px;background:#f6f6f7;font-weight:600;font-size:12px;color:#6d7175;border-bottom:1px solid #e1e3e5}
    .tbl td{padding:8px 12px;border-bottom:1px solid #f1f1f1;vertical-align:middle}
    .tbl tr:hover td{background:#f9fafb}
    .dns-badges{display:flex;gap:4px;flex-wrap:wrap}
    .inbox-item{padding:12px 16px;border-bottom:1px solid #f1f1f1;cursor:pointer;display:flex;justify-content:space-between;align-items:center}
    .inbox-item:hover{background:#f9fafb}
    .inbox-item.unread{font-weight:600}
    .inbox-item .from{font-size:13px}.inbox-item .subj{font-size:12px;color:#6d7175;margin-top:2px}
    .inbox-item .time{font-size:11px;color:#8c9196;white-space:nowrap}
    .empty-state{text-align:center;padding:40px 20px;color:#6d7175}
    .empty-state h3{font-size:16px;font-weight:600;color:#202223;margin-bottom:8px}
    .btn-sm{padding:4px 10px;font-size:12px;border-radius:6px}
    .btn-danger{background:#e51c00;color:#fff;border:none;cursor:pointer}.btn-danger:hover{background:#c41600}
    .inline-form{display:flex;gap:8px;align-items:flex-end}
    .inline-form .form-g{margin-bottom:0;flex:1}
  </style>
</head>
<body>
<div class="app">
  <div id="sb" class="banner banner-ok"></div>
  <div id="eb" class="banner banner-err"></div>

  <div class="header"><div><h1>OCE Platform</h1><p>Commission engine + email outreach</p></div></div>

  <div class="tabs">
    <button class="tab active" onclick="switchTab('oce')">OCE Dashboard</button>
    <button class="tab" onclick="switchTab('email')">Email Outreach <span id="inbox-badge" class="tab-badge" style="display:none">0</span></button>
  </div>

  <div id="tab-oce" class="tab-content active">

  <div class="card"><div class="card-row"><h2>Integration Status</h2><span id="ob" class="badge b-info">Loading...</span></div>
    <div class="grid-3">
      <div class="status-box"><h3>🔗 SDK Script</h3><span id="sb1" class="badge b-info">—</span><p id="sm1" style="font-size:12px;color:#6d7175;margin-top:6px"></p></div>
      <div class="status-box"><h3>📦 Order Webhook</h3><span id="sb2" class="badge b-info">—</span><p id="sm2" style="font-size:12px;color:#6d7175;margin-top:6px"></p></div>
      <div class="status-box"><h3>📡 API Connection</h3><span id="sb3" class="badge b-info">—</span><p id="sm3" style="font-size:12px;color:#6d7175;margin-top:6px"></p></div>
    </div>
  </div>

  <div class="card"><div class="card-row"><div><h2>API Key</h2><p style="font-size:13px;color:#6d7175">Get your key from <a href="https://app.onsiteaffiliate.com/settings/api-keys" target="_blank">app.onsiteaffiliate.com</a></p></div>
    <button class="btn btn-link" onclick="document.getElementById('kf').style.display=document.getElementById('kf').style.display==='none'?'block':'none'">Change Key</button></div>
    <div id="kd" style="margin-top:12px;background:#f6f6f7;border-radius:8px;padding:12px;display:none">✅ <span id="mk"></span></div>
    <div id="kf" style="margin-top:12px"><div class="form-g"><label>OCE API Key</label>
      <input type="password" id="ki" placeholder="oce_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx">
      <p class="help">Paste your API key from the OCE dashboard.</p></div>
      <button class="btn btn-p" onclick="saveKey()" id="skb">Save Key</button></div>
  </div>

  <div class="card" id="qs"><h2>Quick Start</h2><hr>
    <div class="cl-item"><div class="cl-n">1</div><div class="cl-c"><h4>Create an OCE Account</h4><p><a href="https://app.onsiteaffiliate.com/signup" target="_blank">Sign up at app.onsiteaffiliate.com</a></p></div></div>
    <div class="cl-item"><div class="cl-n">2</div><div class="cl-c"><h4>Generate an API Key</h4><p>Settings → API Keys in OCE dashboard</p></div></div>
    <div class="cl-item"><div class="cl-n">3</div><div class="cl-c"><h4>Paste Your Key Above</h4><p>Enter your API key to connect</p></div></div>
    <div class="cl-item"><div class="cl-n">4</div><div class="cl-c"><h4>Configure Attribution</h4><p>Set commission rates, window, and events</p></div></div>
    <div class="cl-item"><div class="cl-n">5</div><div class="cl-c"><h4>Register Video Assets</h4><p><a href="https://app.onsiteaffiliate.com/assets" target="_blank">Map videos to products</a></p></div></div>
  </div>

  <div class="grid-2">
    <div class="card"><div class="card-row"><div><h2>OCE SDK Script</h2><p style="font-size:13px;color:#6d7175">Auto-injects tracking into storefront</p></div>
      <div class="tog" onclick="tSdk()"><div id="st" class="tog-t on"><div class="tog-th"></div></div></div></div>
      <div id="sc" style="margin-top:12px"><div class="code">&lt;script<br>&nbsp;&nbsp;src="https://app.onsiteaffiliate.com/sdk/oce.min.js"<br>&nbsp;&nbsp;data-api-key="<span id="pk">YOUR_KEY</span>"<br>&nbsp;&nbsp;defer&gt;<br>&lt;/script&gt;</div>
      <p style="font-size:12px;color:#6d7175;margin-top:8px">Auto-detects Videowise, Tolstoy, Firework, YouTube, Vimeo, HTML5 players.</p></div>
    </div>
    <div class="card"><div class="card-row"><div><h2>Order Webhook</h2><p style="font-size:13px;color:#6d7175">Sends orders to OCE for attribution</p></div>
      <div class="tog" onclick="tWh()"><div id="wt" class="tog-t on"><div class="tog-th"></div></div></div></div>
      <p style="font-size:13px;color:#6d7175;margin-top:12px">Order details and exposure IDs sent to OCE REST API on checkout.</p>
      <div id="ro" style="margin-top:12px"></div>
    </div>
  </div>

  <div class="card"><div class="card-row"><h2>Attribution Settings</h2><button class="btn btn-link" onclick="var p=document.getElementById('sp');p.style.display=p.style.display==='none'?'block':'none'">Expand ▾</button></div>
    <div id="sp" style="display:none"><hr>
      <div class="form-g"><label>Attribution Model</label><select id="am"><option value="last-touch">Last Touch</option><option value="first-touch">First Touch</option></select>
        <p class="help">Which creator gets commission when multiple videos watched.</p></div>
      <div class="form-g"><label>Attribution Window: <span id="wv">30</span> days</label>
        <input type="range" id="aw" min="1" max="90" value="30" oninput="document.getElementById('wv').textContent=this.value" style="width:100%">
        <p class="help">How long after a view can a purchase be attributed.</p></div>
      <div class="form-g"><label>Commission Rate (%)</label><input type="number" id="cr" value="10" min="0" max="100" step="0.5">
        <p class="help">Default rate. Override per-SKU/creator in OCE dashboard.</p></div>
      <hr><h3 style="font-size:14px;font-weight:600;margin-bottom:8px">Qualifying Events</h3>
      <div class="cb"><input type="checkbox" id="ti" checked><label for="ti">Track Impressions</label></div>
      <div class="cb"><input type="checkbox" id="tc" checked><label for="tc">Track Clicks</label></div>
      <div class="cb"><input type="checkbox" id="tw" checked><label for="tw">Track Watch Progress</label></div>
      <div class="form-g" style="margin-top:12px"><label>Min Watch %: <span id="mv">25</span>%</label>
        <input type="range" id="mw" min="5" max="100" step="5" value="25" oninput="document.getElementById('mv').textContent=this.value" style="width:100%"></div>
      <hr><div style="text-align:right"><button class="btn btn-p" onclick="saveSets()">Save Attribution Settings</button></div>
    </div>
  </div>

  <div class="card"><h2>How It Works</h2>
    <div class="grid-4">
      <div class="fs"><div class="ic">▶️</div><h4>Video Plays</h4><p>User watches creator content</p></div>
      <div class="fs"><div class="ic">📊</div><h4>Events Tracked</h4><p>Impressions, clicks, watch</p></div>
      <div class="fs"><div class="ic">🛒</div><h4>Order Received</h4><p>Conversion via webhook</p></div>
      <div class="fs"><div class="ic">💰</div><h4>Attribution</h4><p>Commission calculated</p></div>
    </div>
  </div>

  </div><!-- /tab-oce -->

  <div id="tab-email" class="tab-content">

    <!-- Email Settings Card -->
    <div class="card">
      <div class="card-row"><h2>Email Settings</h2>
        <button class="btn btn-link" onclick="var p=document.getElementById('email-settings-form');p.style.display=p.style.display==='none'?'block':'none'">Configure</button>
      </div>
      <div class="grid-3" style="margin-top:8px">
        <div class="status-box"><h3>Cloudflare</h3><span id="cf-status" class="badge b-info">--</span></div>
        <div class="status-box"><h3>Smartlead</h3><span id="sl-status" class="badge b-info">--</span></div>
        <div class="status-box"><h3>Gmail</h3><span id="gm-status" class="badge b-info">--</span></div>
      </div>
      <div id="email-settings-form" style="display:none"><hr>
        <div class="grid-2">
          <div>
            <h3 style="font-size:14px;font-weight:600;margin-bottom:12px">Cloudflare</h3>
            <div class="form-g"><label>Account ID</label><input type="text" id="es-cf-id" placeholder="Cloudflare Account ID"></div>
            <div class="form-g"><label>API Token</label><input type="password" id="es-cf-token" placeholder="Cloudflare API Token"></div>
            <button class="btn btn-s btn-sm" onclick="testCf()">Test Connection</button>
          </div>
          <div>
            <h3 style="font-size:14px;font-weight:600;margin-bottom:12px">Smartlead</h3>
            <div class="form-g"><label>API Key</label><input type="password" id="es-sl-key" placeholder="Smartlead API Key"></div>
            <button class="btn btn-s btn-sm" onclick="testSl()">Test Connection</button>
          </div>
        </div>
        <hr>
        <h3 style="font-size:14px;font-weight:600;margin-bottom:12px">WHOIS Contact (for domain registration)</h3>
        <div class="grid-2">
          <div class="form-g"><label>First Name</label><input type="text" id="es-wh-fn"></div>
          <div class="form-g"><label>Last Name</label><input type="text" id="es-wh-ln"></div>
        </div>
        <div class="form-g"><label>Address</label><input type="text" id="es-wh-addr"></div>
        <div class="grid-4">
          <div class="form-g"><label>City</label><input type="text" id="es-wh-city"></div>
          <div class="form-g"><label>State</label><input type="text" id="es-wh-state"></div>
          <div class="form-g"><label>ZIP</label><input type="text" id="es-wh-zip"></div>
          <div class="form-g"><label>Country</label><input type="text" id="es-wh-country" value="US"></div>
        </div>
        <div class="grid-2">
          <div class="form-g"><label>Phone</label><input type="text" id="es-wh-phone" placeholder="+1.5551234567"></div>
          <div class="form-g"><label>Email</label><input type="text" id="es-wh-email"></div>
        </div>
        <hr>
        <div style="text-align:right"><button class="btn btn-p" onclick="saveEmailSettings()">Save Email Settings</button></div>
      </div>
    </div>

    <!-- Domain Manager Card -->
    <div class="card">
      <h2>Domain Manager</h2>
      <div class="inline-form" style="margin-top:12px">
        <div class="form-g"><label>Search Domains</label><input type="text" id="domain-search" placeholder="mybrand-outreach.com"></div>
        <button class="btn btn-p" onclick="searchDom()">Check Availability</button>
      </div>
      <div id="domain-results" style="margin-top:12px"></div>
      <hr>
      <h3 style="font-size:14px;font-weight:600;margin-bottom:8px">Your Domains</h3>
      <div id="domains-list">
        <div class="empty-state"><h3>No domains yet</h3><p>Search and purchase a domain above to get started.</p></div>
      </div>
    </div>

    <!-- Email Accounts Card -->
    <div class="card">
      <div class="card-row"><h2>Email Accounts</h2>
        <button class="btn btn-p btn-sm" onclick="document.getElementById('add-account-form').style.display='block'">+ Add Account</button>
      </div>
      <div id="add-account-form" style="display:none;margin-top:12px;background:#f6f6f7;border-radius:8px;padding:16px">
        <div class="grid-2">
          <div class="form-g"><label>Domain</label><select id="aa-domain"></select></div>
          <div class="form-g"><label>Local Part</label><input type="text" id="aa-local" placeholder="john"></div>
        </div>
        <div class="grid-2">
          <div class="form-g"><label>Password</label><input type="password" id="aa-pass" placeholder="SMTP/IMAP password"></div>
          <div class="form-g"><label>Display Name</label><input type="text" id="aa-name" placeholder="John Smith"></div>
        </div>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn btn-p btn-sm" onclick="addAccount()">Create Account</button>
          <button class="btn btn-s btn-sm" onclick="document.getElementById('add-account-form').style.display='none'">Cancel</button>
        </div>
      </div>
      <div id="accounts-list" style="margin-top:12px">
        <div class="empty-state"><p>No email accounts yet.</p></div>
      </div>
    </div>

    <!-- Campaigns Card -->
    <div class="card">
      <div class="card-row"><h2>Campaigns</h2>
        <div class="inline-form">
          <input type="text" id="new-camp-name" placeholder="Campaign name" style="width:200px">
          <button class="btn btn-p btn-sm" onclick="addCampaign()">+ Create</button>
        </div>
      </div>
      <div id="campaigns-list" style="margin-top:12px">
        <div class="empty-state"><p>No campaigns yet.</p></div>
      </div>
    </div>

    <!-- Inbox Card -->
    <div class="card">
      <div class="card-row"><h2>Inbox</h2><span id="inbox-count" class="badge b-info">0 messages</span></div>
      <div id="inbox-list" style="margin-top:12px">
        <div class="empty-state"><h3>No replies yet</h3><p>Replies from leads will appear here.</p></div>
      </div>
    </div>

  </div><!-- /tab-email -->

</div>

<script>
const S="${shop}",B="";
let st={sdk:true,wh:true,key:false};
console.log("[init] shop:",S,"shopify obj:",typeof window.shopify,"idToken:",typeof (window.shopify&&window.shopify.idToken));

// ── Diagnostic: verify what App Bridge actually sees ──
(function(){
  var meta=document.querySelector('meta[name="shopify-api-key"]');
  console.log("[diag] meta tag value:",meta?JSON.stringify(meta.content):"META TAG MISSING");
  console.log("[diag] iframe origin:",window.location.origin);
  console.log("[diag] iframe URL:",window.location.href);
  console.log("[diag] parent===self (not embedded):",window.parent===window);
  if(window.shopify){
    console.log("[diag] shopify object keys:",Object.keys(window.shopify));
    console.log("[diag] shopify.config:",JSON.stringify(window.shopify.config||"none"));
    console.log("[diag] shopify.environment:",JSON.stringify(window.shopify.environment||"none"));
  }
})();

async function getSessionToken(attempt){
  attempt=attempt||1;
  if(!window.shopify||!window.shopify.idToken){
    console.warn("[auth] App Bridge not available");
    return null;
  }
  try{
    var t=await Promise.race([
      shopify.idToken(),
      new Promise(function(_,rej){setTimeout(function(){rej(new Error("timeout"))},3000)})
    ]);
    console.log("[auth] got token on attempt",attempt,"length:",t.length);
    return t;
  }catch(e){
    if(attempt<4){
      var delay=attempt*500;
      console.log("[auth] attempt",attempt,"failed ("+e.message+"), retrying in",delay+"ms...");
      await new Promise(function(r){setTimeout(r,delay)});
      return getSessionToken(attempt+1);
    }
    console.error("[auth] all attempts failed:",e.message);
    return null;
  }
}

async function api(m,p,b){
  var t=await getSessionToken();
  var headers={"Content-Type":"application/json"};
  if(t){
    headers["Authorization"]="Bearer "+t;
  }else{
    console.warn("[api] no session token, request may fail");
  }
  var o={method:m,headers:headers};
  if(b)o.body=JSON.stringify(b);
  var url=B+p+(p.includes("?")?"&":"?")+"shop="+encodeURIComponent(S);
  console.log("[api]",m,url,"auth:",!!t);
  var resp=await fetch(url,o);
  if(!resp.ok){
    var err=await resp.json().catch(function(){return{error:"HTTP "+resp.status}});
    if(err.reauthorize){
      console.log("[api] redirecting to OAuth:",err.reauthorize);
      window.open(err.reauthorize,"_top");
      throw new Error("Redirecting to authorization...");
    }
    throw new Error(err.error||err.detail||"HTTP "+resp.status);
  }
  return resp.json();
}
function msg(t,m){const e=document.getElementById(t==="success"?"sb":"eb");e.textContent=m;e.style.display="block";setTimeout(()=>e.style.display="none",5000)}
function bg(s){const m={active:["b-ok","Active"],connected:["b-ok","Connected"],healthy:["b-ok","Healthy"],disabled:["b-warn","Disabled"],inactive:["b-err","Inactive"],error:["b-err","Error"],not_configured:["b-warn","Not Configured"]};const[c,l]=m[s]||["b-info",s];return'<span class="badge '+c+'">'+l+"</span>"}

async function load(){
  try{
    const s=await api("GET","/api/settings");
    if(s.hasApiKey){document.getElementById("kd").style.display="block";document.getElementById("kf").style.display="none";document.getElementById("mk").textContent=s.apiKey;document.getElementById("qs").style.display="none";document.getElementById("pk").textContent=s.apiKey}
    tog("st",s.sdkEnabled);tog("wt",s.webhookEnabled);st.sdk=s.sdkEnabled;st.wh=s.webhookEnabled;
    document.getElementById("am").value=s.attributionModel;
    document.getElementById("aw").value=s.attributionWindow;document.getElementById("wv").textContent=s.attributionWindow;
    document.getElementById("cr").value=s.commissionRate;
    document.getElementById("ti").checked=s.trackImpressions;document.getElementById("tc").checked=s.trackClicks;document.getElementById("tw").checked=s.trackWatchProgress;
    document.getElementById("mw").value=s.minWatchPercent;document.getElementById("mv").textContent=s.minWatchPercent;
  }catch(e){console.log("Settings load pending auth")}
  try{
    const x=await api("GET","/api/settings/status");
    document.getElementById("ob").outerHTML=bg(x.overall);
    document.getElementById("sb1").outerHTML=bg(x.sdk.status);document.getElementById("sm1").textContent=x.sdk.message;
    document.getElementById("sb2").outerHTML=bg(x.webhook.status);document.getElementById("sm2").textContent=x.webhook.message;
    document.getElementById("sb3").outerHTML=bg(x.apiConnection.status);document.getElementById("sm3").textContent=x.apiConnection.message;
    if(x.recentOrders&&x.recentOrders.length)document.getElementById("ro").innerHTML="<strong>Recent Orders</strong>"+x.recentOrders.map(o=>'<div class="o-row"><span>#'+o.shopifyOrderId+"</span>"+bg(o.status)+"</div>").join("");
  }catch(e){console.log("Status load pending auth")}
}

async function saveKey(){
  const k=document.getElementById("ki").value.trim();if(!k)return;
  const b=document.getElementById("skb");b.disabled=true;b.textContent="Saving...";
  try{
    const r=await api("PUT","/api/settings/api-key",{apiKey:k});
    b.disabled=false;b.textContent="Save Key";
    console.log("Save response:",JSON.stringify(r));
    if(r.success){
      const syncOk=r.metafieldSync&&r.metafieldSync.success;
      msg("success","API key saved!"+(syncOk?" Metafields synced to storefront.":" (Warning: metafield sync "+JSON.stringify(r.metafieldSync)+")"));
      load();
    }else{
      msg("error",r.error||r.detail||"Failed to save API key");
    }
  }catch(e){
    b.disabled=false;b.textContent="Save Key";
    msg("error","Network error: "+e.message);
    console.error("saveKey error:",e);
  }
}

async function saveSets(){
  const r=await api("PUT","/api/settings",{sdkEnabled:st.sdk,webhookEnabled:st.wh,
    attributionModel:document.getElementById("am").value,
    attributionWindow:parseInt(document.getElementById("aw").value),
    commissionRate:parseFloat(document.getElementById("cr").value),
    trackImpressions:document.getElementById("ti").checked,
    trackClicks:document.getElementById("tc").checked,
    trackWatchProgress:document.getElementById("tw").checked,
    minWatchPercent:parseInt(document.getElementById("mw").value)});
  if(r.success)msg("success","Settings saved!");else msg("error","Save failed");
}

function tog(id,v){const e=document.getElementById(id);if(v)e.classList.add("on");else e.classList.remove("on")}
function tSdk(){st.sdk=!st.sdk;tog("st",st.sdk);document.getElementById("sc").style.display=st.sdk?"block":"none"}
function tWh(){st.wh=!st.wh;tog("wt",st.wh)}

// ── Tab Navigation ──
function switchTab(tab){
  document.querySelectorAll('.tab').forEach(function(t){t.classList.remove('active')});
  document.querySelectorAll('.tab-content').forEach(function(t){t.classList.remove('active')});
  document.getElementById('tab-'+tab).classList.add('active');
  event.target.closest?event.target.closest('.tab').classList.add('active'):event.target.classList.add('active');
  if(tab==='email')loadEmailData();
}

// ── Email Settings ──
async function loadEmailSettings(){
  try{
    var s=await api("GET","/api/email/settings");
    document.getElementById('cf-status').outerHTML=s.hasCloudflare?bg('connected'):bg('not_configured');
    document.getElementById('sl-status').outerHTML=s.hasSmartlead?bg('connected'):bg('not_configured');
    document.getElementById('gm-status').outerHTML=s.hasGmail?bg('connected'):bg('not_configured');
    if(s.cloudflareAccountId)document.getElementById('es-cf-id').value=s.cloudflareAccountId;
    if(s.cloudflareApiToken)document.getElementById('es-cf-token').value=s.cloudflareApiToken;
    if(s.smartleadApiKey)document.getElementById('es-sl-key').value=s.smartleadApiKey;
    if(s.whoisFirstName)document.getElementById('es-wh-fn').value=s.whoisFirstName;
    if(s.whoisLastName)document.getElementById('es-wh-ln').value=s.whoisLastName;
    if(s.whoisAddress1)document.getElementById('es-wh-addr').value=s.whoisAddress1;
    if(s.whoisCity)document.getElementById('es-wh-city').value=s.whoisCity;
    if(s.whoisState)document.getElementById('es-wh-state').value=s.whoisState;
    if(s.whoisZip)document.getElementById('es-wh-zip').value=s.whoisZip;
    if(s.whoisCountry)document.getElementById('es-wh-country').value=s.whoisCountry;
    if(s.whoisPhone)document.getElementById('es-wh-phone').value=s.whoisPhone;
    if(s.whoisEmail)document.getElementById('es-wh-email').value=s.whoisEmail;
  }catch(e){console.log("Email settings load error:",e)}
}

async function saveEmailSettings(){
  try{
    var r=await api("PUT","/api/email/settings",{
      cloudflareAccountId:document.getElementById('es-cf-id').value.trim(),
      cloudflareApiToken:document.getElementById('es-cf-token').value.trim(),
      smartleadApiKey:document.getElementById('es-sl-key').value.trim(),
      whoisFirstName:document.getElementById('es-wh-fn').value.trim(),
      whoisLastName:document.getElementById('es-wh-ln').value.trim(),
      whoisAddress1:document.getElementById('es-wh-addr').value.trim(),
      whoisCity:document.getElementById('es-wh-city').value.trim(),
      whoisState:document.getElementById('es-wh-state').value.trim(),
      whoisZip:document.getElementById('es-wh-zip').value.trim(),
      whoisCountry:document.getElementById('es-wh-country').value.trim(),
      whoisPhone:document.getElementById('es-wh-phone').value.trim(),
      whoisEmail:document.getElementById('es-wh-email').value.trim()
    });
    if(r.success)msg("success","Email settings saved!");else msg("error","Save failed");
    loadEmailSettings();
  }catch(e){msg("error","Error: "+e.message)}
}

async function testCf(){
  try{var r=await api("POST","/api/email/settings/test-cf");msg(r.valid?"success":"error",r.valid?"Cloudflare connected!":"Cloudflare: "+(r.error||"Failed"));}
  catch(e){msg("error","CF test error: "+e.message)}
}
async function testSl(){
  try{var r=await api("POST","/api/email/settings/test-sl");msg(r.valid?"success":"error",r.valid?"Smartlead connected!":"Smartlead: "+(r.error||"Failed"));}
  catch(e){msg("error","SL test error: "+e.message)}
}

// ── Domains ──
var emailDomains=[];

async function loadDomains(){
  try{
    emailDomains=await api("GET","/api/email/domains");
    var el=document.getElementById('domains-list');
    if(!emailDomains.length){el.innerHTML='<div class="empty-state"><h3>No domains yet</h3><p>Search and purchase a domain above to get started.</p></div>';return;}
    var html='<table class="tbl"><tr><th>Domain</th><th>Status</th><th>DNS</th><th>Accounts</th><th>Actions</th></tr>';
    emailDomains.forEach(function(d){
      var dns='<div class="dns-badges">'+
        (d.mxVerified?'<span class="badge b-ok">MX</span>':'<span class="badge b-err">MX</span>')+
        (d.spfVerified?'<span class="badge b-ok">SPF</span>':'<span class="badge b-err">SPF</span>')+
        (d.dkimVerified?'<span class="badge b-ok">DKIM</span>':'<span class="badge b-err">DKIM</span>')+
        (d.dmarcVerified?'<span class="badge b-ok">DMARC</span>':'<span class="badge b-err">DMARC</span>')+
        '</div>';
      html+='<tr><td><strong>'+d.domain+'</strong></td><td>'+bg(d.registrarStatus)+'</td><td>'+dns+'</td>';
      html+='<td>'+(d.emailAccounts?d.emailAccounts.length:0)+'</td>';
      html+='<td><button class="btn btn-s btn-sm" onclick="provDns(\\''+d.id+'\\')">Provision DNS</button> ';
      html+='<button class="btn btn-s btn-sm" onclick="verDns(\\''+d.id+'\\')">Verify</button></td></tr>';
    });
    html+='</table>';
    el.innerHTML=html;
    // Update domain dropdown for account creation
    var sel=document.getElementById('aa-domain');
    sel.innerHTML=emailDomains.map(function(d){return'<option value="'+d.id+'">'+d.domain+'</option>'}).join('');
  }catch(e){console.log("Domains load error:",e)}
}

async function searchDom(){
  var q=document.getElementById('domain-search').value.trim();if(!q)return;
  var el=document.getElementById('domain-results');
  el.innerHTML='<p>Searching...</p>';
  try{
    var results=await api("POST","/api/email/domains/search",{query:q});
    if(!results||!results.length){el.innerHTML='<p>No results found.</p>';return;}
    var html='<table class="tbl"><tr><th>Domain</th><th>Available</th><th>Price</th><th></th></tr>';
    results.forEach(function(r){
      var avail=r.available?'<span class="badge b-ok">Available</span>':'<span class="badge b-err">Taken</span>';
      var price=r.price?('$'+r.price):'--';
      html+='<tr><td>'+r.name+'</td><td>'+avail+'</td><td>'+price+'</td>';
      html+='<td>'+(r.available?'<button class="btn btn-p btn-sm" onclick="buyDom(\\''+r.name+'\\')">Purchase</button>':'')+'</td></tr>';
    });
    html+='</table>';
    el.innerHTML=html;
  }catch(e){el.innerHTML='<p style="color:#e51c00">Error: '+e.message+'</p>';}
}

async function buyDom(domain){
  if(!confirm('Purchase '+domain+'? This will charge your Cloudflare account.'))return;
  try{
    await api("POST","/api/email/domains/purchase",{domain:domain,years:1});
    msg("success",domain+" purchased!");
    loadDomains();
  }catch(e){msg("error","Purchase failed: "+e.message)}
}

async function provDns(id){
  try{var r=await api("POST","/api/email/domains/"+id+"/provision");
    var errs=r.errors&&r.errors.length?(" Warnings: "+r.errors.join(", ")):"";
    msg("success","DNS records provisioned!"+errs);loadDomains();
  }catch(e){msg("error","DNS provision failed: "+e.message)}
}

async function verDns(id){
  try{var r=await api("POST","/api/email/domains/"+id+"/verify");
    msg("success","DNS verified — MX:"+r.mx+" SPF:"+r.spf+" DKIM:"+r.dkim+" DMARC:"+r.dmarc);loadDomains();
  }catch(e){msg("error","DNS verify failed: "+e.message)}
}

// ── Email Accounts ──
async function loadAccounts(){
  try{
    var accounts=await api("GET","/api/email/accounts");
    var el=document.getElementById('accounts-list');
    if(!accounts.length){el.innerHTML='<div class="empty-state"><p>No email accounts yet.</p></div>';return;}
    var html='<table class="tbl"><tr><th>Email</th><th>Domain</th><th>Warmup</th><th>Status</th><th>Actions</th></tr>';
    accounts.forEach(function(a){
      var warmBadge=a.warmupEnabled?'<span class="badge b-ok">'+a.warmupStatus+'</span>':'<span class="badge b-warn">Paused</span>';
      html+='<tr><td><strong>'+a.emailAddress+'</strong></td>';
      html+='<td>'+(a.domain?a.domain.domain:'--')+'</td>';
      html+='<td>'+warmBadge+'</td>';
      html+='<td>'+bg(a.status)+'</td>';
      html+='<td><button class="btn btn-s btn-sm" onclick="toggleWarmup(\\''+a.id+'\\','+(!a.warmupEnabled)+')">'+(a.warmupEnabled?'Pause':'Enable')+' Warmup</button></td></tr>';
    });
    html+='</table>';
    el.innerHTML=html;
  }catch(e){console.log("Accounts load error:",e)}
}

async function addAccount(){
  var domainId=document.getElementById('aa-domain').value;
  var localPart=document.getElementById('aa-local').value.trim();
  var password=document.getElementById('aa-pass').value;
  var fromName=document.getElementById('aa-name').value.trim();
  if(!domainId||!localPart||!password){msg("error","Domain, local part, and password are required");return;}
  try{
    await api("POST","/api/email/accounts",{domainId:domainId,localPart:localPart,password:password,fromName:fromName});
    msg("success","Account created!");
    document.getElementById('add-account-form').style.display='none';
    document.getElementById('aa-local').value='';document.getElementById('aa-pass').value='';document.getElementById('aa-name').value='';
    loadAccounts();
  }catch(e){msg("error","Create account failed: "+e.message)}
}

async function toggleWarmup(id,enabled){
  try{await api("POST","/api/email/accounts/"+id+"/warmup",{enabled:enabled});msg("success","Warmup "+(enabled?"enabled":"paused"));loadAccounts();}
  catch(e){msg("error","Warmup toggle failed: "+e.message)}
}

// ── Campaigns ──
async function loadCampaigns(){
  try{
    var campaigns=await api("GET","/api/email/campaigns");
    var el=document.getElementById('campaigns-list');
    if(!campaigns.length){el.innerHTML='<div class="empty-state"><p>No campaigns yet.</p></div>';return;}
    var html='<table class="tbl"><tr><th>Name</th><th>Status</th><th>Accounts</th><th>Sent</th><th>Replies</th></tr>';
    campaigns.forEach(function(c){
      var acctCount=c.emailAccountIds?c.emailAccountIds.length:0;
      html+='<tr><td><strong>'+c.name+'</strong></td><td>'+bg(c.status)+'</td>';
      html+='<td>'+acctCount+'</td><td>'+c.totalSent+'</td><td>'+c.totalReplies+'</td></tr>';
    });
    html+='</table>';
    el.innerHTML=html;
  }catch(e){console.log("Campaigns load error:",e)}
}

async function addCampaign(){
  var name=document.getElementById('new-camp-name').value.trim();
  if(!name){msg("error","Campaign name required");return;}
  try{
    await api("POST","/api/email/campaigns",{name:name});
    msg("success","Campaign created!");
    document.getElementById('new-camp-name').value='';
    loadCampaigns();
  }catch(e){msg("error","Create campaign failed: "+e.message)}
}

// ── Inbox ──
async function loadInbox(){
  try{
    var data=await api("GET","/api/email/inbox");
    var stats=await api("GET","/api/email/inbox/stats");
    document.getElementById('inbox-count').textContent=stats.total+' messages'+(stats.unread?' ('+stats.unread+' unread)':'');
    var badge=document.getElementById('inbox-badge');
    if(stats.unread>0){badge.textContent=stats.unread;badge.style.display='inline';}else{badge.style.display='none';}
    var el=document.getElementById('inbox-list');
    if(!data.conversations||!data.conversations.length){el.innerHTML='<div class="empty-state"><h3>No replies yet</h3><p>Replies from leads will appear here.</p></div>';return;}
    var html='';
    data.conversations.forEach(function(c){
      var cls='inbox-item'+(c.isRead?'':' unread');
      var time=new Date(c.createdAt).toLocaleDateString();
      html+='<div class="'+cls+'" onclick="viewConvo(\\''+c.id+'\\')">';
      html+='<div><div class="from">'+c.fromEmail+'</div><div class="subj">'+(c.subject||'(no subject)')+' — '+(c.body||'').substring(0,80)+'</div></div>';
      html+='<div class="time">'+time+'</div></div>';
    });
    el.innerHTML=html;
  }catch(e){console.log("Inbox load error:",e)}
}

async function viewConvo(id){
  try{
    var c=await api("GET","/api/email/inbox/"+id);
    alert("From: "+c.fromEmail+"\\nTo: "+c.toEmail+"\\nSubject: "+(c.subject||"(none)")+"\\n\\n"+c.body);
    loadInbox();
  }catch(e){msg("error","Error: "+e.message)}
}

// ── Load all email data ──
function loadEmailData(){
  loadEmailSettings();
  loadDomains();
  loadAccounts();
  loadCampaigns();
  loadInbox();
}

// Wait for App Bridge iframe handshake before first API call
if(window.shopify&&window.shopify.idToken){
  console.log("[init] waiting for App Bridge readiness...");
  Promise.race([
    shopify.idToken(),
    new Promise(function(r){setTimeout(r,2000)})
  ]).then(function(t){
    console.log("[init] App Bridge",t?"ready":"warm-up timeout",", loading with retry...");
    load();
  }).catch(function(){
    console.log("[init] initial idToken error, loading with retry...");
    load();
  });
}else{
  console.log("[init] no App Bridge, loading immediately");
  load();
}
</script>
</body></html>`;
}

// ─── Start ────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log("[OCE] Running on port " + PORT);
  console.log("[OCE] URL: " + SHOPIFY_APP_URL);
});

export default app;
