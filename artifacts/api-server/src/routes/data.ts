import { Router, type IRouter } from "express";
import { desc, eq, sql, and } from "drizzle-orm";
import { db, ticksTable, candlesTable, spikeEventsTable, platformStateTable } from "@workspace/db";
import { getDerivClientWithDbToken, SUPPORTED_SYMBOLS, getEnabledSymbols, getBackfillProgress, isBackfillRunning } from "../lib/deriv.js";
import { runBackfillWithTracking } from "../index.js";

const router: IRouter = Router();

router.post("/data/backfill/start", async (_req, res): Promise<void> => {
  if (isBackfillRunning()) {
    res.status(409).json({ success: false, message: "Backfill is already running." });
    return;
  }
  runBackfillWithTracking().catch(err => {
    console.error("[Backfill] Trigger failed:", err instanceof Error ? err.message : err);
  });
  res.json({ success: true, message: "Backfill started." });
});

router.get("/data/backfill/progress", async (_req, res): Promise<void> => {
  res.json(getBackfillProgress());
});

router.get("/data/backfill/summary", async (_req, res): Promise<void> => {
  const enabledSymbols = await getEnabledSymbols();
  const validSymbols = enabledSymbols.filter(s => SUPPORTED_SYMBOLS.includes(s));

  const summaries: Record<string, { ticks: number; candles1m: number; candles5m: number; oldestCandle1m: string | null; oldestCandle5m: string | null }> = {};

  for (const symbol of validSymbols) {
    const tickCount = await db.select({ count: sql<number>`count(*)` }).from(ticksTable).where(eq(ticksTable.symbol, symbol));
    const candles1mCount = await db.select({ count: sql<number>`count(*)` }).from(candlesTable).where(and(eq(candlesTable.symbol, symbol), eq(candlesTable.timeframe, "1m")));
    const candles5mCount = await db.select({ count: sql<number>`count(*)` }).from(candlesTable).where(and(eq(candlesTable.symbol, symbol), eq(candlesTable.timeframe, "5m")));

    const oldest1m = await db.select({ ts: candlesTable.openTs }).from(candlesTable).where(and(eq(candlesTable.symbol, symbol), eq(candlesTable.timeframe, "1m"))).orderBy(candlesTable.openTs).limit(1);
    const oldest5m = await db.select({ ts: candlesTable.openTs }).from(candlesTable).where(and(eq(candlesTable.symbol, symbol), eq(candlesTable.timeframe, "5m"))).orderBy(candlesTable.openTs).limit(1);

    summaries[symbol] = {
      ticks: Number(tickCount[0]?.count || 0),
      candles1m: Number(candles1mCount[0]?.count || 0),
      candles5m: Number(candles5mCount[0]?.count || 0),
      oldestCandle1m: oldest1m.length > 0 ? new Date(oldest1m[0].ts * 1000).toISOString().slice(0, 10) : null,
      oldestCandle5m: oldest5m.length > 0 ? new Date(oldest5m[0].ts * 1000).toISOString().slice(0, 10) : null,
    };
  }

  res.json({ symbols: summaries, backfillRunning: isBackfillRunning() });
});

router.post("/data/backfill", async (req, res): Promise<void> => {
  const { symbol = "BOOM1000", months = 12 } = req.body ?? {};

  if (!SUPPORTED_SYMBOLS.includes(symbol)) {
    res.status(400).json({ error: `Symbol '${symbol}' not supported. Use: ${SUPPORTED_SYMBOLS.join(", ")}` });
    return;
  }

  const monthsNum = Math.min(Math.max(Number(months) || 12, 1), 24);
  const tickCount = 5000;

  try {
    const client = await getDerivClientWithDbToken();
    await client.connect();
    const result = await client.backfill(symbol, tickCount);

    await db.insert(platformStateTable).values({ key: "last_sync_at", value: new Date().toISOString() })
      .onConflictDoUpdate({ target: platformStateTable.key, set: { value: new Date().toISOString(), updatedAt: new Date() } });

    res.json({
      success: true,
      message: `Backfill complete for ${symbol} (${monthsNum}mo requested): ${result.ticks} ticks and ${result.candles} candles stored.`,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ success: false, message: `Backfill failed: ${message}` });
  }
});

router.post("/data/stream/start", async (req, res): Promise<void> => {
  const enabledSymbols = await getEnabledSymbols();
  const { symbols = enabledSymbols } = req.body ?? {};

  const validSymbols = (symbols as string[]).filter(s => SUPPORTED_SYMBOLS.includes(s));
  if (validSymbols.length === 0) {
    res.status(400).json({ error: `No valid symbols provided. Supported: ${SUPPORTED_SYMBOLS.join(", ")}` });
    return;
  }

  try {
    const client = await getDerivClientWithDbToken();
    await client.startStreaming(validSymbols);
    res.json({ success: true, message: `Live tick stream started for: ${validSymbols.join(", ")}` });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ success: false, message: `Stream start failed: ${message}` });
  }
});

router.post("/data/stream/stop", async (_req, res): Promise<void> => {
  try {
    const client = await getDerivClientWithDbToken();
    await client.stopStreaming();
    res.json({ success: true, message: "Live tick stream stopped." });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ success: false, message: `Stream stop failed: ${message}` });
  }
});

router.get("/data/status", async (_req, res): Promise<void> => {
  const states = await db.select().from(platformStateTable);
  const stateMap: Record<string, string> = {};
  for (const s of states) stateMap[s.key] = s.value;

  const tickCountResult = await db.select({ count: sql<number>`count(*)` }).from(ticksTable);

  let streamingSymbols: string[] = [];
  try {
    const client = await getDerivClientWithDbToken();
    streamingSymbols = client.getSubscribedSymbols();
  } catch {
    streamingSymbols = (stateMap["streaming_symbols"] || "").split(",").filter(Boolean);
  }

  const paperActive = stateMap["paper_mode_active"] === "true";
  const demoActive  = stateMap["demo_mode_active"] === "true";
  const realActive  = stateMap["real_mode_active"] === "true";
  const isStreaming  = stateMap["streaming"] === "true";
  let derivedMode = "idle";
  if (realActive)       derivedMode = "live";
  else if (demoActive)  derivedMode = "demo";
  else if (paperActive) derivedMode = "paper";
  else if (isStreaming)  derivedMode = "scanning";

  res.json({
    mode: derivedMode,
    streaming: isStreaming,
    lastSyncAt: stateMap["last_sync_at"] || null,
    tickCount: Number(tickCountResult[0]?.count || 0),
    symbols: streamingSymbols.length > 0 ? streamingSymbols : SUPPORTED_SYMBOLS,
  });
});

router.get("/data/ticks", async (req, res): Promise<void> => {
  const symbol = String(req.query.symbol || "BOOM1000");
  const limit = Math.min(Number(req.query.limit || 100), 1000);
  const rows = await db.select().from(ticksTable)
    .where(eq(ticksTable.symbol, symbol))
    .orderBy(desc(ticksTable.epochTs))
    .limit(limit);
  res.json(rows.map(r => ({
    id: r.id,
    symbol: r.symbol,
    epochTs: r.epochTs,
    quote: r.quote,
    createdAt: r.createdAt.toISOString(),
  })));
});

router.get("/data/candles", async (req, res): Promise<void> => {
  const symbol = String(req.query.symbol || "BOOM1000");
  const timeframe = String(req.query.timeframe || "1m");
  const limit = Math.min(Number(req.query.limit || 200), 1000);
  const rows = await db.select().from(candlesTable)
    .where(eq(candlesTable.symbol, symbol))
    .orderBy(desc(candlesTable.openTs))
    .limit(limit);
  res.json(rows.map(r => ({
    id: r.id,
    symbol: r.symbol,
    timeframe: r.timeframe,
    openTs: r.openTs,
    closeTs: r.closeTs,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    tickCount: r.tickCount,
  })));
});

router.get("/data/spikes", async (req, res): Promise<void> => {
  const symbol = String(req.query.symbol || "BOOM1000");
  const limit = Math.min(Number(req.query.limit || 50), 500);
  const rows = await db.select().from(spikeEventsTable)
    .where(eq(spikeEventsTable.symbol, symbol))
    .orderBy(desc(spikeEventsTable.eventTs))
    .limit(limit);
  res.json(rows.map(r => ({
    id: r.id,
    symbol: r.symbol,
    eventTs: r.eventTs,
    direction: r.direction,
    spikeSize: r.spikeSize,
    ticksSincePreviousSpike: r.ticksSincePreviousSpike,
  })));
});

export default router;
