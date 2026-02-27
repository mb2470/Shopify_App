/**
 * Smartlead.ai API Service
 * Handles email account management, warmup, and campaign operations.
 *
 * Multi-tenant: each merchant stores their own Smartlead API key
 * in the EmailSettings table.
 *
 * Auth: API key passed as query parameter `api_key` on every request.
 */

const SMARTLEAD_BASE_URL = "https://server.smartlead.ai";

export class SmartleadService {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = SMARTLEAD_BASE_URL;
  }

  async request(method, path, body = null) {
    const separator = path.includes("?") ? "&" : "?";
    const url = `${this.baseUrl}${path}${separator}api_key=${this.apiKey}`;
    const headers = { "Content-Type": "application/json" };

    const options = { method, headers };
    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const message = data?.message || data?.error || `HTTP ${response.status}`;
      throw new SmartleadApiError(
        `Smartlead API error: ${message}`,
        response.status,
        data
      );
    }

    return data;
  }

  // ─── Connection Test ────────────────────────────────────────────

  async testConnection() {
    try {
      await this.request("GET", "/api/v1/campaigns");
      return { valid: true };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }

  // ─── Email Accounts ─────────────────────────────────────────────

  /**
   * Add an email account to Smartlead (connects SMTP/IMAP)
   */
  async addEmailAccount({
    fromEmail,
    fromName,
    userName,
    password,
    smtpHost,
    smtpPort = 587,
    imapHost,
    imapPort = 993,
    maxDailyLimit = 20,
    warmupEnabled = true,
  }) {
    return this.request("POST", "/api/v1/email-accounts/save", {
      from_email: fromEmail,
      from_name: fromName || fromEmail.split("@")[0],
      user_name: userName || fromEmail,
      password,
      smtp_host: smtpHost,
      smtp_port: smtpPort,
      imap_host: imapHost,
      imap_port: imapPort,
      max_email_per_day: maxDailyLimit,
      warmup_enabled: warmupEnabled,
      type: "SMTP",
    });
  }

  /**
   * Get email account details
   */
  async getEmailAccount(emailAccountId) {
    return this.request("GET", `/api/v1/email-accounts/${emailAccountId}`);
  }

  /**
   * List all email accounts
   */
  async listEmailAccounts() {
    return this.request("GET", "/api/v1/email-accounts");
  }

  /**
   * Update warmup settings for an email account
   */
  async updateWarmup(emailAccountId, enabled) {
    return this.request("POST", `/api/v1/email-accounts/${emailAccountId}/warmup`, {
      warmup_enabled: enabled,
    });
  }

  /**
   * Get warmup statistics for an email account
   */
  async getWarmupStats(emailAccountId) {
    return this.request("GET", `/api/v1/email-accounts/${emailAccountId}/warmup-stats`);
  }

  /**
   * Delete an email account from Smartlead
   */
  async deleteEmailAccount(emailAccountId) {
    return this.request("DELETE", `/api/v1/email-accounts/${emailAccountId}`);
  }

  // ─── Campaigns ──────────────────────────────────────────────────

  /**
   * List all campaigns
   */
  async listCampaigns() {
    return this.request("GET", "/api/v1/campaigns");
  }

  /**
   * Create a new campaign
   */
  async createCampaign(name) {
    return this.request("POST", "/api/v1/campaigns/create", { name });
  }

  /**
   * Get campaign details including stats
   */
  async getCampaign(campaignId) {
    return this.request("GET", `/api/v1/campaigns/${campaignId}`);
  }

  /**
   * Add email accounts to a campaign
   */
  async addEmailsToCampaign(campaignId, emailAccountIds) {
    return this.request("POST", `/api/v1/campaigns/${campaignId}/email-accounts`, {
      email_account_ids: emailAccountIds,
    });
  }

  /**
   * Remove email account from a campaign
   */
  async removeEmailFromCampaign(campaignId, emailAccountId) {
    return this.request(
      "DELETE",
      `/api/v1/campaigns/${campaignId}/email-accounts/${emailAccountId}`
    );
  }

  /**
   * Get campaign statistics
   */
  async getCampaignStats(campaignId) {
    return this.request("GET", `/api/v1/campaigns/${campaignId}/statistics`);
  }
}

export class SmartleadApiError extends Error {
  constructor(message, statusCode, responseBody) {
    super(message);
    this.name = "SmartleadApiError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

export default SmartleadService;
