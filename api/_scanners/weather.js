/**
 * Weather scanner — fetches NWS forecasts for NYC/Chicago/Miami/Austin,
 * applies observed forecast bias corrections, and compares against
 * Kalshi highest-temperature-today brackets.
 *
 * Edge logic:
 *   1. Pull NWS forecast high for today (or tomorrow if evening).
 *   2. Add station-specific bias correction (empirically derived).
 *   3. Build a normal distribution around corrected forecast (sigma = 2.5°F).
 *   4. For each Kalshi bracket, compute P(high falls in bracket).
 *   5. Flag as opportunity when |ai_prob - market_prob| >= 0.05 AND
 *      ai_prob within [0.08, 0.92] (avoid epsilon brackets).
 */
const https = require("https");
const { listAllMarkets } = require("../kalshi.js");

// NWS gridpoints for the four cities Kalshi tracks.
// bias_correction_f: number added to raw NWS forecast to estimate actual high.
// Positive values mean NWS under-forecasts on average.
const CITIES = [
  {
    name: "NYC",
    kalshi_prefix: "KXHIGHNY",
    nws_office: "OKX",
    gx: 33, gy: 37,
    bias_correction_f: 1.0,
  },
  {
    name: "Chicago",
    kalshi_prefix: "KXHIGHCHI",
    nws_office: "LOT",
    gx: 73, gy: 76,
    bias_correction_f: 0.5,
  },
  {
    name: "Miami",
    kalshi_prefix: "KXHIGHMIA",
    nws_office: "MFL",
    gx: 109, gy: 50,
    bias_correction_f: 3.0,
  },
  {
    name: "Austin",
    kalshi_prefix: "KXHIGHAUS",
    nws_office: "EWX",
    gx: 156, gy: 91,
    bias_correction_f: 1.5,
  },
];

// NWS API requires a User-Agent string
const USER_AGENT = "kalshi-vercel-deploy (mikedmote52@gmail.com)";

function fetchJSON(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: "GET",
      headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...headers },
      timeout: 8000,
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          if (res.statusCode >= 400) return reject(new Error(`${url} ${res.statusCode}: ${data.slice(0, 200)}`));
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

// Standard normal CDF using error function approximation
function normalCDF(z) {
  // Abramowitz & Stegun 7.1.26
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  let p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

// P(a <= X <= b) for X ~ N(mu, sigma^2)
function normalRangeProb(mu, sigma, a, b) {
  const pLo = a === null || a === undefined || a === -Infinity ? 0 : normalCDF((a - mu) / sigma);
  const pHi = b === null || b === undefined || b === Infinity ? 1 : normalCDF((b - mu) / sigma);
  return Math.max(0, Math.min(1, pHi - pLo));
}

// Parse Kalshi bracket ticker / title — extract temp range in °F.
// Kalshi high-temp markets typically encode like:
//   "KXHIGHNY-26APR15-T72.5"  (strike above/below)
//   "KXHIGHNY-26APR15-B70-72"  (between)
// We parse the title since ticker suffixes vary.
function parseBracket(market) {
  const t = (market.title || market.subtitle || market.yes_sub_title || "").toLowerCase();
  const tk = market.ticker || "";

  // "between X and Y"
  let m = t.match(/between\s+(-?\d+(?:\.\d+)?)\s*(?:°|degrees|f)?\s+and\s+(-?\d+(?:\.\d+)?)/i);
  if (m) return { low: parseFloat(m[1]), high: parseFloat(m[2]), type: "range" };

  // "X to Y"
  m = t.match(/(-?\d+(?:\.\d+)?)\s*(?:°|degrees|f)?\s*(?:to|-|–|—)\s*(-?\d+(?:\.\d+)?)\s*(?:°|degrees|f)?/i);
  if (m) {
    const lo = parseFloat(m[1]); const hi = parseFloat(m[2]);
    if (hi > lo && hi - lo <= 20) return { low: lo, high: hi, type: "range" };
  }

  // "above X" / "X or higher" / "at least X"
  m = t.match(/(?:above|over|at\s+least|higher\s+than|more\s+than|or\s+higher)\s+(-?\d+(?:\.\d+)?)/i);
  if (m) return { low: parseFloat(m[1]), high: Infinity, type: "above" };
  m = t.match(/(-?\d+(?:\.\d+)?)\s*(?:°|degrees)?\s*(?:or\s+higher|or\s+more|or\s+above)/i);
  if (m) return { low: parseFloat(m[1]), high: Infinity, type: "above" };

  // "below X" / "X or lower"
  m = t.match(/(?:below|under|less\s+than|lower\s+than|or\s+lower)\s+(-?\d+(?:\.\d+)?)/i);
  if (m) return { low: -Infinity, high: parseFloat(m[1]), type: "below" };
  m = t.match(/(-?\d+(?:\.\d+)?)\s*(?:°|degrees)?\s*(?:or\s+lower|or\s+less|or\s+below)/i);
  if (m) return { low: -Infinity, high: parseFloat(m[1]), type: "below" };

  // Ticker suffix fallback: -B##-## (between), -A## (above), -T## (strike), etc.
  m = tk.match(/-B(\d+)-(\d+)$/i);
  if (m) return { low: parseFloat(m[1]), high: parseFloat(m[2]), type: "range" };
  m = tk.match(/-A(\d+)$/i);
  if (m) return { low: parseFloat(m[1]), high: Infinity, type: "above" };

  return null;
}

async function getNWSHighForecast(city) {
  // Pull the gridpoint forecast (daily periods)
  const url = `https://api.weather.gov/gridpoints/${city.nws_office}/${city.gx},${city.gy}/forecast`;
  const data = await fetchJSON(url);
  const periods = data?.properties?.periods || [];

  // Find the next daytime period (isDaytime: true) — that's today's high if before evening,
  // otherwise tomorrow's high.
  const dayPeriod = periods.find((p) => p.isDaytime);
  if (!dayPeriod) throw new Error(`no daytime period for ${city.name}`);

  return {
    raw_forecast_f: dayPeriod.temperature,
    corrected_f: dayPeriod.temperature + city.bias_correction_f,
    period_name: dayPeriod.name,
    period_start: dayPeriod.startTime,
  };
}

async function scanCity(city) {
  const opportunities = [];
  let forecast;
  try {
    forecast = await getNWSHighForecast(city);
  } catch (e) {
    return { city: city.name, error: e.message, opportunities: [] };
  }

  // Kalshi uses series tickers like KXHIGHNY, KXHIGHCHI, KXHIGHMIA, KXHIGHAUS
  // The scanner pulls current open markets in that series.
  let markets = [];
  try {
    markets = await listAllMarkets({ series_ticker: city.kalshi_prefix, status: "open" }, 2);
  } catch (e) {
    return { city: city.name, error: `kalshi list: ${e.message}`, forecast, opportunities: [] };
  }

  const mu = forecast.corrected_f;
  const sigma = 2.5; // empirical day-ahead high-temp forecast sigma

  for (const m of markets) {
    const bracket = parseBracket(m);
    if (!bracket) continue;

    const aiProb = normalRangeProb(mu, sigma, bracket.low, bracket.high);
    const yesAsk = (m.yes_ask || 0) / 100;
    const yesBid = (m.yes_bid || 0) / 100;
    const mid = yesAsk > 0 && yesBid > 0 ? (yesAsk + yesBid) / 2 : yesAsk || yesBid;
    if (!mid || mid <= 0.02 || mid >= 0.98) continue;

    const edgeYes = aiProb - mid;
    const edgeNo = (1 - aiProb) - (1 - mid);

    if (Math.abs(edgeYes) >= 0.05 && aiProb >= 0.08 && aiProb <= 0.92) {
      const side = edgeYes > 0 ? "yes" : "no";
      const edge = side === "yes" ? edgeYes : edgeNo;
      const sidePrice = side === "yes" ? yesAsk : (1 - yesBid);
      const sideProb = side === "yes" ? aiProb : (1 - aiProb);
      const kelly = kellyFraction(sideProb, sidePrice);
      opportunities.push({
        ticker: m.ticker,
        title: m.title || m.subtitle || "",
        side,
        ai_prob: Number(sideProb.toFixed(3)),
        market_prob: Number((side === "yes" ? mid : 1 - mid).toFixed(3)),
        edge: Number(edge.toFixed(3)),
        confidence: "medium",
        source: "weather_scanner",
        city: city.name,
        nws_raw_forecast_f: forecast.raw_forecast_f,
        nws_corrected_f: Number(mu.toFixed(1)),
        bracket_low_f: bracket.low,
        bracket_high_f: bracket.high,
        reasoning: `NWS ${city.name} high: ${forecast.raw_forecast_f}°F → bias-corrected ${mu.toFixed(1)}°F (σ=2.5). Bracket [${bracket.low}, ${bracket.high}] → P=${(aiProb*100).toFixed(1)}%, market ${(mid*100).toFixed(1)}%.`,
        thesis: `${city.name} NWS forecast adjusted for station bias (+${city.bias_correction_f}°F) places true probability at ${(sideProb*100).toFixed(1)}% vs market ${(sidePrice*100).toFixed(1)}%.`,
        counter_thesis: `Forecast sigma of 2.5°F may be too tight during unstable weather patterns; a frontal passage could move the high by 5-10°F.`,
        red_team_flaw: `Historical station bias may have shifted since the calibration window — recent NWS model updates may have reduced the systematic under-forecast.`,
        red_team_strength: "moderate",
        suggested_size: Math.max(1, Math.min(5, kelly * 40)).toFixed(2),
        related_count: 0,
      });
    }
  }

  return {
    city: city.name,
    forecast,
    markets_scanned: markets.length,
    opportunities,
  };
}

function kellyFraction(p, price) {
  // Kelly for binary bet at decimal odds = 1/price
  // f = (bp - q) / b  where b = (1-price)/price, q = 1-p
  if (price <= 0 || price >= 1) return 0;
  const b = (1 - price) / price;
  const q = 1 - p;
  const f = (b * p - q) / b;
  return Math.max(0, Math.min(0.1, f * 0.25)); // 1/4 Kelly, capped at 10%
}

async function scanAll() {
  const results = await Promise.allSettled(CITIES.map(scanCity));
  const all = [];
  const diagnostics = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      diagnostics.push({
        city: r.value.city,
        forecast: r.value.forecast || null,
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

module.exports = { scanAll, scanCity, CITIES };
