import { Router, type IRouter } from "express";
import { desc, eq, sql, and } from "drizzle-orm";
import { db, ticksTable, candlesTable, spikeEventsTable, platformStateTable } from "@workspace/db";
import { getDerivClientWithDbToken, ACTIVE_TRADING_SYMBOLS, getEnabledSymbols } from "../infrastructure/deriv.js";

const router: IRouter = Router();

function normalizeTimeframe(tf: string): string {
  const v = String(tf || "1m").trim().toLowerCase();
  if (v === "m1") return "1m";
  if (v === "m5") return "5m";
  if (v === "m10") return "10m";
  if (v === "m20") return "20m";
  if (v === "m40") return "40m";
  if (v === "h1") return "1h";
  if (v === "h2") return "2h";
  if (v === "h4") return "4h";
  if (v === "h8") return "8h";
  if (v === "d1") return "1d";
  if (v === "d2") return "2d";
  if (v === "d4") return "4d";
  return v;
}

router.post("/data/stream/start", async (req, res): Promise<void> => {
  const enabledSymbols = await getEnabledSymbols();
  const { symbols = enabledSymbols } = req.body ?? {};

  const validSymbols = (symbols as string[]).filter(s => ACTIVE_TRADING_SYMBOLS.includes(s));
  if (validSymbols.length === 0) {
    res.status(400).json({ error: `No valid symbols provided. Active symbols: ${ACTIVE_TRADING_SYMBOLS.join(", ")}` });
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
    symbols: streamingSymbols.length > 0 ? streamingSymbols : ACTIVE_TRADING_SYMBOLS,
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
  const timeframe = normalizeTimeframe(String(req.query.timeframe || "1m"));
  const limit = Math.min(Number(req.query.limit || 200), 1000);
  const rows = await db.select().from(candlesTable)
    .where(and(eq(candlesTable.symbol, symbol), eq(candlesTable.timeframe, timeframe)))
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
