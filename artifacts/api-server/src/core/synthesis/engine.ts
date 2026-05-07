import { Crash300SynthesisAdapter, buildUnifiedCrash300Dataset } from "./crash300Adapter.js";
import type { SymbolSynthesisAdapter, UnifiedSynthesisDataset } from "./adapter.js";
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
  const timestamps = candidates.map((candidate) => candidate.entryTs).filter((value) => Number.isFinite(value));
  const inspectedCalibratedMoves = dataset.moves.length;
  const offsetsAttempted = dataset.moves.length * 11;
  const simulatedTrades = candidates.filter((candidate) => candidate.simulatedTrade);
  const rejectedCandidates = candidates.filter((candidate) => !candidate.simulatedTrade);
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
    rejectionReasonCounts: countValues(rejectedCandidates.flatMap((candidate) => candidate.rejectionReasons.length > 0 ? candidate.rejectionReasons : [candidate.rejectReason ?? candidate.noTradeReason])),
    candidateOffsetDistribution: countValues(candidates.map((candidate) => candidate.offsetLabel)),
    candidateArchetypeDistribution: countValues(candidates.map((candidate) => candidate.runtimeFamily)),
    candidateDirectionDistribution: countValues(candidates.map((candidate) => candidate.direction)),
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
  featureSet: EliteSynthesisFeatureSummary[];
  mutationSummary: string;
};

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
  mutationSummary: string;
  sourcePool: "runtime_trades" | "rebuilt_trigger_candidates";
}) {
  const exitSubset = (params.sourcePool === "rebuilt_trigger_candidates"
    ? params.dataset.rebuiltTriggerCandidates
    : params.dataset.trades).filter((trade) =>
    params.selectedRuntimeArchetypes.includes(trade.runtimeFamily ?? "unknown")
    && params.selectedBuckets.includes(trade.selectedBucket ?? "unknown")
    && params.selectedTriggerTransitions.includes(trade.triggerTransition ?? "none"),
  );
  const exitRules = params.adapter.deriveExitPolicyFromSubset(params.dataset, exitSubset as never);
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
    policyId: `crash300-elite-pass-${params.passNumber}`,
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
      minConfidence: subsetConfidence.length > 0 ? Number(median(subsetConfidence).toFixed(4)) : 0.45,
      minSetupMatch: subsetSetupMatch.length > 0 ? Number(median(subsetSetupMatch).toFixed(4)) : 0.45,
    },
    entryTimingRules: [
      {
        preferredOffset: "T0",
        earliestSafeOffset: "T-1",
        rejectEarlierThan: "T-5",
        rejectLaterThan: "T+3",
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
  const groups = new Map<string, number>();
  for (const candidate of rebuiltCandidates) {
    if (!candidate.eligible) continue;
    const family = String(candidate.runtimeFamily ?? "unknown");
    const bucket = String(candidate.selectedBucket ?? "unknown");
    const trigger = String(candidate.triggerTransition ?? "none");
    const key = `${family}|${bucket}|${trigger}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return [...groups.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([key], index) => {
      const [family, bucket, trigger] = key.split("|");
      return {
        passNumber: 2,
        sourcePool: "rebuilt_trigger_candidates" as const,
        selectedRuntimeArchetypes: [family ?? "unknown"],
        selectedBuckets: [bucket ?? "unknown"],
        selectedMoveSizeBuckets: resolveSelectedMoveSizeBuckets({
          dataset,
          selectedBuckets: [bucket ?? "unknown"],
          selectedRuntimeArchetypes: [family ?? "unknown"],
        }).slice(0, 5),
        selectedTriggerTransitions: [trigger ?? "none"],
        featureSet: features.filter((feature) => feature.kept).slice(0, Math.max(4, 8 + index % 4)),
        mutationSummary: index === 0 ? "rebuilt_from_calibrated_move_offsets" : `rebuilt_trigger_cluster_${index + 1}`,
      };
    });
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
  const topPolicies: EliteSynthesisPolicySummary[] = [];
  let rebuiltTriggerAttempted = false;
  let rebuiltTriggerDiagnostics = buildRebuiltTriggerDiagnostics(dataset);
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
        mutationSummary: seed.mutationSummary,
        sourcePool: seed.sourcePool,
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
      if (!passBest || evaluation.objectiveScore > passBest.objectiveScore) {
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
      bottleneck = "rebuilt_trigger_execution_failed";
      stopReason = "rebuilt_zero_trade_diagnostics";
      const lastLog = passLog[passLog.length - 1];
      if (lastLog) {
        const rebuiltTopReason = Object.entries(rebuiltTriggerDiagnostics.rejectionReasonCounts ?? {}).sort((a, b) => b[1] - a[1])[0];
        lastLog.reasonStopped = stopReason;
        lastLog.changedParameters = [
          ...lastLog.changedParameters,
          `rebuilt_eligible:${rebuiltTriggerDiagnostics.rebuiltTriggerCandidatesEligible}`,
          `rebuilt_simulated:${rebuiltTriggerDiagnostics.simulatedTradeCount}`,
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

  const topPolicySummaries = topPolicies
    .slice()
    .sort((a, b) => b.objectiveScore - a.objectiveScore)
    .slice(0, 20);

  const result: EliteSynthesisResult = {
    jobId: params.jobId,
    serviceId: params.serviceId,
    status: "completed",
    resultState: targetAchieved(bestPolicySummary)
      ? "completed_target_achieved"
      : bottleneck === "rebuilt_trigger_execution_failed"
        ? "completed_foundation_incomplete"
      : rebuiltTriggerAttempted || passLog.length >= maxPasses
        ? "completed_exhausted_no_target"
        : "completed_foundation_incomplete",
    targetAchieved: targetAchieved(bestPolicySummary),
    bestPolicySummary,
    topPolicySummaries,
    bestPolicyArtifact: bestPolicyArtifact
      ? {
          ...bestPolicyArtifact,
          objectiveScore: bestPolicySummary?.objectiveScore ?? bestPolicyArtifact.objectiveScore,
          expectedThreeMonthPerformance: bestPolicyArtifact.expectedThreeMonthPerformance,
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
        ? (bottleneck === "rebuilt_trigger_execution_failed" ? "rebuilt_trigger_execution_failed" : "current_runtime_pool_insufficient")
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
            rebuiltTriggerAttempted
              ? "Rebuilt trigger pool was evaluated after the current runtime pool proved insufficient."
              : "Configured smoke profile did not find a target-grade policy in the current runtime pool.",
          ],
      futureImplementationRecommendation: targetAchieved(bestPolicySummary)
        ? "Run deeper synthesis on a longer window before considering any paper promotion."
        : bottleneck === "rebuilt_trigger_execution_failed"
          ? "Repair rebuilt trigger candidate execution before using rebuilt passes to judge strategy quality."
        : "Use a deeper profile or add more historical windows before promoting a runtime candidate.",
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
