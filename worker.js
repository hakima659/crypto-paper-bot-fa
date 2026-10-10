

const CONFIG = {
  initialBalance: 1000,
  tradeAmount: 100,
  stopLossPct: 0.01,
  takeProfitPct: 0.02,
  trailingStartPct: 0.008,
  trailingDistancePct: 0.005,
  feePct: 0.001
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

async function getPrice() {
  const res = await fetch(
    "https://apiv2.nobitex.ir/v3/orderbook/BTCIRT"
  );

  if (!res.ok) throw new Error("Nobitex price request failed");

  const data = await res.json();
  const bid = Number(data.bids?.[0]?.[0]);
  const ask = Number(data.asks?.[0]?.[0]);

  if (!(bid > 0 && ask > 0)) {
    throw new Error("Invalid market price");
  }

  return { price: (bid + ask) / 2, bid, ask };
}

function average(values, period) {
  const sample = values.slice(-period);
  return sample.reduce((sum, value) => sum + value, 0)
    / sample.length;
}

function initialState() {
  return {
    balance: CONFIG.initialBalance,
    position: null,
    prices: [],
    trades: [],
    lastUpdate: null
  };
}

async function loadState(kv) {
  return (await kv.get(KEY, "json")) || initialState();
}

async function tick(kv) {
  const state = await loadState(kv);
  const market = await getPrice();
  const price = market.price;
  const now = new Date().toISOString();

  state.prices.push(price);
  if (state.prices.length > 100) state.prices.shift();

  const pos = state.position;

  if (pos) {
    pos.highest = Math.max(pos.highest, price);

    if ((price - pos.entry) / pos.entry >= CONFIG.trailingStartPct) {
      pos.trailingActive = true;
      pos.trailingStop = Math.max(
        pos.trailingStop || 0,
        pos.highest * (1 - CONFIG.trailingDistancePct)
      );
    }

    let reason = null;

    if (price <= pos.entry * (1 - CONFIG.stopLossPct)) {
      reason = "STOP_LOSS";
    } else if (price >= pos.entry * (1 + CONFIG.takeProfitPct)) {
      reason = "TAKE_PROFIT";
    } else if (pos.trailingActive && price <= pos.trailingStop) {
      reason = "TRAILING_STOP";
    }

    if (reason) {
      const gross = (price - pos.entry) * pos.quantity;
      const fees = (pos.entry + price) * pos.quantity * CONFIG.feePct;
      const net = gross - fees;

      state.balance += pos.quantity * price * (1 - CONFIG.feePct);

      state.trades.push({
        entry: pos.entry,
        exit: price,
        quantity: pos.quantity,
        netProfit: net,
        reason,
        closedAt: now
      });

      if (state.trades.length > 100) state.trades.shift();
      state.position = null;
    }
  } else if (state.prices.length >= 20) {
    const previous = state.prices.slice(0, -1);

    const crossedUp =
      average(previous, 5) <= average(previous, 20) &&
      average(state.prices, 5) > average(state.prices, 20);

    if (crossedUp) {
      const cost = CONFIG.tradeAmount;
      const fee = cost * CONFIG.feePct;

      if (state.balance >= cost + fee) {
        state.balance -= cost + fee;

        state.position = {
          entry: price,
          quantity: cost / price,
          highest: price,
          trailingActive: false,
          trailingStop: 0,
          openedAt: now
        };
      }
    }
  }

  state.lastUpdate = now;
  await kv.put(KEY, JSON.stringify(state));

  return {
    ok: true,
    mode: "PAPER",
    symbol: "BTC/IRT",
    market,
    balance: state.balance,
    position: state.position,
    trades: state.trades.length,
    lastUpdate: now
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!env.BOT_STATE) {
      return json({
        ok: false,
        error: "Configure the BOT_STATE KV binding in Cloudflare."
      }, 500);
    }

    if (url.pathname === "/") {
      return json({
        bot: "Crypto Paper Bot FA",
        status: "online",
        mode: "PAPER",
        endpoints: ["/status", "/price", "/tick"],
        note: "Paper trading only. No real orders."
      });
    }

    if (url.pathname === "/price") {
      try {
        return json(await getPrice());
      } catch (error) {
        return json({ ok: false, error: error.message }, 502);
      }
    }

    if (url.pathname === "/status") {
      const state = await loadState(env.BOT_STATE);
      return json({
        mode: "PAPER",
        balance: state.balance,
        position: state.position,
        trades: state.trades,
        lastUpdate: state.lastUpdate
      });
    }

    if (url.pathname === "/tick") {
      try {
        return json(await tick(env.BOT_STATE));
      } catch (error) {
        return json({ ok: false, error: error.message }, 502);
      }
    }

    return json({ error: "Not found" }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env.BOT_STATE));
  }
};
