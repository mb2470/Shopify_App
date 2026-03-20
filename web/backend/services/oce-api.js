/**
 * OCE API Service
 * Handles all communication with the Onsite Commission Engine REST API
 * Base URL: https://mqhtzepjrudposuedqbu.supabase.co/functions/v1
 */

const OCE_BASE_URL = "https://mqhtzepjrudposuedqbu.supabase.co/functions/v1";

/**
 * On install: ask Onsite Affiliate to create an API token for this Shopify shop.
 * Requires env OCE_INSTALL_URL and OCE_INSTALL_SECRET (server-to-server).
 * Returns { api_key } or null if not configured / request failed.
 */
export async function createTokenForShop(shop, branding = {}) {
  const installUrl = process.env.OCE_INSTALL_URL;
  const installSecret = process.env.OCE_INSTALL_SECRET;
  if (!installUrl || !installSecret) {
    return null;
  }
  try {
    const response = await fetch(installUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": installSecret,
      },
      body: JSON.stringify({ shop, ...branding }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.warn("[OCE] Install API non-OK:", response.status, text.slice(0, 200));
      return null;
    }
    const data = await response.json().catch(() => ({}));
    const apiKey = data.api_key || data.apiKey || null;
    if (apiKey) {
      console.log("[OCE] Install API returned API key for", shop);
      return {
        api_key: apiKey,
        creator_portal_url: data.creator_portal_url || null,
        brand_slug: data.brand_slug || null,
      };
    }
    console.warn("[OCE] Install API response missing api_key:", Object.keys(data));
    return null;
  } catch (err) {
    console.error("[OCE] Install API error:", err.message);
    return null;
  }
}

export class OceApiService {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = OCE_BASE_URL;
  }

  async request(method, path, body = null) {
    const url = `${this.baseUrl}${path}`;
    const headers = {
      "Content-Type": "application/json",
      "X-API-Key": this.apiKey,
    };

    console.log("[OCE] Outbound API request", {
      method,
      path,
      has_api_key: !!this.apiKey,
      api_key_prefix: this.apiKey ? this.apiKey.slice(0, 8) : null,
    });

    const options = { method, headers };
    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new OceApiError(
        `OCE API error: ${response.status} ${response.statusText}`,
        response.status,
        errorText
      );
    }

    return response.json();
  }

  // ─── Exposures ──────────────────────────────────────────────────

  /**
   * Generate a server-side exposure ID
   * POST /exposures-create
   */
  async createExposure({ assetId, sessionId, oaId, sku, creatorExternalId }) {
    return this.request("POST", "/exposures-create", {
      asset_id: assetId,
      session_id: sessionId,
      oa_id: oaId,
      sku,
      creator_external_id: creatorExternalId,
    });
  }

  // ─── Events ─────────────────────────────────────────────────────

  /**
   * Record video engagement events
   * POST /events-exposure
   */
  async sendExposureEvents(events) {
    return this.request("POST", "/events-exposure", { events });
  }

  // ─── Orders ─────────────────────────────────────────────────────

  /**
   * Submit order for attribution
   * POST /orders
   */
  async sendOrder({ orderId, ts, exposureIds, sessionId, oaId, checkoutToken, lineItems, currency }) {
    return this.request("POST", "/orders", {
      order_id: orderId,
      ts,
      exposure_ids: exposureIds,
      session_id: sessionId,
      oa_id: oaId,
      checkout_token: checkoutToken,
      line_items: lineItems.map((item) => ({
        sku: item.sku,
        product_id: item.productId,
        variant_id: item.variantId,
        qty: item.quantity,
        price: item.price,
        revenue: item.revenue ?? item.price * item.quantity,
      })),
      currency,
    });
  }

  // ─── Assets ─────────────────────────────────────────────────────

  /**
   * Register or update video assets
   * POST /assets-upsert
   */
  async upsertAssets(assets) {
    return this.request("POST", "/assets-upsert", { assets });
  }

  // ─── Creators ───────────────────────────────────────────────────

  /**
   * Register or update creators
   * POST /creators-upsert
   */
  async upsertCreators(creators) {
    return this.request("POST", "/creators-upsert", { creators });
  }

  // ─── Attributions ───────────────────────────────────────────────

  /**
   * Recompute attributions for a date range
   * POST /recompute-attributions
   */
  async recomputeAttributions({ startDate, endDate, orderIds }) {
    const body = { start_date: startDate, end_date: endDate };
    if (orderIds) body.order_ids = orderIds;
    return this.request("POST", "/recompute-attributions", body);
  }

  // ─── Management API ─────────────────────────────────────────────

  /**
   * Call the management API (control plane)
   * POST /manage
   */
  async manage(action, params = {}, { dryRun = false, idempotencyKey } = {}) {
    const body = { action, params };
    if (dryRun) body.dry_run = true;
    if (idempotencyKey) body.idempotency_key = idempotencyKey;
    return this.request("POST", "/manage", body);
  }

  /**
   * Get dashboard stats via management API
   */
  async getStats(periodDays = 30) {
    return this.manage("stats.overview", { period_days: periodDays });
  }

  /**
   * Get attribution settings via management API
   */
  async getSettings() {
    return this.manage("settings.get");
  }

  // ─── Validation ─────────────────────────────────────────────────

  /**
   * Validate API key by making a lightweight request.
   * Sends an empty events array to /events-exposure — a 401 means the key
   * is invalid; any other response (200, 400 validation error) means valid.
   */
  async validateApiKey() {
    try {
      const url = `${this.baseUrl}/events-exposure`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": this.apiKey,
        },
        body: JSON.stringify({ events: [] }),
      });

      if (response.status === 401) {
        return { valid: false, error: "Invalid API key" };
      }
      // Any non-401 response means the key is recognized
      return { valid: true };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }
}

export class OceApiError extends Error {
  constructor(message, statusCode, responseBody) {
    super(message);
    this.name = "OceApiError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

export default OceApiService;
