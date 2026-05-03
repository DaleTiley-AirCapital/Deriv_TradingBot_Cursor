import { Router, type IRouter } from "express";
import { buildUnifiedCrash300Dataset } from "../core/synthesis/crash300Adapter.js";
import { scheduleEliteSynthesisJob, getSynthesisAdapter } from "../core/synthesis/engine.js";
import {
  createEliteSynthesisJob,
  ensureEliteSynthesisJobsTable,
  getEliteSynthesisJob,
  getEliteSynthesisProgress,
  getEliteSynthesisSchemaStatus,
  listEliteSynthesisJobs,
  markEliteSynthesisJobCancelled,
} from "../core/synthesis/jobs.js";
import type { EliteSynthesisParams } from "../core/synthesis/types.js";
import { profileDefaults } from "../core/synthesis/types.js";

const router: IRouter = Router();

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
    await scheduleEliteSynthesisJob({ jobId, serviceId, request: params });
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
        targetAchieved: compact.targetAchieved,
        bestPolicySummary: compact.bestPolicySummary,
        topPolicySummaries: compact.topPolicySummaries,
        bottleneckSummary: compact.bottleneckSummary,
        leakageAuditSummary: compact.leakageAuditSummary,
        windowSummary: compact.windowSummary,
        sourceRunIds: compact.sourceRunIds,
        datasetSummary: compact.datasetSummary,
        passLogSummary: compact.passLogSummary,
      },
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Elite synthesis result fetch failed" });
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
