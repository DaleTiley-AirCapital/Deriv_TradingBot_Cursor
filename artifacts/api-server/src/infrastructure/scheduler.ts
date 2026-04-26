import { manageOpenPositions, openPositionV3 } from "../core/tradeEngine.js";
import { verifySignal } from "./openai.js";
import { db, platformStateTable, tradesTable, candlesTable, signalLogTable } from "@workspace/db";
import { eq, desc, and, gte, sql } from "drizzle-orm";
import { getActiveModes, isAnyModeActive } from "./deriv.js";
import type { TradingMode } from "./deriv.js";
import { ACTIVE_TRADING_SYMBOLS } from "./deriv.js";
import { syncLatestCanonical1mForSymbol } from "./deriv.js";
import { scanSymbolV3 } from "../core/engineRouterV3.js";
import { allocateV3Signal } from "../core/portfolioAllocatorV3.js";
import { getLiveCalibrationProfile } from "../core/calibration/liveCalibrationProfile.js";
import {
  updateCandidate,
  markCandidateExecuted,
  getSymbolsNeedingWatchScan,
  getWatchedCandidates,
  cleanupStale,
} from "../core/candidateLifecycle.js";
import { evaluateRuntimeEntryEvidence } from "../core/calibration/runtimeProfileUtils.js";
import type { BehaviorProfileSummary } from "../core/backtest/behaviorProfiler.js";
import { isSymbolStreamingDisabled } from "./symbolValidator.js";

const DEFAULT_SYMBOLS = ACTIVE_TRADING_SYMBOLS;
const DEFAULT_SCAN_INTERVAL_MS = 300_000;
const WATCH_SCAN_INTERVAL_MS = 60_000;
const DEFAULT_STAGGER_SECONDS = 10;
let scanCycleRunning = false;
let positionCycleRunning = false;
let watchCycleRunning = false;

function formatDbErr(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: unknown })?.cause;
  if (!cause) return base;
  const causeMsg = cause instanceof Error ? cause.message : String(cause);
  return `${base} | cause: ${causeMsg}`;
}

async function dbWithRetry<T>(fn: () => Promise<T>, label: string, maxAttempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = formatDbErr(err);
      // Avoid log storms under persistent DB failures.
      if (attempt === maxAttempts) {
        console.warn(`[Scheduler] DB retry ${attempt}/${maxAttempts} for "${label}": ${msg}`);
      }
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  throw lastErr;
}

const POSITION_MGMT_INTERVAL_MS = 10_000;

let schedulerHandle: ReturnType<typeof setInterval> | null = null;
let positionMgmtHandle: ReturnType<typeof setInterval> | null = null;
let watchCycleHandle: ReturnType<typeof setInterval> | null = null;

function parseRuntimeWindowMs(raw: string | undefined, fallbackMs: number): number {
  if (!raw) return fallbackMs;
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(m|min|mins|h|hr|hrs|hour|hours)?$/i);
  if (!match) return fallbackMs;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return fallbackMs;
  const unit = (match[2] ?? "m").toLowerCase();
  const minutes = unit.startsWith("h") ? value * 60 : value;
  return Math.max(30, Math.round(minutes)) * 60_000;
}

function runtimeCandidateAgeMs(runtimeCalibration: Awaited<ReturnType<typeof getLiveCalibrationProfile>>): number {
  if (!runtimeCalibration) return 0;
  return parseRuntimeWindowMs(runtimeCalibration.confirmationWindow, 2 * 60 * 60_000);
}

function runtimeCandidateCooldownMs(runtimeCalibration: Awaited<ReturnType<typeof getLiveCalibrationProfile>>): number {
  if (!runtimeCalibration) return 2 * 60 * 60_000;
  const confirmationMs = runtimeCandidateAgeMs(runtimeCalibration);
  const minHoldMinutes = Number(runtimeCalibration.trailingModel?.["minHoldMinutesBeforeTrail"] ?? 0);
  const minHoldMs = Number.isFinite(minHoldMinutes) && minHoldMinutes > 0
    ? minHoldMinutes * 60_000
    : 0;
  return Math.max(confirmationMs * 2, minHoldMs, 4 * 60 * 60_000);
}
let currentIntervalMs = DEFAULT_SCAN_INTERVAL_MS;

let staggeredScanActive = false;
let staggerSymbolIndex = 0;
let staggerTimerHandle: ReturnType<typeof setTimeout> | null = null;

let lastScanTime: Date | null = null;
let lastScanSymbol: string | null = null;
let totalScansRun = 0;
let totalDecisionsLogged = 0;
const calibratedLastScanMs: Record<string, number> = {};

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

  try {
    await syncLatestCanonical1mForSymbol(symbol);
  } catch (err) {
    console.warn(
      `[V3Scan] ${symbol} | canonical_1m_sync_failed | ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const aiEnabled = stateMap["ai_verification_enabled"] === "true";
  const activeModes = getActiveModes(stateMap);
  const modesToProcess: TradingMode[] = activeModes.length > 0 ? activeModes : ["paper" as TradingMode];
  const isIntelOnly = activeModes.length === 0;
  const paperModeInUse = isIntelOnly || modesToProcess.includes("paper");
  const runtimeCalibration = paperModeInUse
    ? await getLiveCalibrationProfile(symbol, "paper", stateMap).catch(() => null)
    : null;

  if (runtimeCalibration && paperModeInUse) {
    const watchSymbols = new Set(getSymbolsNeedingWatchScan());
    const cadenceMs = Math.max(30_000, Math.min(15 * 60_000, runtimeCalibration.recommendedScanIntervalSeconds * 1000));
    const nowMs = Date.now();
    const lastMs = calibratedLastScanMs[symbol] ?? 0;
    if (!watchSymbols.has(symbol) && (nowMs - lastMs) < cadenceMs) {
      console.log(
        `[V3Scan] ${symbol} | SKIP | reason=calibrated_scan_cadence_guard(${Math.round((cadenceMs - (nowMs - lastMs)) / 1000)}s_remaining)`,
      );
      return;
    }
    calibratedLastScanMs[symbol] = nowMs;
  }

  const result = await scanSymbolV3(symbol, runtimeCalibration);

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

  const latestCandleCloseTs = Number(features.latestCandleCloseTs || 0);
  const staleCutoffMs = Number(stateMap["max_candle_stale_ms"] || 180_000);
  if (Number.isFinite(latestCandleCloseTs) && latestCandleCloseTs > 0) {
    const ageMs = Date.now() - latestCandleCloseTs;
    if (ageMs > staleCutoffMs) {
      console.log(
        `[V3Scan] ${symbol} | SKIP | reason=stale_candle_data(age=${Math.round(ageMs / 1000)}s,cutoff=${Math.round(staleCutoffMs / 1000)}s)`,
      );
      return;
    }
  }

  const { winner } = coordinatorOutput;
  console.log(`[V3Scan] ${symbol} | regime=${operationalRegime}(${regimeConfidence.toFixed(2)}) | engine=${winner.engineName} | dir=${coordinatorOutput.resolvedDirection} | conf=${coordinatorOutput.coordinatorConfidence.toFixed(3)} | move=${(winner.projectedMovePct * 100).toFixed(1)}%`);

  // Store per-symbol scan context for live trade management (tradeEngine.manageOpenPositions).
  // The adaptive trailing stop uses emaSlope and spikeCount4h to adjust the trail multiplier.
  // Writing these per scan ensures live management uses the most recent market context
  // rather than placeholder 0-values.
  const emaKey      = `${symbol}_scan_ema_slope`;
  const spikeKey    = `${symbol}_scan_spike_count_4h`;
  const trailActivationKey = `${symbol}_scan_trail_activation_pct`;
  const trailDistanceKey   = `${symbol}_scan_trail_distance_pct`;
  const trailMinHoldBarsKey = `${symbol}_scan_trail_min_hold_bars`;
  const calibCadenceKey    = `${symbol}_scan_calibrated_interval_seconds`;
  const emaVal      = String(features.emaSlope ?? 0);
  const spikeVal    = String(features.spikeCount4h ?? 0);
  const trailActivationVal = String(
    Number(runtimeCalibration?.trailingModel?.["activationProfitPct"] ?? 0) || 0,
  );
  const trailDistanceVal = String(
    Number(runtimeCalibration?.trailingModel?.["trailingDistancePct"] ?? 0) || 0,
  );
  const trailMinHoldBarsVal = String(
    Number(runtimeCalibration?.trailingModel?.["minHoldMinutesBeforeTrail"] ?? 0) || 0,
  );
  const calibCadenceVal = String(
    Number(runtimeCalibration?.recommendedScanIntervalSeconds ?? 0) || 0,
  );
  Promise.all([
    db.insert(platformStateTable).values({ key: emaKey, value: emaVal })
      .onConflictDoUpdate({ target: platformStateTable.key, set: { value: emaVal, updatedAt: new Date() } }),
    db.insert(platformStateTable).values({ key: spikeKey, value: spikeVal })
      .onConflictDoUpdate({ target: platformStateTable.key, set: { value: spikeVal, updatedAt: new Date() } }),
    db.insert(platformStateTable).values({ key: trailActivationKey, value: trailActivationVal })
      .onConflictDoUpdate({ target: platformStateTable.key, set: { value: trailActivationVal, updatedAt: new Date() } }),
    db.insert(platformStateTable).values({ key: trailDistanceKey, value: trailDistanceVal })
      .onConflictDoUpdate({ target: platformStateTable.key, set: { value: trailDistanceVal, updatedAt: new Date() } }),
    db.insert(platformStateTable).values({ key: trailMinHoldBarsKey, value: trailMinHoldBarsVal })
      .onConflictDoUpdate({ target: platformStateTable.key, set: { value: trailMinHoldBarsVal, updatedAt: new Date() } }),
    db.insert(platformStateTable).values({ key: calibCadenceKey, value: calibCadenceVal })
      .onConflictDoUpdate({ target: platformStateTable.key, set: { value: calibCadenceVal, updatedAt: new Date() } }),
  ]).catch(() => {/* non-fatal */});

  for (const mode of modesToProcess) {
    const modePrefix = mode === "paper" ? "paper" : mode === "demo" ? "demo" : "real";

    if (!isIntelOnly) {
      const modeSymbolsRaw = stateMap[`${modePrefix}_enabled_symbols`] || stateMap["enabled_symbols"] || "";
      const modeSymbols = modeSymbolsRaw ? modeSymbolsRaw.split(",").map((s: string) => s.trim()).filter(Boolean) : null;
      if (modeSymbols && !modeSymbols.includes(symbol)) continue;
    }

    const effectiveMode: TradingMode = isIntelOnly ? "paper" : mode;

    // ── Allocator decision ───────────────────────────────────────────────────
    const modeCalibration = effectiveMode === "paper" ? runtimeCalibration : null;
    const minCandidateAgeMs = runtimeCandidateAgeMs(modeCalibration);
    const minCandidateScans = modeCalibration ? 2 : 1;

    const v3Decision = await allocateV3Signal(
      coordinatorOutput,
      effectiveMode,
      stateMap,
      modeCalibration,
    );

    // ── Extract engine-native score and component breakdown ─────────────────
    const candidateScoringDims = winner.metadata?.["componentScores"] as Record<string, number> | null ?? null;
    const candidateNativeScore =
      winner.metadata?.["boom300NativeScore"] != null ? (winner.metadata["boom300NativeScore"] as number)
      : winner.metadata?.["crash300NativeScore"] != null ? (winner.metadata["crash300NativeScore"] as number)
      : winner.metadata?.["r75ReversalNativeScore"] != null ? (winner.metadata["r75ReversalNativeScore"] as number)
      : winner.metadata?.["r75ContinuationNativeScore"] != null ? (winner.metadata["r75ContinuationNativeScore"] as number)
      : winner.metadata?.["r75BreakoutNativeScore"] != null ? (winner.metadata["r75BreakoutNativeScore"] as number)
      : winner.metadata?.["r100ReversalNativeScore"] != null ? (winner.metadata["r100ReversalNativeScore"] as number)
      : winner.metadata?.["r100BreakoutNativeScore"] != null ? (winner.metadata["r100BreakoutNativeScore"] as number)
      : winner.metadata?.["r100ContinuationNativeScore"] != null ? (winner.metadata["r100ContinuationNativeScore"] as number)
      : Math.round(coordinatorOutput.coordinatorConfidence * 100);

    const setupEvidence = evaluateRuntimeEntryEvidence({
      symbol,
      direction: coordinatorOutput.resolvedDirection,
      nativeScore: candidateNativeScore,
      winner,
      features,
      runtimeCalibration: modeCalibration,
    });
    const setupSignature = setupEvidence.matchedBucketKey
      ? `${setupEvidence.matchedBucketKey}`
      : `${setupEvidence.leadInShape}|${setupEvidence.qualityBand}`;

    // Engine gate passed = the rejection is NOT score-based (score cleared engine gate but something else blocked)
    const rejReason = v3Decision.rejectionReason ?? "";
    const isScoreRejection = rejReason.includes("_score_below_mode_threshold") || rejReason.includes("confidence_below_threshold");
    const engineGatePassed = v3Decision.allowed || !isScoreRejection;

    if (!v3Decision.allowed) {
      console.log(`[V3Scan] ${symbol} | ${effectiveMode} | engine=${winner.engineName} | BLOCKED | ${rejReason}`);

      // ── Lifecycle update: only log on material state change ─────────────
      const lcResult = updateCandidate({
        symbol,
        engineName: winner.engineName,
        direction: coordinatorOutput.resolvedDirection,
        nativeScore: candidateNativeScore,
        breakdown: candidateScoringDims,
        engineGatePassed,
        allocatorAllowed: false,
        rejectionReason: rejReason,
        regime: operationalRegime,
        regimeConfidence,
        minTradeableAgeMs: minCandidateAgeMs,
        minTradeableScans: minCandidateScans,
        setupSignature,
        setupEvidenceAllowed: setupEvidence.allowed,
        setupEvidenceReason: setupEvidence.reason,
        setupEvidenceScore: setupEvidence.evidenceScore,
      });

      if (lcResult.shouldLog) {
        const lcStatus = lcResult.candidate.status;
        console.log(`[V3Lifecycle] ${symbol} | ${winner.engineName} | ${coordinatorOutput.resolvedDirection} | ${lcResult.logReason} | status=${lcStatus} | score=${candidateNativeScore}`);
        try {
          await db.insert(signalLogTable).values({
            symbol,
            strategyName: winner.engineName,
            strategyFamily: "v3_engine",
            direction: coordinatorOutput.resolvedDirection,
            score: coordinatorOutput.coordinatorConfidence,
            compositeScore: candidateNativeScore,
            expectedValue: winner.projectedMovePct,
            allowedFlag: false,
            rejectionReason: rejReason,
            mode: effectiveMode,
            aiVerdict: "skipped",
            aiReasoning: `lifecycle:${lcResult.logReason} | lifecycle_state:${lcStatus}`,
            regime: operationalRegime,
            regimeConfidence,
            executionStatus: "blocked",
            scoringDimensions: candidateScoringDims,
          });
          totalDecisionsLogged++;
        } catch (logErr) {
          console.error(`[V3Scan] Lifecycle log error:`, logErr instanceof Error ? logErr.message : logErr);
        }
      }

      if (isIntelOnly) break;
      continue;
    }

    if (!setupEvidence.allowed) {
      const setupRejectReason = `runtime_setup_evidence:${setupEvidence.reason}`;
      console.log(`[V3Scan] ${symbol} | ${effectiveMode} | engine=${winner.engineName} | MONITORING | ${setupRejectReason}`);

      const lcResult = updateCandidate({
        symbol,
        engineName: winner.engineName,
        direction: coordinatorOutput.resolvedDirection,
        nativeScore: candidateNativeScore,
        breakdown: candidateScoringDims,
        engineGatePassed: true,
        allocatorAllowed: false,
        rejectionReason: setupRejectReason,
        regime: operationalRegime,
        regimeConfidence,
        minTradeableAgeMs: minCandidateAgeMs,
        minTradeableScans: minCandidateScans,
        setupSignature,
        setupEvidenceAllowed: false,
        setupEvidenceReason: setupEvidence.reason,
        setupEvidenceScore: setupEvidence.evidenceScore,
      });

      if (lcResult.shouldLog) {
        try {
          await db.insert(signalLogTable).values({
            symbol,
            strategyName: winner.engineName,
            strategyFamily: "v3_engine",
            direction: coordinatorOutput.resolvedDirection,
            score: coordinatorOutput.coordinatorConfidence,
            compositeScore: candidateNativeScore,
            expectedValue: winner.projectedMovePct,
            allowedFlag: false,
            rejectionReason: setupRejectReason,
            mode: effectiveMode,
            aiVerdict: "skipped",
            aiReasoning: `lifecycle:${lcResult.logReason || "setup_evidence"} | lifecycle_state:${lcResult.candidate.status} | setup:${setupSignature}`,
            regime: operationalRegime,
            regimeConfidence,
            executionStatus: "blocked",
            scoringDimensions: candidateScoringDims,
          });
          totalDecisionsLogged++;
        } catch (logErr) {
          console.error(`[V3Scan] Runtime setup evidence log error:`, logErr instanceof Error ? logErr.message : logErr);
        }
      }

      if (isIntelOnly) break;
      continue;
    }

    // Allowed path — update lifecycle with allocatorAllowed=true
    const allowedLifecycle = updateCandidate({
      symbol,
      engineName: winner.engineName,
      direction: coordinatorOutput.resolvedDirection,
      nativeScore: candidateNativeScore,
      breakdown: candidateScoringDims,
      engineGatePassed: true,
      allocatorAllowed: true,
      rejectionReason: null,
      regime: operationalRegime,
      regimeConfidence,
      minTradeableAgeMs: minCandidateAgeMs,
      minTradeableScans: minCandidateScans,
      setupSignature,
      setupEvidenceAllowed: true,
      setupEvidenceReason: setupEvidence.reason,
      setupEvidenceScore: setupEvidence.evidenceScore,
    });

    if (modeCalibration && allowedLifecycle.candidate.status !== "tradeable") {
      const readyAt = allowedLifecycle.candidate.tradeableAfterAt?.toISOString() ?? "next_confirmation";
      console.log(`[V3Lifecycle] ${symbol} | ${winner.engineName} | ${coordinatorOutput.resolvedDirection} | MONITORING | status=${allowedLifecycle.candidate.status} | score=${candidateNativeScore} | tradeableAfter=${readyAt}`);

      if (allowedLifecycle.shouldLog) {
        try {
          await db.insert(signalLogTable).values({
            symbol,
            strategyName: winner.engineName,
            strategyFamily: "v3_engine",
            direction: coordinatorOutput.resolvedDirection,
            score: coordinatorOutput.coordinatorConfidence,
            compositeScore: candidateNativeScore,
            expectedValue: winner.projectedMovePct,
            allowedFlag: false,
            rejectionReason: `runtime_candidate_window:${allowedLifecycle.candidate.status}`,
            mode: effectiveMode,
            aiVerdict: "skipped",
            aiReasoning: `lifecycle:${allowedLifecycle.logReason || "monitoring"} | lifecycle_state:${allowedLifecycle.candidate.status} | tradeable_after:${readyAt}`,
            regime: operationalRegime,
            regimeConfidence,
            executionStatus: "blocked",
            scoringDimensions: candidateScoringDims,
          });
          totalDecisionsLogged++;
        } catch (logErr) {
          console.error(`[V3Scan] Runtime candidate lifecycle log error:`, logErr instanceof Error ? logErr.message : logErr);
        }
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
          mode: effectiveMode,
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

    // ── Log execution to signal_log (uses candidateNativeScore/candidateScoringDims) ──
    try {
      await db.insert(signalLogTable).values({
        symbol,
        strategyName: winner.engineName,
        strategyFamily: "v3_engine",
        direction: coordinatorOutput.resolvedDirection,
        score: coordinatorOutput.coordinatorConfidence,
        compositeScore: candidateNativeScore,
        expectedValue: winner.projectedMovePct,
        allowedFlag: true,
        allocationPct: v3Decision.capitalAllocationPct,
        mode: effectiveMode,
        aiVerdict: aiVerdict ?? "skipped",
        aiReasoning: aiVerdict ? `AI: ${aiVerdict}` : "AI check skipped",
        regime: operationalRegime,
        regimeConfidence,
        executionStatus: "executed",
        scoringDimensions: candidateScoringDims,
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
      runtimeCalibration: modeCalibration,
    });

    if (tradeId) {
      markCandidateExecuted(
        symbol,
        winner.engineName,
        coordinatorOutput.resolvedDirection,
        setupSignature,
        runtimeCandidateCooldownMs(modeCalibration),
      );
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
    if (isSymbolStreamingDisabled(symbol)) {
      return;
    }
    await scanSingleSymbolV3(symbol, freshMap);
  } catch (err) {
    console.error(`[Scheduler] Stagger scan error for ${symbol}:`, err instanceof Error ? err.message : err);
  }

  if (staggeredScanActive) {
    staggerTimerHandle = setTimeout(() => scheduleStaggeredScan(symbols, staggerMs), staggerMs);
  }
}

async function scanCycle(): Promise<void> {
  if (scanCycleRunning) return;
  scanCycleRunning = true;
  try {
    const states = await dbWithRetry(
      () => db.select().from(platformStateTable),
      "platform_state read (scan cycle)",
    );
    const stateMap: Record<string, string> = {};
    for (const s of states) stateMap[s.key] = s.value;

    const configuredInterval = parseInt(stateMap["scan_interval_seconds"] || "300") * 1000;
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
    const symbolsRaw = enabledSymbolsRaw
      ? enabledSymbolsRaw.split(",").map((s: string) => s.trim()).filter(Boolean)
      : DEFAULT_SYMBOLS;
    const symbols = symbolsRaw.filter((s) => !isSymbolStreamingDisabled(s));
    if (symbols.length === 0) {
      if (staggeredScanActive) {
        staggeredScanActive = false;
        if (staggerTimerHandle) {
          clearTimeout(staggerTimerHandle);
          staggerTimerHandle = null;
        }
      }
      return;
    }

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
    console.error("[Scheduler] Scan error:", formatDbErr(err));
  } finally {
    scanCycleRunning = false;
  }
}

async function positionManagementCycle(): Promise<void> {
  if (positionCycleRunning) return;
  positionCycleRunning = true;
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

    // Unified lifecycle state machine: manageOpenPositions handles all stages
    // (BE promotion 1→2, trailing activation 2→3, exits) via applyBarStateTransitions.
    // promoteBreakevenSls is superseded — breakeven is now embedded in the shared state machine.
    await manageOpenPositions();
  } catch (err) {
    console.error("[Scheduler] Position management error:", formatDbErr(err));
  } finally {
    positionCycleRunning = false;
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

/**
 * Per-symbol last-watch-scan timestamps.
 * Used by the behavior-guided cadence to throttle rescans per symbol independently.
 * Populated by watchScanCycle; reset on scheduler restart.
 */
const watchLastScanMs: Record<string, number> = {};

/**
 * Watch-mode cycle — runs every 60s.
 * Re-scans only symbols that have at least one watch/qualified/tradeable candidate.
 * Per-symbol, not per-candidate, so all engines for that symbol re-evaluate.
 * Also runs stale-candidate cleanup.
 *
 * Behavior-guided cadence discipline:
 *   If `behavior_watch_cadence_${sym}` is set in platformState (written by the
 *   POST /api/behavior/persist/:symbol endpoint from the behavior profiler), that
 *   cadence overrides the baseline 60s interval for that specific symbol.
 *   This ties live watch-mode execution discipline to empirically derived behavior profiles.
 */
async function watchScanCycle(): Promise<void> {
  if (watchCycleRunning) return;
  watchCycleRunning = true;
  cleanupStale();

  const watchSymbols = getSymbolsNeedingWatchScan();
  if (watchSymbols.length === 0) {
    watchCycleRunning = false;
    return;
  }

  try {
    const states = await dbWithRetry(
      () => db.select().from(platformStateTable),
      "platform_state read (watch scan)",
    );
    const stateMap: Record<string, string> = {};
    for (const s of states) stateMap[s.key] = s.value;

    const killSwitch = stateMap["kill_switch"] === "true";
    const streamingActive = stateMap["streaming"] === "true";
    if (killSwitch || !streamingActive) return;

    const nowMs = Date.now();
    // Pre-load watched candidates once for the full cycle
    const allWatchedCandidates = getWatchedCandidates();

    for (const sym of watchSymbols) {
      if (isSymbolStreamingDisabled(sym)) continue;
      // ── Gate 1: Behavior-guided cadence throttle ──────────────────────────
      // Only re-scan once the behavior-recommended interval has elapsed.
      const behaviorCadenceMs = stateMap[`behavior_watch_cadence_${sym}`]
        ? parseInt(stateMap[`behavior_watch_cadence_${sym}`], 10)
        : WATCH_SCAN_INTERVAL_MS;
      const lastScan = watchLastScanMs[sym] ?? 0;
      if (nowMs - lastScan < behaviorCadenceMs) continue;

      // ── Gate 2: Trigger-state maturity check (behavior profile) ──────────
      // Uses per-engine `recommendedMemoryWindowBars` from the derived behavior
      // profile (1 bar = 1 min). For each "watch" candidate whose engine has a
      // profile, require the candidate to have been observed for at least that
      // many minutes before allowing the execution scan to proceed.
      // "qualified" or "tradeable" candidates have already cleared the engine
      // gate and are NOT deferred — the maturity window only guards "watch" state
      // signals that are still developing.
      // Conservative fallback minimum watch duration when no behavior profile
      // is persisted — prevents execution scans on brand-new watch candidates
      // before any historical data is available to calibrate the maturity window.
      // Once a real profile is derived and persisted, its per-engine values take over.
      const FALLBACK_WATCH_MIN_MINS = 30;

      const profileRaw = stateMap[`behavior_profile_${sym}`];
      if (profileRaw) {
        try {
          const profile = JSON.parse(profileRaw) as BehaviorProfileSummary;
          const watchOnlyCandidates = allWatchedCandidates.filter(
            c => c.symbol === sym && c.status === "watch",
          );

          if (watchOnlyCandidates.length > 0) {
            let shouldDefer = false;
            let deferReason = "";

            for (const cand of watchOnlyCandidates) {
              const engineProf = profile.engineProfiles.find(
                ep => ep.engineName === cand.engineName,
              );
              // Use per-engine memory window if available; fall back to symbol cadence × 2
              const memWindowMins = engineProf?.recommendedMemoryWindowBars
                ?? (profile.recommendedScanCadenceMins * 2);

              if (memWindowMins > 0) {
                const watchDurationMins = (nowMs - cand.firstSeenAt.getTime()) / 60_000;
                if (watchDurationMins < memWindowMins) {
                  shouldDefer = true;
                  deferReason = `engine=${cand.engineName} watchDuration=${watchDurationMins.toFixed(1)}min < memoryWindow=${memWindowMins}min`;
                  break;
                }
              }
            }

            if (shouldDefer) {
              console.log(
                `[WatchScan] ${sym} | TRIGGER_MATURITY_GATE | ${deferReason} | deferring execution scan`,
              );
              continue;
            }
          }
        } catch {
          // Profile parse error — allow scan to proceed (corrupt profile is better
          // than indefinitely blocking watch candidates)
        }
      } else {
        // No behavior profile persisted yet — apply conservative fallback gate:
        // require any "watch" state candidate to have been observed for at least
        // FALLBACK_WATCH_MIN_MINS minutes before allowing the execution scan.
        const watchOnlyCandidates = allWatchedCandidates.filter(
          c => c.symbol === sym && c.status === "watch",
        );
        if (watchOnlyCandidates.length > 0) {
          const immature = watchOnlyCandidates.find(
            c => (nowMs - c.firstSeenAt.getTime()) / 60_000 < FALLBACK_WATCH_MIN_MINS,
          );
          if (immature) {
            const watchDurationMins = ((nowMs - immature.firstSeenAt.getTime()) / 60_000).toFixed(1);
            console.log(
              `[WatchScan] ${sym} | FALLBACK_MATURITY_GATE | engine=${immature.engineName} ` +
              `watchDuration=${watchDurationMins}min < fallback=${FALLBACK_WATCH_MIN_MINS}min | deferring`,
            );
            continue;
          }
        }
      }

      try {
        await scanSingleSymbolV3(sym, stateMap);
        watchLastScanMs[sym] = Date.now();
      } catch (err) {
        console.error(`[WatchScan] Error for ${sym}:`, err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    console.error("[WatchScan] Cycle error:", formatDbErr(err));
  } finally {
    watchCycleRunning = false;
  }
}

export function startScheduler(): void {
  if (schedulerHandle) return;

  if (JOB_CONFIG.signalScan.enabled) {
    console.log(`[Scheduler] Starting baseline signal scan every ${currentIntervalMs / 1000}s`);
    schedulerHandle = setInterval(scanCycle, currentIntervalMs);
    setTimeout(scanCycle, 5000);

    console.log(`[Scheduler] Starting watch-mode scan every ${WATCH_SCAN_INTERVAL_MS / 1000}s (candidate-scoped)`);
    watchCycleHandle = setInterval(watchScanCycle, WATCH_SCAN_INTERVAL_MS);
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
  if (watchCycleHandle) {
    clearInterval(watchCycleHandle);
    watchCycleHandle = null;
    console.log("[Scheduler] Watch-mode scanner stopped.");
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
