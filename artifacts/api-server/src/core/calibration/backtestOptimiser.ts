import {
  db,
  symbolModelOptimisationCandidatesTable,
  symbolModelOptimisationRunsTable,
} from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  runV3Backtest,
  type BacktestTierMode,
  type V3BacktestResult,
} from "../backtest/backtestRunner.js";
import {
  getPromotedSymbolRuntimeModel,
  stageSymbolRuntimeModel,
  type PromotedSymbolRuntimeModel,
} from "./promotedSymbolModel.js";
import { chatCompleteJsonPrefer } from "../../infrastructure/openai.js";

type OptimiserStatus =
  | "running"
  | "completed"
  | "failed"
  | "staged"
  | "cancelled"
  | "stale";
type OptimiserPhase =
  | "queued"
  | "starting"
  | "running_candidate"
  | "scoring"
  | "ai_review"
  | "completed"
  | "failed"
  | "staged"
  | "cancel_requested"
  | "cancelled"
  | "stale";

const MAX_STALE_HEARTBEAT_MS = 15 * 60 * 1000;

export interface OptimiserParams {
  symbol: string;
  windowDays?: number;
  maxIterations?: number;
  enableAiReview?: boolean;
}

interface CandidateParams {
  key: string;
  tierMode: BacktestTierMode;
  tpScale?: number;
  slScale?: number;
  trailActivationScale?: number;
  trailDistanceScale?: number;
  scoreGateDelta?: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function finite(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export async function ensureSymbolModelOptimisationTables(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS symbol_model_optimisation_runs (
      id serial PRIMARY KEY,
      symbol text NOT NULL,
      source_runtime_run_id integer,
      calibration_run_id integer,
      status text NOT NULL DEFAULT 'running',
      phase text NOT NULL DEFAULT 'queued',
      objective text NOT NULL DEFAULT 'profit_factor_total_pnl_guarded_drawdown',
      window_days integer NOT NULL DEFAULT 365,
      max_iterations integer NOT NULL DEFAULT 5,
      current_iteration integer,
      current_candidate text,
      candidate_count integer NOT NULL DEFAULT 0,
      last_heartbeat_at timestamptz,
      cancel_requested_at timestamptz,
      cancel_reason text,
      stale_reason text,
      baseline_metrics jsonb,
      winner_metrics jsonb,
      ai_review jsonb,
      error_summary jsonb,
      started_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      staged_at timestamptz
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS symbol_model_optimisation_candidates (
      id serial PRIMARY KEY,
      run_id integer NOT NULL REFERENCES symbol_model_optimisation_runs(id),
      symbol text NOT NULL,
      iteration integer NOT NULL,
      candidate_key text NOT NULL,
      parent_candidate_key text,
      params jsonb,
      backtest_metrics jsonb,
      move_overlap_metrics jsonb,
      exit_breakdown jsonb,
      tier_performance jsonb,
      ai_rationale jsonb,
      selected boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS idx_symbol_model_opt_runs_symbol_status ON symbol_model_optimisation_runs(symbol, status)`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS idx_symbol_model_opt_candidates_run ON symbol_model_optimisation_candidates(run_id)`,
  );

  await db.execute(
    sql`ALTER TABLE symbol_model_optimisation_runs ADD COLUMN IF NOT EXISTS phase text NOT NULL DEFAULT 'queued'`,
  );
  await db.execute(
    sql`ALTER TABLE symbol_model_optimisation_runs ADD COLUMN IF NOT EXISTS current_iteration integer`,
  );
  await db.execute(
    sql`ALTER TABLE symbol_model_optimisation_runs ADD COLUMN IF NOT EXISTS current_candidate text`,
  );
  await db.execute(
    sql`ALTER TABLE symbol_model_optimisation_runs ADD COLUMN IF NOT EXISTS candidate_count integer NOT NULL DEFAULT 0`,
  );
  await db.execute(
    sql`ALTER TABLE symbol_model_optimisation_runs ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz`,
  );
  await db.execute(
    sql`ALTER TABLE symbol_model_optimisation_runs ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz`,
  );
  await db.execute(
    sql`ALTER TABLE symbol_model_optimisation_runs ADD COLUMN IF NOT EXISTS cancel_reason text`,
  );
  await db.execute(
    sql`ALTER TABLE symbol_model_optimisation_runs ADD COLUMN IF NOT EXISTS stale_reason text`,
  );
}

function cloneModel(model: PromotedSymbolRuntimeModel): PromotedSymbolRuntimeModel {
  return JSON.parse(JSON.stringify(model)) as PromotedSymbolRuntimeModel;
}

function applyCandidateParams(
  model: PromotedSymbolRuntimeModel,
  params: CandidateParams,
): PromotedSymbolRuntimeModel {
  const next = cloneModel(model);
  const tpModel = asRecord(next.tpModel);
  const slModel = asRecord(next.slModel);
  const trailingModel = asRecord(next.trailingModel);

  const tpScale = params.tpScale ?? 1;
  const slScale = params.slScale ?? 1;
  const trailActivationScale = params.trailActivationScale ?? 1;
  const trailDistanceScale = params.trailDistanceScale ?? 1;

  const targetPct = finite(tpModel.targetPct, 0);
  if (targetPct > 0) tpModel.targetPct = Math.max(1, Math.min(30, targetPct * tpScale));
  const fallbackTargetPct = finite(tpModel.fallbackTargetPct, 0);
  if (fallbackTargetPct > 0) {
    tpModel.fallbackTargetPct = Math.max(1, Math.min(30, fallbackTargetPct * tpScale));
  }

  const buckets = asRecord(tpModel.buckets);
  for (const bucket of Object.values(buckets)) {
    const row = asRecord(bucket);
    const pct = finite(row.targetPct, 0);
    if (pct > 0) row.targetPct = Math.max(1, Math.min(30, pct * tpScale));
  }

  const riskPct = finite(slModel.maxInitialRiskPct, 0);
  if (riskPct > 0) slModel.maxInitialRiskPct = Math.max(0.4, Math.min(8, riskPct * slScale));

  const activation = finite(trailingModel.activationProfitPct, 0);
  if (activation > 0) {
    trailingModel.activationProfitPct = Math.max(0.5, Math.min(12, activation * trailActivationScale));
  }
  const distance = finite(trailingModel.trailingDistancePct, 0);
  if (distance > 0) {
    trailingModel.trailingDistancePct = Math.max(0.2, Math.min(8, distance * trailDistanceScale));
  }

  if (params.scoreGateDelta) {
    next.recommendedScoreGates = {
      paper: Math.max(1, Math.min(100, next.recommendedScoreGates.paper + params.scoreGateDelta)),
      demo: Math.max(1, Math.min(100, next.recommendedScoreGates.demo + params.scoreGateDelta)),
      real: Math.max(1, Math.min(100, next.recommendedScoreGates.real + params.scoreGateDelta)),
    };
  }

  next.tpModel = tpModel;
  next.slModel = slModel;
  next.trailingModel = trailingModel;
  next.optimisationParams = params as unknown as Record<string, unknown>;
  return next;
}

function compactMetrics(result: V3BacktestResult) {
  return {
    tierMode: result.tierMode,
    tradeCount: result.summary.tradeCount,
    winRate: result.summary.winRate,
    profitFactor: Number.isFinite(result.summary.profitFactor) ? result.summary.profitFactor : 999,
    totalPnlPct: result.summary.totalPnlPct,
    avgPnlPct: result.summary.avgPnlPct,
    maxDrawdownPct: result.summary.maxDrawdownPct,
    avgHoldBars: result.summary.avgHoldBars,
    byExitReason: result.summary.byExitReason,
    bySlStage: result.summary.bySlStage,
    runtimeModel: result.runtimeModel,
  };
}

function objective(
  metrics: ReturnType<typeof compactMetrics>,
  baseline: ReturnType<typeof compactMetrics>,
): number {
  const ddPenalty = Math.max(0, metrics.maxDrawdownPct - baseline.maxDrawdownPct) * 80;
  return metrics.profitFactor * 40 + metrics.totalPnlPct * 100 + metrics.winRate * 25 - ddPenalty;
}

function passesGuardrail(
  metrics: ReturnType<typeof compactMetrics>,
  baseline: ReturnType<typeof compactMetrics>,
): boolean {
  if (metrics.maxDrawdownPct <= baseline.maxDrawdownPct) return true;
  return metrics.winRate >= baseline.winRate + 0.05 && metrics.profitFactor >= baseline.profitFactor + 0.1;
}

function candidatePlan(maxIterations: number): CandidateParams[] {
  const plans: CandidateParams[] = [
    { key: "baseline", tierMode: "ALL" },
    { key: "tier-ab", tierMode: "AB" },
    {
      key: "earlier-trail",
      tierMode: "ALL",
      trailActivationScale: 0.75,
      trailDistanceScale: 0.85,
    },
    { key: "wider-structure-risk", tierMode: "ALL", slScale: 1.15, trailActivationScale: 0.85 },
    { key: "quality-tp-ab", tierMode: "AB", tpScale: 1.1, trailActivationScale: 0.85 },
    {
      key: "balanced-tight",
      tierMode: "ABC",
      scoreGateDelta: 4,
      trailActivationScale: 0.85,
      trailDistanceScale: 0.9,
    },
  ];
  return plans.slice(0, Math.max(1, maxIterations + 1));
}

async function runTierPerformance(
  symbol: string,
  startTs: number,
  endTs: number,
  model: PromotedSymbolRuntimeModel,
) {
  const modes: BacktestTierMode[] = ["A", "AB", "ABC", "ALL"];
  const out: Record<string, unknown> = {};
  for (const tierMode of modes) {
    const result = await runV3Backtest({
      symbol,
      startTs,
      endTs,
      mode: "paper",
      tierMode,
      runtimeCalibrationOverride: model,
    });
    out[tierMode] = {
      ...compactMetrics(result),
      moveOverlap: result.moveOverlap,
    };
  }
  return out;
}

async function aiReview(params: {
  symbol: string;
  baseline: unknown;
  winner: unknown;
  candidates: unknown[];
}): Promise<Record<string, unknown>> {
  try {
    const response = await chatCompleteJsonPrefer({
      logLabel: "backtestOptimiserReview",
      messages: [
        {
          role: "user",
          content: `Review these symbol-model optimisation results for ${params.symbol}. Return compact JSON with verdict, risk, rationale, and nextBoundedSuggestion. AI is advisory only and cannot promote runtime.\n${JSON.stringify(params).slice(0, 18_000)}`,
        },
      ],
      max_completion_tokens: 800,
      temperature: 0.2,
    });
    const text = response.choices[0]?.message?.content ?? "{}";
    const match = text.match(/\{[\s\S]*\}/);
    return match ? (JSON.parse(match[0]) as Record<string, unknown>) : { verdict: "no_json", raw: text };
  } catch (err) {
    return { verdict: "skipped", error: err instanceof Error ? err.message : String(err) };
  }
}

async function heartbeat(
  runId: number,
  patch: Partial<{
    status: OptimiserStatus;
    phase: OptimiserPhase;
    currentIteration: number | null;
    currentCandidate: string | null;
    candidateCount: number;
    baselineMetrics: Record<string, unknown>;
    winnerMetrics: Record<string, unknown>;
    aiReview: Record<string, unknown>;
    errorSummary: Record<string, unknown>;
    completedAt: Date | null;
    staleReason: string | null;
  }> = {},
): Promise<void> {
  await db
    .update(symbolModelOptimisationRunsTable)
    .set({
      status: patch.status,
      baselineMetrics: patch.baselineMetrics,
      winnerMetrics: patch.winnerMetrics,
      aiReview: patch.aiReview,
      errorSummary: patch.errorSummary,
      completedAt: patch.completedAt,
    })
    .where(eq(symbolModelOptimisationRunsTable.id, runId));

  await db.execute(sql`
    UPDATE symbol_model_optimisation_runs
    SET
      last_heartbeat_at = now(),
      phase = COALESCE(${patch.phase ?? null}, phase),
      current_iteration = COALESCE(${patch.currentIteration ?? null}, current_iteration),
      current_candidate = COALESCE(${patch.currentCandidate ?? null}, current_candidate),
      candidate_count = COALESCE(${patch.candidateCount ?? null}, candidate_count),
      stale_reason = COALESCE(${patch.staleReason ?? null}, stale_reason)
    WHERE id = ${runId}
  `);
}

async function getRunById(runId: number) {
  const result = await db.execute(sql`
    SELECT
      id,
      symbol,
      status,
      objective,
      window_days AS "windowDays",
      max_iterations AS "maxIterations",
      source_runtime_run_id AS "sourceRuntimeRunId",
      calibration_run_id AS "calibrationRunId",
      baseline_metrics AS "baselineMetrics",
      winner_metrics AS "winnerMetrics",
      ai_review AS "aiReview",
      error_summary AS "errorSummary",
      started_at AS "startedAt",
      completed_at AS "completedAt",
      staged_at AS "stagedAt",
      phase,
      current_iteration AS "currentIteration",
      current_candidate AS "currentCandidate",
      candidate_count AS "candidateCount",
      last_heartbeat_at AS "lastHeartbeatAt",
      cancel_requested_at AS "cancelRequestedAt",
      cancel_reason AS "cancelReason",
      stale_reason AS "staleReason"
    FROM symbol_model_optimisation_runs
    WHERE id = ${runId}
    LIMIT 1
  `);
  return (result.rows[0] as Record<string, unknown> | undefined) ?? null;
}

async function isCancelRequested(runId: number): Promise<boolean> {
  const row = await getRunById(runId);
  if (!row) return true;
  return row.cancelRequestedAt != null;
}

async function recoverStaleRun(runId: number): Promise<void> {
  const row = await getRunById(runId);
  if (!row || String(row.status) !== "running") return;
  if (!row.lastHeartbeatAt) return;
  const elapsed = Date.now() - new Date(String(row.lastHeartbeatAt)).getTime();
  if (elapsed <= MAX_STALE_HEARTBEAT_MS) return;
  await db
    .update(symbolModelOptimisationRunsTable)
    .set({
      status: "stale",
      completedAt: new Date(),
    })
    .where(eq(symbolModelOptimisationRunsTable.id, runId));
  await db.execute(sql`
    UPDATE symbol_model_optimisation_runs
    SET
      phase = 'stale',
      stale_reason = ${`heartbeat_timeout_${Math.round(elapsed / 1000)}s`}
    WHERE id = ${runId}
  `);
}

async function executeOptimisation(runId: number, params: OptimiserParams): Promise<void> {
  const symbol = params.symbol;
  const windowDays = params.windowDays ?? 365;
  const maxIterations = Math.max(1, Math.min(5, params.maxIterations ?? 5));
  const endTs = Math.floor(Date.now() / 1000);
  const startTs = endTs - windowDays * 86400;
  const promoted = await getPromotedSymbolRuntimeModel(symbol);
  if (!promoted) {
    throw new Error(`No promoted runtime model found for ${symbol}. Stage and promote research first.`);
  }

  const plans = candidatePlan(maxIterations);
  await heartbeat(runId, {
    phase: "starting",
    currentIteration: null,
    currentCandidate: null,
    candidateCount: plans.length,
  });

  let baselineMetrics: ReturnType<typeof compactMetrics> | null = null;
  let winner:
    | {
        candidateId: number;
        params: CandidateParams;
        metrics: ReturnType<typeof compactMetrics>;
        score: number;
      }
    | null = null;
  let noImprove = 0;
  const candidateSummaries: unknown[] = [];

  for (let iteration = 0; iteration < plans.length; iteration++) {
    if (await isCancelRequested(runId)) {
      await heartbeat(runId, {
        status: "cancelled",
        phase: "cancelled",
        currentIteration: iteration,
        completedAt: new Date(),
      });
      return;
    }

    const candidateParams = plans[iteration]!;
    await heartbeat(runId, {
      phase: "running_candidate",
      currentIteration: iteration,
      currentCandidate: candidateParams.key,
    });

    const model = iteration === 0 ? cloneModel(promoted) : applyCandidateParams(promoted, candidateParams);
    const result = await runV3Backtest({
      symbol,
      startTs,
      endTs,
      mode: "paper",
      tierMode: candidateParams.tierMode,
      runtimeCalibrationOverride: model,
    });
    const metrics = compactMetrics(result);
    if (!baselineMetrics) {
      baselineMetrics = metrics;
      await heartbeat(runId, { baselineMetrics: baselineMetrics as unknown as Record<string, unknown> });
    }
    const score = objective(metrics, baselineMetrics);
    const guardrailPassed = passesGuardrail(metrics, baselineMetrics);
    const tierPerformance =
      iteration === 0 ? await runTierPerformance(symbol, startTs, endTs, model) : null;

    const [row] = await db
      .insert(symbolModelOptimisationCandidatesTable)
      .values({
        runId,
        symbol,
        iteration,
        candidateKey: candidateParams.key,
        params: candidateParams,
        backtestMetrics: { ...metrics, objectiveScore: score, guardrailPassed },
        moveOverlapMetrics: result.moveOverlap,
        exitBreakdown: result.summary.byExitReason,
        tierPerformance,
        aiRationale: null,
        selected: false,
      })
      .returning();

    candidateSummaries.push({
      id: row.id,
      key: candidateParams.key,
      metrics,
      moveOverlap: result.moveOverlap,
      exitBreakdown: result.summary.byExitReason,
      objectiveScore: score,
      guardrailPassed,
    });

    const improved = guardrailPassed && (!winner || score > winner.score);
    if (improved) {
      winner = { candidateId: row.id, params: candidateParams, metrics, score };
      noImprove = 0;
    } else if (iteration > 0) {
      noImprove++;
    }

    await heartbeat(runId, {
      phase: "scoring",
      currentIteration: iteration,
      currentCandidate: candidateParams.key,
    });
    if (iteration > 0 && noImprove >= 2) break;
  }

  if (!baselineMetrics || !winner) throw new Error("Optimisation produced no candidate results");

  await heartbeat(runId, { phase: "ai_review" });
  const review = params.enableAiReview
    ? await aiReview({
        symbol,
        baseline: baselineMetrics,
        winner,
        candidates: candidateSummaries,
      })
    : { verdict: "skipped_disabled", reason: "enableAiReview=false" };

  await db
    .update(symbolModelOptimisationCandidatesTable)
    .set({ selected: true, aiRationale: review })
    .where(eq(symbolModelOptimisationCandidatesTable.id, winner.candidateId));

  await heartbeat(runId, {
    status: "completed",
    phase: "completed",
    winnerMetrics: {
      candidateId: winner.candidateId,
      params: winner.params,
      metrics: winner.metrics,
      objectiveScore: winner.score,
    },
    aiReview: review,
    completedAt: new Date(),
  });
}

export async function startBacktestOptimisation(params: OptimiserParams): Promise<number> {
  await ensureSymbolModelOptimisationTables();

  const [activeRun] = await db
    .select()
    .from(symbolModelOptimisationRunsTable)
    .where(
      and(
        eq(symbolModelOptimisationRunsTable.symbol, params.symbol),
        eq(symbolModelOptimisationRunsTable.status, "running"),
      ),
    )
    .orderBy(desc(symbolModelOptimisationRunsTable.id))
    .limit(1);
  if (activeRun) {
    throw new Error(
      `Optimiser already running for ${params.symbol} (runId=${activeRun.id}). Cancel or wait for completion.`,
    );
  }

  const promoted = await getPromotedSymbolRuntimeModel(params.symbol);
  const [run] = await db
    .insert(symbolModelOptimisationRunsTable)
    .values({
      symbol: params.symbol,
      sourceRuntimeRunId: promoted?.sourceRunId ?? null,
      calibrationRunId: promoted?.sourceRunId ?? null,
      status: "running",
      windowDays: params.windowDays ?? 365,
      maxIterations: Math.max(1, Math.min(5, params.maxIterations ?? 5)),
    })
    .returning();
  await db.execute(sql`
    UPDATE symbol_model_optimisation_runs
    SET phase = 'queued', candidate_count = 0, last_heartbeat_at = now()
    WHERE id = ${run.id}
  `);

  void executeOptimisation(run.id, params).catch(async (err) => {
    await heartbeat(run.id, {
      status: "failed",
      phase: "failed",
      errorSummary: { error: err instanceof Error ? err.message : String(err) },
      completedAt: new Date(),
    });
  });

  return run.id;
}

export async function cancelBacktestOptimisationRun(
  runId: number,
  symbol: string,
  reason = "cancelled_by_user",
) {
  await ensureSymbolModelOptimisationTables();
  const run = await getRunById(runId);
  if (!run || String(run.symbol) !== symbol) return null;
  if (String(run.status) !== "running") {
    return { run, cancelled: false, reason: `run_not_running:${run.status}` };
  }

  await db.execute(sql`
    UPDATE symbol_model_optimisation_runs
    SET
      phase = 'cancel_requested',
      cancel_requested_at = now(),
      cancel_reason = ${reason},
      last_heartbeat_at = now()
    WHERE id = ${runId}
  `);
  const updated = await getRunById(runId);
  return { run: updated, cancelled: true, reason };
}

export async function getBacktestOptimisationStatus(runId: number) {
  await ensureSymbolModelOptimisationTables();
  await recoverStaleRun(runId);

  const run = await getRunById(runId);
  if (!run) return null;
  const candidates = await db
    .select()
    .from(symbolModelOptimisationCandidatesTable)
    .where(eq(symbolModelOptimisationCandidatesTable.runId, runId))
    .orderBy(desc(symbolModelOptimisationCandidatesTable.iteration));
  return { run, candidates };
}

export async function stageBacktestOptimisationWinner(runId: number) {
  await ensureSymbolModelOptimisationTables();
  const status = await getBacktestOptimisationStatus(runId);
  if (!status) throw new Error("Optimisation run not found");
  if (!["completed", "staged"].includes(String(status.run.status))) {
    throw new Error(`Run ${runId} is not complete. Current status: ${status.run.status}`);
  }

  const selected = status.candidates.find((c) => c.selected);
  if (!selected) throw new Error("No selected optimisation winner yet");
  const runSymbol = String(status.run.symbol);
  const promoted = await getPromotedSymbolRuntimeModel(runSymbol);
  if (!promoted) throw new Error(`No promoted runtime model found for ${runSymbol}`);

  const model = applyCandidateParams(
    promoted,
    asRecord(selected.params) as unknown as CandidateParams,
  );
  model.promotedAt = new Date().toISOString();
  model.optimisationRunId = runId;
  model.optimisationCandidateId = selected.id;
  await stageSymbolRuntimeModel(model);
  await heartbeat(runId, {
    status: "staged",
    phase: "staged",
    completedAt: new Date(),
  });
  await db
    .update(symbolModelOptimisationRunsTable)
    .set({ stagedAt: new Date() })
    .where(eq(symbolModelOptimisationRunsTable.id, runId));
  return { model, selected };
}
