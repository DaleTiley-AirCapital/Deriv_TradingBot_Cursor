import { Router, type IRouter } from "express";
import { eq, and, count, min, max, desc, lt, asc, gte, lte } from "drizzle-orm";
import { db, candlesTable, backtestRunsTable, backtestTradesTable, platformStateTable } from "@workspace/db";
import { getDerivClientWithDbToken, V1_DEFAULT_SYMBOLS } from "../lib/deriv.js";
import { getApiSymbol } from "../lib/symbolValidator.js";
import { runSymbolBacktest } from "../lib/backtestEngine.js";
import { isOpenAIConfigured } from "../lib/openai.js";
import OpenAI from "openai";
import { createDecipheriv, scryptSync } from "crypto";

const router: IRouter = Router();

const STRATEGIES = ["trend_continuation", "mean_reversion", "breakout_expansion", "spike_event"] as const;
const GRANULARITY_1M = 60;
const GRANULARITY_5M = 300;
const MAX_BATCH = 5000;
const MAX_CONSECUTIVE_ERRORS = 5;
const API_RATE_DELAY_MS = 150;
const DEFAULT_CAPITAL = 600;
const TWELVE_MONTHS_SECONDS = 365 * 24 * 3600;
const SUFFICIENT_CANDLE_COUNT = 325_000;

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

router.get("/research/data-status", async (_req, res): Promise<void> => {
  try {
    const symbolStatuses = await Promise.all(
      V1_DEFAULT_SYMBOLS.map(async (symbol) => {
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

        return {
          symbol,
          count1m,
          count5m,
          totalCandles,
          oldestDate,
          newestDate,
          lastBacktestDate,
          status,
        };
      })
    );

    const totalStorage = symbolStatuses.reduce((s, r) => s + r.totalCandles, 0);

    res.json({
      symbols: symbolStatuses,
      totalStorage,
      symbolCount: V1_DEFAULT_SYMBOLS.length,
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

  if (!symbol || !V1_DEFAULT_SYMBOLS.includes(symbol)) {
    send({ phase: "error", message: `Invalid symbol: ${symbol}` });
    res.end();
    return;
  }

  try {
    await pruneOldCandles();

    const [candleCountResult] = await db.select({ n: count() }).from(candlesTable)
      .where(eq(candlesTable.symbol, symbol));
    const existingCandleCount = candleCountResult?.n ?? 0;

    if (existingCandleCount >= SUFFICIENT_CANDLE_COUNT) {
      send({
        phase: "data_sufficient", symbol,
        candles: existingCandleCount,
        message: `Data sufficient (${existingCandleCount.toLocaleString()} records), skipping download — running simulation...`,
      });
    } else {
    send({ phase: "download_start", symbol, message: `Downloading 12 months of data for ${symbol}...` });

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

    for (const { tf, granularity } of timeframes) {
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

        if (earliestEpoch < oneYearAgoEpoch) {
          const filtered = sorted.filter(c => c.epoch >= oneYearAgoEpoch);
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
          break;
        }

        const newRows = sorted.map(c => ({
          symbol, timeframe: tf, openTs: c.epoch, closeTs: c.epoch + granularity,
          open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), tickCount: 0,
        }));
        for (let chunk = 0; chunk < newRows.length; chunk += 1000) {
          await db.insert(candlesTable).values(newRows.slice(chunk, chunk + 1000))
            .onConflictDoNothing({ target: [candlesTable.symbol, candlesTable.timeframe, candlesTable.openTs] });
        }
        totalInserted += newRows.length;

        if (candles.length < MAX_BATCH) break;

        const newEnd = earliestEpoch - 1;
        if (newEnd >= endEpoch || newEnd < oneYearAgoEpoch) break;
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
      message: `Download complete: ${totalInserted.toLocaleString()} candles for ${symbol}`,
    });
    }

    send({ phase: "backtest_start", symbol, message: `Running all strategies on ${symbol}...` });

    const states = await db.select().from(platformStateTable);
    const stateMap: Record<string, string> = {};
    for (const s of states) stateMap[s.key] = s.value;
    const initialCapital = parseFloat(stateMap["total_capital"] || String(DEFAULT_CAPITAL));

    try {
      const btResult = await runSymbolBacktest(symbol, initialCapital, "balanced");

      if (btResult.profitableStrategies.length > 0) {
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
          const profitableTrades = btResult.trades.filter(t => {
            return btResult.profitableStrategies.some(s => s.strategyName === t.strategyName);
          });
          for (let i = 0; i < profitableTrades.length; i += 500) {
            const batch = profitableTrades.slice(i, i + 500);
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

        send({
          phase: "backtest_complete", symbol,
          profitableStrategies: btResult.profitableStrategies,
          portfolioMetrics: {
            netProfit: btResult.portfolioMetrics.netProfit,
            winRate: btResult.portfolioMetrics.winRate,
            profitFactor: btResult.portfolioMetrics.profitFactor,
            tradeCount: btResult.portfolioMetrics.tradeCount,
          },
          message: `Backtest complete: ${btResult.profitableStrategies.length} profitable strategies found`,
        });
      } else {
        send({
          phase: "backtest_complete", symbol,
          profitableStrategies: [],
          message: `Backtest complete: no profitable strategies found for ${symbol}`,
        });
      }
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

  if (!symbol || !V1_DEFAULT_SYMBOLS.includes(symbol)) {
    res.status(400).json({ error: `Invalid symbol: ${symbol}` });
    return;
  }

  try {
    const states = await db.select().from(platformStateTable);
    const stateMap: Record<string, string> = {};
    for (const s of states) stateMap[s.key] = s.value;
    const initialCapital = parseFloat(stateMap["total_capital"] || String(DEFAULT_CAPITAL));

    const btResult = await runSymbolBacktest(symbol, initialCapital, "balanced");

    if (btResult.profitableStrategies.length > 0) {
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
        const profitableTrades = btResult.trades.filter(t => {
          return btResult.profitableStrategies.some(s => s.strategyName === t.strategyName);
        });
        for (let i = 0; i < profitableTrades.length; i += 500) {
          const batch = profitableTrades.slice(i, i + 500);
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
        symbol,
        backtestId: row?.id,
        profitableStrategies: btResult.profitableStrategies,
        portfolioMetrics: {
          netProfit: btResult.portfolioMetrics.netProfit,
          winRate: btResult.portfolioMetrics.winRate,
          profitFactor: btResult.portfolioMetrics.profitFactor,
          tradeCount: btResult.portfolioMetrics.tradeCount,
        },
      });
    } else {
      res.json({
        success: true,
        symbol,
        profitableStrategies: [],
        message: `No profitable strategies found for ${symbol}`,
      });
    }
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

    const systemPrompt = `You are a quantitative trading analyst for the Deriv Capital Extraction Platform.
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
      if (!V1_DEFAULT_SYMBOLS.includes(sym)) continue;

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
            if (s.netProfit > 0 && s.tradeCount > 0) {
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
        }
        grouped[sym].portfolioNetProfit = run.netProfit ?? 0;
        grouped[sym].portfolioWinRate = run.winRate ?? 0;
      } else {
        if ((run.netProfit ?? 0) > 0 && (run.tradeCount ?? 0) > 0) {
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
    }

    res.json({
      symbols: Object.values(grouped).sort((a, b) => b.portfolioNetProfit - a.portfolioNetProfit),
    });
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
