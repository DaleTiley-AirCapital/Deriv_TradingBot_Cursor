import { computeFeatures } from "./features.js";
import { runAllStrategies } from "./strategies.js";
import { routeSignals, logSignalDecisions } from "./signalRouter.js";
import { type ScoringWeights, DEFAULT_SCORING_WEIGHTS } from "./scoring.js";
import { openPosition, manageOpenPositions } from "./tradeEngine.js";
import { verifySignal } from "./openai.js";
import { classifyRegime, classifyRegimeFromHTF, classifyInstrument, getCachedRegime, cacheRegime, accumulateHourlyFeatures } from "./regimeEngine.js";
import { db, platformStateTable, tradesTable, candlesTable, backtestRunsTable, backtestTradesTable } from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import { runBacktestSimulation } from "./backtestEngine.js";
import { getActiveModes, isAnyModeActive } from "./deriv.js";
import type { TradingMode } from "./deriv.js";
import type { AllocationDecision } from "./signalRouter.js";
import { confirmSignal, removePendingSignal, expireStaleSignals, shouldEvaluateWindow, getWindowTs, invalidateUnconfirmedPending } from "./pendingSignals.js";

import { ACTIVE_TRADING_SYMBOLS } from "./deriv.js";

const DEFAULT_SYMBOLS = ACTIVE_TRADING_SYMBOLS;
const DEFAULT_SCAN_INTERVAL_MS = 60_000;
const DEFAULT_STAGGER_SECONDS = 10;

async function dbWithRetry<T>(fn: () => Promise<T>, label: string, maxAttempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Scheduler] DB retry ${attempt}/${maxAttempts} for "${label}": ${msg}`);
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  throw lastErr;
}

const POSITION_MGMT_INTERVAL_MS = 10_000;

const STRATEGY_FAMILIES = ["trend_continuation", "mean_reversion", "spike_cluster_recovery", "swing_exhaustion", "trendline_breakout"] as const;

let schedulerHandle: ReturnType<typeof setInterval> | null = null;
let positionMgmtHandle: ReturnType<typeof setInterval> | null = null;
let currentIntervalMs = DEFAULT_SCAN_INTERVAL_MS;

let staggeredScanActive = false;
let staggerSymbolIndex = 0;
let staggerTimerHandle: ReturnType<typeof setTimeout> | null = null;

let lastScanTime: Date | null = null;
let lastScanSymbol: string | null = null;
let totalScansRun = 0;
let totalDecisionsLogged = 0;

export function getSchedulerStatus() {
  return {
    running: schedulerHandle !== null,
    lastScanTime: lastScanTime?.toISOString() ?? null,
    lastScanSymbol,
    totalScansRun,
    totalDecisionsLogged,
    scanIntervalMs: currentIntervalMs,
  };
}

function parseScoringWeights(stateMap: Record<string, string>): ScoringWeights | undefined {
  const keys: (keyof ScoringWeights)[] = [
    "rangePosition", "maDeviation", "volatilityProfile",
    "rangeExpansion", "directionalConfirmation",
  ];
  const stateKeys: Record<keyof ScoringWeights, string> = {
    rangePosition: "scoring_weight_range_position",
    maDeviation: "scoring_weight_ma_deviation",
    volatilityProfile: "scoring_weight_volatility_profile",
    rangeExpansion: "scoring_weight_range_expansion",
    directionalConfirmation: "scoring_weight_directional_confirmation",
  };
  const hasAny = keys.some(k => stateMap[stateKeys[k]] !== undefined);
  if (!hasAny) return undefined;
  const weights: ScoringWeights = {} as ScoringWeights;
  for (const k of keys) {
    weights[k] = parseFloat(stateMap[stateKeys[k]] || String(DEFAULT_SCORING_WEIGHTS[k]));
  }
  return weights;
}

async function scanSingleSymbol(symbol: string, stateMap: Record<string, string>): Promise<void> {
  lastScanTime = new Date();
  lastScanSymbol = symbol;
  totalScansRun++;

  const features = await computeFeatures(symbol);
  if (!features) {
    console.log(`[Scan] ${symbol} | SKIP | reason=insufficient_data`);
    return;
  }

  accumulateHourlyFeatures(features);

  const cachedRegime = await getCachedRegime(symbol);
  const regime = cachedRegime ?? classifyRegimeFromHTF(features);
  if (!cachedRegime) {
    await cacheRegime(symbol, regime);
  }

  const latestCandleCloseMs = features.latestCandleCloseTs ? new Date(features.latestCandleCloseTs).getTime() : undefined;
  const isNewWindow = shouldEvaluateWindow(symbol, latestCandleCloseMs);

  if (!isNewWindow) {
    return;
  }

  expireStaleSignals();

  if (regime.allowedFamilies.length === 0) {
    console.log(`[Scan] ${symbol} | regime=${regime.regime} | SKIP=no_allowed_families`);
    invalidateUnconfirmedPending(symbol, new Set());
    return;
  }

  const weights = parseScoringWeights(stateMap);
  const candidates = runAllStrategies(features, weights, regime);
  if (candidates.length === 0) {
    console.log(`[Scan] ${symbol} | regime=${regime.regime} | families=[${regime.allowedFamilies.join(",")}] | candidates=0 | SKIP=no_signals`);
    invalidateUnconfirmedPending(symbol, new Set());
    return;
  }

  console.log(`[Intel] ${symbol} | regime=${regime.regime} | families=[${regime.allowedFamilies.join(",")}] | candidates=${candidates.length} | top=${candidates[0].strategyFamily}(${candidates[0].score.toFixed(3)}, EV=${candidates[0].expectedValue.toFixed(4)})`);

  const windowTs = getWindowTs();

  const aiEnabled = stateMap["ai_verification_enabled"] === "true";

  const activeModes = getActiveModes(stateMap);

  const modesToProcess: TradingMode[] = activeModes.length > 0 ? activeModes : ["paper" as TradingMode];
  const isIntelOnly = activeModes.length === 0;

  for (const mode of modesToProcess) {
    const modePrefix = mode === "paper" ? "paper" : mode === "demo" ? "demo" : "real";
    if (!isIntelOnly) {
      const modeSymbolsRaw = stateMap[`${modePrefix}_enabled_symbols`] || stateMap["enabled_symbols"] || "";
      const modeSymbols = modeSymbolsRaw ? modeSymbolsRaw.split(",").map((s: string) => s.trim()).filter(Boolean) : null;
      if (modeSymbols && !modeSymbols.includes(symbol)) continue;
    }

    const effectiveMode = isIntelOnly ? "paper" : mode;
    const logMode = isIntelOnly ? undefined : mode;

    const openSymbolTrades = await db.select().from(tradesTable)
      .where(and(eq(tradesTable.status, "open"), eq(tradesTable.symbol, symbol), eq(tradesTable.mode, effectiveMode)));
    const existingPositionCount = openSymbolTrades.length;

    const promotedCandidates: { candidate: typeof candidates[0]; atr: number }[] = [];
    const confirmedKeysThisWindow = new Set<string>();

    for (const candidate of candidates) {
      if ((candidate.compositeScore ?? 0) < 75) {
        continue;
      }
      const currentPrice = features.latestClose ?? 0;
      const family = candidate.strategyFamily || candidate.strategyName;
      const result = confirmSignal(candidate, windowTs, currentPrice, existingPositionCount, effectiveMode);
      const candidateKey = `${candidate.symbol}|${family}|${candidate.direction}|${effectiveMode}`;
      confirmedKeysThisWindow.add(candidateKey);

      if (result.promoted) {
        console.log(`[Confirm] ${symbol} | ${candidate.strategyName} | dir=${candidate.direction} | PROMOTED after ${result.pending.confirmCount}/${result.pending.requiredConfirmations} windows | pyramid=${result.pending.pyramidLevel} | mode=${effectiveMode}`);
        promotedCandidates.push({ candidate, atr: features.atr14 });
        removePendingSignal(symbol, family, candidate.direction, effectiveMode);
      } else {
        console.log(`[Confirm] ${symbol} | ${candidate.strategyName} | dir=${candidate.direction} | window=${result.pending.confirmCount}/${result.pending.requiredConfirmations} | score=${candidate.compositeScore} | EV=${candidate.expectedValue.toFixed(4)}`);
      }
    }

    invalidateUnconfirmedPending(symbol, confirmedKeysThisWindow, effectiveMode);

    const promotedCandidateSignals = promotedCandidates.map(c => c.candidate);
    const promotedSet = new Set(promotedCandidateSignals.map(c => {
      const family = c.strategyFamily || c.strategyName;
      return `${c.symbol}|${family}|${c.direction}|${effectiveMode}`;
    }));

    const execDecisions = promotedCandidateSignals.length > 0
      ? await routeSignals(promotedCandidateSignals, effectiveMode)
      : [];

    for (const decision of execDecisions) {
      const compositeScore = decision.signal.compositeScore ?? 0;

      if (!decision.allowed) {
        decision.aiVerdict = "skipped";
        decision.aiReasoning = `AI check skipped — signal blocked by system: ${decision.rejectionReason || "unknown"}`;
      } else if (aiEnabled && compositeScore >= 75) {
        try {
          const feats = await computeFeatures(decision.signal.symbol);

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
            strategyFamily: decision.signal.strategyFamily || "trend_continuation",
            reason: decision.signal.reason,
            rsi14: feats?.rsi14 ?? 50,
            atr14: feats?.atr14 ?? 0.01,
            ema20: estimatedEma20,
            bbWidth: feats?.bbWidth ?? 0,
            zScore: feats?.zScore ?? 0,
            recentCandles: candleDescriptions,
            recentWinLoss,
            regimeState: decision.signal.regimeState || regime.regime,
            regimeConfidence: decision.signal.regimeConfidence || regime.confidence,
            instrumentFamily: classifyInstrument(decision.signal.symbol),
            macroBiasModifier: 0,
            compositeScore: decision.signal.compositeScore,
            expectedValue: decision.signal.expectedValue,
            swingHigh: feats?.swingHigh ?? undefined,
            swingLow: feats?.swingLow ?? undefined,
            fibRetraceLevels: feats?.fibRetraceLevels ?? undefined,
            fibExtensionLevels: feats?.fibExtensionLevels ?? undefined,
            fibExtensionLevelsDown: feats?.fibExtensionLevelsDown ?? undefined,
            latestClose: feats?.latestClose ?? currentPrice,
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

      if (isIntelOnly) {
        decision.allowed = false;
        if (!decision.rejectionReason) {
          decision.rejectionReason = "No execution mode active — intelligence only";
        }
      }
    }

    const allDecisionsForLog: AllocationDecision[] = [];

    for (const candidate of candidates) {
      const family = candidate.strategyFamily || candidate.strategyName;
      const candidateKey = `${candidate.symbol}|${family}|${candidate.direction}|${effectiveMode}`;
      const isPromoted = promotedSet.has(candidateKey);

      const execMatch = execDecisions.find(d => {
        const dFamily = d.signal.strategyFamily || d.signal.strategyName;
        return d.signal.symbol === candidate.symbol &&
          dFamily === family &&
          d.signal.direction === candidate.direction;
      });

      if (isPromoted && execMatch) {
        const sig = execMatch.signal;
        const composite = sig.compositeScore ?? 0;
        const modeTag = isIntelOnly ? "intel" : mode;
        const aiTag = execMatch.aiVerdict ? ` | ai=${execMatch.aiVerdict}` : "";
        const allocTag = execMatch.allowed ? ` | alloc=${((execMatch.capitalAmount ?? 0)).toFixed(2)}` : "";
        const rejectTag = !execMatch.allowed && execMatch.rejectionReason ? ` | reject=${execMatch.rejectionReason}` : "";
        console.log(`[Scan] ${sig.symbol} | ${modeTag} | family=${sig.strategyFamily || sig.strategyName} | dir=${sig.direction} | score=${sig.score.toFixed(3)} | EV=${sig.expectedValue.toFixed(4)} | composite=${composite}${aiTag}${allocTag}${rejectTag} | CONFIRMED | ${execMatch.allowed ? "EXECUTE" : "BLOCKED"}`);
        allDecisionsForLog.push(execMatch);
      } else {
        const logDecision: AllocationDecision = {
          signal: candidate,
          allowed: false,
          capitalAmount: 0,
          capitalAllocationPct: 0,
          rejectionReason: "Awaiting multi-window confirmation (not yet promoted)",
          aiVerdict: "skipped",
          aiReasoning: "Signal pending confirmation — AI check deferred",
        };
        const sig = candidate;
        const composite = sig.compositeScore ?? 0;
        const modeTag = isIntelOnly ? "intel" : mode;
        console.log(`[Scan] ${sig.symbol} | ${modeTag} | family=${sig.strategyFamily || sig.strategyName} | dir=${sig.direction} | score=${sig.score.toFixed(3)} | EV=${sig.expectedValue.toFixed(4)} | composite=${composite} | reject=awaiting_confirmation | BLOCKED`);
        allDecisionsForLog.push(logDecision);
      }
    }

    try {
      await logSignalDecisions(allDecisionsForLog, logMode);
      totalDecisionsLogged += allDecisionsForLog.length;
    } catch (err) {
      console.error(`[Scheduler] Failed to log ${allDecisionsForLog.length} signal decisions:`, err instanceof Error ? err.message : err);
    }

    if (!isIntelOnly && promotedCandidates.length > 0) {
      const allowedExec = execDecisions.filter(d => d.allowed);
      for (const decision of allowedExec) {
        const matchingCandidate = promotedCandidates.find(c => c.candidate.symbol === decision.signal.symbol && c.candidate.strategyName === decision.signal.strategyName);
        const atr = matchingCandidate?.atr ?? 0.01;
        await openPosition(decision, atr, mode);
        console.log(`[Exec] ${decision.signal.symbol} | ${mode} | ${decision.signal.direction} | family=${decision.signal.strategyFamily || decision.signal.strategyName} | alloc=$${(decision.capitalAmount ?? 0).toFixed(2)} | MULTI-WINDOW-CONFIRMED`);
      }
    }

    if (isIntelOnly) break;
  }
}

async function scheduleStaggeredScan(symbols: string[], staggerMs: number): Promise<void> {
  if (staggerSymbolIndex >= symbols.length) {
    staggerSymbolIndex = 0;
  }

  const symbol = symbols[staggerSymbolIndex];
  staggerSymbolIndex++;

  try {
    const freshStates = await dbWithRetry(
      () => db.select().from(platformStateTable),
      `platform_state read (stagger scan ${symbol})`,
    );
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
    const states = await dbWithRetry(
      () => db.select().from(platformStateTable),
      "platform_state read (scan cycle)",
    );
    const stateMap: Record<string, string> = {};
    for (const s of states) stateMap[s.key] = s.value;

    const configuredInterval = parseInt(stateMap["scan_interval_seconds"] || "60") * 1000;
    if (configuredInterval !== currentIntervalMs && configuredInterval >= 5000) {
      currentIntervalMs = configuredInterval;
      if (schedulerHandle) {
        clearInterval(schedulerHandle);
        schedulerHandle = setInterval(scanCycle, currentIntervalMs);
        console.log(`[Scheduler] Scan interval updated to ${currentIntervalMs / 1000}s`);
      }
    }

    const killSwitch = stateMap["kill_switch"] === "true";
    const streamingActive = stateMap["streaming"] === "true";

    if (killSwitch || !streamingActive) {
      if (staggeredScanActive) {
        staggeredScanActive = false;
        if (staggerTimerHandle) { clearTimeout(staggerTimerHandle); staggerTimerHandle = null; }
      }
      return;
    }

    const enabledSymbolsRaw = stateMap["enabled_symbols"] || "";
    const symbols = enabledSymbolsRaw
      ? enabledSymbolsRaw.split(",").map((s: string) => s.trim()).filter(Boolean)
      : DEFAULT_SYMBOLS;

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
    const states = await dbWithRetry(
      () => db.select().from(platformStateTable),
      "platform_state read (position management)",
    );
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
const WEEKLY_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const STRATEGIES_LIST = [
  "trend_continuation",
  "mean_reversion",
  "spike_cluster_recovery",
  "swing_exhaustion",
  "trendline_breakout",
] as const;
const AI_LOCKABLE_KEYS = [
  "equity_pct_per_trade", "paper_equity_pct_per_trade", "demo_equity_pct_per_trade", "real_equity_pct_per_trade",
  "max_open_trades", "paper_max_open_trades", "demo_max_open_trades", "real_max_open_trades",
  "min_composite_score", "paper_min_composite_score", "demo_min_composite_score", "real_min_composite_score",
  "min_ev_threshold", "min_rr_ratio",
  "max_daily_loss_pct", "max_weekly_loss_pct", "max_drawdown_pct",
  "correlated_family_cap", "extraction_target_pct",
  "allocation_mode", "paper_allocation_mode", "demo_allocation_mode", "real_allocation_mode",
];
let monthlyHandle: ReturnType<typeof setInterval> | null = null;
let weeklyHandle: ReturnType<typeof setInterval> | null = null;

async function runWeeklyAnalysis(stateMap: Record<string, string>): Promise<void> {
  const closedTrades = await db.select().from(tradesTable).where(eq(tradesTable.status, "closed"));
  if (closedTrades.length < 5) {
    console.log(`[Scheduler] Weekly analysis skipped — only ${closedTrades.length} closed trades (need 5+)`);
    return;
  }

  const modes = ["paper", "demo", "real"] as const;
  const nowIso = new Date().toISOString();
  const suggestions: Record<string, string> = {};

  for (const mode of modes) {
    const modeTrades = closedTrades.filter(t => t.mode === mode);
    if (modeTrades.length < 3) continue;

    const wins = modeTrades.filter(t => (t.pnl ?? 0) > 0);
    const losses = modeTrades.filter(t => (t.pnl ?? 0) <= 0);
    const winRate = wins.length / modeTrades.length;
    const avgPnl = modeTrades.reduce((s, t) => s + (t.pnl ?? 0), 0) / modeTrades.length;

    const avgWinPnl = wins.length > 0 ? wins.reduce((s, t) => s + (t.pnl ?? 0), 0) / wins.length : 0;
    const avgLossPnl = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0) / losses.length) : 1;
    const actualRR = avgLossPnl > 0 ? avgWinPnl / avgLossPnl : 1;

    const tpHits = modeTrades.filter(t => t.exitReason?.includes("tp")).length;
    const slHits = modeTrades.filter(t => t.exitReason?.includes("sl")).length;
    const tpHitRate = modeTrades.length > 0 ? tpHits / modeTrades.length : 0;
    const slHitRate = modeTrades.length > 0 ? slHits / modeTrades.length : 0;

    const currentEquityPct = parseFloat(stateMap[`${mode}_equity_pct_per_trade`] || "15");
    const currentMaxTrades = parseInt(stateMap[`${mode}_max_open_trades`] || "3");
    const currentMaxDaily = parseFloat(stateMap[`${mode}_max_daily_loss_pct`] || "5");
    const currentMaxWeekly = parseFloat(stateMap[`${mode}_max_weekly_loss_pct`] || "10");
    const currentMaxDD = parseFloat(stateMap[`${mode}_max_drawdown_pct`] || "15");

    const conservatism = mode === "real" ? 0.85 : mode === "demo" ? 0.95 : 1.05;

    if (winRate > 0.6 && avgPnl > 0) {
      suggestions[`${mode}_equity_pct_per_trade`] = String(Math.min(currentEquityPct * 1.05 * conservatism, mode === "real" ? 25 : mode === "demo" ? 30 : 40).toFixed(1));
    } else if (winRate < 0.4) {
      suggestions[`${mode}_equity_pct_per_trade`] = String(Math.max(currentEquityPct * 0.9, mode === "real" ? 10 : 8).toFixed(1));
    }

    if (winRate > 0.55 && currentMaxTrades < (mode === "real" ? 4 : 6)) {
      suggestions[`${mode}_max_open_trades`] = String(Math.min(currentMaxTrades + 1, mode === "real" ? 4 : 6));
    } else if (winRate < 0.35 && currentMaxTrades > 2) {
      suggestions[`${mode}_max_open_trades`] = String(Math.max(currentMaxTrades - 1, 2));
    }

    if (winRate < 0.4) {
      suggestions[`${mode}_max_daily_loss_pct`] = String(Math.max(currentMaxDaily * 0.85, 2).toFixed(1));
      suggestions[`${mode}_max_weekly_loss_pct`] = String(Math.max(currentMaxWeekly * 0.85, 4).toFixed(1));
      suggestions[`${mode}_max_drawdown_pct`] = String(Math.max(currentMaxDD * 0.85, 8).toFixed(1));
    } else if (winRate > 0.6 && avgPnl > 0) {
      suggestions[`${mode}_max_daily_loss_pct`] = String(Math.min(currentMaxDaily * 1.1, mode === "real" ? 5 : 10).toFixed(1));
      suggestions[`${mode}_max_weekly_loss_pct`] = String(Math.min(currentMaxWeekly * 1.1, mode === "real" ? 10 : 20).toFixed(1));
    }

    const currentAllocMode = stateMap[`${mode}_allocation_mode`] || "balanced";
    if (winRate > 0.6 && avgPnl > 0 && mode !== "real") {
      if (currentAllocMode === "conservative") suggestions[`${mode}_allocation_mode`] = "balanced";
      if (currentAllocMode === "balanced" && mode === "paper") suggestions[`${mode}_allocation_mode`] = "aggressive";
    } else if (winRate < 0.35) {
      if (currentAllocMode === "aggressive") suggestions[`${mode}_allocation_mode`] = "balanced";
      if (currentAllocMode === "balanced") suggestions[`${mode}_allocation_mode`] = "conservative";
    }

    const currentCorrelatedCap = parseInt(stateMap[`${mode}_correlated_family_cap`] || "3");
    if (winRate > 0.6 && avgPnl > 0 && mode !== "real") {
      suggestions[`${mode}_correlated_family_cap`] = String(Math.min(currentCorrelatedCap + 1, 6));
    } else if (winRate < 0.35) {
      suggestions[`${mode}_correlated_family_cap`] = String(Math.max(currentCorrelatedCap - 1, 1));
    }

    const currentExtractionTarget = parseFloat(stateMap[`${mode}_extraction_target_pct`] || "50");
    if (winRate > 0.6 && avgPnl > 0) {
      suggestions[`${mode}_extraction_target_pct`] = String(Math.max(currentExtractionTarget * 0.9, 20).toFixed(0));
    } else if (winRate < 0.35) {
      suggestions[`${mode}_extraction_target_pct`] = String(Math.min(currentExtractionTarget * 1.1, 200).toFixed(0));
    }

    const regimeDistribution: Record<string, number> = {};
    for (const t of modeTrades) {
      const tradeRegime = (t as Record<string, unknown>).regime as string || "unknown";
      regimeDistribution[tradeRegime] = (regimeDistribution[tradeRegime] || 0) + 1;
    }
    const regimeWinRates: Record<string, number> = {};
    for (const regKey of Object.keys(regimeDistribution)) {
      const regTrades = modeTrades.filter(t => ((t as Record<string, unknown>).regime as string || "unknown") === regKey);
      const regWins = regTrades.filter(t => (t.pnl ?? 0) > 0).length;
      regimeWinRates[regKey] = regTrades.length > 0 ? regWins / regTrades.length : 0;
    }
    const worstRegime = Object.entries(regimeWinRates).sort((a, b) => a[1] - b[1])[0];
    if (worstRegime && worstRegime[1] < 0.25 && (regimeDistribution[worstRegime[0]] || 0) > 3) {
      const curRangeWeight = parseFloat(stateMap["scoring_weight_range_position"] || "25");
      suggestions["scoring_weight_range_position"] = String(Math.min(curRangeWeight * 1.15, 40).toFixed(2));
    }

    const disableFamilies: string[] = [];
    for (const family of STRATEGY_FAMILIES) {
      const ft = modeTrades.filter(t => t.strategyName === family);
      if (ft.length >= 5) {
        const fwr = ft.filter(t => (t.pnl ?? 0) > 0).length / ft.length;
        if (fwr < 0.2) disableFamilies.push(family);
      }
    }
    if (disableFamilies.length > 0 && disableFamilies.length < STRATEGY_FAMILIES.length) {
      const currentEnabled = stateMap[`${mode}_enabled_strategies`] || STRATEGY_FAMILIES.join(",");
      const remaining = currentEnabled.split(",").filter(f => !disableFamilies.includes(f));
      if (remaining.length > 0) {
        suggestions[`${mode}_enabled_strategies`] = remaining.join(",");
      }
    }
  }

  const currentMinScore = parseFloat(stateMap["min_composite_score"] || "80");
  const currentMinEV = parseFloat(stateMap["min_ev_threshold"] || "0.001");
  const currentMinRR = parseFloat(stateMap["min_rr_ratio"] || "1.5");

  const allWinRate = closedTrades.length > 0
    ? closedTrades.filter(t => (t.pnl ?? 0) > 0).length / closedTrades.length : 0.5;

  if (allWinRate < 0.35) {
    suggestions["min_composite_score"] = String(Math.min(currentMinScore + 2, 95).toFixed(0));
    suggestions["min_ev_threshold"] = String(Math.min(currentMinEV * 1.2, 0.01).toFixed(4));
    suggestions["min_rr_ratio"] = String(Math.min(currentMinRR * 1.1, 4.0).toFixed(2));
  } else if (allWinRate > 0.6 && closedTrades.length > 20) {
    suggestions["min_composite_score"] = String(Math.max(currentMinScore - 1, 80).toFixed(0));
  }

  const exitReasons = closedTrades.map(t => t.exitReason || "");
  const tpCount = exitReasons.filter(r => r.includes("tp")).length;
  const totalExits = closedTrades.length;
  if (totalExits > 10 && tpCount / totalExits < 0.25) {
    const curVolProfile = parseFloat(stateMap["scoring_weight_volatility_profile"] || "20");
    suggestions["scoring_weight_volatility_profile"] = String(Math.min(curVolProfile * 1.1, 35).toFixed(2));
    const curDirConfirm = parseFloat(stateMap["scoring_weight_directional_confirmation"] || "20");
    suggestions["scoring_weight_directional_confirmation"] = String(Math.min(curDirConfirm * 1.05, 30).toFixed(2));
  }

  const filteredSuggestions: Record<string, string> = {};
  for (const [key, value] of Object.entries(suggestions)) {
    const current = stateMap[key];
    if (current !== undefined && current !== value) {
      filteredSuggestions[key] = value;
    }
  }

  for (const [key, value] of Object.entries(filteredSuggestions)) {
    const suggestKey = `ai_suggest_${key}`;
    await db.insert(platformStateTable).values({ key: suggestKey, value })
      .onConflictDoUpdate({ target: platformStateTable.key, set: { value, updatedAt: new Date() } });
  }

  await db.insert(platformStateTable).values({ key: "ai_weekly_analysis_at", value: nowIso })
    .onConflictDoUpdate({ target: platformStateTable.key, set: { value: nowIso, updatedAt: new Date() } });

  const tradeCount = closedTrades.length;
  const overallWinRate = allWinRate;
  const increaseSuggestions = Object.values(filteredSuggestions).filter((v, i) => {
    const k = Object.keys(filteredSuggestions)[i];
    return parseFloat(v) > parseFloat(stateMap[k] || "0");
  }).length;
  const decreaseSuggestions = Object.keys(filteredSuggestions).length - increaseSuggestions;
  const trend = increaseSuggestions > decreaseSuggestions ? "more_aggressive" : increaseSuggestions < decreaseSuggestions ? "more_conservative" : "neutral";

  await db.insert(platformStateTable).values({ key: "ai_suggestion_trend", value: trend })
    .onConflictDoUpdate({ target: platformStateTable.key, set: { value: trend, updatedAt: new Date() } });
  await db.insert(platformStateTable).values({ key: "ai_trades_analyzed", value: String(tradeCount) })
    .onConflictDoUpdate({ target: platformStateTable.key, set: { value: String(tradeCount), updatedAt: new Date() } });
  await db.insert(platformStateTable).values({ key: "ai_win_rate_observed", value: String(overallWinRate.toFixed(3)) })
    .onConflictDoUpdate({ target: platformStateTable.key, set: { value: String(overallWinRate.toFixed(3)), updatedAt: new Date() } });

  console.log(`[Scheduler] Weekly analysis complete — ${tradeCount} trades analyzed, ${Object.keys(filteredSuggestions).length} suggestions generated (trend: ${trend}).`);
}

async function weeklyAnalysisCycle(): Promise<void> {
  try {
    const states = await db.select().from(platformStateTable);
    const stateMap: Record<string, string> = {};
    for (const s of states) stateMap[s.key] = s.value;

    if (stateMap["initial_setup_complete"] !== "true") return;

    const now = new Date();
    if (now.getDay() !== 0) return;

    const lastAnalysis = stateMap["ai_weekly_analysis_at"];
    if (lastAnalysis) {
      const lastDate = new Date(lastAnalysis);
      const hoursSince = (now.getTime() - lastDate.getTime()) / 3600000;
      if (hoursSince < 20) return;
    }

    console.log(`[Scheduler] Sunday detected — starting weekly AI analysis...`);
    await runWeeklyAnalysis(stateMap);
  } catch (err) {
    console.error("[Scheduler] Weekly analysis error:", err instanceof Error ? err.message : err);
  }
}

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

  const conservatism = (m: string) => m === "real" ? 0.85 : m === "demo" ? 0.95 : 1.05;
  const optEquityPct = (pf: number, m: string) => {
    const base = Math.min(Math.max(pf * 8, 10), 30);
    return (base * conservatism(m)).toFixed(1);
  };

  const nowIso = new Date().toISOString();
  const currentMonthKey = `${new Date().getFullYear()}-${new Date().getMonth() + 1}`;

  const aiSuggestions: Record<string, string> = {
    ai_suggest_paper_equity_pct_per_trade: optEquityPct(bestPf, "paper"),
    ai_suggest_demo_equity_pct_per_trade: optEquityPct(bestPf, "demo"),
    ai_suggest_real_equity_pct_per_trade: optEquityPct(bestPf, "real"),
    ai_suggest_paper_min_composite_score: String(Math.max(85, Math.round(88 - bestPf * 2))),
    ai_suggest_demo_min_composite_score: String(Math.max(90, Math.round(93 - bestPf * 2))),
    ai_suggest_real_min_composite_score: String(Math.max(92, Math.round(95 - bestPf * 2))),
    ai_optimised_at: nowIso,
    last_monthly_optimise_month: currentMonthKey,
    last_monthly_optimise_at: nowIso,
  };

  for (const [key, value] of Object.entries(aiSuggestions)) {
    await db.insert(platformStateTable).values({ key, value })
      .onConflictDoUpdate({ target: platformStateTable.key, set: { value, updatedAt: new Date() } });
  }

  console.log(`[Scheduler] Monthly re-optimisation complete — ${ran} backtests, suggestions updated (no settings changed).`);
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

  console.log(`[Scheduler] Starting weekly AI analysis check (hourly)`);
  weeklyHandle = setInterval(weeklyAnalysisCycle, WEEKLY_CHECK_INTERVAL_MS);
  setTimeout(weeklyAnalysisCycle, 20000);
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
  if (weeklyHandle) {
    clearInterval(weeklyHandle);
    weeklyHandle = null;
    console.log("[Scheduler] Weekly analyser stopped.");
  }
  staggeredScanActive = false;
  if (staggerTimerHandle) {
    clearTimeout(staggerTimerHandle);
    staggerTimerHandle = null;
  }
}
