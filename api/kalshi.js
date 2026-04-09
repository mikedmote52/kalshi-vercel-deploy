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

module.exports = { getBalance, getPositions, getMarket, placeOrder };
