/**
 * GET /api/balance — Fetch current Kalshi balance and position count.
 * Protected: set KALSHI_DASHBOARD_KEY in Vercel env vars.
 * Callers must send "Authorization: Bearer <key>" header.
 */
const { getBalance, getPositions } = require("./kalshi");

// Key guard — if KALSHI_DASHBOARD_KEY is set in Vercel env vars, enforce it.
const DASHBOARD_KEY = process.env.KALSHI_DASHBOARD_KEY;

module.exports = async function handler(req, res) {
  const origin = process.env.KALSHI_DASHBOARD_ORIGIN || "null";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (DASHBOARD_KEY) {
    const auth = (req.headers.authorization || "").trim();
    if (auth !== `Bearer ${DASHBOARD_KEY}`) {
      return res.status(401).json({ error: "Unauthorized — set Authorization: Bearer <KALSHI_DASHBOARD_KEY>" });
    }
  }

  try {
    const balance = await getBalance();
    const positions = await getPositions();
    return res.status(200).json({
      balance,
      positions: positions.length,
      position_details: positions.map((p) => ({
        ticker: p.ticker,
        position: p.position_fp,
        traded: p.total_traded_dollars,
      })),
    });
  } catch (err) {
    console.error("Balance error:", err);
    return res.status(500).json({ error: err.message || "Internal error" });
  }
};
