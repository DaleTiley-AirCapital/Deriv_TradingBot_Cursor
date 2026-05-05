/**
 * backtestRunner.ts â€” V3 Unified Runtime Backtest Engine
 *
 * Replays historical candles bar-by-bar using the EXACT same decision path
 * as the live scanner, including mode score gates mirroring portfolioAllocatorV3:
 *
 *   features â†’ HTF regime (averaged) â†’ engines â†’ symbolCoordinator
 *     â†’ backtestAllocator (mode gate: paperâ‰¥60, demoâ‰¥65, realâ‰¥70)
 *     â†’ staged exit model (SR/Fib TP, 1:5 SL, breakeven at 20%, ATR trail at 30%)
 *
 * â”€â”€ Divergences from V2 runner (now eliminated) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 *   OLD: bare classifyRegime per bar â†’ NEW: HTF feature-averaged regime
 *   OLD: highest-score loop â†’ NEW: runSymbolCoordinator (conflict resolution)
 *   OLD: no mode score gate â†’ NEW: paper/demo/real gates matching live allocator
 *   OLD: Leg1/Hard-SL/MFE exits â†’ NEW: SR/Fib TP + 1:5 SL + BE@20% + ATR trail
 *   OLD: blocked signals silently dropped â†’ NEW: blocked events captured for profiling
 *
 * â”€â”€ Behavior event capture â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 *   Every lifecycle stage is recorded:
 *     signal_fired â†’ blocked_by_gate | entered â†’ breakeven_promoted
 *     â†’ trailing_activated â†’ closed
 *   The behavior profiler reads these to derive: win rate, hold time,
 *   MFE/MAE distributions, blocked rate, recommended scan cadence, memory window.
 *
 * â”€â”€ Design constraints â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 *   - No DB calls inside the hot loop (candles pre-loaded at startup)
 *   - HTF regime averaged over last 60 1m feature samples (~1 hour)
 *   - One open trade per symbol at a time (matches live one-per-symbol enforcement)
 *   - Mode score gates: paper=60, demo=65, real=70 (matches portfolioAllocatorV3)
 *   - Backtest allocator is pure/stateless (no portfolio PnL risk limits â€” those
 *     are portfolio-state-dependent and inapplicable in isolated bar-by-bar replay)
 */

import { db, candlesTable, platformStateTable, detectedMovesTable } from "@workspace/db";
import { eq, and, gte, lte, asc, inArray } from "drizzle-orm";
import { computeFeaturesFromSlice, type CandleRow } from "./featureSlice.js";
import { classifyRegimeFromSamples } from "../regimeEngine.js";
import {
  calculateSRFibTP,
  calculateSRFibSL,
  applyRuntimeCalibrationExitModel,
} from "../tradeEngine.js";
import {
  evaluateRuntimeEntryEvidence,
  type RuntimeQualityBand,
} from "../calibration/runtimeProfileUtils.js";
import { getSymbolIndicatorTimeframeMins } from "../features.js";
import type { EngineResult } from "../engineTypes.js";
import type { FeatureVector } from "../features.js";
import {
  recordBehaviorEvent,
  type ClosedEvent,
} from "./behaviorCapture.js";
import {
  evaluateSignalAdmission,
  MODE_SCORE_GATES,
  extractNativeScore,
} from "../allocatorCore.js";
import { runEnginesAndCoordinate } from "../signalPipeline.js";
import {
  evaluateBarExits,
  MAX_HOLD_MINS,
  applyBarStateTransitions,
} from "../tradeManagement.js";
import { buildSymbolTradeCandidate } from "../symbolModels/candidateBuilder.js";
import { evaluateCrash300Runtime, coordinatorFromCrash300Decision } from "../../symbol-services/CRASH300/engine.js";
import type { Crash300RuntimeState } from "../../symbol-services/CRASH300/features.js";
import {
  DEFAULT_CRASH300_ADMISSION_POLICY,
  evaluateCrash300AdmissionPolicy,
  normalizeCrash300AdmissionPolicyConfig,
  type Crash300AdmissionPolicyConfig,
  type Crash300AdmissionPolicyMode,
} from "../../symbol-services/CRASH300/admissionPolicy.js";
import { getModeCapitalKey, getModeCapitalDefault } from "../../infrastructure/deriv.js";
import {
  getLiveCalibrationProfile,
  resolveLiveCalibrationProfile,
  type LiveCalibrationProfile,
  type LiveCalibrationProfileResolution,
} from "../calibration/liveCalibrationProfile.js";

// â”€â”€ Constants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const STRUCTURAL_LOOKBACK = 1500;
// MAX_HOLD_MINS is shared from tradeManagement.ts (also used by live tradeEngine)
// For 1m bars: 1 bar = 1 minute, so MAX_HOLD_BARS === MAX_HOLD_MINS
const SYNTHETIC_EQUITY = 10_000;
const DEFAULT_ALLOCATION_PCT = 0.15;     // matches live portfolioAllocatorV3 default
const SYNTHETIC_SIZE = SYNTHETIC_EQUITY * DEFAULT_ALLOCATION_PCT; // = 1500
const HTF_AVERAGING_WINDOW = 60;         // 60 feature samples â‰ˆ 1 hour (matches live)
const DEFAULT_REPORT_STARTING_CAPITAL_USD = 600;

// â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface V3BacktestTrade {
  entryTs: number;
  exitTs: number;
  symbol: string;
  direction: "buy" | "sell";
  engineName: string;
  entryType: string;
  entryPrice: number;
  exitPrice: number;
  exitReason: "tp_hit" | "sl_hit" | "trailing_stop" | "max_duration";
  slStage: 1 | 2 | 3;
  projectedMovePct: number;
  runtimeEvidence: number;
  regimeAtEntry: string;
  regimeConfidence: number;
  holdBars: number;
  barsToMfe: number;
  barsToBreakeven: number;
  pnlPct: number;
  mfePct: number;
  maePct: number;
  tpPct: number;
  slPct: number;
  conflictResolution: string;
  modeGateApplied: number;
  modelSource?: string;
  runtimeModelRunId?: number | null;
  runtimeFamily?: string | null;
  selectedBucket?: string | null;
  qualityTier?: string | null;
  confidence?: number | null;
  setupMatch?: number | null;
  trailingActivationPct?: number | null;
  trailingDistancePct?: number | null;
  trailingMinHoldBars?: number | null;
  trailingActivated?: boolean;
  contextSnapshotAtEntry?: Record<string, unknown> | null;
  triggerSnapshotAtEntry?: Record<string, unknown> | null;
  contextFamilyCandidates?: Array<Record<string, unknown>> | null;
  selectedContextFamily?: string | null;
  selectedTriggerTransition?: string | null;
  triggerDirection?: string | null;
  triggerStrengthScore?: number | null;
  contextAgeBars?: number | null;
  contextAgeMinutes?: number | null;
  triggerAgeBars?: number | null;
  triggerFresh?: boolean | null;
  contextEpochId?: string | null;
  duplicateWithinContextEpoch?: boolean | null;
  previousTradeInSameContextEpoch?: string | null;
  wouldBlockNoTrigger?: boolean | null;
  wouldBlockStaleContext?: boolean | null;
  wouldBlockDuplicateEpoch?: boolean | null;
  wouldBlockDirectionMismatch?: boolean | null;
  wouldBlockLateAfterMoveWindow?: boolean | null;
  admissionPolicyWouldBlock?: boolean | null;
  admissionPolicyBlockedReasons?: string[] | null;
  admissionPolicyMode?: Crash300AdmissionPolicyMode | null;
}

export interface V3BacktestResult {
  symbol: string;
  mode: string;
  tierMode: BacktestTierMode;
  startTs: number;
  endTs: number;
  totalBars: number;
  modeScoreGate: number;
  signalsFired: number;
  signalsBlocked: number;
  blockedRate: number;
  runtimeModel: {
    enabled: boolean;
    applied: boolean;
    reason: string;
    useCalibratedRuntimeProfiles: boolean;
    mode: string | null;
    source: string | null;
    sourceRunId: number | null;
    entryModel: string | null;
    tpBucketCount: number;
    dynamicTpEnabled: boolean;
    modelSourceCounts: Record<string, number>;
  };
  admissionPolicy: {
    enabled: boolean;
    mode: Crash300AdmissionPolicyMode;
    config: Crash300AdmissionPolicyConfig;
    candidatesBlockedByAdmissionPolicy: number;
    blockedReasonsCounts: Record<string, number>;
    tradesWouldHaveBeenBlocked: number;
    winsBlocked: number | null;
    lossesBlocked: number | null;
    slHitsBlocked: number | null;
    resultingWinRate: number | null;
    resultingTradeCount: number | null;
  };
  trades: V3BacktestTrade[];
  /**
   * Allocator gates that could NOT be applied with full parity because they
   * require cross-symbol or live portfolio state unavailable in single-symbol
   * historical replay. Non-empty = backtest made assumptions for these gates.
   * Callers should surface these to the user as simulation caveats.
   */
  simulationGaps: string[];
  moveOverlap: {
    movesInWindow: number;
    capturedMoves: number;
    missedMoves: number;
    captureRate: number;
    tradesMatchedToMoves: number;
    ghostTrades: number;
    ghostRate: number;
    moveDirectionSplit: { up: number; down: number };
  };
  summary: {
    tradeCount: number;
    winCount: number;
    lossCount: number;
    winRate: number;
    avgPnlPct: number;
    summedTradePnlPct: number;
    avgWinPct: number;
    avgLossPct: number;
    totalPnlPct: number;
    profitFactor: number;
    maxDrawdownPct: number;
    summedTradeDrawdownPct: number;
    avgHoldBars: number;
    avgMfePct: number;
    avgMaePct: number;
    extensionProbability: number;
    mfePctP25: number;
    mfePctP50: number;
    mfePctP75: number;
    mfePctP90: number;
    maePctP25: number;
    maePctP50: number;
    maePctP75: number;
    maePctP90: number;
    barsToMfeP50: number;
    byEngine: Record<string, { count: number; wins: number; avgPnlPct: number; blockedCount: number }>;
    byExitReason: Record<string, number>;
    bySlStage: Record<string, number>;
    byRegime: Record<string, { count: number; wins: number; winRate: number }>;
    admissionPolicyEnabled?: boolean;
    admissionPolicyMode?: Crash300AdmissionPolicyMode;
    admissionPolicyConfig?: Crash300AdmissionPolicyConfig;
    candidatesBlockedByAdmissionPolicy?: number;
    blockedReasonsCounts?: Record<string, number>;
    tradesWouldHaveBeenBlocked?: number;
    winsBlocked?: number | null;
    lossesBlocked?: number | null;
    slHitsBlocked?: number | null;
    resultingWinRate?: number | null;
    resultingTradeCount?: number | null;
    capitalModel: {
      startingCapitalUsd: number;
      allocationPct: number;
      maxConcurrentTrades: number;
      compoundingEnabled: boolean;
      syntheticEquityUsd: number;
      syntheticPositionSizeUsd: number;
      equityCurveModel: string;
      tradePnlBasis: string;
    };
    endingCapitalUsd: number;
    netProfitUsd: number;
    accountReturnPct: number;
    allocatedCapitalReturnPct: number;
    averageTradePnlPct: number;
    maxDrawdownUsd: number;
    accountMaxDrawdownPct: number;
    largestWinUsd: number;
    largestLossUsd: number;
    averageWinUsd: number;
    averageLossUsd: number;
  };
}

export interface V3BacktestRequest {
  symbol: string;
  startTs?: number;
  endTs?: number;
  mode?: "paper" | "demo" | "real";
  tierMode?: BacktestTierMode;
  runtimeCalibrationOverride?: LiveCalibrationProfile | null;
  crash300AdmissionPolicy?: Partial<Crash300AdmissionPolicyConfig> | null;
  startingCapitalUsd?: number;
  cancellationCheck?: (() => Promise<void>) | null;
}

export type BacktestTierMode = "A" | "AB" | "ABC" | "ALL";

// â”€â”€ HTF regime averaging (local, isolated from live module cache) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface FeatureSample {
  emaSlope: number;
  rsi14: number;
  bbWidth: number;
  bbWidthRoc: number;
  atr14: number;
  atrRank: number;
  atrAccel: number;
  zScore: number;
  spikeHazardScore: number;
  bbPctB: number;
}

interface ReplayCandidateWindow {
  firstSeenTs: number;
  lastSeenTs: number;
  scanCount: number;
  bestScore: number;
  cooldownUntilTs: number;
}

function normalizeBacktestTierMode(value?: string | null): BacktestTierMode {
  const raw = String(value ?? "ALL").toUpperCase();
  return raw === "A" || raw === "AB" || raw === "ABC" ? raw : "ALL";
}

function allowedRuntimeQualityBands(mode: BacktestTierMode): RuntimeQualityBand[] | null {
  if (mode === "A") return ["A"];
  if (mode === "AB") return ["A", "B"];
  if (mode === "ABC") return ["A", "B", "C"];
  return null;
}

function allowedDetectedMoveTiers(mode: BacktestTierMode): Array<"A" | "B" | "C" | "D"> | null {
  if (mode === "A") return ["A"];
  if (mode === "AB") return ["A", "B"];
  if (mode === "ABC") return ["A", "B", "C"];
  return null;
}

// â”€â”€ Per-symbol context for synchronized multi-symbol replay â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface SymCtx {
  sym: string;
  instrumentFamily: "crash" | "boom" | "volatility";
  candles: CandleRow[];
  idxByTs: Map<number, number>;   // closeTs (epoch seconds) â†’ array index
  simStart: number;               // first index inside sim range

  // Shared platform state (derived once for all symbols)
  mode: string;
  modeGate: number;
  killSwitchActive: boolean;
  modeEnabled: boolean;
  symbolEnabled: boolean;
  maxOpenTrades: number;
  totalCapital: number;
  maxDailyLossPct: number;
  maxWeeklyLossPct: number;
  maxDrawdownThresholdPct: number;

  // HTF regime sample buffer (per-symbol; must not be shared)
  featureHistory: FeatureSample[];

  // Runtime simulation state
  openTrade: OpenTradeState | null;
  simEquity: number;
  simEquityPeak: number;
  simClosedPnls: Array<{ closeTs: number; pnlUsd: number }>;
  trades: V3BacktestTrade[];
  signalsFired: number;
  signalsBlocked: number;
  blockedByEngine: Record<string, number>;
  scoringSourceCounts: Record<string, number>;
  candidateWindows: Map<string, ReplayCandidateWindow>;
  crash300RuntimeState?: Crash300RuntimeState;
  detectedMoves: Array<{ startTs: number; endTs: number; direction: "up" | "down" | "unknown" }>;
  admissionPolicyBlockedCandidates: number;
  admissionPolicyBlockedReasonsCounts: Record<string, number>;
  runtimeCalibration: LiveCalibrationProfile | null;
  runtimeCalibrationResolution: LiveCalibrationProfileResolution | null;
  trailingActivationThresholdPct?: number;
  trailingDistancePct?: number;
  trailingMinHoldBars?: number;
}

function calcMoveOverlapDiagnostics(params: {
  moves: Array<{ startTs: number; endTs: number; direction: string }>;
  trades: V3BacktestTrade[];
}): V3BacktestResult["moveOverlap"] {
  const { moves, trades } = params;
  const directionMatches = (moveDir: string, tradeDir: "buy" | "sell") =>
    (moveDir === "up" && tradeDir === "buy") || (moveDir === "down" && tradeDir === "sell");
  const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) =>
    aStart <= bEnd && aEnd >= bStart;

  const moveDirectionSplit = moves.reduce<{ up: number; down: number }>((acc, m) => {
    if (m.direction === "up") acc.up += 1;
    else if (m.direction === "down") acc.down += 1;
    return acc;
  }, { up: 0, down: 0 });

  const capturedMoveIds = new Set<number>();
  moves.forEach((move, idx) => {
    const matched = trades.some((t) =>
      directionMatches(move.direction, t.direction) &&
      overlaps(move.startTs, move.endTs, t.entryTs, t.exitTs),
    );
    if (matched) capturedMoveIds.add(idx);
  });

  const matchedTradeIds = new Set<number>();
  trades.forEach((trade, idx) => {
    const matched = moves.some((move) =>
      directionMatches(move.direction, trade.direction) &&
      overlaps(move.startTs, move.endTs, trade.entryTs, trade.exitTs),
    );
    if (matched) matchedTradeIds.add(idx);
  });

  const movesInWindow = moves.length;
  const capturedMoves = capturedMoveIds.size;
  const missedMoves = Math.max(0, movesInWindow - capturedMoves);
  const tradesMatchedToMoves = matchedTradeIds.size;
  const ghostTrades = Math.max(0, trades.length - tradesMatchedToMoves);

  return {
    movesInWindow,
    capturedMoves,
    missedMoves,
    captureRate: movesInWindow > 0 ? capturedMoves / movesInWindow : 0,
    tradesMatchedToMoves,
    ghostTrades,
    ghostRate: trades.length > 0 ? ghostTrades / trades.length : 0,
    moveDirectionSplit,
  };
}

// â”€â”€ Percentile helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * p)));
  return sorted[idx];
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function runBacktestCancellationCheckpoint(
  cancellationCheck: (() => Promise<void>) | null | undefined,
  iteration: number,
  every: number,
): Promise<void> {
  if (!cancellationCheck) return;
  if (iteration === 0 || iteration % every === 0) {
    await cancellationCheck();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

// â”€â”€ Summary builder â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function computeSummary(
  trades: V3BacktestTrade[],
  blockedByEngine: Record<string, number>,
  admissionPolicyMeta?: V3BacktestResult["admissionPolicy"],
  accountingInput?: {
    startingCapitalUsd?: number;
    allocationPct?: number;
    maxConcurrentTrades?: number;
    compoundingEnabled?: boolean;
    syntheticEquityUsd?: number;
    syntheticPositionSizeUsd?: number;
  },
): V3BacktestResult["summary"] {
  const startingCapitalUsd = Math.max(1, accountingInput?.startingCapitalUsd ?? DEFAULT_REPORT_STARTING_CAPITAL_USD);
  const allocationPct = accountingInput?.allocationPct ?? DEFAULT_ALLOCATION_PCT;
  const maxConcurrentTrades = accountingInput?.maxConcurrentTrades ?? 1;
  const compoundingEnabled = accountingInput?.compoundingEnabled ?? false;
  const syntheticEquityUsd = accountingInput?.syntheticEquityUsd ?? SYNTHETIC_EQUITY;
  const syntheticPositionSizeUsd = accountingInput?.syntheticPositionSizeUsd ?? SYNTHETIC_SIZE;

  if (trades.length === 0) {
    return {
      tradeCount: 0, winCount: 0, lossCount: 0, winRate: 0,
      avgPnlPct: 0, summedTradePnlPct: 0, avgWinPct: 0, avgLossPct: 0, totalPnlPct: 0,
      profitFactor: 0, maxDrawdownPct: 0, summedTradeDrawdownPct: 0, avgHoldBars: 0,
      avgMfePct: 0, avgMaePct: 0, extensionProbability: 0,
      mfePctP25: 0, mfePctP50: 0, mfePctP75: 0, mfePctP90: 0,
      maePctP25: 0, maePctP50: 0, maePctP75: 0, maePctP90: 0,
      barsToMfeP50: 0,
      byEngine: {}, byExitReason: {}, bySlStage: {}, byRegime: {},
      admissionPolicyEnabled: admissionPolicyMeta?.enabled ?? false,
      admissionPolicyMode: admissionPolicyMeta?.mode ?? "off",
      admissionPolicyConfig: admissionPolicyMeta?.config ?? DEFAULT_CRASH300_ADMISSION_POLICY,
      candidatesBlockedByAdmissionPolicy: admissionPolicyMeta?.candidatesBlockedByAdmissionPolicy ?? 0,
      blockedReasonsCounts: admissionPolicyMeta?.blockedReasonsCounts ?? {},
      tradesWouldHaveBeenBlocked: admissionPolicyMeta?.tradesWouldHaveBeenBlocked ?? 0,
      winsBlocked: admissionPolicyMeta?.winsBlocked ?? null,
      lossesBlocked: admissionPolicyMeta?.lossesBlocked ?? null,
      slHitsBlocked: admissionPolicyMeta?.slHitsBlocked ?? null,
      resultingWinRate: admissionPolicyMeta?.resultingWinRate ?? 0,
      resultingTradeCount: admissionPolicyMeta?.resultingTradeCount ?? 0,
      capitalModel: {
        startingCapitalUsd,
        allocationPct,
        maxConcurrentTrades,
        compoundingEnabled,
        syntheticEquityUsd,
        syntheticPositionSizeUsd,
        equityCurveModel: "fixed-allocation-non-compounding-pnl-with-normalized-proxy-used-separately-for-risk-gates",
        tradePnlBasis: "trade.pnlPct is per-trade return on the synthetic allocated position size",
      },
      endingCapitalUsd: startingCapitalUsd,
      netProfitUsd: 0,
      accountReturnPct: 0,
      allocatedCapitalReturnPct: 0,
      averageTradePnlPct: 0,
      maxDrawdownUsd: 0,
      accountMaxDrawdownPct: 0,
      largestWinUsd: 0,
      largestLossUsd: 0,
      averageWinUsd: 0,
      averageLossUsd: 0,
    };
  }

  const wins = trades.filter(t => t.pnlPct > 0);
  const losses = trades.filter(t => t.pnlPct <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnlPct, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0));

  let equity = 0, peak = 0, maxDd = 0;
  for (const t of trades) {
    equity += t.pnlPct;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }

  const mfePcts = [...trades.map(t => t.mfePct)].sort((a, b) => a - b);
  const maePcts = [...trades.map(t => Math.abs(t.maePct))].sort((a, b) => a - b);
  const barsToMfe = [...trades.map(t => t.barsToMfe)].sort((a, b) => a - b);

  // Extension probability: % of trades that reached 50%+ of projected move
  const extended = trades.filter(t => {
    const proj = t.projectedMovePct;
    return proj > 0 && t.mfePct >= proj * 0.50;
  });
  const extensionProbability = trades.length > 0 ? extended.length / trades.length : 0;

  const byEngine: Record<string, { count: number; wins: number; avgPnlPct: number; blockedCount: number }> = {};
  for (const t of trades) {
    if (!byEngine[t.engineName]) {
      byEngine[t.engineName] = { count: 0, wins: 0, avgPnlPct: 0, blockedCount: blockedByEngine[t.engineName] ?? 0 };
    }
    byEngine[t.engineName].count++;
    if (t.pnlPct > 0) byEngine[t.engineName].wins++;
    byEngine[t.engineName].avgPnlPct += t.pnlPct;
  }
  for (const k of Object.keys(byEngine)) {
    byEngine[k].avgPnlPct /= byEngine[k].count;
  }

  const byExitReason: Record<string, number> = {};
  for (const t of trades) {
    byExitReason[t.exitReason] = (byExitReason[t.exitReason] ?? 0) + 1;
  }

  const bySlStage: Record<string, number> = {};
  for (const t of trades) {
    const key = `stage_${t.slStage}`;
    bySlStage[key] = (bySlStage[key] ?? 0) + 1;
  }

  const byRegime: Record<string, { count: number; wins: number; winRate: number }> = {};
  for (const t of trades) {
    if (!byRegime[t.regimeAtEntry]) byRegime[t.regimeAtEntry] = { count: 0, wins: 0, winRate: 0 };
    byRegime[t.regimeAtEntry].count++;
    if (t.pnlPct > 0) byRegime[t.regimeAtEntry].wins++;
  }
  for (const k of Object.keys(byRegime)) {
    byRegime[k].winRate = byRegime[k].count > 0 ? byRegime[k].wins / byRegime[k].count : 0;
  }

  const summedTradePnlPct = trades.reduce((s, t) => s + t.pnlPct, 0);
  const allocatedCapitalReturnPct = summedTradePnlPct;
  const accountReturnPct = summedTradePnlPct * allocationPct;
  const netProfitUsd = startingCapitalUsd * accountReturnPct;
  const endingCapitalUsd = startingCapitalUsd + netProfitUsd;
  const summedTradeDrawdownPct = maxDd;
  const accountMaxDrawdownPct = maxDd * allocationPct;
  const maxDrawdownUsd = startingCapitalUsd * accountMaxDrawdownPct;
  const winUsdValues = wins.map((trade) => trade.pnlPct * startingCapitalUsd * allocationPct);
  const lossUsdValues = losses.map((trade) => trade.pnlPct * startingCapitalUsd * allocationPct);
  const largestWinUsd = winUsdValues.length > 0 ? Math.max(...winUsdValues) : 0;
  const largestLossUsd = lossUsdValues.length > 0 ? Math.min(...lossUsdValues) : 0;
  const averageWinUsd = avg(winUsdValues);
  const averageLossUsd = avg(lossUsdValues);

  return {
    tradeCount: trades.length,
    winCount: wins.length,
    lossCount: losses.length,
    winRate: trades.length > 0 ? wins.length / trades.length : 0,
    avgPnlPct: trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length,
    summedTradePnlPct,
    avgWinPct: wins.length > 0 ? grossProfit / wins.length : 0,
    avgLossPct: losses.length > 0 ? -grossLoss / losses.length : 0,
    totalPnlPct: summedTradePnlPct,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    maxDrawdownPct: maxDd,
    summedTradeDrawdownPct,
    avgHoldBars: trades.reduce((s, t) => s + t.holdBars, 0) / trades.length,
    avgMfePct: trades.reduce((s, t) => s + t.mfePct, 0) / trades.length,
    avgMaePct: trades.reduce((s, t) => s + Math.abs(t.maePct), 0) / trades.length,
    extensionProbability,
    mfePctP25: percentile(mfePcts, 0.25),
    mfePctP50: percentile(mfePcts, 0.50),
    mfePctP75: percentile(mfePcts, 0.75),
    mfePctP90: percentile(mfePcts, 0.90),
    maePctP25: percentile(maePcts, 0.25),
    maePctP50: percentile(maePcts, 0.50),
    maePctP75: percentile(maePcts, 0.75),
    maePctP90: percentile(maePcts, 0.90),
    barsToMfeP50: percentile(barsToMfe, 0.50),
    byEngine,
    byExitReason,
    bySlStage,
    byRegime,
    admissionPolicyEnabled: admissionPolicyMeta?.enabled ?? false,
    admissionPolicyMode: admissionPolicyMeta?.mode ?? "off",
    admissionPolicyConfig: admissionPolicyMeta?.config ?? DEFAULT_CRASH300_ADMISSION_POLICY,
    candidatesBlockedByAdmissionPolicy: admissionPolicyMeta?.candidatesBlockedByAdmissionPolicy ?? 0,
    blockedReasonsCounts: admissionPolicyMeta?.blockedReasonsCounts ?? {},
    tradesWouldHaveBeenBlocked: admissionPolicyMeta?.tradesWouldHaveBeenBlocked ?? 0,
    winsBlocked: admissionPolicyMeta?.winsBlocked ?? null,
    lossesBlocked: admissionPolicyMeta?.lossesBlocked ?? null,
    slHitsBlocked: admissionPolicyMeta?.slHitsBlocked ?? null,
    resultingWinRate: admissionPolicyMeta?.resultingWinRate ?? (trades.length > 0 ? wins.length / trades.length : 0),
    resultingTradeCount: admissionPolicyMeta?.resultingTradeCount ?? trades.length,
    capitalModel: {
      startingCapitalUsd,
      allocationPct,
      maxConcurrentTrades,
      compoundingEnabled,
      syntheticEquityUsd,
      syntheticPositionSizeUsd,
      equityCurveModel: "fixed-allocation-non-compounding-pnl-with-normalized-proxy-used-separately-for-risk-gates",
      tradePnlBasis: "trade.pnlPct is per-trade return on the synthetic allocated position size",
    },
    endingCapitalUsd,
    netProfitUsd,
    accountReturnPct,
    allocatedCapitalReturnPct,
    averageTradePnlPct: trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length,
    maxDrawdownUsd,
    accountMaxDrawdownPct,
    largestWinUsd,
    largestLossUsd,
    averageWinUsd,
    averageLossUsd,
  };
}

// â”€â”€ Instrument family helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function getInstrumentFamily(symbol: string): "crash" | "boom" | "volatility" {
  if (symbol.startsWith("CRASH")) return "crash";
  if (symbol.startsWith("BOOM")) return "boom";
  return "volatility";
}

function getModePrefix(mode: "paper" | "demo" | "real"): "paper" | "demo" | "real" {
  return mode === "real" ? "real" : mode === "demo" ? "demo" : "paper";
}

function isModeEnabledFromState(stateMap: Record<string, string>, prefix: string): boolean {
  return (
    stateMap[`${prefix}_mode_active`] === "true" ||
    stateMap[`${prefix}_mode`] === "active" ||
    stateMap[`${prefix}_enabled`] === "true"
  );
}

function isSymbolEnabledFromState(stateMap: Record<string, string>, prefix: string, symbol: string): boolean {
  const modeSymbolsRaw = stateMap[`${prefix}_enabled_symbols`] || stateMap["enabled_symbols"] || "";
  const modeSymbols = modeSymbolsRaw ? modeSymbolsRaw.split(",").map((s) => s.trim()).filter(Boolean) : null;
  return !modeSymbols || modeSymbols.includes(symbol);
}

function resolveModeScoreGate(
  stateMap: Record<string, string>,
  prefix: string,
  mode: "paper" | "demo" | "real",
  runtimeCalibration: LiveCalibrationProfile | null,
): number {
  const modeDefaultGate = MODE_SCORE_GATES[mode] ?? 60;
  const calibratedGate = runtimeCalibration?.recommendedScoreGates?.[mode];
  if (calibratedGate != null) return calibratedGate;
  const gateFromState = stateMap[`${prefix}_min_composite_score`] || stateMap["min_composite_score"];
  return gateFromState ? parseFloat(gateFromState) : modeDefaultGate;
}

// â”€â”€ Open trade state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface OpenTradeState {
  winner: EngineResult;
  entryBar: number;
  entryPrice: number;
  entryTs: number;
  regimeAtEntry: string;
  regimeConfidence: number;
  nativeScore: number;
  conflictResolution: string;
  scoringSource?: string;
  runtimeModelRunId?: number | null;
  runtimeProjectedMovePct?: number;
  tp: number;
  sl: number;
  originalSl: number;
  stage: 1 | 2 | 3;
  peakPrice: number;
  mfePct: number;
  maePct: number;
  mfePeakBar: number;
  beTriggeredBar: number;
  mfePctAtBreakeven: number;
  atr14AtEntry: number;
  instrumentFamily: "crash" | "boom" | "volatility";
  emaSlope: number;
  spikeCount4h: number;
  adverseCandleCount: number;
  tpPct: number;
  slOriginalPct: number;
  tpProgressAtBe: number;
  trailingActivationThresholdPct?: number;
  trailingDistancePct?: number;
  trailingMinHoldBars?: number;
  runtimeFamily?: string | null;
  selectedBucket?: string | null;
  qualityTier?: string | null;
  confidence?: number | null;
  setupMatch?: number | null;
  trailingActivated?: boolean;
  contextSnapshotAtEntry?: Record<string, unknown> | null;
  triggerSnapshotAtEntry?: Record<string, unknown> | null;
  contextFamilyCandidates?: Array<Record<string, unknown>> | null;
  selectedContextFamily?: string | null;
  selectedTriggerTransition?: string | null;
  triggerDirection?: string | null;
  triggerStrengthScore?: number | null;
  contextAgeBars?: number | null;
  contextAgeMinutes?: number | null;
  triggerAgeBars?: number | null;
  triggerFresh?: boolean | null;
  contextEpochId?: string | null;
  duplicateWithinContextEpoch?: boolean | null;
  previousTradeInSameContextEpoch?: string | null;
  wouldBlockNoTrigger?: boolean | null;
  wouldBlockStaleContext?: boolean | null;
  wouldBlockDuplicateEpoch?: boolean | null;
  wouldBlockDirectionMismatch?: boolean | null;
  wouldBlockLateAfterMoveWindow?: boolean | null;
  admissionPolicyWouldBlock?: boolean | null;
  admissionPolicyBlockedReasons?: string[] | null;
  admissionPolicyMode?: Crash300AdmissionPolicyMode | null;
}

interface BacktestTrailingConfig {
  trailingActivationThresholdPct?: number;
  trailingDistancePct?: number;
  trailingMinHoldBars?: number;
}

function resolveTrailingConfigFromProfile(
  trailingModel: Record<string, unknown>,
): BacktestTrailingConfig {
  const activationPctRaw = Number(trailingModel.activationProfitPct ?? 0);
  const distancePctRaw = Number(trailingModel.trailingDistancePct ?? 0);
  const minHoldBarsRaw = Number(trailingModel.minHoldMinutesBeforeTrail ?? 0);

  return {
    trailingActivationThresholdPct:
      Number.isFinite(activationPctRaw) && activationPctRaw > 0
        ? Math.max(0.05, Math.min(0.9, activationPctRaw / 100))
        : undefined,
    trailingDistancePct:
      Number.isFinite(distancePctRaw) && distancePctRaw > 0
        ? Math.max(0.001, Math.min(0.8, distancePctRaw / 100))
        : undefined,
    trailingMinHoldBars:
      Number.isFinite(minHoldBarsRaw) && minHoldBarsRaw > 0
        ? Math.max(1, Math.min(MAX_HOLD_MINS, Math.round(minHoldBarsRaw)))
        : undefined,
  };
}

function runtimeModelDiagnostics(
  resolution: LiveCalibrationProfileResolution | null,
  scoringSourceCounts: Record<string, number> = {},
): V3BacktestResult["runtimeModel"] {
  const runtimeCalibration = resolution?.profile ?? null;
  const tpBuckets = runtimeCalibration?.tpModel?.["buckets"];
  const tpBucketCount = tpBuckets && typeof tpBuckets === "object" && !Array.isArray(tpBuckets)
    ? Object.keys(tpBuckets).length
    : 0;

  return {
    enabled: Boolean(runtimeCalibration),
    applied: resolution?.applied ?? false,
    reason: resolution?.reason ?? "not_resolved",
    useCalibratedRuntimeProfiles: resolution?.useCalibratedRuntimeProfiles ?? false,
    mode: resolution?.mode ?? null,
    source: runtimeCalibration?.source ?? null,
    sourceRunId: runtimeCalibration?.sourceRunId ?? null,
    entryModel: runtimeCalibration?.entryModel ?? null,
    tpBucketCount,
    dynamicTpEnabled: runtimeCalibration?.tpModel?.["dynamicByQualityLeadIn"] === true && tpBucketCount > 0,
    modelSourceCounts: scoringSourceCounts,
  };
}

type PolicyDetectedMove = {
  startTs: number;
  endTs: number;
  direction: "up" | "down" | "unknown";
};

function normalizePolicyMoveDirection(value: unknown): "up" | "down" | "unknown" {
  if (value === "up" || value === "down") return value;
  return "unknown";
}

function familyDirectionForAdmission(runtimeFamily: string | null | undefined): "buy" | "sell" | "unknown" {
  const family = String(runtimeFamily ?? "").trim().toLowerCase();
  if (["drift_continuation_up", "post_crash_recovery_up", "bear_trap_reversal_up"].includes(family)) return "buy";
  if (["failed_recovery_short", "crash_event_down", "bull_trap_reversal_down"].includes(family)) return "sell";
  return "unknown";
}

function bucketDirectionForAdmission(selectedBucket: string | null | undefined): "buy" | "sell" | "unknown" {
  const direction = String(selectedBucket ?? "").trim().split("|")[0] ?? "";
  if (direction === "up") return "buy";
  if (direction === "down") return "sell";
  return "unknown";
}

function matchDetectedMoveForAdmission(
  entryTs: number,
  tradeDirection: "buy" | "sell",
  moves: PolicyDetectedMove[],
): PolicyDetectedMove | null {
  const expectedDirection = tradeDirection === "buy" ? "up" : "down";
  const inside = moves.filter((move) => entryTs >= move.startTs && entryTs <= move.endTs);
  const insideSameDirection = inside.filter((move) => move.direction === expectedDirection);
  if (insideSameDirection.length > 0) {
    return insideSameDirection.sort((a, b) => Math.abs(entryTs - a.startTs) - Math.abs(entryTs - b.startTs))[0] ?? null;
  }
  if (inside.length > 0) {
    return inside.sort((a, b) => Math.abs(entryTs - a.startTs) - Math.abs(entryTs - b.startTs))[0] ?? null;
  }
  const sameDirection = moves.filter((move) => move.direction === expectedDirection);
  const source = sameDirection.length > 0 ? sameDirection : moves;
  return source.sort((a, b) => Math.abs(entryTs - a.startTs) - Math.abs(entryTs - b.startTs))[0] ?? null;
}

function bumpReasonCounts(target: Record<string, number>, reasons: string[]) {
  for (const reason of reasons) {
    target[reason] = (target[reason] ?? 0) + 1;
  }
}

function buildAdmissionPolicyMeta(params: {
  config: Crash300AdmissionPolicyConfig;
  trades: V3BacktestTrade[];
  blockedCandidateCount: number;
  blockedReasonsCounts: Record<string, number>;
}): V3BacktestResult["admissionPolicy"] {
  const { config, trades, blockedCandidateCount, blockedReasonsCounts } = params;
  const wouldBlockTrades = trades.filter((trade) => trade.admissionPolicyWouldBlock === true);
  const remainingTrades = config.enabled && config.mode === "preview"
    ? trades.filter((trade) => trade.admissionPolicyWouldBlock !== true)
    : trades;
  const remainingWins = remainingTrades.filter((trade) => trade.pnlPct > 0).length;
  const winsBlocked = wouldBlockTrades.filter((trade) => trade.pnlPct > 0).length;
  const lossesBlocked = wouldBlockTrades.filter((trade) => trade.pnlPct <= 0).length;
  const slHitsBlocked = wouldBlockTrades.filter((trade) => trade.exitReason === "sl_hit").length;
  return {
    enabled: config.enabled,
    mode: config.enabled ? config.mode : "off",
    config,
    candidatesBlockedByAdmissionPolicy: Math.max(blockedCandidateCount, wouldBlockTrades.length),
    blockedReasonsCounts,
    tradesWouldHaveBeenBlocked: wouldBlockTrades.length,
    winsBlocked: config.enabled ? winsBlocked : 0,
    lossesBlocked: config.enabled ? lossesBlocked : 0,
    slHitsBlocked: config.enabled ? slHitsBlocked : 0,
    resultingWinRate: remainingTrades.length > 0 ? remainingWins / remainingTrades.length : 0,
    resultingTradeCount: remainingTrades.length,
  };
}

function scoringSourceFromWinner(winner: EngineResult): string {
  const source = winner.metadata?.["crash300ScoringSource"];
  return typeof source === "string" ? source : "native_engine";
}

function winnerSymbolServiceDecision(
  winner: EngineResult,
): Record<string, unknown> {
  const decision = winner.metadata?.["symbolServiceDecision"];
  return decision && typeof decision === "object" && !Array.isArray(decision)
    ? (decision as Record<string, unknown>)
    : {};
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function optionalNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function optionalBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value == null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return null;
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalRecordArray(value: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(value)) return null;
  const rows = value.filter((row) => row && typeof row === "object" && !Array.isArray(row)) as Array<Record<string, unknown>>;
  return rows.length > 0 ? rows : null;
}

function parseRuntimeWindowSeconds(raw: string | undefined, fallbackSeconds: number): number {
  if (!raw) return fallbackSeconds;
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(m|min|mins|h|hr|hrs|hour|hours)?$/i);
  if (!match) return fallbackSeconds;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return fallbackSeconds;
  const unit = (match[2] ?? "m").toLowerCase();
  const minutes = unit.startsWith("h") ? value * 60 : value;
  return Math.max(30, Math.round(minutes)) * 60;
}

function runtimeCandidateWindowSeconds(runtimeCalibration: LiveCalibrationProfile | null): number {
  if (!runtimeCalibration) return 0;
  return parseRuntimeWindowSeconds(runtimeCalibration.confirmationWindow, 2 * 60 * 60);
}

function runtimeCandidateCooldownSeconds(runtimeCalibration: LiveCalibrationProfile | null): number {
  if (!runtimeCalibration) return 0;
  const confirmationSeconds = runtimeCandidateWindowSeconds(runtimeCalibration);
  const minHoldMinutes = Number(runtimeCalibration.trailingModel?.["minHoldMinutesBeforeTrail"] ?? 0);
  const minHoldSeconds = Number.isFinite(minHoldMinutes) && minHoldMinutes > 0
    ? minHoldMinutes * 60
    : 0;
  return Math.max(confirmationSeconds * 2, minHoldSeconds, 4 * 60 * 60);
}

function replayCandidateKey(symbol: string, engineName: string, direction: string, setupSignature: string | null): string {
  return `${symbol}|${engineName}|${direction}|${setupSignature ?? "native"}`;
}

function evaluateReplayCandidateWindow(params: {
  windows: Map<string, ReplayCandidateWindow>;
  runtimeCalibration: LiveCalibrationProfile | null;
  symbol: string;
  engineName: string;
  direction: "buy" | "sell";
  nativeScore: number;
  setupSignature?: string | null;
  ts: number;
}): { allowed: boolean; reason: string; key: string } {
  const key = replayCandidateKey(params.symbol, params.engineName, params.direction, params.setupSignature ?? null);
  const confirmationSeconds = runtimeCandidateWindowSeconds(params.runtimeCalibration);
  if (!params.runtimeCalibration || confirmationSeconds <= 0) {
    return { allowed: true, reason: "native", key };
  }

  const existing = params.windows.get(key);
  if (existing && params.ts < existing.cooldownUntilTs) {
    return { allowed: false, reason: "runtime_candidate_cooldown", key };
  }

  if (!existing || params.ts - existing.lastSeenTs > confirmationSeconds * 2) {
    params.windows.set(key, {
      firstSeenTs: params.ts,
      lastSeenTs: params.ts,
      scanCount: 1,
      bestScore: params.nativeScore,
      cooldownUntilTs: 0,
    });
    return { allowed: false, reason: "runtime_candidate_monitoring", key };
  }

  existing.lastSeenTs = params.ts;
  existing.scanCount += 1;
  existing.bestScore = Math.max(existing.bestScore, params.nativeScore);

  if (params.ts - existing.firstSeenTs < confirmationSeconds || existing.scanCount < 2) {
    return { allowed: false, reason: "runtime_candidate_monitoring", key };
  }

  if (params.nativeScore < existing.bestScore - 8) {
    existing.firstSeenTs = params.ts;
    existing.scanCount = 1;
    existing.bestScore = params.nativeScore;
    return { allowed: false, reason: "runtime_candidate_deteriorated", key };
  }

  return { allowed: true, reason: "runtime_candidate_tradeable", key };
}

function markReplayCandidateExecuted(
  windows: Map<string, ReplayCandidateWindow>,
  key: string,
  ts: number,
  runtimeCalibration: LiveCalibrationProfile | null,
): void {
  const existing = windows.get(key);
  if (!existing) return;
  existing.cooldownUntilTs = ts + runtimeCandidateCooldownSeconds(runtimeCalibration);
  existing.firstSeenTs = ts;
  existing.lastSeenTs = ts;
  existing.scanCount = 0;
}

async function resolveBacktestTrailingConfig(
  symbol: string,
  mode: "paper" | "demo" | "real",
  stateMap: Record<string, string>,
): Promise<BacktestTrailingConfig> {
  const profile = await getLiveCalibrationProfile(symbol, mode, stateMap).catch(() => null);
  if (!profile) return {};
  return resolveTrailingConfigFromProfile(profile.trailingModel ?? {});
}

// â”€â”€ Simulation gap documentation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Flags fetched from DB at run start (same source as live allocator):
//   - killSwitchActive: read from platformState["kill_switch"]
//   - modeEnabled:      read from platformState prefix (same logic as allocateV3Signal)
//   - symbolEnabled:    read from platformState prefix_enabled_symbols list
// Computed from simulation state per bar:
//   - dailyLossLimitBreached:  derived from simClosedPnls (within last 24h of replay ts)
//   - weeklyLossLimitBreached: derived from simClosedPnls (within last 7d of replay ts)
// Remaining true simulation gaps (require live cross-symbol PnL, unavailable here):
//   - maxDrawdownBreached:     assumed false (no cross-symbol equity curve)
//   - correlatedFamilyCapBreached: assumed false (no cross-symbol state)
//   - maxOpenTrades: set to 1 (single-symbol backtest; no cross-symbol tracking)
// Score gate (gate 4) and one-per-symbol (gate 5) are fully simulated.

// â”€â”€ Shared portfolio ledger for synchronized multi-symbol replay â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Tracks ALL open positions across symbols in time order. Used by
// runV3BacktestMulti so gates 6 (maxOpenTrades) and 10 (correlatedFamilyCap)
// are evaluated with real cross-symbol portfolio state â€” the same semantics
// as the live portfolioAllocatorV3 path.
//
// Positions are recorded by the timestamp of the bar that opened/closed them,
// enabling correct portfolio-state queries at any bar time T regardless of
// the order in which symbols are replayed.

export class SharedPortfolioLedger {
  private history: Array<{
    symbol: string;
    family: string;
    openTs: number;    // bar closeTs (ms) when position was opened
    closeTs: number;   // bar closeTs (ms) when position was closed; Infinity = still open
  }> = [];
  private openBySymbol = new Map<string, string>(); // symbol â†’ family, for open positions

  /** Record a new position opening. openTs is the bar closeTs in ms. */
  open(symbol: string, family: string, openTs: number): void {
    this.history.push({ symbol, family, openTs, closeTs: Infinity });
    this.openBySymbol.set(symbol, family);
  }

  /** Record a position closing. closeTs is the bar closeTs in ms. */
  close(symbol: string, closeTs: number): void {
    const pos = [...this.history].reverse().find(p => p.symbol === symbol && p.closeTs === Infinity);
    if (pos) pos.closeTs = closeTs;
    this.openBySymbol.delete(symbol);
  }

  /** Count of positions open at bar time T (inclusive). */
  getOpenCount(atTs: number): number {
    return this.history.filter(p => p.openTs <= atTs && p.closeTs > atTs).length;
  }

  /** Count of positions in a given instrument family that are open at bar time T. */
  getFamilyOpenCount(family: string, atTs: number): number {
    return this.history.filter(p => p.family === family && p.openTs <= atTs && p.closeTs > atTs).length;
  }

  /** True if the given symbol has an open position at bar time T. */
  isSymbolOpen(symbol: string, atTs: number): boolean {
    return this.history.some(p => p.symbol === symbol && p.openTs <= atTs && p.closeTs > atTs);
  }
}

// â”€â”€ Core simulation loop â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function runV3Backtest(
  req: V3BacktestRequest,
  sharedLedger?: SharedPortfolioLedger,
): Promise<V3BacktestResult> {
  const now = Math.floor(Date.now() / 1000);
  const startTs = req.startTs ?? (now - 90 * 86400);
  const endTs = req.endTs ?? now;
  const symbol = req.symbol;
  const mode = req.mode ?? "paper";
  const tierMode = normalizeBacktestTierMode(req.tierMode);
  const startingCapitalUsd = Math.max(1, Number(req.startingCapitalUsd ?? DEFAULT_REPORT_STARTING_CAPITAL_USD));
  const cancellationCheck = req.cancellationCheck ?? null;
  const runtimeQualityBands = allowedRuntimeQualityBands(tierMode);
  const detectedMoveTiers = allowedDetectedMoveTiers(tierMode);
  const crash300AdmissionPolicy = normalizeCrash300AdmissionPolicyConfig(req.crash300AdmissionPolicy);

  const bufferStartTs = startTs - STRUCTURAL_LOOKBACK * 60;

  const rawCandles = await db.select({
    open: candlesTable.open,
    high: candlesTable.high,
    low: candlesTable.low,
    close: candlesTable.close,
    openTs: candlesTable.openTs,
    closeTs: candlesTable.closeTs,
  }).from(candlesTable)
    .where(
      and(
        eq(candlesTable.symbol, symbol),
        eq(candlesTable.timeframe, "1m"),
        gte(candlesTable.openTs, bufferStartTs),
        lte(candlesTable.openTs, endTs)
      )
    )
    .orderBy(asc(candlesTable.openTs));

  if (rawCandles.length < 60) {
    return {
      symbol, mode, tierMode, startTs, endTs, totalBars: 0,
      modeScoreGate: MODE_SCORE_GATES[mode] ?? 60,
      signalsFired: 0, signalsBlocked: 0, blockedRate: 0,
      runtimeModel: runtimeModelDiagnostics(null),
      admissionPolicy: buildAdmissionPolicyMeta({
        config: crash300AdmissionPolicy,
        trades: [],
        blockedCandidateCount: 0,
        blockedReasonsCounts: {},
      }),
      trades: [],
      simulationGaps: [],
      moveOverlap: {
        movesInWindow: 0,
        capturedMoves: 0,
        missedMoves: 0,
        captureRate: 0,
        tradesMatchedToMoves: 0,
        ghostTrades: 0,
        ghostRate: 0,
        moveDirectionSplit: { up: 0, down: 0 },
      },
      summary: computeSummary([], {}, buildAdmissionPolicyMeta({
        config: crash300AdmissionPolicy,
        trades: [],
        blockedCandidateCount: 0,
        blockedReasonsCounts: {},
      }), {
        startingCapitalUsd,
        allocationPct: DEFAULT_ALLOCATION_PCT,
        maxConcurrentTrades: 1,
        compoundingEnabled: false,
        syntheticEquityUsd: SYNTHETIC_EQUITY,
        syntheticPositionSizeUsd: SYNTHETIC_SIZE,
      }),
    };
  }

  const candles = rawCandles as CandleRow[];

  let simStart = candles.findIndex(c => c.openTs >= startTs);
  if (simStart < 0) simStart = candles.length - 1;
  if (simStart < STRUCTURAL_LOOKBACK) simStart = STRUCTURAL_LOOKBACK;

  // â”€â”€ Fetch platformState flags (same source as live allocator) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Reads the exact same keys that portfolioAllocatorV3.allocateV3Signal reads.
  // Kill switch, mode-enabled, and symbol-enabled flags are NOT hardcoded.
  const platformRows = await db.select().from(platformStateTable);
  const stateMap: Record<string, string> = {};
  for (const r of platformRows) stateMap[r.key] = r.value;

  const modePrefix = getModePrefix(mode);
  const killSwitchActive = stateMap["kill_switch"] === "true";
  const modeEnabled = isModeEnabledFromState(stateMap, modePrefix);
  const symbolEnabled = isSymbolEnabledFromState(stateMap, modePrefix, symbol);

  const instrumentFamily = getInstrumentFamily(symbol);
  const htfMins = getSymbolIndicatorTimeframeMins(symbol);
  const indicatorLookback = 55 * htfMins;

  const trades: V3BacktestTrade[] = [];
  let openTrade: OpenTradeState | null = null;
  const featureHistory: FeatureSample[] = [];
  const crash300RuntimeState: Crash300RuntimeState = {
    currentEpoch: null,
    previousEpochId: null,
    lastValidTriggerTs: null,
    lastValidTriggerDirection: null,
    lastValidTriggerStrength: null,
  };
  let signalsFired = 0;
  let signalsBlocked = 0;
  const blockedByEngine: Record<string, number> = {};
  const scoringSourceCounts: Record<string, number> = {};
  const candidateWindows = new Map<string, ReplayCandidateWindow>();
  let admissionPolicyBlockedCandidates = 0;
  const admissionPolicyBlockedReasonsCounts: Record<string, number> = {};

  // â”€â”€ Simulation PnL state â€” used to evaluate daily/weekly risk gates â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Tracks closed simulation trades with their close timestamp and $ PnL so
  // that dailyLossLimitBreached and weeklyLossLimitBreached are computed from
  // replay state rather than assumed false.
  const simClosedPnls: Array<{ closeTs: number; pnlUsd: number }> = [];
  const maxDailyLossPct  = parseFloat(stateMap[`${modePrefix}_max_daily_loss_pct`] || stateMap["max_daily_loss_pct"] || "5") / 100;
  const maxWeeklyLossPct = parseFloat(stateMap[`${modePrefix}_max_weekly_loss_pct`] || stateMap["max_weekly_loss_pct"] || "10") / 100;

  // totalCapital: read from platformState using same key/default as live allocator
  // (portfolioAllocatorV3.ts getModeCapitalKey/getModeCapitalDefault).
  // Loss limits are expressed as a % of total capital â€” using SYNTHETIC_SIZE (~1500)
  // instead would cause gates to trigger at a completely different threshold.
  const capitalKey = getModeCapitalKey(mode as "paper" | "demo" | "real");
  const capitalDefault = getModeCapitalDefault(mode as "paper" | "demo" | "real");
  const totalCapital = Math.max(1, parseFloat(stateMap[capitalKey] || stateMap["total_capital"] || capitalDefault));

  // â”€â”€ Running equity curve â€” used to compute maxDrawdownBreached per bar â”€â”€â”€â”€â”€â”€â”€
  // Normalized to 1.0 start. Updated whenever a trade closes so each new entry
  // evaluation sees the current drawdown level (not assumed false).
  let simEquity     = 1.0;
  let simEquityPeak = 1.0;
  const maxDrawdownThresholdPct = parseFloat(
    stateMap[`${modePrefix}_max_drawdown_pct`] || stateMap["max_drawdown_pct"] || "20"
  ) / 100;

  if (mode === "real") {
    console.error(
      `[BacktestRunner] REAL-MODE PARITY WARNING: ${symbol} backtest cannot achieve full ` +
      `allocator parity â€” cross-symbol portfolio state (correlatedFamilyCapBreached, ` +
      `multi-symbol equity curve) is unavailable in single-symbol replay. ` +
      `Results are directionally valid but NOT safe for real-mode deployment decisions.`
    );
  }

  // maxOpenTrades: read from platformState (same key/default as live portfolioAllocatorV3).
  // In a single-symbol replay, currentOpenCount is 0 or 1 â€” this gate only fires if the
  // platform is configured for maxOpenTrades=1, which is a deliberate operator choice.
  const maxOpenTrades = parseInt(
    stateMap[`${modePrefix}_max_open_trades`] || stateMap["max_open_trades"] || "3"
  );
  const runtimeCalibrationResolution = req.runtimeCalibrationOverride
    ? {
        profile: req.runtimeCalibrationOverride,
        applied: true,
        reason: "applied" as const,
        symbol,
        mode: mode as "paper" | "demo" | "real",
        useCalibratedRuntimeProfiles: true,
      }
    : await resolveLiveCalibrationProfile(symbol, mode as "paper" | "demo" | "real", stateMap).catch(() => null);
  const runtimeCalibration = runtimeCalibrationResolution?.profile ?? null;
  if (symbol === "CRASH300" && !runtimeCalibration) {
    throw new Error("CRASH300 runtime model missing/invalid. Cannot evaluate symbol service.");
  }
  const detectedMovesForPolicy = symbol === "CRASH300"
    ? await db
        .select({
          startTs: detectedMovesTable.startTs,
          endTs: detectedMovesTable.endTs,
          direction: detectedMovesTable.direction,
          qualityTier: detectedMovesTable.qualityTier,
        })
        .from(detectedMovesTable)
        .where(and(
          eq(detectedMovesTable.symbol, symbol),
          gte(detectedMovesTable.endTs, startTs),
          lte(detectedMovesTable.startTs, endTs),
        ))
    : [];
  const filteredDetectedMovesForPolicy: PolicyDetectedMove[] = detectedMovesForPolicy
    .filter((move) => !detectedMoveTiers || detectedMoveTiers.includes(move.qualityTier as "A" | "B" | "C" | "D"))
    .map((move) => ({
      startTs: move.startTs,
      endTs: move.endTs,
      direction: normalizePolicyMoveDirection(move.direction),
    }));
  const modeGate = resolveModeScoreGate(stateMap, modePrefix, mode, runtimeCalibration);
  const trailingCfg = runtimeCalibration
    ? resolveTrailingConfigFromProfile(runtimeCalibration.trailingModel ?? {})
    : {};

  // â”€â”€ Simulation parity gaps carried in the response â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // - maxDrawdownBreached: computed from running single-symbol equity (not assumed false)
  // - dailyLossLimitBreached/weeklyLossLimitBreached: computed from sim PnLs w/ real totalCapital
  // - maxOpenTrades: read from platformState (same formula as live allocator)
  // - correlatedFamilyCapBreached: always false â€” IDENTICAL to live allocator (portfolioAllocatorV3.ts:119)
  //   The live path also hardcodes this to false; no gap exists between live and backtest here.
  // REMAINING TRUE GAP: single-symbol replay cannot model cross-symbol portfolio state.
  // (multi-symbol concurrent positions, correlated family exposure from other symbols)
  const runSimulationGaps: string[] = [
    "cross_symbol_portfolio_state_unavailable(single_symbol_replay_cannot_model_concurrent_positions_in_other_symbols)",
  ];

  for (let i = simStart; i < candles.length; i++) {
    await runBacktestCancellationCheckpoint(cancellationCheck, i - simStart, 100);
    const sliceStart = Math.max(0, i - STRUCTURAL_LOOKBACK + 1);
    const slice = candles.slice(sliceStart, i + 1);
    const bar = candles[i];

    // â”€â”€ Manage open trade â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (openTrade !== null) {
      const dir = openTrade.winner.direction;
      const ep = openTrade.entryPrice;
      const holdBars = i - openTrade.entryBar;

      // â”€â”€ Shared bar-state transitions (peak tracking, MFE/MAE, BE, trailing) â”€â”€
      // Uses applyBarStateTransitions from tradeManagement.ts â€” identical logic
      // consumed by both live manageOpenPositions and historical replay.
      const prevPeakPrice = openTrade.peakPrice;
      const barState = applyBarStateTransitions({
        direction: dir,
        entryPrice: ep,
        tp: openTrade.tp,
        holdBars,
        barHigh: bar.high,
        barLow: bar.low,
        barClose: bar.close,
        barOpen: bar.open,
        stage: openTrade.stage,
        sl: openTrade.sl,
        peakPrice: openTrade.peakPrice,
        mfePct: openTrade.mfePct,
        maePct: openTrade.maePct,
        adverseCandleCount: openTrade.adverseCandleCount,
        atr14AtEntry: openTrade.atr14AtEntry,
        instrumentFamily: openTrade.instrumentFamily,
        emaSlope: openTrade.emaSlope,
        spikeCount4h: openTrade.spikeCount4h,
        trailingActivationThresholdPct: openTrade.trailingActivationThresholdPct,
        trailingMinHoldBars: openTrade.trailingMinHoldBars,
        trailingDistancePct: openTrade.trailingDistancePct,
      });

      openTrade.sl               = barState.sl;
      openTrade.stage            = barState.stage;
      openTrade.peakPrice        = barState.peakPrice;
      openTrade.mfePct           = barState.mfePct;
      openTrade.maePct           = barState.maePct;
      openTrade.trailingActivated = openTrade.trailingActivated || barState.stage === 3;
      openTrade.adverseCandleCount = barState.adverseCandleCount;
      if (barState.peakPrice !== prevPeakPrice) openTrade.mfePeakBar = i;

      if (barState.bePromoted) {
        openTrade.mfePctAtBreakeven = barState.mfePctAtPromotion;
        openTrade.beTriggeredBar    = i;
        openTrade.tpProgressAtBe    = barState.tpProgressAtBe;
        recordBehaviorEvent({
          eventType: "breakeven_promoted",
          symbol,
          engineName: openTrade.winner.engineName,
          direction: dir,
          holdBarsAtPromotion: holdBars,
          mfePctAtPromotion: barState.mfePctAtPromotion,
          tpProgressAtPromotion: barState.tpProgressAtBe,
          ts: bar.closeTs,
        });
      }

      if (barState.trailingActivated) {
        recordBehaviorEvent({
          eventType: "trailing_activated",
          symbol,
          engineName: openTrade.winner.engineName,
          direction: dir,
          holdBarsAtActivation: holdBars,
          mfePctAtActivation: barState.mfePct,
          tpProgressAtActivation: barState.tpProgressAtTrailing,
          ts: bar.closeTs,
        });
      }

      // â”€â”€ Exit checks â€” uses shared evaluateBarExits (SL checked BEFORE TP) â”€â”€
      // SL-first priority matches live manageOpenPositions (eliminates same-bar
      // divergence where backtest used TP-first, live uses SL-first).
      const barExit = evaluateBarExits({
        direction: dir,
        barHigh: bar.high,
        barLow: bar.low,
        barClose: bar.close,
        tp: openTrade.tp,
        sl: openTrade.sl,
      });

      let exitReason: V3BacktestTrade["exitReason"] | null =
        barExit.exitReason === "sl_hit" && openTrade.stage === 3
          ? "trailing_stop"
          : barExit.exitReason;
      let exitPrice = barExit.exitPrice;

      // Max duration â€” shared MAX_HOLD_MINS from tradeManagement.ts
      // For 1m bars holdBars === holdMins; MAX_HOLD_MINS applies directly
      if (!exitReason && holdBars >= MAX_HOLD_MINS) {
        exitReason = "max_duration";
        exitPrice = bar.close;
      }

      if (exitReason) {
        const finalPnl = dir === "buy"
          ? (exitPrice - ep) / ep
          : (ep - exitPrice) / ep;

        const barsToMfe = openTrade.mfePeakBar > openTrade.entryBar
          ? openTrade.mfePeakBar - openTrade.entryBar
          : holdBars;
        const barsToBreakeven = openTrade.beTriggeredBar > 0
          ? openTrade.beTriggeredBar - openTrade.entryBar
          : 0;

        const trade: V3BacktestTrade = {
          entryTs: openTrade.entryTs,
          exitTs: bar.closeTs,
          symbol,
          direction: dir,
          engineName: openTrade.winner.engineName,
          entryType: openTrade.winner.entryType,
          entryPrice: ep,
          exitPrice,
          exitReason,
          slStage: openTrade.stage,
          projectedMovePct: openTrade.runtimeProjectedMovePct ?? openTrade.winner.projectedMovePct,
          runtimeEvidence: openTrade.nativeScore,
          regimeAtEntry: openTrade.regimeAtEntry,
          regimeConfidence: openTrade.regimeConfidence,
          holdBars,
          barsToMfe,
          barsToBreakeven,
          pnlPct: finalPnl,
          mfePct: openTrade.mfePct,
          maePct: openTrade.maePct,
          tpPct: openTrade.tpPct,
          slPct: openTrade.slOriginalPct,
          conflictResolution: openTrade.conflictResolution,
          modeGateApplied: modeGate,
          modelSource: openTrade.scoringSource,
          runtimeModelRunId: openTrade.runtimeModelRunId,
          runtimeFamily: openTrade.runtimeFamily ?? null,
          selectedBucket: openTrade.selectedBucket ?? null,
          qualityTier: openTrade.qualityTier ?? null,
          confidence: openTrade.confidence ?? null,
          setupMatch: openTrade.setupMatch ?? null,
          trailingActivationPct: openTrade.trailingActivationThresholdPct ?? null,
          trailingDistancePct: openTrade.trailingDistancePct ?? null,
          trailingMinHoldBars: openTrade.trailingMinHoldBars ?? null,
          trailingActivated: Boolean(openTrade.trailingActivated || openTrade.stage === 3),
          contextSnapshotAtEntry: openTrade.contextSnapshotAtEntry ?? null,
          triggerSnapshotAtEntry: openTrade.triggerSnapshotAtEntry ?? null,
          contextFamilyCandidates: openTrade.contextFamilyCandidates ?? null,
          selectedContextFamily: openTrade.selectedContextFamily ?? null,
          selectedTriggerTransition: openTrade.selectedTriggerTransition ?? null,
          triggerDirection: openTrade.triggerDirection ?? null,
          triggerStrengthScore: openTrade.triggerStrengthScore ?? null,
          contextAgeBars: openTrade.contextAgeBars ?? null,
          contextAgeMinutes: openTrade.contextAgeMinutes ?? null,
          triggerAgeBars: openTrade.triggerAgeBars ?? null,
          triggerFresh: openTrade.triggerFresh ?? null,
          contextEpochId: openTrade.contextEpochId ?? null,
          duplicateWithinContextEpoch: openTrade.duplicateWithinContextEpoch ?? null,
          previousTradeInSameContextEpoch: openTrade.previousTradeInSameContextEpoch ?? null,
          wouldBlockNoTrigger: openTrade.wouldBlockNoTrigger ?? null,
          wouldBlockStaleContext: openTrade.wouldBlockStaleContext ?? null,
          wouldBlockDuplicateEpoch: openTrade.wouldBlockDuplicateEpoch ?? null,
          wouldBlockDirectionMismatch: openTrade.wouldBlockDirectionMismatch ?? null,
          wouldBlockLateAfterMoveWindow: openTrade.wouldBlockLateAfterMoveWindow ?? null,
          admissionPolicyWouldBlock: openTrade.admissionPolicyWouldBlock ?? null,
          admissionPolicyBlockedReasons: openTrade.admissionPolicyBlockedReasons ?? null,
          admissionPolicyMode: openTrade.admissionPolicyMode ?? null,
        };

        trades.push(trade);

        // Track closed trade PnL for daily/weekly loss limit gates
        // bar.closeTs is unix epoch SECONDS â€” multiply by 1000 to store as ms
        simClosedPnls.push({
          closeTs: bar.closeTs * 1000,
          pnlUsd: finalPnl * SYNTHETIC_SIZE,
        });

        // Update running equity curve for maxDrawdownBreached gate
        simEquity *= (1 + finalPnl);
        if (simEquity > simEquityPeak) simEquityPeak = simEquity;

        // Closed event for behavior profiler
        const closedEvent: ClosedEvent = {
          eventType: "closed",
          symbol,
          engineName: openTrade.winner.engineName,
          entryType: openTrade.winner.entryType,
          direction: dir,
          regimeAtEntry: openTrade.regimeAtEntry,
          regimeConfidence: openTrade.regimeConfidence,
          nativeScore: openTrade.nativeScore,
          projectedMovePct: openTrade.runtimeProjectedMovePct ?? openTrade.winner.projectedMovePct,
          entryTs: openTrade.entryTs,
          exitTs: bar.closeTs,
          holdBars,
          pnlPct: finalPnl,
          mfePct: openTrade.mfePct,
          maePct: openTrade.maePct,
          mfePctAtBreakeven: openTrade.mfePctAtBreakeven,
          barsToMfe,
          barsToBreakeven,
          exitReason,
          slStage: openTrade.stage,
          conflictResolution: openTrade.conflictResolution,
          source: "backtest",
        };
        recordBehaviorEvent(closedEvent);

        // Update shared ledger so other symbols see this close in their replay
        if (sharedLedger) sharedLedger.close(symbol, bar.closeTs * 1000);
        openTrade = null;
      }

      if (openTrade !== null) continue;
    }

    // â”€â”€ Signal scan (only when no open trade) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (slice.length < Math.max(60, Math.ceil(indicatorLookback / 60))) continue;

    const features = computeFeaturesFromSlice(symbol, slice);
    if (!features) continue;

    // Accumulate feature sample for HTF regime averaging (matches live accumulateHourlyFeatures)
    featureHistory.push({
      emaSlope: features.emaSlope,
      rsi14: features.rsi14,
      bbWidth: features.bbWidth,
      bbWidthRoc: features.bbWidthRoc,
      atr14: features.atr14,
      atrRank: features.atrRank,
      atrAccel: features.atrAccel,
      zScore: features.zScore,
      spikeHazardScore: features.spikeHazardScore,
      bbPctB: features.bbPctB,
    });
    if (featureHistory.length > HTF_AVERAGING_WINDOW) featureHistory.shift();

    // HTF-averaged regime â€” uses shared classifyRegimeFromSamples from regimeEngine.ts
    // This is the SAME function classifyRegimeFromHTF uses internally (live path).
    // Both paths now share identical averaging logic over their respective sample buffers.
    const regimeResult = classifyRegimeFromSamples(features, featureHistory);

    // â”€â”€ Engine evaluation + coordinator â€” shared pipeline â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // runEnginesAndCoordinate is the exact same function used by engineRouterV3
    // (live scanner). Both paths share identical engine logic and coordinator
    // conflict resolution from this point forward.
    let engineResults: EngineResult[];
    let coordinatorOutput: ReturnType<typeof runEnginesAndCoordinate>["coordinatorOutput"];
    try {
      if (symbol === "CRASH300") {
        const runtimeDecision = await evaluateCrash300Runtime({
          symbol,
          mode,
          ts: bar.closeTs,
          marketState: {
            features,
            featureHistory,
            candles: slice,
            runtimeState: crash300RuntimeState,
            operationalRegime: regimeResult.regime,
            regimeConfidence: regimeResult.confidence,
          },
          runtimeModel: runtimeCalibration as unknown as Record<string, unknown> | null,
          stateMap: {},
        });
        const serviceResult = coordinatorFromCrash300Decision(
          runtimeDecision,
          runtimeCalibration as LiveCalibrationProfile,
          Number((runtimeDecision.evidence as Record<string, unknown>)["expectedMovePct"] ?? 0),
          ((runtimeDecision.evidence as Record<string, unknown>)["componentScores"] as Record<string, number>) ?? {},
        );
        engineResults = serviceResult.engineResults;
        coordinatorOutput = serviceResult.coordinatorOutput;
      } else {
        const pipelineResult = runEnginesAndCoordinate({
          symbol,
          features,
          operationalRegime: regimeResult.regime,
          regimeConfidence: regimeResult.confidence,
          runtimeCalibration,
        });
        engineResults = pipelineResult.engineResults;
        coordinatorOutput = pipelineResult.coordinatorOutput;
      }
    } catch (err) {
      if (symbol === "CRASH300") throw err;
      continue;
    }

    if (engineResults.length === 0 || !coordinatorOutput) continue;

    const { winner, conflictResolution, coordinatorConfidence } = coordinatorOutput;
    const nativeScore = extractNativeScore(winner, coordinatorConfidence);
    const scoringSource = scoringSourceFromWinner(winner);
    scoringSourceCounts[scoringSource] = (scoringSourceCounts[scoringSource] ?? 0) + 1;

    // Record signal_fired event (all coordinator outputs, regardless of gate)
    signalsFired++;
    recordBehaviorEvent({
      eventType: "signal_fired",
      symbol,
      engineName: winner.engineName,
      entryType: winner.entryType,
      direction: winner.direction,
      regimeAtEntry: regimeResult.regime,
      regimeConfidence: regimeResult.confidence,
      nativeScore,
      projectedMovePct: winner.projectedMovePct,
      ts: bar.closeTs,
      conflictResolution,
    });

    // â”€â”€ Shared admission evaluator (same logic as portfolioAllocatorV3) â”€â”€â”€â”€â”€
    // killSwitchActive, modeEnabled, symbolEnabled come from real platformState.
    // dailyLossLimitBreached and weeklyLossLimitBreached are computed from the
    // simulation's own accumulated closed-trade PnL so that risk gates fire
    // correctly during replay (no longer assumed false).
    // bar.closeTs is unix epoch SECONDS â€” convert to ms for window comparisons
    const nowTs        = bar.closeTs * 1000;
    const dayStartTs   = nowTs - 86_400_000;
    const weekStartTs  = nowTs - 7 * 86_400_000;
    const dailyLossUsd  = simClosedPnls.filter(p => p.closeTs >= dayStartTs).reduce((s, p) => s + p.pnlUsd, 0);
    const weeklyLossUsd = simClosedPnls.filter(p => p.closeTs >= weekStartTs).reduce((s, p) => s + p.pnlUsd, 0);
    // Mirror live portfolioAllocatorV3 formula: loss gates use totalCapital as denominator
    const dailyLossLimitBreached  = dailyLossUsd  < 0 && Math.abs(dailyLossUsd)  / totalCapital >= maxDailyLossPct;
    const weeklyLossLimitBreached = weeklyLossUsd < 0 && Math.abs(weeklyLossUsd) / totalCapital >= maxWeeklyLossPct;

    // Drawdown gate: derived from the running single-symbol normalized equity curve.
    // Computed fresh each bar from closed trades â€” same approach as dailyLossLimitBreached.
    const currentDrawdownPct = simEquityPeak > 0 ? (simEquityPeak - simEquity) / simEquityPeak : 0;
    const maxDrawdownBreached = currentDrawdownPct >= maxDrawdownThresholdPct;

    const allocResult = evaluateSignalAdmission({
      symbol,
      engineName: winner.engineName,
      direction: winner.direction,
      nativeScore,
      confidence: winner.confidence,
      mode,
      minScoreGate: modeGate,
      killSwitchActive,   // real: from platformState["kill_switch"]
      modeEnabled,        // real: from platformState prefix keys
      symbolEnabled,      // real: from platformState prefix_enabled_symbols
      // When a shared ledger is provided (multi-symbol run), use it for cross-symbol
      // portfolio state â€” this gives gates 6 and 10 the same semantics as live.
      // Without a ledger (single-symbol run), fall back to local-only state.
      openTradeForSymbol: sharedLedger
        ? sharedLedger.isSymbolOpen(symbol, bar.closeTs * 1000)
        : openTrade !== null,
      currentOpenCount: sharedLedger
        ? sharedLedger.getOpenCount(bar.closeTs * 1000)
        : (openTrade !== null ? 1 : 0),
      maxOpenTrades,                     // from platformState â€” same formula as live allocator
      dailyLossLimitBreached,            // computed from simulation trades + real totalCapital
      weeklyLossLimitBreached,           // computed from simulation trades + real totalCapital
      maxDrawdownBreached,               // computed from running single-symbol equity curve
      // correlatedFamilyCapBreached: false â€” identical to live portfolioAllocatorV3 (line 119).
      // Live also hardcodes this to false, so backtest=false IS correct parity.
      // With a shared ledger, cross-symbol open count (gate 6) already enforces the
      // multi-symbol limit, so family-cap is an additive concern, not a parity gap.
      correlatedFamilyCapBreached: false,
      simulationDefaults: sharedLedger ? [] : runSimulationGaps,
    });

    if (!allocResult.allowed) {
      // Record blocked_by_gate event for ALL allocator rejection stages so the
      // behavior lifecycle profiler has complete signal-blocked coverage.
      // Stage 4 = score gate (signal quality gate, counted in signalsBlocked)
      // Stage 5 = symbol already open (trade management gate, not a signal block)
      // Other stages = platform / risk gates (kill switch, mode, daily/weekly loss, etc.)
      const isSignalQualityBlock = allocResult.rejectionStage === 4;
      const isTradeManagementBlock = allocResult.rejectionStage === 5;
      if (!isTradeManagementBlock) {
        // Count as "blocked" for all non-symbol-already-open rejections
        signalsBlocked++;
        blockedByEngine[winner.engineName] = (blockedByEngine[winner.engineName] ?? 0) + 1;
      }
      // Capture behavior event for ALL rejections (incl. platform gates and trade mgmt)
      // so profiler has full lifecycle visibility
      recordBehaviorEvent({
        eventType: "blocked_by_gate",
        symbol,
        engineName: winner.engineName,
        direction: winner.direction,
        regimeAtEntry: regimeResult.regime,
        nativeScore,
        modeGate,
        mode,
        ts: bar.closeTs,
        rejectionStage: allocResult.rejectionStage ?? undefined,
        rejectionReason: allocResult.rejectionReason ?? `stage${allocResult.rejectionStage ?? 0}`,
        isSignalQualityBlock,
      });
      continue;
    }

    const builtCandidate = buildSymbolTradeCandidate({
      symbol,
      mode,
      coordinatorOutput,
      winner,
      features,
      spotPrice: bar.close,
      runtimeCalibration,
      allowedQualityBands: runtimeQualityBands,
      positionSize: SYNTHETIC_SIZE,
      equity: SYNTHETIC_EQUITY,
    });
    if (!builtCandidate) continue;
    const setupEvidence = builtCandidate.candidate.runtimeSetup;
    const setupSignature = builtCandidate.setupSignature;

    if (!setupEvidence.allowed) {
      signalsBlocked++;
      blockedByEngine[winner.engineName] = (blockedByEngine[winner.engineName] ?? 0) + 1;
      recordBehaviorEvent({
        eventType: "blocked_by_gate",
        symbol,
        engineName: winner.engineName,
        direction: winner.direction,
        regimeAtEntry: regimeResult.regime,
        nativeScore,
        modeGate,
        mode,
        ts: bar.closeTs,
        rejectionStage: 12,
        rejectionReason: `runtime_setup_evidence:${setupEvidence.reason}`,
        isSignalQualityBlock: false,
      });
      continue;
    }

    const candidateWindow = symbol === "CRASH300"
      ? { allowed: true, reason: "crash300_context_trigger_only", key: `${symbol}|instant` }
      : evaluateReplayCandidateWindow({
          windows: candidateWindows,
          runtimeCalibration,
          symbol,
          engineName: winner.engineName,
          direction: winner.direction,
          nativeScore,
          setupSignature,
          ts: bar.closeTs,
        });
    if (!candidateWindow.allowed) {
      signalsBlocked++;
      blockedByEngine[winner.engineName] = (blockedByEngine[winner.engineName] ?? 0) + 1;
      recordBehaviorEvent({
        eventType: "blocked_by_gate",
        symbol,
        engineName: winner.engineName,
        direction: winner.direction,
        regimeAtEntry: regimeResult.regime,
        nativeScore,
        modeGate,
        mode,
        ts: bar.closeTs,
        rejectionStage: 11,
        rejectionReason: candidateWindow.reason,
        isSignalQualityBlock: false,
      });
      continue;
    }

    let tp: number;
    let sl: number;
    if (symbol === "CRASH300") {
      const crashTp = builtCandidate.candidate.exitPolicy.takeProfitPrice;
      const crashSl = builtCandidate.candidate.exitPolicy.stopLossPrice;
      if (typeof crashTp !== "number" || typeof crashSl !== "number" || !Number.isFinite(crashTp) || !Number.isFinite(crashSl) || crashTp <= 0 || crashSl <= 0) {
        throw new Error("CRASH300 runtime model missing/invalid. Cannot evaluate symbol service. runtime_exit_policy_missing");
      }
      tp = crashTp;
      sl = crashSl;
    } else {
      // SR/Fib TP/SL plus runtime calibration model for non-CRASH symbols.
      tp = calculateSRFibTP({
        entryPrice: bar.close,
        direction: winner.direction,
        swingHigh: features.swingHigh,
        swingLow: features.swingLow,
        majorSwingHigh: features.majorSwingHigh,
        majorSwingLow: features.majorSwingLow,
        fibExtensionLevels: features.fibExtensionLevels ?? [],
        fibExtensionLevelsDown: features.fibExtensionLevelsDown ?? [],
        bbUpper: features.bbUpper,
        bbLower: features.bbLower,
        atrPct: features.atr14,
        pivotLevels: [
          features.pivotR1, features.pivotR2, features.pivotS1, features.pivotS2,
        ].filter((v): v is number => typeof v === "number"),
        vwap: features.vwap,
        psychRound: features.psychRound,
        prevSessionHigh: features.prevSessionHigh,
        prevSessionLow: features.prevSessionLow,
        spikeMagnitude: features.spikeMagnitude,
      });

      if (!isFinite(tp) || tp <= 0) continue;
      if (winner.direction === "buy" && tp <= bar.close) continue;
      if (winner.direction === "sell" && tp >= bar.close) continue;

      sl = calculateSRFibSL({
        entryPrice: bar.close,
        direction: winner.direction,
        tp,
        positionSize: SYNTHETIC_SIZE,
        equity: SYNTHETIC_EQUITY,
      });
      if (!isFinite(sl) || sl <= 0) continue;

      ({ tp, sl } = applyRuntimeCalibrationExitModel({
        spotPrice: bar.close,
        direction: winner.direction,
        tp,
        sl,
        trailingStopPct: trailingCfg.trailingDistancePct ?? 0,
        mode,
        runtimeCalibration,
        nativeScore,
        features,
      }));
      if (!isFinite(tp) || tp <= 0) continue;
      if (winner.direction === "buy" && tp <= bar.close) continue;
      if (winner.direction === "sell" && tp >= bar.close) continue;
      if (!isFinite(sl) || sl <= 0) continue;
    }

    const tpPct = Math.abs(tp - bar.close) / bar.close;
    const slOriginalPct = Math.abs(sl - bar.close) / bar.close;
    const runtimeProjectedMovePct = tpPct;
    const crashDecision = winnerSymbolServiceDecision(winner);
    const crashEvidence = optionalRecord(crashDecision["evidence"]);
    const matchedPolicyMove = symbol === "CRASH300"
      ? matchDetectedMoveForAdmission(bar.closeTs, winner.direction, filteredDetectedMovesForPolicy)
      : null;
    const admissionSemanticFlags: string[] = [];
    const runtimeFamily = optionalString(crashDecision["setupFamily"]);
    const selectedBucket = optionalString(crashDecision["moveBucket"]);
    const triggerDirection = optionalString(crashEvidence?.["triggerDirection"]) ?? "unknown";
    const familyDirection = familyDirectionForAdmission(runtimeFamily);
    const bucketDirection = bucketDirectionForAdmission(selectedBucket);
    if (triggerDirection !== "unknown" && triggerDirection !== "none" && triggerDirection !== winner.direction) {
      admissionSemanticFlags.push("trigger_trade_direction_mismatch");
    }
    if (familyDirection !== "unknown" && bucketDirection !== "unknown" && familyDirection !== bucketDirection) {
      admissionSemanticFlags.push("family_bucket_direction_mismatch");
    }
    if (runtimeFamily === "post_crash_recovery_up" && matchedPolicyMove?.direction === "down") {
      admissionSemanticFlags.push("recovery_up_family_on_down_move");
    }
    if (runtimeFamily === "crash_event_down" && matchedPolicyMove?.direction === "up") {
      admissionSemanticFlags.push("crash_down_family_on_up_move");
    }
    const admissionDecision = symbol === "CRASH300"
      ? evaluateCrash300AdmissionPolicy(
          { setupFamily: runtimeFamily, moveBucket: selectedBucket },
          optionalRecord(crashEvidence?.["contextSnapshot"]),
          optionalRecord(crashEvidence?.["triggerSnapshot"]),
          {
            tradeDirection: winner.direction,
            triggerDirection: triggerDirection as "buy" | "sell" | "none" | "unknown",
            runtimeFamily,
            selectedBucket,
            matchedMoveDirection: matchedPolicyMove?.direction ?? "unknown",
            triggerFresh: optionalBoolean(crashEvidence?.["triggerFresh"]),
            familyDirection,
            bucketDirection,
            semanticFlags: admissionSemanticFlags,
            evaluationMode: "backtest",
          },
          crash300AdmissionPolicy,
        )
      : null;
    if (admissionDecision?.wouldHaveBlocked) {
      bumpReasonCounts(admissionPolicyBlockedReasonsCounts, admissionDecision.blockedReasons);
      if (admissionDecision.policyMode === "enforce") {
        admissionPolicyBlockedCandidates += 1;
        signalsBlocked++;
        blockedByEngine[winner.engineName] = (blockedByEngine[winner.engineName] ?? 0) + 1;
        recordBehaviorEvent({
          eventType: "blocked_by_gate",
          symbol,
          engineName: winner.engineName,
          direction: winner.direction,
          regimeAtEntry: regimeResult.regime,
          nativeScore,
          modeGate,
          mode,
          ts: bar.closeTs,
          rejectionStage: 13,
          rejectionReason: `admission_policy:${admissionDecision.blockedReasons.join("|")}`,
          isSignalQualityBlock: false,
        });
        continue;
      }
    }

    // Record entry event
    recordBehaviorEvent({
      eventType: "entered",
      symbol,
      engineName: winner.engineName,
      entryType: winner.entryType,
      direction: winner.direction,
      regimeAtEntry: regimeResult.regime,
      regimeConfidence: regimeResult.confidence,
      nativeScore,
      projectedMovePct: runtimeProjectedMovePct,
      entryTs: bar.closeTs,
      tpPct,
      slPct: slOriginalPct,
    });
    openTrade = {
      winner,
      entryBar: i,
      entryPrice: bar.close,
      entryTs: bar.closeTs,
      regimeAtEntry: regimeResult.regime,
      regimeConfidence: regimeResult.confidence,
      nativeScore,
      conflictResolution,
      scoringSource,
      runtimeModelRunId: runtimeCalibration?.sourceRunId ?? null,
      runtimeProjectedMovePct,
      tp,
      sl,
      originalSl: sl,
      stage: 1,
      peakPrice: bar.close,
      mfePct: 0,
      maePct: 0,
      mfePeakBar: i,
      beTriggeredBar: 0,
      mfePctAtBreakeven: 0,
      atr14AtEntry: Math.max(features.atr14, 0.001),
      instrumentFamily,
      emaSlope: features.emaSlope,
      spikeCount4h: features.spikeCount4h ?? 0,
      adverseCandleCount: 0,
      tpPct,
      slOriginalPct,
      tpProgressAtBe: 0,
      trailingActivationThresholdPct: symbol === "CRASH300"
        ? builtCandidate.candidate.exitPolicy.trailingArmPct
        : trailingCfg.trailingActivationThresholdPct,
      trailingDistancePct: symbol === "CRASH300"
        ? builtCandidate.candidate.exitPolicy.trailingDistancePct
        : trailingCfg.trailingDistancePct,
      trailingMinHoldBars: symbol === "CRASH300"
        ? builtCandidate.candidate.exitPolicy.minHoldMinutes
        : trailingCfg.trailingMinHoldBars,
      runtimeFamily: optionalString(crashDecision["setupFamily"]),
      selectedBucket: optionalString(crashDecision["moveBucket"]),
      qualityTier: optionalString(crashDecision["qualityTier"]),
      confidence: optionalNumber(crashDecision["confidence"]),
      setupMatch: optionalNumber(crashDecision["setupMatch"]),
      trailingActivated: false,
      contextSnapshotAtEntry: optionalRecord(crashEvidence?.["contextSnapshot"]),
      triggerSnapshotAtEntry: optionalRecord(crashEvidence?.["triggerSnapshot"]),
      contextFamilyCandidates: optionalRecordArray(crashEvidence?.["contextFamilyCandidates"]),
      selectedContextFamily: optionalString(crashEvidence?.["selectedContextFamily"]),
      selectedTriggerTransition: optionalString(crashEvidence?.["selectedTriggerTransition"]),
      triggerDirection: optionalString(crashEvidence?.["triggerDirection"]),
      triggerStrengthScore: optionalNumber(crashEvidence?.["triggerStrengthScore"]),
      contextAgeBars: optionalNumber(crashEvidence?.["contextAgeBars"]),
      contextAgeMinutes: optionalNumber(crashEvidence?.["contextAgeMinutes"]),
      triggerAgeBars: optionalNumber(crashEvidence?.["triggerAgeBars"]),
      triggerFresh: optionalBoolean(crashEvidence?.["triggerFresh"]),
      contextEpochId: optionalString(crashEvidence?.["contextEpochId"]),
      duplicateWithinContextEpoch: optionalBoolean(crashEvidence?.["duplicateWithinContextEpoch"]),
      previousTradeInSameContextEpoch: optionalString(crashEvidence?.["previousTradeInSameContextEpoch"]),
      wouldBlockNoTrigger: optionalBoolean(crashEvidence?.["wouldBlockNoTrigger"]),
      wouldBlockStaleContext: optionalBoolean(crashEvidence?.["wouldBlockStaleContext"]),
      wouldBlockDuplicateEpoch: optionalBoolean(crashEvidence?.["wouldBlockDuplicateEpoch"]),
      wouldBlockDirectionMismatch: optionalBoolean(crashEvidence?.["wouldBlockDirectionMismatch"]),
      wouldBlockLateAfterMoveWindow: optionalBoolean(crashEvidence?.["wouldBlockLateAfterMoveWindow"]),
      admissionPolicyWouldBlock: admissionDecision?.wouldHaveBlocked ?? false,
      admissionPolicyBlockedReasons: admissionDecision?.blockedReasons ?? [],
      admissionPolicyMode: admissionDecision?.policyMode ?? (crash300AdmissionPolicy.enabled ? crash300AdmissionPolicy.mode : "off"),
    };

    // Register opening in shared ledger so concurrent symbols see this position
    if (sharedLedger) sharedLedger.open(symbol, instrumentFamily, bar.closeTs * 1000);
    if (symbol !== "CRASH300") {
      markReplayCandidateExecuted(candidateWindows, candidateWindow.key, bar.closeTs, runtimeCalibration);
    }
  }

  const barsInRange = Math.max(0, candles.length - simStart);
  const blockedRate = signalsFired > 0 ? signalsBlocked / signalsFired : 0;
  const detectedMovesInWindow = await db
    .select({
      startTs: detectedMovesTable.startTs,
      endTs: detectedMovesTable.endTs,
      direction: detectedMovesTable.direction,
      qualityTier: detectedMovesTable.qualityTier,
    })
    .from(detectedMovesTable)
    .where(and(
      eq(detectedMovesTable.symbol, symbol),
      gte(detectedMovesTable.endTs, startTs),
      lte(detectedMovesTable.startTs, endTs),
    ));
  const targetMovesInWindow = detectedMoveTiers
    ? detectedMovesInWindow.filter((move) => detectedMoveTiers.includes(move.qualityTier as "A" | "B" | "C" | "D"))
    : detectedMovesInWindow;
  const moveOverlap = calcMoveOverlapDiagnostics({ moves: targetMovesInWindow, trades });
  const admissionPolicyMeta = buildAdmissionPolicyMeta({
    config: crash300AdmissionPolicy,
    trades,
    blockedCandidateCount: admissionPolicyBlockedCandidates,
    blockedReasonsCounts: admissionPolicyBlockedReasonsCounts,
  });

  return {
    symbol,
    mode,
    tierMode,
    startTs,
    endTs,
    totalBars: barsInRange,
    modeScoreGate: modeGate,
    signalsFired,
    signalsBlocked,
    blockedRate,
    runtimeModel: runtimeModelDiagnostics(runtimeCalibrationResolution, scoringSourceCounts),
    admissionPolicy: admissionPolicyMeta,
    trades,
    simulationGaps: runSimulationGaps,
    moveOverlap,
    summary: computeSummary(trades, blockedByEngine, admissionPolicyMeta, {
      startingCapitalUsd,
      allocationPct: DEFAULT_ALLOCATION_PCT,
      maxConcurrentTrades: maxOpenTrades,
      compoundingEnabled: false,
      syntheticEquityUsd: SYNTHETIC_EQUITY,
      syntheticPositionSizeUsd: SYNTHETIC_SIZE,
    }),
  };
}

/**
 * Run V3 backtest across multiple symbols using a time-synchronized event loop.
 *
 * â”€â”€ Synchronization guarantee â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 * All symbols share a single global bar clock (sorted union of all closeTs values).
 * At each timestamp T the loop processes two phases in strict order:
 *
 *   1. EXIT PHASE  â€” apply state transitions and check SL/TP/timeout for every
 *      symbol that has an open position at T.  Positions that close at T are
 *      removed from the shared ledger before the entry phase begins.
 *
 *   2. ENTRY PHASE â€” evaluate new entries for every symbol that has no open
 *      position at T.  Admission gates (maxOpenTrades, one-per-symbol) query
 *      the shared ledger which already reflects all exits at T, so the cross-
 *      symbol portfolio state is always correct at the moment of evaluation.
 *
 * This eliminates the order-bias of sequential-per-symbol replay, where symbol A
 * was simulated without any knowledge of symbol B's positions, and symbol B then
 * saw symbol A's complete future history.
 */
export async function runV3BacktestMulti(
  symbols: string[],
  startTs?: number,
  endTs?: number,
  mode?: "paper" | "demo" | "real",
  tierModeRaw?: BacktestTierMode,
  crash300AdmissionPolicyRaw?: Partial<Crash300AdmissionPolicyConfig> | null,
  startingCapitalUsdRaw?: number,
  cancellationCheck?: (() => Promise<void>) | null,
): Promise<Record<string, V3BacktestResult>> {
  const tierMode = normalizeBacktestTierMode(tierModeRaw);
  const runtimeQualityBands = allowedRuntimeQualityBands(tierMode);
  const detectedMoveTiers = allowedDetectedMoveTiers(tierMode);
  const crash300AdmissionPolicy = normalizeCrash300AdmissionPolicyConfig(crash300AdmissionPolicyRaw);
  const startingCapitalUsd = Math.max(1, Number(startingCapitalUsdRaw ?? DEFAULT_REPORT_STARTING_CAPITAL_USD));
  if (symbols.length <= 1) {
    const result = await runV3Backtest({
      symbol: symbols[0] ?? "",
      startTs,
      endTs,
      mode,
      tierMode,
      crash300AdmissionPolicy,
      startingCapitalUsd,
      cancellationCheck,
    });
    return symbols[0] ? { [symbols[0]]: result } : {};
  }

  // â”€â”€ Shared platform state (loaded once for all symbols) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const now = Math.floor(Date.now() / 1000);
  const _startTs = startTs ?? (now - 90 * 86400);
  const _endTs   = endTs   ?? now;
  const _mode    = mode    ?? "paper";
  const modePrefix = getModePrefix(_mode);

  const platformRows = await db.select().from(platformStateTable);
  const stateMap: Record<string, string> = {};
  for (const r of platformRows) stateMap[r.key] = r.value;

  const sharedModeGate = resolveModeScoreGate(stateMap, modePrefix, _mode, null);
  const sharedKillSwitch  = stateMap["kill_switch"] === "true";
  const sharedModeEnabled = isModeEnabledFromState(stateMap, modePrefix);

  const sharedMaxOpenTrades = parseInt(
    stateMap[`${modePrefix}_max_open_trades`] || stateMap["max_open_trades"] || "3", 10,
  );
  const capitalKey     = getModeCapitalKey(_mode as "paper" | "demo" | "real");
  const capitalDefault = getModeCapitalDefault(_mode as "paper" | "demo" | "real");
  const sharedCapital  = Math.max(1, parseFloat(stateMap[capitalKey] || stateMap["total_capital"] || capitalDefault));
  const sharedMaxDailyLoss   = parseFloat(stateMap[`${modePrefix}_max_daily_loss_pct`]   || stateMap["max_daily_loss_pct"]   || "5")  / 100;
  const sharedMaxWeeklyLoss  = parseFloat(stateMap[`${modePrefix}_max_weekly_loss_pct`]  || stateMap["max_weekly_loss_pct"]  || "10") / 100;
  const sharedMaxDrawdownPct = parseFloat(stateMap[`${modePrefix}_max_drawdown_pct`]     || stateMap["max_drawdown_pct"]     || "20") / 100;

  const detectedMovesBySymbol = new Map<string, Array<PolicyDetectedMove>>();
  const detectedMovesRows = await db
    .select({
      symbol: detectedMovesTable.symbol,
      startTs: detectedMovesTable.startTs,
      endTs: detectedMovesTable.endTs,
      direction: detectedMovesTable.direction,
      qualityTier: detectedMovesTable.qualityTier,
    })
    .from(detectedMovesTable)
    .where(and(
      inArray(detectedMovesTable.symbol, symbols),
      gte(detectedMovesTable.endTs, _startTs),
      lte(detectedMovesTable.startTs, _endTs),
    ));
  for (const row of detectedMovesRows) {
    if (detectedMoveTiers && !detectedMoveTiers.includes(row.qualityTier as "A" | "B" | "C" | "D")) continue;
    const list = detectedMovesBySymbol.get(row.symbol) ?? [];
    list.push({
      startTs: row.startTs,
      endTs: row.endTs,
      direction: normalizePolicyMoveDirection(row.direction),
    });
    detectedMovesBySymbol.set(row.symbol, list);
  }

  // â”€â”€ Load candles for all symbols in parallel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const bufferStartTs = _startTs - STRUCTURAL_LOOKBACK * 60;
  const allCandleArrays = await Promise.all(
    symbols.map(sym =>
      db.select({
        open: candlesTable.open, high: candlesTable.high,
        low:  candlesTable.low,  close: candlesTable.close,
        openTs: candlesTable.openTs, closeTs: candlesTable.closeTs,
      }).from(candlesTable)
        .where(and(
          eq(candlesTable.symbol, sym),
          eq(candlesTable.timeframe, "1m"),
          gte(candlesTable.openTs, bufferStartTs),
          lte(candlesTable.openTs, _endTs),
        ))
        .orderBy(asc(candlesTable.openTs))
        .then(rows => rows as CandleRow[]),
    ),
  );

  // â”€â”€ Build per-symbol contexts and global timestamp union â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const symCtxMap = new Map<string, SymCtx>();
  const allTs     = new Set<number>();

  for (let si = 0; si < symbols.length; si++) {
    await runBacktestCancellationCheckpoint(cancellationCheck, si, 1);
    const sym     = symbols[si]!;
    const candles = allCandleArrays[si]!;
    if (candles.length < 60) continue;

    let simStart = candles.findIndex(c => c.openTs >= _startTs);
    if (simStart < 0) simStart = candles.length - 1;
    if (simStart < STRUCTURAL_LOOKBACK) simStart = STRUCTURAL_LOOKBACK;

    const idxByTs = new Map<number, number>();
    for (let i = 0; i < candles.length; i++) {
      await runBacktestCancellationCheckpoint(cancellationCheck, i, 1_000);
      idxByTs.set(candles[i]!.closeTs, i);
      if (i >= simStart) allTs.add(candles[i]!.closeTs);
    }

    symCtxMap.set(sym, {
      sym,
      instrumentFamily:      getInstrumentFamily(sym),
      candles,
      idxByTs,
      simStart,
      mode:                   _mode,
      modeGate:               sharedModeGate,
      killSwitchActive:       sharedKillSwitch,
      modeEnabled:            sharedModeEnabled,
      symbolEnabled:          isSymbolEnabledFromState(stateMap, modePrefix, sym),
      maxOpenTrades:          sharedMaxOpenTrades,
      totalCapital:           sharedCapital,
      maxDailyLossPct:        sharedMaxDailyLoss,
      maxWeeklyLossPct:       sharedMaxWeeklyLoss,
      maxDrawdownThresholdPct: sharedMaxDrawdownPct,
      featureHistory:         [],
      openTrade:              null,
      simEquity:              1.0,
      simEquityPeak:          1.0,
      simClosedPnls:          [],
      trades:                 [],
      signalsFired:           0,
      signalsBlocked:         0,
      blockedByEngine:        {},
      scoringSourceCounts:     {},
      candidateWindows:       new Map<string, ReplayCandidateWindow>(),
      detectedMoves:          detectedMovesBySymbol.get(sym) ?? [],
      admissionPolicyBlockedCandidates: 0,
      admissionPolicyBlockedReasonsCounts: {},
      crash300RuntimeState:   sym === "CRASH300"
        ? {
            currentEpoch: null,
            previousEpochId: null,
            lastValidTriggerTs: null,
            lastValidTriggerDirection: null,
            lastValidTriggerStrength: null,
          }
        : undefined,
      runtimeCalibration:     null,
      runtimeCalibrationResolution: null,
      trailingActivationThresholdPct: undefined,
      trailingDistancePct: undefined,
      trailingMinHoldBars: undefined,
    });
  }

  if (symCtxMap.size === 0) {
    const out: Record<string, V3BacktestResult> = {};
    for (const sym of symbols) {
      out[sym] = {
      symbol: sym, mode: _mode, tierMode, startTs: _startTs, endTs: _endTs,
      totalBars: 0, modeScoreGate: sharedModeGate,
      signalsFired: 0, signalsBlocked: 0, blockedRate: 0,
      runtimeModel: runtimeModelDiagnostics(null),
      admissionPolicy: buildAdmissionPolicyMeta({
        config: crash300AdmissionPolicy,
        trades: [],
        blockedCandidateCount: 0,
        blockedReasonsCounts: {},
      }),
      trades: [],
        simulationGaps: [],
        moveOverlap: {
          movesInWindow: 0,
          capturedMoves: 0,
          missedMoves: 0,
          captureRate: 0,
          tradesMatchedToMoves: 0,
          ghostTrades: 0,
          ghostRate: 0,
          moveDirectionSplit: { up: 0, down: 0 },
        },
        summary: computeSummary([], {}, buildAdmissionPolicyMeta({
          config: crash300AdmissionPolicy,
          trades: [],
          blockedCandidateCount: 0,
          blockedReasonsCounts: {},
        }), {
          startingCapitalUsd,
          allocationPct: DEFAULT_ALLOCATION_PCT,
          maxConcurrentTrades: sharedMaxOpenTrades,
          compoundingEnabled: false,
          syntheticEquityUsd: SYNTHETIC_EQUITY,
          syntheticPositionSizeUsd: SYNTHETIC_SIZE,
        }),
      };
    }
    return out;
  }

  // â”€â”€ Shared portfolio ledger â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const ledger = new SharedPortfolioLedger();
  let runtimeCalibrationIndex = 0;
  for (const ctx of symCtxMap.values()) {
    await runBacktestCancellationCheckpoint(cancellationCheck, runtimeCalibrationIndex, 1);
    runtimeCalibrationIndex += 1;
    const runtimeCalibrationResolution =
      await resolveLiveCalibrationProfile(ctx.sym, _mode, stateMap).catch(() => null);
    const runtimeCalibration = runtimeCalibrationResolution?.profile ?? null;
    if (ctx.sym === "CRASH300" && !runtimeCalibration) {
      throw new Error("CRASH300 runtime model missing/invalid. Cannot evaluate symbol service.");
    }
    ctx.runtimeCalibrationResolution = runtimeCalibrationResolution;
    ctx.runtimeCalibration = runtimeCalibration;
    ctx.modeGate = resolveModeScoreGate(stateMap, modePrefix, _mode, runtimeCalibration);
    const trailingCfg = runtimeCalibration
      ? resolveTrailingConfigFromProfile(runtimeCalibration.trailingModel ?? {})
      : {};
    ctx.trailingActivationThresholdPct = trailingCfg.trailingActivationThresholdPct;
    ctx.trailingDistancePct = trailingCfg.trailingDistancePct;
    ctx.trailingMinHoldBars = trailingCfg.trailingMinHoldBars;
  }

  // â”€â”€ Global sorted timestamp list â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const globalTs = Array.from(allTs).sort((a, b) => a - b);

  // â”€â”€ Time-synchronized event loop â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  for (let tsIndex = 0; tsIndex < globalTs.length; tsIndex += 1) {
    await runBacktestCancellationCheckpoint(cancellationCheck, tsIndex, 100);
    const ts = globalTs[tsIndex]!;
    const tsMs = ts * 1000;

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    // EXIT PHASE â€” apply state transitions + check SL/TP/timeout for all
    // open positions first.  Ledger updates (close) happen here so the entry
    // phase sees accurate open-count / symbol-open state.
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    for (const ctx of symCtxMap.values()) {
      if (!ctx.openTrade) continue;
      const i = ctx.idxByTs.get(ts);
      if (i === undefined) continue;
      const bar = ctx.candles[i]!;
      const ot  = ctx.openTrade;
      const dir = ot.winner.direction;
      const ep  = ot.entryPrice;
      const holdBars    = i - ot.entryBar;
      const prevPeak    = ot.peakPrice;

      const barState = applyBarStateTransitions({
        direction: dir, entryPrice: ep, tp: ot.tp,
        holdBars,
        barHigh: bar.high, barLow: bar.low, barClose: bar.close, barOpen: bar.open,
        stage: ot.stage, sl: ot.sl, peakPrice: ot.peakPrice,
        mfePct: ot.mfePct, maePct: ot.maePct, adverseCandleCount: ot.adverseCandleCount,
        atr14AtEntry: ot.atr14AtEntry, instrumentFamily: ot.instrumentFamily,
        emaSlope: ot.emaSlope, spikeCount4h: ot.spikeCount4h,
        trailingActivationThresholdPct: ot.trailingActivationThresholdPct,
        trailingMinHoldBars: ot.trailingMinHoldBars,
        trailingDistancePct: ot.trailingDistancePct,
      });

      ot.sl                 = barState.sl;
      ot.stage              = barState.stage;
      ot.peakPrice          = barState.peakPrice;
      ot.mfePct             = barState.mfePct;
      ot.maePct             = barState.maePct;
      ot.trailingActivated  = ot.trailingActivated || barState.stage === 3;
      ot.adverseCandleCount = barState.adverseCandleCount;
      if (barState.peakPrice !== prevPeak) ot.mfePeakBar = i;

      if (barState.bePromoted) {
        ot.mfePctAtBreakeven = barState.mfePctAtPromotion;
        ot.beTriggeredBar    = i;
        ot.tpProgressAtBe    = barState.tpProgressAtBe;
        recordBehaviorEvent({
          eventType: "breakeven_promoted", symbol: ctx.sym,
          engineName: ot.winner.engineName, direction: dir,
          holdBarsAtPromotion: holdBars, mfePctAtPromotion: barState.mfePctAtPromotion,
          tpProgressAtPromotion: barState.tpProgressAtBe, ts: bar.closeTs,
        });
      }
      if (barState.trailingActivated) {
        recordBehaviorEvent({
          eventType: "trailing_activated", symbol: ctx.sym,
          engineName: ot.winner.engineName, direction: dir,
          holdBarsAtActivation: holdBars, mfePctAtActivation: barState.mfePct,
          tpProgressAtActivation: barState.tpProgressAtTrailing, ts: bar.closeTs,
        });
      }

      const barExit = evaluateBarExits({
        direction: dir, barHigh: bar.high, barLow: bar.low, barClose: bar.close,
        tp: ot.tp, sl: ot.sl,
      });
      let exitReason: V3BacktestTrade["exitReason"] | null =
        barExit.exitReason === "sl_hit" && ot.stage === 3
          ? "trailing_stop"
          : barExit.exitReason;
      let exitPrice = barExit.exitPrice;
      if (!exitReason && holdBars >= MAX_HOLD_MINS) {
        exitReason = "max_duration";
        exitPrice  = bar.close;
      }

      if (exitReason) {
        const finalPnl      = dir === "buy" ? (exitPrice - ep) / ep : (ep - exitPrice) / ep;
        const barsToMfe     = ot.mfePeakBar > ot.entryBar ? ot.mfePeakBar - ot.entryBar : holdBars;
        const barsToBreakeven = ot.beTriggeredBar > 0 ? ot.beTriggeredBar - ot.entryBar : 0;

        ctx.trades.push({
          entryTs: ot.entryTs, exitTs: bar.closeTs, symbol: ctx.sym,
          direction: dir, engineName: ot.winner.engineName, entryType: ot.winner.entryType,
          entryPrice: ep, exitPrice, exitReason, slStage: ot.stage,
          projectedMovePct: ot.runtimeProjectedMovePct ?? ot.winner.projectedMovePct, runtimeEvidence: ot.nativeScore,
          regimeAtEntry: ot.regimeAtEntry, regimeConfidence: ot.regimeConfidence,
          holdBars, barsToMfe, barsToBreakeven, pnlPct: finalPnl,
          mfePct: ot.mfePct, maePct: ot.maePct, tpPct: ot.tpPct, slPct: ot.slOriginalPct,
          conflictResolution: ot.conflictResolution, modeGateApplied: ctx.modeGate,
          modelSource: ot.scoringSource,
          runtimeModelRunId: ot.runtimeModelRunId,
          runtimeFamily: ot.runtimeFamily ?? null,
          selectedBucket: ot.selectedBucket ?? null,
          qualityTier: ot.qualityTier ?? null,
          confidence: ot.confidence ?? null,
          setupMatch: ot.setupMatch ?? null,
          trailingActivationPct: ot.trailingActivationThresholdPct ?? null,
          trailingDistancePct: ot.trailingDistancePct ?? null,
          trailingMinHoldBars: ot.trailingMinHoldBars ?? null,
          trailingActivated: Boolean(ot.trailingActivated || ot.stage === 3),
          contextSnapshotAtEntry: ot.contextSnapshotAtEntry ?? null,
          triggerSnapshotAtEntry: ot.triggerSnapshotAtEntry ?? null,
          contextFamilyCandidates: ot.contextFamilyCandidates ?? null,
          selectedContextFamily: ot.selectedContextFamily ?? null,
          selectedTriggerTransition: ot.selectedTriggerTransition ?? null,
          triggerDirection: ot.triggerDirection ?? null,
          triggerStrengthScore: ot.triggerStrengthScore ?? null,
          contextAgeBars: ot.contextAgeBars ?? null,
          contextAgeMinutes: ot.contextAgeMinutes ?? null,
          triggerAgeBars: ot.triggerAgeBars ?? null,
          triggerFresh: ot.triggerFresh ?? null,
          contextEpochId: ot.contextEpochId ?? null,
          duplicateWithinContextEpoch: ot.duplicateWithinContextEpoch ?? null,
          previousTradeInSameContextEpoch: ot.previousTradeInSameContextEpoch ?? null,
          wouldBlockNoTrigger: ot.wouldBlockNoTrigger ?? null,
          wouldBlockStaleContext: ot.wouldBlockStaleContext ?? null,
          wouldBlockDuplicateEpoch: ot.wouldBlockDuplicateEpoch ?? null,
          wouldBlockDirectionMismatch: ot.wouldBlockDirectionMismatch ?? null,
          wouldBlockLateAfterMoveWindow: ot.wouldBlockLateAfterMoveWindow ?? null,
          admissionPolicyWouldBlock: ot.admissionPolicyWouldBlock ?? null,
          admissionPolicyBlockedReasons: ot.admissionPolicyBlockedReasons ?? null,
          admissionPolicyMode: ot.admissionPolicyMode ?? null,
        });
        ctx.simClosedPnls.push({ closeTs: tsMs, pnlUsd: finalPnl * SYNTHETIC_SIZE });
        ctx.simEquity *= (1 + finalPnl);
        if (ctx.simEquity > ctx.simEquityPeak) ctx.simEquityPeak = ctx.simEquity;

        recordBehaviorEvent({
          eventType: "closed", symbol: ctx.sym, engineName: ot.winner.engineName,
          entryType: ot.winner.entryType, direction: dir,
          regimeAtEntry: ot.regimeAtEntry, regimeConfidence: ot.regimeConfidence,
          nativeScore: ot.nativeScore, projectedMovePct: ot.runtimeProjectedMovePct ?? ot.winner.projectedMovePct,
          entryTs: ot.entryTs, exitTs: bar.closeTs, holdBars,
          pnlPct: finalPnl, mfePct: ot.mfePct, maePct: ot.maePct,
          mfePctAtBreakeven: ot.mfePctAtBreakeven,
          barsToMfe, barsToBreakeven, exitReason, slStage: ot.stage,
          conflictResolution: ot.conflictResolution, source: "backtest",
        } as ClosedEvent);

        // Ledger close BEFORE entry phase so the released slot is visible
        ledger.close(ctx.sym, tsMs);
        ctx.openTrade = null;
      }
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    // ENTRY PHASE â€” evaluate new entries now that all exits at T are settled.
    // The shared ledger reflects the true concurrent portfolio state at T.
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    for (const ctx of symCtxMap.values()) {
      if (ctx.openTrade) continue;
      const i = ctx.idxByTs.get(ts);
      if (i === undefined || i < ctx.simStart) continue;
      const bar = ctx.candles[i]!;

      // Feature slice up to current bar
      const sliceStart = Math.max(0, i - STRUCTURAL_LOOKBACK + 1);
      const slice      = ctx.candles.slice(sliceStart, i + 1);
      const features   = computeFeaturesFromSlice(ctx.sym, slice);
      if (!features) continue;

      // HTF regime averaging
      ctx.featureHistory.push({
        emaSlope: features.emaSlope, rsi14: features.rsi14,
        bbWidth: features.bbWidth,   bbWidthRoc: features.bbWidthRoc,
        atr14: features.atr14,       atrRank: features.atrRank,
        atrAccel: features.atrAccel, zScore: features.zScore,
        spikeHazardScore: features.spikeHazardScore, bbPctB: features.bbPctB,
      });
      if (ctx.featureHistory.length > HTF_AVERAGING_WINDOW) ctx.featureHistory.shift();

      const regimeResult = classifyRegimeFromSamples(features, ctx.featureHistory);

      let engineResults: EngineResult[];
      let coordinatorOutput: ReturnType<typeof runEnginesAndCoordinate>["coordinatorOutput"];
      try {
        if (ctx.sym === "CRASH300") {
          const runtimeDecision = await evaluateCrash300Runtime({
            symbol: ctx.sym,
            mode: _mode,
            ts,
            marketState: {
              features,
              featureHistory: ctx.featureHistory,
              candles: slice,
              runtimeState: ctx.crash300RuntimeState,
              operationalRegime: regimeResult.regime,
              regimeConfidence: regimeResult.confidence,
            },
            runtimeModel: ctx.runtimeCalibration as unknown as Record<string, unknown> | null,
            stateMap: {},
          });
          const serviceResult = coordinatorFromCrash300Decision(
            runtimeDecision,
            ctx.runtimeCalibration as LiveCalibrationProfile,
            Number((runtimeDecision.evidence as Record<string, unknown>)["expectedMovePct"] ?? 0),
            ((runtimeDecision.evidence as Record<string, unknown>)["componentScores"] as Record<string, number>) ?? {},
          );
          engineResults = serviceResult.engineResults;
          coordinatorOutput = serviceResult.coordinatorOutput;
        } else {
          const p = runEnginesAndCoordinate({
            symbol: ctx.sym, features,
            operationalRegime: regimeResult.regime, regimeConfidence: regimeResult.confidence,
            runtimeCalibration: ctx.runtimeCalibration,
          });
          engineResults = p.engineResults;
          coordinatorOutput = p.coordinatorOutput;
        }
      } catch (err) {
        if (ctx.sym === "CRASH300") throw err;
        continue;
      }

      if (engineResults.length === 0 || !coordinatorOutput) continue;

      const { winner, conflictResolution, coordinatorConfidence } = coordinatorOutput;
      const nativeScore = extractNativeScore(winner, coordinatorConfidence);
      const scoringSource = scoringSourceFromWinner(winner);
      ctx.scoringSourceCounts[scoringSource] = (ctx.scoringSourceCounts[scoringSource] ?? 0) + 1;

      ctx.signalsFired++;
      recordBehaviorEvent({
        eventType: "signal_fired", symbol: ctx.sym, engineName: winner.engineName,
        entryType: winner.entryType, direction: winner.direction,
        regimeAtEntry: regimeResult.regime, regimeConfidence: regimeResult.confidence,
        nativeScore, projectedMovePct: winner.projectedMovePct,
        ts: bar.closeTs, conflictResolution,
      });

      // Admission â€” ledger provides true cross-symbol open count / symbol-open state
      const nowMs        = tsMs;
      const dayStartTs   = nowMs - 86_400_000;
      const weekStartTs  = nowMs - 7 * 86_400_000;
      const dailyLossUsd  = ctx.simClosedPnls.filter(p => p.closeTs >= dayStartTs) .reduce((s, p) => s + p.pnlUsd, 0);
      const weeklyLossUsd = ctx.simClosedPnls.filter(p => p.closeTs >= weekStartTs).reduce((s, p) => s + p.pnlUsd, 0);
      const dailyLossLimitBreached  = dailyLossUsd  < 0 && Math.abs(dailyLossUsd)  / ctx.totalCapital >= ctx.maxDailyLossPct;
      const weeklyLossLimitBreached = weeklyLossUsd < 0 && Math.abs(weeklyLossUsd) / ctx.totalCapital >= ctx.maxWeeklyLossPct;
      const currentDrawdownPct = ctx.simEquityPeak > 0 ? (ctx.simEquityPeak - ctx.simEquity) / ctx.simEquityPeak : 0;
      const maxDrawdownBreached = currentDrawdownPct >= ctx.maxDrawdownThresholdPct;

      const allocResult = evaluateSignalAdmission({
        symbol: ctx.sym, engineName: winner.engineName, direction: winner.direction,
        nativeScore, confidence: winner.confidence,
        mode: _mode, minScoreGate: ctx.modeGate,
        killSwitchActive: ctx.killSwitchActive,
        modeEnabled:      ctx.modeEnabled,
        symbolEnabled:    ctx.symbolEnabled,
        // Cross-symbol portfolio state from shared ledger â€” true concurrent state at T
        openTradeForSymbol: ledger.isSymbolOpen(ctx.sym, tsMs),
        currentOpenCount:   ledger.getOpenCount(tsMs),
        maxOpenTrades:      ctx.maxOpenTrades,
        dailyLossLimitBreached, weeklyLossLimitBreached, maxDrawdownBreached,
        correlatedFamilyCapBreached: false,
        simulationDefaults: [],   // no parity gaps â€” ledger covers all cross-symbol gates
      });

      if (!allocResult.allowed) {
        const isTradeManagementBlock = allocResult.rejectionStage === 5;
        if (!isTradeManagementBlock) {
          ctx.signalsBlocked++;
          ctx.blockedByEngine[winner.engineName] = (ctx.blockedByEngine[winner.engineName] ?? 0) + 1;
        }
        recordBehaviorEvent({
          eventType: "blocked_by_gate", symbol: ctx.sym, engineName: winner.engineName,
          direction: winner.direction, regimeAtEntry: regimeResult.regime,
          nativeScore, modeGate: ctx.modeGate, mode: _mode, ts: bar.closeTs,
          rejectionStage:   allocResult.rejectionStage   ?? undefined,
          rejectionReason:  allocResult.rejectionReason  ?? `stage${allocResult.rejectionStage ?? 0}`,
          isSignalQualityBlock: allocResult.rejectionStage === 4,
        });
        continue;
      }

      const builtCandidate = ctx.sym === "CRASH300"
        ? buildSymbolTradeCandidate({
            symbol: ctx.sym,
            mode: _mode,
            coordinatorOutput: coordinatorOutput as NonNullable<typeof coordinatorOutput>,
            winner,
            features,
            spotPrice: bar.close,
            runtimeCalibration: ctx.runtimeCalibration,
            allowedQualityBands: runtimeQualityBands,
            positionSize: SYNTHETIC_SIZE,
            equity: SYNTHETIC_EQUITY,
          })
        : null;
      if (ctx.sym === "CRASH300" && !builtCandidate) continue;
      const setupEvidence = builtCandidate
        ? builtCandidate.candidate.runtimeSetup
        : evaluateRuntimeEntryEvidence({
            symbol: ctx.sym,
            direction: winner.direction,
            nativeScore,
            winner,
            features,
            runtimeCalibration: ctx.runtimeCalibration,
            allowedQualityBands: runtimeQualityBands,
          });
      const setupSignature = builtCandidate
        ? builtCandidate.setupSignature
        : (setupEvidence.matchedBucketKey
            ? setupEvidence.matchedBucketKey
            : `${setupEvidence.leadInShape}|${setupEvidence.qualityBand}`);

      if (!setupEvidence.allowed) {
        ctx.signalsBlocked++;
        ctx.blockedByEngine[winner.engineName] = (ctx.blockedByEngine[winner.engineName] ?? 0) + 1;
        recordBehaviorEvent({
          eventType: "blocked_by_gate", symbol: ctx.sym, engineName: winner.engineName,
          direction: winner.direction, regimeAtEntry: regimeResult.regime,
          nativeScore, modeGate: ctx.modeGate, mode: _mode, ts: bar.closeTs,
          rejectionStage: 12,
          rejectionReason: `runtime_setup_evidence:${setupEvidence.reason}`,
          isSignalQualityBlock: false,
        });
        continue;
      }

      const candidateWindow = ctx.sym === "CRASH300"
        ? { allowed: true, reason: "crash300_context_trigger_only", key: `${ctx.sym}|instant` }
        : evaluateReplayCandidateWindow({
            windows: ctx.candidateWindows,
            runtimeCalibration: ctx.runtimeCalibration,
            symbol: ctx.sym,
            engineName: winner.engineName,
            direction: winner.direction,
            nativeScore,
            setupSignature,
            ts,
          });
      if (!candidateWindow.allowed) {
        ctx.signalsBlocked++;
        ctx.blockedByEngine[winner.engineName] = (ctx.blockedByEngine[winner.engineName] ?? 0) + 1;
        recordBehaviorEvent({
          eventType: "blocked_by_gate", symbol: ctx.sym, engineName: winner.engineName,
          direction: winner.direction, regimeAtEntry: regimeResult.regime,
          nativeScore, modeGate: ctx.modeGate, mode: _mode, ts: bar.closeTs,
          rejectionStage: 11,
          rejectionReason: candidateWindow.reason,
          isSignalQualityBlock: false,
        });
        continue;
      }

      // SR/Fib TP â€” same as single-symbol path
      let tp: number;
      let sl: number;
      if (ctx.sym === "CRASH300" && builtCandidate) {
        const crashTp = builtCandidate.candidate.exitPolicy.takeProfitPrice;
        const crashSl = builtCandidate.candidate.exitPolicy.stopLossPrice;
        if (typeof crashTp !== "number" || typeof crashSl !== "number" || !Number.isFinite(crashTp) || !Number.isFinite(crashSl) || crashTp <= 0 || crashSl <= 0) {
          throw new Error("CRASH300 runtime model missing/invalid. Cannot evaluate symbol service. runtime_exit_policy_missing");
        }
        tp = crashTp;
        sl = crashSl;
      } else {
        tp = calculateSRFibTP({
          entryPrice: bar.close, direction: winner.direction,
          swingHigh: features.swingHigh, swingLow: features.swingLow,
          majorSwingHigh: features.majorSwingHigh, majorSwingLow: features.majorSwingLow,
          fibExtensionLevels:     features.fibExtensionLevels     ?? [],
          fibExtensionLevelsDown: features.fibExtensionLevelsDown ?? [],
          bbUpper: features.bbUpper, bbLower: features.bbLower, atrPct: features.atr14,
          pivotLevels: [features.pivotR1, features.pivotR2, features.pivotS1, features.pivotS2]
            .filter((v): v is number => typeof v === "number"),
          vwap: features.vwap, psychRound: features.psychRound,
          prevSessionHigh: features.prevSessionHigh, prevSessionLow: features.prevSessionLow,
          spikeMagnitude: features.spikeMagnitude,
        });
        if (!isFinite(tp) || tp <= 0) continue;
        if (winner.direction === "buy"  && tp <= bar.close) continue;
        if (winner.direction === "sell" && tp >= bar.close) continue;

        sl = calculateSRFibSL({
          entryPrice: bar.close, direction: winner.direction, tp,
          positionSize: SYNTHETIC_SIZE, equity: SYNTHETIC_EQUITY,
        });
        if (!isFinite(sl) || sl <= 0) continue;

        ({ tp, sl } = applyRuntimeCalibrationExitModel({
          spotPrice: bar.close,
          direction: winner.direction,
          tp,
          sl,
          trailingStopPct: ctx.trailingDistancePct ?? 0,
          mode: _mode,
          runtimeCalibration: ctx.runtimeCalibration,
          nativeScore,
          features,
        }));

        if (!isFinite(tp) || tp <= 0) continue;
        if (winner.direction === "buy"  && tp <= bar.close) continue;
        if (winner.direction === "sell" && tp >= bar.close) continue;
        if (!isFinite(sl) || sl <= 0) continue;
      }

      const tpPct        = Math.abs(tp - bar.close) / bar.close;
      const slOriginalPct = Math.abs(sl - bar.close) / bar.close;
      const runtimeProjectedMovePct = tpPct;
      const symbolServiceDecision = winnerSymbolServiceDecision(winner);
      const symbolServiceEvidence = optionalRecord(symbolServiceDecision["evidence"]);
      const matchedPolicyMove = ctx.sym === "CRASH300"
        ? matchDetectedMoveForAdmission(bar.closeTs, winner.direction, ctx.detectedMoves)
        : null;
      const admissionSemanticFlags: string[] = [];
      const runtimeFamily = optionalString(symbolServiceDecision["setupFamily"]);
      const selectedBucket = optionalString(symbolServiceDecision["moveBucket"]);
      const triggerDirection = optionalString(symbolServiceEvidence?.["triggerDirection"]) ?? "unknown";
      const familyDirection = familyDirectionForAdmission(runtimeFamily);
      const bucketDirection = bucketDirectionForAdmission(selectedBucket);
      if (triggerDirection !== "unknown" && triggerDirection !== "none" && triggerDirection !== winner.direction) {
        admissionSemanticFlags.push("trigger_trade_direction_mismatch");
      }
      if (familyDirection !== "unknown" && bucketDirection !== "unknown" && familyDirection !== bucketDirection) {
        admissionSemanticFlags.push("family_bucket_direction_mismatch");
      }
      if (runtimeFamily === "post_crash_recovery_up" && matchedPolicyMove?.direction === "down") {
        admissionSemanticFlags.push("recovery_up_family_on_down_move");
      }
      if (runtimeFamily === "crash_event_down" && matchedPolicyMove?.direction === "up") {
        admissionSemanticFlags.push("crash_down_family_on_up_move");
      }
      const admissionDecision = ctx.sym === "CRASH300" && builtCandidate
        ? evaluateCrash300AdmissionPolicy(
            { setupFamily: runtimeFamily, moveBucket: selectedBucket },
            optionalRecord(symbolServiceEvidence?.["contextSnapshot"]),
            optionalRecord(symbolServiceEvidence?.["triggerSnapshot"]),
            {
              tradeDirection: winner.direction,
              triggerDirection: triggerDirection as "buy" | "sell" | "none" | "unknown",
              runtimeFamily,
              selectedBucket,
              matchedMoveDirection: matchedPolicyMove?.direction ?? "unknown",
              triggerFresh: optionalBoolean(symbolServiceEvidence?.["triggerFresh"]),
              familyDirection,
              bucketDirection,
              semanticFlags: admissionSemanticFlags,
              evaluationMode: "backtest",
            },
            crash300AdmissionPolicy,
          )
        : null;
      if (admissionDecision?.wouldHaveBlocked) {
        bumpReasonCounts(ctx.admissionPolicyBlockedReasonsCounts, admissionDecision.blockedReasons);
        if (admissionDecision.policyMode === "enforce") {
          ctx.admissionPolicyBlockedCandidates += 1;
          ctx.signalsBlocked++;
          ctx.blockedByEngine[winner.engineName] = (ctx.blockedByEngine[winner.engineName] ?? 0) + 1;
          recordBehaviorEvent({
            eventType: "blocked_by_gate", symbol: ctx.sym, engineName: winner.engineName,
            direction: winner.direction, regimeAtEntry: regimeResult.regime,
            nativeScore, modeGate: ctx.modeGate, mode: _mode, ts: bar.closeTs,
            rejectionStage: 13,
            rejectionReason: `admission_policy:${admissionDecision.blockedReasons.join("|")}`,
            isSignalQualityBlock: false,
          });
          continue;
        }
      }

      recordBehaviorEvent({
        eventType: "entered", symbol: ctx.sym, engineName: winner.engineName,
        entryType: winner.entryType, direction: winner.direction,
        regimeAtEntry: regimeResult.regime, regimeConfidence: regimeResult.confidence,
        nativeScore, projectedMovePct: runtimeProjectedMovePct,
        entryTs: bar.closeTs, tpPct, slPct: slOriginalPct,
      });

      ctx.openTrade = {
        winner, entryBar: i, entryPrice: bar.close, entryTs: bar.closeTs,
        regimeAtEntry: regimeResult.regime, regimeConfidence: regimeResult.confidence,
        nativeScore, conflictResolution, tp, sl, originalSl: sl,
        scoringSource,
        runtimeModelRunId: ctx.runtimeCalibration?.sourceRunId ?? null,
        runtimeProjectedMovePct,
        stage: 1, peakPrice: bar.close, mfePct: 0, maePct: 0, mfePeakBar: i,
        beTriggeredBar: 0, mfePctAtBreakeven: 0,
        atr14AtEntry: Math.max(features.atr14, 0.001),
        instrumentFamily: ctx.instrumentFamily,
        emaSlope: features.emaSlope, spikeCount4h: features.spikeCount4h ?? 0,
        adverseCandleCount: 0, tpPct, slOriginalPct, tpProgressAtBe: 0,
        trailingActivationThresholdPct: ctx.sym === "CRASH300" && builtCandidate
          ? builtCandidate.candidate.exitPolicy.trailingArmPct
          : ctx.trailingActivationThresholdPct,
        trailingDistancePct: ctx.sym === "CRASH300" && builtCandidate
          ? builtCandidate.candidate.exitPolicy.trailingDistancePct
          : ctx.trailingDistancePct,
        trailingMinHoldBars: ctx.sym === "CRASH300" && builtCandidate
          ? builtCandidate.candidate.exitPolicy.minHoldMinutes
          : ctx.trailingMinHoldBars,
        runtimeFamily: optionalString(symbolServiceDecision["setupFamily"]),
        selectedBucket: optionalString(symbolServiceDecision["moveBucket"]),
        qualityTier: optionalString(symbolServiceDecision["qualityTier"]),
        confidence: optionalNumber(symbolServiceDecision["confidence"]),
        setupMatch: optionalNumber(symbolServiceDecision["setupMatch"]),
        trailingActivated: false,
        contextSnapshotAtEntry: optionalRecord(symbolServiceEvidence?.["contextSnapshot"]),
        triggerSnapshotAtEntry: optionalRecord(symbolServiceEvidence?.["triggerSnapshot"]),
        contextFamilyCandidates: optionalRecordArray(symbolServiceEvidence?.["contextFamilyCandidates"]),
        selectedContextFamily: optionalString(symbolServiceEvidence?.["selectedContextFamily"]),
        selectedTriggerTransition: optionalString(symbolServiceEvidence?.["selectedTriggerTransition"]),
        triggerDirection: optionalString(symbolServiceEvidence?.["triggerDirection"]),
        triggerStrengthScore: optionalNumber(symbolServiceEvidence?.["triggerStrengthScore"]),
        contextAgeBars: optionalNumber(symbolServiceEvidence?.["contextAgeBars"]),
        contextAgeMinutes: optionalNumber(symbolServiceEvidence?.["contextAgeMinutes"]),
        triggerAgeBars: optionalNumber(symbolServiceEvidence?.["triggerAgeBars"]),
        triggerFresh: optionalBoolean(symbolServiceEvidence?.["triggerFresh"]),
        contextEpochId: optionalString(symbolServiceEvidence?.["contextEpochId"]),
        duplicateWithinContextEpoch: optionalBoolean(symbolServiceEvidence?.["duplicateWithinContextEpoch"]),
        previousTradeInSameContextEpoch: optionalString(symbolServiceEvidence?.["previousTradeInSameContextEpoch"]),
        wouldBlockNoTrigger: optionalBoolean(symbolServiceEvidence?.["wouldBlockNoTrigger"]),
        wouldBlockStaleContext: optionalBoolean(symbolServiceEvidence?.["wouldBlockStaleContext"]),
        wouldBlockDuplicateEpoch: optionalBoolean(symbolServiceEvidence?.["wouldBlockDuplicateEpoch"]),
        wouldBlockDirectionMismatch: optionalBoolean(symbolServiceEvidence?.["wouldBlockDirectionMismatch"]),
        wouldBlockLateAfterMoveWindow: optionalBoolean(symbolServiceEvidence?.["wouldBlockLateAfterMoveWindow"]),
        admissionPolicyWouldBlock: admissionDecision?.wouldHaveBlocked ?? false,
        admissionPolicyBlockedReasons: admissionDecision?.blockedReasons ?? [],
        admissionPolicyMode: admissionDecision?.policyMode ?? (crash300AdmissionPolicy.enabled ? crash300AdmissionPolicy.mode : "off"),
      };
      ledger.open(ctx.sym, ctx.instrumentFamily, tsMs);
      if (ctx.sym !== "CRASH300") {
        markReplayCandidateExecuted(ctx.candidateWindows, candidateWindow.key, ts, ctx.runtimeCalibration);
      }
    }
  }

  // â”€â”€ Collect results â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const out: Record<string, V3BacktestResult> = {};
  for (const [sym, ctx] of symCtxMap.entries()) {
    const barsInRange = Math.max(0, ctx.candles.length - ctx.simStart);
    const blockedRate = ctx.signalsFired > 0 ? ctx.signalsBlocked / ctx.signalsFired : 0;
    const moveOverlap = calcMoveOverlapDiagnostics({
      moves: detectedMovesBySymbol.get(sym) ?? [],
      trades: ctx.trades,
    });
    const admissionPolicyMeta = buildAdmissionPolicyMeta({
      config: crash300AdmissionPolicy,
      trades: ctx.trades,
      blockedCandidateCount: ctx.admissionPolicyBlockedCandidates,
      blockedReasonsCounts: ctx.admissionPolicyBlockedReasonsCounts,
    });
    out[sym] = {
      symbol: sym, mode: _mode, tierMode, startTs: _startTs, endTs: _endTs,
      totalBars: barsInRange, modeScoreGate: ctx.modeGate,
      signalsFired: ctx.signalsFired, signalsBlocked: ctx.signalsBlocked, blockedRate,
      runtimeModel: runtimeModelDiagnostics(ctx.runtimeCalibrationResolution, ctx.scoringSourceCounts),
      admissionPolicy: admissionPolicyMeta,
      trades: ctx.trades,
      simulationGaps: [],
      moveOverlap,
      summary: computeSummary(ctx.trades, ctx.blockedByEngine, admissionPolicyMeta, {
        startingCapitalUsd,
        allocationPct: DEFAULT_ALLOCATION_PCT,
        maxConcurrentTrades: ctx.maxOpenTrades,
        compoundingEnabled: false,
        syntheticEquityUsd: SYNTHETIC_EQUITY,
        syntheticPositionSizeUsd: SYNTHETIC_SIZE,
      }),
    };
  }

  // Fill missing symbols (insufficient candle data) with empty results
  for (const sym of symbols) {
    if (!out[sym]) {
      out[sym] = {
        symbol: sym, mode: _mode, tierMode, startTs: _startTs, endTs: _endTs,
        totalBars: 0, modeScoreGate: sharedModeGate,
        signalsFired: 0, signalsBlocked: 0, blockedRate: 0,
        runtimeModel: runtimeModelDiagnostics(null),
        admissionPolicy: buildAdmissionPolicyMeta({
          config: crash300AdmissionPolicy,
          trades: [],
          blockedCandidateCount: 0,
          blockedReasonsCounts: {},
        }),
        trades: [],
        simulationGaps: [],
        moveOverlap: {
          movesInWindow: 0,
          capturedMoves: 0,
          missedMoves: 0,
          captureRate: 0,
          tradesMatchedToMoves: 0,
          ghostTrades: 0,
          ghostRate: 0,
          moveDirectionSplit: { up: 0, down: 0 },
        },
        summary: computeSummary([], {}, buildAdmissionPolicyMeta({
          config: crash300AdmissionPolicy,
          trades: [],
          blockedCandidateCount: 0,
          blockedReasonsCounts: {},
        }), {
          startingCapitalUsd,
          allocationPct: DEFAULT_ALLOCATION_PCT,
          maxConcurrentTrades: sharedMaxOpenTrades,
          compoundingEnabled: false,
          syntheticEquityUsd: SYNTHETIC_EQUITY,
          syntheticPositionSizeUsd: SYNTHETIC_SIZE,
        }),
      };
    }
  }

  return out;
}

