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

const ALL_SYMBOLS_DEFAULT = "BOOM1000,CRASH1000,BOOM500,CRASH500,BOOM300,CRASH300,BOOM200,CRASH200,R_75,R_100,JD75,STPIDX,RDBEAR";
const ALL_STRATEGIES_DEFAULT = "trend-pullback,exhaustion-rebound,volatility-breakout,spike-hazard,volatility-expansion,liquidity-sweep,macro-bias";

const SETTING_DEFAULTS: Record<string, string> = {
  max_open_trades: "4",
  equity_pct_per_trade: "22",
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
  total_capital: "10000",
  scan_interval_seconds: "30",
  scan_stagger_seconds: "10",
  paper_equity_pct_per_trade: "13",
  live_equity_pct_per_trade: "22",
  paper_max_open_trades: "4",
  live_max_open_trades: "3",
  ai_verification_enabled: "false",
  enabled_symbols: ALL_SYMBOLS_DEFAULT,
  paper_max_daily_loss_pct: "5",
  live_max_daily_loss_pct: "3",
  paper_max_weekly_loss_pct: "12",
  live_max_weekly_loss_pct: "8",
  paper_max_drawdown_pct: "20",
  live_max_drawdown_pct: "15",
  min_composite_score: "85",
  min_ev_threshold: "0.003",
  min_rr_ratio: "1.5",
  scoring_weight_regime_fit: "16.67",
  scoring_weight_setup_quality: "16.67",
  scoring_weight_trend_alignment: "16.67",
  scoring_weight_volatility_condition: "16.67",
  scoring_weight_reward_risk: "16.67",
  scoring_weight_probability_of_success: "16.67",
  paper_capital: "10000",
  demo_capital: "600",
  real_capital: "600",
  demo_equity_pct_per_trade: "22",
  real_equity_pct_per_trade: "22",
  demo_max_open_trades: "3",
  real_max_open_trades: "3",
  demo_max_daily_loss_pct: "3",
  real_max_daily_loss_pct: "3",
  demo_max_weekly_loss_pct: "8",
  real_max_weekly_loss_pct: "8",
  demo_max_drawdown_pct: "15",
  real_max_drawdown_pct: "15",
  paper_mode_active: "false",
  demo_mode_active: "false",
  real_mode_active: "false",
  paper_tp_multiplier_strong: "2.5",
  paper_tp_multiplier_medium: "2.0",
  paper_tp_multiplier_weak: "1.5",
  paper_sl_ratio: "1.0",
  paper_trailing_stop_buffer_pct: "0.3",
  paper_time_exit_window_hours: "72",
  paper_allocation_mode: "balanced",
  paper_scan_interval_seconds: "30",
  paper_scan_stagger_seconds: "10",
  paper_min_composite_score: "85",
  paper_min_ev_threshold: "0.003",
  paper_min_rr_ratio: "1.5",
  paper_scoring_weight_regime_fit: "16.67",
  paper_scoring_weight_setup_quality: "16.67",
  paper_scoring_weight_trend_alignment: "16.67",
  paper_scoring_weight_volatility_condition: "16.67",
  paper_scoring_weight_reward_risk: "16.67",
  paper_scoring_weight_probability_of_success: "16.67",
  paper_enabled_symbols: ALL_SYMBOLS_DEFAULT,
  paper_enabled_strategies: ALL_STRATEGIES_DEFAULT,
  demo_tp_multiplier_strong: "2.5",
  demo_tp_multiplier_medium: "2.0",
  demo_tp_multiplier_weak: "1.5",
  demo_sl_ratio: "1.0",
  demo_trailing_stop_buffer_pct: "0.3",
  demo_time_exit_window_hours: "72",
  demo_allocation_mode: "balanced",
  demo_scan_interval_seconds: "30",
  demo_scan_stagger_seconds: "10",
  demo_min_composite_score: "85",
  demo_min_ev_threshold: "0.003",
  demo_min_rr_ratio: "1.5",
  demo_scoring_weight_regime_fit: "16.67",
  demo_scoring_weight_setup_quality: "16.67",
  demo_scoring_weight_trend_alignment: "16.67",
  demo_scoring_weight_volatility_condition: "16.67",
  demo_scoring_weight_reward_risk: "16.67",
  demo_scoring_weight_probability_of_success: "16.67",
  demo_enabled_symbols: ALL_SYMBOLS_DEFAULT,
  demo_enabled_strategies: ALL_STRATEGIES_DEFAULT,
  real_tp_multiplier_strong: "2.5",
  real_tp_multiplier_medium: "2.0",
  real_tp_multiplier_weak: "1.5",
  real_sl_ratio: "1.0",
  real_trailing_stop_buffer_pct: "0.3",
  real_time_exit_window_hours: "72",
  real_allocation_mode: "balanced",
  real_scan_interval_seconds: "30",
  real_scan_stagger_seconds: "10",
  real_min_composite_score: "85",
  real_min_ev_threshold: "0.003",
  real_min_rr_ratio: "1.5",
  real_scoring_weight_regime_fit: "16.67",
  real_scoring_weight_setup_quality: "16.67",
  real_scoring_weight_trend_alignment: "16.67",
  real_scoring_weight_volatility_condition: "16.67",
  real_scoring_weight_reward_risk: "16.67",
  real_scoring_weight_probability_of_success: "16.67",
  real_enabled_symbols: ALL_SYMBOLS_DEFAULT,
  real_enabled_strategies: ALL_STRATEGIES_DEFAULT,
  ai_recommended_strategies: "",
  ai_recommended_symbols: "",
};

const API_KEY_KEYS = ["deriv_api_token", "deriv_api_token_demo", "deriv_api_token_real", "openai_api_key"];

const ALL_SETTING_KEYS = Object.keys(SETTING_DEFAULTS);

const MODE_PREFIXES = ["paper", "demo", "real"] as const;
const INHERITABLE_SUFFIXES = [
  "tp_multiplier_strong", "tp_multiplier_medium", "tp_multiplier_weak",
  "sl_ratio", "trailing_stop_buffer_pct", "time_exit_window_hours",
  "allocation_mode", "scan_interval_seconds", "scan_stagger_seconds",
  "equity_pct_per_trade", "max_open_trades",
  "max_daily_loss_pct", "max_weekly_loss_pct", "max_drawdown_pct",
  "min_composite_score", "min_ev_threshold", "min_rr_ratio",
  "scoring_weight_regime_fit", "scoring_weight_setup_quality",
  "scoring_weight_trend_alignment", "scoring_weight_volatility_condition",
  "scoring_weight_reward_risk", "scoring_weight_probability_of_success",
  "enabled_symbols", "enabled_strategies",
];

function getLegacyFallbackKey(modeKey: string): string | null {
  for (const prefix of MODE_PREFIXES) {
    if (modeKey.startsWith(`${prefix}_`)) {
      const suffix = modeKey.slice(prefix.length + 1);
      if (INHERITABLE_SUFFIXES.includes(suffix)) {
        return suffix;
      }
    }
  }
  return null;
}

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
      const legacyKey = getLegacyFallbackKey(key);
      if (legacyKey && stateMap[legacyKey] !== undefined) {
        settings[key] = stateMap[legacyKey];
      } else {
        settings[key] = SETTING_DEFAULTS[key];
      }
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

    const BOOLEAN_KEYS = ["kill_switch", "ai_verification_enabled", "paper_mode_active", "demo_mode_active", "real_mode_active"];
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
  }

  res.json({ success: true, message: `Updated ${updates.length} setting(s)` });
});

router.get("/settings/api-key-status", async (_req, res): Promise<void> => {
  const states = await db.select().from(platformStateTable);
  const stateMap: Record<string, string> = {};
  for (const s of states) stateMap[s.key] = s.value;

  res.json({
    deriv_api_token_set: !!(stateMap["deriv_api_token"] || stateMap["deriv_api_token_demo"] || stateMap["deriv_api_token_real"]),
    deriv_api_token_demo_set: !!(stateMap["deriv_api_token_demo"] || stateMap["deriv_api_token"]),
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
  const suggestionKey = `ai_suggestion_${key}`;

  const rows = await db.select().from(platformStateTable).where(eq(platformStateTable.key, aiKey));
  if (rows.length > 0) {
    await db
      .insert(platformStateTable)
      .values({ key: suggestionKey, value: rows[0].value })
      .onConflictDoUpdate({ target: platformStateTable.key, set: { value: rows[0].value, updatedAt: new Date() } });
    await db.delete(platformStateTable).where(eq(platformStateTable.key, aiKey));
  }

  const states = await db.select().from(platformStateTable);
  const remaining = states.some(s => s.key.startsWith("ai_") && !s.key.startsWith("ai_settings_") && !s.key.startsWith("ai_optimised") && !s.key.startsWith("ai_suggestion_"));
  if (!remaining) {
    await db
      .insert(platformStateTable)
      .values({ key: "ai_settings_locked", value: "false" })
      .onConflictDoUpdate({ target: platformStateTable.key, set: { value: "false", updatedAt: new Date() } });
  }

  res.json({ success: true, message: `Override applied for ${key}` });
});

router.post("/settings/ai-revert", async (req, res): Promise<void> => {
  const { key } = req.body as { key?: string };
  if (!key || !AI_LOCKABLE_KEYS.includes(key)) {
    res.status(400).json({ success: false, message: "Invalid key" });
    return;
  }

  const aiKey = `ai_${key}`;
  const suggestionKey = `ai_suggestion_${key}`;

  const suggestionRows = await db.select().from(platformStateTable).where(eq(platformStateTable.key, suggestionKey));
  if (suggestionRows.length === 0) {
    res.status(404).json({ success: false, message: "No AI suggestion found for this key" });
    return;
  }

  const suggestedValue = suggestionRows[0].value;

  await db
    .insert(platformStateTable)
    .values({ key: aiKey, value: suggestedValue })
    .onConflictDoUpdate({ target: platformStateTable.key, set: { value: suggestedValue, updatedAt: new Date() } });

  await db
    .insert(platformStateTable)
    .values({ key, value: suggestedValue })
    .onConflictDoUpdate({ target: platformStateTable.key, set: { value: suggestedValue, updatedAt: new Date() } });

  await db.delete(platformStateTable).where(eq(platformStateTable.key, suggestionKey));

  const states = await db.select().from(platformStateTable);
  const anyLocked = states.some(s => s.key.startsWith("ai_") && !s.key.startsWith("ai_settings_") && !s.key.startsWith("ai_optimised") && !s.key.startsWith("ai_suggestion_"));
  if (anyLocked) {
    await db
      .insert(platformStateTable)
      .values({ key: "ai_settings_locked", value: "true" })
      .onConflictDoUpdate({ target: platformStateTable.key, set: { value: "true", updatedAt: new Date() } });
  }

  res.json({ success: true, message: `Reverted ${key} to AI suggestion (${suggestedValue})`, value: suggestedValue });
});

router.get("/settings/ai-status", async (_req, res): Promise<void> => {
  const states = await db.select().from(platformStateTable);
  const stateMap: Record<string, string> = {};
  for (const s of states) stateMap[s.key] = s.value;

  const locked = stateMap["ai_settings_locked"] === "true";
  const optimisedAt = stateMap["ai_optimised_at"] || null;

  const aiValues: Record<string, string> = {};
  const aiSuggestions: Record<string, string> = {};
  for (const key of AI_LOCKABLE_KEYS) {
    const aiKey = `ai_${key}`;
    const suggestionKey = `ai_suggestion_${key}`;
    if (stateMap[aiKey] !== undefined) aiValues[key] = stateMap[aiKey];
    if (stateMap[suggestionKey] !== undefined) aiSuggestions[key] = stateMap[suggestionKey];
  }

  const lastMonthlyOptimise = stateMap["last_monthly_optimise_month"] || null;
  const nextScheduled = (() => {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return next.toISOString();
  })();

  res.json({
    locked,
    optimisedAt,
    aiValues,
    aiSuggestions,
    lockedKeys: locked ? Object.keys(aiValues) : [],
    overriddenKeys: Object.keys(aiSuggestions),
    lastMonthlyOptimise,
    nextScheduled,
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
