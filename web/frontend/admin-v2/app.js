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
  saveAttribution: document.getElementById("save-attribution"),
  metricExposures: document.getElementById("metric-exposures"),
  metricOrders: document.getElementById("metric-orders"),
  metricRevenue: document.getElementById("metric-revenue"),
  metricCommission: document.getElementById("metric-commission"),
  overviewOrders: document.getElementById("overview-orders"),
  overviewOrdersCount: document.getElementById("overview-orders-count"),
  overviewCreators: document.getElementById("overview-creators"),
  overviewCreatorsCount: document.getElementById("overview-creators-count"),
  ordersTable: document.getElementById("orders-table"),
  ordersCount: document.getElementById("orders-count"),
  creatorsTable: document.getElementById("creators-table"),
  creatorsCount: document.getElementById("creators-count"),
  creatorLinkCard: document.getElementById("creator-link-card"),
  creatorLinkEmpty: document.getElementById("creator-link-empty"),
  creatorLinkContent: document.getElementById("creator-link-content"),
  creatorPortalUrl: document.getElementById("creator-portal-url"),
  copyCreatorPortalUrl: document.getElementById("copy-creator-portal-url"),
  payoutsTable: document.getElementById("payouts-table"),
  payoutTotal: document.getElementById("payout-total"),
  attrModel: document.getElementById("attr-model"),
  attrCommissionRate: document.getElementById("attr-commission-rate"),
  attrViewWindow: document.getElementById("attr-view-window"),
  attrClickWindow: document.getElementById("attr-click-window"),
  attrEventBoxes: Array.from(document.querySelectorAll(".attr-event")),
  tabs: Array.from(document.querySelectorAll(".tab")),
  panels: Array.from(document.querySelectorAll(".tab-panel")),
};

let creatorLinkLoaded = false;

function showBanner(kind, text) {
  const el = kind === "error" ? els.errorBanner : els.successBanner;
  const other = kind === "error" ? els.successBanner : els.errorBanner;
  other.classList.add("hidden");
  el.textContent = text;
  el.classList.remove("hidden");
}

function clearBanners() {
  els.errorBanner.classList.add("hidden");
  els.successBanner.classList.add("hidden");
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
    pending: ["warning", "Pending"],
    paid: ["success", "Paid"],
  };
  const [klass, label] = map[status] || ["", status || "-"];
  el.className = `badge${klass ? ` ${klass}` : ""}`;
  el.textContent = label;
}

function pill(status, label) {
  const map = {
    success: "badge success",
    warning: "badge warning",
    error: "badge error",
  };
  return `<span class="${map[status] || "badge"}">${label}</span>`;
}

function formatCurrency(value) {
  const amount = Number(value) || 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function formatInteger(value) {
  return (Number(value) || 0).toLocaleString();
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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

function setActiveTab(tabId) {
  els.tabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabId);
  });
  els.panels.forEach((panel) => {
    panel.classList.toggle("active", panel.id === `tab-${tabId}`);
  });
  if (tabId === "creators" && !creatorLinkLoaded) {
    loadCreatorPortalLink().catch((err) => {
      showBanner("error", err.message);
    });
  }
}

function renderCreatorPortalLink(result) {
  if (!result.creatorPortalUrl) {
    els.creatorLinkCard.classList.remove("hidden");
    els.creatorLinkEmpty.classList.remove("hidden");
    els.creatorLinkContent.classList.add("hidden");
    return;
  }

  els.creatorLinkCard.classList.remove("hidden");
  els.creatorLinkEmpty.classList.add("hidden");
  els.creatorLinkContent.classList.remove("hidden");
  els.creatorPortalUrl.value = result.creatorPortalUrl;
}

async function loadCreatorPortalLink() {
  const result = await api("GET", "/api/creator-portal-link");
  renderCreatorPortalLink(result);
  creatorLinkLoaded = true;
}

function renderOverviewOrders(orders) {
  els.overviewOrdersCount.textContent = String(orders.length);
  if (!orders.length) {
    els.overviewOrders.className = "stack-list empty-state";
    els.overviewOrders.textContent = "No orders yet.";
    return;
  }

  els.overviewOrders.className = "stack-list";
  els.overviewOrders.innerHTML = orders.slice(0, 5).map((order) => `
    <div class="stack-row">
      <div>
        <div class="row-title">#${escapeHtml(order.order_id)}</div>
        <div class="row-subtle">${escapeHtml(formatDate(order.ts))}</div>
      </div>
      <div class="row-meta">
        ${order.isAttributed ? pill("success", "Attributed") : pill("warning", "Pending")}
        <span>${escapeHtml(formatCurrency(order.total_revenue))}</span>
      </div>
    </div>
  `).join("");
}

function renderOverviewCreators(creators) {
  els.overviewCreatorsCount.textContent = String(creators.length);
  if (!creators.length) {
    els.overviewCreators.className = "stack-list empty-state";
    els.overviewCreators.textContent = "No creators yet.";
    return;
  }

  els.overviewCreators.className = "stack-list";
  els.overviewCreators.innerHTML = creators.slice(0, 5).map((creator) => `
    <div class="stack-row">
      <div>
        <div class="row-title">${escapeHtml(creator.name || creator.external_id || "Unnamed creator")}</div>
        <div class="row-subtle">${escapeHtml(creator.email || "No email on file")}</div>
      </div>
      <div class="row-meta">
        ${creator.status === "active" ? pill("success", "Active") : pill("warning", escapeHtml(creator.status || "Pending"))}
        <span>${escapeHtml(String(creator.asset_count || 0))} assets</span>
      </div>
    </div>
  `).join("");
}

function renderOrdersTable(orders) {
  els.ordersCount.textContent = String(orders.length);
  if (!orders.length) {
    els.ordersTable.innerHTML = `<tr><td colspan="5" class="empty-cell">No orders found.</td></tr>`;
    return;
  }

  els.ordersTable.innerHTML = orders.map((order) => `
    <tr>
      <td>#${escapeHtml(order.order_id)}</td>
      <td>${escapeHtml(formatDate(order.ts))}</td>
      <td>${escapeHtml(formatCurrency(order.total_revenue))}</td>
      <td>${escapeHtml((order.exposure_ids || []).join(", ") || "No exposure IDs on order")}</td>
      <td>${order.isAttributed ? pill("success", "Attributed") : pill("warning", "Pending / fallback")}</td>
    </tr>
  `).join("");
}

function renderCreatorsTable(creators) {
  els.creatorsCount.textContent = String(creators.length);
  if (!creators.length) {
    els.creatorsTable.innerHTML = `<tr><td colspan="5" class="empty-cell">No creators found.</td></tr>`;
    return;
  }

  els.creatorsTable.innerHTML = creators.map((creator) => `
    <tr>
      <td>${escapeHtml(creator.name || creator.external_id || "Unnamed creator")}</td>
      <td>${escapeHtml(creator.email || "—")}</td>
      <td>${escapeHtml(String(creator.asset_count || 0))}</td>
      <td>${creator.stripe_connected ? pill("success", "Connected") : pill("warning", "Not connected")}</td>
      <td>${creator.status === "active" ? pill("success", "Active") : pill("warning", escapeHtml(creator.status || "Pending"))}</td>
    </tr>
  `).join("");
}

function renderPayoutsTable(result) {
  const payouts = result.payouts || [];
  els.payoutTotal.textContent = formatCurrency(result.totalAmount || 0);

  if (!payouts.length) {
    els.payoutsTable.innerHTML = `<tr><td colspan="5" class="empty-cell">No payouts found.</td></tr>`;
    return;
  }

  els.payoutsTable.innerHTML = payouts.map((payout) => `
    <tr>
      <td>${escapeHtml(payout.creator_name || payout.creator_id || "Unknown creator")}</td>
      <td>${escapeHtml(payout.period || "—")}</td>
      <td>${escapeHtml(formatCurrency(payout.amount))}</td>
      <td>${payout.status === "paid" ? pill("success", "Paid") : pill("warning", escapeHtml(payout.status || "Pending"))}</td>
      <td>${escapeHtml(payout.paid_at ? formatDate(payout.paid_at) : "—")}</td>
    </tr>
  `).join("");
}

function populateAttributionSettings(settings) {
  els.attrModel.value = settings.attribution_model || "last_touch";
  els.attrCommissionRate.value = ((Number(settings.default_commission_rate) || 0) * 100).toFixed(1);
  els.attrViewWindow.value = String(settings.view_window_days || 7);
  els.attrClickWindow.value = String(settings.click_window_days || 30);

  const qualifying = settings.qualifying_events || [];
  els.attrEventBoxes.forEach((box) => {
    box.checked = qualifying.includes(box.value);
  });
}

async function loadStatusAndSettings() {
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

async function loadDashboard() {
  const [stats, creators, orders, payouts, attribution] = await Promise.all([
    api("GET", "/api/stats?period_days=30"),
    api("GET", "/api/creators"),
    api("GET", "/api/orders?limit=10"),
    api("GET", "/api/payouts"),
    api("GET", "/api/attribution-settings"),
  ]);

  els.metricExposures.textContent = formatInteger(stats.data?.total_exposures);
  els.metricOrders.textContent = formatInteger(stats.data?.total_orders);
  els.metricRevenue.textContent = formatCurrency(stats.data?.total_revenue);
  els.metricCommission.textContent = formatCurrency(stats.data?.total_commission);

  renderOverviewOrders(orders.orders || []);
  renderOverviewCreators(creators.creators || []);
  renderOrdersTable(orders.orders || []);
  renderCreatorsTable(creators.creators || []);
  renderPayoutsTable(payouts);
  populateAttributionSettings(attribution.settings || {});
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
    els.apiKey.value = "";
  }

  showBanner("success", "Settings saved.");
  await Promise.all([loadStatusAndSettings(), loadDashboard()]);
}

async function saveAttributionSettings() {
  const qualifyingEvents = els.attrEventBoxes.filter((box) => box.checked).map((box) => box.value);
  const payload = {
    attribution_model: els.attrModel.value,
    default_commission_rate: (parseFloat(els.attrCommissionRate.value) || 0) / 100,
    view_window_days: parseInt(els.attrViewWindow.value, 10) || 7,
    click_window_days: parseInt(els.attrClickWindow.value, 10) || 30,
    qualifying_events: qualifyingEvents.length ? qualifyingEvents : ["click", "watch_start"],
  };
  await api("PUT", "/api/attribution-settings", payload);
  showBanner("success", "Attribution settings saved.");
}

els.tabs.forEach((tab) => {
  tab.addEventListener("click", () => setActiveTab(tab.dataset.tab));
});

els.copyCreatorPortalUrl?.addEventListener("click", async () => {
  if (!els.creatorPortalUrl.value) return;
  await navigator.clipboard.writeText(els.creatorPortalUrl.value);
  showBanner("success", "Creator signup link copied.");
});

els.diagnoseWebhook.addEventListener("click", async () => {
  try {
    await diagnoseWebhook();
  } catch (err) {
    showBanner("error", err.message);
  }
});

els.saveSettings.addEventListener("click", async () => {
  try {
    clearBanners();
    await saveSettings();
  } catch (err) {
    showBanner("error", err.message);
  }
});

els.saveAttribution.addEventListener("click", async () => {
  try {
    clearBanners();
    await saveAttributionSettings();
  } catch (err) {
    showBanner("error", err.message);
  }
});

Promise.all([loadStatusAndSettings(), loadDashboard()]).catch((err) => {
  showBanner("error", err.message);
});
