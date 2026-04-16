/**
 * Shared Kalshi API client for Vercel serverless functions.
 * Uses Node.js native crypto for RSA-PSS signing — zero external deps.
 */
const crypto = require("crypto");
const https = require("https");

const KALSHI_API_KEY_ID = process.env.KALSHI_API_KEY_ID;
const KALSHI_PEM_KEY = process.env.KALSHI_PEM_KEY; // base64-encoded PEM
const KALSHI_BASE = "https://api.elections.kalshi.com";
const API_PREFIX = "/trade-api/v2";

function getPrivateKey() {
  if (!KALSHI_PEM_KEY) throw new Error("KALSHI_PEM_KEY not configured");
  return Buffer.from(KALSHI_PEM_KEY, "base64").toString("utf-8");
}

function sign(timestampMs, method, path) {
  const pathClean = path.split("?")[0];
  const message = `${timestampMs}${method}${pathClean}`;
  const privateKey = getPrivateKey();
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(message);
  // RSA-PSS with SHA256 and salt length = hash length (32 bytes)
  const signature = signer.sign(
    {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    },
    "base64"
  );
  return signature;
}

function headers(method, path) {
  const ts = Date.now().toString();
  const sig = sign(ts, method, path);
  return {
    "KALSHI-ACCESS-KEY": KALSHI_API_KEY_ID,
    "KALSHI-ACCESS-TIMESTAMP": ts,
    "KALSHI-ACCESS-SIGNATURE": sig,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const fullPath = `${API_PREFIX}${path}`;
    const url = new URL(`${KALSHI_BASE}${fullPath}`);
    const hdrs = headers(method, fullPath);
    const payload = body ? JSON.stringify(body) : null;
    if (payload) hdrs["Content-Length"] = Buffer.byteLength(payload);

    const opts = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method,
      headers: hdrs,
      timeout: 30000,
    };

    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`Kalshi ${res.statusCode}: ${JSON.stringify(json)}`));
          } else {
            resolve(json);
          }
        } catch {
          reject(new Error(`Kalshi ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    if (payload) req.write(payload);
    req.end();
  });
}

// Public API
async function getBalance() {
  const data = await request("GET", "/portfolio/balance");
  return (data.balance || 0) / 100; // cents → dollars
}

async function getPositions() {
  const data = await request("GET", "/portfolio/positions");
  return data.market_positions || [];
}

async function getMarket(ticker) {
  const data = await request("GET", `/markets/${ticker}`);
  return data.market || data;
}

async function placeOrder(body) {
  return request("POST", "/portfolio/orders", body);
}

// List markets with filter. Used by scanner to find weather / index brackets.
// opts: { event_ticker, series_ticker, status, limit, cursor }
async function listMarkets(opts = {}) {
  const params = new URLSearchParams();
  if (opts.event_ticker) params.set("event_ticker", opts.event_ticker);
  if (opts.series_ticker) params.set("series_ticker", opts.series_ticker);
  params.set("status", opts.status || "open");
  params.set("limit", String(opts.limit || 200));
  if (opts.cursor) params.set("cursor", opts.cursor);
  const data = await request("GET", `/markets?${params.toString()}`);
  return data;
}

async function listEvents(opts = {}) {
  const params = new URLSearchParams();
  if (opts.series_ticker) params.set("series_ticker", opts.series_ticker);
  params.set("status", opts.status || "open");
  params.set("limit", String(opts.limit || 200));
  if (opts.cursor) params.set("cursor", opts.cursor);
  const data = await request("GET", `/events?${params.toString()}`);
  return data;
}

// Search all markets across many pages. Safe for use inside a 30s serverless limit.
async function listAllMarkets(opts = {}, maxPages = 3) {
  let all = [];
  let cursor = null;
  for (let i = 0; i < maxPages; i++) {
    const page = await listMarkets({ ...opts, cursor });
    if (Array.isArray(page.markets)) all = all.concat(page.markets);
    cursor = page.cursor;
    if (!cursor) break;
  }
  return all;
}

module.exports = {
  getBalance,
  getPositions,
  getMarket,
  placeOrder,
  listMarkets,
  listEvents,
  listAllMarkets,
  request,
};
