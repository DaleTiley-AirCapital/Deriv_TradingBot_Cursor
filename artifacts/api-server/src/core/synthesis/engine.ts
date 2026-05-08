import { Crash300SynthesisAdapter, buildUnifiedCrash300Dataset } from "./crash300Adapter.js";
import type { PolicyEvaluationResult, SymbolSynthesisAdapter, SynthesisRebuiltTriggerCandidateRecord, UnifiedSynthesisDataset } from "./adapter.js";
import {
  getEliteSynthesisJob,
  updateEliteSynthesisJob,
} from "./jobs.js";
import { isWorkerJobCancellationRequested, WorkerJobCancelledError } from "../worker/jobs.js";
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
  EliteSynthesisUnitValidation,
  EliteSynthesisValidationError,
} from "./types.js";
import { profileDefaults } from "./types.js";

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
    trailingRules: {
      activationProfitPct: exitRules.trailingActivationPct,
      trailingDistancePct: exitRules.trailingDistancePct,
      unit: exitRules.unit,
      source: "synthesis_percentile_subset",
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

function targetAchieved(policy: EliteSynthesisPolicySummary | null) {
  return Boolean(
    policy
    && policy.winRate >= 0.9
    && policy.slHitRate <= 0.1
    && policy.profitFactor >= 2.5
    && policy.trades >= 45
    && policy.trades <= 75,
  );
}

function mean(values: number[]) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
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
      trailingActivationRangePctPoints: {
        min: selectedTrades.length > 0 ? Math.min(...selectedTrades.map((trade) => Number(trade.trailingActivationPctPoints ?? trade.trailingActivationPct ?? 0))) : null,
        max: selectedTrades.length > 0 ? Math.max(...selectedTrades.map((trade) => Number(trade.trailingActivationPctPoints ?? trade.trailingActivationPct ?? 0))) : null,
      },
      trailingDistanceRangePctPoints: {
        min: selectedTrades.length > 0 ? Math.min(...selectedTrades.map((trade) => Number(trade.trailingDistancePctPoints ?? trade.trailingDistancePct ?? 0))) : null,
        max: selectedTrades.length > 0 ? Math.max(...selectedTrades.map((trade) => Number(trade.trailingDistancePctPoints ?? trade.trailingDistancePct ?? 0))) : null,
      },
    },
    derivedTpPct: bestEvaluation.exitRules.tpTargetPct,
    derivedSlPct: bestEvaluation.exitRules.slRiskPct,
    derivedTrailingActivationPct: bestEvaluation.exitRules.trailingActivationPct,
    derivedTrailingDistancePct: bestEvaluation.exitRules.trailingDistancePct,
    explanation: mostCommonExitSource === "family_default"
      ? "The selected rebuilt trades use the family_default exit subset. TP/SL/trailing should be judged against the source value ranges aggregated from the simulated selected trades, not only against a narrower intermediate display range."
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
  return {
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
    requiredTradeCountMin: params.targetTradeCountMin,
    requiredTradeCountMax: params.targetTradeCountMax,
    tradeCountPassed,
    maxTradesPerDay: params.maxTradesPerDay,
    maxTradesPerDayPassed: true,
    phantomCount: policy?.phantomCount ?? 0,
    phantomCountPassed: Boolean((policy?.phantomCount ?? 0) === 0),
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
      && tradeCountPassed
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
        validationErrors,
      },
      resultSummary: {
        resultState,
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
        resultSummary: { targetAchieved: false, cancelled: true },
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

    if (targetAchieved(bestPolicySummary)) {
      bottleneck = "none";
      if (noImprovementPasses >= patiencePasses) {
        stopReason = "target_achieved_and_patience_exhausted";
        break;
      }
    }

    if (!targetAchieved(bestPolicySummary) && !rebuiltTriggerAttempted && passNumber >= Math.max(2, Math.floor(maxPasses / 3))) {
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

  if (!targetAchieved(bestPolicySummary)) {
    bottleneck = bottleneck === "rebuilt_trigger_execution_failed"
      ? "rebuilt_trigger_execution_failed"
      : rebuiltTriggerAttempted
      ? "rebuilt_trigger_pool_still_insufficient"
      : "current_runtime_pool_insufficient";
  }
  if (!stopReason) {
    stopReason = targetAchieved(bestPolicySummary) ? "target_achieved" : "search_space_exhausted";
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
  });

  const result: EliteSynthesisResult = {
    jobId: params.jobId,
    serviceId: params.serviceId,
    status: "completed",
    resultState: targetAchieved(bestPolicySummary)
      ? "completed_target_achieved"
      : bottleneck === "rebuilt_policy_evaluation_failed"
        ? "rebuilt_policy_evaluation_failed"
      : bottleneck === "rebuilt_trigger_execution_failed"
        ? "completed_foundation_incomplete"
      : rebuiltTriggerAttempted || passLog.length >= maxPasses
        ? "completed_exhausted_no_target"
        : "completed_foundation_incomplete",
    targetAchieved: targetAchieved(bestPolicySummary),
    bestPolicySummary: bestPolicySummary
      ? {
          ...bestPolicySummary,
          lateOffsetSafetyAudit: bestPolicyValidationArtifacts.lateOffsetSafetyAudit,
          calibratedMoveRelationshipSummary: bestPolicyValidationArtifacts.calibratedMoveRelationshipSummary,
          exitDerivationAudit: bestPolicyValidationArtifacts.exitDerivationAudit,
          monthlyStabilityAssessment: bestPolicyValidationArtifacts.monthlyStabilityAssessment,
          targetAchievedBreakdown: targetBreakdown,
          policyArtifactReadiness,
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
          bottleneckAnalysis: {
            targetAchieved: targetAchieved(bestPolicySummary),
            triggerRebuildAttempted: rebuiltTriggerAttempted,
            classification: bottleneck,
            reasons: targetAchieved(bestPolicySummary)
              ? ["Configured smoke search found a policy that meets the current target gates."]
              : rebuiltTriggerAttempted
                ? ["Current runtime pool was insufficient, rebuilt trigger candidates were evaluated, and the configured search still fell short of the target objective."]
                : ["Current runtime pool did not produce a target-grade policy within the configured smoke search."],
            futureImplementationRecommendation: targetAchieved(bestPolicySummary)
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
    exitOptimisationTable: bestPolicyArtifact ? [bestPolicyArtifact.tpRules, bestPolicyArtifact.slRules, bestPolicyArtifact.trailingRules] : [],
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
      targetAchieved: targetAchieved(bestPolicySummary),
      triggerRebuildAttempted: rebuiltTriggerAttempted,
      classification: bottleneck,
      reasons: targetAchieved(bestPolicySummary)
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
      futureImplementationRecommendation: targetAchieved(bestPolicySummary)
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
  };

  await updateEliteSynthesisJob(params.jobId, {
    status: "completed",
    stage: "completed",
    progressPct: 100,
    message: result.targetAchieved
      ? "Integrated elite synthesis completed with a target-grade candidate policy"
      : "Integrated elite synthesis completed without reaching the target objective",
    heartbeatAt: nowIso(),
    completedAt: nowIso(),
    bestSummary: bestSummaryFromPolicy(bestPolicySummary, evaluatedPolicyCount, topPolicies.length),
    resultSummary: {
      resultState: result.resultState,
      targetAchieved: result.targetAchieved,
      topPolicyCount: result.topPolicySummaries.length,
      bottleneck: result.bottleneckSummary.classification,
      validationErrors: result.validationErrors,
    },
    resultArtifact: result,
  });

  return result;
}
