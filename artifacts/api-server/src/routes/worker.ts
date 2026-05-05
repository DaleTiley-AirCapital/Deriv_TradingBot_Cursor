import { Router, type IRouter } from "express";
import { cancelWorkerJob, getWorkerJob, getWorkerSchemaStatus, listWorkerJobs } from "../core/worker/jobs.js";

const router: IRouter = Router();

router.get("/worker/schema-status", async (_req, res): Promise<void> => {
  try {
    res.json(await getWorkerSchemaStatus());
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Worker schema status failed" });
  }
});

router.get("/worker/jobs", async (req, res): Promise<void> => {
  try {
    const serviceId = typeof req.query.serviceId === "string" ? req.query.serviceId.toUpperCase() : undefined;
    const taskType = typeof req.query.taskType === "string" ? req.query.taskType : undefined;
    const activeOnly = String(req.query.activeOnly ?? "true") !== "false";
    const jobs = await listWorkerJobs({
      serviceId,
      taskType: taskType as never,
      statuses: activeOnly ? ["queued", "running"] : undefined,
      limit: Number(req.query.limit ?? 10),
    });
    res.json({
      jobs: jobs.map((job) => ({
        id: job.id,
        taskType: job.taskType,
        serviceId: job.serviceId,
        symbol: job.symbol,
        status: job.status,
        stage: job.stage,
        progressPct: job.progressPct,
        message: job.message,
        heartbeatAt: job.heartbeatAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        createdAt: job.createdAt,
        taskState: job.taskState ?? {},
        resultSummary: job.resultSummary,
        errorSummary: job.errorSummary,
      })),
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Worker job list failed" });
  }
});

router.get("/worker/jobs/:id", async (req, res): Promise<void> => {
  try {
    const jobId = Number(req.params.id);
    if (!Number.isInteger(jobId) || jobId <= 0) {
      res.status(400).json({ error: "Invalid worker job id" });
      return;
    }
    const job = await getWorkerJob(jobId);
    if (!job) {
      res.status(404).json({ error: `Worker job ${jobId} not found.` });
      return;
    }
    res.json({
      ok: true,
      job: {
        id: job.id,
        taskType: job.taskType,
        serviceId: job.serviceId,
        symbol: job.symbol,
        status: job.status,
        stage: job.stage,
        progressPct: job.progressPct,
        message: job.message,
        heartbeatAt: job.heartbeatAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        taskState: job.taskState ?? {},
        params: job.params ?? {},
        resultSummary: job.resultSummary,
        resultArtifact: job.resultArtifact,
        errorSummary: job.errorSummary,
      },
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Worker job fetch failed" });
  }
});

router.post("/worker/jobs/:id/cancel", async (req, res): Promise<void> => {
  try {
    const jobId = Number(req.params.id);
    if (!Number.isInteger(jobId) || jobId <= 0) {
      res.status(400).json({ error: "Invalid worker job id" });
      return;
    }
    const job = await getWorkerJob(jobId);
    if (!job) {
      res.status(404).json({ error: `Worker job ${jobId} not found.` });
      return;
    }
    const updated = await cancelWorkerJob(jobId);
    res.json({
      ok: true,
      jobId,
      status: updated?.status ?? job.status,
      stage: updated?.stage ?? job.stage,
      message: updated?.message ?? job.message,
      cancellationRequested: true,
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Worker job cancellation failed" });
  }
});

export default router;
