import { Router, type IRouter } from "express";
import { buildUnifiedCrash300Dataset } from "../core/synthesis/crash300Adapter.js";
import { getSynthesisAdapter } from "../core/synthesis/engine.js";
import {
  createEliteSynthesisJob,
  ensureEliteSynthesisJobsTable,
  getEliteSynthesisJob,
  getEliteSynthesisProgress,
  getEliteSynthesisSchemaStatus,
  listEliteSynthesisJobs,
  markEliteSynthesisJobCancelled,
  updateEliteSynthesisJob,
} from "../core/synthesis/jobs.js";
import type { EliteSynthesisParams } from "../core/synthesis/types.js";
import { profileDefaults } from "../core/synthesis/types.js";

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
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        heartbeatAt: job.heartbeatAt,
        resultSummary: job.resultSummary,
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
    if (!job.resultArtifact) {
      res.json({
        jobId,
        serviceId,
        status: job.status,
        stage: job.stage,
        message: job.message,
        result: null,
      });
      return;
    }
    const compact = job.resultArtifact;
    res.json({
      jobId,
      serviceId,
      status: job.status,
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
        candidateRuntimeArtifacts: job.candidateRuntimeArtifacts,
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
      jobId,
      serviceId,
      status: job.status,
      exportedAt: new Date().toISOString(),
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
    const readiness = (result.policyArtifactReadiness
      ?? (result.bestPolicySummary as Record<string, unknown>).policyArtifactReadiness
      ?? {}) as Record<string, unknown>;
    if (!Boolean(readiness.reportConsistencyPassed) || !Boolean(readiness.canStageForPaper)) {
      res.status(409).json({
        error: "Best synthesis candidate failed paper staging readiness checks.",
        policyArtifactReadiness: readiness,
      });
      return;
    }
    const selectedTrades = Array.isArray(result.bestPolicySelectedTrades) ? result.bestPolicySelectedTrades : [];
    const selectedTradeIds = selectedTrades.map((trade) => String((trade as Record<string, unknown>).candidateId ?? (trade as Record<string, unknown>).tradeId ?? "")).filter(Boolean);
    const artifactId = `crash300-synthesis-candidate-${jobId}-${Date.now()}`;
    const artifact = {
      artifactId,
      artifactType: "crash300_synthesis_candidate_runtime",
      mode: "paper_only",
      runtimeMimicReady: false,
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
        tpRules: result.bestPolicyArtifact.tpRules,
        slRules: result.bestPolicyArtifact.slRules,
        trailingRules: result.bestPolicyArtifact.trailingRules,
        minHoldRules: result.bestPolicyArtifact.minHoldRules,
      },
      expectedPerformance: {
        trades: result.bestPolicySummary.trades,
        wins: result.bestPolicySummary.wins,
        losses: result.bestPolicySummary.losses,
        winRate: result.bestPolicySummary.winRate,
        slHitRate: result.bestPolicySummary.slHitRate,
        profitFactor: result.bestPolicySummary.profitFactor,
        accountReturnPct: result.bestPolicySummary.accountReturnPct,
        maxDrawdownPct: result.bestPolicySummary.maxDrawdownPct,
        monthlyBreakdown: result.bestPolicyArtifact.monthlyBreakdown ?? [],
      },
      selectedTradeIds,
      selectedTradesChecksum: stableChecksum(selectedTradeIds),
      reportConsistencyChecksum: stableChecksum((result.bestPolicySelectedTradesSummary as Record<string, unknown> | undefined)?.reportConsistencyChecks ?? {}),
      leakageAudit: result.leakageAuditSummary,
      exitDerivationAudit: (result.bestPolicySummary as Record<string, unknown>).exitDerivationAudit ?? null,
      lateOffsetSafetyAudit: (result.bestPolicySummary as Record<string, unknown>).lateOffsetSafetyAudit ?? null,
      calibratedRelationshipSummary: (result.bestPolicySummary as Record<string, unknown>).calibratedMoveRelationshipSummary ?? null,
    };
    const nextArtifacts = [...job.candidateRuntimeArtifacts, artifact];
    await updateEliteSynthesisJob(jobId, {
      taskStatePatch: {
        candidateRuntimeArtifacts: nextArtifacts,
      },
    });
    res.status(202).json({
      ok: true,
      artifact,
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
      jobId,
      serviceId,
      status: job.status,
      exportedAt: new Date().toISOString(),
      result: job.resultArtifact,
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Elite synthesis full export failed" });
  }
});

export default router;
