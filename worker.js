
const CONFIG = {
  initialBalance: 1000,
  tradeAmount: 100,

  // Risk and profit targets
  stopLossPct: 0.005,
  takeProfitPct: 0.012,

  // Protect gains after price moves in our favor
  breakEvenTriggerPct: 0.0045,
  trailingStartPct: 0.006,
  trailingDistancePct: 0.002,
  breakEvenBufferPct: 0.001,

  feePct: 0.001,

  // A wider spread permits more tests but increases trading costs.
  maxSpreadPct: 0.0035,

  minTrendStrengthPct: 0.0003,
  cooldownMinutesAfterLoss: 5,

  // Exit early only after a minimum hold and bearish confirmation.
  earlyExitMinHoldMinutes: 3,
  earlyExitNetLossPct: 0.20,

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
  const response = await fetch(
    "https://apiv2.nobitex.ir/v3/orderbook/BTCIRT",
    { headers: { accept: "application/json" } }
  );

  if (!response.ok) {
    throw new Error(`Nobitex request failed (${response.status})`);
  }

  const data = await response.json();
  const bid = Number(data.bids?.[0]?.[0]);
  const ask = Number(data.asks?.[0]?.[0]);

  if (!(bid > 0 && ask > 0) || ask < bid) {
    throw new Error("Invalid BTC/IRT order book");
  }

  const price = (bid + ask) / 2;

  return {
    bid,
    ask,
    price,
    spreadPct: (ask - bid) / price
  };
}

function average(values, period) {
  if (values.length < period) return null;

  const sample = values.slice(-period);

  return sample.reduce((sum, value) => sum + value, 0) /
    period;
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
  const saved = await kv.get(KEY, "json");
  const state = saved || initialState();

  if (!Array.isArray(state.prices)) state.prices = [];
  if (!Array.isArray(state.trades)) state.trades = [];

  if (
    typeof state.balance !== "number" ||
    !Number.isFinite(state.balance)
  ) {
    state.balance = CONFIG.initialBalance;
  }

  if (!("position" in state)) state.position = null;
  if (!("lastLossAt" in state)) state.lastLossAt = null;
  if (!("lastUpdate" in state)) state.lastUpdate = null;
  if (!("lastError" in state)) state.lastError = null;
  if (!("lastMarket" in state)) state.lastMarket = null;

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
  const fees = entryFee + exitFee;
  const net = gross - fees;
  const notional = entry * quantity;

  return {
    gross,
    fees,
    net,
    netPct: notional > 0 ? net / notional * 100 : 0
  };
}

function feeAwareBreakEven(entry) {
  return entry *
    ((1 + CONFIG.feePct) / (1 - CONFIG.feePct)) *
    (1 + CONFIG.breakEvenBufferPct);
}

function getRiskInfo(position) {
  if (!position) return null;

  const entry = Number(position.entry);

  return {
    emergencyStop: entry * (1 - CONFIG.stopLossPct),
    breakEvenStop: feeAwareBreakEven(entry),
    breakEvenTriggerPct: CONFIG.breakEvenTriggerPct,
    trailingStartPct: CONFIG.trailingStartPct,
    trailingDistancePct: CONFIG.trailingDistancePct,
    takeProfit: entry * (1 + CONFIG.takeProfitPct)
  };
}

function isInCooldown(state, nowMs) {
  if (!state.lastLossAt) return false;

  const lastLossMs = Date.parse(state.lastLossAt);
  if (!Number.isFinite(lastLossMs)) return false;

  return nowMs - lastLossMs <
    CONFIG.cooldownMinutesAfterLoss * 60 * 1000;
}

function hasBearishConfirmation(prices) {
  if (prices.length < 20) return false;

  const fast = average(prices, 5);
  const slow = average(prices, 20);
  const recent = prices.slice(-5);

  if (
    fast === null ||
    slow === null ||
    recent.length < 5
  ) {
    return false;
  }

  // Require both a bearish average relationship and
  // a recent downward move instead of reacting to one tick.
  const bearishTrend = fast < slow;
  const priceBelowSlow = prices[prices.length - 1] < slow;
  const downwardMomentum = recent[4] < recent[0];

  return bearishTrend && priceBelowSlow && downwardMomentum;
}

async function tick(kv) {
  if (
    !kv ||
    typeof kv.get !== "function" ||
    typeof kv.put !== "function"
  ) {
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
  state.prices = state.prices.slice(-CONFIG.maxPrices);
  state.lastMarket = { ...market, time: nowIso };

  let closedTrade = null;
  let openedTrade = false;
  let entryBlockReason = null;

  if (state.position) {
    const pos = state.position;

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

    // Move the protective stop above fee-aware break-even.
    if (highProfit >= CONFIG.breakEvenTriggerPct) {
      pos.trailingStop = Math.max(
        pos.trailingStop,
        feeAwareBreakEven(pos.entry)
      );
      pos.breakEvenProtected = true;
    }

    // Trail upward as the market makes new highs.
    // The stop is never lowered.
    if (highProfit >= CONFIG.trailingStartPct) {
      pos.trailingActive = true;
      pos.trailingStop = Math.max(
        pos.trailingStop,
        pos.highest * (1 - CONFIG.trailingDistancePct)
      );
    }

    const resultAtBid = estimateNet(pos, market.bid);
    const heldMs = Date.parse(nowIso) -
      Date.parse(pos.openedAt || nowIso);

    const minimumHoldPassed =
      Number.isFinite(heldMs) &&
      heldMs >= CONFIG.earlyExitMinHoldMinutes * 60 * 1000;

    const bearishConfirmed =
      hasBearishConfirmation(state.prices);

    let reason = null;

    // Emergency protection takes priority.
    if (
      market.bid <=
      pos.entry * (1 - CONFIG.stopLossPct)
    ) {
      reason = "EMERGENCY_STOP_LOSS";
    } else if (
      market.bid >=
      pos.entry * (1 + CONFIG.takeProfitPct)
    ) {
      reason = "TAKE_PROFIT";
    } else if (
      pos.trailingStop > 0 &&
      market.bid <= pos.trailingStop
    ) {
      reason = pos.trailingActive
        ? "TRAILING_STOP"
        : "BREAK_EVEN_STOP";
    } else if (
      minimumHoldPassed &&
      bearishConfirmed &&
      resultAtBid &&
      resultAtBid.netPct <= -CONFIG.earlyExitNetLossPct
    ) {
      // Close only when the bearish trend is confirmed
      // and estimated net loss has crossed the configured threshold.
      reason = "EARLY_BEARISH_EXIT";
    }

    if (reason) {
      const exitPrice = market.bid;
      const result = estimateNet(pos, exitPrice);
      const exitFee =
        exitPrice * pos.quantity * CONFIG.feePct;

      state.balance +=
        exitPrice * pos.quantity - exitFee;

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
      state.trades = state.trades.slice(-CONFIG.maxTrades);

      if (result.net < 0) {
        state.lastLossAt = nowIso;
      }

      state.position = null;
    }
  } else {
    if (
      state.prices.length < 21 ||
      previousPrices.length < 20
    ) {
      entryBlockReason = "COLLECTING_PRICE_SAMPLES";
    } else if (isInCooldown(state, nowMs)) {
      entryBlockReason = "COOLDOWN_AFTER_LOSS";
    } else if (market.spreadPct > CONFIG.maxSpreadPct) {
      entryBlockReason = "SPREAD_TOO_HIGH";
    } else {
      const previousFast = average(previousPrices, 5);
      const previousSlow = average(previousPrices, 20);
      const currentFast = average(state.prices, 5);
      const currentSlow = average(state.prices, 20);

      const crossedUp =
        previousFast !== null &&
        previousSlow !== null &&
        currentFast !== null &&
        currentSlow !== null &&
        previousFast <= previousSlow &&
        currentFast > currentSlow;

      const trendStrength = currentSlow > 0
        ? (currentFast - currentSlow) / currentSlow
        : 0;

      const recent = state.prices.slice(-6);
      const momentumUp =
        recent.length === 6 &&
        recent[5] > recent[0];

      if (!crossedUp) {
        entryBlockReason = "NO_FRESH_UPWARD_CROSSOVER";
      } else if (
        trendStrength < CONFIG.minTrendStrengthPct ||
        !momentumUp ||
        market.price <= currentSlow
      ) {
        entryBlockReason = "TREND_NOT_CONFIRMED";
      } else {
        const cost = CONFIG.tradeAmount;
        const entryFee = cost * CONFIG.feePct;

        if (state.balance < cost + entryFee) {
          entryBlockReason = "INSUFFICIENT_BALANCE";
        } else {
          const entryPrice = market.ask;
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
        }
      }
    }
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
        note:
          "Paper trading only. No real orders or wallet connection."
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
        error:
          "Configure the BOT_STATE KV binding in Cloudflare."
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

    return json({ ok: false, error: "Not found" }, 404);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        if (!env.BOT_STATE) {
          throw new Error("BOT_STATE binding is missing.");
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
