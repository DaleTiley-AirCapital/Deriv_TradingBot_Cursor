import { Router, type IRouter } from "express";
import { eq, and, count, min, max, desc, lt, asc, gte, lte, sql } from "drizzle-orm";
import { db, candlesTable, backtestRunsTable, backtestTradesTable, platformStateTable } from "@workspace/db";
import { getDerivClientWithDbToken, ACTIVE_TRADING_SYMBOLS, V1_DEFAULT_SYMBOLS, ALL_SYMBOLS } from "../lib/deriv.js";
import { getApiSymbol } from "../lib/symbolValidator.js";
import { runSymbolBacktest } from "../lib/backtestEngine.js";
import { isOpenAIConfigured } from "../lib/openai.js";
import OpenAI from "openai";
import { createDecipheriv, scryptSync } from "crypto";

const router: IRouter = Router();

const STRATEGIES = ["trend_continuation", "mean_reversion", "spike_cluster_recovery", "swing_exhaustion", "trendline_breakout"] as const;
const GRANULARITY_1M = 60;
const GRANULARITY_5M = 300;
const MAX_BATCH = 5000;
const MAX_CONSECUTIVE_ERRORS = 5;
const API_RATE_DELAY_MS = 150;
const DEFAULT_CAPITAL = 600;
const TWELVE_MONTHS_SECONDS = 365 * 24 * 3600;

const ENC_KEY_SOURCE = process.env["DATABASE_URL"] || process.env["ENCRYPTION_SECRET"];
const ENC_DERIVED_KEY = ENC_KEY_SOURCE ? scryptSync(ENC_KEY_SOURCE, "deriv-quant-salt", 32) : null;

function decryptStoredSecret(stored: string): string {
  if (!stored.startsWith("enc:") || !ENC_DERIVED_KEY) return stored;
  const parts = stored.split(":");
  if (parts.length !== 3) return stored;
  const iv = Buffer.from(parts[1], "hex");
  const decipher = createDecipheriv("aes-256-cbc", ENC_DERIVED_KEY, iv);
  let decrypted = decipher.update(parts[2], "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

async function getOpenAIClient(): Promise<OpenAI> {
  const rows = await db.select().from(platformStateTable).where(eq(platformStateTable.key, "openai_api_key"));
  const raw = rows[0]?.value || null;
  if (!raw) throw new Error("OpenAI API key not configured");
  return new OpenAI({ apiKey: decryptStoredSecret(raw) });
}

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
    await pruneOldCandles();

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
  const { symbol } = req.body ?? {};

  if (!symbol || !ALL_SYMBOLS.includes(symbol)) {
    res.status(400).json({ error: `Invalid symbol: ${symbol}` });
    return;
  }

  try {
    const states = await db.select().from(platformStateTable);
    const stateMap: Record<string, string> = {};
    for (const s of states) stateMap[s.key] = s.value;
    const initialCapital = parseFloat(stateMap["total_capital"] || String(DEFAULT_CAPITAL));

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
      res.json({
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
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
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

    const client = await getOpenAIClient();
    const response = await client.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message },
      ],
      max_tokens: 800,
      temperature: 0.4,
    });

    const answer = response.choices[0]?.message?.content?.trim() || "No response generated.";
    res.json({ answer, backtestId });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "AI chat failed" });
  }
});

router.get("/research/grouped-results", async (_req, res): Promise<void> => {
  try {
    const results = await db.select().from(backtestRunsTable)
      .where(eq(backtestRunsTable.status, "completed"))
      .orderBy(desc(backtestRunsTable.createdAt));

    const grouped: Record<string, {
      symbol: string;
      latestBacktestId: number;
      latestBacktestDate: string;
      strategies: {
        strategyName: string;
        winRate: number;
        profitFactor: number;
        netProfit: number;
        tradeCount: number;
        backtestId: number;
      }[];
      portfolioNetProfit: number;
      portfolioWinRate: number;
    }> = {};

    for (const run of results) {
      const sym = run.symbol;

      if (!grouped[sym]) {
        grouped[sym] = {
          symbol: sym,
          latestBacktestId: run.id,
          latestBacktestDate: run.createdAt.toISOString(),
          strategies: [],
          portfolioNetProfit: 0,
          portfolioWinRate: 0,
        };
      }

      if (run.strategyName === "all_strategies") {
        const metricsJson = run.metricsJson as { strategyBreakdown?: Array<{ strategyName: string; winRate: number; profitFactor: number; netProfit: number; tradeCount: number }> } | null;
        if (metricsJson?.strategyBreakdown) {
          for (const s of metricsJson.strategyBreakdown) {
            const existing = grouped[sym].strategies.find(x => x.strategyName === s.strategyName);
            if (!existing) {
              grouped[sym].strategies.push({
                strategyName: s.strategyName,
                winRate: s.winRate,
                profitFactor: s.profitFactor,
                netProfit: s.netProfit,
                tradeCount: s.tradeCount,
                backtestId: run.id,
              });
            }
          }
        }
        grouped[sym].portfolioNetProfit = run.netProfit ?? 0;
        grouped[sym].portfolioWinRate = run.winRate ?? 0;
      } else {
        const existing = grouped[sym].strategies.find(x => x.strategyName === run.strategyName);
        if (!existing) {
          grouped[sym].strategies.push({
            strategyName: run.strategyName,
            winRate: run.winRate ?? 0,
            profitFactor: run.profitFactor ?? 0,
            netProfit: run.netProfit ?? 0,
            tradeCount: run.tradeCount ?? 0,
            backtestId: run.id,
          });
        }
      }
    }

    const ordered = ALL_SYMBOLS
      .filter(sym => grouped[sym])
      .map(sym => grouped[sym]);
    res.json({ symbols: ordered });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

router.post("/research/enrich-timeframes", async (req, res): Promise<void> => {
  const { symbol } = req.body ?? {};

  if (!symbol || !ALL_SYMBOLS.includes(symbol)) {
    res.status(400).json({ error: `Invalid symbol: ${symbol}` });
    return;
  }

  try {
    const higherTimeframes: Record<string, number> = {
      "2h": 7200, "4h": 14400, "8h": 28800, "12h": 43200,
      "1d": 86400, "2d": 172800, "4d": 345600, "7d": 604800,
      "15d": 1296000, "30d": 2592000,
    };

    let totalInserted = 0;

    for (const [tfLabel, tfSeconds] of Object.entries(higherTimeframes)) {
      const existing = await db.select({ cnt: count() }).from(candlesTable)
        .where(and(eq(candlesTable.symbol, symbol), eq(candlesTable.timeframe, tfLabel)));
      if ((existing[0]?.cnt ?? 0) > 0) continue;

      const oneMinCandles = await db.select().from(candlesTable)
        .where(and(eq(candlesTable.symbol, symbol), eq(candlesTable.timeframe, "1m")))
        .orderBy(asc(candlesTable.openTs));

      if (oneMinCandles.length === 0) continue;

      const aggregated: { openTs: Date; closeTs: Date; open: number; high: number; low: number; close: number; tickCount: number }[] = [];
      let bucketStart = Math.floor(new Date(oneMinCandles[0].openTs).getTime() / 1000 / tfSeconds) * tfSeconds;
      let open = 0, high = -Infinity, low = Infinity, close = 0, ticks = 0, bucketHasData = false;

      for (const c of oneMinCandles) {
        const cEpoch = new Date(c.openTs).getTime() / 1000;
        while (cEpoch >= bucketStart + tfSeconds) {
          if (bucketHasData) {
            aggregated.push({
              openTs: new Date(bucketStart * 1000),
              closeTs: new Date((bucketStart + tfSeconds) * 1000),
              open, high, low, close, tickCount: ticks,
            });
          }
          bucketStart += tfSeconds;
          open = 0; high = -Infinity; low = Infinity; close = 0; ticks = 0; bucketHasData = false;
        }
        if (!bucketHasData) { open = c.open; bucketHasData = true; }
        if (c.high > high) high = c.high;
        if (c.low < low) low = c.low;
        close = c.close;
        ticks += c.tickCount ?? 1;
      }
      if (bucketHasData) {
        aggregated.push({
          openTs: new Date(bucketStart * 1000),
          closeTs: new Date((bucketStart + tfSeconds) * 1000),
          open, high, low, close, tickCount: ticks,
        });
      }

      for (let i = 0; i < aggregated.length; i += 500) {
        const batch = aggregated.slice(i, i + 500);
        await db.insert(candlesTable).values(
          batch.map(a => ({
            symbol,
            timeframe: tfLabel,
            openTs: a.openTs,
            closeTs: a.closeTs,
            open: a.open,
            high: a.high,
            low: a.low,
            close: a.close,
            tickCount: a.tickCount,
          }))
        ).onConflictDoNothing();
      }
      totalInserted += aggregated.length;
    }

    res.json({ success: true, symbol, candlesCreated: totalInserted });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
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

export default router;
