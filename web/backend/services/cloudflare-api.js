/**
 * Cloudflare API Service
 * Handles domain registration, DNS management, and zone operations
 * via the Cloudflare API v4.
 *
 * Multi-tenant: each merchant stores their own Cloudflare account ID
 * and API token in the EmailSettings table.
 */

const CF_BASE_URL = "https://api.cloudflare.com/client/v4";

export class CloudflareService {
  constructor(apiToken, accountId) {
    this.apiToken = apiToken;
    this.accountId = accountId;
    this.baseUrl = CF_BASE_URL;
  }

  async request(method, path, body = null) {
    const url = `${this.baseUrl}${path}`;
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiToken}`,
    };

    const options = { method, headers };
    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    const data = await response.json().catch(() => null);

    if (!response.ok || (data && !data.success)) {
      const errors = data?.errors?.map((e) => e.message).join("; ") || `HTTP ${response.status}`;
      throw new CloudflareApiError(
        `Cloudflare API error: ${errors}`,
        response.status,
        data
      );
    }

    return data;
  }

  // ─── Token Verification ─────────────────────────────────────────

  async verifyToken() {
    try {
      const data = await this.request("GET", "/user/tokens/verify");
      return { valid: true, status: data.result?.status };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }

  // ─── Domain Search & Purchase ───────────────────────────────────

  async searchDomains(query) {
    const encoded = encodeURIComponent(query);
    const data = await this.request(
      "GET",
      `/accounts/${this.accountId}/registrar/domains/search?query=${encoded}`
    );
    return data.result || [];
  }

  async purchaseDomain(domain, contactInfo, years = 1) {
    const data = await this.request(
      "POST",
      `/accounts/${this.accountId}/registrar/domains/purchase`,
      {
        name: domain,
        years,
        auto_renew: true,
        privacy: true,
        contacts: {
          registrant: contactInfo,
          admin: contactInfo,
          tech: contactInfo,
          billing: contactInfo,
        },
      }
    );
    return data.result;
  }

  async getDomainInfo(domain) {
    const data = await this.request(
      "GET",
      `/accounts/${this.accountId}/registrar/domains/${domain}`
    );
    return data.result;
  }

  // ─── Zone Management ────────────────────────────────────────────

  async getZoneId(domain) {
    const data = await this.request(
      "GET",
      `/zones?name=${encodeURIComponent(domain)}&account.id=${this.accountId}`
    );
    if (!data.result || data.result.length === 0) {
      return null;
    }
    return data.result[0].id;
  }

  async createZone(domain) {
    const data = await this.request("POST", "/zones", {
      name: domain,
      account: { id: this.accountId },
      type: "full",
    });
    return data.result;
  }

  // ─── DNS Records ────────────────────────────────────────────────

  async listDnsRecords(zoneId, type = null) {
    let path = `/zones/${zoneId}/dns_records?per_page=100`;
    if (type) path += `&type=${type}`;
    const data = await this.request("GET", path);
    return data.result || [];
  }

  async createDnsRecord(zoneId, { type, name, content, priority, ttl = 3600 }) {
    const body = { type, name, content, ttl };
    if (priority !== undefined) body.priority = priority;
    const data = await this.request("POST", `/zones/${zoneId}/dns_records`, body);
    return data.result;
  }

  async deleteDnsRecord(zoneId, recordId) {
    return this.request("DELETE", `/zones/${zoneId}/dns_records/${recordId}`);
  }

  // ─── Cold Email DNS Provisioning ────────────────────────────────

  /**
   * Creates the full set of DNS records needed for cold email:
   * MX, SPF, DKIM, and DMARC.
   *
   * @param {string} zoneId - Cloudflare zone ID
   * @param {string} domain - The domain name
   * @param {object} provider - Email provider config:
   *   { mxRecords: [{ content, priority }], spfInclude, dkimRecords: [{ name, content }] }
   */
  async provisionColdEmailDns(zoneId, domain, provider) {
    const results = { mx: [], spf: null, dkim: [], dmarc: null, errors: [] };

    // MX Records
    for (const mx of provider.mxRecords || []) {
      try {
        const record = await this.createDnsRecord(zoneId, {
          type: "MX",
          name: domain,
          content: mx.content,
          priority: mx.priority,
        });
        results.mx.push(record);
      } catch (err) {
        results.errors.push(`MX ${mx.content}: ${err.message}`);
      }
    }

    // SPF (TXT record)
    if (provider.spfInclude) {
      try {
        results.spf = await this.createDnsRecord(zoneId, {
          type: "TXT",
          name: domain,
          content: `v=spf1 include:${provider.spfInclude} -all`,
        });
      } catch (err) {
        results.errors.push(`SPF: ${err.message}`);
      }
    }

    // DKIM (TXT or CNAME records)
    for (const dkim of provider.dkimRecords || []) {
      try {
        const record = await this.createDnsRecord(zoneId, {
          type: dkim.type || "TXT",
          name: dkim.name,
          content: dkim.content,
        });
        results.dkim.push(record);
      } catch (err) {
        results.errors.push(`DKIM ${dkim.name}: ${err.message}`);
      }
    }

    // DMARC (TXT record)
    try {
      results.dmarc = await this.createDnsRecord(zoneId, {
        type: "TXT",
        name: `_dmarc.${domain}`,
        content: "v=DMARC1; p=quarantine; rua=mailto:dmarc@" + domain,
      });
    } catch (err) {
      results.errors.push(`DMARC: ${err.message}`);
    }

    return results;
  }

  // ─── DNS Verification ───────────────────────────────────────────

  async verifyDnsRecords(zoneId, domain) {
    const records = await this.listDnsRecords(zoneId);
    const status = {
      mx: false,
      spf: false,
      dkim: false,
      dmarc: false,
    };

    for (const r of records) {
      if (r.type === "MX" && r.name === domain) {
        status.mx = true;
      }
      if (r.type === "TXT" && r.name === domain && r.content.startsWith("v=spf1")) {
        status.spf = true;
      }
      if (r.type === "TXT" && r.name.includes("._domainkey.")) {
        status.dkim = true;
      }
      if (r.type === "CNAME" && r.name.includes("._domainkey.")) {
        status.dkim = true;
      }
      if (r.type === "TXT" && r.name === `_dmarc.${domain}` && r.content.startsWith("v=DMARC1")) {
        status.dmarc = true;
      }
    }

    return status;
  }
}

export class CloudflareApiError extends Error {
  constructor(message, statusCode, responseBody) {
    super(message);
    this.name = "CloudflareApiError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

export default CloudflareService;
