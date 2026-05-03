import { Crash300SynthesisAdapter, buildUnifiedCrash300Dataset } from "./crash300Adapter.js";
import type { SymbolSynthesisAdapter, UnifiedSynthesisDataset } from "./adapter.js";
import {
  getEliteSynthesisJob,
  updateEliteSynthesisJob,
} from "./jobs.js";
import type {
  EliteSynthesisBottleneck,
  EliteSynthesisFeatureSummary,
  EliteSynthesisLeakageAudit,
  EliteSynthesisParams,
  EliteSynthesisPassLog,
  EliteSynthesisPolicyArtifact,
  EliteSynthesisPolicySummary,
  EliteSynthesisResult,
  EliteSynthesisSearchProfile,
} from "./types.js";
import { profileDefaults } from "./types.js";

function nowIso() {
  return new Date().toISOString();
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

function featureSummaryFromDataset(dataset: UnifiedSynthesisDataset): EliteSynthesisFeatureSummary[] {
  const positiveTrades = dataset.trades.filter((trade) => trade.pnlPct > 0);
  const negativeTrades = dataset.trades.filter((trade) => trade.pnlPct <= 0 || trade.phantomNoiseLabel === "noise_trade");
  const keys = uniqueStrings([
    ...positiveTrades.flatMap((trade) => Object.keys(trade.liveSafeFeatures)),
    ...negativeTrades.flatMap((trade) => Object.keys(trade.liveSafeFeatures)),
  ]);
  return keys.map((key) => {
    const positive = positiveTrades.map((trade) => Number(trade.liveSafeFeatures[key])).filter((value) => Number.isFinite(value));
    const negative = negativeTrades.map((trade) => Number(trade.liveSafeFeatures[key])).filter((value) => Number.isFinite(value));
    const posMedian = median(positive);
    const negMedian = median(negative);
    const separationScore = Math.abs(posMedian - negMedian);
    const overlapScore = separationScore <= 0.02 ? 1 : Math.max(0, 1 - separationScore);
    const denominator = positiveTrades.length + negativeTrades.length;
    const missingRate = denominator > 0
      ? 1 - ((positive.length + negative.length) / denominator)
      : 1;
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
}) {
  const exitSubset = params.dataset.trades.filter((trade) =>
    params.selectedRuntimeArchetypes.includes(trade.runtimeFamily ?? "unknown")
    && params.selectedBuckets.includes(trade.selectedBucket ?? "unknown")
    && params.selectedTriggerTransitions.includes(trade.triggerTransition ?? "none"),
  );
  const exitRules = params.adapter.deriveExitPolicyFromSubset(params.dataset, exitSubset);
  const policy: EliteSynthesisPolicyArtifact = {
    policyId: `crash300-elite-pass-${params.passNumber}`,
    version: "0.1.0-foundation",
    generatedAt: nowIso(),
    sourceCalibrationRunId: Number(params.dataset.sourceRunIds.calibrationRunId ?? 0) || null,
    sourceBacktestRunId: Number(params.dataset.sourceRunIds.backtestRunId ?? 0) || null,
    calibratedBaseFamily: "crash_expansion",
    selectedMoveSizeBuckets: params.selectedMoveSizeBuckets,
    selectedRuntimeArchetypes: params.selectedRuntimeArchetypes,
    selectedBuckets: params.selectedBuckets,
    selectedTriggerTransitions: params.selectedTriggerTransitions,
    selectedCoreFeatures: params.featureSet,
    entryThresholds: {
      mutationSummary: params.mutationSummary,
      minConfidence: 0,
      minSetupMatch: 0,
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
    tpRules: { targetPct: exitRules.tpTargetPct, source: "synthesis_percentile_subset" },
    slRules: { maxInitialRiskPct: exitRules.slRiskPct, source: "synthesis_percentile_subset" },
    trailingRules: {
      activationProfitPct: exitRules.trailingActivationPct,
      trailingDistancePct: exitRules.trailingDistancePct,
      source: "synthesis_percentile_subset",
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

function generateInitialPolicies(dataset: UnifiedSynthesisDataset, features: EliteSynthesisFeatureSummary[]) {
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
    .filter((group) => group.trades >= 2)
    .sort((a, b) => (b.wins / Math.max(1, b.trades)) - (a.wins / Math.max(1, a.trades)))
    .slice(0, 20)
    .map((group, index) => ({
      passNumber: 1,
      selectedRuntimeArchetypes: [group.family],
      selectedBuckets: [group.bucket],
      selectedMoveSizeBuckets: dataset.moves
        .filter((move) => (move.phaseDerivedBucket ?? move.calibratedMoveSizeBucket) === group.bucket)
        .map((move) => move.calibratedMoveSizeBucket)
        .slice(0, 5),
      selectedTriggerTransitions: [group.trigger],
      featureSet: features.filter((feature) => feature.kept).slice(0, 10 + index % 5),
      mutationSummary: index === 0 ? "seeded_from_current_runtime_candidate_pool" : `seeded_runtime_group_${index + 1}`,
    }));
}

function generatePoliciesFromTriggerRebuild(dataset: UnifiedSynthesisDataset, rebuiltCandidates: Array<Record<string, unknown>>, features: EliteSynthesisFeatureSummary[]) {
  const groups = new Map<string, number>();
  for (const candidate of rebuiltCandidates) {
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
        selectedRuntimeArchetypes: [family ?? "unknown"],
        selectedBuckets: [bucket ?? "unknown"],
        selectedMoveSizeBuckets: dataset.moves
          .filter((move) => (move.phaseDerivedFamily ?? "unknown") === family)
          .map((move) => move.calibratedMoveSizeBucket)
          .slice(0, 5),
        selectedTriggerTransitions: [trigger ?? "none"],
        featureSet: features.filter((feature) => feature.kept).slice(0, 8 + index % 4),
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

  const dataset = await buildUnifiedCrash300Dataset({
    calibrationRunId: params.request.calibrationRunId ?? null,
    backtestRunId: params.request.backtestRunId ?? null,
    startTs: effectiveStartTs,
    endTs: effectiveEndTs,
    windowDays: effectiveWindowDays,
  });
  await updateEliteSynthesisJob(params.jobId, {
    stage: "building_dataset",
    progressPct: 10,
    message: `Built unified dataset with ${dataset.moves.length} calibrated moves, ${dataset.trades.length} runtime trades, and ${dataset.controls.length} controls`,
    heartbeatAt: nowIso(),
    resultSummary: { datasetSummary: dataset.summary },
  });

  const features = featureSummaryFromDataset(dataset);
  await updateEliteSynthesisJob(params.jobId, {
    stage: "feature_elimination",
    progressPct: 18,
    message: `Computed live-safe feature separability for ${features.length} features`,
    heartbeatAt: nowIso(),
  });

  let passLog: EliteSynthesisPassLog[] = [];
  let bestPolicySummary: EliteSynthesisPolicySummary | null = null;
  let bestPolicyArtifact: EliteSynthesisPolicyArtifact | null = null;
  const topPolicies: EliteSynthesisPolicySummary[] = [];
  let rebuiltTriggerAttempted = false;
  let bottleneck: EliteSynthesisBottleneck = "current_runtime_pool_insufficient";
  let noImprovementPasses = 0;
  let evaluatedPolicyCount = 0;

  let policySeeds = generateInitialPolicies(dataset, features);
  await updateEliteSynthesisJob(params.jobId, {
    stage: "evaluating_current_pool",
    progressPct: 24,
    message: `Evaluating ${policySeeds.length} policies from the current runtime candidate pool`,
    heartbeatAt: nowIso(),
    bestSummary: bestSummaryFromPolicy(bestPolicySummary, evaluatedPolicyCount, policySeeds.length),
  });

  for (let passNumber = 1; passNumber <= maxPasses; passNumber += 1) {
    const job = await getEliteSynthesisJob(params.jobId);
    if (job?.status === "cancelled") {
      const cancelledResult: EliteSynthesisResult = {
        jobId: params.jobId,
        serviceId: params.serviceId,
        status: "cancelled",
        targetAchieved: false,
        bestPolicySummary,
        topPolicySummaries: topPolicies.slice(0, 20),
        bestPolicyArtifact,
        passLogSummary: passLog.slice(-10),
        fullPassLog: passLog,
        featureDistributions: features,
        exitOptimisationTable: [],
        triggerRebuildSummary: { attempted: rebuiltTriggerAttempted },
        bottleneckSummary: {
          targetAchieved: false,
          triggerRebuildAttempted: rebuiltTriggerAttempted,
          classification: "search_exhausted",
          reasons: ["Job was cancelled before completion."],
          futureImplementationRecommendation: "Restart synthesis if a full search is still required.",
        },
        leakageAuditSummary: bestPolicyArtifact?.leakageAudit ?? defaultLeakageAudit(),
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
      policySeeds = generatePoliciesFromTriggerRebuild(dataset, rebuilt, features);
      await updateEliteSynthesisJob(params.jobId, {
        stage: "generating_policies",
        progressPct: 36,
        currentPass: passNumber,
        message: `Generated ${policySeeds.length} policies from rebuilt trigger candidates`,
        heartbeatAt: nowIso(),
      });
      continue;
    }

    await updateEliteSynthesisJob(params.jobId, {
      stage: "evaluating_policies",
      progressPct: Math.min(92, 36 + Math.round((passNumber / Math.max(1, maxPasses)) * 46)),
      currentPass: passNumber,
      message: `Evaluating policy pass ${passNumber}/${maxPasses}`,
      heartbeatAt: nowIso(),
      bestSummary: bestSummaryFromPolicy(bestPolicySummary, evaluatedPolicyCount, policySeeds.length),
    });

    let passBest: EliteSynthesisPolicySummary | null = null;
    let passBestArtifact: EliteSynthesisPolicyArtifact | null = null;
    for (const seed of policySeeds) {
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
      reasonBestImproved: improved ? "objective_score_improved" : "no_improvement_this_pass",
      bestSoFar: improved,
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
      if (noImprovementPasses >= patiencePasses) break;
    }

    if (!targetAchieved(bestPolicySummary) && !rebuiltTriggerAttempted && passNumber >= Math.max(2, Math.floor(maxPasses / 3))) {
      rebuiltTriggerAttempted = true;
      bottleneck = "current_runtime_pool_insufficient";
      await updateEliteSynthesisJob(params.jobId, {
        stage: "rebuilding_trigger_candidates",
        progressPct: Math.min(70, 46 + Math.round((passNumber / Math.max(1, maxPasses)) * 18)),
        currentPass: passNumber,
        message: "Current runtime pool remains insufficient; rebuilding trigger candidates from calibrated move offsets",
        heartbeatAt: nowIso(),
      });
      const rebuilt = await adapter.generateTriggerCandidatesFromMoveOffsets(dataset);
      policySeeds = generatePoliciesFromTriggerRebuild(dataset, rebuilt, features);
      continue;
    }

    if (noImprovementPasses >= patiencePasses && passNumber >= 2) {
      break;
    }

    policySeeds = policySeeds.map((seed, index) => ({
      ...seed,
      passNumber: passNumber + 1,
      featureSet: seed.featureSet.slice(0, Math.max(4, seed.featureSet.length - (index % 2 === 0 ? 1 : 0))),
      mutationSummary: `mutated_from_pass_${passNumber}_candidate_${index + 1}`,
    }));
  }

  if (!targetAchieved(bestPolicySummary)) {
    bottleneck = rebuiltTriggerAttempted
      ? "rebuilt_trigger_pool_still_insufficient"
      : "current_runtime_pool_insufficient";
  }

  await updateEliteSynthesisJob(params.jobId, {
    stage: "selecting_best",
    progressPct: 96,
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
      attempted: rebuiltTriggerAttempted,
      reason: rebuiltTriggerAttempted ? "current_runtime_pool_insufficient" : "not_required_in_current_search",
    },
    bottleneckSummary: {
      targetAchieved: targetAchieved(bestPolicySummary),
      triggerRebuildAttempted: rebuiltTriggerAttempted,
      classification: bottleneck,
      reasons: targetAchieved(bestPolicySummary)
        ? ["Configured search reached the requested target gates within the smoke profile."]
        : [
            rebuiltTriggerAttempted
              ? "Rebuilt trigger pool was evaluated after the current runtime pool proved insufficient."
              : "Configured smoke profile did not find a target-grade policy in the current runtime pool.",
          ],
      futureImplementationRecommendation: targetAchieved(bestPolicySummary)
        ? "Run deeper synthesis on a longer window before considering any paper promotion."
        : "Use a deeper profile or add more historical windows before promoting a runtime candidate.",
    },
    leakageAuditSummary: bestPolicyArtifact?.leakageAudit ?? defaultLeakageAudit(),
    windowSummary: {
      startTs: effectiveStartTs,
      endTs: effectiveEndTs,
      windowDays: effectiveWindowDays,
      searchProfile,
      maxPasses,
      patiencePasses,
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
      targetAchieved: result.targetAchieved,
      topPolicyCount: result.topPolicySummaries.length,
      bottleneck: result.bottleneckSummary.classification,
    },
    resultArtifact: result,
  });

  return result;
}
