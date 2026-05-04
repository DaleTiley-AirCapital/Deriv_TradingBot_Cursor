import { and, asc, between, desc, eq, gte, lte } from "drizzle-orm";
import {
  db,
  candlesTable,
  calibrationPassRunsTable,
  detectedMovesTable,
} from "@workspace/db";
import { sql } from "drizzle-orm";
import type { CandleRow } from "../backtest/featureSlice.js";
import { buildCrash300CalibrationReconciliationReport } from "../backtest/calibrationReconciliation.js";
import { loadCrash300RuntimeEnvelope } from "../../symbol-services/CRASH300/model.js";
import { buildCrash300PhaseIdentifierReport } from "../../symbol-services/CRASH300/phaseIdentifiers.js";
import { buildCrash300ContextSnapshot } from "../../symbol-services/CRASH300/context.js";
import { buildCrash300TriggerSnapshot } from "../../symbol-services/CRASH300/trigger.js";
import { detectCrash300TriggerTransition } from "../../symbol-services/CRASH300/triggerSemantics.js";
import { deriveCrash300RuntimeFamilyWithSemantics } from "../../symbol-services/CRASH300/familySemantics.js";
import { deriveCrash300RuntimeBucket } from "../../symbol-services/CRASH300/bucketSemantics.js";
import type { Crash300MoveSizeBucket } from "../../symbol-services/CRASH300/features.js";
import type { PromotedSymbolRuntimeModel } from "../calibration/promotedSymbolModel.js";
import type {
  PolicyEvaluationResult,
  SynthesisRebuiltTriggerCandidateRecord,
  SymbolSynthesisAdapter,
  SynthesisControlRecord,
  SynthesisMoveRecord,
  SynthesisTradeRecord,
  UnifiedSynthesisDataset,
} from "./adapter.js";
import type {
  EliteSynthesisDataAvailability,
  EliteSynthesisDataAvailabilityMetric,
  EliteSynthesisExitRules,
  EliteSynthesisFeatureSummary,
  EliteSynthesisParams,
  EliteSynthesisPolicyArtifact,
  EliteSynthesisStage,
  EliteSynthesisUnitValidation,
  EliteSynthesisValidationError,
} from "./types.js";

const SYMBOL = "CRASH300";
const MAX_CONTROL_SAMPLES = 60;
const LOOP_YIELD_INTERVAL = 24;

type DatasetBuildProgress = {
  stage: EliteSynthesisStage;
  progressPct: number;
  message: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function optionalNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function inferPercentUnit(values: Array<number | null | undefined>): "percentage_points" | "fraction" | "mixed" {
  const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (finite.length === 0) return "percentage_points";
  const small = finite.filter((value) => Math.abs(value) <= 1.2).length;
  const large = finite.filter((value) => Math.abs(value) > 1.2).length;
  if (small === finite.length) return "fraction";
  if (large === finite.length) return "percentage_points";
  return "mixed";
}

function toPercentagePoints(value: number | null | undefined, unit: "percentage_points" | "fraction" | "mixed"): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (unit === "fraction") return value * 100;
  if (unit === "mixed") return Math.abs(value) <= 1.2 ? value * 100 : value;
  return value;
}

function metricFromPresence(total: number, present: number, nullableAllowed: boolean, notes: string[] = []): EliteSynthesisDataAvailabilityMetric {
  const safeTotal = Math.max(total, 0);
  const safePresent = Math.max(0, Math.min(safeTotal, present));
  const missing = Math.max(0, safeTotal - safePresent);
  return {
    total: safeTotal,
    present: safePresent,
    missing,
    missingRate: safeTotal > 0 ? Number((missing / safeTotal).toFixed(4)) : 1,
    nullableAllowed,
    notes,
  };
}

function rangeOf(values: Array<number | null | undefined>) {
  const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (finite.length === 0) return { min: null, max: null };
  return { min: Math.min(...finite), max: Math.max(...finite) };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p)));
  return sorted[idx] ?? 0;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function yieldToEventLoop() {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function objectiveFromMetrics(params: {
  winRate: number;
  slHitRate: number;
  profitFactor: number;
  tradeCount: number;
  targetTradeCountMin: number;
  targetTradeCountMax: number;
  preferredTradeCount: number;
  maxDrawdownPct: number;
  phantomCount: number;
}): number {
  const tradeCountPenalty =
    params.tradeCount < params.targetTradeCountMin
      ? (params.targetTradeCountMin - params.tradeCount) * 0.6
      : params.tradeCount > params.targetTradeCountMax
        ? (params.tradeCount - params.targetTradeCountMax) * 0.25
        : Math.abs(params.tradeCount - params.preferredTradeCount) * 0.1;
  return (
    params.winRate * 100
    - params.slHitRate * 80
    + Math.min(params.profitFactor, 6) * 12
    - params.maxDrawdownPct * 1.5
    - params.phantomCount * 1.25
    - tradeCountPenalty
  );
}

function bucketLabelFromPct(movePct: number): Crash300MoveSizeBucket {
  const pct = Math.abs(movePct * 100);
  if (!Number.isFinite(pct) || pct <= 0) return "5_to_6_pct";
  if (pct >= 10) return "10_plus_pct";
  const lower = Math.max(5, Math.floor(pct));
  if (lower <= 5) return "5_to_6_pct";
  if (lower <= 6) return "6_to_8_pct";
  if (lower <= 8) return "8_to_10_pct";
  return "10_plus_pct";
}

function inferMoveDirection(value: unknown): "up" | "down" {
  return String(value).toLowerCase() === "down" ? "down" : "up";
}

function toCandleRow(row: { open: number; high: number; low: number; close: number; openTs: number; closeTs: number }): CandleRow {
  return {
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    openTs: Number(row.openTs),
    closeTs: Number(row.closeTs),
  };
}

function buildFeatureVectorFromContextTrigger(params: {
  candles: CandleRow[];
  ts: number;
  runtimeModel: PromotedSymbolRuntimeModel;
  detectedMoves: Array<{ id: number; startTs: number; endTs: number; direction: "up" | "down"; movePct: number }>;
}) {
  const { snapshot: contextSnapshot } = buildCrash300ContextSnapshot({
    symbol: SYMBOL,
    ts: params.ts,
    candles: params.candles,
    runtimeModel: params.runtimeModel,
    detectedMoves: params.detectedMoves,
  });
  const triggerSnapshot = buildCrash300TriggerSnapshot({
    symbol: SYMBOL,
    ts: params.ts,
    candles: params.candles,
    context: contextSnapshot,
  });
  const semanticTrigger = detectCrash300TriggerTransition({
    context: contextSnapshot,
    trigger: triggerSnapshot,
    priorTriggers: [],
    mode: "diagnostic",
    offsetBars: 0,
  });
  const family = deriveCrash300RuntimeFamilyWithSemantics({
    context: contextSnapshot,
    trigger: semanticTrigger,
    moveDirection: "unknown",
  });
  const bucket = deriveCrash300RuntimeBucket({
    family: family.familyFinal,
    trigger: semanticTrigger,
    moveSizeBucket: bucketLabelFromPct((contextSnapshot.recoveryFromLastCrashPct ?? 0) * 100),
  });
  return {
    contextSnapshot,
    triggerSnapshot: semanticTrigger,
    runtimeFamily: family.familyFinal,
    selectedBucket: bucket,
    liveSafeFeatures: {
      runtimeFamily: family.familyFinal,
      selectedBucket: bucket,
      triggerTransition: semanticTrigger.triggerTransition,
      triggerDirection: semanticTrigger.triggerDirection,
      triggerStrengthScore: semanticTrigger.triggerStrengthScore,
      oneBarReturnPct: semanticTrigger.oneBarReturnPct,
      threeBarReturnPct: semanticTrigger.threeBarReturnPct,
      fiveBarReturnPct: semanticTrigger.fiveBarReturnPct,
      impulseScore: semanticTrigger.impulseScore,
      rejectionScore: semanticTrigger.rejectionScore,
      closeLocationInRangePct: semanticTrigger.closeLocationInRangePct,
      microBreakDirection: semanticTrigger.microBreakDirection,
      microBreakStrengthPct: semanticTrigger.microBreakStrengthPct,
      reclaimConfirmed: Boolean(((semanticTrigger as unknown as Record<string, unknown>).reclaimConfirmed) ?? false),
      adverseImpulseBeforeTrigger: Boolean(((semanticTrigger as unknown as Record<string, unknown>).adverseImpulseBeforeTrigger) ?? false),
      projectedMovePct: contextSnapshot.recoveryFromLastCrashPct,
      trendPersistenceScore: contextSnapshot.trendPersistenceScore,
      driftPersistence60: contextSnapshot.driftPersistence60,
      driftPersistence240: contextSnapshot.driftPersistence240,
      positiveCloseRatio60: contextSnapshot.positiveCloseRatio60,
      positiveCloseRatio240: contextSnapshot.positiveCloseRatio240,
      recoveryQualityScore: contextSnapshot.recoveryQualityScore,
      recoverySlope60: contextSnapshot.recoverySlope60,
      recoverySlope240: contextSnapshot.recoverySlope240,
      crashRecencyScore: contextSnapshot.crashRecencyScore,
      barsSinceLastCrash: contextSnapshot.barsSinceLastCrash,
      recoveryFromLastCrashPct: contextSnapshot.recoveryFromLastCrashPct,
      priceDistanceFromLastCrashLowPct: contextSnapshot.priceDistanceFromLastCrashLowPct,
      rangeCompressionScore60: contextSnapshot.rangeCompressionScore60,
      rangeCompressionScore240: contextSnapshot.rangeCompressionScore240,
      rangeExpansionScore15: contextSnapshot.rangeExpansionScore15,
      rangeExpansionScore60: contextSnapshot.rangeExpansionScore60,
      compressionToExpansionScore: contextSnapshot.compressionToExpansionScore,
      atrRank60: contextSnapshot.atrRank60,
      atrRank240: contextSnapshot.atrRank240,
      bbWidthRank60: contextSnapshot.bbWidthRank60,
      bbWidthRank240: contextSnapshot.bbWidthRank240,
      priceVsEma20Pct: contextSnapshot.priceVsEma20Pct,
      priceVsEma50Pct: contextSnapshot.priceVsEma50Pct,
      priceVsEma200Pct: contextSnapshot.priceVsEma200Pct,
    } as Record<string, number | string | boolean | null>,
  };
}

async function loadWindowCandles(startTs: number, endTs: number): Promise<CandleRow[]> {
  const rows = await db
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
      gte(candlesTable.openTs, startTs),
      lte(candlesTable.closeTs, endTs),
    ))
    .orderBy(asc(candlesTable.openTs));
  return rows.map(toCandleRow);
}

function normalizePersistedTrade(trade: Record<string, unknown>) {
  const runtimeEvidence = optionalNumber(trade.runtimeEvidence ?? trade.nativeScore);
  const modelSource = optionalString(trade.modelSource ?? trade.scoringSource);
  return {
    ...trade,
    runtimeEvidence,
    modelSource,
    triggerTransition: optionalString(trade.triggerTransition ?? trade.selectedTriggerTransition),
  };
}

function normalizePersistedBacktestResult(result: Record<string, unknown>) {
  const trades = Array.isArray(result.trades)
    ? result.trades.map((trade) => normalizePersistedTrade(asRecord(trade)))
    : [];
  const runtimeModel = asRecord(result.runtimeModel);
  const summary = asRecord(result.summary);
  return {
    ...result,
    runtimeModel: {
      ...runtimeModel,
      modelSourceCounts: asRecord(runtimeModel.modelSourceCounts),
    },
    summary: {
      ...summary,
      decisionGate: "runtime-platform-state",
    },
    trades,
  };
}

async function loadPersistedBacktestRun(runId: number | null) {
  const baseSql = runId == null
    ? sql`SELECT id, result, created_at FROM v3_backtest_runs WHERE symbol = ${SYMBOL} ORDER BY created_at DESC LIMIT 1`
    : sql`SELECT id, result, created_at FROM v3_backtest_runs WHERE id = ${runId} AND symbol = ${SYMBOL} LIMIT 1`;
  const result = await db.execute(baseSql);
  const row = result.rows?.[0] as Record<string, unknown> | undefined;
  if (!row) {
    throw new Error("CRASH300 elite synthesis requires a persisted CRASH300 backtest run.");
  }
  return {
    id: Number(row.id ?? 0),
    createdAt: row.created_at == null ? null : String(row.created_at),
    result: normalizePersistedBacktestResult(asRecord(row.result)),
  };
}

async function emitDatasetBuildProgress(
  cb: ((update: DatasetBuildProgress) => Promise<void> | void) | undefined,
  update: DatasetBuildProgress,
) {
  if (!cb) return;
  await cb(update);
}

async function buildPhaseReport(params: { startTs: number; endTs: number }) {
  return buildCrash300PhaseIdentifierReport({
    startTs: params.startTs,
    endTs: params.endTs,
    includeMoves: true,
    includeAggregates: true,
  });
}

async function mapMovesToSynthesisRecords(params: {
  rows: Array<Record<string, unknown>>;
  runtimeModel: PromotedSymbolRuntimeModel;
  candles: CandleRow[];
  phaseMoves: Array<Record<string, unknown>>;
  onProgress?: (update: DatasetBuildProgress) => Promise<void> | void;
}): Promise<SynthesisMoveRecord[]> {
  const { rows, runtimeModel, candles, phaseMoves, onProgress } = params;
  const candleByCloseTs = new Map<number, number>();
  candles.forEach((candle, index) => candleByCloseTs.set(candle.closeTs, index));
  const phaseByMoveId = new Map<number, Record<string, unknown>>(
    phaseMoves.map((row) => [Number(row.moveId ?? 0), row]),
  );
  const detectedMoves = rows.map((row) => ({
    id: Number(row.id ?? 0),
    startTs: Number(row.startTs ?? 0),
    endTs: Number(row.endTs ?? 0),
    direction: inferMoveDirection(row.direction),
    movePct: Number(row.movePct ?? 0),
  }));

  const mapped: SynthesisMoveRecord[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const move = rows[index] ?? {};
    const phase = phaseByMoveId.get(Number(move.id ?? 0)) ?? {};
    const startIndex = candleByCloseTs.get(Number(move.startTs ?? 0)) ?? candleByCloseTs.get(Number(move.endTs ?? 0)) ?? -1;
    const slice = startIndex > 240 ? candles.slice(startIndex - 240, startIndex + 1) : candles.slice(0, Math.max(0, startIndex) + 1);
    const ts = slice[slice.length - 1]?.closeTs ?? Number(move.startTs ?? 0);
    const built = slice.length > 10
      ? buildFeatureVectorFromContextTrigger({
          candles: slice,
          ts,
          runtimeModel,
          detectedMoves,
        })
      : null;
    mapped.push({
      kind: "calibrated_move",
      moveId: Number(move.id ?? 0),
      startTs: Number(move.startTs ?? 0),
      endTs: Number(move.endTs ?? 0),
      direction: inferMoveDirection(move.direction),
      movePct: toPercentagePoints(optionalNumber(move.movePct), "fraction") ?? 0,
      qualityTier: String(move.qualityTier ?? "unknown"),
      calibratedBaseFamily: "crash_expansion",
      calibratedMoveSizeBucket: bucketLabelFromPct(Number(move.movePct ?? 0)),
      phaseDerivedFamily: String(phase.phaseDerivedFamilyFinal ?? phase.phaseDerivedFamily ?? "unknown"),
      phaseDerivedBucket: String(phase.phaseDerivedBucket ?? "unknown"),
      earliestValidLiveSafeTriggerOffset: (phase.trigger as Record<string, unknown> | undefined)?.firstValidTriggerOffset == null ? null : `T${Number((phase.trigger as Record<string, unknown>).firstValidTriggerOffset) >= 0 ? "+" : ""}${Number((phase.trigger as Record<string, unknown>).firstValidTriggerOffset)}`,
      bestTheoreticalLiveSafeTriggerOffset: (phase.trigger as Record<string, unknown> | undefined)?.strongestTriggerOffset == null ? null : `T${Number((phase.trigger as Record<string, unknown>).strongestTriggerOffset) >= 0 ? "+" : ""}${Number((phase.trigger as Record<string, unknown>).strongestTriggerOffset)}`,
      normalMaeBeforeSuccess: toPercentagePoints(optionalNumber((phase.during as Record<string, unknown> | undefined)?.maePct), "fraction"),
      realisticMfeAfterEntry: toPercentagePoints(optionalNumber((phase.during as Record<string, unknown> | undefined)?.mfePct), "fraction"),
      barsToMfe: asNumber((phase.during as Record<string, unknown> | undefined)?.barsToMfe, 0),
      pullbackAfterMfe: toPercentagePoints(optionalNumber((phase.after as Record<string, unknown> | undefined)?.pullbackPct), "fraction"),
      liveSafeFeatures: built?.liveSafeFeatures ?? {},
      triggerOffsets: Array.isArray((phase.trigger as Record<string, unknown> | undefined)?.snapshots)
        ? (((phase.trigger as Record<string, unknown>).snapshots as unknown[]) as Array<Record<string, unknown>>)
        : [],
    });

    if ((index + 1) % LOOP_YIELD_INTERVAL === 0) {
      await emitDatasetBuildProgress(onProgress, {
        stage: "building_dataset",
        progressPct: 14,
        message: `Mapped ${index + 1}/${rows.length} calibrated moves into synthesis records`,
      });
      await yieldToEventLoop();
    }
  }
  return mapped;
}

function buildTradeRecordsFromRun(params: {
  run: { id: number; result: Record<string, unknown> };
  reconciliation: Record<string, unknown> | null;
}): SynthesisTradeRecord[] {
  const reconTrades = Array.isArray((params.reconciliation as Record<string, unknown> | null)?.trades)
    ? ((params.reconciliation as Record<string, unknown>).trades as Array<Record<string, unknown>>)
    : [];
  const reconByTradeId = new Map<string, Record<string, unknown>>(reconTrades.map((trade) => [String(trade.tradeId), trade]));
  const trades = Array.isArray(params.run.result.trades) ? (params.run.result.trades as Array<Record<string, unknown>>) : [];
  const tradeUnit = inferPercentUnit(trades.flatMap((trade) => [
    optionalNumber(trade.pnlPct),
    optionalNumber(trade.mfePct),
    optionalNumber(trade.maePct),
    optionalNumber(trade.projectedMovePct),
    optionalNumber(trade.slPct),
    optionalNumber(trade.trailingActivationPct),
    optionalNumber(trade.trailingDistancePct),
  ]));

  return trades.map((trade, idx) => {
    const tradeId = String(trade.tradeId ?? `${params.run.id}-${idx + 1}`);
    const recon = reconByTradeId.get(tradeId) ?? {};
    const contextSnapshot = asRecord(trade.contextSnapshotAtEntry);
    const triggerSnapshot = asRecord(trade.triggerSnapshotAtEntry);
    const runtimeFamily = optionalString(trade.runtimeFamily);
    const selectedBucket = optionalString(trade.selectedBucket);
    const triggerTransition = optionalString(trade.triggerTransition ?? trade.selectedTriggerTransition);
    const triggerDirection = optionalString(trade.triggerDirection)
      ?? (String(trade.direction ?? "").toLowerCase() === "sell" ? "sell" : String(trade.direction ?? "").toLowerCase() === "buy" ? "buy" : null);
    const projectedMovePct = toPercentagePoints(optionalNumber(trade.projectedMovePct), tradeUnit);
    const slPct = toPercentagePoints(optionalNumber(trade.slPct), tradeUnit);
    const trailingActivationPct = toPercentagePoints(optionalNumber(trade.trailingActivationPct), tradeUnit);
    const trailingDistancePct = toPercentagePoints(optionalNumber(trade.trailingDistancePct), tradeUnit);
    const mfePct = toPercentagePoints(optionalNumber(trade.mfePct), tradeUnit);
    const maePct = toPercentagePoints(optionalNumber(trade.maePct), tradeUnit);
    const pnlPct = toPercentagePoints(optionalNumber(trade.pnlPct), tradeUnit) ?? 0;
    const setupMatch = optionalNumber(trade.setupMatch);
    const confidence = optionalNumber(trade.confidence);
    const triggerStrengthScore = optionalNumber(trade.triggerStrengthScore);
    return {
      kind: "runtime_trade",
      tradeId,
      entryTs: asNumber(trade.entryTs),
      exitTs: trade.exitTs == null ? null : asNumber(trade.exitTs),
      direction: String(trade.direction ?? "buy") === "sell" ? "sell" : "buy",
      runtimeFamily,
      selectedBucket,
      triggerTransition,
      setupMatch,
      confidence,
      triggerStrengthScore,
      qualityTier: optionalString(trade.qualityTier),
      regimeAtEntry: optionalString(trade.regimeAtEntry),
      contextAgeBars: optionalNumber(trade.contextAgeBars),
      triggerAgeBars: optionalNumber(trade.triggerAgeBars),
      epochAgeBars: optionalNumber(trade.epochAgeBars),
      projectedMovePct,
      slPct,
      trailingActivationPct,
      trailingDistancePct,
      pnlPct,
      mfePct,
      maePct,
      exitReason: optionalString(trade.exitReason),
      modelSource: optionalString(trade.modelSource),
      runtimeEvidence: optionalNumber(trade.runtimeEvidence),
      matchedMoveIdStrict: recon.matchedMoveId == null ? null : asNumber(recon.matchedMoveId),
      strictRelationshipLabel: recon.relationToMove == null ? null : String(recon.relationToMove),
      phantomNoiseLabel: Boolean(recon.wasNoiseTrade) ? "noise_trade" : null,
      enteredTooEarly: String(recon.tradeOutcomeClassification ?? "") === "entered_too_early",
      enteredTooLate: String(recon.tradeOutcomeClassification ?? "") === "entered_too_late",
      targetUnrealisticForBucket: String(recon.tradeOutcomeClassification ?? "") === "target_unrealistic_for_bucket",
      trailingTooEarly: String(recon.tradeOutcomeClassification ?? "") === "good_entry_trailing_too_early",
      slTooTight: String(recon.tradeOutcomeClassification ?? "") === "good_entry_sl_too_tight",
      liveSafeFeatures: {
        runtimeFamily,
        selectedBucket,
        triggerTransition,
        triggerDirection,
        setupMatch,
        confidence,
        triggerStrengthScore,
        qualityTier: optionalString(trade.qualityTier),
        regimeAtEntry: optionalString(trade.regimeAtEntry),
        contextAgeBars: optionalNumber(trade.contextAgeBars),
        triggerAgeBars: optionalNumber(trade.triggerAgeBars),
        epochAgeBars: optionalNumber(trade.epochAgeBars),
        projectedMovePct,
        slPct,
        trailingActivationPct,
        trailingDistancePct,
        runtimeEvidence: optionalNumber(trade.runtimeEvidence),
        modelSource: optionalString(trade.modelSource),
        trendPersistenceScore: optionalNumber(contextSnapshot.trendPersistenceScore),
        driftPersistence60: optionalNumber(contextSnapshot.driftPersistence60),
        driftPersistence240: optionalNumber(contextSnapshot.driftPersistence240),
        positiveCloseRatio60: optionalNumber(contextSnapshot.positiveCloseRatio60),
        positiveCloseRatio240: optionalNumber(contextSnapshot.positiveCloseRatio240),
        recoveryQualityScore: optionalNumber(contextSnapshot.recoveryQualityScore),
        recoverySlope60: optionalNumber(contextSnapshot.recoverySlope60),
        recoverySlope240: optionalNumber(contextSnapshot.recoverySlope240),
        crashRecencyScore: optionalNumber(contextSnapshot.crashRecencyScore),
        barsSinceLastCrash: optionalNumber(contextSnapshot.barsSinceLastCrash),
        recoveryFromLastCrashPct: optionalNumber(contextSnapshot.recoveryFromLastCrashPct),
        priceDistanceFromLastCrashLowPct: optionalNumber(contextSnapshot.priceDistanceFromLastCrashLowPct),
        rangeCompressionScore60: optionalNumber(contextSnapshot.rangeCompressionScore60),
        rangeCompressionScore240: optionalNumber(contextSnapshot.rangeCompressionScore240),
        rangeExpansionScore15: optionalNumber(contextSnapshot.rangeExpansionScore15),
        rangeExpansionScore60: optionalNumber(contextSnapshot.rangeExpansionScore60),
        compressionToExpansionScore: optionalNumber(contextSnapshot.compressionToExpansionScore),
        atrRank60: optionalNumber(contextSnapshot.atrRank60),
        atrRank240: optionalNumber(contextSnapshot.atrRank240),
        bbWidthRank60: optionalNumber(contextSnapshot.bbWidthRank60),
        bbWidthRank240: optionalNumber(contextSnapshot.bbWidthRank240),
        priceVsEma20Pct: optionalNumber(contextSnapshot.priceVsEma20Pct),
        priceVsEma50Pct: optionalNumber(contextSnapshot.priceVsEma50Pct),
        priceVsEma200Pct: optionalNumber(contextSnapshot.priceVsEma200Pct),
        oneBarReturnPct: optionalNumber(triggerSnapshot.oneBarReturnPct),
        threeBarReturnPct: optionalNumber(triggerSnapshot.threeBarReturnPct),
        fiveBarReturnPct: optionalNumber(triggerSnapshot.fiveBarReturnPct),
        impulseScore: optionalNumber(triggerSnapshot.impulseScore),
        rejectionScore: optionalNumber(triggerSnapshot.rejectionScore),
        closeLocationInRangePct: optionalNumber(triggerSnapshot.closeLocationInRangePct),
        microBreakDirection: optionalString(triggerSnapshot.microBreakDirection),
        microBreakStrengthPct: optionalNumber(triggerSnapshot.microBreakStrengthPct),
        reclaimConfirmed: typeof triggerSnapshot.reclaimConfirmed === "boolean" ? triggerSnapshot.reclaimConfirmed : null,
        adverseImpulseBeforeTrigger: typeof triggerSnapshot.adverseImpulseBeforeTrigger === "boolean" ? triggerSnapshot.adverseImpulseBeforeTrigger : null,
        projectedMoveToSlRatio: projectedMovePct != null && slPct != null && slPct > 0
          ? projectedMovePct / slPct
          : null,
        projectedMoveToTrailingActivationRatio: projectedMovePct != null && trailingActivationPct != null && trailingActivationPct > 0
          ? projectedMovePct / trailingActivationPct
          : null,
      },
    };
  });
}

function buildDataAvailability(params: {
  moves: SynthesisMoveRecord[];
  trades: SynthesisTradeRecord[];
  phaseSnapshots: Array<Record<string, unknown>>;
  reconciliation: Record<string, unknown> | null;
}): EliteSynthesisDataAvailability {
  const totalTrades = params.trades.length;
  const reconMoves = Array.isArray((params.reconciliation as Record<string, unknown> | null)?.calibratedMoves)
    ? (((params.reconciliation as Record<string, unknown>).calibratedMoves as unknown[])?.length ?? 0)
    : Array.isArray((params.reconciliation as Record<string, unknown> | null)?.moves)
      ? (((params.reconciliation as Record<string, unknown>).moves as unknown[])?.length ?? 0)
      : Number(asRecord(params.reconciliation?.aggregates).calibratedMovesTotal ?? 0);

  const countPresent = <T,>(items: T[], picker: (item: T) => unknown) =>
    items.filter((item) => {
      const value = picker(item);
      if (value == null) return false;
      if (typeof value === "string") return value.trim().length > 0;
      return true;
    }).length;

  return {
    counts: {
      calibratedMoves: params.moves.length,
      phaseSnapshots: params.phaseSnapshots.length,
      runtimeTrades: totalTrades,
      reconciliationMoves: reconMoves,
    },
    metrics: {
      runtimeFamily: metricFromPresence(totalTrades, countPresent(params.trades, (trade) => trade.runtimeFamily), false),
      selectedBucket: metricFromPresence(totalTrades, countPresent(params.trades, (trade) => trade.selectedBucket), false),
      triggerTransition: metricFromPresence(totalTrades, countPresent(params.trades, (trade) => trade.triggerTransition), false),
      triggerDirection: metricFromPresence(totalTrades, countPresent(params.trades, (trade) => trade.liveSafeFeatures.triggerDirection), false),
      qualityTier: metricFromPresence(totalTrades, countPresent(params.trades, (trade) => trade.qualityTier), true, ["Null is allowed only when the originating trade artifact truly lacks quality tier evidence."]),
      regimeAtEntry: metricFromPresence(totalTrades, countPresent(params.trades, (trade) => trade.regimeAtEntry), true, ["Null is allowed only when the originating trade artifact truly lacks regime evidence."]),
      mfePct: metricFromPresence(totalTrades, countPresent(params.trades, (trade) => trade.mfePct), false),
      maePct: metricFromPresence(totalTrades, countPresent(params.trades, (trade) => trade.maePct), false),
      runtimeEvidence: metricFromPresence(totalTrades, countPresent(params.trades, (trade) => trade.runtimeEvidence), true),
      modelSource: metricFromPresence(totalTrades, countPresent(params.trades, (trade) => trade.modelSource), true),
    },
  };
}

function buildUnitValidation(params: {
  moves: SynthesisMoveRecord[];
  trades: SynthesisTradeRecord[];
}): EliteSynthesisUnitValidation {
  const unit = inferPercentUnit([
    ...params.moves.map((move) => move.movePct),
    ...params.trades.flatMap((trade) => [
      trade.pnlPct,
      trade.mfePct,
      trade.maePct,
      trade.projectedMovePct,
      trade.slPct,
      trade.trailingActivationPct,
      trade.trailingDistancePct,
    ]),
  ]);
  const tpImpossibleTrades = params.trades.filter((trade) =>
    trade.projectedMovePct != null &&
    trade.trailingActivationPct != null &&
    trade.projectedMovePct > 0 &&
    trade.trailingActivationPct > trade.projectedMovePct * 1.5,
  ).length;
  return {
    passed: unit !== "mixed" && tpImpossibleTrades === 0,
    unit,
    notes: [
      unit === "mixed"
        ? "Detected mixed fraction and percentage-point values across move/trade fields."
        : `Detected ${unit} inputs and standardised synthesis internals to percentage points.`,
      ...(tpImpossibleTrades > 0 ? [`Detected ${tpImpossibleTrades} trades with trailing activation materially larger than projected move.`] : []),
    ],
    sampledRanges: {
      movePct: rangeOf(params.moves.map((move) => move.movePct)),
      pnlPct: rangeOf(params.trades.map((trade) => trade.pnlPct)),
      mfePct: rangeOf(params.trades.map((trade) => trade.mfePct)),
      maePct: rangeOf(params.trades.map((trade) => trade.maePct)),
      projectedMovePct: rangeOf(params.trades.map((trade) => trade.projectedMovePct)),
      slPct: rangeOf(params.trades.map((trade) => trade.slPct)),
      trailingActivationPct: rangeOf(params.trades.map((trade) => trade.trailingActivationPct)),
      trailingDistancePct: rangeOf(params.trades.map((trade) => trade.trailingDistancePct)),
    },
  };
}

function buildValidationErrors(params: {
  moves: SynthesisMoveRecord[];
  trades: SynthesisTradeRecord[];
  phaseSnapshots: Array<Record<string, unknown>>;
  reconciliation: Record<string, unknown> | null;
  dataAvailability: EliteSynthesisDataAvailability;
  unitValidation: EliteSynthesisUnitValidation;
}): EliteSynthesisValidationError[] {
  const errors: EliteSynthesisValidationError[] = [];
  if (params.moves.length <= 0) errors.push("missing_calibrated_moves");
  if (params.phaseSnapshots.length <= 0) errors.push("missing_phase_snapshots");
  if (params.trades.length <= 0) errors.push("missing_runtime_or_rebuilt_candidates");
  const reconMoves = params.dataAvailability.counts.reconciliationMoves ?? 0;
  if (reconMoves <= 0) errors.push("missing_reconciliation_moves");
  if ((params.dataAvailability.metrics.runtimeFamily?.missingRate ?? 1) >= 1) errors.push("missing_runtime_family");
  if ((params.dataAvailability.metrics.selectedBucket?.missingRate ?? 1) >= 1) errors.push("missing_selected_bucket");
  if ((params.dataAvailability.metrics.triggerTransition?.missingRate ?? 1) >= 1) errors.push("missing_trigger_transition");
  if ((params.dataAvailability.metrics.triggerDirection?.missingRate ?? 1) >= 1) errors.push("missing_trigger_direction");
  if ((params.dataAvailability.metrics.qualityTier?.missingRate ?? 1) >= 1) errors.push("missing_quality_tier");
  if ((params.dataAvailability.metrics.regimeAtEntry?.missingRate ?? 1) >= 1) errors.push("missing_regime");
  if ((params.dataAvailability.metrics.mfePct?.missingRate ?? 1) >= 1 || (params.dataAvailability.metrics.maePct?.missingRate ?? 1) >= 1) {
    errors.push("missing_mfe_mae");
  }
  if (!params.unitValidation.passed) errors.push("unit_validation_failed");
  return Array.from(new Set(errors));
}

export async function buildUnifiedCrash300Dataset(params: {
  calibrationRunId: number | null;
  backtestRunId: number | null;
  startTs: number;
  endTs: number;
  windowDays: number;
  onProgress?: (update: DatasetBuildProgress) => Promise<void> | void;
}): Promise<UnifiedSynthesisDataset> {
  const adapter = new Crash300SynthesisAdapter();
  await emitDatasetBuildProgress(params.onProgress, {
    stage: "loading_data",
    progressPct: 3,
    message: "Loading CRASH300 runtime model",
  });
  const runtimeEnvelope = await loadCrash300RuntimeEnvelope();
  const promoted = runtimeEnvelope.promotedModel;
  if (!promoted) {
    throw new Error("CRASH300 runtime model missing/invalid. Cannot evaluate symbol service.");
  }
  await yieldToEventLoop();

  await emitDatasetBuildProgress(params.onProgress, {
    stage: "loading_data",
    progressPct: 4,
    message: "Loading persisted CRASH300 backtest run",
  });
  const persistedRun = await loadPersistedBacktestRun(params.backtestRunId);
  await yieldToEventLoop();

  await emitDatasetBuildProgress(params.onProgress, {
    stage: "building_dataset",
    progressPct: 6,
    message: "Loading 1m candle window once for synthesis dataset",
  });
  const candles = await loadWindowCandles(params.startTs - 240 * 60, params.endTs + 10 * 60);
  await yieldToEventLoop();

  await emitDatasetBuildProgress(params.onProgress, {
    stage: "building_dataset",
    progressPct: 8,
    message: "Loading calibrated move rows",
  });
  const moveRows = await db
    .select()
    .from(detectedMovesTable)
    .where(and(
      eq(detectedMovesTable.symbol, SYMBOL),
      between(detectedMovesTable.startTs, params.startTs, params.endTs),
    ))
    .orderBy(asc(detectedMovesTable.startTs));
  await yieldToEventLoop();

  await emitDatasetBuildProgress(params.onProgress, {
    stage: "building_dataset",
    progressPct: 10,
    message: "Building CRASH300 phase identifier report once for synthesis",
  });
  const phaseReport = await buildPhaseReport({
    startTs: params.startTs,
    endTs: params.endTs,
  });
  const phaseSnapshots = ((phaseReport.moves ?? []) as unknown as Array<Record<string, unknown>>) ?? [];
  await yieldToEventLoop();

  const moves = await mapMovesToSynthesisRecords({
    rows: moveRows as unknown as Array<Record<string, unknown>>,
    runtimeModel: promoted,
    candles,
    phaseMoves: phaseSnapshots,
    onProgress: params.onProgress,
  });
  await yieldToEventLoop();

  await emitDatasetBuildProgress(params.onProgress, {
    stage: "building_dataset",
    progressPct: 15,
    message: "Building calibration reconciliation once for trade linkage",
  });
  const reconciliation = await buildCrash300CalibrationReconciliationReport({
    runId: persistedRun.id,
    createdAt: persistedRun.createdAt,
    result: persistedRun.result as unknown as Parameters<typeof buildCrash300CalibrationReconciliationReport>[0]["result"],
  });
  await yieldToEventLoop();

  await emitDatasetBuildProgress(params.onProgress, {
    stage: "building_dataset",
    progressPct: 17,
    message: "Mapping runtime trades into synthesis records",
  });
  const trades = buildTradeRecordsFromRun({
    run: persistedRun,
    reconciliation,
  });
  await yieldToEventLoop();

  const dataAvailability = buildDataAvailability({
    moves,
    trades,
    phaseSnapshots,
    reconciliation,
  });
  const unitValidation = buildUnitValidation({
    moves,
    trades,
  });
  const validationErrors = buildValidationErrors({
    moves,
    trades,
    phaseSnapshots,
    reconciliation,
    dataAvailability,
    unitValidation,
  });
  const missingFeatureImplementations = [
    "projectedMovePct_trailingActivationPct_ratio_from_runtime_snapshot",
  ];

  await emitDatasetBuildProgress(params.onProgress, {
    stage: "building_dataset",
    progressPct: 18,
    message: "Loading run summaries for dataset provenance",
  });
  const [calibrationRuns, backtestRuns] = await Promise.all([
    adapter.loadCalibrationRuns(),
    adapter.loadBacktestRuns(),
  ]);
  await yieldToEventLoop();

  const detectedMoveRefs = moves.map((move) => ({
    id: move.moveId,
    startTs: move.startTs,
    endTs: move.endTs,
    direction: move.direction,
    movePct: move.movePct,
  }));
  const moveRanges = moves.map((move) => ({
    startTs: move.startTs - 60 * 60,
    endTs: move.endTs + 60 * 60,
  }));
  const controlIndices: number[] = [];
  for (let i = 240; i < candles.length; i += 180) {
    const ts = candles[i]?.closeTs ?? 0;
    const nearMove = moveRanges.some((range) => ts >= range.startTs && ts <= range.endTs);
    if (!nearMove) controlIndices.push(i);
    if (controlIndices.length >= MAX_CONTROL_SAMPLES) break;
  }
  const controls: SynthesisControlRecord[] = [];
  for (let idx = 0; idx < controlIndices.length; idx += 1) {
    const index = controlIndices[idx] ?? 0;
    const slice = candles.slice(Math.max(0, index - 240), index + 1);
    const ts = slice[slice.length - 1]?.closeTs ?? 0;
    const built = buildFeatureVectorFromContextTrigger({
      candles: slice,
      ts,
      runtimeModel: promoted,
      detectedMoves: detectedMoveRefs,
    });
    controls.push({
      kind: "non_move_control",
      controlId: `control-${idx + 1}-${ts}`,
      ts,
      label: "non_move_control",
      liveSafeFeatures: built.liveSafeFeatures,
    });
    if ((idx + 1) % LOOP_YIELD_INTERVAL === 0) {
      await emitDatasetBuildProgress(params.onProgress, {
        stage: "building_dataset",
        progressPct: 19,
        message: `Built ${idx + 1}/${controlIndices.length} non-move control samples`,
      });
      await yieldToEventLoop();
    }
  }

  return {
    serviceId: SYMBOL,
    symbol: SYMBOL,
    displayName: "Crash 300 Index",
    sourceRunIds: {
      calibrationRunId: params.calibrationRunId ?? null,
      backtestRunId: params.backtestRunId ?? (backtestRuns[0] ? Number(backtestRuns[0].id ?? 0) : null),
      runtimeModelRunId: Number((promoted.sourceRunId as number | undefined) ?? 0) || null,
      phaseReportRunId: Number((phaseSnapshots[0]?.phaseReportRunId as number | undefined) ?? 0) || null,
    },
    moves,
    trades,
    controls,
    rebuiltTriggerCandidates: [],
    validationErrors,
    dataAvailability,
    unitValidation,
    missingFeatureImplementations,
    reconciliation,
    summary: {
      calibrationRuns: calibrationRuns.length,
      backtestRuns: backtestRuns.length,
      calibratedMoves: moves.length,
      runtimeTrades: trades.length,
      nonMoveControls: controls.length,
      phaseSnapshots: phaseSnapshots.length,
      reconciliationMoves: dataAvailability.counts.reconciliationMoves,
      validationErrors,
      dataAvailability,
      unitValidation,
      missingFeatureImplementations,
      dateCoverage: {
        startTs: params.startTs,
        endTs: params.endTs,
      },
      sourceRunIdsUsed: {
        calibrationRunId: params.calibrationRunId ?? null,
        backtestRunId: params.backtestRunId ?? null,
      },
    },
  };
}

export class Crash300SynthesisAdapter implements SymbolSynthesisAdapter {
  readonly serviceId = SYMBOL;
  readonly symbol = SYMBOL;
  readonly displayName = "Crash 300 Index";

  async loadCalibrationRuns() {
    return db
      .select({
        id: calibrationPassRunsTable.id,
        symbol: calibrationPassRunsTable.symbol,
        status: calibrationPassRunsTable.status,
        passName: calibrationPassRunsTable.passName,
        startedAt: calibrationPassRunsTable.startedAt,
      })
      .from(calibrationPassRunsTable)
      .where(eq(calibrationPassRunsTable.symbol, SYMBOL))
      .orderBy(desc(calibrationPassRunsTable.startedAt))
      .limit(20);
  }

  async loadCalibratedMoves(params: { startTs: number; endTs: number }): Promise<SynthesisMoveRecord[]> {
    const rows = await db
      .select()
      .from(detectedMovesTable)
      .where(and(
        eq(detectedMovesTable.symbol, SYMBOL),
        between(detectedMovesTable.startTs, params.startTs, params.endTs),
      ))
      .orderBy(asc(detectedMovesTable.startTs));
    const runtimeEnvelope = await loadCrash300RuntimeEnvelope();
    if (!runtimeEnvelope.promotedModel) {
      throw new Error("CRASH300 runtime model missing/invalid. Cannot evaluate symbol service.");
    }
    const candles = await loadWindowCandles(params.startTs - 240 * 60, params.endTs + 10 * 60);
    const phaseReport = await buildPhaseReport({
      startTs: params.startTs,
      endTs: params.endTs,
    });
    const phaseMoves = ((phaseReport.moves ?? []) as unknown as Array<Record<string, unknown>>) ?? [];
    return mapMovesToSynthesisRecords({
      rows: rows as unknown as Array<Record<string, unknown>>,
      runtimeModel: runtimeEnvelope.promotedModel,
      candles,
      phaseMoves,
    });
  }

  async loadRuntimeModel() {
    const runtimeEnvelope = await loadCrash300RuntimeEnvelope();
    if (!runtimeEnvelope.promotedModel) {
      throw new Error("CRASH300 runtime model missing/invalid. Cannot evaluate symbol service.");
    }
    return runtimeEnvelope.promotedModel as unknown as Record<string, unknown>;
  }

  async loadBacktestRuns() {
    const result = await db.execute(sql`
      SELECT id, created_at, summary
      FROM v3_backtest_runs
      WHERE symbol = ${SYMBOL}
      ORDER BY created_at DESC
      LIMIT 20
    `);
    return (result.rows ?? []) as Array<Record<string, unknown>>;
  }

  async loadBacktestTrades(backtestRunId: number | null): Promise<SynthesisTradeRecord[]> {
    const run = await loadPersistedBacktestRun(backtestRunId);
    const reconciliation = await this.loadCalibrationReconciliation(run.id);
    return buildTradeRecordsFromRun({
      run,
      reconciliation,
    });
  }

  async loadPhaseSnapshots(params: { windowDays: number }) {
    const now = Math.floor(Date.now() / 1000);
    const report = await buildPhaseReport({
      startTs: now - params.windowDays * 86400,
      endTs: now,
    });
    return ((report.moves ?? []) as unknown as Array<Record<string, unknown>>) ?? [];
  }

  async loadCalibrationReconciliation(backtestRunId: number | null) {
    const run = await loadPersistedBacktestRun(backtestRunId);
    const result = run.result as Record<string, unknown>;
    return buildCrash300CalibrationReconciliationReport({
      runId: run.id,
      createdAt: run.createdAt,
      result: result as unknown as Parameters<typeof buildCrash300CalibrationReconciliationReport>[0]["result"],
    });
  }

  buildLiveSafeFeatureVector(record: Record<string, unknown>) {
    return asRecord(record.liveSafeFeatures) as Record<string, number | string | boolean | null>;
  }

  deriveMoveSizeBucket(movePct: number): string {
    return bucketLabelFromPct(movePct);
  }

  deriveRuntimeArchetype(record: Record<string, unknown>): string {
    const runtimeFamily = String(record.runtimeFamily ?? record.phaseDerivedFamily ?? "unknown");
    return runtimeFamily === "unknown" ? "unknown" : runtimeFamily;
  }

  async generateTriggerCandidatesFromMoveOffsets(dataset: UnifiedSynthesisDataset) {
    const candidates: SynthesisRebuiltTriggerCandidateRecord[] = [];
    for (const move of dataset.moves) {
      const snapshots = move.triggerOffsets
        .map((snapshot) => asRecord(snapshot))
        .filter((snapshot) => Number.isFinite(Number(snapshot.offsetBars)));
      if (snapshots.length === 0) {
        candidates.push({
          kind: "rebuilt_trigger_candidate",
          candidateId: `move-${move.moveId}-no-snapshots`,
          moveId: move.moveId,
          entryTs: move.startTs,
          exitTs: null,
          offsetLabel: "none",
          offsetBars: 0,
          direction: move.direction === "down" ? "sell" : "buy",
          runtimeFamily: null,
          selectedBucket: null,
          triggerTransition: null,
          triggerDirection: null,
          qualityTier: move.qualityTier,
          setupMatch: null,
          confidence: null,
          triggerStrengthScore: null,
          projectedMovePct: Math.abs(move.movePct),
          slPct: null,
          trailingActivationPct: null,
          trailingDistancePct: null,
          minHoldBars: null,
          pnlPct: 0,
          mfePct: null,
          maePct: null,
          exitReason: null,
          eligible: false,
          rejectReason: "no_phase_trigger_snapshots",
          liveSafeFeatures: { ...move.liveSafeFeatures },
        });
        continue;
      }
      for (const snapshot of snapshots) {
        const offsetBars = asNumber(snapshot.offsetBars, 0);
        const triggerTransition = optionalString(snapshot.triggerTransition);
        const triggerDirection = optionalString(snapshot.triggerDirection);
        const runtimeFamily = optionalString(snapshot.runtimeFamily ?? move.phaseDerivedFamily);
        const selectedBucket = optionalString(snapshot.selectedBucket ?? move.phaseDerivedBucket ?? move.calibratedMoveSizeBucket);
        const triggerStrengthScore = optionalNumber(snapshot.triggerStrengthScore);
        const projectedMovePct = Math.abs(move.realisticMfeAfterEntry ?? move.movePct ?? 0);
        const maePct = Math.abs(move.normalMaeBeforeSuccess ?? 0);
        const offsetPenalty = Math.max(0, 1 - Math.min(0.75, Math.abs(offsetBars) * 0.06));
        const effectiveMfePct = Number((projectedMovePct * offsetPenalty).toFixed(4));
        const effectiveMaePct = Number((Math.max(maePct, projectedMovePct * 0.18) * (1 + Math.abs(offsetBars) * 0.04)).toFixed(4));
        const slPct = Number(Math.max(0.35, Math.min(effectiveMaePct * 1.15, projectedMovePct * 0.55)).toFixed(4));
        const trailingActivationPct = Number(Math.max(0.5, effectiveMfePct * 0.45).toFixed(4));
        const trailingDistancePct = Number(Math.max(0.25, Math.min(slPct, effectiveMaePct * 0.8)).toFixed(4));
        const minHoldBars = Math.max(3, Number(move.barsToMfe ?? 6));
        const eligible =
          Boolean(runtimeFamily) &&
          runtimeFamily !== "unknown" &&
          Boolean(selectedBucket) &&
          selectedBucket !== "unknown" &&
          Boolean(triggerTransition) &&
          triggerTransition !== "none" &&
          Boolean(triggerDirection) &&
          triggerDirection !== "none";
        const reason =
          !runtimeFamily || runtimeFamily === "unknown"
            ? "no_runtime_family_from_offset"
            : !selectedBucket || selectedBucket === "unknown"
              ? "no_selected_bucket_from_offset"
              : !triggerTransition || triggerTransition === "none"
                ? "no_trigger_transition_from_offset"
                : !triggerDirection || triggerDirection === "none"
                  ? "no_trigger_direction_from_offset"
                  : null;
        const winLike = eligible && effectiveMfePct > slPct * 1.05 && (triggerStrengthScore ?? 0) > 0;
        candidates.push({
          kind: "rebuilt_trigger_candidate",
          candidateId: `move-${move.moveId}-offset-${offsetBars}`,
          moveId: move.moveId,
          entryTs: move.startTs + offsetBars * 60,
          exitTs: move.endTs,
          offsetLabel: `T${offsetBars >= 0 ? "+" : ""}${offsetBars}`,
          offsetBars,
          direction: triggerDirection === "sell" ? "sell" : "buy",
          runtimeFamily,
          selectedBucket,
          triggerTransition,
          triggerDirection,
          qualityTier: move.qualityTier,
          setupMatch: optionalNumber(snapshot.setupMatch) ?? Math.max(0, Math.min(1, (triggerStrengthScore ?? 0) * 0.9)),
          confidence: optionalNumber(snapshot.confidence) ?? Math.max(0, Math.min(1, (triggerStrengthScore ?? 0) * 0.95)),
          triggerStrengthScore,
          projectedMovePct,
          slPct,
          trailingActivationPct,
          trailingDistancePct,
          minHoldBars,
          pnlPct: winLike ? Number(Math.min(projectedMovePct * 0.55, effectiveMfePct * 0.7).toFixed(4)) : Number((-Math.min(slPct, effectiveMaePct)).toFixed(4)),
          mfePct: effectiveMfePct,
          maePct: effectiveMaePct,
          exitReason: !eligible ? null : winLike ? "tp_hit" : "sl_hit",
          eligible,
          rejectReason: reason,
          liveSafeFeatures: {
            ...move.liveSafeFeatures,
            ...Object.fromEntries(
              Object.entries(snapshot).filter(([, value]) => ["string", "number", "boolean"].includes(typeof value)),
            ),
            runtimeFamily,
            selectedBucket,
            triggerTransition,
            triggerDirection,
            qualityTier: move.qualityTier,
            projectedMovePct,
            slPct,
            trailingActivationPct,
            trailingDistancePct,
            projectedMoveToSlRatio: slPct > 0 ? projectedMovePct / slPct : null,
            projectedMoveToTrailingActivationRatio: trailingActivationPct > 0 ? projectedMovePct / trailingActivationPct : null,
          },
        });
      }
    }
    return candidates;
  }

  async evaluatePolicyOnHistoricalData(dataset: UnifiedSynthesisDataset, policy: EliteSynthesisPolicyArtifact): Promise<PolicyEvaluationResult> {
    const sourcePool = String(policy.entryThresholds.sourcePool ?? "runtime_trades") === "rebuilt_trigger_candidates"
      ? "rebuilt_trigger_candidates"
      : "runtime_trades";
    const pool = sourcePool === "rebuilt_trigger_candidates"
      ? dataset.rebuiltTriggerCandidates.filter((candidate) => candidate.eligible)
      : dataset.trades;
    const eligible = pool.filter((trade) => {
      const familyOk = policy.selectedRuntimeArchetypes.length === 0 || policy.selectedRuntimeArchetypes.includes(trade.runtimeFamily ?? "unknown");
      const bucketOk = policy.selectedBuckets.length === 0 || policy.selectedBuckets.includes(trade.selectedBucket ?? "unknown");
      const triggerOk = policy.selectedTriggerTransitions.length === 0 || policy.selectedTriggerTransitions.includes(trade.triggerTransition ?? "none");
      return familyOk && bucketOk && triggerOk;
    });
    const wins = eligible.filter((trade) => trade.pnlPct > 0).length;
    const losses = eligible.length - wins;
    const slHits = eligible.filter((trade) => trade.exitReason === "sl_hit").length;
    const grossProfit = eligible.filter((trade) => trade.pnlPct > 0).reduce((sum, trade) => sum + trade.pnlPct, 0);
    const grossLoss = Math.abs(eligible.filter((trade) => trade.pnlPct <= 0).reduce((sum, trade) => sum + trade.pnlPct, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0;
    const phantomCount = eligible.filter((trade) => "phantomNoiseLabel" in trade && trade.phantomNoiseLabel === "noise_trade").length;
    const maxDrawdownPct = Math.max(0, ...eligible.map((trade) => Math.max(0, -(trade.pnlPct ?? 0))));
    const winRate = eligible.length > 0 ? wins / eligible.length : 0;
    const slHitRate = eligible.length > 0 ? slHits / eligible.length : 0;
    const objectiveScore = objectiveFromMetrics({
      winRate,
      slHitRate,
      profitFactor,
      tradeCount: eligible.length,
      targetTradeCountMin: 45,
      targetTradeCountMax: 75,
      preferredTradeCount: 60,
      maxDrawdownPct,
      phantomCount,
    });
    return {
      policyId: policy.policyId,
      passNumber: policy.passNumberSelected,
      trades: eligible.length,
      wins,
      losses,
      winRate,
      slHits,
      slHitRate,
      profitFactor,
      accountReturnPct: eligible.reduce((sum, trade) => sum + trade.pnlPct, 0) * 0.15,
      maxDrawdownPct,
      phantomCount,
      objectiveScore,
      selectedFeatures: policy.selectedCoreFeatures,
      selectedMoveSizeBuckets: policy.selectedMoveSizeBuckets,
      selectedRuntimeArchetypes: policy.selectedRuntimeArchetypes,
      selectedBuckets: policy.selectedBuckets,
      selectedTriggerTransitions: policy.selectedTriggerTransitions,
      entryThresholds: policy.entryThresholds,
      entryTimingRules: policy.entryTimingRules.map((rule) => ({ ...rule })),
      noTradeRules: [...policy.noTradeRules],
      exitRules: {
        tpTargetPct: asNumber(policy.tpRules.targetPct, 0),
        slRiskPct: asNumber(policy.slRules.maxInitialRiskPct, 0),
        trailingActivationPct: asNumber(policy.trailingRules.activationProfitPct, 0),
        trailingDistancePct: asNumber(policy.trailingRules.trailingDistancePct, 0),
        minHoldBars: asNumber(policy.minHoldRules.minHoldBars, 0),
      },
      leakagePassed: policy.leakageAudit.passed,
      monthlyBreakdown: [],
      reasons: [],
      sourcePool,
      selectedFeaturesSummary: policy.selectedCoreFeatures.map((feature) => feature.key),
      tpSlTrailingSummary: [
        `tp=${asNumber(policy.tpRules.targetPct, 0).toFixed(2)}%`,
        `sl=${asNumber(policy.slRules.maxInitialRiskPct, 0).toFixed(2)}%`,
        `trail=${asNumber(policy.trailingRules.activationProfitPct, 0).toFixed(2)}%/${asNumber(policy.trailingRules.trailingDistancePct, 0).toFixed(2)}%`,
      ],
      targetAchieved: winRate >= 0.9 && slHitRate <= 0.1 && profitFactor >= 2.5 && eligible.length >= 45 && eligible.length <= 75,
    };
  }

  deriveExitPolicyFromSubset(_dataset: UnifiedSynthesisDataset, subset: SynthesisTradeRecord[]): EliteSynthesisExitRules {
    const winners = subset.filter((trade) => trade.pnlPct > 0);
    const winnerMae = winners.map((trade) => Math.abs(trade.maePct ?? 0)).filter((value) => value > 0);
    const winnerMfe = winners.map((trade) => Math.abs(trade.mfePct ?? 0)).filter((value) => value > 0);
    const unit = inferPercentUnit([...winnerMae, ...winnerMfe]);
    const winnerMaePct = winnerMae.map((value) => toPercentagePoints(value, unit) ?? 0).filter((value) => value > 0);
    const winnerMfePct = winnerMfe.map((value) => toPercentagePoints(value, unit) ?? 0).filter((value) => value > 0);
    return {
      tpTargetPct: Number(Math.max(0.5, percentile(winnerMfePct, 0.5)).toFixed(2)),
      slRiskPct: Number(Math.max(0.35, percentile(winnerMaePct, 0.9)).toFixed(2)),
      trailingActivationPct: Number(Math.max(0.4, percentile(winnerMfePct, 0.25)).toFixed(2)),
      trailingDistancePct: Number(Math.max(0.25, percentile(winnerMaePct, 0.75)).toFixed(2)),
      minHoldBars: Math.max(1, Math.round(average(winners.map((trade) => Math.max(1, ((trade.exitTs ?? trade.entryTs) - trade.entryTs) / 60))))),
    };
  }

  validateNoFutureLeakage(policy: EliteSynthesisPolicyArtifact) {
    const featureKeys = policy.selectedCoreFeatures.map((feature) => feature.key.toLowerCase());
    const banned = ["pnl", "mfe", "mae", "exitreason", "strictrelationshiplabel", "legacydiagnosticscore"];
    const found = featureKeys.filter((key) => banned.some((token) => key.includes(token)));
    return {
      passed: found.length === 0,
      notes: found.length === 0 ? ["Live-safe feature audit passed."] : [`Forbidden feature tokens found: ${found.join(", ")}`],
    };
  }
}
