import { Router, type IRouter } from "express";
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

function stableChecksum(value: unknown): string {
  const json = JSON.stringify(value, Object.keys(value && typeof value === "object" ? value as Record<string, unknown> : {}).sort());
  let hash = 0;
  for (let index = 0; index < json.length; index += 1) {
    hash = ((hash << 5) - hash + json.charCodeAt(index)) | 0;
  }
  return `s${Math.abs(hash)}`;
}

async function findCandidateRuntimeArtifact(serviceId: string, artifactId: string) {
  const jobs = await listEliteSynthesisJobs(serviceId, 200);
  for (const job of jobs) {
    const artifact = job.candidateRuntimeArtifacts.find((item) => String(item.artifactId ?? "") === artifactId);
    if (artifact) return { job, artifact };
  }
  return null;
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

function jobDisplayState(job: EliteSynthesisJobRow): "completed_with_artifact" | "completed_missing_artifact" | "running" | "queued" | "failed" | "cancelled" {
  if (job.status === "completed") {
    return job.resultArtifact ? "completed_with_artifact" : "completed_missing_artifact";
  }
  if (job.status === "failed" || job.status === "cancelled" || job.status === "queued" || job.status === "running") {
    return job.status;
  }
  return "running";
}

function artifactHealth(job: EliteSynthesisJobRow) {
  const resultArtifact = job.resultArtifact;
  const bestSelectedTrades = Array.isArray(resultArtifact?.bestPolicySelectedTrades)
    ? resultArtifact.bestPolicySelectedTrades
    : [];
  const returnAmplification = resultArtifact?.returnAmplificationAnalysis ?? null;
  const diagnostics: string[] = [];
  if (job.status === "completed" && !resultArtifact) {
    diagnostics.push("Job status is completed but the result artifact is missing.");
  }
  if (resultArtifact && !resultArtifact.bestPolicySummary) {
    diagnostics.push("Result artifact exists but the best policy summary is missing.");
  }
  if (resultArtifact && bestSelectedTrades.length === 0) {
    diagnostics.push("Result artifact exists but the selected trades artifact is empty or missing.");
  }
  if (resultArtifact && !returnAmplification) {
    diagnostics.push("Result artifact exists but the return/lifecycle amplification report is missing.");
  }
  return {
    displayState: jobDisplayState(job),
    artifactStatus: {
      resultArtifact: Boolean(resultArtifact),
      selectedTradesArtifact: bestSelectedTrades.length > 0,
      returnAmplificationArtifact: Boolean(returnAmplification),
      candidateRuntimeArtifacts: job.candidateRuntimeArtifacts.length,
      baselineRecords: job.baselineRecords.length,
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
  return {
    serviceId: job.serviceId,
    jobId: job.id,
    reportType,
    windowDays: meta.windowDays,
    searchProfile: meta.searchProfile,
    targetProfile: meta.targetProfile,
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
  const lifecycleReplayReport = await synthesizeTradeLifecycleReplayReport(job);
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
  try {
    const serviceId = String(req.params.serviceId ?? "").toUpperCase();
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
        candidateRuntimeArtifactsCount: job.candidateRuntimeArtifacts.length,
        baselineRecordsCount: job.baselineRecords.length,
        ...synthesisJobMetadata(job),
        ...artifactHealth(job),
      })),
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Elite synthesis job list failed" });
  }
});

router.post("/research/:serviceId/elite-synthesis/jobs", async (req, res): Promise<void> => {
  try {
    await ensureEliteSynthesisJobsTable();
    const serviceId = String(req.params.serviceId ?? "").toUpperCase();
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
    res.status(400).json({ error: err instanceof Error ? err.message : "Elite synthesis job start failed" });
  }
});

router.get("/research/:serviceId/elite-synthesis/jobs/:id", async (req, res): Promise<void> => {
  try {
    const serviceId = String(req.params.serviceId ?? "").toUpperCase();
    getSynthesisAdapter(serviceId);
    const jobId = Number(req.params.id);
    const job = await getEliteSynthesisProgress(jobId);
    if (!job || job.serviceId !== serviceId) {
      res.status(404).json({ error: `Elite synthesis job ${jobId} not found for ${serviceId}.` });
      return;
    }
    res.json({ job });
  } catch (err) {
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
  try {
    const serviceId = String(req.params.serviceId ?? "").toUpperCase();
    getSynthesisAdapter(serviceId);
    const jobId = Number(req.params.id);
    const job = await getEliteSynthesisJob(jobId);
    if (!job || job.serviceId !== serviceId) {
      res.status(404).json({ error: `Elite synthesis job ${jobId} not found for ${serviceId}.` });
      return;
    }
    const stagedCandidate = await resolveCurrentStagedCandidate(serviceId);
    const health = artifactHealth(job);
    if (!job.resultArtifact) {
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
        result: null,
      });
      return;
    }
    const compact = await buildHydratedResultArtifact(job);
    if (!compact) {
      res.status(409).json({ error: `Elite synthesis job ${jobId} has no completed result artifact yet.` });
      return;
    }
    res.json({
      jobId,
      serviceId,
      status: job.status,
      selectedJob: {
        jobId: job.id,
        ...synthesisJobMetadata(job),
        displayState: health.displayState,
      },
      artifactStatus: health.artifactStatus,
      artifactDiagnostics: health.artifactDiagnostics,
      currentStagedCandidate: stagedCandidate,
      result: {
        jobId: compact.jobId,
        serviceId: compact.serviceId,
        status: compact.status,
        resultState: compact.resultState,
        targetAchieved: compact.targetAchieved,
        bestPolicySummary: compact.bestPolicySummary,
        topPolicySummaries: compact.topPolicySummaries,
        bottleneckSummary: compact.bottleneckSummary,
        leakageAuditSummary: compact.leakageAuditSummary,
        validationErrors: compact.validationErrors,
        dataAvailability: compact.dataAvailability,
        unitValidation: compact.unitValidation,
        missingFeatureImplementations: compact.missingFeatureImplementations,
        windowSummary: compact.windowSummary,
        sourceRunIds: compact.sourceRunIds,
        datasetSummary: compact.datasetSummary,
        passLogSummary: compact.passLogSummary,
        fullPassLog: compact.fullPassLog,
        featureDistributions: compact.featureDistributions,
        triggerRebuildSummary: compact.triggerRebuildSummary,
        rebuiltTriggerDiagnostics: compact.rebuiltTriggerDiagnostics ?? compact.triggerRebuildSummary ?? null,
        exitOptimisationTable: compact.exitOptimisationTable,
        bestPolicySelectedTradesSummary: compact.bestPolicySelectedTradesSummary ?? null,
        targetAchievedBreakdown: compact.targetAchievedBreakdown ?? null,
        strategyGradeReadiness: compact.strategyGradeReadiness ?? null,
        policyArtifactReadiness: compact.policyArtifactReadiness ?? null,
        validationHardeningGuard: compact.validationHardeningGuard ?? null,
        returnAmplificationAnalysis: compact.returnAmplificationAnalysis ?? null,
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
    res.json({
      ...buildExportMetadata(job, "selected_trades"),
      status: job.status,
      policyId: (job.resultArtifact.bestPolicySummary as Record<string, unknown> | undefined)?.policyId ?? null,
      sourcePool: (job.resultArtifact.bestPolicySummary as Record<string, unknown> | undefined)?.sourcePool ?? null,
      policyArtifactReadiness: job.resultArtifact.policyArtifactReadiness ?? null,
      bestPolicySelectedTradesSummary: job.resultArtifact.bestPolicySelectedTradesSummary ?? null,
      bestPolicySelectedTrades: job.resultArtifact.bestPolicySelectedTrades ?? [],
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Elite synthesis selected-trades export failed" });
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
    const artifactId = `crash300-v3-1-paper-candidate-${jobId}-${Date.now()}`;
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
      blocker: "Candidate staged for paper review; runtime mimic validation still required before demo/real.",
      reason: "V3.1 CRASH300 baseline candidate for paper observation only",
    };
    const artifact = {
      artifactId,
      artifactType: "crash300_v3_1_paper_candidate_runtime",
      mode: "paper_only",
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
          trailingRules: result.bestPolicyArtifact.trailingRules,
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
      baselineType: "paper_candidate",
      sourceJobId: jobId,
      sourcePolicyId: result.bestPolicySummary.policyId,
      createdAt: new Date().toISOString(),
      artifactId,
      runtimeMimicValidationStatus: "not_run",
      runtimeMimicReady: false,
      notes: [
        "CRASH300 is preserved as current best baseline while pipeline moves to R_75.",
        "Further CRASH300 squeezing deferred until all active services have candidate runtimes.",
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
      note: "Paper-only candidate. Not live-approved.",
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
        error: "CRASH300 candidate runtime is not approved for Paper staging.",
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
      note: "Promoted runtime is universal to the service. Paper is enabled first; Demo and Real remain blocked.",
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
    res.json({
      ...buildExportMetadata(job, "return_lifecycle_amplification"),
      status: job.status,
      targetProfile: (job.resultArtifact.windowSummary as Record<string, unknown> | undefined)?.targetProfile ?? "default",
      returnAmplificationAnalysis: (await buildHydratedResultArtifact(job))?.returnAmplificationAnalysis ?? null,
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
    res.json({
      ...buildExportMetadata(job, "trade_lifecycle_replay"),
      status: job.status,
      targetProfile: (job.resultArtifact.windowSummary as Record<string, unknown> | undefined)?.targetProfile ?? "default",
      tradeLifecycleReplayReport: ((await buildHydratedResultArtifact(job))?.returnAmplificationAnalysis as Record<string, unknown> | undefined)?.tradeLifecycleReplayReport ?? null,
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Trade lifecycle replay export failed" });
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
    res.json({
      ...buildExportMetadata(job, "elite_synthesis_full"),
      status: job.status,
      result: await buildHydratedResultArtifact(job),
      candidateRuntimeArtifacts: job.candidateRuntimeArtifacts,
      baselineRecords: job.baselineRecords,
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Elite synthesis full export failed" });
  }
});

export default router;
