const CONFIG = {
  initialBalance: 1000,
  tradeAmount: 100,
  stopLossPct: 0.01,
  takeProfitPct: 0.90,
  trailingStartPct: 0.008,
  trailingDistancePct: 0.005,
  feePct: 0.001,
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
  return error instanceof Error
    ? error.message
    : String(error);
}

async function getPrice() {
  const res = await fetch(
    "https://apiv2.nobitex.ir/v3/orderbook/BTCIRT",
    {
      headers: {
        accept: "application/json"
      }
    }
  );

  if (!res.ok) {
    throw new Error(
      `Nobitex price request failed (${res.status})`
    );
  }

  const data = await res.json();

  const bid = Number(data.bids?.[0]?.[0]);
  const ask = Number(data.asks?.[0]?.[0]);

  if (
    !(bid > 0 && ask > 0) ||
    ask < bid
  ) {
    throw new Error(
      "Invalid market price from Nobitex"
    );
  }

  return {
    price: (bid + ask) / 2,
    bid,
    ask
  };
}

function average(values, period) {
  const sample = values.slice(-period);

  if (sample.length < period) {
    return null;
  }

  return sample.reduce(
    (sum, value) => sum + value,
    0
  ) / sample.length;
}

function initialState() {
  return {
    balance: CONFIG.initialBalance,
    position: null,
    prices: [],
    trades: [],
    lastUpdate: null,
    lastError: null
  };
}

async function loadState(kv) {
  return (
    await kv.get(KEY, "json")
  ) || initialState();
}

async function saveState(kv, state) {
  await kv.put(
    KEY,
    JSON.stringify(state)
  );
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
  const price = market.price;
  const now = new Date().toISOString();

  if (!Array.isArray(state.prices)) {
    state.prices = [];
  }

  if (!Array.isArray(state.trades)) {
    state.trades = [];
  }

  state.prices.push(price);

  if (
    state.prices.length > CONFIG.maxPrices
  ) {
    state.prices.shift();
  }

  const pos = state.position;

  if (pos) {
    pos.highest = Math.max(
      Number(pos.highest || pos.entry),
      price
    );

    const profitRatio =
      (price - pos.entry) / pos.entry;

    if (
      profitRatio >= CONFIG.trailingStartPct
    ) {
      pos.trailingActive = true;

      pos.trailingStop = Math.max(
        Number(pos.trailingStop || 0),
        pos.highest *
          (1 - CONFIG.trailingDistancePct)
      );
    }

    let reason = null;

    if (
      price <=
      pos.entry * (1 - CONFIG.stopLossPct)
    ) {
      reason = "STOP_LOSS";
    } else if (
      price >=
      pos.entry * (1 + CONFIG.takeProfitPct)
    ) {
      reason = "TAKE_PROFIT";
    } else if (
      pos.trailingActive &&
      price <= pos.trailingStop
    ) {
      reason = "TRAILING_STOP";
    }

    if (reason) {
      const gross =
        (price - pos.entry) * pos.quantity;

      const entryFee =
        pos.entry *
        pos.quantity *
        CONFIG.feePct;

      const exitFee =
        price *
        pos.quantity *
        CONFIG.feePct;

      const net =
        gross - entryFee - exitFee;

      state.balance +=
        price *
        pos.quantity *
        (1 - CONFIG.feePct);

      state.trades.push({
        entry: pos.entry,
        exit: price,
        quantity: pos.quantity,
        grossProfit: gross,
        fees: entryFee + exitFee,
        netProfit: net,
        reason,
        openedAt: pos.openedAt,
        closedAt: now
      });

      if (
        state.trades.length > CONFIG.maxTrades
      ) {
        state.trades.shift();
      }

      state.position = null;
    }
  } else if (state.prices.length >= 21) {
    const previous =
      state.prices.slice(0, -1);

    const prevFast = average(previous, 5);
    const prevSlow = average(previous, 20);

    const currentFast =
      average(state.prices, 5);

    const currentSlow =
      average(state.prices, 20);

    const crossedUp =
      prevFast !== null &&
      prevSlow !== null &&
      currentFast !== null &&
      currentSlow !== null &&
      prevFast <= prevSlow &&
      currentFast > currentSlow;

    if (crossedUp) {
      const cost = CONFIG.tradeAmount;
      const fee = cost * CONFIG.feePct;

      if (state.balance >= cost + fee) {
        const quantity = cost / price;

        state.balance -= cost + fee;

        state.position = {
          entry: price,
          quantity,
          highest: price,
          trailingActive: false,
          trailingStop: 0,
          openedAt: now
        };
      }
    }
  }

  state.lastUpdate = now;
  state.lastError = null;

  await saveState(kv, state);

  return {
    ok: true,
    mode: "PAPER",
    symbol: "BTC/IRT",
    market,
    balance: state.balance,
    position: state.position,
    closedTrades: state.trades.length,
    lastTrade: state.trades.length
      ? state.trades[state.trades.length - 1]
      : null,
    lastUpdate: now
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
        takeProfitPct: CONFIG.takeProfitPct,
        stopLossPct: CONFIG.stopLossPct,
        endpoints: [
          "/status",
          "/price",
          "/tick"
        ],
        note:
          "Paper trading only. No real orders or wallet connection."
      });
    }

    if (url.pathname === "/price") {
      try {
        return json(await getPrice());
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
        const state =
          await loadState(env.BOT_STATE);

        return json({
          ok: true,
          mode: "PAPER",
          symbol: "BTC/IRT",
          balance: state.balance,
          position: state.position,
          trades: state.trades,
          lastUpdate: state.lastUpdate,
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
        return json(
          await tick(env.BOT_STATE)
        );
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
    ctx.waitUntil(
      (async () => {
        try {
          if (!env.BOT_STATE) {
            throw new Error(
              "BOT_STATE KV binding is missing."
            );
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
              const state =
                await loadState(env.BOT_STATE);

              state.lastError = message;

              await saveState(
                env.BOT_STATE,
                state
              );
            } catch (saveError) {
              console.error(
                "Could not save scheduled error:",
                errorMessage(saveError)
              );
            }
          }

          throw error;
        }
      })()
    );
  }
};
