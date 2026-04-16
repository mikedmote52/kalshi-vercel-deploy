/**
 * Economic calendar scanner — surfaces Kalshi markets resolving around
 * upcoming FOMC, CPI, NFP, PCE, and GDP releases within a 3-day lookahead window.
 *
 * These events produce predictable Kalshi series (FED-25MAY-T25, CPICORE-26APR-T3.0, etc.).
 * This module doesn't try to predict the print — it pulls markets with imminent resolution
 * so they surface in the opportunities feed when the release is within 3 days.
 */
const { listAllMarkets } = require("../kalshi.js");

// 2026 economic calendar. Update each year.
// Dates are ET / release date.
const CALENDAR_2026 = [
  // FOMC meetings
  { date: "2026-01-28", event: "FOMC", kind: "fomc", kalshi_series: ["KXFED", "FED"] },
  { date: "2026-03-18", event: "FOMC", kind: "fomc", kalshi_series: ["KXFED", "FED"] },
  { date: "2026-04-29", event: "FOMC", kind: "fomc", kalshi_series: ["KXFED", "FED"] },
  { date: "2026-06-17", event: "FOMC", kind: "fomc", kalshi_series: ["KXFED", "FED"] },
  { date: "2026-07-29", event: "FOMC", kind: "fomc", kalshi_series: ["KXFED", "FED"] },
  { date: "2026-09-16", event: "FOMC", kind: "fomc", kalshi_series: ["KXFED", "FED"] },
  { date: "2026-11-04", event: "FOMC", kind: "fomc", kalshi_series: ["KXFED", "FED"] },
  { date: "2026-12-16", event: "FOMC", kind: "fomc", kalshi_series: ["KXFED", "FED"] },
  // CPI (8:30am ET, typically 2nd week of month)
  { date: "2026-01-14", event: "CPI December 2025", kind: "cpi", kalshi_series: ["KXCPI", "CPIYOY", "CPICORE"] },
  { date: "2026-02-11", event: "CPI January 2026", kind: "cpi", kalshi_series: ["KXCPI", "CPIYOY", "CPICORE"] },
  { date: "2026-03-11", event: "CPI February 2026", kind: "cpi", kalshi_series: ["KXCPI", "CPIYOY", "CPICORE"] },
  { date: "2026-04-14", event: "CPI March 2026", kind: "cpi", kalshi_series: ["KXCPI", "CPIYOY", "CPICORE"] },
  { date: "2026-05-13", event: "CPI April 2026", kind: "cpi", kalshi_series: ["KXCPI", "CPIYOY", "CPICORE"] },
  { date: "2026-06-11", event: "CPI May 2026", kind: "cpi", kalshi_series: ["KXCPI", "CPIYOY", "CPICORE"] },
  { date: "2026-07-15", event: "CPI June 2026", kind: "cpi", kalshi_series: ["KXCPI", "CPIYOY", "CPICORE"] },
  { date: "2026-08-12", event: "CPI July 2026", kind: "cpi", kalshi_series: ["KXCPI", "CPIYOY", "CPICORE"] },
  { date: "2026-09-10", event: "CPI August 2026", kind: "cpi", kalshi_series: ["KXCPI", "CPIYOY", "CPICORE"] },
  { date: "2026-10-14", event: "CPI September 2026", kind: "cpi", kalshi_series: ["KXCPI", "CPIYOY", "CPICORE"] },
  { date: "2026-11-12", event: "CPI October 2026", kind: "cpi", kalshi_series: ["KXCPI", "CPIYOY", "CPICORE"] },
  { date: "2026-12-10", event: "CPI November 2026", kind: "cpi", kalshi_series: ["KXCPI", "CPIYOY", "CPICORE"] },
  // NFP (1st Friday each month)
  { date: "2026-01-02", event: "NFP December 2025", kind: "nfp", kalshi_series: ["KXNFP", "NFP"] },
  { date: "2026-02-06", event: "NFP January 2026", kind: "nfp", kalshi_series: ["KXNFP", "NFP"] },
  { date: "2026-03-06", event: "NFP February 2026", kind: "nfp", kalshi_series: ["KXNFP", "NFP"] },
  { date: "2026-04-03", event: "NFP March 2026", kind: "nfp", kalshi_series: ["KXNFP", "NFP"] },
  { date: "2026-05-01", event: "NFP April 2026", kind: "nfp", kalshi_series: ["KXNFP", "NFP"] },
  { date: "2026-06-05", event: "NFP May 2026", kind: "nfp", kalshi_series: ["KXNFP", "NFP"] },
  { date: "2026-07-02", event: "NFP June 2026", kind: "nfp", kalshi_series: ["KXNFP", "NFP"] },
  { date: "2026-08-07", event: "NFP July 2026", kind: "nfp", kalshi_series: ["KXNFP", "NFP"] },
  { date: "2026-09-04", event: "NFP August 2026", kind: "nfp", kalshi_series: ["KXNFP", "NFP"] },
  { date: "2026-10-02", event: "NFP September 2026", kind: "nfp", kalshi_series: ["KXNFP", "NFP"] },
  { date: "2026-11-06", event: "NFP October 2026", kind: "nfp", kalshi_series: ["KXNFP", "NFP"] },
  { date: "2026-12-04", event: "NFP November 2026", kind: "nfp", kalshi_series: ["KXNFP", "NFP"] },
  // PCE (last business day area)
  { date: "2026-01-30", event: "PCE December 2025", kind: "pce", kalshi_series: ["KXPCE", "PCE"] },
  { date: "2026-02-27", event: "PCE January 2026", kind: "pce", kalshi_series: ["KXPCE", "PCE"] },
  { date: "2026-03-27", event: "PCE February 2026", kind: "pce", kalshi_series: ["KXPCE", "PCE"] },
  { date: "2026-04-30", event: "PCE March 2026", kind: "pce", kalshi_series: ["KXPCE", "PCE"] },
  { date: "2026-05-29", event: "PCE April 2026", kind: "pce", kalshi_series: ["KXPCE", "PCE"] },
  { date: "2026-06-26", event: "PCE May 2026", kind: "pce", kalshi_series: ["KXPCE", "PCE"] },
];

function daysUntil(target, now = new Date()) {
  const t = new Date(target + "T13:30:00Z").getTime(); // ~8:30 ET
  const n = now.getTime();
  return (t - n) / (24 * 3600 * 1000);
}

function parseProbBracket(market) {
  const t = (market.title || market.subtitle || "").toLowerCase();
  // Attempt to extract numeric strike (e.g., "CPI YoY above 3.0%" or "Fed hike 25bps")
  let m = t.match(/(?:above|over|greater\s+than|at\s+least|or\s+higher)\s+(-?\d+(?:\.\d+)?)/i);
  if (m) return { threshold: parseFloat(m[1]), direction: "above" };
  m = t.match(/(?:below|under|less\s+than|or\s+lower)\s+(-?\d+(?:\.\d+)?)/i);
  if (m) return { threshold: parseFloat(m[1]), direction: "below" };
  m = t.match(/between\s+(-?\d+(?:\.\d+)?)\s+and\s+(-?\d+(?:\.\d+)?)/i);
  if (m) return { low: parseFloat(m[1]), high: parseFloat(m[2]), direction: "range" };
  return null;
}

async function findMarketsForEvent(evt) {
  const all = [];
  for (const series of evt.kalshi_series) {
    try {
      const page = await listAllMarkets({ series_ticker: series, status: "open" }, 1);
      all.push(...page);
    } catch (_) { /* ignore missing series */ }
  }
  return all;
}

async function scanAll(lookaheadDays = 3) {
  const now = new Date();
  const upcoming = CALENDAR_2026
    .map((e) => ({ ...e, days_until: daysUntil(e.date, now) }))
    .filter((e) => e.days_until >= -0.5 && e.days_until <= lookaheadDays)
    .sort((a, b) => a.days_until - b.days_until);

  const opportunities = [];
  const diagnostics = [];

  for (const evt of upcoming) {
    const markets = await findMarketsForEvent(evt);
    diagnostics.push({
      event: evt.event,
      date: evt.date,
      days_until: Number(evt.days_until.toFixed(2)),
      markets_found: markets.length,
    });

    // For each market, surface as an "awareness" opportunity so the user sees
    // upcoming resolutions. We don't predict the print — we flag high-|edge-vs-flat|
    // prices that look like sentiment overshoot.
    for (const m of markets) {
      const yesAsk = (m.yes_ask || 0) / 100;
      const yesBid = (m.yes_bid || 0) / 100;
      const mid = yesAsk > 0 && yesBid > 0 ? (yesAsk + yesBid) / 2 : yesAsk || yesBid;
      if (!mid) continue;

      // Only surface markets in the 0.10–0.90 zone (actionable, not degenerate)
      if (mid < 0.12 || mid > 0.88) continue;

      // Heuristic prior: assume 50/50 unless we have better signal. This creates
      // an opportunity in the dashboard asking the user to review heavy-sentiment markets.
      const aiProb = 0.5;
      const edgeYes = aiProb - mid;
      if (Math.abs(edgeYes) < 0.08) continue; // require meaningful sentiment skew

      const side = edgeYes > 0 ? "yes" : "no";
      const sideProb = side === "yes" ? aiProb : 1 - aiProb;
      const sidePrice = side === "yes" ? yesAsk : 1 - yesBid;
      const edge = sideProb - sidePrice;

      opportunities.push({
        ticker: m.ticker,
        title: m.title || m.subtitle || "",
        side,
        ai_prob: Number(sideProb.toFixed(3)),
        market_prob: Number(sidePrice.toFixed(3)),
        edge: Number(edge.toFixed(3)),
        confidence: "low",
        source: "econ_calendar_scanner",
        event: evt.event,
        event_date: evt.date,
        days_until: Number(evt.days_until.toFixed(2)),
        reasoning: `${evt.event} resolves in ${evt.days_until.toFixed(1)} days. Market prices ${side} at ${(sidePrice*100).toFixed(0)}% — sentiment skew vs 50/50 prior of ${Math.abs(edge*100).toFixed(0)}%. Review before release.`,
        thesis: `Pre-release sentiment overshoot creates a reversion opportunity. Flat prior at 50% vs market ${(sidePrice*100).toFixed(0)}% gives ${(edge*100).toFixed(0)}% theoretical edge if the flat prior is accurate.`,
        counter_thesis: `Market may be correctly pricing private information (leaked data, survey skew, regional Fed signals) that the flat prior ignores.`,
        red_team_flaw: `Flat 50/50 prior is naive — macro releases often have strong base rates (NFP beats ~55% of consensus, CPI prints within range ~60%, FOMC holds at long-term ~70%). A better model would use historical base rate for each event type.`,
        red_team_strength: "strong",
        suggested_size: 1.0,
        related_count: 0,
      });
    }
  }

  return { opportunities, diagnostics, lookahead_days: lookaheadDays };
}

module.exports = { scanAll, CALENDAR_2026 };
