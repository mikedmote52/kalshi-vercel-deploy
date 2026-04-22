/**
 * POST /api/approve — DISABLED 2026-04-22
 *
 * Order submission via this endpoint has been shut down. It previously placed
 * real Kalshi orders with no authentication, no daily cap, no dry-run gate, and
 * no local DB logging — a critical exposure identified during a 2026-04-22 audit.
 *
 * Approvals are now handled exclusively by the local approval server at
 * http://localhost:5050, which requires physical access to Mike's machine and
 * enforces: DRY_RUN_MODE gate, $50/day cap, type-to-confirm modal, and
 * pending-first DB write before any order is submitted.
 *
 * Do not re-enable this endpoint without: auth (shared secret header),
 * a dry-run gate, a daily cap, and DB write-back.
 */
module.exports = async function handler(req, res) {
  // Block all CORS so no browser dashboard can drive orders through here
  res.setHeader("Access-Control-Allow-Origin", "null");
  res.setHeader("Access-Control-Allow-Methods", "OPTIONS");

  if (req.method === "OPTIONS") return res.status(200).end();

  return res.status(503).json({
    error: "Order submission disabled. Use the local approval server at http://localhost:5050.",
    disabled_at: "2026-04-22",
    reason: "Unguarded remote order placement — no auth, no cap, no DB logging.",
    docs: "See SYSTEM_MAP_AND_IMPROVEMENTS.md §3.1 for context and re-enable requirements.",
  });
};
