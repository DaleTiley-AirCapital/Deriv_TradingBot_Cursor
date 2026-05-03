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
  SymbolSynthesisAdapter,
  SynthesisControlRecord,
  SynthesisMoveRecord,
  SynthesisTradeRecord,
  UnifiedSynthesisDataset,
} from "./adapter.js";
import type {
  EliteSynthesisExitRules,
  EliteSynthesisFeatureSummary,
  EliteSynthesisParams,
  EliteSynthesisPolicyArtifact,
  EliteSynthesisStage,
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
    result: asRecord(row.result),
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
      movePct: Number(move.movePct ?? 0),
      qualityTier: String(move.qualityTier ?? "unknown"),
      calibratedBaseFamily: "crash_expansion",
      calibratedMoveSizeBucket: bucketLabelFromPct(Number(move.movePct ?? 0)),
      phaseDerivedFamily: String(phase.phaseDerivedFamilyFinal ?? phase.phaseDerivedFamily ?? "unknown"),
      phaseDerivedBucket: String(phase.phaseDerivedBucket ?? "unknown"),
      earliestValidLiveSafeTriggerOffset: (phase.trigger as Record<string, unknown> | undefined)?.firstValidTriggerOffset == null ? null : `T${Number((phase.trigger as Record<string, unknown>).firstValidTriggerOffset) >= 0 ? "+" : ""}${Number((phase.trigger as Record<string, unknown>).firstValidTriggerOffset)}`,
      bestTheoreticalLiveSafeTriggerOffset: (phase.trigger as Record<string, unknown> | undefined)?.strongestTriggerOffset == null ? null : `T${Number((phase.trigger as Record<string, unknown>).strongestTriggerOffset) >= 0 ? "+" : ""}${Number((phase.trigger as Record<string, unknown>).strongestTriggerOffset)}`,
      normalMaeBeforeSuccess: asNumber((phase.during as Record<string, unknown> | undefined)?.maePct, 0),
      realisticMfeAfterEntry: asNumber((phase.during as Record<string, unknown> | undefined)?.mfePct, 0),
      barsToMfe: asNumber((phase.during as Record<string, unknown> | undefined)?.barsToMfe, 0),
      pullbackAfterMfe: asNumber((phase.after as Record<string, unknown> | undefined)?.pullbackPct, 0),
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
  return trades.map((trade, idx) => {
    const tradeId = String(trade.tradeId ?? `${params.run.id}-${idx + 1}`);
    const recon = reconByTradeId.get(tradeId) ?? {};
    return {
      kind: "runtime_trade",
      tradeId,
      entryTs: asNumber(trade.entryTs),
      exitTs: trade.exitTs == null ? null : asNumber(trade.exitTs),
      direction: String(trade.direction ?? "buy") === "sell" ? "sell" : "buy",
      runtimeFamily: trade.runtimeFamily == null ? null : String(trade.runtimeFamily),
      selectedBucket: trade.selectedBucket == null ? null : String(trade.selectedBucket),
      triggerTransition: trade.triggerTransition == null ? null : String(trade.triggerTransition),
      setupMatch: trade.setupMatch == null ? null : asNumber(trade.setupMatch),
      confidence: trade.confidence == null ? null : asNumber(trade.confidence),
      triggerStrengthScore: trade.triggerStrengthScore == null ? null : asNumber(trade.triggerStrengthScore),
      qualityTier: trade.qualityTier == null ? null : String(trade.qualityTier),
      regimeAtEntry: trade.regimeAtEntry == null ? null : String(trade.regimeAtEntry),
      contextAgeBars: trade.contextAgeBars == null ? null : asNumber(trade.contextAgeBars),
      triggerAgeBars: trade.triggerAgeBars == null ? null : asNumber(trade.triggerAgeBars),
      epochAgeBars: trade.epochAgeBars == null ? null : asNumber(trade.epochAgeBars),
      projectedMovePct: trade.projectedMovePct == null ? null : asNumber(trade.projectedMovePct),
      slPct: trade.slPct == null ? null : asNumber(trade.slPct),
      trailingActivationPct: trade.trailingActivationPct == null ? null : asNumber(trade.trailingActivationPct),
      trailingDistancePct: trade.trailingDistancePct == null ? null : asNumber(trade.trailingDistancePct),
      pnlPct: asNumber(trade.pnlPct),
      mfePct: trade.mfePct == null ? null : asNumber(trade.mfePct),
      maePct: trade.maePct == null ? null : asNumber(trade.maePct),
      exitReason: trade.exitReason == null ? null : String(trade.exitReason),
      matchedMoveIdStrict: recon.matchedMoveId == null ? null : asNumber(recon.matchedMoveId),
      strictRelationshipLabel: recon.relationToMove == null ? null : String(recon.relationToMove),
      phantomNoiseLabel: Boolean(recon.wasNoiseTrade) ? "noise_trade" : null,
      enteredTooEarly: String(recon.tradeOutcomeClassification ?? "") === "entered_too_early",
      enteredTooLate: String(recon.tradeOutcomeClassification ?? "") === "entered_too_late",
      targetUnrealisticForBucket: String(recon.tradeOutcomeClassification ?? "") === "target_unrealistic_for_bucket",
      trailingTooEarly: String(recon.tradeOutcomeClassification ?? "") === "good_entry_trailing_too_early",
      slTooTight: String(recon.tradeOutcomeClassification ?? "") === "good_entry_sl_too_tight",
      liveSafeFeatures: {
        runtimeFamily: trade.runtimeFamily == null ? null : String(trade.runtimeFamily),
        selectedBucket: trade.selectedBucket == null ? null : String(trade.selectedBucket),
        triggerTransition: trade.triggerTransition == null ? null : String(trade.triggerTransition),
        triggerDirection: trade.direction == null ? null : String(trade.direction),
        setupMatch: trade.setupMatch == null ? null : asNumber(trade.setupMatch),
        confidence: trade.confidence == null ? null : asNumber(trade.confidence),
        triggerStrengthScore: trade.triggerStrengthScore == null ? null : asNumber(trade.triggerStrengthScore),
        qualityTier: trade.qualityTier == null ? null : String(trade.qualityTier),
        regimeAtEntry: trade.regimeAtEntry == null ? null : String(trade.regimeAtEntry),
        contextAgeBars: trade.contextAgeBars == null ? null : asNumber(trade.contextAgeBars),
        triggerAgeBars: trade.triggerAgeBars == null ? null : asNumber(trade.triggerAgeBars),
        epochAgeBars: trade.epochAgeBars == null ? null : asNumber(trade.epochAgeBars),
        projectedMovePct: trade.projectedMovePct == null ? null : asNumber(trade.projectedMovePct),
        slPct: trade.slPct == null ? null : asNumber(trade.slPct),
        projectedMoveToSlRatio: trade.projectedMovePct != null && trade.slPct != null && asNumber(trade.slPct) > 0
          ? asNumber(trade.projectedMovePct) / asNumber(trade.slPct)
          : null,
        projectedMoveToTrailingActivationRatio: trade.projectedMovePct != null && trade.trailingActivationPct != null && asNumber(trade.trailingActivationPct) > 0
          ? asNumber(trade.projectedMovePct) / asNumber(trade.trailingActivationPct)
          : null,
      },
    };
  });
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
    summary: {
      calibrationRuns: calibrationRuns.length,
      backtestRuns: backtestRuns.length,
      calibratedMoves: moves.length,
      runtimeTrades: trades.length,
      nonMoveControls: controls.length,
      phaseSnapshots: phaseSnapshots.length,
      reconciliationMoves: Array.isArray((reconciliation as Record<string, unknown> | null)?.moves) ? ((reconciliation as Record<string, unknown>).moves as unknown[]).length : 0,
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
    const candidates: Array<Record<string, unknown>> = [];
    for (const move of dataset.moves) {
      const snapshots = move.triggerOffsets;
      for (const snapshot of snapshots) {
        const offsetBars = asNumber(snapshot.offsetBars, 0);
        const triggerTransition = String(snapshot.triggerTransition ?? "none");
        const triggerDirection = String(snapshot.triggerDirection ?? "none");
        if (triggerDirection === "none" || triggerTransition === "none") continue;
        candidates.push({
          moveId: move.moveId,
          offsetBars,
          triggerTransition,
          triggerDirection,
          runtimeFamily: move.phaseDerivedFamily ?? "unknown",
          selectedBucket: move.phaseDerivedBucket ?? move.calibratedMoveSizeBucket,
          qualityTier: move.qualityTier,
          direction: move.direction,
        });
      }
    }
    return candidates;
  }

  async evaluatePolicyOnHistoricalData(dataset: UnifiedSynthesisDataset, policy: EliteSynthesisPolicyArtifact): Promise<PolicyEvaluationResult> {
    const eligible = dataset.trades.filter((trade) => {
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
    const phantomCount = eligible.filter((trade) => trade.phantomNoiseLabel === "noise_trade").length;
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
    return {
      tpTargetPct: Number(percentile(winnerMfe, 0.5).toFixed(2)),
      slRiskPct: Number(Math.max(0.5, percentile(winnerMae, 0.9)).toFixed(2)),
      trailingActivationPct: Number(Math.max(1, percentile(winnerMfe, 0.25)).toFixed(2)),
      trailingDistancePct: Number(Math.max(0.5, percentile(winnerMae, 0.75)).toFixed(2)),
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
