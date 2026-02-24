/**
 * OCE API Service
 * Handles all communication with the Onsite Commission Engine REST API
 * Base URL: https://app.onsiteaffiliate.com
 */

const OCE_BASE_URL = "https://app.onsiteaffiliate.com";

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

  // ─── Exposure Events ────────────────────────────────────────────

  /**
   * Send an exposure event to OCE
   * Called when a user watches creator video content
   */
  async sendExposureEvent({ exposureId, assetId, sku, sessionId, events }) {
    return this.request("POST", "/api/v1/events-exposure", {
      exposure_id: exposureId,
      asset_id: assetId,
      sku,
      session_id: sessionId,
      events, // array of { type, timestamp, metadata }
    });
  }

  // ─── Orders ─────────────────────────────────────────────────────

  /**
   * Send order data for attribution
   * Called via Shopify order webhook
   */
  async sendOrder({ orderId, exposureIds, lineItems, totalAmount, currency, customerEmail }) {
    return this.request("POST", "/api/v1/orders", {
      order_id: orderId,
      exposure_ids: exposureIds,
      line_items: lineItems.map((item) => ({
        sku: item.sku,
        product_id: item.productId,
        variant_id: item.variantId,
        title: item.title,
        quantity: item.quantity,
        price: item.price,
      })),
      total_amount: totalAmount,
      currency,
      customer_email: customerEmail,
    });
  }

  // ─── Video Assets ───────────────────────────────────────────────

  /**
   * Register a video asset with OCE
   */
  async registerVideoAsset({ title, creatorId, videoUrl, skus, platform }) {
    return this.request("POST", "/api/v1/assets", {
      title,
      creator_id: creatorId,
      video_url: videoUrl,
      skus,
      platform,
    });
  }

  /**
   * List registered video assets
   */
  async listVideoAssets(page = 1, limit = 50) {
    return this.request("GET", `/api/v1/assets?page=${page}&limit=${limit}`);
  }

  // ─── Attribution & Reporting ────────────────────────────────────

  /**
   * Get attribution report
   */
  async getAttributionReport({ startDate, endDate, creatorId }) {
    const params = new URLSearchParams();
    if (startDate) params.set("start_date", startDate);
    if (endDate) params.set("end_date", endDate);
    if (creatorId) params.set("creator_id", creatorId);
    return this.request("GET", `/api/v1/reports/attribution?${params}`);
  }

  /**
   * Get commission summary
   */
  async getCommissionSummary({ startDate, endDate }) {
    const params = new URLSearchParams();
    if (startDate) params.set("start_date", startDate);
    if (endDate) params.set("end_date", endDate);
    return this.request("GET", `/api/v1/reports/commissions?${params}`);
  }

  // ─── Settings ───────────────────────────────────────────────────

  /**
   * Validate API key by making a test request
   */
  async validateApiKey() {
    try {
      await this.request("GET", "/api/v1/account");
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
