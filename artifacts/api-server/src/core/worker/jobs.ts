import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import type { WorkerJobRow, WorkerJobStatus, WorkerTaskState, WorkerTaskType } from "./types.js";

let workerJobsSchemaPromise: Promise<void> | null = null;

export class WorkerJobCancelledError extends Error {
  constructor(
    public readonly jobId: number,
    public readonly reason = "Worker job cancelled",
  ) {
    super(reason);
    this.name = "WorkerJobCancelledError";
  }
}

function iso(raw: unknown): string | null {
  if (!raw) return null;
  const d = raw instanceof Date ? raw : new Date(String(raw));
  return Number.isNaN(d.getTime()) ? String(raw) : d.toISOString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hydrateWorkerJobRow(row: Record<string, unknown> | undefined): WorkerJobRow | null {
  if (!row) return null;
  return {
    id: Number(row.id ?? 0),
    taskType: String(row.task_type ?? "elite_synthesis") as WorkerTaskType,
    serviceId: String(row.service_id ?? ""),
    symbol: String(row.symbol ?? ""),
    status: String(row.status ?? "queued") as WorkerJobStatus,
    stage: String(row.stage ?? "queued"),
    params: asRecord(row.params),
    taskState: asRecord(row.task_state),
    progressPct: Number(row.progress_pct ?? 0),
    message: row.message == null ? null : String(row.message),
    heartbeatAt: iso(row.heartbeat_at),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    errorSummary: asRecord(row.error_summary),
    resultSummary: asRecord(row.result_summary),
    resultArtifact: row.result_artifact ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export async function ensureWorkerJobsTable(): Promise<void> {
  if (workerJobsSchemaPromise) return workerJobsSchemaPromise;
  workerJobsSchemaPromise = (async () => {
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS worker_jobs (
          id serial PRIMARY KEY,
          task_type text NOT NULL,
          service_id text NOT NULL,
          symbol text NOT NULL,
          status text NOT NULL DEFAULT 'queued',
          stage text NOT NULL DEFAULT 'queued',
          params jsonb,
          task_state jsonb,
          progress_pct integer NOT NULL DEFAULT 0,
          message text,
          heartbeat_at timestamptz,
          started_at timestamptz,
          completed_at timestamptz,
          error_summary jsonb,
          result_summary jsonb,
          result_artifact jsonb,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await db.execute(sql`ALTER TABLE worker_jobs ADD COLUMN IF NOT EXISTS task_type text`);
      await db.execute(sql`ALTER TABLE worker_jobs ADD COLUMN IF NOT EXISTS service_id text`);
      await db.execute(sql`ALTER TABLE worker_jobs ADD COLUMN IF NOT EXISTS symbol text`);
      await db.execute(sql`ALTER TABLE worker_jobs ADD COLUMN IF NOT EXISTS status text`);
      await db.execute(sql`ALTER TABLE worker_jobs ADD COLUMN IF NOT EXISTS stage text`);
      await db.execute(sql`ALTER TABLE worker_jobs ADD COLUMN IF NOT EXISTS params jsonb`);
      await db.execute(sql`ALTER TABLE worker_jobs ADD COLUMN IF NOT EXISTS task_state jsonb`);
      await db.execute(sql`ALTER TABLE worker_jobs ADD COLUMN IF NOT EXISTS progress_pct integer`);
      await db.execute(sql`ALTER TABLE worker_jobs ADD COLUMN IF NOT EXISTS message text`);
      await db.execute(sql`ALTER TABLE worker_jobs ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz`);
      await db.execute(sql`ALTER TABLE worker_jobs ADD COLUMN IF NOT EXISTS started_at timestamptz`);
      await db.execute(sql`ALTER TABLE worker_jobs ADD COLUMN IF NOT EXISTS completed_at timestamptz`);
      await db.execute(sql`ALTER TABLE worker_jobs ADD COLUMN IF NOT EXISTS error_summary jsonb`);
      await db.execute(sql`ALTER TABLE worker_jobs ADD COLUMN IF NOT EXISTS result_summary jsonb`);
      await db.execute(sql`ALTER TABLE worker_jobs ADD COLUMN IF NOT EXISTS result_artifact jsonb`);
      await db.execute(sql`ALTER TABLE worker_jobs ADD COLUMN IF NOT EXISTS created_at timestamptz`);
      await db.execute(sql`ALTER TABLE worker_jobs ADD COLUMN IF NOT EXISTS updated_at timestamptz`);
      await db.execute(sql`ALTER TABLE worker_jobs ALTER COLUMN status SET DEFAULT 'queued'`);
      await db.execute(sql`ALTER TABLE worker_jobs ALTER COLUMN stage SET DEFAULT 'queued'`);
      await db.execute(sql`ALTER TABLE worker_jobs ALTER COLUMN progress_pct SET DEFAULT 0`);
      await db.execute(sql`ALTER TABLE worker_jobs ALTER COLUMN created_at SET DEFAULT now()`);
      await db.execute(sql`ALTER TABLE worker_jobs ALTER COLUMN updated_at SET DEFAULT now()`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_worker_jobs_task_created ON worker_jobs(task_type, created_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_worker_jobs_service_status_created ON worker_jobs(service_id, status, created_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_worker_jobs_status_heartbeat ON worker_jobs(status, heartbeat_at DESC)`);
    } catch (err) {
      workerJobsSchemaPromise = null;
      const message = err instanceof Error ? err.message : "unknown schema bootstrap error";
      throw new Error(`Worker job schema is not ready: ${message}`);
    }
  })();
  return workerJobsSchemaPromise;
}

export async function createWorkerJob(params: {
  taskType: WorkerTaskType;
  serviceId: string;
  symbol: string;
  jobParams: Record<string, unknown>;
  taskState?: WorkerTaskState | null;
  message?: string | null;
}): Promise<number> {
  await ensureWorkerJobsTable();
  const inserted = await db.execute(sql`
    INSERT INTO worker_jobs (
      task_type, service_id, symbol, status, stage, params, task_state, progress_pct, message
    ) VALUES (
      ${params.taskType},
      ${params.serviceId},
      ${params.symbol},
      'queued',
      'queued',
      ${JSON.stringify(params.jobParams)}::jsonb,
      ${params.taskState ? JSON.stringify(params.taskState) : null}::jsonb,
      0,
      ${params.message ?? "Queued"}
    )
    RETURNING id
  `);
  const jobId = Number(((inserted.rows?.[0] ?? {}) as { id?: number }).id ?? 0);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    throw new Error("Failed to create worker job.");
  }
  return jobId;
}

export async function updateWorkerJob(
  jobId: number,
  patch: Partial<{
    status: WorkerJobStatus;
    stage: string;
    params: Record<string, unknown> | null;
    taskState: WorkerTaskState | null;
    progressPct: number;
    message: string | null;
    heartbeatAt: string | Date | null;
    startedAt: string | Date | null;
    completedAt: string | Date | null;
    errorSummary: Record<string, unknown> | null;
    resultSummary: Record<string, unknown> | null;
    resultArtifact: unknown;
  }>,
): Promise<void> {
  await ensureWorkerJobsTable();
  const hasParamsPatch = Object.prototype.hasOwnProperty.call(patch, "params");
  const hasTaskStatePatch = Object.prototype.hasOwnProperty.call(patch, "taskState");
  const hasErrorSummaryPatch = Object.prototype.hasOwnProperty.call(patch, "errorSummary");
  const hasResultSummaryPatch = Object.prototype.hasOwnProperty.call(patch, "resultSummary");
  const hasResultArtifactPatch = Object.prototype.hasOwnProperty.call(patch, "resultArtifact");
  await db.execute(sql`
    UPDATE worker_jobs
    SET
      status = COALESCE(${patch.status ?? null}, status),
      stage = COALESCE(${patch.stage ?? null}, stage),
      params = ${hasParamsPatch ? sql`${patch.params == null ? null : JSON.stringify(patch.params)}::jsonb` : sql`params`},
      task_state = ${hasTaskStatePatch ? sql`${patch.taskState == null ? null : JSON.stringify(patch.taskState)}::jsonb` : sql`task_state`},
      progress_pct = COALESCE(${patch.progressPct ?? null}, progress_pct),
      message = COALESCE(${patch.message ?? null}, message),
      heartbeat_at = COALESCE(${patch.heartbeatAt ? new Date(patch.heartbeatAt) : null}, heartbeat_at),
      started_at = COALESCE(${patch.startedAt ? new Date(patch.startedAt) : null}, started_at),
      completed_at = COALESCE(${patch.completedAt ? new Date(patch.completedAt) : null}, completed_at),
      error_summary = ${hasErrorSummaryPatch ? sql`${patch.errorSummary == null ? null : JSON.stringify(patch.errorSummary)}::jsonb` : sql`error_summary`},
      result_summary = ${hasResultSummaryPatch ? sql`${patch.resultSummary == null ? null : JSON.stringify(patch.resultSummary)}::jsonb` : sql`result_summary`},
      result_artifact = ${hasResultArtifactPatch ? sql`${patch.resultArtifact == null ? null : JSON.stringify(patch.resultArtifact)}::jsonb` : sql`result_artifact`},
      updated_at = now()
    WHERE id = ${jobId}
  `);
}

export async function getWorkerJob(jobId: number): Promise<WorkerJobRow | null> {
  await ensureWorkerJobsTable();
  const result = await db.execute(sql`SELECT * FROM worker_jobs WHERE id = ${jobId} LIMIT 1`);
  return hydrateWorkerJobRow(result.rows?.[0] as Record<string, unknown> | undefined);
}

export async function listWorkerJobs(params: {
  serviceId?: string;
  taskType?: WorkerTaskType;
  statuses?: WorkerJobStatus[];
  limit?: number;
}): Promise<WorkerJobRow[]> {
  await ensureWorkerJobsTable();
  const limit = Math.max(1, Math.min(50, params.limit ?? 10));
  const statusArray = params.statuses && params.statuses.length > 0 ? params.statuses : null;
  const result = await db.execute(sql`
    SELECT *
    FROM worker_jobs
    WHERE (${params.serviceId ?? null}::text IS NULL OR service_id = ${params.serviceId ?? null})
      AND (${params.taskType ?? null}::text IS NULL OR task_type = ${params.taskType ?? null})
      AND (${statusArray ? true : false} = false OR status = ANY(${statusArray ?? ["queued", "running", "completed", "failed", "cancelled"]}))
    ORDER BY created_at DESC
    LIMIT ${limit}
  `);
  return ((result.rows ?? []) as Record<string, unknown>[]).map((row) => hydrateWorkerJobRow(row)).filter(Boolean) as WorkerJobRow[];
}

export async function claimNextWorkerJob(taskTypes?: WorkerTaskType[]): Promise<WorkerJobRow | null> {
  await ensureWorkerJobsTable();
  const allowed = taskTypes && taskTypes.length > 0 ? taskTypes : null;
  const typeFilter = allowed
    ? sql`AND task_type = ANY(${allowed})`
    : sql``;
  const result = await db.execute(sql`
    WITH next_job AS (
      SELECT id
      FROM worker_jobs
      WHERE status = 'queued'
      ${typeFilter}
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE worker_jobs
    SET
      status = 'running',
      stage = CASE WHEN stage = 'queued' THEN 'starting' ELSE stage END,
      started_at = COALESCE(started_at, now()),
      heartbeat_at = now(),
      updated_at = now()
    WHERE id IN (SELECT id FROM next_job)
    RETURNING *
  `);
  return hydrateWorkerJobRow(result.rows?.[0] as Record<string, unknown> | undefined);
}

function withCancellationRequest(taskState: WorkerTaskState | null, reason?: string | null): WorkerTaskState {
  return {
    ...(taskState ?? {}),
    cancelRequestedAt: new Date().toISOString(),
    cancelReason: reason ?? "cancelled_from_ui",
  };
}

export async function isWorkerJobCancellationRequested(jobId: number): Promise<boolean> {
  const job = await getWorkerJob(jobId);
  if (!job) return false;
  if (job.status === "cancelled") return true;
  const taskState = job.taskState ?? {};
  return Boolean(taskState.cancelRequestedAt);
}

export async function throwIfWorkerJobCancellationRequested(jobId: number, fallbackReason?: string): Promise<void> {
  const job = await getWorkerJob(jobId);
  if (!job) return;
  const taskState = job.taskState ?? {};
  const reason = typeof taskState.cancelReason === "string" && taskState.cancelReason
    ? taskState.cancelReason
    : fallbackReason ?? job.message ?? "Worker job cancelled";
  if (job.status === "cancelled" || taskState.cancelRequestedAt) {
    throw new WorkerJobCancelledError(jobId, reason);
  }
}

export async function finalizeWorkerJobCancellation(
  jobId: number,
  patch?: Partial<{
    stage: string;
    message: string | null;
    errorSummary: Record<string, unknown> | null;
    resultSummary: Record<string, unknown> | null;
    resultArtifact: unknown;
  }>,
): Promise<void> {
  const current = await getWorkerJob(jobId);
  const nextTaskState: WorkerTaskState = {
    ...(current?.taskState ?? {}),
    cancelledAt: new Date().toISOString(),
  };
  await updateWorkerJob(jobId, {
    status: "cancelled",
    stage: patch?.stage ?? "cancelled",
    progressPct: 100,
    message: patch?.message ?? "Cancelled",
    heartbeatAt: new Date(),
    completedAt: new Date(),
    taskState: nextTaskState,
    errorSummary: patch && Object.prototype.hasOwnProperty.call(patch, "errorSummary")
      ? patch.errorSummary ?? null
      : current?.errorSummary ?? null,
    resultSummary: patch && Object.prototype.hasOwnProperty.call(patch, "resultSummary")
      ? patch.resultSummary ?? null
      : current?.resultSummary ?? null,
    resultArtifact: patch && Object.prototype.hasOwnProperty.call(patch, "resultArtifact")
      ? patch.resultArtifact
      : current?.resultArtifact ?? null,
  });
}

export async function cancelWorkerJob(jobId: number, reason?: string | null): Promise<WorkerJobRow | null> {
  const current = await getWorkerJob(jobId);
  if (!current) return null;
  if (current.status === "completed" || current.status === "failed" || current.status === "cancelled") {
    return current;
  }
  if (current.status === "queued") {
    await updateWorkerJob(jobId, {
      status: "cancelled",
      stage: "cancelled",
      message: "Cancelled before worker claim",
      heartbeatAt: new Date(),
      completedAt: new Date(),
      taskState: withCancellationRequest(current.taskState, reason),
      errorSummary: {
        reason: reason ?? "cancelled_before_claim",
      },
      resultSummary: {
        taskType: current.taskType,
        resultState: "cancelled",
      },
    });
    return getWorkerJob(jobId);
  }
  await updateWorkerJob(jobId, {
    status: "running",
    stage: "cancelling",
    message: "Cancellation requested; waiting for task checkpoint",
    heartbeatAt: new Date(),
    taskState: withCancellationRequest(current.taskState, reason),
  });
  return getWorkerJob(jobId);
}

export async function requeueStaleRunningWorkerJobs(staleMs = 5 * 60 * 1000): Promise<number> {
  await ensureWorkerJobsTable();
  await db.execute(sql`
    UPDATE worker_jobs
    SET
      status = 'cancelled',
      stage = 'cancelled',
      message = 'Cancellation finalized after worker heartbeat expired',
      completed_at = now(),
      updated_at = now()
    WHERE status = 'running'
      AND task_state IS NOT NULL
      AND task_state ? 'cancelRequestedAt'
      AND heartbeat_at IS NOT NULL
      AND heartbeat_at < now() - (${Math.max(60_000, staleMs)} * interval '1 millisecond')
  `);
  const result = await db.execute(sql`
    UPDATE worker_jobs
    SET
      status = 'queued',
      stage = 'queued',
      message = 'Worker heartbeat expired; job requeued',
      updated_at = now()
    WHERE status = 'running'
      AND heartbeat_at IS NOT NULL
      AND heartbeat_at < now() - (${Math.max(60_000, staleMs)} * interval '1 millisecond')
    RETURNING id
  `);
  return Number(result.rows?.length ?? 0);
}

export async function getWorkerSchemaStatus(): Promise<Record<string, unknown>> {
  await ensureWorkerJobsTable();
  const result = await db.execute(sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'worker_jobs'
    ORDER BY ordinal_position
  `);
  return {
    ready: true,
    table: "worker_jobs",
    columns: (result.rows ?? []).map((row) => String((row as Record<string, unknown>).column_name ?? "")),
  };
}
