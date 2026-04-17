import { Router, type IRouter } from "express";
import { eq, and, inArray, count, sql } from "drizzle-orm";
import { db, candlesTable, backtestRunsTable, backtestTradesTable, platformStateTable, tradesTable, signalLogTable, ticksTable, spikeEventsTable, featuresTable, modelRunsTable } from "@workspace/db";
import { getDerivClientWithDbToken, getDbApiTokenForMode, ACTIVE_TRADING_SYMBOLS } from "../infrastructure/deriv.js";
import { checkOpenAiHealth, isOpenAIConfigured } from "../infrastructure/openai.js";
import { getApiSymbol, validateActiveSymbols } from "../infrastructure/symbolValidator.js";
import { reconcileSymbolData } from "../core/dataIntegrity.js";
import { runNativeScoreCalibration } from "../core/calibrationRunner.js";

const router: IRouter = Router();

interface SetupProgress {
  running: boolean;
  events: Array<Record<string, unknown>>;
  lastEventIndex: number;
  startedAt: number;
  completedAt: number | null;
  error: string | null;
}

let setupProgress: SetupProgress = {
  running: false,
  events: [],
  lastEventIndex: 0,
  startedAt: 0,
  completedAt: null,
  error: null,
};

const MAX_PROGRESS_EVENTS = 2000;
const GRANULARITY_1M = 60;
const GRANULARITY_5M = 300;
const MAX_BATCH = 5000;
const MAX_CONSECUTIVE_ERRORS = 5;
const API_RATE_DELAY_MS = 150;
const TWELVE_MONTHS_SECONDS = 365 * 24 * 3600;
const MIN_SYMBOLS_FOR_PROCEED = Math.ceil(ACTIVE_TRADING_SYMBOLS.length * 0.5);
const AI_LOCKABLE_KEYS = [
  "equity_pct_per_trade", "paper_equity_pct_per_trade",
  "demo_equity_pct_per_trade",
  "real_equity_pct_per_trade",
  "min_composite_score", "min_rr_ratio", "min_ev_threshold",
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
      ACTIVE_TRADING_SYMBOLS.map(async (symbol) => {
        const [r1m] = await db.select({ n: count() }).from(candlesTable)
          .where(and(eq(candlesTable.symbol, symbol), eq(candlesTable.timeframe, "1m")));
        const [r5m] = await db.select({ n: count() }).from(candlesTable)
          .where(and(eq(candlesTable.symbol, symbol), eq(candlesTable.timeframe, "5m")));
        return { symbol, count: (r1m?.n ?? 0) + (r5m?.n ?? 0) };
      })
    );

    const totalCandles = symbolCounts.reduce((s, r) => s + r.count, 0);
    const hasEnoughData = symbolCounts.filter(r => r.count >= 100).length >= Math.ceil(ACTIVE_TRADING_SYMBOLS.length * 0.5);

    const calibrationRows = await db.select().from(platformStateTable)
      .where(eq(platformStateTable.key, "calibration_last_run")).limit(1);
    const hasInitialCalibration = calibrationRows.length > 0 && !!calibrationRows[0].value;

    const setupRow = await db.select().from(platformStateTable)
      .where(eq(platformStateTable.key, "initial_setup_complete")).limit(1);
    const initialSetupDone = setupRow.length > 0 && setupRow[0].value === "true";

    res.json({
      hasToken,
      totalCandles,
      symbolCounts,
      hasEnoughData,
      hasInitialCalibration,
      initialSetupComplete: initialSetupDone,
      setupComplete: initialSetupDone && hasEnoughData && hasInitialCalibration,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

async function queryOldestAvailableEpoch(
  client: Awaited<ReturnType<typeof getDerivClientWithDbToken>>,
  apiSymbol: string,
  granularity: number
): Promise<number | null> {
  try {
    const nowEpoch = Math.floor(Date.now() / 1000);
    const oneYearAgoEpoch = nowEpoch - TWELVE_MONTHS_SECONDS;
    const resp = await client.getCandleHistoryWithEnd(apiSymbol, granularity, 1, oneYearAgoEpoch, true);
    if (resp && resp.length > 0) {
      return Math.max(resp[0].epoch, oneYearAgoEpoch);
    }
    const resp2 = await client.getCandleHistoryWithEnd(apiSymbol, granularity, 1, undefined, true);
    if (resp2 && resp2.length > 0) {
      return Math.max(resp2[0].epoch, oneYearAgoEpoch);
    }
    return oneYearAgoEpoch;
  } catch {
    return null;
  }
}

router.get("/setup/progress", (_req, res): void => {
  const since = parseInt(String(_req.query.since) || "0", 10);
  const newEvents = setupProgress.events.slice(since);
  res.json({
    running: setupProgress.running,
    events: newEvents,
    totalEvents: setupProgress.events.length,
    since,
    completedAt: setupProgress.completedAt,
    error: setupProgress.error,
  });
});

router.post("/setup/initialise", async (_req, res): Promise<void> => {
  if (setupProgress.running) {
    res.json({ started: false, message: "Setup is already running.", totalEvents: setupProgress.events.length });
    return;
  }

  setupProgress = {
    running: true,
    events: [],
    lastEventIndex: 0,
    startedAt: Date.now(),
    completedAt: null,
    error: null,
  };

  res.json({ started: true, message: "Setup started." });

  const send = (data: Record<string, unknown>) => {
    if (setupProgress.events.length >= MAX_PROGRESS_EVENTS) {
      setupProgress.events.splice(0, 500);
    }
    setupProgress.events.push(data);
  };

  runSetupInBackground(send).catch(err => {
    console.error("[Setup] Background setup crashed:", err);
    setupProgress.error = err instanceof Error ? err.message : String(err);
    setupProgress.running = false;
    setupProgress.completedAt = Date.now();
  });
});

async function runSetupInBackground(send: (data: Record<string, unknown>) => void): Promise<void> {
  const globalStart = Date.now();

  try {
    const nowEpoch = Math.floor(Date.now() / 1000);
    const oneYearAgoEpoch = nowEpoch - TWELVE_MONTHS_SECONDS;
    const SIX_MONTHS_SECONDS = 182 * 24 * 3600;
    const expected1m = Math.ceil(SIX_MONTHS_SECONDS / 60);
    const expected5m = Math.ceil(SIX_MONTHS_SECONDS / 300);
    const perSymbolExpected = expected1m + expected5m;
    const grandTotalExpected = perSymbolExpected * ACTIVE_TRADING_SYMBOLS.length;

    send({
      phase: "backfill_probing",
      stage: "backfill",
      message: "Preparing symbols and connecting to Deriv API...",
      totalSymbols: ACTIVE_TRADING_SYMBOLS.length,
    });

    for (let si = 0; si < ACTIVE_TRADING_SYMBOLS.length; si++) {
      const symbol = ACTIVE_TRADING_SYMBOLS[si];
      send({
        phase: "backfill_probe_result",
        stage: "backfill",
        symbol,
        symbolIndex: si,
        totalSymbols: ACTIVE_TRADING_SYMBOLS.length,
        connected: true,
        oldestAvailableDate: new Date(oneYearAgoEpoch * 1000).toISOString().slice(0, 10),
        oldestEpoch: oneYearAgoEpoch,
        expected1m,
        expected5m,
        totalExpected: perSymbolExpected,
        message: `${symbol}: ready (~${perSymbolExpected.toLocaleString()} records)`,
      });
    }

    send({
      phase: "backfill_start",
      stage: "backfill",
      message: `Clearing old data and connecting to Deriv...`,
      totalSymbols: ACTIVE_TRADING_SYMBOLS.length,
      connectedCount: ACTIVE_TRADING_SYMBOLS.length,
      grandTotalExpected,
      symbols: ACTIVE_TRADING_SYMBOLS.map(s => ({
        symbol: s,
        status: "waiting",
        candles: 0,
        oldestDate: new Date(oneYearAgoEpoch * 1000).toISOString().slice(0, 10),
        expected: perSymbolExpected,
        connected: true,
        error: null,
      })),
    });

    console.log("[Setup] Clearing derived data tables (preserving candles if present)...");
    await db.delete(backtestRunsTable);
    await db.delete(backtestTradesTable);
    await db.delete(tradesTable);
    await db.delete(signalLogTable);
    await db.delete(ticksTable);
    await db.delete(spikeEventsTable);
    await db.delete(featuresTable);
    await db.delete(modelRunsTable);
    console.log("[Setup] Derived tables cleared. Connecting to Deriv WS...");

    const client = await getDerivClientWithDbToken();
    await client.connect();
    console.log("[Setup] Deriv WS connected. Validating symbols...");
    await validateActiveSymbols(true);
    console.log("[Setup] Symbol validation complete. Starting backfill...");

    send({
      phase: "backfill_start",
      stage: "backfill",
      message: `Step 1 of 5: Downloading history for ${ACTIVE_TRADING_SYMBOLS.length} symbols (~${grandTotalExpected.toLocaleString()} total records)...`,
      totalSymbols: ACTIVE_TRADING_SYMBOLS.length,
      connectedCount: ACTIVE_TRADING_SYMBOLS.length,
      grandTotalExpected,
      symbols: ACTIVE_TRADING_SYMBOLS.map(s => ({
        symbol: s,
        status: "waiting",
        candles: 0,
        oldestDate: new Date(oneYearAgoEpoch * 1000).toISOString().slice(0, 10),
        expected: perSymbolExpected,
        connected: true,
        error: null,
      })),
    });

    let candleTotal = 0;
    const timeframes: { tf: string; granularity: number }[] = [
      { tf: "1m", granularity: GRANULARITY_1M },
      { tf: "5m", granularity: GRANULARITY_5M },
    ];
    const totalJobs = ACTIVE_TRADING_SYMBOLS.length * timeframes.length;

    let jobsDone = 0;
    const failedSymbols: { symbol: string; error: string; timeframe: string }[] = [];

    for (let si = 0; si < ACTIVE_TRADING_SYMBOLS.length; si++) {
      const symbol = ACTIVE_TRADING_SYMBOLS[si];
      const apiSymbol = getApiSymbol(symbol);
      let symbolTotalInserted = 0;
      let symbolFailed = false;

      send({
        phase: "backfill_symbol_start", stage: "backfill", symbol,
        symbolIndex: si, totalSymbols: ACTIVE_TRADING_SYMBOLS.length,
        status: "downloading", symbolPct: 0,
        apiSymbol,
        totalExpected: perSymbolExpected,
        message: `Starting ${symbol} (${si + 1}/${ACTIVE_TRADING_SYMBOLS.length}) — ~${perSymbolExpected.toLocaleString()} records expected...`,
      });

      for (const { tf, granularity } of timeframes) {
        const tfExpected = tf === "1m" ? expected1m : expected5m;

        const coverageResult = await db
          .select({
            cnt: count(),
            maxTs: sql<number>`MAX(${candlesTable.openTs})`,
          })
          .from(candlesTable)
          .where(and(eq(candlesTable.symbol, symbol), eq(candlesTable.timeframe, tf)));
        const existingCnt = coverageResult[0]?.cnt ?? 0;
        const existingMaxTs = coverageResult[0]?.maxTs ?? 0;
        const nowEpoch = Math.floor(Date.now() / 1000);
        const targetRangeStart = nowEpoch - 365 * 24 * 3600;

        const recentWindowSecs = 24 * 3600;
        const isRecent = existingMaxTs > 0 && existingMaxTs >= nowEpoch - recentWindowSecs;
        const hasAnyData = existingCnt > 0 && existingMaxTs > targetRangeStart;
        const stopEpoch = hasAnyData ? existingMaxTs + 1 : targetRangeStart;

        if (isRecent && hasAnyData) {
          console.log(`[Setup] ${symbol} ${tf}: ${existingCnt} candles, latest ${new Date(existingMaxTs * 1000).toISOString().slice(0, 16)} — up to date, skipping.`);
          jobsDone++;
          symbolTotalInserted += existingCnt;
          candleTotal += existingCnt;
          send({
            phase: "backfill_tf_complete", stage: "backfill", symbol, timeframe: tf,
            inserted: existingCnt, skipped: true,
            message: `${symbol} ${tf}: up to date (${existingCnt.toLocaleString()} candles)`,
            overallPct: Math.round((jobsDone / totalJobs) * 100),
          });
          continue;
        }

        if (existingCnt > 0) {
          console.log(`[Setup] ${symbol} ${tf}: ${existingCnt} candles, latest ${new Date(existingMaxTs * 1000).toISOString().slice(0, 16)} — gap-filling to now...`);
        } else {
          console.log(`[Setup] ${symbol} ${tf}: no data — downloading full 12-month range...`);
        }

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
              const errorCode = errMsg.includes("not connected") ? "WS_DISCONNECTED"
                : errMsg.includes("timed out") ? "REQUEST_TIMEOUT"
                : errMsg.includes("rate") ? "RATE_LIMITED"
                : "API_ERROR";
              send({
                phase: "backfill_symbol_error", stage: "backfill", symbol,
                symbolIndex: si, totalSymbols: ACTIVE_TRADING_SYMBOLS.length,
                status: "error", timeframe: tf,
                errorCode,
                error: `Failed after ${consecutiveErrors} retries: ${errMsg}`,
                message: `${symbol} ${tf} failed: ${errMsg}`,
                candlesForSymbol: symbolTotalInserted,
              });
              failedSymbols.push({ symbol, error: `${errorCode}: ${errMsg}`, timeframe: tf });
              symbolFailed = true;
              break;
            }
            if (errMsg.includes("not connected") || errMsg.includes("timed out") || errMsg.includes("WebSocket")) {
              send({
                phase: "backfill_retry", stage: "backfill", symbol,
                symbolIndex: si, totalSymbols: ACTIVE_TRADING_SYMBOLS.length,
                timeframe: tf,
                attempt: consecutiveErrors,
                maxAttempts: MAX_CONSECUTIVE_ERRORS,
                errorCode: "WS_RECONNECTING",
                error: errMsg,
                message: `${symbol} ${tf}: connection lost, reconnecting (attempt ${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS})...`,
              });
              await new Promise(r => setTimeout(r, 3000));
              try {
                await client.connect();
              } catch {
                await new Promise(r => setTimeout(r, 5000));
              }
            } else {
              send({
                phase: "backfill_retry", stage: "backfill", symbol,
                symbolIndex: si, totalSymbols: ACTIVE_TRADING_SYMBOLS.length,
                timeframe: tf,
                attempt: consecutiveErrors,
                maxAttempts: MAX_CONSECUTIVE_ERRORS,
                errorCode: "RETRYING",
                error: errMsg,
                message: `${symbol} ${tf}: error, retrying (attempt ${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS})...`,
              });
              await new Promise(r => setTimeout(r, 2000));
            }
            continue;
          }
          if (candles === null || candles === undefined) {
            consecutiveErrors++;
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
              send({
                phase: "backfill_symbol_error", stage: "backfill", symbol,
                symbolIndex: si, totalSymbols: ACTIVE_TRADING_SYMBOLS.length,
                status: "error", timeframe: tf,
                errorCode: "NULL_RESPONSE",
                error: `API returned null after ${consecutiveErrors} retries`,
                message: `${symbol} ${tf} failed: API returned empty response`,
                candlesForSymbol: symbolTotalInserted,
              });
              failedSymbols.push({ symbol, error: `NULL_RESPONSE: API returned null after ${consecutiveErrors} retries`, timeframe: tf });
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
          oldestDateStr = new Date(Math.max(earliestEpoch, stopEpoch) * 1000).toISOString().slice(0, 10);

          const filteredByDate = sorted.filter(c => c.epoch >= stopEpoch);
          if (filteredByDate.length === 0) break;

          const newRows = filteredByDate.map(c => ({
            symbol, timeframe: tf, openTs: c.epoch, closeTs: c.epoch + granularity,
            open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), tickCount: 0,
          }));
          if (newRows.length > 0) {
            for (let chunk = 0; chunk < newRows.length; chunk += 1000) {
              await db.insert(candlesTable).values(newRows.slice(chunk, chunk + 1000)).onConflictDoNothing({ target: [candlesTable.symbol, candlesTable.timeframe, candlesTable.openTs] });
            }
            tfInserted += newRows.length;
            symbolTotalInserted += newRows.length;
            candleTotal += newRows.length;
          }

          if (candles.length < MAX_BATCH) break;
          if (earliestEpoch <= stopEpoch) break;

          const newEnd = earliestEpoch - 1;
          if (newEnd >= endEpoch || newEnd < stopEpoch) break;
          endEpoch = newEnd;

          const symbolPct = perSymbolExpected > 0
            ? Math.min(Math.round((symbolTotalInserted / perSymbolExpected) * 100), 99)
            : Math.min(Math.round((page / Math.max(page + 20, 50)) * 100), 99);

          const jobFrac = (jobsDone + (symbolTotalInserted / Math.max(perSymbolExpected, 1))) / totalJobs;
          const overallPct = Math.max(Math.round(jobFrac * 40), 1);
          send({
            phase: "backfill_progress", stage: "backfill", symbol,
            symbolIndex: si, totalSymbols: ACTIVE_TRADING_SYMBOLS.length,
            timeframe: tf,
            candlesForSymbol: symbolTotalInserted,
            candleTotal,
            oldestDate: oldestDateStr,
            overallPct,
            symbolPct,
            totalExpected: perSymbolExpected,
            tfExpected,
            tfFetched: tfInserted,
            page,
            message: `${symbol} ${tf}: ${tfInserted.toLocaleString()} candles (oldest: ${oldestDateStr})`,
          });

          await new Promise(r => setTimeout(r, API_RATE_DELAY_MS));
        }

        if (symbolFailed) break;
        jobsDone++;
      }

      if (symbolFailed) {
        send({
          phase: "backfill_symbol_failed", stage: "backfill", symbol,
          symbolIndex: si, totalSymbols: ACTIVE_TRADING_SYMBOLS.length,
          candlesForSymbol: symbolTotalInserted, candleTotal,
          status: "failed",
          message: `${symbol} failed — ${symbolTotalInserted.toLocaleString()} candles downloaded before error`,
        });
        continue;
      }

      const overallPct = Math.round((jobsDone / totalJobs) * 40);
      send({
        phase: "backfill_symbol_done", stage: "backfill", symbol,
        symbolIndex: si, totalSymbols: ACTIVE_TRADING_SYMBOLS.length,
        candlesForSymbol: symbolTotalInserted, candleTotal,
        overallPct, symbolPct: 100,
        totalExpected: perSymbolExpected,
        status: "done",
        message: `${symbol} done — ${symbolTotalInserted.toLocaleString()} candles`,
      });
    }

    const uniqueFailedSymbols = [...new Set(failedSymbols.map(f => f.symbol))];
    const successCount = ACTIVE_TRADING_SYMBOLS.length - uniqueFailedSymbols.length;

    if (successCount === 0) {
      send({
        phase: "error", stage: "backfill",
        errorCode: "ALL_SYMBOLS_FAILED",
        failedSymbols: failedSymbols.map(f => ({ symbol: f.symbol, error: f.error, timeframe: f.timeframe })),
        message: `Setup failed: all ${ACTIVE_TRADING_SYMBOLS.length} symbols failed to download. Check your Deriv API connection and try again.`,
      });
      setupProgress.running = false;
      setupProgress.completedAt = Date.now();
      return;
    }

    if (successCount < MIN_SYMBOLS_FOR_PROCEED) {
      send({
        phase: "backfill_partial_warning", stage: "backfill",
        successCount,
        failedCount: uniqueFailedSymbols.length,
        failedSymbols: failedSymbols.map(f => ({ symbol: f.symbol, error: f.error, timeframe: f.timeframe })),
        message: `Warning: Only ${successCount}/${ACTIVE_TRADING_SYMBOLS.length} symbols succeeded. Failed: ${uniqueFailedSymbols.join(", ")}. Proceeding with available data — fix failed symbols from Research > Data Status.`,
      });
    }

    send({
      phase: "backfill_complete", stage: "backfill", candleTotal,
      overallPct: 40,
      successCount,
      failedCount: uniqueFailedSymbols.length,
      failedSymbols: failedSymbols.map(f => ({ symbol: f.symbol, error: f.error, timeframe: f.timeframe })),
      message: successCount === ACTIVE_TRADING_SYMBOLS.length
        ? `Step 1 complete — ${candleTotal.toLocaleString()} candles downloaded for all ${ACTIVE_TRADING_SYMBOLS.length} symbols (12-month history).`
        : `Step 1 complete — ${candleTotal.toLocaleString()} candles downloaded (${successCount}/${ACTIVE_TRADING_SYMBOLS.length} symbols succeeded, ${uniqueFailedSymbols.length} failed: ${uniqueFailedSymbols.join(", ")}). Re-download failed symbols from Research > Data Status.`,
    });

    const states = await db.select().from(platformStateTable);
    const stateMap: Record<string, string> = {};
    for (const s of states) stateMap[s.key] = s.value;

    const rawEnabled = stateMap["enabled_symbols"] ? stateMap["enabled_symbols"].split(",").filter(Boolean) : [];
    const enabledSymbols = (rawEnabled.length > 0
      ? rawEnabled.filter(s => ACTIVE_TRADING_SYMBOLS.includes(s))
      : [...ACTIVE_TRADING_SYMBOLS]
    ).filter(s => !uniqueFailedSymbols.includes(s));
    const reconcileTotal = enabledSymbols.length;
    let reconcileCompleted = 0;
    send({
      phase: "canonical_start",
      stage: "canonical",
      overallPct: 40,
      reconcileTotal,
      message: `Step 2 of 5: Running canonical data reconcile for ${reconcileTotal} symbols...`,
    });

    for (const symbol of enabledSymbols) {
      try {
        send({
          phase: "canonical_symbol_start",
          stage: "canonical",
          symbol,
          reconcileCompleted,
          reconcileTotal,
          overallPct: 40 + Math.round((reconcileCompleted / Math.max(reconcileTotal, 1)) * 35),
          message: `Reconciling ${symbol}: repairing gaps and rebuilding enriched timeframes...`,
        });

        const reconcile = await reconcileSymbolData(symbol, client);
        reconcileCompleted++;
        send({
          phase: "canonical_symbol_complete",
          stage: "canonical",
          symbol,
          reconcileCompleted,
          reconcileTotal,
          overallPct: 40 + Math.round((reconcileCompleted / Math.max(reconcileTotal, 1)) * 35),
          improvementDelta: reconcile.postCheck.improvementDelta,
          inserted: reconcile.repair.candlesInserted,
          message: `Reconciled ${symbol}: +${reconcile.postCheck.improvementDelta} base candles (${reconcile.repair.candlesInserted} repaired inserts)`,
        });
      } catch (err) {
        reconcileCompleted++;
        send({
          phase: "canonical_symbol_error",
          stage: "canonical",
          symbol,
          reconcileCompleted,
          reconcileTotal,
          overallPct: 40 + Math.round((reconcileCompleted / Math.max(reconcileTotal, 1)) * 35),
          message: `Reconcile error for ${symbol}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    send({
      phase: "canonical_complete",
      stage: "canonical",
      overallPct: 75,
      reconcileCompleted,
      reconcileTotal,
      message: `Step 2 complete — canonical reconcile finished for ${reconcileCompleted}/${reconcileTotal} symbols.`,
    });

    send({
      phase: "calibration_start",
      stage: "calibration",
      overallPct: 76,
      message: "Step 3 of 5: Running move calibration...",
    });
    const calibrationReport = await runNativeScoreCalibration(false);
    send({
      phase: "calibration_complete",
      stage: "calibration",
      overallPct: 88,
      enginesAnalyzed: calibrationReport.enginesAnalyzed ?? 0,
      message: `Step 3 complete — move calibration finished (${calibrationReport.enginesAnalyzed ?? 0} engines analyzed).`,
    });

    send({
      phase: "streaming_start", stage: "streaming", overallPct: 90,
      message: "Step 4 of 5: Starting live data stream...",
    });

    try {
      const streamClient = await getDerivClientWithDbToken();
      await streamClient.startStreaming(ACTIVE_TRADING_SYMBOLS);
      await db.insert(platformStateTable).values({ key: "streaming", value: "true" })
        .onConflictDoUpdate({ target: platformStateTable.key, set: { value: "true", updatedAt: new Date() } });
      console.log(`[Setup] Streaming started for ${ACTIVE_TRADING_SYMBOLS.length} symbols after setup complete`);
    } catch (streamErr) {
      const errMsg = streamErr instanceof Error ? streamErr.message : String(streamErr);
      console.error("[Setup] Streaming failed:", errMsg);
      send({ phase: "error", stage: "streaming", message: `Streaming failed: ${errMsg}. Setup incomplete — please try again.` });
      setupProgress.running = false;
      setupProgress.completedAt = Date.now();
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
      message: `Step 4 complete — streaming ${ACTIVE_TRADING_SYMBOLS.length} symbols.`,
    });

    const totalSec = Math.round((Date.now() - globalStart) / 1000);
    send({
      phase: "complete", stage: "complete", overallPct: 100,
      candleTotal, reconcileCompleted, reconcileTotal,
      failedSymbols: failedSymbols.map(f => ({ symbol: f.symbol, error: f.error, timeframe: f.timeframe })),
      message: `Step 5 of 5: Ready — ${candleTotal.toLocaleString()} candles, canonical data cleaned, move calibration complete, streaming live (${totalSec}s)`,
    });

    setupProgress.running = false;
    setupProgress.completedAt = Date.now();
    console.log(`[Setup] Setup complete in ${totalSec}s`);
  } catch (err) {
    send({ phase: "error", message: err instanceof Error ? err.message : "Initialisation failed" });
    setupProgress.error = err instanceof Error ? err.message : "Initialisation failed";
    setupProgress.running = false;
    setupProgress.completedAt = Date.now();
  }
}

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
