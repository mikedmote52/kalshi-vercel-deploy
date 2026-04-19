/**
 * POST /api/approve — Execute a trade on Kalshi.
 * Body: { ticker, side, amount, add_to_position? }
 * Set add_to_position: true to increase an existing position.
 */
const { getBalance, getPositions, getMarket, placeOrder } = require("./kalshi");

const MAX_PER_POSITION = 500;

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { ticker, side, amount, add_to_position } = req.body || {};
    if (!ticker || !side || !amount || amount <= 0) {
      return res.status(400).json({ success: false, error: "Missing ticker, side, or amount" });
    }

    // Sanity checks
    const balance = await getBalance();
    if (balance < 1) {
      return res.status(400).json({ success: false, error: "Insufficient balance", balance });
    }

    const positions = await getPositions();
    const heldTickers = new Set(positions.map((p) => p.ticker || ""));
    const alreadyHeld = heldTickers.has(ticker);


    if (alreadyHeld && !add_to_position) {
      return res.status(400).json({ success: false, error: `Already have position in ${ticker}. Use add_to_position to increase.` });
    }

    // Check total exposure for this ticker if adding
    if (alreadyHeld) {
      const existing = positions.find(p => p.ticker === ticker);
      const existingCost = parseFloat(existing?.total_traded_dollars || 0);
      if (existingCost + amount > MAX_PER_POSITION) {
        return res.status(400).json({
          success: false,
          error: `Adding $${amount} would exceed $${MAX_PER_POSITION} max per position (current: $${existingCost.toFixed(2)})`,
        });
      }
    }

    if (amount > MAX_PER_POSITION) {
      return res.status(400).json({ success: false, error: `Amount $${amount} exceeds max $${MAX_PER_POSITION}` });
    }

    if (amount > balance) {
      return res.status(400).json({ success: false, error: `Amount $${amount} exceeds balance $${balance.toFixed(2)}` });
    }

    // Get current market price
    const market = await getMarket(ticker);
    if (!market) {
      return res.status(400).json({ success: false, error: `Could not fetch market data for ${ticker}` });
    }

    let priceCents, yesPriceCents;
    if (side === "yes") {
      const askD = parseFloat(market.yes_ask_dollars || market.last_price_dollars || 0);
      priceCents = Math.round(askD * 100) || 50;
      yesPriceCents = priceCents;
    } else {
      let askD = parseFloat(market.no_ask_dollars || 0);
      if (!askD) {
        const yesAskD = parseFloat(market.yes_ask_dollars || market.last_price_dollars || 0);
        askD = yesAskD ? 1.0 - yesAskD : 0.5;
      }
      priceCents = Math.round(askD * 100) || 50;
      yesPriceCents = 100 - priceCents;
    }

    if (priceCents <= 0 || priceCents >= 100) {
      return res.status(400).json({ success: false, error: `Invalid price: ${priceCents}c` });
    }

    const contracts = Math.max(1, Math.floor(amount / (priceCents / 100)));
    const actualCost = contracts * priceCents / 100;

    console.log(`EXECUTING: ${side.toUpperCase()} ${ticker} x${contracts} @ ${priceCents}c ($${actualCost.toFixed(2)})`);

    // Place limit order at the ask so it fills immediately
    const body = {
      ticker,
      action: "buy",
      side,
      count: contracts,
      type: "limit",
      yes_price: yesPriceCents,
    };

    const result = await placeOrder(body);
    const order = result.order || {};
    const orderId = order.order_id || "unknown";
    const status = order.status || "unknown";
    const filled = parseFloat(order.fill_count_fp || 0);
    const fees = parseFloat(order.taker_fees_dollars || 0);

    if (status !== "executed" || filled < 1) {
      return res.status(400).json({
        success: false,
        error: `Order not filled: status=${status}, filled=${filled}. May be resting.`,
        order_id: orderId,
      });
    }

    const totalCost = parseFloat(order.taker_fill_cost_dollars || actualCost) + fees;

    console.log(`ORDER EXECUTED: ${orderId} (filled=${filled}, cost=$${totalCost.toFixed(2)}, fees=$${fees.toFixed(3)})`);

    return res.status(200).json({
      success: true,
      order_id: orderId,
      ticker,
      side,
      contracts: Math.round(filled),
      price_cents: priceCents,
      cost_dollars: totalCost,
      balance_after: balance - totalCost,
    });
  } catch (err) {
    console.error("Approve error:", err);
    return res.status(500).json({ success: false, error: err.message || "Internal error" });
  }
};
