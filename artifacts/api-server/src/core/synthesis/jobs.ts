import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";
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

function iso(raw: unknown): string | null {
  if (!raw) return null;
  const d = raw instanceof Date ? raw : new Date(String(raw));
  return Number.isNaN(d.getTime()) ? String(raw) : d.toISOString();
}

function asNumber(raw: unknown, fallback = 0): number {
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function asNullableNumber(raw: unknown): number | null {
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function asNullableString(raw: unknown): string | null {
  return raw == null || raw === "" ? null : String(raw);
}

function safeText(expr: SQL, maxLength = 2000) {
  return sql`left(COALESCE(${expr}, ''), ${maxLength})`;
}

function compactSummarySelect() {
  return sql`
    id,
    task_type,
    service_id,
    symbol,
    status,
    stage,
    progress_pct,
    ${safeText(sql`message`, 1000)} AS message,
    heartbeat_at,
    started_at,
    completed_at,
    created_at,
    updated_at,
    ${safeText(sql`params ->> 'windowDays'`, 80)} AS window_days,
    ${safeText(sql`params ->> 'searchProfile'`, 80)} AS search_profile,
    ${safeText(sql`params ->> 'targetProfile'`, 80)} AS target_profile,
    ${safeText(sql`task_state ->> 'currentPass'`, 80)} AS current_pass,
    ${safeText(sql`COALESCE(task_state ->> 'maxPasses', task_state ->> 'maxPass')`, 80)} AS max_passes,
    ${safeText(sql`task_state -> 'bestSummary' ->> 'currentPolicyCount'`, 80)} AS current_policy_count,
    ${safeText(sql`task_state -> 'bestSummary' ->> 'evaluatedPolicyCount'`, 80)} AS evaluated_policy_count,
    ${safeText(sql`task_state -> 'bestSummary' ->> 'bestWinRate'`, 80)} AS best_win_rate,
    ${safeText(sql`task_state -> 'bestSummary' ->> 'bestSlRate'`, 80)} AS best_sl_rate,
    ${safeText(sql`task_state -> 'bestSummary' ->> 'bestProfitFactor'`, 80)} AS best_profit_factor,
    ${safeText(sql`task_state -> 'bestSummary' ->> 'bestTradeCount'`, 80)} AS best_trade_count,
    ${safeText(sql`task_state -> 'bestSummary' ->> 'bestObjectiveScore'`, 80)} AS best_objective_score,
    ${safeText(sql`task_state -> 'bestSummary' ->> 'bestPolicyId'`, 300)} AS best_policy_id,
    ${safeText(sql`error_summary ->> 'failureType'`, 120)} AS error_failure_type,
    ${safeText(sql`error_summary ->> 'exceptionMessage'`, 2000)} AS error_exception_message,
    ${safeText(sql`error_summary ->> 'noTargetReason'`, 2000)} AS error_no_target_reason,
    ${safeText(sql`error_summary ->> 'passesCompleted'`, 80)} AS error_passes_completed,
    ${safeText(sql`error_summary ->> 'maxPasses'`, 80)} AS error_max_passes,
    ${safeText(sql`error_summary ->> 'targetProfile'`, 80)} AS error_target_profile,
    ${safeText(sql`error_summary ->> 'targetProfileNormalized'`, 80)} AS error_target_profile_normalized,
    ${safeText(sql`result_summary ->> 'resultState'`, 120)} AS result_state,
    ${safeText(sql`result_summary ->> 'targetAchieved'`, 80)} AS result_target_achieved,
    ${safeText(sql`result_summary ->> 'failureType'`, 120)} AS result_failure_type,
    ${safeText(sql`result_summary ->> 'exceptionMessage'`, 2000)} AS result_exception_message,
    ${safeText(sql`result_summary ->> 'noTargetReason'`, 2000)} AS result_no_target_reason,
    ${safeText(sql`result_summary ->> 'passesCompleted'`, 80)} AS result_passes_completed,
    ${safeText(sql`result_summary ->> 'maxPasses'`, 80)} AS result_max_passes,
    ${safeText(sql`result_summary ->> 'targetProfile'`, 80)} AS result_target_profile,
    ${safeText(sql`result_summary ->> 'targetProfileNormalized'`, 80)} AS result_target_profile_normalized,
    ${safeText(sql`result_summary ->> 'recommendedPolicyStatus'`, 120)} AS recommended_policy_status,
    ${safeText(sql`result_summary ->> 'guardrailsPassedCount'`, 80)} AS guardrails_passed_count,
    ${safeText(sql`result_summary ->> 'topPolicyCount'`, 80)} AS top_policy_count,
    ${safeText(sql`result_summary ->> 'bottleneck'`, 500)} AS result_bottleneck,
    CASE WHEN result_artifact IS NULL THEN false ELSE true END AS has_result_artifact,
    false AS result_artifact_loaded,
    NULL::jsonb AS result_artifact,
    CASE
      WHEN jsonb_typeof(task_state -> 'candidateRuntimeArtifacts') = 'array'
        THEN jsonb_array_length(task_state -> 'candidateRuntimeArtifacts')
      ELSE 0
    END AS candidate_runtime_artifacts_count,
    CASE
      WHEN jsonb_typeof(task_state -> 'baselineRecords') = 'array'
        THEN jsonb_array_length(task_state -> 'baselineRecords')
      ELSE 0
    END AS baseline_records_count
  `;
}

function hydrateEliteSynthesisSummaryRow(row: Record<string, unknown> | undefined): EliteSynthesisJobRow | null {
  if (!row) return null;
  return {
    id: asNumber(row.id),
    serviceId: String(row.service_id ?? ""),
    symbol: String(row.symbol ?? ""),
    status: String(row.status ?? "queued") as EliteSynthesisJobStatus,
    stage: String(row.stage ?? "queued") as EliteSynthesisStage,
    params: {
      windowDays: asNullableNumber(row.window_days),
      searchProfile: asNullableString(row.search_profile),
      targetProfile: asNullableString(row.target_profile),
    },
    progressPct: asNumber(row.progress_pct),
    currentPass: asNumber(row.current_pass),
    maxPasses: asNumber(row.max_passes),
    message: asNullableString(row.message),
    heartbeatAt: iso(row.heartbeat_at),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    errorSummary: {
      failureType: asNullableString(row.error_failure_type),
      exceptionMessage: asNullableString(row.error_exception_message),
      noTargetReason: asNullableString(row.error_no_target_reason),
      passesCompleted: asNullableNumber(row.error_passes_completed),
      maxPasses: asNullableNumber(row.error_max_passes),
      targetProfile: asNullableString(row.error_target_profile),
      targetProfileNormalized: asNullableString(row.error_target_profile_normalized),
    },
    bestSummary: {
      currentPolicyCount: asNumber(row.current_policy_count),
      evaluatedPolicyCount: asNumber(row.evaluated_policy_count),
      bestWinRate: asNullableNumber(row.best_win_rate),
      bestSlRate: asNullableNumber(row.best_sl_rate),
      bestProfitFactor: asNullableNumber(row.best_profit_factor),
      bestTradeCount: asNullableNumber(row.best_trade_count),
      bestObjectiveScore: asNullableNumber(row.best_objective_score),
      bestPolicyId: asNullableString(row.best_policy_id),
    },
    resultSummary: {
      resultState: asNullableString(row.result_state),
      targetAchieved: row.result_target_achieved == null ? null : String(row.result_target_achieved) === "true",
      failureType: asNullableString(row.result_failure_type),
      exceptionMessage: asNullableString(row.result_exception_message),
      noTargetReason: asNullableString(row.result_no_target_reason),
      passesCompleted: asNullableNumber(row.result_passes_completed),
      maxPasses: asNullableNumber(row.result_max_passes),
      targetProfile: asNullableString(row.result_target_profile),
      targetProfileNormalized: asNullableString(row.result_target_profile_normalized),
      recommendedPolicyStatus: asNullableString(row.recommended_policy_status),
      guardrailsPassedCount: asNullableNumber(row.guardrails_passed_count),
      topPolicyCount: asNullableNumber(row.top_policy_count),
      bottleneck: asNullableString(row.result_bottleneck),
    },
    hasResultArtifact: Boolean(row.has_result_artifact),
    resultArtifactLoaded: false,
    resultArtifact: null,
    candidateRuntimeArtifacts: [],
    baselineRecords: [],
    candidateRuntimeArtifactsCount: asNumber(row.candidate_runtime_artifacts_count),
    baselineRecordsCount: asNumber(row.baseline_records_count),
    createdAt: iso(row.created_at),
  };
}

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

export async function getEliteSynthesisJobSummary(jobId: number): Promise<EliteSynthesisJobRow | null> {
  await ensureWorkerJobsTable();
  const result = await db.execute(sql`
    SELECT ${compactSummarySelect()}
    FROM worker_jobs
    WHERE id = ${jobId}
      AND task_type = 'elite_synthesis'
    LIMIT 1
  `);
  return hydrateEliteSynthesisSummaryRow(result.rows?.[0] as Record<string, unknown> | undefined);
}

export async function getEliteSynthesisProgress(jobId: number): Promise<EliteSynthesisProgressSnapshot | null> {
  await ensureWorkerJobsTable();
  const result = await db.execute(sql`
    SELECT ${compactSummarySelect()}
    FROM worker_jobs
    WHERE id = ${jobId}
      AND task_type = 'elite_synthesis'
    LIMIT 1
  `);
  const row = hydrateEliteSynthesisSummaryRow(result.rows?.[0] as Record<string, unknown> | undefined);
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
  await ensureWorkerJobsTable();
  const boundedLimit = Math.max(1, Math.min(200, limit));
  const result = await db.execute(sql`
    SELECT ${compactSummarySelect()}
    FROM worker_jobs
    WHERE service_id = ${serviceId}
      AND task_type = 'elite_synthesis'
    ORDER BY created_at DESC
    LIMIT ${boundedLimit}
  `);
  return ((result.rows ?? []) as Record<string, unknown>[])
    .map((row) => hydrateEliteSynthesisSummaryRow(row))
    .filter(Boolean) as EliteSynthesisJobRow[];
}

export async function getEliteSynthesisSchemaStatus(): Promise<Record<string, unknown>> {
  const status = await getWorkerSchemaStatus();
  return {
    ...status,
    taskType: "elite_synthesis",
  };
}

export async function getEliteSynthesisJobSizeDiagnostics(serviceId: string, limit = 50): Promise<Array<Record<string, unknown>>> {
  await ensureWorkerJobsTable();
  const boundedLimit = Math.max(1, Math.min(200, limit));
  const result = await db.execute(sql`
    SELECT
      id,
      status,
      stage,
      params ->> 'windowDays' AS window_days,
      params ->> 'searchProfile' AS search_profile,
      params ->> 'targetProfile' AS target_profile,
      pg_column_size(task_state) AS task_state_bytes,
      pg_column_size(result_artifact) AS result_artifact_bytes,
      pg_column_size(result_summary) AS result_summary_bytes,
      pg_column_size(error_summary) AS error_summary_bytes,
      created_at,
      completed_at
    FROM worker_jobs
    WHERE service_id = ${serviceId}
      AND task_type = 'elite_synthesis'
    ORDER BY created_at DESC
    LIMIT ${boundedLimit}
  `);
  return ((result.rows ?? []) as Record<string, unknown>[]).map((row) => ({
    id: asNumber(row.id),
    status: asNullableString(row.status),
    stage: asNullableString(row.stage),
    windowDays: asNullableString(row.window_days),
    searchProfile: asNullableString(row.search_profile),
    targetProfile: asNullableString(row.target_profile),
    taskStateBytes: asNumber(row.task_state_bytes),
    resultArtifactBytes: asNumber(row.result_artifact_bytes),
    resultSummaryBytes: asNumber(row.result_summary_bytes),
    errorSummaryBytes: asNumber(row.error_summary_bytes),
    createdAt: iso(row.created_at),
    completedAt: iso(row.completed_at),
  }));
}
