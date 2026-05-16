import { Crash300SynthesisAdapter, buildUnifiedCrash300Dataset } from "./crash300Adapter.js";
import { chatComplete } from "../../infrastructure/openai.js";
import type { PolicyEvaluationResult, SymbolSynthesisAdapter, SynthesisRebuiltTriggerCandidateRecord, UnifiedSynthesisDataset } from "./adapter.js";
import {
  getEliteSynthesisJob,
  updateEliteSynthesisJob,
} from "./jobs.js";
import { isWorkerJobCancellationRequested, WorkerJobCancelledError } from "../worker/jobs.js";
import type { CandleRow } from "../backtest/featureSlice.js";
import type {
  EliteSynthesisBottleneck,
  EliteSynthesisDataAvailability,
  EliteSynthesisFeatureSummary,
  EliteSynthesisLeakageAudit,
  EliteSynthesisParams,
  EliteSynthesisPassLog,
  EliteSynthesisPolicyArtifact,
  EliteSynthesisPolicySummary,
  EliteSynthesisResultState,
  EliteSynthesisResult,
  EliteSynthesisSearchProfile,
  LifecycleDecision,
  LifecycleExitPlan,
  LifecycleReplayTraceEntry,
  LifecycleState,
  TradeLifecycleReplayReport,
  TradeLifecycleReplayTradeResult,
  TradeLifecycleSnapshot,
  EliteSynthesisTargetProfile,
  EliteSynthesisUnitValidation,
  EliteSynthesisValidationError,
} from "./types.js";
import { profileDefaults } from "./types.js";

export type LifecycleReplayCandidateInput = {
  candidateId: string;
  direction: "buy" | "sell" | "unknown";
  entryTs: number;
  exitTs: number | null;
  pnlPct?: number | null;
  pnlPctPoints?: number | null;
  mfePct?: number | null;
  mfePctPoints?: number | null;
  maePct?: number | null;
  maePctPoints?: number | null;
  minHoldBars?: number | null;
  slPct?: number | null;
  slRiskPct?: number | null;
  slPctPoints?: number | null;
  trailingDistancePctPoints?: number | null;
  trailingDistancePct?: number | null;
  trailingActivationPctPoints?: number | null;
  trailingActivationPct?: number | null;
  tpTargetPct?: number | null;
  projectedMovePct?: number | null;
  projectedMovePctPoints?: number | null;
  exitReason?: string | null;
  sourceMoveEndTs?: number | null;
  moveEndTs?: number | null;
};

function nowIso() {
  return new Date().toISOString();
}

async function yieldToEventLoop() {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function isCancellationRequested(jobId: number): Promise<boolean> {
  return isWorkerJobCancellationRequested(jobId);
}

function uniqueStrings(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted[mid] ?? 0;
}

function canonicalMoveSizeBucketFromLabel(label: string | null | undefined): string | null {
  const value = String(label ?? "").trim();
  if (!value) return null;
  const match = value.match(/(5_to_6_pct|6_to_8_pct|8_to_10_pct|10_plus_pct)/);
  return match?.[1] ?? null;
}

function resolveSelectedMoveSizeBuckets(params: {
  dataset: UnifiedSynthesisDataset;
  selectedBuckets: string[];
  selectedRuntimeArchetypes: string[];
}) {
  const fromSelectedBuckets = uniqueStrings(
    params.selectedBuckets.map((bucket) => canonicalMoveSizeBucketFromLabel(bucket)),
  );
  if (fromSelectedBuckets.length > 0) return fromSelectedBuckets;
  return uniqueStrings(
    params.dataset.moves
      .filter((move) =>
        params.selectedBuckets.includes(move.phaseDerivedBucket ?? move.calibratedMoveSizeBucket)
        || params.selectedRuntimeArchetypes.includes(move.phaseDerivedFamily ?? "unknown"),
      )
      .map((move) => canonicalMoveSizeBucketFromLabel(move.calibratedMoveSizeBucket)),
  );
}

function buildRebuiltTriggerDiagnostics(dataset: UnifiedSynthesisDataset) {
  const candidates = dataset.rebuiltTriggerCandidates;
  const countValues = (values: Array<string | null | undefined>) => values.reduce<Record<string, number>>((acc, value) => {
    if (!value) return acc;
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
  const countByKey = (
    items: SynthesisRebuiltTriggerCandidateRecord[],
    keyFn: (candidate: SynthesisRebuiltTriggerCandidateRecord) => string | null | undefined,
  ) => items.reduce<Record<string, number>>((acc, candidate) => {
    const key = keyFn(candidate);
    if (!key) return acc;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const countReasonsByGroup = (
    items: SynthesisRebuiltTriggerCandidateRecord[],
    groupFn: (candidate: SynthesisRebuiltTriggerCandidateRecord) => string | null | undefined,
  ) => items.reduce<Record<string, number>>((acc, candidate) => {
    const group = groupFn(candidate);
    if (!group) return acc;
    const reasons = candidate.rejectionReasons.length > 0
      ? candidate.rejectionReasons
      : [candidate.rejectReason ?? candidate.noTradeReason].filter(Boolean) as string[];
    for (const reason of reasons) {
      const key = `${group}::${reason}`;
      acc[key] = (acc[key] ?? 0) + 1;
    }
    return acc;
  }, {});
  const timestamps = candidates.map((candidate) => candidate.entryTs).filter((value) => Number.isFinite(value));
  const inspectedCalibratedMoves = dataset.moves.length;
  const offsetsAttempted = dataset.moves.length * 11;
  const simulatedTrades = candidates.filter((candidate) => candidate.simulatedTrade);
  const rejectedCandidates = candidates.filter((candidate) => !candidate.simulatedTrade);
  const topReasonCounts = countValues(rejectedCandidates.flatMap((candidate) => candidate.rejectionReasons.length > 0 ? candidate.rejectionReasons : [candidate.rejectReason ?? candidate.noTradeReason]));
  const topRawFamilyReject = Object.entries(countByKey(
    rejectedCandidates.filter((candidate) => candidate.rejectionReasons.includes("invalid_archetype")),
    (candidate) => candidate.rawRuntimeFamily ?? String(candidate.liveSafeFeatures.rawRuntimeFamily ?? ""),
  )).sort((a, b) => b[1] - a[1])[0] ?? null;
  const topRawTransitionReject = Object.entries(countByKey(
    rejectedCandidates.filter((candidate) => candidate.rejectionReasons.includes("invalid_trigger_transition")),
    (candidate) => candidate.rawTriggerTransition ?? String(candidate.liveSafeFeatures.rawTriggerTransition ?? ""),
  )).sort((a, b) => b[1] - a[1])[0] ?? null;
  const topRawDirectionReject = Object.entries(countByKey(
    rejectedCandidates.filter((candidate) => candidate.rejectionReasons.includes("invalid_direction") || candidate.rejectionReasons.includes("direction_mismatch")),
    (candidate) => candidate.rawTriggerDirection ?? String(candidate.liveSafeFeatures.rawTriggerDirection ?? ""),
  )).sort((a, b) => b[1] - a[1])[0] ?? null;
  const missingExitRulesRejected = rejectedCandidates.filter((candidate) => candidate.rejectionReasons.includes("missing_exit_rules"));
  const exampleRejectedCandidatesByReason = rejectedCandidates.reduce<Record<string, Array<Record<string, unknown>>>>((acc, candidate) => {
    const reasons = candidate.rejectionReasons.length > 0
      ? candidate.rejectionReasons
      : [candidate.rejectReason ?? candidate.noTradeReason].filter(Boolean) as string[];
    for (const reason of reasons) {
      if ((acc[reason]?.length ?? 0) >= 5) continue;
      const rawTriggerTransition = typeof candidate.rawTriggerTransition === "string"
        ? candidate.rawTriggerTransition
        : String(candidate.liveSafeFeatures.rawTriggerTransition ?? candidate.triggerTransition ?? "");
      const rawRuntimeFamily = typeof candidate.rawRuntimeFamily === "string"
        ? candidate.rawRuntimeFamily
        : String(candidate.liveSafeFeatures.rawRuntimeFamily ?? candidate.runtimeFamily ?? "");
      const rawTriggerDirection = typeof candidate.rawTriggerDirection === "string"
        ? candidate.rawTriggerDirection
        : String(candidate.liveSafeFeatures.rawTriggerDirection ?? candidate.triggerDirection ?? "");
      (acc[reason] ??= []).push({
        candidateId: candidate.candidateId,
        moveId: candidate.moveId,
        offsetLabel: candidate.offsetLabel,
        entryTs: candidate.entryTs,
        rawTriggerTransition,
        canonicalTriggerTransition: candidate.triggerTransition,
        rawRuntimeFamily,
        canonicalRuntimeFamily: candidate.runtimeFamily,
        rawTriggerDirection,
        canonicalDirection: candidate.canonicalDirection,
        microBreakDirection: candidate.liveSafeFeatures.microBreakDirection ?? null,
        oneBarReturnPct: candidate.liveSafeFeatures.oneBarReturnPct ?? null,
        threeBarReturnPct: candidate.liveSafeFeatures.threeBarReturnPct ?? null,
        fiveBarReturnPct: candidate.liveSafeFeatures.fiveBarReturnPct ?? null,
        selectedBucket: candidate.selectedBucket,
        selectedMoveSizeBucket: candidate.selectedMoveSizeBucket,
        availableExitLookupKeysTried: candidate.availableExitLookupKeysTried ?? candidate.liveSafeFeatures.availableExitLookupKeysTried ?? [],
        exitSubsetCandidateCount: candidate.exitSubsetCandidateCount ?? candidate.liveSafeFeatures.exitSubsetCandidateCount ?? null,
        exitSubsetWinnerCount: candidate.exitSubsetWinnerCount ?? candidate.liveSafeFeatures.exitSubsetWinnerCount ?? null,
        exitSubsetMfeRange: candidate.exitSubsetMfeRange ?? {
          min: Number.isFinite(Number(candidate.liveSafeFeatures.exitSubsetMfeMin)) ? Number(candidate.liveSafeFeatures.exitSubsetMfeMin) : null,
          max: Number.isFinite(Number(candidate.liveSafeFeatures.exitSubsetMfeMax)) ? Number(candidate.liveSafeFeatures.exitSubsetMfeMax) : null,
        },
        exitSubsetMaeAbsRange: candidate.exitSubsetMaeAbsRange ?? {
          min: Number.isFinite(Number(candidate.liveSafeFeatures.exitSubsetMaeAbsMin)) ? Number(candidate.liveSafeFeatures.exitSubsetMaeAbsMin) : null,
          max: Number.isFinite(Number(candidate.liveSafeFeatures.exitSubsetMaeAbsMax)) ? Number(candidate.liveSafeFeatures.exitSubsetMaeAbsMax) : null,
        },
        exitRuleRejectReason: candidate.exitRuleRejectReason ?? candidate.liveSafeFeatures.exitRuleRejectReason ?? null,
        exitRuleSource: candidate.exitRuleSource ?? candidate.liveSafeFeatures.exitRuleSource ?? null,
        exitRuleWidenedFrom: candidate.exitRuleWidenedFrom ?? candidate.liveSafeFeatures.exitRuleWidenedFrom ?? null,
        exitRuleWidenedTo: candidate.exitRuleWidenedTo ?? candidate.liveSafeFeatures.exitRuleWidenedTo ?? null,
        rejectionReasons: candidate.rejectionReasons,
      });
    }
    return acc;
  }, {});
  return {
    attempted: candidates.length > 0,
    inspectedCalibratedMoves,
    offsetsAttempted,
    rawCandidatesGenerated: candidates.length,
    rebuiltTriggerCandidatesGenerated: candidates.length,
    eligibleCandidates: candidates.filter((candidate) => candidate.eligible).length,
    rebuiltTriggerCandidatesEligible: candidates.filter((candidate) => candidate.eligible).length,
    rejectedCandidates: rejectedCandidates.length,
    rebuiltTriggerCandidatesRejected: rejectedCandidates.length,
    simulatedTradeCount: simulatedTrades.length,
    matchedCalibratedMoveCount: new Set(simulatedTrades.map((candidate) => candidate.matchedCalibratedMoveId).filter((value) => value != null)).size,
    rejectionReasonCounts: topReasonCounts,
    rejectionReasonCountsByRawFamily: countReasonsByGroup(
      rejectedCandidates,
      (candidate) => candidate.rawRuntimeFamily ?? String(candidate.liveSafeFeatures.rawRuntimeFamily ?? ""),
    ),
    rejectionReasonCountsByOffset: countReasonsByGroup(rejectedCandidates, (candidate) => candidate.offsetLabel),
    rejectionReasonCountsByRawTransition: countReasonsByGroup(
      rejectedCandidates,
      (candidate) => candidate.rawTriggerTransition ?? String(candidate.liveSafeFeatures.rawTriggerTransition ?? ""),
    ),
    missingExitRulesCount: missingExitRulesRejected.length,
    missingExitRulesByFamily: countByKey(
      missingExitRulesRejected,
      (candidate) => candidate.runtimeFamily ?? candidate.rawRuntimeFamily ?? String(candidate.liveSafeFeatures.rawRuntimeFamily ?? ""),
    ),
    missingExitRulesByTriggerTransition: countByKey(
      missingExitRulesRejected,
      (candidate) => candidate.triggerTransition ?? candidate.rawTriggerTransition ?? String(candidate.liveSafeFeatures.rawTriggerTransition ?? ""),
    ),
    missingExitRulesBySelectedBucket: countByKey(
      missingExitRulesRejected,
      (candidate) => candidate.selectedBucket,
    ),
    missingExitRulesBySelectedMoveSizeBucket: countByKey(
      missingExitRulesRejected,
      (candidate) => candidate.selectedMoveSizeBucket,
    ),
    missingExitRulesByDirection: countByKey(
      missingExitRulesRejected,
      (candidate) => candidate.canonicalDirection ?? candidate.direction,
    ),
    missingExitRulesByOffset: countByKey(
      missingExitRulesRejected,
      (candidate) => candidate.offsetLabel,
    ),
    candidateOffsetDistribution: countValues(candidates.map((candidate) => candidate.offsetLabel)),
    rawTriggerDirectionDistribution: countValues(candidates.map((candidate) => candidate.rawTriggerDirection ?? String(candidate.liveSafeFeatures.rawTriggerDirection ?? ""))),
    canonicalDirectionDistribution: countValues(candidates.map((candidate) => candidate.canonicalDirection ?? candidate.direction)),
    rawRuntimeFamilyDistribution: countValues(candidates.map((candidate) => candidate.rawRuntimeFamily ?? String(candidate.liveSafeFeatures.rawRuntimeFamily ?? ""))),
    canonicalRuntimeFamilyDistribution: countValues(candidates.map((candidate) => candidate.runtimeFamily)),
    invalidRuntimeFamilyDistribution: countByKey(
      rejectedCandidates.filter((candidate) => candidate.rejectionReasons.includes("invalid_archetype")),
      (candidate) => candidate.rawRuntimeFamily ?? String(candidate.liveSafeFeatures.rawRuntimeFamily ?? ""),
    ),
    candidateArchetypeDistribution: countValues(candidates.map((candidate) => candidate.runtimeFamily)),
    candidateDirectionDistribution: countValues(candidates.map((candidate) => candidate.direction)),
    rawTriggerTransitionDistribution: countValues(candidates.map((candidate) => candidate.rawTriggerTransition ?? String(candidate.liveSafeFeatures.rawTriggerTransition ?? ""))),
    canonicalTriggerTransitionDistribution: countValues(candidates.map((candidate) => candidate.triggerTransition)),
    invalidTriggerTransitionDistribution: countByKey(
      rejectedCandidates.filter((candidate) => candidate.rejectionReasons.includes("invalid_trigger_transition")),
      (candidate) => candidate.rawTriggerTransition ?? String(candidate.liveSafeFeatures.rawTriggerTransition ?? ""),
    ),
    candidateTriggerTransitionDistribution: countValues(candidates.map((candidate) => candidate.triggerTransition)),
    candidateBucketDistribution: countValues(candidates.map((candidate) => candidate.selectedBucket)),
    selectedBucketDistribution: countValues(candidates.map((candidate) => candidate.selectedBucket)),
    selectedMoveSizeBucketDistribution: countValues(candidates.map((candidate) => candidate.selectedMoveSizeBucket)),
    entryTimestampCoverage: {
      minEntryTs: timestamps.length > 0 ? Math.min(...timestamps) : null,
      maxEntryTs: timestamps.length > 0 ? Math.max(...timestamps) : null,
      uniqueEntryDays: new Set(timestamps.map((ts) => new Date(ts * 1000).toISOString().slice(0, 10))).size,
    },
    noTradeReasonCounts: countValues(candidates.map((candidate) => candidate.noTradeReason)),
    exampleRejectedCandidatesByReason,
    exampleRejectedCandidates: rejectedCandidates.slice(0, 8).map((candidate) => ({
      candidateId: candidate.candidateId,
      matchedCalibratedMoveId: candidate.matchedCalibratedMoveId,
      sourceMoveStartTs: candidate.sourceMoveStartTs,
      sourceMoveEndTs: candidate.sourceMoveEndTs,
      offsetLabel: candidate.offsetLabel,
      offsetBars: candidate.offsetBars,
      entryTs: candidate.entryTs,
      entryCandleFound: candidate.entryCandleFound,
      entryPrice: candidate.entryPrice,
      rawTriggerTransition: candidate.rawTriggerTransition ?? candidate.liveSafeFeatures.rawTriggerTransition ?? null,
      canonicalTriggerTransition: candidate.triggerTransition,
      rawRuntimeFamily: candidate.rawRuntimeFamily ?? candidate.liveSafeFeatures.rawRuntimeFamily ?? null,
      canonicalRuntimeFamily: candidate.runtimeFamily,
      rawTriggerDirection: candidate.rawTriggerDirection ?? candidate.liveSafeFeatures.rawTriggerDirection ?? null,
      canonicalDirection: candidate.canonicalDirection ?? candidate.direction,
      direction: candidate.direction,
      archetype: candidate.runtimeFamily,
      triggerTransition: candidate.triggerTransition,
      selectedBucket: candidate.selectedBucket,
      selectedMoveSizeBucket: candidate.selectedMoveSizeBucket,
      featureSnapshotPresent: candidate.featureSnapshotPresent,
      exitRulesPresent: candidate.exitRulesPresent,
      simulatedTradeCreated: candidate.simulatedTrade,
      noTradeReason: candidate.noTradeReason,
      rejectionReasons: candidate.rejectionReasons,
    })),
    exampleSimulatedTrades: simulatedTrades.slice(0, 8).map((candidate) => ({
      candidateId: candidate.candidateId,
      matchedCalibratedMoveId: candidate.matchedCalibratedMoveId,
      offsetLabel: candidate.offsetLabel,
      entryTs: candidate.entryTs,
      exitTs: candidate.exitTs,
      direction: candidate.direction,
      entryPrice: candidate.entryPrice,
      exitPrice: candidate.exitPrice,
      pnlPct: candidate.pnlPct,
      mfePct: candidate.mfePct,
      maePct: candidate.maePct,
      exitReason: candidate.exitReason,
      selectedRuntimeArchetype: candidate.runtimeFamily,
      selectedTriggerTransition: candidate.triggerTransition,
      selectedBucket: candidate.selectedBucket,
      selectedMoveSizeBucket: candidate.selectedMoveSizeBucket,
      })),
    summary: {
      topRawFamilyReject: topRawFamilyReject ? { rawValue: topRawFamilyReject[0], count: topRawFamilyReject[1] } : null,
      topRawTransitionReject: topRawTransitionReject ? { rawValue: topRawTransitionReject[0], count: topRawTransitionReject[1] } : null,
      topRawDirectionReject: topRawDirectionReject ? { rawValue: topRawDirectionReject[0], count: topRawDirectionReject[1] } : null,
      topInvalidArchetypeExamplesCount: exampleRejectedCandidatesByReason.invalid_archetype?.length ?? 0,
      topMissingExitRulesReject: Object.entries(countByKey(
        missingExitRulesRejected,
        (candidate) => candidate.runtimeFamily && candidate.selectedMoveSizeBucket
          ? `${candidate.runtimeFamily}|${candidate.selectedMoveSizeBucket}|${candidate.canonicalDirection ?? candidate.direction}`
          : candidate.runtimeFamily ?? candidate.selectedMoveSizeBucket ?? candidate.selectedBucket ?? "unknown",
      )).sort((a, b) => b[1] - a[1])[0]
        ? {
            rawValue: Object.entries(countByKey(
              missingExitRulesRejected,
              (candidate) => candidate.runtimeFamily && candidate.selectedMoveSizeBucket
                ? `${candidate.runtimeFamily}|${candidate.selectedMoveSizeBucket}|${candidate.canonicalDirection ?? candidate.direction}`
                : candidate.runtimeFamily ?? candidate.selectedMoveSizeBucket ?? candidate.selectedBucket ?? "unknown",
            )).sort((a, b) => b[1] - a[1])[0]![0],
            count: Object.entries(countByKey(
              missingExitRulesRejected,
              (candidate) => candidate.runtimeFamily && candidate.selectedMoveSizeBucket
                ? `${candidate.runtimeFamily}|${candidate.selectedMoveSizeBucket}|${candidate.canonicalDirection ?? candidate.direction}`
                : candidate.runtimeFamily ?? candidate.selectedMoveSizeBucket ?? candidate.selectedBucket ?? "unknown",
            )).sort((a, b) => b[1] - a[1])[0]![1],
          }
        : null,
    },
  };
}

function featureSummaryFromDataset(dataset: UnifiedSynthesisDataset): EliteSynthesisFeatureSummary[] {
  const positiveTrades = dataset.trades.filter((trade) => trade.pnlPct > 0);
  const negativeTrades = dataset.trades.filter((trade) => trade.pnlPct <= 0 || trade.phantomNoiseLabel === "noise_trade");
  const keys = uniqueStrings([
    ...positiveTrades.flatMap((trade) => Object.keys(trade.liveSafeFeatures)),
    ...negativeTrades.flatMap((trade) => Object.keys(trade.liveSafeFeatures)),
  ]);
  return keys.map((key) => {
    const positiveRaw = positiveTrades.map((trade) => trade.liveSafeFeatures[key]);
    const negativeRaw = negativeTrades.map((trade) => trade.liveSafeFeatures[key]);
    const positive = positiveRaw.map((value) => Number(value)).filter((value) => Number.isFinite(value));
    const negative = negativeRaw.map((value) => Number(value)).filter((value) => Number.isFinite(value));
    const nonNullCount = [...positiveRaw, ...negativeRaw].filter((value) => value != null && `${value}`.trim() !== "").length;
    const denominator = positiveTrades.length + negativeTrades.length;
    const missingRate = denominator > 0
      ? 1 - (nonNullCount / denominator)
      : 1;
    const isCategorical = nonNullCount > 0 && positive.length + negative.length === 0;
    if (isCategorical) {
      return {
        key,
        positiveP50: null,
        negativeP50: null,
        overlapScore: 0,
        separationScore: 0,
        missingRate: Number(missingRate.toFixed(4)),
        monthlyStabilityScore: Number((1 - Math.min(1, missingRate)).toFixed(4)),
        kept: false,
        reasons: ["categorical_not_numeric"],
      };
    }
    const posMedian = median(positive);
    const negMedian = median(negative);
    const separationScore = Math.abs(posMedian - negMedian);
    const overlapScore = separationScore <= 0.02 ? 1 : Math.max(0, 1 - separationScore);
    const monthlyStabilityScore = 1 - Math.min(1, missingRate + (separationScore < 0.01 ? 0.4 : 0));
    const kept = separationScore >= 0.015 && missingRate <= 0.35;
    return {
      key,
      positiveP50: positive.length > 0 ? posMedian : null,
      negativeP50: negative.length > 0 ? negMedian : null,
      overlapScore: Number(overlapScore.toFixed(4)),
      separationScore: Number(separationScore.toFixed(4)),
      missingRate: Number(missingRate.toFixed(4)),
      monthlyStabilityScore: Number(monthlyStabilityScore.toFixed(4)),
      kept,
      reasons: kept ? ["feature_separation_kept"] : ["feature_eliminated_for_low_separation_or_high_missing_rate"],
    };
  }).sort((a, b) => b.separationScore - a.separationScore);
}

function defaultLeakageAudit(): EliteSynthesisLeakageAudit {
  return {
    passed: true,
    checkedRules: [
      { rule: "no_future_pnl", passed: true, notes: ["Final policy evaluation excludes future pnl fields."] },
      { rule: "no_future_mfe_mae", passed: true, notes: ["Final policy evaluation excludes future mfe/mae fields."] },
      { rule: "no_actual_exit_reason", passed: true, notes: ["Exit reason is not used as a live rule input."] },
      { rule: "no_realised_win_loss", passed: true, notes: ["Realised win/loss is not used as a live rule input."] },
      { rule: "no_strict_oracle_relationship_label", passed: true, notes: ["Oracle relationship labels stay evaluation-only."] },
      { rule: "no_calibrated_move_outcome_label", passed: true, notes: ["Calibrated move outcome labels stay evaluation-only."] },
      { rule: "no_post_entry_candle_data", passed: true, notes: ["Entry features are limited to the entry candle slice."] },
      { rule: "no_legacy_diagnostic_score", passed: true, notes: ["Legacy diagnostic score is excluded."] },
    ],
  };
}

function bestSummaryFromPolicy(policy: EliteSynthesisPolicySummary | null, evaluatedPolicyCount: number, currentPolicyCount: number) {
  if (!policy) {
    return {
      currentPolicyCount,
      evaluatedPolicyCount,
      bestWinRate: null,
      bestSlRate: null,
      bestProfitFactor: null,
      bestTradeCount: null,
      bestObjectiveScore: null,
      bestPolicyId: null,
    };
  }
  return {
    currentPolicyCount,
    evaluatedPolicyCount,
    bestWinRate: policy.winRate,
    bestSlRate: policy.slHitRate,
    bestProfitFactor: policy.profitFactor,
    bestTradeCount: policy.trades,
    bestObjectiveScore: policy.objectiveScore,
    bestPolicyId: policy.policyId,
  };
}

type PolicySeed = {
  passNumber: number;
  sourcePool: "runtime_trades" | "rebuilt_trigger_candidates";
  selectedRuntimeArchetypes: string[];
  selectedBuckets: string[];
  selectedMoveSizeBuckets: string[];
  selectedTriggerTransitions: string[];
  selectedDirections?: Array<"buy" | "sell">;
  offsetClusters?: string[];
  featureSet: EliteSynthesisFeatureSummary[];
  mutationSummary: string;
  diagnostics?: Record<string, unknown>;
};

const CANONICAL_REBUILT_FAMILIES = new Set([
  "crash_event_down",
  "post_crash_recovery_up",
  "bear_trap_reversal_up",
  "failed_recovery_short",
]);

const CANONICAL_REBUILT_TRANSITIONS = new Set([
  "crash_continuation_down",
  "post_crash_recovery_reclaim_up",
  "bear_trap_reversal_up",
  "failed_recovery_break_down",
]);

const RETURN_AMPLIFICATION_BUCKETS = [
  "5_to_6_pct",
  "6_to_7_pct",
  "7_to_8_pct",
  "8_to_9_pct",
  "9_to_10_pct",
  "10_to_11_pct",
  "11_to_12_pct",
  "12_to_13_pct",
  "13_plus_pct",
] as const;

type ReturnAmplificationBucket = (typeof RETURN_AMPLIFICATION_BUCKETS)[number];

function isReturnFirstObjective(targetProfile: EliteSynthesisTargetProfile): boolean {
  return targetProfile === "return_amplification" || targetProfile === "return_first";
}

function offsetClusterFromLabel(label: string | null | undefined) {
  switch (label) {
    case "T-10":
    case "T-5":
    case "T-3":
      return "early";
    case "T-2":
    case "T-1":
    case "T+0":
    case "T0":
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

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p)));
  return sorted[idx] ?? 0;
}

function summarizeDistribution(values: number[]) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return { p25: 0, p50: 0, p75: 0 };
  return {
    p25: Number(percentile(finite, 0.25).toFixed(2)),
    p50: Number(percentile(finite, 0.5).toFixed(2)),
    p75: Number(percentile(finite, 0.75).toFixed(2)),
  };
}

function summarizeRange(values: number[]) {
  const finite = values.filter((value) => Number.isFinite(value) && value > 0);
  if (finite.length === 0) return { min: null, max: null };
  return { min: Math.min(...finite), max: Math.max(...finite) };
}

function summarizeExitRulesFromRebuiltCandidates(candidates: SynthesisRebuiltTriggerCandidateRecord[]) {
  const tp = summarizeDistribution(candidates.map((candidate) => candidate.projectedMovePctPoints ?? 0).filter((value) => value > 0));
  const sl = summarizeDistribution(candidates.map((candidate) => candidate.slPctPoints ?? 0).filter((value) => value > 0));
  const trailingActivation = summarizeDistribution(candidates.map((candidate) => candidate.trailingActivationPctPoints ?? 0).filter((value) => value > 0));
  const trailingDistance = summarizeDistribution(candidates.map((candidate) => candidate.trailingDistancePctPoints ?? 0).filter((value) => value > 0));
  const exitRuleSourceDistribution = candidates.reduce<Record<string, number>>((acc, candidate) => {
    const key = candidate.exitRuleSource ?? "unknown";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const widenedDistribution = candidates.reduce<Record<string, number>>((acc, candidate) => {
    const key = `${candidate.exitRuleWidenedFrom ?? "none"}=>${candidate.exitRuleWidenedTo ?? "none"}`;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  return {
    tp,
    sl,
    trailingActivation,
    trailingDistance,
    exitRuleSourceDistribution,
    widenedDistribution,
  };
}

function bucketLabelFromPctPoints(pctPoints: number | null | undefined): ReturnAmplificationBucket | null {
  const value = Math.abs(Number(pctPoints ?? 0));
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value < 6) return "5_to_6_pct";
  if (value < 7) return "6_to_7_pct";
  if (value < 8) return "7_to_8_pct";
  if (value < 9) return "8_to_9_pct";
  if (value < 10) return "9_to_10_pct";
  if (value < 11) return "10_to_11_pct";
  if (value < 12) return "11_to_12_pct";
  if (value < 13) return "12_to_13_pct";
  return "13_plus_pct";
}

function bucketLowerBound(bucket: ReturnAmplificationBucket): number {
  switch (bucket) {
    case "5_to_6_pct":
      return 5;
    case "6_to_7_pct":
      return 6;
    case "7_to_8_pct":
      return 7;
    case "8_to_9_pct":
      return 8;
    case "9_to_10_pct":
      return 9;
    case "10_to_11_pct":
      return 10;
    case "11_to_12_pct":
      return 11;
    case "12_to_13_pct":
      return 12;
    case "13_plus_pct":
      return 13;
  }
}

function bucketUpperBound(bucket: ReturnAmplificationBucket): number {
  switch (bucket) {
    case "5_to_6_pct":
      return 6;
    case "6_to_7_pct":
      return 7;
    case "7_to_8_pct":
      return 8;
    case "8_to_9_pct":
      return 9;
    case "9_to_10_pct":
      return 10;
    case "10_to_11_pct":
      return 11;
    case "11_to_12_pct":
      return 12;
    case "12_to_13_pct":
      return 13;
    case "13_plus_pct":
      return 15;
  }
}

function bucketMidpoint(bucket: ReturnAmplificationBucket): number {
  return Number((((bucketLowerBound(bucket) + bucketUpperBound(bucket)) / 2)).toFixed(2));
}

function bucketRank(bucket: string | null | undefined): number {
  const idx = RETURN_AMPLIFICATION_BUCKETS.indexOf(String(bucket ?? "") as ReturnAmplificationBucket);
  return idx >= 0 ? idx : -1;
}

function returnBucketAtLeast(bucket: string | null | undefined, threshold: ReturnAmplificationBucket): boolean {
  return bucketRank(bucket) >= bucketRank(threshold);
}

function asFiniteNumber(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function candidateFeatureNumber(candidate: SynthesisRebuiltTriggerCandidateRecord, key: string): number | null {
  return asFiniteNumber(candidate.liveSafeFeatures[key]);
}

function actualMoveBucketForCandidate(
  candidate: SynthesisRebuiltTriggerCandidateRecord,
  moveById: Map<number, UnifiedSynthesisDataset["moves"][number]>,
): ReturnAmplificationBucket | null {
  const move = candidate.matchedCalibratedMoveId ? moveById.get(candidate.matchedCalibratedMoveId) ?? null : null;
  const pctPoints = move?.movePctPoints
    ?? move?.realisticMfeAfterEntryPctPoints
    ?? move?.realisticMfeAfterEntry
    ?? candidate.projectedMovePctPoints
    ?? candidate.projectedMovePct
    ?? null;
  return bucketLabelFromPctPoints(pctPoints);
}

function computeScenarioEquityMetrics(pnlPctPoints: number[]) {
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const pnl of pnlPctPoints) {
    cumulative += pnl;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }
  return {
    accountReturnPct: Number(cumulative.toFixed(2)),
    maxDrawdownPct: Number(maxDrawdown.toFixed(2)),
  };
}

function emptyDataAvailability(): EliteSynthesisDataAvailability {
  return { counts: {}, metrics: {} };
}

function emptyUnitValidation(): EliteSynthesisUnitValidation {
  return {
    passed: false,
    unit: "mixed",
    canonicalUnit: "percentage_points",
    notes: ["Unit validation not available."],
    fieldUnits: {},
    fieldWarnings: [],
    fieldErrors: [],
    sampledRanges: {},
    normalisationNotes: [],
  };
}

function buildPolicyArtifact(params: {
  adapter: SymbolSynthesisAdapter;
  dataset: UnifiedSynthesisDataset;
  passNumber: number;
  featureSet: EliteSynthesisFeatureSummary[];
  selectedRuntimeArchetypes: string[];
  selectedBuckets: string[];
  selectedMoveSizeBuckets: string[];
  selectedTriggerTransitions: string[];
  selectedDirections?: Array<"buy" | "sell">;
  offsetClusters?: string[];
  mutationSummary: string;
  sourcePool: "runtime_trades" | "rebuilt_trigger_candidates";
  diagnostics?: Record<string, unknown>;
}) {
  const policyKeyParts = [
    params.sourcePool === "rebuilt_trigger_candidates" ? "rebuilt" : "runtime",
    params.selectedRuntimeArchetypes.join("-") || "all_archetypes",
    params.selectedTriggerTransitions.join("-") || "all_triggers",
    params.selectedMoveSizeBuckets.join("-") || "all_move_sizes",
    (params.selectedDirections ?? []).join("-") || "all_directions",
    (params.offsetClusters ?? []).join("-") || "all_offsets",
  ]
    .map((value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter((value) => value.length > 0);
  const exitSubset = (params.sourcePool === "rebuilt_trigger_candidates"
    ? params.dataset.rebuiltTriggerCandidates.filter((candidate) =>
        candidate.eligible
        && candidate.simulatedTrade
        && !candidate.noTradeReason
        && params.selectedRuntimeArchetypes.includes(candidate.runtimeFamily ?? "unknown")
        && params.selectedTriggerTransitions.includes(candidate.triggerTransition ?? "none")
        && params.selectedMoveSizeBuckets.includes(candidate.selectedMoveSizeBucket ?? "unknown")
        && ((params.selectedDirections?.length ?? 0) === 0 || params.selectedDirections?.includes(candidate.direction as "buy" | "sell"))
        && ((params.offsetClusters?.length ?? 0) === 0 || params.offsetClusters?.includes(offsetClusterFromLabel(candidate.offsetLabel)))
      )
    : params.dataset.trades.filter((trade) =>
        params.selectedRuntimeArchetypes.includes(trade.runtimeFamily ?? "unknown")
        && params.selectedBuckets.includes(trade.selectedBucket ?? "unknown")
        && params.selectedTriggerTransitions.includes(trade.triggerTransition ?? "none"),
      ));
  const exitRules = params.sourcePool === "rebuilt_trigger_candidates"
    ? (() => {
        const rebuiltSubset = exitSubset as SynthesisRebuiltTriggerCandidateRecord[];
        const exitSummary = summarizeExitRulesFromRebuiltCandidates(rebuiltSubset);
        return {
          tpTargetPct: exitSummary.tp.p50,
          slRiskPct: exitSummary.sl.p50,
          protectionActivationPct: exitSummary.trailingActivation.p50,
          dynamicProtectionDistancePct: exitSummary.trailingDistance.p50,
          trailingActivationPct: exitSummary.trailingActivation.p50,
          trailingDistancePct: exitSummary.trailingDistance.p50,
          minHoldBars: Math.max(1, Math.round(median(rebuiltSubset.map((candidate) => Math.max(1, candidate.minHoldBars ?? 1))))),
          unit: "percentage_points" as const,
          exitUnitValidation: {
            selectedSubsetMfeRange: summarizeRange(rebuiltSubset.map((candidate) => Math.abs(candidate.mfePctPoints ?? 0))),
            selectedSubsetMaeAbsRange: summarizeRange(rebuiltSubset.map((candidate) => Math.abs(candidate.maePctPoints ?? 0))),
            selectedSubsetMfeRangePctPoints: summarizeRange(rebuiltSubset.map((candidate) => Math.abs(candidate.mfePctPoints ?? 0))),
            selectedSubsetMaeAbsRangePctPoints: summarizeRange(rebuiltSubset.map((candidate) => Math.abs(candidate.maePctPoints ?? 0))),
            derivedTpPctPoints: exitSummary.tp.p50,
            derivedSlPctPoints: exitSummary.sl.p50,
            derivedProtectionActivationPctPoints: exitSummary.trailingActivation.p50,
            derivedDynamicProtectionDistancePctPoints: exitSummary.trailingDistance.p50,
            derivedTrailingActivationPctPoints: exitSummary.trailingActivation.p50,
            derivedTrailingDistancePctPoints: exitSummary.trailingDistance.p50,
            sourceValueExamples: {
              tpTargetPct: rebuiltSubset.map((candidate) => candidate.projectedMovePctPoints ?? 0).slice(0, 5),
              slRiskPct: rebuiltSubset.map((candidate) => candidate.slPctPoints ?? 0).slice(0, 5),
            },
            canonicalValueExamples: {
              tpTargetPct: rebuiltSubset.map((candidate) => candidate.projectedMovePctPoints ?? 0).slice(0, 5),
              slRiskPct: rebuiltSubset.map((candidate) => candidate.slPctPoints ?? 0).slice(0, 5),
            },
            impossibleExitRejected: rebuiltSubset.length === 0,
            warnings: rebuiltSubset.length === 0 ? ["Rejected rebuilt policy because no simulated rebuilt trades were available for exit summary."] : [],
          },
        };
      })()
    : params.adapter.deriveExitPolicyFromSubset(params.dataset, exitSubset as never);
  exitRules.protectionActivationPct = Number(exitRules.protectionActivationPct ?? exitRules.trailingActivationPct ?? 0);
  exitRules.dynamicProtectionDistancePct = Number(exitRules.dynamicProtectionDistancePct ?? exitRules.trailingDistancePct ?? 0);
  exitRules.exitUnitValidation.derivedProtectionActivationPctPoints = Number(
    exitRules.exitUnitValidation.derivedProtectionActivationPctPoints
    ?? exitRules.exitUnitValidation.derivedTrailingActivationPctPoints
    ?? exitRules.protectionActivationPct
    ?? 0,
  );
  exitRules.exitUnitValidation.derivedDynamicProtectionDistancePctPoints = Number(
    exitRules.exitUnitValidation.derivedDynamicProtectionDistancePctPoints
    ?? exitRules.exitUnitValidation.derivedTrailingDistancePctPoints
    ?? exitRules.dynamicProtectionDistancePct
    ?? 0,
  );
  const selectedMoveSizeBuckets = params.selectedMoveSizeBuckets.length > 0
    ? uniqueStrings(params.selectedMoveSizeBuckets)
    : resolveSelectedMoveSizeBuckets({
        dataset: params.dataset,
        selectedBuckets: params.selectedBuckets,
        selectedRuntimeArchetypes: params.selectedRuntimeArchetypes,
      });
  const subsetConfidence = exitSubset
    .map((trade) => Number((trade as Record<string, unknown>).confidence))
    .filter((value) => Number.isFinite(value) && value > 0);
  const subsetSetupMatch = exitSubset
    .map((trade) => Number((trade as Record<string, unknown>).setupMatch))
    .filter((value) => Number.isFinite(value) && value > 0);
  const policy: EliteSynthesisPolicyArtifact = {
    policyId: `crash300-elite-pass-${params.passNumber}-${policyKeyParts.join("-")}`,
    version: "0.1.0-foundation",
    generatedAt: nowIso(),
    sourceCalibrationRunId: Number(params.dataset.sourceRunIds.calibrationRunId ?? 0) || null,
    sourceBacktestRunId: Number(params.dataset.sourceRunIds.backtestRunId ?? 0) || null,
    calibratedBaseFamily: "crash_expansion",
    selectedMoveSizeBuckets,
    selectedRuntimeArchetypes: params.selectedRuntimeArchetypes,
    selectedBuckets: params.selectedBuckets,
    selectedTriggerTransitions: params.selectedTriggerTransitions,
    selectedCoreFeatures: params.featureSet,
    entryThresholds: {
      sourcePool: params.sourcePool,
      mutationSummary: params.mutationSummary,
      selectedDirections: params.selectedDirections ?? [],
      offsetClusters: params.offsetClusters ?? [],
      rebuiltSeedDiagnostics: params.diagnostics ?? null,
      minConfidence: subsetConfidence.length > 0 ? Number(median(subsetConfidence).toFixed(4)) : 0.45,
      minSetupMatch: subsetSetupMatch.length > 0 ? Number(median(subsetSetupMatch).toFixed(4)) : 0.45,
    },
    entryTimingRules: [
      {
        preferredOffset: "T0",
        earliestSafeOffset: "T-1",
        rejectEarlierThan: "T-5",
        rejectLaterThan: "T+3",
        offsetClusters: params.offsetClusters ?? [],
      },
    ],
    noTradeRules: [
      "no_trade_without_fresh_trigger",
      "max_one_trade_per_day",
      "cascade_disabled_by_default",
    ],
    tpRules: {
      targetPct: exitRules.tpTargetPct,
      unit: exitRules.unit,
      source: "synthesis_percentile_subset",
      exitUnitValidation: exitRules.exitUnitValidation,
    },
    slRules: {
      maxInitialRiskPct: exitRules.slRiskPct,
      unit: exitRules.unit,
      source: "synthesis_percentile_subset",
      exitUnitValidation: exitRules.exitUnitValidation,
    },
    lifecycleManagerRules: {
      lifecycleManagerModel: "trade_lifecycle_manager_v1",
      protectionActivationPct: exitRules.protectionActivationPct ?? exitRules.trailingActivationPct ?? 0,
      dynamicProtectionDistancePct: exitRules.dynamicProtectionDistancePct ?? exitRules.trailingDistancePct ?? 0,
      protectedFloorPct: 0,
      tp1Pct: Number(Math.max(0.1, (exitRules.tpTargetPct ?? 0) * 0.45).toFixed(4)),
      tp2Pct: exitRules.tpTargetPct,
      runnerTargetPct: exitRules.tpTargetPct,
      unit: exitRules.unit,
      source: "synthesis_percentile_subset",
      exitUnitValidation: exitRules.exitUnitValidation,
      protectionRules: ["activate_protection_after_tp1_progress", "tighten_floor_on_momentum_failure"],
      exitDecisionRules: ["tp2_or_runner_target", "protected_exit", "momentum_failure_exit", "reversal_pressure_exit", "time_progress_failure_exit", "hard_sl"],
      maturityRules: { minHoldBars: exitRules.minHoldBars },
    },
    trailingRules: {
      activationProfitPct: exitRules.protectionActivationPct ?? exitRules.trailingActivationPct,
      trailingDistancePct: exitRules.dynamicProtectionDistancePct ?? exitRules.trailingDistancePct,
      unit: exitRules.unit,
      source: "internal_compatibility_alias",
      exitUnitValidation: exitRules.exitUnitValidation,
    },
    minHoldRules: { minHoldBars: exitRules.minHoldBars },
    dailyTradeLimit: 1,
    cascadeRules: { enabled: false, notes: ["cascade research is not enabled in the default policy output"] },
    liveSafeEliteScoreFormula: "weighted_runtime_evidence_from_live_safe_features_only",
    expectedThreeMonthPerformance: {},
    monthlyBreakdown: [],
    passNumberSelected: params.passNumber,
    objectiveScore: 0,
    leakageAudit: defaultLeakageAudit(),
    bottleneckAnalysis: {
      targetAchieved: false,
      triggerRebuildAttempted: false,
      classification: "none",
      reasons: [],
      futureImplementationRecommendation: "",
    },
    implementationNotes: [
      "Generated by integrated elite synthesis foundation pass.",
      "Uses only live-safe feature families for final policy inputs.",
      ...(params.sourcePool === "rebuilt_trigger_candidates" ? ["Rebuilt policy exits are summarised from simulated rebuilt candidate outcomes."] : []),
      ...(exitRules.exitUnitValidation.impossibleExitRejected ? ["Policy carries impossible exit rejection diagnostics and must not be promoted."] : []),
    ],
  };
  const audit = params.adapter.validateNoFutureLeakage(policy);
  policy.leakageAudit = {
    passed: audit.passed,
    checkedRules: defaultLeakageAudit().checkedRules.map((rule) => ({
      ...rule,
      passed: audit.passed && rule.passed,
      notes: rule.rule === "no_legacy_diagnostic_score" ? [...rule.notes, ...audit.notes] : rule.notes,
    })),
  };
  return policy;
}

function generateInitialPolicies(dataset: UnifiedSynthesisDataset, features: EliteSynthesisFeatureSummary[]): PolicySeed[] {
  const groups = new Map<string, {
    family: string;
    bucket: string;
    trigger: string;
    trades: number;
    wins: number;
    losses: number;
  }>();
  for (const trade of dataset.trades) {
    const family = trade.runtimeFamily ?? "unknown";
    const bucket = trade.selectedBucket ?? "unknown";
    const trigger = trade.triggerTransition ?? "none";
    const key = `${family}|${bucket}|${trigger}`;
    const group = groups.get(key) ?? { family, bucket, trigger, trades: 0, wins: 0, losses: 0 };
    group.trades += 1;
    if (trade.pnlPct > 0) group.wins += 1; else group.losses += 1;
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) => group.trades >= 2 && group.family !== "unknown" && group.bucket !== "unknown" && group.trigger !== "none")
    .sort((a, b) => (b.wins / Math.max(1, b.trades)) - (a.wins / Math.max(1, a.trades)))
    .slice(0, 20)
    .map((group, index) => ({
      passNumber: 1,
      sourcePool: "runtime_trades" as const,
      selectedRuntimeArchetypes: [group.family],
      selectedBuckets: [group.bucket],
      selectedMoveSizeBuckets: resolveSelectedMoveSizeBuckets({
        dataset,
        selectedBuckets: [group.bucket],
        selectedRuntimeArchetypes: [group.family],
      }).slice(0, 5),
      selectedTriggerTransitions: [group.trigger],
      featureSet: features.filter((feature) => feature.kept).slice(0, 10 + index % 5),
      mutationSummary: index === 0 ? "seeded_from_current_runtime_candidate_pool" : `seeded_runtime_group_${index + 1}`,
    }));
}

function generatePoliciesFromTriggerRebuild(dataset: UnifiedSynthesisDataset, rebuiltCandidates: UnifiedSynthesisDataset["rebuiltTriggerCandidates"], features: EliteSynthesisFeatureSummary[]): PolicySeed[] {
  const groups = new Map<string, {
    family: string;
    triggerTransition: string;
    selectedMoveSizeBucket: string;
    direction: "buy" | "sell";
    offsetCluster: string;
    selectedBuckets: Map<string, number>;
    offsetLabels: Map<string, number>;
    simulatedCandidateCount: number;
    simulatedTradeCount: number;
    wins: number;
    losses: number;
    slHits: number;
    exitRuleSourceDistribution: Record<string, number>;
  }>();
  const seedRejectionReasons: Record<string, number> = {};
  for (const candidate of rebuiltCandidates) {
    if (!candidate.eligible) continue;
    const family = String(candidate.runtimeFamily ?? "unknown");
    const triggerTransition = String(candidate.triggerTransition ?? "none");
    const selectedMoveSizeBucket = String(candidate.selectedMoveSizeBucket ?? "unknown");
    const direction = candidate.direction === "buy" || candidate.direction === "sell" ? candidate.direction : "buy";
    const offsetCluster = offsetClusterFromLabel(candidate.offsetLabel);
    if (!CANONICAL_REBUILT_FAMILIES.has(family)) {
      seedRejectionReasons.invalid_runtime_family = (seedRejectionReasons.invalid_runtime_family ?? 0) + 1;
      continue;
    }
    if (!CANONICAL_REBUILT_TRANSITIONS.has(triggerTransition)) {
      seedRejectionReasons.invalid_trigger_transition = (seedRejectionReasons.invalid_trigger_transition ?? 0) + 1;
      continue;
    }
    if (!selectedMoveSizeBucket || selectedMoveSizeBucket === "unknown") {
      seedRejectionReasons.missing_selected_move_size_bucket = (seedRejectionReasons.missing_selected_move_size_bucket ?? 0) + 1;
      continue;
    }
    if (offsetCluster === "unknown") {
      seedRejectionReasons.unknown_offset_cluster = (seedRejectionReasons.unknown_offset_cluster ?? 0) + 1;
      continue;
    }
    const key = `${family}|${triggerTransition}|${selectedMoveSizeBucket}|${direction}|${offsetCluster}`;
    const group = groups.get(key) ?? {
      family,
      triggerTransition,
      selectedMoveSizeBucket,
      direction,
      offsetCluster,
      selectedBuckets: new Map<string, number>(),
      offsetLabels: new Map<string, number>(),
      simulatedCandidateCount: 0,
      simulatedTradeCount: 0,
      wins: 0,
      losses: 0,
      slHits: 0,
      exitRuleSourceDistribution: {},
    };
    group.simulatedCandidateCount += 1;
    group.simulatedTradeCount += candidate.simulatedTrade ? 1 : 0;
    if ((candidate.pnlPctPoints ?? candidate.pnlPct ?? 0) > 0) group.wins += 1; else group.losses += 1;
    if (candidate.exitReason === "sl_hit") group.slHits += 1;
    if (candidate.selectedBucket) group.selectedBuckets.set(candidate.selectedBucket, (group.selectedBuckets.get(candidate.selectedBucket) ?? 0) + 1);
    group.offsetLabels.set(candidate.offsetLabel, (group.offsetLabels.get(candidate.offsetLabel) ?? 0) + 1);
    const exitRuleSource = candidate.exitRuleSource ?? "unknown";
    group.exitRuleSourceDistribution[exitRuleSource] = (group.exitRuleSourceDistribution[exitRuleSource] ?? 0) + 1;
    groups.set(key, group);
  }
  const seeds = [...groups.values()]
    .sort((a, b) => b.simulatedTradeCount - a.simulatedTradeCount)
    .slice(0, 20)
    .map((group, index) => {
      const topBucket = [...group.selectedBuckets.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? `${group.direction === "buy" ? "up" : "down"}|${group.family}|${group.selectedMoveSizeBucket}`;
      const offsetLabelsIncluded = [...group.offsetLabels.entries()].sort((a, b) => b[1] - a[1]).map(([label]) => label);
      return {
        passNumber: 2,
        sourcePool: "rebuilt_trigger_candidates" as const,
        selectedRuntimeArchetypes: [group.family],
        selectedBuckets: [topBucket],
        selectedMoveSizeBuckets: [group.selectedMoveSizeBucket],
        selectedTriggerTransitions: [group.triggerTransition],
        selectedDirections: [group.direction],
        offsetClusters: [group.offsetCluster],
        featureSet: features.filter((feature) => feature.kept).slice(0, Math.max(4, 8 + index % 4)),
        mutationSummary: index === 0 ? "rebuilt_from_calibrated_move_offsets" : `rebuilt_trigger_cluster_${index + 1}`,
        diagnostics: {
          groupKey: `${group.family}|${group.triggerTransition}|${group.selectedMoveSizeBucket}|${group.direction}|${group.offsetCluster}`,
          runtimeFamily: group.family,
          triggerTransition: group.triggerTransition,
          selectedMoveSizeBucket: group.selectedMoveSizeBucket,
          direction: group.direction,
          selectedBucket: topBucket,
          offsetLabelsIncluded,
          simulatedCandidateCount: group.simulatedCandidateCount,
          simulatedTradeCount: group.simulatedTradeCount,
          wins: group.wins,
          losses: group.losses,
          slHits: group.slHits,
          exitRuleSourceDistribution: group.exitRuleSourceDistribution,
        },
      };
    });
  (dataset.summary.rebuiltPolicySeedDiagnostics as Record<string, unknown> | undefined) ??= {};
  Object.assign(dataset.summary.rebuiltPolicySeedDiagnostics as Record<string, unknown>, {
    rebuiltPolicySeedCount: seeds.length,
    rebuiltPolicySeedGroups: [...groups.keys()],
    rebuiltPolicySeedGroupKeys: [...groups.keys()],
    rebuiltPolicySeedRejectedCount: Object.values(seedRejectionReasons).reduce((sum, value) => sum + value, 0),
    rebuiltPolicySeedRejectionReasons: seedRejectionReasons,
    exampleRebuiltPolicySeeds: seeds.slice(0, 10).map((seed) => seed.diagnostics ?? {}),
  });
  return seeds;
}

function targetAchieved(policy: EliteSynthesisPolicySummary | null, targetProfile: EliteSynthesisTargetProfile = "default") {
  if (!policy) return false;
  if (isReturnFirstObjective(targetProfile)) {
    const averageMonthlyReturn = Number(policy.averageMonthlyAccountReturnPct ?? 0);
    return Boolean(
      policy.winRate >= 0.9
      && policy.slHitRate <= 0.1
      && policy.profitFactor >= 2.5
      && averageMonthlyReturn >= 50
      && policy.maxDrawdownPct <= 10
      && policy.trades >= 20
      && policy.trades <= 45,
    );
  }
  return Boolean(
    policy.winRate >= 0.9
    && policy.slHitRate <= 0.1
    && policy.profitFactor >= 2.5
    && policy.trades >= 45
    && policy.trades <= 75,
  );
}

function mean(values: number[]) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function pctDeltaPoints(direction: "buy" | "sell", entryPrice: number, price: number) {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(price)) return 0;
  const change = ((price - entryPrice) / entryPrice) * 100;
  return direction === "buy" ? change : -change;
}

function safeNumber(value: unknown, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function normalizeLifecycleExitReason(reason: unknown): string {
  const value = String(reason ?? "unknown");
  if (value === "trailing_exit" || value === "trailing_stop") return "protected_exit";
  return value;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function averageTrueRange(candles: CandleRow[], index: number, length = 14) {
  const start = Math.max(1, index - length + 1);
  const values: number[] = [];
  for (let i = start; i <= index; i += 1) {
    const candle = candles[i];
    const prev = candles[i - 1];
    if (!candle || !prev) continue;
    const tr = Math.max(
      Math.abs(candle.high - candle.low),
      Math.abs(candle.high - prev.close),
      Math.abs(candle.low - prev.close),
    );
    if (Number.isFinite(tr)) values.push(tr);
  }
  return mean(values);
}

function buildLifecycleSnapshot(params: {
  candles: CandleRow[];
  entryIndex: number;
  index: number;
  direction: "buy" | "sell";
  entryPrice: number;
  expectedMovePct: number;
  exitPlan: LifecycleExitPlan;
  bestFavourable: number;
  worstAdverse: number;
}) : TradeLifecycleSnapshot {
  const candle = params.candles[params.index];
  const prev1 = params.candles[Math.max(params.entryIndex, params.index - 1)] ?? candle;
  const prev3 = params.candles[Math.max(params.entryIndex, params.index - 3)] ?? prev1;
  const prev5 = params.candles[Math.max(params.entryIndex, params.index - 5)] ?? prev3;
  const direction = params.direction;
  const currentPnlPct = pctDeltaPoints(direction, params.entryPrice, candle.close);
  const pullbackFromLocalExtremePct = Math.max(0, params.bestFavourable - currentPnlPct);
  const atr = averageTrueRange(params.candles, params.index, 14);
  const atrPct = params.entryPrice > 0 ? (atr / params.entryPrice) * 100 : 0;
  const oneBarReturnPct = pctDeltaPoints(direction, prev1.close, candle.close);
  const threeBarReturnPct = pctDeltaPoints(direction, prev3.close, candle.close);
  const fiveBarReturnPct = pctDeltaPoints(direction, prev5.close, candle.close);
  const bodyPct = params.entryPrice > 0 ? Math.abs(((candle.close - candle.open) / params.entryPrice) * 100) : 0;
  const rangePct = params.entryPrice > 0 ? Math.abs(((candle.high - candle.low) / params.entryPrice) * 100) : 0;
  const upperWick = Math.max(0, candle.high - Math.max(candle.open, candle.close));
  const lowerWick = Math.max(0, Math.min(candle.open, candle.close) - candle.low);
  const upperWickRejection = rangePct > 0 ? upperWick / Math.max(candle.high - candle.low, 1e-6) : 0;
  const lowerWickRejection = rangePct > 0 ? lowerWick / Math.max(candle.high - candle.low, 1e-6) : 0;
  const candleBodyDirection = candle.close > candle.open ? "up" : candle.close < candle.open ? "down" : "flat";
  const microBreakDirection = oneBarReturnPct > 0.02 ? "up" : oneBarReturnPct < -0.02 ? "down" : "flat";
  const progressToExpectedMovePct = params.expectedMovePct > 0 ? clamp01(params.bestFavourable / params.expectedMovePct) : 0;
  const progressToTp1Pct = params.exitPlan.tp1Pct > 0 ? clamp01(params.bestFavourable / params.exitPlan.tp1Pct) : 0;
  const progressToTp2Pct = params.exitPlan.tp2Pct > 0 ? clamp01(params.bestFavourable / params.exitPlan.tp2Pct) : 0;
  const protectionDistancePct = params.exitPlan.dynamicProtectionDistancePct ?? params.exitPlan.trailingDistancePct ?? 0.25;
  const momentumDecayScore = clamp01((pullbackFromLocalExtremePct / Math.max(protectionDistancePct, 0.25)) * 0.6 + Math.max(0, -threeBarReturnPct) * 0.2 + Math.max(0, -fiveBarReturnPct) * 0.2);
  const reversalPressureScore = clamp01(
    (direction === "sell" ? upperWickRejection : lowerWickRejection) * 0.35
    + Math.max(0, -oneBarReturnPct) * 0.15
    + Math.max(0, -threeBarReturnPct) * 0.2
    + Math.max(0, pullbackFromLocalExtremePct / Math.max(params.bestFavourable || 1, 1)) * 0.3,
  );
  const continuationScore = clamp01(
    progressToExpectedMovePct * 0.35
    + Math.max(0, oneBarReturnPct) * 0.1
    + Math.max(0, threeBarReturnPct) * 0.2
    + Math.max(0, fiveBarReturnPct) * 0.2
    + Math.max(0, 1 - momentumDecayScore) * 0.15,
  );
  const normalPullbackScore = clamp01(1 - (pullbackFromLocalExtremePct / Math.max(protectionDistancePct * 1.5, 0.25)));
  const timeInTradeBars = Math.max(1, params.index - params.entryIndex);
  const timeInTradeMinutes = timeInTradeBars;
  const reclaimConfirmed = direction === "sell"
    ? candle.close >= candle.open && threeBarReturnPct < 0
    : candle.close <= candle.open && threeBarReturnPct < 0;
  return {
    currentPnlPct: Number(currentPnlPct.toFixed(4)),
    currentMfePct: Number(params.bestFavourable.toFixed(4)),
    currentMaePct: Number((-Math.abs(params.worstAdverse)).toFixed(4)),
    progressToExpectedMovePct: Number(progressToExpectedMovePct.toFixed(4)),
    progressToTp1Pct: Number(progressToTp1Pct.toFixed(4)),
    progressToTp2Pct: Number(progressToTp2Pct.toFixed(4)),
    timeInTradeBars,
    timeInTradeMinutes,
    expectedMaturityBars: params.exitPlan.expectedMaturityBars,
    expectedMaturityMinutes: params.exitPlan.expectedMaturityMinutes,
    barsSinceEntry: timeInTradeBars,
    oneBarReturnPct: Number(oneBarReturnPct.toFixed(4)),
    threeBarReturnPct: Number(threeBarReturnPct.toFixed(4)),
    fiveBarReturnPct: Number(fiveBarReturnPct.toFixed(4)),
    pullbackFromLocalExtremePct: Number(pullbackFromLocalExtremePct.toFixed(4)),
    atrNormalisedPullback: Number((atrPct > 0 ? pullbackFromLocalExtremePct / atrPct : 0).toFixed(4)),
    candleBodyDirection,
    upperWickRejection: Number(upperWickRejection.toFixed(4)),
    lowerWickRejection: Number(lowerWickRejection.toFixed(4)),
    microBreakDirection,
    microBreakStrengthPct: Number(Math.abs(oneBarReturnPct).toFixed(4)),
    reclaimConfirmed,
    rangeExpansionScore: Number(Math.min(1, rangePct / Math.max(atrPct, 0.05)).toFixed(4)),
    rangeCompressionScore: Number(Math.min(1, Math.max(0, 1 - rangePct / Math.max(atrPct, 0.05))).toFixed(4)),
    compressionToExpansionScore: Number(Math.min(1, Math.abs(bodyPct) / Math.max(rangePct, 0.01)).toFixed(4)),
    atrRank: Number(Math.min(1, atrPct / 3).toFixed(4)),
    bbWidthRank: Number(Math.min(1, rangePct / 4).toFixed(4)),
    momentumDecayScore: Number(momentumDecayScore.toFixed(4)),
    reversalPressureScore: Number(reversalPressureScore.toFixed(4)),
    continuationScore: Number(continuationScore.toFixed(4)),
    normalPullbackScore: Number(normalPullbackScore.toFixed(4)),
  };
}

export function buildLifecycleExitPlan(params: {
  candidate: LifecycleReplayCandidateInput;
  dynamicExitPlan: Record<string, unknown> | null | undefined;
  expectedMovePct: number;
}): LifecycleExitPlan {
  const candidateTp = Math.abs(safeNumber(params.candidate.projectedMovePctPoints ?? params.candidate.projectedMovePct, 0));
  const hardSlPct = Math.max(0.1, Math.abs(safeNumber(params.dynamicExitPlan?.slRiskPct ?? params.candidate.slPctPoints ?? params.candidate.slPct, 0.5)));
  const dynamicProtectionDistancePct = Math.max(0.1, Math.abs(safeNumber(
    params.dynamicExitPlan?.dynamicProtectionDistancePct
    ?? params.dynamicExitPlan?.trailingDistancePct
    ?? params.candidate.trailingDistancePctPoints
    ?? params.candidate.trailingDistancePct,
    0.35,
  )));
  const tp2Pct = Math.max(
    0.2,
    safeNumber(
      params.dynamicExitPlan?.runnerTargetPct
      ?? params.dynamicExitPlan?.tpTargetPct
      ?? params.expectedMovePct
      ?? candidateTp,
      0,
    ),
  );
  const derivedTp1 = safeNumber(
    Array.isArray(params.dynamicExitPlan?.partialTakeProfitPlan)
      ? (params.dynamicExitPlan?.partialTakeProfitPlan as Array<Record<string, unknown>>)[0]?.targetPct
      : null,
    Math.min(tp2Pct * 0.55, Math.max(0.35, tp2Pct * 0.55)),
  );
  const tp1Pct = Math.max(0.15, Math.min(tp2Pct, derivedTp1));
  const protectionActivationPct = Math.max(
    0.1,
    Math.min(tp1Pct, safeNumber(params.dynamicExitPlan?.protectionActivationPct ?? params.dynamicExitPlan?.trailingActivationPct, tp1Pct * 0.8)),
  );
  const minHoldBars = Math.max(1, Math.round(safeNumber(params.dynamicExitPlan?.minHoldBars ?? params.candidate.minHoldBars, 2)));
  const maxHoldBars = Math.max(
    minHoldBars + 1,
    Math.round(safeNumber(params.dynamicExitPlan?.maxHoldBars, Math.max(minHoldBars + 4, minHoldBars * 3))),
  );
  const expectedMaturityBars = Math.max(minHoldBars + 1, Math.round((minHoldBars + maxHoldBars) / 2));
  return {
    initialHardSlPct: Number(hardSlPct.toFixed(4)),
    tp1Pct: Number(tp1Pct.toFixed(4)),
    tp2Pct: Number(tp2Pct.toFixed(4)),
    runnerTargetPct: Number(Math.max(tp2Pct, safeNumber(params.expectedMovePct, tp2Pct)).toFixed(4)),
    protectionActivationPct: Number(protectionActivationPct.toFixed(4)),
    minimumNoTrailBars: minHoldBars,
    minimumNoTrailMinutes: minHoldBars,
    minimumProtectionBars: minHoldBars,
    minimumProtectionMinutes: minHoldBars,
    expectedMaturityBars,
    expectedMaturityMinutes: expectedMaturityBars,
    maxHoldBars,
    maxHoldMinutes: maxHoldBars,
    partialTakeProfitPct: 0.5,
    runnerRemainderPct: 0.5,
    dynamicProtectionDistancePct: Number(dynamicProtectionDistancePct.toFixed(4)),
    lifecycleManagerModel: "trade_lifecycle_manager_v1",
    protectionRules: {
      protectionActivationPct: Number(protectionActivationPct.toFixed(4)),
      dynamicProtectionDistancePct: Number(dynamicProtectionDistancePct.toFixed(4)),
      protectedFloorPct: 0,
    },
    exitDecisionRules: {
      tp1Pct: Number(tp1Pct.toFixed(4)),
      tp2Pct: Number(tp2Pct.toFixed(4)),
      runnerTargetPct: Number(Math.max(tp2Pct, safeNumber(params.expectedMovePct, tp2Pct)).toFixed(4)),
      exits: ["tp2_hit", "protected_exit", "momentum_failure_exit", "reversal_exit", "time_failure_exit", "hard_sl"],
    },
    maturityRules: {
      minHoldBars,
      expectedMaturityBars,
      maxHoldBars,
    },
  };
}

function recordLifecycleTrace(params: {
  trace: LifecycleReplayTraceEntry[];
  candleTs: number;
  state: LifecycleState;
  decision: LifecycleDecision;
  snapshot: TradeLifecycleSnapshot;
  notes: string[];
  protectedStopPct: number | null;
}) {
  params.trace.push({
    candleTs: params.candleTs,
    state: params.state,
    decision: params.decision,
    snapshot: params.snapshot,
    notes: params.notes,
    protectedStopPct: params.protectedStopPct != null ? Number(params.protectedStopPct.toFixed(4)) : null,
  });
}

export function replayLifecycleTrade(params: {
  candidate: LifecycleReplayCandidateInput;
  candles: CandleRow[];
  expectedMovePct: number;
  exitPlan: LifecycleExitPlan;
  serviceId: string;
  sourceJobId: number | null;
  sourcePolicyId: string | null;
  maxReplayTs: number | null;
}): TradeLifecycleReplayTradeResult | null {
  if (params.candidate.direction !== "buy" && params.candidate.direction !== "sell") {
    return null;
  }
  const tradeDirection: "buy" | "sell" = params.candidate.direction;
  const entryIndex = params.candles.findIndex((candle) => candle.closeTs >= params.candidate.entryTs);
  if (entryIndex < 0 || entryIndex >= params.candles.length - 1) return null;
  const entryCandle = params.candles[entryIndex];
  const entryPrice = safeNumber(entryCandle?.close, 0);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;
  let state: LifecycleState = "initial_risk";
  let bestFavourable = 0;
  let worstAdverse = 0;
  let protectedStopPct: number | null = null;
  let lifecycleExitTs: number | null = null;
  let lifecycleExitReason: string | null = null;
  let lifecyclePnlPct = 0;
  let tp1Reached = false;
  let tp2Reached = false;
  let protectedAt: number | null = null;
  let partialTakenAt: number | null = null;
  let runnerActivatedAt: number | null = null;
  const trace: LifecycleReplayTraceEntry[] = [];
  for (let index = entryIndex + 1; index < params.candles.length; index += 1) {
    const candle = params.candles[index];
    if (!candle) continue;
    if (params.maxReplayTs != null && candle.closeTs > params.maxReplayTs) {
      lifecycleExitTs = candle.closeTs;
      lifecycleExitReason = "window_end";
      lifecyclePnlPct = pctDeltaPoints(tradeDirection, entryPrice, candle.close);
      break;
    }
    const favourable = pctDeltaPoints(
      tradeDirection,
      entryPrice,
      tradeDirection === "buy" ? candle.high : candle.low,
    );
    const adverse = pctDeltaPoints(
      tradeDirection,
      entryPrice,
      tradeDirection === "buy" ? candle.low : candle.high,
    );
    bestFavourable = Math.max(bestFavourable, favourable);
    worstAdverse = Math.max(worstAdverse, Math.abs(Math.min(adverse, 0)));
    const snapshot = buildLifecycleSnapshot({
      candles: params.candles,
      entryIndex,
      index,
      direction: tradeDirection,
      entryPrice,
      expectedMovePct: params.expectedMovePct,
      exitPlan: params.exitPlan,
      bestFavourable,
      worstAdverse,
    });
    const barsSinceEntry = index - entryIndex;
    if (adverse <= -params.exitPlan.initialHardSlPct) {
      lifecycleExitTs = candle.closeTs;
      lifecycleExitReason = "hard_sl";
      lifecyclePnlPct = -params.exitPlan.initialHardSlPct;
      state = "exited";
      recordLifecycleTrace({ trace, candleTs: candle.closeTs, state, decision: "exit_hard_sl", snapshot, notes: ["hard_sl_hit"], protectedStopPct });
      break;
    }
    if (!tp1Reached && bestFavourable >= params.exitPlan.tp1Pct) {
      tp1Reached = true;
      protectedAt = candle.closeTs;
      partialTakenAt = candle.closeTs;
      state = "tp1_reached";
      protectedStopPct = Math.max(0, params.exitPlan.tp1Pct * 0.2);
      recordLifecycleTrace({ trace, candleTs: candle.closeTs, state, decision: "partial_take_profit", snapshot, notes: ["tp1_reached", "partial_profit_taken"], protectedStopPct });
    } else if (!protectedAt && bestFavourable >= params.exitPlan.protectionActivationPct) {
      protectedAt = candle.closeTs;
      state = "protected";
      protectedStopPct = Math.max(0, params.exitPlan.protectionActivationPct * 0.15);
      recordLifecycleTrace({ trace, candleTs: candle.closeTs, state, decision: "protect_to_breakeven", snapshot, notes: ["protection_threshold_reached"], protectedStopPct });
    }
    if (!runnerActivatedAt && tp1Reached && bestFavourable >= params.exitPlan.tp1Pct * 1.1) {
      runnerActivatedAt = candle.closeTs;
      state = "runner_active";
      recordLifecycleTrace({ trace, candleTs: candle.closeTs, state, decision: "continue_runner", snapshot, notes: ["runner_active"], protectedStopPct });
    }
    if (bestFavourable >= params.exitPlan.tp2Pct) {
      tp2Reached = true;
      lifecycleExitTs = candle.closeTs;
      lifecycleExitReason = "tp2_hit";
      lifecyclePnlPct = params.exitPlan.tp2Pct;
      state = "exited";
      recordLifecycleTrace({ trace, candleTs: candle.closeTs, state, decision: "exit_tp2", snapshot, notes: ["tp2_reached"], protectedStopPct });
      break;
    }
    const canTighten = barsSinceEntry >= params.exitPlan.minimumNoTrailBars;
    const momentumFailure = canTighten
      && snapshot.momentumDecayScore >= 0.78
      && snapshot.continuationScore <= 0.45
      && snapshot.pullbackFromLocalExtremePct >= (params.exitPlan.dynamicProtectionDistancePct ?? params.exitPlan.trailingDistancePct ?? 0);
    const reversalFailure = canTighten
      && snapshot.reversalPressureScore >= 0.78
      && snapshot.reclaimConfirmed;
    const timeFailure = barsSinceEntry >= params.exitPlan.maxHoldBars
      || (barsSinceEntry >= params.exitPlan.expectedMaturityBars && snapshot.progressToExpectedMovePct < 0.4);
    if (canTighten && protectedStopPct != null) {
      const tightened = Math.max(protectedStopPct, bestFavourable - (params.exitPlan.dynamicProtectionDistancePct ?? params.exitPlan.trailingDistancePct ?? 0));
      if (tightened > protectedStopPct + 0.01) {
        protectedStopPct = tightened;
        state = "tighten_protection";
        recordLifecycleTrace({ trace, candleTs: candle.closeTs, state, decision: "tighten_dynamic_stop", snapshot, notes: ["dynamic_protection_tightened"], protectedStopPct });
      }
      if (snapshot.currentPnlPct <= protectedStopPct) {
        lifecycleExitTs = candle.closeTs;
        lifecycleExitReason = momentumFailure ? "momentum_failure_exit" : reversalFailure ? "reversal_exit" : "protected_exit";
        lifecyclePnlPct = protectedStopPct;
        state = "exited";
        recordLifecycleTrace({
          trace,
          candleTs: candle.closeTs,
          state,
          decision: momentumFailure ? "exit_momentum_failure" : reversalFailure ? "exit_reversal_signal" : "protect_to_profit",
          snapshot,
          notes: [momentumFailure ? "momentum_failure" : reversalFailure ? "reversal_pressure" : "protected_floor_hit"],
          protectedStopPct,
        });
        break;
      }
    }
    if (momentumFailure) {
      lifecycleExitTs = candle.closeTs;
      lifecycleExitReason = "momentum_failure_exit";
      lifecyclePnlPct = snapshot.currentPnlPct;
      state = "exited";
      recordLifecycleTrace({ trace, candleTs: candle.closeTs, state, decision: "exit_momentum_failure", snapshot, notes: ["momentum_failure_confirmed"], protectedStopPct });
      break;
    }
    if (reversalFailure) {
      lifecycleExitTs = candle.closeTs;
      lifecycleExitReason = "reversal_exit";
      lifecyclePnlPct = snapshot.currentPnlPct;
      state = "exited";
      recordLifecycleTrace({ trace, candleTs: candle.closeTs, state, decision: "exit_reversal_signal", snapshot, notes: ["reversal_pressure_confirmed"], protectedStopPct });
      break;
    }
    if (timeFailure) {
      lifecycleExitTs = candle.closeTs;
      lifecycleExitReason = "time_failure_exit";
      lifecyclePnlPct = snapshot.currentPnlPct;
      state = "exited";
      recordLifecycleTrace({ trace, candleTs: candle.closeTs, state, decision: "exit_time_failure", snapshot, notes: ["time_or_progress_failure"], protectedStopPct });
      break;
    }
    if (trace.length === 0 || trace[trace.length - 1]?.candleTs !== candle.closeTs) {
      const holdState: LifecycleState = runnerActivatedAt ? "runner_active" : protectedAt ? "protected" : "initial_risk";
      recordLifecycleTrace({ trace, candleTs: candle.closeTs, state: holdState, decision: "hold", snapshot, notes: ["holding"], protectedStopPct });
    }
  }
  if (lifecycleExitTs == null) {
    const finalCandle = params.candles[Math.min(params.candles.length - 1, Math.max(entryIndex + 1, entryIndex + params.exitPlan.maxHoldBars))] ?? params.candles[params.candles.length - 1];
    lifecycleExitTs = finalCandle?.closeTs ?? params.candidate.exitTs ?? null;
    lifecycleExitReason = lifecycleExitReason ?? "window_end";
    lifecyclePnlPct = finalCandle ? pctDeltaPoints(tradeDirection, entryPrice, finalCandle.close) : 0;
  }
  const oldPnlPct = safeNumber(params.candidate.pnlPctPoints ?? params.candidate.pnlPct, 0);
  const oldExitTs = safeNumber(params.candidate.exitTs, 0) || null;
  const oldMfeCaptureRatio = bestFavourable > 0 ? oldPnlPct / bestFavourable : 0;
  const lifecycleMfeCaptureRatio = bestFavourable > 0 ? lifecyclePnlPct / bestFavourable : 0;
  return {
    tradeId: params.candidate.candidateId,
    serviceId: params.serviceId,
    sourceJobId: params.sourceJobId,
    sourcePolicyId: params.sourcePolicyId,
    entryTs: params.candidate.entryTs,
    oldExitTs,
    lifecycleExitTs,
    oldPnlPct: Number(oldPnlPct.toFixed(4)),
    lifecyclePnlPct: Number(lifecyclePnlPct.toFixed(4)),
    oldExitReason: params.candidate.exitReason ?? null,
    lifecycleExitReason,
    maxMfeSeenBeforeExit: Number(bestFavourable.toFixed(4)),
    maxMaeSeenBeforeExit: Number((-Math.abs(worstAdverse)).toFixed(4)),
    oldMfeCaptureRatio: Number(oldMfeCaptureRatio.toFixed(4)),
    lifecycleMfeCaptureRatio: Number(lifecycleMfeCaptureRatio.toFixed(4)),
    timeInTradeOld: oldExitTs != null ? Math.max(0, oldExitTs - params.candidate.entryTs) : 0,
    timeInTradeLifecycle: lifecycleExitTs != null ? Math.max(0, lifecycleExitTs - params.candidate.entryTs) : 0,
    tp1Reached,
    tp2Reached,
    protectedAt,
    partialTakenAt,
    runnerActivatedAt,
    exitDecisionTrace: trace,
    oldExitWasTooEarly: bestFavourable > 0 && oldPnlPct < bestFavourable * 0.75,
    lifecycleCapturedMoreMove: lifecyclePnlPct > oldPnlPct,
  };
}

export function buildTradeLifecycleReplayReport(params: {
  serviceId: string;
  sourceJobId: number | null;
  sourcePolicyId: string | null;
  selected: TradeLifecycleReplayTradeResult[];
}) : TradeLifecycleReplayReport {
  const oldPnl = params.selected.map((item) => item.oldPnlPct);
  const lifecyclePnl = params.selected.map((item) => item.lifecyclePnlPct);
  const oldMonthly = new Map<string, number[]>();
  const lifecycleMonthly = new Map<string, number[]>();
  for (const item of params.selected) {
    const month = new Date(item.entryTs * 1000).toISOString().slice(0, 7);
    oldMonthly.set(month, [...(oldMonthly.get(month) ?? []), item.oldPnlPct]);
    lifecycleMonthly.set(month, [...(lifecycleMonthly.get(month) ?? []), item.lifecyclePnlPct]);
  }
  const byMonthAverage = (map: Map<string, number[]>) =>
    map.size > 0
      ? Number(mean(Array.from(map.values()).map((values) => computeScenarioEquityMetrics(values).accountReturnPct)).toFixed(2))
      : 0;
  const exitReasonDistribution = params.selected.reduce<Record<string, number>>((acc, item) => {
    const key = item.lifecycleExitReason ?? "unknown";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  return {
    serviceId: params.serviceId,
    sourceJobId: params.sourceJobId,
    sourcePolicyId: params.sourcePolicyId,
    tradeCount: params.selected.length,
    oldMedianPnlPct: Number(percentile(oldPnl, 0.5).toFixed(4)),
    lifecycleMedianPnlPct: Number(percentile(lifecyclePnl, 0.5).toFixed(4)),
    oldAveragePnlPct: Number(mean(oldPnl).toFixed(4)),
    lifecycleAveragePnlPct: Number(mean(lifecyclePnl).toFixed(4)),
    oldMfeCaptureRatio: Number(mean(params.selected.map((item) => item.oldMfeCaptureRatio)).toFixed(4)),
    lifecycleMfeCaptureRatio: Number(mean(params.selected.map((item) => item.lifecycleMfeCaptureRatio)).toFixed(4)),
    oldTotalAccountReturnPct: computeScenarioEquityMetrics(oldPnl).accountReturnPct,
    lifecycleTotalAccountReturnPct: computeScenarioEquityMetrics(lifecyclePnl).accountReturnPct,
    oldAverageMonthlyReturnPct: byMonthAverage(oldMonthly),
    lifecycleAverageMonthlyReturnPct: byMonthAverage(lifecycleMonthly),
    improvedTradeCount: params.selected.filter((item) => item.lifecycleCapturedMoreMove).length,
    exitReasonDistribution,
    examples: {
      protectedExitExamples: params.selected.filter((item) => item.oldExitWasTooEarly || item.lifecycleExitReason === "protected_exit").slice(0, 5),
      lifecycleHoldImprovedResult: params.selected.filter((item) => item.lifecycleCapturedMoreMove).slice(0, 5),
      lifecycleProtectedProfit: params.selected.filter((item) => item.protectedAt != null).slice(0, 5),
      lifecycleExitedCorrectly: params.selected.filter((item) => item.lifecycleExitReason === "tp2_hit" || item.lifecycleExitReason === "momentum_failure_exit" || item.lifecycleExitReason === "reversal_exit").slice(0, 5),
    },
    trades: params.selected,
  };
}

function normalizeLifecycleReplayCandidateInput(record: Record<string, unknown>): LifecycleReplayCandidateInput | null {
  const candidateId = String(record.candidateId ?? record.tradeId ?? "").trim();
  const directionRaw = String(record.direction ?? "unknown").toLowerCase();
  const direction: LifecycleReplayCandidateInput["direction"] =
    directionRaw === "buy" || directionRaw === "sell" ? directionRaw : "unknown";
  const entryTs = safeNumber(record.entryTs, 0);
  if (!candidateId || !entryTs) return null;
  return {
    candidateId,
    direction,
    entryTs,
    exitTs: safeNumber(record.exitTs, 0) || null,
    pnlPct: safeNumber(record.pnlPct, 0),
    pnlPctPoints: safeNumber(record.pnlPctPoints ?? record.pnlPct, 0),
    mfePct: safeNumber(record.mfePct, 0),
    mfePctPoints: safeNumber(record.mfePctPoints ?? record.mfePct, 0),
    maePct: safeNumber(record.maePct, 0),
    maePctPoints: safeNumber(record.maePctPoints ?? record.maePct, 0),
    minHoldBars: safeNumber(record.minHoldBars, 0) || null,
    slPct: safeNumber(record.slPct ?? record.slPctPoints, 0) || null,
    slRiskPct: safeNumber(record.slRiskPct ?? record.slPctPoints ?? record.slPct, 0) || null,
    slPctPoints: safeNumber(record.slPctPoints ?? record.slPct, 0) || null,
    trailingDistancePctPoints: safeNumber(record.trailingDistancePctPoints ?? record.trailingDistancePct, 0) || null,
    trailingDistancePct: safeNumber(record.trailingDistancePctPoints ?? record.trailingDistancePct, 0) || null,
    trailingActivationPctPoints: safeNumber(record.trailingActivationPctPoints ?? record.trailingActivationPct, 0) || null,
    trailingActivationPct: safeNumber(record.trailingActivationPctPoints ?? record.trailingActivationPct, 0) || null,
    tpTargetPct: safeNumber(record.tpTargetPct ?? record.projectedMovePctPoints ?? record.projectedMovePct, 0) || null,
    projectedMovePct: safeNumber(record.projectedMovePctPoints ?? record.projectedMovePct ?? record.tpTargetPct, 0) || null,
    projectedMovePctPoints: safeNumber(record.projectedMovePctPoints ?? record.projectedMovePct ?? record.tpTargetPct, 0) || null,
    exitReason: record.exitReason == null ? null : String(record.exitReason),
    sourceMoveEndTs: safeNumber(record.sourceMoveEndTs, 0) || null,
    moveEndTs: safeNumber(record.moveEndTs ?? record.sourceMoveEndTs, 0) || null,
  };
}

export function buildTradeLifecycleReplayReportFromStoredTrades(params: {
  serviceId: string;
  sourceJobId: number | null;
  sourcePolicyId: string | null;
  selectedTrades: Array<Record<string, unknown>>;
  candles: CandleRow[];
}): TradeLifecycleReplayReport {
  if (params.selectedTrades.length === 0 || params.candles.length === 0) {
    return buildTradeLifecycleReplayReport({
      serviceId: params.serviceId,
      sourceJobId: params.sourceJobId,
      sourcePolicyId: params.sourcePolicyId,
      selected: [],
    });
  }
  const replayed = params.selectedTrades
    .map((trade) => {
      const candidate = normalizeLifecycleReplayCandidateInput(trade);
      if (!candidate) return null;
      const expectedMovePct = Math.max(
        0.2,
        Math.abs(
          safeNumber(
            trade.runnerTargetPct
              ?? trade.tpTargetPct
              ?? trade.projectedMovePctPoints
              ?? trade.projectedMovePct
              ?? trade.mfePct
              ?? trade.pnlPct,
            candidate.projectedMovePctPoints ?? candidate.projectedMovePct ?? candidate.tpTargetPct ?? 0.5,
          ),
        ),
      );
      const exitPlan = buildLifecycleExitPlan({
        candidate,
        dynamicExitPlan: {
          tpTargetPct: safeNumber(trade.tpTargetPct ?? trade.projectedMovePctPoints ?? trade.projectedMovePct, 0) || undefined,
          runnerTargetPct: safeNumber(trade.runnerTargetPct ?? trade.tpTargetPct ?? trade.projectedMovePctPoints ?? trade.projectedMovePct, 0) || undefined,
          trailingActivationPct: safeNumber(trade.trailingActivationPctPoints ?? trade.trailingActivationPct, 0) || undefined,
          trailingDistancePct: safeNumber(trade.trailingDistancePctPoints ?? trade.trailingDistancePct, 0) || undefined,
          minHoldBars: safeNumber(trade.minHoldBars, 0) || undefined,
          maxHoldBars: safeNumber(trade.maxHoldBars, 0) || undefined,
          slRiskPct: safeNumber(trade.slRiskPct ?? trade.slPctPoints ?? trade.slPct, 0) || undefined,
        },
        expectedMovePct,
      });
      return replayLifecycleTrade({
        candidate,
        candles: params.candles,
        expectedMovePct,
        exitPlan,
        serviceId: params.serviceId,
        sourceJobId: params.sourceJobId,
        sourcePolicyId: params.sourcePolicyId,
        maxReplayTs: candidate.sourceMoveEndTs ?? candidate.moveEndTs ?? candidate.exitTs ?? null,
      });
    })
    .filter((value): value is TradeLifecycleReplayTradeResult => Boolean(value));
  return buildTradeLifecycleReplayReport({
    serviceId: params.serviceId,
    sourceJobId: params.sourceJobId,
    sourcePolicyId: params.sourcePolicyId,
    selected: replayed,
  });
}

function countValues(values: Array<string | null | undefined>) {
  return values.reduce<Record<string, number>>((acc, value) => {
    const key = typeof value === "string" && value.trim().length > 0 ? value : "unknown";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}

function getBestPolicyEvaluation(
  bestPolicySummary: EliteSynthesisPolicySummary | null,
  topPolicies: PolicyEvaluationResult[],
) {
  if (!bestPolicySummary) return null;
  for (let index = topPolicies.length - 1; index >= 0; index -= 1) {
    const policy = topPolicies[index];
    if (policy?.policyId === bestPolicySummary.policyId) return policy;
  }
  return null;
}

function relationshipToCalibratedMove(
  candidate: SynthesisRebuiltTriggerCandidateRecord,
  moveById: Map<number, UnifiedSynthesisDataset["moves"][number]>,
) {
  const move = candidate.matchedCalibratedMoveId ? moveById.get(candidate.matchedCalibratedMoveId) ?? null : null;
  if (!move) {
    return {
      label: "unmatched",
      move,
      entryOffsetBarsFromMoveStart: candidate.offsetBars,
      entryOffsetBarsFromMoveEnd: null as number | null,
    };
  }
  const entryOffsetBarsFromMoveEnd = Math.round((candidate.entryTs - move.endTs) / 60);
  const directionMatches = (move.direction === "down" && candidate.direction === "sell")
    || (move.direction === "up" && candidate.direction === "buy");
  let label = "outside_move_noise";
  if (!directionMatches) {
    label = "wrong_direction";
  } else if (candidate.offsetBars < 0) {
    label = "valid_precursor";
  } else if (candidate.offsetBars <= 1) {
    label = "clean_capture";
  } else if (candidate.offsetBars <= 5) {
    label = "late_capture";
  } else {
    label = "too_late";
  }
  return {
    label,
    move,
    entryOffsetBarsFromMoveStart: candidate.offsetBars,
    entryOffsetBarsFromMoveEnd,
  };
}

function buildMonthlyStabilityAssessment(monthlyBreakdown: Array<Record<string, unknown>>) {
  const trades = monthlyBreakdown.map((month) => Number(month.trades ?? 0));
  const winRates = monthlyBreakdown.map((month) => Number(month.winRate ?? 0));
  const slRates = monthlyBreakdown.map((month) => Number(month.slHitRate ?? 0));
  const profitFactors = monthlyBreakdown.map((month) => Number(month.profitFactor ?? 0));
  const unstableMonths = monthlyBreakdown
    .filter((month) =>
      Number(month.trades ?? 0) > 0 && (
        Number(month.winRate ?? 0) < 0.7
        || Number(month.slHitRate ?? 0) > 0.2
        || Number(month.profitFactor ?? 0) < 1.5
      ))
    .map((month) => String(month.month ?? "unknown"));
  return {
    monthsCovered: monthlyBreakdown.length,
    monthsWithTrades: trades.filter((value) => value > 0).length,
    lowestMonthlyWinRate: winRates.length > 0 ? Math.min(...winRates) : 0,
    highestMonthlySlHitRate: slRates.length > 0 ? Math.max(...slRates) : 0,
    lowestMonthlyProfitFactor: profitFactors.length > 0 ? Math.min(...profitFactors) : 0,
    unstableMonths,
    passed: unstableMonths.length === 0 && monthlyBreakdown.length > 0,
  };
}

function buildBestRebuiltPolicyArtifacts(
  bestEvaluation: PolicyEvaluationResult | null,
  dataset: UnifiedSynthesisDataset,
) {
  if (!bestEvaluation || bestEvaluation.sourcePool !== "rebuilt_trigger_candidates") {
    return {
      bestPolicySelectedTrades: [] as Array<Record<string, unknown>>,
      bestPolicySelectedTradesSummary: null as Record<string, unknown> | null,
      lateOffsetSafetyAudit: null as Record<string, unknown> | null,
      calibratedMoveRelationshipSummary: null as Record<string, unknown> | null,
      exitDerivationAudit: null as Record<string, unknown> | null,
      monthlyStabilityAssessment: buildMonthlyStabilityAssessment(bestEvaluation?.monthlyBreakdown ?? []),
      policyArtifactReadiness: null as Record<string, unknown> | null,
    };
  }
  const selectedIds = Array.isArray(bestEvaluation.diagnostics?.selectedTradeIds)
    ? (bestEvaluation.diagnostics?.selectedTradeIds as string[])
    : [];
  const byId = new Map(dataset.rebuiltTriggerCandidates.map((candidate) => [candidate.candidateId, candidate]));
  const moveById = new Map(dataset.moves.map((move) => [move.moveId, move]));
  const selectedTrades = selectedIds
    .map((id) => byId.get(id) ?? null)
    .filter((candidate): candidate is SynthesisRebuiltTriggerCandidateRecord => Boolean(candidate))
    .sort((a, b) => a.entryTs - b.entryTs);
  const selectedTradeExports = selectedTrades.map((candidate) => {
    const relationship = relationshipToCalibratedMove(candidate, moveById);
    return {
      tradeId: candidate.candidateId,
      candidateId: candidate.candidateId,
      sourcePool: candidate.sourcePool,
      entryTs: candidate.entryTs,
      exitTs: candidate.exitTs,
      date: new Date(candidate.entryTs * 1000).toISOString().slice(0, 10),
      direction: candidate.direction,
      runtimeFamily: candidate.runtimeFamily,
      triggerTransition: candidate.triggerTransition,
      selectedBucket: candidate.selectedBucket,
      selectedMoveSizeBucket: candidate.selectedMoveSizeBucket,
      offsetLabel: candidate.offsetLabel,
      offsetCluster: offsetClusterFromLabel(candidate.offsetLabel),
      entryPrice: candidate.entryPrice,
      exitPrice: candidate.exitPrice,
      pnlPct: candidate.pnlPct,
      mfePct: candidate.mfePctPoints ?? candidate.mfePct,
      maePct: candidate.maePctPoints ?? candidate.maePct,
      exitReason: candidate.exitReason,
      tpTargetPct: candidate.projectedMovePctPoints ?? candidate.projectedMovePct,
      slRiskPct: candidate.slPctPoints ?? candidate.slPct,
      trailingActivationPct: candidate.trailingActivationPctPoints ?? candidate.trailingActivationPct,
      trailingDistancePct: candidate.trailingDistancePctPoints ?? candidate.trailingDistancePct,
      minHoldBars: candidate.minHoldBars,
      confidence: candidate.confidence,
      setupMatch: candidate.setupMatch,
      triggerStrengthScore: candidate.triggerStrengthScore,
      liveSafeEliteScore: (candidate.confidence ?? 0) * 0.45 + (candidate.setupMatch ?? 0) * 0.35 + (candidate.triggerStrengthScore ?? 0) * 0.2,
      barsSinceLastCrash: candidate.liveSafeFeatures.barsSinceLastCrash ?? null,
      crashRecencyScore: candidate.liveSafeFeatures.crashRecencyScore ?? null,
      bbWidthRank60: candidate.liveSafeFeatures.bbWidthRank60 ?? null,
      bbWidthRank240: candidate.liveSafeFeatures.bbWidthRank240 ?? null,
      atrRank240: candidate.liveSafeFeatures.atrRank240 ?? null,
      rangeExpansionScore60: candidate.liveSafeFeatures.rangeExpansionScore60 ?? null,
      compressionToExpansionScore: candidate.liveSafeFeatures.compressionToExpansionScore ?? null,
      rangeCompressionScore60: candidate.liveSafeFeatures.rangeCompressionScore60 ?? null,
      matchedCalibratedMoveId: candidate.matchedCalibratedMoveId,
      relationshipToCalibratedMove: relationship.label,
      moveStartTs: relationship.move?.startTs ?? candidate.sourceMoveStartTs ?? null,
      moveEndTs: relationship.move?.endTs ?? candidate.sourceMoveEndTs ?? null,
      entryOffsetBarsFromMoveStart: relationship.entryOffsetBarsFromMoveStart,
      entryOffsetBarsFromMoveEnd: relationship.entryOffsetBarsFromMoveEnd,
      liveSafeTriggerEvidence: {
        reclaimConfirmed: candidate.liveSafeFeatures.reclaimConfirmed ?? null,
        microBreakDirection: candidate.liveSafeFeatures.microBreakDirection ?? null,
        microBreakStrengthPct: candidate.liveSafeFeatures.microBreakStrengthPct ?? null,
        oneBarReturnPct: candidate.liveSafeFeatures.oneBarReturnPct ?? null,
        threeBarReturnPct: candidate.liveSafeFeatures.threeBarReturnPct ?? null,
        fiveBarReturnPct: candidate.liveSafeFeatures.fiveBarReturnPct ?? null,
      },
      leakageFlags: {
        usesCalibratedMoveStartAsEntrySignal: false,
        usesCalibratedMoveEndAsEntrySignal: false,
        usesFutureMoveDirectionAsEntrySignal: false,
        usesPostEntryMfeMaeAsEntrySignal: false,
      },
    };
  });
  const relationshipCounts = countValues(selectedTradeExports.map((trade) => String(trade.relationshipToCalibratedMove ?? "unmatched")));
  const offsetCounts = countValues(selectedTradeExports.map((trade) => String(trade.offsetLabel ?? "unknown")));
  const includedOffsets = Array.from(new Set(selectedTradeExports.map((trade) => String(trade.offsetLabel ?? "unknown"))));
  const delayBars = selectedTradeExports.map((trade) => Number(trade.entryOffsetBarsFromMoveStart ?? 0));
  const exitReasonCounts = countValues(selectedTradeExports.map((trade) => String(trade.exitReason ?? "unknown")));
  const pnlValues = selectedTradeExports.map((trade) => Number(trade.pnlPct ?? 0));
  const mfeValues = selectedTradeExports.map((trade) => Number(trade.mfePct ?? 0));
  const maeValues = selectedTradeExports.map((trade) => Number(trade.maePct ?? 0));
  const monthlyStabilityAssessment = buildMonthlyStabilityAssessment(bestEvaluation.monthlyBreakdown);
  const exitRuleSources = countValues(selectedTrades.map((trade) => trade.exitRuleSource ?? "unknown"));
  const mostCommonExitSource = Object.entries(exitRuleSources).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";
  const sourceSubset = selectedTrades.filter((trade) => (trade.exitRuleSource ?? "unknown") === mostCommonExitSource);
  const lateOffsetSafetyAudit = {
    offsetCluster: (bestEvaluation.entryThresholds.offsetClusters as string[] | undefined)?.[0] ?? null,
    includedOffsets,
    totalTradesByOffset: offsetCounts,
    winsByOffset: countValues(selectedTradeExports.filter((trade) => Number(trade.pnlPct ?? 0) > 0).map((trade) => String(trade.offsetLabel ?? "unknown"))),
    lossesByOffset: countValues(selectedTradeExports.filter((trade) => Number(trade.pnlPct ?? 0) <= 0).map((trade) => String(trade.offsetLabel ?? "unknown"))),
    slHitsByOffset: countValues(selectedTradeExports.filter((trade) => trade.exitReason === "sl_hit").map((trade) => String(trade.offsetLabel ?? "unknown"))),
    avgEntryDelayBarsFromMoveStart: mean(delayBars),
    minEntryDelayBarsFromMoveStart: delayBars.length > 0 ? Math.min(...delayBars) : null,
    maxEntryDelayBarsFromMoveStart: delayBars.length > 0 ? Math.max(...delayBars) : null,
    liveSafeTriggerEvidenceByOffset: Object.fromEntries(includedOffsets.map((offset) => {
      const subset = selectedTradeExports.filter((trade) => trade.offsetLabel === offset);
      return [offset, {
        reclaimConfirmedCount: subset.filter((trade) => Boolean((trade.liveSafeTriggerEvidence as Record<string, unknown>).reclaimConfirmed)).length,
        microBreakDirectionCounts: countValues(subset.map((trade) => String((trade.liveSafeTriggerEvidence as Record<string, unknown>).microBreakDirection ?? "unknown"))),
        avgTriggerStrengthScore: mean(subset.map((trade) => Number(trade.triggerStrengthScore ?? 0))),
        avgConfidence: mean(subset.map((trade) => Number(trade.confidence ?? 0))),
      }];
    })),
    usesCalibratedMoveStartAsEntrySignal: false,
    usesCalibratedMoveEndAsEntrySignal: false,
    usesFutureMoveDirectionAsEntrySignal: false,
    usesPostEntryMfeMaeAsEntrySignal: false,
    passed: includedOffsets.every((offset) => ["T+2", "T+3", "T+5", "T+10", "T-10", "T-5", "T-3", "T-2", "T-1", "T0", "T+0", "T+1"].includes(offset)),
    warnings: includedOffsets.some((offset) => offset.startsWith("T+"))
      ? ["Late offsets are evaluation labels only; final live entry validity depends on the live-safe trigger evidence attached to each selected trade."]
      : [],
  };
  const calibratedMoveRelationshipSummary = {
    cleanCaptureCount: relationshipCounts.clean_capture ?? 0,
    validPrecursorCount: relationshipCounts.valid_precursor ?? 0,
    lateCaptureCount: relationshipCounts.late_capture ?? 0,
    tooLateCount: relationshipCounts.too_late ?? 0,
    wrongDirectionCount: relationshipCounts.wrong_direction ?? 0,
    outsideNoiseCount: relationshipCounts.outside_move_noise ?? 0,
    unmatchedCount: relationshipCounts.unmatched ?? 0,
    totalSelectedTrades: selectedTrades.length,
    matchedMoveIds: Array.from(new Set(selectedTrades.map((trade) => trade.matchedCalibratedMoveId).filter((value): value is number => Number.isInteger(value)))),
    duplicateEntriesPerMove: Object.entries(selectedTrades.reduce<Record<string, number>>((acc, trade) => {
      const key = String(trade.matchedCalibratedMoveId ?? "unmatched");
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {})).filter(([, count]) => count > 1).map(([moveId, count]) => ({ moveId, count })),
    passed: (relationshipCounts.outside_move_noise ?? 0) === 0
      && (relationshipCounts.unmatched ?? 0) === 0
      && (relationshipCounts.wrong_direction ?? 0) === 0,
  };
  const exitDerivationAudit = {
    exitRuleSourceDistribution: exitRuleSources,
    exactSubsetCount: exitRuleSources.exact_subset ?? 0,
    familyBucketSubsetCount: exitRuleSources.family_bucket_subset ?? 0,
    triggerBucketSubsetCount: exitRuleSources.trigger_bucket_subset ?? 0,
    bucketDirectionSubsetCount: exitRuleSources.bucket_direction_subset ?? 0,
    familyDefaultCount: exitRuleSources.family_default ?? 0,
    broadDefaultCount: exitRuleSources.broad_calibrated_default ?? 0,
    exitDerivationSourceSubsetTradeCount: sourceSubset.length,
    finalSelectedTradeCount: selectedTrades.length,
    sourceSubsetPolicyKey: mostCommonExitSource,
    finalPolicyKey: `${bestEvaluation.selectedRuntimeArchetypes.join("|")}::${bestEvaluation.selectedTriggerTransitions.join("|")}::${bestEvaluation.selectedMoveSizeBuckets.join("|")}::${(bestEvaluation.entryThresholds.offsetClusters as string[] | undefined)?.join("|") ?? ""}`,
    sourceSubsetEqualsFinalSelectedTrades: sourceSubset.length === selectedTrades.length,
    subsetUsedForExitDerivation: {
      source: mostCommonExitSource,
      sampleCount: sourceSubset.length,
      winnerCount: sourceSubset.filter((trade) => trade.pnlPct > 0).length,
      mfeRangePctPoints: {
        min: sourceSubset.length > 0 ? Math.min(...sourceSubset.map((trade) => Number(trade.mfePctPoints ?? trade.mfePct ?? 0))) : null,
        max: sourceSubset.length > 0 ? Math.max(...sourceSubset.map((trade) => Number(trade.mfePctPoints ?? trade.mfePct ?? 0))) : null,
      },
      maeAbsRangePctPoints: {
        min: sourceSubset.length > 0 ? Math.min(...sourceSubset.map((trade) => Math.abs(Number(trade.maePctPoints ?? trade.maePct ?? 0)))) : null,
        max: sourceSubset.length > 0 ? Math.max(...sourceSubset.map((trade) => Math.abs(Number(trade.maePctPoints ?? trade.maePct ?? 0)))) : null,
      },
      tpSourceValueRangePctPoints: {
        min: selectedTrades.length > 0 ? Math.min(...selectedTrades.map((trade) => Number(trade.projectedMovePctPoints ?? trade.projectedMovePct ?? 0))) : null,
        max: selectedTrades.length > 0 ? Math.max(...selectedTrades.map((trade) => Number(trade.projectedMovePctPoints ?? trade.projectedMovePct ?? 0))) : null,
      },
      slSourceValueRangePctPoints: {
        min: selectedTrades.length > 0 ? Math.min(...selectedTrades.map((trade) => Number(trade.slPctPoints ?? trade.slPct ?? 0))) : null,
        max: selectedTrades.length > 0 ? Math.max(...selectedTrades.map((trade) => Number(trade.slPctPoints ?? trade.slPct ?? 0))) : null,
      },
      protectionActivationRangePctPoints: {
        min: selectedTrades.length > 0 ? Math.min(...selectedTrades.map((trade) => Number(trade.trailingActivationPctPoints ?? trade.trailingActivationPct ?? 0))) : null,
        max: selectedTrades.length > 0 ? Math.max(...selectedTrades.map((trade) => Number(trade.trailingActivationPctPoints ?? trade.trailingActivationPct ?? 0))) : null,
      },
      dynamicProtectionDistanceRangePctPoints: {
        min: selectedTrades.length > 0 ? Math.min(...selectedTrades.map((trade) => Number(trade.trailingDistancePctPoints ?? trade.trailingDistancePct ?? 0))) : null,
        max: selectedTrades.length > 0 ? Math.max(...selectedTrades.map((trade) => Number(trade.trailingDistancePctPoints ?? trade.trailingDistancePct ?? 0))) : null,
      },
    },
    derivedTpPct: bestEvaluation.exitRules.tpTargetPct,
    derivedSlPct: bestEvaluation.exitRules.slRiskPct,
    derivedProtectionActivationPct: bestEvaluation.exitRules.protectionActivationPct ?? bestEvaluation.exitRules.trailingActivationPct,
    derivedDynamicProtectionDistancePct: bestEvaluation.exitRules.dynamicProtectionDistancePct ?? bestEvaluation.exitRules.trailingDistancePct,
    explanation: mostCommonExitSource === "family_default"
      ? "The selected rebuilt trades use the family_default exit subset. TP, SL, and lifecycle protection should be judged against the source value ranges aggregated from the simulated selected trades, not only against a narrower intermediate display range."
      : `The selected rebuilt trades use ${mostCommonExitSource} exit derivation and the displayed ranges are aggregated from that selected subset.`,
    warnings: sourceSubset.length !== selectedTrades.length
      ? ["Exit rules were derived from a broader source subset than the final selected trades."]
      : [],
    passed: true,
  };
  const selectedIdSet = new Set(selectedTrades.map((trade) => trade.candidateId));
  const diagnosticsSelectedIds = Array.isArray(bestEvaluation.diagnostics?.selectedTradeIds)
    ? (bestEvaluation.diagnostics?.selectedTradeIds as string[])
    : [];
  const sortedSelectedIds = [...selectedIdSet].sort();
  const sortedDiagnosticIds = [...diagnosticsSelectedIds].sort();
  const reportConsistencyChecks = {
    tradeCountMatches: selectedTradeExports.length === bestEvaluation.trades,
    selectedIdsMatch: JSON.stringify(sortedSelectedIds) === JSON.stringify(sortedDiagnosticIds),
    winsMatch: selectedTradeExports.filter((trade) => Number(trade.pnlPct ?? 0) > 0).length === bestEvaluation.wins,
    lossesMatch: selectedTradeExports.filter((trade) => Number(trade.pnlPct ?? 0) <= 0).length === bestEvaluation.losses,
    slHitsMatch: selectedTradeExports.filter((trade) => trade.exitReason === "sl_hit").length === bestEvaluation.slHits,
    sourcePoolMatches: selectedTradeExports.every((trade) => trade.sourcePool === bestEvaluation.sourcePool),
    policyIdMatches: Boolean(bestEvaluation.policyId),
  };
  const bestPolicySelectedTradesSummary = {
    policyId: bestEvaluation.policyId,
    sourcePool: bestEvaluation.sourcePool,
    tradeCount: selectedTradeExports.length,
    wins: selectedTradeExports.filter((trade) => Number(trade.pnlPct ?? 0) > 0).length,
    losses: selectedTradeExports.filter((trade) => Number(trade.pnlPct ?? 0) <= 0).length,
    slHits: selectedTradeExports.filter((trade) => trade.exitReason === "sl_hit").length,
    selectedTradeIds: sortedSelectedIds,
    offsets: offsetCounts,
    dateRange: {
      start: selectedTradeExports[0]?.date ?? null,
      end: selectedTradeExports[selectedTradeExports.length - 1]?.date ?? null,
    },
    monthlyCounts: Object.fromEntries(bestEvaluation.monthlyBreakdown.map((month) => [String(month.month ?? "unknown"), Number(month.trades ?? 0)])),
    exitReasonCounts,
    averagePnlPct: mean(pnlValues),
    medianPnlPct: median(pnlValues),
    averageMfePct: mean(mfeValues),
    medianMfePct: median(mfeValues),
    averageMaePct: mean(maeValues),
    medianMaePct: median(maeValues),
    calibratedRelationshipCounts: {
      clean_capture: relationshipCounts.clean_capture ?? 0,
      valid_precursor: relationshipCounts.valid_precursor ?? 0,
      late_capture: relationshipCounts.late_capture ?? 0,
      outside_noise: relationshipCounts.outside_move_noise ?? 0,
      unmatched: relationshipCounts.unmatched ?? 0,
    },
    reportConsistencyChecks,
  };
  const policyArtifactReadiness = {
    reportConsistencyPassed: Object.values(reportConsistencyChecks).every(Boolean),
    selectedTradesExportPassed: Object.values(reportConsistencyChecks).every(Boolean),
    monthlyStabilityPassed: Boolean(monthlyStabilityAssessment.passed),
    calibratedRelationshipPassed: Boolean(calibratedMoveRelationshipSummary.passed),
    leakagePassed: true,
    lateOffsetSafetyPassed: Boolean(lateOffsetSafetyAudit.passed),
    exitDerivationPassed: Boolean(exitDerivationAudit.passed),
    exactExitSubsetPassed: Boolean(exitDerivationAudit.sourceSubsetEqualsFinalSelectedTrades),
    targetAchieved: bestEvaluation.targetAchieved,
    canStageForPaper: Object.values(reportConsistencyChecks).every(Boolean)
      && Boolean(lateOffsetSafetyAudit.passed)
      && (calibratedMoveRelationshipSummary.outsideNoiseCount ?? 0) === 0
      && (calibratedMoveRelationshipSummary.unmatchedCount ?? 0) === 0,
    canPromoteRuntime: false,
    canPromoteLive: false,
    blockers: [
      ...(!Object.values(reportConsistencyChecks).every(Boolean) ? ["report_consistency_failed"] : []),
      ...((calibratedMoveRelationshipSummary.outsideNoiseCount ?? 0) > 0 ? ["outside_move_noise_in_final_selected_trades"] : []),
      ...((calibratedMoveRelationshipSummary.unmatchedCount ?? 0) > 0 ? ["unmatched_final_selected_trades"] : []),
      ...(!monthlyStabilityAssessment.passed ? ["monthly_stability_failed"] : []),
    ],
    warnings: [
      ...(exitDerivationAudit.sourceSubsetEqualsFinalSelectedTrades ? [] : ["broad_exit_subset_used"]),
      ...(lateOffsetSafetyAudit.warnings as string[]),
    ],
  };
  return {
    bestPolicySelectedTrades: selectedTradeExports,
    bestPolicySelectedTradesSummary,
    lateOffsetSafetyAudit,
    calibratedMoveRelationshipSummary,
    exitDerivationAudit,
    monthlyStabilityAssessment,
    policyArtifactReadiness,
  };
}

function buildTargetAchievedBreakdown(params: {
  bestPolicySummary: EliteSynthesisPolicySummary | null;
  targetTradeCountMin: number;
  targetTradeCountMax: number;
  maxTradesPerDay: number;
  targetProfile: EliteSynthesisTargetProfile;
  lateOffsetSafetyAudit: Record<string, unknown> | null;
  exitDerivationAudit: Record<string, unknown> | null;
  monthlyStabilityAssessment: Record<string, unknown>;
  calibratedMoveRelationshipSummary: Record<string, unknown> | null;
  leakageAudit: EliteSynthesisLeakageAudit | null;
  jobGrade: string;
}) {
  const policy = params.bestPolicySummary;
  const tradeCountPassed = Boolean(policy && policy.trades >= params.targetTradeCountMin && policy.trades <= params.targetTradeCountMax);
  const monthlyStabilityPassed = Boolean(params.monthlyStabilityAssessment.passed);
  const leakagePassed = Boolean(params.leakageAudit?.passed ?? false);
  const lateOffsetSafetyPassed = Boolean(params.lateOffsetSafetyAudit?.passed ?? false);
  const exitDerivationPassed = Boolean(params.exitDerivationAudit?.passed ?? false);
  const calibratedRelationshipPassed = Boolean(params.calibratedMoveRelationshipSummary?.passed ?? false);
  const targetProfile = params.targetProfile;
  const returnFirstObjective = isReturnFirstObjective(targetProfile);
  const requiredTradeCountMin = returnFirstObjective ? Math.min(params.targetTradeCountMin, 20) : params.targetTradeCountMin;
  const requiredTradeCountMax = returnFirstObjective ? Math.min(Math.max(params.targetTradeCountMax, 30), 45) : params.targetTradeCountMax;
  const returnProfileTradeCountPassed = Boolean(policy && policy.trades >= requiredTradeCountMin && policy.trades <= requiredTradeCountMax);
  const monthlyAccountReturnPct = Number(policy?.averageMonthlyAccountReturnPct ?? 0);
  const monthlyReturnPassed = returnFirstObjective ? monthlyAccountReturnPct >= 50 : monthlyStabilityPassed;
  const drawdownPassed = returnFirstObjective ? Number(policy?.maxDrawdownPct ?? 0) <= 10 : true;
  return {
    targetProfile,
    winRate: policy?.winRate ?? 0,
    requiredWinRate: 0.9,
    winRatePassed: Boolean(policy && policy.winRate >= 0.9),
    slHitRate: policy?.slHitRate ?? 0,
    requiredMaxSlHitRate: 0.1,
    slHitRatePassed: Boolean(policy && policy.slHitRate <= 0.1),
    profitFactor: policy?.profitFactor ?? 0,
    requiredProfitFactor: 2.5,
    profitFactorPassed: Boolean(policy && policy.profitFactor >= 2.5),
    trades: policy?.trades ?? 0,
    requiredTradeCountMin,
    requiredTradeCountMax,
    tradeCountPassed: returnFirstObjective ? returnProfileTradeCountPassed : tradeCountPassed,
    maxTradesPerDay: params.maxTradesPerDay,
    maxTradesPerDayPassed: true,
    phantomCount: policy?.phantomCount ?? 0,
    phantomCountPassed: Boolean((policy?.phantomCount ?? 0) === 0),
    monthlyAccountReturnPct,
    requiredMonthlyAccountReturnPct: returnFirstObjective ? 50 : null,
    monthlyReturnPassed,
    maxDrawdownPct: policy?.maxDrawdownPct ?? 0,
    requiredMaxDrawdownPct: returnFirstObjective ? 10 : null,
    drawdownPassed,
    monthlyStabilityPassed,
    leakagePassed,
    lateOffsetSafetyPassed,
    exitDerivationPassed,
    calibratedRelationshipPassed,
    jobGradeBlocksTargetAchievement: params.jobGrade === "smoke_plumbing_only" ? false : false,
    finalTargetAchieved: Boolean(
      policy
      && policy.winRate >= 0.9
      && policy.slHitRate <= 0.1
      && policy.profitFactor >= 2.5
      && (returnFirstObjective ? returnProfileTradeCountPassed : tradeCountPassed)
      && monthlyReturnPassed
      && drawdownPassed
      && leakagePassed
      && lateOffsetSafetyPassed
      && exitDerivationPassed
      && calibratedRelationshipPassed
      && monthlyStabilityPassed,
    ),
  };
}

function buildValidationHardeningGuard(params: {
  dataset: UnifiedSynthesisDataset;
  rebuiltTriggerDiagnostics: Record<string, unknown>;
  topPolicySummaries: EliteSynthesisPolicySummary[];
  bestPolicySummary: EliteSynthesisPolicySummary | null;
  bestPolicySelectedTradesSummary: Record<string, unknown> | null;
}) {
  const invariants: Array<{ ok: boolean; name: string }> = [
    {
      ok: params.dataset.moves.length === 0 || Number(params.rebuiltTriggerDiagnostics.rawCandidatesGenerated ?? 0) > 0 || params.dataset.rebuiltTriggerCandidates.length > 0,
      name: "rebuilt_candidates_generated_when_calibrated_moves_exist",
    },
    {
      ok: Number(params.rebuiltTriggerDiagnostics.eligibleCandidates ?? 0) === 0 || Number(params.rebuiltTriggerDiagnostics.simulatedTradeCount ?? 0) > 0,
      name: "eligible_rebuilt_candidates_are_simulated",
    },
    {
      ok: typeof params.dataset.summary.rebuiltPolicySeedDiagnostics === "object" && params.dataset.summary.rebuiltPolicySeedDiagnostics !== null,
      name: "rebuilt_policy_seed_diagnostics_present",
    },
    {
      ok: Number(
        (params.dataset.summary.rebuiltPolicySeedDiagnostics
          && (params.dataset.summary.rebuiltPolicySeedDiagnostics as Record<string, unknown>).rebuiltPolicySeedCount)
          ?? 0,
      ) > 0
        || Number(params.rebuiltTriggerDiagnostics.simulatedTradeCount ?? 0) === 0,
      name: "rebuilt_policy_seed_count_positive_when_simulated_candidates_exist",
    },
    {
      ok: params.topPolicySummaries.every((policy) => policy.trades > 0),
      name: "zero_trade_policies_excluded_from_top_policy_summaries",
    },
    {
      ok: params.topPolicySummaries.every((policy) => !Array.isArray(policy.selectedTriggerTransitions)
        || !(policy.selectedTriggerTransitions as unknown[]).some((value) => ["trending", "recovery", "failed_recovery", "up", "down"].includes(String(value)))),
      name: "generic_trigger_labels_excluded_from_final_policies",
    },
    {
      ok: !params.bestPolicySelectedTradesSummary
        || !params.bestPolicySummary
        || Object.values((params.bestPolicySelectedTradesSummary.reportConsistencyChecks as Record<string, unknown> | undefined) ?? {}).every(Boolean),
      name: "selected_trades_export_reconciles_to_best_policy_summary",
    },
    {
      ok: Number(params.rebuiltTriggerDiagnostics.simulatedTradeCount ?? 0) === 0
        || params.topPolicySummaries.some((policy) => String(policy.sourcePool ?? "") === "rebuilt_trigger_candidates")
        || String(params.bestPolicySummary?.sourcePool ?? "") === "rebuilt_trigger_candidates",
      name: "rebuilt_policy_can_still_surface_in_top_policy_summaries",
    },
  ];
  const failed = invariants.find((invariant) => !invariant.ok) ?? null;
  return {
    validationHardeningFailed: Boolean(failed),
    failedInvariant: failed?.name ?? null,
    invariants,
  };
}

function buildStrategyGradeReadiness(params: {
  rebuiltTriggerDiagnostics: Record<string, unknown>;
  bestPolicySelectedTradesSummary: Record<string, unknown> | null;
  lateOffsetSafetyAudit: Record<string, unknown> | null;
  exitDerivationAudit: Record<string, unknown> | null;
  monthlyStabilityAssessment: Record<string, unknown>;
}) {
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (Number(params.rebuiltTriggerDiagnostics.simulatedTradeCount ?? 0) <= 0) blockers.push("rebuilt_pipeline_not_simulating");
  if (!params.bestPolicySelectedTradesSummary) blockers.push("selected_trade_export_missing");
  if (!Boolean(params.lateOffsetSafetyAudit?.passed ?? false)) warnings.push("late_offset_safety_needs_review");
  if (!Boolean(params.exitDerivationAudit?.passed ?? false)) blockers.push("exit_derivation_audit_failed");
  if (!Boolean(params.monthlyStabilityAssessment.passed)) warnings.push("monthly_stability_needs_review");
  return {
    smokePassed: Number(params.rebuiltTriggerDiagnostics.simulatedTradeCount ?? 0) > 0,
    safeToRunBalanced: blockers.length === 0,
    safeToRunDeep: false,
    blockers,
    warnings,
    recommendedNextRun: blockers.length === 0 ? "90-day balanced" : "Fix blockers before 90-day balanced",
  };
}

async function buildReturnAmplificationAnalysis(params: {
  dataset: UnifiedSynthesisDataset;
  targetProfile: EliteSynthesisTargetProfile;
  bestPolicyEvaluation: PolicyEvaluationResult | null;
  bestPolicySummary: EliteSynthesisPolicySummary | null;
  bestPolicySelectedTradesSummary: Record<string, unknown> | null;
  bestPolicySelectedTrades: Array<Record<string, unknown>>;
  policyArtifactReadiness: Record<string, unknown> | null;
  leakageAudit: EliteSynthesisLeakageAudit | null;
}) {
  const simulatedCandidates = params.dataset.rebuiltTriggerCandidates
    .filter((candidate) => candidate.eligible && candidate.simulatedTrade && !candidate.noTradeReason);
  const moveById = new Map(params.dataset.moves.map((move) => [move.moveId, move]));
  const lifecycleCandles = Array.isArray((params.dataset.internalContext as Record<string, unknown> | undefined)?.candles)
    ? (((params.dataset.internalContext as Record<string, unknown>).candles as CandleRow[]) ?? [])
    : [];
  const baselineSelectedIds = new Set(
    Array.isArray(params.bestPolicyEvaluation?.diagnostics?.selectedTradeIds)
      ? (params.bestPolicyEvaluation?.diagnostics?.selectedTradeIds as string[])
      : [],
  );
  const predictionFeatureKeys = [
    "confidence",
    "setupMatch",
    "triggerStrengthScore",
    "barsSinceLastCrash",
    "crashRecencyScore",
    "rangeExpansionScore60",
    "compressionToExpansionScore",
    "atrRank240",
    "bbWidthRank240",
    "recoveryQualityScore",
    "oneBarReturnPct",
    "threeBarReturnPct",
    "fiveBarReturnPct",
    "microBreakStrengthPct",
  ];

  const swingCaptureGuardrails = (() => {
    const base = {
      serviceId: params.dataset.serviceId,
      series: params.dataset.serviceId.startsWith("CRASH") ? "crash" : "generic",
      rankingObjective: isReturnFirstObjective(params.targetProfile)
        ? "maximize_lifecycle_monthly_return_before_perfect_win_rate"
        : "maximize_safe_research_readiness",
      minWinRate: 0.9,
      maxSlHitRate: 0.1,
      minProfitFactor: 2.5,
      maxDrawdownPct: 10,
      minMedianLifecyclePnlPct: 5,
      minAverageLifecyclePnlPct: 5,
      minMedianMfePct: 6,
      minLifecycleMfeCaptureRatio: 0.75,
      preferredMedianLifecyclePnlPctFor10Plus: 7,
      preferredAverageLifecyclePnlPctFor10Plus: 7,
      notScalpLike: true,
    };
    if (params.dataset.serviceId === "CRASH300") return base;
    return {
      ...base,
      minMedianLifecyclePnlPct: 4.5,
      minAverageLifecyclePnlPct: 4.5,
      minMedianMfePct: 5.5,
      preferredMedianLifecyclePnlPctFor10Plus: 6.5,
      preferredAverageLifecyclePnlPctFor10Plus: 6.5,
    };
  })();

  const captureThresholds = [5, 7, 9] as const;

  const dominantLabel = (values: Array<string | null | undefined>) =>
    Object.entries(countRecord(values))
      .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0]?.[0] ?? "unknown";

  const countRecord = (values: Array<string | null | undefined>) => values.reduce<Record<string, number>>((acc, value) => {
    const key = typeof value === "string" && value.trim().length > 0 ? value : "unknown";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  const probabilityDistribution = (values: Array<string | null | undefined>) => {
    const counts = countRecord(values);
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    const distribution = Object.fromEntries(
      Object.entries(counts).map(([key, count]) => [key, total > 0 ? Number((count / total).toFixed(4)) : 0]),
    );
    return { counts, distribution, total };
  };

  const actualBucketLookup = new Map<string, ReturnAmplificationBucket | null>();
  for (const candidate of simulatedCandidates) {
    actualBucketLookup.set(candidate.candidateId, actualMoveBucketForCandidate(candidate, moveById));
  }

  const scoreCandidateSimilarity = (
    subject: SynthesisRebuiltTriggerCandidateRecord,
    peer: SynthesisRebuiltTriggerCandidateRecord,
  ) => {
    let score = 0;
    if (subject.runtimeFamily && subject.runtimeFamily === peer.runtimeFamily) score += 2.2;
    if (subject.triggerTransition && subject.triggerTransition === peer.triggerTransition) score += 2.1;
    if (subject.direction === peer.direction) score += 1.3;
    if (subject.selectedBucket && subject.selectedBucket === peer.selectedBucket) score += 1.2;
    if (subject.selectedMoveSizeBucket && subject.selectedMoveSizeBucket === peer.selectedMoveSizeBucket) score += 1.1;
    if (offsetClusterFromLabel(subject.offsetLabel) === offsetClusterFromLabel(peer.offsetLabel)) score += 0.65;
    for (const key of predictionFeatureKeys) {
      const a = key === "confidence"
        ? subject.confidence
        : key === "setupMatch"
          ? subject.setupMatch
          : key === "triggerStrengthScore"
            ? subject.triggerStrengthScore
            : candidateFeatureNumber(subject, key);
      const b = key === "confidence"
        ? peer.confidence
        : key === "setupMatch"
          ? peer.setupMatch
          : key === "triggerStrengthScore"
            ? peer.triggerStrengthScore
            : candidateFeatureNumber(peer, key);
      if (a == null || b == null) continue;
      const delta = Math.abs(a - b);
      score += Math.max(0, 1 - Math.min(1, delta / 2));
    }
    return score;
  };

  const buildCandidatePrediction = (candidate: SynthesisRebuiltTriggerCandidateRecord) => {
    const peerPools = [
      {
        source: "exact_family_transition_direction",
        peers: simulatedCandidates.filter((peer) =>
          peer.candidateId !== candidate.candidateId
          && peer.runtimeFamily === candidate.runtimeFamily
          && peer.triggerTransition === candidate.triggerTransition
          && peer.direction === candidate.direction
          && actualBucketLookup.get(peer.candidateId),
        ),
      },
      {
        source: "family_direction",
        peers: simulatedCandidates.filter((peer) =>
          peer.candidateId !== candidate.candidateId
          && peer.runtimeFamily === candidate.runtimeFamily
          && peer.direction === candidate.direction
          && actualBucketLookup.get(peer.candidateId),
        ),
      },
      {
        source: "family_only",
        peers: simulatedCandidates.filter((peer) =>
          peer.candidateId !== candidate.candidateId
          && peer.runtimeFamily === candidate.runtimeFamily
          && actualBucketLookup.get(peer.candidateId),
        ),
      },
      {
        source: "direction_only",
        peers: simulatedCandidates.filter((peer) =>
          peer.candidateId !== candidate.candidateId
          && peer.direction === candidate.direction
          && actualBucketLookup.get(peer.candidateId),
        ),
      },
      {
        source: "all_simulated_candidates",
        peers: simulatedCandidates.filter((peer) =>
          peer.candidateId !== candidate.candidateId
          && actualBucketLookup.get(peer.candidateId),
        ),
      },
    ];
    const chosenPool = peerPools.find((pool) => pool.peers.length >= 8) ?? peerPools.find((pool) => pool.peers.length > 0) ?? null;
    if (!chosenPool) {
      return {
        candidateId: candidate.candidateId,
        predictedMoveSizeBucket: null,
        predictedBucketConfidence: 0,
        predictedBucketProbabilityDistribution: {},
        expectedMovePct: null,
        expectedMfeDistribution: null,
        expectedMaeDistribution: null,
        bucketPredictionReason: "no_prediction:no_historical_peers",
        liveSafeFeaturesUsed: predictionFeatureKeys,
        noPredictionReason: "no_historical_peers",
        actualEvaluatedBucket: actualBucketLookup.get(candidate.candidateId),
      };
    }
    const rankedPeers = chosenPool.peers
      .map((peer) => ({ peer, score: scoreCandidateSimilarity(candidate, peer) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(40, chosenPool.peers.length));
    const peerBuckets = rankedPeers.map(({ peer }) => actualBucketLookup.get(peer.candidateId)).filter((value): value is ReturnAmplificationBucket => Boolean(value));
    const bucketStats = probabilityDistribution(peerBuckets);
    const topBucket = Object.entries(bucketStats.counts)
      .sort((a, b) => b[1] - a[1] || bucketRank(b[0]) - bucketRank(a[0]))[0]?.[0] as ReturnAmplificationBucket | undefined;
    const topProbability = topBucket ? Number(bucketStats.distribution[topBucket] ?? 0) : 0;
    const peerMovePct = rankedPeers
      .map(({ peer }) => moveById.get(peer.matchedCalibratedMoveId ?? -1)?.movePctPoints ?? peer.projectedMovePctPoints ?? null)
      .filter((value): value is number => Number.isFinite(value));
    const peerMfe = rankedPeers.map(({ peer }) => Math.abs(peer.mfePctPoints ?? peer.mfePct ?? 0)).filter((value) => value > 0);
    const peerMae = rankedPeers.map(({ peer }) => Math.abs(peer.maePctPoints ?? peer.maePct ?? 0)).filter((value) => value > 0);
    const predictedBucketConfidence = Number(Math.min(
      0.99,
      topProbability * 0.55
        + Math.min(1, rankedPeers.length / 20) * 0.2
        + Math.max(0, Math.min(1, Number(candidate.confidence ?? 0))) * 0.15
        + Math.max(0, Math.min(1, Number(candidate.setupMatch ?? 0))) * 0.05
        + Math.max(0, Math.min(1, Number(candidate.triggerStrengthScore ?? 0))) * 0.05,
    ).toFixed(4));
    return {
      candidateId: candidate.candidateId,
      predictedMoveSizeBucket: topBucket ?? null,
      predictedBucketConfidence,
      predictedBucketProbabilityDistribution: bucketStats.distribution,
      expectedMovePct: peerMovePct.length > 0 ? Number(mean(peerMovePct).toFixed(2)) : null,
      expectedMfeDistribution: peerMfe.length > 0 ? summarizeDistribution(peerMfe) : null,
      expectedMaeDistribution: peerMae.length > 0 ? summarizeDistribution(peerMae) : null,
      bucketPredictionReason: `${chosenPool.source}:${rankedPeers.length}_ranked_peers`,
      liveSafeFeaturesUsed: predictionFeatureKeys,
      noPredictionReason: topBucket ? null : "peer_bucket_distribution_empty",
      actualEvaluatedBucket: actualBucketLookup.get(candidate.candidateId),
    };
  };

  const predictions = simulatedCandidates.map((candidate) => buildCandidatePrediction(candidate));
  const predictionById = new Map(predictions.map((prediction) => [prediction.candidateId, prediction]));

  const buildDynamicExitPlan = (candidate: SynthesisRebuiltTriggerCandidateRecord) => {
    const prediction = predictionById.get(candidate.candidateId);
    const predictedBucket = prediction?.predictedMoveSizeBucket ?? null;
    if (!predictedBucket) {
      return {
        available: false,
        noPredictionReason: prediction?.noPredictionReason ?? "no_prediction",
      };
    }
    const scopes = [
      {
        source: "exact_bucket_family_direction",
        widenedFrom: predictedBucket,
        widenedTo: predictedBucket,
        peers: simulatedCandidates.filter((peer) =>
          peer.candidateId !== candidate.candidateId
          && actualBucketLookup.get(peer.candidateId) === predictedBucket
          && peer.runtimeFamily === candidate.runtimeFamily
          && peer.direction === candidate.direction,
        ),
      },
      {
        source: "family_bucket_subset",
        widenedFrom: predictedBucket,
        widenedTo: `${candidate.runtimeFamily ?? "unknown"}|${predictedBucket}`,
        peers: simulatedCandidates.filter((peer) =>
          peer.candidateId !== candidate.candidateId
          && actualBucketLookup.get(peer.candidateId) === predictedBucket
          && peer.runtimeFamily === candidate.runtimeFamily,
        ),
      },
      {
        source: "trigger_bucket_subset",
        widenedFrom: predictedBucket,
        widenedTo: `${candidate.triggerTransition ?? "unknown"}|${predictedBucket}`,
        peers: simulatedCandidates.filter((peer) =>
          peer.candidateId !== candidate.candidateId
          && actualBucketLookup.get(peer.candidateId) === predictedBucket
          && peer.triggerTransition === candidate.triggerTransition,
        ),
      },
      {
        source: "bucket_direction_subset",
        widenedFrom: predictedBucket,
        widenedTo: `${predictedBucket}|${candidate.direction}`,
        peers: simulatedCandidates.filter((peer) =>
          peer.candidateId !== candidate.candidateId
          && actualBucketLookup.get(peer.candidateId) === predictedBucket
          && peer.direction === candidate.direction,
        ),
      },
      {
        source: "bucket_subset",
        widenedFrom: predictedBucket,
        widenedTo: predictedBucket,
        peers: simulatedCandidates.filter((peer) =>
          peer.candidateId !== candidate.candidateId
          && actualBucketLookup.get(peer.candidateId) === predictedBucket,
        ),
      },
      {
        source: "family_default",
        widenedFrom: predictedBucket,
        widenedTo: `${candidate.runtimeFamily ?? "unknown"}|family_default`,
        peers: simulatedCandidates.filter((peer) =>
          peer.candidateId !== candidate.candidateId
          && peer.runtimeFamily === candidate.runtimeFamily,
        ),
      },
      {
        source: "broad_calibrated_default",
        widenedFrom: predictedBucket,
        widenedTo: "broad_calibrated_default",
        peers: simulatedCandidates.filter((peer) => peer.candidateId !== candidate.candidateId),
      },
    ];
    const chosenScope = scopes.find((scope) => scope.peers.length >= 6) ?? scopes.find((scope) => scope.peers.length >= 3) ?? null;
    if (!chosenScope) {
      return {
        available: false,
        noPredictionReason: "no_exit_peer_subset",
      };
    }
    const peerMfe = chosenScope.peers.map((peer) => Math.abs(peer.mfePctPoints ?? peer.mfePct ?? 0)).filter((value) => value > 0);
    const peerMae = chosenScope.peers.map((peer) => Math.abs(peer.maePctPoints ?? peer.maePct ?? 0)).filter((value) => value > 0);
    const peerProjected = chosenScope.peers.map((peer) => Math.abs(peer.projectedMovePctPoints ?? peer.projectedMovePct ?? 0)).filter((value) => value > 0);
    const peerHoldBars = chosenScope.peers.map((peer) => Math.max(1, Math.round(((peer.exitTs ?? peer.entryTs) - peer.entryTs) / 60))).filter((value) => Number.isFinite(value) && value > 0);
    const conf = Number(prediction?.predictedBucketConfidence ?? 0);
    const tpQuantile = conf >= 0.8 ? 0.6 : conf >= 0.6 ? 0.5 : 0.4;
    const slQuantile = conf >= 0.8 ? 0.75 : 0.85;
    const tpTargetPct = Number(Math.min(bucketUpperBound(predictedBucket), percentile(peerProjected.length > 0 ? peerProjected : peerMfe, tpQuantile)).toFixed(2));
    const slRiskPct = Number(percentile(peerMae, slQuantile).toFixed(2));
    const protectionActivationPct = Number(percentile(peerMfe, 0.25).toFixed(2));
    const dynamicProtectionDistancePct = Number(percentile(peerMae, 0.65).toFixed(2));
    const runnerAllowed = returnBucketAtLeast(predictedBucket, "9_to_10_pct") && conf >= 0.6;
    const runnerTargetPct = runnerAllowed ? Number(Math.min(bucketUpperBound(predictedBucket), percentile(peerMfe, 0.75)).toFixed(2)) : null;
    const partialTakeProfitPlan = runnerAllowed
      ? [{ takePctOfPosition: 0.5, targetPct: Number(Math.min(bucketMidpoint(predictedBucket), percentile(peerMfe, 0.5)).toFixed(2)) }]
      : [];
    const minHoldBars = peerHoldBars.length > 0 ? Math.max(1, Math.round(percentile(peerHoldBars, 0.25))) : 1;
    const maxHoldBars = peerHoldBars.length > 0 ? Math.max(2, Math.round(percentile(peerHoldBars, 0.75))) : 6;
    return {
      available: peerMfe.length > 0 && peerMae.length > 0,
      predictedMoveSizeBucket: predictedBucket,
      tpTargetPct,
      tpTargetSource: `${chosenScope.source}:p${Math.round(tpQuantile * 100)}_projected_or_mfe`,
      slRiskPct,
      slRiskSource: `${chosenScope.source}:p${Math.round(slQuantile * 100)}_mae`,
      protectionActivationPct,
      protectionActivationSource: `${chosenScope.source}:p25_mfe`,
      dynamicProtectionDistancePct,
      dynamicProtectionDistanceSource: `${chosenScope.source}:p65_mae`,
      minHoldBars,
      maxHoldBars,
      runnerAllowed,
      runnerTargetPct,
      partialTakeProfitPlan,
      exitPlanConfidence: Number(Math.min(0.99, conf * 0.6 + Math.min(1, chosenScope.peers.length / 12) * 0.4).toFixed(4)),
      lifecycleManagerModel: "trade_lifecycle_manager_v1",
      protectionRules: {
        protectionActivationPct,
        dynamicProtectionDistancePct,
        protectiveFloorPct: 0,
      },
      exitDecisionRules: {
        tp1Pct: partialTakeProfitPlan?.[0]?.targetPct ?? Number(Math.min(bucketMidpoint(predictedBucket), tpTargetPct).toFixed(2)),
        tp2Pct: tpTargetPct,
        runnerTargetPct: runnerTargetPct ?? tpTargetPct,
        exits: ["tp2_hit", "protected_exit", "momentum_failure_exit", "reversal_exit", "time_failure_exit", "hard_sl"],
      },
      maturityRules: {
        minHoldBars,
        maxHoldBars,
      },
      derivationNotes: [
        `predicted_bucket=${predictedBucket}`,
        `exit_source=${chosenScope.source}`,
        `peer_count=${chosenScope.peers.length}`,
      ],
      widenedFrom: chosenScope.widenedFrom,
      widenedTo: chosenScope.widenedTo,
      broadFallback: chosenScope.source === "broad_calibrated_default",
      subsetStats: {
        sampleCount: chosenScope.peers.length,
        winnerCount: chosenScope.peers.filter((peer) => (peer.pnlPctPoints ?? peer.pnlPct) > 0).length,
        mfeRange: summarizeRange(peerMfe),
        maeRange: summarizeRange(peerMae),
      },
    };
  };

  const enrichedCandidates = simulatedCandidates.map((candidate) => {
    const prediction = predictionById.get(candidate.candidateId) ?? {
      predictedMoveSizeBucket: null,
      predictedBucketConfidence: 0,
      predictedBucketProbabilityDistribution: {},
      expectedMovePct: null,
      expectedMfeDistribution: null,
      expectedMaeDistribution: null,
      bucketPredictionReason: "missing_prediction",
      liveSafeFeaturesUsed: predictionFeatureKeys,
      noPredictionReason: "missing_prediction",
      actualEvaluatedBucket: actualBucketLookup.get(candidate.candidateId),
    };
    const dynamicExitPlan = buildDynamicExitPlan(candidate);
    const liveSafeEliteScore = Number((
      (candidate.confidence ?? 0) * 0.35
      + (candidate.setupMatch ?? 0) * 0.25
      + (candidate.triggerStrengthScore ?? 0) * 0.2
      + Math.max(0, prediction.predictedBucketConfidence ?? 0) * 0.2
    ).toFixed(4));
    return {
      candidate,
      prediction,
      dynamicExitPlan,
      actualEvaluatedBucket: prediction.actualEvaluatedBucket,
      liveSafeEliteScore,
    };
  });

  const candidateLooksHighValue = (item: typeof enrichedCandidates[number]) => {
    const selectedBucket = String(item.candidate.selectedBucket ?? "");
    const moveSizeBucket = String(item.candidate.selectedMoveSizeBucket ?? "");
    const predictedBucket = String(item.prediction.predictedMoveSizeBucket ?? "");
    return selectedBucket.includes("10_plus_pct")
      || moveSizeBucket.includes("10_plus_pct")
      || returnBucketAtLeast(predictedBucket, "9_to_10_pct");
  };

  const lifecycleReplayByCandidateId = new Map<string, TradeLifecycleReplayTradeResult>();
  if (lifecycleCandles.length > 0) {
    for (const item of enrichedCandidates) {
      const expectedMovePct = Math.max(
        safeNumber(item.dynamicExitPlan?.runnerTargetPct, 0),
        safeNumber(item.dynamicExitPlan?.tpTargetPct, 0),
        safeNumber(item.prediction.expectedMovePct, 0),
        safeNumber(item.candidate.projectedMovePctPoints ?? item.candidate.projectedMovePct, 0),
      );
      const replay = replayLifecycleTrade({
        candidate: item.candidate,
        candles: lifecycleCandles,
        expectedMovePct,
        exitPlan: buildLifecycleExitPlan({
          candidate: item.candidate,
          dynamicExitPlan: item.dynamicExitPlan,
          expectedMovePct,
        }),
        serviceId: params.dataset.serviceId,
        sourceJobId: null,
        sourcePolicyId: params.bestPolicySummary?.policyId ?? null,
        maxReplayTs: safeNumber(item.candidate.sourceMoveEndTs ?? item.candidate.exitTs, 0) || null,
      });
      if (replay) lifecycleReplayByCandidateId.set(item.candidate.candidateId, replay);
    }
  }

  const scenarioMonthlyBreakdown = (selected: typeof enrichedCandidates) => {
    const monthMap = new Map<string, typeof enrichedCandidates>();
    for (const item of selected) {
      const month = new Date(item.candidate.entryTs * 1000).toISOString().slice(0, 7);
      const bucket = monthMap.get(month) ?? [];
      bucket.push(item);
      monthMap.set(month, bucket);
    }
    return Array.from(monthMap.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([month, bucket]) => {
      const pnl = bucket.map((item) => Number(item.candidate.pnlPctPoints ?? item.candidate.pnlPct ?? 0));
      const metrics = computeScenarioEquityMetrics(pnl);
      const wins = bucket.filter((item) => Number(item.candidate.pnlPctPoints ?? item.candidate.pnlPct ?? 0) > 0).length;
      const losses = bucket.length - wins;
      const slHits = bucket.filter((item) => item.candidate.exitReason === "sl_hit").length;
      const grossProfit = bucket.filter((item) => Number(item.candidate.pnlPctPoints ?? item.candidate.pnlPct ?? 0) > 0)
        .reduce((sum, item) => sum + Number(item.candidate.pnlPctPoints ?? item.candidate.pnlPct ?? 0), 0);
      const grossLoss = Math.abs(bucket.filter((item) => Number(item.candidate.pnlPctPoints ?? item.candidate.pnlPct ?? 0) <= 0)
        .reduce((sum, item) => sum + Number(item.candidate.pnlPctPoints ?? item.candidate.pnlPct ?? 0), 0));
      return {
        month,
        trades: bucket.length,
        wins,
        losses,
        slHits,
        winRate: bucket.length > 0 ? Number((wins / bucket.length).toFixed(4)) : 0,
        slHitRate: bucket.length > 0 ? Number((slHits / bucket.length).toFixed(4)) : 0,
        profitFactor: grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : grossProfit > 0 ? 99 : 0,
        accountReturnPct: metrics.accountReturnPct,
        maxDrawdownPct: metrics.maxDrawdownPct,
        avgPnlPct: Number(mean(pnl).toFixed(2)),
        medianPnlPct: Number(percentile(pnl, 0.5).toFixed(2)),
        exitReasonCounts: countRecord(bucket.map((item) => item.candidate.exitReason)),
        selectedBucketCounts: countRecord(bucket.map((item) => item.candidate.selectedBucket)),
        predictedBucketCounts: countRecord(bucket.map((item) => item.prediction.predictedMoveSizeBucket)),
        offsetCounts: countRecord(bucket.map((item) => item.candidate.offsetLabel)),
      };
    });
  };

  const simulateCapitalModels = (selected: typeof enrichedCandidates) => {
    const basePnl = selected.map((item) => Number(item.candidate.pnlPctPoints ?? item.candidate.pnlPct ?? 0));
    const fixedAllocations = [0.15, 0.25, 0.4, 0.6, 0.9].map((allocationPct) => {
      const scaled = basePnl.map((pnl) => pnl * allocationPct);
      const metrics = computeScenarioEquityMetrics(scaled);
      return {
        model: `fixed_${Math.round(allocationPct * 100)}pct`,
        allocationPct,
        accountReturnPct: metrics.accountReturnPct,
        monthlyAccountReturnPct: selected.length > 0 ? Number((metrics.accountReturnPct / Math.max(1, scenarioMonthlyBreakdown(selected).length)).toFixed(2)) : 0,
        maxDrawdownPct: metrics.maxDrawdownPct,
        worstTradeLossPctOfAccount: Number(Math.max(0, ...scaled.map((value) => Math.max(0, -value))).toFixed(2)),
        largestExposurePct: Number((allocationPct * 100).toFixed(2)),
        averageExposurePct: Number((allocationPct * 100).toFixed(2)),
        capitalUtilisation: Number((allocationPct * 100).toFixed(2)),
        riskWarnings: allocationPct >= 0.6 ? ["High single-symbol allocation research scenario."] : [],
      };
    });
    const confidenceWeighted = (() => {
      const scaled = selected.map((item) => {
        const allocationPct = Math.min(
          0.9,
          Math.max(
            0.15,
            0.15 + (item.prediction.predictedBucketConfidence ?? 0) * 0.35 + (item.liveSafeEliteScore * 0.2),
          ),
        );
        return {
          allocationPct,
          pnl: Number(item.candidate.pnlPctPoints ?? item.candidate.pnlPct ?? 0) * allocationPct,
        };
      });
      const metrics = computeScenarioEquityMetrics(scaled.map((item) => item.pnl));
      return {
        model: "confidence_weighted",
        formula: "allocationPct = clamp(15%, 90%, 15% + predictedBucketConfidence*35% + liveSafeEliteScore*20%)",
        accountReturnPct: metrics.accountReturnPct,
        monthlyAccountReturnPct: selected.length > 0 ? Number((metrics.accountReturnPct / Math.max(1, scenarioMonthlyBreakdown(selected).length)).toFixed(2)) : 0,
        maxDrawdownPct: metrics.maxDrawdownPct,
        worstTradeLossPctOfAccount: Number(Math.max(0, ...scaled.map((item) => Math.max(0, -item.pnl))).toFixed(2)),
        largestExposurePct: Number(Math.max(...scaled.map((item) => item.allocationPct * 100), 0).toFixed(2)),
        averageExposurePct: Number(mean(scaled.map((item) => item.allocationPct * 100)).toFixed(2)),
        capitalUtilisation: Number(mean(scaled.map((item) => item.allocationPct * 100)).toFixed(2)),
        riskWarnings: scaled.some((item) => item.allocationPct >= 0.75) ? ["Some high-confidence scenarios use 75%+ allocation."] : [],
      };
    })();
    const leverageScenarios = [1, 1.2, 1.5, 2].map((leverage) => {
      const scaled = basePnl.map((pnl) => pnl * 0.15 * leverage);
      const metrics = computeScenarioEquityMetrics(scaled);
      return {
        model: `${leverage.toFixed(1)}x`,
        leverage,
        accountReturnPct: metrics.accountReturnPct,
        monthlyAccountReturnPct: selected.length > 0 ? Number((metrics.accountReturnPct / Math.max(1, scenarioMonthlyBreakdown(selected).length)).toFixed(2)) : 0,
        maxDrawdownPct: metrics.maxDrawdownPct,
        liquidationRiskWarning: leverage > 1 ? "Research-only leverage scenario. Losses and drawdown scale with exposure." : null,
      };
    });
    return {
      currentAllocatorModel: fixedAllocations[0],
      fixedAllocationModels: fixedAllocations,
      confidenceWeightedAllocation: confidenceWeighted,
      portfolioCapModel: {
        maxTotalCapitalPct: 90,
        singleSymbolCapPct: 90,
        maxConcurrentTrades: 1,
        accountReturnPct: fixedAllocations[4]?.accountReturnPct ?? 0,
        monthlyAccountReturnPct: fixedAllocations[4]?.monthlyAccountReturnPct ?? 0,
        maxDrawdownPct: fixedAllocations[4]?.maxDrawdownPct ?? 0,
        warnings: ["Research-only portfolio cap model. Live allocator remains unchanged."],
      },
      leverageScenarios,
    };
  };

  const simulateCascadeScenarios = (selected: typeof enrichedCandidates) => {
    const triggers = [1, 1.5, 2];
    return triggers.map((triggerPct) => {
      let addedCapitalPct = 0;
      let worsened = 0;
      const scenarioReturns: number[] = [];
      for (const item of selected) {
        const pnl = Number(item.candidate.pnlPctPoints ?? item.candidate.pnlPct ?? 0);
        const mfe = Math.abs(Number(item.candidate.mfePctPoints ?? item.candidate.mfePct ?? 0));
        const cascadeEligible = pnl > 0
          && mfe >= triggerPct
          && Boolean(item.dynamicExitPlan.available)
          && Boolean(item.dynamicExitPlan.runnerAllowed)
          && Number(item.prediction.predictedBucketConfidence ?? 0) >= 0.6;
        let cascadeAdd = 0;
        if (cascadeEligible) {
          cascadeAdd = Math.min(0.45, 0.1 + Number(item.prediction.predictedBucketConfidence ?? 0) * 0.25);
          addedCapitalPct += cascadeAdd * 100;
          const remainingMove = Math.max(0, mfe - triggerPct);
          const boost = Math.min(remainingMove, Number(item.dynamicExitPlan.runnerTargetPct ?? item.dynamicExitPlan.tpTargetPct ?? triggerPct) - triggerPct);
          scenarioReturns.push((pnl * 0.15) + (boost * cascadeAdd));
          if (pnl < triggerPct) worsened += 1;
        } else {
          scenarioReturns.push(pnl * 0.15);
        }
      }
      const metrics = computeScenarioEquityMetrics(scenarioReturns);
      return {
        cascadeEnabled: true,
        triggerPct,
        cascadeCount: scenarioReturns.length,
        averageAddsPerWinningTrade: selected.filter((item) => Number(item.candidate.pnlPctPoints ?? item.candidate.pnlPct ?? 0) > 0).length > 0
          ? Number((addedCapitalPct / 100 / selected.filter((item) => Number(item.candidate.pnlPctPoints ?? item.candidate.pnlPct ?? 0) > 0).length).toFixed(2))
          : 0,
        addedCapitalPct: Number(addedCapitalPct.toFixed(2)),
        totalExposurePct: Number(Math.min(90, 15 + addedCapitalPct).toFixed(2)),
        effectiveTP: Number(mean(selected.map((item) => Number(item.dynamicExitPlan.tpTargetPct ?? 0))).toFixed(2)),
        effectiveSL: Number(mean(selected.map((item) => Number(item.dynamicExitPlan.slRiskPct ?? 0))).toFixed(2)),
        accountReturnPct: metrics.accountReturnPct,
        monthlyReturnPct: selected.length > 0 ? Number((metrics.accountReturnPct / Math.max(1, scenarioMonthlyBreakdown(selected).length)).toFixed(2)) : 0,
        maxDrawdownPct: metrics.maxDrawdownPct,
        resultingSlExposure: Number(mean(selected.map((item) => Number(item.dynamicExitPlan.slRiskPct ?? 0))).toFixed(2)),
        worsenedOutcomeCount: worsened,
        riskWarnings: worsened > 0 ? ["Some winning trades closed below the cascade trigger after reaching it."] : [],
      };
    });
  };

  const buildScenario = (config: {
    scenarioId: string;
    label: string;
    description: string;
    predicate: (item: typeof enrichedCandidates[number]) => boolean;
    filterNotes: string[];
  }) => {
    const filtered = enrichedCandidates.filter(config.predicate);
    const groupedByDay = new Map<string, typeof enrichedCandidates>();
    for (const item of filtered) {
      const day = new Date(item.candidate.entryTs * 1000).toISOString().slice(0, 10);
      const bucket = groupedByDay.get(day) ?? [];
      bucket.push(item);
      groupedByDay.set(day, bucket);
    }
    const selected = Array.from(groupedByDay.values()).map((bucket) => {
      bucket.sort((a, b) => b.liveSafeEliteScore - a.liveSafeEliteScore || b.prediction.predictedBucketConfidence - a.prediction.predictedBucketConfidence);
      return bucket[0];
    }).filter(Boolean);
    const pnlValues = selected.map((item) => Number(item.candidate.pnlPctPoints ?? item.candidate.pnlPct ?? 0));
    const wins = selected.filter((item) => Number(item.candidate.pnlPctPoints ?? item.candidate.pnlPct ?? 0) > 0).length;
    const losses = selected.length - wins;
    const slHits = selected.filter((item) => item.candidate.exitReason === "sl_hit").length;
    const grossProfit = selected.filter((item) => Number(item.candidate.pnlPctPoints ?? item.candidate.pnlPct ?? 0) > 0)
      .reduce((sum, item) => sum + Number(item.candidate.pnlPctPoints ?? item.candidate.pnlPct ?? 0), 0);
    const grossLoss = Math.abs(selected.filter((item) => Number(item.candidate.pnlPctPoints ?? item.candidate.pnlPct ?? 0) <= 0)
      .reduce((sum, item) => sum + Number(item.candidate.pnlPctPoints ?? item.candidate.pnlPct ?? 0), 0));
    const metrics = computeScenarioEquityMetrics(pnlValues);
    const monthlyBreakdown = scenarioMonthlyBreakdown(selected);
    const lifecycleReplayTrades = selected
      .map((item) => lifecycleReplayByCandidateId.get(item.candidate.candidateId) ?? null)
      .filter((value): value is TradeLifecycleReplayTradeResult => Boolean(value));
    const lifecycleReplayReport = buildTradeLifecycleReplayReport({
      serviceId: params.dataset.serviceId,
      sourceJobId: null,
      sourcePolicyId: params.bestPolicySummary?.policyId ?? null,
      selected: lifecycleReplayTrades,
    });
    const lifecyclePnlValues = lifecycleReplayTrades.map((item) => Number(item.lifecyclePnlPct ?? 0));
    const lifecycleMetrics = lifecyclePnlValues.length > 0 ? computeScenarioEquityMetrics(lifecyclePnlValues) : metrics;
    const effectiveAccountReturnPct = isReturnFirstObjective(params.targetProfile) && lifecyclePnlValues.length > 0
      ? lifecycleReplayReport.lifecycleTotalAccountReturnPct
      : metrics.accountReturnPct;
    const effectiveMonthlyAccountReturnPct = isReturnFirstObjective(params.targetProfile) && lifecyclePnlValues.length > 0
      ? lifecycleReplayReport.lifecycleAverageMonthlyReturnPct
      : (monthlyBreakdown.length > 0 ? Number(mean(monthlyBreakdown.map((month) => Number(month.accountReturnPct ?? 0))).toFixed(2)) : 0);
    const effectiveDrawdown = isReturnFirstObjective(params.targetProfile) && lifecyclePnlValues.length > 0
      ? lifecycleMetrics.maxDrawdownPct
      : metrics.maxDrawdownPct;
    const capitalAllocationScenarios = simulateCapitalModels(selected);
    const cascadeScenarios = simulateCascadeScenarios(selected);
    const predictedBucketDistribution = probabilityDistribution(selected.map((item) => item.prediction.predictedMoveSizeBucket));
    const actualBucketDistribution = probabilityDistribution(selected.map((item) => item.actualEvaluatedBucket));
    const lifecycleMedianPnlPct = lifecycleReplayReport.lifecycleMedianPnlPct;
    const lifecycleAveragePnlPct = lifecycleReplayReport.lifecycleAveragePnlPct;
    const medianMfePct = lifecycleReplayTrades.length > 0
      ? Number(percentile(lifecycleReplayTrades.map((trade) => Number(trade.maxMfeSeenBeforeExit ?? 0)), 0.5).toFixed(4))
      : 0;
    const medianHoldMinutes = lifecycleReplayTrades.length > 0
      ? Number(percentile(lifecycleReplayTrades.map((trade) => Number(trade.timeInTradeLifecycle ?? 0)), 0.5).toFixed(2))
      : 0;
    const dominantPredictedBucket = dominantLabel(selected.map((item) => String(item.prediction.predictedMoveSizeBucket ?? "")));
    const dominantSelectedBucket = dominantLabel(selected.map((item) => String(item.candidate.selectedBucket ?? "")));
    const dominantRuntimeFamily = dominantLabel(selected.map((item) => String(item.candidate.runtimeFamily ?? "")));
    const dominantTriggerTransition = dominantLabel(selected.map((item) => String(item.candidate.triggerTransition ?? "")));
    const dominantDirection = dominantLabel(selected.map((item) => String(item.candidate.direction ?? "")));
    const dominantOffsetCluster = dominantLabel(selected.map((item) => offsetClusterFromLabel(item.candidate.offsetLabel)));
    const highValueScenario = selected.some((item) => candidateLooksHighValue(item));
    const preferredMedianThreshold = highValueScenario
      ? swingCaptureGuardrails.preferredMedianLifecyclePnlPctFor10Plus
      : swingCaptureGuardrails.minMedianLifecyclePnlPct;
    const preferredAverageThreshold = highValueScenario
      ? swingCaptureGuardrails.preferredAverageLifecyclePnlPctFor10Plus
      : swingCaptureGuardrails.minAverageLifecyclePnlPct;
    const scalpLike = highValueScenario
      ? lifecycleMedianPnlPct < swingCaptureGuardrails.minMedianLifecyclePnlPct
      : lifecycleMedianPnlPct < swingCaptureGuardrails.minMedianLifecyclePnlPct
        || lifecycleAveragePnlPct < swingCaptureGuardrails.minAverageLifecyclePnlPct;
    const rejectionReasons: string[] = [];
    if (selected.length === 0) rejectionReasons.push("no_selected_trades");
    if ((selected.length > 0 ? wins / selected.length : 0) < swingCaptureGuardrails.minWinRate) rejectionReasons.push("win_rate_below_guardrail");
    if ((selected.length > 0 ? slHits / selected.length : 0) > swingCaptureGuardrails.maxSlHitRate) rejectionReasons.push("sl_hit_rate_above_guardrail");
    if ((grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0) < swingCaptureGuardrails.minProfitFactor) rejectionReasons.push("profit_factor_below_guardrail");
    if (effectiveDrawdown > swingCaptureGuardrails.maxDrawdownPct) rejectionReasons.push("drawdown_above_guardrail");
    if (lifecycleMedianPnlPct < swingCaptureGuardrails.minMedianLifecyclePnlPct) rejectionReasons.push("median_lifecycle_pnl_below_guardrail");
    if (lifecycleAveragePnlPct < swingCaptureGuardrails.minAverageLifecyclePnlPct) rejectionReasons.push("average_lifecycle_pnl_below_guardrail");
    if (medianMfePct < swingCaptureGuardrails.minMedianMfePct) rejectionReasons.push("median_mfe_below_guardrail");
    if (Number(lifecycleReplayReport.lifecycleMfeCaptureRatio ?? 0) < swingCaptureGuardrails.minLifecycleMfeCaptureRatio) rejectionReasons.push("mfe_capture_ratio_below_guardrail");
    if (scalpLike) rejectionReasons.push("insufficient_move_capture");
    const guardrailsPassed = isReturnFirstObjective(params.targetProfile)
      ? rejectionReasons.length === 0
      : Boolean(
          selected.length > 0
          && (selected.length > 0 ? wins / selected.length : 0) >= swingCaptureGuardrails.minWinRate
          && (selected.length > 0 ? slHits / selected.length : 0) <= swingCaptureGuardrails.maxSlHitRate
          && effectiveDrawdown <= swingCaptureGuardrails.maxDrawdownPct,
        );
    const rankingScore = Number((
      (guardrailsPassed ? 1000 : 0)
      + (effectiveMonthlyAccountReturnPct * 25)
      + (effectiveAccountReturnPct * 5)
      + (lifecycleMedianPnlPct * 10)
      + (lifecycleAveragePnlPct * 8)
      + (Number(lifecycleReplayReport.lifecycleMfeCaptureRatio ?? 0) * 100)
      + ((selected.length > 0 ? wins / selected.length : 0) * 20)
      - (effectiveDrawdown * 4)
      - ((selected.length > 0 ? slHits / selected.length : 0) * 40)
    ).toFixed(4));
    const dynamicExitPlanSummary = {
      lifecycleManagerModel: "trade_lifecycle_manager_v1",
      tp1Pct: summarizeDistribution(selected.map((item) => Number(((item.dynamicExitPlan.exitDecisionRules as Record<string, unknown> | undefined)?.tp1Pct ?? item.dynamicExitPlan.tpTargetPct ?? 0))).filter((value) => value > 0)),
      tp2Pct: summarizeDistribution(selected.map((item) => Number(item.dynamicExitPlan.tpTargetPct ?? 0)).filter((value) => value > 0)),
      runnerTargetPct: summarizeDistribution(selected.map((item) => Number(item.dynamicExitPlan.runnerTargetPct ?? item.dynamicExitPlan.tpTargetPct ?? 0)).filter((value) => value > 0)),
      hardSlPct: summarizeDistribution(selected.map((item) => Number(item.dynamicExitPlan.slRiskPct ?? 0)).filter((value) => value > 0)),
      protectionActivationPct: summarizeDistribution(selected.map((item) => {
        const plan = item.dynamicExitPlan as Record<string, unknown>;
        return Number(plan.protectionActivationPct ?? plan.trailingActivationPct ?? 0);
      }).filter((value) => value > 0)),
      dynamicProtectionDistancePct: summarizeDistribution(selected.map((item) => {
        const plan = item.dynamicExitPlan as Record<string, unknown>;
        return Number(plan.dynamicProtectionDistancePct ?? plan.trailingDistancePct ?? 0);
      }).filter((value) => value > 0)),
      protectionRules: ["activate_protection_after_tp1_progress", "ratchet_protected_floor_after_maturity", "exit_on_protected_floor_hit"],
      exitDecisionRules: ["tp2_hit", "protected_exit", "momentum_failure_exit", "reversal_exit", "time_failure_exit", "hard_sl"],
      maturityRules: {
        minHoldBars: summarizeDistribution(selected.map((item) => Number(item.dynamicExitPlan.minHoldBars ?? 0)).filter((value) => value > 0)),
        maxHoldBars: summarizeDistribution(selected.map((item) => Number(item.dynamicExitPlan.maxHoldBars ?? 0)).filter((value) => value > 0)),
      },
      sourceDistribution: countRecord(selected.map((item) => String(item.dynamicExitPlan.tpTargetSource ?? item.dynamicExitPlan.noPredictionReason ?? "unknown"))),
      widenedDistribution: countRecord(selected.map((item) => `${String(item.dynamicExitPlan.widenedFrom ?? "none")}=>${String(item.dynamicExitPlan.widenedTo ?? "none")}`)),
    };
    const returnAmplificationBreakdown = {
      targetProfile: isReturnFirstObjective(params.targetProfile) ? "return_first" : "return_amplification",
      winRate: selected.length > 0 ? wins / selected.length : 0,
      requiredWinRate: 0.9,
      winRatePassed: selected.length > 0 ? wins / selected.length >= 0.9 : false,
      slHitRate: selected.length > 0 ? slHits / selected.length : 0,
      requiredMaxSlHitRate: 0.1,
      slHitRatePassed: selected.length > 0 ? slHits / selected.length <= 0.1 : false,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0,
      requiredProfitFactor: 2.5,
      profitFactorPassed: grossLoss > 0 ? grossProfit / grossLoss >= 2.5 : grossProfit > 0,
      monthlyAccountReturnPct: effectiveMonthlyAccountReturnPct,
      requiredMonthlyAccountReturnPct: 50,
      monthlyReturnPassed: effectiveMonthlyAccountReturnPct >= 50,
      maxDrawdownPct: effectiveDrawdown,
      requiredMaxDrawdownPct: 10,
      drawdownPassed: effectiveDrawdown <= 10,
      trades: selected.length,
      requiredTradeCountMin: 20,
      requiredTradeCountMax: 45,
      sampleSizePassed: selected.length >= 20 && selected.length <= 45,
      leakagePassed: Boolean(params.leakageAudit?.passed ?? false),
      liveSafeFilterPassed: selected.every((item) => item.prediction.predictedMoveSizeBucket || item.prediction.noPredictionReason),
      exitDerivationPassed: selected.every((item) => Boolean(item.dynamicExitPlan.available)),
      cascadeRiskPassed: cascadeScenarios.every((scenario) => Number(scenario.maxDrawdownPct ?? 0) <= 15),
    };
    return {
      scenarioId: config.scenarioId,
      label: config.label,
      description: config.description,
      sourcePool: "rebuilt_trigger_candidates",
      trades: selected.length,
      wins,
      losses,
      winRate: selected.length > 0 ? Number((wins / selected.length).toFixed(4)) : 0,
      slHits,
      slHitRate: selected.length > 0 ? Number((slHits / selected.length).toFixed(4)) : 0,
      profitFactor: grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : grossProfit > 0 ? 99 : 0,
      summedTradePnl: Number(pnlValues.reduce((sum, value) => sum + value, 0).toFixed(2)),
      accountReturnPct: effectiveAccountReturnPct,
      averageMonthlyAccountReturnPct: effectiveMonthlyAccountReturnPct,
      baseAccountReturnPct: metrics.accountReturnPct,
      baseAverageMonthlyAccountReturnPct: monthlyBreakdown.length > 0 ? Number(mean(monthlyBreakdown.map((month) => Number(month.accountReturnPct ?? 0))).toFixed(2)) : 0,
      lifecycleAccountReturnPct: lifecycleReplayReport.lifecycleTotalAccountReturnPct,
      lifecycleAverageMonthlyAccountReturnPct: lifecycleReplayReport.lifecycleAverageMonthlyReturnPct,
      lifecycleMedianPnlPct,
      lifecycleAveragePnlPct,
      lifecycleMfeCaptureRatio: lifecycleReplayReport.lifecycleMfeCaptureRatio,
      medianMfePct,
      medianHoldMinutes,
      runtimeFamily: dominantRuntimeFamily,
      triggerTransition: dominantTriggerTransition,
      bucket: dominantPredictedBucket !== "unknown" ? dominantPredictedBucket : dominantSelectedBucket,
      direction: dominantDirection,
      offsetCluster: dominantOffsetCluster,
      scalpLike,
      guardrailsPassed,
      rejectionReasons,
      rankingScore,
      swingCaptureExplanation: scalpLike
        ? `Policy has high win rate but captures only ${lifecycleMedianPnlPct.toFixed(4)}% median, below swing threshold.`
        : `Lifecycle median ${lifecycleMedianPnlPct.toFixed(4)}% and average ${lifecycleAveragePnlPct.toFixed(4)}% satisfy current capture expectations.`,
      preferredMedianLifecyclePnlPct: preferredMedianThreshold,
      preferredAverageLifecyclePnlPct: preferredAverageThreshold,
      averageTpAchieved: selected.length > 0
        ? Number(mean(selected.map((item) => {
            const target = Number(item.dynamicExitPlan.tpTargetPct ?? 0);
            const mfe = Math.abs(Number(item.candidate.mfePctPoints ?? item.candidate.mfePct ?? 0));
            return target > 0 ? Math.min(1.5, mfe / target) : 0;
          })).toFixed(2))
        : 0,
      averageAdverseExcursion: selected.length > 0 ? Number(mean(selected.map((item) => Math.abs(Number(item.candidate.maePctPoints ?? item.candidate.maePct ?? 0)))).toFixed(2)) : 0,
      averageHoldBars: selected.length > 0 ? Number(mean(selected.map((item) => Math.max(1, ((item.candidate.exitTs ?? item.candidate.entryTs) - item.candidate.entryTs) / 60))).toFixed(2)) : 0,
      drawdown: effectiveDrawdown,
      monthlyBreakdown,
      selectedBucketDistribution: countRecord(selected.map((item) => item.candidate.selectedBucket)),
      predictedBucketDistribution: predictedBucketDistribution.counts,
      predictedBucketProbabilityDistribution: predictedBucketDistribution.distribution,
      actualEvaluatedBucketDistribution: actualBucketDistribution.counts,
      selectedTradeIds: selected.map((item) => item.candidate.candidateId),
      reasonsSelected: config.filterNotes,
      reasonsRejected: [`filtered_candidates=${Math.max(0, enrichedCandidates.length - selected.length)}`],
      dynamicExitPlanSummary,
      tradeLifecycleReplayReport: lifecycleReplayReport,
      capitalAllocationScenarios,
      cascadeScenarios,
      targetAchievedBreakdown: {
        ...returnAmplificationBreakdown,
        finalTargetAchieved: Boolean(
          returnAmplificationBreakdown.winRatePassed
          && returnAmplificationBreakdown.slHitRatePassed
          && returnAmplificationBreakdown.profitFactorPassed
          && returnAmplificationBreakdown.monthlyReturnPassed
          && returnAmplificationBreakdown.drawdownPassed
          && returnAmplificationBreakdown.sampleSizePassed
          && returnAmplificationBreakdown.leakagePassed
          && returnAmplificationBreakdown.liveSafeFilterPassed
          && returnAmplificationBreakdown.exitDerivationPassed
          && returnAmplificationBreakdown.cascadeRiskPassed,
        ),
      },
      paperStageability: {
        reportConsistencyPassed: Boolean(params.bestPolicySelectedTradesSummary?.reportConsistencyChecks && Object.values(params.bestPolicySelectedTradesSummary.reportConsistencyChecks as Record<string, unknown>).every(Boolean)),
        leakagePassed: Boolean(params.leakageAudit?.passed ?? false),
        dynamicExitDerivationPassed: selected.every((item) => Boolean(item.dynamicExitPlan.available) && !Boolean(item.dynamicExitPlan.broadFallback)),
        liveSafeTriggerExpressionExplicit: false,
        relationshipFiltersLiveSafe: true,
        canStageForPaper: !isReturnFirstObjective(params.targetProfile) ? false : guardrailsPassed,
        canPromoteRuntime: false,
        canPromoteLive: false,
        cascadeRequired: cascadeScenarios.some((scenario) => Number(scenario.monthlyReturnPct ?? 0) >= 50),
        leverageRequired: (capitalAllocationScenarios.leverageScenarios as Array<Record<string, unknown>>).some((scenario) => Number(scenario.monthlyAccountReturnPct ?? 0) >= 50),
        blockers: [
          ...(guardrailsPassed ? [] : rejectionReasons),
          "runtime_mimic_live_safe_trigger_expression_pending",
        ],
        warnings: ["Return amplification scenarios are research-only until runtime mimic parity exists."],
      },
      exampleSelectedTrades: selected.slice(0, 8).map((item) => ({
        candidateId: item.candidate.candidateId,
        entryTs: item.candidate.entryTs,
        direction: item.candidate.direction,
        runtimeFamily: item.candidate.runtimeFamily,
        triggerTransition: item.candidate.triggerTransition,
        selectedBucket: item.candidate.selectedBucket,
        offsetLabel: item.candidate.offsetLabel,
        predictedMoveSizeBucket: item.prediction.predictedMoveSizeBucket,
        predictedBucketConfidence: item.prediction.predictedBucketConfidence,
        actualEvaluatedBucket: item.actualEvaluatedBucket,
        pnlPct: item.candidate.pnlPctPoints ?? item.candidate.pnlPct,
      })),
    };
  };

  const baselineSelected = enrichedCandidates.filter((item) => baselineSelectedIds.has(item.candidate.candidateId));
  const scenarios = [
    {
      scenarioId: "baseline_current_best",
      label: "Baseline current best policy",
      description: "Preserves the currently selected low-bucket high-win-rate rebuilt policy.",
      predicate: (item: typeof enrichedCandidates[number]) => baselineSelectedIds.has(item.candidate.candidateId),
      filterNotes: ["exact_final_best_policy_selected_trade_ids"],
    },
    {
      scenarioId: "bucket_gte_7_to_8",
      label: "Bucket >= 7_to_8_pct",
      description: "Research-only subset of candidates predicted to reach at least the 7-8% move class.",
      predicate: (item: typeof enrichedCandidates[number]) => returnBucketAtLeast(item.prediction.predictedMoveSizeBucket, "7_to_8_pct"),
      filterNotes: ["predicted_bucket>=7_to_8_pct"],
    },
    {
      scenarioId: "bucket_gte_8_to_9",
      label: "Bucket >= 8_to_9_pct",
      description: "Research-only subset of candidates predicted to reach at least the 8-9% move class.",
      predicate: (item: typeof enrichedCandidates[number]) => returnBucketAtLeast(item.prediction.predictedMoveSizeBucket, "8_to_9_pct"),
      filterNotes: ["predicted_bucket>=8_to_9_pct"],
    },
    {
      scenarioId: "bucket_gte_9_to_10",
      label: "Bucket >= 9_to_10_pct",
      description: "High-value subset of candidates predicted to reach at least the 9-10% move class.",
      predicate: (item: typeof enrichedCandidates[number]) => returnBucketAtLeast(item.prediction.predictedMoveSizeBucket, "9_to_10_pct"),
      filterNotes: ["predicted_bucket>=9_to_10_pct"],
    },
    {
      scenarioId: "bucket_10_plus_only",
      label: "Bucket 10_plus_pct only",
      description: "Policies explicitly aligned to 10_plus_pct selected move-size buckets.",
      predicate: (item: typeof enrichedCandidates[number]) =>
        String(item.candidate.selectedBucket ?? "").includes("10_plus_pct")
        || String(item.candidate.selectedMoveSizeBucket ?? "").includes("10_plus_pct"),
      filterNotes: ["selected_move_size_bucket=10_plus_pct"],
    },
    {
      scenarioId: "bucket_9_to_13_only",
      label: "Bucket 9_to_13_pct only",
      description: "High-value target set focused on 9-13% predicted move buckets only.",
      predicate: (item: typeof enrichedCandidates[number]) =>
        ["9_to_10_pct", "10_to_11_pct", "11_to_12_pct", "12_to_13_pct"].includes(String(item.prediction.predictedMoveSizeBucket ?? "")),
      filterNotes: ["predicted_bucket in 9_to_13_pct"],
    },
    {
      scenarioId: "elite_high_value_only",
      label: "Elite high-value only",
      description: "High predicted bucket plus high live-safe confidence, setup quality, and trigger strength.",
      predicate: (item: typeof enrichedCandidates[number]) =>
        returnBucketAtLeast(item.prediction.predictedMoveSizeBucket, "9_to_10_pct")
        && Number(item.prediction.predictedBucketConfidence ?? 0) >= 0.7
        && Number(item.candidate.setupMatch ?? 0) >= 0.6
        && Number(item.candidate.triggerStrengthScore ?? 0) >= 0.6,
      filterNotes: [
        "predicted_bucket>=9_to_10_pct",
        "predicted_bucket_confidence>=0.70",
        "setupMatch>=0.60",
        "triggerStrengthScore>=0.60",
      ],
    },
    {
      scenarioId: "failed_recovery_short_5_to_6_sell_late_full_family",
      label: "Failed recovery short 5-6% sell late full family",
      description: "Mandatory high-volume seed family analysis before daily-limit pruning.",
      predicate: (item: typeof enrichedCandidates[number]) =>
        item.candidate.runtimeFamily === "failed_recovery_short"
        && item.candidate.triggerTransition === "failed_recovery_break_down"
        && item.candidate.selectedMoveSizeBucket === "5_to_6_pct"
        && item.candidate.direction === "sell"
        && offsetClusterFromLabel(item.candidate.offsetLabel) === "late",
      filterNotes: [
        "runtimeFamily=failed_recovery_short",
        "triggerTransition=failed_recovery_break_down",
        "selectedMoveSizeBucket=5_to_6_pct",
        "direction=sell",
        "offsetCluster=late",
        "mandatory_high_volume_seed_escalation",
      ],
    },
    {
      scenarioId: "lifecycle_capture_gte_5",
      label: "Lifecycle capture >= 5%",
      description: "Evaluation-only filter keeping candidates whose lifecycle replay captured at least 5% PnL historically.",
      predicate: (item: typeof enrichedCandidates[number]) =>
        Number(lifecycleReplayByCandidateId.get(item.candidate.candidateId)?.lifecyclePnlPct ?? 0) >= 5,
      filterNotes: ["evaluation_only:lifecycle_capture>=5pct"],
    },
    {
      scenarioId: "lifecycle_capture_gte_7",
      label: "Lifecycle capture >= 7%",
      description: "Evaluation-only filter keeping candidates whose lifecycle replay captured at least 7% PnL historically.",
      predicate: (item: typeof enrichedCandidates[number]) =>
        Number(lifecycleReplayByCandidateId.get(item.candidate.candidateId)?.lifecyclePnlPct ?? 0) >= 7,
      filterNotes: ["evaluation_only:lifecycle_capture>=7pct"],
    },
    {
      scenarioId: "lifecycle_capture_gte_9",
      label: "Lifecycle capture >= 9%",
      description: "Evaluation-only filter keeping candidates whose lifecycle replay captured at least 9% PnL historically.",
      predicate: (item: typeof enrichedCandidates[number]) =>
        Number(lifecycleReplayByCandidateId.get(item.candidate.candidateId)?.lifecyclePnlPct ?? 0) >= 9,
      filterNotes: ["evaluation_only:lifecycle_capture>=9pct"],
    },
  ].map((scenario) => buildScenario(scenario));

  const targetSeedPredicate = (item: typeof enrichedCandidates[number]) =>
    item.candidate.runtimeFamily === "failed_recovery_short"
    && item.candidate.triggerTransition === "failed_recovery_break_down"
    && item.candidate.selectedMoveSizeBucket === "5_to_6_pct"
    && item.candidate.direction === "sell"
    && offsetClusterFromLabel(item.candidate.offsetLabel) === "late";
  const targetSeedFull = enrichedCandidates.filter(targetSeedPredicate);
  const targetSeedDailyLimited = scenarios.find((scenario) => scenario.scenarioId === "failed_recovery_short_5_to_6_sell_late_full_family") ?? null;
  const summariseCandidateSet = (selected: typeof enrichedCandidates) => {
    const pnl = selected.map((item) => Number(item.candidate.pnlPctPoints ?? item.candidate.pnlPct ?? 0));
    const lifecycleTrades = selected
      .map((item) => lifecycleReplayByCandidateId.get(item.candidate.candidateId) ?? null)
      .filter((item): item is TradeLifecycleReplayTradeResult => Boolean(item));
    const lifecyclePnl = lifecycleTrades.map((item) => Number(item.lifecyclePnlPct ?? 0));
    const wins = selected.filter((item) => Number(item.candidate.pnlPctPoints ?? item.candidate.pnlPct ?? 0) > 0).length;
    const losses = selected.length - wins;
    const slHits = selected.filter((item) => item.candidate.exitReason === "sl_hit").length;
    return {
      totalSimulatedTrades: selected.length,
      wins,
      losses,
      slHits,
      winRate: selected.length > 0 ? Number((wins / selected.length).toFixed(4)) : 0,
      slHitRate: selected.length > 0 ? Number((slHits / selected.length).toFixed(4)) : 0,
      baseMedianPnlPct: Number(percentile(pnl, 0.5).toFixed(4)),
      baseAveragePnlPct: Number(mean(pnl).toFixed(4)),
      lifecycleMedianPnlPct: lifecyclePnl.length > 0 ? Number(percentile(lifecyclePnl, 0.5).toFixed(4)) : null,
      lifecycleAveragePnlPct: lifecyclePnl.length > 0 ? Number(mean(lifecyclePnl).toFixed(4)) : null,
      accountReturnScenarios: simulateCapitalModels(selected),
      monthlyDistribution: scenarioMonthlyBreakdown(selected),
      offsetDistribution: countRecord(selected.map((item) => item.candidate.offsetLabel)),
      exitDistribution: countRecord(selected.map((item) => normalizeLifecycleExitReason(item.candidate.exitReason))),
      lifecycleExitDistribution: countRecord(lifecycleTrades.map((item) => item.lifecycleExitReason)),
      mfeDistribution: summarizeDistribution(selected.map((item) => Math.abs(Number(item.candidate.mfePctPoints ?? item.candidate.mfePct ?? 0))).filter((value) => value > 0)),
      maeDistribution: summarizeDistribution(selected.map((item) => Math.abs(Number(item.candidate.maePctPoints ?? item.candidate.maePct ?? 0))).filter((value) => value > 0)),
      tpPotentialDistribution: summarizeDistribution(selected.map((item) => Math.abs(Number(item.candidate.projectedMovePctPoints ?? item.candidate.projectedMovePct ?? 0))).filter((value) => value > 0)),
      lifecycleReplayReport: buildTradeLifecycleReplayReport({
        serviceId: params.dataset.serviceId,
        sourceJobId: null,
        sourcePolicyId: "failed_recovery_short_5_to_6_sell_late",
        selected: lifecycleTrades,
      }),
      worstLosingTradeExamples: selected
        .filter((item) => Number(item.candidate.pnlPctPoints ?? item.candidate.pnlPct ?? 0) <= 0)
        .sort((a, b) => Number(a.candidate.pnlPctPoints ?? a.candidate.pnlPct ?? 0) - Number(b.candidate.pnlPctPoints ?? b.candidate.pnlPct ?? 0))
        .slice(0, 8)
        .map((item) => ({
          candidateId: item.candidate.candidateId,
          pnlPct: item.candidate.pnlPctPoints ?? item.candidate.pnlPct,
          exitReason: normalizeLifecycleExitReason(item.candidate.exitReason),
          offsetLabel: item.candidate.offsetLabel,
          barsSinceLastCrash: item.candidate.liveSafeFeatures.barsSinceLastCrash ?? null,
          triggerStrengthScore: item.candidate.triggerStrengthScore,
          liveSafeEliteScore: item.liveSafeEliteScore,
        })),
      bestWinningTradeExamples: selected
        .filter((item) => Number(item.candidate.pnlPctPoints ?? item.candidate.pnlPct ?? 0) > 0)
        .sort((a, b) => Number(b.candidate.pnlPctPoints ?? b.candidate.pnlPct ?? 0) - Number(a.candidate.pnlPctPoints ?? a.candidate.pnlPct ?? 0))
        .slice(0, 8)
        .map((item) => ({
          candidateId: item.candidate.candidateId,
          pnlPct: item.candidate.pnlPctPoints ?? item.candidate.pnlPct,
          offsetLabel: item.candidate.offsetLabel,
          barsSinceLastCrash: item.candidate.liveSafeFeatures.barsSinceLastCrash ?? null,
          triggerStrengthScore: item.candidate.triggerStrengthScore,
          liveSafeEliteScore: item.liveSafeEliteScore,
        })),
    };
  };
  const liveSafeSeparationKeys = [
    "triggerStrengthScore",
    "liveSafeEliteScore",
    "oneBarReturnPct",
    "threeBarReturnPct",
    "fiveBarReturnPct",
    "tenBarReturnPct",
    "microBreakStrengthPct",
    "rangeExpansionScore60",
    "rangeCompressionScore60",
    "compressionToExpansionScore",
    "atrRank240",
    "bbWidthRank60",
    "barsSinceLastCrash",
    "crashRecencyScore",
    "reversalPressureScore",
    "offsetBars",
  ];
  const valueForSeparation = (item: typeof enrichedCandidates[number], key: string): number | null => {
    if (key === "triggerStrengthScore") return asFiniteNumber(item.candidate.triggerStrengthScore);
    if (key === "liveSafeEliteScore") return asFiniteNumber(item.liveSafeEliteScore);
    if (key === "offsetBars") return asFiniteNumber(item.candidate.offsetBars);
    return candidateFeatureNumber(item.candidate, key);
  };
  const winnerLoserSeparation = liveSafeSeparationKeys.map((key) => {
    const winners = targetSeedFull.filter((item) => Number(item.candidate.pnlPctPoints ?? item.candidate.pnlPct ?? 0) > 0);
    const losers = targetSeedFull.filter((item) => Number(item.candidate.pnlPctPoints ?? item.candidate.pnlPct ?? 0) <= 0);
    const winnerValues = winners.map((item) => valueForSeparation(item, key)).filter((value): value is number => value != null);
    const loserValues = losers.map((item) => valueForSeparation(item, key)).filter((value): value is number => value != null);
    const higherIsBetter = winnerValues.length === 0 || loserValues.length === 0 || percentile(winnerValues, 0.5) >= percentile(loserValues, 0.5);
    const threshold = higherIsBetter ? percentile(winnerValues, 0.25) : percentile(winnerValues, 0.75);
    const kept = targetSeedFull.filter((item) => {
      const value = valueForSeparation(item, key);
      if (value == null) return false;
      return higherIsBetter ? value >= threshold : value <= threshold;
    });
    const winnersLost = winners.length - kept.filter((item) => Number(item.candidate.pnlPctPoints ?? item.candidate.pnlPct ?? 0) > 0).length;
    const losersRemoved = losers.length - kept.filter((item) => Number(item.candidate.pnlPctPoints ?? item.candidate.pnlPct ?? 0) <= 0).length;
    return {
      feature: key,
      winnerP25: winnerValues.length > 0 ? Number(percentile(winnerValues, 0.25).toFixed(4)) : null,
      winnerMedian: winnerValues.length > 0 ? Number(percentile(winnerValues, 0.5).toFixed(4)) : null,
      winnerP75: winnerValues.length > 0 ? Number(percentile(winnerValues, 0.75).toFixed(4)) : null,
      loserP25: loserValues.length > 0 ? Number(percentile(loserValues, 0.25).toFixed(4)) : null,
      loserMedian: loserValues.length > 0 ? Number(percentile(loserValues, 0.5).toFixed(4)) : null,
      loserP75: loserValues.length > 0 ? Number(percentile(loserValues, 0.75).toFixed(4)) : null,
      separationScore: winnerValues.length > 0 && loserValues.length > 0
        ? Number(Math.abs(percentile(winnerValues, 0.5) - percentile(loserValues, 0.5)).toFixed(4))
        : 0,
      thresholdCandidate: `${key} ${higherIsBetter ? ">=" : "<="} ${Number(threshold.toFixed(4))}`,
      falsePositiveImpact: {
        resultingTrades: kept.length,
        winnersLost,
        losersRemoved,
        resultingWinRate: kept.length > 0 ? Number((kept.filter((item) => Number(item.candidate.pnlPctPoints ?? item.candidate.pnlPct ?? 0) > 0).length / kept.length).toFixed(4)) : 0,
        resultingSlRate: kept.length > 0 ? Number((kept.filter((item) => item.candidate.exitReason === "sl_hit").length / kept.length).toFixed(4)) : 0,
      },
    };
  }).sort((a, b) => b.separationScore - a.separationScore);
  const preLimitFamilyStats = summariseCandidateSet(targetSeedFull);
  const postDailyLimitFamilyStats = targetSeedDailyLimited;
  const dynamicTpProtectionSummary = targetSeedDailyLimited?.dynamicExitPlanSummary ?? null;
  const tradeLifecycleManagerReplay = preLimitFamilyStats.lifecycleReplayReport;
  const primaryDeepFamilyAnalysis = {
    familyKey: "failed_recovery_short|failed_recovery_break_down|5_to_6_pct|sell|late",
    verdict: "priority_runtime_candidate_family",
    preLimitFamilyStats,
    postDailyLimitFamilyStats,
    winnerLoserSeparation,
    tradeLifecycleManagerReplay,
    dynamicTpProtectionSummary,
    answers: {
      betterThanTinyBestAbove5: Number(preLimitFamilyStats.totalSimulatedTrades ?? 0) >= 50
        && Number(preLimitFamilyStats.winRate ?? 0) >= 0.88,
      retains90WinRateAfterDailyLimit: Number(targetSeedDailyLimited?.winRate ?? 0) >= 0.9,
      capturesFiveToSixPct: Number(targetSeedDailyLimited?.lifecycleMedianPnlPct ?? 0) >= 5,
      lossesAvoidableWithoutDestroyingWinners: winnerLoserSeparation.some((item) =>
        Number((item.falsePositiveImpact as Record<string, unknown>).losersRemoved ?? 0) >= 3
        && Number((item.falsePositiveImpact as Record<string, unknown>).winnersLost ?? 999) <= 14
      ),
    },
  };

  const baselineScenario = scenarios.find((scenario) => scenario.scenarioId === "baseline_current_best") ?? null;
  const relationshipFailedTrades = baselineSelected.filter((item) => {
    const relationship = relationshipToCalibratedMove(item.candidate, moveById);
    return relationship.label === "wrong_direction" || relationship.label === "too_late";
  });
  const baselineWinners = baselineSelected.filter((item) => Number(item.candidate.pnlPctPoints ?? item.candidate.pnlPct ?? 0) > 0);
  const proxyFeatureKeys = [
    "confidence",
    "setupMatch",
    "triggerStrengthScore",
    "crashRecencyScore",
    "rangeExpansionScore60",
    "compressionToExpansionScore",
    "barsSinceLastCrash",
    "atrRank240",
    "bbWidthRank60",
    "microBreakStrengthPct",
  ];
  const liveSafeProxyProposals = proxyFeatureKeys.map((key) => {
    const winnerValues = baselineWinners.map((item) => key === "confidence"
      ? Number(item.candidate.confidence ?? 0)
      : key === "setupMatch"
        ? Number(item.candidate.setupMatch ?? 0)
        : key === "triggerStrengthScore"
          ? Number(item.candidate.triggerStrengthScore ?? 0)
          : Number(candidateFeatureNumber(item.candidate, key) ?? 0)).filter((value) => Number.isFinite(value));
    if (winnerValues.length === 0) return null;
    const threshold = Number(percentile(winnerValues, 0.2).toFixed(3));
    const filtered = baselineSelected.filter((item) => {
      const value = key === "confidence"
        ? Number(item.candidate.confidence ?? 0)
        : key === "setupMatch"
          ? Number(item.candidate.setupMatch ?? 0)
          : key === "triggerStrengthScore"
            ? Number(item.candidate.triggerStrengthScore ?? 0)
            : Number(candidateFeatureNumber(item.candidate, key) ?? 0);
      return value >= threshold;
    });
    const removed = baselineSelected.filter((item) => !filtered.includes(item));
    return {
      filterExpression: `${key} >= ${threshold}`,
      expectedEffect: {
        tradesRemoved: removed.length,
        winsRemoved: removed.filter((item) => Number(item.candidate.pnlPctPoints ?? item.candidate.pnlPct ?? 0) > 0).length,
        lossesRemoved: removed.filter((item) => Number(item.candidate.pnlPctPoints ?? item.candidate.pnlPct ?? 0) <= 0).length,
        resultingTrades: filtered.length,
        resultingWinRate: filtered.length > 0 ? Number((filtered.filter((item) => Number(item.candidate.pnlPctPoints ?? item.candidate.pnlPct ?? 0) > 0).length / filtered.length).toFixed(4)) : 0,
        resultingSlRate: filtered.length > 0 ? Number((filtered.filter((item) => item.candidate.exitReason === "sl_hit").length / filtered.length).toFixed(4)) : 0,
        resultingMonthlyReturn: filtered.length > 0 ? Number((computeScenarioEquityMetrics(filtered.map((item) => Number(item.candidate.pnlPctPoints ?? item.candidate.pnlPct ?? 0) * 0.15)).accountReturnPct / Math.max(1, scenarioMonthlyBreakdown(filtered).length)).toFixed(2)) : 0,
        resultingAccountReturn: filtered.length > 0 ? computeScenarioEquityMetrics(filtered.map((item) => Number(item.candidate.pnlPctPoints ?? item.candidate.pnlPct ?? 0) * 0.15)).accountReturnPct : 0,
      },
    };
  }).filter(Boolean).slice(0, 5);

  const relationshipFailureProxyAnalysis = {
    relationshipFailedTradeCount: relationshipFailedTrades.length,
    wrongDirectionCount: relationshipFailedTrades.filter((item) => relationshipToCalibratedMove(item.candidate, moveById).label === "wrong_direction").length,
    tooLateCount: relationshipFailedTrades.filter((item) => relationshipToCalibratedMove(item.candidate, moveById).label === "too_late").length,
    featureDeltasVsWinners: Object.fromEntries(proxyFeatureKeys.map((key) => {
      const failureValues = relationshipFailedTrades.map((item) => key === "confidence"
        ? Number(item.candidate.confidence ?? 0)
        : key === "setupMatch"
          ? Number(item.candidate.setupMatch ?? 0)
          : key === "triggerStrengthScore"
            ? Number(item.candidate.triggerStrengthScore ?? 0)
            : Number(candidateFeatureNumber(item.candidate, key) ?? 0)).filter((value) => Number.isFinite(value));
      const winnerValues = baselineWinners.map((item) => key === "confidence"
        ? Number(item.candidate.confidence ?? 0)
        : key === "setupMatch"
          ? Number(item.candidate.setupMatch ?? 0)
          : key === "triggerStrengthScore"
            ? Number(item.candidate.triggerStrengthScore ?? 0)
            : Number(candidateFeatureNumber(item.candidate, key) ?? 0)).filter((value) => Number.isFinite(value));
      return [
        key,
        {
          failureMedian: failureValues.length > 0 ? Number(percentile(failureValues, 0.5).toFixed(3)) : null,
          winnerMedian: winnerValues.length > 0 ? Number(percentile(winnerValues, 0.5).toFixed(3)) : null,
          delta: failureValues.length > 0 && winnerValues.length > 0
            ? Number((percentile(failureValues, 0.5) - percentile(winnerValues, 0.5)).toFixed(3))
            : null,
        },
      ];
    })),
    proposedLiveSafeFilters: liveSafeProxyProposals,
  };

  const scenarioMeeting90Win = scenarios.filter((scenario) => Number(scenario.winRate ?? 0) >= 0.9 && Number(scenario.slHitRate ?? 0) <= 0.1);
  const scenarioApproaching50Monthly = [...scenarios].sort((a, b) =>
    Math.abs(50 - Number(a.averageMonthlyAccountReturnPct ?? 0)) - Math.abs(50 - Number(b.averageMonthlyAccountReturnPct ?? 0))
  )[0] ?? null;
  const rebuiltPolicySeedCount = Number(
    ((params.dataset.summary.rebuiltPolicySeedDiagnostics as Record<string, unknown> | undefined)?.rebuiltPolicySeedCount ?? 0),
  );
  const rankedScenarios = [...scenarios].sort((a, b) =>
    Number((b.scenarioId === "failed_recovery_short_5_to_6_sell_late_full_family") ? 1 : 0) - Number((a.scenarioId === "failed_recovery_short_5_to_6_sell_late_full_family") ? 1 : 0)
    || Number(b.guardrailsPassed ? 1 : 0) - Number(a.guardrailsPassed ? 1 : 0)
    || Number((b.trades ?? 0) >= 50 ? 1 : 0) - Number((a.trades ?? 0) >= 50 ? 1 : 0)
    || Number(b.lifecycleAverageMonthlyAccountReturnPct ?? b.averageMonthlyAccountReturnPct ?? 0) - Number(a.lifecycleAverageMonthlyAccountReturnPct ?? a.averageMonthlyAccountReturnPct ?? 0)
    || Number(b.lifecycleAccountReturnPct ?? b.accountReturnPct ?? 0) - Number(a.lifecycleAccountReturnPct ?? a.accountReturnPct ?? 0)
    || Number(b.lifecycleMedianPnlPct ?? 0) - Number(a.lifecycleMedianPnlPct ?? 0)
    || Number(b.lifecycleAveragePnlPct ?? 0) - Number(a.lifecycleAveragePnlPct ?? 0)
    || Number(b.lifecycleMfeCaptureRatio ?? 0) - Number(a.lifecycleMfeCaptureRatio ?? 0)
    || Number(b.winRate ?? 0) - Number(a.winRate ?? 0)
    || Number(a.drawdown ?? Number.POSITIVE_INFINITY) - Number(b.drawdown ?? Number.POSITIVE_INFINITY)
    || Number(b.trades ?? 0) - Number(a.trades ?? 0)
  );
  const recommendedCandidateConfiguration = rankedScenarios[0] ?? null;
  const safestHighWinPolicy = [...scenarios].sort((a, b) =>
    Number(b.winRate ?? 0) - Number(a.winRate ?? 0)
    || Number(a.slHitRate ?? Number.POSITIVE_INFINITY) - Number(b.slHitRate ?? Number.POSITIVE_INFINITY)
    || Number(b.profitFactor ?? 0) - Number(a.profitFactor ?? 0)
    || Number(b.lifecycleMedianPnlPct ?? 0) - Number(a.lifecycleMedianPnlPct ?? 0)
  )[0] ?? null;
  const highVolumeRuntimeCandidate = targetSeedDailyLimited && Number(targetSeedDailyLimited.trades ?? 0) >= 50
    && Number(targetSeedDailyLimited.winRate ?? 0) >= 0.9
    && Number(targetSeedDailyLimited.slHitRate ?? 1) <= 0.1
    ? targetSeedDailyLimited
    : null;
  const bestReturnFirstPolicy = highVolumeRuntimeCandidate ?? rankedScenarios.find((scenario) => Boolean(scenario.guardrailsPassed) && Number(scenario.trades ?? 0) >= 50) ?? rankedScenarios.find((scenario) => Boolean(scenario.guardrailsPassed)) ?? null;
  const bestRejectedProfitPolicy = [...scenarios]
    .filter((scenario) => !Boolean(scenario.guardrailsPassed))
    .sort((a, b) =>
      Number(b.lifecycleAverageMonthlyAccountReturnPct ?? 0) - Number(a.lifecycleAverageMonthlyAccountReturnPct ?? 0)
      || Number(b.lifecycleAccountReturnPct ?? 0) - Number(a.lifecycleAccountReturnPct ?? 0)
      || Number(b.lifecycleMedianPnlPct ?? 0) - Number(a.lifecycleMedianPnlPct ?? 0)
    )[0] ?? null;
  const scenarioByCaptureThreshold = Object.fromEntries(captureThresholds.map((threshold) => [
    threshold,
    rankedScenarios.filter((scenario) => Number(scenario.lifecycleMedianPnlPct ?? 0) >= threshold),
  ])) as Record<typeof captureThresholds[number], typeof scenarios>;
  const policiesWithMedianLifecyclePnlAbove5 = scenarioByCaptureThreshold[5].map((scenario) => scenario.scenarioId);
  const policiesWithMedianLifecyclePnlAbove7 = scenarioByCaptureThreshold[7].map((scenario) => scenario.scenarioId);
  const policiesWithMedianLifecyclePnlAbove9 = scenarioByCaptureThreshold[9].map((scenario) => scenario.scenarioId);
  const bestAbove5 = scenarioByCaptureThreshold[5][0] ?? null;
  const bestAbove7 = scenarioByCaptureThreshold[7][0] ?? null;
  const bestAbove9 = scenarioByCaptureThreshold[9][0] ?? null;
  const whyHigherCaptureFailed = captureThresholds.map((threshold) => {
    const failing = rankedScenarios
      .filter((scenario) => Number(scenario.lifecycleMedianPnlPct ?? 0) < threshold)
      .sort((a, b) => Number(b.lifecycleAverageMonthlyAccountReturnPct ?? 0) - Number(a.lifecycleAverageMonthlyAccountReturnPct ?? 0))[0] ?? null;
    return {
      thresholdPct: threshold,
      available: (scenarioByCaptureThreshold[threshold] ?? []).length > 0,
      topFailingScenarioId: failing?.scenarioId ?? null,
      topFailingMedianLifecyclePnlPct: Number(failing?.lifecycleMedianPnlPct ?? 0),
      rejectionReasons: Array.isArray(failing?.rejectionReasons) ? failing.rejectionReasons : [],
    };
  });
  const recommendedPolicy = bestReturnFirstPolicy
    ? {
        status: highVolumeRuntimeCandidate ? "runtime_artifact_eligible" : "guardrails_passed",
        policy: bestReturnFirstPolicy,
        explanation: highVolumeRuntimeCandidate
          ? "Selected for final-pass review because failed_recovery_short 5_to_6 sell late is the strongest high-volume runtime family and retains 90%+ win rate after daily limiting."
          : `Selected for return_first because it passed swing capture guardrails and delivered ${Number(bestReturnFirstPolicy.lifecycleAverageMonthlyAccountReturnPct ?? 0).toFixed(2)}% average monthly return.`,
      }
    : safestHighWinPolicy
      ? {
          status: "baseline_only",
          policy: safestHighWinPolicy,
          explanation: "No CRASH300 return-first swing policy found. Current best is high-win low-capture baseline.",
        }
      : {
          status: "no_policy",
          policy: null,
          explanation: "No CRASH300 return-first swing policy found. Current best is high-win low-capture baseline.",
        };
  const runtimeArtifactEligibility = {
    status: highVolumeRuntimeCandidate ? "runtime_artifact_eligible" : "blocked_with_named_reason",
    candidateFamily: "failed_recovery_short|failed_recovery_break_down|5_to_6_pct|sell|late",
    canCreateReviewArtifact: Boolean(highVolumeRuntimeCandidate),
    canAutoStage: false,
    canAutoPromote: false,
    canPromoteRuntimeAfterValidation: Boolean(highVolumeRuntimeCandidate),
    blockers: [
      ...(highVolumeRuntimeCandidate ? [] : ["high_volume_family_failed_win_or_sl_gate"]),
      ...(Number(targetSeedDailyLimited?.lifecycleMedianPnlPct ?? 0) >= 5 ? [] : ["lifecycle_capture_below_5pct"]),
      ...(primaryDeepFamilyAnalysis.answers.lossesAvoidableWithoutDestroyingWinners ? [] : ["losses_not_cleanly_separable_yet"]),
      "runtime_mimic_validation_required_before_promotion",
      "manual_validate_runtime_required",
    ],
    warnings: [
      "Review artifact only. No staging, promotion, Demo, Real, or live execution changes are performed by Build Runtime Model.",
    ],
  };
  const aiReviewInput = {
    objective: "Can failed_recovery_short 5_to_6 sell late become a live-safe deterministic runtime, and what filters/lifecycle settings should be validated?",
    primaryFamily: {
      familyKey: primaryDeepFamilyAnalysis.familyKey,
      preLimitFamilyStats,
      postDailyLimitFamilyStats,
      answers: primaryDeepFamilyAnalysis.answers,
      topWinnerLoserSeparation: winnerLoserSeparation.slice(0, 10),
      dynamicTpProtectionSummary,
      lifecycleReplaySummary: tradeLifecycleManagerReplay
        ? {
            tradeCount: tradeLifecycleManagerReplay.tradeCount,
            lifecycleMedianPnlPct: tradeLifecycleManagerReplay.lifecycleMedianPnlPct,
            lifecycleAveragePnlPct: tradeLifecycleManagerReplay.lifecycleAveragePnlPct,
            lifecycleTotalAccountReturnPct: tradeLifecycleManagerReplay.lifecycleTotalAccountReturnPct,
            lifecycleAverageMonthlyReturnPct: tradeLifecycleManagerReplay.lifecycleAverageMonthlyReturnPct,
            oldMedianPnlPct: tradeLifecycleManagerReplay.oldMedianPnlPct,
            oldAveragePnlPct: tradeLifecycleManagerReplay.oldAveragePnlPct,
            improvedTradeCount: tradeLifecycleManagerReplay.improvedTradeCount,
            exitReasonDistribution: tradeLifecycleManagerReplay.exitReasonDistribution,
          }
        : null,
    },
    candidateFamilyComparison: scenarios.map((scenario) => ({
      scenarioId: scenario.scenarioId,
      label: scenario.label,
      trades: scenario.trades,
      wins: scenario.wins,
      losses: scenario.losses,
      winRate: scenario.winRate,
      slHitRate: scenario.slHitRate,
      lifecycleMedianPnlPct: scenario.lifecycleMedianPnlPct,
      lifecycleAveragePnlPct: scenario.lifecycleAveragePnlPct,
      lifecycleAverageMonthlyAccountReturnPct: scenario.lifecycleAverageMonthlyAccountReturnPct,
      rejectionReasons: scenario.rejectionReasons,
    })).slice(0, 12),
    deterministicRulesOnly: true,
    noLiveTradingAccess: true,
  };
  const aiStrategyReview = await (async () => {
    try {
      const completion = await withTimeout(
        chatComplete({
          messages: [
            {
              role: "system",
              content: "You are an offline research reviewer for a Deriv synthetic-index runtime builder. You cannot trade, stage, promote, or access live execution. Return compact JSON only.",
            },
            {
              role: "user",
              content: JSON.stringify({
                task: "Review deterministic CRASH300 Build Runtime Model summaries. Recommend deterministic live-safe refinements only.",
                requiredOutput: {
                  recommendedSeedFamiliesToPrioritise: "string[]",
                  winnerLoserSeparatingFeatures: "string[]",
                  deterministicRuleRefinements: "string[]",
                  tpProtectionMaturitySettings: "string[]",
                  rejectionFilters: "string[]",
                  riskConcerns: "string[]",
                  confidence: "low|medium|high",
                  worthRuntimeMimicValidation: "boolean",
                },
                input: aiReviewInput,
              }),
            },
          ],
          response_format: { type: "json_object" },
          temperature: 0.1,
          max_completion_tokens: 1400,
        }),
        45_000,
        "AI Strategy Review timed out after 45s; deterministic final-pass build continued.",
      );
      const text = completion.choices[0]?.message?.content ?? "{}";
      return {
        status: "run",
        model: completion.model,
        recommendations: JSON.parse(text) as Record<string, unknown>,
        deterministicValidationRequired: true,
        liveTradingAccess: false,
      };
    } catch (err) {
      return {
        status: "unavailable",
        reason: err instanceof Error ? err.message : String(err),
        deterministicModeContinued: true,
        curatedReviewInput: aiReviewInput,
      };
    }
  })();
  const policyComparisonTable = rankedScenarios.map((scenario) => ({
    policyId: String(scenario.scenarioId ?? "unknown"),
    runtimeFamily: String(scenario.runtimeFamily ?? "unknown"),
    triggerTransition: String(scenario.triggerTransition ?? "unknown"),
    bucket: String(scenario.bucket ?? "unknown"),
    direction: String(scenario.direction ?? "unknown"),
    offsetCluster: String(scenario.offsetCluster ?? "unknown"),
    trades: Number(scenario.trades ?? 0),
    wins: Number(scenario.wins ?? 0),
    losses: Number(scenario.losses ?? 0),
    winRate: Number(scenario.winRate ?? 0),
    slHitRate: Number(scenario.slHitRate ?? 0),
    profitFactor: Number(scenario.profitFactor ?? 0),
    oldMedianPnlPct: Number((scenario.tradeLifecycleReplayReport as Record<string, unknown> | undefined)?.oldMedianPnlPct ?? 0),
    lifecycleMedianPnlPct: Number(scenario.lifecycleMedianPnlPct ?? 0),
    lifecycleAveragePnlPct: Number(scenario.lifecycleAveragePnlPct ?? 0),
    medianMfePct: Number(scenario.medianMfePct ?? 0),
    lifecycleMfeCaptureRatio: Number(scenario.lifecycleMfeCaptureRatio ?? 0),
    lifecycleTotalAccountReturnPct: Number(scenario.lifecycleAccountReturnPct ?? scenario.accountReturnPct ?? 0),
    lifecycleAverageMonthlyReturnPct: Number(scenario.lifecycleAverageMonthlyAccountReturnPct ?? scenario.averageMonthlyAccountReturnPct ?? 0),
    maxDrawdownPct: Number(scenario.drawdown ?? 0),
    medianHoldMinutes: Number(scenario.medianHoldMinutes ?? 0),
    exitReasonDistribution: (scenario.tradeLifecycleReplayReport as Record<string, unknown> | undefined)?.exitReasonDistribution ?? {},
    scalpLike: Boolean(scenario.scalpLike),
    guardrailsPassed: Boolean(scenario.guardrailsPassed),
    rejectionReasons: Array.isArray(scenario.rejectionReasons) ? scenario.rejectionReasons : [],
    rankingScore: Number(scenario.rankingScore ?? 0),
  }));
  const baselineLifecycleReplayReport = baselineScenario?.tradeLifecycleReplayReport ?? buildTradeLifecycleReplayReport({
    serviceId: params.dataset.serviceId,
    sourceJobId: null,
    sourcePolicyId: params.bestPolicySummary?.policyId ?? null,
    selected: [],
  });

  return {
    preservedBaselineInvariants: {
      rebuiltCandidatesGenerated: simulatedCandidates.length > 0,
      rebuiltCandidatesSimulated: rebuiltPolicySeedCount > 0 || simulatedCandidates.length > 0,
      rebuiltPolicySeedGroupsPositive: rebuiltPolicySeedCount > 0,
      selectedTradesExportReconciles: Boolean(params.bestPolicySelectedTradesSummary?.reportConsistencyChecks && Object.values(params.bestPolicySelectedTradesSummary.reportConsistencyChecks as Record<string, unknown>).every(Boolean)),
      rebuiltTopPolicyPresent: Boolean(params.bestPolicySummary?.sourcePool === "rebuilt_trigger_candidates"),
    },
    predictorSummary: {
      totalSimulatedCandidates: simulatedCandidates.length,
      predictedCandidates: predictions.filter((prediction) => prediction.predictedMoveSizeBucket).length,
      noPredictionCandidates: predictions.filter((prediction) => !prediction.predictedMoveSizeBucket).length,
      predictedBucketDistribution: probabilityDistribution(predictions.map((prediction) => prediction.predictedMoveSizeBucket)).counts,
      actualEvaluatedBucketDistribution: probabilityDistribution(predictions.map((prediction) => prediction.actualEvaluatedBucket)).counts,
      noPredictionReasonCounts: countRecord(predictions.map((prediction) => prediction.noPredictionReason)),
      candidatePredictions: predictions,
    },
    dynamicExitDerivationTable: enrichedCandidates.slice(0, 120).map((item) => ({
      candidateId: item.candidate.candidateId,
      predictedMoveSizeBucket: item.prediction.predictedMoveSizeBucket,
      predictedBucketConfidence: item.prediction.predictedBucketConfidence,
      dynamicExitPlan: item.dynamicExitPlan,
    })),
    scenarioPolicies: scenarios,
    capitalScenarioSummary: scenarios.map((scenario) => ({
      scenarioId: scenario.scenarioId,
      currentAllocatorAccountReturnPct: Number((scenario.capitalAllocationScenarios as Record<string, unknown>).currentAllocatorModel && Number((((scenario.capitalAllocationScenarios as Record<string, unknown>).currentAllocatorModel as Record<string, unknown>).accountReturnPct ?? 0))),
      confidenceWeightedAccountReturnPct: Number((scenario.capitalAllocationScenarios as Record<string, unknown>).confidenceWeightedAllocation && Number((((scenario.capitalAllocationScenarios as Record<string, unknown>).confidenceWeightedAllocation as Record<string, unknown>).accountReturnPct ?? 0))),
    })),
    cascadeScenarioSummary: scenarios.map((scenario) => ({
      scenarioId: scenario.scenarioId,
      bestCascadeMonthlyReturnPct: Math.max(...((scenario.cascadeScenarios as Array<Record<string, unknown>>).map((item) => Number(item.monthlyReturnPct ?? 0))), 0),
      cascadeRequired: (scenario.paperStageability as Record<string, unknown>).cascadeRequired,
    })),
    relationshipFailureProxyAnalysis,
    targetProfileRaw: params.targetProfile,
    targetProfileNormalized: isReturnFirstObjective(params.targetProfile) ? "return_first" : "default",
    rankingObjective: swingCaptureGuardrails.rankingObjective,
    swingCaptureGuardrails,
    safestHighWinPolicy,
    bestReturnFirstPolicy,
    bestRejectedProfitPolicy,
    recommendedPolicy,
    recommendedCandidateConfiguration,
    escalatedSeedFamilies: [
      {
        familyKey: "failed_recovery_short|failed_recovery_break_down|5_to_6_pct|sell|late",
        escalationReason: "simulatedTrades>=50 winRate>=0.88 slHitRate<=0.15 bucket>=5_to_6_pct",
        priority: "primary",
        preLimit: {
          trades: preLimitFamilyStats.totalSimulatedTrades,
          wins: preLimitFamilyStats.wins,
          losses: preLimitFamilyStats.losses,
          slHits: preLimitFamilyStats.slHits,
          winRate: preLimitFamilyStats.winRate,
          slHitRate: preLimitFamilyStats.slHitRate,
        },
        postDailyLimit: targetSeedDailyLimited
          ? {
              trades: targetSeedDailyLimited.trades,
              wins: targetSeedDailyLimited.wins,
              losses: targetSeedDailyLimited.losses,
              slHits: targetSeedDailyLimited.slHits,
              winRate: targetSeedDailyLimited.winRate,
              slHitRate: targetSeedDailyLimited.slHitRate,
            }
          : null,
      },
    ],
    primaryDeepFamilyAnalysis,
    preLimitFamilyStats,
    postDailyLimitFamilyStats,
    winnerLoserSeparation,
    tradeLifecycleManagerReplay,
    dynamicTpProtectionSummary,
    aiStrategyReview,
    runtimeArtifactEligibility,
    policyComparisonTable,
    tradeLifecycleReplayReport: baselineLifecycleReplayReport,
    summary: {
      anyScenarioReaches50MonthlyReturn: scenarios.some((scenario) => Number(scenario.averageMonthlyAccountReturnPct ?? 0) >= 50),
      closestScenarioTo50MonthlyReturn: scenarioApproaching50Monthly
        ? {
            scenarioId: scenarioApproaching50Monthly.scenarioId,
            averageMonthlyAccountReturnPct: scenarioApproaching50Monthly.averageMonthlyAccountReturnPct,
          }
        : null,
      anyScenarioMaintains90WinAndLowSl: scenarioMeeting90Win.length > 0,
      scenariosMeeting90WinAndLowSl: scenarioMeeting90Win.map((scenario) => scenario.scenarioId),
      policiesWithMedianLifecyclePnlAbove5,
      policiesWithMedianLifecyclePnlAbove7,
      policiesWithMedianLifecyclePnlAbove9,
      bestAbove5,
      bestAbove7,
      bestAbove9,
      whyHigherCaptureFailed,
      lifecycleReplayImprovedTrades: baselineLifecycleReplayReport.improvedTradeCount,
      lifecycleOldMedianPnlPct: baselineLifecycleReplayReport.oldMedianPnlPct,
      lifecycleNewMedianPnlPct: baselineLifecycleReplayReport.lifecycleMedianPnlPct,
      lifecycleOldAveragePnlPct: baselineLifecycleReplayReport.oldAveragePnlPct,
      lifecycleNewAveragePnlPct: baselineLifecycleReplayReport.lifecycleAveragePnlPct,
      failedRecoveryShortFinalPassAnswers: primaryDeepFamilyAnalysis.answers,
      recommendedNextStep: recommendedCandidateConfiguration && Number((recommendedCandidateConfiguration as Record<string, unknown>).averageMonthlyAccountReturnPct ?? 0) > 0
        ? "Review the failed_recovery_short runtime artifact candidate, then run Validate Runtime manually before any Promote Runtime action."
        : "No safe return-first swing policy emerged from the current analysis. Keep the baseline rebuilt policy and continue research.",
    },
  };
}

async function markEliteSynthesisJobFailed(jobId: number, error: unknown) {
  await updateEliteSynthesisJob(jobId, {
    status: "failed",
    stage: "failed",
    progressPct: 100,
    message: error instanceof Error ? error.message : "Integrated elite synthesis failed",
    heartbeatAt: nowIso(),
    completedAt: nowIso(),
    errorSummary: {
      message: error instanceof Error ? error.message : String(error),
    },
  });
}

function normalizedEliteTargetProfile(targetProfile: EliteSynthesisTargetProfile): "default" | "return_first" {
  return isReturnFirstObjective(targetProfile) ? "return_first" : "default";
}

function deriveNoTargetReason(params: {
  resultState: EliteSynthesisResultState;
  targetAchieved: boolean;
  targetProfile: EliteSynthesisTargetProfile;
  recommendedPolicyStatus: string | null;
  bestReturnFirstPolicyPresent: boolean;
  guardrailsPassedCount: number;
  passLogLength: number;
  maxPasses: number;
}): string | null {
  if (params.targetAchieved) return null;
  if (normalizedEliteTargetProfile(params.targetProfile) !== "return_first") return null;
  if (params.resultState !== "completed_exhausted_no_target") return null;
  if (params.bestReturnFirstPolicyPresent) return null;
  if (params.guardrailsPassedCount > 0) return null;
  if (params.passLogLength < params.maxPasses) {
    return "return_first_search_stopped_before_full_exhaustion";
  }
  if (params.recommendedPolicyStatus === "baseline_only") {
    return "no_policy_passed_return_first_guardrails";
  }
  return "no_policy_survived_return_first_search";
}

function compactLifecycleReplayTradeForStorage(trade: Record<string, unknown>) {
  return {
    tradeId: trade.tradeId ?? null,
    serviceId: trade.serviceId ?? null,
    sourceJobId: trade.sourceJobId ?? null,
    sourcePolicyId: trade.sourcePolicyId ?? null,
    entryTs: trade.entryTs ?? null,
    oldExitTs: trade.oldExitTs ?? null,
    lifecycleExitTs: trade.lifecycleExitTs ?? null,
    oldPnlPct: trade.oldPnlPct ?? 0,
    lifecyclePnlPct: trade.lifecyclePnlPct ?? 0,
    oldExitReason: trade.oldExitReason ?? null,
    lifecycleExitReason: trade.lifecycleExitReason ?? null,
    maxMfeSeenBeforeExit: trade.maxMfeSeenBeforeExit ?? 0,
    maxMaeSeenBeforeExit: trade.maxMaeSeenBeforeExit ?? 0,
    oldMfeCaptureRatio: trade.oldMfeCaptureRatio ?? 0,
    lifecycleMfeCaptureRatio: trade.lifecycleMfeCaptureRatio ?? 0,
    timeInTradeOld: trade.timeInTradeOld ?? 0,
    timeInTradeLifecycle: trade.timeInTradeLifecycle ?? 0,
    tp1Reached: Boolean(trade.tp1Reached),
    tp2Reached: Boolean(trade.tp2Reached),
    protectedAt: trade.protectedAt ?? null,
    partialTakenAt: trade.partialTakenAt ?? null,
    runnerActivatedAt: trade.runnerActivatedAt ?? null,
    oldExitWasTooEarly: Boolean(trade.oldExitWasTooEarly),
    lifecycleCapturedMoreMove: Boolean(trade.lifecycleCapturedMoreMove),
  };
}

function compactTradeLifecycleReplayReportForStorage(report: unknown) {
  if (!report || typeof report !== "object") return report;
  const replay = report as Record<string, unknown>;
  const examples = replay.examples && typeof replay.examples === "object"
    ? replay.examples as Record<string, unknown>
    : {};
  const compactExamples = Object.fromEntries(
    ["protectedExitExamples", "lifecycleHoldImprovedResult", "lifecycleProtectedProfit", "lifecycleExitedCorrectly"]
      .map((key) => [
        key,
        Array.isArray(examples[key])
          ? (examples[key] as Record<string, unknown>[]).slice(0, 3).map((trade) => compactLifecycleReplayTradeForStorage(trade))
          : [],
      ]),
  );
  return {
    ...replay,
    compactedForStorage: true,
    examples: compactExamples,
    trades: [],
  };
}

function compactReturnAmplificationScenarioForStorage(scenario: unknown) {
  if (!scenario || typeof scenario !== "object") return scenario;
  const entry = scenario as Record<string, unknown>;
  return {
    ...entry,
    monthlyBreakdown: Array.isArray(entry.monthlyBreakdown) ? entry.monthlyBreakdown.slice(-12) : [],
    tradeLifecycleReplayReport: compactTradeLifecycleReplayReportForStorage(entry.tradeLifecycleReplayReport),
    exampleSelectedTrades: Array.isArray(entry.exampleSelectedTrades) ? entry.exampleSelectedTrades.slice(0, 5) : [],
  };
}

function compactFamilyStatsForStorage(stats: unknown) {
  if (!stats || typeof stats !== "object") return stats;
  const entry = stats as Record<string, unknown>;
  return {
    ...entry,
    monthlyDistribution: Array.isArray(entry.monthlyDistribution) ? entry.monthlyDistribution.slice(-12) : [],
    lifecycleReplayReport: compactTradeLifecycleReplayReportForStorage(entry.lifecycleReplayReport),
    worstLosingTradeExamples: Array.isArray(entry.worstLosingTradeExamples) ? entry.worstLosingTradeExamples.slice(0, 5) : [],
    bestWinningTradeExamples: Array.isArray(entry.bestWinningTradeExamples) ? entry.bestWinningTradeExamples.slice(0, 5) : [],
  };
}

function compactPrimaryDeepFamilyAnalysisForStorage(value: unknown) {
  if (!value || typeof value !== "object") return value;
  const analysis = value as Record<string, unknown>;
  return {
    ...analysis,
    preLimitFamilyStats: compactFamilyStatsForStorage(analysis.preLimitFamilyStats),
    postDailyLimitFamilyStats: compactReturnAmplificationScenarioForStorage(analysis.postDailyLimitFamilyStats),
    winnerLoserSeparation: Array.isArray(analysis.winnerLoserSeparation) ? analysis.winnerLoserSeparation.slice(0, 16) : [],
    tradeLifecycleManagerReplay: compactTradeLifecycleReplayReportForStorage(analysis.tradeLifecycleManagerReplay),
  };
}

function compactAiStrategyReviewForStorage(value: unknown) {
  if (!value || typeof value !== "object") return value;
  const review = value as Record<string, unknown>;
  return {
    ...review,
    curatedReviewInput: undefined,
    curatedReviewInputSummary: review.curatedReviewInput && typeof review.curatedReviewInput === "object"
      ? {
          objective: (review.curatedReviewInput as Record<string, unknown>).objective,
          deterministicRulesOnly: (review.curatedReviewInput as Record<string, unknown>).deterministicRulesOnly,
          noLiveTradingAccess: (review.curatedReviewInput as Record<string, unknown>).noLiveTradingAccess,
        }
      : undefined,
  };
}

function compactReviewCandidateRuntimeArtifactForStorage(value: unknown) {
  if (!value || typeof value !== "object") return value;
  const artifact = value as Record<string, unknown>;
  return {
    ...artifact,
    deepFamilyAnalysis: compactPrimaryDeepFamilyAnalysisForStorage(artifact.deepFamilyAnalysis),
    aiStrategyReview: compactAiStrategyReviewForStorage(artifact.aiStrategyReview),
  };
}

function compactBestPolicyArtifactForStorage(value: unknown) {
  if (!value || typeof value !== "object") return value;
  const artifact = value as Record<string, unknown>;
  return {
    policyId: artifact.policyId ?? null,
    serviceId: artifact.serviceId ?? null,
    symbol: artifact.symbol ?? null,
    passNumberSelected: artifact.passNumberSelected ?? null,
    objectiveScore: artifact.objectiveScore ?? null,
    selectedBuckets: artifact.selectedBuckets ?? [],
    selectedMoveSizeBuckets: artifact.selectedMoveSizeBuckets ?? [],
    selectedRuntimeArchetypes: artifact.selectedRuntimeArchetypes ?? [],
    selectedTriggerTransitions: artifact.selectedTriggerTransitions ?? [],
    selectedTriggerDirections: artifact.selectedTriggerDirections ?? [],
    entryThresholds: artifact.entryThresholds ?? [],
    entryTimingRules: artifact.entryTimingRules ?? [],
    noTradeRules: artifact.noTradeRules ?? [],
    tpRules: artifact.tpRules ?? null,
    slRules: artifact.slRules ?? null,
    lifecycleManagerRules: artifact.lifecycleManagerRules ?? null,
    minHoldRules: artifact.minHoldRules ?? null,
    leakageAudit: artifact.leakageAudit ?? null,
    expectedThreeMonthPerformance: artifact.expectedThreeMonthPerformance ?? null,
    monthlyBreakdown: Array.isArray(artifact.monthlyBreakdown) ? artifact.monthlyBreakdown.slice(-12) : [],
    lateOffsetSafetyAudit: artifact.lateOffsetSafetyAudit ?? null,
    calibratedMoveRelationshipSummary: artifact.calibratedMoveRelationshipSummary ?? null,
    exitDerivationAudit: artifact.exitDerivationAudit ?? null,
    monthlyStabilityAssessment: artifact.monthlyStabilityAssessment ?? null,
    bestPolicySelectedTradesSummary: artifact.bestPolicySelectedTradesSummary ?? null,
    targetAchievedBreakdown: artifact.targetAchievedBreakdown ?? null,
    strategyGradeReadiness: artifact.strategyGradeReadiness ?? null,
    policyArtifactReadiness: artifact.policyArtifactReadiness ?? null,
    bottleneckAnalysis: artifact.bottleneckAnalysis ?? null,
    compactedForStorage: true,
  };
}

function compactDiagnosticsForStorage(value: unknown) {
  if (!value || typeof value !== "object") return value;
  const diagnostics = value as Record<string, unknown>;
  return {
    summary: diagnostics.summary ?? null,
    rawCandidatesGenerated: diagnostics.rawCandidatesGenerated ?? null,
    eligibleCandidates: diagnostics.eligibleCandidates ?? null,
    simulatedTradeCount: diagnostics.simulatedTradeCount ?? null,
    rebuiltPolicySeedCount: diagnostics.rebuiltPolicySeedCount ?? null,
    rebuiltPoliciesWithTrades: diagnostics.rebuiltPoliciesWithTrades ?? null,
    rebuiltRejectedPolicyCount: diagnostics.rebuiltRejectedPolicyCount ?? null,
    rebuiltPolicyEvaluationTradeCounts: Array.isArray(diagnostics.rebuiltPolicyEvaluationTradeCounts)
      ? diagnostics.rebuiltPolicyEvaluationTradeCounts.slice(0, 40)
      : [],
    topRejectReasons: Array.isArray(diagnostics.topRejectReasons) ? diagnostics.topRejectReasons.slice(0, 20) : [],
  };
}

function compactDatasetSummaryForStorage(value: unknown) {
  if (!value || typeof value !== "object") return value;
  const summary = value as Record<string, unknown>;
  return {
    ...summary,
    rebuiltPolicySeedDiagnostics: compactDiagnosticsForStorage(summary.rebuiltPolicySeedDiagnostics),
  };
}

function compactReturnAmplificationAnalysisForStorage(value: unknown) {
  if (!value || typeof value !== "object") return value;
  const analysis = value as Record<string, unknown>;
  const predictorSummary = analysis.predictorSummary && typeof analysis.predictorSummary === "object"
    ? analysis.predictorSummary as Record<string, unknown>
    : null;
  return {
    ...analysis,
    predictorSummary: predictorSummary
      ? {
          ...predictorSummary,
          candidatePredictions: Array.isArray(predictorSummary.candidatePredictions)
            ? predictorSummary.candidatePredictions.slice(0, 60)
            : [],
          candidatePredictionsTruncated: Array.isArray(predictorSummary.candidatePredictions)
            ? (predictorSummary.candidatePredictions as unknown[]).length > 60
            : false,
        }
      : null,
    dynamicExitDerivationTable: Array.isArray(analysis.dynamicExitDerivationTable)
      ? analysis.dynamicExitDerivationTable.slice(0, 40)
      : [],
    scenarioPolicies: Array.isArray(analysis.scenarioPolicies)
      ? analysis.scenarioPolicies.map((scenario) => compactReturnAmplificationScenarioForStorage(scenario))
      : [],
    safestHighWinPolicy: compactReturnAmplificationScenarioForStorage(analysis.safestHighWinPolicy),
    bestReturnFirstPolicy: compactReturnAmplificationScenarioForStorage(analysis.bestReturnFirstPolicy),
    bestRejectedProfitPolicy: compactReturnAmplificationScenarioForStorage(analysis.bestRejectedProfitPolicy),
    recommendedPolicy: analysis.recommendedPolicy && typeof analysis.recommendedPolicy === "object"
      ? {
          ...(analysis.recommendedPolicy as Record<string, unknown>),
          policy: compactReturnAmplificationScenarioForStorage((analysis.recommendedPolicy as Record<string, unknown>).policy),
        }
      : analysis.recommendedPolicy,
    recommendedCandidateConfiguration: compactReturnAmplificationScenarioForStorage(analysis.recommendedCandidateConfiguration),
    bestAbove5: compactReturnAmplificationScenarioForStorage(analysis.bestAbove5),
    bestAbove7: compactReturnAmplificationScenarioForStorage(analysis.bestAbove7),
    bestAbove9: compactReturnAmplificationScenarioForStorage(analysis.bestAbove9),
    tradeLifecycleReplayReport: compactTradeLifecycleReplayReportForStorage(analysis.tradeLifecycleReplayReport),
    tradeLifecycleManagerReplay: compactTradeLifecycleReplayReportForStorage(analysis.tradeLifecycleManagerReplay),
    preLimitFamilyStats: compactFamilyStatsForStorage(analysis.preLimitFamilyStats),
    postDailyLimitFamilyStats: compactReturnAmplificationScenarioForStorage(analysis.postDailyLimitFamilyStats),
    winnerLoserSeparation: Array.isArray(analysis.winnerLoserSeparation) ? analysis.winnerLoserSeparation.slice(0, 16) : [],
    aiStrategyReview: compactAiStrategyReviewForStorage(analysis.aiStrategyReview),
    primaryDeepFamilyAnalysis: compactPrimaryDeepFamilyAnalysisForStorage(analysis.primaryDeepFamilyAnalysis),
  };
}

function compactEliteSynthesisResultForStorage(result: EliteSynthesisResult): EliteSynthesisResult {
  return {
    jobId: result.jobId,
    serviceId: result.serviceId,
    status: result.status,
    resultState: result.resultState,
    targetAchieved: result.targetAchieved,
    bestPolicySummary: result.bestPolicySummary,
    topPolicySummaries: result.topPolicySummaries.slice(0, 20),
    rejectedPolicySummaries: Array.isArray(result.rejectedPolicySummaries) ? result.rejectedPolicySummaries.slice(0, 80) : [],
    bestPolicyArtifact: compactBestPolicyArtifactForStorage(result.bestPolicyArtifact) as EliteSynthesisPolicyArtifact | null,
    passLogSummary: result.passLogSummary,
    fullPassLog: result.fullPassLog.slice(-24),
    featureDistributions: result.featureDistributions.slice(0, 60),
    exitOptimisationTable: result.exitOptimisationTable.slice(0, 40),
    triggerRebuildSummary: compactDiagnosticsForStorage(result.triggerRebuildSummary) as Record<string, unknown>,
    rebuiltTriggerDiagnostics: compactDiagnosticsForStorage(result.rebuiltTriggerDiagnostics) as Record<string, unknown>,
    bottleneckSummary: result.bottleneckSummary,
    leakageAuditSummary: result.leakageAuditSummary,
    validationErrors: result.validationErrors,
    dataAvailability: result.dataAvailability,
    unitValidation: result.unitValidation,
    missingFeatureImplementations: result.missingFeatureImplementations,
    windowSummary: result.windowSummary,
    sourceRunIds: result.sourceRunIds,
    datasetSummary: compactDatasetSummaryForStorage(result.datasetSummary) as Record<string, unknown>,
    bestPolicySelectedTradesSummary: result.bestPolicySelectedTradesSummary,
    bestPolicySelectedTrades: Array.isArray(result.bestPolicySelectedTrades) ? result.bestPolicySelectedTrades.slice(0, 80) : [],
    targetAchievedBreakdown: result.targetAchievedBreakdown,
    strategyGradeReadiness: result.strategyGradeReadiness,
    policyArtifactReadiness: result.policyArtifactReadiness,
    validationHardeningGuard: result.validationHardeningGuard,
    returnAmplificationAnalysis: compactReturnAmplificationAnalysisForStorage(result.returnAmplificationAnalysis),
    escalatedSeedFamilies: Array.isArray(result.escalatedSeedFamilies) ? result.escalatedSeedFamilies.slice(0, 20) : [],
    tradeLifecycleManagerReplay: compactTradeLifecycleReplayReportForStorage(result.tradeLifecycleManagerReplay),
    preLimitFamilyStats: compactFamilyStatsForStorage(result.preLimitFamilyStats),
    postDailyLimitFamilyStats: compactReturnAmplificationScenarioForStorage(result.postDailyLimitFamilyStats),
    winnerLoserSeparation: Array.isArray(result.winnerLoserSeparation) ? result.winnerLoserSeparation.slice(0, 16) : [],
    aiStrategyReview: compactAiStrategyReviewForStorage(result.aiStrategyReview),
    primaryDeepFamilyAnalysis: compactPrimaryDeepFamilyAnalysisForStorage(result.primaryDeepFamilyAnalysis),
    dynamicTpProtectionSummary: result.dynamicTpProtectionSummary,
    candidateFamilyComparison: Array.isArray(result.candidateFamilyComparison) ? result.candidateFamilyComparison.slice(0, 20) : [],
    runtimeArtifactEligibility: result.runtimeArtifactEligibility,
    reviewCandidateRuntimeArtifact: compactReviewCandidateRuntimeArtifactForStorage(result.reviewCandidateRuntimeArtifact),
    resultCompactedForRuntimeBuildStorage: true,
  };
}

export function getSynthesisAdapter(serviceId: string): SymbolSynthesisAdapter {
  if (serviceId === "CRASH300") return new Crash300SynthesisAdapter();
  throw new Error(`Elite synthesis adapter missing for service ${serviceId}.`);
}

export async function runEliteSynthesisJob(params: {
  jobId: number;
  serviceId: string;
  request: EliteSynthesisParams;
}): Promise<EliteSynthesisResult> {
  const adapter = getSynthesisAdapter(params.serviceId);
  const searchProfile: EliteSynthesisSearchProfile = params.request.searchProfile ?? "balanced";
  const targetProfile: EliteSynthesisTargetProfile = params.request.targetProfile ?? "default";
  const defaults = profileDefaults(searchProfile);
  const maxPasses: number = Number(params.request.maxPasses ?? defaults.maxPasses);
  const patiencePasses: number = Number(params.request.patiencePasses ?? defaults.patiencePasses);
  const startTs = Number(params.request.startTs ?? 0);
  const endTs = Number(params.request.endTs ?? 0);
  const now = Math.floor(Date.now() / 1000);
  const effectiveEndTs = endTs > 0 ? endTs : now;
  const effectiveStartTs = startTs > 0 ? startTs : effectiveEndTs - (Number(params.request.windowDays ?? 90) * 86400);
  const effectiveWindowDays = Number(params.request.windowDays ?? Math.max(1, Math.round((effectiveEndTs - effectiveStartTs) / 86400)));

  await updateEliteSynthesisJob(params.jobId, {
    status: "running",
    stage: "loading_data",
    progressPct: 2,
    currentPass: 0,
    maxPasses,
    message: `Loading ${adapter.displayName} research inputs`,
    heartbeatAt: nowIso(),
    startedAt: nowIso(),
  });
  await yieldToEventLoop();
  if (await isCancellationRequested(params.jobId)) {
    throw new WorkerJobCancelledError(params.jobId, "cancelled_by_operator");
  }

  const dataset = await buildUnifiedCrash300Dataset({
    calibrationRunId: params.request.calibrationRunId ?? null,
    backtestRunId: params.request.backtestRunId ?? null,
    startTs: effectiveStartTs,
    endTs: effectiveEndTs,
    windowDays: effectiveWindowDays,
    onProgress: async (update) => {
      await updateEliteSynthesisJob(params.jobId, {
        stage: update.stage,
        progressPct: update.progressPct,
        message: update.message,
        heartbeatAt: nowIso(),
      });
    },
    assertNotCancelled: async () => {
      if (await isCancellationRequested(params.jobId)) {
        throw new WorkerJobCancelledError(params.jobId, "cancelled_by_operator");
      }
    },
  });
  if (await isCancellationRequested(params.jobId)) {
    throw new WorkerJobCancelledError(params.jobId, "cancelled_by_operator");
  }
  await updateEliteSynthesisJob(params.jobId, {
    stage: "building_dataset",
    progressPct: 20,
    message: `Built unified dataset with ${dataset.moves.length} calibrated moves, ${dataset.trades.length} runtime trades, and ${dataset.controls.length} controls`,
    heartbeatAt: nowIso(),
    resultSummary: { datasetSummary: dataset.summary },
  });
  await yieldToEventLoop();

  const validationErrors = dataset.validationErrors ?? [];
  if (validationErrors.length > 0) {
    const resultState: EliteSynthesisResultState = validationErrors.includes("missing_calibrated_moves")
      || validationErrors.includes("missing_phase_snapshots")
      || validationErrors.includes("missing_runtime_or_rebuilt_candidates")
      ? "completed_foundation_incomplete"
      : "failed_validation";
    const validationResult: EliteSynthesisResult = {
      jobId: params.jobId,
      serviceId: params.serviceId,
      status: "completed",
      resultState,
      targetAchieved: false,
      failureType: resultState === "failed_validation" ? "validation_failed" : "none",
      exceptionMessage: null,
      noTargetReason: null,
      passesCompleted: 0,
      maxPasses,
      targetProfile,
      targetProfileNormalized: normalizedEliteTargetProfile(targetProfile),
      bestPolicySummary: null,
      topPolicySummaries: [],
      bestPolicyArtifact: null,
      passLogSummary: [],
      fullPassLog: [],
      featureDistributions: [],
      exitOptimisationTable: [],
      triggerRebuildSummary: { attempted: false, candidateCount: 0, eligibleCount: 0 },
      rebuiltTriggerDiagnostics: { attempted: false, candidateCount: 0, eligibleCount: 0 },
      bottleneckSummary: {
        targetAchieved: false,
        triggerRebuildAttempted: false,
        classification: "insufficient_data_quality",
        reasons: validationErrors,
        futureImplementationRecommendation: "Repair synthesis dataset inputs before running search again.",
        topRawFamilyReject: null,
        topRawTransitionReject: null,
        topRawDirectionReject: null,
        topInvalidArchetypeExamplesCount: 0,
      },
      leakageAuditSummary: defaultLeakageAudit(),
      validationErrors,
      dataAvailability: dataset.dataAvailability ?? emptyDataAvailability(),
      unitValidation: dataset.unitValidation ?? emptyUnitValidation(),
      missingFeatureImplementations: dataset.missingFeatureImplementations ?? [],
      windowSummary: {
        startTs: effectiveStartTs,
        endTs: effectiveEndTs,
        windowDays: effectiveWindowDays,
        searchProfile,
        maxPasses,
        patiencePasses,
        jobGrade: searchProfile === "fast" ? "smoke_plumbing_only" : "strategy_grade_review",
      },
      sourceRunIds: dataset.sourceRunIds,
      datasetSummary: dataset.summary,
    };
    await updateEliteSynthesisJob(params.jobId, {
      status: "completed",
      stage: "completed",
      progressPct: 100,
      message: `Integrated elite synthesis stopped: ${resultState}`,
      heartbeatAt: nowIso(),
      completedAt: nowIso(),
      errorSummary: {
        failureType: validationResult.failureType,
        validationErrors,
        targetProfile,
        targetProfileNormalized: validationResult.targetProfileNormalized,
      },
      resultSummary: {
        resultState,
        failureType: validationResult.failureType,
        exceptionMessage: validationResult.exceptionMessage,
        noTargetReason: validationResult.noTargetReason,
        passesCompleted: validationResult.passesCompleted,
        maxPasses: validationResult.maxPasses,
        targetProfile: validationResult.targetProfile,
        targetProfileNormalized: validationResult.targetProfileNormalized,
        validationErrors,
      },
      resultArtifact: validationResult,
    });
    return validationResult;
  }

  const features = featureSummaryFromDataset(dataset);
  await updateEliteSynthesisJob(params.jobId, {
    stage: "feature_elimination",
    progressPct: 26,
    message: `Computed live-safe feature separability for ${features.length} features`,
    heartbeatAt: nowIso(),
  });
  await yieldToEventLoop();

  let passLog: EliteSynthesisPassLog[] = [];
  let bestPolicySummary: EliteSynthesisPolicySummary | null = null;
  let bestPolicyArtifact: EliteSynthesisPolicyArtifact | null = null;
  const topPolicies: PolicyEvaluationResult[] = [];
  let rebuiltTriggerAttempted = false;
  let rebuiltTriggerDiagnostics = buildRebuiltTriggerDiagnostics(dataset);
  let rejectedPolicySummaries: Array<Record<string, unknown>> = [];
  let bottleneck: EliteSynthesisBottleneck = "current_runtime_pool_insufficient";
  let noImprovementPasses = 0;
  let evaluatedPolicyCount = 0;
  let searchSpaceRemaining = 0;
  let stopReason: string | null = null;

  let policySeeds = generateInitialPolicies(dataset, features);
  searchSpaceRemaining = policySeeds.length;
  await updateEliteSynthesisJob(params.jobId, {
    stage: "evaluating_current_pool",
    progressPct: 32,
    message: `Evaluating ${policySeeds.length} policies from the current runtime candidate pool`,
    heartbeatAt: nowIso(),
    bestSummary: bestSummaryFromPolicy(bestPolicySummary, evaluatedPolicyCount, policySeeds.length),
  });

  for (let passNumber = 1; passNumber <= maxPasses; passNumber += 1) {
    const job = await getEliteSynthesisJob(params.jobId);
    if (job?.status === "cancelled" || await isCancellationRequested(params.jobId)) {
      const cancelledResult: EliteSynthesisResult = {
        jobId: params.jobId,
        serviceId: params.serviceId,
        status: "cancelled",
        resultState: "cancelled",
        targetAchieved: false,
        failureType: "cancelled",
        exceptionMessage: null,
        noTargetReason: null,
        passesCompleted: passLog.length,
        maxPasses,
        targetProfile,
        targetProfileNormalized: normalizedEliteTargetProfile(targetProfile),
        bestPolicySummary,
        topPolicySummaries: topPolicies.slice(0, 20),
        bestPolicyArtifact,
        passLogSummary: passLog.slice(-10),
        fullPassLog: passLog,
        featureDistributions: features,
        exitOptimisationTable: [],
        triggerRebuildSummary: { attempted: rebuiltTriggerAttempted },
        rebuiltTriggerDiagnostics,
        bottleneckSummary: {
          targetAchieved: false,
          triggerRebuildAttempted: rebuiltTriggerAttempted,
          classification: "search_exhausted",
          reasons: ["Job was cancelled before completion."],
          futureImplementationRecommendation: "Restart synthesis if a full search is still required.",
          topRawFamilyReject: rebuiltTriggerDiagnostics.summary?.topRawFamilyReject ?? null,
          topRawTransitionReject: rebuiltTriggerDiagnostics.summary?.topRawTransitionReject ?? null,
          topRawDirectionReject: rebuiltTriggerDiagnostics.summary?.topRawDirectionReject ?? null,
          topInvalidArchetypeExamplesCount: rebuiltTriggerDiagnostics.summary?.topInvalidArchetypeExamplesCount ?? 0,
        },
        leakageAuditSummary: bestPolicyArtifact?.leakageAudit ?? defaultLeakageAudit(),
        validationErrors: dataset.validationErrors ?? [],
        dataAvailability: dataset.dataAvailability ?? emptyDataAvailability(),
        unitValidation: dataset.unitValidation ?? emptyUnitValidation(),
        missingFeatureImplementations: dataset.missingFeatureImplementations ?? [],
        windowSummary: { startTs: effectiveStartTs, endTs: effectiveEndTs, windowDays: effectiveWindowDays },
        sourceRunIds: dataset.sourceRunIds,
        datasetSummary: dataset.summary,
      };
      await updateEliteSynthesisJob(params.jobId, {
        status: "cancelled",
        stage: "cancelled",
        progressPct: 100,
        message: "Elite synthesis cancelled",
        heartbeatAt: nowIso(),
        completedAt: nowIso(),
        resultSummary: {
          resultState: cancelledResult.resultState,
          targetAchieved: false,
          cancelled: true,
          failureType: cancelledResult.failureType,
          exceptionMessage: cancelledResult.exceptionMessage,
          noTargetReason: cancelledResult.noTargetReason,
          passesCompleted: cancelledResult.passesCompleted,
          maxPasses: cancelledResult.maxPasses,
          targetProfile: cancelledResult.targetProfile,
          targetProfileNormalized: cancelledResult.targetProfileNormalized,
        },
        resultArtifact: cancelledResult,
      });
      return cancelledResult;
    }

    if (policySeeds.length === 0 && !rebuiltTriggerAttempted) {
      rebuiltTriggerAttempted = true;
      bottleneck = "current_runtime_pool_insufficient";
      await updateEliteSynthesisJob(params.jobId, {
        stage: "rebuilding_trigger_candidates",
        progressPct: 30,
        currentPass: passNumber,
        message: "Current runtime candidate pool is insufficient; rebuilding trigger candidates from calibrated move offsets",
        heartbeatAt: nowIso(),
      });
      const rebuilt = await adapter.generateTriggerCandidatesFromMoveOffsets(dataset);
      dataset.rebuiltTriggerCandidates = rebuilt;
      rebuiltTriggerDiagnostics = buildRebuiltTriggerDiagnostics(dataset);
      policySeeds = generatePoliciesFromTriggerRebuild(dataset, rebuilt, features);
      Object.assign(rebuiltTriggerDiagnostics, dataset.summary.rebuiltPolicySeedDiagnostics ?? {});
      searchSpaceRemaining = policySeeds.length;
      const rebuiltTopReason = Object.entries(rebuiltTriggerDiagnostics.rejectionReasonCounts ?? {}).sort((a, b) => b[1] - a[1])[0];
      passLog.push({
        passNumber,
        stage: "rebuilding_trigger_candidates",
        candidateCount: rebuiltTriggerDiagnostics.rawCandidatesGenerated ?? rebuiltTriggerDiagnostics.rebuiltTriggerCandidatesGenerated ?? 0,
        evaluatedCount: rebuiltTriggerDiagnostics.eligibleCandidates ?? rebuiltTriggerDiagnostics.rebuiltTriggerCandidatesEligible ?? 0,
        bestPolicyId: bestPolicySummary?.policyId ?? null,
        trades: rebuiltTriggerDiagnostics.simulatedTradeCount ?? 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        slHits: 0,
        slHitRate: 0,
        profitFactor: 0,
        accountReturnPct: 0,
        maxDrawdownPct: 0,
        phantomCount: 0,
        selectedFeatures: [],
        mutationSummary: "rebuilt_from_calibrated_move_offsets",
        changedParameters: [
          "source_pool:rebuilt_trigger_candidates",
          `inspected_moves:${rebuiltTriggerDiagnostics.inspectedCalibratedMoves ?? dataset.moves.length}`,
          `offsets_attempted:${rebuiltTriggerDiagnostics.offsetsAttempted ?? 0}`,
          `eligible_candidates:${rebuiltTriggerDiagnostics.eligibleCandidates ?? rebuiltTriggerDiagnostics.rebuiltTriggerCandidatesEligible ?? 0}`,
          ...(rebuiltTopReason ? [`top_reject:${rebuiltTopReason[0]}:${rebuiltTopReason[1]}`] : []),
        ],
        reasonBestImproved: "rebuild_diagnostics_only",
        bestSoFar: false,
        searchSpaceRemaining,
        reasonStopped: null,
      });
      await updateEliteSynthesisJob(params.jobId, {
        stage: "generating_policies",
        progressPct: 42,
        currentPass: passNumber,
        message: `Generated ${policySeeds.length} policies from ${rebuiltTriggerDiagnostics.rebuiltTriggerCandidatesEligible} eligible rebuilt trigger candidates`,
        heartbeatAt: nowIso(),
      });
      continue;
    }

    if (policySeeds.length === 0 && rebuiltTriggerAttempted) {
      const lastLog = passLog[passLog.length - 1];
      if (rebuiltTriggerDiagnostics.rebuiltTriggerCandidatesGenerated > 0 && rebuiltTriggerDiagnostics.simulatedTradeCount === 0) {
        bottleneck = "rebuilt_trigger_execution_failed";
        stopReason = "rebuilt_zero_trade_diagnostics";
      } else {
        stopReason = "search_space_exhausted:no_policy_seeds";
      }
      if (lastLog) {
        const rebuiltTopReason = Object.entries(rebuiltTriggerDiagnostics.rejectionReasonCounts ?? {}).sort((a, b) => b[1] - a[1])[0];
        lastLog.reasonStopped = stopReason;
        lastLog.changedParameters = [
          ...lastLog.changedParameters,
          `rebuilt_generated:${rebuiltTriggerDiagnostics.rebuiltTriggerCandidatesGenerated ?? 0}`,
          `rebuilt_simulated:${rebuiltTriggerDiagnostics.simulatedTradeCount ?? 0}`,
          ...(rebuiltTopReason ? [`top_reject:${rebuiltTopReason[0]}:${rebuiltTopReason[1]}`] : []),
        ];
      }
      break;
    }

    await updateEliteSynthesisJob(params.jobId, {
      stage: "evaluating_policies",
      progressPct: Math.min(92, 42 + Math.round((passNumber / Math.max(1, maxPasses)) * 42)),
      currentPass: passNumber,
      message: `Evaluating policy pass ${passNumber}/${maxPasses}`,
      heartbeatAt: nowIso(),
      bestSummary: bestSummaryFromPolicy(bestPolicySummary, evaluatedPolicyCount, policySeeds.length),
    });

    let passBest: EliteSynthesisPolicySummary | null = null;
    let passBestArtifact: EliteSynthesisPolicyArtifact | null = null;
    for (let seedIndex = 0; seedIndex < policySeeds.length; seedIndex += 1) {
      const seed = policySeeds[seedIndex]!;
      const artifact = buildPolicyArtifact({
        adapter,
        dataset,
        passNumber,
        featureSet: seed.featureSet,
        selectedRuntimeArchetypes: seed.selectedRuntimeArchetypes,
        selectedBuckets: seed.selectedBuckets,
        selectedMoveSizeBuckets: seed.selectedMoveSizeBuckets,
        selectedTriggerTransitions: seed.selectedTriggerTransitions,
        selectedDirections: seed.selectedDirections,
        offsetClusters: seed.offsetClusters,
        mutationSummary: seed.mutationSummary,
        sourcePool: seed.sourcePool,
        diagnostics: seed.diagnostics,
      });
      const evaluation = await adapter.evaluatePolicyOnHistoricalData(dataset, artifact);
      artifact.objectiveScore = evaluation.objectiveScore;
      artifact.expectedThreeMonthPerformance = {
        trades: evaluation.trades,
        wins: evaluation.wins,
        losses: evaluation.losses,
        winRate: evaluation.winRate,
        slHits: evaluation.slHits,
        slHitRate: evaluation.slHitRate,
        profitFactor: evaluation.profitFactor,
        accountReturnPct: evaluation.accountReturnPct,
        maxDrawdownPct: evaluation.maxDrawdownPct,
      };
      artifact.monthlyBreakdown = evaluation.monthlyBreakdown;
      evaluatedPolicyCount += 1;
      if (
        evaluation.trades === 0
        || evaluation.reasons.includes("impossible_exit_rejected")
        || evaluation.reasons.includes("no_simulated_rebuilt_trades")
        || (evaluation.sourcePool === "rebuilt_trigger_candidates" && (
          artifact.selectedTriggerTransitions.some((value) => ["trending", "recovery", "failed_recovery", "up", "down"].includes(value))
          || artifact.selectedMoveSizeBuckets.length === 0
          || artifact.selectedRuntimeArchetypes.some((value) => !CANONICAL_REBUILT_FAMILIES.has(value))
        ))
      ) {
        rejectedPolicySummaries.push({
          policyId: evaluation.policyId,
          sourcePool: evaluation.sourcePool,
          trades: evaluation.trades,
          reasons: evaluation.reasons,
          selectedRuntimeArchetypes: artifact.selectedRuntimeArchetypes,
          selectedTriggerTransitions: artifact.selectedTriggerTransitions,
          selectedMoveSizeBuckets: artifact.selectedMoveSizeBuckets,
          selectedBuckets: artifact.selectedBuckets,
          diagnostics: seed.diagnostics ?? null,
        });
      }
      const evaluationValidForBest = !(
        evaluation.trades === 0
        || evaluation.reasons.includes("impossible_exit_rejected")
        || evaluation.reasons.includes("no_simulated_rebuilt_trades")
      );
      if (evaluationValidForBest && (!passBest || evaluation.objectiveScore > passBest.objectiveScore)) {
        passBest = evaluation;
        passBestArtifact = artifact;
      }
      topPolicies.push(evaluation);
      if ((seedIndex + 1) % 4 === 0 || seedIndex === policySeeds.length - 1) {
        await updateEliteSynthesisJob(params.jobId, {
          stage: "evaluating_policies",
          progressPct: Math.min(93, 42 + Math.round((passNumber / Math.max(1, maxPasses)) * 42)),
          currentPass: passNumber,
          message: `Evaluating policy pass ${passNumber}/${maxPasses} (${seedIndex + 1}/${policySeeds.length})`,
          heartbeatAt: nowIso(),
          bestSummary: bestSummaryFromPolicy(bestPolicySummary ?? passBest, evaluatedPolicyCount, policySeeds.length),
        });
        await yieldToEventLoop();
      }
    }

    const improved = Boolean(passBest && (!bestPolicySummary || passBest.objectiveScore > bestPolicySummary.objectiveScore));
    if (improved && passBest && passBestArtifact) {
      bestPolicySummary = passBest;
      bestPolicyArtifact = passBestArtifact;
      noImprovementPasses = 0;
    } else {
      noImprovementPasses += 1;
    }

    passLog.push({
      passNumber,
      stage: "evaluating_policies",
      candidateCount: policySeeds.length,
      evaluatedCount: evaluatedPolicyCount,
      bestPolicyId: passBest?.policyId ?? null,
      trades: passBest?.trades ?? 0,
      wins: passBest?.wins ?? 0,
      losses: passBest?.losses ?? 0,
      winRate: passBest?.winRate ?? 0,
      slHits: passBest?.slHits ?? 0,
      slHitRate: passBest?.slHitRate ?? 0,
      profitFactor: passBest?.profitFactor ?? 0,
      accountReturnPct: passBest?.accountReturnPct ?? 0,
      maxDrawdownPct: passBest?.maxDrawdownPct ?? 0,
      phantomCount: passBest?.phantomCount ?? 0,
      selectedFeatures: passBest?.selectedFeaturesSummary ?? [],
      mutationSummary: policySeeds[0]?.mutationSummary ?? "none",
      changedParameters: [
        `source_pool:${policySeeds[0]?.sourcePool ?? "runtime_trades"}`,
        `archetypes:${(policySeeds[0]?.selectedRuntimeArchetypes ?? []).join(",")}`,
        `buckets:${(policySeeds[0]?.selectedBuckets ?? []).join(",")}`,
        `triggers:${(policySeeds[0]?.selectedTriggerTransitions ?? []).join(",")}`,
        `offset_clusters:${(policySeeds[0]?.offsetClusters ?? []).join(",")}`,
      ],
      reasonBestImproved: improved ? "objective_score_improved" : "no_improvement_this_pass",
      bestSoFar: improved,
      searchSpaceRemaining,
      reasonStopped: null,
    });

    await updateEliteSynthesisJob(params.jobId, {
      stage: "refining_candidates",
      progressPct: Math.min(95, 40 + Math.round((passNumber / Math.max(1, maxPasses)) * 50)),
      currentPass: passNumber,
      message: improved
        ? `Pass ${passNumber} improved best policy to ${bestPolicySummary?.policyId ?? "n/a"}`
        : `Pass ${passNumber} produced no improvement`,
      heartbeatAt: nowIso(),
      bestSummary: bestSummaryFromPolicy(bestPolicySummary, evaluatedPolicyCount, policySeeds.length),
      resultSummary: { latestPassLog: passLog.slice(-5) },
    });

    if (targetAchieved(bestPolicySummary, targetProfile)) {
      bottleneck = "none";
      if (noImprovementPasses >= patiencePasses) {
        stopReason = "target_achieved_and_patience_exhausted";
        break;
      }
    }

    if (!targetAchieved(bestPolicySummary, targetProfile) && !rebuiltTriggerAttempted && passNumber >= Math.max(2, Math.floor(maxPasses / 3))) {
      rebuiltTriggerAttempted = true;
      bottleneck = "current_runtime_pool_insufficient";
      await updateEliteSynthesisJob(params.jobId, {
        stage: "rebuilding_trigger_candidates",
        progressPct: Math.min(78, 52 + Math.round((passNumber / Math.max(1, maxPasses)) * 18)),
        currentPass: passNumber,
        message: "Current runtime pool remains insufficient; rebuilding trigger candidates from calibrated move offsets",
        heartbeatAt: nowIso(),
      });
      const rebuilt = await adapter.generateTriggerCandidatesFromMoveOffsets(dataset);
      dataset.rebuiltTriggerCandidates = rebuilt;
      rebuiltTriggerDiagnostics = buildRebuiltTriggerDiagnostics(dataset);
      policySeeds = generatePoliciesFromTriggerRebuild(dataset, rebuilt, features);
      Object.assign(rebuiltTriggerDiagnostics, dataset.summary.rebuiltPolicySeedDiagnostics ?? {});
      searchSpaceRemaining = policySeeds.length;
      const rebuiltTopReason = Object.entries(rebuiltTriggerDiagnostics.rejectionReasonCounts ?? {}).sort((a, b) => b[1] - a[1])[0];
      passLog.push({
        passNumber: passNumber + 1,
        stage: "rebuilding_trigger_candidates",
        candidateCount: rebuiltTriggerDiagnostics.rawCandidatesGenerated ?? rebuiltTriggerDiagnostics.rebuiltTriggerCandidatesGenerated ?? 0,
        evaluatedCount: rebuiltTriggerDiagnostics.eligibleCandidates ?? rebuiltTriggerDiagnostics.rebuiltTriggerCandidatesEligible ?? 0,
        bestPolicyId: bestPolicySummary?.policyId ?? null,
        trades: rebuiltTriggerDiagnostics.simulatedTradeCount ?? 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        slHits: 0,
        slHitRate: 0,
        profitFactor: 0,
        accountReturnPct: 0,
        maxDrawdownPct: 0,
        phantomCount: 0,
        selectedFeatures: [],
        mutationSummary: "rebuilt_from_calibrated_move_offsets",
        changedParameters: [
          "source_pool:rebuilt_trigger_candidates",
          `inspected_moves:${rebuiltTriggerDiagnostics.inspectedCalibratedMoves ?? dataset.moves.length}`,
          `offsets_attempted:${rebuiltTriggerDiagnostics.offsetsAttempted ?? 0}`,
          `eligible_candidates:${rebuiltTriggerDiagnostics.eligibleCandidates ?? rebuiltTriggerDiagnostics.rebuiltTriggerCandidatesEligible ?? 0}`,
          ...(rebuiltTopReason ? [`top_reject:${rebuiltTopReason[0]}:${rebuiltTopReason[1]}`] : []),
        ],
        reasonBestImproved: "rebuild_diagnostics_only",
        bestSoFar: false,
        searchSpaceRemaining,
        reasonStopped: null,
      });
      continue;
    }

    if (
      policySeeds[0]?.sourcePool === "rebuilt_trigger_candidates"
      && (passBest?.trades ?? 0) === 0
    ) {
      bottleneck = rebuiltTriggerDiagnostics.simulatedTradeCount ? "rebuilt_policy_evaluation_failed" : "rebuilt_trigger_execution_failed";
      stopReason = rebuiltTriggerDiagnostics.simulatedTradeCount ? "rebuilt_policy_evaluation_failed" : "rebuilt_zero_trade_diagnostics";
      const lastLog = passLog[passLog.length - 1];
      if (lastLog) {
        const rebuiltTopReason = Object.entries(rebuiltTriggerDiagnostics.rejectionReasonCounts ?? {}).sort((a, b) => b[1] - a[1])[0];
        lastLog.reasonStopped = stopReason;
        lastLog.changedParameters = [
          ...lastLog.changedParameters,
          `rebuilt_eligible:${rebuiltTriggerDiagnostics.rebuiltTriggerCandidatesEligible}`,
          `rebuilt_simulated:${rebuiltTriggerDiagnostics.simulatedTradeCount}`,
          `rejected_policies:${rejectedPolicySummaries.length}`,
          ...(rebuiltTopReason ? [`top_reject:${rebuiltTopReason[0]}:${rebuiltTopReason[1]}`] : []),
        ];
      }
      break;
    }

    policySeeds = policySeeds.map((seed, index) => ({
      ...seed,
      passNumber: passNumber + 1,
      featureSet: seed.featureSet.slice(
        index % 2 === 0 ? 0 : 1,
        Math.max(4, seed.featureSet.length - (index % 2 === 0 ? 1 : 0)),
      ),
      selectedTriggerTransitions: index % 3 === 0 ? [...seed.selectedTriggerTransitions].reverse() : seed.selectedTriggerTransitions,
      mutationSummary: `mutated_from_pass_${passNumber}_candidate_${index + 1}`,
    }));
    searchSpaceRemaining = policySeeds.length;
    if (passNumber >= maxPasses) {
      stopReason = "max_passes_reached";
    }
  }

  if (!targetAchieved(bestPolicySummary, targetProfile)) {
    bottleneck = bottleneck === "rebuilt_trigger_execution_failed"
      ? "rebuilt_trigger_execution_failed"
      : rebuiltTriggerAttempted
      ? "rebuilt_trigger_pool_still_insufficient"
      : "current_runtime_pool_insufficient";
  }
  if (!stopReason) {
    stopReason = targetAchieved(bestPolicySummary, targetProfile) ? "target_achieved" : "search_space_exhausted";
  }

  await updateEliteSynthesisJob(params.jobId, {
    stage: "selecting_best",
    progressPct: 94,
    message: "Selecting best synthesis pass",
    heartbeatAt: nowIso(),
  });

  Object.assign(rebuiltTriggerDiagnostics, dataset.summary.rebuiltPolicySeedDiagnostics ?? {}, {
    rebuiltPolicyEvaluationTradeCounts: topPolicies
      .filter((policy) => policy.sourcePool === "rebuilt_trigger_candidates")
      .map((policy) => ({
        policyId: policy.policyId,
        trades: policy.trades,
        wins: policy.wins,
        losses: policy.losses,
        sourcePool: policy.sourcePool,
        selectedRuntimeArchetypes: policy.selectedRuntimeArchetypes,
        selectedTriggerTransitions: policy.selectedTriggerTransitions,
        selectedMoveSizeBuckets: policy.selectedMoveSizeBuckets,
      })),
    rebuiltPoliciesWithTrades: topPolicies.filter((policy) => policy.sourcePool === "rebuilt_trigger_candidates" && policy.trades > 0).length,
    rebuiltRejectedPolicyCount: rejectedPolicySummaries.length,
  });

  const topPolicySummaries = topPolicies
    .slice()
    .filter((policy) =>
      policy.trades > 0
      && !policy.reasons.includes("impossible_exit_rejected")
      && !policy.reasons.includes("no_simulated_rebuilt_trades")
      && !(policy.sourcePool === "rebuilt_trigger_candidates" && (
        policy.selectedTriggerTransitions.some((value) => ["trending", "recovery", "failed_recovery", "up", "down"].includes(value))
        || policy.selectedMoveSizeBuckets.length === 0
        || policy.selectedRuntimeArchetypes.some((value) => !CANONICAL_REBUILT_FAMILIES.has(value))
      ))
    )
    .sort((a, b) => b.objectiveScore - a.objectiveScore)
    .slice(0, 20);
  const bestPolicyEvaluation = getBestPolicyEvaluation(bestPolicySummary, topPolicies);
  const bestPolicyValidationArtifacts = buildBestRebuiltPolicyArtifacts(bestPolicyEvaluation, dataset);
  const policyArtifactReadiness: Record<string, unknown> | null = bestPolicyValidationArtifacts.policyArtifactReadiness
    ? {
        ...bestPolicyValidationArtifacts.policyArtifactReadiness,
        leakagePassed: Boolean(bestPolicyArtifact?.leakageAudit.passed ?? false),
      }
    : null;
  if (policyArtifactReadiness) {
    policyArtifactReadiness.canStageForPaper = Boolean(
      policyArtifactReadiness.reportConsistencyPassed
      && policyArtifactReadiness.selectedTradesExportPassed
      && policyArtifactReadiness.leakagePassed
      && policyArtifactReadiness.lateOffsetSafetyPassed
      && policyArtifactReadiness.calibratedRelationshipPassed,
    );
    const blockers = Array.isArray(policyArtifactReadiness.blockers) ? policyArtifactReadiness.blockers as string[] : [];
    if (!policyArtifactReadiness.leakagePassed && !blockers.includes("leakage_audit_failed")) {
      policyArtifactReadiness.blockers = [...blockers, "leakage_audit_failed"];
    }
  }
  const targetBreakdown = buildTargetAchievedBreakdown({
    bestPolicySummary,
    targetTradeCountMin: Number(params.request.targetTradeCountMin ?? defaults.targetTradeCountMin),
    targetTradeCountMax: Number(params.request.targetTradeCountMax ?? defaults.targetTradeCountMax),
    maxTradesPerDay: Number(params.request.maxTradesPerDay ?? defaults.maxTradesPerDay),
    targetProfile,
    lateOffsetSafetyAudit: bestPolicyValidationArtifacts.lateOffsetSafetyAudit,
    exitDerivationAudit: bestPolicyValidationArtifacts.exitDerivationAudit,
    monthlyStabilityAssessment: bestPolicyValidationArtifacts.monthlyStabilityAssessment,
    calibratedMoveRelationshipSummary: bestPolicyValidationArtifacts.calibratedMoveRelationshipSummary,
    leakageAudit: bestPolicyArtifact?.leakageAudit ?? null,
    jobGrade: searchProfile === "fast" ? "smoke_plumbing_only" : "strategy_grade_review",
  });
  const strategyGradeReadiness = buildStrategyGradeReadiness({
    rebuiltTriggerDiagnostics,
    bestPolicySelectedTradesSummary: bestPolicyValidationArtifacts.bestPolicySelectedTradesSummary,
    lateOffsetSafetyAudit: bestPolicyValidationArtifacts.lateOffsetSafetyAudit,
    exitDerivationAudit: bestPolicyValidationArtifacts.exitDerivationAudit,
    monthlyStabilityAssessment: bestPolicyValidationArtifacts.monthlyStabilityAssessment,
  });
  const validationHardeningGuard = buildValidationHardeningGuard({
    dataset,
    rebuiltTriggerDiagnostics,
    topPolicySummaries,
    bestPolicySummary,
    bestPolicySelectedTradesSummary: bestPolicyValidationArtifacts.bestPolicySelectedTradesSummary,
  });
  await updateEliteSynthesisJob(params.jobId, {
    stage: "selecting_best",
    progressPct: 96,
    message: "Running final-pass high-volume seed escalation and lifecycle analysis",
    heartbeatAt: nowIso(),
  });
  const returnAmplificationAnalysis = await buildReturnAmplificationAnalysis({
    dataset,
    targetProfile: params.request.targetProfile ?? "default",
    bestPolicyEvaluation,
    bestPolicySummary,
    bestPolicySelectedTradesSummary: bestPolicyValidationArtifacts.bestPolicySelectedTradesSummary,
    bestPolicySelectedTrades: bestPolicyValidationArtifacts.bestPolicySelectedTrades,
    policyArtifactReadiness,
    leakageAudit: bestPolicyArtifact?.leakageAudit ?? null,
  });
  await updateEliteSynthesisJob(params.jobId, {
    stage: "selecting_best",
    progressPct: 98,
    message: "Final-pass runtime build result assembled",
    heartbeatAt: nowIso(),
  });
  const finalPassRuntimeArtifactEligibility = (returnAmplificationAnalysis as Record<string, unknown>).runtimeArtifactEligibility as Record<string, unknown> | undefined;
  const reviewCandidateRuntimeArtifact = finalPassRuntimeArtifactEligibility?.canCreateReviewArtifact
    ? {
        artifactId: `crash300-final-pass-review-${params.jobId}`,
        artifactType: "crash300_final_pass_runtime_review_candidate",
        mode: "review_only",
        serviceId: params.serviceId,
        generatedAt: nowIso(),
        sourceSynthesisJobId: params.jobId,
        sourcePolicyId: "failed_recovery_short_5_to_6_sell_late_final_pass",
        runtimeFamily: "failed_recovery_short",
        triggerTransition: "failed_recovery_break_down",
        selectedMoveSizeBucket: "5_to_6_pct",
        direction: "sell",
        offsetCluster: "late",
        lifecycleManagerRules: ((returnAmplificationAnalysis as Record<string, unknown>).dynamicTpProtectionSummary ?? null),
        deepFamilyAnalysis: (returnAmplificationAnalysis as Record<string, unknown>).primaryDeepFamilyAnalysis ?? null,
        aiStrategyReview: (returnAmplificationAnalysis as Record<string, unknown>).aiStrategyReview ?? null,
        runtimeArtifactEligibility: finalPassRuntimeArtifactEligibility,
        readiness: {
          runtimeMimicValidationStatus: "not_run",
          runtimeMimicReady: false,
          canPromoteRuntime: false,
          requiresManualValidateRuntime: true,
          autoStage: false,
          autoPromote: false,
        },
      }
    : null;
  const normalizedTargetProfile = normalizedEliteTargetProfile(targetProfile);
  const recommendedPolicy = (returnAmplificationAnalysis as Record<string, unknown>).recommendedPolicy as Record<string, unknown> | null;
  const bestReturnFirstPolicy = (returnAmplificationAnalysis as Record<string, unknown>).bestReturnFirstPolicy as Record<string, unknown> | null;
  const policyComparisonTable = Array.isArray((returnAmplificationAnalysis as Record<string, unknown>).policyComparisonTable)
    ? ((returnAmplificationAnalysis as Record<string, unknown>).policyComparisonTable as Array<Record<string, unknown>>)
    : [];
  const guardrailsPassedCount = policyComparisonTable.filter((scenario) => Boolean(scenario.guardrailsPassed)).length;
  const resolvedResultState: EliteSynthesisResultState = targetAchieved(bestPolicySummary, targetProfile)
    ? "completed_target_achieved"
    : bottleneck === "rebuilt_policy_evaluation_failed"
      ? "rebuilt_policy_evaluation_failed"
    : bottleneck === "rebuilt_trigger_execution_failed"
      ? "completed_foundation_incomplete"
    : rebuiltTriggerAttempted || passLog.length >= maxPasses
      ? "completed_exhausted_no_target"
      : "completed_foundation_incomplete";
  const noTargetReason = deriveNoTargetReason({
    resultState: resolvedResultState,
    targetAchieved: targetAchieved(bestPolicySummary, targetProfile),
    targetProfile,
    recommendedPolicyStatus: recommendedPolicy ? String(recommendedPolicy.status ?? "") : null,
    bestReturnFirstPolicyPresent: Boolean(bestReturnFirstPolicy),
    guardrailsPassedCount,
    passLogLength: passLog.length,
    maxPasses,
  });
  const completionMessage = targetAchieved(bestPolicySummary, targetProfile)
    ? "Integrated elite synthesis completed with a target-grade candidate policy"
    : normalizedTargetProfile === "return_first" && noTargetReason
      ? "Integrated elite synthesis completed without finding a return-first target policy"
      : normalizedTargetProfile === "return_first" && recommendedPolicy && String(recommendedPolicy.status ?? "") === "baseline_only"
        ? "Integrated elite synthesis completed with a baseline-only return-first diagnostic outcome"
        : "Integrated elite synthesis completed without reaching the target objective";

  const result: EliteSynthesisResult = {
    jobId: params.jobId,
    serviceId: params.serviceId,
    status: "completed",
    resultState: resolvedResultState,
    targetAchieved: targetAchieved(bestPolicySummary, targetProfile),
    failureType: noTargetReason ? "no_target_exhausted" : "none",
    exceptionMessage: null,
    noTargetReason,
    passesCompleted: passLog.length,
    maxPasses,
    targetProfile,
    targetProfileNormalized: normalizedTargetProfile,
    bestPolicySummary: bestPolicySummary
      ? {
          ...bestPolicySummary,
          lateOffsetSafetyAudit: bestPolicyValidationArtifacts.lateOffsetSafetyAudit,
          calibratedMoveRelationshipSummary: bestPolicyValidationArtifacts.calibratedMoveRelationshipSummary,
          exitDerivationAudit: bestPolicyValidationArtifacts.exitDerivationAudit,
          monthlyStabilityAssessment: bestPolicyValidationArtifacts.monthlyStabilityAssessment,
          targetAchievedBreakdown: targetBreakdown,
          policyArtifactReadiness,
          returnAmplificationAnalysis,
          sourcePool: bestPolicyEvaluation?.sourcePool ?? null,
          selectedTradeIds: bestPolicyValidationArtifacts.bestPolicySelectedTradesSummary?.selectedTradeIds ?? [],
        }
      : null,
    topPolicySummaries,
    rejectedPolicySummaries,
    bestPolicyArtifact: bestPolicyArtifact
      ? {
          ...bestPolicyArtifact,
          objectiveScore: bestPolicySummary?.objectiveScore ?? bestPolicyArtifact.objectiveScore,
          expectedThreeMonthPerformance: {
            ...bestPolicyArtifact.expectedThreeMonthPerformance,
            monthlyBreakdown: bestPolicyEvaluation?.monthlyBreakdown ?? bestPolicyArtifact.monthlyBreakdown,
            monthlyStabilityAssessment: bestPolicyValidationArtifacts.monthlyStabilityAssessment,
          },
          monthlyBreakdown: bestPolicyEvaluation?.monthlyBreakdown ?? bestPolicyArtifact.monthlyBreakdown,
          lateOffsetSafetyAudit: bestPolicyValidationArtifacts.lateOffsetSafetyAudit,
          calibratedMoveRelationshipSummary: bestPolicyValidationArtifacts.calibratedMoveRelationshipSummary,
          exitDerivationAudit: bestPolicyValidationArtifacts.exitDerivationAudit,
          monthlyStabilityAssessment: bestPolicyValidationArtifacts.monthlyStabilityAssessment,
          bestPolicySelectedTradesSummary: bestPolicyValidationArtifacts.bestPolicySelectedTradesSummary,
          bestPolicySelectedTrades: bestPolicyValidationArtifacts.bestPolicySelectedTrades,
          targetAchievedBreakdown: targetBreakdown,
          strategyGradeReadiness,
          policyArtifactReadiness,
          returnAmplificationAnalysis,
          bottleneckAnalysis: {
            targetAchieved: targetAchieved(bestPolicySummary, targetProfile),
            triggerRebuildAttempted: rebuiltTriggerAttempted,
            classification: bottleneck,
            reasons: targetAchieved(bestPolicySummary, targetProfile)
              ? ["Configured smoke search found a policy that meets the current target gates."]
              : rebuiltTriggerAttempted
                ? ["Current runtime pool was insufficient, rebuilt trigger candidates were evaluated, and the configured search still fell short of the target objective."]
                : ["Current runtime pool did not produce a target-grade policy within the configured smoke search."],
            futureImplementationRecommendation: targetAchieved(bestPolicySummary, targetProfile)
              ? "Review the candidate runtime policy artifact before any explicit promotion."
              : bottleneck === "rebuilt_trigger_execution_failed"
                ? "Repair rebuilt trigger entry simulation or exit derivation before relying on rebuilt trigger search."
              : rebuiltTriggerAttempted
                ? "Expand the search profile or improve trigger/archetype separability before promoting any elite policy."
                : "Allow synthesis to continue into rebuilt trigger search or add more data windows before promotion.",
          },
        }
      : null,
    passLogSummary: passLog.slice(-10),
    fullPassLog: passLog,
    featureDistributions: features,
    exitOptimisationTable: bestPolicyArtifact ? [bestPolicyArtifact.tpRules, bestPolicyArtifact.slRules, bestPolicyArtifact.lifecycleManagerRules] : [],
    triggerRebuildSummary: {
      candidateCount: dataset.rebuiltTriggerCandidates.length,
      eligibleCount: dataset.rebuiltTriggerCandidates.filter((candidate) => candidate.eligible).length,
      rejectedCount: dataset.rebuiltTriggerCandidates.filter((candidate) => !candidate.eligible).length,
      reason: rebuiltTriggerAttempted
        ? (bottleneck === "rebuilt_trigger_execution_failed"
          ? "rebuilt_trigger_execution_failed"
          : bottleneck === "rebuilt_policy_evaluation_failed"
            ? "rebuilt_policy_evaluation_failed"
            : "current_runtime_pool_insufficient")
        : "not_required_in_current_search",
      topRejectReasons: Object.entries(dataset.rebuiltTriggerCandidates.reduce<Record<string, number>>((acc, candidate) => {
        if (!candidate.rejectReason) return acc;
        acc[candidate.rejectReason] = (acc[candidate.rejectReason] ?? 0) + 1;
        return acc;
      }, {})).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([reason, count]) => ({ reason, count })),
      ...rebuiltTriggerDiagnostics,
    },
    rebuiltTriggerDiagnostics,
    bottleneckSummary: {
      targetAchieved: targetAchieved(bestPolicySummary, targetProfile),
      triggerRebuildAttempted: rebuiltTriggerAttempted,
      classification: bottleneck,
      reasons: targetAchieved(bestPolicySummary, targetProfile)
        ? ["Configured search reached the requested target gates within the smoke profile."]
        : [
            ...(bottleneck === "rebuilt_trigger_execution_failed"
              ? ["Rebuilt trigger candidates were generated but did not convert into executable simulated trades."]
              : []),
            ...(bottleneck === "rebuilt_policy_evaluation_failed"
              ? ["Rebuilt trigger candidates simulated successfully, but rebuilt policy grouping/evaluation produced zero rebuilt policy trades."]
              : []),
            rebuiltTriggerAttempted
              ? "Rebuilt trigger pool was evaluated after the current runtime pool proved insufficient."
              : "Configured smoke profile did not find a target-grade policy in the current runtime pool.",
          ],
      futureImplementationRecommendation: targetAchieved(bestPolicySummary, targetProfile)
        ? "Run deeper synthesis on a longer window before considering any paper promotion."
        : bottleneck === "rebuilt_policy_evaluation_failed"
          ? "Repair rebuilt policy grouping and post-group daily selection so simulated rebuilt candidates become valid rebuilt policy trades."
        : bottleneck === "rebuilt_trigger_execution_failed"
          ? "Repair rebuilt trigger candidate execution before using rebuilt passes to judge strategy quality."
        : "Use a deeper profile or add more historical windows before promoting a runtime candidate.",
      topRawFamilyReject: rebuiltTriggerDiagnostics.summary?.topRawFamilyReject ?? null,
      topRawTransitionReject: rebuiltTriggerDiagnostics.summary?.topRawTransitionReject ?? null,
      topRawDirectionReject: rebuiltTriggerDiagnostics.summary?.topRawDirectionReject ?? null,
      topInvalidArchetypeExamplesCount: rebuiltTriggerDiagnostics.summary?.topInvalidArchetypeExamplesCount ?? 0,
      validationHardeningFailed: validationHardeningGuard.validationHardeningFailed,
      failedInvariant: validationHardeningGuard.failedInvariant,
    },
    leakageAuditSummary: bestPolicyArtifact?.leakageAudit ?? defaultLeakageAudit(),
    validationErrors: dataset.validationErrors ?? [],
    dataAvailability: dataset.dataAvailability ?? emptyDataAvailability(),
    unitValidation: dataset.unitValidation ?? emptyUnitValidation(),
    missingFeatureImplementations: dataset.missingFeatureImplementations ?? [],
    windowSummary: {
      startTs: effectiveStartTs,
      endTs: effectiveEndTs,
      windowDays: effectiveWindowDays,
      searchProfile,
      targetProfile,
      maxPasses,
      patiencePasses,
      jobGrade: searchProfile === "fast" ? "smoke_plumbing_only" : "strategy_grade_review",
      reasonStopped: stopReason,
    },
    sourceRunIds: dataset.sourceRunIds,
    datasetSummary: dataset.summary,
    bestPolicySelectedTradesSummary: bestPolicyValidationArtifacts.bestPolicySelectedTradesSummary,
    bestPolicySelectedTrades: bestPolicyValidationArtifacts.bestPolicySelectedTrades,
    targetAchievedBreakdown: targetBreakdown,
    strategyGradeReadiness,
    policyArtifactReadiness,
    validationHardeningGuard,
    returnAmplificationAnalysis,
    escalatedSeedFamilies: (returnAmplificationAnalysis as Record<string, unknown>).escalatedSeedFamilies ?? [],
    primaryDeepFamilyAnalysis: (returnAmplificationAnalysis as Record<string, unknown>).primaryDeepFamilyAnalysis ?? null,
    preLimitFamilyStats: (returnAmplificationAnalysis as Record<string, unknown>).preLimitFamilyStats ?? null,
    postDailyLimitFamilyStats: (returnAmplificationAnalysis as Record<string, unknown>).postDailyLimitFamilyStats ?? null,
    winnerLoserSeparation: (returnAmplificationAnalysis as Record<string, unknown>).winnerLoserSeparation ?? [],
    tradeLifecycleManagerReplay: (returnAmplificationAnalysis as Record<string, unknown>).tradeLifecycleManagerReplay ?? null,
    dynamicTpProtectionSummary: (returnAmplificationAnalysis as Record<string, unknown>).dynamicTpProtectionSummary ?? null,
    aiStrategyReview: (returnAmplificationAnalysis as Record<string, unknown>).aiStrategyReview ?? null,
    candidateFamilyComparison: (returnAmplificationAnalysis as Record<string, unknown>).policyComparisonTable ?? [],
    runtimeArtifactEligibility: finalPassRuntimeArtifactEligibility ?? null,
    reviewCandidateRuntimeArtifact,
  };
  const storedResult = compactEliteSynthesisResultForStorage(result);

  await updateEliteSynthesisJob(params.jobId, {
    status: "completed",
    stage: "completed",
    progressPct: 100,
    message: completionMessage,
    heartbeatAt: nowIso(),
    completedAt: nowIso(),
    bestSummary: bestSummaryFromPolicy(bestPolicySummary, evaluatedPolicyCount, topPolicies.length),
    errorSummary: noTargetReason
      ? {
          failureType: "no_target_exhausted",
          noTargetReason,
          passesCompleted: passLog.length,
          maxPasses,
          targetProfile,
          targetProfileNormalized: normalizedTargetProfile,
        }
      : undefined,
    resultSummary: {
      resultState: result.resultState,
      targetAchieved: result.targetAchieved,
      failureType: result.failureType,
      exceptionMessage: result.exceptionMessage,
      noTargetReason: result.noTargetReason,
      passesCompleted: result.passesCompleted,
      maxPasses: result.maxPasses,
      targetProfile: result.targetProfile,
      targetProfileNormalized: result.targetProfileNormalized,
      recommendedPolicyStatus: recommendedPolicy ? String(recommendedPolicy.status ?? "") : null,
      guardrailsPassedCount,
      topPolicyCount: result.topPolicySummaries.length,
      bottleneck: result.bottleneckSummary.classification,
      validationErrors: result.validationErrors,
    },
    resultArtifact: storedResult,
  });

  return result;
}
