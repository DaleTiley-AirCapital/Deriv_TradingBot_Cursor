import { Router, type IRouter } from "express";
import { eq, and, inArray, count } from "drizzle-orm";
import { db, candlesTable, backtestRunsTable, backtestTradesTable, platformStateTable } from "@workspace/db";
import { getDerivClientWithDbToken, getDbApiToken, getDbApiTokenForMode, SUPPORTED_SYMBOLS } from "../lib/deriv.js";
import { checkOpenAiHealth, isOpenAIConfigured } from "../lib/openai.js";
import { runBacktestSimulation } from "../lib/backtestEngine.js";

const router: IRouter = Router();

const STRATEGIES = ["trend-pullback", "exhaustion-rebound", "volatility-breakout", "spike-hazard", "volatility-expansion", "liquidity-sweep", "macro-bias"] as const;
const GRANULARITY_1H = 3600;
const MONTHS_24_SECONDS = 24 * 30 * 24 * 3600;
const MAX_BATCH = 5000;
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
    const targetStartEpoch = Math.floor(Date.now() / 1000) - MONTHS_24_SECONDS;
    const expectedCandlesPerSymbol = Math.ceil(MONTHS_24_SECONDS / GRANULARITY_1H);
    let candleTotal = 0;

    send({
      phase: "backfill_start",
      stage: "backfill",
      message: `Downloading 24-month price history for ${SUPPORTED_SYMBOLS.length} indices...`,
      totalSymbols: SUPPORTED_SYMBOLS.length,
    });

    for (let si = 0; si < SUPPORTED_SYMBOLS.length; si++) {
      const symbol = SUPPORTED_SYMBOLS[si];
      let endEpoch = Math.floor(Date.now() / 1000);
      let symbolInserted = 0;
      let batchNum = 0;
      const MAX_BATCHES = 20;

      while (batchNum < MAX_BATCHES) {
        batchNum++;
        const candles = await client.getCandleHistoryWithEnd(symbol, GRANULARITY_1H, MAX_BATCH, endEpoch);
        if (!candles || candles.length === 0) break;

        const sorted = [...candles].sort((a, b) => a.epoch - b.epoch);
        const earliestEpoch = sorted[0].epoch;
        const toInsert = sorted.filter(c => c.epoch >= targetStartEpoch);
        const reachedTarget = earliestEpoch <= targetStartEpoch;

        if (toInsert.length > 0) {
          const existingTs = await db.select({ openTs: candlesTable.openTs })
            .from(candlesTable)
            .where(and(
              eq(candlesTable.symbol, symbol),
              eq(candlesTable.timeframe, "1h"),
              inArray(candlesTable.openTs, toInsert.map(c => c.epoch))
            ));
          const existingSet = new Set(existingTs.map(r => r.openTs));
          const newRows = toInsert.filter(c => !existingSet.has(c.epoch)).map(c => ({
            symbol, timeframe: "1h", openTs: c.epoch, closeTs: c.epoch + GRANULARITY_1H,
            open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), tickCount: 0,
          }));
          if (newRows.length > 0) {
            await db.insert(candlesTable).values(newRows);
            symbolInserted += newRows.length;
            candleTotal += newRows.length;
          }
        }

        const elapsedMs = Date.now() - globalStart;
        const symbolFrac = si / SUPPORTED_SYMBOLS.length;
        const withinFrac = reachedTarget ? 1 : Math.min((batchNum * MAX_BATCH) / expectedCandlesPerSymbol, 0.95);
        const backfillFrac = symbolFrac + withinFrac / SUPPORTED_SYMBOLS.length;
        const overallPct = Math.round(backfillFrac * 50);
        const estTotalMs = backfillFrac > 0.01 ? elapsedMs / backfillFrac : 0;
        const estRemainingSec = Math.ceil(Math.max(0, (estTotalMs - elapsedMs) / 1000));

        send({
          phase: "backfill_progress", stage: "backfill", symbol,
          symbolIndex: si, totalSymbols: SUPPORTED_SYMBOLS.length,
          candlesForSymbol: symbolInserted, candleTotal,
          overallPct, estRemainingSec,
          message: `Downloading ${symbol} (${si + 1}/${SUPPORTED_SYMBOLS.length}) — ${candleTotal.toLocaleString()} candles`,
        });

        if (reachedTarget) break;
        const newEnd = earliestEpoch - 1;
        if (newEnd >= endEpoch) break;
        endEpoch = newEnd;
        await new Promise(r => setTimeout(r, 150));
      }

      send({
        phase: "backfill_symbol_done", stage: "backfill", symbol,
        symbolIndex: si, totalSymbols: SUPPORTED_SYMBOLS.length,
        candlesForSymbol: symbolInserted, candleTotal,
        overallPct: Math.round(((si + 1) / SUPPORTED_SYMBOLS.length) * 50),
        message: `${symbol} done — ${symbolInserted.toLocaleString()} candles`,
      });
    }

    send({
      phase: "backfill_complete", stage: "backfill", candleTotal,
      overallPct: 50,
      message: `Download complete — ${candleTotal.toLocaleString()} candles. Starting backtests...`,
    });

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

    const btTotal = combinations.length;
    send({
      phase: "backtest_start", stage: "backtest",
      btTotal, overallPct: 50,
      message: `Running ${STRATEGIES.length} strategies × ${enabledSymbols.length} indices — ${btTotal} backtests`,
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
      const overallPct = 50 + Math.round((btCompleted / btTotal) * 45);

      send({
        phase: "backtest_progress", stage: "backtest",
        btCompleted, btTotal, candleTotal,
        strategy, symbol, overallPct,
        estRemainingSec: btRemaining,
        message: `Backtesting ${strategy.replace(/-/g, " ")} on ${symbol} (${btCompleted}/${btTotal})`,
      });
    }

    send({
      phase: "optimising", stage: "optimise", overallPct: 95,
      message: "Optimising settings from backtest results...",
    });

    const sortedCombos = [...comboResults].sort((a, b) => b.score - a.score);
    const topCombos = sortedCombos.slice(0, Math.min(6, sortedCombos.length));
    const realStrategies = [...new Set(topCombos.map(c => c.strategy))];
    const realSymbols = [...new Set(topCombos.map(c => c.symbol))];
    const allStrategies = STRATEGIES.join(",");
    const allSymbols = SUPPORTED_SYMBOLS.join(",");

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

    const aiSettings: Record<string, string> = {
      ai_equity_pct_per_trade: "8",
      ai_paper_equity_pct_per_trade: "16",
      ai_live_equity_pct_per_trade: "8",
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
      streaming: "false",
      mode: "idle",
      paper_mode_active: "false",
      demo_mode_active: "false",
      real_mode_active: "false",
      kill_switch: "false",
      min_composite_score: "85",
      min_ev_threshold: "0.003",
      min_rr_ratio: "1.5",
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
      await db.insert(platformStateTable).values({ key, value })
        .onConflictDoUpdate({ target: platformStateTable.key, set: { value, updatedAt: new Date() } });
    }

    const totalSec = Math.round((Date.now() - globalStart) / 1000);
    send({
      phase: "complete", stage: "complete", overallPct: 100,
      candleTotal, btCompleted, btTotal,
      message: `Setup complete — ${candleTotal.toLocaleString()} candles, ${btCompleted} backtests, settings optimised (${totalSec}s)`,
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
    await db.delete(candlesTable);
    await db.delete(platformStateTable);

    const { tradesTable } = await import("@workspace/db");
    await db.delete(tradesTable);

    for (const [key, value] of Object.entries(savedKeys)) {
      await db.insert(platformStateTable).values({ key, value });
    }

    res.json({ success: true, message: "All data cleared (API keys preserved). Ready for fresh setup." });
  } catch (err) {
    res.status(500).json({ success: false, message: err instanceof Error ? err.message : "Reset failed" });
  }
});

export default router;
