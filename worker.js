
const CONFIG = {
  initialBalance: 1000,
  tradeAmount: 100,

  // Risk controls — paper trading only
  stopLossPct: 0.005,
  takeProfitPct: 0.10,

  // Profit protection
  breakEvenTriggerPct: 0.0045,
  trailingStartPct: 0.006,
  trailingDistancePct: 0.002,
  feePct: 0.001,
  breakEvenBufferPct: 0.001,

  // Entry filters
  maxSpreadPct: 0.003,
  minTrendStrengthPct: 0.0003,
  entryCooldownMinutesAfterLoss: 5,

  maxPrices: 100,
  maxTrades: 100
};

const KEY = "crypto-paper-bot-fa-state";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function getPrice() {
  const res = await fetch(
    "https://apiv2.nobitex.ir/v3/orderbook/BTCIRT",
    { headers: { accept: "application/json" } }
  );

  if (!res.ok) {
    throw new Error(`Nobitex price request failed (${res.status})`);
  }

  const data = await res.json();
  const bid = Number(data.bids?.[0]?.[0]);
  const ask = Number(data.asks?.[0]?.[0]);

  if (!(bid > 0 && ask > 0) || ask < bid) {
    throw new Error("Invalid market price from Nobitex");
  }

  return {
    bid,
    ask,
    price: (bid + ask) / 2,
    spreadPct: (ask - bid) / ((ask + bid) / 2)
  };
}

function average(values, period) {
  const sample = values.slice(-period);
  if (sample.length < period) return null;

  return sample.reduce((sum, value) => sum + value, 0) /
    sample.length;
}

function initialState() {
  return {
    balance: CONFIG.initialBalance,
    position: null,
    prices: [],
    trades: [],
    lastUpdate: null,
    lastError: null,
    lastMarket: null,
    lastLossAt: null
  };
}

async function loadState(kv) {
  const state = (await kv.get(KEY, "json")) || initialState();

  // Preserve compatible data from previous versions.
  if (!Array.isArray(state.prices)) state.prices = [];
  if (!Array.isArray(state.trades)) state.trades = [];
  if (typeof state.balance !== "number") {
    state.balance = CONFIG.initialBalance;
  }
  if (!("position" in state)) state.position = null;
  if (!("lastLossAt" in state)) state.lastLossAt = null;

  return state;
}

async function saveState(kv, state) {
  await kv.put(KEY, JSON.stringify(state));
}

function estimateNet(position, exitPrice) {
  if (!position || !(exitPrice > 0)) return null;

  const entry = Number(position.entry);
  const quantity = Number(position.quantity);

  const gross = (exitPrice - entry) * quantity;
  const entryFee = entry * quantity * CONFIG.feePct;
  const exitFee = exitPrice * quantity * CONFIG.feePct;
  const net = gross - entryFee - exitFee;
  const notional = entry * quantity;

  return {
    gross,
    fees: entryFee + exitFee,
    net,
    netPct: notional > 0 ? (net / notional) * 100 : 0
  };
}

function getRiskInfo(position) {
  if (!position) return null;

  const entry = Number(position.entry);

  const breakEvenStop =
    entry *
    ((1 + CONFIG.feePct) / (1 - CONFIG.feePct)) *
    (1 + CONFIG.breakEvenBufferPct);

  return {
    emergencyStop: entry * (1 - CONFIG.stopLossPct),
    breakEvenStop,
    breakEvenTriggerPct: CONFIG.breakEvenTriggerPct,
    trailingStartPct: CONFIG.trailingStartPct,
    trailingDistancePct: CONFIG.trailingDistancePct,
    takeProfit: entry * (1 + CONFIG.takeProfitPct)
  };
}

function shouldPauseAfterLoss(state, nowMs) {
  if (!state.lastLossAt) return false;

  const lastLossMs = Date.parse(state.lastLossAt);
  if (!Number.isFinite(lastLossMs)) return false;

  return nowMs - lastLossMs <
    CONFIG.entryCooldownMinutesAfterLoss * 60 * 1000;
}

async function tick(kv) {
  if (!kv || typeof kv.get !== "function" ||
      typeof kv.put !== "function") {
    throw new Error(
      "Configure the BOT_STATE KV binding in Cloudflare."
    );
  }

  const state = await loadState(kv);
  const market = await getPrice();
  const now = new Date();
  const nowIso = now.toISOString();
  const nowMs = now.getTime();

  const previousPrices = [...state.prices];

  state.prices.push(market.price);

  if (state.prices.length > CONFIG.maxPrices) {
    state.prices = state.prices.slice(-CONFIG.maxPrices);
  }

  state.lastMarket = {
    ...market,
    time: nowIso
  };

  let closedTrade = null;
  let openedTrade = false;
  let entryBlockReason = null;

  const pos = state.position;

  if (pos) {
    // Compatibility with positions from earlier versions.
    pos.entry = Number(pos.entry);
    pos.quantity = Number(pos.quantity);
    pos.highest = Math.max(
      Number(pos.highest || pos.entry),
      market.bid
    );
    pos.trailingStop = Number(pos.trailingStop || 0);
    pos.trailingActive = Boolean(pos.trailingActive);
    pos.breakEvenProtected = Boolean(pos.breakEvenProtected);

    const highProfit =
      (pos.highest - pos.entry) / pos.entry;

    const prices = state.prices;
    const ma5 = average(prices, 5);
    const ma20 = average(prices, 20);

    // Look for several bearish signs before an early exit.
    const recent = prices.slice(-4);
    let fallingMoves = 0;

    for (let i = 1; i < recent.length; i++) {
      if (recent[i] < recent[i - 1]) fallingMoves++;
    }

    const bearishReversal =
      ma5 !== null &&
      ma20 !== null &&
      market.price < ma5 &&
      ma5 < ma20 &&
      fallingMoves >= 2;

    // Fee-aware break-even protection.
    const breakEvenStop =
      pos.entry *
      ((1 + CONFIG.feePct) / (1 - CONFIG.feePct)) *
      (1 + CONFIG.breakEvenBufferPct);

    if (highProfit >= CONFIG.breakEvenTriggerPct) {
      pos.trailingStop = Math.max(
        pos.trailingStop,
        breakEvenStop
      );

      pos.breakEvenProtected = true;
    }

    // Trail the highest observed BID once price has risen enough.
    if (highProfit >= CONFIG.trailingStartPct) {
      pos.trailingActive = true;

      pos.trailingStop = Math.max(
        pos.trailingStop,
        pos.highest * (1 - CONFIG.trailingDistancePct)
      );
    }

    let reason = null;

    if (market.bid <= pos.entry * (1 - CONFIG.stopLossPct)) {
      reason = "EMERGENCY_STOP_LOSS";
    } else if (
      market.bid >= pos.entry * (1 + CONFIG.takeProfitPct)
    ) {
      reason = "TAKE_PROFIT";
    } else if (
      pos.trailingStop > 0 &&
      market.bid <= pos.trailingStop
    ) {
      reason = pos.trailingActive
        ? "TRAILING_STOP"
        : "BREAK_EVEN_STOP";
    } else if (bearishReversal) {
      reason = "EARLY_TREND_REVERSAL";
    }

    if (reason) {
      const exitPrice = market.bid;
      const result = estimateNet(pos, exitPrice);
      const exitFee = exitPrice * pos.quantity * CONFIG.feePct;

      // Entry principal and entry fee were deducted at entry.
      state.balance += exitPrice * pos.quantity - exitFee;

      closedTrade = {
        entry: pos.entry,
        exit: exitPrice,
        quantity: pos.quantity,
        grossProfit: result.gross,
        fees: result.fees,
        netProfit: result.net,
        netProfitPct: result.netPct,
        reason,
        openedAt: pos.openedAt,
        closedAt: nowIso
      };

      state.trades.push(closedTrade);

      if (state.trades.length > CONFIG.maxTrades) {
        state.trades = state.trades.slice(-CONFIG.maxTrades);
      }

      if (result.net < 0) {
        state.lastLossAt = nowIso;
      }

      state.position = null;
    }
  } else if (state.prices.length >= 21) {
    const previousFast = average(previousPrices, 5);
    const previousSlow = average(previousPrices, 20);
    const currentFast = average(state.prices, 5);
    const currentSlow = average(state.prices, 20);

    // Require a fresh upward crossover.
    const crossedUp =
      previousFast !== null &&
      previousSlow !== null &&
      currentFast !== null &&
      currentSlow !== null &&
      previousFast <= previousSlow &&
      currentFast > currentSlow;

    const trendStrength =
      currentSlow > 0
        ? (currentFast - currentSlow) / currentSlow
        : 0;

    const momentumPrices = state.prices.slice(-6);

    const momentumUp =
      momentumPrices.length >= 6 &&
      momentumPrices[momentumPrices.length - 1] >
        momentumPrices[0];

    const spreadOk = market.spreadPct <= CONFIG.maxSpreadPct;
    const trendOk = trendStrength >= CONFIG.minTrendStrengthPct;
    const cooldown = shouldPauseAfterLoss(state, nowMs);

    if (cooldown) {
      entryBlockReason = "COOLDOWN_AFTER_LOSS";
    } else if (!spreadOk) {
      entryBlockReason = "SPREAD_TOO_HIGH";
    } else if (!crossedUp) {
      entryBlockReason = "NO_CONFIRMED_UPWARD_CROSSOVER";
    } else if (!trendOk || !momentumUp) {
      entryBlockReason = "TREND_OR_MOMENTUM_NOT_CONFIRMED";
    } else {
      // A long entry pays the ASK price.
      const entryPrice = market.ask;
      const cost = CONFIG.tradeAmount;
      const entryFee = cost * CONFIG.feePct;

      if (state.balance >= cost + entryFee) {
        const quantity = cost / entryPrice;

        state.balance -= cost + entryFee;

        state.position = {
          entry: entryPrice,
          quantity,
          highest: market.bid,
          trailingActive: false,
          trailingStop: 0,
          breakEvenProtected: false,
          openedAt: nowIso
        };

        openedTrade = true;
      } else {
        entryBlockReason = "INSUFFICIENT_BALANCE";
      }
    }
  } else {
    entryBlockReason = "COLLECTING_PRICE_SAMPLES";
  }

  state.lastUpdate = nowIso;
  state.lastError = null;

  await saveState(kv, state);

  return {
    ok: true,
    mode: "PAPER",
    symbol: "BTC/IRT",
    market,
    balance: state.balance,
    position: state.position,
    unrealized: state.position
      ? estimateNet(state.position, market.bid)
      : null,
    risk: getRiskInfo(state.position),
    openedTrade,
    closedTrade,
    closedTrades: state.trades.length,
    entryBlockReason,
    lastUpdate: nowIso
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return json({
        bot: "Crypto Paper Bot FA",
        status: "online",
        mode: "PAPER",
        symbol: "BTC/IRT",
        endpoints: ["/status", "/price", "/tick"],
        note: "Paper trading only. No real orders or wallet connection."
      });
    }

    if (url.pathname === "/price") {
      try {
        return json({
          ok: true,
          ...(await getPrice())
        });
      } catch (error) {
        return json({
          ok: false,
          error: errorMessage(error)
        }, 502);
      }
    }

    if (!env.BOT_STATE) {
      return json({
        ok: false,
        error: "Configure the BOT_STATE KV binding in Cloudflare."
      }, 500);
    }

    if (url.pathname === "/status") {
      try {
        const state = await loadState(env.BOT_STATE);
        const market = state.lastMarket || null;

        return json({
          ok: true,
          mode: "PAPER",
          symbol: "BTC/IRT",
          balance: state.balance,
          position: state.position,
          market,
          unrealized: state.position && market
            ? estimateNet(state.position, market.bid)
            : null,
          risk: getRiskInfo(state.position),
          trades: state.trades,
          lastUpdate: state.lastUpdate,
          lastLossAt: state.lastLossAt,
          lastError: state.lastError
        });
      } catch (error) {
        return json({
          ok: false,
          error: errorMessage(error)
        }, 500);
      }
    }

    if (url.pathname === "/tick") {
      try {
        return json(await tick(env.BOT_STATE));
      } catch (error) {
        return json({
          ok: false,
          error: errorMessage(error)
        }, 502);
      }
    }

    return json({
      ok: false,
      error: "Not found"
    }, 404);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        if (!env.BOT_STATE) {
          throw new Error("BOT_STATE KV binding is missing.");
        }

        await tick(env.BOT_STATE);
      } catch (error) {
        const message = errorMessage(error);

        console.error(
          "Scheduled paper-trading tick failed:",
          message
        );

        if (env.BOT_STATE) {
          try {
            const state = await loadState(env.BOT_STATE);
            state.lastError = message;
            await saveState(env.BOT_STATE, state);
          } catch (saveError) {
            console.error(
              "Could not save scheduled error:",
              errorMessage(saveError)
            );
          }
        }

        throw error;
      }
    })());
  }
};
