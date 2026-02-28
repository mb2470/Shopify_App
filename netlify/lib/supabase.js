/**
 * Supabase Client for Netlify Functions
 *
 * Creates a Supabase service-role client for backend operations.
 * Service-role bypasses RLS — used only in server-side functions.
 *
 * Required env vars:
 *   SUPABASE_URL       — e.g. https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY — service_role key (NOT anon key)
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

/**
 * Lightweight Supabase client using fetch (no SDK dependency).
 * Targets the PostgREST API at /rest/v1/.
 */
export class SupabaseClient {
  constructor(url = SUPABASE_URL, serviceKey = SUPABASE_SERVICE_KEY) {
    if (!url || !serviceKey) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars");
    }
    this.url = url.replace(/\/$/, "");
    this.serviceKey = serviceKey;
    this.restUrl = `${this.url}/rest/v1`;
  }

  /**
   * Make a PostgREST request.
   * @param {string} path - Table or RPC path, e.g. "/email_domains" or "/rpc/my_func"
   * @param {object} options - { method, body, params, headers, single }
   * @returns {object|array} Parsed JSON response
   */
  async request(path, { method = "GET", body = null, params = {}, headers = {}, single = false } = {}) {
    const url = new URL(`${this.restUrl}${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }

    const reqHeaders = {
      apikey: this.serviceKey,
      Authorization: `Bearer ${this.serviceKey}`,
      "Content-Type": "application/json",
      ...headers,
    };

    // PostgREST: Prefer header for single-row return or upsert
    if (single) {
      reqHeaders["Prefer"] = "return=representation";
      reqHeaders["Accept"] = "application/vnd.pgrst.object+json";
    } else if (method === "POST" || method === "PATCH") {
      reqHeaders["Prefer"] = "return=representation";
    }

    const fetchOptions = { method, headers: reqHeaders };
    if (body) fetchOptions.body = JSON.stringify(body);

    const response = await fetch(url.toString(), fetchOptions);

    if (response.status === 204) return null;

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const message = data?.message || data?.details || `HTTP ${response.status}`;
      const err = new Error(`Supabase error: ${message}`);
      err.status = response.status;
      err.data = data;
      throw err;
    }

    return data;
  }

  // ─── Convenience Methods ────────────────────────────────────────

  /** SELECT from a table with optional PostgREST query params */
  async select(table, params = {}) {
    return this.request(`/${table}`, { params });
  }

  /** SELECT a single row */
  async selectOne(table, params = {}) {
    return this.request(`/${table}`, { params, single: true });
  }

  /** INSERT one or more rows */
  async insert(table, rows, { single = false } = {}) {
    return this.request(`/${table}`, { method: "POST", body: rows, single });
  }

  /** UPDATE rows matching PostgREST filters */
  async update(table, body, params = {}) {
    return this.request(`/${table}`, { method: "PATCH", body, params });
  }

  /** DELETE rows matching PostgREST filters */
  async delete(table, params = {}) {
    return this.request(`/${table}`, { method: "DELETE", params });
  }

  /** UPSERT (INSERT ... ON CONFLICT) */
  async upsert(table, rows, { onConflict, single = false } = {}) {
    const headers = {
      Prefer: `return=representation,resolution=merge-duplicates`,
    };
    if (onConflict) headers["Prefer"] += `,on_conflict=${onConflict}`;
    return this.request(`/${table}`, { method: "POST", body: rows, headers, single });
  }
}

/** Singleton instance (created on first use) */
let _client = null;

export function getSupabaseClient() {
  if (!_client) {
    _client = new SupabaseClient();
  }
  return _client;
}

export default getSupabaseClient;
