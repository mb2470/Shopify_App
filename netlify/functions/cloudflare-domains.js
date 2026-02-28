/**
 * Cloudflare Domains — Netlify Function
 *
 * Serverless API for domain search, purchase, DNS provisioning, and verification
 * via the Cloudflare API. Persists state to Supabase (email_domains, email_settings).
 *
 * Routes (all require org_id header or query param):
 *   POST /cloudflare-domains/search        — Search available domains
 *   POST /cloudflare-domains/purchase       — Purchase a domain
 *   POST /cloudflare-domains/provision-dns  — Create MX/SPF/DKIM/DMARC records
 *   POST /cloudflare-domains/verify-dns     — Check DNS propagation status
 *   GET  /cloudflare-domains/list           — List all domains for an org
 *   GET  /cloudflare-domains/status/:id     — Get single domain status
 *   POST /cloudflare-domains/test           — Test Cloudflare API token
 *
 * Auth: Expects a Bearer token or API key validated upstream.
 *       org_id identifies the tenant (multi-tenant).
 *
 * Env vars:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY — Supabase backend
 *   FUNCTION_SECRET                     — optional shared secret for function auth
 */

import { getSupabaseClient } from "../lib/supabase.js";

// ─── Cloudflare API v4 Base URL ──────────────────────────────────
const CF_BASE_URL = "https://api.cloudflare.com/client/v4";

// ─── CORS Headers ────────────────────────────────────────────────
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Org-Id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// ─── Cloudflare API Client (inline, no external deps) ────────────

class CloudflareClient {
  constructor(apiToken, accountId) {
    this.apiToken = apiToken;
    this.accountId = accountId;
  }

  async request(method, path, body = null) {
    const url = `${CF_BASE_URL}${path}`;
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiToken}`,
    };

    const options = { method, headers };
    if (body) options.body = JSON.stringify(body);

    const response = await fetch(url, options);
    const data = await response.json().catch(() => null);

    if (!response.ok || (data && !data.success)) {
      const errors = data?.errors?.map((e) => e.message).join("; ") || `HTTP ${response.status}`;
      const err = new Error(`Cloudflare API error: ${errors}`);
      err.status = response.status;
      err.cfErrors = data?.errors;
      throw err;
    }

    return data;
  }

  async verifyToken() {
    try {
      const data = await this.request("GET", "/user/tokens/verify");
      return { valid: true, status: data.result?.status };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }

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

  async getZoneId(domain) {
    const data = await this.request(
      "GET",
      `/zones?name=${encodeURIComponent(domain)}&account.id=${this.accountId}`
    );
    if (!data.result || data.result.length === 0) return null;
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

  /**
   * Provision full cold-email DNS: MX, SPF, DKIM, DMARC
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

  /**
   * Verify that required DNS records exist on the zone
   */
  async verifyDnsRecords(zoneId, domain) {
    const records = await this.listDnsRecords(zoneId);
    const status = { mx: false, spf: false, dkim: false, dmarc: false };

    for (const r of records) {
      if (r.type === "MX" && r.name === domain) {
        status.mx = true;
      }
      if (r.type === "TXT" && r.name === domain && r.content.startsWith("v=spf1")) {
        status.spf = true;
      }
      if ((r.type === "TXT" || r.type === "CNAME") && r.name.includes("._domainkey.")) {
        status.dkim = true;
      }
      if (r.type === "TXT" && r.name === `_dmarc.${domain}` && r.content.startsWith("v=DMARC1")) {
        status.dmarc = true;
      }
    }

    return status;
  }
}

// ─── Helper: Build JSON Response ─────────────────────────────────

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    body: JSON.stringify(body),
  };
}

function error(statusCode, message) {
  return json(statusCode, { success: false, error: message });
}

// ─── Helper: Parse Incoming Request ──────────────────────────────

function parseRequest(event) {
  const path = event.path.replace("/.netlify/functions/cloudflare-domains", "").replace(/^\//, "");
  const method = event.httpMethod;
  const body = event.body ? JSON.parse(event.body) : {};
  const orgId = event.headers["x-org-id"] || event.queryStringParameters?.org_id;
  return { path, method, body, orgId };
}

// ─── Helper: Load Cloudflare Credentials from Supabase ───────────

async function getCloudflareClient(db, orgId) {
  const settings = await db.selectOne("email_settings", {
    org_id: `eq.${orgId}`,
    select: "cloudflare_api_token,cloudflare_account_id",
  });

  if (!settings?.cloudflare_api_token || !settings?.cloudflare_account_id) {
    throw new Error("Cloudflare credentials not configured. Update Email Settings first.");
  }

  return new CloudflareClient(settings.cloudflare_api_token, settings.cloudflare_account_id);
}

// ─── Helper: Load WHOIS Contact Info from Settings ───────────────

async function getWhoisContact(db, orgId) {
  const settings = await db.selectOne("email_settings", {
    org_id: `eq.${orgId}`,
    select: "metadata",
  });

  const meta = settings?.metadata || {};
  const whois = meta.whois || {};

  const required = ["first_name", "last_name", "address", "city", "state", "zip", "country", "phone", "email"];
  const missing = required.filter((f) => !whois[f]);
  if (missing.length > 0) {
    throw new Error(`Missing WHOIS contact info: ${missing.join(", ")}. Update Email Settings first.`);
  }

  return {
    first_name: whois.first_name,
    last_name: whois.last_name,
    address: whois.address,
    city: whois.city,
    state: whois.state,
    zip: whois.zip,
    country: whois.country,
    phone: whois.phone,
    email: whois.email,
    organization: whois.organization || "",
  };
}

// ─── Auth Middleware ──────────────────────────────────────────────

function authenticate(event) {
  const secret = process.env.FUNCTION_SECRET;
  if (!secret) return true; // No secret configured = open (dev mode)

  const authHeader = event.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const querySecret = event.queryStringParameters?.secret;

  if (token === secret || querySecret === secret) return true;

  return false;
}

// ═════════════════════════════════════════════════════════════════
// ROUTE HANDLERS
// ═════════════════════════════════════════════════════════════════

/**
 * POST /search
 * Body: { query: "acmeoutreach" }
 * Returns: Array of available domains with pricing
 */
async function handleSearch(db, orgId, body) {
  const { query } = body;
  if (!query || query.trim().length < 2) {
    return error(400, "Search query must be at least 2 characters");
  }

  const cf = await getCloudflareClient(db, orgId);
  const results = await cf.searchDomains(query.trim());

  return json(200, { success: true, domains: results });
}

/**
 * POST /purchase
 * Body: { domain: "acmeoutreach.com", years: 1 }
 * Returns: Created email_domains record
 */
async function handlePurchase(db, orgId, body) {
  const { domain, years = 1 } = body;
  if (!domain) return error(400, "Domain name is required");

  const cf = await getCloudflareClient(db, orgId);
  const contactInfo = await getWhoisContact(db, orgId);

  // Purchase via Cloudflare
  const result = await cf.purchaseDomain(domain, contactInfo, years);

  // Get zone ID (Cloudflare auto-creates a zone for registered domains)
  let zoneId = null;
  try {
    zoneId = await cf.getZoneId(domain);
  } catch (err) {
    console.warn("[CloudflareFunc] Could not fetch zone ID for", domain, ":", err.message);
  }

  // Store in Supabase
  const domainRecord = await db.insert(
    "email_domains",
    {
      org_id: orgId,
      domain,
      cloudflare_zone_id: zoneId,
      status: "purchased",
      purchased_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + years * 365 * 24 * 60 * 60 * 1000).toISOString(),
      registrar: "cloudflare",
      metadata: { cloudflare_result: result },
    },
    { single: true }
  );

  return json(201, { success: true, domain: domainRecord });
}

/**
 * POST /provision-dns
 * Body: { domain_id: "uuid", provider?: { mxRecords, spfInclude, dkimRecords } }
 * Creates MX, SPF, DKIM, DMARC records on Cloudflare.
 */
async function handleProvisionDns(db, orgId, body) {
  const { domain_id, provider: providerConfig } = body;
  if (!domain_id) return error(400, "domain_id is required");

  // Load domain record
  const domain = await db.selectOne("email_domains", {
    id: `eq.${domain_id}`,
    org_id: `eq.${orgId}`,
    select: "*",
  });
  if (!domain) return error(404, "Domain not found");

  const cf = await getCloudflareClient(db, orgId);

  // Ensure we have a zone ID
  let zoneId = domain.cloudflare_zone_id;
  if (!zoneId) {
    zoneId = await cf.getZoneId(domain.domain);
    if (!zoneId) {
      const zone = await cf.createZone(domain.domain);
      zoneId = zone.id;
    }
    await db.update("email_domains", { cloudflare_zone_id: zoneId }, {
      id: `eq.${domain_id}`,
    });
  }

  // Default provider config (Zoho-style)
  const provider = providerConfig || {
    mxRecords: [
      { content: "mx.zoho.com", priority: 10 },
      { content: "mx2.zoho.com", priority: 20 },
      { content: "mx3.zoho.com", priority: 50 },
    ],
    spfInclude: "zoho.com",
    dkimRecords: [],
  };

  const results = await cf.provisionColdEmailDns(zoneId, domain.domain, provider);

  // Update domain status
  await db.update(
    "email_domains",
    {
      status: results.errors.length === 0 ? "dns_pending" : "failed",
      status_reason: results.errors.length > 0 ? results.errors.join("; ") : null,
      dns_configured: true,
      mx_verified: results.mx.length > 0,
      spf_verified: !!results.spf,
      dmarc_verified: !!results.dmarc,
      dns_configured_at: new Date().toISOString(),
    },
    { id: `eq.${domain_id}` }
  );

  return json(200, { success: true, results });
}

/**
 * POST /verify-dns
 * Body: { domain_id: "uuid" }
 * Checks DNS record propagation on Cloudflare.
 */
async function handleVerifyDns(db, orgId, body) {
  const { domain_id } = body;
  if (!domain_id) return error(400, "domain_id is required");

  const domain = await db.selectOne("email_domains", {
    id: `eq.${domain_id}`,
    org_id: `eq.${orgId}`,
    select: "*",
  });
  if (!domain) return error(404, "Domain not found");
  if (!domain.cloudflare_zone_id) return error(400, "Domain has no Cloudflare zone");

  const cf = await getCloudflareClient(db, orgId);
  const status = await cf.verifyDnsRecords(domain.cloudflare_zone_id, domain.domain);

  // Determine new overall status
  const allVerified = status.mx && status.spf && status.dkim && status.dmarc;
  const newStatus = allVerified ? "active" : "dns_pending";

  // Persist verification results
  await db.update(
    "email_domains",
    {
      mx_verified: status.mx,
      spf_verified: status.spf,
      dkim_verified: status.dkim,
      dmarc_verified: status.dmarc,
      status: newStatus,
    },
    { id: `eq.${domain_id}` }
  );

  return json(200, {
    success: true,
    status,
    all_verified: allVerified,
    domain_status: newStatus,
  });
}

/**
 * GET /list
 * Returns all domains for the org, with account counts.
 */
async function handleList(db, orgId) {
  // Fetch domains
  const domains = await db.select("email_domains", {
    org_id: `eq.${orgId}`,
    select: "*",
    order: "created_at.desc",
  });

  // Fetch account counts per domain
  const domainIds = domains.map((d) => d.id);
  let accountCounts = {};
  if (domainIds.length > 0) {
    const accounts = await db.select("email_accounts", {
      domain_id: `in.(${domainIds.join(",")})`,
      org_id: `eq.${orgId}`,
      select: "domain_id,status",
    });

    for (const acct of accounts) {
      if (!accountCounts[acct.domain_id]) {
        accountCounts[acct.domain_id] = { total: 0, active: 0 };
      }
      accountCounts[acct.domain_id].total++;
      if (acct.status === "active" || acct.status === "warming" || acct.status === "ready") {
        accountCounts[acct.domain_id].active++;
      }
    }
  }

  const result = domains.map((d) => ({
    ...d,
    account_count: accountCounts[d.id]?.total || 0,
    active_account_count: accountCounts[d.id]?.active || 0,
  }));

  return json(200, { success: true, domains: result });
}

/**
 * GET /status/:id
 * Returns detailed status for a single domain.
 */
async function handleStatus(db, orgId, domainId) {
  const domain = await db.selectOne("email_domains", {
    id: `eq.${domainId}`,
    org_id: `eq.${orgId}`,
    select: "*",
  });
  if (!domain) return error(404, "Domain not found");

  // Fetch associated accounts
  const accounts = await db.select("email_accounts", {
    domain_id: `eq.${domainId}`,
    org_id: `eq.${orgId}`,
    select: "id,email_address,status,smartlead_warmup_status,daily_send_limit,created_at",
    order: "created_at.desc",
  });

  return json(200, { success: true, domain, accounts });
}

/**
 * POST /test
 * Tests Cloudflare API token validity.
 */
async function handleTest(db, orgId) {
  const cf = await getCloudflareClient(db, orgId);
  const result = await cf.verifyToken();
  return json(200, { success: true, ...result });
}

// ═════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═════════════════════════════════════════════════════════════════

export default async (event, context) => {
  // Handle CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  // Auth check
  if (!authenticate(event)) {
    return error(401, "Unauthorized");
  }

  try {
    const { path, method, body, orgId } = parseRequest(event);

    // Require org_id for all operations
    if (!orgId) {
      return error(400, "Missing org_id (pass as X-Org-Id header or org_id query param)");
    }

    const db = getSupabaseClient();

    // Route dispatch
    const route = path.split("/")[0] || "";
    const subPath = path.split("/").slice(1).join("/");

    switch (route) {
      case "search":
        if (method !== "POST") return error(405, "Method not allowed");
        return await handleSearch(db, orgId, body);

      case "purchase":
        if (method !== "POST") return error(405, "Method not allowed");
        return await handlePurchase(db, orgId, body);

      case "provision-dns":
        if (method !== "POST") return error(405, "Method not allowed");
        return await handleProvisionDns(db, orgId, body);

      case "verify-dns":
        if (method !== "POST") return error(405, "Method not allowed");
        return await handleVerifyDns(db, orgId, body);

      case "list":
        if (method !== "GET") return error(405, "Method not allowed");
        return await handleList(db, orgId);

      case "status":
        if (method !== "GET") return error(405, "Method not allowed");
        if (!subPath) return error(400, "Domain ID required: /status/:id");
        return await handleStatus(db, orgId, subPath);

      case "test":
        if (method !== "POST") return error(405, "Method not allowed");
        return await handleTest(db, orgId);

      default:
        // If no sub-route, treat root GET as /list
        if (method === "GET" && !route) {
          return await handleList(db, orgId);
        }
        return error(404, `Unknown route: ${route || "/"}`);
    }
  } catch (err) {
    console.error("[CloudflareFunc] Error:", err);

    const statusCode = err.status || 500;
    return json(statusCode, {
      success: false,
      error: err.message,
      ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
    });
  }
};
