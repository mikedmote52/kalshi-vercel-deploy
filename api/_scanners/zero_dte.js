/**
 * 0DTE scanner — S&P 500 and Nasdaq-100 end-of-day brackets.
 *
 * Method:
 *   1. Pull current index spot from Yahoo Finance (^GSPC, ^NDX).
 *   2. Pull VIX / VXN spot as implied vol.
 *   3. Compute remaining trading time in years.
 *   4. Build log-normal distribution around spot using VIX * sqrt(T).
 *   5. For each Kalshi bracket, compute close-price probability.
 *   6. Flag asymmetric mispricings (>=5% edge, 0.10–0.90 band).
 */
const https = require("https");
const { listAllMarkets } = require("../kalshi.js");

const USER_AGENT = "Mozilla/5.0 (compatible; kalshi-vercel-deploy/1.0)";

const INDICES = [
  {
    name: "S&P 500",
    kalshi_prefix: "KXINXD",       // S&P 500 daily close series (Kalshi ticker pattern)
    kalshi_alt: "KXSPYD",          // SPY variant as fallback
    yahoo: "%5EGSPC",
    vix: "%5EVIX",
  },
  {
    name: "Nasdaq 100",
    kalshi_prefix: "KXNDXD",
    kalshi_alt: "KXQQQD",
    yahoo: "%5ENDX",
    vix: "%5EVXN",
  },
];

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json,text/plain,*/*",
      },
      timeout: 8000,
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          if (res.statusCode >= 400) return reject(new Error(`${url} ${res.statusCode}`));
          resolve(JSON.parse(data));
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

// Yahoo Finance quote endpoint. Returns current regular market price.
async function getYahooQuote(symbol) {
  // v7 has strong rate limits, prefer v8 chart endpoint for single-symbol snapshot
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`;
  const data = await fetchJSON(url);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`no chart data for ${symbol}`);
  const price = result.meta?.regularMarketPrice ?? result.meta?.previousClose;
  if (!price) throw new Error(`no price for ${symbol}`);
  return { symbol, price, previous_close: result.meta?.previousClose };
}

function normalCDF(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  let p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

// Log-normal terminal price probability.
// Returns P(a <= S_T <= b) where S_T = S_0 * exp((-0.5 sigma^2) T + sigma sqrt(T) Z)
// (risk-neutral, zero drift approximation — fine for intraday 0DTE)
function logNormalRangeProb(S0, sigma, T, a, b) {
  if (T <= 0) return a <= S0 && S0 <= (b ?? Infinity) ? 1 : 0;
  const denom = sigma * Math.sqrt(T);
  const drift = -0.5 * sigma * sigma * T;
  const toZ = (x) => (Math.log(x / S0) - drift) / denom;
  const pLo = !a || a <= 0 ? 0 : normalCDF(toZ(a));
  const pHi = !b || b === Infinity ? 1 : normalCDF(toZ(b));
  return Math.max(0, Math.min(1, pHi - pLo));
}

// Hours remaining to 4pm ET close, expressed in years (252 trading days * 6.5h)
function yearsToClose(now = new Date()) {
  // 4pm ET = 20:00 UTC (EDT) or 21:00 UTC (EST). Use EDT approximation for April.
  const closeUTC = new Date(now);
  closeUTC.setUTCHours(20, 0, 0, 0);
  let hoursLeft = (closeUTC - now) / 3600000;
  if (hoursLeft <= 0) hoursLeft = 6.5; // tomorrow's full session
  return hoursLeft / (252 * 6.5);
}

// Parse Kalshi index bracket markets — "S&P 500 closes between X and Y"
function parseIndexBracket(market) {
  const t = (market.title || market.subtitle || market.yes_sub_title || "").toLowerCase();
  let m = t.match(/between\s+\$?([\d,]+(?:\.\d+)?)\s+and\s+\$?([\d,]+(?:\.\d+)?)/i);
  if (m) return { low: parseFloat(m[1].replace(/,/g, "")), high: parseFloat(m[2].replace(/,/g, "")), type: "range" };

  m = t.match(/(?:above|over|at\s+least|higher\s+than|more\s+than)\s+\$?([\d,]+(?:\.\d+)?)/i);
  if (m) return { low: parseFloat(m[1].replace(/,/g, "")), high: Infinity, type: "above" };

  m = t.match(/(?:below|under|less\s+than|lower\s+than)\s+\$?([\d,]+(?:\.\d+)?)/i);
  if (m) return { low: 0, high: parseFloat(m[1].replace(/,/g, "")), type: "below" };

  // "X to Y"
  m = t.match(/\$?([\d,]+(?:\.\d+)?)\s*(?:to|-|–|—)\s*\$?([\d,]+(?:\.\d+)?)/i);
  if (m) {
    const lo = parseFloat(m[1].replace(/,/g, ""));
    const hi = parseFloat(m[2].replace(/,/g, ""));
    if (hi > lo) return { low: lo, high: hi, type: "range" };
  }

  return null;
}

function kellyFraction(p, price) {
  if (price <= 0 || price >= 1) return 0;
  const b = (1 - price) / price;
  const q = 1 - p;
  const f = (b * p - q) / b;
  return Math.max(0, Math.min(0.1, f * 0.25));
}

async function scanIndex(idx) {
  let spot, vix;
  try {
    [spot, vix] = await Promise.all([getYahooQuote(idx.yahoo), getYahooQuote(idx.vix)]);
  } catch (e) {
    return { index: idx.name, error: `market data: ${e.message}`, opportunities: [] };
  }

  const S0 = spot.price;
  const sigmaAnnual = vix.price / 100;
  const T = yearsToClose();

  // Pull Kalshi bracket markets. Try primary series, fall back to alt.
  let markets = [];
  try {
    markets = await listAllMarkets({ series_ticker: idx.kalshi_prefix, status: "open" }, 2);
    if (markets.length === 0 && idx.kalshi_alt) {
      markets = await listAllMarkets({ series_ticker: idx.kalshi_alt, status: "open" }, 2);
    }
  } catch (e) {
    return { index: idx.name, spot: S0, vix: vix.price, error: `kalshi: ${e.message}`, opportunities: [] };
  }

  const opportunities = [];
  for (const m of markets) {
    const bracket = parseIndexBracket(m);
    if (!bracket) continue;

    const aiProb = logNormalRangeProb(S0, sigmaAnnual, T, bracket.low, bracket.high);
    const yesAsk = (m.yes_ask || 0) / 100;
    const yesBid = (m.yes_bid || 0) / 100;
    const mid = yesAsk > 0 && yesBid > 0 ? (yesAsk + yesBid) / 2 : yesAsk || yesBid;
    if (!mid || mid <= 0.02 || mid >= 0.98) continue;

    const edgeYes = aiProb - mid;
    if (Math.abs(edgeYes) < 0.05) continue;
    if (aiProb < 0.1 || aiProb > 0.9) continue;

    const side = edgeYes > 0 ? "yes" : "no";
    const sidePrice = side === "yes" ? yesAsk : (1 - yesBid);
    const sideProb = side === "yes" ? aiProb : (1 - aiProb);
    const edge = sideProb - sidePrice;
    const kelly = kellyFraction(sideProb, sidePrice);

    opportunities.push({
      ticker: m.ticker,
      title: m.title || m.subtitle || "",
      side,
      ai_prob: Number(sideProb.toFixed(3)),
      market_prob: Number(sidePrice.toFixed(3)),
      edge: Number(edge.toFixed(3)),
      confidence: "medium",
      source: "zero_dte_scanner",
      index: idx.name,
      spot: Number(S0.toFixed(2)),
      vix: Number(vix.price.toFixed(2)),
      T_years: Number(T.toFixed(5)),
      bracket_low: bracket.low,
      bracket_high: bracket.high === Infinity ? null : bracket.high,
      reasoning: `${idx.name} spot ${S0.toFixed(2)}, VIX ${vix.price.toFixed(2)}, ${(T*252*6.5).toFixed(2)}h to close. Log-normal prob close in [${bracket.low}, ${bracket.high}] = ${(aiProb*100).toFixed(1)}% vs market ${(mid*100).toFixed(1)}%.`,
      thesis: `VIX-implied log-normal distribution centered at spot places ${(sideProb*100).toFixed(1)}% probability on this outcome vs market ${(sidePrice*100).toFixed(1)}%.`,
      counter_thesis: `Log-normal fails to capture fat tails; real markets have crash risk and jump moves that underweight extreme brackets.`,
      red_team_flaw: `VIX is a 30-day variance measure, not 0DTE realized vol — intraday distributions are often thinner than VIX implies, reducing tail brackets' true probability.`,
      red_team_strength: "moderate",
      suggested_size: Math.max(1, Math.min(5, kelly * 40)).toFixed(2),
      related_count: 0,
    });
  }

  return {
    index: idx.name,
    spot: S0,
    vix: vix.price,
    T_years: T,
    markets_scanned: markets.length,
    opportunities,
  };
}

async function scanAll() {
  const results = await Promise.allSettled(INDICES.map(scanIndex));
  const all = [];
  const diagnostics = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      diagnostics.push({
        index: r.value.index,
        spot: r.value.spot || null,
        vix: r.value.vix || null,
        markets_scanned: r.value.markets_scanned || 0,
        error: r.value.error || null,
      });
      if (r.value.opportunities) all.push(...r.value.opportunities);
    } else {
      diagnostics.push({ error: r.reason?.message || String(r.reason) });
    }
  }
  return { opportunities: all, diagnostics };
}

module.exports = { scanAll, scanIndex, INDICES };
