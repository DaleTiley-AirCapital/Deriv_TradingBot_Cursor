import { Router, type IRouter } from "express";
import { desc, eq, asc } from "drizzle-orm";
import { db, backtestRunsTable, backtestTradesTable, candlesTable } from "@workspace/db";
import { computeFeatures } from "../lib/features.js";
import { runAllStrategies } from "../lib/strategies.js";
import { analyseBacktest, isOpenAIConfigured } from "../lib/openai.js";

const router: IRouter = Router();

interface TradeRecord {
  pnl: number;
  holdingCandles: number;
  entryTs: Date;
  exitTs: Date;
  direction: string;
  entryPrice: number;
  exitPrice: number;
  exitReason: string;
}

export async function runBacktestSimulation(
  strategyName: string,
  symbol: string,
  initialCapital: number,
  allocationMode: string
): Promise<{
  totalReturn: number; netProfit: number; winRate: number; profitFactor: number;
  maxDrawdown: number; tradeCount: number; avgHoldingHours: number;
  expectancy: number; sharpeRatio: number; trades: TradeRecord[];
  equityCurve: { ts: string; equity: number }[];
}> {
  const candles = await db.select().from(candlesTable)
    .where(eq(candlesTable.symbol, symbol))
    .orderBy(desc(candlesTable.openTs))
    .limit(600);

  if (candles.length < 60) {
    throw new Error(
      `Insufficient candle data for ${symbol}: only ${candles.length} candles available (minimum 60 required). ` +
      `Start the data stream and wait for historical candles to accumulate before running a backtest.`
    );
  }

  candles.reverse();

  const trades: TradeRecord[] = [];
  let equity = initialCapital;
  let peak = initialCapital;
  let maxDrawdown = 0;
  const equityCurve: { ts: string; equity: number }[] = [
    { ts: new Date(candles[0].openTs * 1000).toISOString(), equity: initialCapital }
  ];

  for (let i = 50; i < candles.length - 20; i += 15) {
    const windowCandles = candles.slice(0, i + 1);
    const closes = windowCandles.map(c => c.close);
    const last = windowCandles[windowCandles.length - 1];

    const ema20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const price = last.close;
    const distFromEma = (price - ema20) / ema20;
    const changes = closes.slice(-14).map((c, i, arr) => i > 0 ? c - arr[i - 1] : 0).slice(1);
    const gains = changes.filter(c => c > 0);
    const losses = changes.filter(c => c < 0).map(Math.abs);
    const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / 14 : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / 14 : 0.001;
    const rsi = 100 - 100 / (1 + avgGain / avgLoss);

    let signal = false;
    let direction = 1;
    let directionStr = "long";

    switch (strategyName) {
      case "trend-pullback":
        signal = Math.abs(distFromEma) < 0.01 && rsi > 40 && rsi < 65;
        direction = distFromEma >= 0 ? 1 : -1;
        directionStr = direction === 1 ? "long" : "short";
        break;
      case "exhaustion-rebound":
        signal = rsi < 32 || rsi > 68;
        direction = rsi < 32 ? 1 : -1;
        directionStr = direction === 1 ? "long" : "short";
        break;
      case "volatility-breakout": {
        const std = Math.sqrt(closes.slice(-20).reduce((acc, c) => acc + (c - ema20) ** 2, 0) / 20);
        signal = std / ema20 < 0.005 && Math.abs(distFromEma) > 0.003;
        direction = distFromEma > 0 ? 1 : -1;
        directionStr = direction === 1 ? "long" : "short";
        break;
      }
      case "spike-hazard":
        signal = Math.random() < 0.15;
        direction = symbol.startsWith("BOOM") ? 1 : -1;
        directionStr = direction === 1 ? "long" : "short";
        break;
    }

    if (!signal) continue;

    const recentPrices = closes.slice(-20);
    const atrPct = recentPrices.length >= 2
      ? recentPrices.map((c, idx, arr) => idx > 0 ? Math.abs(c - arr[idx - 1]) / arr[idx - 1] : 0).slice(1).reduce((a, b) => a + b, 0) / (recentPrices.length - 1)
      : 0.005;
    const slPct = atrPct * 1.5;
    const tpPct = atrPct * 2.0;
    const sl = direction === 1 ? price * (1 - slPct) : price * (1 + slPct);
    const tp = direction === 1 ? price * (1 + tpPct) : price * (1 - tpPct);

    const entryCandle = last;
    const candleDurationMs = i > 0
      ? Math.abs(candles[i].openTs - candles[i - 1].openTs) * 1000
      : 3600000;
    const maxHoldMs = 120 * 3600000;
    const maxHoldCandles = Math.ceil(maxHoldMs / Math.max(candleDurationMs, 1000));

    let exitCandle = candles[Math.min(i + maxHoldCandles, candles.length - 1)];
    let exitPrice = exitCandle.close;
    let exitReason = "TIME";
    let holdingCandles = maxHoldCandles;

    for (let j = i + 1; j <= Math.min(i + maxHoldCandles, candles.length - 1); j++) {
      const c = candles[j];
      const slHit = direction === 1 ? c.low <= sl : c.high >= sl;
      const tpHit = direction === 1 ? c.high >= tp : c.low <= tp;
      if (tpHit) {
        exitCandle = c;
        exitPrice = tp;
        exitReason = "TP";
        holdingCandles = j - i;
        break;
      }
      if (slHit) {
        exitCandle = c;
        exitPrice = sl;
        exitReason = "SL";
        holdingCandles = j - i;
        break;
      }
    }

    const sizePct = allocationMode === "aggressive" ? 0.4 : allocationMode === "conservative" ? 0.15 : 0.25;
    const positionSize = equity * sizePct;
    const priceDiff = (exitPrice - price) / price * direction;
    const pnl = positionSize * priceDiff;

    trades.push({
      pnl,
      holdingCandles,
      entryTs: new Date(entryCandle.openTs * 1000),
      exitTs: new Date(exitCandle.openTs * 1000),
      direction: directionStr,
      entryPrice: price,
      exitPrice,
      exitReason,
    });

    equity += pnl;
    if (equity > peak) peak = equity;
    const dd = (equity - peak) / peak;
    if (dd < maxDrawdown) maxDrawdown = dd;
    equityCurve.push({ ts: new Date(exitCandle.openTs * 1000).toISOString(), equity });
  }

  if (trades.length === 0) {
    return {
      totalReturn: 0, netProfit: 0, winRate: 0, profitFactor: 0,
      maxDrawdown: 0, tradeCount: 0, avgHoldingHours: 0, expectancy: 0, sharpeRatio: 0,
      trades: [],
      equityCurve: [{ ts: new Date(candles[0].openTs * 1000).toISOString(), equity: initialCapital }],
    };
  }

  const wins = trades.filter(t => t.pnl > 0);
  const lossTrades = trades.filter(t => t.pnl <= 0);
  const winRate = wins.length / trades.length;
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(lossTrades.reduce((s, t) => s + t.pnl, 0));
  const netProfit = equity - initialCapital;
  const avgHoldingHours = trades.reduce((s, t) => s + (t.exitTs.getTime() - t.entryTs.getTime()) / 3600000, 0) / trades.length;
  const expectancy = netProfit / trades.length;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit;
  const totalReturn = netProfit / initialCapital;

  const returns = equityCurve.slice(1).map((v, i) => (v.equity - equityCurve[i].equity) / equityCurve[i].equity);
  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const stdReturn = Math.sqrt(returns.reduce((a, b) => a + (b - meanReturn) ** 2, 0) / returns.length);
  const sharpeRatio = stdReturn > 0 ? (meanReturn / stdReturn) * Math.sqrt(252) : 0;

  return {
    totalReturn, netProfit, winRate, profitFactor,
    maxDrawdown, tradeCount: trades.length, avgHoldingHours, expectancy, sharpeRatio,
    trades, equityCurve,
  };
}

router.post("/backtest/run", async (req, res): Promise<void> => {
  const {
    strategyName = "trend-pullback",
    symbol = "BOOM1000",
    initialCapital = 10000,
    allocationMode = "balanced",
  } = req.body ?? {};

  const validStrategies = ["trend-pullback", "exhaustion-rebound", "volatility-breakout", "spike-hazard"];
  if (!validStrategies.includes(strategyName)) {
    res.status(400).json({ error: `Invalid strategy. Use: ${validStrategies.join(", ")}` });
    return;
  }

  try {
    const result = await runBacktestSimulation(strategyName, symbol, initialCapital, allocationMode);

    const [row] = await db.insert(backtestRunsTable).values({
      strategyName,
      symbol,
      initialCapital,
      totalReturn: result.totalReturn,
      netProfit: result.netProfit,
      winRate: result.winRate,
      profitFactor: result.profitFactor,
      maxDrawdown: result.maxDrawdown,
      tradeCount: result.tradeCount,
      avgHoldingHours: result.avgHoldingHours,
      expectancy: result.expectancy,
      sharpeRatio: result.sharpeRatio,
      configJson: { allocationMode, symbol, strategyName },
      metricsJson: { equityCurve: result.equityCurve },
      status: "completed",
    }).returning();

    if (row && result.trades.length > 0) {
      await db.insert(backtestTradesTable).values(
        result.trades.map(t => ({
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

    res.json({
      success: true,
      message: `Backtest '${strategyName}' on ${symbol} complete. ${result.tradeCount} trades, win rate ${(result.winRate * 100).toFixed(1)}%, net P&L $${result.netProfit.toFixed(2)}. ID: ${row?.id}`,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ success: false, message: `Backtest failed: ${message}` });
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
    .orderBy(desc(candlesTable.openTs))
    .limit(600);
  candles.reverse();
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
