import { Router, type IRouter } from "express";
import { eq, and, inArray, count } from "drizzle-orm";
import { db, candlesTable, backtestRunsTable, backtestTradesTable, platformStateTable } from "@workspace/db";
import { getDerivClientWithDbToken, getDbApiToken, SUPPORTED_SYMBOLS } from "../lib/deriv.js";
import { checkOpenAiHealth, isOpenAIConfigured } from "../lib/openai.js";
import { runBacktestSimulation } from "../lib/backtestEngine.js";

const router: IRouter = Router();

const STRATEGIES = ["trend-pullback", "exhaustion-rebound", "volatility-breakout", "spike-hazard", "volatility-expansion", "liquidity-sweep", "macro-bias"] as const;
const GRANULARITY_1H = 3600;
const MONTHS_24_SECONDS = 24 * 30 * 24 * 3600;
const MAX_BATCH = 5000;
const DEFAULT_CAPITAL = 10000;
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
    const derivToken = await getDbApiToken();
    const openaiConfigured = await isOpenAIConfigured();

    const [derivResult, openaiResult] = await Promise.all([
      (async (): Promise<{ ok: boolean; error?: string }> => {
        if (!derivToken) return { ok: false, error: "Deriv API token not configured. Add it in Settings → API Keys." };
        const DERIV_WS_URL = "wss://ws.binaryws.com/websockets/v3?app_id=1089";
        const { default: WebSocket } = await import("ws");
        return new Promise<{ ok: boolean; error?: string }>((resolve) => {
          const ws = new WebSocket(DERIV_WS_URL);
          let settled = false;
          const timeout = setTimeout(() => {
            if (!settled) {
              settled = true;
              try { ws.close(); } catch {}
              resolve({ ok: false, error: "Deriv WebSocket connection timed out after 15 seconds." });
            }
          }, 15000);

          ws.on("open", () => {
            ws.send(JSON.stringify({ authorize: derivToken, req_id: 1 }));
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
                resolve({ ok: false, error: `Deriv auth failed: ${(data.error as { message: string }).message}` });
              } else {
                resolve({ ok: true });
              }
            } catch {}
          });

          ws.on("error", (err: Error) => {
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              resolve({ ok: false, error: `Deriv connection error: ${err.message}` });
            }
          });
        });
      })(),
      (async (): Promise<{ ok: boolean; error?: string }> => {
        if (!openaiConfigured) return { ok: false, error: "OpenAI API key not configured. Add it in Settings → API Keys." };
        const health = await checkOpenAiHealth();
        if (!health.working) {
          return { ok: false, error: health.error || "OpenAI API key is invalid or the API is unreachable." };
        }
        return { ok: true };
      })(),
    ]);

    res.json({ deriv: derivResult, openai: openaiResult });
  } catch (err) {
    res.status(500).json({
      deriv: { ok: false, error: "Preflight check failed unexpectedly." },
      openai: { ok: false, error: err instanceof Error ? err.message : "Unknown error" },
    });
  }
});

router.get("/setup/status", async (_req, res): Promise<void> => {
  try {
    const tokenRow = await db.select().from(platformStateTable)
      .where(eq(platformStateTable.key, "deriv_api_token")).limit(1);
    const hasToken = tokenRow.length > 0 && !!tokenRow[0].value;

    const symbolCounts = await Promise.all(
      SUPPORTED_SYMBOLS.map(async (symbol) => {
        const [r] = await db.select({ n: count() }).from(candlesTable)
          .where(and(eq(candlesTable.symbol, symbol), eq(candlesTable.timeframe, "1h")));
        return { symbol, count: r?.n ?? 0 };
      })
    );

    const [btResult] = await db.select({ n: count() }).from(backtestRunsTable);
    const backtestCount = btResult?.n ?? 0;
    const expectedBacktests = SUPPORTED_SYMBOLS.length * STRATEGIES.length;

    const totalCandles = symbolCounts.reduce((s, r) => s + r.count, 0);
    const hasEnoughData = symbolCounts.filter(r => r.count >= 100).length >= Math.ceil(SUPPORTED_SYMBOLS.length * 0.5);
    const hasInitialBacktests = backtestCount >= expectedBacktests;

    res.json({
      hasToken,
      totalCandles,
      symbolCounts,
      hasEnoughData,
      hasInitialBacktests,
      backtestCount,
      expectedBacktests,
      setupComplete: hasEnoughData && hasInitialBacktests,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

router.post("/setup/backfill", async (req, res): Promise<void> => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const token = await getDbApiToken();
    if (!token) {
      send({ phase: "error", message: "No Deriv API token found. Please add your token in Settings → API Keys first." });
      res.end();
      return;
    }

    const client = await getDerivClientWithDbToken();
    const targetStartEpoch = Math.floor(Date.now() / 1000) - MONTHS_24_SECONDS;
    let grandTotal = 0;

    send({
      phase: "start",
      message: `Starting 24-month candle download for ${SUPPORTED_SYMBOLS.length} indices...`,
      totalSymbols: SUPPORTED_SYMBOLS.length,
    });

    for (let si = 0; si < SUPPORTED_SYMBOLS.length; si++) {
      const symbol = SUPPORTED_SYMBOLS[si];
      send({
        phase: "symbol_start",
        symbol,
        symbolIndex: si,
        totalSymbols: SUPPORTED_SYMBOLS.length,
        message: `Downloading history for ${symbol}...`,
      });

      let endEpoch = Math.floor(Date.now() / 1000);
      let symbolInserted = 0;
      let batchNum = 0;
      let reachedTarget = false;

      while (!reachedTarget) {
        batchNum++;
        const candles = await client.getCandleHistoryWithEnd(symbol, GRANULARITY_1H, MAX_BATCH, endEpoch);

        if (!candles || candles.length === 0) break;

        const targetCandles = candles.filter(c => c.epoch >= targetStartEpoch);
        if (targetCandles.length === 0) break;

        const toInsert = candles.filter(c => c.epoch >= targetStartEpoch);
        if (candles[0].epoch <= targetStartEpoch) reachedTarget = true;

        if (toInsert.length > 0) {
          const existingTs = await db.select({ openTs: candlesTable.openTs })
            .from(candlesTable)
            .where(and(
              eq(candlesTable.symbol, symbol),
              eq(candlesTable.timeframe, "1h"),
              inArray(candlesTable.openTs, toInsert.map(c => c.epoch))
            ));
          const existingSet = new Set(existingTs.map(r => r.openTs));

          const newRows = toInsert
            .filter(c => !existingSet.has(c.epoch))
            .map(c => ({
              symbol,
              timeframe: "1h",
              openTs: c.epoch,
              closeTs: c.epoch + GRANULARITY_1H,
              open: Number(c.open),
              high: Number(c.high),
              low: Number(c.low),
              close: Number(c.close),
              tickCount: 0,
            }));

          if (newRows.length > 0) {
            await db.insert(candlesTable).values(newRows);
            symbolInserted += newRows.length;
            grandTotal += newRows.length;
          }
        }

        send({
          phase: "symbol_progress",
          symbol,
          symbolIndex: si,
          totalSymbols: SUPPORTED_SYMBOLS.length,
          candlesForSymbol: symbolInserted,
          batchNum,
          message: `${symbol}: ${symbolInserted.toLocaleString()} candles downloaded...`,
        });

        if (reachedTarget || candles[0].epoch <= targetStartEpoch) break;

        endEpoch = candles[0].epoch - 1;
        await new Promise(r => setTimeout(r, 150));
      }

      send({
        phase: "symbol_done",
        symbol,
        symbolIndex: si,
        totalSymbols: SUPPORTED_SYMBOLS.length,
        candlesForSymbol: symbolInserted,
        message: `${symbol}: complete — ${symbolInserted.toLocaleString()} candles`,
      });
    }

    send({
      phase: "backfill_complete",
      grandTotal,
      message: `Download complete — ${grandTotal.toLocaleString()} candles across ${SUPPORTED_SYMBOLS.length} indices`,
    });

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    send({ phase: "error", message: err instanceof Error ? err.message : "Backfill failed" });
    res.end();
  }
});

router.post("/setup/initial-analyse", async (_req, res): Promise<void> => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const states = await db.select().from(platformStateTable);
    const stateMap: Record<string, string> = {};
    for (const s of states) stateMap[s.key] = s.value;

    const enabledSymbols = stateMap["enabled_symbols"]
      ? stateMap["enabled_symbols"].split(",").filter(Boolean)
      : SUPPORTED_SYMBOLS;
    const initialCapital = parseFloat(stateMap["total_capital"] || String(DEFAULT_CAPITAL));

    const combinations: { strategy: string; symbol: string }[] = [];
    for (const strategy of STRATEGIES) {
      for (const symbol of enabledSymbols) {
        combinations.push({ strategy, symbol });
      }
    }

    const total = combinations.length;
    send({
      phase: "start",
      total,
      message: `Running ${STRATEGIES.length} strategies across ${enabledSymbols.length} indices — ${total} backtests total`,
    });

    const strategyAgg: Record<string, {
      sharpeSum: number; sharpeCount: number;
      tpSum: number; slSum: number; holdSum: number;
      equitySum: number; drawdownSum: number; winRateSum: number; count: number;
    }> = {};
    for (const strat of STRATEGIES) {
      strategyAgg[strat] = { sharpeSum: 0, sharpeCount: 0, tpSum: 0, slSum: 0, holdSum: 0, equitySum: 0, drawdownSum: 0, winRateSum: 0, count: 0 };
    }

    const comboResults: { strategy: string; symbol: string; sharpe: number; winRate: number; score: number }[] = [];

    let completed = 0;
    const startTime = Date.now();

    for (const { strategy, symbol } of combinations) {
      try {
        const result = await runBacktestSimulation(strategy, symbol, initialCapital, "balanced");

        const [row] = await db.insert(backtestRunsTable).values({
          strategyName: strategy,
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
          configJson: { allocationMode: "balanced", symbol, strategyName: strategy, source: "initial-setup" },
          metricsJson: {
            equityCurve: result.equityCurve,
            grossProfit: result.grossProfit,
            grossLoss: result.grossLoss,
            avgWin: result.avgWin,
            avgLoss: result.avgLoss,
            maxDrawdownDuration: result.maxDrawdownDuration,
            monthlyReturns: result.monthlyReturns,
            returnBySymbol: result.returnBySymbol,
            returnByRegime: result.returnByRegime,
          },
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

        const r = strategyAgg[strategy];
        r.count++;
        if (result.sharpeRatio > 0 && result.tradeCount > 0) {
          r.sharpeSum += result.sharpeRatio;
          r.sharpeCount++;
        }
        r.holdSum += result.avgHoldingHours;
        r.drawdownSum += Math.abs(result.maxDrawdown);
        r.winRateSum += result.winRate;
        if (result.profitFactor > 0) {
          const optTp = 1.5 + result.profitFactor * 0.4;
          r.tpSum += Math.min(Math.max(optTp, 1.2), 4.0);
          r.slSum += Math.min(Math.max(1.0 / result.profitFactor, 0.5), 2.0);
        } else {
          r.tpSum += 2.0;
          r.slSum += 1.0;
        }
        r.equitySum += Math.min(Math.max(result.winRate * 4, 0.5), 5.0);

        if (result.tradeCount >= 3) {
          const comboScore = (result.sharpeRatio * 0.5) + (result.winRate * 0.3) + (result.profitFactor * 0.2);
          comboResults.push({ strategy, symbol, sharpe: result.sharpeRatio, winRate: result.winRate, score: comboScore });
        }
      } catch {
        // skip failed backtest
      }

      completed++;
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = completed / elapsed;
      const remaining = rate > 0 ? Math.ceil((total - completed) / rate) : 0;

      send({
        phase: "progress",
        completed,
        total,
        strategy,
        symbol,
        message: `Running ${strategy.replace(/-/g, " ")} on ${symbol} (${completed} of ${total})`,
        estimatedSecondsRemaining: remaining,
      });
    }

    let globalTpStrong = 0, globalTpMed = 0, globalTpWeak = 0, globalSl = 0, globalHold = 0, globalEquity = 0;
    let stratCount = 0;
    for (const [, r] of Object.entries(strategyAgg)) {
      const n = Math.max(r.count, 1);
      globalHold += r.holdSum / n;
      globalSl += r.slSum / n;
      globalEquity += r.equitySum / n;
      const avgTp = r.tpSum / n;
      globalTpStrong += Math.min(avgTp * 1.15, 4.0);
      globalTpMed += avgTp;
      globalTpWeak += Math.max(avgTp * 0.8, 1.0);
      stratCount++;
    }

    const sc = Math.max(stratCount, 1);
    const optEquity = parseFloat((globalEquity / sc).toFixed(2));
    const optTpStrong = parseFloat((globalTpStrong / sc).toFixed(2));
    const optTpMed = parseFloat((globalTpMed / sc).toFixed(2));
    const optTpWeak = parseFloat((globalTpWeak / sc).toFixed(2));
    const optSl = parseFloat((globalSl / sc).toFixed(2));
    const optHold = parseFloat((globalHold / sc).toFixed(1));

    const sortedCombos = [...comboResults].sort((a, b) => b.score - a.score);
    const top4 = sortedCombos.slice(0, 4);
    const realStrategies = [...new Set(top4.map(c => c.strategy))];
    const realSymbols = [...new Set(top4.map(c => c.symbol))];
    const allStrategies = STRATEGIES.join(",");
    const allSymbols = SUPPORTED_SYMBOLS.join(",");

    function computeModeSettings(combos: typeof comboResults, prefix: string) {
      const settings: Record<string, string> = {};
      if (combos.length === 0) return settings;

      let tpS = 0, tpM = 0, tpW = 0, sl = 0, eq = 0, hold = 0, n = 0;
      for (const c of combos) {
        const key = `${c.strategy}`;
        const agg = strategyAgg[key];
        if (!agg || agg.count === 0) continue;
        const cnt = Math.max(agg.count, 1);
        const avgTp = agg.tpSum / cnt;
        tpS += Math.min(avgTp * 1.15, 4.0);
        tpM += avgTp;
        tpW += Math.max(avgTp * 0.8, 1.0);
        sl += agg.slSum / cnt;
        eq += agg.equitySum / cnt;
        hold += agg.holdSum / cnt;
        n++;
      }
      if (n === 0) return settings;

      const trailPct = prefix === "real" ? 20 : 25;
      settings[`${prefix}_tp_multiplier_strong`] = parseFloat((tpS / n).toFixed(2)).toString();
      settings[`${prefix}_tp_multiplier_medium`] = parseFloat((tpM / n).toFixed(2)).toString();
      settings[`${prefix}_tp_multiplier_weak`] = parseFloat((tpW / n).toFixed(2)).toString();
      settings[`${prefix}_sl_ratio`] = parseFloat((sl / n).toFixed(2)).toString();
      settings[`${prefix}_trailing_stop_pct`] = String(trailPct);
      settings[`${prefix}_equity_pct_per_trade`] = parseFloat((eq / n).toFixed(2)).toString();
      settings[`${prefix}_time_exit_window_hours`] = parseFloat((hold / n).toFixed(1)).toString();
      return settings;
    }

    const demoTop = sortedCombos.slice(0, Math.min(8, sortedCombos.length));
    const realTop = sortedCombos.slice(0, Math.min(4, sortedCombos.length));
    const demoModeSettings = computeModeSettings(demoTop, "demo");
    const realModeSettings = computeModeSettings(realTop, "real");

    const aiSettings: Record<string, string> = {
      ai_equity_pct_per_trade: String(optEquity),
      ai_paper_equity_pct_per_trade: String(Math.max(optEquity * 0.6, 0.5).toFixed(2)),
      ai_live_equity_pct_per_trade: String(optEquity),
      ai_tp_multiplier_strong: String(optTpStrong),
      ai_tp_multiplier_medium: String(optTpMed),
      ai_tp_multiplier_weak: String(optTpWeak),
      ai_sl_ratio: String(optSl),
      ai_trailing_stop_pct: "25",
      ai_time_exit_window_hours: String(optHold),
      ai_settings_locked: "true",
      ai_optimised_at: new Date().toISOString(),
      initial_setup_complete: "true",
      initial_setup_at: new Date().toISOString(),
      paper_enabled_strategies: allStrategies,
      paper_enabled_symbols: allSymbols,
      demo_enabled_strategies: allStrategies,
      demo_enabled_symbols: allSymbols,
      real_enabled_strategies: realStrategies.length > 0 ? realStrategies.join(",") : allStrategies,
      real_enabled_symbols: realSymbols.length > 0 ? realSymbols.join(",") : allSymbols,
      ai_recommended_strategies: realStrategies.join(","),
      ai_recommended_symbols: realSymbols.join(","),
      ...demoModeSettings,
      ...realModeSettings,
    };

    for (const [key, value] of Object.entries(aiSettings)) {
      await db
        .insert(platformStateTable)
        .values({ key, value })
        .onConflictDoUpdate({
          target: platformStateTable.key,
          set: { value, updatedAt: new Date() },
        });
    }

    const paramCount = AI_LOCKABLE_KEYS.length;
    send({
      phase: "complete",
      completed: total,
      total,
      backtestsCreated: completed,
      message: `Analysis complete — ${completed} backtests saved, ${paramCount} settings optimised`,
      settings: {
        equity_pct_per_trade: optEquity,
        paper_equity_pct_per_trade: parseFloat((optEquity * 0.6).toFixed(2)),
        live_equity_pct_per_trade: optEquity,
        tp_multiplier_strong: optTpStrong,
        tp_multiplier_medium: optTpMed,
        tp_multiplier_weak: optTpWeak,
        sl_ratio: optSl,
        time_exit_window_hours: optHold,
      },
    });

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    send({ phase: "error", message: err instanceof Error ? err.message : "Analysis failed" });
    res.end();
  }
});

export default router;
