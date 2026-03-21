import { computeFeatures } from "./features.js";
import { runAllStrategies } from "./strategies.js";
import { routeSignals, logSignalDecisions } from "./signalRouter.js";
import type { ScoringWeights } from "./scoring.js";
import { openPosition, manageOpenPositions } from "./tradeEngine.js";
import { verifySignal } from "./openai.js";
import { db, platformStateTable, tradesTable, candlesTable, backtestRunsTable, backtestTradesTable } from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import { runBacktestSimulation } from "./backtestEngine.js";
import { getActiveModes, isAnyModeActive } from "./deriv.js";
import type { TradingMode } from "./deriv.js";
import type { AllocationDecision } from "./signalRouter.js";

const DEFAULT_SYMBOLS = [
  "BOOM1000", "CRASH1000", "BOOM500", "CRASH500",
  "BOOM300", "CRASH300", "BOOM200", "CRASH200",
  "R_75", "R_100", "JD75", "STPIDX", "RDBEAR"
];
const DEFAULT_SCAN_INTERVAL_MS = 30_000;
const DEFAULT_STAGGER_SECONDS = 10;
const POSITION_MGMT_INTERVAL_MS = 10_000;

let schedulerHandle: ReturnType<typeof setInterval> | null = null;
let positionMgmtHandle: ReturnType<typeof setInterval> | null = null;
let currentIntervalMs = DEFAULT_SCAN_INTERVAL_MS;

let staggeredScanActive = false;
let staggerSymbolIndex = 0;
let staggerTimerHandle: ReturnType<typeof setTimeout> | null = null;

function parseScoringWeights(stateMap: Record<string, string>): ScoringWeights | undefined {
  const keys: (keyof ScoringWeights)[] = [
    "regimeFit", "setupQuality", "trendAlignment",
    "volatilityCondition", "rewardRisk", "probabilityOfSuccess",
  ];
  const stateKeys: Record<keyof ScoringWeights, string> = {
    regimeFit: "scoring_weight_regime_fit",
    setupQuality: "scoring_weight_setup_quality",
    trendAlignment: "scoring_weight_trend_alignment",
    volatilityCondition: "scoring_weight_volatility_condition",
    rewardRisk: "scoring_weight_reward_risk",
    probabilityOfSuccess: "scoring_weight_probability_of_success",
  };
  const hasAny = keys.some(k => stateMap[stateKeys[k]] !== undefined);
  if (!hasAny) return undefined;
  const weights: ScoringWeights = {} as ScoringWeights;
  for (const k of keys) {
    weights[k] = parseFloat(stateMap[stateKeys[k]] || "1");
  }
  return weights;
}

async function scanSingleSymbol(symbol: string, stateMap: Record<string, string>): Promise<void> {
  const features = await computeFeatures(symbol);
  if (!features) return;

  const aiEnabled = stateMap["ai_verification_enabled"] === "true";

  const activeModes = getActiveModes(stateMap);
  if (activeModes.length === 0) return;

  for (const mode of activeModes) {
    const modePrefix = mode === "paper" ? "paper" : mode === "demo" ? "demo" : "real";
    const modeSymbolsRaw = stateMap[`${modePrefix}_enabled_symbols`] || stateMap["enabled_symbols"] || "";
    const modeSymbols = modeSymbolsRaw ? modeSymbolsRaw.split(",").map((s: string) => s.trim()).filter(Boolean) : null;
    if (modeSymbols && !modeSymbols.includes(symbol)) continue;

    const weights = parseScoringWeights(stateMap);
    const candidates = runAllStrategies(features, weights);
    if (candidates.length === 0) continue;

    const allCandidates = candidates.map(c => ({ candidate: c, atr: features.atr14 }));

    const decisions = await routeSignals(allCandidates.map(c => c.candidate), mode);

    const finalDecisions: AllocationDecision[] = [];

    for (const decision of decisions) {
      if (decision.allowed && aiEnabled) {
        try {
          const matchingCandidate = allCandidates.find(c => c.candidate.symbol === decision.signal.symbol && c.candidate.strategyName === decision.signal.strategyName);
          const feats = matchingCandidate ? await computeFeatures(decision.signal.symbol) : null;

          const recentTrades = await db.select().from(tradesTable)
            .where(eq(tradesTable.symbol, decision.signal.symbol))
            .orderBy(desc(tradesTable.entryTs))
            .limit(5);
          const recentWinLoss = recentTrades.length > 0
            ? recentTrades.map(t => `${t.side} ${t.status} PnL:${(t.pnl ?? 0).toFixed(2)}`).join("; ")
            : "No recent trades";

          const last5Candles = await db.select().from(candlesTable)
            .where(and(eq(candlesTable.symbol, decision.signal.symbol), eq(candlesTable.timeframe, "1m")))
            .orderBy(desc(candlesTable.openTs))
            .limit(5);
          const candleDescriptions = last5Candles.length > 0
            ? last5Candles.map((c, i) => `[${i+1}] O:${c.open.toFixed(2)} H:${c.high.toFixed(2)} L:${c.low.toFixed(2)} C:${c.close.toFixed(2)} Vol:${c.tickCount}`).join("; ")
            : "No recent candles";

          const ema20Value = feats ? feats.priceVsEma20 : 0;
          const currentPrice = last5Candles.length > 0 ? last5Candles[0].close : 0;
          const estimatedEma20 = currentPrice > 0 ? currentPrice / (1 + ema20Value) : 0;

          const verdict = await verifySignal({
            symbol: decision.signal.symbol,
            direction: decision.signal.direction,
            confidence: decision.signal.confidence,
            score: decision.signal.score,
            strategyName: decision.signal.strategyName,
            reason: decision.signal.reason,
            rsi14: feats?.rsi14 ?? 50,
            atr14: feats?.atr14 ?? 0.01,
            ema20: estimatedEma20,
            bbWidth: feats?.bbWidth ?? 0,
            zScore: feats?.zScore ?? 0,
            recentCandles: candleDescriptions,
            recentWinLoss,
          });

          if (verdict) {
            decision.aiVerdict = verdict.verdict;
            decision.aiReasoning = verdict.reasoning;
            decision.aiConfidenceAdj = verdict.confidenceAdjustment;

            if (verdict.verdict === "disagree") {
              decision.allowed = false;
              decision.rejectionReason = `AI disagree: ${verdict.reasoning}`;
            } else if (verdict.verdict === "uncertain") {
              decision.capitalAmount = decision.capitalAmount * 0.5;
            }
          }
        } catch (err) {
          decision.allowed = false;
          decision.rejectionReason = `AI verification unavailable: ${err instanceof Error ? err.message : "unknown error"}`;
          decision.aiVerdict = "error";
          decision.aiReasoning = `Verification failed: ${err instanceof Error ? err.message : "unknown error"}`;
        }
      }
      finalDecisions.push(decision);
    }

    if (mode === activeModes[0]) {
      await logSignalDecisions(finalDecisions);
    }

    const allowed = finalDecisions.filter(d => d.allowed);
    for (const decision of allowed) {
      const matchingCandidate = allCandidates.find(c => c.candidate.symbol === decision.signal.symbol && c.candidate.strategyName === decision.signal.strategyName);
      const atr = matchingCandidate?.atr ?? 0.01;
      await openPosition(decision, atr, mode);
    }
  }
}

async function scheduleStaggeredScan(symbols: string[], staggerMs: number): Promise<void> {
  if (staggerSymbolIndex >= symbols.length) {
    staggerSymbolIndex = 0;
  }

  const symbol = symbols[staggerSymbolIndex];
  staggerSymbolIndex++;

  try {
    const freshStates = await db.select().from(platformStateTable);
    const freshMap: Record<string, string> = {};
    for (const s of freshStates) freshMap[s.key] = s.value;
    await scanSingleSymbol(symbol, freshMap);
  } catch (err) {
    console.error(`[Scheduler] Stagger scan error for ${symbol}:`, err instanceof Error ? err.message : err);
  }

  if (staggeredScanActive) {
    staggerTimerHandle = setTimeout(() => scheduleStaggeredScan(symbols, staggerMs), staggerMs);
  }
}

async function scanCycle(): Promise<void> {
  try {
    const states = await db.select().from(platformStateTable);
    const stateMap: Record<string, string> = {};
    for (const s of states) stateMap[s.key] = s.value;

    const configuredInterval = parseInt(stateMap["scan_interval_seconds"] || "30") * 1000;
    if (configuredInterval !== currentIntervalMs && configuredInterval >= 5000) {
      currentIntervalMs = configuredInterval;
      if (schedulerHandle) {
        clearInterval(schedulerHandle);
        schedulerHandle = setInterval(scanCycle, currentIntervalMs);
        console.log(`[Scheduler] Scan interval updated to ${currentIntervalMs / 1000}s (fastest active mode)`);
      }
    }

    const killSwitch = stateMap["kill_switch"] === "true";
    const anyActive = isAnyModeActive(stateMap);

    const legacyMode = stateMap["mode"] || "idle";
    const hasLegacyActive = legacyMode === "paper" || legacyMode === "live";
    const shouldRun = anyActive || hasLegacyActive;

    if (!shouldRun || killSwitch) {
      if (staggeredScanActive) {
        staggeredScanActive = false;
        if (staggerTimerHandle) { clearTimeout(staggerTimerHandle); staggerTimerHandle = null; }
      }
      return;
    }

    if (hasLegacyActive && !anyActive) {
      if (legacyMode === "paper") {
        stateMap["paper_mode_active"] = "true";
      } else if (legacyMode === "live") {
        stateMap["demo_mode_active"] = "true";
      }
    }

    const activeModes = getActiveModes(stateMap);
    const modeSymbolSets = activeModes.map(m => {
      const prefix = m === "paper" ? "paper" : m === "demo" ? "demo" : "real";
      const raw = stateMap[`${prefix}_enabled_symbols`] || stateMap["enabled_symbols"] || "";
      return raw ? raw.split(",").map((s: string) => s.trim()).filter(Boolean) : DEFAULT_SYMBOLS;
    });
    const symbols = [...new Set(modeSymbolSets.flat())];
    if (symbols.length === 0) symbols.push(...DEFAULT_SYMBOLS);

    const staggerSeconds = parseInt(stateMap["scan_stagger_seconds"] || String(DEFAULT_STAGGER_SECONDS));
    const staggerMs = Math.max(staggerSeconds * 1000, 1000);

    if (!staggeredScanActive) {
      staggeredScanActive = true;
      staggerSymbolIndex = 0;
      console.log(`[Scheduler] Starting staggered scan: ${symbols.length} symbols, ${staggerSeconds}s apart`);
      scheduleStaggeredScan(symbols, staggerMs).catch(console.error);
    } else {
      const newStaggerMs = Math.max(parseInt(stateMap["scan_stagger_seconds"] || String(DEFAULT_STAGGER_SECONDS)) * 1000, 1000);
      if (newStaggerMs !== staggerMs) {
        console.log(`[Scheduler] Stagger interval updated to ${newStaggerMs / 1000}s`);
      }
    }
  } catch (err) {
    console.error("[Scheduler] Scan error:", err instanceof Error ? err.message : err);
  }
}

async function positionManagementCycle(): Promise<void> {
  try {
    const states = await db.select().from(platformStateTable);
    const stateMap: Record<string, string> = {};
    for (const s of states) stateMap[s.key] = s.value;

    const anyActive = isAnyModeActive(stateMap);
    const legacyMode = stateMap["mode"] || "idle";
    if (!anyActive && legacyMode === "idle") return;

    await manageOpenPositions();
  } catch (err) {
    console.error("[Scheduler] Position management error:", err instanceof Error ? err.message : err);
  }
}

const MONTHLY_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const STRATEGIES_LIST = ["trend-pullback", "exhaustion-rebound", "volatility-breakout", "spike-hazard", "volatility-expansion", "liquidity-sweep", "macro-bias"] as const;
const AI_LOCKABLE_KEYS = [
  "equity_pct_per_trade", "paper_equity_pct_per_trade", "live_equity_pct_per_trade",
  "tp_multiplier_strong", "tp_multiplier_medium", "tp_multiplier_weak",
  "sl_ratio", "trailing_stop_pct", "time_exit_window_hours",
  "paper_tp_multiplier_strong", "paper_tp_multiplier_medium", "paper_tp_multiplier_weak",
  "paper_sl_ratio", "paper_trailing_stop_pct", "paper_time_exit_window_hours",
  "demo_tp_multiplier_strong", "demo_tp_multiplier_medium", "demo_tp_multiplier_weak",
  "demo_sl_ratio", "demo_trailing_stop_pct", "demo_equity_pct_per_trade", "demo_time_exit_window_hours",
  "real_tp_multiplier_strong", "real_tp_multiplier_medium", "real_tp_multiplier_weak",
  "real_sl_ratio", "real_trailing_stop_pct", "real_equity_pct_per_trade", "real_time_exit_window_hours",
];
let monthlyHandle: ReturnType<typeof setInterval> | null = null;

async function runMonthlyOptimisation(stateMap: Record<string, string>): Promise<void> {
  const enabledSymbols = stateMap["enabled_symbols"]
    ? stateMap["enabled_symbols"].split(",").filter(Boolean)
    : DEFAULT_SYMBOLS;
  const initialCapital = parseFloat(stateMap["total_capital"] || "10000");

  const combinations: { strategy: string; symbol: string }[] = [];
  for (const strategy of STRATEGIES_LIST) {
    for (const symbol of enabledSymbols) {
      combinations.push({ strategy, symbol });
    }
  }

  const agg: Record<string, { tpSum: number; slSum: number; holdSum: number; equitySum: number; count: number }> = {};
  for (const s of STRATEGIES_LIST) agg[s] = { tpSum: 0, slSum: 0, holdSum: 0, equitySum: 0, count: 0 };

  let ran = 0;
  for (const { strategy, symbol } of combinations) {
    try {
      const result = await runBacktestSimulation(strategy, symbol, initialCapital, "balanced");

      await db.insert(backtestRunsTable).values({
        strategyName: strategy,
        symbol,
        initialCapital,
        totalReturn: result.totalReturn,
        netProfit: result.netProfit,
        winRate: result.winRate,
        profitFactor: result.profitFactor,
        maxDrawdown: result.maxDrawdown,
        tradeCount: result.tradeCount,
        avgHoldingHours: result.avgHoldingHours,
        expectancy: result.expectancy,
        sharpeRatio: result.sharpeRatio,
        configJson: { allocationMode: "balanced", symbol, strategyName: strategy, source: "monthly-reoptimise" },
        metricsJson: {
          equityCurve: result.equityCurve,
          grossProfit: result.grossProfit,
          grossLoss: result.grossLoss,
          avgWin: result.avgWin,
          avgLoss: result.avgLoss,
          maxDrawdownDuration: result.maxDrawdownDuration,
          monthlyReturns: result.monthlyReturns,
          returnBySymbol: result.returnBySymbol,
          returnByRegime: result.returnByRegime,
        },
        status: "completed",
      });

      const r = agg[strategy];
      r.count++;
      r.holdSum += result.avgHoldingHours;
      const optTp = result.profitFactor > 0 ? Math.min(Math.max(1.5 + result.profitFactor * 0.4, 1.2), 4.0) : 2.0;
      const optSl = result.profitFactor > 0 ? Math.min(Math.max(1.0 / result.profitFactor, 0.5), 2.0) : 1.0;
      r.tpSum += optTp;
      r.slSum += optSl;
      r.equitySum += Math.min(Math.max(result.winRate * 4, 0.5), 5.0);
      ran++;
    } catch { /* skip failed */ }
  }

  const comboResults: { strategy: string; symbol: string; pf: number; hold: number; score: number }[] = [];
  for (const { strategy, symbol } of combinations) {
    try {
      const result = await runBacktestSimulation(strategy, symbol, initialCapital, "balanced");
      if (result.tradeCount >= 3) {
        comboResults.push({
          strategy, symbol,
          pf: result.profitFactor,
          hold: result.avgHoldingHours,
          score: (result.sharpeRatio * 0.4) + (result.winRate * 0.25) + (result.profitFactor * 0.2) + (result.expectancy * 0.15),
        });
      }
    } catch { /* skip */ }
  }

  const sortedCombos = [...comboResults].sort((a, b) => b.score - a.score);
  const topCombos = sortedCombos.slice(0, Math.min(6, sortedCombos.length));
  const bestPf = topCombos.length > 0 ? topCombos.reduce((s, c) => s + c.pf, 0) / topCombos.length : 1.5;
  const bestHold = topCombos.length > 0 ? topCombos.reduce((s, c) => s + c.hold, 0) / topCombos.length : 72;

  const optTpStrong = parseFloat(Math.min(Math.max(1.8 + bestPf * 0.5, 2.5), 4.0).toFixed(2));
  const optTpMed = parseFloat(Math.min(Math.max(1.5 + bestPf * 0.35, 2.0), 3.5).toFixed(2));
  const optTpWeak = parseFloat(Math.min(Math.max(1.2 + bestPf * 0.25, 1.5), 2.5).toFixed(2));
  const optSl = parseFloat(Math.min(Math.max(0.8, 1.0 / bestPf), 1.5).toFixed(2));
  const optHold = parseFloat(Math.max(48, Math.min(bestHold * 1.3, 168)).toFixed(1));
  const optEquity = 22;

  const nowIso = new Date().toISOString();
  const currentMonthKey = `${new Date().getFullYear()}-${new Date().getMonth() + 1}`;

  const aiSettings: Record<string, string> = {
    ai_equity_pct_per_trade: String(optEquity),
    ai_paper_equity_pct_per_trade: String(Math.min(optEquity * 0.7, 18).toFixed(2)),
    ai_live_equity_pct_per_trade: String(optEquity),
    ai_tp_multiplier_strong: String(optTpStrong),
    ai_tp_multiplier_medium: String(optTpMed),
    ai_tp_multiplier_weak: String(optTpWeak),
    ai_sl_ratio: String(optSl),
    ai_time_exit_window_hours: String(optHold),
    ai_settings_locked: "true",
    ai_optimised_at: nowIso,
    last_monthly_optimise_month: currentMonthKey,
    last_monthly_optimise_at: nowIso,
  };

  for (const [key, value] of Object.entries(aiSettings)) {
    await db.insert(platformStateTable).values({ key, value })
      .onConflictDoUpdate({ target: platformStateTable.key, set: { value, updatedAt: new Date() } });
  }

  for (const key of AI_LOCKABLE_KEYS) {
    await db.delete(platformStateTable).where(eq(platformStateTable.key, `ai_suggestion_${key}`));
  }

  console.log(`[Scheduler] Monthly re-optimisation complete — ${ran} backtests, settings re-locked.`);
}

async function monthlyOptimisationCycle(): Promise<void> {
  try {
    const states = await db.select().from(platformStateTable);
    const stateMap: Record<string, string> = {};
    for (const s of states) stateMap[s.key] = s.value;

    if (stateMap["initial_setup_complete"] !== "true") return;

    const now = new Date();
    const currentMonthKey = `${now.getFullYear()}-${now.getMonth() + 1}`;
    if (stateMap["last_monthly_optimise_month"] === currentMonthKey) return;

    console.log(`[Scheduler] New month detected (${currentMonthKey}) — starting rolling re-optimisation...`);
    await runMonthlyOptimisation(stateMap);
  } catch (err) {
    console.error("[Scheduler] Monthly optimisation error:", err instanceof Error ? err.message : err);
  }
}

export function startScheduler(): void {
  if (schedulerHandle) return;
  console.log(`[Scheduler] Starting signal scan every ${currentIntervalMs / 1000}s`);
  schedulerHandle = setInterval(scanCycle, currentIntervalMs);
  setTimeout(scanCycle, 5000);

  console.log(`[Scheduler] Starting position management every ${POSITION_MGMT_INTERVAL_MS / 1000}s`);
  positionMgmtHandle = setInterval(positionManagementCycle, POSITION_MGMT_INTERVAL_MS);
  setTimeout(positionManagementCycle, 8000);

  console.log(`[Scheduler] Starting monthly re-optimisation check (hourly)`);
  monthlyHandle = setInterval(monthlyOptimisationCycle, MONTHLY_CHECK_INTERVAL_MS);
  setTimeout(monthlyOptimisationCycle, 15000);
}

export function stopScheduler(): void {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
    console.log("[Scheduler] Signal scanner stopped.");
  }
  if (positionMgmtHandle) {
    clearInterval(positionMgmtHandle);
    positionMgmtHandle = null;
    console.log("[Scheduler] Position manager stopped.");
  }
  if (monthlyHandle) {
    clearInterval(monthlyHandle);
    monthlyHandle = null;
    console.log("[Scheduler] Monthly optimiser stopped.");
  }
  staggeredScanActive = false;
  if (staggerTimerHandle) {
    clearTimeout(staggerTimerHandle);
    staggerTimerHandle = null;
  }
}
