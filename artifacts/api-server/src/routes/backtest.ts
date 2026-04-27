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
} from "../core/backtest/backtestRunner.js";
import { ACTIVE_SYMBOLS } from "../core/engineTypes.js";

const router: IRouter = Router();

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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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
      );
      results = multi as Record<string, unknown>;
    } else {
      const single = await runV3Backtest({
        symbol,
        startTs: parsedStart,
        endTs: parsedEnd,
        mode,
        tierMode: normalizedTierMode as "A" | "AB" | "ABC" | "ALL",
      });
      results = { [symbol]: single };
    }

    const totalTrades = Object.values(results).reduce(
      (sum: number, r) => sum + ((r as { trades: unknown[] }).trades?.length ?? 0), 0
    );

    const persistedRunIds: Record<string, number> = {};
    for (const [sym, raw] of Object.entries(results)) {
      const result = asRecord(raw);
      const runtimeModel = asRecord(result.runtimeModel);
      const summary = asRecord(result.summary);
      const tierModeResult = String(result.tierMode ?? normalizedTierMode ?? "ALL").toUpperCase();
      const modeResult = String(result.mode ?? mode ?? "paper");
      const startTsResult = Number(result.startTs ?? parsedStart ?? 0);
      const endTsResult = Number(result.endTs ?? parsedEnd ?? Math.floor(Date.now() / 1000));
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
      if (insertedId > 0) {
        persistedRunIds[sym] = insertedId;
      }
    }

    res.json({
      ok: true,
      symbol,
      totalTrades,
      results,
      persistedRunIds,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "V3 backtest failed";
    console.error("[backtest/v3/run] error:", message);
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

export default router;
