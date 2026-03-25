import { Router, type IRouter } from "express";
import { eq, and, inArray, count } from "drizzle-orm";
import { db, candlesTable, backtestRunsTable, backtestTradesTable, platformStateTable, tradesTable, signalLogTable, ticksTable, spikeEventsTable, featuresTable, modelRunsTable } from "@workspace/db";
import { getDerivClientWithDbToken, getDbApiToken, getDbApiTokenForMode, V1_DEFAULT_SYMBOLS } from "../lib/deriv.js";
import { checkOpenAiHealth, isOpenAIConfigured, analyseBacktest, type BacktestMetrics } from "../lib/openai.js";
import { runBacktestSimulation } from "../lib/backtestEngine.js";
import { getApiSymbol, validateActiveSymbols } from "../lib/symbolValidator.js";

const router: IRouter = Router();

const STRATEGIES = ["trend_continuation", "mean_reversion", "breakout_expansion", "spike_event"] as const;
const GRANULARITY_1M = 60;
const GRANULARITY_5M = 300;
const MAX_BATCH = 5000;
const MAX_CONSECUTIVE_ERRORS = 5;
const DEFAULT_CAPITAL = 600;
const AI_LOCKABLE_KEYS = [
  "equity_pct_per_trade", "paper_equity_pct_per_trade", "live_equity_pct_per_trade",
  "tp_multiplier_strong", "tp_multiplier_medium", "tp_multiplier_weak",
  "sl_ratio", "trailing_stop_pct", "time_exit_window_hours",
  "demo_tp_multiplier_strong", "demo_tp_multiplier_medium", "demo_tp_multiplier_weak",
  "demo_sl_ratio", "demo_trailing_stop_pct", "demo_equity_pct_per_trade", "demo_time_exit_window_hours",
  "real_tp_multiplier_strong", "real_tp_multiplier_medium", "real_tp_multiplier_weak",
  "real_sl_ratio", "real_trailing_stop_pct", "real_equity_pct_per_trade", "real_time_exit_window_hours",
];

router.post("/setup/preflight", async (_req, res): Promise<void> => {
  try {
    const demoToken = await getDbApiTokenForMode("demo");
    const realToken = await getDbApiTokenForMode("real");
    const openaiConfigured = await isOpenAIConfigured();

    async function testDerivToken(token: string | null, label: string): Promise<{ ok: boolean; error?: string }> {
      if (!token) return { ok: false, error: `${label} token not configured.` };
      const DERIV_WS_URL = "wss://ws.binaryws.com/websockets/v3?app_id=1089";
      const { default: WebSocket } = await import("ws");
      return new Promise<{ ok: boolean; error?: string }>((resolve) => {
        const ws = new WebSocket(DERIV_WS_URL);
        let settled = false;
        const timeout = setTimeout(() => {
          if (!settled) {
            settled = true;
            try { ws.close(); } catch {}
            resolve({ ok: false, error: `${label} connection timed out after 15 seconds.` });
          }
        }, 15000);

        ws.on("open", () => {
          ws.send(JSON.stringify({ authorize: token, req_id: 1 }));
        });

        ws.on("message", (raw: Buffer) => {
          if (settled) return;
          try {
            const data = JSON.parse(raw.toString());
            if (data.req_id !== 1) return;
            settled = true;
            clearTimeout(timeout);
            try { ws.close(); } catch {}
            if (data.error) {
              resolve({ ok: false, error: `${label} auth failed: ${(data.error as { message: string }).message}` });
            } else {
              resolve({ ok: true });
            }
          } catch {}
        });

        ws.on("error", (err: Error) => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            resolve({ ok: false, error: `${label} connection error: ${err.message}` });
          }
        });
      });
    }

    const [derivDemoResult, derivRealResult, openaiResult] = await Promise.all([
      testDerivToken(demoToken, "Demo"),
      testDerivToken(realToken, "Real"),
      (async (): Promise<{ ok: boolean; error?: string }> => {
        if (!openaiConfigured) return { ok: false, error: "OpenAI API key not configured." };
        const health = await checkOpenAiHealth();
        if (!health.working) {
          return { ok: false, error: health.error || "OpenAI API key is invalid or the API is unreachable." };
        }
        return { ok: true };
      })(),
    ]);

    res.json({ derivDemo: derivDemoResult, derivReal: derivRealResult, openai: openaiResult });
  } catch (err) {
    res.status(500).json({
      derivDemo: { ok: false, error: "Preflight check failed unexpectedly." },
      derivReal: { ok: false, error: "Preflight check failed unexpectedly." },
      openai: { ok: false, error: err instanceof Error ? err.message : "Unknown error" },
    });
  }
});

router.get("/setup/status", async (_req, res): Promise<void> => {
  try {
    const tokenRows = await db.select().from(platformStateTable)
      .where(inArray(platformStateTable.key, ["deriv_api_token", "deriv_api_token_demo", "deriv_api_token_real"]));
    const hasToken = tokenRows.some(r => !!r.value);

    const symbolCounts = await Promise.all(
      V1_DEFAULT_SYMBOLS.map(async (symbol) => {
        const [r1m] = await db.select({ n: count() }).from(candlesTable)
          .where(and(eq(candlesTable.symbol, symbol), eq(candlesTable.timeframe, "1m")));
        const [r5m] = await db.select({ n: count() }).from(candlesTable)
          .where(and(eq(candlesTable.symbol, symbol), eq(candlesTable.timeframe, "5m")));
        return { symbol, count: (r1m?.n ?? 0) + (r5m?.n ?? 0) };
      })
    );

    const [btResult] = await db.select({ n: count() }).from(backtestRunsTable);
    const backtestCount = btResult?.n ?? 0;
    const expectedBacktests = V1_DEFAULT_SYMBOLS.length * STRATEGIES.length;

    const totalCandles = symbolCounts.reduce((s, r) => s + r.count, 0);
    const hasEnoughData = symbolCounts.filter(r => r.count >= 100).length >= Math.ceil(V1_DEFAULT_SYMBOLS.length * 0.5);
    const hasInitialBacktests = backtestCount >= expectedBacktests;

    const setupRow = await db.select().from(platformStateTable)
      .where(eq(platformStateTable.key, "initial_setup_complete")).limit(1);
    const initialSetupDone = setupRow.length > 0 && setupRow[0].value === "true";

    res.json({
      hasToken,
      totalCandles,
      symbolCounts,
      hasEnoughData,
      hasInitialBacktests,
      backtestCount,
      expectedBacktests,
      initialSetupComplete: initialSetupDone,
      setupComplete: initialSetupDone && hasEnoughData && hasInitialBacktests,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

router.post("/setup/initialise", async (_req, res): Promise<void> => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const globalStart = Date.now();

  try {
    const client = await getDerivClientWithDbToken();
    await client.connect();
    await validateActiveSymbols(true);

    let candleTotal = 0;
    const timeframes: { tf: string; granularity: number }[] = [
      { tf: "1m", granularity: GRANULARITY_1M },
      { tf: "5m", granularity: GRANULARITY_5M },
    ];
    const totalJobs = V1_DEFAULT_SYMBOLS.length * timeframes.length;

    send({
      phase: "backfill_start",
      stage: "backfill",
      message: `Step 1 of 6: Downloading ALL available 1m & 5m price history for ${V1_DEFAULT_SYMBOLS.length} symbols...`,
      totalSymbols: V1_DEFAULT_SYMBOLS.length,
      symbols: V1_DEFAULT_SYMBOLS.map(s => ({ symbol: s, status: "waiting", candles: 0, oldestDate: null })),
    });

    let jobsDone = 0;

    for (let si = 0; si < V1_DEFAULT_SYMBOLS.length; si++) {
      const symbol = V1_DEFAULT_SYMBOLS[si];
      const apiSymbol = getApiSymbol(symbol);
      let symbolTotalInserted = 0;
      let symbolFailed = false;

      send({
        phase: "backfill_symbol_start", stage: "backfill", symbol,
        symbolIndex: si, totalSymbols: V1_DEFAULT_SYMBOLS.length,
        status: "downloading", symbolPct: 0,
        message: `Starting ${symbol} (${si + 1}/${V1_DEFAULT_SYMBOLS.length})...`,
      });

      for (const { tf, granularity } of timeframes) {
        let endEpoch = Math.floor(Date.now() / 1000);
        let tfInserted = 0;
        let oldestDateStr: string | null = null;
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
            const errMsg = err instanceof Error ? err.message : String(err);
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
              send({
                phase: "backfill_symbol_error", stage: "backfill", symbol,
                symbolIndex: si, totalSymbols: V1_DEFAULT_SYMBOLS.length,
                status: "error", timeframe: tf,
                error: `Failed after ${consecutiveErrors} retries: ${errMsg}`,
                message: `${symbol} ${tf} failed: ${errMsg}`,
              });
              symbolFailed = true;
              break;
            }
            if (errMsg.includes("not connected") || errMsg.includes("timed out") || errMsg.includes("WebSocket")) {
              send({
                phase: "backfill_progress", stage: "backfill", symbol,
                symbolIndex: si, totalSymbols: V1_DEFAULT_SYMBOLS.length,
                message: `${symbol} ${tf}: connection lost, reconnecting (attempt ${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS})...`,
              });
              await new Promise(r => setTimeout(r, 3000));
              try {
                await client.connect();
              } catch {
                await new Promise(r => setTimeout(r, 5000));
              }
            } else {
              await new Promise(r => setTimeout(r, 2000));
            }
            continue;
          }
          if (candles === null || candles === undefined) {
            consecutiveErrors++;
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
              send({
                phase: "backfill_symbol_error", stage: "backfill", symbol,
                symbolIndex: si, totalSymbols: V1_DEFAULT_SYMBOLS.length,
                status: "error", timeframe: tf,
                error: `API returned null after ${consecutiveErrors} retries`,
                message: `${symbol} ${tf} failed: API returned null data`,
              });
              symbolFailed = true;
              break;
            }
            await new Promise(r => setTimeout(r, 2000));
            try {
              await client.connect();
            } catch {
              await new Promise(r => setTimeout(r, 3000));
            }
            continue;
          }
          if (candles.length === 0) break;

          const sorted = [...candles].sort((a, b) => a.epoch - b.epoch);
          const earliestEpoch = sorted[0].epoch;
          oldestDateStr = new Date(earliestEpoch * 1000).toISOString().slice(0, 10);

          const existingTs = await db.select({ openTs: candlesTable.openTs })
            .from(candlesTable)
            .where(and(
              eq(candlesTable.symbol, symbol),
              eq(candlesTable.timeframe, tf),
              inArray(candlesTable.openTs, sorted.map(c => c.epoch))
            ));
          const existingSet = new Set(existingTs.map(r => r.openTs));
          const newRows = sorted.filter(c => !existingSet.has(c.epoch)).map(c => ({
            symbol, timeframe: tf, openTs: c.epoch, closeTs: c.epoch + granularity,
            open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), tickCount: 0,
          }));
          if (newRows.length > 0) {
            for (let chunk = 0; chunk < newRows.length; chunk += 1000) {
              await db.insert(candlesTable).values(newRows.slice(chunk, chunk + 1000));
            }
            tfInserted += newRows.length;
            symbolTotalInserted += newRows.length;
            candleTotal += newRows.length;
          }

          if (candles.length < MAX_BATCH) break;

          const newEnd = earliestEpoch - 1;
          if (newEnd >= endEpoch) break;
          endEpoch = newEnd;

          if (page % 3 === 0) {
            const estPagesPerTf = Math.max(page + 20, 100);
            const tfFrac = Math.min(page / estPagesPerTf, 0.95);
            const jobFrac = (jobsDone + tfFrac) / totalJobs;
            const overallPct = Math.round(jobFrac * 40);
            const symbolJobsDone = jobsDone - si * timeframes.length;
            const symbolPct = Math.round(((symbolJobsDone + tfFrac) / timeframes.length) * 100);
            send({
              phase: "backfill_progress", stage: "backfill", symbol,
              symbolIndex: si, totalSymbols: V1_DEFAULT_SYMBOLS.length,
              timeframe: tf, candlesForSymbol: symbolTotalInserted, candleTotal,
              oldestDate: oldestDateStr,
              overallPct, symbolPct: Math.min(symbolPct, 99),
              message: `${symbol} ${tf}: ${tfInserted.toLocaleString()} candles (oldest: ${oldestDateStr})`,
            });
          }

          await new Promise(r => setTimeout(r, 100));
        }

        if (symbolFailed) break;
        jobsDone++;
      }

      if (symbolFailed) {
        send({
          phase: "error", stage: "backfill",
          message: `Setup failed: could not download history for ${symbol}. Please check your connection and try again.`,
        });
        res.end();
        return;
      }

      const overallPct = Math.round((jobsDone / totalJobs) * 40);
      send({
        phase: "backfill_symbol_done", stage: "backfill", symbol,
        symbolIndex: si, totalSymbols: V1_DEFAULT_SYMBOLS.length,
        candlesForSymbol: symbolTotalInserted, candleTotal,
        overallPct, symbolPct: 100,
        status: "done",
        message: `${symbol} done — ${symbolTotalInserted.toLocaleString()} candles`,
      });
    }

    send({
      phase: "backfill_complete", stage: "backfill", candleTotal,
      overallPct: 40,
      message: `Step 1 complete — ${candleTotal.toLocaleString()} candles downloaded. Starting backtests...`,
    });

    const states = await db.select().from(platformStateTable);
    const stateMap: Record<string, string> = {};
    for (const s of states) stateMap[s.key] = s.value;

    const enabledSymbols = stateMap["enabled_symbols"]
      ? stateMap["enabled_symbols"].split(",").filter(Boolean)
      : V1_DEFAULT_SYMBOLS;
    const initialCapital = parseFloat(stateMap["total_capital"] || String(DEFAULT_CAPITAL));

    const combinations: { strategy: string; symbol: string }[] = [];
    for (const strategy of STRATEGIES) {
      for (const symbol of enabledSymbols) {
        combinations.push({ strategy, symbol });
      }
    }

    const btTotal = combinations.length;
    send({
      phase: "backtest_start", stage: "backtest",
      btTotal, overallPct: 40,
      message: `Step 2 of 6: Running ${STRATEGIES.length} strategies × ${enabledSymbols.length} symbols — ${btTotal} backtests`,
    });

    const strategyAgg: Record<string, {
      sharpeSum: number; sharpeCount: number;
      tpSum: number; slSum: number; holdSum: number;
      equitySum: number; drawdownSum: number; winRateSum: number; count: number;
    }> = {};
    for (const strat of STRATEGIES) {
      strategyAgg[strat] = { sharpeSum: 0, sharpeCount: 0, tpSum: 0, slSum: 0, holdSum: 0, equitySum: 0, drawdownSum: 0, winRateSum: 0, count: 0 };
    }

    const comboResults: { strategy: string; symbol: string; sharpe: number; winRate: number; profitFactor: number; avgHold: number; score: number }[] = [];
    let btCompleted = 0;
    const btStart = Date.now();

    for (const { strategy, symbol } of combinations) {
      try {
        const result = await runBacktestSimulation(strategy, symbol, initialCapital, "balanced");

        const [row] = await db.insert(backtestRunsTable).values({
          strategyName: strategy, symbol, initialCapital,
          totalReturn: result.totalReturn, netProfit: result.netProfit,
          winRate: result.winRate, profitFactor: result.profitFactor,
          maxDrawdown: result.maxDrawdown, tradeCount: result.tradeCount,
          avgHoldingHours: result.avgHoldingHours, expectancy: result.expectancy,
          sharpeRatio: result.sharpeRatio,
          configJson: { allocationMode: "balanced", symbol, strategyName: strategy, source: "initial-setup" },
          metricsJson: {
            equityCurve: result.equityCurve, grossProfit: result.grossProfit,
            grossLoss: result.grossLoss, avgWin: result.avgWin, avgLoss: result.avgLoss,
            maxDrawdownDuration: result.maxDrawdownDuration, monthlyReturns: result.monthlyReturns,
            returnBySymbol: result.returnBySymbol, returnByRegime: result.returnByRegime,
          },
          status: "completed",
        }).returning();

        if (row && result.trades.length > 0) {
          await db.insert(backtestTradesTable).values(
            result.trades.map(t => ({
              backtestRunId: row.id, entryTs: t.entryTs, exitTs: t.exitTs,
              direction: t.direction, entryPrice: t.entryPrice, exitPrice: t.exitPrice,
              pnl: t.pnl, exitReason: t.exitReason,
            }))
          );
        }

        const r = strategyAgg[strategy];
        r.count++;
        if (result.sharpeRatio > 0 && result.tradeCount > 0) { r.sharpeSum += result.sharpeRatio; r.sharpeCount++; }
        r.holdSum += result.avgHoldingHours;
        r.drawdownSum += Math.abs(result.maxDrawdown);
        r.winRateSum += result.winRate;
        if (result.profitFactor > 0) {
          r.tpSum += Math.min(Math.max(1.5 + result.profitFactor * 0.4, 1.2), 4.0);
          r.slSum += Math.min(Math.max(1.0 / result.profitFactor, 0.5), 2.0);
        } else { r.tpSum += 2.0; r.slSum += 1.0; }
        r.equitySum += Math.min(Math.max(result.winRate * 20, 8), 15);

        if (result.tradeCount >= 3) {
          const comboScore = (result.sharpeRatio * 0.4) + (result.winRate * 0.25) + (result.profitFactor * 0.2) + (result.expectancy * 0.15);
          comboResults.push({ strategy, symbol, sharpe: result.sharpeRatio, winRate: result.winRate, profitFactor: result.profitFactor, avgHold: result.avgHoldingHours, score: comboScore });
        }
      } catch { /* skip */ }

      btCompleted++;
      const btElapsed = (Date.now() - btStart) / 1000;
      const btRate = btCompleted / btElapsed;
      const btRemaining = btRate > 0 ? Math.ceil((btTotal - btCompleted) / btRate) : 0;
      const overallPct = 40 + Math.round((btCompleted / btTotal) * 30);

      send({
        phase: "backtest_progress", stage: "backtest",
        btCompleted, btTotal, candleTotal,
        strategy, symbol, overallPct,
        estRemainingSec: btRemaining,
        message: `Backtesting ${strategy.replace(/-/g, " ")} on ${symbol} (${btCompleted}/${btTotal})`,
      });
    }

    for (const sym of enabledSymbols) {
      const symCombos = comboResults.filter(c => c.symbol === sym);
      if (symCombos.length === 0) continue;
      const bestCombo = [...symCombos].sort((a, b) => b.score - a.score)[0];
      const avgWinRate = symCombos.reduce((s, c) => s + c.winRate, 0) / symCombos.length;
      const avgPf = symCombos.reduce((s, c) => s + c.profitFactor, 0) / symCombos.length;
      const avgHold = symCombos.reduce((s, c) => s + c.avgHold, 0) / symCombos.length;
      send({
        phase: "backtest_symbol_summary", stage: "backtest",
        symbol: sym,
        tradeCount: symCombos.length,
        bestStrategy: bestCombo.strategy,
        bestScore: bestCombo.score,
        avgWinRate, avgProfitFactor: avgPf, avgHoldHours: avgHold,
        message: `${sym}: ${symCombos.length} combos, best=${bestCombo.strategy} (WR=${(bestCombo.winRate * 100).toFixed(0)}%, PF=${bestCombo.profitFactor.toFixed(2)})`,
      });
    }

    send({
      phase: "ai_review_start", stage: "ai_review", overallPct: 70,
      message: `Step 3 of 6: AI reviewing backtest results per symbol...`,
    });

    const sortedCombos = [...comboResults].sort((a, b) => b.score - a.score);

    const aiAvailable = await isOpenAIConfigured();
    const symbolReviews: Record<string, { bestStrategy: string; bestScore: number; winRate: number; profitFactor: number; aiSummary?: string; aiSuggestions?: string[] }> = {};
    for (let si = 0; si < enabledSymbols.length; si++) {
      const sym = enabledSymbols[si];
      const symCombos = comboResults.filter(c => c.symbol === sym).sort((a, b) => b.score - a.score);
      const best = symCombos[0];
      const review: typeof symbolReviews[string] = best
        ? { bestStrategy: best.strategy, bestScore: best.score, winRate: best.winRate, profitFactor: best.profitFactor }
        : { bestStrategy: "none", bestScore: 0, winRate: 0, profitFactor: 0 };

      if (aiAvailable && best) {
        try {
          const btRows = await db.select().from(backtestRunsTable)
            .where(and(eq(backtestRunsTable.symbol, sym), eq(backtestRunsTable.strategyName, best.strategy), eq(backtestRunsTable.status, "completed")));
          const btRow = btRows[0];
          if (btRow) {
            const metrics: BacktestMetrics = {
              id: btRow.id,
              strategyName: btRow.strategyName,
              symbol: btRow.symbol,
              initialCapital: btRow.initialCapital,
              totalReturn: btRow.totalReturn ?? 0,
              netProfit: btRow.netProfit ?? 0,
              winRate: btRow.winRate ?? 0,
              profitFactor: btRow.profitFactor ?? 0,
              maxDrawdown: btRow.maxDrawdown ?? 0,
              tradeCount: btRow.tradeCount ?? 0,
              avgHoldingHours: btRow.avgHoldingHours ?? 0,
              expectancy: btRow.expectancy ?? 0,
              sharpeRatio: btRow.sharpeRatio ?? 0,
            };
            const analysis = await analyseBacktest(metrics);
            review.aiSummary = analysis.summary;
            review.aiSuggestions = analysis.suggestions;
          }
        } catch (aiErr) {
          console.warn(`[Setup] AI review failed for ${sym}:`, aiErr instanceof Error ? aiErr.message : aiErr);
          review.aiSummary = "AI review unavailable";
        }
      }

      symbolReviews[sym] = review;

      send({
        phase: "ai_review_symbol", stage: "ai_review",
        symbol: sym, symbolIndex: si, totalSymbols: enabledSymbols.length,
        overallPct: 70 + Math.round(((si + 1) / enabledSymbols.length) * 10),
        bestStrategy: review.bestStrategy,
        bestScore: review.bestScore,
        winRate: review.winRate,
        profitFactor: review.profitFactor,
        aiSummary: review.aiSummary || null,
        aiSuggestions: review.aiSuggestions || null,
        message: review.aiSummary
          ? `AI Review ${sym}: ${review.aiSummary.slice(0, 120)}`
          : `Reviewed ${sym}: best=${review.bestStrategy} (score=${review.bestScore.toFixed(2)}, WR=${(review.winRate * 100).toFixed(1)}%)`,
      });
    }

    send({
      phase: "ai_review_complete", stage: "ai_review", overallPct: 80,
      message: `Step 3 complete — ${enabledSymbols.length} symbols reviewed${aiAvailable ? " with AI analysis" : ""}.`,
    });

    send({
      phase: "optimising", stage: "optimise", overallPct: 80,
      message: "Step 4 of 6: Computing AI-optimised trading parameters...",
    });
    const topCombos = sortedCombos.slice(0, Math.min(6, sortedCombos.length));
    const realStrategies = [...new Set(topCombos.map(c => c.strategy))];
    const realSymbols = [...new Set(topCombos.map(c => c.symbol))];
    const allStrategies = STRATEGIES.join(",");
    const allSymbols = V1_DEFAULT_SYMBOLS.join(",");

    const bestAvgHold = topCombos.length > 0
      ? topCombos.reduce((s, c) => s + c.avgHold, 0) / topCombos.length : 72;
    const bestPf = topCombos.length > 0
      ? topCombos.reduce((s, c) => s + c.profitFactor, 0) / topCombos.length : 1.5;

    const optTpStrong = parseFloat(Math.min(Math.max(1.8 + bestPf * 0.5, 2.5), 4.0).toFixed(2));
    const optTpMed = parseFloat(Math.min(Math.max(1.5 + bestPf * 0.35, 2.0), 3.5).toFixed(2));
    const optTpWeak = parseFloat(Math.min(Math.max(1.2 + bestPf * 0.25, 1.5), 2.5).toFixed(2));
    const optSl = parseFloat(Math.min(Math.max(0.8, 1.0 / bestPf), 1.5).toFixed(2));
    const optHold = parseFloat(Math.max(48, Math.min(bestAvgHold * 1.3, 168)).toFixed(1));
    const optEquity = parseFloat(Math.min(Math.max(8, 12), 16).toFixed(2));

    function computeModeSettings(combos: typeof comboResults, prefix: string) {
      const settings: Record<string, string> = {};
      if (combos.length === 0) return settings;
      let tpS = 0, tpM = 0, tpW = 0, sl = 0, eq = 0, hold = 0, n = 0;
      for (const c of combos) {
        const agg = strategyAgg[c.strategy];
        if (!agg || agg.count === 0) continue;
        const cnt = Math.max(agg.count, 1);
        const avgTp = agg.tpSum / cnt;
        tpS += Math.min(avgTp * 1.2, 4.0);
        tpM += avgTp;
        tpW += Math.max(avgTp * 0.85, 1.5);
        sl += agg.slSum / cnt;
        hold += Math.max(agg.holdSum / cnt, 48);
        n++;
      }
      if (n === 0) return settings;
      const trailPct = prefix === "real" ? 20 : 25;
      const modeEquity = prefix === "real" ? 8 : (prefix === "demo" ? 12 : 16);
      settings[`${prefix}_tp_multiplier_strong`] = parseFloat((tpS / n).toFixed(2)).toString();
      settings[`${prefix}_tp_multiplier_medium`] = parseFloat((tpM / n).toFixed(2)).toString();
      settings[`${prefix}_tp_multiplier_weak`] = parseFloat((tpW / n).toFixed(2)).toString();
      settings[`${prefix}_sl_ratio`] = parseFloat((sl / n).toFixed(2)).toString();
      settings[`${prefix}_trailing_stop_pct`] = String(trailPct);
      settings[`${prefix}_equity_pct_per_trade`] = modeEquity.toFixed(2);
      settings[`${prefix}_time_exit_window_hours`] = parseFloat((hold / n).toFixed(1)).toString();
      return settings;
    }

    const demoTop = sortedCombos.slice(0, Math.min(8, sortedCombos.length));
    const realTop = sortedCombos.slice(0, Math.min(4, sortedCombos.length));
    const demoModeSettings = computeModeSettings(demoTop, "demo");
    const realModeSettings = computeModeSettings(realTop, "real");

    const aiSuggestions: Record<string, string> = {};
    aiSuggestions["paper_tp_multiplier_strong"] = String(optTpStrong);
    aiSuggestions["paper_tp_multiplier_medium"] = String(optTpMed);
    aiSuggestions["paper_tp_multiplier_weak"] = String(optTpWeak);
    aiSuggestions["paper_sl_ratio"] = String(optSl);
    aiSuggestions["paper_time_exit_window_hours"] = String(optHold);
    aiSuggestions["paper_equity_pct_per_trade"] = String(optEquity);

    for (const [key, value] of Object.entries(demoModeSettings)) {
      aiSuggestions[key] = value;
    }
    for (const [key, value] of Object.entries(realModeSettings)) {
      aiSuggestions[key] = value;
    }

    if (realStrategies.length > 0) {
      aiSuggestions["real_enabled_strategies"] = realStrategies.join(",");
    }
    if (realSymbols.length > 0) {
      aiSuggestions["real_enabled_symbols"] = realSymbols.join(",");
    }

    for (const [key, value] of Object.entries(aiSuggestions)) {
      const suggestKey = `ai_suggest_${key}`;
      await db.insert(platformStateTable).values({ key: suggestKey, value })
        .onConflictDoUpdate({ target: platformStateTable.key, set: { value, updatedAt: new Date() } });
    }

    await db.insert(platformStateTable).values({ key: "ai_optimised_at", value: new Date().toISOString() })
      .onConflictDoUpdate({ target: platformStateTable.key, set: { value: new Date().toISOString(), updatedAt: new Date() } });
    await db.insert(platformStateTable).values({ key: "ai_recommended_strategies", value: realStrategies.join(",") })
      .onConflictDoUpdate({ target: platformStateTable.key, set: { value: realStrategies.join(","), updatedAt: new Date() } });
    await db.insert(platformStateTable).values({ key: "ai_recommended_symbols", value: realSymbols.join(",") })
      .onConflictDoUpdate({ target: platformStateTable.key, set: { value: realSymbols.join(","), updatedAt: new Date() } });

    send({
      phase: "optimise_complete", stage: "optimise", overallPct: 88,
      message: "Step 4 complete — AI-optimised settings saved.",
    });

    send({
      phase: "streaming_start", stage: "streaming", overallPct: 90,
      message: "Step 5 of 6: Starting live data stream...",
    });

    try {
      const streamClient = await getDerivClientWithDbToken();
      await streamClient.startStreaming(V1_DEFAULT_SYMBOLS);
      await db.insert(platformStateTable).values({ key: "streaming", value: "true" })
        .onConflictDoUpdate({ target: platformStateTable.key, set: { value: "true", updatedAt: new Date() } });
      console.log(`[Setup] Streaming started for ${V1_DEFAULT_SYMBOLS.length} symbols after setup complete`);
    } catch (streamErr) {
      const errMsg = streamErr instanceof Error ? streamErr.message : String(streamErr);
      console.error("[Setup] Streaming failed:", errMsg);
      send({ phase: "error", stage: "streaming", message: `Streaming failed: ${errMsg}. Setup incomplete — please try again.` });
      res.end();
      return;
    }

    const setupCompleteEntries: Record<string, string> = {
      initial_setup_complete: "true",
      initial_setup_at: new Date().toISOString(),
    };
    for (const [key, value] of Object.entries(setupCompleteEntries)) {
      await db.insert(platformStateTable).values({ key, value })
        .onConflictDoUpdate({ target: platformStateTable.key, set: { value, updatedAt: new Date() } });
    }

    send({
      phase: "streaming_complete", stage: "streaming", overallPct: 95,
      message: `Step 5 complete — streaming ${V1_DEFAULT_SYMBOLS.length} symbols.`,
    });

    const totalSec = Math.round((Date.now() - globalStart) / 1000);
    send({
      phase: "complete", stage: "complete", overallPct: 100,
      candleTotal, btCompleted, btTotal,
      message: `Step 6 of 6: Complete — ${candleTotal.toLocaleString()} candles, ${btCompleted} backtests, settings optimised, streaming live (${totalSec}s)`,
    });

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    send({ phase: "error", message: err instanceof Error ? err.message : "Initialisation failed" });
    res.end();
  }
});

router.post("/setup/reset", async (_req, res): Promise<void> => {
  try {
    const API_KEY_KEYS = ["deriv_api_token", "deriv_api_token_demo", "deriv_api_token_real", "openai_api_key"];

    const existingKeys = await db.select().from(platformStateTable)
      .where(inArray(platformStateTable.key, API_KEY_KEYS));
    const savedKeys: Record<string, string> = {};
    for (const row of existingKeys) {
      if (row.value) savedKeys[row.key] = row.value;
    }

    await db.delete(backtestTradesTable);
    await db.delete(backtestRunsTable);
    await db.delete(tradesTable);
    await db.delete(signalLogTable);
    await db.delete(featuresTable);
    await db.delete(modelRunsTable);
    await db.delete(spikeEventsTable);
    await db.delete(candlesTable);
    await db.delete(ticksTable);
    await db.delete(platformStateTable);

    for (const [key, value] of Object.entries(savedKeys)) {
      await db.insert(platformStateTable).values({ key, value });
    }

    res.json({ success: true, message: "All data cleared (API keys preserved). Ready for fresh setup." });
  } catch (err) {
    res.status(500).json({ success: false, message: err instanceof Error ? err.message : "Reset failed" });
  }
});

export default router;
