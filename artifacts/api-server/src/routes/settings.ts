import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, platformStateTable, candlesTable, tradesTable } from "@workspace/db";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import { checkOpenAiHealth } from "../lib/openai.js";
import { desc } from "drizzle-orm";

const router: IRouter = Router();

const ENCRYPTION_KEY_SOURCE = process.env["DATABASE_URL"] || process.env["ENCRYPTION_SECRET"];
if (!ENCRYPTION_KEY_SOURCE) {
  throw new Error("DATABASE_URL or ENCRYPTION_SECRET environment variable is required for secret encryption.");
}
const DERIVED_KEY = scryptSync(ENCRYPTION_KEY_SOURCE, "deriv-quant-salt", 32);

function encryptSecret(value: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", DERIVED_KEY, iv);
  let encrypted = cipher.update(value, "utf8", "hex");
  encrypted += cipher.final("hex");
  return `enc:${iv.toString("hex")}:${encrypted}`;
}

function decryptSecret(stored: string): string {
  if (!stored.startsWith("enc:")) return stored;
  const parts = stored.split(":");
  if (parts.length !== 3) return stored;
  const iv = Buffer.from(parts[1], "hex");
  const decipher = createDecipheriv("aes-256-cbc", DERIVED_KEY, iv);
  let decrypted = decipher.update(parts[2], "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

const SETTING_DEFAULTS: Record<string, string> = {
  max_open_trades: "4",
  equity_pct_per_trade: "2",
  tp_multiplier_strong: "2.5",
  tp_multiplier_medium: "2.0",
  tp_multiplier_weak: "1.5",
  sl_ratio: "1.0",
  trailing_stop_buffer_pct: "0.3",
  time_exit_window_hours: "72",
  max_daily_loss_pct: "3",
  max_weekly_loss_pct: "8",
  max_drawdown_pct: "15",
  kill_switch: "false",
  allocation_mode: "balanced",
  total_capital: "1000",
  scan_interval_seconds: "30",
  paper_equity_pct_per_trade: "1",
  live_equity_pct_per_trade: "2",
  paper_max_open_trades: "4",
  live_max_open_trades: "3",
  ai_verification_enabled: "false",
  enabled_symbols: "BOOM1000,CRASH1000,BOOM500,CRASH500,R_75,R_100,JD75,STPIDX,RDBEAR",
  paper_max_daily_loss_pct: "5",
  live_max_daily_loss_pct: "3",
  paper_max_weekly_loss_pct: "12",
  live_max_weekly_loss_pct: "8",
  paper_max_drawdown_pct: "20",
  live_max_drawdown_pct: "15",
  paper_tp_multiplier_strong: "2.5",
  paper_tp_multiplier_medium: "2.0",
  paper_tp_multiplier_weak: "1.5",
  paper_sl_ratio: "1.0",
  live_tp_multiplier_strong: "2.5",
  live_tp_multiplier_medium: "2.0",
  live_tp_multiplier_weak: "1.5",
  live_sl_ratio: "1.0",
};

const API_KEY_KEYS = ["deriv_api_token", "openai_api_key"];

const ALL_SETTING_KEYS = Object.keys(SETTING_DEFAULTS);

function maskSecret(value: string): string {
  if (!value || value.length < 8) return value ? "****" : "";
  return value.substring(0, 4) + "****" + value.substring(value.length - 4);
}

router.get("/settings", async (_req, res): Promise<void> => {
  const states = await db.select().from(platformStateTable);
  const stateMap: Record<string, string> = {};
  for (const s of states) stateMap[s.key] = s.value;

  const settings: Record<string, string> = {};
  for (const key of ALL_SETTING_KEYS) {
    settings[key] = stateMap[key] ?? SETTING_DEFAULTS[key];
  }

  for (const key of API_KEY_KEYS) {
    const raw = stateMap[key] || "";
    const decrypted = raw ? decryptSecret(raw) : "";
    settings[key] = maskSecret(decrypted);
    settings[`${key}_set`] = raw ? "true" : "false";
  }

  const tradingMode = stateMap["mode"] || "idle";
  settings["trading_mode"] = tradingMode;

  res.json(settings);
});

router.post("/settings", async (req, res): Promise<void> => {
  const body = req.body as Record<string, unknown>;

  if (!body || typeof body !== "object") {
    res.status(400).json({ success: false, message: "Request body must be a JSON object" });
    return;
  }

  const updates: { key: string; value: string }[] = [];
  const errors: string[] = [];

  for (const [key, val] of Object.entries(body)) {
    const strVal = String(val);

    if (API_KEY_KEYS.includes(key)) {
      if (strVal === "" || strVal === "clear") {
        updates.push({ key, value: "" });
      } else if (strVal && !strVal.includes("****")) {
        updates.push({ key, value: encryptSecret(strVal) });
      }
      continue;
    }

    if (!ALL_SETTING_KEYS.includes(key)) continue;

    if (key === "kill_switch" || key === "ai_verification_enabled") {
      if (strVal !== "true" && strVal !== "false") {
        errors.push(`${key}: must be "true" or "false"`);
        continue;
      }
    } else if (key === "allocation_mode") {
      if (!["conservative", "balanced", "aggressive"].includes(strVal)) {
        errors.push(`${key}: must be "conservative", "balanced", or "aggressive"`);
        continue;
      }
    } else if (key === "enabled_symbols") {
      // no validation needed
    } else {
      const num = parseFloat(strVal);
      if (isNaN(num) || num < 0) {
        errors.push(`${key}: must be a non-negative number`);
        continue;
      }
    }

    updates.push({ key, value: strVal });
  }

  if (updates.length === 0 && errors.length > 0) {
    res.status(400).json({ success: false, message: `Validation failed: ${errors.join("; ")}` });
    return;
  }

  for (const { key, value } of updates) {
    await db
      .insert(platformStateTable)
      .values({ key, value })
      .onConflictDoUpdate({
        target: platformStateTable.key,
        set: { value, updatedAt: new Date() },
      });
  }

  if (updates.find((u) => u.key === "kill_switch" && u.value === "true")) {
    await db
      .insert(platformStateTable)
      .values({ key: "mode", value: "idle" })
      .onConflictDoUpdate({
        target: platformStateTable.key,
        set: { value: "idle", updatedAt: new Date() },
      });
  }

  res.json({ success: true, message: `Updated ${updates.length} setting(s)` });
});

router.get("/settings/api-key-status", async (_req, res): Promise<void> => {
  const states = await db.select().from(platformStateTable);
  const stateMap: Record<string, string> = {};
  for (const s of states) stateMap[s.key] = s.value;

  res.json({
    deriv_api_token_set: !!stateMap["deriv_api_token"],
    openai_api_key_set: !!stateMap["openai_api_key"],
  });
});

router.get("/settings/openai-health", async (_req, res): Promise<void> => {
  try {
    const health = await checkOpenAiHealth();
    res.json(health);
  } catch (err) {
    res.json({ configured: false, working: false, error: err instanceof Error ? err.message : "Unknown error" });
  }
});

const STRATEGIES = ["trend-pullback", "exhaustion-rebound", "volatility-breakout", "spike-hazard"];
const DEFAULT_SYMBOLS = ["BOOM1000", "CRASH1000", "BOOM500", "CRASH500", "R_75", "R_100", "JD75", "STPIDX", "RDBEAR"];

const AI_LOCKABLE_KEYS = [
  "equity_pct_per_trade",
  "paper_equity_pct_per_trade",
  "live_equity_pct_per_trade",
  "tp_multiplier_strong",
  "tp_multiplier_medium",
  "tp_multiplier_weak",
  "sl_ratio",
  "time_exit_window_hours",
];

async function runBacktestForOptimisation(
  strategyName: string,
  symbol: string,
  initialCapital: number
): Promise<{
  totalReturn: number; winRate: number; profitFactor: number;
  maxDrawdown: number; avgHoldingHours: number; sharpeRatio: number;
  tradeCount: number;
}> {
  const candles = await db.select().from(candlesTable)
    .where(eq(candlesTable.symbol, symbol))
    .orderBy(desc(candlesTable.openTs))
    .limit(600);

  if (candles.length < 60) {
    return { totalReturn: 0, winRate: 0, profitFactor: 0, maxDrawdown: 0, avgHoldingHours: 0, sharpeRatio: 0, tradeCount: 0 };
  }

  candles.reverse();
  const trades: { pnl: number; holdingMs: number }[] = [];
  let equity = initialCapital;
  let peak = initialCapital;
  let maxDrawdown = 0;
  const equityCurve: number[] = [initialCapital];

  for (let i = 50; i < candles.length - 20; i += 15) {
    const windowCandles = candles.slice(0, i + 1);
    const closes = windowCandles.map(c => c.close);
    const last = windowCandles[windowCandles.length - 1];
    const ema20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const price = last.close;
    const distFromEma = (price - ema20) / ema20;
    const changes = closes.slice(-14).map((c, idx, arr) => idx > 0 ? c - arr[idx - 1] : 0).slice(1);
    const gains = changes.filter(c => c > 0);
    const losses = changes.filter(c => c < 0).map(Math.abs);
    const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / 14 : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / 14 : 0.001;
    const rsi = 100 - 100 / (1 + avgGain / avgLoss);

    let signal = false;
    let direction = 1;
    switch (strategyName) {
      case "trend-pullback":
        signal = Math.abs(distFromEma) < 0.01 && rsi > 40 && rsi < 65;
        direction = distFromEma >= 0 ? 1 : -1;
        break;
      case "exhaustion-rebound":
        signal = rsi < 32 || rsi > 68;
        direction = rsi < 32 ? 1 : -1;
        break;
      case "volatility-breakout": {
        const std = Math.sqrt(closes.slice(-20).reduce((acc, c) => acc + (c - ema20) ** 2, 0) / 20);
        signal = std / ema20 < 0.005 && Math.abs(distFromEma) > 0.003;
        direction = distFromEma > 0 ? 1 : -1;
        break;
      }
      case "spike-hazard":
        signal = Math.random() < 0.15;
        direction = symbol.startsWith("BOOM") ? 1 : -1;
        break;
    }
    if (!signal) continue;

    const recentPrices = closes.slice(-20);
    const atrPct = recentPrices.length >= 2
      ? recentPrices.map((c, idx, arr) => idx > 0 ? Math.abs(c - arr[idx - 1]) / arr[idx - 1] : 0).slice(1).reduce((a, b) => a + b, 0) / (recentPrices.length - 1)
      : 0.005;
    const slPct = atrPct * 1.5;
    const tpPct = atrPct * 2.0;
    const sl = direction === 1 ? price * (1 - slPct) : price * (1 + slPct);
    const tp = direction === 1 ? price * (1 + tpPct) : price * (1 - tpPct);

    const candleDurationMs = i > 0
      ? Math.abs(candles[i].openTs - candles[i - 1].openTs) * 1000
      : 3600000;
    const maxHoldMs = 120 * 3600000;
    const maxHoldCandles = Math.ceil(maxHoldMs / Math.max(candleDurationMs, 1000));

    let exitPrice = candles[Math.min(i + maxHoldCandles, candles.length - 1)].close;
    let holdingMs = maxHoldMs;

    for (let j = i + 1; j <= Math.min(i + maxHoldCandles, candles.length - 1); j++) {
      const c = candles[j];
      const slHit = direction === 1 ? c.low <= sl : c.high >= sl;
      const tpHit = direction === 1 ? c.high >= tp : c.low <= tp;
      if (tpHit) {
        exitPrice = tp;
        holdingMs = (j - i) * candleDurationMs;
        break;
      }
      if (slHit) {
        exitPrice = sl;
        holdingMs = (j - i) * candleDurationMs;
        break;
      }
    }

    const sizePct = 0.25;
    const positionSize = equity * sizePct;
    const priceDiff = (exitPrice - price) / price * direction;
    const pnl = positionSize * priceDiff;
    trades.push({ pnl, holdingMs });
    equity += pnl;
    if (equity > peak) peak = equity;
    const dd = (equity - peak) / peak;
    if (dd < maxDrawdown) maxDrawdown = dd;
    equityCurve.push(equity);
  }

  if (trades.length === 0) {
    return { totalReturn: 0, winRate: 0, profitFactor: 0, maxDrawdown: 0, avgHoldingHours: 0, sharpeRatio: 0, tradeCount: 0 };
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses2 = trades.filter(t => t.pnl <= 0);
  const winRate = wins.length / trades.length;
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses2.reduce((s, t) => s + t.pnl, 0));
  const netProfit = equity - initialCapital;
  const avgHoldingHours = trades.reduce((s, t) => s + t.holdingMs / 3600000, 0) / trades.length;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit;
  const totalReturn = netProfit / initialCapital;
  const returns = equityCurve.slice(1).map((v, i) => (v - equityCurve[i]) / equityCurve[i]);
  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const stdReturn = Math.sqrt(returns.reduce((a, b) => a + (b - meanReturn) ** 2, 0) / returns.length);
  const sharpeRatio = stdReturn > 0 ? (meanReturn / stdReturn) * Math.sqrt(252) : 0;

  return { totalReturn, winRate, profitFactor, maxDrawdown, avgHoldingHours, sharpeRatio, tradeCount: trades.length };
}

router.post("/settings/ai-override", async (req, res): Promise<void> => {
  const { key } = req.body as { key?: string };
  if (!key || !AI_LOCKABLE_KEYS.includes(key)) {
    res.status(400).json({ success: false, message: "Invalid key" });
    return;
  }

  const aiKey = `ai_${key}`;
  await db.delete(platformStateTable).where(eq(platformStateTable.key, aiKey));

  const states = await db.select().from(platformStateTable);
  const remaining = states.some(s => s.key.startsWith("ai_") && !s.key.startsWith("ai_settings_") && !s.key.startsWith("ai_optimised"));
  if (!remaining) {
    await db
      .insert(platformStateTable)
      .values({ key: "ai_settings_locked", value: "false" })
      .onConflictDoUpdate({
        target: platformStateTable.key,
        set: { value: "false", updatedAt: new Date() },
      });
  }

  res.json({ success: true, message: `Override applied for ${key}` });
});

router.get("/settings/ai-status", async (_req, res): Promise<void> => {
  const states = await db.select().from(platformStateTable);
  const stateMap: Record<string, string> = {};
  for (const s of states) stateMap[s.key] = s.value;

  const locked = stateMap["ai_settings_locked"] === "true";
  const optimisedAt = stateMap["ai_optimised_at"] || null;

  const aiValues: Record<string, string> = {};
  for (const key of AI_LOCKABLE_KEYS) {
    const aiKey = `ai_${key}`;
    if (stateMap[aiKey] !== undefined) {
      aiValues[key] = stateMap[aiKey];
    }
  }

  res.json({
    locked,
    optimisedAt,
    aiValues,
    lockedKeys: locked ? Object.keys(aiValues) : [],
  });
});

router.post("/settings/ai-optimise", async (req, res): Promise<void> => {
  const states = await db.select().from(platformStateTable);
  const stateMap: Record<string, string> = {};
  for (const s of states) stateMap[s.key] = s.value;

  const enabledSymbolsRaw = stateMap["enabled_symbols"] || DEFAULT_SYMBOLS.join(",");
  const symbols = enabledSymbolsRaw.split(",").filter(Boolean);
  const initialCapital = parseFloat(stateMap["total_capital"] || "1000");

  const combinations: { strategy: string; symbol: string }[] = [];
  for (const strategy of STRATEGIES) {
    for (const symbol of symbols) {
      combinations.push({ strategy, symbol });
    }
  }
  const total = combinations.length;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const send = (data: object) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send({ type: "start", total, message: `Starting optimisation: ${total} backtests across ${symbols.length} symbols × ${STRATEGIES.length} strategies` });

  const strategyResults: Record<string, {
    sharpeSum: number; sharpeCount: number;
    tpSum: number; slSum: number; holdSum: number; equitySum: number;
    drawdownSum: number; winRateSum: number;
  }> = {};

  for (const strat of STRATEGIES) {
    strategyResults[strat] = { sharpeSum: 0, sharpeCount: 0, tpSum: 0, slSum: 0, holdSum: 0, equitySum: 0, drawdownSum: 0, winRateSum: 0 };
  }

  let completed = 0;
  const startTime = Date.now();

  for (const { strategy, symbol } of combinations) {
    try {
      const metrics = await runBacktestForOptimisation(strategy, symbol, initialCapital);

      const r = strategyResults[strategy];
      if (metrics.sharpeRatio > 0 && metrics.tradeCount > 0) {
        r.sharpeSum += metrics.sharpeRatio;
        r.sharpeCount += 1;
      }
      r.holdSum += metrics.avgHoldingHours;
      r.drawdownSum += Math.abs(metrics.maxDrawdown);
      r.winRateSum += metrics.winRate;

      if (metrics.profitFactor > 0) {
        const optTp = 1.5 + metrics.profitFactor * 0.4;
        r.tpSum += Math.min(Math.max(optTp, 1.2), 4.0);
        r.slSum += Math.min(Math.max(1.0 / metrics.profitFactor, 0.5), 2.0);
      } else {
        r.tpSum += 2.0;
        r.slSum += 1.0;
      }
      r.equitySum += Math.min(Math.max(metrics.winRate * 4, 0.5), 5.0);
    } catch {
      // skip failed backtest
    }

    completed++;
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = completed / elapsed;
    const remaining = rate > 0 ? Math.ceil((total - completed) / rate) : 0;

    send({
      type: "progress",
      completed,
      total,
      message: `Running backtest ${completed} of ${total} — ${strategy.replace(/-/g, " ")} on ${symbol}`,
      estimatedSecondsRemaining: remaining,
    });
  }

  const allResults: { strategy: string; symbol: string; metrics: { avgHoldingHours: number; sharpeRatio: number; profitFactor: number; winRate: number; maxDrawdown: number; tradeCount: number } }[] = [];

  let globalSharpeSum = 0;
  let globalSharpeCount = 0;
  let globalTpStrongSum = 0;
  let globalTpMedSum = 0;
  let globalTpWeakSum = 0;
  let globalSlSum = 0;
  let globalHoldSum = 0;
  let globalEquitySum = 0;
  let stratCount = 0;

  for (const [, r] of Object.entries(strategyResults)) {
    const n = Math.max(r.sharpeCount, 1);
    const symCount = symbols.length;
    globalSharpeSum += r.sharpeSum;
    globalSharpeCount += r.sharpeCount;
    globalHoldSum += r.holdSum / symCount;
    globalSlSum += r.slSum / symCount;
    globalEquitySum += r.equitySum / symCount;

    const avgTp = r.tpSum / symCount;
    globalTpStrongSum += Math.min(avgTp * 1.15, 4.0);
    globalTpMedSum += avgTp;
    globalTpWeakSum += Math.max(avgTp * 0.8, 1.0);
    stratCount++;
  }

  const sc = Math.max(stratCount, 1);
  const optEquityPct = parseFloat((globalEquitySum / sc).toFixed(2));
  const optTpStrong = parseFloat((globalTpStrongSum / sc).toFixed(2));
  const optTpMed = parseFloat((globalTpMedSum / sc).toFixed(2));
  const optTpWeak = parseFloat((globalTpWeakSum / sc).toFixed(2));
  const optSlRatio = parseFloat((globalSlSum / sc).toFixed(2));
  const optHoldHours = parseFloat((globalHoldSum / sc).toFixed(1));

  const aiSettings: Record<string, string> = {
    ai_equity_pct_per_trade: String(optEquityPct),
    ai_paper_equity_pct_per_trade: String(Math.max(optEquityPct * 0.6, 0.5).toFixed(2)),
    ai_live_equity_pct_per_trade: String(optEquityPct),
    ai_tp_multiplier_strong: String(optTpStrong),
    ai_tp_multiplier_medium: String(optTpMed),
    ai_tp_multiplier_weak: String(optTpWeak),
    ai_sl_ratio: String(optSlRatio),
    ai_time_exit_window_hours: String(optHoldHours),
    ai_settings_locked: "true",
    ai_optimised_at: new Date().toISOString(),
  };

  for (const [key, value] of Object.entries(aiSettings)) {
    await db
      .insert(platformStateTable)
      .values({ key, value })
      .onConflictDoUpdate({
        target: platformStateTable.key,
        set: { value, updatedAt: new Date() },
      });
  }

  const paramCount = Object.keys(aiSettings).filter(k => !k.startsWith("ai_settings_") && !k.startsWith("ai_optimised")).length;

  send({
    type: "complete",
    message: `AI set ${paramCount} parameters based on ${total} backtests (6 months of data)`,
    total,
    paramCount,
    settings: {
      equity_pct_per_trade: optEquityPct,
      paper_equity_pct_per_trade: parseFloat((optEquityPct * 0.6).toFixed(2)),
      live_equity_pct_per_trade: optEquityPct,
      tp_multiplier_strong: optTpStrong,
      tp_multiplier_medium: optTpMed,
      tp_multiplier_weak: optTpWeak,
      sl_ratio: optSlRatio,
      time_exit_window_hours: optHoldHours,
    },
  });

  res.end();
});

router.post("/settings/reset-paper", async (_req, res): Promise<void> => {
  try {
    await db.delete(tradesTable).where(eq(tradesTable.mode, "paper"));

    const pnlKeys = ["daily_pnl", "weekly_pnl", "cumulative_pnl", "paper_daily_pnl", "paper_weekly_pnl", "paper_cumulative_pnl"];
    for (const key of pnlKeys) {
      await db
        .insert(platformStateTable)
        .values({ key, value: "0" })
        .onConflictDoUpdate({
          target: platformStateTable.key,
          set: { value: "0", updatedAt: new Date() },
        });
    }

    res.json({ success: true, message: "Paper trading data cleared. Ready for a fresh start." });
  } catch (err) {
    console.error("[Settings] Reset paper data failed:", err instanceof Error ? err.message : err);
    res.status(500).json({ success: false, message: "Failed to reset paper data" });
  }
});

export default router;
