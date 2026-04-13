import { manageOpenPositions, openPositionV3 } from "../core/tradeEngine.js";
import { verifySignal } from "./openai.js";
import { db, platformStateTable, tradesTable, candlesTable, signalLogTable } from "@workspace/db";
import { eq, desc, and, gte, sql } from "drizzle-orm";
import { getActiveModes, isAnyModeActive } from "./deriv.js";
import type { TradingMode } from "./deriv.js";
import { ACTIVE_TRADING_SYMBOLS } from "./deriv.js";
import { scanSymbolV3 } from "../core/engineRouterV3.js";
import { allocateV3Signal } from "../core/portfolioAllocatorV3.js";
import { promoteBreakevenSls } from "../core/hybridTradeManager.js";

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

/**
 * V3 live scanner — replaces the V2 family-based scanSingleSymbol.
 *
 * Flow: scanSymbolV3 → coordinatorOutput → allocateV3Signal → [AI verify] → openPositionV3
 * V2 strategies.ts / signalRouter.ts are NOT used here (backtest only).
 */
async function scanSingleSymbolV3(symbol: string, stateMap: Record<string, string>): Promise<void> {
  lastScanTime = new Date();
  lastScanSymbol = symbol;
  totalScansRun++;

  const result = await scanSymbolV3(symbol);

  if (result.skipped) {
    console.log(`[V3Scan] ${symbol} | SKIP | reason=${result.skipReason ?? "unknown"}`);
    return;
  }

  const { coordinatorOutput, features, operationalRegime, regimeConfidence, engineResults } = result;

  if (!coordinatorOutput || !features) {
    const engineCount = engineResults.length;
    console.log(`[V3Scan] ${symbol} | regime=${operationalRegime} | engines=${engineCount} | SKIP=no_coordinator_output`);
    return;
  }

  const { winner } = coordinatorOutput;
  console.log(`[V3Scan] ${symbol} | regime=${operationalRegime}(${regimeConfidence.toFixed(2)}) | engine=${winner.engineName} | dir=${coordinatorOutput.resolvedDirection} | conf=${coordinatorOutput.coordinatorConfidence.toFixed(3)} | move=${(winner.projectedMovePct * 100).toFixed(1)}%`);

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

    const effectiveMode: TradingMode = isIntelOnly ? "paper" : mode;

    // ── Allocator decision ───────────────────────────────────────────────────
    const v3Decision = await allocateV3Signal(coordinatorOutput, effectiveMode, stateMap);

    if (!v3Decision.allowed) {
      console.log(`[V3Scan] ${symbol} | ${effectiveMode} | engine=${winner.engineName} | BLOCKED | ${v3Decision.rejectionReason}`);
      // Log blocked decisions so Decisions UI can surface them with full gate info
      // Include engine-native score breakdown in scoringDimensions for BOOM300/CRASH300
      const blockedScoringDims = winner.metadata?.["componentScores"] ?? null;
      const blockedNativeScore =
        winner.metadata?.["boom300NativeScore"] != null ? (winner.metadata["boom300NativeScore"] as number)
        : winner.metadata?.["crash300NativeScore"] != null ? (winner.metadata["crash300NativeScore"] as number)
        : winner.metadata?.["r75ReversalNativeScore"] != null ? (winner.metadata["r75ReversalNativeScore"] as number)
        : winner.metadata?.["r75ContinuationNativeScore"] != null ? (winner.metadata["r75ContinuationNativeScore"] as number)
        : winner.metadata?.["r75BreakoutNativeScore"] != null ? (winner.metadata["r75BreakoutNativeScore"] as number)
        : winner.metadata?.["r100ReversalNativeScore"] != null ? (winner.metadata["r100ReversalNativeScore"] as number)
        : winner.metadata?.["r100BreakoutNativeScore"] != null ? (winner.metadata["r100BreakoutNativeScore"] as number)
        : winner.metadata?.["r100ContinuationNativeScore"] != null ? (winner.metadata["r100ContinuationNativeScore"] as number)
        : null;
      try {
        await db.insert(signalLogTable).values({
          symbol,
          strategyName: winner.engineName,
          strategyFamily: "v3_engine",
          direction: coordinatorOutput.resolvedDirection,
          score: coordinatorOutput.coordinatorConfidence,
          compositeScore: blockedNativeScore ?? Math.round(coordinatorOutput.coordinatorConfidence * 100),
          expectedValue: winner.projectedMovePct,
          allowedFlag: false,
          rejectionReason: v3Decision.rejectionReason,
          mode: effectiveMode,
          aiVerdict: "skipped",
          aiReasoning: "blocked before AI check",
          regime: operationalRegime,
          regimeConfidence,
          executionStatus: "blocked",
          scoringDimensions: blockedScoringDims,
        });
        totalDecisionsLogged++;
      } catch (logErr) {
        console.error(`[V3Scan] Blocked signal log error:`, logErr instanceof Error ? logErr.message : logErr);
      }
      if (isIntelOnly) break;
      continue;
    }

    // ── Optional AI verification ─────────────────────────────────────────────
    let aiVerdict: string | undefined;
    let aiBlocked = false;

    if (aiEnabled && !isIntelOnly) {
      try {
        const recentTrades = await db.select().from(tradesTable)
          .where(eq(tradesTable.symbol, symbol))
          .orderBy(desc(tradesTable.entryTs))
          .limit(5);
        const recentWinLoss = recentTrades.length > 0
          ? recentTrades.map(t => `${t.side} ${t.status} PnL:${(t.pnl ?? 0).toFixed(2)}`).join("; ")
          : "No recent trades";

        const last5Candles = await db.select().from(candlesTable)
          .where(and(eq(candlesTable.symbol, symbol), eq(candlesTable.timeframe, "1m")))
          .orderBy(desc(candlesTable.openTs))
          .limit(5);
        const candleDescriptions = last5Candles.length > 0
          ? last5Candles.map((c, i) => `[${i + 1}] O:${c.open.toFixed(2)} H:${c.high.toFixed(2)} L:${c.low.toFixed(2)} C:${c.close.toFixed(2)}`).join("; ")
          : "No recent candles";

        const verdict = await verifySignal({
          symbol,
          direction: coordinatorOutput.resolvedDirection,
          confidence: coordinatorOutput.coordinatorConfidence,
          score: coordinatorOutput.coordinatorConfidence,
          strategyName: winner.engineName,
          strategyFamily: "v3_engine",
          reason: winner.reason,
          rsi14: features.rsi14 ?? 50,
          atr14: features.atr14 ?? 0.01,
          ema20: features.latestClose,
          bbWidth: features.bbWidth ?? 0,
          zScore: features.zScore ?? 0,
          recentCandles: candleDescriptions,
          recentWinLoss,
          regimeState: operationalRegime,
          regimeConfidence,
          instrumentFamily: symbol.startsWith("BOOM") ? "boom_crash" : symbol.startsWith("CRASH") ? "boom_crash" : "volatility",
          macroBiasModifier: 0,
          compositeScore: Math.round(coordinatorOutput.coordinatorConfidence * 100),
          expectedValue: winner.projectedMovePct,
          latestClose: features.latestClose,
        });

        if (verdict) {
          aiVerdict = verdict.verdict;
          if (verdict.verdict === "disagree") {
            aiBlocked = true;
            console.log(`[V3Scan] ${symbol} | ${effectiveMode} | AI DISAGREE | ${verdict.reasoning}`);
          } else if (verdict.verdict === "uncertain") {
            v3Decision.capitalAmount = v3Decision.capitalAmount * 0.5;
            console.log(`[V3Scan] ${symbol} | ${effectiveMode} | AI UNCERTAIN | size halved to $${v3Decision.capitalAmount.toFixed(2)}`);
          }
        }
      } catch (err) {
        console.error(`[V3Scan] AI verification error for ${symbol}:`, err instanceof Error ? err.message : err);
        aiBlocked = true;
      }
    }

    if (isIntelOnly) {
      console.log(`[V3Scan] ${symbol} | intel-only | engine=${winner.engineName} | dir=${coordinatorOutput.resolvedDirection} | alloc=$${v3Decision.capitalAmount.toFixed(2)} | INTELLIGENCE_ONLY`);
      break;
    }

    if (aiBlocked) {
      if (isIntelOnly) break;
      continue;
    }

    // ── Log to signal_log table ──────────────────────────────────────────────
    // Include engine-native score breakdown in scoringDimensions for BOOM300/CRASH300
    const approvedScoringDims = winner.metadata?.["componentScores"] ?? null;
    const approvedNativeScore =
      winner.metadata?.["boom300NativeScore"] != null ? (winner.metadata["boom300NativeScore"] as number)
      : winner.metadata?.["crash300NativeScore"] != null ? (winner.metadata["crash300NativeScore"] as number)
      : winner.metadata?.["r75ReversalNativeScore"] != null ? (winner.metadata["r75ReversalNativeScore"] as number)
      : winner.metadata?.["r75ContinuationNativeScore"] != null ? (winner.metadata["r75ContinuationNativeScore"] as number)
      : winner.metadata?.["r75BreakoutNativeScore"] != null ? (winner.metadata["r75BreakoutNativeScore"] as number)
      : winner.metadata?.["r100ReversalNativeScore"] != null ? (winner.metadata["r100ReversalNativeScore"] as number)
      : winner.metadata?.["r100BreakoutNativeScore"] != null ? (winner.metadata["r100BreakoutNativeScore"] as number)
      : winner.metadata?.["r100ContinuationNativeScore"] != null ? (winner.metadata["r100ContinuationNativeScore"] as number)
      : null;
    try {
      await db.insert(signalLogTable).values({
        symbol,
        strategyName: winner.engineName,
        strategyFamily: "v3_engine",
        direction: coordinatorOutput.resolvedDirection,
        score: coordinatorOutput.coordinatorConfidence,
        compositeScore: approvedNativeScore ?? Math.round(coordinatorOutput.coordinatorConfidence * 100),
        expectedValue: winner.projectedMovePct,
        allowedFlag: true,
        allocationPct: v3Decision.capitalAllocationPct,
        mode: effectiveMode,
        aiVerdict: aiVerdict ?? "skipped",
        aiReasoning: aiVerdict ? `AI: ${aiVerdict}` : "AI check skipped",
        regime: operationalRegime,
        regimeConfidence,
        executionStatus: "executed",
        scoringDimensions: approvedScoringDims,
      });
      totalDecisionsLogged++;
    } catch (logErr) {
      console.error(`[V3Scan] Signal log error:`, logErr instanceof Error ? logErr.message : logErr);
    }

    // ── Open position ────────────────────────────────────────────────────────
    const tradeId = await openPositionV3({
      symbol,
      engineName: winner.engineName,
      direction: coordinatorOutput.resolvedDirection,
      confidence: coordinatorOutput.coordinatorConfidence,
      capitalAmount: v3Decision.capitalAmount,
      features,
      mode: effectiveMode,
    });

    if (tradeId) {
      console.log(`[V3Exec] ${symbol} | ${effectiveMode} | ${coordinatorOutput.resolvedDirection} | engine=${winner.engineName} | alloc=$${v3Decision.capitalAmount.toFixed(2)} | tradeId=${tradeId} | EXECUTED`);
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
    await scanSingleSymbolV3(symbol, freshMap);
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

    // Stage 1→2 SL promotion (breakeven at 20% TP progress) — V3 hybrid manager
    await promoteBreakevenSls();
    // Stage 2→3 trailing stop + closes — existing trade engine
    await manageOpenPositions();
  } catch (err) {
    console.error("[Scheduler] Position management error:", err instanceof Error ? err.message : err);
  }
}

const WEEKLY_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const AI_LOCKABLE_KEYS = [
  "equity_pct_per_trade", "paper_equity_pct_per_trade", "demo_equity_pct_per_trade", "real_equity_pct_per_trade",
  "max_open_trades", "paper_max_open_trades", "demo_max_open_trades", "real_max_open_trades",
  "min_composite_score", "paper_min_composite_score", "demo_min_composite_score", "real_min_composite_score",
  "min_ev_threshold", "min_rr_ratio",
  "max_daily_loss_pct", "max_weekly_loss_pct", "max_drawdown_pct",
  "correlated_family_cap", "extraction_target_pct",
  "allocation_mode", "paper_allocation_mode", "demo_allocation_mode", "real_allocation_mode",
];
let weeklyHandle: ReturnType<typeof setInterval> | null = null;

const JOB_CONFIG = {
  signalScan:         { enabled: true },
  positionManagement: { enabled: true },
  weeklyAnalysis:     { enabled: true },
} as const;

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

export function startScheduler(): void {
  if (schedulerHandle) return;

  if (JOB_CONFIG.signalScan.enabled) {
    console.log(`[Scheduler] Starting signal scan every ${currentIntervalMs / 1000}s`);
    schedulerHandle = setInterval(scanCycle, currentIntervalMs);
    setTimeout(scanCycle, 5000);
  }

  if (JOB_CONFIG.positionManagement.enabled) {
    console.log(`[Scheduler] Starting position management every ${POSITION_MGMT_INTERVAL_MS / 1000}s`);
    positionMgmtHandle = setInterval(positionManagementCycle, POSITION_MGMT_INTERVAL_MS);
    setTimeout(positionManagementCycle, 8000);
  }

  if (JOB_CONFIG.weeklyAnalysis.enabled) {
    console.log(`[Scheduler] Starting weekly AI analysis check (hourly)`);
    weeklyHandle = setInterval(weeklyAnalysisCycle, WEEKLY_CHECK_INTERVAL_MS);
    setTimeout(weeklyAnalysisCycle, 20000);
  }
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
