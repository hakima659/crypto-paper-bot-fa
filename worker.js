const CONFIG = {
  initialBalance: 1000,
  tradeAmount: 100,

  // اهداف سود و ضرر
  stopLossPct: 0.004,        // 0.4% (کاهش یافت - سریع‌تر بیرون بیا)
  takeProfitPct: 0.010,      // 1.0%

  // محافظت از سود
  breakEvenTriggerPct: 0.004,
  trailingStartPct: 0.006,
  trailingDistancePct: 0.0015,
  breakEvenBufferPct: 0.001,

  // محافظت از ضرر
  maxNetLossPct: 0.10,       // اگه ضرر خالص به 10% رسید، ببند
  softStopPct: 0.003,        // اگه قیمت 0.3% زیر ورود رفت، هوشیار باش
  earlyExitMinHoldMinutes: 2,
  earlyExitNetLossPct: 0.15,

  // ریسک کلی
  maxConsecutiveLosses: 3,   // بعد از 3 ضرر متوالی توقف
  cooldownMinutesAfterLoss: 5,
  maxDailyLoss: 50,          // حداکثر ضرر روزانه

  feePct: 0.001,
  maxSpreadPct: 0.0035,
  minTrendStrengthPct: 0.0003,

  maxPrices: 100,
  maxTrades: 200
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
  return sample.reduce((s, v) => s + v, 0) / period;
}

function initialState() {
  return {
    balance: CONFIG.initialBalance,
    peakBalance: CONFIG.initialBalance,
    position: null,
    prices: [],
    trades: [],
    lastUpdate: null,
    lastError: null,
    lastMarket: null,
    lastLossAt: null,
    consecutiveLosses: 0,
    dailyLoss: 0,
    dailyResetAt: new Date().toISOString().slice(0, 10),
    halted: false,
    haltReason: null
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

  const defaults = initialState();
  for (const k of Object.keys(defaults)) {
    if (!(k in state)) state[k] = defaults[k];
  }

  // ریست روزانه
  const today = new Date().toISOString().slice(0, 10);
  if (state.dailyResetAt !== today) {
    state.dailyLoss = 0;
    state.dailyResetAt = today;
    state.halted = false;
    state.haltReason = null;
  }

  return state;
}

async function saveState(kv, state) {
  await kv.put(KEY, JSON.stringify(state));
}

/**
 * محاسبه دقیق سود/ضرر خالص
 * ورود: ما cost را کم کردیم و quantity از (cost - entryFee) محاسبه شده
 */
function estimateNet(position, exitPrice) {
  if (!position || !(exitPrice > 0)) return null;

  const entry = Number(position.entry);
  const quantity = Number(position.quantity);
  const entryFee = Number(position.entryFee || 0);

  const grossExit = exitPrice * quantity;
  const exitFee = grossExit * CONFIG.feePct;
  const netExit = grossExit - exitFee;

  const totalInvested = entry * quantity + entryFee;
  const net = netExit - totalInvested;
  const netPct = totalInvested > 0
    ? (net / totalInvested) * 100
    : 0;

  return {
    grossExit,
    exitFee,
    net,
    netPct,
    totalInvested
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
  const worstCase = estimateNet(
    position,
    entry * (1 - CONFIG.stopLossPct)
  );

  return {
    emergencyStop: entry * (1 - CONFIG.stopLossPct),
    softStop: entry * (1 - CONFIG.softStopPct),
    breakEvenStop: feeAwareBreakEven(entry),
    breakEvenTriggerPct: CONFIG.breakEvenTriggerPct,
    trailingStartPct: CONFIG.trailingStartPct,
    trailingDistancePct: CONFIG.trailingDistancePct,
    takeProfit: entry * (1 + CONFIG.takeProfitPct),
    worstCaseNet: worstCase ? worstCase.net : null
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

  if (fast === null || slow === null || recent.length < 5) {
    return false;
  }

  const bearishTrend = fast < slow;
  const priceBelowSlow = prices[prices.length - 1] < slow;
  const downwardMomentum = recent[4] < recent[0];

  return bearishTrend && priceBelowSlow && downwardMomentum;
}

function calcStats(trades) {
  if (!trades.length) {
    return {
      total: 0, wins: 0, losses: 0,
      winRate: 0, totalNet: 0,
      avgWin: 0, avgLoss: 0,
      profitFactor: 0,
      maxDrawdown: 0
    };
  }

  const wins = trades.filter(t => t.netProfit > 0);
  const losses = trades.filter(t => t.netProfit <= 0);
  const totalNet = trades.reduce((s, t) => s + t.netProfit, 0);
  const grossWin = wins.reduce((s, t) => s + t.netProfit, 0);
  const grossLoss = Math.abs(
    losses.reduce((s, t) => s + t.netProfit, 0)
  );

  // Max drawdown روی equity curve
  let peak = CONFIG.initialBalance;
  let maxDD = 0;
  let equity = CONFIG.initialBalance;

  for (const t of trades) {
    equity += t.netProfit;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    total: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: +(wins.length / trades.length * 100).toFixed(2),
    totalNet: +totalNet.toFixed(2),
    avgWin: wins.length
      ? +(grossWin / wins.length).toFixed(2)
      : 0,
    avgLoss: losses.length
      ? +(grossLoss / losses.length).toFixed(2)
      : 0,
    profitFactor: grossLoss > 0
      ? +(grossWin / grossLoss).toFixed(2)
      : (grossWin > 0 ? Infinity : 0),
    maxDrawdown: +maxDD.toFixed(2)
  };
}

async function tick(kv) {
  if (!kv || typeof kv.get !== "function") {
    throw new Error("BOT_STATE KV binding missing.");
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

  // بروزرسانی peak balance
  if (state.balance > state.peakBalance) {
    state.peakBalance = state.balance;
  }

  if (state.position) {
    const pos = state.position;

    pos.entry = Number(pos.entry);
    pos.quantity = Number(pos.quantity);
    pos.entryFee = Number(pos.entryFee || 0);
    pos.highest = Math.max(
      Number(pos.highest || pos.entry),
      market.bid
    );
    pos.trailingStop = Number(pos.trailingStop || 0);
    pos.trailingActive = Boolean(pos.trailingActive);
    pos.breakEvenProtected = Boolean(pos.breakEvenProtected);

    const highProfit = (pos.highest - pos.entry) / pos.entry;
    const resultAtBid = estimateNet(pos, market.bid);

    // 1) فعال‌سازی Break-Even
    if (highProfit >= CONFIG.breakEvenTriggerPct) {
      pos.trailingStop = Math.max(
        pos.trailingStop,
        feeAwareBreakEven(pos.entry)
      );
      pos.breakEvenProtected = true;
    }

    // 2) فعال‌سازی Trailing
    if (highProfit >= CONFIG.trailingStartPct) {
      pos.trailingActive = true;
      pos.trailingStop = Math.max(
        pos.trailingStop,
        pos.highest * (1 - CONFIG.trailingDistancePct)
      );
    }

    const heldMs = Date.parse(nowIso) -
      Date.parse(pos.openedAt || nowIso);
    const minimumHoldPassed =
      Number.isFinite(heldMs) &&
      heldMs >= CONFIG.earlyExitMinHoldMinutes * 60 * 1000;

    const bearishConfirmed = hasBearishConfirmation(state.prices);

    let reason = null;

    // ═══ اولویت‌بندی خروج ═══

    // 1) Take Profit
    if (market.bid >= pos.entry * (1 + CONFIG.takeProfitPct)) {
      reason = "TAKE_PROFIT";
    }

    // 2) Emergency Stop Loss
    else if (
      market.bid <= pos.entry * (1 - CONFIG.stopLossPct)
    ) {
      reason = "EMERGENCY_STOP_LOSS";
    }

    // 3) Trailing / Break-Even
    else if (
      pos.trailingStop > 0 &&
      market.bid <= pos.trailingStop
    ) {
      reason = pos.trailingActive
        ? "TRAILING_STOP"
        : "BREAK_EVEN_STOP";
    }

    // 4) محافظت از ضرر خالص (Net-Loss Guard)
    else if (
      resultAtBid &&
      resultAtBid.netPct <= -CONFIG.maxNetLossPct
    ) {
      reason = "NET_LOSS_GUARD";
    }

    // 5) خروج زودهنگام با تأیید نزولی
    else if (
      minimumHoldPassed &&
      bearishConfirmed &&
      resultAtBid &&
      resultAtBid.netPct <= -CONFIG.earlyExitNetLossPct
    ) {
      reason = "EARLY_BEARISH_EXIT";
    }

    if (reason) {
      const exitPrice = market.bid;
      const exitFee = exitPrice * pos.quantity * CONFIG.feePct;
      const grossExit = exitPrice * pos.quantity - exitFee;
      const netProfit = grossExit -
        (pos.entry * pos.quantity + pos.entryFee);

      state.balance += grossExit;

      const trade = {
        entry: pos.entry,
        exit: exitPrice,
        quantity: pos.quantity,
        entryFee: pos.entryFee,
        exitFee,
        grossProfit: (exitPrice - pos.entry) * pos.quantity,
        fees: pos.entryFee + exitFee,
        netProfit,
        netProfitPct: (netProfit /
          (pos.entry * pos.quantity + pos.entryFee)) * 100,
        reason,
        openedAt: pos.openedAt,
        closedAt: nowIso
      };

      state.trades.push(trade);
      state.trades = state.trades.slice(-CONFIG.maxTrades);
      closedTrade = trade;

      if (netProfit < 0) {
        state.lastLossAt = nowIso;
        state.consecutiveLosses += 1;
        state.dailyLoss += Math.abs(netProfit);

        // بررسی توقف
        if (state.consecutiveLosses >= CONFIG.maxConsecutiveLosses) {
          state.halted = true;
          state.haltReason = `${CONFIG.maxConsecutiveLosses} consecutive losses`;
        }
        if (state.dailyLoss >= CONFIG.maxDailyLoss) {
          state.halted = true;
          state.haltReason = "Daily loss limit reached";
        }
      } else {
        state.consecutiveLosses = 0;
      }

      state.position = null;
    }
  } else {
    // ═══ ورود ═══
    if (state.halted) {
      entryBlockReason = "HALTED: " + state.haltReason;
    } else if (
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
        recent.length === 6 && recent[5] > recent[0];

      if (!crossedUp) {
        entryBlockReason = "NO_FRESH_UPWARD_CROSSOVER";
      } else if (
        trendStrength < CONFIG.minTrendStrengthPct ||
        !momentumUp ||
        market.price <= currentSlow
      ) {
        entryBlockReason = "TREND_NOT_CONFIRMED";
      } else {
        // ═══ محاسبه اصلاح‌شده پوزیشن ═══
        const cost = CONFIG.tradeAmount;
        const entryFee = cost * CONFIG.feePct;
        const totalDebit = cost + entryFee;

        if (state.balance < totalDebit) {
          entryBlockReason = "INSUFFICIENT_BALANCE";
        } else {
          const entryPrice = market.ask;
          const quantity = cost / entryPrice;

          state.balance -= totalDebit;

          state.position = {
            entry: entryPrice,
            quantity,
            entryFee,
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

  const stats = calcStats(state.trades);

  return {
    ok: true,
    mode: "PAPER",
    symbol: "BTC/IRT",
    market,
    balance: +state.balance.toFixed(2),
    peakBalance: +state.peakBalance.toFixed(2),
    position: state.position,
    unrealized: state.position
      ? estimateNet(state.position, market.bid)
      : null,
    risk: getRiskInfo(state.position),
    openedTrade,
    closedTrade,
    entryBlockReason,
    consecutiveLosses: state.consecutiveLosses,
    dailyLoss: +state.dailyLoss.toFixed(2),
    halted: state.halted,
    haltReason: state.haltReason,
    stats,
    lastUpdate: nowIso
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return json({
        bot: "Crypto Paper Bot FA v2",
        status: "online",
        mode: "PAPER",
        symbol: "BTC/IRT",
        endpoints: ["/status", "/price", "/tick", "/stats", "/reset"],
        note: "Paper trading only. No real orders."
      });
    }

    if (url.pathname === "/price") {
      try {
        return json({ ok: true, ...(await getPrice()) });
      } catch (error) {
        return json({ ok: false, error: errorMessage(error) }, 502);
      }
    }

    if (!env.BOT_STATE) {
      return json({
        ok: false,
        error: "Configure BOT_STATE KV binding."
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
          balance: +state.balance.toFixed(2),
          peakBalance: +state.peakBalance.toFixed(2),
          position: state.position,
          market,
          unrealized: state.position && market
            ? estimateNet(state.position, market.bid)
            : null,
          risk: getRiskInfo(state.position),
          consecutiveLosses: state.consecutiveLosses,
          dailyLoss: +state.dailyLoss.toFixed(2),
          halted: state.halted,
          haltReason: state.haltReason,
          stats: calcStats(state.trades),
          recentTrades: state.trades.slice(-10),
          lastUpdate: state.lastUpdate,
          lastLossAt: state.lastLossAt,
          lastError: state.lastError
        });
      } catch (error) {
        return json({ ok: false, error: errorMessage(error) }, 500);
      }
    }

    if (url.pathname === "/tick") {
      try {
        return json(await tick(env.BOT_STATE));
      } catch (error) {
        return json({ ok: false, error: errorMessage(error) }, 502);
      }
    }

    if (url.pathname === "/stats") {
      try {
        const state = await loadState(env.BOT_STATE);
        return json({
          ok: true,
          stats: calcStats(state.trades),
          trades: state.trades
        });
      } catch (error) {
        return json({ ok: false, error: errorMessage(error) }, 500);
      }
    }

    if (url.pathname === "/reset") {
      try {
        await saveState(env.BOT_STATE, initialState());
        return json({ ok: true, message: "State reset" });
      } catch (error) {
        return json({ ok: false, error: errorMessage(error) }, 500);
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
        console.error("Scheduled tick failed:", message);
        if (env.BOT_STATE) {
          try {
            const state = await loadState(env.BOT_STATE);
            state.lastError = message;
            await saveState(env.BOT_STATE, state);
          } catch (e) {
            console.error("Save failed:", errorMessage(e));
          }
        }
      }
    })());
  }
};
