import {
  cancelWorkerJob,
  createWorkerJob,
  ensureWorkerJobsTable,
  getWorkerJob,
  getWorkerSchemaStatus,
  listWorkerJobs,
  updateWorkerJob,
} from "../worker/jobs.js";
import type { WorkerJobRow } from "../worker/types.js";
import type {
  EliteSynthesisJobStatus,
  EliteSynthesisParams,
  EliteSynthesisProgressSnapshot,
  EliteSynthesisResult,
  EliteSynthesisStage,
} from "./types.js";

export type EliteSynthesisJobRow = {
  id: number;
  serviceId: string;
  symbol: string;
  status: EliteSynthesisJobStatus;
  stage: EliteSynthesisStage;
  params: Record<string, unknown> | null;
  progressPct: number;
  currentPass: number;
  maxPasses: number;
  message: string | null;
  heartbeatAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  errorSummary: Record<string, unknown> | null;
  bestSummary: Record<string, unknown> | null;
  resultSummary: Record<string, unknown> | null;
  hasResultArtifact: boolean;
  resultArtifactLoaded: boolean;
  resultArtifact: EliteSynthesisResult | null;
  candidateRuntimeArtifacts: Array<Record<string, unknown>>;
  baselineRecords: Array<Record<string, unknown>>;
  candidateRuntimeArtifactsCount: number;
  baselineRecordsCount: number;
  createdAt: string | null;
};

function hydrateEliteSynthesisJob(row: WorkerJobRow | null): EliteSynthesisJobRow | null {
  if (!row || row.taskType !== "elite_synthesis") return null;
  const taskState = row.taskState ?? {};
  return {
    id: row.id,
    serviceId: row.serviceId,
    symbol: row.symbol,
    status: row.status as EliteSynthesisJobStatus,
    stage: row.stage as EliteSynthesisStage,
    params: row.params,
    progressPct: row.progressPct,
    currentPass: Number(taskState.currentPass ?? 0),
    maxPasses: Number(taskState.maxPasses ?? 0),
    message: row.message,
    heartbeatAt: row.heartbeatAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    errorSummary: row.errorSummary,
    bestSummary: (taskState.bestSummary as Record<string, unknown> | null) ?? null,
    resultSummary: row.resultSummary,
    hasResultArtifact: row.hasResultArtifact,
    resultArtifactLoaded: row.resultArtifactLoaded,
    resultArtifact: (row.resultArtifact as EliteSynthesisResult | null) ?? null,
    candidateRuntimeArtifacts: Array.isArray(taskState.candidateRuntimeArtifacts)
      ? (taskState.candidateRuntimeArtifacts as Array<Record<string, unknown>>)
      : [],
    baselineRecords: Array.isArray(taskState.baselineRecords)
      ? (taskState.baselineRecords as Array<Record<string, unknown>>)
      : [],
    candidateRuntimeArtifactsCount: row.candidateRuntimeArtifactsCount,
    baselineRecordsCount: row.baselineRecordsCount,
    createdAt: row.createdAt,
  };
}

export async function ensureEliteSynthesisJobsTable(): Promise<void> {
  await ensureWorkerJobsTable();
}

export async function createEliteSynthesisJob(params: {
  serviceId: string;
  symbol: string;
  jobParams: EliteSynthesisParams;
  maxPasses: number;
}): Promise<number> {
  return createWorkerJob({
    taskType: "elite_synthesis",
    serviceId: params.serviceId,
    symbol: params.symbol,
    jobParams: params.jobParams as Record<string, unknown>,
    taskState: {
      currentPass: 0,
      maxPasses: params.maxPasses,
      bestSummary: null,
      candidateRuntimeArtifacts: [],
      baselineRecords: [],
    },
    message: "Queued for integrated elite synthesis",
  });
}

export async function updateEliteSynthesisJob(
  jobId: number,
  patch: Partial<{
    status: EliteSynthesisJobStatus;
    stage: EliteSynthesisStage;
    progressPct: number;
    currentPass: number;
    maxPasses: number;
    message: string;
    heartbeatAt: string | Date | null;
    startedAt: string | Date | null;
    completedAt: string | Date | null;
    errorSummary: Record<string, unknown> | null;
    bestSummary: Record<string, unknown> | null;
    resultSummary: Record<string, unknown> | null;
    resultArtifact: EliteSynthesisResult | null;
    taskStatePatch: Record<string, unknown>;
  }>,
): Promise<void> {
  const current = await getWorkerJob(jobId);
  const existingState = current?.taskState ?? {};
  const nextTaskState: Record<string, unknown> = {
    ...existingState,
    ...(patch.currentPass == null ? {} : { currentPass: patch.currentPass }),
    ...(patch.maxPasses == null ? {} : { maxPasses: patch.maxPasses }),
    ...(patch.bestSummary == null ? {} : { bestSummary: patch.bestSummary }),
    ...(patch.taskStatePatch ?? {}),
  };
  await updateWorkerJob(jobId, {
    status: patch.status,
    stage: patch.stage,
    progressPct: patch.progressPct,
    message: patch.message ?? null,
    heartbeatAt: patch.heartbeatAt ?? null,
    startedAt: patch.startedAt ?? null,
    completedAt: patch.completedAt ?? null,
    errorSummary: patch.errorSummary ?? null,
    resultSummary: patch.resultSummary ?? null,
    resultArtifact: patch.resultArtifact ?? null,
    taskState: nextTaskState,
  });
}

export async function markEliteSynthesisJobCancelled(jobId: number): Promise<void> {
  await cancelWorkerJob(jobId);
}

export async function getEliteSynthesisJob(jobId: number): Promise<EliteSynthesisJobRow | null> {
  return hydrateEliteSynthesisJob(await getWorkerJob(jobId));
}

export async function getEliteSynthesisProgress(jobId: number): Promise<EliteSynthesisProgressSnapshot | null> {
  const row = hydrateEliteSynthesisJob(await getWorkerJob(jobId, { includeResultArtifact: false }));
  if (!row) return null;
  const bestSummary = row.bestSummary ?? {};
  return {
    jobId: row.id,
    serviceId: row.serviceId,
    symbol: row.symbol,
    status: row.status,
    stage: row.stage,
    progressPct: row.progressPct,
    currentPass: row.currentPass,
    maxPasses: row.maxPasses,
    currentPolicyCount: Number(bestSummary.currentPolicyCount ?? 0),
    evaluatedPolicyCount: Number(bestSummary.evaluatedPolicyCount ?? 0),
    bestWinRate: Number.isFinite(Number(bestSummary.bestWinRate)) ? Number(bestSummary.bestWinRate) : null,
    bestSlRate: Number.isFinite(Number(bestSummary.bestSlRate)) ? Number(bestSummary.bestSlRate) : null,
    bestProfitFactor: Number.isFinite(Number(bestSummary.bestProfitFactor)) ? Number(bestSummary.bestProfitFactor) : null,
    bestTradeCount: Number.isFinite(Number(bestSummary.bestTradeCount)) ? Number(bestSummary.bestTradeCount) : null,
    bestObjectiveScore: Number.isFinite(Number(bestSummary.bestObjectiveScore)) ? Number(bestSummary.bestObjectiveScore) : null,
    bestPolicyId: bestSummary.bestPolicyId == null ? null : String(bestSummary.bestPolicyId),
    heartbeatAt: row.heartbeatAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    errorSummary: row.errorSummary,
    message: row.message ?? "Queued",
  };
}

export async function listEliteSynthesisJobs(serviceId: string, limit = 10): Promise<EliteSynthesisJobRow[]> {
  const rows = await listWorkerJobs({
    serviceId,
    taskType: "elite_synthesis",
    limit,
    includeResultArtifact: false,
  });
  return rows.map((row) => hydrateEliteSynthesisJob(row)).filter(Boolean) as EliteSynthesisJobRow[];
}

export async function getEliteSynthesisSchemaStatus(): Promise<Record<string, unknown>> {
  const status = await getWorkerSchemaStatus();
  return {
    ...status,
    taskType: "elite_synthesis",
  };
}
