import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, platformStateTable, candlesTable, tradesTable } from "@workspace/db";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import { checkOpenAiHealth } from "../infrastructure/openai.js";
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

const ACTIVE_TRADING_SYMBOLS_DEFAULT = "CRASH300,BOOM300,R_75,R_100";
const ALL_STRATEGIES_DEFAULT = "trend_continuation,mean_reversion,spike_cluster_recovery,swing_exhaustion,trendline_breakout";

const SETTING_DEFAULTS: Record<string, string> = {
  kill_switch: "false",
  scan_interval_seconds: "30",
  scan_stagger_seconds: "10",
  ai_verification_enabled: "false",
  use_calibrated_runtime_profiles: "false",
  enabled_symbols: ACTIVE_TRADING_SYMBOLS_DEFAULT,
  min_composite_score: "80",
  min_ev_threshold: "0.001",
  min_rr_ratio: "1.5",
  scoring_weight_range_position: "25",
  scoring_weight_ma_deviation: "20",
  scoring_weight_volatility_profile: "20",
  scoring_weight_range_expansion: "15",
  scoring_weight_directional_confirmation: "20",
  ai_recommended_strategies: "",
  ai_recommended_symbols: "",

  paper_mode_active: "false",
  paper_capital: "600",
  paper_equity_pct_per_trade: "30",
  paper_max_open_trades: "4",
  paper_allocation_mode: "aggressive",
  paper_max_daily_loss_pct: "8",
  paper_max_weekly_loss_pct: "15",
  paper_max_drawdown_pct: "25",
  paper_extraction_target_pct: "50",
  paper_auto_extraction: "false",
  paper_correlated_family_cap: "4",
  paper_enabled_symbols: ACTIVE_TRADING_SYMBOLS_DEFAULT,
  paper_enabled_strategies: ALL_STRATEGIES_DEFAULT,

  demo_mode_active: "false",
  demo_capital: "600",
  demo_equity_pct_per_trade: "20",
  demo_max_open_trades: "3",
  demo_allocation_mode: "balanced",
  demo_max_daily_loss_pct: "5",
  demo_max_weekly_loss_pct: "10",
  demo_max_drawdown_pct: "18",
  demo_extraction_target_pct: "50",
  demo_auto_extraction: "false",
  demo_correlated_family_cap: "3",
  demo_enabled_symbols: ACTIVE_TRADING_SYMBOLS_DEFAULT,
  demo_enabled_strategies: ALL_STRATEGIES_DEFAULT,

  real_mode_active: "false",
  real_capital: "600",
  real_equity_pct_per_trade: "15",
  real_max_open_trades: "3",
  real_allocation_mode: "balanced",
  real_max_daily_loss_pct: "3",
  real_max_weekly_loss_pct: "6",
  real_max_drawdown_pct: "12",
  real_extraction_target_pct: "50",
  real_auto_extraction: "false",
  real_correlated_family_cap: "3",
  real_enabled_symbols: ACTIVE_TRADING_SYMBOLS_DEFAULT,
  real_enabled_strategies: ALL_STRATEGIES_DEFAULT,
};

const API_KEY_KEYS = ["deriv_api_token_demo", "deriv_api_token_real", "openai_api_key"];

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
    if (stateMap[key] !== undefined) {
      settings[key] = stateMap[key];
    } else {
      settings[key] = SETTING_DEFAULTS[key];
    }
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

    const BOOLEAN_KEYS = [
      "kill_switch",
      "ai_verification_enabled",
      "use_calibrated_runtime_profiles",
      "paper_mode_active",
      "demo_mode_active",
      "real_mode_active",
      "paper_auto_extraction",
      "demo_auto_extraction",
      "real_auto_extraction",
    ];
    const ALLOCATION_KEYS = ["allocation_mode", "paper_allocation_mode", "demo_allocation_mode", "real_allocation_mode"];
    const STRING_LIST_KEYS = [
      "enabled_symbols", "paper_enabled_symbols", "demo_enabled_symbols", "real_enabled_symbols",
      "paper_enabled_strategies", "demo_enabled_strategies", "real_enabled_strategies",
    ];

    if (BOOLEAN_KEYS.includes(key)) {
      if (strVal !== "true" && strVal !== "false") {
        errors.push(`${key}: must be "true" or "false"`);
        continue;
      }
    } else if (ALLOCATION_KEYS.includes(key)) {
      if (!["conservative", "balanced", "aggressive"].includes(strVal)) {
        errors.push(`${key}: must be "conservative", "balanced", or "aggressive"`);
        continue;
      }
    } else if (STRING_LIST_KEYS.includes(key)) {
      // comma-separated lists, no validation needed
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
    for (const modeKey of ["paper_mode_active", "demo_mode_active", "real_mode_active"]) {
      await db
        .insert(platformStateTable)
        .values({ key: modeKey, value: "false" })
        .onConflictDoUpdate({
          target: platformStateTable.key,
          set: { value: "false", updatedAt: new Date() },
        });
    }
    await db
      .insert(platformStateTable)
      .values({ key: "mode", value: "idle" })
      .onConflictDoUpdate({
        target: platformStateTable.key,
        set: { value: "idle", updatedAt: new Date() },
      });
  } else if (updates.some((u) => ["paper_mode_active", "demo_mode_active", "real_mode_active"].includes(u.key))) {
    const allStates = await db.select().from(platformStateTable);
    const stateMap: Record<string, string> = {};
    for (const s of allStates) stateMap[s.key] = s.value;
    for (const u of updates) stateMap[u.key] = u.value;

    const paperActive = stateMap["paper_mode_active"] === "true";
    const demoActive = stateMap["demo_mode_active"] === "true";
    const realActive = stateMap["real_mode_active"] === "true";
    let derivedMode = "idle";
    if (realActive) derivedMode = "real";
    else if (demoActive) derivedMode = "demo";
    else if (paperActive) derivedMode = "paper";

    await db.insert(platformStateTable).values({ key: "mode", value: derivedMode })
      .onConflictDoUpdate({ target: platformStateTable.key, set: { value: derivedMode, updatedAt: new Date() } });
  }

  res.json({ success: true, message: `Updated ${updates.length} setting(s)` });
});

router.get("/settings/api-key-status", async (_req, res): Promise<void> => {
  const states = await db.select().from(platformStateTable);
  const stateMap: Record<string, string> = {};
  for (const s of states) stateMap[s.key] = s.value;

  res.json({
    deriv_api_token_demo_set: !!stateMap["deriv_api_token_demo"],
    deriv_api_token_real_set: !!stateMap["deriv_api_token_real"],
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

const STRATEGIES = ["trend_continuation", "mean_reversion", "spike_cluster_recovery", "swing_exhaustion", "trendline_breakout"];
const DEFAULT_SYMBOLS = ["CRASH300", "BOOM300", "R_75", "R_100"];


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

  for (let i = 50; i < candles.length - 20; i += 20) {
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
      case "trend_continuation":
        signal = Math.abs(distFromEma) < 0.01 && rsi > 40 && rsi < 65;
        direction = distFromEma >= 0 ? 1 : -1;
        break;
      case "mean_reversion":
        signal = rsi < 32 || rsi > 68;
        direction = rsi < 32 ? 1 : -1;
        break;
      case "spike_cluster_recovery": {
        const bodyRatio = Math.abs(last.close - last.open) / Math.max(0.0001, last.high - last.low);
        const bigMove = closes.length >= 2 && Math.abs(closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2] > 0.01;
        signal = bigMove && bodyRatio < 0.40 && (rsi < 35 || rsi > 65);
        direction = symbol.startsWith("CRASH") ? 1 : -1;
        break;
      }
      case "swing_exhaustion": {
        signal = (rsi > 72 || rsi < 28) && Math.abs(distFromEma) > 0.005;
        direction = rsi > 72 ? -1 : 1;
        break;
      }
      case "trendline_breakout": {
        const highs20 = windowCandles.slice(-20).map(c => c.high);
        const lows20 = windowCandles.slice(-20).map(c => c.low);
        const recentHigh = Math.max(...highs20);
        const recentLow = Math.min(...lows20);
        const breakUp = price > recentHigh && distFromEma > 0.001;
        const breakDown = price < recentLow && distFromEma < -0.001;
        signal = breakUp || breakDown;
        direction = breakUp ? 1 : -1;
        break;
      }
    }
    if (!signal) continue;

    const recentPrices = closes.slice(-20);
    const atrPct = recentPrices.length >= 2
      ? recentPrices.map((c, idx, arr) => idx > 0 ? Math.abs(c - arr[idx - 1]) / arr[idx - 1] : 0).slice(1).reduce((a, b) => a + b, 0) / (recentPrices.length - 1)
      : 0.005;
    const slPct = atrPct * 1.5;
    const tpPct = atrPct * 3.0;
    const sl = direction === 1 ? price * (1 - slPct) : price * (1 + slPct);
    const tp = direction === 1 ? price * (1 + tpPct) : price * (1 - tpPct);

    const candleDurationMs = i > 0
      ? Math.abs(candles[i].openTs - candles[i - 1].openTs) * 1000
      : 3600000;
    const maxHoldMs = 168 * 3600000;
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

router.post("/settings/ai-apply-suggestion", async (req, res): Promise<void> => {
  const { key } = req.body as { key?: string };
  if (!key) {
    res.status(400).json({ success: false, message: "Key is required" });
    return;
  }

  const suggestionKey = `ai_suggest_${key}`;
  const rows = await db.select().from(platformStateTable).where(eq(platformStateTable.key, suggestionKey));
  if (rows.length === 0) {
    res.status(404).json({ success: false, message: "No AI suggestion found for this key" });
    return;
  }

  const suggestedValue = rows[0].value;
  await db.insert(platformStateTable).values({ key, value: suggestedValue })
    .onConflictDoUpdate({ target: platformStateTable.key, set: { value: suggestedValue, updatedAt: new Date() } });

  res.json({ success: true, message: `Applied AI suggestion for ${key}: ${suggestedValue}`, value: suggestedValue });
});

router.get("/settings/ai-status", async (_req, res): Promise<void> => {
  const states = await db.select().from(platformStateTable);
  const stateMap: Record<string, string> = {};
  for (const s of states) stateMap[s.key] = s.value;

  const optimisedAt = stateMap["ai_optimised_at"] || null;

  const aiSuggestions: Record<string, string> = {};
  for (const [k, v] of Object.entries(stateMap)) {
    if (k.startsWith("ai_suggest_")) {
      const settingKey = k.replace("ai_suggest_", "");
      aiSuggestions[settingKey] = v;
    }
  }

  const lastMonthlyOptimise = stateMap["last_monthly_optimise_month"] || null;
  const nextScheduled = (() => {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return next.toISOString();
  })();

  const weeklyAnalysisAt = stateMap["ai_weekly_analysis_at"] || null;
  const suggestionTrend = stateMap["ai_suggestion_trend"] || "neutral";
  const tradesAnalyzed = parseInt(stateMap["ai_trades_analyzed"] || "0");
  const observedWinRate = parseFloat(stateMap["ai_win_rate_observed"] || "0");

  const nextSunday = (() => {
    const now = new Date();
    const daysUntilSunday = (7 - now.getDay()) % 7 || 7;
    const next = new Date(now);
    next.setDate(next.getDate() + daysUntilSunday);
    next.setHours(0, 0, 0, 0);
    return next.toISOString();
  })();

  const modeSuggestionCounts: Record<string, number> = { paper: 0, demo: 0, real: 0, global: 0 };
  for (const k of Object.keys(aiSuggestions)) {
    if (k.startsWith("paper_")) modeSuggestionCounts.paper++;
    else if (k.startsWith("demo_")) modeSuggestionCounts.demo++;
    else if (k.startsWith("real_")) modeSuggestionCounts.real++;
    else modeSuggestionCounts.global++;
  }

  res.json({
    locked: false,
    optimisedAt,
    aiValues: {},
    aiSuggestions,
    lockedKeys: [],
    overriddenKeys: [],
    lastMonthlyOptimise,
    nextScheduled,
    weeklyAnalysisAt,
    suggestionTrend,
    tradesAnalyzed,
    observedWinRate,
    nextWeeklyAnalysis: nextSunday,
    modeSuggestionCounts,
  });
});

router.post("/settings/paper-reset", async (_req, res): Promise<void> => {
  try {
    const deleted = await db.delete(tradesTable).where(eq(tradesTable.mode, "paper")).returning();

    const states = await db.select().from(platformStateTable);
    const stateMap: Record<string, string> = {};
    for (const s of states) stateMap[s.key] = s.value;
    const paperCapital = stateMap["paper_capital"] || "10000";

    await db
      .insert(platformStateTable)
      .values({ key: "paper_current_equity", value: paperCapital })
      .onConflictDoUpdate({
        target: platformStateTable.key,
        set: { value: paperCapital, updatedAt: new Date() },
      });

    res.json({
      success: true,
      message: `Paper trading reset: ${deleted.length} trades cleared, capital reset to $${paperCapital}`,
      tradesDeleted: deleted.length,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err instanceof Error ? err.message : "Reset failed" });
  }
});

export default router;
