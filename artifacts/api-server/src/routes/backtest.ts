import { Router, type IRouter } from "express";
import { desc, eq, asc } from "drizzle-orm";
import { db, backtestRunsTable, backtestTradesTable, candlesTable } from "@workspace/db";
import { analyseBacktest, isOpenAIConfigured } from "../lib/openai.js";
import {
  runBacktestSimulation,
  runFullBacktest,
  type BacktestConfig,
  type BacktestResult,
} from "../lib/backtestEngine.js";

const router: IRouter = Router();

export { runBacktestSimulation } from "../lib/backtestEngine.js";

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

router.post("/backtest/run", async (req, res): Promise<void> => {
  const {
    strategyName = "trend-pullback",
    symbol = "BOOM1000",
    initialCapital = 10000,
    allocationMode = "balanced",
    walkForward,
  } = req.body ?? {};

  const validStrategies = [
    "trend-pullback", "exhaustion-rebound", "volatility-breakout", "spike-hazard",
    "volatility-expansion", "liquidity-sweep", "macro-bias",
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
  const limit = Math.min(Number(req.query.limit || 20), 100);
  const rows = await db.select().from(backtestRunsTable)
    .orderBy(desc(backtestRunsTable.createdAt))
    .limit(limit);
  res.json(rows.map(r => ({
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
  })));
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

export default router;
