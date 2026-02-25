/**
 * OCE API Service
 * Handles all communication with the Onsite Commission Engine REST API
 * Base URL: https://mqhtzepjrudposuedqbu.supabase.co/functions/v1
 */

const OCE_BASE_URL = "https://mqhtzepjrudposuedqbu.supabase.co/functions/v1";

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
  async createExposure({ assetId, sessionId, sku, creatorExternalId }) {
    return this.request("POST", "/exposures-create", {
      asset_id: assetId,
      session_id: sessionId,
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
  async sendOrder({ orderId, ts, exposureIds, sessionId, lineItems, currency }) {
    return this.request("POST", "/orders", {
      order_id: orderId,
      ts,
      exposure_ids: exposureIds,
      session_id: sessionId,
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
   * Validate API key by requesting dashboard stats
   * If the key is invalid, /manage returns 401
   */
  async validateApiKey() {
    try {
      await this.manage("stats.overview", { period_days: 1 });
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
