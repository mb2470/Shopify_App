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
import path from "path";
import { fileURLToPath } from "url";
import { PrismaClient } from "@prisma/client";
import { OceApiService, createTokenForShop } from "./backend/services/oce-api.js";
import { scanThemeForVideos } from "./backend/services/theme-scanner.js";
import { handleOrderCreated } from "./backend/routes/webhooks.js";
import {
  getSettings,
  updateSettings,
  updateApiKey,
  getIntegrationStatus,
  syncAppMetafields,
  activateWebPixel,
  getAppMetafields,
  getStatsOverview,
  getCreators,
  getRecentOrders,
  getPayouts,
  getAttributionSettings,
  updateAttributionSettings,
  registerAssets,
  getRegisteredAssets,
  getDiscoveredVideos,
  getPortalContent,
  savePortalContent,
} from "./backend/routes/settings.js";
import {
  handleSignup,
  handleVerify,
  handleLogin,
  handleResendCode,
  handleGetProfile,
  handleSubmitVideo,
  handleGetVideos,
  handleGetStats as handleCreatorStats,
  renderPortalPage,
} from "./backend/routes/creator-portal.js";

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Middleware ────────────────────────────────────────────────────
// Webhooks must get raw body for HMAC; do not parse JSON for /webhooks/*
app.post("/webhooks/*", express.raw({ type: "application/json" }));
app.use((req, res, next) => {
  if (req.originalUrl && req.originalUrl.startsWith("/webhooks")) return next();
  express.json()(req, res, next);
});
app.use((req, res, next) => {
  if (req.originalUrl && req.originalUrl.startsWith("/webhooks")) return next();
  express.urlencoded({ extended: true })(req, res, next);
});
app.use(
  "/admin-v2-assets",
  express.static(path.join(__dirname, "frontend", "admin-v2"), { maxAge: "5m" })
);

// ─── Shopify Auth Helpers ─────────────────────────────────────────

const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const SHOPIFY_APP_URL = process.env.SHOPIFY_APP_URL;
const SCOPES =
  "read_orders,write_orders,read_customers,read_products,read_script_tags,write_script_tags,write_pixels,read_customer_events";

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

    const settings = await prisma.oceSettings.findUnique({ where: { shop } });
    if (settings && !settings.apiKey) {
      const tokenResult = await createTokenForShop(shop);
      if (tokenResult?.api_key) {
        await prisma.oceSettings.update({
          where: { shop },
          data: { apiKey: tokenResult.api_key },
        });
        const syncResult = await syncAppMetafields(shop, access_token);
        console.log("[OCE] Auto API key from install; metafield sync:", syncResult?.success ? "ok" : syncResult?.error);
      }
    }

    // Activate OCE Checkout Pixel so attribution works on checkout (e.g. Buy Now)
    const currentSettings = await prisma.oceSettings.findUnique({ where: { shop } });
    const pixelEndpoint = process.env.OCE_PIXEL_COLLECT_URL;
    if (currentSettings?.apiKey && pixelEndpoint) {
      const pixelResult = await activateWebPixel(shop, access_token, currentSettings.apiKey, pixelEndpoint);
      if (!pixelResult.success) {
        console.warn("[OCE] Web pixel activation skipped or failed:", pixelResult.error);
      }
    }

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
        subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
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

    try {
      await prisma.oceSettings.upsert({
        where: { shop },
        create: { shop },
        update: {},
      });
    } catch (settingsErr) {
      // Multiple parallel requests can all reach token exchange on first load.
      // If another request created the row first, continue and use that row.
      if (settingsErr?.code !== "P2002") {
        throw settingsErr;
      }
    }

    const settings = await prisma.oceSettings.findUnique({ where: { shop } });
    if (settings && !settings.apiKey) {
      const tokenResult = await createTokenForShop(shop);
      if (tokenResult?.api_key) {
        await prisma.oceSettings.update({
          where: { shop },
          data: { apiKey: tokenResult.api_key },
        });
        const syncResult = await syncAppMetafields(shop, data.access_token);
        console.log("[OCE] Auto API key from token exchange; metafield sync:", syncResult?.success ? "ok" : syncResult?.error);
      }
    }

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

  let existingWebhooks = [];
  try {
    const existingResp = await fetch(`https://${shop}/admin/api/2024-10/webhooks.json`, {
      headers: { "X-Shopify-Access-Token": accessToken },
    });
    const existingData = await existingResp.json();
    existingWebhooks = existingData.webhooks || [];
  } catch (error) {
    console.warn("[Webhook] Could not load existing webhooks before registration:", error.message);
  }

  const results = [];
  for (const wh of webhooks) {
    const existing = existingWebhooks.find((w) => w.topic === wh.topic);

    if (existing?.address === wh.address) {
      console.log(`[Webhook] ${wh.topic} already registered for ${shop} (id: ${existing.id})`);
      results.push({ topic: wh.topic, status: "already_registered", id: existing.id });
      continue;
    }

    try {
      const isUpdate = !!existing;
      const endpoint = isUpdate
        ? `https://${shop}/admin/api/2024-10/webhooks/${existing.id}.json`
        : `https://${shop}/admin/api/2024-10/webhooks.json`;

      const resp = await fetch(endpoint, {
        method: isUpdate ? "PUT" : "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ webhook: { topic: wh.topic, address: wh.address, format: "json" } }),
      });
      const data = await resp.json();
      if (data.webhook) {
        const status = isUpdate ? "updated" : "registered";
        console.log(`[Webhook] ${status} ${wh.topic} for ${shop} (id: ${data.webhook.id})`);
        results.push({ topic: wh.topic, status, id: data.webhook.id });
      } else {
        const errMsg = JSON.stringify(data.errors || data);
        console.error(`[Webhook] Failed ${wh.topic} for ${shop}: ${errMsg}`);
        results.push({ topic: wh.topic, status: "failed", error: errMsg });
      }
    } catch (error) {
      console.error(`[Webhook] Failed ${wh.topic}:`, error.message);
      results.push({ topic: wh.topic, status: "error", error: error.message });
    }
  }
  return results;
}

// ─── Webhook Endpoints ────────────────────────────────────────────

app.post("/webhooks/orders/create", async (req, res) => {
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
  const shop = req.headers["x-shopify-shop-domain"];

  console.log("[Webhook] Received orders/create from", shop || "unknown",
    "| body size:", req.body?.length || 0,
    "| hmac present:", !!hmacHeader);

  if (!hmacHeader || !verifyWebhookHmac(req.body, hmacHeader)) {
    console.error("[Webhook] HMAC verification FAILED for", shop,
      "| secret set:", !!SHOPIFY_API_SECRET,
      "| secret length:", (SHOPIFY_API_SECRET || "").length,
      "| body type:", typeof req.body,
      "| body is Buffer:", Buffer.isBuffer(req.body));
    return res.status(401).send("Unauthorized");
  }

  console.log("[Webhook] HMAC verified OK for", shop);
  res.status(200).send("OK");

  try {
    const orderData = JSON.parse(req.body.toString());
    console.log("[Webhook] Order", orderData.id, "| total:", orderData.total_price,
      "| note_attributes:", JSON.stringify(orderData.note_attributes || []));
    await handleOrderCreated(shop, orderData);
  } catch (error) {
    console.error("[Webhook] orders/create processing error:", error);
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

// ─── Creator Portal (App Proxy) ─────────────────────────────────
// Shopify proxies /apps/onsite-affiliate/* → /proxy/*

function verifyProxySignature(req) {
  if (!SHOPIFY_API_SECRET) return false;

  // Shopify App Proxy has historically used `signature`, but some deployments
  // can send `hmac` instead. Support both to avoid silently dropping requests.
  const incomingSignature = req.query.signature || req.query.hmac;
  if (!incomingSignature) return false;

  const fullUrl = new URL(`${SHOPIFY_APP_URL || "https://localhost"}${req.originalUrl}`);
  const params = [];

  for (const [key, value] of fullUrl.searchParams.entries()) {
    if (key === "signature" || key === "hmac") continue;
    params.push(`${key}=${value}`);
  }

  const msg = params.sort().join("");
  const computed = crypto
    .createHmac("sha256", SHOPIFY_API_SECRET)
    .update(msg)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(computed, "hex"),
      Buffer.from(String(incomingSignature), "hex")
    );
  } catch {
    return false;
  }
}

const proxyRouter = express.Router();

proxyRouter.use((req, res, next) => {
  if (!verifyProxySignature(req)) {
    console.warn("[Proxy] Signature verification failed", {
      shop: req.query.shop,
      path: req.path,
      hasSignature: Boolean(req.query.signature || req.query.hmac),
      queryKeys: Object.keys(req.query || {}),
    });
    return res.status(401).json({ error: "Invalid app proxy signature" });
  }
  next();
});

proxyRouter.get("/", async (req, res) => {
  const pathPrefix = req.query.path_prefix || "/apps/onsite-affiliate";
  const shop = req.query.shop;
  let portalContent = null;
  if (shop) {
    try {
      const settings = await prisma.oceSettings.findUnique({ where: { shop } });
      if (settings?.portalContent) {
        portalContent = JSON.parse(settings.portalContent);
      }
    } catch (err) {
      console.warn("[Proxy] Failed to load portal content:", err.message);
    }
  }
  res.set("Content-Type", "application/liquid");
  res.send(renderPortalPage(pathPrefix, portalContent));
});

proxyRouter.post("/api/signup", handleSignup);
proxyRouter.post("/api/verify", handleVerify);
proxyRouter.post("/api/login", handleLogin);
proxyRouter.post("/api/resend-code", handleResendCode);
proxyRouter.get("/api/me", handleGetProfile);
proxyRouter.post("/api/submit-video", handleSubmitVideo);
proxyRouter.get("/api/videos", handleGetVideos);
proxyRouter.get("/api/stats", handleCreatorStats);

proxyRouter.post("/exposure", async (req, res) => {
  const hostHeader = (req.headers.host || "").toString().toLowerCase();
  const hostShop = hostHeader.endsWith(".myshopify.com") ? hostHeader : null;
  const shopDomain =
    (req.query.shop || "").toString().trim() ||
    (req.headers["x-shopify-shop-domain"] || "").toString().trim() ||
    hostShop;
  if (!shopDomain) {
    console.warn("[OCE] Proxy exposure missing shop domain", {
      queryShop: req.query.shop,
      headerShop: req.headers["x-shopify-shop-domain"],
      host: req.headers.host,
    });
    return res.status(400).json({ error: "Missing shop domain" });
  }

  const settings = await prisma.oceSettings.findUnique({ where: { shop: shopDomain } });
  if (!settings?.apiKey) {
    console.warn("[OCE] Proxy exposure skipped: OCE API key not configured for", shopDomain);
    return res.status(400).json({ error: "OCE not configured" });
  }

  const { asset_id, session_id, oa_id, sku, creator_external_id } = req.body || {};
  if (!asset_id || !session_id) {
    return res.status(400).json({ error: "asset_id and session_id required" });
  }

  try {
    const oceApi = new OceApiService(settings.apiKey);
    const result = await oceApi.createExposure({
      assetId: asset_id,
      sessionId: session_id,
      oaId: oa_id || undefined,
      sku: sku || undefined,
      creatorExternalId: creator_external_id || undefined,
    });
    console.log("[OCE] Proxy exposure created", {
      shop: shopDomain,
      asset_id,
      exposure_id: result?.exposure_id,
    });
    res.json(result);
  } catch (err) {
    console.error("[OCE] Proxy exposure error:", {
      message: err.message,
      statusCode: err.statusCode,
      responseBody: err.responseBody,
      asset_id,
      shop: shopDomain,
    });
    res.status(500).json({
      error: "Failed to create exposure",
      details: err.responseBody || err.message,
    });
  }
});

app.use("/proxy", proxyRouter);

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
    // Activate OCE Checkout Pixel when API key is set (so pixel works for Buy Now, etc.)
    const pixelEndpoint = process.env.OCE_PIXEL_COLLECT_URL;
    if (req.body.apiKey && pixelEndpoint) {
      const pixelResult = await activateWebPixel(req.shop, req.session.accessToken, req.body.apiKey, pixelEndpoint);
      if (!pixelResult.success) {
        console.warn("[OCE] Web pixel activation on API key save:", pixelResult.error);
      }
    }
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

app.get("/api/debug/webhooks", authenticate, async (req, res) => {
  try {
    const shopApi = `https://${req.shop}/admin/api/2024-10`;
    const response = await fetch(`${shopApi}/webhooks.json`, {
      headers: { "X-Shopify-Access-Token": req.session.accessToken },
    });
    const data = await response.json();
    const webhooks = (data.webhooks || []).map((w) => ({
      id: w.id,
      topic: w.topic,
      address: w.address,
      format: w.format,
      created_at: w.created_at,
      updated_at: w.updated_at,
    }));
    const orderWebhook = webhooks.find((w) => w.topic === "orders/create");
    res.json({
      ok: true,
      expectedAddress: `${SHOPIFY_APP_URL}/webhooks/orders/create`,
      orderWebhook: orderWebhook || null,
      addressMatch: orderWebhook?.address === `${SHOPIFY_APP_URL}/webhooks/orders/create`,
      allWebhooks: webhooks,
      serverConfig: {
        SHOPIFY_APP_URL: SHOPIFY_APP_URL || "NOT SET",
        SHOPIFY_API_SECRET_set: !!SHOPIFY_API_SECRET,
        SHOPIFY_API_SECRET_length: (SHOPIFY_API_SECRET || "").length,
      },
    });
  } catch (err) {
    console.error("[OCE] Debug webhooks error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/webhooks/register", authenticate, async (req, res) => {
  try {
    console.log("[Webhook] Manual registration triggered for", req.shop);
    const results = await registerWebhooks(req.shop, req.session.accessToken);
    res.json({ ok: true, results });
  } catch (err) {
    console.error("[Webhook] Manual registration error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Stats Route ──────────────────────────────────────────────────

app.get("/api/stats", authenticate, async (req, res) => {
  try {
    const periodDays = parseInt(req.query.period_days) || 30;
    const result = await getStatsOverview(req.shop, periodDays);
    console.log("[OCE] GET /api/stats raw response:", JSON.stringify(result));

    // Normalize: the stats may be at result.data or at the top level
    // OCE Management API returns camelCase field names
    const stats = result?.data || result || {};
    res.json({
      ok: result?.ok !== false,
      data: {
        total_exposures: Number(stats.totalExposures ?? stats.total_exposures) || 0,
        total_orders: Number(stats.totalOrders ?? stats.total_orders) || 0,
        total_revenue: Number(stats.totalRevenue ?? stats.total_revenue) || 0,
        total_commission: Number(stats.totalCommission ?? stats.total_commission) || 0,
        chart_data: stats.chartData || stats.chart_data || [],
      },
    });
  } catch (err) {
    console.error("[OCE] GET /api/stats error:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch stats", detail: err.message });
  }
});

// ─── Videos Route ────────────────────────────────────────────────
// Discovers videos from two sources:
//  1. OCE SDK tracked videos (via events.list management API)
//  2. Shopify products with video media (VIDEO / EXTERNAL_VIDEO)

function detectPlatform(assetId) {
  if (!assetId) return "Video";
  const id = assetId.toLowerCase();
  if (id.startsWith("videowise")) return "Videowise";
  if (id.startsWith("tolstoy")) return "Tolstoy";
  if (id.startsWith("firework")) return "Firework";
  if (id.includes("youtube") || id.includes("youtu.be")) return "YouTube";
  if (id.includes("vimeo")) return "Vimeo";
  if (id.startsWith("shopify-video")) return "Shopify";
  if (id.startsWith("shopify-")) return "Shopify";
  return "Video";
}

app.get("/api/videos", authenticate, async (req, res) => {
  try {
    // Source 1: Videos discovered by OCE SDK (from exposure events)
    let oceVideos = [];
    try {
      const discovered = await getDiscoveredVideos(req.shop);
      if (discovered.ok) {
        oceVideos = discovered.videos.map(v => ({
          ...v,
          platform: detectPlatform(v.assetId),
          discoveredBy: "sdk",
        }));
      }
    } catch (err) {
      console.warn("[OCE] Failed to fetch OCE-discovered videos:", err.message);
    }

    // Source 2: Shopify products with video media
    let shopifyVideos = [];
    try {
      const graphqlUrl = `https://${req.shop}/admin/api/2024-10/graphql.json`;
      const query = `{
        products(first: 100, query: "status:active") {
          edges {
            node {
              id
              title
              handle
              featuredImage { url }
              media(first: 10) {
                edges {
                  node {
                    mediaContentType
                    ... on Video { id sources { url mimeType } }
                    ... on ExternalVideo { id originUrl embeddedUrl }
                  }
                }
              }
              variants(first: 100) {
                edges { node { sku } }
              }
            }
          }
        }
      }`;

      const response = await fetch(graphqlUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": req.session.accessToken,
        },
        body: JSON.stringify({ query }),
      });
      const data = await response.json();

      if (data.errors) {
        console.warn("[OCE] Shopify GraphQL errors:", JSON.stringify(data.errors));
      }

      for (const edge of (data.data?.products?.edges || [])) {
        const node = edge.node;
        const videoMedia = (node.media?.edges || [])
          .filter(m => m.node.mediaContentType === "VIDEO" || m.node.mediaContentType === "EXTERNAL_VIDEO");

        if (videoMedia.length === 0) continue; // Skip products without videos

        const skus = (node.variants?.edges || []).map(v => v.node.sku).filter(Boolean);

        for (const vm of videoMedia) {
          const mn = vm.node;
          const videoUrl = mn.sources?.[0]?.url || mn.originUrl || mn.embeddedUrl;
          const mediaId = mn.id.replace(/gid:\/\/shopify\/(Video|ExternalVideo)\//, "");
          const assetId = `shopify-video-${mediaId}`;
          const isExternal = mn.mediaContentType === "EXTERNAL_VIDEO";

          shopifyVideos.push({
            assetId,
            title: node.title + (videoMedia.length > 1 ? ` (${isExternal ? "External" : "Hosted"})` : ""),
            source: videoUrl,
            thumbnail: node.featuredImage?.url || null,
            platform: isExternal ? detectPlatform(videoUrl) : "Shopify",
            skus,
            exposureCount: 0,
            lastSeen: null,
            discoveredBy: "shopify",
          });
        }
      }
    } catch (err) {
      console.warn("[OCE] Failed to fetch Shopify video media:", err.message);
    }

    // Source 3: Scan theme for videos (Liquid files + JSON template configs)
    let themeVideos = [];
    try {
      themeVideos = await scanThemeForVideos(req.shop, req.session.accessToken);
    } catch (err) {
      console.warn("[OCE] Failed to scan theme files:", err.message);
    }

    // Get registered assets to mark status
    const registered = await getRegisteredAssets(req.shop);
    const registeredMap = {};
    for (const ra of registered) registeredMap[ra.assetId] = ra;

    // Merge: OCE SDK videos first, then Shopify media, then storefront-scanned
    const seenIds = new Set(oceVideos.map(v => v.assetId));
    const allVideos = [...oceVideos];
    for (const sv of shopifyVideos) {
      if (!seenIds.has(sv.assetId)) { allVideos.push(sv); seenIds.add(sv.assetId); }
    }
    for (const tv of themeVideos) {
      if (!seenIds.has(tv.assetId)) { allVideos.push(tv); seenIds.add(tv.assetId); }
    }

    // Also include previously registered assets not found in any source
    for (const ra of registered) {
      if (!seenIds.has(ra.assetId)) {
        allVideos.push({
          assetId: ra.assetId,
          title: ra.title || ra.assetId,
          source: ra.videoUrl,
          thumbnail: null,
          platform: detectPlatform(ra.assetId),
          skus: JSON.parse(ra.skus || "[]"),
          exposureCount: 0,
          lastSeen: null,
          discoveredBy: "registered",
        });
        seenIds.add(ra.assetId);
      }
    }

    // Attach registration status
    for (const v of allVideos) {
      const reg = registeredMap[v.assetId];
      v.registered = !!reg;
      v.registeredCreatorId = reg?.creatorId || null;
      v.registeredCreatorName = reg?.creatorName || null;
    }

    console.log("[OCE] GET /api/videos:", allVideos.length, "videos (" +
      oceVideos.length + " SDK, " + shopifyVideos.length + " Shopify media, " +
      themeVideos.length + " theme, " + registered.length + " registered)");
    res.json({ ok: true, videos: allVideos });
  } catch (err) {
    console.error("[OCE] GET /api/videos error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Creators Route ─────────────────────────────────────────────

app.get("/api/creators", authenticate, async (req, res) => {
  try {
    const result = await getCreators(req.shop);
    console.log("[OCE] GET /api/creators:", JSON.stringify(result));
    res.json(result);
  } catch (err) {
    console.error("[OCE] GET /api/creators error:", err);
    res.status(500).json({ ok: false, error: err.message, creators: [] });
  }
});

app.get("/api/orders", authenticate, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const result = await getRecentOrders(req.shop, limit);
    console.log("[OCE] GET /api/orders:", JSON.stringify({
      ok: result.ok,
      total: result.total,
      orders: result.orders?.length || 0,
    }));
    res.json(result);
  } catch (err) {
    console.error("[OCE] GET /api/orders error:", err);
    res.status(500).json({ ok: false, error: err.message, orders: [] });
  }
});

app.get("/api/payouts", authenticate, async (req, res) => {
  try {
    const result = await getPayouts(req.shop);
    console.log("[OCE] GET /api/payouts:", JSON.stringify({
      ok: result.ok,
      payouts: result.payouts?.length || 0,
      totalAmount: result.totalAmount || 0,
    }));
    res.json(result);
  } catch (err) {
    console.error("[OCE] GET /api/payouts error:", err);
    res.status(500).json({ ok: false, error: err.message, payouts: [], totalAmount: 0 });
  }
});

app.get("/api/attribution-settings", authenticate, async (req, res) => {
  try {
    const result = await getAttributionSettings(req.shop);
    console.log("[OCE] GET /api/attribution-settings:", JSON.stringify({
      ok: result.ok,
      hasSettings: !!result.settings,
    }));
    res.json(result);
  } catch (err) {
    console.error("[OCE] GET /api/attribution-settings error:", err);
    res.status(500).json({ ok: false, error: err.message, settings: {} });
  }
});

app.put("/api/attribution-settings", authenticate, async (req, res) => {
  try {
    const result = await updateAttributionSettings(req.shop, req.body || {});
    console.log("[OCE] PUT /api/attribution-settings:", JSON.stringify({ ok: result.ok }));
    res.json(result);
  } catch (err) {
    console.error("[OCE] PUT /api/attribution-settings error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Asset Registration Route ───────────────────────────────────

app.post("/api/assets/register", authenticate, async (req, res) => {
  try {
    const { assets } = req.body;
    if (!assets || !Array.isArray(assets) || assets.length === 0) {
      return res.status(400).json({ ok: false, error: "No assets provided" });
    }
    console.log("[OCE] POST /api/assets/register:", assets.length, "assets");
    const result = await registerAssets(req.shop, assets);
    res.json(result);
  } catch (err) {
    console.error("[OCE] POST /api/assets/register error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/portal-content", authenticate, async (req, res) => {
  try {
    const content = await getPortalContent(req.shop);
    res.json({ ok: true, content });
  } catch (err) {
    console.error("[OCE] GET /api/portal-content error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.put("/api/portal-content", authenticate, async (req, res) => {
  try {
    const result = await savePortalContent(req.shop, req.body);
    res.json({ ok: true, content: result.content });
  } catch (err) {
    console.error("[OCE] PUT /api/portal-content error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Admin UI ─────────────────────────────────────────────────────

app.get("/app", (req, res) => {
  // Allow embedding in Shopify Admin
  res.setHeader(
    "Content-Security-Policy",
    "frame-ancestors https://*.myshopify.com https://admin.shopify.com;"
  );
  res.sendFile(path.join(__dirname, "frontend", "admin-v2", "index.html"));
});

app.get("/", (req, res) => {
  // Primary Shopify embedded app entrypoint.
  // Always serve the new admin-v2 dashboard shell so brand admins
  // see the updated dashboard without needing a query flag.
  res.setHeader(
    "Content-Security-Policy",
    "frame-ancestors https://*.myshopify.com https://admin.shopify.com;"
  );
  res.sendFile(path.join(__dirname, "frontend", "admin-v2", "index.html"));
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
    .rt-toolbar{display:flex;gap:2px;border:1px solid #c9cccf;border-bottom:none;border-radius:8px 8px 0 0;padding:4px 6px;background:#f6f6f7}
    .rt-toolbar button{background:none;border:1px solid transparent;border-radius:4px;padding:2px 8px;font-size:13px;cursor:pointer;color:#202223}
    .rt-toolbar button:hover{background:#e1e3e5}
    .rt-editor{min-height:48px;padding:8px 12px;border:1px solid #c9cccf;border-radius:0 0 8px 8px;font-size:14px;line-height:1.5;outline:none;font-family:inherit}
    .rt-editor:focus{border-color:#005bd3;box-shadow:0 0 0 1px #005bd3}
    .rt-editor a{color:#005bd3;text-decoration:underline}
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
    .asset-table{width:100%;border-collapse:collapse;margin-top:12px}
    .asset-table th{text-align:left;padding:8px 12px;font-size:13px;font-weight:600;color:#6d7175;border-bottom:2px solid #e1e3e5;background:#f6f6f7}
    .asset-table td{padding:10px 12px;font-size:13px;border-bottom:1px solid #f1f1f1;vertical-align:middle}
    .asset-table tr:hover{background:#f9fafb}
    .asset-table input[type=checkbox]{width:16px;height:16px;cursor:pointer}
    .asset-img{width:40px;height:40px;border-radius:6px;object-fit:cover;background:#f6f6f7}
    .sku-tags{display:flex;flex-wrap:wrap;gap:4px}
    .sku-tag{background:#e4e5e7;color:#44474a;padding:1px 6px;border-radius:4px;font-size:11px}
    .asset-toolbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
    .asset-toolbar select{width:auto;min-width:200px}
    .btn-sm{padding:4px 12px;font-size:13px;border-radius:6px}
    .btn-danger{background:#fff4f4;color:#6e1717;border:1px solid #fed3d1}
  </style>
</head>
<body>
<div class="app">
  <div id="sb" class="banner banner-ok"></div>
  <div id="eb" class="banner banner-err"></div>

  <div class="header"><div><h1>Onsite Commission Engine</h1><p>Track creator video engagement and attribute conversions</p></div>
    <a href="https://app.onsiteaffiliate.com/dashboard" target="_blank" class="btn btn-p">View OCE Dashboard ↗</a></div>

  <div class="card"><div class="card-row"><h2>Integration Status</h2><span id="ob" class="badge b-info">Loading...</span></div>
    <div class="grid-3">
      <div class="status-box"><h3>🔗 SDK Script</h3><span id="sb1" class="badge b-info">—</span><p id="sm1" style="font-size:12px;color:#6d7175;margin-top:6px"></p></div>
      <div class="status-box"><h3>📦 Order Webhook</h3><span id="sb2" class="badge b-info">—</span><p id="sm2" style="font-size:12px;color:#6d7175;margin-top:6px"></p><button class="btn btn-link" style="font-size:11px;padding:2px 4px;margin-top:4px" onclick="debugWebhook()">Diagnose</button><pre id="wh-debug" style="display:none;font-size:11px;background:#1e2124;color:#95c7f3;padding:8px;border-radius:6px;margin-top:6px;white-space:pre-wrap;max-height:200px;overflow:auto"></pre><button id="wh-register-btn" class="btn" style="display:none;margin-top:6px;background:#d72c0d;color:#fff;font-size:12px;padding:6px 12px" onclick="registerWebhooks()">Register Now</button></div>
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
    <div class="cl-item"><div class="cl-n">1</div><div class="cl-c"><h4>Create an OCE Account</h4><p><a href="https://app.onsiteaffiliate.com/auth" target="_blank">Sign up at app.onsiteaffiliate.com</a></p></div></div>
    <div class="cl-item"><div class="cl-n">2</div><div class="cl-c"><h4>Generate an API Key</h4><p>Settings → API Keys in OCE dashboard</p></div></div>
    <div class="cl-item"><div class="cl-n">3</div><div class="cl-c"><h4>Paste Your Key Above</h4><p>Enter your API key to connect</p></div></div>
    <div class="cl-item"><div class="cl-n">4</div><div class="cl-c"><h4>Configure Attribution</h4><p><a href="https://app.onsiteaffiliate.com/dashboard/settings" target="_blank">Set commission rates, window, and events</a></p></div></div>
    <div class="cl-item"><div class="cl-n">5</div><div class="cl-c"><h4>Register Video Assets</h4><p>Use the Asset Registration section below to register products</p></div></div>
  </div>

  <div class="grid-2">
    <div class="card"><div class="card-row"><div><h2>OCE SDK Script</h2><p style="font-size:13px;color:#6d7175">Auto-injects tracking into storefront</p></div>
      <div class="tog" onclick="tSdk()"><div id="st" class="tog-t on"><div class="tog-th"></div></div></div></div>
      <div id="sc" style="margin-top:12px"><div class="code">&lt;script<br>&nbsp;&nbsp;src="https://app.onsiteaffiliate.com/sdk/oce.min.js?v=1.2.5"<br>&nbsp;&nbsp;data-api-key="<span id="pk">YOUR_KEY</span>"<br>&nbsp;&nbsp;defer&gt;<br>&lt;/script&gt;</div>
      <p style="font-size:12px;color:#6d7175;margin-top:8px">Auto-detects Videowise, Tolstoy, Firework, YouTube, Vimeo, HTML5 players.</p></div>
    </div>
    <div class="card"><div class="card-row"><div><h2>Order Webhook</h2><p style="font-size:13px;color:#6d7175">Sends orders to OCE for attribution</p></div>
      <div class="tog" onclick="tWh()"><div id="wt" class="tog-t on"><div class="tog-th"></div></div></div></div>
      <p style="font-size:13px;color:#6d7175;margin-top:12px">Order details and exposure IDs sent to OCE REST API on checkout.</p>
      <div id="ro" style="margin-top:12px"></div>
    </div>
    <div class="card"><div class="card-row"><div><h2>Intercept checkout / Buy now</h2><p style="font-size:13px;color:#6d7175">Sync cart attribution before redirect (400ms cap); turn OFF if a brand objects</p></div>
      <div class="tog" onclick="tIntercept()"><div id="it" class="tog-t on"><div class="tog-th"></div></div></div></div>
      <p style="font-size:12px;color:#6d7175;margin-top:8px">Default: ON. When ON, clicks to checkout or buy-now trigger a quick cart-attribute sync then redirect.</p>
    </div>
  </div>

  <div class="card">
    <div class="card-row"><h2>Video Asset Registration</h2>
      <button class="btn btn-link" id="assets-toggle" onclick="toggleAssets()">Expand &#9662;</button>
    </div>
    <p style="font-size:13px;color:#6d7175;margin-top:4px">Videos discovered by the OCE SDK and Shopify product media. Register them to enable attribution tracking.</p>
    <div id="assets-panel" style="display:none"><hr>
      <div id="assets-loading" style="display:none;text-align:center;padding:20px;color:#6d7175">Discovering videos and loading creators...</div>
      <div id="assets-error" style="display:none;color:#6e1717;padding:12px;background:#fff4f4;border-radius:8px;margin-bottom:12px"></div>
      <div id="assets-success" style="display:none;color:#0b5e3b;padding:12px;background:#f1f8f5;border:1px solid #aee9d1;border-radius:8px;margin-bottom:12px"></div>
      <div id="assets-content" style="display:none">
        <div class="asset-toolbar">
          <label style="font-size:13px;font-weight:500">Creator:</label>
          <select id="creator-select"><option value="">-- Select a creator --</option></select>
          <button class="btn btn-p btn-sm" id="bulk-register-btn" onclick="bulkRegister()" disabled>Register Selected (0)</button>
          <button class="btn btn-s btn-sm" onclick="loadAssetData()">Refresh</button>
        </div>
        <table class="asset-table">
          <thead>
            <tr>
              <th style="width:36px"><input type="checkbox" id="select-all" onclick="toggleSelectAll()" /></th>
              <th>Video</th>
              <th>Platform</th>
              <th>SKUs</th>
              <th>Exposures</th>
              <th>Status</th>
              <th style="width:100px">Action</th>
            </tr>
          </thead>
          <tbody id="assets-tbody"></tbody>
        </table>
        <div id="assets-empty" style="display:none;text-align:center;padding:24px;color:#6d7175">
          <p style="font-size:14px;font-weight:500;margin-bottom:8px">No videos discovered yet</p>
          <p>Make sure the OCE SDK is enabled and your storefront has video content.<br>The SDK auto-detects Videowise, Tolstoy, Firework, YouTube, Vimeo, and HTML5 video players.</p>
        </div>
        <div style="margin-top:16px;border-top:1px solid #e1e3e5;padding-top:16px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;cursor:pointer" onclick="document.getElementById('manual-form').style.display=document.getElementById('manual-form').style.display==='none'?'block':'none';this.querySelector('span').textContent=document.getElementById('manual-form').style.display==='none'?'\\u25BE':'\\u25B4'">
            <strong style="font-size:14px">+ Add Video Manually</strong><span style="font-size:12px">\\u25BE</span>
          </div>
          <div id="manual-form" style="display:none;background:#f9fafb;border:1px solid #e1e3e5;border-radius:8px;padding:16px">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
              <div>
                <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">Asset ID <span style="color:#d72c0d">*</span></label>
                <input type="text" id="manual-asset-id" placeholder="e.g. my-video-001" style="width:100%;padding:8px;border:1px solid #c9cccf;border-radius:6px;font-size:13px" />
              </div>
              <div>
                <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">Title</label>
                <input type="text" id="manual-title" placeholder="e.g. Product Demo Video" style="width:100%;padding:8px;border:1px solid #c9cccf;border-radius:6px;font-size:13px" />
              </div>
              <div>
                <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">SKUs <span style="font-weight:400;color:#6d7175">(comma-separated)</span></label>
                <input type="text" id="manual-skus" placeholder="e.g. SKU-001, SKU-002" style="width:100%;padding:8px;border:1px solid #c9cccf;border-radius:6px;font-size:13px" />
              </div>
              <div>
                <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">Creator</label>
                <select id="manual-creator-select" style="width:100%;padding:8px;border:1px solid #c9cccf;border-radius:6px;font-size:13px;background:#fff"><option value="">-- Use creator from above --</option></select>
              </div>
            </div>
            <div style="margin-top:12px;display:flex;gap:8px;align-items:center">
              <button class="btn btn-p btn-sm" onclick="manualRegister()">Register</button>
              <span id="manual-error" style="display:none;color:#d72c0d;font-size:12px"></span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="card"><div class="card-row"><h2>Statistics</h2><button class="btn btn-link" id="stats-toggle" onclick="toggleStats()">Expand ▾</button></div>
    <div id="stats-panel" style="display:none"><hr>
      <div style="display:flex;gap:8px;margin-bottom:16px">
        <button class="btn btn-s" id="sp7" onclick="loadStats(7)">7 days</button>
        <button class="btn btn-p" id="sp30" onclick="loadStats(30)">30 days</button>
        <button class="btn btn-s" id="sp90" onclick="loadStats(90)">90 days</button>
      </div>
      <div id="stats-loading" style="display:none;text-align:center;padding:20px;color:#6d7175">Loading statistics...</div>
      <div id="stats-content" style="display:none">
        <div class="grid-3">
          <div class="status-box"><h3>Total Exposures</h3><p id="stat-exp" style="font-size:24px;font-weight:600;margin-top:4px">—</p></div>
          <div class="status-box"><h3>Total Orders</h3><p id="stat-ord" style="font-size:24px;font-weight:600;margin-top:4px">—</p></div>
          <div class="status-box"><h3>Total Revenue</h3><p id="stat-rev" style="font-size:24px;font-weight:600;margin-top:4px">—</p></div>
          <div class="status-box"><h3>Total Commission</h3><p id="stat-com" style="font-size:24px;font-weight:600;margin-top:4px">—</p></div>
          <div class="status-box"><h3>Active Creators</h3><p id="stat-cre" style="font-size:24px;font-weight:600;margin-top:4px">—</p></div>
          <div class="status-box"><h3>Active Assets</h3><p id="stat-ast" style="font-size:24px;font-weight:600;margin-top:4px">—</p></div>
        </div>
      </div>
      <div id="stats-error" style="display:none;color:#6e1717;padding:12px;background:#fff4f4;border-radius:8px"></div>
    </div>
  </div>

  <div class="card">
    <div class="card-row"><div><h2>Creator Portal</h2><p style="font-size:13px;color:#6d7175">Edit the copy displayed on your creator signup portal</p></div>
      <button class="btn btn-link" id="portal-toggle" onclick="togglePortal()">Expand &#9662;</button>
    </div>
    <div id="portal-panel" style="display:none"><hr>
      <div id="portal-saved" style="display:none;color:#0b5e3b;padding:12px;background:#f1f8f5;border:1px solid #aee9d1;border-radius:8px;margin-bottom:12px">Portal content saved successfully.</div>
      <div id="portal-error" style="display:none;color:#6e1717;padding:12px;background:#fff4f4;border-radius:8px;margin-bottom:12px"></div>
      <div id="portal-loading" style="display:none;text-align:center;padding:20px;color:#6d7175">Loading portal content...</div>
      <div id="portal-content">
        <h3 style="font-size:14px;font-weight:600;margin-bottom:12px">Page Header</h3>
        <div class="grid-2">
          <div class="form-g"><label>Page Title</label><input type="text" id="pc-pageTitle"><p class="help">Use {store} for the store name</p></div>
          <div class="form-g"><label>Signup Card Title</label><input type="text" id="pc-signupCardTitle"></div>
        </div>
        <div class="form-g"><label>Page Subtitle</label>
          <div class="rt-toolbar"><button type="button" onclick="rtCmd('bold')" title="Bold"><b>B</b></button><button type="button" onclick="rtCmd('italic')" title="Italic"><i>I</i></button><button type="button" onclick="rtLink()" title="Insert Link">Link</button></div>
          <div class="rt-editor" contenteditable="true" id="pc-pageSubtitle"></div>
        </div>
        <div class="form-g"><label>Page Subtitle (line 2)</label>
          <div class="rt-toolbar"><button type="button" onclick="rtCmd('bold')" title="Bold"><b>B</b></button><button type="button" onclick="rtCmd('italic')" title="Italic"><i>I</i></button><button type="button" onclick="rtLink()" title="Insert Link">Link</button></div>
          <div class="rt-editor" contenteditable="true" id="pc-pageSubtitle2"></div>
        </div>
        <div class="form-g"><label>Signup Card Subtitle</label><input type="text" id="pc-signupCardSubtitle"></div>
        <hr>
        <h3 style="font-size:14px;font-weight:600;margin:12px 0">Benefit Cards <label style="font-weight:400;font-size:13px;margin-left:12px"><input type="checkbox" id="pc-showBenefits" checked onchange="togglePortalSection('benefits',this.checked)"> Visible on portal</label></h3>
        <div id="pc-benefits-fields" class="grid-2">
          <div class="form-g"><label>Benefit 1 Title</label><input type="text" id="pc-benefit1Title"></div>
          <div class="form-g"><label>Benefit 1 Description</label><input type="text" id="pc-benefit1Desc"></div>
          <div class="form-g"><label>Benefit 2 Title</label><input type="text" id="pc-benefit2Title"></div>
          <div class="form-g"><label>Benefit 2 Description</label><input type="text" id="pc-benefit2Desc"></div>
          <div class="form-g"><label>Benefit 3 Title</label><input type="text" id="pc-benefit3Title"></div>
          <div class="form-g"><label>Benefit 3 Description</label><input type="text" id="pc-benefit3Desc"></div>
        </div>
        <hr>
        <h3 style="font-size:14px;font-weight:600;margin:12px 0">Key Terms <label style="font-weight:400;font-size:13px;margin-left:12px"><input type="checkbox" id="pc-showTerms" checked onchange="togglePortalSection('terms',this.checked)"> Visible on portal</label></h3>
        <div id="pc-terms-fields">
          <div class="form-g"><label>Terms Section Heading</label><input type="text" id="pc-termsHeading"></div>
          <div class="grid-2">
            <div class="form-g"><label>Term 1 Icon</label><input type="text" id="pc-term1Icon" style="width:60px"></div>
            <div class="form-g"><label>Term 1 Text</label><input type="text" id="pc-term1Text"><p class="help">Use {store} for the store name</p></div>
            <div class="form-g"><label>Term 2 Icon</label><input type="text" id="pc-term2Icon" style="width:60px"></div>
            <div class="form-g"><label>Term 2 Text</label><input type="text" id="pc-term2Text"></div>
            <div class="form-g"><label>Term 3 Icon</label><input type="text" id="pc-term3Icon" style="width:60px"></div>
            <div class="form-g"><label>Term 3 Text</label><input type="text" id="pc-term3Text"><p class="help">Use {store} for the store name</p></div>
            <div class="form-g"><label>Term 4 Icon</label><input type="text" id="pc-term4Icon" style="width:60px"></div>
            <div class="form-g"><label>Term 4 Text</label><input type="text" id="pc-term4Text"><p class="help">Use {store} for the store name</p></div>
          </div>
        </div>
        <hr>
        <h3 style="font-size:14px;font-weight:600;margin:12px 0">Dashboard Labels</h3>
        <div class="grid-3">
          <div class="form-g"><label>Dashboard Title</label><input type="text" id="pc-dashboardTitle"></div>
          <div class="form-g"><label>Submit Video Title</label><input type="text" id="pc-submitVideoTitle"></div>
          <div class="form-g"><label>Your Videos Title</label><input type="text" id="pc-yourVideosTitle"></div>
        </div>
        <hr>
        <h3 style="font-size:14px;font-weight:600;margin:12px 0">Custom CSS</h3>
        <div class="form-g"><label>Additional styles applied to the creator portal</label>
          <textarea id="pc-customCSS" rows="4" style="width:100%;padding:8px 12px;border:1px solid #c9cccf;border-radius:8px;font-size:13px;font-family:'SF Mono',Monaco,Consolas,monospace;resize:vertical;background:#fafafa" placeholder="#oce-portal .benefit-card { background: #f0f8ff; }"></textarea>
          <p class="help">Scope styles under #oce-portal to avoid conflicts with the storefront theme</p>
        </div>
        <hr>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="btn btn-p" id="portal-save-btn" onclick="savePortalContent()">Save Portal Content</button>
          <button class="btn btn-s" id="portal-preview-btn" onclick="previewPortal()">Preview on Store</button>
        </div>
      </div>
    </div>
  </div>

  <div class="card"><h2>How It Works</h2>
    <div class="grid-4">
      <div class="fs"><div class="ic">&#9654;&#65039;</div><h4>Video Plays</h4><p>User watches creator content</p></div>
      <div class="fs"><div class="ic">&#128202;</div><h4>Events Tracked</h4><p>Impressions, clicks, watch</p></div>
      <div class="fs"><div class="ic">&#128722;</div><h4>Order Received</h4><p>Conversion via webhook</p></div>
      <div class="fs"><div class="ic">&#128176;</div><h4>Attribution</h4><p>Commission calculated</p></div>
    </div>
  </div>
</div>

<script>
const S="${shop}",B="";
let st={sdk:true,wh:true,intercept:true,key:false};
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
function bg(s){const m={active:["b-ok","Active"],connected:["b-ok","Connected"],healthy:["b-ok","Healthy"],disabled:["b-warn","Disabled"],inactive:["b-err","Inactive"],error:["b-err","Error"],not_configured:["b-warn","Not Configured"]};const[c,l]=m[s]||["b-info",s];return{cls:"badge "+c,label:l,html:'<span class="badge '+c+'">'+l+"</span>"}}
function setBadge(id,s){var b=bg(s);var el=document.getElementById(id);if(el){el.className=b.cls;el.textContent=b.label}}

async function load(){
  try{
    const s=await api("GET","/api/settings");
    if(s.hasApiKey){document.getElementById("kd").style.display="block";document.getElementById("kf").style.display="none";document.getElementById("mk").textContent=s.apiKey;document.getElementById("qs").style.display="none";document.getElementById("pk").textContent=s.apiKey}
    tog("st",s.sdkEnabled);tog("wt",s.webhookEnabled);tog("it",s.interceptAttribution!==false);st.sdk=s.sdkEnabled;st.wh=s.webhookEnabled;st.intercept=s.interceptAttribution!==false;
  }catch(e){console.log("Settings load pending auth")}
  try{
    const x=await api("GET","/api/settings/status");
    setBadge("ob",x.overall);
    setBadge("sb1",x.sdk.status);document.getElementById("sm1").textContent=x.sdk.message;
    setBadge("sb2",x.webhook.status);document.getElementById("sm2").textContent=x.webhook.message;
    setBadge("sb3",x.apiConnection.status);document.getElementById("sm3").textContent=x.apiConnection.message;
    if(x.recentOrders&&x.recentOrders.length)document.getElementById("ro").innerHTML="<strong>Recent Orders</strong>"+x.recentOrders.map(o=>'<div class="o-row"><span>#'+o.shopifyOrderId+"</span>"+bg(o.status).html+"</div>").join("");
  }catch(e){console.log("Status load pending auth")}
}

async function debugWebhook(){
  var el=document.getElementById("wh-debug");
  el.style.display="block";el.textContent="Checking...";
  try{
    var r=await api("GET","/api/debug/webhooks");
    var lines=[];
    lines.push("Webhook URL expected: "+r.expectedAddress);
    if(r.orderWebhook){
      lines.push("Webhook registered:   "+r.orderWebhook.address);
      lines.push("Address match:        "+(r.addressMatch?"YES":"NO — MISMATCH!"));
      lines.push("Last updated:         "+r.orderWebhook.updated_at);
    }else{
      lines.push("ORDER WEBHOOK NOT FOUND in Shopify!");
      lines.push("Available webhooks: "+r.allWebhooks.map(function(w){return w.topic}).join(", "));
      lines.push("");
      lines.push("Click 'Register Now' below to fix this.");
    }
    lines.push("");
    lines.push("Server config:");
    lines.push("  SHOPIFY_APP_URL:    "+r.serverConfig.SHOPIFY_APP_URL);
    lines.push("  API_SECRET set:     "+r.serverConfig.SHOPIFY_API_SECRET_set);
    lines.push("  API_SECRET length:  "+r.serverConfig.SHOPIFY_API_SECRET_length);
    el.textContent=lines.join("\\n");
    var regBtn=document.getElementById("wh-register-btn");
    if(regBtn) regBtn.style.display=r.orderWebhook?"none":"inline-block";
  }catch(e){el.textContent="Error: "+e.message}
}

async function registerWebhooks(){
  var btn=document.getElementById("wh-register-btn");
  btn.disabled=true;btn.textContent="Registering...";
  try{
    var r=await api("POST","/api/webhooks/register");
    btn.textContent="Register Now";btn.disabled=false;
    if(r.ok){
      var msgs=r.results.map(function(x){return x.topic+": "+x.status+(x.error?" ("+x.error+")":"")});
      alert("Webhook registration results:\\n\\n"+msgs.join("\\n"));
      debugWebhook();
    }else{
      alert("Registration failed: "+(r.error||"Unknown error"));
    }
  }catch(e){btn.textContent="Register Now";btn.disabled=false;alert("Error: "+e.message)}
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

let statsOpen=false;
function toggleStats(){
  statsOpen=!statsOpen;
  document.getElementById("stats-panel").style.display=statsOpen?"block":"none";
  document.getElementById("stats-toggle").textContent=statsOpen?"Collapse ▴":"Expand ▾";
  if(statsOpen&&!document.getElementById("stats-content").dataset.loaded){loadStats(30)}
}
function setActivePeriod(days){
  ["sp7","sp30","sp90"].forEach(function(id){
    var el=document.getElementById(id);
    el.className=el.id==="sp"+days?"btn btn-p":"btn btn-s";
  });
}
async function loadStats(days){
  setActivePeriod(days);
  document.getElementById("stats-loading").style.display="block";
  document.getElementById("stats-content").style.display="none";
  document.getElementById("stats-error").style.display="none";
  try{
    var r=await api("GET","/api/stats?period_days="+days);
    console.log("[stats] response:",JSON.stringify(r));
    if(r.ok!==false&&r.data){
      var d=r.data;
      var fmt=function(v){return (Number(v)||0).toLocaleString()};
      var cur=function(v){return "$"+(Number(v)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})};
      document.getElementById("stat-exp").textContent=fmt(d.total_exposures);
      document.getElementById("stat-ord").textContent=fmt(d.total_orders);
      document.getElementById("stat-rev").textContent=cur(d.total_revenue);
      document.getElementById("stat-com").textContent=cur(d.total_commission);
      document.getElementById("stat-cre").textContent=fmt(d.active_creators);
      document.getElementById("stat-ast").textContent=fmt(d.active_assets);
      document.getElementById("stats-content").style.display="block";
      document.getElementById("stats-content").dataset.loaded="1";
    }else{
      document.getElementById("stats-error").textContent=r.error||"Failed to load statistics";
      document.getElementById("stats-error").style.display="block";
    }
  }catch(e){
    document.getElementById("stats-error").textContent="Error: "+e.message;
    document.getElementById("stats-error").style.display="block";
  }
  document.getElementById("stats-loading").style.display="none";
}

function tog(id,v){const e=document.getElementById(id);if(v)e.classList.add("on");else e.classList.remove("on")}
async function tSdk(){st.sdk=!st.sdk;tog("st",st.sdk);document.getElementById("sc").style.display=st.sdk?"block":"none";try{await api("PUT","/api/settings",{sdkEnabled:st.sdk})}catch(e){console.error("Toggle SDK error:",e);st.sdk=!st.sdk;tog("st",st.sdk)}}
async function tWh(){st.wh=!st.wh;tog("wt",st.wh);try{await api("PUT","/api/settings",{webhookEnabled:st.wh})}catch(e){console.error("Toggle webhook error:",e);st.wh=!st.wh;tog("wt",st.wh)}}
async function tIntercept(){st.intercept=!st.intercept;tog("it",st.intercept);try{await api("PUT","/api/settings",{interceptAttribution:st.intercept})}catch(e){console.error("Toggle intercept error:",e);st.intercept=!st.intercept;tog("it",st.intercept)}}

// ── Video Asset Registration ──
let assetsOpen=false;
let assetVideos=[];
let assetCreators=[];
let selectedAssets=new Set();

function toggleAssets(){
  assetsOpen=!assetsOpen;
  document.getElementById("assets-panel").style.display=assetsOpen?"block":"none";
  document.getElementById("assets-toggle").textContent=assetsOpen?"Collapse \\u25B4":"Expand \\u25BE";
  if(assetsOpen&&!document.getElementById("assets-content").dataset.loaded){loadAssetData()}
}

async function loadAssetData(){
  document.getElementById("assets-loading").style.display="block";
  document.getElementById("assets-content").style.display="none";
  document.getElementById("assets-error").style.display="none";
  document.getElementById("assets-success").style.display="none";
  selectedAssets.clear();
  try{
    var vr=api("GET","/api/videos");
    var cr=api("GET","/api/creators");
    var videosResp=await vr;
    var creators=await cr;
    console.log("[assets] videos:",JSON.stringify(videosResp).substring(0,300));
    console.log("[assets] creators:",JSON.stringify(creators).substring(0,200));
    if(videosResp.ok===false)throw new Error(videosResp.error||"Failed to discover videos");
    assetVideos=videosResp.videos||[];
    assetCreators=(creators.ok!==false&&creators.creators)?creators.creators:[];
    renderCreatorDropdown();
    renderAssetTable();
    document.getElementById("assets-content").style.display="block";
    document.getElementById("assets-content").dataset.loaded="1";
  }catch(e){
    document.getElementById("assets-error").textContent="Error: "+e.message;
    document.getElementById("assets-error").style.display="block";
  }
  document.getElementById("assets-loading").style.display="none";
}

function renderCreatorDropdown(){
  var sel=document.getElementById("creator-select");
  var manSel=document.getElementById("manual-creator-select");
  sel.innerHTML='<option value="">-- Select a creator --</option>';
  manSel.innerHTML='<option value="">-- Use creator from above --</option>';
  assetCreators.forEach(function(c){
    var id=c.id||c.external_id||c.creator_id||"";
    var name=c.name||c.display_name||c.external_id||id;
    var opt='<option value="'+id+'" data-name="'+name.replace(/"/g,"&quot;")+'">'+name+'</option>';
    sel.innerHTML+=opt;
    manSel.innerHTML+=opt;
  });
}

function srcBadge(src){
  var map={sdk:["b-ok","SDK Tracked"],shopify:["b-info","Shopify Media"],theme:["b-ok","Theme"],manual:["b-info","Manual"],registered:["b-warn","Previously Registered"]};
  var m=map[src]||["b-info",src];
  return '<span class="badge '+m[0]+'">'+m[1]+'</span>';
}

function renderAssetTable(){
  var tbody=document.getElementById("assets-tbody");
  if(!assetVideos.length){
    tbody.innerHTML="";
    document.getElementById("assets-empty").style.display="block";
    return;
  }
  document.getElementById("assets-empty").style.display="none";
  tbody.innerHTML=assetVideos.map(function(v){
    var title=v.title||v.assetId;
    var sourceUrl=v.source?'<a href="'+v.source+'" target="_blank" style="font-size:11px;word-break:break-all">'+v.source.substring(0,60)+(v.source.length>60?"...":"")+'</a>':"";
    var skus=v.skus&&v.skus.length?v.skus.map(function(s){return '<span class="sku-tag">'+s+'</span>'}).join(""):'<span style="color:#6d7175;font-size:12px">&mdash;</span>';
    var expCount=v.exposureCount?'<strong>'+v.exposureCount.toLocaleString()+'</strong>':'<span style="color:#6d7175">0</span>';
    var status=v.registered?'<span class="badge b-ok">Registered</span>'+(v.registeredCreatorName?' <span style="font-size:11px;color:#6d7175">'+v.registeredCreatorName+'</span>':""):'<span class="badge b-info">Not registered</span>';
    var aid=v.assetId.replace(/'/g,"\\\\'");
    var action=v.registered?'<button class="btn btn-s btn-sm" onclick="registerSingle(\\''+aid+'\\')">Update</button>':'<button class="btn btn-p btn-sm" onclick="registerSingle(\\''+aid+'\\')">Register</button>';
    var checked=selectedAssets.has(v.assetId)?"checked":"";
    return '<tr data-id="'+v.assetId+'"><td><input type="checkbox" '+checked+' onchange="toggleAssetSelect(\\''+aid+'\\',this.checked)" /></td><td><strong>'+title+'</strong><br><span style="font-size:11px;color:#6d7175">'+v.assetId+'</span><br>'+sourceUrl+'</td><td>'+v.platform+' '+srcBadge(v.discoveredBy)+'</td><td><div class="sku-tags">'+skus+'</div></td><td>'+expCount+'</td><td>'+status+'</td><td>'+action+'</td></tr>';
  }).join("");
  updateBulkBtn();
}

function toggleAssetSelect(id,checked){
  if(checked)selectedAssets.add(id);else selectedAssets.delete(id);
  updateBulkBtn();
}

function toggleSelectAll(){
  var all=document.getElementById("select-all").checked;
  assetVideos.forEach(function(v){
    if(all)selectedAssets.add(v.assetId);else selectedAssets.delete(v.assetId);
  });
  renderAssetTable();
  document.getElementById("select-all").checked=all;
}

function updateBulkBtn(){
  var btn=document.getElementById("bulk-register-btn");
  var n=selectedAssets.size;
  btn.textContent="Register Selected ("+n+")";
  btn.disabled=n===0;
}

function getSelectedCreator(){
  var sel=document.getElementById("creator-select");
  var opt=sel.options[sel.selectedIndex];
  return {id:sel.value,name:opt?opt.getAttribute("data-name"):""};
}

async function registerSingle(assetId){
  var v=assetVideos.find(function(x){return x.assetId===assetId});
  if(!v)return;
  var creator=getSelectedCreator();
  await doRegister([v],creator);
}

async function bulkRegister(){
  var creator=getSelectedCreator();
  var selected=assetVideos.filter(function(v){return selectedAssets.has(v.assetId)});
  if(!selected.length)return;
  await doRegister(selected,creator);
}

async function doRegister(videos,creator){
  document.getElementById("assets-error").style.display="none";
  document.getElementById("assets-success").style.display="none";
  var assets=videos.map(function(v){
    var asset={
      asset_id:v.assetId,
      title:v.title||v.assetId,
      skus:v.skus||[],
      thumbnail_url:v.thumbnail||undefined,
      source:v.source||undefined,
      metadata:{platform:v.platform,discovered_by:v.discoveredBy}
    };
    if(creator.id){asset.creator_id=creator.id;asset.creator_name=creator.name}
    return asset;
  });
  try{
    var r=await api("POST","/api/assets/register",{assets:assets});
    console.log("[assets] register response:",JSON.stringify(r));
    if(r.ok!==false){
      var s=r.succeeded||assets.length;
      var f=r.failed||0;
      document.getElementById("assets-success").textContent=s+" video(s) registered successfully"+(f?" ("+f+" failed)":"")+"!";
      document.getElementById("assets-success").style.display="block";
      selectedAssets.clear();
      document.getElementById("assets-content").dataset.loaded="";
      loadAssetData();
    }else{
      document.getElementById("assets-error").textContent=r.error||"Registration failed";
      document.getElementById("assets-error").style.display="block";
    }
  }catch(e){
    document.getElementById("assets-error").textContent="Error: "+e.message;
    document.getElementById("assets-error").style.display="block";
  }
}

async function manualRegister(){
  var errEl=document.getElementById("manual-error");
  errEl.style.display="none";
  var assetId=document.getElementById("manual-asset-id").value.trim();
  if(!assetId){errEl.textContent="Asset ID is required";errEl.style.display="inline";return}
  var title=document.getElementById("manual-title").value.trim()||assetId;
  var skusRaw=document.getElementById("manual-skus").value.trim();
  var skus=skusRaw?skusRaw.split(",").map(function(s){return s.trim()}).filter(Boolean):[];
  var manSel=document.getElementById("manual-creator-select");
  var manOpt=manSel.options[manSel.selectedIndex];
  var creator=manSel.value?{id:manSel.value,name:manOpt?manOpt.getAttribute("data-name"):""}:getSelectedCreator();
  var video={assetId:assetId,title:title,skus:skus,platform:"Manual",discoveredBy:"manual"};
  await doRegister([video],creator);
  if(document.getElementById("assets-success").style.display==="block"){
    document.getElementById("manual-asset-id").value="";
    document.getElementById("manual-title").value="";
    document.getElementById("manual-skus").value="";
  }
}

// ── Creator Portal ──
let portalOpen=false;
let portalLoaded=false;

function togglePortal(){
  portalOpen=!portalOpen;
  document.getElementById("portal-panel").style.display=portalOpen?"block":"none";
  document.getElementById("portal-toggle").textContent=portalOpen?"Collapse \\u25B4":"Expand \\u25BE";
  if(portalOpen&&!portalLoaded){loadPortalContent()}
}

// Fields stored as plain text (input.value)
const portalInputFields=["pageTitle","signupCardTitle","signupCardSubtitle","benefit1Title","benefit1Desc","benefit2Title","benefit2Desc","benefit3Title","benefit3Desc","termsHeading","term1Icon","term1Text","term2Icon","term2Text","term3Icon","term3Text","term4Icon","term4Text","dashboardTitle","submitVideoTitle","yourVideosTitle","customCSS"];
// Fields stored as rich text (innerHTML)
const portalRichFields=["pageSubtitle","pageSubtitle2"];
// Boolean toggle fields
const portalBoolFields=["showBenefits","showTerms"];

function togglePortalSection(section,visible){
  var map={benefits:"pc-benefits-fields",terms:"pc-terms-fields"};
  var el=document.getElementById(map[section]);
  if(el)el.style.opacity=visible?"1":"0.4";
}

// Rich text commands
function rtCmd(cmd){document.execCommand(cmd,false,null)}
function rtLink(){
  var url=prompt("Enter URL:");
  if(url)document.execCommand("createLink",false,url);
}

async function loadPortalContent(){
  document.getElementById("portal-loading").style.display="block";
  document.getElementById("portal-content").style.display="none";
  document.getElementById("portal-error").style.display="none";
  document.getElementById("portal-saved").style.display="none";
  try{
    var r=await api("GET","/api/portal-content");
    if(r.ok&&r.content){
      portalInputFields.forEach(function(f){
        var el=document.getElementById("pc-"+f);
        if(el)el.value=r.content[f]||"";
      });
      portalRichFields.forEach(function(f){
        var el=document.getElementById("pc-"+f);
        if(el)el.innerHTML=r.content[f]||"";
      });
      portalBoolFields.forEach(function(f){
        var el=document.getElementById("pc-"+f);
        if(el){
          var val=r.content[f]!==false;
          el.checked=val;
          // Trigger visual state
          if(f==="showBenefits")togglePortalSection("benefits",val);
          if(f==="showTerms")togglePortalSection("terms",val);
        }
      });
      portalLoaded=true;
    }else{
      document.getElementById("portal-error").textContent=r.error||"Failed to load portal content";
      document.getElementById("portal-error").style.display="block";
    }
  }catch(e){
    document.getElementById("portal-error").textContent="Error: "+e.message;
    document.getElementById("portal-error").style.display="block";
  }
  document.getElementById("portal-loading").style.display="none";
  document.getElementById("portal-content").style.display="block";
}

function gatherPortalFields(){
  var data={};
  portalInputFields.forEach(function(f){
    var el=document.getElementById("pc-"+f);
    if(el)data[f]=el.value;
  });
  portalRichFields.forEach(function(f){
    var el=document.getElementById("pc-"+f);
    if(el)data[f]=el.innerHTML;
  });
  portalBoolFields.forEach(function(f){
    var el=document.getElementById("pc-"+f);
    if(el)data[f]=el.checked;
  });
  return data;
}

async function savePortalContent(){
  var btn=document.getElementById("portal-save-btn");
  btn.disabled=true;btn.textContent="Saving...";
  document.getElementById("portal-saved").style.display="none";
  document.getElementById("portal-error").style.display="none";
  try{
    var data=gatherPortalFields();
    var r=await api("PUT","/api/portal-content",data);
    if(r.ok){
      document.getElementById("portal-saved").style.display="block";
      setTimeout(function(){document.getElementById("portal-saved").style.display="none"},5000);
    }else{
      document.getElementById("portal-error").textContent=r.error||"Failed to save";
      document.getElementById("portal-error").style.display="block";
    }
  }catch(e){
    document.getElementById("portal-error").textContent="Error: "+e.message;
    document.getElementById("portal-error").style.display="block";
  }
  btn.disabled=false;btn.textContent="Save Portal Content";
}

async function previewPortal(){
  var btn=document.getElementById("portal-preview-btn");
  btn.disabled=true;btn.textContent="Saving & opening...";
  document.getElementById("portal-error").style.display="none";
  try{
    // Save first so the live page reflects latest edits
    var data=gatherPortalFields();
    var r=await api("PUT","/api/portal-content",data);
    if(r.ok){
      document.getElementById("portal-saved").style.display="block";
      setTimeout(function(){document.getElementById("portal-saved").style.display="none"},5000);
    }
    // Open the live storefront portal in a new tab
    var storeUrl="https://"+S+"/apps/onsite-affiliate";
    window.open(storeUrl,"_blank");
  }catch(e){
    document.getElementById("portal-error").textContent="Error: "+e.message;
    document.getElementById("portal-error").style.display="block";
  }
  btn.disabled=false;btn.textContent="Preview on Store";
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
