/**
 * OCE Shopify App — Express Server
 * Handles:
 *  - Shopify OAuth & session management
 *  - Admin UI serving
 *  - API routes (settings, status)
 *  - Webhook processing (orders/create → OCE)
 *  - Script tag injection
 */

import express from "express";
import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import { OceApiService } from "./backend/services/oce-api.js";
import { handleOrderCreated } from "./backend/routes/webhooks.js";
import {
  getSettings,
  updateSettings,
  updateApiKey,
  getIntegrationStatus,
  syncAppMetafields,
} from "./backend/routes/settings.js";

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ────────────────────────────────────────────────────

app.post("/webhooks/*", express.raw({ type: "application/json" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Shopify Auth Helpers ─────────────────────────────────────────

const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const SHOPIFY_APP_URL = process.env.SHOPIFY_APP_URL;
const SCOPES =
  "read_all_orders,read_customers,read_products,read_script_tags,write_script_tags";

function verifyHmac(query) {
  const { hmac, ...rest } = query;
  if (!hmac) return false;
  const message = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${rest[key]}`)
    .join("&");
  const generated = crypto
    .createHmac("sha256", SHOPIFY_API_SECRET)
    .update(message)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(generated), Buffer.from(hmac));
  } catch {
    return false;
  }
}

function verifyWebhookHmac(body, hmacHeader) {
  const generated = crypto
    .createHmac("sha256", SHOPIFY_API_SECRET)
    .update(body)
    .digest("base64");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(generated),
      Buffer.from(hmacHeader)
    );
  } catch {
    return false;
  }
}

// ─── OAuth Routes ─────────────────────────────────────────────────

app.get("/auth", (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).send("Missing shop parameter");

  const nonce = crypto.randomBytes(16).toString("hex");
  const redirectUri = `${SHOPIFY_APP_URL}/auth/callback`;
  const installUrl =
    `https://${shop}/admin/oauth/authorize?` +
    `client_id=${SHOPIFY_API_KEY}&scope=${SCOPES}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${nonce}`;

  res.redirect(installUrl);
});

app.get("/auth/callback", async (req, res) => {
  const { shop, hmac, code, state } = req.query;

  if (!verifyHmac(req.query)) {
    return res.status(400).send("HMAC verification failed");
  }

  try {
    const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: SHOPIFY_API_KEY,
        client_secret: SHOPIFY_API_SECRET,
        code,
      }),
    });

    const { access_token } = await response.json();

    await prisma.session.upsert({
      where: { id: `offline_${shop}` },
      create: {
        id: `offline_${shop}`,
        shop,
        state: state || "",
        isOnline: false,
        accessToken: access_token,
        scope: SCOPES,
      },
      update: { accessToken: access_token, scope: SCOPES },
    });

    await prisma.oceSettings.upsert({
      where: { shop },
      create: { shop },
      update: {},
    });

    await registerWebhooks(shop, access_token);

    res.redirect(`https://${shop}/admin/apps/${SHOPIFY_API_KEY}`);
  } catch (error) {
    console.error("[Auth] Error:", error);
    res.status(500).send("Authentication failed");
  }
});

// Alias routes for redirect URL compatibility
app.get("/auth/shopify/callback", (req, res) => res.redirect(`/auth/callback?${new URLSearchParams(req.query)}`));
app.get("/api/auth/callback", (req, res) => res.redirect(`/auth/callback?${new URLSearchParams(req.query)}`));

// ─── Webhook Registration ─────────────────────────────────────────

async function registerWebhooks(shop, accessToken) {
  const webhooks = [
    { topic: "orders/create", address: `${SHOPIFY_APP_URL}/webhooks/orders/create` },
    { topic: "app/uninstalled", address: `${SHOPIFY_APP_URL}/webhooks/app/uninstalled` },
  ];

  for (const wh of webhooks) {
    try {
      await fetch(`https://${shop}/admin/api/2024-10/webhooks.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ webhook: { topic: wh.topic, address: wh.address, format: "json" } }),
      });
      console.log(`[Webhook] Registered ${wh.topic} for ${shop}`);
    } catch (error) {
      console.error(`[Webhook] Failed ${wh.topic}:`, error.message);
    }
  }
}

// ─── Webhook Endpoints ────────────────────────────────────────────

app.post("/webhooks/orders/create", async (req, res) => {
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
  const shop = req.headers["x-shopify-shop-domain"];
  if (!hmacHeader || !verifyWebhookHmac(req.body, hmacHeader)) {
    return res.status(401).send("Unauthorized");
  }
  res.status(200).send("OK");
  try {
    const orderData = JSON.parse(req.body.toString());
    await handleOrderCreated(shop, orderData);
  } catch (error) {
    console.error("[Webhook] orders/create error:", error);
  }
});

app.post("/webhooks/app/uninstalled", async (req, res) => {
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
  const shop = req.headers["x-shopify-shop-domain"];
  if (!hmacHeader || !verifyWebhookHmac(req.body, hmacHeader)) {
    return res.status(401).send("Unauthorized");
  }
  res.status(200).send("OK");
  try {
    await prisma.oceSettings.deleteMany({ where: { shop } });
    await prisma.orderSync.deleteMany({ where: { shop } });
    await prisma.videoAsset.deleteMany({ where: { shop } });
    await prisma.session.deleteMany({ where: { shop } });
  } catch (error) {
    console.error("[Webhook] uninstall error:", error);
  }
});

app.post("/webhooks/customers/delete", (req, res) => res.status(200).send("OK"));
app.post("/webhooks/customers/data-request", (req, res) => res.status(200).send("OK"));
app.post("/webhooks/shop/delete", (req, res) => res.status(200).send("OK"));

// ─── Auth Middleware ──────────────────────────────────────────────

async function authenticate(req, res, next) {
  const shop = req.query.shop || req.headers["x-shop-domain"];
  if (!shop) return res.status(401).json({ error: "Missing shop" });
  const session = await prisma.session.findUnique({ where: { id: `offline_${shop}` } });
  if (!session) return res.status(401).json({ error: "Not authenticated" });
  req.shop = shop;
  req.session = session;
  next();
}

// ─── API Routes ───────────────────────────────────────────────────

app.get("/api/settings", authenticate, async (req, res) => {
  res.json(await getSettings(req.shop));
});

app.put("/api/settings", authenticate, async (req, res) => {
  const settings = await updateSettings(req.shop, req.body);
  // Sync to Shopify app metafields so the Liquid theme extension can read them
  await syncAppMetafields(req.shop, req.session.accessToken);
  res.json({ success: true, settings });
});

app.put("/api/settings/api-key", authenticate, async (req, res) => {
  const result = await updateApiKey(req.shop, req.body.apiKey);
  // Sync to Shopify app metafields so the Liquid theme extension can read them
  await syncAppMetafields(req.shop, req.session.accessToken);
  res.json(result);
});

app.get("/api/settings/status", authenticate, async (req, res) => {
  res.json(await getIntegrationStatus(req.shop));
});

// ─── Admin UI ─────────────────────────────────────────────────────

app.get("/", (req, res) => {
  const { shop, host } = req.query;
  res.send(getAdminHTML(shop || "", host || ""));
});

function getAdminHTML(shop, host) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Onsite Commission Engine</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f6f6f7;color:#202223}
    .app{max-width:1000px;margin:0 auto;padding:24px 16px}
    .header{margin-bottom:24px;display:flex;justify-content:space-between;align-items:center}
    .header h1{font-size:24px;font-weight:600}
    .header p{color:#6d7175;margin-top:4px}
    .card{background:#fff;border-radius:12px;border:1px solid #e1e3e5;padding:20px;margin-bottom:16px}
    .card h2{font-size:16px;font-weight:600;margin-bottom:12px}
    .card-row{display:flex;justify-content:space-between;align-items:center}
    .grid-3{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:12px}
    .grid-2{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}
    .grid-4{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:12px}
    .status-box{background:#f6f6f7;border-radius:8px;padding:16px}
    .status-box h3{font-size:14px;font-weight:600;margin-bottom:8px}
    .badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:500}
    .b-ok{background:#aee9d1;color:#0b5e3b}.b-warn{background:#ffea8a;color:#595130}
    .b-err{background:#fed3d1;color:#6e1717}.b-info{background:#e4e5e7;color:#44474a}
    .form-g{margin-bottom:16px}
    .form-g label{display:block;font-size:14px;font-weight:500;margin-bottom:4px}
    .form-g .help{font-size:12px;color:#6d7175;margin-top:2px}
    input[type=text],input[type=password],input[type=number],select{width:100%;padding:8px 12px;border:1px solid #c9cccf;border-radius:8px;font-size:14px;outline:none}
    input:focus,select:focus{border-color:#005bd3;box-shadow:0 0 0 1px #005bd3}
    .btn{display:inline-block;padding:8px 16px;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;border:none}
    .btn-p{background:#005bd3;color:#fff}.btn-p:hover{background:#004bb5}.btn-p:disabled{background:#b5c7e3;cursor:not-allowed}
    .btn-s{background:#f6f6f7;color:#202223;border:1px solid #c9cccf}.btn-link{background:none;color:#005bd3;padding:4px 8px}
    .tog{display:flex;align-items:center;gap:8px;cursor:pointer}
    .tog-t{width:36px;height:20px;border-radius:10px;background:#c9cccf;position:relative;transition:background .2s}
    .tog-t.on{background:#005bd3}
    .tog-th{width:16px;height:16px;border-radius:50%;background:#fff;position:absolute;top:2px;left:2px;transition:left .2s}
    .tog-t.on .tog-th{left:18px}
    .code{background:#1e2124;color:#95c7f3;padding:12px 16px;border-radius:8px;font-family:'SF Mono',Monaco,monospace;font-size:13px;line-height:1.6;overflow-x:auto}
    hr{border:none;border-top:1px solid #e1e3e5;margin:16px 0}
    .cl-item{display:flex;gap:12px;align-items:flex-start;padding:12px 0}
    .cl-n{width:28px;height:28px;border-radius:50%;background:#f6f6f7;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;color:#6d7175;flex-shrink:0}
    .cl-c h4{font-size:14px;font-weight:600}.cl-c p{font-size:13px;color:#6d7175}
    .fs{background:#f6f6f7;border-radius:8px;padding:16px;text-align:center}
    .fs .ic{font-size:24px;margin-bottom:8px}.fs h4{font-size:14px;font-weight:600}.fs p{font-size:12px;color:#6d7175;margin-top:4px}
    .cb{display:flex;align-items:center;gap:8px;padding:8px 0}.cb input{width:16px;height:16px}
    .banner{border-radius:8px;padding:12px 16px;margin-bottom:16px;display:none}
    .banner-ok{background:#f1f8f5;border:1px solid #aee9d1;color:#0b5e3b}
    .banner-err{background:#fff4f4;border:1px solid #fed3d1;color:#6e1717}
    .o-row{display:flex;justify-content:space-between;padding:6px 0;font-size:13px;border-bottom:1px solid #f1f1f1}
    @media(max-width:768px){.grid-3,.grid-4,.grid-2{grid-template-columns:1fr}}
    a{color:#005bd3}
  </style>
</head>
<body>
<div class="app">
  <div id="sb" class="banner banner-ok"></div>
  <div id="eb" class="banner banner-err"></div>

  <div class="header"><div><h1>Onsite Commission Engine</h1><p>Track creator video engagement and attribute conversions</p></div>
    <a href="https://app.onsiteaffiliate.com" target="_blank" class="btn btn-p">View OCE Dashboard ↗</a></div>

  <div class="card"><div class="card-row"><h2>Integration Status</h2><span id="ob" class="badge b-info">Loading...</span></div>
    <div class="grid-3">
      <div class="status-box"><h3>🔗 SDK Script</h3><span id="sb1" class="badge b-info">—</span><p id="sm1" style="font-size:12px;color:#6d7175;margin-top:6px"></p></div>
      <div class="status-box"><h3>📦 Order Webhook</h3><span id="sb2" class="badge b-info">—</span><p id="sm2" style="font-size:12px;color:#6d7175;margin-top:6px"></p></div>
      <div class="status-box"><h3>📡 API Connection</h3><span id="sb3" class="badge b-info">—</span><p id="sm3" style="font-size:12px;color:#6d7175;margin-top:6px"></p></div>
    </div>
  </div>

  <div class="card"><div class="card-row"><div><h2>API Key</h2><p style="font-size:13px;color:#6d7175">Get your key from <a href="https://app.onsiteaffiliate.com/settings/api-keys" target="_blank">app.onsiteaffiliate.com</a></p></div>
    <button class="btn btn-link" onclick="document.getElementById('kf').style.display=document.getElementById('kf').style.display==='none'?'block':'none'">Change Key</button></div>
    <div id="kd" style="margin-top:12px;background:#f6f6f7;border-radius:8px;padding:12px;display:none">✅ <span id="mk"></span></div>
    <div id="kf" style="margin-top:12px"><div class="form-g"><label>OCE API Key</label>
      <input type="password" id="ki" placeholder="oce_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx">
      <p class="help">Paste your API key from the OCE dashboard.</p></div>
      <button class="btn btn-p" onclick="saveKey()" id="skb">Save Key</button></div>
  </div>

  <div class="card" id="qs"><h2>Quick Start</h2><hr>
    <div class="cl-item"><div class="cl-n">1</div><div class="cl-c"><h4>Create an OCE Account</h4><p><a href="https://app.onsiteaffiliate.com/signup" target="_blank">Sign up at app.onsiteaffiliate.com</a></p></div></div>
    <div class="cl-item"><div class="cl-n">2</div><div class="cl-c"><h4>Generate an API Key</h4><p>Settings → API Keys in OCE dashboard</p></div></div>
    <div class="cl-item"><div class="cl-n">3</div><div class="cl-c"><h4>Paste Your Key Above</h4><p>Enter your API key to connect</p></div></div>
    <div class="cl-item"><div class="cl-n">4</div><div class="cl-c"><h4>Configure Attribution</h4><p>Set commission rates, window, and events</p></div></div>
    <div class="cl-item"><div class="cl-n">5</div><div class="cl-c"><h4>Register Video Assets</h4><p><a href="https://app.onsiteaffiliate.com/assets" target="_blank">Map videos to products</a></p></div></div>
  </div>

  <div class="grid-2">
    <div class="card"><div class="card-row"><div><h2>OCE SDK Script</h2><p style="font-size:13px;color:#6d7175">Auto-injects tracking into storefront</p></div>
      <div class="tog" onclick="tSdk()"><div id="st" class="tog-t on"><div class="tog-th"></div></div></div></div>
      <div id="sc" style="margin-top:12px"><div class="code">&lt;script<br>&nbsp;&nbsp;src="https://app.onsiteaffiliate.com/sdk/oce.min.js"<br>&nbsp;&nbsp;data-api-key="<span id="pk">YOUR_KEY</span>"<br>&nbsp;&nbsp;defer&gt;<br>&lt;/script&gt;</div>
      <p style="font-size:12px;color:#6d7175;margin-top:8px">Auto-detects Videowise, Tolstoy, Firework, YouTube, Vimeo, HTML5 players.</p></div>
    </div>
    <div class="card"><div class="card-row"><div><h2>Order Webhook</h2><p style="font-size:13px;color:#6d7175">Sends orders to OCE for attribution</p></div>
      <div class="tog" onclick="tWh()"><div id="wt" class="tog-t on"><div class="tog-th"></div></div></div></div>
      <p style="font-size:13px;color:#6d7175;margin-top:12px">Order details and exposure IDs sent to OCE REST API on checkout.</p>
      <div id="ro" style="margin-top:12px"></div>
    </div>
  </div>

  <div class="card"><div class="card-row"><h2>Attribution Settings</h2><button class="btn btn-link" onclick="var p=document.getElementById('sp');p.style.display=p.style.display==='none'?'block':'none'">Expand ▾</button></div>
    <div id="sp" style="display:none"><hr>
      <div class="form-g"><label>Attribution Model</label><select id="am"><option value="last-touch">Last Touch</option><option value="first-touch">First Touch</option></select>
        <p class="help">Which creator gets commission when multiple videos watched.</p></div>
      <div class="form-g"><label>Attribution Window: <span id="wv">30</span> days</label>
        <input type="range" id="aw" min="1" max="90" value="30" oninput="document.getElementById('wv').textContent=this.value" style="width:100%">
        <p class="help">How long after a view can a purchase be attributed.</p></div>
      <div class="form-g"><label>Commission Rate (%)</label><input type="number" id="cr" value="10" min="0" max="100" step="0.5">
        <p class="help">Default rate. Override per-SKU/creator in OCE dashboard.</p></div>
      <hr><h3 style="font-size:14px;font-weight:600;margin-bottom:8px">Qualifying Events</h3>
      <div class="cb"><input type="checkbox" id="ti" checked><label for="ti">Track Impressions</label></div>
      <div class="cb"><input type="checkbox" id="tc" checked><label for="tc">Track Clicks</label></div>
      <div class="cb"><input type="checkbox" id="tw" checked><label for="tw">Track Watch Progress</label></div>
      <div class="form-g" style="margin-top:12px"><label>Min Watch %: <span id="mv">25</span>%</label>
        <input type="range" id="mw" min="5" max="100" step="5" value="25" oninput="document.getElementById('mv').textContent=this.value" style="width:100%"></div>
      <hr><div style="text-align:right"><button class="btn btn-p" onclick="saveSets()">Save Attribution Settings</button></div>
    </div>
  </div>

  <div class="card"><h2>How It Works</h2>
    <div class="grid-4">
      <div class="fs"><div class="ic">▶️</div><h4>Video Plays</h4><p>User watches creator content</p></div>
      <div class="fs"><div class="ic">📊</div><h4>Events Tracked</h4><p>Impressions, clicks, watch</p></div>
      <div class="fs"><div class="ic">🛒</div><h4>Order Received</h4><p>Conversion via webhook</p></div>
      <div class="fs"><div class="ic">💰</div><h4>Attribution</h4><p>Commission calculated</p></div>
    </div>
  </div>
</div>

<script>
const S="${shop}",B="";
let st={sdk:true,wh:true,key:false};

async function api(m,p,b){
  const o={method:m,headers:{"Content-Type":"application/json","X-Shop-Domain":S}};
  if(b)o.body=JSON.stringify(b);
  return(await fetch(B+p+"?shop="+S,o)).json();
}
function msg(t,m){const e=document.getElementById(t==="success"?"sb":"eb");e.textContent=m;e.style.display="block";setTimeout(()=>e.style.display="none",5000)}
function bg(s){const m={active:["b-ok","Active"],connected:["b-ok","Connected"],healthy:["b-ok","Healthy"],disabled:["b-warn","Disabled"],inactive:["b-err","Inactive"],error:["b-err","Error"],not_configured:["b-warn","Not Configured"]};const[c,l]=m[s]||["b-info",s];return'<span class="badge '+c+'">'+l+"</span>"}

async function load(){
  try{
    const s=await api("GET","/api/settings");
    if(s.hasApiKey){document.getElementById("kd").style.display="block";document.getElementById("kf").style.display="none";document.getElementById("mk").textContent=s.apiKey;document.getElementById("qs").style.display="none";document.getElementById("pk").textContent=s.apiKey}
    tog("st",s.sdkEnabled);tog("wt",s.webhookEnabled);st.sdk=s.sdkEnabled;st.wh=s.webhookEnabled;
    document.getElementById("am").value=s.attributionModel;
    document.getElementById("aw").value=s.attributionWindow;document.getElementById("wv").textContent=s.attributionWindow;
    document.getElementById("cr").value=s.commissionRate;
    document.getElementById("ti").checked=s.trackImpressions;document.getElementById("tc").checked=s.trackClicks;document.getElementById("tw").checked=s.trackWatchProgress;
    document.getElementById("mw").value=s.minWatchPercent;document.getElementById("mv").textContent=s.minWatchPercent;
  }catch(e){console.log("Settings load pending auth")}
  try{
    const x=await api("GET","/api/settings/status");
    document.getElementById("ob").outerHTML=bg(x.overall);
    document.getElementById("sb1").outerHTML=bg(x.sdk.status);document.getElementById("sm1").textContent=x.sdk.message;
    document.getElementById("sb2").outerHTML=bg(x.webhook.status);document.getElementById("sm2").textContent=x.webhook.message;
    document.getElementById("sb3").outerHTML=bg(x.apiConnection.status);document.getElementById("sm3").textContent=x.apiConnection.message;
    if(x.recentOrders&&x.recentOrders.length)document.getElementById("ro").innerHTML="<strong>Recent Orders</strong>"+x.recentOrders.map(o=>'<div class="o-row"><span>#'+o.shopifyOrderId+"</span>"+bg(o.status)+"</div>").join("");
  }catch(e){console.log("Status load pending auth")}
}

async function saveKey(){
  const k=document.getElementById("ki").value.trim();if(!k)return;
  const b=document.getElementById("skb");b.disabled=true;b.textContent="Saving...";
  const r=await api("PUT","/api/settings/api-key",{apiKey:k});
  b.disabled=false;b.textContent="Save Key";
  if(r.success){msg("success","API key saved!");load()}else msg("error",r.error||"Failed to save API key");
}

async function saveSets(){
  const r=await api("PUT","/api/settings",{sdkEnabled:st.sdk,webhookEnabled:st.wh,
    attributionModel:document.getElementById("am").value,
    attributionWindow:parseInt(document.getElementById("aw").value),
    commissionRate:parseFloat(document.getElementById("cr").value),
    trackImpressions:document.getElementById("ti").checked,
    trackClicks:document.getElementById("tc").checked,
    trackWatchProgress:document.getElementById("tw").checked,
    minWatchPercent:parseInt(document.getElementById("mw").value)});
  if(r.success)msg("success","Settings saved!");else msg("error","Save failed");
}

function tog(id,v){const e=document.getElementById(id);if(v)e.classList.add("on");else e.classList.remove("on")}
function tSdk(){st.sdk=!st.sdk;tog("st",st.sdk);document.getElementById("sc").style.display=st.sdk?"block":"none"}
function tWh(){st.wh=!st.wh;tog("wt",st.wh)}

load();
</script>
</body></html>`;
}

// ─── Start ────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log("[OCE] Running on port " + PORT);
  console.log("[OCE] URL: " + SHOPIFY_APP_URL);
});

export default app;
