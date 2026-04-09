/**
 * GET /api/balance — Fetch current Kalshi balance and position count.
 */
const { getBalance, getPositions } = require("./kalshi");

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

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
