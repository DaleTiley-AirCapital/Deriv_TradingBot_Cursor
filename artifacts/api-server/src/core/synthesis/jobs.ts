import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
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
  resultArtifact: EliteSynthesisResult | null;
  createdAt: string | null;
};

let eliteSynthesisSchemaPromise: Promise<void> | null = null;

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

export async function ensureEliteSynthesisJobsTable(): Promise<void> {
  if (eliteSynthesisSchemaPromise) return eliteSynthesisSchemaPromise;
  eliteSynthesisSchemaPromise = (async () => {
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS elite_synthesis_jobs (
          id serial PRIMARY KEY,
          service_id text NOT NULL,
          symbol text NOT NULL,
          status text NOT NULL DEFAULT 'queued',
          stage text NOT NULL DEFAULT 'queued',
          params jsonb,
          progress_pct integer NOT NULL DEFAULT 0,
          current_pass integer NOT NULL DEFAULT 0,
          max_passes integer NOT NULL DEFAULT 0,
          message text,
          heartbeat_at timestamptz,
          started_at timestamptz,
          completed_at timestamptz,
          error_summary jsonb,
          best_summary jsonb,
          result_summary jsonb,
          result_artifact jsonb,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await db.execute(sql`ALTER TABLE elite_synthesis_jobs ADD COLUMN IF NOT EXISTS service_id text`);
      await db.execute(sql`ALTER TABLE elite_synthesis_jobs ADD COLUMN IF NOT EXISTS symbol text`);
      await db.execute(sql`ALTER TABLE elite_synthesis_jobs ADD COLUMN IF NOT EXISTS status text`);
      await db.execute(sql`ALTER TABLE elite_synthesis_jobs ADD COLUMN IF NOT EXISTS stage text`);
      await db.execute(sql`ALTER TABLE elite_synthesis_jobs ADD COLUMN IF NOT EXISTS params jsonb`);
      await db.execute(sql`ALTER TABLE elite_synthesis_jobs ADD COLUMN IF NOT EXISTS progress_pct integer`);
      await db.execute(sql`ALTER TABLE elite_synthesis_jobs ADD COLUMN IF NOT EXISTS current_pass integer`);
      await db.execute(sql`ALTER TABLE elite_synthesis_jobs ADD COLUMN IF NOT EXISTS max_passes integer`);
      await db.execute(sql`ALTER TABLE elite_synthesis_jobs ADD COLUMN IF NOT EXISTS message text`);
      await db.execute(sql`ALTER TABLE elite_synthesis_jobs ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz`);
      await db.execute(sql`ALTER TABLE elite_synthesis_jobs ADD COLUMN IF NOT EXISTS started_at timestamptz`);
      await db.execute(sql`ALTER TABLE elite_synthesis_jobs ADD COLUMN IF NOT EXISTS completed_at timestamptz`);
      await db.execute(sql`ALTER TABLE elite_synthesis_jobs ADD COLUMN IF NOT EXISTS error_summary jsonb`);
      await db.execute(sql`ALTER TABLE elite_synthesis_jobs ADD COLUMN IF NOT EXISTS best_summary jsonb`);
      await db.execute(sql`ALTER TABLE elite_synthesis_jobs ADD COLUMN IF NOT EXISTS result_summary jsonb`);
      await db.execute(sql`ALTER TABLE elite_synthesis_jobs ADD COLUMN IF NOT EXISTS result_artifact jsonb`);
      await db.execute(sql`ALTER TABLE elite_synthesis_jobs ADD COLUMN IF NOT EXISTS created_at timestamptz`);
      await db.execute(sql`ALTER TABLE elite_synthesis_jobs ALTER COLUMN status SET DEFAULT 'queued'`);
      await db.execute(sql`ALTER TABLE elite_synthesis_jobs ALTER COLUMN stage SET DEFAULT 'queued'`);
      await db.execute(sql`ALTER TABLE elite_synthesis_jobs ALTER COLUMN progress_pct SET DEFAULT 0`);
      await db.execute(sql`ALTER TABLE elite_synthesis_jobs ALTER COLUMN current_pass SET DEFAULT 0`);
      await db.execute(sql`ALTER TABLE elite_synthesis_jobs ALTER COLUMN max_passes SET DEFAULT 0`);
      await db.execute(sql`ALTER TABLE elite_synthesis_jobs ALTER COLUMN created_at SET DEFAULT now()`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_elite_synthesis_jobs_service_created ON elite_synthesis_jobs(service_id, created_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_elite_synthesis_jobs_status_created ON elite_synthesis_jobs(status, created_at DESC)`);
    } catch (err) {
      eliteSynthesisSchemaPromise = null;
      const message = err instanceof Error ? err.message : "unknown schema bootstrap error";
      throw new Error(`Elite synthesis job schema is not ready: ${message}`);
    }
  })();
  return eliteSynthesisSchemaPromise;
}

export async function createEliteSynthesisJob(params: {
  serviceId: string;
  symbol: string;
  jobParams: EliteSynthesisParams;
  maxPasses: number;
}): Promise<number> {
  await ensureEliteSynthesisJobsTable();
  const inserted = await db.execute(sql`
    INSERT INTO elite_synthesis_jobs (
      service_id, symbol, status, stage, params, progress_pct, current_pass, max_passes, message
    ) VALUES (
      ${params.serviceId},
      ${params.symbol},
      'queued',
      'queued',
      ${JSON.stringify(params.jobParams)}::jsonb,
      0,
      0,
      ${params.maxPasses},
      'Queued for integrated elite synthesis'
    )
    RETURNING id
  `);
  const row = (inserted.rows?.[0] ?? {}) as { id?: number };
  const jobId = Number(row.id ?? 0);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    throw new Error("Failed to create elite synthesis job.");
  }
  return jobId;
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
  }>,
): Promise<void> {
  await ensureEliteSynthesisJobsTable();
  await db.execute(sql`
    UPDATE elite_synthesis_jobs
    SET
      status = COALESCE(${patch.status ?? null}, status),
      stage = COALESCE(${patch.stage ?? null}, stage),
      progress_pct = COALESCE(${patch.progressPct ?? null}, progress_pct),
      current_pass = COALESCE(${patch.currentPass ?? null}, current_pass),
      max_passes = COALESCE(${patch.maxPasses ?? null}, max_passes),
      message = COALESCE(${patch.message ?? null}, message),
      heartbeat_at = COALESCE(${patch.heartbeatAt ? new Date(patch.heartbeatAt) : null}, heartbeat_at),
      started_at = COALESCE(${patch.startedAt ? new Date(patch.startedAt) : null}, started_at),
      completed_at = COALESCE(${patch.completedAt ? new Date(patch.completedAt) : null}, completed_at),
      error_summary = COALESCE(${patch.errorSummary ? JSON.stringify(patch.errorSummary) : null}::jsonb, error_summary),
      best_summary = COALESCE(${patch.bestSummary ? JSON.stringify(patch.bestSummary) : null}::jsonb, best_summary),
      result_summary = COALESCE(${patch.resultSummary ? JSON.stringify(patch.resultSummary) : null}::jsonb, result_summary),
      result_artifact = COALESCE(${patch.resultArtifact ? JSON.stringify(patch.resultArtifact) : null}::jsonb, result_artifact)
    WHERE id = ${jobId}
  `);
}

export async function markEliteSynthesisJobCancelled(jobId: number): Promise<void> {
  await updateEliteSynthesisJob(jobId, {
    status: "cancelled",
    stage: "cancelled",
    message: "Cancellation requested",
    heartbeatAt: new Date(),
    completedAt: new Date(),
  });
}

export async function getEliteSynthesisJob(jobId: number): Promise<EliteSynthesisJobRow | null> {
  await ensureEliteSynthesisJobsTable();
  const result = await db.execute(sql`SELECT * FROM elite_synthesis_jobs WHERE id = ${jobId} LIMIT 1`);
  const row = result.rows?.[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: Number(row.id ?? 0),
    serviceId: String(row.service_id ?? ""),
    symbol: String(row.symbol ?? ""),
    status: String(row.status ?? "queued") as EliteSynthesisJobStatus,
    stage: String(row.stage ?? "queued") as EliteSynthesisStage,
    params: asRecord(row.params),
    progressPct: Number(row.progress_pct ?? 0),
    currentPass: Number(row.current_pass ?? 0),
    maxPasses: Number(row.max_passes ?? 0),
    message: row.message == null ? null : String(row.message),
    heartbeatAt: iso(row.heartbeat_at),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    errorSummary: asRecord(row.error_summary),
    bestSummary: asRecord(row.best_summary),
    resultSummary: asRecord(row.result_summary),
    resultArtifact: (row.result_artifact as EliteSynthesisResult | null) ?? null,
    createdAt: iso(row.created_at),
  };
}

export async function getEliteSynthesisProgress(jobId: number): Promise<EliteSynthesisProgressSnapshot | null> {
  const row = await getEliteSynthesisJob(jobId);
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
  await ensureEliteSynthesisJobsTable();
  const result = await db.execute(sql`
    SELECT *
    FROM elite_synthesis_jobs
    WHERE service_id = ${serviceId}
    ORDER BY created_at DESC
    LIMIT ${Math.max(1, Math.min(50, limit))}
  `);
  const rows = (result.rows ?? []) as Record<string, unknown>[];
  const jobs: EliteSynthesisJobRow[] = [];
  for (const row of rows) {
    jobs.push({
      id: Number(row.id ?? 0),
      serviceId: String(row.service_id ?? ""),
      symbol: String(row.symbol ?? ""),
      status: String(row.status ?? "queued") as EliteSynthesisJobStatus,
      stage: String(row.stage ?? "queued") as EliteSynthesisStage,
      params: asRecord(row.params),
      progressPct: Number(row.progress_pct ?? 0),
      currentPass: Number(row.current_pass ?? 0),
      maxPasses: Number(row.max_passes ?? 0),
      message: row.message == null ? null : String(row.message),
      heartbeatAt: iso(row.heartbeat_at),
      startedAt: iso(row.started_at),
      completedAt: iso(row.completed_at),
      errorSummary: asRecord(row.error_summary),
      bestSummary: asRecord(row.best_summary),
      resultSummary: asRecord(row.result_summary),
      resultArtifact: (row.result_artifact as EliteSynthesisResult | null) ?? null,
      createdAt: iso(row.created_at),
    });
  }
  return jobs;
}

export async function getEliteSynthesisSchemaStatus(): Promise<Record<string, unknown>> {
  await ensureEliteSynthesisJobsTable();
  const result = await db.execute(sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'elite_synthesis_jobs'
    ORDER BY ordinal_position
  `);
  return {
    ready: true,
    table: "elite_synthesis_jobs",
    columns: (result.rows ?? []).map((row) => String((row as Record<string, unknown>).column_name ?? "")),
  };
}
