/**
 * GitHub Actions entry point.
 * Runs the three scanners, fetches balance + positions + fill history,
 * merges with the existing public/dashboard_data.json, and writes the
 * result back to disk so the next commit publishes fresh data to Pages.
 *
 * Env required:
 *   KALSHI_API_KEY_ID
 *   KALSHI_PEM_KEY   (base64-encoded PEM)
 */
const fs = require("fs");
const path = require("path");

const weather = require("../api/_scanners/weather.js");
const zeroDTE = require("../api/_scanners/zero_dte.js");
const econ = require("../api/_scanners/econ_calendar.js");
const { getBalance, getPositions, getMarket, request } = require("../api/kalshi.js");

async function enrichPositions(positions) {
  return Promise.all(
    positions.map(async (pos) => {
      let market = null;
      try {
        market = await getMarket(pos.ticker);
      } catch (e) {
        console.error(`market fetch failed for ${pos.ticker}:`, e.message);
      }

      const rawPos = parseFloat(pos.position_fp || pos.position || 0);
      const contracts = Math.abs(rawPos);
      const side = rawPos > 0 ? "yes" : rawPos < 0 ? "no" : "";
      const totalTraded = parseFloat(pos.total_traded_dollars || 0);
      const realizedPnl = parseFloat(pos.realized_pnl_dollars || 0);

      let currentYes = null;
      let currentNo = null;
      let title = pos.ticker;
      if (market) {
        const y = parseFloat(
          market.last_price_dollars ||
            market.yes_ask_dollars ||
            market.yes_bid_dollars ||
            0
        );
        currentYes = y || null;
        currentNo = y ? 1 - y : null;
        title = market.title || market.subtitle || pos.ticker;
      }

      const priceCents = contracts > 0 ? Math.round((totalTraded / contracts) * 100) : 0;
      const currentPrice = side === "yes" ? currentYes : side === "no" ? currentNo : null;
      const currentValue = currentPrice !== null ? contracts * currentPrice : null;
      const unrealized = currentValue !== null ? currentValue - totalTraded : null;

      return {
        ticker: pos.ticker,
        title,
        side,
        contracts,
        price_cents: priceCents,
        cost_dollars: totalTraded,
        current_price_cents: currentPrice !== null ? Math.round(currentPrice * 100) : 0,
        unrealized_pnl: unrealized,
        realized_pnl: realizedPnl,
      };
    })
  );
}

async function getFills(limit = 50) {
  try {
    const data = await request("GET", `/portfolio/fills?limit=${limit}`);
    return data.fills || [];
  } catch (e) {
    console.error("fills fetch failed:", e.message);
    return [];
  }
}

function mapFillToHistory(f) {
  const priceCents = f.yes_price || 0;
  const count = f.count || 0;
  return {
    trade_date: (f.created_time || "").split("T")[0] || "",
    ticker: f.ticker,
    title: f.ticker,
    side: f.side,
    contracts: count,
    price_cents: priceCents,
    cost_dollars: (count * priceCents) / 100,
    status: "open",
    resolution: null,
    pnl_dollars: 0,
  };
}

async function main() {
  const t0 = Date.now();
  const generated_at = new Date().toISOString();
  console.log("=== Kalshi scan start", generated_at);

  const [wRes, zRes, eRes] = await Promise.allSettled([
    weather.scanAll(),
    zeroDTE.scanAll(),
    econ.scanAll(3),
  ]);

  const opportunities = [];
  const diagnostics = {};

  if (wRes.status === "fulfilled") {
    opportunities.push(...wRes.value.opportunities);
    diagnostics.weather = wRes.value.diagnostics;
  } else {
    diagnostics.weather_error = wRes.reason?.message || String(wRes.reason);
  }
  if (zRes.status === "fulfilled") {
    opportunities.push(...zRes.value.opportunities);
    diagnostics.zero_dte = zRes.value.diagnostics;
  } else {
    diagnostics.zero_dte_error = zRes.reason?.message || String(zRes.reason);
  }
  if (eRes.status === "fulfilled") {
    opportunities.push(...eRes.value.opportunities);
    diagnostics.econ_calendar = eRes.value.diagnostics;
  } else {
    diagnostics.econ_calendar_error = eRes.reason?.message || String(eRes.reason);
  }

  opportunities.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));
  console.log(`scanners done: ${opportunities.length} opportunities`);

  let balance = null;
  let rawPositions = [];
  let fills = [];
  try {
    [balance, rawPositions, fills] = await Promise.all([
      getBalance(),
      getPositions(),
      getFills(50),
    ]);
  } catch (e) {
    console.error("account fetch failed:", e.message);
  }
  const positionDetails = await enrichPositions(rawPositions);
  console.log(`account: balance $${balance}, ${positionDetails.length} positions, ${fills.length} fills`);

  const outPath = path.join("public", "dashboard_data.json");
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(outPath, "utf-8"));
  } catch (_) {
    /* first run */
  }

  const existingByTicker = new Map(
    (existing.position_details || []).map((p) => [p.ticker, p])
  );
  const mergedPositions = positionDetails.map((p) => {
    const prev = existingByTicker.get(p.ticker) || {};
    return {
      ai_probability: prev.ai_probability,
      market_probability: prev.market_probability,
      edge: prev.edge,
      thesis: prev.thesis,
      ...p,
    };
  });

  const history =
    fills.length > 0
      ? fills.map(mapFillToHistory)
      : existing.trade_history || [];

  const payload = {
    generated_at,
    balance: balance !== null ? balance : existing.balance,
    total_pnl: existing.total_pnl || 0,
    positions: mergedPositions.length,
    position_details: mergedPositions,
    latest_scan: {
      timestamp: generated_at,
      markets_pulled:
        (diagnostics.weather || []).reduce((s, d) => s + (d.markets_scanned || 0), 0) +
        (diagnostics.zero_dte || []).reduce((s, d) => s + (d.markets_scanned || 0), 0),
      markets_analyzed:
        (diagnostics.weather || []).reduce((s, d) => s + (d.markets_scanned || 0), 0) +
        (diagnostics.zero_dte || []).reduce((s, d) => s + (d.markets_scanned || 0), 0),
      opportunities_found: opportunities.length,
      trades_placed: 0,
    },
    opportunities,
    trade_history: history,
    performance: existing.performance || null,
    elapsed_ms: Date.now() - t0,
    diagnostics,
  };

  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  fs.writeFileSync(
    path.join("public", "heartbeat.json"),
    JSON.stringify({ started_at: new Date(t0).toISOString(), exported_at: generated_at }, null, 2)
  );

  console.log(`=== Kalshi scan done (${Date.now() - t0}ms) — wrote ${outPath}`);
}

main().catch((e) => {
  console.error("scan failed:", e);
  process.exit(1);
});
