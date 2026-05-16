import { Router, type IRouter, type Response } from "express";
import { backgroundDb, candlesTable, db, platformStateTable } from "@workspace/db";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { buildUnifiedCrash300Dataset } from "../core/synthesis/crash300Adapter.js";
import {
  buildTradeLifecycleReplayReportFromStoredTrades,
  getSynthesisAdapter,
} from "../core/synthesis/engine.js";
import {
  createEliteSynthesisJob,
  ensureEliteSynthesisJobsTable,
  getEliteSynthesisJob,
  getEliteSynthesisJobSizeDiagnostics,
  getEliteSynthesisJobSummary,
  getEliteSynthesisProgress,
  getEliteSynthesisSchemaStatus,
  listEliteSynthesisJobs,
  markEliteSynthesisJobCancelled,
  updateEliteSynthesisJob,
  type EliteSynthesisJobRow,
} from "../core/synthesis/jobs.js";
import type { CandleRow } from "../core/backtest/featureSlice.js";
import type { EliteSynthesisParams, EliteSynthesisResult } from "../core/synthesis/types.js";
import { profileDefaults } from "../core/synthesis/types.js";
import {
  promoteCandidateArtifactToServiceRuntime,
  readPromotedServiceRuntimeArtifact,
  readStagedSynthesisCandidateState,
  writeStagedSynthesisCandidateState,
} from "../core/serviceRuntimeLifecycle.js";

const router: IRouter = Router();

function logEliteSynthesisRouteError(routeName: string, err: unknown, context: Record<string, unknown> = {}) {
  const error = err instanceof Error ? err : new Error(String(err));
  console.error("[elite-synthesis-route-error]", {
    routeName,
    errorName: error.name,
    errorMessage: error.message,
    stack: error.stack,
    ...context,
  });
}

function sendJsonOrTooLarge(res: Response, routeName: string, payload: unknown, context: Record<string, unknown> = {}) {
  try {
    const body = JSON.stringify(payload);
    res.type("application/json").send(body);
  } catch (err) {
    logEliteSynthesisRouteError(routeName, err, {
      ...context,
      jsonStringify: true,
    });
    res.status(413).json({
      error: "Elite synthesis artifact is too large to export in one response.",
      routeName,
    });
  }
}

function stableChecksum(value: unknown): string {
  const json = JSON.stringify(value, Object.keys(value && typeof value === "object" ? value as Record<string, unknown> : {}).sort());
  let hash = 0;
  for (let index = 0; index < json.length; index += 1) {
    hash = ((hash << 5) - hash + json.charCodeAt(index)) | 0;
  }
  return `s${Math.abs(hash)}`;
}

async function findCandidateRuntimeArtifact(serviceId: string, artifactId: string) {
  const summaries = await listEliteSynthesisJobs(serviceId, 200);
  for (const summary of summaries) {
    const job = await getEliteSynthesisJob(summary.id);
    if (!job) continue;
    const reviewArtifact = job.resultArtifact?.reviewCandidateRuntimeArtifact;
    const artifacts = [
      ...job.candidateRuntimeArtifacts,
      ...(reviewArtifact && typeof reviewArtifact === "object" ? [reviewArtifact as Record<string, unknown>] : []),
    ];
    const artifact = artifacts.find((item) => String(item.artifactId ?? "") === artifactId);
    if (artifact) return { job, artifact };
  }
  return null;
}

async function findLatestReviewCandidateRuntimeArtifact(serviceId: string) {
  const summaries = await listEliteSynthesisJobs(serviceId, 50);
  for (const summary of summaries) {
    const job = await getEliteSynthesisJob(summary.id);
    const artifact = job?.resultArtifact?.reviewCandidateRuntimeArtifact;
    if (artifact && typeof artifact === "object") return { job, artifact: artifact as Record<string, unknown> };
    const candidate = job?.candidateRuntimeArtifacts.find((item) => String(item.mode ?? "") === "review_only");
    if (job && candidate) return { job, artifact: candidate };
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function pickCompactFields(source: Record<string, unknown>, keys: string[]) {
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) output[key] = source[key];
  }
  return output;
}

function compactRuntimeBuildScenario(value: unknown) {
  const scenario = asRecord(value);
  if (!Object.keys(scenario).length) return value ?? null;
  return pickCompactFields(scenario, [
    "scenarioId",
    "policyId",
    "label",
    "description",
    "sourcePool",
    "runtimeFamily",
    "triggerTransition",
    "selectedMoveSizeBucket",
    "direction",
    "offsetCluster",
    "selectedTradeCount",
    "wins",
    "losses",
    "winRate",
    "slHitRate",
    "medianPnlPct",
    "averagePnlPct",
    "baseMedianPnlPct",
    "baseAveragePnlPct",
    "lifecycleMedianPnlPct",
    "lifecycleAveragePnlPct",
    "monthlyAccountReturnPct",
    "maxDrawdownPct",
    "tradeFrequency",
    "runtimeMimicReadiness",
    "liveSafeExpressionStatus",
    "status",
    "reasonsSelected",
    "reasonsRejected",
    "rejectionReasons",
    "promotionBlockers",
    "dynamicExitPlanSummary",
    "targetAchievedBreakdown",
    "paperStageability",
  ]);
}

function compactRuntimeBuildSummary(value: unknown) {
  const summary = asRecord(value);
  if (!Object.keys(summary).length) return value ?? null;
  return {
    ...pickCompactFields(summary, [
      "targetProfileNormalized",
      "rankingObjective",
      "guardrailsPassedCount",
      "topPolicyCount",
      "anyScenarioMaintains90WinAndLowSl",
      "anyScenarioReaches50MonthlyReturn",
      "lifecycleOldMedianPnlPct",
      "lifecycleNewMedianPnlPct",
      "lifecycleOldAveragePnlPct",
      "lifecycleNewAveragePnlPct",
      "lifecycleReplayImprovedTrades",
      "policiesWithMedianLifecyclePnlAbove5",
      "policiesWithMedianLifecyclePnlAbove7",
      "policiesWithMedianLifecyclePnlAbove9",
      "closestScenarioTo50MonthlyReturn",
      "recommendedNextStep",
      "whyHigherCaptureFailed",
      "failedRecoveryShortFinalPassAnswers",
    ]),
    bestAbove5: compactRuntimeBuildScenario(summary.bestAbove5),
    bestAbove7: compactRuntimeBuildScenario(summary.bestAbove7),
    bestAbove9: compactRuntimeBuildScenario(summary.bestAbove9),
    scenariosMeeting90WinAndLowSl: Array.isArray(summary.scenariosMeeting90WinAndLowSl)
      ? summary.scenariosMeeting90WinAndLowSl.slice(0, 10).map((entry) => compactRuntimeBuildScenario(entry))
      : [],
  };
}

function compactRuntimeBuildPolicySummary(value: unknown) {
  const policy = asRecord(value);
  if (!Object.keys(policy).length) return value ?? null;
  return pickCompactFields(policy, [
    "policyId",
    "serviceId",
    "symbol",
    "sourcePool",
    "runtimeFamily",
    "triggerTransition",
    "selectedMoveSizeBucket",
    "direction",
    "offsetCluster",
    "trades",
    "selectedTradeCount",
    "wins",
    "losses",
    "winRate",
    "slHitRate",
    "profitFactor",
    "objectiveScore",
    "medianPnlPct",
    "averagePnlPct",
    "lifecycleMedianPnlPct",
    "lifecycleAveragePnlPct",
    "status",
    "stageability",
    "readiness",
    "blockers",
    "warnings",
  ]);
}

function buildRuntimeBuildResult(serviceId: string, job: EliteSynthesisJobRow, result: EliteSynthesisResult) {
  const resultRecord = result as unknown as Record<string, unknown>;
  const bestPolicySummary = asRecord(result.bestPolicySummary);
  const readiness = asRecord(result.policyArtifactReadiness);
  const returnAmplification = asRecord(result.returnAmplificationAnalysis);
  const returnSummary = asRecord(returnAmplification.summary);
  const recommendedCandidate = asRecord(returnAmplification.recommendedCandidateConfiguration);
  const bestCapitalExtractionCandidate = asRecord(resultRecord.bestCapitalExtractionCandidate ?? returnAmplification.bestCapitalExtractionCandidate);
  const bestPolicyArtifact = asRecord(result.bestPolicyArtifact);
  const candidateArtifacts = Array.isArray(job.candidateRuntimeArtifacts) ? job.candidateRuntimeArtifacts : [];
  const blockers: string[] = [];
  if (readiness.reportConsistencyPassed === false) blockers.push("report_consistency_failed");
  if (readiness.selectedTradesExportPassed === false) blockers.push("selected_trades_export_failed");
  if (readiness.leakagePassed === false) blockers.push("leakage_check_failed");
  if (!bestPolicySummary.policyId) blockers.push("recommended_policy_missing");
  return {
    artifactName: `runtime_build_result_${serviceId}_${job.id}.json`,
    serviceId,
    sourceCalibrationRunId: Number(bestPolicySummary.sourceRunId ?? job.params?.sourceRunId ?? 0) || null,
    sourceDataWindow: {
      windowDays: job.params?.windowDays ?? null,
      startTs: job.params?.startTs ?? null,
      endTs: job.params?.endTs ?? null,
    },
    buildRunId: job.id,
    buildProfile: {
      searchProfile: job.params?.searchProfile ?? null,
      targetProfile: job.params?.targetProfile ?? null,
      maxPasses: job.maxPasses,
    },
    targetObjective: returnAmplification.rankingObjective ?? job.params?.targetProfile ?? "default",
    targetMoveUniverse: resultRecord.targetMoveUniverse ?? returnAmplification.targetMoveUniverse ?? resultRecord.datasetSummary ?? resultRecord.moveUniverseSummary ?? null,
    targetMoveCoverage: resultRecord.largeMoveCoverage ?? returnAmplification.largeMoveCoverage ?? result.targetAchievedBreakdown ?? null,
    largeMoveCoverage: resultRecord.largeMoveCoverage ?? returnAmplification.largeMoveCoverage ?? null,
    missedMoveAnalysis: resultRecord.missedTargetMoveAnalysis ?? returnAmplification.missedTargetMoveAnalysis ?? resultRecord.missedMoveAnalysis ?? resultRecord.calibrationReconciliationSummary ?? null,
    missedTargetMoveAnalysis: resultRecord.missedTargetMoveAnalysis ?? returnAmplification.missedTargetMoveAnalysis ?? null,
    candidateEntryMatrixSummary: resultRecord.candidateEntryMatrixSummary ?? bestPolicyArtifact.entryThresholds ?? null,
    controlSampleSummary: resultRecord.controlSampleSummary ?? null,
    lifecycleSimulationSummary: resultRecord.tradeLifecycleManagerReplay ?? resultRecord.tradeLifecycleReplaySummary ?? recommendedCandidate.dynamicExitPlanSummary ?? null,
    profitRankingSummary: compactRuntimeBuildSummary(returnSummary),
    candidateLeaderboard: resultRecord.policyLeaderboard ?? resultRecord.bestPolicyCandidates ?? [],
    escalatedSeedFamilies: resultRecord.escalatedSeedFamilies ?? returnAmplification.escalatedSeedFamilies ?? [],
    primaryDeepFamilyAnalysis: resultRecord.primaryDeepFamilyAnalysis ?? returnAmplification.primaryDeepFamilyAnalysis ?? null,
    preLimitFamilyStats: resultRecord.preLimitFamilyStats ?? returnAmplification.preLimitFamilyStats ?? null,
    postDailyLimitFamilyStats: resultRecord.postDailyLimitFamilyStats ?? returnAmplification.postDailyLimitFamilyStats ?? null,
    winnerLoserSeparation: resultRecord.winnerLoserSeparation ?? returnAmplification.winnerLoserSeparation ?? [],
    tradeLifecycleManagerReplay: resultRecord.tradeLifecycleManagerReplay ?? returnAmplification.tradeLifecycleManagerReplay ?? null,
    dynamicTpProtectionSummary: resultRecord.dynamicTpProtectionSummary ?? returnAmplification.dynamicTpProtectionSummary ?? null,
    lifecycleHoldAndExhaustionAnalysis: resultRecord.lifecycleHoldAndExhaustionAnalysis ?? returnAmplification.lifecycleHoldAndExhaustionAnalysis ?? null,
    aiStrategyReview: resultRecord.aiStrategyReview ?? returnAmplification.aiStrategyReview ?? null,
    candidateFamilyComparison: resultRecord.candidateFamilyComparison ?? returnAmplification.policyComparisonTable ?? [],
    bestCapitalExtractionCandidate: compactRuntimeBuildScenario(bestCapitalExtractionCandidate),
    runtimeArtifactEligibility: resultRecord.runtimeArtifactEligibility ?? returnAmplification.runtimeArtifactEligibility ?? null,
    reviewCandidateRuntimeArtifact: resultRecord.reviewCandidateRuntimeArtifact ?? null,
    recommendedCandidate: Object.keys(bestCapitalExtractionCandidate).length > 0
      ? compactRuntimeBuildScenario(bestCapitalExtractionCandidate)
      : compactRuntimeBuildPolicySummary(bestPolicySummary),
    safestBaselineCandidate: compactRuntimeBuildScenario(returnAmplification.safestHighWinPolicy),
    bestRejectedProfitCandidate: compactRuntimeBuildScenario(returnAmplification.bestRejectedProfitPolicy),
    runtimeRuleDraft: result.bestPolicyArtifact ?? null,
    liveSafeRuleStatus: {
      status: readiness.liveSafeRuleStatus ?? (blockers.length === 0 ? "ready_for_validation" : "blocked"),
      reportConsistencyPassed: Boolean(readiness.reportConsistencyPassed),
      selectedTradesExportPassed: Boolean(readiness.selectedTradesExportPassed),
    },
    leakageStatus: {
      passed: Boolean(readiness.leakagePassed ?? result.leakageAuditSummary),
      summary: result.leakageAuditSummary ?? null,
    },
    runtimeMimicReadiness: {
      status: candidateArtifacts.some((artifact) => Boolean(artifact.runtimeMimicReady)) ? "ready" : "not_run",
      stagedCandidateArtifactId: candidateArtifacts.find((artifact) => Boolean(artifact.staged))?.artifactId ?? null,
    },
    stageability: {
      canStage: blockers.length === 0,
      requiresManualStage: true,
      autoStage: false,
    },
    reportsGenerated: {
      selectedTrades: Boolean(result.bestPolicySelectedTradesSummary),
      returnProfitAnalysis: Boolean(result.returnAmplificationAnalysis),
      lifecycleReplay: Boolean(resultRecord.tradeLifecycleReplaySummary),
      policyComparison: Boolean(resultRecord.policyComparisonSummary),
    },
    blockers,
    warnings: [
      "Build Runtime Model does not promote runtime or enable any execution mode.",
      "Validate Runtime must pass before Promote Runtime.",
    ],
  };
}

function buildRuntimeValidationResult(serviceId: string, artifact: Record<string, unknown>) {
  const artifactId = String(artifact.artifactId ?? "");
  const readiness = asRecord(artifact.readiness);
  const blockers = [
    "runtime_mimic_validation_not_executed",
    "historical_backtest_not_executed_in_consolidated_validator",
    "parity_check_not_executed_in_consolidated_validator",
    "trigger_validation_not_executed_in_consolidated_validator",
  ];
  return {
    artifactName: `runtime_validation_result_${serviceId}_${Date.now()}.json`,
    stagedCandidateId: artifactId,
    runtimeArtifactId: artifactId,
    validationStatus: "blocked",
    mimicResult: {
      status: artifact.runtimeMimicValidationStatus ?? "not_run",
      ready: Boolean(artifact.runtimeMimicReady ?? false),
    },
    backtestResult: {
      status: "not_run",
      source: "Validate Runtime consolidated contract",
    },
    parityResult: {
      status: "not_run",
      source: "internal parity stage",
    },
    triggerValidationResult: {
      status: "not_run",
      source: "internal runtime trigger validation stage",
    },
    phantomNoiseResult: {
      status: "not_run",
    },
    allocatorPathResult: {
      status: "not_run",
      provenanceRequired: true,
    },
    lifecycleMonitorResult: {
      status: "not_run",
    },
    modeGateResult: {
      paper: Boolean(readiness.canUseForPaper ?? readiness.canUseForServiceRuntime ?? false),
      demo: false,
      real: false,
    },
    blockers,
    warnings: [
      "This validation action is consolidated over existing diagnostic stages and does not change live execution.",
      "Promotion remains a separate explicit service-level action.",
    ],
    canPromoteRuntime: false,
  };
}

function parseParams(input: unknown): EliteSynthesisParams {
  const record = input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
  return {
    calibrationRunId: record.calibrationRunId == null ? null : Number(record.calibrationRunId),
    backtestRunId: record.backtestRunId == null ? null : Number(record.backtestRunId),
    windowDays: record.windowDays == null ? null : Number(record.windowDays),
    startTs: record.startTs == null ? null : Number(record.startTs),
    endTs: record.endTs == null ? null : Number(record.endTs),
    searchProfile: (["fast", "balanced", "deep"].includes(String(record.searchProfile))
      ? record.searchProfile
      : "balanced") as EliteSynthesisParams["searchProfile"],
    targetProfile: (["default", "return_amplification", "return_first"].includes(String(record.targetProfile))
      ? record.targetProfile
      : "default") as EliteSynthesisParams["targetProfile"],
    maxPasses: record.maxPasses == null ? null : Number(record.maxPasses),
    patiencePasses: record.patiencePasses == null ? null : Number(record.patiencePasses),
    targetTradeCountMin: record.targetTradeCountMin == null ? null : Number(record.targetTradeCountMin),
    targetTradeCountMax: record.targetTradeCountMax == null ? null : Number(record.targetTradeCountMax),
    preferredTradeCount: record.preferredTradeCount == null ? null : Number(record.preferredTradeCount),
    maxTradesPerDay: record.maxTradesPerDay == null ? null : Number(record.maxTradesPerDay),
    allowCascade: record.allowCascade == null ? null : Boolean(record.allowCascade),
    objectiveWeights: record.objectiveWeights && typeof record.objectiveWeights === "object" && !Array.isArray(record.objectiveWeights)
      ? (record.objectiveWeights as EliteSynthesisParams["objectiveWeights"])
      : null,
  };
}

function jobDisplayState(job: EliteSynthesisJobRow): string {
  const resultSummary = job.resultSummary && typeof job.resultSummary === "object"
    ? job.resultSummary as Record<string, unknown>
    : {};
  const resultArtifact = job.resultArtifact && typeof job.resultArtifact === "object"
    ? job.resultArtifact as Record<string, unknown>
    : {};
  const resultState = String(resultSummary.resultState ?? resultArtifact.resultState ?? "");
  const targetProfileNormalized = String(resultSummary.targetProfileNormalized ?? resultArtifact.targetProfileNormalized ?? "");
  const recommendedPolicyStatus = String(
    resultSummary.recommendedPolicyStatus
      ?? ((resultArtifact.returnAmplificationAnalysis as Record<string, unknown> | undefined)?.recommendedPolicy as Record<string, unknown> | undefined)?.status
      ?? "",
  );
  if (job.status === "completed") {
    if (!job.hasResultArtifact && !job.resultArtifact) return "completed_missing_artifact";
    if (resultState === "completed_target_achieved") return "completed_target_achieved";
    if (resultState === "completed_exhausted_no_target") {
      if (recommendedPolicyStatus === "baseline_only") return "completed_baseline_only";
      if (targetProfileNormalized === "return_first") return "completed_exhausted_no_target";
    }
    if (resultState) return resultState;
    return "completed_with_artifact";
  }
  if (job.status === "failed" || job.status === "cancelled" || job.status === "queued" || job.status === "running") {
    return job.status;
  }
  return "running";
}

function artifactHealth(job: EliteSynthesisJobRow) {
  const resultArtifact = job.resultArtifact;
  const hasResultArtifact = job.resultArtifactLoaded ? Boolean(resultArtifact) : job.hasResultArtifact;
  const resultSummary = job.resultSummary && typeof job.resultSummary === "object"
    ? job.resultSummary as Record<string, unknown>
    : {};
  const resultState = String(resultSummary.resultState ?? resultArtifact?.resultState ?? "");
  const noTargetDiagnosticRun = resultState === "completed_exhausted_no_target";
  const bestSelectedTrades = Array.isArray(resultArtifact?.bestPolicySelectedTrades)
    ? resultArtifact.bestPolicySelectedTrades
    : [];
  const returnAmplification = resultArtifact?.returnAmplificationAnalysis ?? null;
  const diagnostics: string[] = [];
  if (job.status === "completed" && job.resultArtifactLoaded && !resultArtifact) {
    diagnostics.push("Job status is completed but the result artifact is missing.");
  }
  if (resultArtifact && !resultArtifact.bestPolicySummary && !noTargetDiagnosticRun) {
    diagnostics.push("Result artifact exists but the best policy summary is missing.");
  }
  if (resultArtifact && bestSelectedTrades.length === 0 && !noTargetDiagnosticRun) {
    diagnostics.push("Result artifact exists but the selected trades artifact is empty or missing.");
  }
  if (resultArtifact && !returnAmplification) {
    diagnostics.push("Result artifact exists but the return/lifecycle amplification report is missing.");
  }
  return {
    displayState: jobDisplayState(job),
    artifactStatus: {
      resultArtifact: hasResultArtifact,
      selectedTradesArtifact: bestSelectedTrades.length > 0,
      returnAmplificationArtifact: Boolean(returnAmplification),
      candidateRuntimeArtifacts: job.candidateRuntimeArtifactsCount,
      baselineRecords: job.baselineRecordsCount,
    },
    artifactDiagnostics: diagnostics,
  };
}

function synthesisJobMetadata(job: EliteSynthesisJobRow) {
  const params = (job.params ?? {}) as Record<string, unknown>;
  return {
    windowDays: Number(params.windowDays ?? 0) || null,
    searchProfile: String(params.searchProfile ?? "balanced"),
    targetProfile: String(params.targetProfile ?? "default"),
    startedAt: job.startedAt ?? null,
    completedAt: job.completedAt ?? null,
  };
}

function buildExportMetadata(job: EliteSynthesisJobRow, reportType: string) {
  const meta = synthesisJobMetadata(job);
  const health = artifactHealth(job);
  const resultSummary = job.resultSummary && typeof job.resultSummary === "object"
    ? job.resultSummary as Record<string, unknown>
    : {};
  return {
    serviceId: job.serviceId,
    jobId: job.id,
    reportType,
    windowDays: meta.windowDays,
    searchProfile: meta.searchProfile,
    targetProfile: meta.targetProfile,
    targetProfileNormalized: String(resultSummary.targetProfileNormalized ?? ""),
    startedAt: meta.startedAt,
    completedAt: meta.completedAt,
    exportedAt: new Date().toISOString(),
    artifactStatus: health.artifactStatus,
    artifactDiagnostics: health.artifactDiagnostics,
  };
}

function readStoredSelectedTrades(job: EliteSynthesisJobRow): Array<Record<string, unknown>> {
  const selected = job.resultArtifact?.bestPolicySelectedTrades;
  return Array.isArray(selected) ? selected.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object")) : [];
}

async function loadLifecycleReplayCandles(job: EliteSynthesisJobRow, selectedTrades: Array<Record<string, unknown>>): Promise<CandleRow[]> {
  if (selectedTrades.length === 0) return [];
  const minEntryTs = Math.min(...selectedTrades.map((trade) => Number(trade.entryTs ?? 0)).filter((value) => Number.isFinite(value) && value > 0));
  const maxExitTs = Math.max(...selectedTrades.map((trade) => Number(
    trade.sourceMoveEndTs ?? trade.moveEndTs ?? trade.exitTs ?? trade.entryTs ?? 0,
  )).filter((value) => Number.isFinite(value) && value > 0));
  if (!Number.isFinite(minEntryTs) || !Number.isFinite(maxExitTs) || minEntryTs <= 0 || maxExitTs <= 0) return [];
  const symbol = String(job.symbol ?? job.serviceId ?? "").toUpperCase();
  const rows = await backgroundDb
    .select({
      openTs: candlesTable.openTs,
      closeTs: candlesTable.closeTs,
      open: candlesTable.open,
      high: candlesTable.high,
      low: candlesTable.low,
      close: candlesTable.close,
    })
    .from(candlesTable)
    .where(and(
      eq(candlesTable.symbol, symbol),
      eq(candlesTable.timeframe, "1m"),
      eq(candlesTable.isInterpolated, false),
      gte(candlesTable.openTs, Math.max(0, minEntryTs - 3600)),
      lte(candlesTable.openTs, maxExitTs + 3600),
    ))
    .orderBy(asc(candlesTable.openTs));
  return rows.map((row) => ({
    openTs: Number(row.openTs),
    closeTs: Number(row.closeTs ?? (Number(row.openTs) + 60)),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
  }));
}

async function synthesizeTradeLifecycleReplayReport(job: EliteSynthesisJobRow) {
  const existing = (job.resultArtifact?.returnAmplificationAnalysis as Record<string, unknown> | undefined)?.tradeLifecycleReplayReport;
  if (existing && typeof existing === "object") return existing;
  const selectedTrades = readStoredSelectedTrades(job);
  if (selectedTrades.length === 0) return null;
  const candles = await loadLifecycleReplayCandles(job, selectedTrades);
  if (candles.length === 0) return null;
  return buildTradeLifecycleReplayReportFromStoredTrades({
    serviceId: job.serviceId,
    sourceJobId: job.id,
    sourcePolicyId: String((job.resultArtifact?.bestPolicySummary as Record<string, unknown> | undefined)?.policyId ?? "") || null,
    selectedTrades,
    candles,
  });
}

async function buildHydratedResultArtifact(job: EliteSynthesisJobRow): Promise<EliteSynthesisResult | null> {
  if (!job.resultArtifact) return null;
  const storedReturnAmplification = job.resultArtifact.returnAmplificationAnalysis && typeof job.resultArtifact.returnAmplificationAnalysis === "object"
    ? job.resultArtifact.returnAmplificationAnalysis as Record<string, unknown>
    : null;
  const storedLifecycleReplay = storedReturnAmplification?.tradeLifecycleReplayReport;
  const lifecycleReplayNeedsHydration = !storedLifecycleReplay
    || typeof storedLifecycleReplay !== "object"
    || !Array.isArray((storedLifecycleReplay as Record<string, unknown>).trades)
    || ((storedLifecycleReplay as Record<string, unknown>).trades as unknown[]).length === 0;
  const lifecycleReplayReport = lifecycleReplayNeedsHydration
    ? await synthesizeTradeLifecycleReplayReport(job)
    : storedLifecycleReplay;
  const returnAmplificationAnalysis = job.resultArtifact.returnAmplificationAnalysis && typeof job.resultArtifact.returnAmplificationAnalysis === "object"
    ? {
        ...(job.resultArtifact.returnAmplificationAnalysis as Record<string, unknown>),
        ...(lifecycleReplayReport ? { tradeLifecycleReplayReport: lifecycleReplayReport } : {}),
      }
    : (lifecycleReplayReport ? { tradeLifecycleReplayReport: lifecycleReplayReport } : null);
  return {
    ...job.resultArtifact,
    returnAmplificationAnalysis,
  } as EliteSynthesisResult;
}

async function resolveCurrentStagedCandidate(serviceId: string) {
  const stagedState = await readStagedSynthesisCandidateState(serviceId);
  if (!stagedState) return null;
  const located = await findCandidateRuntimeArtifact(serviceId, stagedState.artifactId);
  if (!located) {
    return {
      ...stagedState,
      artifactMissing: true,
    };
  }
  return {
    ...stagedState,
    artifactMissing: false,
    artifact: located.artifact,
  };
}

router.get("/research/elite-synthesis/schema-status", async (_req, res): Promise<void> => {
  try {
    const status = await getEliteSynthesisSchemaStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Elite synthesis schema status failed" });
  }
});

router.get("/research/:serviceId/elite-synthesis/dataset-summary", async (req, res): Promise<void> => {
  try {
    const serviceId = String(req.params.serviceId ?? "").toUpperCase();
    getSynthesisAdapter(serviceId);
    const windowDays = Math.max(7, Number(req.query.windowDays ?? 90));
    const endTs = Number(req.query.endTs ?? Math.floor(Date.now() / 1000));
    const startTs = Number(req.query.startTs ?? Math.max(0, endTs - windowDays * 86400));
    const dataset = await buildUnifiedCrash300Dataset({
      calibrationRunId: req.query.calibrationRunId == null ? null : Number(req.query.calibrationRunId),
      backtestRunId: req.query.backtestRunId == null ? null : Number(req.query.backtestRunId),
      startTs,
      endTs,
      windowDays,
    });
    res.json({
      serviceId,
      symbol: dataset.symbol,
      displayName: dataset.displayName,
      summary: dataset.summary,
      sourceRunIds: dataset.sourceRunIds,
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Elite synthesis dataset summary failed" });
  }
});

router.get("/research/:serviceId/elite-synthesis/jobs", async (req, res): Promise<void> => {
  const serviceId = String(req.params.serviceId ?? "").toUpperCase();
  try {
    getSynthesisAdapter(serviceId);
    const limit = Math.max(1, Number(req.query.limit ?? 10));
    const jobs = await listEliteSynthesisJobs(serviceId, limit);
    res.json({
      serviceId,
      jobs: jobs.map((job) => ({
        id: job.id,
        serviceId: job.serviceId,
        symbol: job.symbol,
        status: job.status,
        stage: job.stage,
        progressPct: job.progressPct,
        currentPass: job.currentPass,
        maxPasses: job.maxPasses,
        message: job.message,
        createdAt: job.createdAt,
        heartbeatAt: job.heartbeatAt,
        resultSummary: job.resultSummary,
        candidateRuntimeArtifactsCount: job.candidateRuntimeArtifactsCount,
        baselineRecordsCount: job.baselineRecordsCount,
        ...synthesisJobMetadata(job),
        ...artifactHealth(job),
      })),
    });
  } catch (err) {
    logEliteSynthesisRouteError("elite_synthesis_jobs_list", err, {
      serviceId,
      selectsTaskState: false,
      selectsResultArtifact: false,
      selectedFields: "scalar summary projection",
    });
    res.status(400).json({ error: err instanceof Error ? err.message : "Elite synthesis job list failed" });
  }
});

router.get("/research/:serviceId/elite-synthesis/job-size-diagnostics", async (req, res): Promise<void> => {
  const serviceId = String(req.params.serviceId ?? "").toUpperCase();
  try {
    getSynthesisAdapter(serviceId);
    const limit = Math.max(1, Number(req.query.limit ?? 50));
    const rows = await getEliteSynthesisJobSizeDiagnostics(serviceId, limit);
    res.json({
      serviceId,
      taskType: "elite_synthesis",
      selectedFields: [
        "id",
        "status",
        "stage",
        "params windowDays/searchProfile/targetProfile",
        "pg_column_size(task_state)",
        "pg_column_size(result_artifact)",
        "pg_column_size(result_summary)",
        "pg_column_size(error_summary)",
        "created_at",
        "completed_at",
      ],
      rows,
    });
  } catch (err) {
    logEliteSynthesisRouteError("elite_synthesis_job_size_diagnostics", err, {
      serviceId,
      selectsTaskState: false,
      selectsResultArtifact: false,
      selectedFields: "pg_column_size diagnostics",
    });
    res.status(400).json({ error: err instanceof Error ? err.message : "Elite synthesis size diagnostics failed" });
  }
});

router.post("/research/:serviceId/elite-synthesis/jobs", async (req, res): Promise<void> => {
  const serviceId = String(req.params.serviceId ?? "").toUpperCase();
  try {
    await ensureEliteSynthesisJobsTable();
    const adapter = getSynthesisAdapter(serviceId);
    const params = parseParams(req.body);
    const defaults = profileDefaults(params.searchProfile ?? "balanced");
    const maxPasses: number = Number(params.maxPasses ?? defaults.maxPasses);
    const jobId = await createEliteSynthesisJob({
      serviceId,
      symbol: adapter.symbol,
      jobParams: params,
      maxPasses,
    });
    res.status(202).json({
      jobId,
      serviceId,
      symbol: adapter.symbol,
      status: "queued",
      defaults,
    });
  } catch (err) {
    logEliteSynthesisRouteError("elite_synthesis_jobs_create", err, {
      serviceId,
      selectsTaskState: false,
      selectsResultArtifact: false,
      selectedFields: "insert only",
    });
    res.status(400).json({ error: err instanceof Error ? err.message : "Elite synthesis job start failed" });
  }
});

router.get("/research/:serviceId/elite-synthesis/jobs/:id", async (req, res): Promise<void> => {
  const serviceId = String(req.params.serviceId ?? "").toUpperCase();
  const jobId = Number(req.params.id);
  try {
    getSynthesisAdapter(serviceId);
    const job = await getEliteSynthesisProgress(jobId);
    if (!job || job.serviceId !== serviceId) {
      res.status(404).json({ error: `Elite synthesis job ${jobId} not found for ${serviceId}.` });
      return;
    }
    res.json({ job });
  } catch (err) {
    logEliteSynthesisRouteError("elite_synthesis_job_progress", err, {
      serviceId,
      jobId,
      selectsTaskState: false,
      selectsResultArtifact: false,
      selectedFields: "scalar summary projection",
    });
    res.status(400).json({ error: err instanceof Error ? err.message : "Elite synthesis job status failed" });
  }
});

router.post("/research/:serviceId/elite-synthesis/jobs/:id/cancel", async (req, res): Promise<void> => {
  try {
    const serviceId = String(req.params.serviceId ?? "").toUpperCase();
    getSynthesisAdapter(serviceId);
    const jobId = Number(req.params.id);
    const job = await getEliteSynthesisJob(jobId);
    if (!job || job.serviceId !== serviceId) {
      res.status(404).json({ error: `Elite synthesis job ${jobId} not found for ${serviceId}.` });
      return;
    }
    await markEliteSynthesisJobCancelled(jobId);
    res.json({ ok: true, jobId, status: "cancelled" });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Elite synthesis cancellation failed" });
  }
});

router.get("/research/:serviceId/elite-synthesis/jobs/:id/result", async (req, res): Promise<void> => {
  const serviceId = String(req.params.serviceId ?? "").toUpperCase();
  const jobId = Number(req.params.id);
  try {
    getSynthesisAdapter(serviceId);
    const job = await getEliteSynthesisJobSummary(jobId);
    if (!job || job.serviceId !== serviceId) {
      res.status(404).json({ error: `Elite synthesis job ${jobId} not found for ${serviceId}.` });
      return;
    }
    const stagedCandidate = await resolveCurrentStagedCandidate(serviceId);
    const health = artifactHealth(job);
    const resultSummary = job.resultSummary && typeof job.resultSummary === "object"
      ? job.resultSummary as Record<string, unknown>
      : {};
    const bestSummary = job.bestSummary && typeof job.bestSummary === "object"
      ? job.bestSummary as Record<string, unknown>
      : {};
    res.json({
      jobId,
      serviceId,
      status: job.status,
      stage: job.stage,
      message: job.message,
      selectedJob: {
        jobId: job.id,
        ...synthesisJobMetadata(job),
        displayState: health.displayState,
      },
      artifactStatus: health.artifactStatus,
      artifactDiagnostics: health.artifactDiagnostics,
      currentStagedCandidate: stagedCandidate,
      result: {
        jobId: job.id,
        serviceId: job.serviceId,
        status: job.status,
        resultState: resultSummary.resultState ?? null,
        targetAchieved: resultSummary.targetAchieved ?? null,
        bestPolicySummary: {
          policyId: bestSummary.bestPolicyId ?? null,
          trades: bestSummary.bestTradeCount ?? null,
          winRate: bestSummary.bestWinRate ?? null,
          slHitRate: bestSummary.bestSlRate ?? null,
          profitFactor: bestSummary.bestProfitFactor ?? null,
          objectiveScore: bestSummary.bestObjectiveScore ?? null,
        },
        topPolicySummaries: [],
        bottleneckSummary: resultSummary.bottleneck ? { classification: resultSummary.bottleneck } : null,
        leakageAuditSummary: null,
        validationErrors: [],
        dataAvailability: null,
        unitValidation: null,
        missingFeatureImplementations: [],
        windowSummary: synthesisJobMetadata(job),
        sourceRunIds: null,
        datasetSummary: null,
        passLogSummary: null,
        fullPassLog: null,
        featureDistributions: null,
        triggerRebuildSummary: null,
        rebuiltTriggerDiagnostics: null,
        exitOptimisationTable: null,
        bestPolicySelectedTradesSummary: null,
        targetAchievedBreakdown: {
          finalTargetAchieved: Boolean(resultSummary.targetAchieved),
        },
        strategyGradeReadiness: null,
        policyArtifactReadiness: null,
        validationHardeningGuard: null,
        returnAmplificationAnalysis: {
          targetProfileNormalized: resultSummary.targetProfileNormalized ?? null,
          recommendedPolicy: resultSummary.recommendedPolicyStatus ? { status: resultSummary.recommendedPolicyStatus } : null,
          summary: {
            guardrailsPassedCount: resultSummary.guardrailsPassedCount ?? null,
            topPolicyCount: resultSummary.topPolicyCount ?? null,
          },
        },
        candidateRuntimeArtifacts: job.candidateRuntimeArtifacts,
        baselineRecords: job.baselineRecords,
        selectedJob: {
          jobId: job.id,
          ...synthesisJobMetadata(job),
          displayState: health.displayState,
        },
        artifactStatus: health.artifactStatus,
        artifactDiagnostics: health.artifactDiagnostics,
        currentStagedCandidate: stagedCandidate,
      },
    });
  } catch (err) {
    logEliteSynthesisRouteError("elite_synthesis_job_result_summary", err, {
      serviceId,
      jobId,
      selectsTaskState: false,
      selectsResultArtifact: false,
      selectedFields: "scalar summary projection",
    });
    res.status(400).json({ error: err instanceof Error ? err.message : "Elite synthesis result fetch failed" });
  }
});

router.get("/research/:serviceId/elite-synthesis/jobs/:id/export/selected-trades", async (req, res): Promise<void> => {
  try {
    const serviceId = String(req.params.serviceId ?? "").toUpperCase();
    getSynthesisAdapter(serviceId);
    const jobId = Number(req.params.id);
    const job = await getEliteSynthesisJob(jobId);
    if (!job || job.serviceId !== serviceId) {
      res.status(404).json({ error: `Elite synthesis job ${jobId} not found for ${serviceId}.` });
      return;
    }
    if (!job.resultArtifact) {
      res.status(409).json({ error: `Elite synthesis job ${jobId} has no completed result artifact yet.` });
      return;
    }
    sendJsonOrTooLarge(res, "elite_synthesis_export_selected_trades", {
      ...buildExportMetadata(job, "selected_trades"),
      status: job.status,
      policyId: (job.resultArtifact.bestPolicySummary as Record<string, unknown> | undefined)?.policyId ?? null,
      sourcePool: (job.resultArtifact.bestPolicySummary as Record<string, unknown> | undefined)?.sourcePool ?? null,
      policyArtifactReadiness: job.resultArtifact.policyArtifactReadiness ?? null,
      bestPolicySelectedTradesSummary: job.resultArtifact.bestPolicySelectedTradesSummary ?? null,
      bestPolicySelectedTrades: job.resultArtifact.bestPolicySelectedTrades ?? [],
    }, {
      serviceId,
      jobId,
      selectsTaskState: true,
      selectsResultArtifact: true,
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Elite synthesis selected-trades export failed" });
  }
});

router.get("/research/:serviceId/elite-synthesis/jobs/:id/export/policy-comparison", async (req, res): Promise<void> => {
  try {
    const serviceId = String(req.params.serviceId ?? "").toUpperCase();
    getSynthesisAdapter(serviceId);
    const jobId = Number(req.params.id);
    const job = await getEliteSynthesisJob(jobId);
    if (!job || job.serviceId !== serviceId) {
      res.status(404).json({ error: `Elite synthesis job ${jobId} not found for ${serviceId}.` });
      return;
    }
    if (!job.resultArtifact) {
      res.status(409).json({ error: `Elite synthesis job ${jobId} has no completed result artifact yet.` });
      return;
    }
    const hydrated = await buildHydratedResultArtifact(job);
    const returnAmplificationAnalysis = hydrated?.returnAmplificationAnalysis && typeof hydrated.returnAmplificationAnalysis === "object"
      ? hydrated.returnAmplificationAnalysis as Record<string, unknown>
      : {};
    sendJsonOrTooLarge(res, "elite_synthesis_export_policy_comparison", {
      ...buildExportMetadata(job, "return_first_policy_comparison"),
      status: job.status,
      resultState: hydrated?.resultState ?? null,
      targetAchieved: hydrated?.targetAchieved ?? false,
      targetProfile: (hydrated?.windowSummary as Record<string, unknown> | undefined)?.targetProfile ?? "default",
      targetProfileNormalized: String(returnAmplificationAnalysis.targetProfileNormalized ?? hydrated?.targetProfileNormalized ?? "default"),
      rankingObjective: returnAmplificationAnalysis.rankingObjective ?? null,
      swingCaptureGuardrails: returnAmplificationAnalysis.swingCaptureGuardrails ?? null,
      safestHighWinPolicy: returnAmplificationAnalysis.safestHighWinPolicy ?? null,
      bestReturnFirstPolicy: returnAmplificationAnalysis.bestReturnFirstPolicy ?? null,
      bestRejectedProfitPolicy: returnAmplificationAnalysis.bestRejectedProfitPolicy ?? null,
      recommendedPolicy: returnAmplificationAnalysis.recommendedPolicy ?? null,
      policyComparisonTable: Array.isArray(returnAmplificationAnalysis.policyComparisonTable)
        ? returnAmplificationAnalysis.policyComparisonTable
        : [],
      tradeLifecycleReplayReport: returnAmplificationAnalysis.tradeLifecycleReplayReport ?? null,
      summary: returnAmplificationAnalysis.summary ?? null,
    }, {
      serviceId,
      jobId,
      selectsTaskState: true,
      selectsResultArtifact: true,
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Elite synthesis policy comparison export failed" });
  }
});

router.post("/research/:serviceId/elite-synthesis/jobs/:id/stage-candidate-runtime", async (req, res): Promise<void> => {
  try {
    const serviceId = String(req.params.serviceId ?? "").toUpperCase();
    getSynthesisAdapter(serviceId);
    const jobId = Number(req.params.id);
    const job = await getEliteSynthesisJob(jobId);
    if (!job || job.serviceId !== serviceId) {
      res.status(404).json({ error: `Elite synthesis job ${jobId} not found for ${serviceId}.` });
      return;
    }
    const result = job.resultArtifact;
    if (!result?.bestPolicyArtifact || !result.bestPolicySummary) {
      res.status(409).json({ error: `Elite synthesis job ${jobId} does not have a stageable best policy yet.` });
      return;
    }
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? req.body as Record<string, unknown>
      : {};
    const readiness = (result.policyArtifactReadiness
      ?? (result.bestPolicySummary as Record<string, unknown>).policyArtifactReadiness
      ?? {}) as Record<string, unknown>;
    const manualStageApproved = Boolean(body.manualStageApproved) || serviceId === "CRASH300";
    const manualStageReason = String(
      body.manualStageReason
      ?? "Portfolio baseline handover; CRASH300 candidate is high-quality but not final/live-approved.",
    );
    const canForceBaselinePaperStage = serviceId === "CRASH300"
      && manualStageApproved
      && Boolean(readiness.reportConsistencyPassed)
      && Boolean(readiness.selectedTradesExportPassed)
      && Boolean(readiness.leakagePassed);
    if (!Boolean(readiness.reportConsistencyPassed) || (!Boolean(readiness.canStageForPaper) && !canForceBaselinePaperStage)) {
      res.status(409).json({
        error: "Best synthesis candidate failed paper staging readiness checks.",
        policyArtifactReadiness: readiness,
        manualStageApproved,
        manualStageReason,
      });
      return;
    }
    const selectedTrades = Array.isArray(result.bestPolicySelectedTrades) ? result.bestPolicySelectedTrades : [];
    const selectedTradeIds = selectedTrades.map((trade) => String((trade as Record<string, unknown>).candidateId ?? (trade as Record<string, unknown>).tradeId ?? "")).filter(Boolean);
    const artifactId = `crash300-v3-1-runtime-candidate-${jobId}-${Date.now()}`;
    const reportConsistencyChecks = ((result.bestPolicySelectedTradesSummary as Record<string, unknown> | undefined)?.reportConsistencyChecks ?? {}) as Record<string, unknown>;
    const dynamicExitPlanSummary = ((result.returnAmplificationAnalysis as Record<string, unknown> | undefined)?.recommendedCandidateConfiguration as Record<string, unknown> | undefined)?.dynamicExitPlanSummary ?? null;
    const returnAmplificationSummary = ((result.returnAmplificationAnalysis as Record<string, unknown> | undefined)?.summary ?? null) as Record<string, unknown> | null;
    const stagedReadiness = {
      canUseForPaper: true,
      canUseForDemo: false,
      canUseForReal: false,
      canPromoteLive: false,
      runtimeMimicValidationStatus: "not_run",
      runtimeMimicReady: false,
      blocker: "Candidate staged for service runtime review; runtime mimic validation still required before wider mode gates.",
      reason: "V3.1 CRASH300 baseline candidate for service runtime validation",
    };
    const artifact = {
      artifactId,
      artifactType: "crash300_v3_1_service_runtime_candidate",
      mode: "service_runtime_candidate",
      version: "v3.1",
      runtimeMimicReady: false,
      runtimeMimicValidationStatus: "not_run",
      runtimeMimicBlockers: [
        "Candidate policy still needs explicit live-safe trigger expression before runtime mimic can trade.",
      ],
      serviceId,
      sourceSynthesisJobId: jobId,
      sourcePolicyId: result.bestPolicySummary.policyId,
      sourceRunIds: result.sourceRunIds,
      generatedAt: new Date().toISOString(),
      targetAchieved: result.targetAchieved,
      policyArtifactReadiness: readiness,
      manualStageApproved,
      manualStageReason,
      selectedPolicy: {
        sourcePool: (result.bestPolicySummary as Record<string, unknown>).sourcePool ?? "rebuilt_trigger_candidates",
        runtimeArchetype: result.bestPolicyArtifact.selectedRuntimeArchetypes?.[0] ?? null,
        triggerTransition: result.bestPolicyArtifact.selectedTriggerTransitions?.[0] ?? null,
        selectedBucket: result.bestPolicyArtifact.selectedBuckets?.[0] ?? null,
        selectedMoveSizeBucket: result.bestPolicyArtifact.selectedMoveSizeBuckets?.[0] ?? null,
        direction: ((result.bestPolicyArtifact.entryThresholds as Record<string, unknown>).selectedDirections as string[] | undefined)?.[0] ?? null,
        offsetCluster: ((result.bestPolicyArtifact.entryThresholds as Record<string, unknown>).offsetClusters as string[] | undefined)?.[0] ?? null,
        selectedFeatures: result.bestPolicyArtifact.selectedCoreFeatures,
        entryThresholds: result.bestPolicyArtifact.entryThresholds,
        noTradeRules: result.bestPolicyArtifact.noTradeRules,
        dailyTradeLimit: result.bestPolicyArtifact.dailyTradeLimit,
        cascadeRules: { ...result.bestPolicyArtifact.cascadeRules, enabled: false },
        exitRules: {
          tpRules: result.bestPolicyArtifact.tpRules,
          slRules: result.bestPolicyArtifact.slRules,
          lifecycleManagerRules: result.bestPolicyArtifact.lifecycleManagerRules ?? result.bestPolicyArtifact.trailingRules,
          minHoldRules: result.bestPolicyArtifact.minHoldRules,
        },
        minHoldRules: result.bestPolicyArtifact.minHoldRules,
        dynamicExitPlanSummary,
        returnAmplificationSummary,
      },
      expectedPerformance: {
        trades: result.bestPolicySummary.trades,
        wins: result.bestPolicySummary.wins,
        losses: result.bestPolicySummary.losses,
        winRate: result.bestPolicySummary.winRate,
        slHitRate: result.bestPolicySummary.slHitRate,
        profitFactor: result.bestPolicySummary.profitFactor,
        accountReturnPct: result.bestPolicySummary.accountReturnPct,
        averageMonthlyAccountReturnPct: Number((result.bestPolicySummary as Record<string, unknown>).averageMonthlyAccountReturnPct ?? 0),
        maxDrawdownPct: result.bestPolicySummary.maxDrawdownPct,
        monthlyBreakdown: result.bestPolicyArtifact.monthlyBreakdown ?? [],
      },
      selectedTradeIds,
      selectedTradesChecksum: stableChecksum(selectedTradeIds),
      reportConsistencyChecksum: stableChecksum((result.bestPolicySelectedTradesSummary as Record<string, unknown> | undefined)?.reportConsistencyChecks ?? {}),
      reportConsistencyChecks,
      leakageAudit: result.leakageAuditSummary,
      exitDerivationAudit: (result.bestPolicySummary as Record<string, unknown>).exitDerivationAudit ?? null,
      lateOffsetSafetyAudit: (result.bestPolicySummary as Record<string, unknown>).lateOffsetSafetyAudit ?? null,
      calibratedRelationshipSummary: (result.bestPolicySummary as Record<string, unknown>).calibratedMoveRelationshipSummary ?? null,
      readiness: stagedReadiness,
    };
    const baselineRecord = {
      version: "v3.1",
      serviceId,
      baselineType: "service_runtime_candidate",
      sourceJobId: jobId,
      sourcePolicyId: result.bestPolicySummary.policyId,
      createdAt: new Date().toISOString(),
      artifactId,
      runtimeMimicValidationStatus: "not_run",
      runtimeMimicReady: false,
      notes: [
        "CRASH300 is preserved as current best baseline while pipeline moves to R_75.",
        "Further CRASH300 squeezing deferred until all active services have runtime candidates.",
      ],
      metricsSnapshot: {
        trades: result.bestPolicySummary.trades,
        wins: result.bestPolicySummary.wins,
        losses: result.bestPolicySummary.losses,
        winRate: result.bestPolicySummary.winRate,
        slHitRate: result.bestPolicySummary.slHitRate,
        profitFactor: result.bestPolicySummary.profitFactor,
        accountReturnPct: result.bestPolicySummary.accountReturnPct,
        averageMonthlyAccountReturnPct: Number((result.bestPolicySummary as Record<string, unknown>).averageMonthlyAccountReturnPct ?? 0),
        maxDrawdownPct: result.bestPolicySummary.maxDrawdownPct,
      },
    };
    const serviceJobs = await listEliteSynthesisJobs(serviceId, 200);
    for (const serviceJob of serviceJobs) {
      if (!Array.isArray(serviceJob.candidateRuntimeArtifacts) || serviceJob.candidateRuntimeArtifacts.length === 0) continue;
      const normalized = serviceJob.candidateRuntimeArtifacts.map((item) => ({
        ...item,
        staged: false,
      }));
      const changed = normalized.some((item, index) => item.staged !== serviceJob.candidateRuntimeArtifacts[index]?.staged);
      if (changed) {
        await updateEliteSynthesisJob(serviceJob.id, {
          taskStatePatch: {
            candidateRuntimeArtifacts: normalized,
          },
        });
      }
    }
    const nextArtifacts = [...job.candidateRuntimeArtifacts.map((item) => ({ ...item, staged: false })), { ...artifact, staged: true }];
    const nextBaselineRecords = [
      ...job.baselineRecords.filter((record) => !(String(record.version ?? "") === "v3.1" && String(record.serviceId ?? "") === serviceId)),
      baselineRecord,
    ];
    await updateEliteSynthesisJob(jobId, {
      taskStatePatch: {
        candidateRuntimeArtifacts: nextArtifacts,
        baselineRecords: nextBaselineRecords,
      },
    });
    await writeStagedSynthesisCandidateState({
      serviceId,
      artifactId,
      jobId,
      sourcePolicyId: result.bestPolicySummary.policyId ?? null,
      stagedAt: new Date().toISOString(),
    });
    res.status(202).json({
      ok: true,
      artifact,
      baselineRecord,
      note: "Runtime candidate staged. Not promoted.",
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Candidate runtime staging failed" });
  }
});

router.post("/research/:serviceId/elite-synthesis/candidate-runtime/:artifactId/validate-backtest", async (req, res): Promise<void> => {
  try {
    const serviceId = String(req.params.serviceId ?? "").toUpperCase();
    getSynthesisAdapter(serviceId);
    const artifactId = String(req.params.artifactId ?? "");
    const stagedState = await readStagedSynthesisCandidateState(serviceId);
    if (!stagedState || String(stagedState.artifactId ?? "") !== artifactId) {
      res.status(409).json({
        error: "Candidate runtime promotion must use the currently staged synthesis candidate for the service.",
        stagedCandidateArtifactId: stagedState?.artifactId ?? null,
      });
      return;
    }
    const located = await findCandidateRuntimeArtifact(serviceId, artifactId);
    if (!located) {
      res.status(404).json({ error: `Candidate runtime artifact ${artifactId} not found for ${serviceId}.` });
      return;
    }
    const artifact = located.artifact;
    res.status(202).json({
      artifactId,
      serviceId,
      runtimeValidationResult: buildRuntimeValidationResult(serviceId, artifact),
      candidateRuntimeValidation: {
        artifactId,
        sourceSynthesisJobId: artifact.sourceSynthesisJobId ?? null,
        sourcePolicyId: artifact.sourcePolicyId ?? null,
        backtestWindow: {
          windowDays: 90,
        },
        trades: null,
        wins: null,
        losses: null,
        winRate: null,
        slHitRate: null,
        profitFactor: null,
        accountReturnPct: null,
        parityToSynthesis: {
          synthesisTrades: Array.isArray(artifact.selectedTradeIds) ? artifact.selectedTradeIds.length : 0,
          runtimeTrades: null,
          matchedEntryCount: null,
          unmatchedSynthesisEntries: null,
          extraRuntimeEntries: null,
          pnlDifference: null,
          exitReasonDifferences: [],
          parityPassed: false,
        },
        runtimeMimicValidationStatus: artifact.runtimeMimicValidationStatus ?? "not_run",
        runtimeMimicReady: Boolean(artifact.runtimeMimicReady ?? false),
        blockers: [
          "Candidate runtime mimic path is not ready because explicit live-safe trigger expression is still pending.",
        ],
        warnings: [
          "Validation backtest contract is available, but the runtime mimic executor remains intentionally blocked until the live-safe trigger expression is explicit.",
        ],
      },
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Candidate runtime validation failed" });
  }
});

router.post("/research/:serviceId/runtime-validation/run", async (req, res): Promise<void> => {
  try {
    const serviceId = String(req.params.serviceId ?? "").toUpperCase();
    getSynthesisAdapter(serviceId);
    const stagedState = await readStagedSynthesisCandidateState(serviceId);
    if (!stagedState) {
      const latestReview = await findLatestReviewCandidateRuntimeArtifact(serviceId);
      if (!latestReview) {
        res.status(409).json({
          error: "Validate Runtime requires a staged or review runtime candidate for the service.",
          runtimeValidationResult: null,
        });
        return;
      }
      const runtimeValidationResult = buildRuntimeValidationResult(serviceId, latestReview.artifact);
      res.status(202).json({
        ok: true,
        serviceId,
        runtimeValidationResult,
        note: "Validate Runtime reviewed the latest Build Runtime Model candidate. It did not stage, promote, or change execution mode.",
      });
      return;
    }
    let located = await findCandidateRuntimeArtifact(serviceId, stagedState.artifactId);
    if (!located) {
      located = await findLatestReviewCandidateRuntimeArtifact(serviceId);
      if (!located) {
        res.status(404).json({
          error: `Staged runtime candidate ${stagedState.artifactId} could not be resolved for ${serviceId}, and no review candidate exists.`,
        });
        return;
      }
    }
    const runtimeValidationResult = buildRuntimeValidationResult(serviceId, located.artifact);
    res.status(202).json({
      ok: true,
      serviceId,
      runtimeValidationResult,
      note: "Validate Runtime returned a consolidated validation artifact over existing diagnostic stages. It did not promote runtime or change execution mode.",
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Validate Runtime failed" });
  }
});

router.post("/research/:serviceId/elite-synthesis/candidate-runtime/:artifactId/promote-runtime", async (req, res): Promise<void> => {
  try {
    const serviceId = String(req.params.serviceId ?? "").toUpperCase();
    getSynthesisAdapter(serviceId);
    const artifactId = String(req.params.artifactId ?? "");
    const located = await findCandidateRuntimeArtifact(serviceId, artifactId);
    if (!located) {
      res.status(404).json({ error: `Candidate runtime artifact ${artifactId} not found for ${serviceId}.` });
      return;
    }
    const artifact = located.artifact;
    const readiness = (artifact.readiness && typeof artifact.readiness === "object")
      ? artifact.readiness as Record<string, unknown>
      : {};
    const reportConsistencyChecks = (artifact.reportConsistencyChecks && typeof artifact.reportConsistencyChecks === "object")
      ? artifact.reportConsistencyChecks as Record<string, unknown>
      : {};
    if (reportConsistencyChecks.reportConsistencyPassed === false) {
      res.status(409).json({
        error: "Candidate runtime cannot be promoted because report consistency failed.",
        reportConsistencyChecks,
      });
      return;
    }
    if (serviceId === "CRASH300" && readiness.canUseForPaper === false) {
      res.status(409).json({
        error: "CRASH300 candidate runtime is not approved for service runtime staging.",
        readiness,
      });
      return;
    }
    const promotedRuntime = await promoteCandidateArtifactToServiceRuntime(serviceId, artifact);
    await db
      .insert(platformStateTable)
      .values({ key: "use_calibrated_runtime_profiles", value: "true" })
      .onConflictDoUpdate({
        target: platformStateTable.key,
        set: { value: "true", updatedAt: new Date() },
      });
    res.status(202).json({
      ok: true,
      serviceId,
      promotedRuntime,
      note: "Promoted runtime is universal to the service. Mode gates decide where it can execute; Demo and Real remain blocked.",
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Candidate runtime promotion failed" });
  }
});

router.get("/research/:serviceId/promoted-runtime", async (req, res): Promise<void> => {
  try {
    const serviceId = String(req.params.serviceId ?? "").toUpperCase();
    getSynthesisAdapter(serviceId);
    const promotedRuntime = await readPromotedServiceRuntimeArtifact(serviceId);
    res.json({
      serviceId,
      promotedRuntime,
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Promoted runtime fetch failed" });
  }
});

router.get("/research/:serviceId/elite-synthesis/jobs/:id/export/return-amplification", async (req, res): Promise<void> => {
  try {
    const serviceId = String(req.params.serviceId ?? "").toUpperCase();
    getSynthesisAdapter(serviceId);
    const jobId = Number(req.params.id);
    const job = await getEliteSynthesisJob(jobId);
    if (!job || job.serviceId !== serviceId) {
      res.status(404).json({ error: `Elite synthesis job ${jobId} not found for ${serviceId}.` });
      return;
    }
    if (!job.resultArtifact) {
      res.status(409).json({ error: `Elite synthesis job ${jobId} has no completed result artifact yet.` });
      return;
    }
    sendJsonOrTooLarge(res, "elite_synthesis_export_return_amplification", {
      ...buildExportMetadata(job, "return_lifecycle_amplification"),
      status: job.status,
      targetProfile: (job.resultArtifact.windowSummary as Record<string, unknown> | undefined)?.targetProfile ?? "default",
      returnAmplificationAnalysis: (await buildHydratedResultArtifact(job))?.returnAmplificationAnalysis ?? null,
    }, {
      serviceId,
      jobId,
      selectsTaskState: true,
      selectsResultArtifact: true,
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Elite return amplification export failed" });
  }
});

router.get("/research/:serviceId/elite-synthesis/jobs/:id/export/trade-lifecycle-replay", async (req, res): Promise<void> => {
  try {
    const serviceId = String(req.params.serviceId ?? "").toUpperCase();
    getSynthesisAdapter(serviceId);
    const jobId = Number(req.params.id);
    const job = await getEliteSynthesisJob(jobId);
    if (!job || job.serviceId !== serviceId) {
      res.status(404).json({ error: `Elite synthesis job ${jobId} not found for ${serviceId}.` });
      return;
    }
    if (!job.resultArtifact) {
      res.status(400).json({ error: `Elite synthesis job ${jobId} has no result artifact to export.` });
      return;
    }
    sendJsonOrTooLarge(res, "elite_synthesis_export_trade_lifecycle_replay", {
      ...buildExportMetadata(job, "trade_lifecycle_replay"),
      status: job.status,
      targetProfile: (job.resultArtifact.windowSummary as Record<string, unknown> | undefined)?.targetProfile ?? "default",
      tradeLifecycleReplayReport: ((await buildHydratedResultArtifact(job))?.returnAmplificationAnalysis as Record<string, unknown> | undefined)?.tradeLifecycleReplayReport ?? null,
    }, {
      serviceId,
      jobId,
      selectsTaskState: true,
      selectsResultArtifact: true,
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Trade lifecycle replay export failed" });
  }
});

router.get("/research/:serviceId/elite-synthesis/jobs/:id/export/runtime-build-result", async (req, res): Promise<void> => {
  const serviceId = String(req.params.serviceId ?? "").toUpperCase();
  const jobId = Number(req.params.id);
  try {
    getSynthesisAdapter(serviceId);
    const job = await getEliteSynthesisJob(jobId);
    if (!job || job.serviceId !== serviceId || !job.resultArtifact) {
      res.status(404).json({ error: `Runtime build result for job ${jobId} not found for ${serviceId}.` });
      return;
    }
    sendJsonOrTooLarge(res, "elite_synthesis_runtime_build_result_export", buildRuntimeBuildResult(serviceId, job, job.resultArtifact), {
      serviceId,
      jobId,
    });
  } catch (err) {
    logEliteSynthesisRouteError("elite_synthesis_runtime_build_result_export", err, {
      serviceId,
      jobId,
      selectsTaskState: true,
      selectsResultArtifact: true,
    });
    res.status(400).json({ error: err instanceof Error ? err.message : "Runtime build result export failed" });
  }
});

router.get("/research/:serviceId/elite-synthesis/jobs/:id/export/full", async (req, res): Promise<void> => {
  try {
    const serviceId = String(req.params.serviceId ?? "").toUpperCase();
    getSynthesisAdapter(serviceId);
    const jobId = Number(req.params.id);
    const job = await getEliteSynthesisJob(jobId);
    if (!job || job.serviceId !== serviceId) {
      res.status(404).json({ error: `Elite synthesis job ${jobId} not found for ${serviceId}.` });
      return;
    }
    if (!job.resultArtifact) {
      res.status(409).json({ error: `Elite synthesis job ${jobId} has no completed result artifact yet.` });
      return;
    }
    sendJsonOrTooLarge(res, "elite_synthesis_export_full", {
      ...buildExportMetadata(job, "elite_synthesis_full"),
      status: job.status,
      result: await buildHydratedResultArtifact(job),
      candidateRuntimeArtifacts: job.candidateRuntimeArtifacts,
      baselineRecords: job.baselineRecords,
    }, {
      serviceId,
      jobId,
      selectsTaskState: true,
      selectsResultArtifact: true,
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Elite synthesis full export failed" });
  }
});

export default router;
