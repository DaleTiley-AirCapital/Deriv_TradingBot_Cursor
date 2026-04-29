import { db, candlesTable, detectedMovesTable } from "@workspace/db";
import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { CandleRow } from "../../core/backtest/featureSlice.js";
import type { V3BacktestResult, V3BacktestTrade } from "../../core/backtest/backtestRunner.js";
import { buildCrash300TradeOutcomeAttributionReport } from "../../core/backtest/tradeOutcomeAttribution.js";
import type { PromotedSymbolRuntimeModel } from "../../core/calibration/promotedSymbolModel.js";
import { runCrash300CalibrationParity } from "./calibration.js";
import { buildCrash300ContextSnapshot } from "./context.js";
import type {
  Crash300ContextSnapshot,
  Crash300CrashEvent,
  Crash300RuntimeFamily,
  Crash300TriggerSnapshot,
} from "./features.js";
import { loadCrash300RuntimeEnvelope } from "./model.js";
import type { ParityMoveVerdict } from "../shared/parityTypes.js";
import { buildCrash300TriggerSnapshot } from "./trigger.js";

const SYMBOL = "CRASH300";
const BEFORE_OFFSETS = [-240, -120, -60, -30, -15, -5, -1] as const;
const TRIGGER_OFFSETS = [-5, -3, -2, -1, 0, 1, 3, 5] as const;
const DURING_HORIZONS = [5, 15, 30, 60, 120, 240] as const;
const AFTER_HORIZONS = [5, 15, 30, 60, 120, 240] as const;
const LOOKBACK_BUFFER_BARS = 1600;

type MoveSizeBucket = "5_to_6_pct" | "6_to_8_pct" | "8_to_10_pct" | "10_plus_pct";

type DetectedMoveRow = {
  id: number;
  symbol: string;
  startTs: number;
  endTs: number;
  startPrice: number;
  endPrice: number;
  direction: "up" | "down" | "unknown";
  moveType: string;
  movePct: number;
  qualityTier: string;
  qualityScore: number;
  leadInShape: string;
  leadInBars: number;
  directionalPersistence: number;
  rangeExpansion: number;
  holdingMinutes: number;
};

type PhaseWindow = {
  startTs: number;
  endTs: number;
};

type Crash300ContextSnapshotWithMoveMeta = Crash300ContextSnapshot & {
  offsetBars: number;
  barsUntilCurrentMoveStart: number;
  priorMoveDirection: "up" | "down" | "unknown";
  priorMovePct: number | null;
  priorMoveQualityTier: string | null;
};

type Crash300TriggerSnapshotWithMoveMeta = Crash300TriggerSnapshot & {
  offsetBars: number;
  expectedTradeDirection: "buy" | "sell" | null;
  directionMatchesMove: boolean;
  triggerFreshAtMoveStart: boolean;
  contextTrendPersistenceScore: number;
  contextRecoveryQualityScore: number;
  contextCrashRecencyScore: number;
  contextCompressionToExpansionScore: number;
  contextRecoveryFromLastCrashPct: number | null;
  contextPriceVsEma20Pct: number;
  contextPriceVsEma50Pct: number;
  contextAtr14Pct: number;
  triggerDiagnosticOnly: boolean;
  liveEligibleTrigger: boolean;
  triggerConfirmationOffsetBars: number | null;
  adverseImpulseBeforeTrigger: boolean;
  adverseImpulseDirection: "up" | "down" | "none";
  adverseImpulsePct: number;
  reclaimConfirmed: boolean;
};

type Crash300PhaseDerivedFamily =
  | Crash300RuntimeFamily
  | "bear_trap_reversal_up"
  | "bull_trap_reversal_down"
  | "unknown";

type Crash300PhaseBucketContext =
  | "trending"
  | "recovery"
  | "compression"
  | "failed_recovery"
  | "crash_event"
  | "reversal";

type Crash300PhaseDerivedBucket = `${"up" | "down"}|${Crash300PhaseBucketContext}|${MoveSizeBucket}`;

type Crash300DuringHorizon = {
  horizonBars: number | "move_end";
  label: string;
  endTs: number;
  mfePct: number;
  maePct: number;
  netMovePct: number;
  adverseFirstPct: number;
  favourableFirstPct: number;
};

type Crash300AfterHorizon = {
  horizonBars: number;
  label: string;
  endTs: number;
  reversalPctAfterMove: number;
  continuationPctAfterMove: number;
  netMovePct: number;
};

type Crash300TradeLinkage = {
  backtestRunId: number | null;
  tradesLinkedToMove: number;
  firstTradeEntryDelayMinutes: number | null;
  lastTradeEntryDelayMinutes: number | null;
  tradeDirections: Array<"buy" | "sell">;
  tradeRuntimeFamilies: string[];
  tradeSelectedBuckets: string[];
  tradeWins: number;
  tradeLosses: number;
  duplicateTradeCount: number;
  conflictingDirectionTradeCount: number;
  classifications: string[];
};

type Crash300MovePhaseBefore = {
  snapshots: Crash300ContextSnapshotWithMoveMeta[];
};

type Crash300MovePhaseTrigger = {
  snapshots: Crash300TriggerSnapshotWithMoveMeta[];
  strongestTriggerOffset: number | null;
  strongestTriggerDirection: "buy" | "sell" | "none";
  strongestTriggerStrength: number;
  strongestTriggerTransition: Crash300TriggerSnapshot["triggerTransition"];
  firstValidTriggerOffset: number | null;
  firstValidTriggerDirection: "buy" | "sell" | "none";
  firstValidTriggerTransition: Crash300TriggerSnapshot["triggerTransition"];
};

type Crash300MovePhaseDuring = {
  referenceEntryPrice: number;
  horizons: Crash300DuringHorizon[];
  barsToMfe25: number | null;
  barsToMfe50: number | null;
  barsToMfe75: number | null;
  barsToMfe100: number | null;
  barsToMaxMfe: number | null;
  barsToMaxMae: number | null;
  barsToMae25OfMove: number | null;
  barsToMae50OfMove: number | null;
  pullbackAfterMfe25: number | null;
  pullbackAfterMfe50: number | null;
  pullbackAfterMfe75: number | null;
  maxPullbackBeforeContinuationPct: number;
  continuationFailureBars: number | null;
  stallBars: number;
  oppositeImpulseCount: number;
  oppositeImpulseMaxPct: number;
  volatilityExpansionDuringMove: number;
  trendPersistenceDuringMove: number;
  observedSafeInitialSlPct: number;
  observedNormalMaePct: number;
  observedP75MaePct: number;
  observedP90MaePct: number;
  observedTrailingActivationPct: number | null;
  observedTrailingDistancePct: number | null;
  observedMinHoldBarsBeforeTrailing: number | null;
  realisticTpPct: number;
  realisticTpPctP50: number;
  realisticTpPctP75: number;
  realisticTpPctP90: number;
};

type Crash300MovePhaseAfter = {
  horizons: Crash300AfterHorizon[];
  reversalPctAfterMove: number;
  barsToReversal25: number | null;
  barsToReversal50: number | null;
  postMoveVolatilityExpansion: number;
  postMoveCompression: number;
  failedContinuationAfterMove: boolean;
  meanReversionSpeed: number;
  nextMoveStartTs: number | null;
  barsUntilNextMove: number | null;
  nextMoveDirection: "up" | "down" | "unknown" | null;
  nextMovePct: number | null;
};

type Crash300DerivedLabels = {
  hasCleanLeadIn: boolean;
  hasCompressionBeforeMove: boolean;
  hasFreshTriggerAtStart: boolean;
  hasLateTriggerOnly: boolean;
  hasWrongDirectionTriggerBeforeMove: boolean;
  hasNormalAdverseExcursion: boolean;
  hasExcessiveAdverseExcursion: boolean;
  hasEarlyMfe: boolean;
  hasDelayedMfe: boolean;
  hasFastReversalAfterMove: boolean;
  likelyTrendContinuation: boolean;
  likelyPostCrashRecovery: boolean;
  likelyFailedRecoveryShort: boolean;
  likelyCrashContinuation: boolean;
};

export interface Crash300MovePhaseIdentifiers {
  moveId: number;
  symbol: string;
  startTs: number;
  endTs: number;
  direction: "up" | "down" | "unknown";
  moveType: string;
  movePct: number;
  moveSizeBucket: MoveSizeBucket;
  qualityTier: string;
  runtimeFamily: string | null;
  selectedBucket: string | null;
  parityRuntimeFamily: string | null;
  phaseDerivedFamily: Crash300PhaseDerivedFamily;
  familySource: "phase-derived" | "parity-only" | "unknown";
  parityFamilyDisagreesWithPhaseFamily: boolean;
  paritySelectedBucket: string | null;
  phaseDerivedBucket: Crash300PhaseDerivedBucket;
  bucketSource: "phase-derived";
  parityBucketMissing: boolean;
  before: Crash300MovePhaseBefore;
  trigger: Crash300MovePhaseTrigger;
  during: Crash300MovePhaseDuring;
  after: Crash300MovePhaseAfter;
  derivedLabels: Crash300DerivedLabels;
  eventualOutcome: string;
  tradeBacktestOutcome: string | null;
  parity: {
    candidateProduced: boolean | null;
    expectedTradeDirection: "buy" | "sell" | null;
    actualCandidateDirection: "buy" | "sell" | null;
    familyCompatible: boolean | null;
    directionCompatible: boolean | null;
    matchReason: string | null;
    mismatchReason: string | null;
  } | null;
  backtestLinkage: Crash300TradeLinkage | null;
}

export interface Crash300MovePhaseIdentifierReport {
  symbol: string;
  generatedAt: string;
  source: string;
  window: PhaseWindow;
  promotedModelRunId: number | null;
  detectedMoveCount: number;
  moves: Crash300MovePhaseIdentifiers[];
  aggregates: Record<string, unknown>;
  diagnostics: {
    missingPromotedModel: boolean;
    candleRangeStartTs: number | null;
    candleRangeEndTs: number | null;
    truncatedBeforeSnapshots: number;
    truncatedTriggerSnapshots: number;
    truncatedDuringHorizons: number;
    truncatedAfterHorizons: number;
    movesWithoutNextMove: number;
    linkedBacktestRunId: number | null;
    move11419Summary: {
      triggerFound: boolean;
      phaseDerivedFamily: Crash300PhaseDerivedFamily | null;
      phaseDerivedBucket: Crash300PhaseDerivedBucket | null;
      strongestTriggerOffset: number | null;
      strongestTriggerTransition: Crash300TriggerSnapshot["triggerTransition"] | null;
    } | null;
  };
}

type FlattenedMetricMap = Record<string, number[]>;

type PersistedV3RunRow = {
  id: number;
  symbol: string;
  startTs: number;
  endTs: number;
  mode: string;
  tierMode: string;
  runtimeModelRunId: number | null;
  summary: Record<string, unknown>;
  result: Record<string, unknown>;
  createdAt: string;
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdDev(values: number[]): number {
  if (values.length <= 1) return 0;
  const mean = avg(values);
  return Math.sqrt(avg(values.map((value) => (value - mean) ** 2)));
}

function percentile(values: number[], pct: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * pct)));
  return sorted[idx] ?? 0;
}

function signedMovePct(entryPrice: number, price: number, direction: "up" | "down" | "unknown"): number {
  if (!Number.isFinite(entryPrice) || entryPrice === 0) return 0;
  const raw = (price - entryPrice) / entryPrice;
  if (direction === "up") return raw;
  if (direction === "down") return -raw;
  return 0;
}

function adverseMovePct(entryPrice: number, price: number, direction: "up" | "down" | "unknown"): number {
  if (!Number.isFinite(entryPrice) || entryPrice === 0) return 0;
  const raw = (price - entryPrice) / entryPrice;
  if (direction === "up") return Math.max(0, -raw);
  if (direction === "down") return Math.max(0, raw);
  return 0;
}

function moveSizeBucket(movePct: number): MoveSizeBucket {
  if (movePct < 6) return "5_to_6_pct";
  if (movePct < 8) return "6_to_8_pct";
  if (movePct < 10) return "8_to_10_pct";
  return "10_plus_pct";
}

function expectedTradeDirection(direction: "up" | "down" | "unknown"): "buy" | "sell" | null {
  if (direction === "up") return "buy";
  if (direction === "down") return "sell";
  return null;
}

function toRuntimeFamily(value: string | null | undefined): Crash300RuntimeFamily | null {
  if (
    value === "drift_continuation_up" ||
    value === "post_crash_recovery_up" ||
    value === "failed_recovery_short" ||
    value === "crash_event_down"
  ) {
    return value;
  }
  return null;
}

function parityBucketMissing(value: string | null | undefined): boolean {
  if (!value) return true;
  const normalized = value.trim().toLowerCase();
  return normalized.length === 0 || normalized === "unknown" || normalized === "none";
}

function directionFromFamily(family: Crash300PhaseDerivedFamily): "up" | "down" | "unknown" {
  if (
    family === "drift_continuation_up" ||
    family === "post_crash_recovery_up" ||
    family === "bear_trap_reversal_up"
  ) {
    return "up";
  }
  if (
    family === "failed_recovery_short" ||
    family === "crash_event_down" ||
    family === "bull_trap_reversal_down"
  ) {
    return "down";
  }
  return "unknown";
}

function bucketContextFromFamily(
  family: Crash300PhaseDerivedFamily,
  trigger: Crash300MovePhaseTrigger,
): Crash300PhaseBucketContext {
  const hasCompressionBreak = trigger.snapshots.some((snapshot) =>
    snapshot.triggerTransition === "compression_break_up" || snapshot.triggerTransition === "compression_break_down",
  );
  if (hasCompressionBreak) return "compression";
  if (family === "post_crash_recovery_up") return "recovery";
  if (family === "failed_recovery_short") return "failed_recovery";
  if (family === "crash_event_down") return "crash_event";
  if (family === "bear_trap_reversal_up" || family === "bull_trap_reversal_down") return "reversal";
  return "trending";
}

function buildPhaseDerivedBucket(params: {
  moveDirection: "up" | "down" | "unknown";
  family: Crash300PhaseDerivedFamily;
  trigger: Crash300MovePhaseTrigger;
  moveSizeBucket: MoveSizeBucket;
}): Crash300PhaseDerivedBucket {
  const direction = params.moveDirection === "unknown" ? directionFromFamily(params.family) : params.moveDirection;
  const safeDirection = direction === "down" ? "down" : "up";
  const context = bucketContextFromFamily(params.family, params.trigger);
  return `${safeDirection}|${context}|${params.moveSizeBucket}`;
}

function triggerOffsetLabel(offset: number): string {
  if (offset === 0) return "T0";
  return offset > 0 ? `T+${offset}` : `T${offset}`;
}

function duringLabel(horizon: number | "move_end"): string {
  return horizon === "move_end" ? "move_end" : `plus_${horizon}`;
}

function afterLabel(horizon: number): string {
  return `after_${horizon}`;
}

function normalizeDirection(value: unknown): "up" | "down" | "unknown" {
  if (value === "up" || value === "down") return value;
  return "unknown";
}

function pickCandleIndexAtOrAfter(candles: CandleRow[], ts: number): number {
  const idx = candles.findIndex((candle) => candle.closeTs >= ts);
  return idx >= 0 ? idx : candles.length - 1;
}

function pickSnapshotIndex(baseIndex: number, offset: number, candles: CandleRow[]): number {
  return Math.max(0, Math.min(candles.length - 1, baseIndex + offset));
}

function flattenNumericValues(value: unknown, prefix: string, into: FlattenedMetricMap) {
  if (typeof value === "number" && Number.isFinite(value)) {
    into[prefix] ??= [];
    into[prefix].push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const rec = entry as Record<string, unknown>;
        const suffix = typeof rec["offsetBars"] === "number"
          ? `offset_${String(rec["offsetBars"]).replace("-", "m")}`
          : typeof rec["label"] === "string"
            ? String(rec["label"])
            : String(index);
        flattenNumericValues(entry, `${prefix}.${suffix}`, into);
      } else {
        flattenNumericValues(entry, `${prefix}.${index}`, into);
      }
    });
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      flattenNumericValues(nested, prefix ? `${prefix}.${key}` : key, into);
    }
  }
}

function summarizeStats(values: number[]) {
  const filtered = values.filter((value) => Number.isFinite(value));
  return {
    count: filtered.length,
    min: filtered.length > 0 ? Math.min(...filtered) : 0,
    p10: percentile(filtered, 0.1),
    p25: percentile(filtered, 0.25),
    median: percentile(filtered, 0.5),
    mean: avg(filtered),
    p75: percentile(filtered, 0.75),
    p90: percentile(filtered, 0.9),
    max: filtered.length > 0 ? Math.max(...filtered) : 0,
    standardDeviation: stdDev(filtered),
  };
}

function metricDiffScore(groups: Array<{ label: string; value: number }>): number {
  const values = groups.map((group) => group.value).filter((value) => Number.isFinite(value));
  if (values.length <= 1) return 0;
  return Math.abs(Math.max(...values) - Math.min(...values));
}

function ensureRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function resolveWindow(input: {
  startTs?: number | null;
  endTs?: number | null;
}): Promise<PhaseWindow> {
  if (Number.isFinite(input.startTs) && Number.isFinite(input.endTs)) {
    return { startTs: Number(input.startTs), endTs: Number(input.endTs) };
  }

  const rows = await db
    .select({
      startTs: detectedMovesTable.startTs,
      endTs: detectedMovesTable.endTs,
    })
    .from(detectedMovesTable)
    .where(eq(detectedMovesTable.symbol, SYMBOL))
    .orderBy(desc(detectedMovesTable.startTs))
    .limit(1);

  const latest = rows[0];
  if (!latest) {
    throw new Error("No detected CRASH300 moves available for phase identifier export.");
  }

  const endTs = Number(input.endTs ?? latest.endTs);
  const startTs = Number(input.startTs ?? Math.max(0, endTs - 365 * 86400));
  return { startTs, endTs };
}

async function loadDetectedMoves(window: PhaseWindow, limit?: number): Promise<DetectedMoveRow[]> {
  const query = db
    .select({
      id: detectedMovesTable.id,
      symbol: detectedMovesTable.symbol,
      startTs: detectedMovesTable.startTs,
      endTs: detectedMovesTable.endTs,
      startPrice: detectedMovesTable.startPrice,
      endPrice: detectedMovesTable.endPrice,
      direction: detectedMovesTable.direction,
      moveType: detectedMovesTable.moveType,
      movePct: detectedMovesTable.movePct,
      qualityTier: detectedMovesTable.qualityTier,
      qualityScore: detectedMovesTable.qualityScore,
      leadInShape: detectedMovesTable.leadInShape,
      leadInBars: detectedMovesTable.leadInBars,
      directionalPersistence: detectedMovesTable.directionalPersistence,
      rangeExpansion: detectedMovesTable.rangeExpansion,
      holdingMinutes: detectedMovesTable.holdingMinutes,
    })
    .from(detectedMovesTable)
    .where(and(
      eq(detectedMovesTable.symbol, SYMBOL),
      gte(detectedMovesTable.startTs, window.startTs),
      lte(detectedMovesTable.startTs, window.endTs),
    ))
    .orderBy(asc(detectedMovesTable.startTs));

  const rows = await (typeof limit === "number" && limit > 0 ? query.limit(limit) : query);
  return rows.map((row) => ({
    ...row,
    direction: normalizeDirection(row.direction),
    moveType: row.moveType ?? "unknown",
    qualityTier: row.qualityTier ?? "unknown",
  })) as DetectedMoveRow[];
}

async function loadCandles(window: PhaseWindow, moves: DetectedMoveRow[]): Promise<CandleRow[]> {
  if (moves.length === 0) return [];
  const earliestStart = Math.min(...moves.map((move) => move.startTs));
  const latestEnd = Math.max(...moves.map((move) => move.endTs));
  return await db
    .select({
      open: candlesTable.open,
      high: candlesTable.high,
      low: candlesTable.low,
      close: candlesTable.close,
      openTs: candlesTable.openTs,
      closeTs: candlesTable.closeTs,
    })
    .from(candlesTable)
    .where(and(
      eq(candlesTable.symbol, SYMBOL),
      eq(candlesTable.timeframe, "1m"),
      eq(candlesTable.isInterpolated, false),
      gte(candlesTable.openTs, Math.max(0, earliestStart - LOOKBACK_BUFFER_BARS * 60)),
      lte(candlesTable.openTs, latestEnd + 240 * 60),
    ))
    .orderBy(asc(candlesTable.openTs)) as CandleRow[];
}

async function loadLatestBacktestAttribution(window: PhaseWindow) {
  const rows = await db.execute(sql`
    SELECT id, symbol, start_ts AS "startTs", end_ts AS "endTs", mode, tier_mode AS "tierMode",
           runtime_model_run_id AS "runtimeModelRunId", summary, result, created_at AS "createdAt"
    FROM v3_backtest_runs
    WHERE symbol = ${SYMBOL}
      AND start_ts = ${window.startTs}
      AND end_ts = ${window.endTs}
    ORDER BY created_at DESC
    LIMIT 1
  `);
  const row = (rows.rows?.[0] ?? null) as PersistedV3RunRow | null;
  if (!row) return null;
  const report = await buildCrash300TradeOutcomeAttributionReport({
    runId: Number(row.id),
    result: ensureRecord(row.result) as unknown as V3BacktestResult,
    createdAt: row.createdAt,
  });
  return { runId: Number(row.id), report };
}

function buildParityMap(verdicts: ParityMoveVerdict[]) {
  return new Map<number, ParityMoveVerdict>(
    verdicts
      .map((verdict) => {
        const moveId = Number(verdict.moveId);
        return Number.isFinite(moveId) ? [moveId, verdict] as const : null;
      })
      .filter((entry): entry is readonly [number, ParityMoveVerdict] => entry !== null),
  );
}

function resolvePriorMove(move: DetectedMoveRow, moves: DetectedMoveRow[]) {
  const idx = moves.findIndex((row) => row.id === move.id);
  return idx > 0 ? moves[idx - 1] ?? null : null;
}

function resolveNextMove(move: DetectedMoveRow, moves: DetectedMoveRow[]) {
  const idx = moves.findIndex((row) => row.id === move.id);
  return idx >= 0 && idx < moves.length - 1 ? moves[idx + 1] ?? null : null;
}

function computeBeforeSnapshots(params: {
  move: DetectedMoveRow;
  moves: DetectedMoveRow[];
  candles: CandleRow[];
  runtimeModel: PromotedSymbolRuntimeModel;
  startIndex: number;
  diagnostics: Crash300MovePhaseIdentifierReport["diagnostics"];
}) {
  const priorMove = resolvePriorMove(params.move, params.moves);
  return BEFORE_OFFSETS.map((offset) => {
    const index = pickSnapshotIndex(params.startIndex, offset, params.candles);
    if (index !== params.startIndex + offset) params.diagnostics.truncatedBeforeSnapshots += 1;
    const slice = params.candles.slice(0, index + 1);
    const built = buildCrash300ContextSnapshot({
      symbol: SYMBOL,
      ts: params.candles[index]?.closeTs ?? params.move.startTs,
      candles: slice,
      runtimeModel: params.runtimeModel,
      detectedMoves: params.moves,
    });
    return {
      offsetBars: offset,
      barsUntilCurrentMoveStart: Math.max(0, params.move.startTs - (params.candles[index]?.closeTs ?? params.move.startTs)) / 60,
      priorMoveDirection: priorMove?.direction ?? "unknown",
      priorMovePct: priorMove?.movePct ?? null,
      priorMoveQualityTier: priorMove?.qualityTier ?? null,
      ...built.snapshot,
    } satisfies Crash300ContextSnapshotWithMoveMeta;
  });
}

function computeTriggerSnapshots(params: {
  move: DetectedMoveRow;
  moves: DetectedMoveRow[];
  candles: CandleRow[];
  runtimeModel: PromotedSymbolRuntimeModel;
  startIndex: number;
  diagnostics: Crash300MovePhaseIdentifierReport["diagnostics"];
}) {
  const expectedDirection = expectedTradeDirection(params.move.direction);
  return TRIGGER_OFFSETS.map((offset) => {
    const index = pickSnapshotIndex(params.startIndex, offset, params.candles);
    if (index !== params.startIndex + offset) params.diagnostics.truncatedTriggerSnapshots += 1;
    const slice = params.candles.slice(0, index + 1);
    const context = buildCrash300ContextSnapshot({
      symbol: SYMBOL,
      ts: params.candles[index]?.closeTs ?? params.move.startTs,
      candles: slice,
      runtimeModel: params.runtimeModel,
      detectedMoves: params.moves,
    }).snapshot;
    const trigger = buildCrash300TriggerSnapshot({
      symbol: SYMBOL,
      ts: params.candles[index]?.closeTs ?? params.move.startTs,
      candles: slice,
      context,
    });
    return {
      offsetBars: offset,
      expectedTradeDirection: expectedDirection,
      directionMatchesMove: expectedDirection !== null && trigger.triggerDirection === expectedDirection,
      triggerFreshAtMoveStart: offset >= -1 && offset <= 1 && trigger.triggerDirection !== "none",
      contextTrendPersistenceScore: context.trendPersistenceScore,
      contextRecoveryQualityScore: context.recoveryQualityScore,
      contextCrashRecencyScore: context.crashRecencyScore,
      contextCompressionToExpansionScore: context.compressionToExpansionScore,
      contextRecoveryFromLastCrashPct: context.recoveryFromLastCrashPct,
      contextPriceVsEma20Pct: context.priceVsEma20Pct,
      contextPriceVsEma50Pct: context.priceVsEma50Pct,
      contextAtr14Pct: context.atr14 / Math.max(trigger.candleClose, 1e-9),
      triggerDiagnosticOnly: false,
      liveEligibleTrigger: offset === 0 && trigger.triggerDirection !== "none",
      triggerConfirmationOffsetBars: 0,
      adverseImpulseBeforeTrigger: false,
      adverseImpulseDirection: "none",
      adverseImpulsePct: 0,
      reclaimConfirmed: false,
      ...trigger,
    } satisfies Crash300TriggerSnapshotWithMoveMeta;
  });
}

function isStrongDirectionalImpulse(
  snapshot: Crash300TriggerSnapshotWithMoveMeta,
  direction: "up" | "down",
): boolean {
  const atrPct = Math.max(snapshot.contextAtr14Pct, 0.0005);
  if (direction === "down") {
    return (
      snapshot.oneBarReturnPct <= -Math.max(atrPct * 0.7, 0.0015) ||
      snapshot.oneBarMomentum <= -0.9 ||
      (snapshot.microBreakDirection === "down" && snapshot.impulseScore >= 0.65)
    );
  }
  return (
    snapshot.oneBarReturnPct >= Math.max(atrPct * 0.7, 0.0015) ||
    snapshot.oneBarMomentum >= 0.9 ||
    (snapshot.microBreakDirection === "up" && snapshot.impulseScore >= 0.65)
  );
}

function reclaimsAdverseBody(
  adverse: Crash300TriggerSnapshotWithMoveMeta,
  candidate: Crash300TriggerSnapshotWithMoveMeta,
  direction: "up" | "down",
): boolean {
  const body = Math.abs(adverse.candleOpen - adverse.candleClose);
  if (direction === "up") {
    const reclaimHalfBody = candidate.candleClose >= adverse.candleClose + body * 0.5;
    const reclaimOpen = candidate.candleClose >= adverse.candleOpen || candidate.candleHigh >= adverse.candleOpen;
    return reclaimHalfBody || reclaimOpen;
  }
  const reclaimHalfBody = candidate.candleClose <= adverse.candleClose - body * 0.5;
  const reclaimOpen = candidate.candleClose <= adverse.candleOpen || candidate.candleLow <= adverse.candleOpen;
  return reclaimHalfBody || reclaimOpen;
}

function momentumReclaims(
  adverse: Crash300TriggerSnapshotWithMoveMeta,
  candidate: Crash300TriggerSnapshotWithMoveMeta,
  direction: "up" | "down",
): boolean {
  if (direction === "up") {
    return (
      candidate.threeBarReturnPct > 0 ||
      candidate.fiveBarReturnPct > 0 ||
      candidate.oneBarMomentum > adverse.oneBarMomentum + 0.6 ||
      candidate.closeLocationInRangePct >= 0.55
    );
  }
  return (
    candidate.threeBarReturnPct < 0 ||
    candidate.fiveBarReturnPct < 0 ||
    candidate.oneBarMomentum < adverse.oneBarMomentum - 0.6 ||
    candidate.closeLocationInRangePct <= 0.45
  );
}

function findRecentAdverseImpulse(
  snapshots: Crash300TriggerSnapshotWithMoveMeta[],
  currentIndex: number,
  direction: "up" | "down",
): { snapshot: Crash300TriggerSnapshotWithMoveMeta; offsetBars: number } | null {
  const adverseDirection = direction === "up" ? "down" : "up";
  for (let i = Math.max(0, currentIndex - 3); i < currentIndex; i++) {
    const snapshot = snapshots[i];
    if (!snapshot) continue;
    if (isStrongDirectionalImpulse(snapshot, adverseDirection)) {
      return { snapshot, offsetBars: currentIndex - i };
    }
  }
  return null;
}

function enrichDiagnosticTriggers(params: {
  move: DetectedMoveRow;
  beforeSnapshots: Crash300ContextSnapshotWithMoveMeta[];
  snapshots: Crash300TriggerSnapshotWithMoveMeta[];
}): Crash300TriggerSnapshotWithMoveMeta[] {
  const direction = params.move.direction;
  const tMinus15 = params.beforeSnapshots.find((snapshot) => snapshot.offsetBars === -15) ?? params.beforeSnapshots[0];
  return params.snapshots.map((snapshot, currentIndex) => {
    const next = { ...snapshot };
    next.liveEligibleTrigger = snapshot.offsetBars === 0 && snapshot.triggerDirection !== "none";
    if (snapshot.triggerDirection !== "none") {
      next.triggerDiagnosticOnly = snapshot.offsetBars !== 0;
    }
    const recentAdverse = (direction === "up" || direction === "down")
      ? findRecentAdverseImpulse(params.snapshots, currentIndex, direction)
      : null;
    if (recentAdverse) {
      next.adverseImpulseBeforeTrigger = true;
      next.adverseImpulseDirection = direction === "up" ? "down" : "up";
      next.adverseImpulsePct = Math.abs(recentAdverse.snapshot.oneBarReturnPct);
    }

    if (direction === "up" && recentAdverse) {
      const adverse = recentAdverse.snapshot;
      const reclaim = reclaimsAdverseBody(adverse, snapshot, "up");
      const momentum = momentumReclaims(adverse, snapshot, "up");
      const noFurtherDownImpulse = snapshot.microBreakDirection !== "down" || snapshot.oneBarReturnPct > adverse.oneBarReturnPct;
      if (reclaim && momentum && noFurtherDownImpulse) {
        next.reclaimConfirmed = true;
        next.triggerDirection = "buy";
        next.directionMatchesMove = true;
        next.triggerDiagnosticOnly = true;
        next.liveEligibleTrigger = false;
        next.triggerConfirmationOffsetBars = recentAdverse.offsetBars;
        next.triggerTransition =
          adverse.microBreakDirection === "down" || adverse.impulseScore >= 0.75
            ? "bear_trap_reversal_up"
            : "failed_down_impulse_reclaim_up";
      }
    }

    if (direction === "down" && recentAdverse) {
      const adverse = recentAdverse.snapshot;
      const reclaim = reclaimsAdverseBody(adverse, snapshot, "down");
      const momentum = momentumReclaims(adverse, snapshot, "down");
      const noFurtherUpImpulse = snapshot.microBreakDirection !== "up" || snapshot.oneBarReturnPct < adverse.oneBarReturnPct;
      if (reclaim && momentum && noFurtherUpImpulse) {
        next.reclaimConfirmed = true;
        next.triggerDirection = "sell";
        next.directionMatchesMove = true;
        next.triggerDiagnosticOnly = true;
        next.liveEligibleTrigger = false;
        next.triggerConfirmationOffsetBars = recentAdverse.offsetBars;
        next.triggerTransition =
          adverse.microBreakDirection === "up" || adverse.impulseScore >= 0.75
            ? "bull_trap_reversal_down"
            : "failed_up_impulse_break_down";
      }
    }

    if (
      direction === "up" &&
      next.triggerTransition === "none" &&
      snapshot.contextCrashRecencyScore > 0.2 &&
      (snapshot.contextRecoveryFromLastCrashPct ?? 0) > 0 &&
      snapshot.contextRecoveryQualityScore >= (tMinus15?.recoveryQualityScore ?? snapshot.contextRecoveryQualityScore) - 0.02 &&
      (snapshot.candleDirection === "up" || snapshot.contextPriceVsEma20Pct >= 0 || snapshot.contextPriceVsEma50Pct >= 0)
    ) {
      next.triggerTransition = "post_crash_recovery_reclaim_up";
      next.triggerDirection = "buy";
      next.directionMatchesMove = true;
      next.triggerDiagnosticOnly = snapshot.offsetBars !== 0;
      next.liveEligibleTrigger = snapshot.offsetBars === 0;
      next.reclaimConfirmed = next.reclaimConfirmed || snapshot.closeLocationInRangePct >= 0.5;
    }

    return next;
  });
}

function maxFavourable(
  candles: CandleRow[],
  startIndex: number,
  endIndex: number,
  direction: "up" | "down" | "unknown",
  entryPrice: number,
) {
  let maxMove = 0;
  for (let i = startIndex; i <= endIndex; i++) {
    const candle = candles[i];
    if (!candle) continue;
    const favourable = direction === "up"
      ? signedMovePct(entryPrice, candle.high, direction)
      : signedMovePct(entryPrice, candle.low, direction);
    if (favourable > maxMove) maxMove = favourable;
  }
  return maxMove;
}

function maxAdverse(
  candles: CandleRow[],
  startIndex: number,
  endIndex: number,
  direction: "up" | "down" | "unknown",
  entryPrice: number,
) {
  let maxMove = 0;
  for (let i = startIndex; i <= endIndex; i++) {
    const candle = candles[i];
    if (!candle) continue;
    const adverse = direction === "up"
      ? adverseMovePct(entryPrice, candle.low, direction)
      : adverseMovePct(entryPrice, candle.high, direction);
    if (adverse > maxMove) maxMove = adverse;
  }
  return maxMove;
}

function firstExcursionStats(
  candles: CandleRow[],
  startIndex: number,
  endIndex: number,
  direction: "up" | "down" | "unknown",
  entryPrice: number,
) {
  let maxAdverseBeforeFavourable = 0;
  let maxFavourableBeforeAdverse = 0;
  let seenFavourable = false;
  let seenAdverse = false;
  for (let i = startIndex; i <= endIndex; i++) {
    const candle = candles[i];
    if (!candle) continue;
    const favourable = direction === "up"
      ? Math.max(0, signedMovePct(entryPrice, candle.high, direction))
      : Math.max(0, signedMovePct(entryPrice, candle.low, direction));
    const adverse = direction === "up"
      ? adverseMovePct(entryPrice, candle.low, direction)
      : adverseMovePct(entryPrice, candle.high, direction);
    if (!seenFavourable) {
      maxAdverseBeforeFavourable = Math.max(maxAdverseBeforeFavourable, adverse);
      if (favourable > 0) seenFavourable = true;
    }
    if (!seenAdverse) {
      maxFavourableBeforeAdverse = Math.max(maxFavourableBeforeAdverse, favourable);
      if (adverse > 0) seenAdverse = true;
    }
  }
  return {
    adverseFirstPct: maxAdverseBeforeFavourable,
    favourableFirstPct: maxFavourableBeforeAdverse,
  };
}

function barsToThreshold(
  candles: CandleRow[],
  startIndex: number,
  endIndex: number,
  entryPrice: number,
  direction: "up" | "down" | "unknown",
  threshold: number,
  favourable: boolean,
): number | null {
  for (let i = startIndex; i <= endIndex; i++) {
    const candle = candles[i];
    if (!candle) continue;
    const value = favourable
      ? direction === "up"
        ? Math.max(0, signedMovePct(entryPrice, candle.high, direction))
        : Math.max(0, signedMovePct(entryPrice, candle.low, direction))
      : direction === "up"
        ? adverseMovePct(entryPrice, candle.low, direction)
        : adverseMovePct(entryPrice, candle.high, direction);
    if (value >= threshold) return i - startIndex;
  }
  return null;
}

function computeDuringPhase(params: {
  move: DetectedMoveRow;
  candles: CandleRow[];
  startIndex: number;
  endIndex: number;
  diagnostics: Crash300MovePhaseIdentifierReport["diagnostics"];
}) {
  const referenceEntryPrice = params.candles[params.startIndex]?.close ?? params.move.startPrice;
  const movePctDecimal = Math.max(0, params.move.movePct / 100);
  const horizonSpecs: Array<number | "move_end"> = [...DURING_HORIZONS, "move_end"];
  const horizons = horizonSpecs.map((horizon) => {
    const targetIndex = horizon === "move_end"
      ? params.endIndex
      : Math.min(params.candles.length - 1, params.startIndex + horizon);
    if (horizon !== "move_end" && targetIndex !== params.startIndex + horizon) {
      params.diagnostics.truncatedDuringHorizons += 1;
    }
    const mfePct = maxFavourable(params.candles, params.startIndex, targetIndex, params.move.direction, referenceEntryPrice);
    const maePct = maxAdverse(params.candles, params.startIndex, targetIndex, params.move.direction, referenceEntryPrice);
    const endClose = params.candles[targetIndex]?.close ?? referenceEntryPrice;
    const netMovePct = signedMovePct(referenceEntryPrice, endClose, params.move.direction);
    const first = firstExcursionStats(params.candles, params.startIndex, targetIndex, params.move.direction, referenceEntryPrice);
    return {
      horizonBars: horizon,
      label: duringLabel(horizon),
      endTs: params.candles[targetIndex]?.closeTs ?? params.move.endTs,
      mfePct,
      maePct,
      netMovePct,
      adverseFirstPct: first.adverseFirstPct,
      favourableFirstPct: first.favourableFirstPct,
    } satisfies Crash300DuringHorizon;
  });

  const moveEndHorizon = horizons[horizons.length - 1]!;
  const favourablePath = horizons.map((horizon) => horizon.mfePct);
  const adversePath = horizons.map((horizon) => horizon.maePct);
  const barsToMfe25 = barsToThreshold(params.candles, params.startIndex, params.endIndex, referenceEntryPrice, params.move.direction, movePctDecimal * 0.25, true);
  const barsToMfe50 = barsToThreshold(params.candles, params.startIndex, params.endIndex, referenceEntryPrice, params.move.direction, movePctDecimal * 0.5, true);
  const barsToMfe75 = barsToThreshold(params.candles, params.startIndex, params.endIndex, referenceEntryPrice, params.move.direction, movePctDecimal * 0.75, true);
  const barsToMfe100 = barsToThreshold(params.candles, params.startIndex, params.endIndex, referenceEntryPrice, params.move.direction, movePctDecimal, true);
  const barsToMae25OfMove = barsToThreshold(params.candles, params.startIndex, params.endIndex, referenceEntryPrice, params.move.direction, movePctDecimal * 0.25, false);
  const barsToMae50OfMove = barsToThreshold(params.candles, params.startIndex, params.endIndex, referenceEntryPrice, params.move.direction, movePctDecimal * 0.5, false);

  let barsToMaxMfe: number | null = null;
  let barsToMaxMae: number | null = null;
  let maxMfe = -Infinity;
  let maxMae = -Infinity;
  for (let i = 0; i < horizons.length; i++) {
    if (horizons[i]!.mfePct > maxMfe) {
      maxMfe = horizons[i]!.mfePct;
      barsToMaxMfe = horizons[i]!.horizonBars === "move_end" ? params.endIndex - params.startIndex : Number(horizons[i]!.horizonBars);
    }
    if (horizons[i]!.maePct > maxMae) {
      maxMae = horizons[i]!.maePct;
      barsToMaxMae = horizons[i]!.horizonBars === "move_end" ? params.endIndex - params.startIndex : Number(horizons[i]!.horizonBars);
    }
  }

  const maxPullbackBeforeContinuationPct = Math.max(
    0,
    maxMfe - moveEndHorizon.netMovePct,
  );
  const pullbackAfterMfe25 = barsToMfe25 == null ? null : Math.max(0, maxMfe - (horizons.find((row) => row.horizonBars === 60)?.netMovePct ?? moveEndHorizon.netMovePct));
  const pullbackAfterMfe50 = barsToMfe50 == null ? null : Math.max(0, maxMfe - (horizons.find((row) => row.horizonBars === 120)?.netMovePct ?? moveEndHorizon.netMovePct));
  const pullbackAfterMfe75 = barsToMfe75 == null ? null : Math.max(0, maxMfe - moveEndHorizon.netMovePct);
  const continuationFailureBars = moveEndHorizon.netMovePct < maxMfe ? (params.endIndex - params.startIndex) - (barsToMaxMfe ?? 0) : null;
  const stallBars = horizons.filter((row) => row.netMovePct <= 0).length;
  const oppositeImpulseCount = horizons.filter((row) => row.adverseFirstPct > row.favourableFirstPct).length;
  const oppositeImpulseMaxPct = Math.max(...horizons.map((row) => row.adverseFirstPct), 0);
  const volatilityExpansionDuringMove = maxMfe > 0 && moveEndHorizon.maePct > 0 ? moveEndHorizon.maePct / maxMfe : moveEndHorizon.maePct;
  const trendPersistenceDuringMove = moveEndHorizon.netMovePct > 0 && maxMfe > 0 ? clamp01(moveEndHorizon.netMovePct / maxMfe) : 0;

  const trailingActivationCandidate = horizons.find((row) => row.mfePct > 0 && row.netMovePct < row.mfePct);
  const observedTrailingActivationPct = trailingActivationCandidate?.mfePct ?? null;
  const observedTrailingDistancePct = trailingActivationCandidate
    ? Math.max(0, trailingActivationCandidate.mfePct - trailingActivationCandidate.netMovePct)
    : null;
  const observedMinHoldBarsBeforeTrailing = trailingActivationCandidate
    ? trailingActivationCandidate.horizonBars === "move_end"
      ? params.endIndex - params.startIndex
      : Number(trailingActivationCandidate.horizonBars)
    : null;

  return {
    referenceEntryPrice,
    horizons,
    barsToMfe25,
    barsToMfe50,
    barsToMfe75,
    barsToMfe100,
    barsToMaxMfe,
    barsToMaxMae,
    barsToMae25OfMove,
    barsToMae50OfMove,
    pullbackAfterMfe25,
    pullbackAfterMfe50,
    pullbackAfterMfe75,
    maxPullbackBeforeContinuationPct,
    continuationFailureBars,
    stallBars,
    oppositeImpulseCount,
    oppositeImpulseMaxPct,
    volatilityExpansionDuringMove,
    trendPersistenceDuringMove,
    observedSafeInitialSlPct: Math.min(moveEndHorizon.maePct, percentile(adversePath, 0.25)),
    observedNormalMaePct: moveEndHorizon.maePct,
    observedP75MaePct: percentile(adversePath, 0.75),
    observedP90MaePct: percentile(adversePath, 0.9),
    observedTrailingActivationPct,
    observedTrailingDistancePct,
    observedMinHoldBarsBeforeTrailing,
    realisticTpPct: maxMfe,
    realisticTpPctP50: percentile(favourablePath, 0.5),
    realisticTpPctP75: percentile(favourablePath, 0.75),
    realisticTpPctP90: percentile(favourablePath, 0.9),
  } satisfies Crash300MovePhaseDuring;
}

function computeAfterPhase(params: {
  move: DetectedMoveRow;
  moves: DetectedMoveRow[];
  candles: CandleRow[];
  endIndex: number;
  diagnostics: Crash300MovePhaseIdentifierReport["diagnostics"];
}) {
  const endPrice = params.candles[params.endIndex]?.close ?? params.move.endPrice;
  const nextMove = resolveNextMove(params.move, params.moves);
  const horizons = AFTER_HORIZONS.map((horizon) => {
    const targetIndex = Math.min(params.candles.length - 1, params.endIndex + horizon);
    if (targetIndex !== params.endIndex + horizon) params.diagnostics.truncatedAfterHorizons += 1;
    const slice = params.candles.slice(params.endIndex, targetIndex + 1);
    let reversalPct = 0;
    let continuationPct = 0;
    if (params.move.direction === "up") {
      reversalPct = Math.max(0, ...slice.map((candle) => (endPrice - candle.low) / Math.max(endPrice, 1e-9)));
      continuationPct = Math.max(0, ...slice.map((candle) => (candle.high - endPrice) / Math.max(endPrice, 1e-9)));
    } else if (params.move.direction === "down") {
      reversalPct = Math.max(0, ...slice.map((candle) => (candle.high - endPrice) / Math.max(endPrice, 1e-9)));
      continuationPct = Math.max(0, ...slice.map((candle) => (endPrice - candle.low) / Math.max(endPrice, 1e-9)));
    }
    const endClose = params.candles[targetIndex]?.close ?? endPrice;
    const netMovePct = params.move.direction === "up"
      ? (endClose - endPrice) / Math.max(endPrice, 1e-9)
      : (endPrice - endClose) / Math.max(endPrice, 1e-9);
    return {
      horizonBars: horizon,
      label: afterLabel(horizon),
      endTs: params.candles[targetIndex]?.closeTs ?? params.move.endTs,
      reversalPctAfterMove: reversalPct,
      continuationPctAfterMove: continuationPct,
      netMovePct,
    } satisfies Crash300AfterHorizon;
  });

  const movePctDecimal = Math.max(0, params.move.movePct / 100);
  const barsToReversal25 = horizons.find((row) => row.reversalPctAfterMove >= movePctDecimal * 0.25)?.horizonBars ?? null;
  const barsToReversal50 = horizons.find((row) => row.reversalPctAfterMove >= movePctDecimal * 0.5)?.horizonBars ?? null;
  const reversalPctAfterMove = Math.max(...horizons.map((row) => row.reversalPctAfterMove), 0);
  const continuationPctAfterMove = Math.max(...horizons.map((row) => row.continuationPctAfterMove), 0);
  const postMoveVolatilityExpansion = Math.max(...horizons.map((row) => row.reversalPctAfterMove + row.continuationPctAfterMove), 0);
  const postMoveCompression = continuationPctAfterMove > 0 ? clamp01(1 - (postMoveVolatilityExpansion / continuationPctAfterMove)) : 0;
  const failedContinuationAfterMove = reversalPctAfterMove > continuationPctAfterMove;
  const longestHorizon = horizons[horizons.length - 1];
  if (!nextMove) params.diagnostics.movesWithoutNextMove += 1;
  return {
    horizons,
    reversalPctAfterMove,
    barsToReversal25: typeof barsToReversal25 === "number" ? barsToReversal25 : null,
    barsToReversal50: typeof barsToReversal50 === "number" ? barsToReversal50 : null,
    postMoveVolatilityExpansion,
    postMoveCompression,
    failedContinuationAfterMove,
    meanReversionSpeed: reversalPctAfterMove > 0 && barsToReversal25 ? reversalPctAfterMove / Math.max(1, barsToReversal25) : 0,
    nextMoveStartTs: nextMove?.startTs ?? null,
    barsUntilNextMove: nextMove ? Math.max(0, Math.round((nextMove.startTs - params.move.endTs) / 60)) : null,
    nextMoveDirection: nextMove?.direction ?? null,
    nextMovePct: nextMove?.movePct ?? null,
  } satisfies Crash300MovePhaseAfter;
}

function derivePhaseFamily(params: {
  move: DetectedMoveRow;
  before: Crash300MovePhaseBefore;
  trigger: Crash300MovePhaseTrigger;
  parityRuntimeFamily: string | null;
}): {
  family: Crash300PhaseDerivedFamily;
  source: "phase-derived" | "parity-only" | "unknown";
} {
  const startContext = params.before.snapshots[params.before.snapshots.length - 1];
  const transitions = params.trigger.snapshots.map((snapshot) => snapshot.triggerTransition);

  if (params.move.direction === "up") {
    if (transitions.includes("bear_trap_reversal_up") || transitions.includes("failed_down_impulse_reclaim_up")) {
      return { family: "bear_trap_reversal_up", source: "phase-derived" };
    }
    if (
      (startContext?.crashRecencyScore ?? 0) > 0.2 &&
      ((startContext?.recoveryFromLastCrashPct ?? 0) > 0 || (startContext?.recoveryQualityScore ?? 0) >= (startContext?.trendPersistenceScore ?? 0))
    ) {
      return { family: "post_crash_recovery_up", source: "phase-derived" };
    }
    if ((startContext?.trendPersistenceScore ?? 0) > 0.45 || params.move.leadInShape === "trending") {
      return { family: "drift_continuation_up", source: "phase-derived" };
    }
  }

  if (params.move.direction === "down") {
    if (transitions.includes("bull_trap_reversal_down") || transitions.includes("failed_up_impulse_break_down")) {
      return { family: "bull_trap_reversal_down", source: "phase-derived" };
    }
    if (
      transitions.includes("crash_continuation_down") ||
      ((startContext?.crashRecencyScore ?? 0) > 0.4 && (startContext?.compressionToExpansionScore ?? 0) > 0.45)
    ) {
      return { family: "crash_event_down", source: "phase-derived" };
    }
    if ((startContext?.recoveryQualityScore ?? 0) < Math.max(0.35, (startContext?.trendPersistenceScore ?? 0) - 0.05)) {
      return { family: "failed_recovery_short", source: "phase-derived" };
    }
  }

  const parityFamily = toRuntimeFamily(params.parityRuntimeFamily);
  if (parityFamily) {
    return { family: parityFamily, source: "parity-only" };
  }
  return { family: "unknown", source: "unknown" };
}

function deriveLabels(params: {
  move: DetectedMoveRow;
  before: Crash300MovePhaseBefore;
  trigger: Crash300MovePhaseTrigger;
  during: Crash300MovePhaseDuring;
  after: Crash300MovePhaseAfter;
  runtimeFamily: string | null;
}) {
  const startContext = params.before.snapshots[params.before.snapshots.length - 1];
  const earlyTrigger = params.trigger.snapshots.find((snapshot) => snapshot.offsetBars >= -1 && snapshot.offsetBars <= 1 && snapshot.triggerDirection !== "none") ?? null;
  const preMoveOpposite = params.trigger.snapshots.some((snapshot) =>
    snapshot.offsetBars < 0 &&
    snapshot.triggerDirection !== "none" &&
    snapshot.expectedTradeDirection !== null &&
    snapshot.triggerDirection !== snapshot.expectedTradeDirection,
  );
  return {
    hasCleanLeadIn: params.move.leadInShape === "compressing" || params.move.leadInShape === "ranging",
    hasCompressionBeforeMove: startContext ? startContext.compressionToExpansionScore >= startContext.rangeExpansionScore15 : false,
    hasFreshTriggerAtStart: Boolean(earlyTrigger),
    hasLateTriggerOnly: !earlyTrigger && (params.trigger.firstValidTriggerOffset ?? 99) > 0,
    hasWrongDirectionTriggerBeforeMove: preMoveOpposite,
    hasNormalAdverseExcursion: params.during.observedNormalMaePct <= params.during.realisticTpPctP50,
    hasExcessiveAdverseExcursion: params.during.observedNormalMaePct > params.during.realisticTpPct,
    hasEarlyMfe: params.during.barsToMfe50 != null && params.during.barsToMfe50 <= 30,
    hasDelayedMfe: params.during.barsToMfe50 != null && params.during.barsToMfe50 > 60,
    hasFastReversalAfterMove: params.after.barsToReversal25 != null && params.after.barsToReversal25 <= 30,
    likelyTrendContinuation: params.runtimeFamily === "drift_continuation_up",
    likelyPostCrashRecovery: params.runtimeFamily === "post_crash_recovery_up",
    likelyFailedRecoveryShort: params.runtimeFamily === "failed_recovery_short",
    likelyCrashContinuation: params.runtimeFamily === "crash_event_down",
  } satisfies Crash300DerivedLabels;
}

function eventualOutcome(after: Crash300MovePhaseAfter): string {
  if (after.nextMoveDirection === "up" || after.nextMoveDirection === "down") {
    return after.failedContinuationAfterMove
      ? `reversal_to_${after.nextMoveDirection}`
      : `continuation_to_${after.nextMoveDirection}`;
  }
  return after.failedContinuationAfterMove ? "failed_continuation_no_next_move" : "no_next_move_in_window";
}

function tradeOutcomeFromLinkage(linkage: Crash300TradeLinkage | null): string | null {
  if (!linkage || linkage.tradesLinkedToMove === 0) return null;
  if (linkage.tradeWins > 0 && linkage.tradeLosses === 0) return "all_wins";
  if (linkage.tradeLosses > 0 && linkage.tradeWins === 0) return "all_losses";
  return "mixed";
}

function buildTradeLinkage(
  moveId: number,
  backtestRunId: number | null,
  attributionReport: Awaited<ReturnType<typeof buildCrash300TradeOutcomeAttributionReport>> | null,
): Crash300TradeLinkage | null {
  if (!attributionReport) return null;
  const trades = attributionReport.trades.filter((trade) => Number(trade.matchedCalibratedMove?.moveId ?? NaN) === moveId);
  if (trades.length === 0) {
    return {
      backtestRunId,
      tradesLinkedToMove: 0,
      firstTradeEntryDelayMinutes: null,
      lastTradeEntryDelayMinutes: null,
      tradeDirections: [],
      tradeRuntimeFamilies: [],
      tradeSelectedBuckets: [],
      tradeWins: 0,
      tradeLosses: 0,
      duplicateTradeCount: 0,
      conflictingDirectionTradeCount: 0,
      classifications: [],
    };
  }
  const delays = trades.map((trade) => Number(trade.minutesFromMoveStartToEntry ?? 0)).filter((value) => Number.isFinite(value));
  const tradeDirections = Array.from(new Set(trades.map((trade) => trade.direction)));
  return {
    backtestRunId,
    tradesLinkedToMove: trades.length,
    firstTradeEntryDelayMinutes: delays.length > 0 ? Math.min(...delays) : null,
    lastTradeEntryDelayMinutes: delays.length > 0 ? Math.max(...delays) : null,
    tradeDirections,
    tradeRuntimeFamilies: Array.from(new Set(trades.map((trade) => trade.runtimeFamily ?? "unknown"))),
    tradeSelectedBuckets: Array.from(new Set(trades.map((trade) => trade.selectedBucket ?? "unknown"))),
    tradeWins: trades.filter((trade) => trade.pnlPct > 0).length,
    tradeLosses: trades.filter((trade) => trade.pnlPct <= 0).length,
    duplicateTradeCount: Math.max(0, trades.length - 1),
    conflictingDirectionTradeCount: trades.filter((trade) => !trade.tradeDirectionAlignedWithCalibratedMove).length,
    classifications: Array.from(new Set(trades.map((trade) => trade.outcomeClassification))),
  };
}

function aggregateByGroups(moves: Crash300MovePhaseIdentifiers[]) {
  const groupMap = new Map<string, Crash300MovePhaseIdentifiers[]>();
  const push = (key: string, move: Crash300MovePhaseIdentifiers) => {
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key)!.push(move);
  };

  for (const move of moves) {
    push(`direction:${move.direction}`, move);
    push(`moveType:${move.moveType}`, move);
    push(`runtimeFamily:${move.phaseDerivedFamily}`, move);
    push(`selectedBucket:${move.phaseDerivedBucket}`, move);
    push(`parityRuntimeFamily:${move.parityRuntimeFamily ?? "unknown"}`, move);
    push(`paritySelectedBucket:${move.paritySelectedBucket ?? "unknown"}`, move);
    push(`moveSizeBucket:${move.moveSizeBucket}`, move);
    push(`qualityTier:${move.qualityTier}`, move);
    push(`eventualOutcome:${move.eventualOutcome}`, move);
    push(`tradeBacktestOutcome:${move.tradeBacktestOutcome ?? "none"}`, move);
    push(`direction+moveSizeBucket:${move.direction}|${move.moveSizeBucket}`, move);
    push(`runtimeFamily+selectedBucket:${move.phaseDerivedFamily}|${move.phaseDerivedBucket}`, move);
    push(`runtimeFamily+moveSizeBucket:${move.phaseDerivedFamily}|${move.moveSizeBucket}`, move);
    push(`qualityTier+moveSizeBucket:${move.qualityTier}|${move.moveSizeBucket}`, move);
  }

  const aggregates: Record<string, unknown> = {};
  for (const [groupKey, entries] of groupMap.entries()) {
    const flattened: FlattenedMetricMap = {};
    const transitionByOffset: Record<string, Record<string, number>> = {};
    const directionByOffset: Record<string, Record<string, number>> = {};
    const strongestTriggerOffsetDistribution: Record<string, number> = {};
    const firstValidTriggerOffsetDistribution: Record<string, number> = {};

    for (const move of entries) {
      flattenNumericValues({
        movePct: move.movePct,
        before: move.before,
        trigger: {
          strongestTriggerOffset: move.trigger.strongestTriggerOffset,
          strongestTriggerStrength: move.trigger.strongestTriggerStrength,
          strongestTriggerTransition: move.trigger.strongestTriggerTransition,
          firstValidTriggerOffset: move.trigger.firstValidTriggerOffset,
          firstValidTriggerTransition: move.trigger.firstValidTriggerTransition,
          snapshots: move.trigger.snapshots,
        },
        during: move.during,
        after: move.after,
        backtestLinkage: move.backtestLinkage ?? {},
      }, "", flattened);

      for (const snapshot of move.trigger.snapshots) {
        const offsetKey = triggerOffsetLabel(snapshot.offsetBars);
        transitionByOffset[offsetKey] ??= {};
        directionByOffset[offsetKey] ??= {};
        transitionByOffset[offsetKey]![snapshot.triggerTransition] = (transitionByOffset[offsetKey]![snapshot.triggerTransition] ?? 0) + 1;
        directionByOffset[offsetKey]![snapshot.triggerDirection] = (directionByOffset[offsetKey]![snapshot.triggerDirection] ?? 0) + 1;
      }
      const strongestKey = move.trigger.strongestTriggerOffset == null ? "none" : triggerOffsetLabel(move.trigger.strongestTriggerOffset);
      strongestTriggerOffsetDistribution[strongestKey] = (strongestTriggerOffsetDistribution[strongestKey] ?? 0) + 1;
      const firstKey = move.trigger.firstValidTriggerOffset == null ? "none" : triggerOffsetLabel(move.trigger.firstValidTriggerOffset);
      firstValidTriggerOffsetDistribution[firstKey] = (firstValidTriggerOffsetDistribution[firstKey] ?? 0) + 1;
    }

    const metrics: Record<string, unknown> = {};
    for (const [metricKey, values] of Object.entries(flattened)) {
      metrics[metricKey] = summarizeStats(values);
    }

    aggregates[groupKey] = {
      count: entries.length,
      metrics,
      triggerTransitions: transitionByOffset,
      triggerDirections: directionByOffset,
      strongestTriggerOffsetDistribution,
      firstValidTriggerOffsetDistribution,
    };
  }

  return { groupMap, aggregates };
}

function buildSeparationDiagnostics(groupMap: Map<string, Crash300MovePhaseIdentifiers[]>) {
  const computeTopDiffs = (prefix: string) => {
    const relevant = [...groupMap.entries()].filter(([key]) => key.startsWith(prefix));
    const metricGroups = new Map<string, Array<{ label: string; value: number }>>();
    for (const [key, entries] of relevant) {
      const flattened: FlattenedMetricMap = {};
      for (const entry of entries) {
        flattenNumericValues({
          movePct: entry.movePct,
          before: entry.before,
          trigger: entry.trigger,
          during: entry.during,
          after: entry.after,
          backtestLinkage: entry.backtestLinkage ?? {},
        }, "", flattened);
      }
      for (const [metric, values] of Object.entries(flattened)) {
        metricGroups.set(metric, [
          ...(metricGroups.get(metric) ?? []),
          { label: key, value: summarizeStats(values).median },
        ]);
      }
    }
    return [...metricGroups.entries()]
      .map(([metric, groups]) => ({
        metric,
        diffScore: metricDiffScore(groups),
        groups,
      }))
      .sort((a, b) => b.diffScore - a.diffScore)
      .slice(0, 12);
  };

  return {
    direction: computeTopDiffs("direction:"),
    moveSizeBucket: computeTopDiffs("moveSizeBucket:"),
    qualityTier: computeTopDiffs("qualityTier:"),
    runtimeFamily: computeTopDiffs("runtimeFamily:"),
    tradeBacktestOutcome: computeTopDiffs("tradeBacktestOutcome:"),
  };
}

function buildTriggerDiagnostics(rows: Crash300MovePhaseIdentifiers[]) {
  const transitionByOffset: Record<string, Record<string, number>> = {};
  const strongestTriggerOffset: Record<string, number> = {};
  const firstValidTriggerOffset: Record<string, number> = {};
  const phaseDerivedFamily: Record<string, number> = {};
  const phaseDerivedBucket: Record<string, number> = {};
  const liveEligibleTrigger: Record<string, number> = { true: 0, false: 0 };
  const diagnosticOnlyTrigger: Record<string, number> = { true: 0, false: 0 };
  const triggerDirectionVsMoveDirection: Record<string, number> = {};
  const parityRuntimeFamilyVsPhaseDerivedFamily: Record<string, number> = {};
  const paritySelectedBucketVsPhaseDerivedBucket: Record<string, number> = {};
  let adverseImpulseBeforeTrigger = 0;
  let reclaimConfirmed = 0;
  let movesWithNoTrigger = 0;
  let movesWithOnlyDiagnosticDelayedTrigger = 0;
  let movesWithAdverseImpulseBeforeCorrectMove = 0;
  let movesWhereParityFamilyDisagrees = 0;
  let movesWhereBucketWasUnknown = 0;

  for (const move of rows) {
    phaseDerivedFamily[move.phaseDerivedFamily] = (phaseDerivedFamily[move.phaseDerivedFamily] ?? 0) + 1;
    phaseDerivedBucket[move.phaseDerivedBucket] = (phaseDerivedBucket[move.phaseDerivedBucket] ?? 0) + 1;
    const parityFamilyKey = `${move.parityRuntimeFamily ?? "unknown"}->${move.phaseDerivedFamily}`;
    parityRuntimeFamilyVsPhaseDerivedFamily[parityFamilyKey] = (parityRuntimeFamilyVsPhaseDerivedFamily[parityFamilyKey] ?? 0) + 1;
    const parityBucketKey = `${move.paritySelectedBucket ?? "unknown"}->${move.phaseDerivedBucket}`;
    paritySelectedBucketVsPhaseDerivedBucket[parityBucketKey] = (paritySelectedBucketVsPhaseDerivedBucket[parityBucketKey] ?? 0) + 1;
    if (move.parityFamilyDisagreesWithPhaseFamily) movesWhereParityFamilyDisagrees += 1;
    if (move.parityBucketMissing) movesWhereBucketWasUnknown += 1;

    const hasAnyTrigger = move.trigger.snapshots.some((snapshot) => snapshot.triggerDirection !== "none");
    const hasLiveEligible = move.trigger.snapshots.some((snapshot) => snapshot.liveEligibleTrigger);
    const hasDiagnosticOnly = move.trigger.snapshots.some((snapshot) => snapshot.triggerDiagnosticOnly);
    liveEligibleTrigger[String(hasLiveEligible) as "true" | "false"] += 1;
    diagnosticOnlyTrigger[String(hasDiagnosticOnly) as "true" | "false"] += 1;
    if (!hasAnyTrigger) movesWithNoTrigger += 1;
    if (hasAnyTrigger && !hasLiveEligible && hasDiagnosticOnly) movesWithOnlyDiagnosticDelayedTrigger += 1;

    const firstTrigger = move.trigger.snapshots.find((snapshot) => snapshot.triggerDirection !== "none") ?? null;
    const directionKey = `${move.direction}->${firstTrigger?.triggerDirection ?? "none"}`;
    triggerDirectionVsMoveDirection[directionKey] = (triggerDirectionVsMoveDirection[directionKey] ?? 0) + 1;

    const strongestKey = move.trigger.strongestTriggerOffset == null ? "none" : triggerOffsetLabel(move.trigger.strongestTriggerOffset);
    strongestTriggerOffset[strongestKey] = (strongestTriggerOffset[strongestKey] ?? 0) + 1;
    const firstKey = move.trigger.firstValidTriggerOffset == null ? "none" : triggerOffsetLabel(move.trigger.firstValidTriggerOffset);
    firstValidTriggerOffset[firstKey] = (firstValidTriggerOffset[firstKey] ?? 0) + 1;

    let moveHasAdverseImpulseBeforeTrigger = false;
    for (const snapshot of move.trigger.snapshots) {
      const offsetKey = triggerOffsetLabel(snapshot.offsetBars);
      transitionByOffset[offsetKey] ??= {};
      transitionByOffset[offsetKey]![snapshot.triggerTransition] = (transitionByOffset[offsetKey]![snapshot.triggerTransition] ?? 0) + 1;
      if (snapshot.adverseImpulseBeforeTrigger) {
        adverseImpulseBeforeTrigger += 1;
        moveHasAdverseImpulseBeforeTrigger = true;
      }
      if (snapshot.reclaimConfirmed) reclaimConfirmed += 1;
    }
    if (moveHasAdverseImpulseBeforeTrigger && firstTrigger && firstTrigger.directionMatchesMove) {
      movesWithAdverseImpulseBeforeCorrectMove += 1;
    }
  }

  return {
    countByTriggerTransitionAtOffset: transitionByOffset,
    countByPhaseDerivedFamily: phaseDerivedFamily,
    countByPhaseDerivedBucket: phaseDerivedBucket,
    countByStrongestTriggerOffset: strongestTriggerOffset,
    countByFirstValidTriggerOffset: firstValidTriggerOffset,
    countByLiveEligibleTrigger: liveEligibleTrigger,
    countByDiagnosticOnlyTrigger: diagnosticOnlyTrigger,
    countOfAdverseImpulseBeforeTrigger: adverseImpulseBeforeTrigger,
    countOfReclaimConfirmed: reclaimConfirmed,
    triggerDirectionVsMoveDirection,
    parityRuntimeFamilyVsPhaseDerivedFamily,
    paritySelectedBucketVsPhaseDerivedBucket,
    movesWithNoTrigger,
    movesWithOnlyDiagnosticDelayedTrigger,
    movesWithAdverseImpulseBeforeCorrectMove,
    movesWhereParityFamilyDisagrees,
    movesWhereBucketWasUnknown,
  };
}

export async function buildCrash300PhaseIdentifierReport(params: {
  startTs?: number | null;
  endTs?: number | null;
  limit?: number | null;
  includeMoves?: boolean;
  includeAggregates?: boolean;
}) : Promise<Crash300MovePhaseIdentifierReport> {
  const window = await resolveWindow({ startTs: params.startTs, endTs: params.endTs });
  const envelope = await loadCrash300RuntimeEnvelope();
  if (!envelope.promotedModel) {
    throw new Error("CRASH300 runtime model missing/invalid. Cannot evaluate symbol service.");
  }

  const diagnostics: Crash300MovePhaseIdentifierReport["diagnostics"] = {
    missingPromotedModel: false,
    candleRangeStartTs: null,
    candleRangeEndTs: null,
    truncatedBeforeSnapshots: 0,
    truncatedTriggerSnapshots: 0,
    truncatedDuringHorizons: 0,
    truncatedAfterHorizons: 0,
    movesWithoutNextMove: 0,
    linkedBacktestRunId: null,
    move11419Summary: null,
  };

  const moves = await loadDetectedMoves(window, params.limit ?? undefined);
  const candles = await loadCandles(window, moves);
  diagnostics.candleRangeStartTs = candles[0]?.openTs ?? null;
  diagnostics.candleRangeEndTs = candles[candles.length - 1]?.closeTs ?? null;

  const parity = await runCrash300CalibrationParity({ startTs: window.startTs, endTs: window.endTs, mode: "parity" });
  const parityByMoveId = buildParityMap(parity.verdicts);
  const backtest = await loadLatestBacktestAttribution(window);
  diagnostics.linkedBacktestRunId = backtest?.runId ?? null;

  const rows = moves.map((move) => {
    const startIndex = pickCandleIndexAtOrAfter(candles, move.startTs);
    const endIndex = pickCandleIndexAtOrAfter(candles, move.endTs);
    const before = {
      snapshots: computeBeforeSnapshots({
        move,
        moves,
        candles,
        runtimeModel: envelope.promotedModel!,
        startIndex,
        diagnostics,
      }),
    } satisfies Crash300MovePhaseBefore;
    const trigger = (() => {
      const rawSnapshots = computeTriggerSnapshots({
        move,
        moves,
        candles,
        runtimeModel: envelope.promotedModel!,
        startIndex,
        diagnostics,
      });
      const snapshots = enrichDiagnosticTriggers({
        move,
        beforeSnapshots: before.snapshots,
        snapshots: rawSnapshots,
      });
      const strongest = [...snapshots].sort((a, b) => b.triggerStrengthScore - a.triggerStrengthScore)[0] ?? null;
      const firstValid = snapshots.find((snapshot) =>
        snapshot.triggerDirection !== "none" &&
        snapshot.directionMatchesMove &&
        snapshot.triggerStrengthScore > 0,
      ) ?? null;
      return {
        snapshots,
        strongestTriggerOffset: strongest?.offsetBars ?? null,
        strongestTriggerDirection: strongest?.triggerDirection ?? "none",
        strongestTriggerStrength: strongest?.triggerStrengthScore ?? 0,
        strongestTriggerTransition: strongest?.triggerTransition ?? "none",
        firstValidTriggerOffset: firstValid?.offsetBars ?? null,
        firstValidTriggerDirection: firstValid?.triggerDirection ?? "none",
        firstValidTriggerTransition: firstValid?.triggerTransition ?? "none",
      } satisfies Crash300MovePhaseTrigger;
    })();
    const during = computeDuringPhase({
      move,
      candles,
      startIndex,
      endIndex,
      diagnostics,
    });
    const after = computeAfterPhase({
      move,
      moves,
      candles,
      endIndex,
      diagnostics,
    });
    const parityVerdict = parityByMoveId.get(move.id) ?? null;
    const parityRuntimeFamily = parityVerdict?.runtimeFamily ?? parityVerdict?.selectedRuntimeFamily ?? null;
    const familyDerivation = derivePhaseFamily({
      move,
      before,
      trigger,
      parityRuntimeFamily,
    });
    const phaseDerivedBucket = buildPhaseDerivedBucket({
      moveDirection: move.direction,
      family: familyDerivation.family,
      trigger,
      moveSizeBucket: moveSizeBucket(move.movePct),
    });
    const linkage = buildTradeLinkage(move.id, backtest?.runId ?? null, backtest?.report ?? null);
    const derived = deriveLabels({
      move,
      before,
      trigger,
      during,
      after,
      runtimeFamily: familyDerivation.family,
    });
    const row = {
      moveId: move.id,
      symbol: move.symbol,
      startTs: move.startTs,
      endTs: move.endTs,
      direction: move.direction,
      moveType: move.moveType,
      movePct: move.movePct,
      moveSizeBucket: moveSizeBucket(move.movePct),
      qualityTier: move.qualityTier,
      runtimeFamily: familyDerivation.family,
      selectedBucket: phaseDerivedBucket,
      parityRuntimeFamily,
      phaseDerivedFamily: familyDerivation.family,
      familySource: familyDerivation.source,
      parityFamilyDisagreesWithPhaseFamily: Boolean(parityRuntimeFamily) && familyDerivation.family !== "unknown" && parityRuntimeFamily !== familyDerivation.family,
      paritySelectedBucket: parityVerdict?.selectedBucket ?? null,
      phaseDerivedBucket,
      bucketSource: "phase-derived",
      parityBucketMissing: parityBucketMissing(parityVerdict?.selectedBucket ?? null),
      before,
      trigger,
      during,
      after,
      derivedLabels: derived,
      eventualOutcome: eventualOutcome(after),
      tradeBacktestOutcome: tradeOutcomeFromLinkage(linkage),
      parity: parityVerdict ? {
        candidateProduced: parityVerdict.candidateProduced,
        expectedTradeDirection: parityVerdict.expectedTradeDirection ?? null,
        actualCandidateDirection: parityVerdict.actualCandidateDirection ?? null,
        familyCompatible: parityVerdict.familyCompatible ?? null,
        directionCompatible: parityVerdict.directionCompatible ?? null,
        matchReason: parityVerdict.matchReason ?? null,
        mismatchReason: parityVerdict.mismatchReason ?? null,
      } : null,
      backtestLinkage: linkage,
    } satisfies Crash300MovePhaseIdentifiers;
    if (move.id === 11419) {
      diagnostics.move11419Summary = {
        triggerFound: trigger.snapshots.some((snapshot) => snapshot.triggerDirection !== "none"),
        phaseDerivedFamily: row.phaseDerivedFamily,
        phaseDerivedBucket: row.phaseDerivedBucket,
        strongestTriggerOffset: trigger.strongestTriggerOffset,
        strongestTriggerTransition: trigger.strongestTriggerTransition,
      };
    }
    return row;
  });

  const { groupMap, aggregates } = aggregateByGroups(rows);
  const triggerDiagnostics = buildTriggerDiagnostics(rows);
  const out: Crash300MovePhaseIdentifierReport = {
    symbol: SYMBOL,
    generatedAt: new Date().toISOString(),
    source: backtest
      ? "detected_moves+m1_candles+parity+latest_backtest_attribution"
      : "detected_moves+m1_candles+parity",
    window,
    promotedModelRunId: envelope.promotedModel.sourceRunId ?? null,
    detectedMoveCount: rows.length,
    moves: params.includeMoves === false ? [] : rows,
    aggregates: params.includeAggregates === false
      ? {}
        : {
          ...aggregates,
          distributions: {
            rawDetectedMoveFamily: Object.fromEntries(Object.entries(groupMap).filter(([key]) => key.startsWith("moveType:")).map(([key, value]) => [key.replace("moveType:", ""), value.length])),
            runtimeFamily: Object.fromEntries(Object.entries(groupMap).filter(([key]) => key.startsWith("runtimeFamily:")).map(([key, value]) => [key.replace("runtimeFamily:", ""), value.length])),
            parityRuntimeFamily: Object.fromEntries(Object.entries(groupMap).filter(([key]) => key.startsWith("parityRuntimeFamily:")).map(([key, value]) => [key.replace("parityRuntimeFamily:", ""), value.length])),
            phaseDerivedBucket: Object.fromEntries(Object.entries(groupMap).filter(([key]) => key.startsWith("selectedBucket:")).map(([key, value]) => [key.replace("selectedBucket:", ""), value.length])),
            paritySelectedBucket: Object.fromEntries(Object.entries(groupMap).filter(([key]) => key.startsWith("paritySelectedBucket:")).map(([key, value]) => [key.replace("paritySelectedBucket:", ""), value.length])),
            moveSizeBucket: Object.fromEntries(Object.entries(groupMap).filter(([key]) => key.startsWith("moveSizeBucket:")).map(([key, value]) => [key.replace("moveSizeBucket:", ""), value.length])),
            qualityTier: Object.fromEntries(Object.entries(groupMap).filter(([key]) => key.startsWith("qualityTier:")).map(([key, value]) => [key.replace("qualityTier:", ""), value.length])),
          },
          triggerDiagnostics,
          separationDiagnostics: buildSeparationDiagnostics(groupMap),
        },
    diagnostics,
  };

  return out;
}
