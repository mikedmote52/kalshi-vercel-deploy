/**
 * GET /api/positions — Fetch enriched position data with current market prices.
 * Returns each position with entry info, current price, P&L, and ROI.
 * Protected: set KALSHI_DASHBOARD_KEY in Vercel env vars.
 * Callers must send "Authorization: Bearer <key>" header.
 */
const { getBalance, getPositions, getMarket } = require("./kalshi");

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
    const [positions, balance] = await Promise.all([
      getPositions(),
      getBalance(),
    ]);

    // Enrich each position with current market data
    const enriched = await Promise.all(
      positions.map(async (pos) => {
        let market = null;
        try {
          market = await getMarket(pos.ticker);
        } catch (e) {
          console.error(`Failed to fetch market for ${pos.ticker}:`, e.message);
        }

        // Position fields from Kalshi API
        const contracts = Math.abs(
          parseFloat(pos.position_fp || pos.position || 0)
        );
        const side =
          parseFloat(pos.position_fp || pos.position || 0) > 0
            ? "yes"
            : parseFloat(pos.position_fp || pos.position || 0) < 0
            ? "no"
            : "none";
        const totalTraded = parseFloat(pos.total_traded_dollars || 0);
        const realizedPnl = parseFloat(pos.realized_pnl_dollars || 0);

        // Current market pricing
        let currentYesPrice = null;
        let currentNoPrice = null;
        let marketTitle = pos.ticker;
        let marketStatus = "unknown";
        let expirationDate = null;

        if (market) {
          currentYesPrice = parseFloat(
            market.last_price_dollars ||
              market.yes_ask_dollars ||
              market.yes_bid_dollars ||
              0
          );
          currentNoPrice = currentYesPrice ? 1 - currentYesPrice : null;
          marketTitle = market.title || market.subtitle || pos.ticker;
          marketStatus = market.status || "unknown";
          expirationDate = market.expiration_time || market.close_time || null;
        }

        // Calculate estimated entry price and P&L
        const entryPricePerContract =
          contracts > 0 ? totalTraded / contracts : 0;
        const currentPricePerContract =
          side === "yes"
            ? currentYesPrice
            : side === "no"
            ? currentNoPrice
            : 0;
        const currentValue =
          currentPricePerContract !== null
            ? contracts * currentPricePerContract
            : null;
        const unrealizedPnl =
          currentValue !== null ? currentValue - totalTraded : null;
        const roiPercent =
          totalTraded > 0 && unrealizedPnl !== null
            ? (unrealizedPnl / totalTraded) * 100
            : null;

        // Expected value based on AI model (if contract resolves in our favor)
        // If we hold YES contracts, payout is $1/contract if YES resolves
        // If we hold NO contracts, payout is $1/contract if NO resolves
        const maxPayout = contracts * 1.0; // $1 per contract
        const maxProfit = maxPayout - totalTraded;
        const maxLoss = -totalTraded; // lose entire investment

        return {
          ticker: pos.ticker,
          title: marketTitle,
          side,
          contracts,
          entry_cost: totalTraded,
          entry_price_cents: Math.round(entryPricePerContract * 100),
          current_price_cents:
            currentPricePerContract !== null
              ? Math.round(currentPricePerContract * 100)
              : null,
          current_value: currentValue,
          unrealized_pnl: unrealizedPnl,
          realized_pnl: realizedPnl,
          roi_percent: roiPercent,
          max_payout: maxPayout,
          max_profit: maxProfit,
          max_loss: maxLoss,
          market_status: marketStatus,
          expiration_date: expirationDate,
          // Raw market prices for display
          yes_price_cents: currentYesPrice
            ? Math.round(currentYesPrice * 100)
            : null,
          no_price_cents: currentNoPrice
            ? Math.round(currentNoPrice * 100)
            : null,
        };
      })
    );

    return res.status(200).json({
      balance,
      positions: enriched,
      fetched_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Positions error:", err);
    return res.status(500).json({ error: err.message || "Internal error" });
  }
};
