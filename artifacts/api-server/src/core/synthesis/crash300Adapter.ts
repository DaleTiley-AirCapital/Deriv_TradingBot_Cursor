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
import { deriveCrash300RuntimeFamilyWithSemantics, directionFromCrash300Family } from "../../symbol-services/CRASH300/familySemantics.js";
import { deriveCrash300RuntimeBucket, directionFromCrash300Bucket } from "../../symbol-services/CRASH300/bucketSemantics.js";
import type { Crash300MoveSizeBucket } from "../../symbol-services/CRASH300/features.js";
import type { PromotedSymbolRuntimeModel } from "../calibration/promotedSymbolModel.js";
import type {
  PolicyEvaluationResult,
  SynthesisPercentFieldMeta,
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
  EliteSynthesisPercentFieldUnit,
  EliteSynthesisPolicyArtifact,
  EliteSynthesisStage,
  EliteSynthesisUnitValidation,
  EliteSynthesisValidationError,
} from "./types.js";

const SYMBOL = "CRASH300";
const MAX_CONTROL_SAMPLES = 60;
const LOOP_YIELD_INTERVAL = 24;
const REBUILT_TRIGGER_OFFSETS = [-10, -5, -3, -2, -1, 0, 1, 2, 3, 5, 10] as const;
const MIN_EXIT_SUBSET_CANDIDATES = 3;
const MIN_EXIT_SUBSET_WINNERS = 2;
const VALID_REBUILT_RUNTIME_ARCHETYPES = new Set([
  "crash_event_down",
  "post_crash_recovery_up",
  "bear_trap_reversal_up",
  "failed_recovery_short",
]);
const VALID_REBUILT_TRIGGER_TRANSITIONS = new Set([
  "crash_continuation_down",
  "post_crash_recovery_reclaim_up",
  "bear_trap_reversal_up",
  "failed_recovery_break_down",
]);

function canonicalFamilyFromTriggerTransition(transition: string | null | undefined): string | null {
  switch (transition) {
    case "crash_continuation_down":
      return "crash_event_down";
    case "post_crash_recovery_reclaim_up":
    case "recovery_continuation_up":
      return "post_crash_recovery_up";
    case "bear_trap_reversal_up":
    case "failed_down_impulse_reclaim_up":
      return "bear_trap_reversal_up";
    case "failed_recovery_break_down":
    case "compression_break_down":
      return "failed_recovery_short";
    default:
      return null;
  }
}

function canonicalTriggerTransitionFromFamily(family: string | null | undefined): string | null {
  switch (family) {
    case "crash_event_down":
      return "crash_continuation_down";
    case "post_crash_recovery_up":
      return "post_crash_recovery_reclaim_up";
    case "bear_trap_reversal_up":
      return "bear_trap_reversal_up";
    case "failed_recovery_short":
      return "failed_recovery_break_down";
    default:
      return null;
  }
}

function canonicalTriggerTransitionFromRawTransition(transition: string | null | undefined): string | null {
  switch (transition) {
    case "crash_continuation_down":
      return "crash_continuation_down";
    case "post_crash_recovery_reclaim_up":
    case "recovery_continuation_up":
      return "post_crash_recovery_reclaim_up";
    case "bear_trap_reversal_up":
    case "failed_down_impulse_reclaim_up":
      return "bear_trap_reversal_up";
    case "failed_recovery_break_down":
    case "compression_break_down":
      return "failed_recovery_break_down";
    default:
      return null;
  }
}

function canonicalFamilyFromBucket(bucket: string | null | undefined): string | null {
  const value = String(bucket ?? "").trim().toLowerCase();
  if (!value) return null;
  if (value.includes("|crash_event|")) return "crash_event_down";
  if (value.includes("|recovery|")) return "post_crash_recovery_up";
  if (value.includes("|reversal|")) return "bear_trap_reversal_up";
  if (value.includes("|failed_recovery|")) return "failed_recovery_short";
  return null;
}

function canonicalFamilyFromRawRuntimeFamily(value: string | null | undefined): string | null {
  const family = String(value ?? "").trim().toLowerCase();
  if (!family || family === "none" || family === "unknown") return null;
  switch (family) {
    case "crash_event_down":
    case "post_crash_recovery_up":
    case "bear_trap_reversal_up":
    case "failed_recovery_short":
      return family;
    case "drift_continuation_up":
      return "post_crash_recovery_up";
    case "bull_trap_reversal_down":
      return "failed_recovery_short";
    case "crash_expansion_down":
    case "crash_continuation_down":
      return "crash_event_down";
    case "recovery_continuation_up":
    case "post_crash_recovery_reclaim_up":
      return "post_crash_recovery_up";
    case "failed_down_impulse_reclaim_up":
      return "bear_trap_reversal_up";
    case "compression_break_down":
    case "failed_recovery_break_down":
      return "failed_recovery_short";
    default:
      if (family.startsWith("down|crash_event|")) return "crash_event_down";
      if (family.startsWith("up|recovery|")) return "post_crash_recovery_up";
      if (family.startsWith("up|reversal|")) return "bear_trap_reversal_up";
      if (family.startsWith("down|failed_recovery|")) return "failed_recovery_short";
      return null;
  }
}

function canonicalFamilyFromLiveSafeEvidence(params: {
  canonicalDirection: "buy" | "sell" | "unknown";
  selectedBucket: string | null;
  canonicalTriggerTransition: string | null;
  contextSnapshot: Record<string, unknown>;
  liveSafeFeatures: Record<string, number | string | boolean | null>;
}): string | null {
  const fromTransition = canonicalFamilyFromTriggerTransition(params.canonicalTriggerTransition);
  if (fromTransition) return fromTransition;
  const fromBucket = canonicalFamilyFromBucket(params.selectedBucket);
  if (fromBucket) return fromBucket;
  const crashRecencyScore = optionalNumber(params.contextSnapshot.crashRecencyScore ?? params.liveSafeFeatures.crashRecencyScore) ?? 0;
  const recoveryFromLastCrashPct = optionalNumber(params.contextSnapshot.recoveryFromLastCrashPct ?? params.liveSafeFeatures.recoveryFromLastCrashPct) ?? 0;
  const recoveryQualityScore = optionalNumber(params.contextSnapshot.recoveryQualityScore ?? params.liveSafeFeatures.recoveryQualityScore) ?? 0;
  const trendPersistenceScore = optionalNumber(params.contextSnapshot.trendPersistenceScore ?? params.liveSafeFeatures.trendPersistenceScore) ?? 0;
  const compressionToExpansionScore = optionalNumber(params.contextSnapshot.compressionToExpansionScore ?? params.liveSafeFeatures.compressionToExpansionScore) ?? 0;
  const reclaimConfirmed = Boolean(params.liveSafeFeatures.reclaimConfirmed);
  const adverseImpulseBeforeTrigger = Boolean(params.liveSafeFeatures.adverseImpulseBeforeTrigger);
  if (params.canonicalDirection === "buy") {
    if (reclaimConfirmed && adverseImpulseBeforeTrigger) return "bear_trap_reversal_up";
    if (
      crashRecencyScore > 0.2 &&
      (recoveryFromLastCrashPct > 0 || recoveryQualityScore >= Math.max(0.25, trendPersistenceScore - 0.1))
    ) {
      return "post_crash_recovery_up";
    }
  }
  if (params.canonicalDirection === "sell") {
    if (crashRecencyScore > 0.4 && compressionToExpansionScore > 0.45) return "crash_event_down";
    if (recoveryQualityScore < Math.max(0.35, trendPersistenceScore - 0.05)) return "failed_recovery_short";
  }
  return null;
}

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

function rebuiltOffsetCluster(label: string | null | undefined): string {
  switch (label) {
    case "T-10":
    case "T-5":
    case "T-3":
      return "early";
    case "T-2":
    case "T-1":
    case "T0":
    case "T+0":
    case "T+1":
      return "trigger";
    case "T+2":
    case "T+3":
    case "T+5":
    case "T+10":
      return "late";
    default:
      return "unknown";
  }
}

function deterministicRebuiltCandidateScore(candidate: SynthesisRebuiltTriggerCandidateRecord): number {
  return (candidate.confidence ?? 0) * 0.45
    + (candidate.setupMatch ?? 0) * 0.35
    + (candidate.triggerStrengthScore ?? 0) * 0.2;
}

function buildMonthlyBreakdown(
  trades: Array<
    Pick<SynthesisTradeRecord, "entryTs" | "pnlPct" | "exitReason" | "selectedBucket">
    | Pick<SynthesisRebuiltTriggerCandidateRecord, "entryTs" | "pnlPct" | "exitReason" | "selectedBucket" | "offsetLabel">
  >,
): Array<Record<string, unknown>> {
  const grouped = new Map<string, Array<typeof trades[number]>>();
  for (const trade of trades) {
    const month = new Date(trade.entryTs * 1000).toISOString().slice(0, 7);
    const bucket = grouped.get(month) ?? [];
    bucket.push(trade);
    grouped.set(month, bucket);
  }
  return Array.from(grouped.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, bucket]) => {
      const wins = bucket.filter((trade) => trade.pnlPct > 0).length;
      const losses = bucket.length - wins;
      const slHits = bucket.filter((trade) => trade.exitReason === "sl_hit").length;
      const grossProfit = bucket.filter((trade) => trade.pnlPct > 0).reduce((sum, trade) => sum + trade.pnlPct, 0);
      const grossLoss = Math.abs(bucket.filter((trade) => trade.pnlPct <= 0).reduce((sum, trade) => sum + trade.pnlPct, 0));
      const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0;
      const pnlValues = bucket.map((trade) => trade.pnlPct).sort((a, b) => a - b);
      const exitReasonCounts = bucket.reduce<Record<string, number>>((acc, trade) => {
        const reason = trade.exitReason ?? "unknown";
        acc[reason] = (acc[reason] ?? 0) + 1;
        return acc;
      }, {});
      const selectedBucketCounts = bucket.reduce<Record<string, number>>((acc, trade) => {
        const key = trade.selectedBucket ?? "unknown";
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {});
      const offsetCounts = bucket.reduce<Record<string, number>>((acc, trade) => {
        const key = "offsetLabel" in trade ? (trade.offsetLabel ?? "unknown") : "runtime_trade";
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {});
      return {
        month,
        trades: bucket.length,
        wins,
        losses,
        slHits,
        winRate: bucket.length > 0 ? wins / bucket.length : 0,
        slHitRate: bucket.length > 0 ? slHits / bucket.length : 0,
        profitFactor,
        accountReturnPct: bucket.reduce((sum, trade) => sum + trade.pnlPct, 0) * 0.15,
        maxDrawdownPct: Math.max(0, ...bucket.map((trade) => Math.max(0, -trade.pnlPct))),
        avgPnlPct: bucket.length > 0 ? bucket.reduce((sum, trade) => sum + trade.pnlPct, 0) / bucket.length : 0,
        medianPnlPct: percentile(pnlValues, 0.5),
        exitReasonCounts,
        selectedBucketCounts,
        offsetCounts,
      };
    });
}

type PercentLikeField =
  | "movePct"
  | "pnlPct"
  | "mfePct"
  | "maePct"
  | "projectedMovePct"
  | "slPct"
  | "trailingActivationPct"
  | "trailingDistancePct"
  | "pullbackPct"
  | "recoveryFromLastCrashPct"
  | "priceDistanceFromLastCrashLowPct"
  | "priceVsEma20Pct"
  | "priceVsEma50Pct"
  | "priceVsEma200Pct"
  | "oneBarReturnPct"
  | "threeBarReturnPct"
  | "fiveBarReturnPct"
  | "closeLocationInRangePct"
  | "microBreakStrengthPct";

const DEFAULT_PERCENT_POINT_FIELDS = new Set<PercentLikeField>([
  "movePct",
  "pnlPct",
  "mfePct",
  "maePct",
  "projectedMovePct",
  "slPct",
  "trailingActivationPct",
  "trailingDistancePct",
  "pullbackPct",
  "recoveryFromLastCrashPct",
  "priceDistanceFromLastCrashLowPct",
  "priceVsEma20Pct",
  "priceVsEma50Pct",
  "priceVsEma200Pct",
  "oneBarReturnPct",
  "threeBarReturnPct",
  "fiveBarReturnPct",
  "closeLocationInRangePct",
  "microBreakStrengthPct",
]);

const PERCENT_SANITY_RULES: Record<PercentLikeField, { min: number; max: number; note?: string }> = {
  movePct: { min: 0, max: 50 },
  projectedMovePct: { min: 0, max: 50 },
  pnlPct: { min: -20, max: 50 },
  mfePct: { min: 0, max: 50 },
  maePct: { min: -20, max: 0, note: "MAE uses a negative adverse-move convention." },
  slPct: { min: 0, max: 20 },
  trailingActivationPct: { min: 0, max: 20 },
  trailingDistancePct: { min: 0, max: 20 },
  pullbackPct: { min: 0, max: 20 },
  recoveryFromLastCrashPct: { min: -50, max: 50 },
  priceDistanceFromLastCrashLowPct: { min: -50, max: 50 },
  priceVsEma20Pct: { min: -50, max: 50 },
  priceVsEma50Pct: { min: -50, max: 50 },
  priceVsEma200Pct: { min: -50, max: 50 },
  oneBarReturnPct: { min: -20, max: 20 },
  threeBarReturnPct: { min: -30, max: 30 },
  fiveBarReturnPct: { min: -50, max: 50 },
  closeLocationInRangePct: { min: 0, max: 100 },
  microBreakStrengthPct: { min: -20, max: 20 },
};

function inferDefaultUnit(field: PercentLikeField, sourceHint?: EliteSynthesisPercentFieldUnit["inferredSourceUnit"]): EliteSynthesisPercentFieldUnit["inferredSourceUnit"] {
  if (sourceHint) return sourceHint;
  return DEFAULT_PERCENT_POINT_FIELDS.has(field) ? "percentage_points" : "percentage_points";
}

function normalizePercentField(
  field: PercentLikeField,
  raw: number | null | undefined,
  options?: {
    sourceHint?: EliteSynthesisPercentFieldUnit["inferredSourceUnit"];
    reason?: string;
    confidence?: EliteSynthesisPercentFieldUnit["confidence"];
  },
): SynthesisPercentFieldMeta {
  const numeric = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  const inferredSourceUnit = inferDefaultUnit(field, options?.sourceHint);
  const pctPoints = numeric == null ? null : inferredSourceUnit === "fraction" ? numeric * 100 : numeric;
  return {
    raw: numeric,
    pctPoints,
    unit: inferredSourceUnit,
    confidence: options?.confidence ?? (options?.sourceHint ? "source_metadata" : "field_default"),
    reason: options?.reason
      ?? (inferredSourceUnit === "fraction"
        ? `CRASH300 ${field} source is stored as fraction and normalised to percentage points.`
        : `CRASH300 ${field} defaults to percentage_points for synthesis validation.`),
  };
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

function canonicalMoveSizeBucketFromLabel(label: string | null | undefined): Crash300MoveSizeBucket | null {
  const value = String(label ?? "").trim();
  if (!value) return null;
  const match = value.match(/(5_to_6_pct|6_to_8_pct|8_to_10_pct|10_plus_pct)/);
  return (match?.[1] as Crash300MoveSizeBucket | undefined) ?? null;
}

function directionFromMove(move: SynthesisMoveRecord): "buy" | "sell" {
  return move.direction === "down" ? "sell" : "buy";
}

function asTradeDirection(value: string | null | undefined): "buy" | "sell" | "unknown" {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "buy" || normalized === "up") return "buy";
  if (normalized === "sell" || normalized === "down") return "sell";
  return "unknown";
}

function buildOffsetLabel(offsetBars: number) {
  return `T${offsetBars >= 0 ? "+" : ""}${offsetBars}`;
}

function pctDeltaPoints(direction: "buy" | "sell", entryPrice: number, price: number): number {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(price)) return 0;
  const raw = ((price - entryPrice) / entryPrice) * 100;
  return direction === "buy" ? raw : -raw;
}

function findEntryCandleIndex(candles: CandleRow[], targetTs: number): number {
  let lastBefore = -1;
  for (let index = 0; index < candles.length; index += 1) {
    const closeTs = candles[index]?.closeTs ?? 0;
    if (closeTs === targetTs) return index;
    if (closeTs < targetTs) {
      lastBefore = index;
      continue;
    }
    return lastBefore >= 0 ? lastBefore : index;
  }
  return lastBefore;
}

function winnersFromSubset(subset: SynthesisTradeRecord[]) {
  return subset.filter((trade) => trade.pnlPct > 0);
}

function exitSubsetStats(subset: SynthesisTradeRecord[]) {
  const winners = winnersFromSubset(subset);
  const mfeValues = winners
    .map((trade) => Math.abs(trade.mfePctPoints ?? trade.mfePct ?? 0))
    .filter((value) => Number.isFinite(value) && value > 0);
  const maeValues = winners
    .map((trade) => Math.abs(trade.maePctPoints ?? trade.maePct ?? 0))
    .filter((value) => Number.isFinite(value) && value > 0);
  return {
    candidateCount: subset.length,
    winnerCount: winners.length,
    mfeRange: rangeOf(mfeValues),
    maeAbsRange: rangeOf(maeValues),
  };
}

function buildSyntheticExitTradeFromMove(params: {
  move: SynthesisMoveRecord;
  runtimeFamily: string;
  selectedBucket: string | null;
  selectedMoveSizeBucket: Crash300MoveSizeBucket | null;
  direction: "buy" | "sell";
}): SynthesisTradeRecord | null {
  const mfePctPoints = Math.abs(params.move.realisticMfeAfterEntryPctPoints ?? params.move.realisticMfeAfterEntry ?? 0);
  const maeAbsPctPoints = Math.abs(params.move.normalMaeBeforeSuccessPctPoints ?? params.move.normalMaeBeforeSuccess ?? 0);
  if (mfePctPoints <= 0 || maeAbsPctPoints <= 0) return null;
  const selectedBucket = params.selectedBucket
    ?? params.move.phaseDerivedBucket
    ?? params.move.calibratedMoveSizeBucket
    ?? params.selectedMoveSizeBucket;
  return {
    kind: "runtime_trade",
    tradeId: `synthetic_move_${params.move.moveId}`,
    entryTs: params.move.startTs,
    exitTs: params.move.endTs,
    direction: params.direction,
    runtimeFamily: params.runtimeFamily,
    selectedBucket,
    triggerTransition: canonicalTriggerTransitionFromFamily(params.runtimeFamily),
    setupMatch: null,
    confidence: null,
    triggerStrengthScore: null,
    qualityTier: params.move.qualityTier ?? null,
    regimeAtEntry: null,
    contextAgeBars: null,
    triggerAgeBars: null,
    epochAgeBars: null,
    projectedMovePct: mfePctPoints,
    projectedMovePctPoints: mfePctPoints,
    slPct: maeAbsPctPoints,
    slPctPoints: maeAbsPctPoints,
    trailingActivationPct: null,
    trailingActivationPctPoints: null,
    trailingDistancePct: null,
    trailingDistancePctPoints: null,
    pnlPct: mfePctPoints,
    pnlPctPoints: mfePctPoints,
    mfePct: mfePctPoints,
    mfePctPoints,
    maePct: -maeAbsPctPoints,
    maePctPoints: -maeAbsPctPoints,
    exitReason: "synthetic_calibrated_subset",
    modelSource: "calibrated_move_subset",
    runtimeEvidence: null,
    matchedMoveIdStrict: params.move.moveId,
    strictRelationshipLabel: "synthetic_calibrated_subset",
    phantomNoiseLabel: null,
    enteredTooEarly: false,
    enteredTooLate: false,
    targetUnrealisticForBucket: false,
    trailingTooEarly: false,
    slTooTight: false,
    liveSafeFeatures: {
      source: "calibrated_move_subset",
      calibratedMoveId: params.move.moveId,
      calibratedMoveSizeBucket: params.move.calibratedMoveSizeBucket,
      phaseDerivedBucket: params.move.phaseDerivedBucket ?? null,
    },
  };
}

function buildExitLookupKeySummary(params: {
  runtimeFamily: string;
  selectedMoveSizeBucket: Crash300MoveSizeBucket;
  triggerTransition: string;
  direction: "buy" | "sell";
  selectedBucket: string | null;
}) {
  return {
    exact: `family=${params.runtimeFamily}|bucket=${params.selectedMoveSizeBucket}|direction=${params.direction}`,
    familyBucket: `family=${params.runtimeFamily}|bucket=${params.selectedMoveSizeBucket}`,
    triggerBucket: `trigger=${params.triggerTransition}|bucket=${params.selectedMoveSizeBucket}`,
    fullBucket: params.selectedBucket ? `selected_bucket=${params.selectedBucket}` : null,
    bucketDirection: `bucket=${params.selectedMoveSizeBucket}|direction=${params.direction}`,
    familyDefault: `family=${params.runtimeFamily}`,
    broadDefault: `service=${SYMBOL}|bucket=${params.selectedMoveSizeBucket}|direction=${params.direction}|broad_calibrated_default`,
  };
}

type ExitLookupSource =
  | "exact_subset"
  | "family_bucket_subset"
  | "trigger_bucket_subset"
  | "bucket_subset"
  | "bucket_direction_subset"
  | "family_default"
  | "broad_calibrated_default";

type ExitSubsetLookupResult = {
  subset: SynthesisTradeRecord[];
  source: ExitLookupSource | null;
  widenedFrom: string | null;
  widenedTo: string | null;
  availableExitLookupKeysTried: string[];
  exitSubsetCandidateCount: number;
  exitSubsetWinnerCount: number;
  exitSubsetMfeRange: { min: number | null; max: number | null };
  exitSubsetMaeAbsRange: { min: number | null; max: number | null };
  exitRuleRejectReason: string | null;
};

function buildNoTradeCandidate(params: {
  move: SynthesisMoveRecord;
  candidateId: string;
  offsetBars: number;
  entryTs: number;
  reason: string;
  rejectionReasons?: string[];
  runtimeFamily?: string | null;
  rawRuntimeFamily?: string | null;
  selectedBucket?: string | null;
  selectedMoveSizeBucket?: string | null;
  triggerTransition?: string | null;
  rawTriggerTransition?: string | null;
  triggerDirection?: string | null;
  rawTriggerDirection?: string | null;
  canonicalDirection?: "buy" | "sell" | "unknown";
  liveSafeFeatures?: Record<string, number | string | boolean | null>;
  projectedMovePct?: number | null;
  percentFields?: Record<string, SynthesisPercentFieldMeta>;
  entryCandleFound?: boolean;
  entryPrice?: number | null;
  featureSnapshotPresent?: boolean;
  featureSnapshotLiveSafe?: boolean;
  exitRulesPresent?: boolean;
  availableExitLookupKeysTried?: string[];
  exitSubsetCandidateCount?: number | null;
  exitSubsetWinnerCount?: number | null;
  exitSubsetMfeRange?: { min: number | null; max: number | null } | null;
  exitSubsetMaeAbsRange?: { min: number | null; max: number | null } | null;
  exitRuleRejectReason?: string | null;
  exitRuleSource?: string | null;
  exitRuleWidenedFrom?: string | null;
  exitRuleWidenedTo?: string | null;
}): SynthesisRebuiltTriggerCandidateRecord {
  const inferredDirection = asTradeDirection(params.triggerDirection);
  const candidateDirection: "buy" | "sell" | "unknown" = inferredDirection;
  return {
    kind: "rebuilt_trigger_candidate",
    candidateId: params.candidateId,
    moveId: params.move.moveId,
    matchedCalibratedMoveId: params.move.moveId,
    sourcePool: "rebuilt_trigger_candidates",
    sourceMoveStartTs: params.move.startTs,
    sourceMoveEndTs: params.move.endTs,
    entryTs: params.entryTs,
    exitTs: null,
    entryCandleFound: params.entryCandleFound ?? false,
    entryPrice: params.entryPrice ?? null,
    exitPrice: null,
    offsetLabel: buildOffsetLabel(params.offsetBars),
    offsetBars: params.offsetBars,
    direction: candidateDirection,
    canonicalDirection: params.canonicalDirection ?? inferredDirection,
    runtimeFamily: params.runtimeFamily ?? null,
    rawRuntimeFamily: params.rawRuntimeFamily ?? params.runtimeFamily ?? null,
    selectedBucket: params.selectedBucket ?? null,
    selectedMoveSizeBucket: params.selectedMoveSizeBucket ?? canonicalMoveSizeBucketFromLabel(params.selectedBucket) ?? canonicalMoveSizeBucketFromLabel(params.move.calibratedMoveSizeBucket),
    triggerTransition: params.triggerTransition ?? null,
    rawTriggerTransition: params.rawTriggerTransition ?? params.triggerTransition ?? null,
    triggerDirection: params.triggerDirection ?? null,
    rawTriggerDirection: params.rawTriggerDirection ?? params.triggerDirection ?? null,
    qualityTier: params.move.qualityTier,
    featureSnapshotPresent: params.featureSnapshotPresent ?? false,
    featureSnapshotLiveSafe: params.featureSnapshotLiveSafe ?? false,
    exitRulesPresent: params.exitRulesPresent ?? false,
    setupMatch: null,
    confidence: null,
    triggerStrengthScore: null,
    projectedMovePct: params.projectedMovePct ?? Math.abs(params.move.realisticMfeAfterEntry ?? params.move.movePct ?? 0),
    projectedMovePctPoints: params.projectedMovePct ?? Math.abs(params.move.realisticMfeAfterEntry ?? params.move.movePct ?? 0),
    slPct: null,
    slPctPoints: null,
    trailingActivationPct: null,
    trailingActivationPctPoints: null,
    trailingDistancePct: null,
    trailingDistancePctPoints: null,
    minHoldBars: null,
    pnlPct: 0,
    pnlPctPoints: 0,
    mfePct: null,
    mfePctPoints: null,
    maePct: null,
    maePctPoints: null,
    exitReason: null,
    simulatedTrade: false,
    eligible: false,
    rejectReason: params.reason,
    noTradeReason: params.reason,
    rejectionReasons: params.rejectionReasons ?? [params.reason],
    availableExitLookupKeysTried: params.availableExitLookupKeysTried,
    exitSubsetCandidateCount: params.exitSubsetCandidateCount ?? null,
    exitSubsetWinnerCount: params.exitSubsetWinnerCount ?? null,
    exitSubsetMfeRange: params.exitSubsetMfeRange ?? null,
    exitSubsetMaeAbsRange: params.exitSubsetMaeAbsRange ?? null,
    exitRuleRejectReason: params.exitRuleRejectReason ?? null,
    exitRuleSource: params.exitRuleSource ?? null,
    exitRuleWidenedFrom: params.exitRuleWidenedFrom ?? null,
    exitRuleWidenedTo: params.exitRuleWidenedTo ?? null,
    percentFields: params.percentFields,
    liveSafeFeatures: {
      ...params.move.liveSafeFeatures,
      availableExitLookupKeysTried: (params.availableExitLookupKeysTried ?? []).join(" || "),
      exitSubsetCandidateCount: params.exitSubsetCandidateCount ?? null,
      exitSubsetWinnerCount: params.exitSubsetWinnerCount ?? null,
      exitSubsetMfeMin: params.exitSubsetMfeRange?.min ?? null,
      exitSubsetMfeMax: params.exitSubsetMfeRange?.max ?? null,
      exitSubsetMaeAbsMin: params.exitSubsetMaeAbsRange?.min ?? null,
      exitSubsetMaeAbsMax: params.exitSubsetMaeAbsRange?.max ?? null,
      exitRuleRejectReason: params.exitRuleRejectReason ?? null,
      exitRuleSource: params.exitRuleSource ?? null,
      exitRuleWidenedFrom: params.exitRuleWidenedFrom ?? null,
      exitRuleWidenedTo: params.exitRuleWidenedTo ?? null,
      ...(params.liveSafeFeatures ?? {}),
    },
  };
}

function simulateCandidateTrade(params: {
  candles: CandleRow[];
  entryIndex: number;
  move: SynthesisMoveRecord;
  direction: "buy" | "sell";
  tpPctPoints: number;
  slPctPoints: number;
  trailingActivationPctPoints: number;
  trailingDistancePctPoints: number;
  minHoldBars: number;
  maxExitTs: number;
}): {
  exitIndex: number | null;
  exitReason: string | null;
  pnlPctPoints: number;
  mfePctPoints: number;
  maePctPoints: number;
  exitPrice: number | null;
  noTradeReason: string | null;
} {
  const entryCandle = params.candles[params.entryIndex];
  const entryPrice = entryCandle?.close;
  if (!entryCandle || !Number.isFinite(entryPrice) || entryPrice <= 0) {
    return {
      exitIndex: null,
      exitReason: null,
      pnlPctPoints: 0,
      mfePctPoints: 0,
      maePctPoints: 0,
      exitPrice: null,
      noTradeReason: "missing_entry_price",
    };
  }

  if (params.entryIndex >= params.candles.length - 1) {
    return {
      exitIndex: null,
      exitReason: null,
      pnlPctPoints: 0,
      mfePctPoints: 0,
      maePctPoints: 0,
      exitPrice: null,
      noTradeReason: "no_forward_candles",
    };
  }

  let bestFavourable = 0;
  let worstAdverse = 0;
  let trailingArmed = false;
  let trailingStopPct: number | null = null;

  for (let index = params.entryIndex + 1; index < params.candles.length; index += 1) {
    const candle = params.candles[index];
    if (!candle) continue;
    if (candle.closeTs > params.maxExitTs) {
      const pnlAtWindowEnd = pctDeltaPoints(params.direction, entryPrice, candle.close);
      return {
        exitIndex: index,
        exitReason: "window_end",
        pnlPctPoints: Number(pnlAtWindowEnd.toFixed(4)),
        mfePctPoints: Number(bestFavourable.toFixed(4)),
        maePctPoints: Number((-Math.abs(worstAdverse)).toFixed(4)),
        exitPrice: candle.close,
        noTradeReason: null,
      };
    }

    const favourableHigh = pctDeltaPoints(params.direction, entryPrice, params.direction === "buy" ? candle.high : candle.low);
    const adverseLow = pctDeltaPoints(params.direction, entryPrice, params.direction === "buy" ? candle.low : candle.high);
    bestFavourable = Math.max(bestFavourable, favourableHigh);
    worstAdverse = Math.max(worstAdverse, Math.abs(Math.min(adverseLow, 0)));

    if (params.slPctPoints > 0 && adverseLow <= -params.slPctPoints) {
      const exitPrice = params.direction === "buy"
        ? entryPrice * (1 - params.slPctPoints / 100)
        : entryPrice * (1 + params.slPctPoints / 100);
      return {
        exitIndex: index,
        exitReason: "sl_hit",
        pnlPctPoints: Number((-params.slPctPoints).toFixed(4)),
        mfePctPoints: Number(bestFavourable.toFixed(4)),
        maePctPoints: Number((-Math.abs(worstAdverse)).toFixed(4)),
        exitPrice,
        noTradeReason: null,
      };
    }

    if (params.tpPctPoints > 0 && favourableHigh >= params.tpPctPoints) {
      const exitPrice = params.direction === "buy"
        ? entryPrice * (1 + params.tpPctPoints / 100)
        : entryPrice * (1 - params.tpPctPoints / 100);
      return {
        exitIndex: index,
        exitReason: "tp_hit",
        pnlPctPoints: Number(params.tpPctPoints.toFixed(4)),
        mfePctPoints: Number(bestFavourable.toFixed(4)),
        maePctPoints: Number((-Math.abs(worstAdverse)).toFixed(4)),
        exitPrice,
        noTradeReason: null,
      };
    }

    if (params.trailingActivationPctPoints > 0 && bestFavourable >= params.trailingActivationPctPoints) {
      trailingArmed = true;
      trailingStopPct = Math.max(0, bestFavourable - params.trailingDistancePctPoints);
    }

    if (trailingArmed && trailingStopPct != null && index - params.entryIndex >= params.minHoldBars) {
      if (adverseLow <= trailingStopPct) {
        const exitPrice = params.direction === "buy"
          ? entryPrice * (1 + trailingStopPct / 100)
          : entryPrice * (1 - trailingStopPct / 100);
        return {
          exitIndex: index,
          exitReason: "trailing_exit",
          pnlPctPoints: Number(trailingStopPct.toFixed(4)),
          mfePctPoints: Number(bestFavourable.toFixed(4)),
          maePctPoints: Number((-Math.abs(worstAdverse)).toFixed(4)),
          exitPrice,
          noTradeReason: null,
        };
      }
    }
  }

  return {
    exitIndex: null,
    exitReason: null,
    pnlPctPoints: 0,
    mfePctPoints: Number(bestFavourable.toFixed(4)),
    maePctPoints: Number((-Math.abs(worstAdverse)).toFixed(4)),
    exitPrice: null,
    noTradeReason: "no_exit_found",
  };
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
  const liveSafeMoveDirection: "up" | "down" | "unknown" =
    semanticTrigger.triggerDirection === "buy"
      ? "up"
      : semanticTrigger.triggerDirection === "sell"
        ? "down"
        : semanticTrigger.microBreakDirection === "up"
          ? "up"
          : semanticTrigger.microBreakDirection === "down"
            ? "down"
            : semanticTrigger.oneBarReturnPct > 0
              ? "up"
              : semanticTrigger.oneBarReturnPct < 0
                ? "down"
                : "unknown";
  const family = deriveCrash300RuntimeFamilyWithSemantics({
    context: contextSnapshot,
    trigger: semanticTrigger,
    moveDirection: liveSafeMoveDirection,
  });
  const rawRuntimeFamily = family.familyFinal === "unknown" ? family.familyRaw : family.familyFinal;
  const rawTriggerTransition = semanticTrigger.triggerTransition;
  const familyFinal = family.familyFinal === "unknown"
    ? (canonicalFamilyFromTriggerTransition(rawTriggerTransition) ?? "unknown")
    : family.familyFinal;
  const triggerTransitionFinal = canonicalTriggerTransitionFromRawTransition(rawTriggerTransition)
    ?? canonicalTriggerTransitionFromFamily(familyFinal)
    ?? rawTriggerTransition;
  const bucket = deriveCrash300RuntimeBucket({
    family: familyFinal as Parameters<typeof deriveCrash300RuntimeBucket>[0]["family"],
    trigger: semanticTrigger,
    moveSizeBucket: bucketLabelFromPct((contextSnapshot.recoveryFromLastCrashPct ?? 0) * 100),
  });
  return {
    contextSnapshot,
    triggerSnapshot: {
      ...semanticTrigger,
      rawTriggerTransition,
      triggerTransition: triggerTransitionFinal,
    },
    rawRuntimeFamily,
    runtimeFamily: familyFinal,
    selectedBucket: bucket,
    liveSafeFeatures: {
      rawRuntimeFamily,
      runtimeFamily: familyFinal,
      selectedBucket: bucket,
      rawTriggerTransition,
      triggerTransition: triggerTransitionFinal,
      triggerDirection: semanticTrigger.triggerDirection,
      rawTriggerDirection: semanticTrigger.triggerDirection,
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

async function buildPhaseReport(params: {
  startTs: number;
  endTs: number;
  onProgress?: (update: DatasetBuildProgress) => Promise<void> | void;
  assertNotCancelled?: () => Promise<void> | void;
}) {
  return buildCrash300PhaseIdentifierReport({
    startTs: params.startTs,
    endTs: params.endTs,
    includeMoves: true,
    includeAggregates: true,
    onProgress: params.onProgress
      ? async (update) => {
        await params.onProgress?.({
          stage: "building_dataset",
          progressPct: typeof update.progressPct === "number" ? update.progressPct : 10,
          message: update.message,
        });
      }
      : undefined,
    assertNotCancelled: params.assertNotCancelled,
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
    const movePctMeta = normalizePercentField("movePct", optionalNumber(move.movePct), {
      sourceHint: "fraction",
      reason: "Detected-move magnitudes are stored as fractions in CRASH300 move rows.",
    });
    const normalMaeMeta = normalizePercentField("maePct", optionalNumber((phase.during as Record<string, unknown> | undefined)?.maePct), {
      sourceHint: "fraction",
      reason: "Phase-report MAE values are stored as fractions and normalised for synthesis.",
    });
    const realisticMfeMeta = normalizePercentField("mfePct", optionalNumber((phase.during as Record<string, unknown> | undefined)?.mfePct), {
      sourceHint: "fraction",
      reason: "Phase-report MFE values are stored as fractions and normalised for synthesis.",
    });
    const pullbackMeta = normalizePercentField("pullbackPct", optionalNumber((phase.after as Record<string, unknown> | undefined)?.pullbackPct), {
      sourceHint: "fraction",
      reason: "Phase-report pullback values are stored as fractions and normalised for synthesis.",
    });
    mapped.push({
      kind: "calibrated_move",
      moveId: Number(move.id ?? 0),
      startTs: Number(move.startTs ?? 0),
      endTs: Number(move.endTs ?? 0),
      direction: inferMoveDirection(move.direction),
      movePct: movePctMeta.pctPoints ?? 0,
      movePctPoints: movePctMeta.pctPoints ?? 0,
      qualityTier: String(move.qualityTier ?? "unknown"),
      calibratedBaseFamily: "crash_expansion",
      calibratedMoveSizeBucket: bucketLabelFromPct(Number(move.movePct ?? 0)),
      phaseDerivedFamily: String(phase.phaseDerivedFamilyFinal ?? phase.phaseDerivedFamily ?? "unknown"),
      phaseDerivedBucket: String(phase.phaseDerivedBucket ?? "unknown"),
      earliestValidLiveSafeTriggerOffset: (phase.trigger as Record<string, unknown> | undefined)?.firstValidTriggerOffset == null ? null : `T${Number((phase.trigger as Record<string, unknown>).firstValidTriggerOffset) >= 0 ? "+" : ""}${Number((phase.trigger as Record<string, unknown>).firstValidTriggerOffset)}`,
      bestTheoreticalLiveSafeTriggerOffset: (phase.trigger as Record<string, unknown> | undefined)?.strongestTriggerOffset == null ? null : `T${Number((phase.trigger as Record<string, unknown>).strongestTriggerOffset) >= 0 ? "+" : ""}${Number((phase.trigger as Record<string, unknown>).strongestTriggerOffset)}`,
      normalMaeBeforeSuccess: normalMaeMeta.pctPoints,
      normalMaeBeforeSuccessPctPoints: normalMaeMeta.pctPoints,
      realisticMfeAfterEntry: realisticMfeMeta.pctPoints,
      realisticMfeAfterEntryPctPoints: realisticMfeMeta.pctPoints,
      barsToMfe: asNumber((phase.during as Record<string, unknown> | undefined)?.barsToMfe, 0),
      pullbackAfterMfe: pullbackMeta.pctPoints,
      pullbackAfterMfePctPoints: pullbackMeta.pctPoints,
      percentFields: {
        movePct: movePctMeta,
        normalMaeBeforeSuccess: normalMaeMeta,
        realisticMfeAfterEntry: realisticMfeMeta,
        pullbackPct: pullbackMeta,
      },
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
    const contextSnapshot = asRecord(trade.contextSnapshotAtEntry);
    const triggerSnapshot = asRecord(trade.triggerSnapshotAtEntry);
    const runtimeFamily = optionalString(trade.runtimeFamily);
    const selectedBucket = optionalString(trade.selectedBucket);
    const triggerTransition = optionalString(trade.triggerTransition ?? trade.selectedTriggerTransition);
    const triggerDirection = optionalString(trade.triggerDirection)
      ?? (String(trade.direction ?? "").toLowerCase() === "sell" ? "sell" : String(trade.direction ?? "").toLowerCase() === "buy" ? "buy" : null);
    const projectedMovePctMeta = normalizePercentField("projectedMovePct", optionalNumber(trade.projectedMovePct), {
      sourceHint: "fraction",
      reason: "Persisted CRASH300 runtime trade projectedMovePct is stored as tp distance divided by entry price in the backtest runner.",
      confidence: "source_metadata",
    });
    const slPctMeta = normalizePercentField("slPct", optionalNumber(trade.slPct), {
      sourceHint: "fraction",
      reason: "Persisted CRASH300 runtime trade slPct is stored as stop-loss distance divided by entry price in the backtest runner.",
      confidence: "source_metadata",
    });
    const trailingActivationPctMeta = normalizePercentField("trailingActivationPct", optionalNumber(trade.trailingActivationPct), {
      sourceHint: "fraction",
      reason: "Persisted CRASH300 runtime trade trailingActivationPct is stored as a fractional TP-progress threshold in the backtest runner.",
      confidence: "source_metadata",
    });
    const trailingDistancePctMeta = normalizePercentField("trailingDistancePct", optionalNumber(trade.trailingDistancePct), {
      sourceHint: "fraction",
      reason: "Persisted CRASH300 runtime trade trailingDistancePct is stored as a fractional trailing distance in the backtest runner.",
      confidence: "source_metadata",
    });
    const mfePctMeta = normalizePercentField("mfePct", optionalNumber(trade.mfePct), {
      sourceHint: "fraction",
      reason: "Persisted CRASH300 runtime trade mfePct is stored as favorable price movement divided by entry price in the backtest runner.",
      confidence: "source_metadata",
    });
    const maePctMeta = normalizePercentField("maePct", optionalNumber(trade.maePct), {
      sourceHint: "fraction",
      reason: "Persisted CRASH300 runtime trade maePct is stored as negative adverse price movement divided by entry price in the backtest runner.",
      confidence: "source_metadata",
    });
    const pnlPctMeta = normalizePercentField("pnlPct", optionalNumber(trade.pnlPct), {
      sourceHint: "fraction",
      reason: "Persisted CRASH300 runtime trade pnlPct is stored as realised price return divided by entry price in the backtest runner.",
      confidence: "source_metadata",
    });
    const projectedMovePct = projectedMovePctMeta.pctPoints;
    const slPct = slPctMeta.pctPoints;
    const trailingActivationPct = trailingActivationPctMeta.pctPoints;
    const trailingDistancePct = trailingDistancePctMeta.pctPoints;
    const mfePct = mfePctMeta.pctPoints;
    const maePct = maePctMeta.pctPoints;
    const pnlPct = pnlPctMeta.pctPoints ?? 0;
    const setupMatch = optionalNumber(trade.setupMatch);
    const confidence = optionalNumber(trade.confidence);
    const triggerStrengthScore = optionalNumber(trade.triggerStrengthScore);
    const recoveryFromLastCrashPctMeta = normalizePercentField("recoveryFromLastCrashPct", optionalNumber(contextSnapshot.recoveryFromLastCrashPct));
    const priceDistanceFromLastCrashLowPctMeta = normalizePercentField("priceDistanceFromLastCrashLowPct", optionalNumber(contextSnapshot.priceDistanceFromLastCrashLowPct));
    const priceVsEma20PctMeta = normalizePercentField("priceVsEma20Pct", optionalNumber(contextSnapshot.priceVsEma20Pct));
    const priceVsEma50PctMeta = normalizePercentField("priceVsEma50Pct", optionalNumber(contextSnapshot.priceVsEma50Pct));
    const priceVsEma200PctMeta = normalizePercentField("priceVsEma200Pct", optionalNumber(contextSnapshot.priceVsEma200Pct));
    const oneBarReturnPctMeta = normalizePercentField("oneBarReturnPct", optionalNumber(triggerSnapshot.oneBarReturnPct));
    const threeBarReturnPctMeta = normalizePercentField("threeBarReturnPct", optionalNumber(triggerSnapshot.threeBarReturnPct));
    const fiveBarReturnPctMeta = normalizePercentField("fiveBarReturnPct", optionalNumber(triggerSnapshot.fiveBarReturnPct));
    const closeLocationInRangePctMeta = normalizePercentField("closeLocationInRangePct", optionalNumber(triggerSnapshot.closeLocationInRangePct));
    const microBreakStrengthPctMeta = normalizePercentField("microBreakStrengthPct", optionalNumber(triggerSnapshot.microBreakStrengthPct));
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
      projectedMovePctPoints: projectedMovePct,
      slPct,
      slPctPoints: slPct,
      trailingActivationPct,
      trailingActivationPctPoints: trailingActivationPct,
      trailingDistancePct,
      trailingDistancePctPoints: trailingDistancePct,
      pnlPct,
      pnlPctPoints: pnlPct,
      mfePct,
      mfePctPoints: mfePct,
      maePct,
      maePctPoints: maePct,
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
      percentFields: {
        projectedMovePct: projectedMovePctMeta,
        slPct: slPctMeta,
        trailingActivationPct: trailingActivationPctMeta,
        trailingDistancePct: trailingDistancePctMeta,
        mfePct: mfePctMeta,
        maePct: maePctMeta,
        pnlPct: pnlPctMeta,
        recoveryFromLastCrashPct: recoveryFromLastCrashPctMeta,
        priceDistanceFromLastCrashLowPct: priceDistanceFromLastCrashLowPctMeta,
        priceVsEma20Pct: priceVsEma20PctMeta,
        priceVsEma50Pct: priceVsEma50PctMeta,
        priceVsEma200Pct: priceVsEma200PctMeta,
        oneBarReturnPct: oneBarReturnPctMeta,
        threeBarReturnPct: threeBarReturnPctMeta,
        fiveBarReturnPct: fiveBarReturnPctMeta,
        closeLocationInRangePct: closeLocationInRangePctMeta,
        microBreakStrengthPct: microBreakStrengthPctMeta,
      },
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
        projectedMovePctPoints: projectedMovePct,
        slPct,
        slPctPoints: slPct,
        trailingActivationPct,
        trailingActivationPctPoints: trailingActivationPct,
        trailingDistancePct,
        trailingDistancePctPoints: trailingDistancePct,
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
        recoveryFromLastCrashPct: recoveryFromLastCrashPctMeta.pctPoints,
        recoveryFromLastCrashPctPoints: recoveryFromLastCrashPctMeta.pctPoints,
        priceDistanceFromLastCrashLowPct: priceDistanceFromLastCrashLowPctMeta.pctPoints,
        priceDistanceFromLastCrashLowPctPoints: priceDistanceFromLastCrashLowPctMeta.pctPoints,
        rangeCompressionScore60: optionalNumber(contextSnapshot.rangeCompressionScore60),
        rangeCompressionScore240: optionalNumber(contextSnapshot.rangeCompressionScore240),
        rangeExpansionScore15: optionalNumber(contextSnapshot.rangeExpansionScore15),
        rangeExpansionScore60: optionalNumber(contextSnapshot.rangeExpansionScore60),
        compressionToExpansionScore: optionalNumber(contextSnapshot.compressionToExpansionScore),
        atrRank60: optionalNumber(contextSnapshot.atrRank60),
        atrRank240: optionalNumber(contextSnapshot.atrRank240),
        bbWidthRank60: optionalNumber(contextSnapshot.bbWidthRank60),
        bbWidthRank240: optionalNumber(contextSnapshot.bbWidthRank240),
        priceVsEma20Pct: priceVsEma20PctMeta.pctPoints,
        priceVsEma20PctPoints: priceVsEma20PctMeta.pctPoints,
        priceVsEma50Pct: priceVsEma50PctMeta.pctPoints,
        priceVsEma50PctPoints: priceVsEma50PctMeta.pctPoints,
        priceVsEma200Pct: priceVsEma200PctMeta.pctPoints,
        priceVsEma200PctPoints: priceVsEma200PctMeta.pctPoints,
        oneBarReturnPct: oneBarReturnPctMeta.pctPoints,
        oneBarReturnPctPoints: oneBarReturnPctMeta.pctPoints,
        threeBarReturnPct: threeBarReturnPctMeta.pctPoints,
        threeBarReturnPctPoints: threeBarReturnPctMeta.pctPoints,
        fiveBarReturnPct: fiveBarReturnPctMeta.pctPoints,
        fiveBarReturnPctPoints: fiveBarReturnPctMeta.pctPoints,
        impulseScore: optionalNumber(triggerSnapshot.impulseScore),
        rejectionScore: optionalNumber(triggerSnapshot.rejectionScore),
        closeLocationInRangePct: closeLocationInRangePctMeta.pctPoints,
        closeLocationInRangePctPoints: closeLocationInRangePctMeta.pctPoints,
        microBreakDirection: optionalString(triggerSnapshot.microBreakDirection),
        microBreakStrengthPct: microBreakStrengthPctMeta.pctPoints,
        microBreakStrengthPctPoints: microBreakStrengthPctMeta.pctPoints,
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

function fieldUnitFromMeta(
  fieldName: string,
  metas: Array<SynthesisPercentFieldMeta | null | undefined>,
): EliteSynthesisPercentFieldUnit {
  const present = metas.find((meta) => meta != null && meta.unit != null) ?? null;
  if (!present) {
    return {
      inferredSourceUnit: "percentage_points",
      canonicalUnit: "percentage_points",
      confidence: "field_default",
      reason: `${fieldName} defaults to percentage_points for CRASH300 synthesis validation.`,
    };
  }
  return {
    inferredSourceUnit: present.unit,
    canonicalUnit: "percentage_points",
    confidence: present.confidence,
    reason: present.reason,
  };
}

function runUnitValidationRegressionCase() {
  const sample = {
    movePct: [5, 20.05],
    slPct: [2.52],
    mfePct: [0, 7.9],
    maePct: [-3.1, 0],
    pnlPct: [-2.52, 7.19],
  };
  const violations = Object.entries(sample).flatMap(([fieldName, values]) => {
    const rule = PERCENT_SANITY_RULES[fieldName as keyof typeof PERCENT_SANITY_RULES];
    if (!rule) return [];
    return values.filter((value) => value < rule.min || value > rule.max).map((value) => `${fieldName}=${value}`);
  });
  return {
    passed: violations.length === 0,
    note: violations.length === 0
      ? "Regression case passed: valid CRASH300 percentage-point ranges no longer trigger mixed-unit validation."
      : `Regression case failed for: ${violations.join(", ")}`,
  };
}

function runRuntimeTradeFractionRegressionCase() {
  const sample = {
    pnlPct: normalizePercentField("pnlPct", 0.0719, {
      sourceHint: "fraction",
      reason: "Regression check: persisted runtime trade pnlPct is stored as a raw return fraction.",
      confidence: "source_metadata",
    }),
    mfePct: normalizePercentField("mfePct", 0.078986, {
      sourceHint: "fraction",
      reason: "Regression check: persisted runtime trade mfePct is stored as a raw return fraction.",
      confidence: "source_metadata",
    }),
    maePct: normalizePercentField("maePct", -0.03145, {
      sourceHint: "fraction",
      reason: "Regression check: persisted runtime trade maePct is stored as a raw return fraction.",
      confidence: "source_metadata",
    }),
    slPct: normalizePercentField("slPct", 0.0252, {
      sourceHint: "fraction",
      reason: "Regression check: persisted runtime trade slPct is stored as a raw return fraction.",
      confidence: "source_metadata",
    }),
    projectedMovePct: normalizePercentField("projectedMovePct", 0.0719, {
      sourceHint: "fraction",
      reason: "Regression check: persisted runtime trade projectedMovePct is stored as a raw return fraction.",
      confidence: "source_metadata",
    }),
    trailingActivationPct: normalizePercentField("trailingActivationPct", 0.0252, {
      sourceHint: "fraction",
      reason: "Regression check: persisted runtime trade trailingActivationPct is stored as a raw return fraction.",
      confidence: "source_metadata",
    }),
    trailingDistancePct: normalizePercentField("trailingDistancePct", 0.0126, {
      sourceHint: "fraction",
      reason: "Regression check: persisted runtime trade trailingDistancePct is stored as a raw return fraction.",
      confidence: "source_metadata",
    }),
  };
  const expected = {
    pnlPct: 7.19,
    mfePct: 7.8986,
    maePct: -3.145,
    slPct: 2.52,
    projectedMovePct: 7.19,
    trailingActivationPct: 2.52,
    trailingDistancePct: 1.26,
  } satisfies Record<string, number>;
  const mismatches = Object.entries(sample).flatMap(([fieldName, meta]) => {
    const pctPoints = meta.pctPoints;
    const target = expected[fieldName as keyof typeof expected];
    return pctPoints == null || Math.abs(pctPoints - target) > 0.0001
      ? [`${fieldName} expected ${target} pct points but got ${pctPoints ?? "null"}`]
      : [];
  });
  return {
    passed: mismatches.length === 0,
    note: mismatches.length === 0
      ? "Regression case passed: persisted runtime trade fraction fields normalize to canonical percentage points."
      : `Runtime trade fraction regression failed for: ${mismatches.join(", ")}`,
  };
}

function exampleValues(
  metas: Array<SynthesisPercentFieldMeta | null | undefined>,
  selector: (meta: SynthesisPercentFieldMeta) => number | null,
): number[] {
  return metas
    .map((meta) => (meta ? selector(meta) : null))
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .slice(0, 5);
}

function buildUnitValidation(params: {
  moves: SynthesisMoveRecord[];
  trades: SynthesisTradeRecord[];
}): EliteSynthesisUnitValidation {
  const sampledRanges = {
    movePct: rangeOf(params.moves.map((move) => move.movePctPoints ?? move.movePct)),
    pnlPct: rangeOf(params.trades.map((trade) => trade.pnlPctPoints ?? trade.pnlPct)),
    mfePct: rangeOf(params.trades.map((trade) => trade.mfePctPoints ?? trade.mfePct)),
    maePct: rangeOf(params.trades.map((trade) => trade.maePctPoints ?? trade.maePct)),
    projectedMovePct: rangeOf(params.trades.map((trade) => trade.projectedMovePctPoints ?? trade.projectedMovePct)),
    slPct: rangeOf(params.trades.map((trade) => trade.slPctPoints ?? trade.slPct)),
    trailingActivationPct: rangeOf(params.trades.map((trade) => trade.trailingActivationPctPoints ?? trade.trailingActivationPct)),
    trailingDistancePct: rangeOf(params.trades.map((trade) => trade.trailingDistancePctPoints ?? trade.trailingDistancePct)),
  } satisfies Record<string, { min: number | null; max: number | null }>;
  const fieldWarnings: string[] = [];
  const fieldErrors: string[] = [];
  for (const [fieldName, range] of Object.entries(sampledRanges)) {
    const rule = PERCENT_SANITY_RULES[fieldName as PercentLikeField];
    if (!rule) continue;
    if (range.min != null && range.min < rule.min) {
      fieldErrors.push(`${fieldName} minimum ${range.min.toFixed(4)} is outside CRASH300 sanity range ${rule.min} to ${rule.max}.`);
    }
    if (range.max != null && range.max > rule.max) {
      fieldErrors.push(`${fieldName} maximum ${range.max.toFixed(4)} is outside CRASH300 sanity range ${rule.min} to ${rule.max}.`);
    }
    if (rule.note) {
      fieldWarnings.push(`${fieldName}: ${rule.note}`);
    }
  }
  const tpImpossibleTrades = params.trades.filter((trade) =>
    trade.projectedMovePctPoints != null &&
    trade.trailingActivationPctPoints != null &&
    trade.projectedMovePctPoints > 0 &&
    trade.trailingActivationPctPoints > trade.projectedMovePctPoints * 1.5,
  ).length;
  if (tpImpossibleTrades > 0) {
    fieldWarnings.push(`Detected ${tpImpossibleTrades} trades with trailing activation materially larger than projected move.`);
  }
  const regressionCase = runUnitValidationRegressionCase();
  const runtimeTradeFractionRegressionCase = runRuntimeTradeFractionRegressionCase();
  if (!regressionCase.passed) {
    fieldErrors.push(regressionCase.note);
  }
  if (!runtimeTradeFractionRegressionCase.passed) {
    fieldErrors.push(runtimeTradeFractionRegressionCase.note);
  }
  const fieldUnits: Record<string, EliteSynthesisPercentFieldUnit> = {
    movePct: fieldUnitFromMeta("movePct", params.moves.map((move) => move.percentFields?.movePct)),
    pnlPct: fieldUnitFromMeta("pnlPct", params.trades.map((trade) => trade.percentFields?.pnlPct)),
    mfePct: fieldUnitFromMeta("mfePct", params.trades.map((trade) => trade.percentFields?.mfePct)),
    maePct: fieldUnitFromMeta("maePct", params.trades.map((trade) => trade.percentFields?.maePct)),
    projectedMovePct: fieldUnitFromMeta("projectedMovePct", params.trades.map((trade) => trade.percentFields?.projectedMovePct)),
    slPct: fieldUnitFromMeta("slPct", params.trades.map((trade) => trade.percentFields?.slPct)),
    trailingActivationPct: fieldUnitFromMeta("trailingActivationPct", params.trades.map((trade) => trade.percentFields?.trailingActivationPct)),
    trailingDistancePct: fieldUnitFromMeta("trailingDistancePct", params.trades.map((trade) => trade.percentFields?.trailingDistancePct)),
  };
  const tradePercentMetas = params.trades.map((trade) => trade.percentFields ?? {});
  return {
    passed: fieldErrors.length === 0,
    unit: "percentage_points",
    canonicalUnit: "percentage_points",
    notes: [
      "Field-aware CRASH300 unit normalisation is active.",
      regressionCase.note,
      runtimeTradeFractionRegressionCase.note,
    ],
    fieldUnits,
    fieldWarnings,
    fieldErrors,
    sampledRanges,
    rawRuntimeTradeExamples: {
      pnlPct: exampleValues(tradePercentMetas.map((fields) => fields.pnlPct), (meta) => meta.raw),
      mfePct: exampleValues(tradePercentMetas.map((fields) => fields.mfePct), (meta) => meta.raw),
      maePct: exampleValues(tradePercentMetas.map((fields) => fields.maePct), (meta) => meta.raw),
      slPct: exampleValues(tradePercentMetas.map((fields) => fields.slPct), (meta) => meta.raw),
      projectedMovePct: exampleValues(tradePercentMetas.map((fields) => fields.projectedMovePct), (meta) => meta.raw),
      trailingActivationPct: exampleValues(tradePercentMetas.map((fields) => fields.trailingActivationPct), (meta) => meta.raw),
      trailingDistancePct: exampleValues(tradePercentMetas.map((fields) => fields.trailingDistancePct), (meta) => meta.raw),
    },
    canonicalRuntimeTradeExamples: {
      pnlPctPoints: exampleValues(tradePercentMetas.map((fields) => fields.pnlPct), (meta) => meta.pctPoints),
      mfePctPoints: exampleValues(tradePercentMetas.map((fields) => fields.mfePct), (meta) => meta.pctPoints),
      maePctPoints: exampleValues(tradePercentMetas.map((fields) => fields.maePct), (meta) => meta.pctPoints),
      slPctPoints: exampleValues(tradePercentMetas.map((fields) => fields.slPct), (meta) => meta.pctPoints),
      projectedMovePctPoints: exampleValues(tradePercentMetas.map((fields) => fields.projectedMovePct), (meta) => meta.pctPoints),
      trailingActivationPctPoints: exampleValues(tradePercentMetas.map((fields) => fields.trailingActivationPct), (meta) => meta.pctPoints),
      trailingDistancePctPoints: exampleValues(tradePercentMetas.map((fields) => fields.trailingDistancePct), (meta) => meta.pctPoints),
    },
    normalisationNotes: [
      "CRASH300 synthesis uses canonical percentage_points internally for all percent-like calculations.",
      "Small values such as 0.5 are treated as 0.5 percentage points unless source metadata says fraction.",
      "Persisted CRASH300 runtime trade percent fields are source fractions in the backtest runner and are multiplied by 100 into canonical percentage points.",
      "MFE stays positive favourable movement, MAE stays negative adverse movement, and SL uses positive absolute risk.",
    ],
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
  assertNotCancelled?: () => Promise<void> | void;
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
  await params.assertNotCancelled?.();
  await yieldToEventLoop();

  await emitDatasetBuildProgress(params.onProgress, {
    stage: "loading_data",
    progressPct: 4,
    message: "Loading persisted CRASH300 backtest run",
  });
  const persistedRun = await loadPersistedBacktestRun(params.backtestRunId);
  await params.assertNotCancelled?.();
  await yieldToEventLoop();

  await emitDatasetBuildProgress(params.onProgress, {
    stage: "building_dataset",
    progressPct: 6,
    message: "Loading 1m candle window once for synthesis dataset",
  });
  const candles = await loadWindowCandles(params.startTs - 240 * 60, params.endTs + 10 * 60);
  await params.assertNotCancelled?.();
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
  await params.assertNotCancelled?.();
  await yieldToEventLoop();

  await emitDatasetBuildProgress(params.onProgress, {
    stage: "building_dataset",
    progressPct: 10,
    message: "Building CRASH300 phase identifier report once for synthesis",
  });
  const phaseReport = await buildPhaseReport({
    startTs: params.startTs,
    endTs: params.endTs,
    onProgress: params.onProgress,
    assertNotCancelled: params.assertNotCancelled,
  });
  const phaseSnapshots = ((phaseReport.moves ?? []) as unknown as Array<Record<string, unknown>>) ?? [];
  await params.assertNotCancelled?.();
  await yieldToEventLoop();

  const moves = await mapMovesToSynthesisRecords({
    rows: moveRows as unknown as Array<Record<string, unknown>>,
    runtimeModel: promoted,
    candles,
    phaseMoves: phaseSnapshots,
    onProgress: params.onProgress,
  });
  await params.assertNotCancelled?.();
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
    onProgress: params.onProgress
      ? async (update) => {
        await params.onProgress?.({
          stage: "building_dataset",
          progressPct: typeof update.progressPct === "number" ? update.progressPct : 15,
          message: update.message,
        });
      }
      : undefined,
    assertNotCancelled: params.assertNotCancelled,
  });
  await params.assertNotCancelled?.();
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
  await params.assertNotCancelled?.();
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
  await params.assertNotCancelled?.();
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
      await params.assertNotCancelled?.();
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
    internalContext: {
      candles,
      runtimeModel: promoted,
      detectedMoves: detectedMoveRefs,
      windowStartTs: params.startTs,
      windowEndTs: params.endTs,
    },
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

  private collectCalibratedExitSubset(params: {
    dataset: UnifiedSynthesisDataset;
    runtimeFamily: string;
    selectedMoveSizeBucket: Crash300MoveSizeBucket;
    direction: "buy" | "sell";
    selectedBucket: string | null;
  }) {
    const synthetic = params.dataset.moves
      .map((move) => {
        const moveFamily =
          canonicalFamilyFromRawRuntimeFamily(move.phaseDerivedFamily ?? move.calibratedBaseFamily)
          ?? canonicalFamilyFromBucket(move.phaseDerivedBucket ?? move.calibratedMoveSizeBucket);
        const moveBucket = canonicalMoveSizeBucketFromLabel(move.phaseDerivedBucket ?? move.calibratedMoveSizeBucket);
        const moveDirection = directionFromMove(move);
        if (moveFamily !== params.runtimeFamily) return null;
        if (moveBucket !== params.selectedMoveSizeBucket) return null;
        if (moveDirection !== params.direction) return null;
        return buildSyntheticExitTradeFromMove({
          move,
          runtimeFamily: params.runtimeFamily,
          selectedBucket: params.selectedBucket ?? move.phaseDerivedBucket ?? move.calibratedMoveSizeBucket,
          selectedMoveSizeBucket: params.selectedMoveSizeBucket,
          direction: params.direction,
        });
      })
      .filter((trade): trade is SynthesisTradeRecord => Boolean(trade));
    return synthetic;
  }

  private findExitSubsetForRebuiltCandidate(params: {
    dataset: UnifiedSynthesisDataset;
    runtimeFamily: string;
    selectedMoveSizeBucket: Crash300MoveSizeBucket;
    triggerTransition: string;
    direction: "buy" | "sell";
    selectedBucket: string | null;
  }): ExitSubsetLookupResult {
    const keys = buildExitLookupKeySummary(params);
    const tried: string[] = [];
    const attempt = (
      source: ExitLookupSource,
      key: string | null,
      subsetFactory: () => SynthesisTradeRecord[],
    ): ExitSubsetLookupResult | null => {
      if (!key) return null;
      tried.push(key);
      const subset = subsetFactory();
      const stats = exitSubsetStats(subset);
      if (stats.candidateCount < MIN_EXIT_SUBSET_CANDIDATES || stats.winnerCount < MIN_EXIT_SUBSET_WINNERS) {
        return null;
      }
      return {
        subset,
        source,
        widenedFrom: keys.exact,
        widenedTo: key,
        availableExitLookupKeysTried: [...tried],
        exitSubsetCandidateCount: stats.candidateCount,
        exitSubsetWinnerCount: stats.winnerCount,
        exitSubsetMfeRange: stats.mfeRange,
        exitSubsetMaeAbsRange: stats.maeAbsRange,
        exitRuleRejectReason: null,
      };
    };

    const runtimeTrades = params.dataset.trades;
    const exact = attempt("exact_subset", keys.exact, () =>
      runtimeTrades.filter((trade) =>
        trade.runtimeFamily === params.runtimeFamily
        && canonicalMoveSizeBucketFromLabel(trade.selectedBucket) === params.selectedMoveSizeBucket
        && trade.direction === params.direction
      ),
    );
    if (exact) return exact;

    const familyBucket = attempt("family_bucket_subset", keys.familyBucket, () =>
      runtimeTrades.filter((trade) =>
        trade.runtimeFamily === params.runtimeFamily
        && canonicalMoveSizeBucketFromLabel(trade.selectedBucket) === params.selectedMoveSizeBucket
      ),
    );
    if (familyBucket) return familyBucket;

    const triggerBucket = attempt("trigger_bucket_subset", keys.triggerBucket, () =>
      runtimeTrades.filter((trade) =>
        trade.triggerTransition === params.triggerTransition
        && canonicalMoveSizeBucketFromLabel(trade.selectedBucket) === params.selectedMoveSizeBucket
      ),
    );
    if (triggerBucket) return triggerBucket;

    const fullBucket = attempt("bucket_subset", keys.fullBucket, () =>
      runtimeTrades.filter((trade) =>
        trade.selectedBucket === params.selectedBucket
      ),
    );
    if (fullBucket) return fullBucket;

    const bucketDirection = attempt("bucket_direction_subset", keys.bucketDirection, () =>
      runtimeTrades.filter((trade) =>
        canonicalMoveSizeBucketFromLabel(trade.selectedBucket) === params.selectedMoveSizeBucket
        && trade.direction === params.direction
      ),
    );
    if (bucketDirection) return bucketDirection;

    const familyDefault = attempt("family_default", keys.familyDefault, () =>
      runtimeTrades.filter((trade) =>
        trade.runtimeFamily === params.runtimeFamily
      ),
    );
    if (familyDefault) return familyDefault;

    const calibratedFallback = attempt("broad_calibrated_default", keys.broadDefault, () =>
      this.collectCalibratedExitSubset({
        dataset: params.dataset,
        runtimeFamily: params.runtimeFamily,
        selectedMoveSizeBucket: params.selectedMoveSizeBucket,
        direction: params.direction,
        selectedBucket: params.selectedBucket,
      }),
    );
    if (calibratedFallback) return calibratedFallback;

    const fallbackSubset = this.collectCalibratedExitSubset({
      dataset: params.dataset,
      runtimeFamily: params.runtimeFamily,
      selectedMoveSizeBucket: params.selectedMoveSizeBucket,
      direction: params.direction,
      selectedBucket: params.selectedBucket,
    });
    const fallbackStats = exitSubsetStats(fallbackSubset);
    const rejectReason = fallbackStats.candidateCount === 0
      ? "no_matching_exit_subset"
      : fallbackStats.winnerCount === 0
        ? "no_winning_exit_subset"
        : "exit_subset_too_small";
    return {
      subset: [],
      source: null,
      widenedFrom: keys.exact,
      widenedTo: null,
      availableExitLookupKeysTried: tried,
      exitSubsetCandidateCount: fallbackStats.candidateCount,
      exitSubsetWinnerCount: fallbackStats.winnerCount,
      exitSubsetMfeRange: fallbackStats.mfeRange,
      exitSubsetMaeAbsRange: fallbackStats.maeAbsRange,
      exitRuleRejectReason: rejectReason,
    };
  }

  async generateTriggerCandidatesFromMoveOffsets(dataset: UnifiedSynthesisDataset) {
    const internalContext = asRecord(dataset.internalContext);
    const candles = Array.isArray(internalContext.candles)
      ? (internalContext.candles as CandleRow[])
      : [];
    const runtimeModel = internalContext.runtimeModel as PromotedSymbolRuntimeModel | undefined;
    const detectedMoves = Array.isArray(internalContext.detectedMoves)
      ? (internalContext.detectedMoves as Array<{ id: number; startTs: number; endTs: number; direction: "up" | "down"; movePct: number }>)
      : [];
    const windowStartTs = asNumber(internalContext.windowStartTs, 0);
    const windowEndTs = asNumber(internalContext.windowEndTs, 0);
    const candidates: SynthesisRebuiltTriggerCandidateRecord[] = [];
    for (const move of dataset.moves) {
      for (const offsetBars of REBUILT_TRIGGER_OFFSETS) {
        const candidateId = `move-${move.moveId}-offset-${offsetBars}`;
        const entryTs = move.startTs + offsetBars * 60;
        if (!runtimeModel || candles.length === 0 || detectedMoves.length === 0) {
          candidates.push(buildNoTradeCandidate({ move, candidateId, offsetBars, entryTs, reason: "missing_entry_candle", rejectionReasons: ["missing_entry_candle"] }));
          continue;
        }
        if ((windowStartTs > 0 && entryTs < windowStartTs) || (windowEndTs > 0 && entryTs > windowEndTs)) {
          candidates.push(buildNoTradeCandidate({ move, candidateId, offsetBars, entryTs, reason: "outside_backtest_window", rejectionReasons: ["outside_backtest_window"] }));
          continue;
        }
        const entryIndex = findEntryCandleIndex(candles, entryTs);
        if (entryIndex < 0) {
          candidates.push(buildNoTradeCandidate({ move, candidateId, offsetBars, entryTs, reason: "missing_entry_candle", rejectionReasons: ["missing_entry_candle"] }));
          continue;
        }
        const entryCandle = candles[entryIndex];
        if (!entryCandle || !Number.isFinite(entryCandle.close) || entryCandle.close <= 0) {
          candidates.push(buildNoTradeCandidate({ move, candidateId, offsetBars, entryTs, reason: "missing_entry_price", rejectionReasons: ["missing_entry_price"], entryCandleFound: Boolean(entryCandle), entryPrice: entryCandle?.close ?? null }));
          continue;
        }

        const windowSlice = candles.slice(Math.max(0, entryIndex - 240), entryIndex + 1);
        const built = buildFeatureVectorFromContextTrigger({
          candles: windowSlice,
          ts: entryCandle.closeTs,
          runtimeModel,
          detectedMoves,
        });
        const rawTriggerTransition = optionalString((built.triggerSnapshot as Record<string, unknown>).rawTriggerTransition)
          ?? optionalString(built.triggerSnapshot.triggerTransition);
        const rawTriggerDirection = optionalString((built.liveSafeFeatures as Record<string, unknown>).rawTriggerDirection)
          ?? optionalString(built.triggerSnapshot.triggerDirection);
        const rawRuntimeFamily = optionalString((built as Record<string, unknown>).rawRuntimeFamily)
          ?? optionalString((built.liveSafeFeatures as Record<string, unknown>).rawRuntimeFamily)
          ?? optionalString(built.runtimeFamily);
        const selectedBucket = optionalString(built.selectedBucket);
        const selectedMoveSizeBucket = canonicalMoveSizeBucketFromLabel(selectedBucket)
          ?? canonicalMoveSizeBucketFromLabel(move.calibratedMoveSizeBucket);
        const semanticDirection = asTradeDirection(rawTriggerDirection);
        const microBreakDirection = String(built.liveSafeFeatures.microBreakDirection ?? "").toLowerCase();
        const oneBarReturnPct = optionalNumber(built.liveSafeFeatures.oneBarReturnPct);
        const threeBarReturnPct = optionalNumber(built.liveSafeFeatures.threeBarReturnPct);
        const fiveBarReturnPct = optionalNumber(built.liveSafeFeatures.fiveBarReturnPct);
        const shortReturnDirection =
          (oneBarReturnPct ?? 0) > 0 || (threeBarReturnPct ?? 0) > 0 || (fiveBarReturnPct ?? 0) > 0
            ? "buy"
            : (oneBarReturnPct ?? 0) < 0 || (threeBarReturnPct ?? 0) < 0 || (fiveBarReturnPct ?? 0) < 0
              ? "sell"
              : "unknown";
        const microBreakTradeDirection =
          microBreakDirection === "up"
            ? "buy"
            : microBreakDirection === "down"
              ? "sell"
              : "unknown";
        const canonicalDirection = semanticDirection !== "unknown"
          ? semanticDirection
          : microBreakTradeDirection !== "unknown"
            ? microBreakTradeDirection
            : shortReturnDirection;
        const canonicalFamilyFromRaw = canonicalFamilyFromRawRuntimeFamily(rawRuntimeFamily);
        const canonicalFamilyFromTransition = canonicalFamilyFromTriggerTransition(rawTriggerTransition);
        const canonicalFamilyFromBucketValue = canonicalFamilyFromBucket(selectedBucket);
        const inferredRuntimeFamily = optionalString(built.runtimeFamily);
        const runtimeFamily = canonicalFamilyFromRaw
          ?? (inferredRuntimeFamily && inferredRuntimeFamily !== "unknown"
            ? canonicalFamilyFromRawRuntimeFamily(inferredRuntimeFamily)
            : null)
          ?? canonicalFamilyFromTransition
          ?? canonicalFamilyFromBucketValue
          ?? canonicalFamilyFromLiveSafeEvidence({
            canonicalDirection,
            selectedBucket,
            canonicalTriggerTransition: canonicalTriggerTransitionFromRawTransition(rawTriggerTransition),
            contextSnapshot: built.contextSnapshot as unknown as Record<string, unknown>,
            liveSafeFeatures: built.liveSafeFeatures,
          });
        const triggerTransition = canonicalTriggerTransitionFromRawTransition(rawTriggerTransition)
          ?? canonicalTriggerTransitionFromFamily(runtimeFamily)
          ?? canonicalTriggerTransitionFromFamily(canonicalFamilyFromBucketValue)
          ?? null;
        const derivedFamilyDirection = runtimeFamily ? directionFromCrash300Family(runtimeFamily as never) : "unknown";
        const derivedBucketDirection = directionFromCrash300Bucket(selectedBucket);
        const directionCandidate = canonicalDirection !== "unknown"
          ? canonicalDirection
          : derivedFamilyDirection !== "unknown"
            ? derivedFamilyDirection
            : derivedBucketDirection !== "unknown"
              ? derivedBucketDirection
              : "unknown";
        const direction = directionCandidate === "buy" || directionCandidate === "sell"
          ? directionCandidate
          : null;
        const contextAgeBars = optionalNumber(built.liveSafeFeatures.contextAgeBars);
        const triggerAgeBars = optionalNumber(built.liveSafeFeatures.triggerAgeBars);
        const triggerStrengthScore = optionalNumber(built.liveSafeFeatures.triggerStrengthScore);
        const confidence = optionalNumber(built.liveSafeFeatures.confidence)
          ?? optionalNumber(built.liveSafeFeatures.runtimeEvidence)
          ?? (triggerStrengthScore != null ? Math.max(0, Math.min(1, triggerStrengthScore)) : null);
        const setupMatch = optionalNumber(built.liveSafeFeatures.setupMatch)
          ?? (triggerStrengthScore != null ? Math.max(0, Math.min(1, triggerStrengthScore * 0.9)) : null);
        const featureSnapshotPresent = Object.keys(built.liveSafeFeatures ?? {}).length > 0;
        const rejectionReasons: string[] = [];
        const liveSafeFeatures = {
          ...move.liveSafeFeatures,
          ...built.liveSafeFeatures,
          rawRuntimeFamily,
          rawTriggerTransition,
          rawTriggerDirection,
          canonicalDirection,
          canonicalRuntimeFamily: runtimeFamily,
          canonicalTriggerTransition: triggerTransition,
        };

        if (!featureSnapshotPresent) rejectionReasons.push("missing_feature_snapshot");
        if ((contextAgeBars ?? 0) > 240 || (triggerAgeBars ?? 0) > 12) rejectionReasons.push("stale_context");
        if (!runtimeFamily || runtimeFamily === "unknown" || !VALID_REBUILT_RUNTIME_ARCHETYPES.has(runtimeFamily)) rejectionReasons.push("invalid_archetype");
        if (!selectedBucket) rejectionReasons.push("invalid_bucket");
        if (!selectedMoveSizeBucket) rejectionReasons.push("missing_selected_move_size_bucket");
        if (!triggerTransition || triggerTransition === "none" || !VALID_REBUILT_TRIGGER_TRANSITIONS.has(triggerTransition)) rejectionReasons.push("invalid_trigger_transition");
        if (!direction) rejectionReasons.push("invalid_direction");
        if (direction && derivedFamilyDirection !== "unknown" && direction !== derivedFamilyDirection) rejectionReasons.push("direction_mismatch");
        if ((triggerStrengthScore ?? 0) <= 0 || (confidence ?? 0) <= 0 || (setupMatch ?? 0) <= 0) rejectionReasons.push("rejected_by_candidate_thresholds");
        if ((triggerStrengthScore ?? 0) <= 0.05) rejectionReasons.push("rejected_by_live_safe_filter");

        if (rejectionReasons.length > 0) {
          candidates.push(buildNoTradeCandidate({
            move,
            candidateId,
            offsetBars,
            entryTs,
            reason: rejectionReasons[0] ?? "rejected_by_live_safe_filter",
            rejectionReasons,
            runtimeFamily,
            rawRuntimeFamily,
            selectedBucket,
            selectedMoveSizeBucket,
            triggerTransition,
            rawTriggerTransition,
            triggerDirection: direction,
            rawTriggerDirection,
            canonicalDirection,
            liveSafeFeatures,
            entryCandleFound: true,
            entryPrice: entryCandle.close,
            featureSnapshotPresent,
            featureSnapshotLiveSafe: featureSnapshotPresent && !rejectionReasons.includes("rejected_by_live_safe_filter"),
            exitRulesPresent: false,
          }));
          continue;
        }
        const executableDirection = direction as "buy" | "sell";
        const executableRuntimeFamily = runtimeFamily as string;
        const executableMoveSizeBucket = selectedMoveSizeBucket as Crash300MoveSizeBucket;
        const executableTriggerTransition = triggerTransition as string;

        const exitLookup = this.findExitSubsetForRebuiltCandidate({
          dataset,
          runtimeFamily: executableRuntimeFamily,
          selectedMoveSizeBucket: executableMoveSizeBucket,
          triggerTransition: executableTriggerTransition,
          direction: executableDirection,
          selectedBucket,
        });
        const exitSubset = exitLookup.subset;
        if (exitSubset.length === 0) {
          candidates.push(buildNoTradeCandidate({
            move,
            candidateId,
            offsetBars,
            entryTs,
            reason: "missing_exit_rules",
            rejectionReasons: ["missing_exit_rules"],
            runtimeFamily,
            rawRuntimeFamily,
            selectedBucket,
            selectedMoveSizeBucket,
            triggerTransition,
            rawTriggerTransition,
            triggerDirection: direction,
            rawTriggerDirection,
            canonicalDirection,
            liveSafeFeatures,
            entryCandleFound: true,
            entryPrice: entryCandle.close,
            featureSnapshotPresent: true,
            featureSnapshotLiveSafe: true,
            availableExitLookupKeysTried: exitLookup.availableExitLookupKeysTried,
            exitSubsetCandidateCount: exitLookup.exitSubsetCandidateCount,
            exitSubsetWinnerCount: exitLookup.exitSubsetWinnerCount,
            exitSubsetMfeRange: exitLookup.exitSubsetMfeRange,
            exitSubsetMaeAbsRange: exitLookup.exitSubsetMaeAbsRange,
            exitRuleRejectReason: exitLookup.exitRuleRejectReason,
            exitRuleSource: exitLookup.source,
            exitRuleWidenedFrom: exitLookup.widenedFrom,
            exitRuleWidenedTo: exitLookup.widenedTo,
          }));
          continue;
        }
        const exitRules = this.deriveExitPolicyFromSubset(dataset, exitSubset as never);
        if (
          exitRules.exitUnitValidation.impossibleExitRejected
          || exitRules.tpTargetPct <= 0
          || exitRules.slRiskPct <= 0
          || exitRules.trailingActivationPct <= 0
          || exitRules.trailingDistancePct <= 0
        ) {
          candidates.push(buildNoTradeCandidate({
            move,
            candidateId,
            offsetBars,
            entryTs,
            reason: "impossible_exit_rejected",
            rejectionReasons: ["impossible_exit_rejected"],
            runtimeFamily,
            rawRuntimeFamily,
            selectedBucket,
            selectedMoveSizeBucket,
            triggerTransition,
            rawTriggerTransition,
            triggerDirection: direction,
            rawTriggerDirection,
            canonicalDirection,
            liveSafeFeatures,
            entryCandleFound: true,
            entryPrice: entryCandle.close,
            featureSnapshotPresent: true,
            featureSnapshotLiveSafe: true,
            exitRulesPresent: false,
            availableExitLookupKeysTried: exitLookup.availableExitLookupKeysTried,
            exitSubsetCandidateCount: exitLookup.exitSubsetCandidateCount,
            exitSubsetWinnerCount: exitLookup.exitSubsetWinnerCount,
            exitSubsetMfeRange: exitLookup.exitSubsetMfeRange,
            exitSubsetMaeAbsRange: exitLookup.exitSubsetMaeAbsRange,
            exitRuleRejectReason: "impossible_exit_rejected",
            exitRuleSource: exitLookup.source,
            exitRuleWidenedFrom: exitLookup.widenedFrom,
            exitRuleWidenedTo: exitLookup.widenedTo,
          }));
          continue;
        }

        const simulation = simulateCandidateTrade({
          candles,
          entryIndex,
          move,
          direction: executableDirection,
          tpPctPoints: exitRules.tpTargetPct,
          slPctPoints: exitRules.slRiskPct,
          trailingActivationPctPoints: exitRules.trailingActivationPct,
          trailingDistancePctPoints: exitRules.trailingDistancePct,
          minHoldBars: Math.max(1, exitRules.minHoldBars),
          maxExitTs: Math.min(windowEndTs || Number.MAX_SAFE_INTEGER, move.endTs + Math.max(3600, (move.barsToMfe ?? 12) * 120)),
        });
        const projectedMovePct = Math.abs(move.realisticMfeAfterEntryPctPoints ?? move.realisticMfeAfterEntry ?? move.movePctPoints ?? move.movePct);
        const projectedMovePctMeta = normalizePercentField("projectedMovePct", projectedMovePct, { sourceHint: "percentage_points", reason: "Rebuilt trigger projected move uses canonical move percentage points." });
        const slPctMeta = normalizePercentField("slPct", exitRules.slRiskPct, { sourceHint: "percentage_points", reason: "Rebuilt trigger SL uses canonical derived percentage points." });
        const trailingActivationPctMeta = normalizePercentField("trailingActivationPct", exitRules.trailingActivationPct, { sourceHint: "percentage_points", reason: "Rebuilt trigger trailing activation uses canonical derived percentage points." });
        const trailingDistancePctMeta = normalizePercentField("trailingDistancePct", exitRules.trailingDistancePct, { sourceHint: "percentage_points", reason: "Rebuilt trigger trailing distance uses canonical derived percentage points." });
        const pnlPctMeta = normalizePercentField("pnlPct", simulation.pnlPctPoints, { sourceHint: "percentage_points", reason: "Rebuilt trigger pnlPct uses candle-simulated canonical percentage points." });
        const mfePctMeta = normalizePercentField("mfePct", simulation.mfePctPoints, { sourceHint: "percentage_points", reason: "Rebuilt trigger MFE uses candle-simulated canonical percentage points." });
        const maePctMeta = normalizePercentField("maePct", simulation.maePctPoints, { sourceHint: "percentage_points", reason: "Rebuilt trigger MAE uses candle-simulated canonical percentage points." });
        const exitCandle = simulation.exitIndex != null ? candles[simulation.exitIndex] : null;
        const simulatedTrade = simulation.exitIndex != null && !simulation.noTradeReason;
        const noTradeReason = simulation.noTradeReason;
        const candidateRejectionReasons = simulatedTrade ? [] : [noTradeReason ?? "simulation_error"];
        candidates.push({
          kind: "rebuilt_trigger_candidate",
          candidateId,
          moveId: move.moveId,
          matchedCalibratedMoveId: move.moveId,
          sourcePool: "rebuilt_trigger_candidates",
          sourceMoveStartTs: move.startTs,
          sourceMoveEndTs: move.endTs,
          entryTs: entryCandle.closeTs,
          exitTs: exitCandle?.closeTs ?? null,
          entryCandleFound: true,
          entryPrice: entryCandle.close,
          exitPrice: simulation.exitPrice,
          offsetLabel: buildOffsetLabel(offsetBars),
          offsetBars,
          direction: executableDirection,
          canonicalDirection: executableDirection,
          runtimeFamily,
          rawRuntimeFamily,
          selectedBucket,
          selectedMoveSizeBucket,
          triggerTransition,
          rawTriggerTransition,
          triggerDirection: direction,
          rawTriggerDirection,
          qualityTier: move.qualityTier,
          featureSnapshotPresent: true,
          featureSnapshotLiveSafe: true,
          exitRulesPresent: true,
          setupMatch,
          confidence,
          triggerStrengthScore,
          projectedMovePct: projectedMovePctMeta.pctPoints,
          projectedMovePctPoints: projectedMovePctMeta.pctPoints,
          slPct: slPctMeta.pctPoints,
          slPctPoints: slPctMeta.pctPoints,
          trailingActivationPct: trailingActivationPctMeta.pctPoints,
          trailingActivationPctPoints: trailingActivationPctMeta.pctPoints,
          trailingDistancePct: trailingDistancePctMeta.pctPoints,
          trailingDistancePctPoints: trailingDistancePctMeta.pctPoints,
          minHoldBars: Math.max(1, exitRules.minHoldBars),
          pnlPct: pnlPctMeta.pctPoints ?? 0,
          pnlPctPoints: pnlPctMeta.pctPoints ?? 0,
          mfePct: mfePctMeta.pctPoints,
          mfePctPoints: mfePctMeta.pctPoints,
          maePct: maePctMeta.pctPoints,
          maePctPoints: maePctMeta.pctPoints,
          exitReason: simulation.exitReason,
          simulatedTrade,
          eligible: simulatedTrade,
          rejectReason: simulatedTrade ? null : noTradeReason ?? "simulation_error",
          noTradeReason,
          rejectionReasons: candidateRejectionReasons,
          availableExitLookupKeysTried: exitLookup.availableExitLookupKeysTried,
          exitSubsetCandidateCount: exitLookup.exitSubsetCandidateCount,
          exitSubsetWinnerCount: exitLookup.exitSubsetWinnerCount,
          exitSubsetMfeRange: exitLookup.exitSubsetMfeRange,
          exitSubsetMaeAbsRange: exitLookup.exitSubsetMaeAbsRange,
          exitRuleRejectReason: simulatedTrade ? null : noTradeReason ?? "simulation_error",
          exitRuleSource: exitLookup.source,
          exitRuleWidenedFrom: exitLookup.widenedFrom,
          exitRuleWidenedTo: exitLookup.widenedTo,
          percentFields: {
            projectedMovePct: projectedMovePctMeta,
            slPct: slPctMeta,
            trailingActivationPct: trailingActivationPctMeta,
            trailingDistancePct: trailingDistancePctMeta,
            pnlPct: pnlPctMeta,
            mfePct: mfePctMeta,
            maePct: maePctMeta,
          },
          liveSafeFeatures: {
            ...liveSafeFeatures,
            runtimeFamily,
            selectedBucket,
            selectedMoveSizeBucket,
            triggerTransition,
            triggerDirection: direction,
            rawTriggerDirection,
            qualityTier: move.qualityTier,
            setupMatch,
            confidence,
            projectedMovePct: projectedMovePctMeta.pctPoints,
            slPct: slPctMeta.pctPoints,
            trailingActivationPct: trailingActivationPctMeta.pctPoints,
            trailingDistancePct: trailingDistancePctMeta.pctPoints,
            projectedMoveToSlRatio: (slPctMeta.pctPoints ?? 0) > 0 ? (projectedMovePctMeta.pctPoints ?? 0) / (slPctMeta.pctPoints ?? 1) : null,
            projectedMoveToTrailingActivationRatio: (trailingActivationPctMeta.pctPoints ?? 0) > 0 ? (projectedMovePctMeta.pctPoints ?? 0) / (trailingActivationPctMeta.pctPoints ?? 1) : null,
            availableExitLookupKeysTried: exitLookup.availableExitLookupKeysTried.join(" || "),
            exitSubsetCandidateCount: exitLookup.exitSubsetCandidateCount,
            exitSubsetWinnerCount: exitLookup.exitSubsetWinnerCount,
            exitSubsetMfeMin: exitLookup.exitSubsetMfeRange.min,
            exitSubsetMfeMax: exitLookup.exitSubsetMfeRange.max,
            exitSubsetMaeAbsMin: exitLookup.exitSubsetMaeAbsRange.min,
            exitSubsetMaeAbsMax: exitLookup.exitSubsetMaeAbsRange.max,
            exitRuleSource: exitLookup.source,
            exitRuleWidenedFrom: exitLookup.widenedFrom,
            exitRuleWidenedTo: exitLookup.widenedTo,
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
    const exitValidation = asRecord(policy.tpRules.exitUnitValidation);
    if (sourcePool !== "rebuilt_trigger_candidates" && Boolean(exitValidation.impossibleExitRejected)) {
      return {
        policyId: policy.policyId,
        passNumber: policy.passNumberSelected,
        trades: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        slHits: 0,
        slHitRate: 0,
        profitFactor: 0,
        accountReturnPct: 0,
        maxDrawdownPct: 0,
        phantomCount: 0,
        objectiveScore: 0,
        selectedFeatures: policy.selectedCoreFeatures,
        selectedMoveSizeBuckets: policy.selectedMoveSizeBuckets,
        selectedRuntimeArchetypes: policy.selectedRuntimeArchetypes,
        selectedBuckets: policy.selectedBuckets,
        selectedTriggerTransitions: policy.selectedTriggerTransitions,
        entryThresholds: policy.entryThresholds,
        entryTimingRules: policy.entryTimingRules.map((rule) => ({ ...rule })),
        noTradeRules: [...policy.noTradeRules, "impossible_exit_rejected"],
        exitRules: this.deriveExitPolicyFromSubset(dataset, []),
        leakagePassed: policy.leakageAudit.passed,
        monthlyBreakdown: [],
        reasons: ["impossible_exit_rejected"],
        sourcePool,
        diagnostics: {
          simulatedTradeCount: 0,
          noTradeReasonCounts: { impossible_exit_rejected: 1 },
        },
        selectedFeaturesSummary: policy.selectedCoreFeatures.map((feature) => feature.key),
        tpSlTrailingSummary: ["policy_rejected: impossible exit scale"],
        targetAchieved: false,
      };
    }
    const selectedDirections = Array.isArray(policy.entryThresholds.selectedDirections)
      ? (policy.entryThresholds.selectedDirections as Array<"buy" | "sell">)
      : [];
    const offsetClusters = Array.isArray(policy.entryThresholds.offsetClusters)
      ? (policy.entryThresholds.offsetClusters as string[])
      : [];
    const eligible = sourcePool === "rebuilt_trigger_candidates"
      ? (() => {
          const rebuiltPool = dataset.rebuiltTriggerCandidates.filter((candidate) => candidate.eligible && candidate.simulatedTrade && !candidate.noTradeReason);
          const grouped = rebuiltPool.filter((candidate) => {
            const familyOk = policy.selectedRuntimeArchetypes.length === 0 || policy.selectedRuntimeArchetypes.includes(candidate.runtimeFamily ?? "unknown");
            const triggerOk = policy.selectedTriggerTransitions.length === 0 || policy.selectedTriggerTransitions.includes(candidate.triggerTransition ?? "none");
            const moveSizeOk = policy.selectedMoveSizeBuckets.length === 0 || policy.selectedMoveSizeBuckets.includes(candidate.selectedMoveSizeBucket ?? "unknown");
            const directionOk = selectedDirections.length === 0 || selectedDirections.includes(candidate.direction as "buy" | "sell");
            const clusterOk = offsetClusters.length === 0 || offsetClusters.includes(
              candidate.offsetLabel === "T-10" || candidate.offsetLabel === "T-5" || candidate.offsetLabel === "T-3"
                ? "early"
                : candidate.offsetLabel === "T-2" || candidate.offsetLabel === "T-1" || candidate.offsetLabel === "T0" || candidate.offsetLabel === "T+0" || candidate.offsetLabel === "T+1"
                  ? "trigger"
                  : candidate.offsetLabel === "T+2" || candidate.offsetLabel === "T+3" || candidate.offsetLabel === "T+5" || candidate.offsetLabel === "T+10"
                    ? "late"
                    : "unknown",
            );
            return familyOk && triggerOk && moveSizeOk && directionOk && clusterOk;
          });
          const candidatesBeforeDailyLimit = grouped.length;
          const perDay = new Map<string, SynthesisRebuiltTriggerCandidateRecord[]>();
          for (const candidate of grouped) {
            const dayKey = new Date(candidate.entryTs * 1000).toISOString().slice(0, 10);
            const bucket = perDay.get(dayKey) ?? [];
            bucket.push(candidate);
            perDay.set(dayKey, bucket);
          }
          const selected: SynthesisRebuiltTriggerCandidateRecord[] = [];
          for (const bucket of perDay.values()) {
            bucket.sort((a, b) => {
              const aScore = deterministicRebuiltCandidateScore(a);
              const bScore = deterministicRebuiltCandidateScore(b);
              return bScore - aScore;
            });
            const chosen = bucket[0];
            if (chosen) selected.push(chosen);
          }
          (policy.entryThresholds as Record<string, unknown>).candidatesBeforeDailyLimit = candidatesBeforeDailyLimit;
          (policy.entryThresholds as Record<string, unknown>).candidatesAfterDailyLimit = selected.length;
          (policy.entryThresholds as Record<string, unknown>).rejectedByDailyLimit = Math.max(0, candidatesBeforeDailyLimit - selected.length);
          return selected;
        })()
      : dataset.trades.filter((trade) => {
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
    const monthlyBreakdown = buildMonthlyBreakdown(eligible as Array<
      Pick<SynthesisTradeRecord, "entryTs" | "pnlPct" | "exitReason" | "selectedBucket">
      | Pick<SynthesisRebuiltTriggerCandidateRecord, "entryTs" | "pnlPct" | "exitReason" | "selectedBucket" | "offsetLabel">
    >);
    const selectedTradeIds = sourcePool === "rebuilt_trigger_candidates"
      ? (eligible as SynthesisRebuiltTriggerCandidateRecord[]).map((trade) => trade.candidateId)
      : (eligible as SynthesisTradeRecord[]).map((trade) => trade.tradeId);
    const noTradeReasonCounts = sourcePool === "rebuilt_trigger_candidates"
      ? dataset.rebuiltTriggerCandidates.reduce<Record<string, number>>((acc, candidate) => {
          const familyOk = policy.selectedRuntimeArchetypes.length === 0 || policy.selectedRuntimeArchetypes.includes(candidate.runtimeFamily ?? "unknown");
          const moveSizeOk = policy.selectedMoveSizeBuckets.length === 0 || policy.selectedMoveSizeBuckets.includes(candidate.selectedMoveSizeBucket ?? "unknown");
          const triggerOk = policy.selectedTriggerTransitions.length === 0 || policy.selectedTriggerTransitions.includes(candidate.triggerTransition ?? "none");
          if (!familyOk || !moveSizeOk || !triggerOk) return acc;
          const reason = candidate.noTradeReason ?? candidate.rejectReason;
          if (!reason) return acc;
          acc[reason] = (acc[reason] ?? 0) + 1;
          return acc;
        }, {})
      : {};
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
    if (sourcePool === "rebuilt_trigger_candidates" && eligible.length === 0) {
      const reasons = [
        "no_simulated_rebuilt_trades",
      ];
      return {
        policyId: policy.policyId,
        passNumber: policy.passNumberSelected,
        trades: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        slHits: 0,
        slHitRate: 0,
        profitFactor: 0,
        accountReturnPct: 0,
        maxDrawdownPct: 0,
        phantomCount: 0,
        objectiveScore: 0,
        selectedFeatures: policy.selectedCoreFeatures,
        selectedMoveSizeBuckets: policy.selectedMoveSizeBuckets,
        selectedRuntimeArchetypes: policy.selectedRuntimeArchetypes,
        selectedBuckets: policy.selectedBuckets,
        selectedTriggerTransitions: policy.selectedTriggerTransitions,
        entryThresholds: policy.entryThresholds,
        entryTimingRules: policy.entryTimingRules.map((rule) => ({ ...rule })),
        noTradeRules: [...policy.noTradeRules, "no_simulated_rebuilt_trades"],
        exitRules: {
          tpTargetPct: asNumber(policy.tpRules.targetPct, 0),
          slRiskPct: asNumber(policy.slRules.maxInitialRiskPct, 0),
          trailingActivationPct: asNumber(policy.trailingRules.activationProfitPct, 0),
          trailingDistancePct: asNumber(policy.trailingRules.trailingDistancePct, 0),
          minHoldBars: asNumber(policy.minHoldRules.minHoldBars, 0),
          unit: "percentage_points",
          exitUnitValidation: {
            selectedSubsetMfeRange: { min: null, max: null },
            selectedSubsetMaeAbsRange: { min: null, max: null },
            derivedTpPctPoints: asNumber(policy.tpRules.targetPct, 0),
            derivedSlPctPoints: asNumber(policy.slRules.maxInitialRiskPct, 0),
            derivedTrailingActivationPctPoints: asNumber(policy.trailingRules.activationProfitPct, 0),
            derivedTrailingDistancePctPoints: asNumber(policy.trailingRules.trailingDistancePct, 0),
            impossibleExitRejected: false,
            warnings: ["No simulated rebuilt trades survived grouping and daily selection."],
          },
        },
        leakagePassed: policy.leakageAudit.passed,
        monthlyBreakdown,
        reasons,
        sourcePool,
        diagnostics: {
          simulatedTradeCount: 0,
          noTradeReasonCounts,
          selectedTradeIds,
          selectedTradeCount: 0,
          selectedTradeSource: sourcePool === "rebuilt_trigger_candidates" ? "candidateId" : "tradeId",
          monthlyBreakdown,
        },
        selectedFeaturesSummary: policy.selectedCoreFeatures.map((feature) => feature.key),
        tpSlTrailingSummary: ["policy_rejected: no simulated rebuilt trades"],
        targetAchieved: false,
      };
    }
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
        unit: "percentage_points",
        exitUnitValidation: {
          selectedSubsetMfeRange: {
            min: optionalNumber(asRecord(policy.tpRules.exitUnitValidation).selectedSubsetMfeRange && asRecord(asRecord(policy.tpRules.exitUnitValidation).selectedSubsetMfeRange).min),
            max: optionalNumber(asRecord(policy.tpRules.exitUnitValidation).selectedSubsetMfeRange && asRecord(asRecord(policy.tpRules.exitUnitValidation).selectedSubsetMfeRange).max),
          },
          selectedSubsetMaeAbsRange: {
            min: optionalNumber(asRecord(policy.tpRules.exitUnitValidation).selectedSubsetMaeAbsRange && asRecord(asRecord(policy.tpRules.exitUnitValidation).selectedSubsetMaeAbsRange).min),
            max: optionalNumber(asRecord(policy.tpRules.exitUnitValidation).selectedSubsetMaeAbsRange && asRecord(asRecord(policy.tpRules.exitUnitValidation).selectedSubsetMaeAbsRange).max),
          },
          derivedTpPctPoints: asNumber(asRecord(policy.tpRules.exitUnitValidation).derivedTpPctPoints, 0),
          derivedSlPctPoints: asNumber(asRecord(policy.tpRules.exitUnitValidation).derivedSlPctPoints, 0),
          derivedTrailingActivationPctPoints: asNumber(asRecord(policy.tpRules.exitUnitValidation).derivedTrailingActivationPctPoints, 0),
          derivedTrailingDistancePctPoints: asNumber(asRecord(policy.tpRules.exitUnitValidation).derivedTrailingDistancePctPoints, 0),
          impossibleExitRejected: Boolean(asRecord(policy.tpRules.exitUnitValidation).impossibleExitRejected),
          warnings: Array.isArray(asRecord(policy.tpRules.exitUnitValidation).warnings)
            ? ((asRecord(policy.tpRules.exitUnitValidation).warnings as unknown[]) as string[])
            : [],
        },
      },
      leakagePassed: policy.leakageAudit.passed,
      monthlyBreakdown,
      reasons: [],
      sourcePool,
      diagnostics: {
        simulatedTradeCount: eligible.length,
        noTradeReasonCounts,
        selectedTradeIds,
        selectedTradeCount: eligible.length,
        selectedTradeSource: sourcePool === "rebuilt_trigger_candidates" ? "candidateId" : "tradeId",
        monthlyBreakdown,
        selectedTradeExitReasonCounts: eligible.reduce<Record<string, number>>((acc, trade) => {
          const key = trade.exitReason ?? "unknown";
          acc[key] = (acc[key] ?? 0) + 1;
          return acc;
        }, {}),
      },
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
    const winnerMaePct = winners.map((trade) => Math.abs(trade.maePctPoints ?? trade.maePct ?? 0)).filter((value) => value > 0);
    const winnerMfePct = winners.map((trade) => Math.abs(trade.mfePctPoints ?? trade.mfePct ?? 0)).filter((value) => value > 0);
    const derivedTpPctPoints = Number(Math.max(0.5, percentile(winnerMfePct, 0.5)).toFixed(2));
    const derivedSlPctPoints = Number(Math.max(0.35, percentile(winnerMaePct, 0.9)).toFixed(2));
    const derivedTrailingActivationPctPoints = Number(Math.max(0.4, percentile(winnerMfePct, 0.25)).toFixed(2));
    const derivedTrailingDistancePctPoints = Number(Math.max(0.25, percentile(winnerMaePct, 0.75)).toFixed(2));
    const warnings: string[] = [];
    if (winners.length === 0) warnings.push("Rejected exit derivation because no winning subset trades were available.");
    if (derivedTpPctPoints <= 0) warnings.push("Rejected TP because derived TP was not positive.");
    if (derivedSlPctPoints <= 0) warnings.push("Rejected SL because derived SL was not positive.");
    if (derivedTrailingActivationPctPoints <= 0) warnings.push("Rejected trailing activation because derived value was not positive.");
    if (derivedTrailingDistancePctPoints <= 0) warnings.push("Rejected trailing distance because derived value was not positive.");
    if (winnerMfePct.length > 0 && derivedTpPctPoints < Math.max(0.1, percentile(winnerMfePct, 0.1) * 0.25)) {
      warnings.push("Derived TP is materially below the selected subset MFE distribution.");
    }
    if (winnerMfePct.length > 0 && derivedTpPctPoints > Math.max(...winnerMfePct)) {
      warnings.push("Rejected TP because derived TP is larger than the observed winner MFE ceiling.");
    }
    if (winnerMfePct.length > 0 && winnerMaePct.length > 0 && derivedSlPctPoints > Math.max(...winnerMfePct)) {
      warnings.push("Rejected SL because derived SL is larger than the observed winner MFE ceiling.");
    }
    if (winnerMfePct.length > 0 && derivedSlPctPoints >= derivedTpPctPoints) {
      warnings.push("Rejected SL because derived SL is not smaller than derived TP.");
    }
    const impossibleExitRejected = warnings.some((warning) => warning.startsWith("Rejected"));
    return {
      tpTargetPct: derivedTpPctPoints,
      slRiskPct: derivedSlPctPoints,
      trailingActivationPct: derivedTrailingActivationPctPoints,
      trailingDistancePct: derivedTrailingDistancePctPoints,
      minHoldBars: Math.max(1, Math.round(average(winners.map((trade) => Math.max(1, ((trade.exitTs ?? trade.entryTs) - trade.entryTs) / 60))))),
      unit: "percentage_points",
      exitUnitValidation: {
        selectedSubsetMfeRange: rangeOf(winnerMfePct),
        selectedSubsetMaeAbsRange: rangeOf(winnerMaePct),
        selectedSubsetMfeRangePctPoints: rangeOf(winnerMfePct),
        selectedSubsetMaeAbsRangePctPoints: rangeOf(winnerMaePct),
        derivedTpPctPoints,
        derivedSlPctPoints,
        derivedTrailingActivationPctPoints,
        derivedTrailingDistancePctPoints,
        sourceValueExamples: {
          winnerMfePct: winnerMfePct.slice(0, 5),
          winnerMaeAbsPct: winnerMaePct.slice(0, 5),
        },
        canonicalValueExamples: {
          winnerMfePctPoints: winnerMfePct.slice(0, 5),
          winnerMaeAbsPctPoints: winnerMaePct.slice(0, 5),
        },
        impossibleExitRejected,
        warnings,
      },
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
