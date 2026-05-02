import { Router, type IRouter } from "express";
import { desc, eq, asc, count, sql } from "drizzle-orm";
import { db, backtestRunsTable, backtestTradesTable, candlesTable } from "@workspace/db";
import { analyseBacktest, isOpenAIConfigured } from "../infrastructure/openai.js";
import {
  runBacktestSimulation,
  runFullBacktest,
  type BacktestConfig,
  type BacktestResult,
} from "../runtimes/backtestEngine.js";
import {
  runV3Backtest,
  runV3BacktestMulti,
  type V3BacktestResult,
} from "../core/backtest/backtestRunner.js";
import type { Crash300AdmissionPolicyConfig } from "../symbol-services/CRASH300/admissionPolicy.js";
import { buildCrash300TradeOutcomeAttributionReport } from "../core/backtest/tradeOutcomeAttribution.js";
import { buildCrash300BacktestComparisonReport } from "../core/backtest/backtestComparison.js";
import { buildCrash300CalibrationReconciliationReport } from "../core/backtest/calibrationReconciliation.js";
import { ACTIVE_SYMBOLS } from "../core/engineTypes.js";

const router: IRouter = Router();
let v3BacktestJobsSchemaPromise: Promise<void> | null = null;

export { runBacktestSimulation } from "../runtimes/backtestEngine.js";

function buildMetricsJson(result: BacktestResult) {
  const pm = result.portfolioMetrics;
  return {
    equityCurve: pm.equityCurve,
    grossProfit: pm.grossProfit,
    grossLoss: pm.grossLoss,
    avgWin: pm.avgWin,
    avgLoss: pm.avgLoss,
    maxDrawdownDuration: pm.maxDrawdownDuration,
    monthlyReturns: pm.monthlyReturns,
    returnBySymbol: pm.returnBySymbol,
    returnByRegime: pm.returnByRegime,
    tpHitRate: pm.tpHitRate,
    slHitRate: pm.slHitRate,
    tradesPerDay: pm.tradesPerDay,
    avgRR: pm.avgRR,
    avgHoldingHours: pm.avgHoldingHours,
    strategyMetrics: result.strategyMetrics,
    inSample: result.inSample ? {
      totalReturn: result.inSample.totalReturn,
      netProfit: result.inSample.netProfit,
      winRate: result.inSample.winRate,
      sharpeRatio: result.inSample.sharpeRatio,
      tradeCount: result.inSample.tradeCount,
      maxDrawdown: result.inSample.maxDrawdown,
      profitFactor: result.inSample.profitFactor,
    } : undefined,
    outOfSample: result.outOfSample ? {
      totalReturn: result.outOfSample.totalReturn,
      netProfit: result.outOfSample.netProfit,
      winRate: result.outOfSample.winRate,
      sharpeRatio: result.outOfSample.sharpeRatio,
      tradeCount: result.outOfSample.tradeCount,
      maxDrawdown: result.outOfSample.maxDrawdown,
      profitFactor: result.outOfSample.profitFactor,
    } : undefined,
    walkForward: result.walkForward ? {
      folds: result.walkForward.folds.map(f => ({
        foldIndex: f.foldIndex,
        trainStart: f.trainStart,
        trainEnd: f.trainEnd,
        testStart: f.testStart,
        testEnd: f.testEnd,
        inSampleSharpe: f.inSample.sharpeRatio,
        outOfSampleSharpe: f.outOfSample.sharpeRatio,
        inSampleReturn: f.inSample.totalReturn,
        outOfSampleReturn: f.outOfSample.totalReturn,
        inSampleTrades: f.inSample.tradeCount,
        outOfSampleTrades: f.outOfSample.tradeCount,
      })),
      aggregateOOSSharpe: result.walkForward.aggregateOOS.sharpeRatio,
      aggregateOOSReturn: result.walkForward.aggregateOOS.totalReturn,
      overfittingRatio: result.walkForward.overfittingRatio,
    } : undefined,
  };
}

type PersistedV3RunRow = {
  id: number;
  symbol: string;
  startTs: number;
  endTs: number;
  mode: string;
  tierMode: string;
  runtimeModelRunId: number | null;
  summary: Record<string, unknown>;
  result: Record<string, unknown>;
  createdAt: string;
};

type PersistedV3JobRow = {
  id: number;
  symbol: string;
  startTs: number;
  endTs: number;
  mode: string;
  tierMode: string;
  status: string;
  phase: string;
  progressPct: number;
  message: string | null;
  errorSummary: Record<string, unknown> | null;
  resultSummary: Record<string, unknown> | null;
  persistedRunIds: Record<string, number> | null;
  params: Record<string, unknown> | null;
  createdAt: string | Date;
  startedAt: string | Date | null;
  completedAt: string | Date | null;
  lastHeartbeatAt: string | Date | null;
};

type V3BacktestJobParams = {
  symbol: string;
  startTs?: number;
  endTs?: number;
  mode?: "paper" | "demo" | "real";
  tierMode: "A" | "AB" | "ABC" | "ALL";
  crash300AdmissionPolicy?: Partial<Crash300AdmissionPolicyConfig> | null;
  startingCapitalUsd: number;
};

const activeV3BacktestJobs = new Map<number, Promise<void>>();

async function ensureV3BacktestRunsTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS v3_backtest_runs (
      id serial PRIMARY KEY,
      symbol text NOT NULL,
      start_ts integer NOT NULL,
      end_ts integer NOT NULL,
      mode text NOT NULL,
      tier_mode text NOT NULL DEFAULT 'ALL',
      runtime_model_run_id integer,
      summary jsonb NOT NULL,
      result jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_v3_backtest_runs_symbol_created ON v3_backtest_runs(symbol, created_at DESC)`);
}

async function ensureV3BacktestJobsTable(): Promise<void> {
  if (v3BacktestJobsSchemaPromise) {
    return v3BacktestJobsSchemaPromise;
  }
  v3BacktestJobsSchemaPromise = (async () => {
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS v3_backtest_jobs (
          id serial PRIMARY KEY,
          symbol text NOT NULL,
          start_ts integer NOT NULL,
          end_ts integer NOT NULL,
          mode text NOT NULL,
          tier_mode text NOT NULL DEFAULT 'ALL',
          params jsonb,
          status text NOT NULL DEFAULT 'queued',
          phase text NOT NULL DEFAULT 'queued',
          progress_pct integer NOT NULL DEFAULT 0,
          message text,
          error_summary jsonb,
          result_summary jsonb,
          persisted_run_ids jsonb,
          created_at timestamptz NOT NULL DEFAULT now(),
          started_at timestamptz,
          completed_at timestamptz,
          last_heartbeat_at timestamptz
        )
      `);
      await db.execute(sql`ALTER TABLE v3_backtest_jobs ADD COLUMN IF NOT EXISTS symbol text`);
      await db.execute(sql`ALTER TABLE v3_backtest_jobs ADD COLUMN IF NOT EXISTS start_ts integer`);
      await db.execute(sql`ALTER TABLE v3_backtest_jobs ADD COLUMN IF NOT EXISTS end_ts integer`);
      await db.execute(sql`ALTER TABLE v3_backtest_jobs ADD COLUMN IF NOT EXISTS mode text`);
      await db.execute(sql`ALTER TABLE v3_backtest_jobs ADD COLUMN IF NOT EXISTS tier_mode text`);
      await db.execute(sql`ALTER TABLE v3_backtest_jobs ADD COLUMN IF NOT EXISTS params jsonb`);
      await db.execute(sql`ALTER TABLE v3_backtest_jobs ADD COLUMN IF NOT EXISTS status text`);
      await db.execute(sql`ALTER TABLE v3_backtest_jobs ADD COLUMN IF NOT EXISTS phase text`);
      await db.execute(sql`ALTER TABLE v3_backtest_jobs ADD COLUMN IF NOT EXISTS progress_pct integer`);
      await db.execute(sql`ALTER TABLE v3_backtest_jobs ADD COLUMN IF NOT EXISTS message text`);
      await db.execute(sql`ALTER TABLE v3_backtest_jobs ADD COLUMN IF NOT EXISTS error_summary jsonb`);
      await db.execute(sql`ALTER TABLE v3_backtest_jobs ADD COLUMN IF NOT EXISTS result_summary jsonb`);
      await db.execute(sql`ALTER TABLE v3_backtest_jobs ADD COLUMN IF NOT EXISTS persisted_run_ids jsonb`);
      await db.execute(sql`ALTER TABLE v3_backtest_jobs ADD COLUMN IF NOT EXISTS created_at timestamptz`);
      await db.execute(sql`ALTER TABLE v3_backtest_jobs ADD COLUMN IF NOT EXISTS started_at timestamptz`);
      await db.execute(sql`ALTER TABLE v3_backtest_jobs ADD COLUMN IF NOT EXISTS completed_at timestamptz`);
      await db.execute(sql`ALTER TABLE v3_backtest_jobs ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz`);
      await db.execute(sql`ALTER TABLE v3_backtest_jobs ALTER COLUMN tier_mode SET DEFAULT 'ALL'`);
      await db.execute(sql`ALTER TABLE v3_backtest_jobs ALTER COLUMN status SET DEFAULT 'queued'`);
      await db.execute(sql`ALTER TABLE v3_backtest_jobs ALTER COLUMN phase SET DEFAULT 'queued'`);
      await db.execute(sql`ALTER TABLE v3_backtest_jobs ALTER COLUMN progress_pct SET DEFAULT 0`);
      await db.execute(sql`ALTER TABLE v3_backtest_jobs ALTER COLUMN created_at SET DEFAULT now()`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_v3_backtest_jobs_symbol_created ON v3_backtest_jobs(symbol, created_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_v3_backtest_jobs_status ON v3_backtest_jobs(status, created_at DESC)`);
    } catch (err) {
      v3BacktestJobsSchemaPromise = null;
      const message = err instanceof Error ? err.message : "unknown schema bootstrap error";
      console.error("[backtest/v3/jobs/schema] bootstrap failed:", message);
      throw new Error(`V3 backtest job schema is not ready: ${message}`);
    }
  })();
  return v3BacktestJobsSchemaPromise;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toIsoString(raw: string | Date | null | undefined): string | null {
  if (!raw) return null;
  const d = raw instanceof Date ? raw : new Date(raw);
  return Number.isNaN(d.getTime()) ? String(raw) : d.toISOString();
}

function summarizeV3Results(results: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(results).map(([sym, raw]) => {
      const result = raw as V3BacktestResult;
      return [sym, {
        symbol: sym,
        startTs: result.startTs,
        endTs: result.endTs,
        totalBars: result.totalBars,
        totalTrades: result.summary.tradeCount,
        wins: result.summary.winCount,
        losses: result.summary.lossCount,
        winRate: result.summary.winRate,
        summedTradePnlPct: result.summary.summedTradePnlPct ?? result.summary.totalPnlPct,
        accountReturnPct: result.summary.accountReturnPct ?? 0,
        netProfitUsd: result.summary.netProfitUsd ?? 0,
        endingCapitalUsd: result.summary.endingCapitalUsd ?? 0,
        maxDrawdownPct: result.summary.accountMaxDrawdownPct ?? result.summary.maxDrawdownPct,
        profitFactor: result.summary.profitFactor,
        moveCapture: result.moveOverlap,
        runtimeModel: result.runtimeModel,
        admissionPolicy: result.admissionPolicy,
        exits: result.summary.byExitReason,
      }];
    }),
  );
}

async function persistV3BacktestResults(params: {
  results: Record<string, unknown>;
  normalizedTierMode: "A" | "AB" | "ABC" | "ALL";
  mode?: "paper" | "demo" | "real";
  parsedStart?: number;
  parsedEnd?: number;
}) {
  const persistedRunIds: Record<string, number> = {};
  for (const [sym, raw] of Object.entries(params.results)) {
    const result = asRecord(raw);
    const runtimeModel = asRecord(result.runtimeModel);
    const summary = asRecord(result.summary);
    const tierModeResult = String(result.tierMode ?? params.normalizedTierMode ?? "ALL").toUpperCase();
    const modeResult = String(result.mode ?? params.mode ?? "paper");
    const startTsResult = Number(result.startTs ?? params.parsedStart ?? 0);
    const endTsResult = Number(result.endTs ?? params.parsedEnd ?? Math.floor(Date.now() / 1000));
    const runtimeModelRunIdRaw = runtimeModel.sourceRunId;
    const runtimeModelRunId = Number.isFinite(Number(runtimeModelRunIdRaw))
      ? Number(runtimeModelRunIdRaw)
      : null;

    const insertResult = await db.execute(sql`
      INSERT INTO v3_backtest_runs (
        symbol, start_ts, end_ts, mode, tier_mode, runtime_model_run_id, summary, result
      ) VALUES (
        ${sym},
        ${startTsResult},
        ${endTsResult},
        ${modeResult},
        ${tierModeResult},
        ${runtimeModelRunId},
        ${JSON.stringify(summary)}::jsonb,
        ${JSON.stringify(result)}::jsonb
      )
      RETURNING id
    `);
    const insertedId = Number((insertResult.rows[0] as { id?: number } | undefined)?.id ?? 0);
    if (insertedId > 0) persistedRunIds[sym] = insertedId;
  }

  const totalTrades = Object.values(params.results).reduce(
    (sum: number, r) => sum + (((r as { trades?: unknown[] }).trades?.length) ?? 0),
    0,
  );
  return {
    persistedRunIds,
    totalTrades,
    summaryBySymbol: summarizeV3Results(params.results),
  };
}

async function runV3BacktestRequest(params: V3BacktestJobParams) {
  if (params.symbol === "all") {
    const multi = await runV3BacktestMulti(
      [...ACTIVE_SYMBOLS],
      params.startTs,
      params.endTs,
      params.mode,
      params.tierMode,
      params.crash300AdmissionPolicy ?? null,
      Number(params.startingCapitalUsd),
    );
    return multi as Record<string, unknown>;
  }
  const single = await runV3Backtest({
    symbol: params.symbol,
    startTs: params.startTs,
    endTs: params.endTs,
    mode: params.mode,
    tierMode: params.tierMode,
    crash300AdmissionPolicy: params.crash300AdmissionPolicy ?? null,
    startingCapitalUsd: Number(params.startingCapitalUsd),
  });
  return { [params.symbol]: single };
}

async function heartbeatV3BacktestJob(jobId: number, patch: {
  status?: string;
  phase?: string;
  progressPct?: number;
  message?: string | null;
  errorSummary?: Record<string, unknown> | null;
  resultSummary?: Record<string, unknown> | null;
  persistedRunIds?: Record<string, number> | null;
  startedAt?: boolean;
  completedAt?: boolean;
}) {
  const assignments = [
    patch.status !== undefined ? sql`status = ${patch.status}` : null,
    patch.phase !== undefined ? sql`phase = ${patch.phase}` : null,
    patch.progressPct !== undefined ? sql`progress_pct = ${patch.progressPct}` : null,
    patch.message !== undefined ? sql`message = ${patch.message}` : null,
    patch.errorSummary !== undefined ? sql`error_summary = ${patch.errorSummary ? JSON.stringify(patch.errorSummary) : null}::jsonb` : null,
    patch.resultSummary !== undefined ? sql`result_summary = ${patch.resultSummary ? JSON.stringify(patch.resultSummary) : null}::jsonb` : null,
    patch.persistedRunIds !== undefined ? sql`persisted_run_ids = ${patch.persistedRunIds ? JSON.stringify(patch.persistedRunIds) : null}::jsonb` : null,
    patch.startedAt ? sql`started_at = COALESCE(started_at, now())` : null,
    patch.completedAt ? sql`completed_at = now()` : null,
    sql`last_heartbeat_at = now()`,
  ].filter(Boolean);
  if (assignments.length === 0) return;
  await db.execute(sql`
    UPDATE v3_backtest_jobs
    SET ${sql.join(assignments as NonNullable<typeof assignments[number]>[], sql`, `)}
    WHERE id = ${jobId}
  `);
}

async function executeV3BacktestJob(jobId: number, params: V3BacktestJobParams) {
  await heartbeatV3BacktestJob(jobId, {
    status: "running",
    phase: "running_backtest",
    progressPct: 10,
    message: `Running V3 backtest for ${params.symbol}...`,
    startedAt: true,
  });
  try {
    const results = await runV3BacktestRequest(params);
    await heartbeatV3BacktestJob(jobId, {
      phase: "persisting_results",
      progressPct: 80,
      message: "Persisting backtest results...",
      resultSummary: summarizeV3Results(results),
    });
    const persisted = await persistV3BacktestResults({
      results,
      normalizedTierMode: params.tierMode,
      mode: params.mode,
      parsedStart: params.startTs,
      parsedEnd: params.endTs,
    });
    await heartbeatV3BacktestJob(jobId, {
      status: "completed",
      phase: "completed",
      progressPct: 100,
      message: `Completed ${params.symbol} V3 backtest`,
      resultSummary: persisted.summaryBySymbol,
      persistedRunIds: persisted.persistedRunIds,
      completedAt: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "V3 backtest job failed";
    await heartbeatV3BacktestJob(jobId, {
      status: "failed",
      phase: "failed",
      progressPct: 100,
      message,
      errorSummary: { message },
      completedAt: true,
    });
  } finally {
    activeV3BacktestJobs.delete(jobId);
  }
}

async function createV3BacktestJob(params: V3BacktestJobParams) {
  await ensureV3BacktestRunsTable();
  await ensureV3BacktestJobsTable();
  const insertResult = await db.execute(sql`
    INSERT INTO v3_backtest_jobs (
      symbol, start_ts, end_ts, mode, tier_mode, params, status, phase, progress_pct, message, last_heartbeat_at
    ) VALUES (
      ${params.symbol},
      ${params.startTs ?? 0},
      ${params.endTs ?? Math.floor(Date.now() / 1000)},
      ${params.mode ?? "paper"},
      ${params.tierMode},
      ${JSON.stringify(params)}::jsonb,
      'queued',
      'queued',
      0,
      ${`Queued ${params.symbol} V3 backtest`},
      now()
    )
    RETURNING id
  `);
  const jobId = Number((insertResult.rows[0] as { id?: number } | undefined)?.id ?? 0);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    throw new Error("Failed to create V3 backtest job");
  }
  const promise = executeV3BacktestJob(jobId, params);
  activeV3BacktestJobs.set(jobId, promise);
  void promise;
  return jobId;
}

router.post("/backtest/run", async (req, res): Promise<void> => {
  const {
    strategyName = "trend_continuation",
    symbol = "BOOM1000",
    initialCapital = 10000,
    allocationMode = "balanced",
    walkForward,
  } = req.body ?? {};

  const validStrategies = [
    "trend_continuation", "mean_reversion", "spike_cluster_recovery", "swing_exhaustion", "trendline_breakout",
  ];
  if (!validStrategies.includes(strategyName)) {
    res.status(400).json({ error: `Invalid strategy. Use: ${validStrategies.join(", ")}` });
    return;
  }

  try {
    const mode = allocationMode === "aggressive" ? "live" as const : "paper" as const;
    const basePct = allocationMode === "aggressive" ? 0.25
      : allocationMode === "conservative" ? 0.10 : 0.15;

    const config: BacktestConfig = {
      symbol,
      symbols: [symbol],
      strategyName,
      initialCapital,
      mode,
      basePct,
      walkForward: walkForward ? {
        trainMonths: walkForward.trainMonths ?? 6,
        testMonths: walkForward.testMonths ?? 2,
        stepMonths: walkForward.stepMonths ?? 1,
      } : undefined,
    };

    const result = await runFullBacktest(config);
    const pm = result.portfolioMetrics;

    const [row] = await db.insert(backtestRunsTable).values({
      strategyName,
      symbol,
      initialCapital,
      totalReturn: pm.totalReturn,
      netProfit: pm.netProfit,
      winRate: pm.winRate,
      profitFactor: pm.profitFactor,
      maxDrawdown: pm.maxDrawdown,
      tradeCount: pm.tradeCount,
      avgHoldingHours: pm.avgHoldingHours,
      expectancy: pm.expectancy,
      sharpeRatio: pm.sharpeRatio,
      configJson: { allocationMode, symbol, strategyName },
      metricsJson: buildMetricsJson(result),
      status: "completed",
    }).returning();

    if (row && result.trades.length > 0) {
      const batchSize = 500;
      for (let i = 0; i < result.trades.length; i += batchSize) {
        const batch = result.trades.slice(i, i + batchSize);
        await db.insert(backtestTradesTable).values(
          batch.map(t => ({
            backtestRunId: row.id,
            entryTs: t.entryTs,
            exitTs: t.exitTs,
            direction: t.direction,
            entryPrice: t.entryPrice,
            exitPrice: t.exitPrice,
            pnl: t.pnl,
            exitReason: t.exitReason,
          }))
        );
      }
    }

    res.json({
      success: true,
      message: `Backtest '${strategyName}' on ${symbol} complete. ${pm.tradeCount} trades, win rate ${(pm.winRate * 100).toFixed(1)}%, net P&L $${pm.netProfit.toFixed(2)}. ID: ${row?.id}`,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ success: false, message: `Backtest failed: ${message}` });
  }
});

router.post("/backtest/portfolio", async (req, res): Promise<void> => {
  const {
    symbols = [],
    initialCapital = 10000,
    mode = "paper",
    walkForward,
  } = req.body ?? {};

  if (!Array.isArray(symbols) || symbols.length === 0) {
    res.status(400).json({ error: "Provide an array of symbols" });
    return;
  }

  try {
    const config: BacktestConfig = {
      symbols,
      initialCapital,
      mode: mode === "live" ? "live" : "paper",
      walkForward: walkForward ? {
        trainMonths: walkForward.trainMonths ?? 6,
        testMonths: walkForward.testMonths ?? 2,
        stepMonths: walkForward.stepMonths ?? 1,
      } : undefined,
    };

    const result = await runFullBacktest(config);
    const pm = result.portfolioMetrics;

    const [row] = await db.insert(backtestRunsTable).values({
      strategyName: "portfolio",
      symbol: symbols.join(","),
      initialCapital,
      totalReturn: pm.totalReturn,
      netProfit: pm.netProfit,
      winRate: pm.winRate,
      profitFactor: pm.profitFactor,
      maxDrawdown: pm.maxDrawdown,
      tradeCount: pm.tradeCount,
      avgHoldingHours: pm.avgHoldingHours,
      expectancy: pm.expectancy,
      sharpeRatio: pm.sharpeRatio,
      configJson: { mode, symbols, source: "portfolio-backtest" },
      metricsJson: buildMetricsJson(result),
      status: "completed",
    }).returning();

    if (row && result.trades.length > 0) {
      const batchSize = 500;
      for (let i = 0; i < result.trades.length; i += batchSize) {
        const batch = result.trades.slice(i, i + batchSize);
        await db.insert(backtestTradesTable).values(
          batch.map(t => ({
            backtestRunId: row.id,
            entryTs: t.entryTs,
            exitTs: t.exitTs,
            direction: t.direction,
            entryPrice: t.entryPrice,
            exitPrice: t.exitPrice,
            pnl: t.pnl,
            exitReason: t.exitReason,
          }))
        );
      }
    }

    res.json({
      success: true,
      id: row?.id,
      portfolioMetrics: {
        totalReturn: pm.totalReturn,
        netProfit: pm.netProfit,
        winRate: pm.winRate,
        profitFactor: pm.profitFactor,
        maxDrawdown: pm.maxDrawdown,
        tradeCount: pm.tradeCount,
        sharpeRatio: pm.sharpeRatio,
      },
      strategyBreakdown: Object.fromEntries(
        Object.entries(result.strategyMetrics).map(([k, v]) => [k, {
          totalReturn: v.totalReturn,
          winRate: v.winRate,
          tradeCount: v.tradeCount,
          sharpeRatio: v.sharpeRatio,
        }])
      ),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ success: false, message: `Portfolio backtest failed: ${message}` });
  }
});

router.get("/backtest/results", async (req, res): Promise<void> => {
  const limit = Math.min(Number(req.query.limit || 40), 200);
  const offset = Math.max(Number(req.query.offset || 0), 0);

  const [[countResult], rows] = await Promise.all([
    db.select({ n: count() }).from(backtestRunsTable),
    db.select().from(backtestRunsTable)
      .orderBy(desc(backtestRunsTable.createdAt))
      .limit(limit)
      .offset(offset),
  ]);

  const total = countResult?.n ?? 0;

  res.json({
    data: rows.map(r => ({
      id: r.id,
      strategyName: r.strategyName,
      symbol: r.symbol,
      initialCapital: r.initialCapital,
      totalReturn: r.totalReturn,
      netProfit: r.netProfit,
      winRate: r.winRate,
      profitFactor: r.profitFactor,
      maxDrawdown: r.maxDrawdown,
      tradeCount: r.tradeCount,
      avgHoldingHours: r.avgHoldingHours,
      expectancy: r.expectancy,
      sharpeRatio: r.sharpeRatio,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      configJson: r.configJson,
      metricsJson: r.metricsJson,
    })),
    total,
    limit,
    offset,
  });
});

router.get("/backtest/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [row] = await db.select().from(backtestRunsTable).where(eq(backtestRunsTable.id, id));
  if (!row) { res.status(404).json({ error: "Backtest not found" }); return; }
  res.json({
    id: row.id, strategyName: row.strategyName, symbol: row.symbol, initialCapital: row.initialCapital,
    totalReturn: row.totalReturn, netProfit: row.netProfit, winRate: row.winRate, profitFactor: row.profitFactor,
    maxDrawdown: row.maxDrawdown, tradeCount: row.tradeCount, avgHoldingHours: row.avgHoldingHours,
    expectancy: row.expectancy, sharpeRatio: row.sharpeRatio, status: row.status, createdAt: row.createdAt.toISOString(),
    configJson: row.configJson,
    metricsJson: row.metricsJson,
  });
});

router.get("/backtest/:id/trades", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [run] = await db.select().from(backtestRunsTable).where(eq(backtestRunsTable.id, id));
  if (!run) { res.status(404).json({ error: "Backtest not found" }); return; }
  const trades = await db.select().from(backtestTradesTable)
    .where(eq(backtestTradesTable.backtestRunId, id))
    .orderBy(asc(backtestTradesTable.entryTs));
  res.json(trades.map(t => ({
    id: t.id,
    backtestRunId: t.backtestRunId,
    entryTs: t.entryTs.toISOString(),
    exitTs: t.exitTs ? t.exitTs.toISOString() : null,
    direction: t.direction,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    pnl: t.pnl,
    exitReason: t.exitReason,
  })));
});

router.get("/backtest/:id/candles", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [run] = await db.select().from(backtestRunsTable).where(eq(backtestRunsTable.id, id));
  if (!run) { res.status(404).json({ error: "Backtest not found" }); return; }
  const candles = await db.select().from(candlesTable)
    .where(eq(candlesTable.symbol, run.symbol))
    .orderBy(asc(candlesTable.openTs));
  res.json(candles.map(c => ({
    ts: new Date(c.openTs * 1000).toISOString(),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  })));
});

router.post("/backtest/:id/analyse", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const configured = await isOpenAIConfigured();
  if (!configured) {
    res.status(400).json({ error: "OpenAI API key not configured. Set it in Settings." });
    return;
  }

  const [row] = await db.select().from(backtestRunsTable).where(eq(backtestRunsTable.id, id));
  if (!row) { res.status(404).json({ error: "Backtest not found" }); return; }

  try {
    const analysis = await analyseBacktest({
      id: row.id,
      strategyName: row.strategyName,
      symbol: row.symbol,
      initialCapital: row.initialCapital,
      totalReturn: row.totalReturn ?? 0,
      netProfit: row.netProfit ?? 0,
      winRate: row.winRate ?? 0,
      profitFactor: row.profitFactor ?? 0,
      maxDrawdown: row.maxDrawdown ?? 0,
      tradeCount: row.tradeCount ?? 0,
      avgHoldingHours: row.avgHoldingHours ?? 0,
      expectancy: row.expectancy ?? 0,
      sharpeRatio: row.sharpeRatio ?? 0,
    });

    res.json(analysis);
  } catch (err) {
    const message = err instanceof Error ? err.message : "AI analysis failed";
    res.status(500).json({ error: message });
  }
});

// ── V3 Isolated Backtest ──────────────────────────────────────────────────────

/**
 * POST /api/backtest/v3/run
 *
 * Run the V3 engine backtest over historical candles for one or all active symbols.
 * Uses the same engines, feature vector, and regime classifier as the live scanner,
 * but in a fully isolated DB-free loop (no spike events, no cross-correlation).
 *
 * Body params:
 *   symbol?   — one of CRASH300 | BOOM300 | R_75 | R_100 | "all" (default "all")
 *   startTs?  — unix seconds; default = 90 days ago
 *   endTs?    — unix seconds; default = now
 * Response:
 *   { results: Record<symbol, V3BacktestResult> }
 *   Each result contains trades[], summary{}, and metadata.
 *
 * Warning: running all 4 symbols over 90 days can take 30-120 seconds.
 * Frontend should poll or show a loading indicator.
 */
router.post("/backtest/v3/run", async (req, res): Promise<void> => {
  const {
    symbol = "all",
    startTs,
    endTs,
    tierMode = "ALL",
    crash300AdmissionPolicy = null,
    startingCapitalUsd = 600,
  } = req.body ?? {};

  const validSymbols = [...ACTIVE_SYMBOLS, "all"];
  if (!validSymbols.includes(symbol)) {
    res.status(400).json({
      error: `Invalid symbol. Use one of: ${validSymbols.join(", ")}`,
    });
    return;
  }

  const parsedStart = startTs !== undefined ? Number(startTs) : undefined;
  const parsedEnd = endTs !== undefined ? Number(endTs) : undefined;

  if (parsedStart !== undefined && isNaN(parsedStart)) {
    res.status(400).json({ error: "startTs must be a valid unix timestamp (seconds)" });
    return;
  }
  if (parsedEnd !== undefined && isNaN(parsedEnd)) {
    res.status(400).json({ error: "endTs must be a valid unix timestamp (seconds)" });
    return;
  }

  try {
    await ensureV3BacktestRunsTable();
    let results: Record<string, unknown>;

    const mode = req.body?.mode;
    const validModes = [undefined, "paper", "demo", "real"];
    if (!validModes.includes(mode)) {
      res.status(400).json({ error: "mode must be one of: paper, demo, real" });
      return;
    }
    const normalizedTierMode = String(tierMode).toUpperCase();
    if (!["A", "AB", "ABC", "ALL"].includes(normalizedTierMode)) {
      res.status(400).json({ error: "tierMode must be one of: A, AB, ABC, ALL" });
      return;
    }

    if (symbol === "all") {
      const multi = await runV3BacktestMulti(
        [...ACTIVE_SYMBOLS],
        parsedStart,
        parsedEnd,
        mode,
        normalizedTierMode as "A" | "AB" | "ABC" | "ALL",
        crash300AdmissionPolicy,
        Number(startingCapitalUsd),
      );
      results = multi as Record<string, unknown>;
    } else {
      const single = await runV3Backtest({
        symbol,
        startTs: parsedStart,
        endTs: parsedEnd,
        mode,
        tierMode: normalizedTierMode as "A" | "AB" | "ABC" | "ALL",
        crash300AdmissionPolicy,
        startingCapitalUsd: Number(startingCapitalUsd),
      });
      results = { [symbol]: single };
    }

    const persisted = await persistV3BacktestResults({
      results,
      normalizedTierMode: normalizedTierMode as "A" | "AB" | "ABC" | "ALL",
      mode,
      parsedStart,
      parsedEnd,
    });

    res.json({
      ok: true,
      symbol,
      totalTrades: persisted.totalTrades,
      results,
      persistedRunIds: persisted.persistedRunIds,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "V3 backtest failed";
    console.error("[backtest/v3/run] error:", message);
    res.status(500).json({ error: message });
  }
});

router.post("/backtest/v3/run-async", async (req, res): Promise<void> => {
  const {
    symbol = "all",
    startTs,
    endTs,
    tierMode = "ALL",
    crash300AdmissionPolicy = null,
    startingCapitalUsd = 600,
  } = req.body ?? {};

  const validSymbols = [...ACTIVE_SYMBOLS, "all"];
  if (!validSymbols.includes(symbol)) {
    res.status(400).json({ error: `Invalid symbol. Use one of: ${validSymbols.join(", ")}` });
    return;
  }
  const parsedStart = startTs !== undefined ? Number(startTs) : undefined;
  const parsedEnd = endTs !== undefined ? Number(endTs) : undefined;
  const mode = req.body?.mode;
  const validModes = [undefined, "paper", "demo", "real"];
  if (!validModes.includes(mode)) {
    res.status(400).json({ error: "mode must be one of: paper, demo, real" });
    return;
  }
  const normalizedTierMode = String(tierMode).toUpperCase();
  if (!["A", "AB", "ABC", "ALL"].includes(normalizedTierMode)) {
    res.status(400).json({ error: "tierMode must be one of: A, AB, ABC, ALL" });
    return;
  }

  try {
    const jobId = await createV3BacktestJob({
      symbol,
      startTs: parsedStart,
      endTs: parsedEnd,
      mode,
      tierMode: normalizedTierMode as "A" | "AB" | "ABC" | "ALL",
      crash300AdmissionPolicy,
      startingCapitalUsd: Number(startingCapitalUsd),
    });
    res.json({
      ok: true,
      jobId,
      status: "queued",
      phase: "queued",
      message: `Queued V3 backtest for ${symbol}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to queue V3 backtest";
    console.error("[backtest/v3/run-async] error:", message);
    res.status(500).json({ error: message });
  }
});

router.get("/backtest/v3/history", async (req, res): Promise<void> => {
  const symbol = String(req.query.symbol ?? "").toUpperCase();
  const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? 25)));
  if (!symbol) {
    res.status(400).json({ error: "symbol query parameter is required" });
    return;
  }
  try {
    await ensureV3BacktestRunsTable();
    const rows = await db.execute(sql`
      SELECT
        id,
        symbol,
        start_ts AS "startTs",
        end_ts AS "endTs",
        mode,
        tier_mode AS "tierMode",
        runtime_model_run_id AS "runtimeModelRunId",
        summary,
        created_at AS "createdAt"
      FROM v3_backtest_runs
      WHERE symbol = ${symbol}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `);
    const runs = rows.rows.map((row) => ({
      ...row,
      createdAt: (() => {
        const raw = (row as { createdAt?: string | Date }).createdAt;
        if (!raw) return "";
        const d = raw instanceof Date ? raw : new Date(raw);
        return Number.isNaN(d.getTime()) ? String(raw) : d.toISOString();
      })(),
    }));
    res.json({ ok: true, symbol, runs });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load V3 backtest history";
    res.status(500).json({ error: message });
  }
});

router.get("/backtest/v3/history/compare", async (req, res): Promise<void> => {
  const baselineRunId = Number(req.query.baselineRunId);
  const policyRunId = Number(req.query.policyRunId);
  const includeWindowStability = String(req.query.includeWindowStability ?? "false").toLowerCase() === "true";

  if (!Number.isInteger(baselineRunId) || baselineRunId <= 0 || !Number.isInteger(policyRunId) || policyRunId <= 0) {
    res.status(400).json({ error: "baselineRunId and policyRunId query parameters are required" });
    return;
  }

  try {
    await ensureV3BacktestRunsTable();
    const rows = await db.execute(sql`
      SELECT
        id,
        symbol,
        start_ts AS "startTs",
        end_ts AS "endTs",
        mode,
        tier_mode AS "tierMode",
        runtime_model_run_id AS "runtimeModelRunId",
        summary,
        result,
        created_at AS "createdAt"
      FROM v3_backtest_runs
      WHERE id IN (${baselineRunId}, ${policyRunId})
    `);
    const rowMap = new Map<number, PersistedV3RunRow>();
    for (const row of rows.rows as PersistedV3RunRow[]) rowMap.set(Number(row.id), row);
    const baselineRow = rowMap.get(baselineRunId);
    const policyRow = rowMap.get(policyRunId);
    if (!baselineRow || !policyRow) {
      res.status(404).json({ error: "One or both V3 backtest runs were not found" });
      return;
    }
    const baselineResult = asRecord(baselineRow.result) as unknown as V3BacktestResult;
    const policyResult = asRecord(policyRow.result) as unknown as V3BacktestResult;
    const report = await buildCrash300BacktestComparisonReport({
      baselineRunId,
      baselineResult,
      baselineCreatedAt: baselineRow.createdAt,
      policyRunId,
      policyResult,
      policyCreatedAt: policyRow.createdAt,
      includeWindowStability,
    });
    res.json({ ok: true, report });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to compare V3 backtest runs";
    console.error(`[backtest/v3/history/compare] error:`, message);
    res.status(500).json({ error: message });
  }
});

router.get("/backtest/v3/jobs/schema-status", async (_req, res): Promise<void> => {
  try {
    await ensureV3BacktestJobsTable();
    const rows = await db.execute(sql`
      SELECT
        column_name AS "columnName",
        data_type AS "dataType"
      FROM information_schema.columns
      WHERE table_name = 'v3_backtest_jobs'
      ORDER BY ordinal_position
    `);
    res.json({
      ok: true,
      ready: true,
      table: "v3_backtest_jobs",
      columns: rows.rows,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "V3 backtest job schema check failed";
    res.status(500).json({
      ok: false,
      ready: false,
      table: "v3_backtest_jobs",
      error: message,
    });
  }
});

router.get("/backtest/v3/jobs/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid V3 backtest job id" });
    return;
  }
  try {
    await ensureV3BacktestJobsTable();
    const rows = await db.execute(sql`
      SELECT
        id,
        symbol,
        start_ts AS "startTs",
        end_ts AS "endTs",
        mode,
        tier_mode AS "tierMode",
        status,
        phase,
        progress_pct AS "progressPct",
        message,
        error_summary AS "errorSummary",
        result_summary AS "resultSummary",
        persisted_run_ids AS "persistedRunIds",
        params,
        created_at AS "createdAt",
        started_at AS "startedAt",
        completed_at AS "completedAt",
        last_heartbeat_at AS "lastHeartbeatAt"
      FROM v3_backtest_jobs
      WHERE id = ${id}
      LIMIT 1
    `);
    const row = rows.rows[0] as PersistedV3JobRow | undefined;
    if (!row) {
      res.status(404).json({ error: "V3 backtest job not found" });
      return;
    }
    res.json({
      ok: true,
      job: {
        ...row,
        createdAt: toIsoString(row.createdAt),
        startedAt: toIsoString(row.startedAt),
        completedAt: toIsoString(row.completedAt),
        lastHeartbeatAt: toIsoString(row.lastHeartbeatAt),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load V3 backtest job";
    res.status(500).json({ error: message });
  }
});

router.get("/backtest/v3/jobs/:id/result", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid V3 backtest job id" });
    return;
  }
  try {
    await ensureV3BacktestJobsTable();
    const rows = await db.execute(sql`
      SELECT
        id,
        symbol,
        status,
        phase,
        result_summary AS "resultSummary",
        persisted_run_ids AS "persistedRunIds",
        error_summary AS "errorSummary",
        completed_at AS "completedAt"
      FROM v3_backtest_jobs
      WHERE id = ${id}
      LIMIT 1
    `);
    const row = rows.rows[0] as PersistedV3JobRow | undefined;
    if (!row) {
      res.status(404).json({ error: "V3 backtest job not found" });
      return;
    }
    if (String(row.status) !== "completed") {
      res.status(409).json({
        error: "V3 backtest job has not completed yet",
        job: {
          id: row.id,
          symbol: row.symbol,
          status: row.status,
          phase: row.phase,
          completedAt: toIsoString(row.completedAt),
          errorSummary: row.errorSummary ?? null,
        },
      });
      return;
    }
    res.json({
      ok: true,
      result: {
        jobId: row.id,
        symbol: row.symbol,
        status: row.status,
        phase: row.phase,
        completedAt: toIsoString(row.completedAt),
        persistedRunIds: row.persistedRunIds ?? {},
        summaryBySymbol: row.resultSummary ?? {},
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load V3 backtest job result";
    res.status(500).json({ error: message });
  }
});

router.get("/backtest/v3/history/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid backtest run id" });
    return;
  }
  try {
    await ensureV3BacktestRunsTable();
    const rows = await db.execute(sql`
      SELECT
        id,
        symbol,
        start_ts AS "startTs",
        end_ts AS "endTs",
        mode,
        tier_mode AS "tierMode",
        runtime_model_run_id AS "runtimeModelRunId",
        summary,
        result,
        created_at AS "createdAt"
      FROM v3_backtest_runs
      WHERE id = ${id}
      LIMIT 1
    `);
    const row = rows.rows[0] as PersistedV3RunRow | undefined;
    if (!row) {
      res.status(404).json({ error: "V3 backtest history run not found" });
      return;
    }
    res.json({
      ok: true,
      run: {
        ...row,
        createdAt: (() => {
          const raw = (row as unknown as { createdAt?: string | Date }).createdAt;
          if (!raw) return "";
          const d = raw instanceof Date ? raw : new Date(raw);
          return Number.isNaN(d.getTime()) ? String(raw) : d.toISOString();
        })(),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load V3 backtest run";
    res.status(500).json({ error: message });
  }
});

router.get("/backtest/v3/history/:id/attribution", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid backtest run id" });
    return;
  }
  try {
    await ensureV3BacktestRunsTable();
    const rows = await db.execute(sql`
      SELECT
        id,
        symbol,
        start_ts AS "startTs",
        end_ts AS "endTs",
        mode,
        tier_mode AS "tierMode",
        runtime_model_run_id AS "runtimeModelRunId",
        summary,
        result,
        created_at AS "createdAt"
      FROM v3_backtest_runs
      WHERE id = ${id}
      LIMIT 1
    `);
    const row = rows.rows[0] as PersistedV3RunRow | undefined;
    if (!row) {
      res.status(404).json({ error: "V3 backtest history run not found" });
      return;
    }
    const result = asRecord(row.result) as unknown as V3BacktestResult;
    if (String(row.symbol).toUpperCase() !== "CRASH300") {
      res.status(400).json({ error: "Trade-outcome attribution is currently available for CRASH300 only" });
      return;
    }
    const report = await buildCrash300TradeOutcomeAttributionReport({
      runId: row.id,
      result,
      createdAt: row.createdAt,
    });
    res.json({ ok: true, report });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to build trade-outcome attribution report";
    console.error(`[backtest/v3/history/${id}/attribution] error:`, message);
    res.status(500).json({ error: message });
  }
});

router.get("/backtest/v3/history/:id/calibration-reconciliation", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid backtest run id" });
    return;
  }
  try {
    await ensureV3BacktestRunsTable();
    const rows = await db.execute(sql`
      SELECT
        id,
        symbol,
        start_ts AS "startTs",
        end_ts AS "endTs",
        mode,
        tier_mode AS "tierMode",
        runtime_model_run_id AS "runtimeModelRunId",
        summary,
        result,
        created_at AS "createdAt"
      FROM v3_backtest_runs
      WHERE id = ${id}
      LIMIT 1
    `);
    const row = rows.rows[0] as PersistedV3RunRow | undefined;
    if (!row) {
      res.status(404).json({ error: "V3 backtest history run not found" });
      return;
    }
    const result = asRecord(row.result) as unknown as V3BacktestResult;
    if (String(row.symbol).toUpperCase() !== "CRASH300") {
      res.status(400).json({ error: "Calibration reconciliation is currently available for CRASH300 only" });
      return;
    }
    const report = await buildCrash300CalibrationReconciliationReport({
      runId: row.id,
      result,
      createdAt: row.createdAt,
    });
    res.json({ ok: true, report });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to build calibration reconciliation report";
    console.error(`[backtest/v3/history/${id}/calibration-reconciliation] error:`, message);
    res.status(500).json({ error: message });
  }
});

export default router;
