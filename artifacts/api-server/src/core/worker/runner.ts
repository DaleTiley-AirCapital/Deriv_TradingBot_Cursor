import {
  claimNextWorkerJob,
  finalizeWorkerJobCancellation,
  isWorkerJobCancellationRequested,
  requeueStaleRunningWorkerJobs,
  updateWorkerJob,
  WorkerJobCancelledError,
} from "./jobs.js";
import type { WorkerJobRow, WorkerTaskType } from "./types.js";
import { runEliteSynthesisJob } from "../synthesis/engine.js";
import type { EliteSynthesisParams } from "../synthesis/types.js";
import { cancelV3BacktestJob, executeV3BacktestJob } from "../../routes/backtest.js";
import {
  buildCalibrationParityReport,
  buildRuntimeTriggerValidationReport,
} from "../calibration/runtimeDiagnostics.js";
import { runQueuedCalibrationPassJob, runQueuedFullCalibrationJob } from "../calibration/fullCalibrationJob.js";
import {
  cancelCalibrationRunRecord,
  getPassRunStatus,
} from "../calibration/calibrationPassRunner.js";

function nowIso() {
  return new Date().toISOString();
}

async function yieldToEventLoop() {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function createWorkerCancellationChecker(jobId: number, pollMs = 1_500) {
  let lastCheckAt = 0;
  let cancellationReason: string | null = null;
  return async (force = false) => {
    if (cancellationReason) {
      throw new WorkerJobCancelledError(jobId, cancellationReason);
    }
    const now = Date.now();
    if (!force && now - lastCheckAt < pollMs) return;
    lastCheckAt = now;
    const requested = await isWorkerJobCancellationRequested(jobId);
    if (!requested) return;
    cancellationReason = "cancelled_by_operator";
    throw new WorkerJobCancelledError(jobId, cancellationReason);
  };
}

function asEliteSynthesisParams(value: Record<string, unknown> | null): EliteSynthesisParams {
  const record = value ?? {};
  return {
    calibrationRunId: record.calibrationRunId == null ? null : Number(record.calibrationRunId),
    backtestRunId: record.backtestRunId == null ? null : Number(record.backtestRunId),
    windowDays: record.windowDays == null ? null : Number(record.windowDays),
    startTs: record.startTs == null ? null : Number(record.startTs),
    endTs: record.endTs == null ? null : Number(record.endTs),
    searchProfile: (["fast", "balanced", "deep"].includes(String(record.searchProfile))
      ? String(record.searchProfile)
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

function asCalibrationPassParams(value: Record<string, unknown> | null) {
  const record = value ?? {};
  return {
    symbol: String(record.symbol ?? ""),
    windowDays: Number(record.windowDays ?? 90),
    passName: (record.passName == null ? "all" : String(record.passName)) as "enrichment" | "family_inference" | "model_synthesis" | "all",
    minTier: record.minTier == null ? undefined : String(record.minTier) as "A" | "B" | "C" | "D",
    moveType: record.moveType == null ? undefined : String(record.moveType),
    maxMoves: record.maxMoves == null ? undefined : Number(record.maxMoves),
    force: record.force === true,
    continueOnMoveErrors: record.continueOnMoveErrors === true,
  };
}

function asFullCalibrationParams(value: Record<string, unknown> | null) {
  const record = value ?? {};
  return {
    symbol: String(record.symbol ?? ""),
    windowDays: Number(record.windowDays ?? 90),
    minMovePct: Number(record.minMovePct ?? 0.05),
    minTier: record.minTier == null ? undefined : String(record.minTier) as "A" | "B" | "C" | "D",
    moveType: record.moveType == null ? undefined : String(record.moveType),
    maxMoves: record.maxMoves == null ? undefined : Number(record.maxMoves),
    force: record.force === true,
  };
}

function asRuntimeBacktestParams(value: Record<string, unknown> | null) {
  const record = value ?? {};
  return {
    symbol: String(record.symbol ?? "all"),
    startTs: record.startTs == null ? undefined : Number(record.startTs),
    endTs: record.endTs == null ? undefined : Number(record.endTs),
    mode: record.mode == null ? undefined : String(record.mode) as "paper" | "demo" | "real",
    tierMode: String(record.tierMode ?? "ALL").toUpperCase() as "A" | "AB" | "ABC" | "ALL",
    crash300AdmissionPolicy: record.crash300AdmissionPolicy && typeof record.crash300AdmissionPolicy === "object"
      ? (record.crash300AdmissionPolicy as Record<string, unknown>)
      : null,
    startingCapitalUsd: Number(record.startingCapitalUsd ?? 600),
  };
}

function asWindowParams(value: Record<string, unknown> | null) {
  const record = value ?? {};
  return {
    symbol: String(record.symbol ?? ""),
    startTs: Number(record.startTs ?? 0),
    endTs: Number(record.endTs ?? 0),
  };
}

function linkedRunId(job: WorkerJobRow): number {
  return Number(job.taskState?.runId ?? 0);
}

function linkedBacktestJobId(job: WorkerJobRow): number {
  return Number(job.taskState?.backtestJobId ?? 0);
}

function startCalibrationRunMirror(workerJobId: number, runId: number) {
  let cancelled = false;
  const tick = async () => {
    if (cancelled) return;
    try {
      const status = await getPassRunStatus(runId);
      if (!status) return;
      const processedMoves = Number(status.processedMoves ?? 0);
      const totalMoves = Math.max(0, Number(status.totalMoves ?? 0));
      const progressFromMoves = totalMoves > 0 ? Math.min(95, Math.floor((processedMoves / totalMoves) * 100)) : 5;
      const meta = status.metaJson && typeof status.metaJson === "object"
        ? (status.metaJson as Record<string, unknown>)
        : {};
      await updateWorkerJob(workerJobId, {
        status: status.status === "running"
          ? "running"
          : status.status === "completed" || status.status === "partial"
            ? "completed"
            : status.status === "cancelled"
              ? "running"
              : "failed",
        stage: String(meta.stage ?? status.passName ?? "running_calibration"),
        progressPct: status.status === "running" ? progressFromMoves : 100,
        message: String((meta.progress as Record<string, unknown> | undefined)?.label ?? meta.stage ?? `Calibration run #${runId}`),
        heartbeatAt: nowIso(),
        taskState: {
          runId,
          calibrationStatus: status.status,
          processedMoves,
          totalMoves,
          failedMoves: Number(status.failedMoves ?? 0),
        },
      });
    } catch {
      // best effort
    }
  };
  void tick();
  const handle = setInterval(() => {
    void tick();
  }, 3000);
  return () => {
    cancelled = true;
    clearInterval(handle);
  };
}

async function runWorkerTask(job: WorkerJobRow): Promise<void> {
  const assertNotCancelled = createWorkerCancellationChecker(job.id);
  switch (job.taskType) {
    case "elite_synthesis":
      await assertNotCancelled(true);
      await runEliteSynthesisJob({
        jobId: job.id,
        serviceId: job.serviceId,
        request: asEliteSynthesisParams(job.params),
      });
      return;
    case "calibration_passes": {
      const runId = linkedRunId(job);
      if (!Number.isInteger(runId) || runId <= 0) {
        throw new Error("Calibration pass worker job is missing runId.");
      }
      await updateWorkerJob(job.id, {
        status: "running",
        stage: "running_calibration_passes",
        progressPct: 5,
        message: `Worker claimed calibration pass run #${runId}`,
        heartbeatAt: nowIso(),
      });
      const stopMirror = startCalibrationRunMirror(job.id, runId);
      let result;
      try {
        await assertNotCancelled(true);
        result = await runQueuedCalibrationPassJob(runId, asCalibrationPassParams(job.params), assertNotCancelled);
      } finally {
        stopMirror();
      }
      await updateWorkerJob(job.id, {
        status: "completed",
        stage: "completed",
        progressPct: 100,
        message: `Calibration pass run #${runId} ${result.status}`,
        heartbeatAt: nowIso(),
        completedAt: nowIso(),
        taskState: { ...(job.taskState ?? {}), runId },
        resultSummary: {
          taskType: job.taskType,
          runId,
          resultState: result.status === "completed" ? "completed_target_achieved" : "completed_exhausted_no_target",
          calibrationStatus: result.status,
          totalMoves: result.totalMoves,
          processedMoves: result.processedMoves,
          failedMoves: result.failedMoves,
        },
        resultArtifact: result,
      });
      return;
    }
    case "full_calibration": {
      const runId = linkedRunId(job);
      if (!Number.isInteger(runId) || runId <= 0) {
        throw new Error("Full calibration worker job is missing runId.");
      }
      await updateWorkerJob(job.id, {
        status: "running",
        stage: "running_full_calibration",
        progressPct: 5,
        message: `Worker claimed full calibration run #${runId}`,
        heartbeatAt: nowIso(),
      });
      const stopMirror = startCalibrationRunMirror(job.id, runId);
      let result;
      try {
        await assertNotCancelled(true);
        result = await runQueuedFullCalibrationJob(runId, asFullCalibrationParams(job.params), assertNotCancelled);
      } finally {
        stopMirror();
      }
      await updateWorkerJob(job.id, {
        status: "completed",
        stage: "completed",
        progressPct: 100,
        message: `Full calibration run #${runId} ${result.status}`,
        heartbeatAt: nowIso(),
        completedAt: nowIso(),
        taskState: { ...(job.taskState ?? {}), runId },
        resultSummary: {
          taskType: job.taskType,
          runId,
          resultState: result.status === "completed" ? "completed_target_achieved" : "completed_exhausted_no_target",
          calibrationStatus: result.status,
          totalMoves: result.totalMoves,
          processedMoves: result.processedMoves,
          failedMoves: result.failedMoves,
        },
        resultArtifact: result,
      });
      return;
    }
    case "runtime_backtest": {
      const backtestJobId = linkedBacktestJobId(job);
      if (!Number.isInteger(backtestJobId) || backtestJobId <= 0) {
        throw new Error("Runtime backtest worker job is missing backtestJobId.");
      }
      await updateWorkerJob(job.id, {
        status: "running",
        stage: "running_runtime_backtest",
        progressPct: 5,
        message: `Worker claimed runtime backtest #${backtestJobId}`,
        heartbeatAt: nowIso(),
      });
      await assertNotCancelled(true);
      await executeV3BacktestJob(backtestJobId, {
        ...asRuntimeBacktestParams(job.params),
        cancellationCheck: assertNotCancelled,
      }, async (patch) => {
        await updateWorkerJob(job.id, {
          status: patch.status === "failed"
            ? "failed"
            : patch.status === "completed"
              ? "completed"
              : patch.status === "cancelled"
                ? "running"
                : "running",
          stage: patch.phase ?? "running_runtime_backtest",
          progressPct: patch.progressPct ?? undefined,
          message: patch.message ?? null,
          heartbeatAt: nowIso(),
          completedAt: patch.status === "completed" || patch.status === "failed" ? nowIso() : undefined,
          taskState: { ...(job.taskState ?? {}), backtestJobId },
          resultSummary: patch.resultSummary ?? undefined,
          errorSummary: patch.errorSummary ?? undefined,
          resultArtifact: patch.persistedRunIds
            ? { backtestJobId, persistedRunIds: patch.persistedRunIds, summaryBySymbol: patch.resultSummary ?? {} }
            : undefined,
        });
      });
      return;
    }
    case "parity_run": {
      const params = asWindowParams(job.params);
      await updateWorkerJob(job.id, {
        status: "running",
        stage: "building_parity_report",
        progressPct: 10,
        message: `Building parity report for ${params.symbol}`,
        heartbeatAt: nowIso(),
      });
      await assertNotCancelled(true);
      const report = await buildCalibrationParityReport(params);
      await updateWorkerJob(job.id, {
        status: "completed",
        stage: "completed",
        progressPct: 100,
        message: `Parity report ready for ${params.symbol}`,
        heartbeatAt: nowIso(),
        completedAt: nowIso(),
        resultSummary: {
          taskType: job.taskType,
          resultState: "completed_target_achieved",
          totalMoves: Number((report.totals as Record<string, unknown> | undefined)?.totalMoves ?? 0),
          matchedMoves: Number((report.totals as Record<string, unknown> | undefined)?.matchedMoves ?? 0),
          noCandidate: Number((report.totals as Record<string, unknown> | undefined)?.noCandidate ?? 0),
        },
        resultArtifact: report,
      });
      return;
    }
    case "runtime_trigger_validation": {
      const params = asWindowParams(job.params);
      await updateWorkerJob(job.id, {
        status: "running",
        stage: "building_runtime_trigger_validation",
        progressPct: 10,
        message: `Building runtime trigger validation for ${params.symbol}`,
        heartbeatAt: nowIso(),
      });
      await assertNotCancelled(true);
      const report = await buildRuntimeTriggerValidationReport(params);
      await updateWorkerJob(job.id, {
        status: "completed",
        stage: "completed",
        progressPct: 100,
        message: `Runtime trigger validation ready for ${params.symbol}`,
        heartbeatAt: nowIso(),
        completedAt: nowIso(),
        resultSummary: {
          taskType: job.taskType,
          resultState: "completed_target_achieved",
          aggregates: (report as Record<string, unknown>).aggregates ?? {},
        },
        resultArtifact: report,
      });
      return;
    }
    default:
      await updateWorkerJob(job.id, {
        status: "failed",
        stage: "failed",
        progressPct: 100,
        message: `Worker task type ${job.taskType} is not implemented in this build`,
        heartbeatAt: nowIso(),
        completedAt: nowIso(),
        errorSummary: {
          taskType: job.taskType,
          reason: "worker_task_type_not_implemented",
        },
        resultSummary: {
          taskType: job.taskType,
          resultState: "failed_error",
        },
      });
  }
}

async function finalizeLinkedTaskCancellation(job: WorkerJobRow, error: WorkerJobCancelledError): Promise<void> {
  if (job.taskType === "elite_synthesis") {
    return;
  }
  if (job.taskType === "calibration_passes" || job.taskType === "full_calibration") {
    const runId = linkedRunId(job);
    if (Number.isInteger(runId) && runId > 0) {
      await cancelCalibrationRunRecord(runId, {
        workerJobId: job.id,
        reason: error.reason,
      });
    }
    return;
  }
  if (job.taskType === "runtime_backtest") {
    const backtestJobId = linkedBacktestJobId(job);
    if (Number.isInteger(backtestJobId) && backtestJobId > 0) {
      await cancelV3BacktestJob(backtestJobId, error.reason);
    }
  }
}

export async function runWorkerLoop(params?: {
  pollMs?: number;
  staleMs?: number;
  taskTypes?: WorkerTaskType[];
}): Promise<never> {
  const pollMs = Math.max(1_500, params?.pollMs ?? 4_000);
  const staleMs = Math.max(120_000, params?.staleMs ?? 5 * 60_000);

  // Keep the queue healthy if Railway restarts the worker.
  await requeueStaleRunningWorkerJobs(staleMs);

  for (;;) {
    let claimed: WorkerJobRow | null = null;
    try {
      claimed = await claimNextWorkerJob(params?.taskTypes);
      if (!claimed) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        continue;
      }
      await updateWorkerJob(claimed.id, {
        heartbeatAt: nowIso(),
        message: claimed.message ?? `Worker claimed ${claimed.taskType}`,
      });
      await yieldToEventLoop();
      await runWorkerTask(claimed);
    } catch (error) {
      console.error("[worker] task execution failed:", error instanceof Error ? error.message : error);
      if (claimed) {
        if (error instanceof WorkerJobCancelledError) {
          await finalizeLinkedTaskCancellation(claimed, error).catch(() => {
            // best-effort linked task cancellation persistence
          });
          await finalizeWorkerJobCancellation(claimed.id, {
            stage: "cancelled",
            message: error.reason,
            errorSummary: {
              taskType: claimed.taskType,
              reason: error.reason,
            },
            resultSummary: {
              taskType: claimed.taskType,
              resultState: "cancelled",
            },
          }).catch(() => {
            // best-effort worker cancellation persistence
          });
          await new Promise((resolve) => setTimeout(resolve, pollMs));
          continue;
        }
        await updateWorkerJob(claimed.id, {
          status: "failed",
          stage: "failed",
          progressPct: 100,
          message: error instanceof Error ? error.message : "Worker task failed",
          heartbeatAt: nowIso(),
          completedAt: nowIso(),
          errorSummary: {
            taskType: claimed.taskType,
            reason: error instanceof Error ? error.message : String(error),
          },
          resultSummary: {
            taskType: claimed.taskType,
            resultState: "failed_error",
          },
        }).catch(() => {
          // best-effort failure persistence
        });
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}
