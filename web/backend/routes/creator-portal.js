/**
 * Creator Portal — Onsite Affiliate
 *
 * Handles creator signup, email verification, login, video submission,
 * and dashboard rendering. Served via Shopify App Proxy at /apps/onsite-affiliate.
 *
 * Flow:
 *   1. Creator visits /apps/onsite-affiliate on the storefront
 *   2. Signs up (name, email, password, accept terms)
 *   3. Verifies email with 6-digit code
 *   4. Logs in → sees dashboard with stats, video list, submit form
 */

import { PrismaClient } from "@prisma/client";
import crypto from "crypto";

const prisma = new PrismaClient();
const JWT_SECRET = process.env.SHOPIFY_API_SECRET || "oce-dev-secret";

// ─── Password Utilities ──────────────────────────────────────────

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString("hex");
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) return reject(err);
      resolve(salt + ":" + key.toString("hex"));
    });
  });
}

function checkPassword(password, hash) {
  return new Promise((resolve, reject) => {
    const [salt, key] = hash.split(":");
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) return reject(err);
      try {
        resolve(crypto.timingSafeEqual(Buffer.from(key, "hex"), derivedKey));
      } catch {
        resolve(false);
      }
    });
  });
}

// ─── JWT Utilities ───────────────────────────────────────────────

function createJwt(payload) {
  var header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  var body = Buffer.from(JSON.stringify({
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 7 * 86400,
  })).toString("base64url");
  var sig = crypto.createHmac("sha256", JWT_SECRET).update(header + "." + body).digest("base64url");
  return header + "." + body + "." + sig;
}

function verifyJwt(token) {
  try {
    var parts = token.split(".");
    if (parts.length !== 3) return null;
    var expected = crypto.createHmac("sha256", JWT_SECRET).update(parts[0] + "." + parts[1]).digest("base64url");
    if (!crypto.timingSafeEqual(Buffer.from(parts[2]), Buffer.from(expected))) return null;
    var payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function authenticateCreator(req) {
  var authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  return verifyJwt(authHeader.slice(7));
}

// ─── API Handlers ────────────────────────────────────────────────

export async function handleSignup(req, res) {
  var shop = req.query.shop;
  var { name, email, password } = req.body || {};

  if (!name || !email || !password) {
    return res.status(400).json({ error: "Name, email, and password are required" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }

  try {
    var existing = await prisma.creator.findUnique({
      where: { shop_email: { shop, email: email.toLowerCase() } },
    });

    if (existing && existing.verified) {
      return res.status(409).json({ error: "An account with this email already exists. Please log in." });
    }

    var passwordHash = await hashPassword(password);

    var creator = await prisma.creator.upsert({
      where: { shop_email: { shop, email: email.toLowerCase() } },
      create: { shop, name, email: email.toLowerCase(), passwordHash, termsAccepted: true },
      update: { name, passwordHash, termsAccepted: true },
    });

    var code = String(Math.floor(100000 + Math.random() * 900000));
    await prisma.verificationCode.create({
      data: {
        creatorId: creator.id,
        code,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });

    console.log("[Creator] Verification code for " + email + ": " + code);

    res.json({
      ok: true,
      message: "Account created. Check your email for the verification code.",
    });
  } catch (error) {
    console.error("[Creator] Signup error:", error);
    res.status(500).json({ error: "Failed to create account" });
  }
}

export async function handleVerify(req, res) {
  var shop = req.query.shop;
  var { email, code } = req.body || {};

  if (!email || !code) {
    return res.status(400).json({ error: "Email and code are required" });
  }

  try {
    var creator = await prisma.creator.findUnique({
      where: { shop_email: { shop, email: email.toLowerCase() } },
    });

    if (!creator) {
      return res.status(404).json({ error: "Account not found" });
    }

    var vc = await prisma.verificationCode.findFirst({
      where: {
        creatorId: creator.id,
        code: String(code),
        used: false,
        expiresAt: { gte: new Date() },
      },
    });

    if (!vc) {
      return res.status(400).json({ error: "Invalid or expired verification code" });
    }

    await prisma.verificationCode.update({
      where: { id: vc.id },
      data: { used: true },
    });

    await prisma.creator.update({
      where: { id: creator.id },
      data: { verified: true },
    });

    var token = createJwt({ creatorId: creator.id, shop, email: creator.email });

    res.json({
      ok: true,
      token,
      creator: { id: creator.id, name: creator.name, email: creator.email },
    });
  } catch (error) {
    console.error("[Creator] Verify error:", error);
    res.status(500).json({ error: "Verification failed" });
  }
}

export async function handleLogin(req, res) {
  var shop = req.query.shop;
  var { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  try {
    var creator = await prisma.creator.findUnique({
      where: { shop_email: { shop, email: email.toLowerCase() } },
    });

    if (!creator) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    if (!creator.verified) {
      return res.status(403).json({ error: "Please verify your email first", needsVerification: true });
    }

    var valid = await checkPassword(password, creator.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    var token = createJwt({ creatorId: creator.id, shop, email: creator.email });

    res.json({
      ok: true,
      token,
      creator: { id: creator.id, name: creator.name, email: creator.email },
    });
  } catch (error) {
    console.error("[Creator] Login error:", error);
    res.status(500).json({ error: "Login failed" });
  }
}

export async function handleResendCode(req, res) {
  var shop = req.query.shop;
  var { email } = req.body || {};

  if (!email) {
    return res.status(400).json({ error: "Email is required" });
  }

  try {
    var creator = await prisma.creator.findUnique({
      where: { shop_email: { shop, email: email.toLowerCase() } },
    });

    if (!creator) {
      return res.status(404).json({ error: "Account not found" });
    }
    if (creator.verified) {
      return res.status(400).json({ error: "Email already verified" });
    }

    var code = String(Math.floor(100000 + Math.random() * 900000));
    await prisma.verificationCode.create({
      data: {
        creatorId: creator.id,
        code,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });

    console.log("[Creator] Resend code for " + email + ": " + code);

    res.json({
      ok: true,
      message: "New verification code sent. Check your email.",
    });
  } catch (error) {
    console.error("[Creator] Resend code error:", error);
    res.status(500).json({ error: "Failed to resend code" });
  }
}

export async function handleGetProfile(req, res) {
  var auth = authenticateCreator(req);
  if (!auth) return res.status(401).json({ error: "Not authenticated" });

  try {
    var creator = await prisma.creator.findUnique({
      where: { id: auth.creatorId },
      select: { id: true, name: true, email: true, shop: true, createdAt: true },
    });

    if (!creator) {
      return res.status(404).json({ error: "Creator not found" });
    }

    res.json({ ok: true, creator });
  } catch (error) {
    console.error("[Creator] Profile error:", error);
    res.status(500).json({ error: "Failed to load profile" });
  }
}

export async function handleSubmitVideo(req, res) {
  var auth = authenticateCreator(req);
  if (!auth) return res.status(401).json({ error: "Not authenticated" });

  var { title, videoUrl, skus } = req.body || {};

  if (!title || !videoUrl || !skus) {
    return res.status(400).json({ error: "Title, video URL, and product SKUs are required" });
  }

  try {
    var skuString = Array.isArray(skus) ? JSON.stringify(skus) : skus;

    var video = await prisma.creatorVideo.create({
      data: {
        shop: auth.shop,
        creatorId: auth.creatorId,
        title,
        videoUrl,
        skus: skuString,
      },
    });

    console.log("[Creator] Video submitted:", video.id, "by", auth.email);

    res.json({ ok: true, video });
  } catch (error) {
    console.error("[Creator] Submit video error:", error);
    res.status(500).json({ error: "Failed to submit video" });
  }
}

export async function handleGetVideos(req, res) {
  var auth = authenticateCreator(req);
  if (!auth) return res.status(401).json({ error: "Not authenticated" });

  try {
    var videos = await prisma.creatorVideo.findMany({
      where: { creatorId: auth.creatorId, shop: auth.shop },
      orderBy: { createdAt: "desc" },
    });

    res.json({ ok: true, videos });
  } catch (error) {
    console.error("[Creator] Get videos error:", error);
    res.status(500).json({ error: "Failed to load videos" });
  }
}

export async function handleGetStats(req, res) {
  var auth = authenticateCreator(req);
  if (!auth) return res.status(401).json({ error: "Not authenticated" });

  try {
    var videos = await prisma.creatorVideo.findMany({
      where: { creatorId: auth.creatorId, shop: auth.shop },
    });

    var stats = {
      totalVideos: videos.length,
      totalViews: videos.reduce(function (s, v) { return s + v.views; }, 0),
      totalOrders: videos.reduce(function (s, v) { return s + v.orders; }, 0),
      totalCommission: videos.reduce(function (s, v) { return s + v.commission; }, 0),
    };

    res.json({ ok: true, stats });
  } catch (error) {
    console.error("[Creator] Stats error:", error);
    res.status(500).json({ error: "Failed to load stats" });
  }
}

// ─── Portal Page Renderer ───────────────────────────────────────

export function renderPortalPage(pathPrefix) {
  var apiBase = pathPrefix + "/api";

  return `
<style>
  #oce-portal{max-width:720px;margin:40px auto;padding:0 16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1a1a2e}
  #oce-portal *{box-sizing:border-box}
  #oce-portal h1{font-size:28px;font-weight:700;margin:0 0 8px}
  #oce-portal h2{font-size:20px;font-weight:600;margin:0 0 16px}
  #oce-portal p{margin:0 0 8px;color:#6d7175}
  #oce-portal .portal-header{margin-bottom:24px}
  #oce-portal .portal-card{background:#fff;border:1px solid #e1e3e5;border-radius:12px;padding:24px;margin-bottom:24px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
  #oce-portal .tabs{display:flex;gap:0;margin-bottom:20px;border-bottom:2px solid #e1e3e5}
  #oce-portal .tab{background:none;border:none;padding:10px 20px;font-size:15px;font-weight:600;color:#6d7175;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-2px;transition:all .2s}
  #oce-portal .tab.active{color:#008060;border-bottom-color:#008060}
  #oce-portal .tab:hover{color:#006e52}
  #oce-portal .form-group{margin-bottom:16px}
  #oce-portal .form-group label{display:block;font-size:13px;font-weight:600;color:#1a1a2e;margin-bottom:6px}
  #oce-portal .form-group input[type="text"],
  #oce-portal .form-group input[type="email"],
  #oce-portal .form-group input[type="password"],
  #oce-portal .form-group input[type="url"]{width:100%;padding:10px 12px;border:1px solid #c9cccf;border-radius:8px;font-size:14px;transition:border-color .2s;outline:none}
  #oce-portal .form-group input:focus{border-color:#008060;box-shadow:0 0 0 2px rgba(0,128,96,.15)}
  #oce-portal .checkbox{display:flex;align-items:center;gap:8px}
  #oce-portal .checkbox input{width:auto;margin:0}
  #oce-portal .checkbox label{margin:0;font-weight:400;font-size:13px}
  #oce-portal .form-hint{font-size:12px;color:#8c9196;margin-top:4px;display:block}
  #oce-portal .form-error{color:#d72c0d;font-size:13px;margin-bottom:12px;display:none}
  #oce-portal .form-error.show{display:block}
  #oce-portal .form-success{color:#008060;font-size:13px;margin-bottom:12px;display:none}
  #oce-portal .form-success.show{display:block}
  #oce-portal .btn-primary{width:100%;padding:12px;background:#008060;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;transition:background .2s}
  #oce-portal .btn-primary:hover{background:#006e52}
  #oce-portal .btn-primary:disabled{background:#8c9196;cursor:not-allowed}
  #oce-portal .btn-secondary{width:100%;padding:10px;background:transparent;color:#008060;border:1px solid #008060;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;margin-top:8px;transition:all .2s}
  #oce-portal .btn-secondary:hover{background:#f1f8f5}
  #oce-portal .stats-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px}
  @media(max-width:600px){#oce-portal .stats-grid{grid-template-columns:repeat(2,1fr)}}
  #oce-portal .stat-card{background:#fff;border:1px solid #e1e3e5;border-radius:12px;padding:16px;text-align:center}
  #oce-portal .stat-label{font-size:12px;color:#6d7175;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}
  #oce-portal .stat-value{font-size:24px;font-weight:700;color:#1a1a2e}
  #oce-portal .video-row{display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid #f1f1f1}
  #oce-portal .video-row:last-child{border-bottom:none}
  #oce-portal .video-title{font-weight:600;font-size:14px}
  #oce-portal .video-meta{font-size:12px;color:#6d7175}
  #oce-portal .badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;text-transform:uppercase}
  #oce-portal .badge-pending{background:#fff3cd;color:#856404}
  #oce-portal .badge-approved{background:#d4edda;color:#155724}
  #oce-portal .badge-rejected{background:#f8d7da;color:#721c24}
  #oce-portal .empty-state{text-align:center;padding:32px;color:#8c9196;font-size:14px}
  #oce-portal .top-bar{display:flex;justify-content:space-between;align-items:center}
  #oce-portal .top-bar .btn-logout{background:none;border:1px solid #c9cccf;border-radius:8px;padding:8px 16px;font-size:13px;color:#6d7175;cursor:pointer}
  #oce-portal .top-bar .btn-logout:hover{background:#f6f6f7}
  #oce-portal a{color:#008060}
  #oce-portal .verify-input{text-align:center;font-size:28px;letter-spacing:10px;font-weight:700;padding:14px !important}
</style>

<div id="oce-portal">

  <!-- ── Auth View ──────────────────────────────────────── -->
  <div id="auth-view" class="portal-view">
    <div class="portal-header" style="text-align:center">
      <h1>Onsite Affiliate Program</h1>
      <p>Join our creator program and earn commission on every sale your content drives.</p>
    </div>

    <div class="portal-card">
      <div class="tabs">
        <button class="tab active" id="tab-signup" onclick="oceShowTab('signup')">Sign Up</button>
        <button class="tab" id="tab-login" onclick="oceShowTab('login')">Log In</button>
      </div>

      <form id="signup-form" onsubmit="oceSignup(event)">
        <div class="form-group">
          <label for="s-name">Full Name</label>
          <input type="text" id="s-name" required placeholder="Your full name">
        </div>
        <div class="form-group">
          <label for="s-email">Email Address</label>
          <input type="email" id="s-email" required placeholder="you@example.com">
        </div>
        <div class="form-group">
          <label for="s-pass">Password</label>
          <input type="password" id="s-pass" required minlength="8" placeholder="Minimum 8 characters">
        </div>
        <div class="checkbox" style="margin-bottom:16px">
          <input type="checkbox" id="s-terms" required>
          <label for="s-terms">I agree to the Terms &amp; Conditions of the affiliate program</label>
        </div>
        <div id="signup-err" class="form-error"></div>
        <button type="submit" class="btn-primary" id="signup-btn">Create Account</button>
      </form>

      <form id="login-form" style="display:none" onsubmit="oceLogin(event)">
        <div class="form-group">
          <label for="l-email">Email Address</label>
          <input type="email" id="l-email" required placeholder="you@example.com">
        </div>
        <div class="form-group">
          <label for="l-pass">Password</label>
          <input type="password" id="l-pass" required placeholder="Your password">
        </div>
        <div id="login-err" class="form-error"></div>
        <button type="submit" class="btn-primary" id="login-btn">Log In</button>
      </form>
    </div>
  </div>

  <!-- ── Verify View ────────────────────────────────────── -->
  <div id="verify-view" class="portal-view" style="display:none">
    <div class="portal-header" style="text-align:center">
      <h1>Verify Your Email</h1>
      <p>Enter the 6-digit code sent to <strong id="verify-email-show"></strong></p>
    </div>

    <div class="portal-card">
      <form onsubmit="oceVerify(event)">
        <div class="form-group">
          <label for="v-code">Verification Code</label>
          <input type="text" id="v-code" class="verify-input" required maxlength="6" pattern="[0-9]{6}" placeholder="000000" autocomplete="one-time-code">
        </div>
        <div id="verify-err" class="form-error"></div>
        <button type="submit" class="btn-primary" id="verify-btn">Verify Email</button>
        <button type="button" class="btn-secondary" onclick="oceResend()">Resend Code</button>
      </form>
    </div>
  </div>

  <!-- ── Dashboard View ─────────────────────────────────── -->
  <div id="dashboard-view" class="portal-view" style="display:none">
    <div class="portal-header">
      <div class="top-bar">
        <div>
          <h1>Creator Dashboard</h1>
          <p>Welcome back, <strong id="dash-name"></strong></p>
        </div>
        <button class="btn-logout" onclick="oceLogout()">Log Out</button>
      </div>
    </div>

    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">Total Views</div><div class="stat-value" id="sv-views">0</div></div>
      <div class="stat-card"><div class="stat-label">Orders</div><div class="stat-value" id="sv-orders">0</div></div>
      <div class="stat-card"><div class="stat-label">Commission</div><div class="stat-value" id="sv-comm">$0.00</div></div>
      <div class="stat-card"><div class="stat-label">Videos</div><div class="stat-value" id="sv-vids">0</div></div>
    </div>

    <div class="portal-card">
      <h2>Submit a Video</h2>
      <form onsubmit="oceSubmitVideo(event)">
        <div class="form-group">
          <label for="vid-title">Video Title</label>
          <input type="text" id="vid-title" required placeholder="e.g. Summer Look Try-On Haul">
        </div>
        <div class="form-group">
          <label for="vid-url">Video URL</label>
          <input type="url" id="vid-url" required placeholder="https://youtube.com/watch?v=...">
        </div>
        <div class="form-group">
          <label for="vid-skus">Product SKUs</label>
          <input type="text" id="vid-skus" required placeholder="SKU-001, SKU-002">
          <span class="form-hint">Comma-separated list of product SKUs featured in the video</span>
        </div>
        <div id="submit-err" class="form-error"></div>
        <div id="submit-ok" class="form-success"></div>
        <button type="submit" class="btn-primary" id="submit-btn">Submit Video</button>
      </form>
    </div>

    <div class="portal-card">
      <h2>Your Videos</h2>
      <div id="video-list">
        <p class="empty-state">No videos submitted yet. Submit your first video above!</p>
      </div>
    </div>
  </div>

</div>

{% raw %}
<script>
(function(){
  var API = '${apiBase}';
  var token = null;
  var creatorEmail = '';

  // ── Helpers ──────────────────────────────────────────
  function $(id){ return document.getElementById(id); }

  function showErr(id, msg){
    var el = $(id);
    el.textContent = msg;
    el.className = 'form-error show';
  }
  function hideErr(id){
    var el = $(id);
    el.textContent = '';
    el.className = 'form-error';
  }
  function showOk(id, msg){
    var el = $(id);
    el.textContent = msg;
    el.className = 'form-success show';
  }

  function showView(name){
    var views = document.querySelectorAll('.portal-view');
    for(var i=0;i<views.length;i++) views[i].style.display='none';
    $(name+'-view').style.display='block';
  }

  function api(method, path, body){
    var opts = {
      method: method,
      headers: { 'Content-Type':'application/json' }
    };
    if(token) opts.headers['Authorization'] = 'Bearer ' + token;
    if(body) opts.body = JSON.stringify(body);
    return fetch(API + path, opts).then(function(r){ return r.json(); });
  }

  // ── Tabs ─────────────────────────────────────────────
  window.oceShowTab = function(tab){
    $('tab-signup').className = 'tab' + (tab==='signup'?' active':'');
    $('tab-login').className = 'tab' + (tab==='login'?' active':'');
    $('signup-form').style.display = tab==='signup'?'block':'none';
    $('login-form').style.display = tab==='login'?'block':'none';
    hideErr('signup-err');
    hideErr('login-err');
  };

  // ── Signup ───────────────────────────────────────────
  window.oceSignup = function(e){
    e.preventDefault();
    hideErr('signup-err');
    var btn = $('signup-btn');
    btn.disabled = true;
    btn.textContent = 'Creating account...';

    api('POST', '/signup', {
      name: $('s-name').value.trim(),
      email: $('s-email').value.trim().toLowerCase(),
      password: $('s-pass').value
    }).then(function(r){
      btn.disabled = false;
      btn.textContent = 'Create Account';
      if(r.error){
        showErr('signup-err', r.error);
        return;
      }
      creatorEmail = $('s-email').value.trim().toLowerCase();
      $('verify-email-show').textContent = creatorEmail;
      showView('verify');
    }).catch(function(){
      btn.disabled = false;
      btn.textContent = 'Create Account';
      showErr('signup-err', 'Network error. Please try again.');
    });
  };

  // ── Verify ───────────────────────────────────────────
  window.oceVerify = function(e){
    e.preventDefault();
    hideErr('verify-err');
    var btn = $('verify-btn');
    btn.disabled = true;
    btn.textContent = 'Verifying...';

    api('POST', '/verify', {
      email: creatorEmail,
      code: $('v-code').value.trim()
    }).then(function(r){
      btn.disabled = false;
      btn.textContent = 'Verify Email';
      if(r.error){
        showErr('verify-err', r.error);
        return;
      }
      token = r.token;
      localStorage.setItem('oce_creator_token', token);
      localStorage.setItem('oce_creator_name', r.creator.name);
      showDashboard(r.creator.name);
    }).catch(function(){
      btn.disabled = false;
      btn.textContent = 'Verify Email';
      showErr('verify-err', 'Network error. Please try again.');
    });
  };

  // ── Resend Code ──────────────────────────────────────
  window.oceResend = function(){
    api('POST', '/resend-code', { email: creatorEmail }).then(function(r){
      if(r.error){
        showErr('verify-err', r.error);
        return;
      }
      hideErr('verify-err');
    });
  };

  // ── Login ────────────────────────────────────────────
  window.oceLogin = function(e){
    e.preventDefault();
    hideErr('login-err');
    var btn = $('login-btn');
    btn.disabled = true;
    btn.textContent = 'Logging in...';

    api('POST', '/login', {
      email: $('l-email').value.trim().toLowerCase(),
      password: $('l-pass').value
    }).then(function(r){
      btn.disabled = false;
      btn.textContent = 'Log In';
      if(r.needsVerification){
        creatorEmail = $('l-email').value.trim().toLowerCase();
        $('verify-email-show').textContent = creatorEmail;
        showView('verify');
        oceResend();
        return;
      }
      if(r.error){
        showErr('login-err', r.error);
        return;
      }
      token = r.token;
      localStorage.setItem('oce_creator_token', token);
      localStorage.setItem('oce_creator_name', r.creator.name);
      showDashboard(r.creator.name);
    }).catch(function(){
      btn.disabled = false;
      btn.textContent = 'Log In';
      showErr('login-err', 'Network error. Please try again.');
    });
  };

  // ── Dashboard ────────────────────────────────────────
  function showDashboard(name){
    $('dash-name').textContent = name;
    showView('dashboard');
    loadStats();
    loadVideos();
  }

  function loadStats(){
    api('GET', '/stats').then(function(r){
      if(!r.ok) return;
      $('sv-views').textContent = r.stats.totalViews.toLocaleString();
      $('sv-orders').textContent = r.stats.totalOrders.toLocaleString();
      $('sv-comm').textContent = '$' + r.stats.totalCommission.toFixed(2);
      $('sv-vids').textContent = r.stats.totalVideos;
    });
  }

  function loadVideos(){
    api('GET', '/videos').then(function(r){
      if(!r.ok || !r.videos) return;
      var el = $('video-list');
      if(!r.videos.length){
        el.innerHTML = '<p class="empty-state">No videos submitted yet. Submit your first video above!</p>';
        return;
      }
      var html = '';
      for(var i=0; i<r.videos.length; i++){
        var v = r.videos[i];
        var badgeCls = v.status === 'approved' ? 'badge-approved' : v.status === 'rejected' ? 'badge-rejected' : 'badge-pending';
        html += '<div class="video-row">'
          + '<div><div class="video-title">' + esc(v.title) + '</div>'
          + '<div class="video-meta">' + esc(v.skus) + '</div></div>'
          + '<div style="text-align:right">'
          + '<span class="badge ' + badgeCls + '">' + esc(v.status) + '</span>'
          + '<div class="video-meta" style="margin-top:4px">'
          + v.views + ' views &middot; ' + v.orders + ' orders &middot; $' + v.commission.toFixed(2)
          + '</div></div></div>';
      }
      el.innerHTML = html;
    });
  }

  function esc(s){
    if(!s) return '';
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // ── Submit Video ─────────────────────────────────────
  window.oceSubmitVideo = function(e){
    e.preventDefault();
    hideErr('submit-err');
    var ok = $('submit-ok');
    ok.className = 'form-success';
    var btn = $('submit-btn');
    btn.disabled = true;
    btn.textContent = 'Submitting...';

    api('POST', '/submit-video', {
      title: $('vid-title').value.trim(),
      videoUrl: $('vid-url').value.trim(),
      skus: $('vid-skus').value.trim()
    }).then(function(r){
      btn.disabled = false;
      btn.textContent = 'Submit Video';
      if(r.error){
        showErr('submit-err', r.error);
        return;
      }
      $('vid-title').value = '';
      $('vid-url').value = '';
      $('vid-skus').value = '';
      showOk('submit-ok', 'Video submitted successfully! It will appear below once reviewed.');
      loadVideos();
      loadStats();
    }).catch(function(){
      btn.disabled = false;
      btn.textContent = 'Submit Video';
      showErr('submit-err', 'Network error. Please try again.');
    });
  };

  // ── Logout ───────────────────────────────────────────
  window.oceLogout = function(){
    token = null;
    localStorage.removeItem('oce_creator_token');
    localStorage.removeItem('oce_creator_name');
    showView('auth');
  };

  // ── Init ─────────────────────────────────────────────
  var savedToken = localStorage.getItem('oce_creator_token');
  if(savedToken){
    token = savedToken;
    api('GET', '/me').then(function(r){
      if(r.ok){
        showDashboard(r.creator.name);
      } else {
        localStorage.removeItem('oce_creator_token');
        localStorage.removeItem('oce_creator_name');
        showView('auth');
      }
    }).catch(function(){
      showView('auth');
    });
  } else {
    showView('auth');
  }
})();
</script>
{% endraw %}
`;
}
