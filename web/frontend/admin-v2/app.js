const qs = new URLSearchParams(window.location.search);
const shop = qs.get("shop") || "";

const els = {
  errorBanner: document.getElementById("error-banner"),
  successBanner: document.getElementById("success-banner"),
  overallStatus: document.getElementById("overall-status"),
  sdkStatus: document.getElementById("sdk-status"),
  webhookStatus: document.getElementById("webhook-status"),
  apiStatus: document.getElementById("api-status"),
  sdkMsg: document.getElementById("sdk-message"),
  webhookMsg: document.getElementById("webhook-message"),
  apiMsg: document.getElementById("api-message"),
  sdkEnabled: document.getElementById("sdk-enabled"),
  webhookEnabled: document.getElementById("webhook-enabled"),
  interceptAttribution: document.getElementById("intercept-attribution"),
  apiKey: document.getElementById("api-key"),
  webhookDebug: document.getElementById("webhook-debug"),
  diagnoseWebhook: document.getElementById("diagnose-webhook"),
  saveSettings: document.getElementById("save-settings"),
};

function showBanner(kind, text) {
  const el = kind === "error" ? els.errorBanner : els.successBanner;
  const other = kind === "error" ? els.successBanner : els.errorBanner;
  other.classList.add("hidden");
  el.textContent = text;
  el.classList.remove("hidden");
}

function setBadge(el, status) {
  const map = {
    active: ["success", "Active"],
    connected: ["success", "Connected"],
    healthy: ["success", "Healthy"],
    disabled: ["warning", "Disabled"],
    inactive: ["error", "Inactive"],
    error: ["error", "Error"],
    not_configured: ["warning", "Not configured"],
  };
  const [klass, label] = map[status] || ["", status || "-"];
  el.className = `badge${klass ? ` ${klass}` : ""}`;
  el.textContent = label;
}

async function getSessionToken() {
  if (!window.shopify || !window.shopify.idToken) return null;
  try {
    return await window.shopify.idToken();
  } catch {
    return null;
  }
}

async function api(method, path, body) {
  const token = await getSessionToken();
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const url = `${path}${path.includes("?") ? "&" : "?"}shop=${encodeURIComponent(shop)}`;
  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || data.detail || `HTTP ${response.status}`);
  }
  return data;
}

async function loadStatus() {
  const [settings, status] = await Promise.all([
    api("GET", "/api/settings"),
    api("GET", "/api/settings/status"),
  ]);

  setBadge(els.overallStatus, status.overall);
  setBadge(els.sdkStatus, status.sdk.status);
  setBadge(els.webhookStatus, status.webhook.status);
  setBadge(els.apiStatus, status.apiConnection.status);
  els.sdkMsg.textContent = status.sdk.message || "";
  els.webhookMsg.textContent = status.webhook.message || "";
  els.apiMsg.textContent = status.apiConnection.message || "";

  els.sdkEnabled.checked = !!settings.sdkEnabled;
  els.webhookEnabled.checked = !!settings.webhookEnabled;
  els.interceptAttribution.checked = settings.interceptAttribution !== false;
}

async function diagnoseWebhook() {
  const result = await api("GET", "/api/debug/webhooks");
  const lines = [];
  lines.push(`Expected: ${result.expectedAddress}`);
  if (result.orderWebhook) {
    lines.push(`Registered: ${result.orderWebhook.address}`);
    lines.push(`Match: ${result.addressMatch ? "YES" : "NO"}`);
  } else {
    lines.push("Order webhook not found.");
  }
  els.webhookDebug.textContent = lines.join("\n");
  els.webhookDebug.classList.remove("hidden");
}

async function saveSettings() {
  const updates = {
    sdkEnabled: els.sdkEnabled.checked,
    webhookEnabled: els.webhookEnabled.checked,
    interceptAttribution: els.interceptAttribution.checked,
  };
  await api("PUT", "/api/settings", updates);

  if (els.apiKey.value.trim()) {
    await api("PUT", "/api/settings/api-key", { apiKey: els.apiKey.value.trim() });
  }
  showBanner("success", "Settings saved.");
  await loadStatus();
}

els.diagnoseWebhook.addEventListener("click", async () => {
  try {
    await diagnoseWebhook();
  } catch (err) {
    showBanner("error", err.message);
  }
});

els.saveSettings.addEventListener("click", async () => {
  try {
    await saveSettings();
  } catch (err) {
    showBanner("error", err.message);
  }
});

loadStatus().catch((err) => {
  showBanner("error", err.message);
});
