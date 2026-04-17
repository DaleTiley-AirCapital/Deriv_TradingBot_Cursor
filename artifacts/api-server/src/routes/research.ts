import { Router, type IRouter } from "express";
import { eq, and, count, min, max, desc, lt, asc, gte, sql } from "drizzle-orm";
import { db, candlesTable, backtestRunsTable, backtestTradesTable, platformStateTable } from "@workspace/db";
import { getDerivClientWithDbToken, ACTIVE_TRADING_SYMBOLS, V1_DEFAULT_SYMBOLS, ALL_SYMBOLS } from "../infrastructure/deriv.js";
import { getApiSymbol } from "../infrastructure/symbolValidator.js";
import { runSymbolBacktest } from "../runtimes/backtestEngine.js";
import { isOpenAIConfigured, chatComplete } from "../infrastructure/openai.js";
import { retrieveContext } from "../core/ai/contextRetriever.js";

const router: IRouter = Router();

const STRATEGIES = ["trend_continuation", "mean_reversion", "spike_cluster_recovery", "swing_exhaustion", "trendline_breakout"] as const;
const GRANULARITY_1M = 60;
const GRANULARITY_5M = 300;
const MAX_BATCH = 5000;
const MAX_CONSECUTIVE_ERRORS = 5;
const API_RATE_DELAY_MS = 150;
const DEFAULT_CAPITAL = 600;
const TWELVE_MONTHS_SECONDS = 365 * 24 * 3600;

export async function pruneOldCandles(): Promise<number> {
  const cutoffEpoch = Math.floor(Date.now() / 1000) - TWELVE_MONTHS_SECONDS;
  const result = await db.delete(candlesTable).where(lt(candlesTable.openTs, cutoffEpoch));
  const deletedCount = (result as { rowCount?: number }).rowCount ?? 0;
  if (deletedCount > 0) {
    console.log(`[DataRetention] Pruned ${deletedCount} candles older than 12 months (cutoff: ${new Date(cutoffEpoch * 1000).toISOString()})`);
  }
  return deletedCount;
}

async function getSymbolStatus(symbol: string) {
  const [r1m] = await db.select({ n: count() }).from(candlesTable)
    .where(and(eq(candlesTable.symbol, symbol), eq(candlesTable.timeframe, "1m")));
  const [r5m] = await db.select({ n: count() }).from(candlesTable)
    .where(and(eq(candlesTable.symbol, symbol), eq(candlesTable.timeframe, "5m")));

  const [oldest1m] = await db.select({ ts: min(candlesTable.openTs) }).from(candlesTable)
    .where(and(eq(candlesTable.symbol, symbol), eq(candlesTable.timeframe, "1m")));
  const [newest1m] = await db.select({ ts: max(candlesTable.openTs) }).from(candlesTable)
    .where(and(eq(candlesTable.symbol, symbol), eq(candlesTable.timeframe, "1m")));

  const [latestBt] = await db.select({
    createdAt: backtestRunsTable.createdAt,
  }).from(backtestRunsTable)
    .where(eq(backtestRunsTable.symbol, symbol))
    .orderBy(desc(backtestRunsTable.createdAt))
    .limit(1);

  const count1m = r1m?.n ?? 0;
  const count5m = r5m?.n ?? 0;
  const totalCandles = count1m + count5m;
  const oldestDate = oldest1m?.ts ? new Date((oldest1m.ts as number) * 1000).toISOString() : null;
  const newestDate = newest1m?.ts ? new Date((newest1m.ts as number) * 1000).toISOString() : null;
  const lastBacktestDate = latestBt?.createdAt?.toISOString() ?? null;

  let status: "healthy" | "stale" | "no_data" = "no_data";
  if (totalCandles > 0 && lastBacktestDate) {
    const daysSinceBacktest = (Date.now() - new Date(lastBacktestDate).getTime()) / (1000 * 3600 * 24);
    status = daysSinceBacktest <= 31 ? "healthy" : "stale";
  } else if (totalCandles > 0) {
    status = "stale";
  }

  const tier: "active" | "data" | "research" =
    ACTIVE_TRADING_SYMBOLS.includes(symbol) ? "active" :
    V1_DEFAULT_SYMBOLS.includes(symbol) ? "data" : "research";

  return {
    symbol,
    tier,
    count1m,
    count5m,
    totalCandles,
    oldestDate,
    newestDate,
    lastBacktestDate,
    status,
  };
}

router.get("/research/data-status", async (_req, res): Promise<void> => {
  try {
    const symbolStatuses = await Promise.all(ALL_SYMBOLS.map(getSymbolStatus));
    const totalStorage = symbolStatuses.reduce((s, r) => s + r.totalCandles, 0);

    res.json({
      symbols: symbolStatuses,
      totalStorage,
      symbolCount: ALL_SYMBOLS.length,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

router.post("/research/download-simulate", async (req, res): Promise<void> => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const { symbol } = req.body ?? {};

  if (!symbol || !ALL_SYMBOLS.includes(symbol)) {
    send({ phase: "error", message: `Invalid symbol: ${symbol}` });
    res.end();
    return;
  }

  try {
    send({ phase: "download_start", symbol, message: `Checking data for ${symbol}...` });

    const client = await getDerivClientWithDbToken();
    await client.connect();
    const apiSymbol = getApiSymbol(symbol);

    const nowEpoch = Math.floor(Date.now() / 1000);
    const oneYearAgoEpoch = nowEpoch - TWELVE_MONTHS_SECONDS;

    const timeframes = [
      { tf: "1m" as const, granularity: GRANULARITY_1M },
      { tf: "5m" as const, granularity: GRANULARITY_5M },
    ];

    let totalInserted = 0;
    let allSkipped = true;

    for (const { tf, granularity } of timeframes) {
      const coverageResult = await db
        .select({
          cnt: count(),
          maxTs: sql<number>`MAX(${candlesTable.openTs})`,
        })
        .from(candlesTable)
        .where(and(eq(candlesTable.symbol, symbol), eq(candlesTable.timeframe, tf)));
      const existingCnt = coverageResult[0]?.cnt ?? 0;
      const existingMaxTs = coverageResult[0]?.maxTs ?? 0;

      const minSufficientCount = tf === "1m" ? 200_000 : 40_000;
      const hasEnoughData = existingCnt >= minSufficientCount;
      const isRecent = existingMaxTs > 0 && existingMaxTs >= nowEpoch - Math.max(granularity * 2, 3600);
      const stopEpoch = (existingMaxTs > oneYearAgoEpoch && hasEnoughData) ? existingMaxTs + 1 : oneYearAgoEpoch;

      if (isRecent && hasEnoughData) {
        send({
          phase: "download_progress", symbol, tf,
          candles: existingCnt,
          message: `${symbol} ${tf}: up to date (${existingCnt.toLocaleString()} candles), skipping...`,
        });
        totalInserted += existingCnt;
        continue;
      }

      allSkipped = false;
      if (existingCnt > 0) {
        send({
          phase: "download_progress", symbol, tf,
          candles: existingCnt,
          message: `${symbol} ${tf}: ${existingCnt.toLocaleString()} candles exist, gap-filling to now...`,
        });
      }

      let endEpoch = nowEpoch;
      let page = 0;
      let consecutiveErrors = 0;

      while (true) {
        page++;
        let candles;
        try {
          candles = await client.getCandleHistoryWithEnd(apiSymbol, granularity, MAX_BATCH, endEpoch, true);
          consecutiveErrors = 0;
        } catch (err) {
          consecutiveErrors++;
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            send({ phase: "download_error", symbol, tf, message: `Failed after ${consecutiveErrors} retries for ${symbol} ${tf}` });
            break;
          }
          const errMsg = err instanceof Error ? err.message : String(err);
          if (errMsg.includes("not connected") || errMsg.includes("timed out")) {
            await new Promise(r => setTimeout(r, 3000));
            try { await client.connect(); } catch { await new Promise(r => setTimeout(r, 5000)); }
          } else {
            await new Promise(r => setTimeout(r, 2000));
          }
          continue;
        }

        if (!candles || candles.length === 0) break;

        const sorted = [...candles].sort((a, b) => a.epoch - b.epoch);
        const earliestEpoch = sorted[0].epoch;

        const filtered = sorted.filter(c => c.epoch >= stopEpoch);
        if (filtered.length > 0) {
          const newRows = filtered.map(c => ({
            symbol, timeframe: tf, openTs: c.epoch, closeTs: c.epoch + granularity,
            open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), tickCount: 0,
          }));
          for (let chunk = 0; chunk < newRows.length; chunk += 1000) {
            await db.insert(candlesTable).values(newRows.slice(chunk, chunk + 1000))
              .onConflictDoNothing({ target: [candlesTable.symbol, candlesTable.timeframe, candlesTable.openTs] });
          }
          totalInserted += newRows.length;
        }

        if (earliestEpoch <= stopEpoch) break;
        if (candles.length < MAX_BATCH) break;

        const newEnd = earliestEpoch - 1;
        if (newEnd >= endEpoch || newEnd < stopEpoch) break;
        endEpoch = newEnd;

        if (page % 3 === 0) {
          send({
            phase: "download_progress", symbol, tf,
            candles: totalInserted,
            message: `${symbol} ${tf}: ${totalInserted.toLocaleString()} candles downloaded...`,
          });
        }

        await new Promise(r => setTimeout(r, API_RATE_DELAY_MS));
      }
    }

    send({
      phase: "download_complete", symbol,
      candles: totalInserted,
      message: allSkipped
        ? `${symbol}: all data up to date (${totalInserted.toLocaleString()} candles), running simulation...`
        : `Download complete: ${totalInserted.toLocaleString()} candles for ${symbol}`,
    });

    send({ phase: "backtest_start", symbol, message: `Running all strategies on ${symbol}...` });

    const states = await db.select().from(platformStateTable);
    const stateMap: Record<string, string> = {};
    for (const s of states) stateMap[s.key] = s.value;
    const initialCapital = parseFloat(stateMap["total_capital"] || String(DEFAULT_CAPITAL));

    try {
      const btResult = await runSymbolBacktest(symbol, initialCapital, "balanced");

      const [row] = await db.insert(backtestRunsTable).values({
          strategyName: "all_strategies",
          symbol,
          initialCapital,
          totalReturn: btResult.portfolioMetrics.totalReturn,
          netProfit: btResult.portfolioMetrics.netProfit,
          winRate: btResult.portfolioMetrics.winRate,
          profitFactor: btResult.portfolioMetrics.profitFactor,
          maxDrawdown: btResult.portfolioMetrics.maxDrawdown,
          tradeCount: btResult.portfolioMetrics.tradeCount,
          avgHoldingHours: btResult.portfolioMetrics.avgHoldingHours,
          expectancy: btResult.portfolioMetrics.expectancy,
          sharpeRatio: btResult.portfolioMetrics.sharpeRatio,
          configJson: {
            allocationMode: "balanced",
            symbol,
            strategies: btResult.profitableStrategies.map(s => s.strategyName),
            source: "research-download-simulate",
          },
          metricsJson: {
            equityCurve: btResult.portfolioMetrics.equityCurve,
            strategyBreakdown: btResult.profitableStrategies,
          },
          status: "completed",
        }).returning();

        if (row && btResult.trades.length > 0) {
          for (let i = 0; i < btResult.trades.length; i += 500) {
            const batch = btResult.trades.slice(i, i + 500);
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

        const profitableCount = btResult.profitableStrategies.filter(s => s.netProfit > 0).length;
        send({
          phase: "backtest_complete", symbol,
          profitableStrategies: btResult.profitableStrategies,
          portfolioMetrics: {
            netProfit: btResult.portfolioMetrics.netProfit,
            winRate: btResult.portfolioMetrics.winRate,
            profitFactor: btResult.portfolioMetrics.profitFactor,
            tradeCount: btResult.portfolioMetrics.tradeCount,
          },
          message: `Backtest complete: ${profitableCount} profitable strategies, ${btResult.portfolioMetrics.tradeCount} total trades`,
        });
    } catch (btErr) {
      send({
        phase: "backtest_error", symbol,
        message: `Backtest failed: ${btErr instanceof Error ? btErr.message : "Unknown error"}`,
      });
    }

    send({ phase: "complete", symbol, message: `Download & simulate complete for ${symbol}` });
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    send({ phase: "error", message: err instanceof Error ? err.message : "Unknown error" });
    res.end();
  }
});

router.post("/research/rerun-backtest", async (req, res): Promise<void> => {
  const { symbol, historicYears } = req.body ?? {};

  if (!symbol || !ALL_SYMBOLS.includes(symbol)) {
    res.status(400).json({ error: `Invalid symbol: ${symbol}` });
    return;
  }

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Transfer-Encoding", "chunked");

  const send = (obj: Record<string, unknown>) => res.write(JSON.stringify(obj) + "\n");

  try {
    const years = Number.isInteger(historicYears) && historicYears >= 1 && historicYears <= 5 ? historicYears : 1;
    const requestedStart = new Date(Date.now() - years * 365 * 24 * 3600 * 1000);

    const [minRow] = await db.select({ minTs: min(candlesTable.openTs) })
      .from(candlesTable)
      .where(eq(candlesTable.symbol, symbol));

    const earliestDate = minRow?.minTs != null ? new Date((minRow.minTs as number) * 1000) : null;
    const startDate = earliestDate && earliestDate > requestedStart ? earliestDate : requestedStart;
    const monthsInWindow = Math.round((Date.now() - startDate.getTime()) / (30 * 24 * 3600 * 1000));

    send({ phase: "starting", symbol, message: `Running on ~${monthsInWindow} month(s) of data (requested ${years} year${years !== 1 ? "s" : ""})` });

    const states = await db.select().from(platformStateTable);
    const stateMap: Record<string, string> = {};
    for (const s of states) stateMap[s.key] = s.value;
    const initialCapital = parseFloat(stateMap["total_capital"] || String(DEFAULT_CAPITAL));

    send({ phase: "running", symbol, message: "Starting simulation…", pct: 0 });

    const btResult = await runSymbolBacktest(
      symbol,
      initialCapital,
      "balanced",
      (evt) => {
        const msg = evt.strategyName
          ? `[${evt.dateLabel}] Signal: ${evt.strategyName} ${evt.direction ?? ""} score=${evt.score}`
          : `[${evt.dateLabel}] ${evt.openPositions} open position${evt.openPositions !== 1 ? "s" : ""}`;
        send({
          phase: "progress",
          symbol,
          pct: evt.pct,
          message: msg,
          strategyName: evt.strategyName,
          direction: evt.direction,
          score: evt.score,
          openPositions: evt.openPositions,
          dateLabel: evt.dateLabel,
        });
      },
      startDate,
    );

    send({ phase: "saving", symbol, message: "Saving results to database…" });

    const [row] = await db.insert(backtestRunsTable).values({
        strategyName: "all_strategies",
        symbol,
        initialCapital,
        totalReturn: btResult.portfolioMetrics.totalReturn,
        netProfit: btResult.portfolioMetrics.netProfit,
        winRate: btResult.portfolioMetrics.winRate,
        profitFactor: btResult.portfolioMetrics.profitFactor,
        maxDrawdown: btResult.portfolioMetrics.maxDrawdown,
        tradeCount: btResult.portfolioMetrics.tradeCount,
        avgHoldingHours: btResult.portfolioMetrics.avgHoldingHours,
        expectancy: btResult.portfolioMetrics.expectancy,
        sharpeRatio: btResult.portfolioMetrics.sharpeRatio,
        configJson: {
          allocationMode: "balanced",
          symbol,
          strategies: btResult.profitableStrategies.map(s => s.strategyName),
          source: "research-rerun",
        },
        metricsJson: {
          equityCurve: btResult.portfolioMetrics.equityCurve,
          strategyBreakdown: btResult.profitableStrategies,
        },
        status: "completed",
      }).returning();

      if (row && btResult.trades.length > 0) {
        for (let i = 0; i < btResult.trades.length; i += 500) {
          const batch = btResult.trades.slice(i, i + 500);
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

      const profitableCount = btResult.profitableStrategies.filter(s => s.netProfit > 0).length;
      send({
        phase: "done",
        success: true,
        symbol,
        backtestId: row?.id,
        profitableStrategies: btResult.profitableStrategies,
        portfolioMetrics: {
          netProfit: btResult.portfolioMetrics.netProfit,
          winRate: btResult.portfolioMetrics.winRate,
          profitFactor: btResult.portfolioMetrics.profitFactor,
          tradeCount: btResult.portfolioMetrics.tradeCount,
        },
        message: `${profitableCount} profitable strategies, ${btResult.portfolioMetrics.tradeCount} total trades`,
      });
      res.end();
  } catch (err) {
    send({ phase: "error", error: err instanceof Error ? err.message : "Unknown error" });
    res.end();
  }
});

router.post("/research/ai-chat", async (req, res): Promise<void> => {
  const { backtestId, message } = req.body ?? {};

  if (!backtestId || !message) {
    res.status(400).json({ error: "backtestId and message are required" });
    return;
  }

  const configured = await isOpenAIConfigured();
  if (!configured) {
    res.status(400).json({ error: "OpenAI API key not configured. Set it in Settings." });
    return;
  }

  try {
    const [run] = await db.select().from(backtestRunsTable).where(eq(backtestRunsTable.id, backtestId));
    if (!run) {
      res.status(404).json({ error: "Backtest not found" });
      return;
    }

    const trades = await db.select().from(backtestTradesTable)
      .where(eq(backtestTradesTable.backtestRunId, backtestId))
      .orderBy(asc(backtestTradesTable.entryTs));

    const metricsJson = run.metricsJson as Record<string, unknown> | null;
    const configJson = run.configJson as Record<string, unknown> | null;

    const tradesSummary = trades.slice(0, 50).map((t, i) => {
      const pnl = t.pnl ?? 0;
      return `Trade #${i + 1}: ${t.direction} @ ${t.entryPrice.toFixed(4)} → ${t.exitPrice?.toFixed(4) ?? "open"}, P&L: $${pnl.toFixed(2)}, Exit: ${t.exitReason ?? "N/A"}, Entry: ${t.entryTs.toISOString().slice(0, 16)}`;
    }).join("\n");

    const strategyBreakdown = metricsJson?.strategyBreakdown
      ? JSON.stringify(metricsJson.strategyBreakdown, null, 2)
      : "N/A";

    const systemPrompt = `You are a quantitative trading analyst for the Deriv Trading - Long Hold platform.
You are answering questions about a specific backtest result.

BACKTEST CONTEXT:
- ID: ${run.id}
- Symbol: ${run.symbol}
- Strategy: ${run.strategyName}
- Initial Capital: $${run.initialCapital.toFixed(2)}
- Net Profit: $${(run.netProfit ?? 0).toFixed(2)}
- Total Return: ${((run.totalReturn ?? 0) * 100).toFixed(2)}%
- Win Rate: ${((run.winRate ?? 0) * 100).toFixed(1)}%
- Profit Factor: ${(run.profitFactor ?? 0).toFixed(2)}
- Max Drawdown: ${((run.maxDrawdown ?? 0) * 100).toFixed(2)}%
- Trade Count: ${run.tradeCount ?? 0}
- Avg Holding: ${(run.avgHoldingHours ?? 0).toFixed(1)} hours
- Sharpe Ratio: ${(run.sharpeRatio ?? 0).toFixed(2)}
- Expectancy: $${(run.expectancy ?? 0).toFixed(2)}

STRATEGY BREAKDOWN:
${strategyBreakdown}

TRADE LOG (up to 50 trades):
${tradesSummary || "No trades recorded"}

CONFIG:
${configJson ? JSON.stringify(configJson, null, 2) : "N/A"}

Answer the user's question about this backtest concisely and with specific data references. If asked about patterns, cite specific trade numbers and times.`;

    const retrievedCtx = await retrieveContext(`${message} backtest analysis`, 6).catch(() => "");
    const retrievedSection = retrievedCtx ? `=== RETRIEVED SYSTEM CONTEXT ===\n${retrievedCtx}\n\n` : "";
    const response = await chatComplete({
      messages: [
        { role: "system", content: retrievedSection + systemPrompt },
        { role: "user", content: message },
      ],
      max_completion_tokens: 800,
      temperature: 0.4,
    });

    const answer = response.choices[0]?.message?.content?.trim() || "No response generated.";
    res.json({ answer, backtestId });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "AI chat failed" });
  }
});

router.get("/research/backtest-history", async (req, res): Promise<void> => {
  const symbol = req.query.symbol as string;
  if (!symbol) {
    res.status(400).json({ error: "symbol required" });
    return;
  }

  try {
    const runs = await db.select({
      id: backtestRunsTable.id,
      createdAt: backtestRunsTable.createdAt,
      netProfit: backtestRunsTable.netProfit,
      winRate: backtestRunsTable.winRate,
      profitFactor: backtestRunsTable.profitFactor,
      tradeCount: backtestRunsTable.tradeCount,
      metricsJson: backtestRunsTable.metricsJson,
      configJson: backtestRunsTable.configJson,
    }).from(backtestRunsTable)
      .where(and(
        eq(backtestRunsTable.symbol, symbol),
        eq(backtestRunsTable.strategyName, "all_strategies"),
        eq(backtestRunsTable.status, "completed"),
      ))
      .orderBy(desc(backtestRunsTable.createdAt))
      .limit(20);

    res.json({ runs });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

router.post("/research/prune-data", async (_req, res): Promise<void> => {
  try {
    const deleted = await pruneOldCandles();
    res.json({ success: true, deletedCandles: deleted });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

/**
 * POST /research/ai-analyze
 * Runs AI research analysis on stored candle data for a symbol.
 * Synchronous — waits for completion and returns the full report.
 *
 * Body: { symbol: string, windowDays?: number }
 */
router.post("/research/ai-analyze", async (req, res): Promise<void> => {
  const { symbol, windowDays } = req.body ?? {};

  if (!symbol || typeof symbol !== "string") {
    res.status(400).json({ error: "symbol is required" });
    return;
  }

  if (!ALL_SYMBOLS.includes(symbol)) {
    res.status(400).json({ error: `Unknown symbol: ${symbol}` });
    return;
  }

  try {
    const { analyzeSymbol } = await import("../core/aiResearchJob.js");
    const report = await analyzeSymbol(symbol, typeof windowDays === "number" ? windowDays : 365);
    res.json({ success: true, report });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "AI analysis failed" });
  }
});

/**
 * POST /research/ai-analyze/background
 * Fires AI research analysis in background (non-blocking).
 * Poll /research/ai-analyze/status for results.
 *
 * Body: { symbol: string, windowDays?: number }
 */
router.post("/research/ai-analyze/background", async (req, res): Promise<void> => {
  const { symbol, windowDays } = req.body ?? {};

  if (!symbol || typeof symbol !== "string") {
    res.status(400).json({ error: "symbol is required" });
    return;
  }

  if (!ALL_SYMBOLS.includes(symbol)) {
    res.status(400).json({ error: `Unknown symbol: ${symbol}` });
    return;
  }

  try {
    const { runResearchJobBackground } = await import("../core/aiResearchJob.js");
    runResearchJobBackground(symbol, typeof windowDays === "number" ? windowDays : 365);
    res.json({ success: true, message: `AI research job started for ${symbol}` });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to start job" });
  }
});

/**
 * GET /research/ai-analyze/status
 * Returns the current AI research job status and any completed results.
 */
router.get("/research/ai-analyze/status", async (_req, res): Promise<void> => {
  try {
    const { getResearchJobStatus } = await import("../core/aiResearchJob.js");
    const status = getResearchJobStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

/**
 * POST /research/data-top-up
 * Triggers a data integrity top-up for a symbol.
 * Detects and repairs 1m/5m gaps from the API, then re-runs enrichment for all derived TFs.
 * Background-capable via query param: ?background=true
 *
 * Body: { symbol: string }
 */
router.post("/research/data-top-up", async (req, res): Promise<void> => {
  const { symbol } = req.body ?? {};
  const background = req.query.background === "true";

  if (!symbol || typeof symbol !== "string") {
    res.status(400).json({ error: "symbol is required" });
    return;
  }

  if (!ALL_SYMBOLS.includes(symbol)) {
    res.status(400).json({ error: `Unknown symbol: ${symbol}` });
    return;
  }

  try {
    const derivClient = await getDerivClientWithDbToken();
    const { runDataTopUp } = await import("../core/dataIntegrity.js");

    if (background) {
      runDataTopUp(symbol, derivClient).catch(err =>
        console.error(`[DataTopUp] background run failed for ${symbol}:`, err),
      );
      res.json({ success: true, message: `Data top-up started in background for ${symbol}` });
    } else {
      const result = await runDataTopUp(symbol, derivClient);
      res.json({ success: true, result });
    }
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Data top-up failed" });
  }
});

/**
 * POST /research/enrich
 * Derives all multi-timeframe candles for a symbol from stored 1m data.
 * Idempotent — safe to re-run.
 *
 * Body: { symbol: string }
 */
router.post("/research/enrich", async (req, res): Promise<void> => {
  const { symbol } = req.body ?? {};

  if (!symbol || typeof symbol !== "string") {
    res.status(400).json({ error: "symbol is required" });
    return;
  }

  if (!ALL_SYMBOLS.includes(symbol)) {
    res.status(400).json({ error: `Unknown symbol: ${symbol}` });
    return;
  }

  try {
    const { enrichTimeframes } = await import("../core/candleEnrichment.js");
    const result = await enrichTimeframes(symbol);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Enrichment failed" });
  }
});

/**
 * POST /research/reconcile
 *
 * Integrity-first reconcile pipeline: inspect → repair gaps → enrich.
 *
 * This is the correct operational flow. Unlike calling top-up and enrich
 * separately, reconcile:
 * 1. Checks if base 1m data is sufficient for enrichment
 * 2. Fails loudly if not (does not silently enrich on thin data)
 * 3. Repairs 1m/5m gaps from the API
 * 4. Re-checks base after repair
 * 5. Enriches derived TFs only from clean, sufficient base
 *
 * Background-capable via query param: ?background=true
 *
 * Body: { symbol: string }
 */
router.post("/research/reconcile", async (req, res): Promise<void> => {
  const { symbol } = req.body ?? {};
  const background = req.query.background === "true";

  if (!symbol || typeof symbol !== "string") {
    res.status(400).json({ error: "symbol is required" });
    return;
  }

  if (!ALL_SYMBOLS.includes(symbol)) {
    res.status(400).json({ error: `Unknown symbol: ${symbol}` });
    return;
  }

  try {
    const derivClient = await getDerivClientWithDbToken();
    const { reconcileSymbolData } = await import("../core/dataIntegrity.js");

    if (background) {
      reconcileSymbolData(symbol, derivClient).catch(err =>
        console.error(`[Reconcile] Background run failed for ${symbol}:`, err),
      );
      res.json({ success: true, message: `Reconcile started in background for ${symbol}` });
    } else {
      const result = await reconcileSymbolData(symbol, derivClient);
      const overallSuccess = result.errors.length === 0 && result.enrichment.ran;
      res.json({ success: overallSuccess, result });
    }
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Reconcile failed" });
  }
});

// ─── POST /research/strategy-ranking ─────────────────────────────────────────
//
// Runs the deterministic strategy extractor for a symbol and returns
// data-derived strategy candidates ranked by expected monthly return.
//
// The extractor reads real candle data from `candles` (excluding isInterpolated=true)
// and computes actual move statistics at multiple thresholds.
// The AI layer is NOT invoked here — this is pure quantitative truth.
//
// Body: { symbol, windowDays?, timeframe? }

router.post("/research/strategy-ranking", async (req, res): Promise<void> => {
  const { symbol, windowDays = 365, timeframe = "1m" } = req.body ?? {};

  if (!symbol || typeof symbol !== "string") {
    res.status(400).json({ error: "symbol is required" });
    return;
  }

  const days = Number(windowDays);
  if (!Number.isFinite(days) || days < 30 || days > 730) {
    res.status(400).json({ error: "windowDays must be between 30 and 730" });
    return;
  }

  try {
    const { extractStrategies } = await import("../core/strategyExtractor.js");
    const report = await extractStrategies(symbol, days, timeframe);
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Strategy extraction failed" });
  }
});

// ─── POST /research/repair-interpolated ──────────────────────────────────────
//
// Actively replaces isInterpolated=true candles with real API candles wherever
// the Deriv API can supply the data. This is the RECOVERY pass that should be
// run after historical backfill and after any reconcile run.
//
// Returns per-timeframe breakdown:
//   before        — interpolated count before recovery
//   recovered     — replaced with real candles
//   unrecoverable — still interpolated after API attempt (API had no data)
//
// Body: { symbol }
// Query: ?background=true to run async and return immediately

/**
 * POST /research/clean-canonical
 *
 * Unified canonical cleanup pipeline — one button, full run.
 *
 * Sequence:
 *   1. Snapshot state before
 *   2. Run full data top-up: detect gaps → fetch real API candles → repair interpolated → enrich
 *   3. Snapshot state after
 *   4. Return comprehensive before/after summary
 *
 * Future runs automatically re-check interpolated candles and replace with real data
 * if the API now has it. Interpolation is only ever created as last resort.
 *
 * Body: { symbol: string }
 * Query: ?background=true to run async
 */
router.post("/research/clean-canonical", async (req, res): Promise<void> => {
  const { symbol } = req.body ?? {};

  if (!symbol || typeof symbol !== "string") {
    res.status(400).json({ error: "symbol is required" });
    return;
  }

  if (!ALL_SYMBOLS.includes(symbol)) {
    res.status(400).json({ error: `Unknown symbol: ${symbol}` });
    return;
  }

  const background = req.query.background === "true";

  try {
    const derivClient = await getDerivClientWithDbToken();
    const { runDataTopUp } = await import("../core/dataIntegrity.js");

    const countRows = async (tf: string, interpOnly = false): Promise<number> => {
      const cond = interpOnly
        ? and(eq(candlesTable.symbol, symbol), eq(candlesTable.timeframe, tf), eq(candlesTable.isInterpolated, true))
        : and(eq(candlesTable.symbol, symbol), eq(candlesTable.timeframe, tf));
      const [r] = await db.select({ n: count() }).from(candlesTable).where(cond);
      return Number(r?.n ?? 0);
    };

    const run = async () => {
      const before1m     = await countRows("1m");
      const beforeInterp = await countRows("1m", true);

      console.log(`[CleanCanonical] ${symbol}: before — 1m=${before1m} interpolated=${beforeInterp}`);

      const result = await runDataTopUp(symbol, derivClient);

      const after1m     = await countRows("1m");
      const afterInterp = await countRows("1m", true);

      return {
        symbol,
        before: { rows1m: before1m, interpolated: beforeInterp },
        after:  { rows1m: after1m,  interpolated: afterInterp  },
        pipeline: {
          gapsFound:                 result.gapsFound,
          gapsRepaired:              result.gapsRepaired,
          gapsInterpolated:          result.gapsInterpolated,
          candlesInserted:           result.candlesInserted,
          interpolatedBefore:        result.interpolatedBefore,
          interpolatedRecovered:     result.interpolatedRecovered,
          interpolatedUnrecoverable: result.interpolatedUnrecoverable,
          enrichedTimeframes:        result.timeframes ?? [],
          durationMs:                result.durationMs,
          errors:                    result.errors ?? [],
        },
        exportReady: after1m > 0 && afterInterp < after1m * 0.1,
      };
    };

    if (background) {
      run().catch(err =>
        console.error(`[CleanCanonical] background run failed for ${symbol}:`, err),
      );
      res.json({ success: true, message: `Canonical cleanup started in background for ${symbol}` });
    } else {
      const result = await run();
      res.json({ success: true, result });
    }
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Canonical cleanup failed" });
  }
});

/**
 * GET /research/coverage-all
 *
 * Returns candle counts for all symbols × all timeframes in one query.
 * Used by the Coverage tab to display the full multi-timeframe matrix.
 *
 * Response: { rows: Array<{ symbol, timeframe, count, interpolatedCount }> }
 */
router.get("/research/coverage-all", async (_req, res): Promise<void> => {
  try {
    const rows = await db
      .select({
        symbol:            candlesTable.symbol,
        timeframe:         candlesTable.timeframe,
        count:             count(),
        interpolatedCount: sql<number>`SUM(CASE WHEN ${candlesTable.isInterpolated} = true THEN 1 ELSE 0 END)`,
      })
      .from(candlesTable)
      .groupBy(candlesTable.symbol, candlesTable.timeframe);

    res.json({
      rows: rows.map(r => ({
        symbol:            r.symbol,
        timeframe:         r.timeframe,
        count:             Number(r.count),
        interpolatedCount: Number(r.interpolatedCount ?? 0),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Coverage query failed" });
  }
});

router.post("/research/repair-interpolated", async (req, res): Promise<void> => {
  const { symbol } = req.body ?? {};

  if (!symbol || typeof symbol !== "string") {
    res.status(400).json({ error: "symbol is required" });
    return;
  }

  if (!ALL_SYMBOLS.includes(symbol)) {
    res.status(400).json({ error: `Unknown symbol: ${symbol}` });
    return;
  }

  const background = req.query.background === "true";

  try {
    const derivClient = await getDerivClientWithDbToken();
    const { repairInterpolatedCandles } = await import("../core/dataIntegrity.js");

    const run = async () => {
      const results: Array<{
        timeframe: string;
        before: number;
        recovered: number;
        unrecoverable: number;
      }> = [];

      for (const tf of ["1m", "5m"]) {
        const r = await repairInterpolatedCandles(symbol, tf, derivClient);
        results.push({ timeframe: tf, ...r });
      }
      return results;
    };

    if (background) {
      run().then(results => {
        console.log(`[RepairInterpolated] Background run complete for ${symbol}:`, results);
      }).catch(err => {
        console.error(`[RepairInterpolated] Background run failed for ${symbol}:`, err);
      });
      res.json({ success: true, message: `Interpolation repair started in background for ${symbol}` });
    } else {
      const results = await run();
      const totalBefore      = results.reduce((s, r) => s + r.before, 0);
      const totalRecovered   = results.reduce((s, r) => s + r.recovered, 0);
      const totalUnrecoverable = results.reduce((s, r) => s + r.unrecoverable, 0);
      res.json({
        success: true,
        symbol,
        summary: { totalBefore, totalRecovered, totalUnrecoverable },
        byTimeframe: results,
      });
    }
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Interpolation repair failed" });
  }
});

export default router;
