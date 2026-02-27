/**
 * Gmail API Service
 * Handles inserting inbound reply messages into a merchant's Gmail inbox
 * so they appear as native emails (preserving From/To headers).
 *
 * Uses Google OAuth 2.0 refresh tokens for offline access.
 * Each merchant stores their own OAuth tokens in EmailSettings.
 *
 * App-level credentials (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET) come from env.
 */

const GMAIL_BASE_URL = "https://gmail.googleapis.com/gmail/v1";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export class GmailService {
  constructor({ accessToken, refreshToken, clientId, clientSecret }) {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
  }

  // ─── Token Management ───────────────────────────────────────────

  async refreshAccessToken() {
    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken,
        grant_type: "refresh_token",
      }),
    });

    const data = await response.json();

    if (!response.ok || !data.access_token) {
      throw new GmailApiError(
        `Token refresh failed: ${data.error_description || data.error || "unknown"}`,
        response.status,
        data
      );
    }

    this.accessToken = data.access_token;
    return {
      accessToken: data.access_token,
      expiresIn: data.expires_in,
    };
  }

  async request(method, path, body = null, retried = false) {
    const url = `${GMAIL_BASE_URL}${path}`;
    const headers = {
      Authorization: `Bearer ${this.accessToken}`,
    };

    const options = { method, headers };

    if (body) {
      if (typeof body === "string") {
        headers["Content-Type"] = "message/rfc822";
        options.body = body;
      } else {
        headers["Content-Type"] = "application/json";
        options.body = JSON.stringify(body);
      }
    }

    const response = await fetch(url, options);

    // Auto-refresh on 401 and retry once
    if (response.status === 401 && !retried && this.refreshToken) {
      await this.refreshAccessToken();
      return this.request(method, path, body, true);
    }

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const message = data?.error?.message || `HTTP ${response.status}`;
      throw new GmailApiError(`Gmail API error: ${message}`, response.status, data);
    }

    return data;
  }

  // ─── Message Insertion ──────────────────────────────────────────

  /**
   * Build an RFC 2822 MIME message and base64url-encode it.
   */
  buildRawMessage({ from, to, subject, body, inReplyTo, date }) {
    const lines = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject || "(no subject)"}`,
      `Date: ${date || new Date().toUTCString()}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/html; charset=UTF-8`,
    ];

    if (inReplyTo) {
      lines.push(`In-Reply-To: ${inReplyTo}`);
      lines.push(`References: ${inReplyTo}`);
    }

    lines.push("", body || "");

    const raw = lines.join("\r\n");
    // Base64url encode
    return Buffer.from(raw)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  /**
   * Insert a message into the merchant's Gmail inbox.
   * Uses the import endpoint which applies Gmail's spam/virus checks
   * and preserves original headers (From, Date, etc.).
   */
  async insertMessage({ from, to, subject, body, inReplyTo, date }) {
    const raw = this.buildRawMessage({ from, to, subject, body, inReplyTo, date });

    const result = await this.request("POST", "/users/me/messages/import", {
      raw,
      labelIds: ["INBOX", "UNREAD"],
    });

    return result;
  }
}

export class GmailApiError extends Error {
  constructor(message, statusCode, responseBody) {
    super(message);
    this.name = "GmailApiError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

export default GmailService;
