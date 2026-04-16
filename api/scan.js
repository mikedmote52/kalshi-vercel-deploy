/**
 * Unified scanner endpoint.
 * Runs weather + 0DTE + economic calendar modules in parallel and returns
 * opportunities keyed by source. The dashboard merges this with static
 * long-horizon opportunities from dashboard_data.json.
 *
 * GET /api/scan
 *   -> { generated_at, summary, opportunities: [...], diagnostics: {...} }
 */
const weather = require("./_scanners/weather.js");
const zeroDTE = require("./_scanners/zero_dte.js");
const econ = require("./_scanners/econ_calendar.js");

module.exports = async (req, res) => {
  const t0 = Date.now();
  try {
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

    // Sort by |edge| descending
    opportunities.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));

    const elapsed_ms = Date.now() - t0;
    const payload = {
      generated_at: new Date().toISOString(),
      elapsed_ms,
      summary: {
        total_opportunities: opportunities.length,
        weather: opportunities.filter((o) => o.source === "weather_scanner").length,
        zero_dte: opportunities.filter((o) => o.source === "zero_dte_scanner").length,
        econ_calendar: opportunities.filter((o) => o.source === "econ_calendar_scanner").length,
      },
      opportunities,
      diagnostics,
    };

    // Cache for 5 minutes on the edge, allow stale-while-revalidate for 10 min.
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    res.setHeader("Content-Type", "application/json");
    res.status(200).send(JSON.stringify(payload));
  } catch (e) {
    res.status(500).json({ error: e.message, generated_at: new Date().toISOString() });
  }
};
