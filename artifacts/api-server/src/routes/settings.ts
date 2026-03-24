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

const ALL_SYMBOLS_DEFAULT = "BOOM1000,CRASH1000,BOOM900,CRASH900,BOOM600,CRASH600,BOOM500,CRASH500,BOOM300,CRASH300,R_75,R_100";
const ALL_STRATEGIES_DEFAULT = "trend_continuation,mean_reversion,breakout_expansion,spike_event";

const SETTING_DEFAULTS: Record<string, string> = {
  kill_switch: "false",
  scan_interval_seconds: "30",
  scan_stagger_seconds: "10",
  ai_verification_enabled: "false",
  enabled_symbols: ALL_SYMBOLS_DEFAULT,
  min_composite_score: "80",
  min_ev_threshold: "0.003",
  min_rr_ratio: "3.0",
  scoring_weight_regime_fit: "16.67",
  scoring_weight_setup_quality: "16.67",
  scoring_weight_trend_alignment: "16.67",
  scoring_weight_volatility_condition: "16.67",
  scoring_weight_reward_risk: "16.67",
  scoring_weight_probability_of_success: "16.67",
  ai_recommended_strategies: "",
  ai_recommended_symbols: "",

  paper_mode_active: "false",
  paper_capital: "10000",
  paper_equity_pct_per_trade: "30",
  paper_max_open_trades: "4",
  paper_allocation_mode: "aggressive",
  paper_probe_threshold: "75",
  paper_confirmation_threshold: "80",
  paper_momentum_threshold: "85",
  paper_stage_multiplier_probe: "1.0",
  paper_stage_multiplier_confirmation: "0.90",
  paper_stage_multiplier_momentum: "0.80",
  paper_tp_multiplier_strong: "3.5",
  paper_tp_multiplier_medium: "2.8",
  paper_tp_multiplier_weak: "2.0",
  paper_sl_ratio: "1.0",
  paper_trailing_stop_pct: "20",
  paper_time_exit_window_hours: "336",
  paper_tp_capture_ratio: "0.80",
  paper_min_sl_atr_multiplier: "3.0",
  paper_max_daily_loss_pct: "8",
  paper_max_weekly_loss_pct: "15",
  paper_max_drawdown_pct: "25",
  paper_extraction_target_pct: "50",
  paper_auto_extraction: "false",
  paper_peak_drawdown_exit_pct: "25",
  paper_min_peak_profit_pct: "3",
  paper_large_peak_threshold_pct: "8",
  paper_correlated_family_cap: "4",
  paper_enabled_symbols: ALL_SYMBOLS_DEFAULT,
  paper_enabled_strategies: ALL_STRATEGIES_DEFAULT,
  paper_trend_continuation_tp_atr_multiplier: "10.0",
  paper_trend_continuation_sl_atr_multiplier: "4.0",
  paper_trend_continuation_initial_exit_hours: "168",
  paper_trend_continuation_extension_hours: "48",
  paper_trend_continuation_max_exit_hours: "336",
  paper_trend_continuation_harvest_sensitivity: "0.7",
  paper_mean_reversion_tp_atr_multiplier: "8.0",
  paper_mean_reversion_sl_atr_multiplier: "4.0",
  paper_mean_reversion_initial_exit_hours: "120",
  paper_mean_reversion_extension_hours: "36",
  paper_mean_reversion_max_exit_hours: "240",
  paper_mean_reversion_harvest_sensitivity: "0.9",
  paper_breakout_expansion_tp_atr_multiplier: "12.0",
  paper_breakout_expansion_sl_atr_multiplier: "3.0",
  paper_breakout_expansion_initial_exit_hours: "168",
  paper_breakout_expansion_extension_hours: "48",
  paper_breakout_expansion_max_exit_hours: "336",
  paper_breakout_expansion_harvest_sensitivity: "0.6",
  paper_spike_event_tp_atr_multiplier: "6.0",
  paper_spike_event_sl_atr_multiplier: "3.0",
  paper_spike_event_initial_exit_hours: "72",
  paper_spike_event_extension_hours: "24",
  paper_spike_event_max_exit_hours: "168",
  paper_spike_event_harvest_sensitivity: "1.0",

  demo_mode_active: "false",
  demo_capital: "600",
  demo_equity_pct_per_trade: "20",
  demo_max_open_trades: "3",
  demo_allocation_mode: "balanced",
  demo_probe_threshold: "82",
  demo_confirmation_threshold: "86",
  demo_momentum_threshold: "90",
  demo_stage_multiplier_probe: "0.85",
  demo_stage_multiplier_confirmation: "0.75",
  demo_stage_multiplier_momentum: "0.65",
  demo_tp_multiplier_strong: "3.0",
  demo_tp_multiplier_medium: "2.5",
  demo_tp_multiplier_weak: "1.8",
  demo_sl_ratio: "1.0",
  demo_trailing_stop_pct: "22",
  demo_time_exit_window_hours: "168",
  demo_tp_capture_ratio: "0.70",
  demo_min_sl_atr_multiplier: "3.5",
  demo_max_daily_loss_pct: "5",
  demo_max_weekly_loss_pct: "10",
  demo_max_drawdown_pct: "18",
  demo_extraction_target_pct: "50",
  demo_auto_extraction: "false",
  demo_peak_drawdown_exit_pct: "30",
  demo_min_peak_profit_pct: "3",
  demo_large_peak_threshold_pct: "8",
  demo_correlated_family_cap: "3",
  demo_enabled_symbols: ALL_SYMBOLS_DEFAULT,
  demo_enabled_strategies: ALL_STRATEGIES_DEFAULT,
  demo_trend_continuation_tp_atr_multiplier: "8.0",
  demo_trend_continuation_sl_atr_multiplier: "3.0",
  demo_trend_continuation_initial_exit_hours: "168",
  demo_trend_continuation_extension_hours: "48",
  demo_trend_continuation_max_exit_hours: "336",
  demo_trend_continuation_harvest_sensitivity: "0.8",
  demo_mean_reversion_tp_atr_multiplier: "6.0",
  demo_mean_reversion_sl_atr_multiplier: "3.5",
  demo_mean_reversion_initial_exit_hours: "120",
  demo_mean_reversion_extension_hours: "36",
  demo_mean_reversion_max_exit_hours: "240",
  demo_mean_reversion_harvest_sensitivity: "1.0",
  demo_breakout_expansion_tp_atr_multiplier: "10.0",
  demo_breakout_expansion_sl_atr_multiplier: "2.5",
  demo_breakout_expansion_initial_exit_hours: "168",
  demo_breakout_expansion_extension_hours: "48",
  demo_breakout_expansion_max_exit_hours: "336",
  demo_breakout_expansion_harvest_sensitivity: "0.7",
  demo_spike_event_tp_atr_multiplier: "5.0",
  demo_spike_event_sl_atr_multiplier: "2.0",
  demo_spike_event_initial_exit_hours: "72",
  demo_spike_event_extension_hours: "24",
  demo_spike_event_max_exit_hours: "168",
  demo_spike_event_harvest_sensitivity: "1.1",

  real_mode_active: "false",
  real_capital: "600",
  real_equity_pct_per_trade: "15",
  real_max_open_trades: "3",
  real_allocation_mode: "balanced",
  real_probe_threshold: "88",
  real_confirmation_threshold: "91",
  real_momentum_threshold: "94",
  real_stage_multiplier_probe: "0.70",
  real_stage_multiplier_confirmation: "0.60",
  real_stage_multiplier_momentum: "0.50",
  real_tp_multiplier_strong: "2.5",
  real_tp_multiplier_medium: "2.0",
  real_tp_multiplier_weak: "1.5",
  real_sl_ratio: "1.0",
  real_trailing_stop_pct: "25",
  real_time_exit_window_hours: "168",
  real_tp_capture_ratio: "0.60",
  real_min_sl_atr_multiplier: "4.0",
  real_max_daily_loss_pct: "3",
  real_max_weekly_loss_pct: "6",
  real_max_drawdown_pct: "12",
  real_extraction_target_pct: "50",
  real_auto_extraction: "false",
  real_peak_drawdown_exit_pct: "30",
  real_min_peak_profit_pct: "3",
  real_large_peak_threshold_pct: "8",
  real_correlated_family_cap: "3",
  real_enabled_symbols: ALL_SYMBOLS_DEFAULT,
  real_enabled_strategies: ALL_STRATEGIES_DEFAULT,
  real_trend_continuation_tp_atr_multiplier: "6.0",
  real_trend_continuation_sl_atr_multiplier: "3.5",
  real_trend_continuation_initial_exit_hours: "168",
  real_trend_continuation_extension_hours: "48",
  real_trend_continuation_max_exit_hours: "336",
  real_trend_continuation_harvest_sensitivity: "0.8",
  real_mean_reversion_tp_atr_multiplier: "4.0",
  real_mean_reversion_sl_atr_multiplier: "4.0",
  real_mean_reversion_initial_exit_hours: "120",
  real_mean_reversion_extension_hours: "36",
  real_mean_reversion_max_exit_hours: "240",
  real_mean_reversion_harvest_sensitivity: "1.0",
  real_breakout_expansion_tp_atr_multiplier: "8.0",
  real_breakout_expansion_sl_atr_multiplier: "3.0",
  real_breakout_expansion_initial_exit_hours: "168",
  real_breakout_expansion_extension_hours: "48",
  real_breakout_expansion_max_exit_hours: "336",
  real_breakout_expansion_harvest_sensitivity: "0.7",
  real_spike_event_tp_atr_multiplier: "4.0",
  real_spike_event_sl_atr_multiplier: "2.5",
  real_spike_event_initial_exit_hours: "72",
  real_spike_event_extension_hours: "24",
  real_spike_event_max_exit_hours: "168",
  real_spike_event_harvest_sensitivity: "1.2",
};

const API_KEY_KEYS = ["deriv_api_token_demo", "deriv_api_token_real", "openai_api_key"];

const ALL_SETTING_KEYS = Object.keys(SETTING_DEFAULTS);

const MODE_PREFIXES = ["paper", "demo", "real"] as const;
const INHERITABLE_SUFFIXES = [
  "tp_multiplier_strong", "tp_multiplier_medium", "tp_multiplier_weak",
  "sl_ratio", "trailing_stop_pct", "time_exit_window_hours",
  "allocation_mode",
  "equity_pct_per_trade", "max_open_trades",
  "max_daily_loss_pct", "max_weekly_loss_pct", "max_drawdown_pct",
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

const STRATEGIES = ["trend_continuation", "mean_reversion", "breakout_expansion", "spike_event"];
const DEFAULT_SYMBOLS = [
  "BOOM1000", "CRASH1000", "BOOM900", "CRASH900",
  "BOOM600", "CRASH600", "BOOM500", "CRASH500",
  "BOOM300", "CRASH300",
  "R_75", "R_100",
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
      case "breakout_expansion": {
        const std = Math.sqrt(closes.slice(-20).reduce((acc, c) => acc + (c - ema20) ** 2, 0) / 20);
        signal = std / ema20 < 0.005 && Math.abs(distFromEma) > 0.003;
        direction = distFromEma > 0 ? 1 : -1;
        break;
      }
      case "spike_event":
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

  res.json({
    locked: false,
    optimisedAt,
    aiValues: {},
    aiSuggestions,
    lockedKeys: [],
    overriddenKeys: [],
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
