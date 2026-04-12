import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, tradesTable, platformStateTable, signalLogTable } from "@workspace/db";

const router: IRouter = Router();

router.post("/trade/mode/toggle", async (req, res): Promise<void> => {
  const { mode, active, confirmed } = req.body ?? {};

  if (!["paper", "demo", "real"].includes(mode)) {
    res.status(400).json({ success: false, message: "Mode must be paper, demo, or real" });
    return;
  }

  if (typeof active !== "boolean") {
    res.status(400).json({ success: false, message: "active must be a boolean" });
    return;
  }

  if (mode === "real" && active && !confirmed) {
    res.status(400).json({
      success: false,
      message: "Real trading requires confirmation. Send { confirmed: true } to proceed.",
      requiresConfirmation: true,
    });
    return;
  }

  if ((mode === "demo" || mode === "real") && active) {
    const tokenKey = mode === "demo" ? "deriv_api_token_demo" : "deriv_api_token_real";
    const tokenRow = await db.select().from(platformStateTable).where(eq(platformStateTable.key, tokenKey)).limit(1);
    const legacyTokenRow = await db.select().from(platformStateTable).where(eq(platformStateTable.key, "deriv_api_token")).limit(1);
    if ((!tokenRow.length || !tokenRow[0].value) && (!legacyTokenRow.length || !legacyTokenRow[0].value)) {
      res.status(403).json({
        success: false,
        message: `${mode === "demo" ? "Demo" : "Real"} trading requires a Deriv API token. Set it in Settings → API Keys first.`,
      });
      return;
    }
  }

  const stateKey = `${mode}_mode_active`;
  await db.insert(platformStateTable).values({ key: stateKey, value: active ? "true" : "false" })
    .onConflictDoUpdate({ target: platformStateTable.key, set: { value: active ? "true" : "false", updatedAt: new Date() } });

  const allStates = await db.select().from(platformStateTable);
  const stateMap: Record<string, string> = {};
  for (const s of allStates) stateMap[s.key] = s.value;

  const paperActive = stateMap["paper_mode_active"] === "true";
  const demoActive = stateMap["demo_mode_active"] === "true";
  const realActive = stateMap["real_mode_active"] === "true";
  let derivedMode = "idle";
  if (realActive) derivedMode = "real";
  else if (demoActive) derivedMode = "demo";
  else if (paperActive) derivedMode = "paper";

  await db.insert(platformStateTable).values({ key: "mode", value: derivedMode })
    .onConflictDoUpdate({ target: platformStateTable.key, set: { value: derivedMode, updatedAt: new Date() } });

  const modeLabel = mode.charAt(0).toUpperCase() + mode.slice(1);
  res.json({
    success: true,
    message: `${modeLabel} trading ${active ? "activated" : "deactivated"}.`,
    mode: derivedMode,
  });
});

router.post("/trade/paper/start", async (_req, res): Promise<void> => {
  await db.insert(platformStateTable).values({ key: "paper_mode_active", value: "true" })
    .onConflictDoUpdate({ target: platformStateTable.key, set: { value: "true", updatedAt: new Date() } });
  await db.insert(platformStateTable).values({ key: "mode", value: "paper" })
    .onConflictDoUpdate({ target: platformStateTable.key, set: { value: "paper", updatedAt: new Date() } });
  res.json({ success: true, message: "Paper trading mode activated. System is now routing signals through portfolio allocator." });
});

router.post("/trade/live/start", async (req, res): Promise<void> => {
  const { confirmed } = req.body ?? {};
  if (!confirmed) {
    res.status(400).json({
      success: false,
      message: "Live trading requires confirmation. Send { confirmed: true } to proceed.",
      requiresConfirmation: true,
    });
    return;
  }
  const tokenRow = await db.select().from(platformStateTable).where(eq(platformStateTable.key, "deriv_api_token")).limit(1);
  const demoTokenRow = await db.select().from(platformStateTable).where(eq(platformStateTable.key, "deriv_api_token_demo")).limit(1);
  if ((!tokenRow.length || !tokenRow[0].value) && (!demoTokenRow.length || !demoTokenRow[0].value)) {
    res.status(403).json({ success: false, message: "Live trading requires a Deriv API token. Set it in Settings → API Keys first." });
    return;
  }
  await db.insert(platformStateTable).values({ key: "demo_mode_active", value: "true" })
    .onConflictDoUpdate({ target: platformStateTable.key, set: { value: "true", updatedAt: new Date() } });
  await db.insert(platformStateTable).values({ key: "mode", value: "live" })
    .onConflictDoUpdate({ target: platformStateTable.key, set: { value: "live", updatedAt: new Date() } });
  res.json({ success: true, message: "Demo trading mode activated." });
});

router.post("/trade/stop", async (_req, res): Promise<void> => {
  for (const modeKey of ["paper_mode_active", "demo_mode_active", "real_mode_active"]) {
    await db.insert(platformStateTable).values({ key: modeKey, value: "false" })
      .onConflictDoUpdate({ target: platformStateTable.key, set: { value: "false", updatedAt: new Date() } });
  }
  await db.insert(platformStateTable).values({ key: "mode", value: "idle" })
    .onConflictDoUpdate({ target: platformStateTable.key, set: { value: "idle", updatedAt: new Date() } });
  res.json({ success: true, message: "Trading stopped. All new signals will be rejected." });
});

function serializeTrade(r: typeof tradesTable.$inferSelect) {
  return {
    id: r.id,
    brokerTradeId: r.brokerTradeId,
    symbol: r.symbol,
    strategyName: r.strategyName,
    side: r.side,
    entryTs: r.entryTs.toISOString(),
    exitTs: r.exitTs?.toISOString() ?? null,
    entryPrice: r.entryPrice,
    exitPrice: r.exitPrice,
    sl: r.sl,
    tp: r.tp,
    size: r.size,
    pnl: r.pnl,
    status: r.status,
    mode: r.mode,
    notes: r.notes,
    confidence: r.confidence,
    trailingStopPct: r.trailingStopPct,
    peakPrice: r.peakPrice,
    maxExitTs: r.maxExitTs?.toISOString() ?? null,
    exitReason: r.exitReason,
    currentPrice: r.currentPrice,
  };
}

router.get("/trade/open", async (_req, res): Promise<void> => {
  const rows = await db.select().from(tradesTable)
    .where(eq(tradesTable.status, "open"))
    .orderBy(desc(tradesTable.entryTs));
  res.json(rows.map(serializeTrade));
});

router.get("/trade/positions", async (_req, res): Promise<void> => {
  const rows = await db.select().from(tradesTable)
    .where(eq(tradesTable.status, "open"))
    .orderBy(desc(tradesTable.entryTs));

  const now = new Date();

  const positions = rows.map(r => {
    const currentPrice = r.currentPrice ?? r.entryPrice;
    const direction = r.side as "buy" | "sell";
    const floatingPnlPct = direction === "buy"
      ? (currentPrice - r.entryPrice) / r.entryPrice
      : (r.entryPrice - currentPrice) / r.entryPrice;
    const floatingPnl = floatingPnlPct * r.size;

    const maxExitTs = r.maxExitTs ?? new Date(r.entryTs.getTime() + 120 * 60 * 60 * 1000);
    const hoursRemaining = Math.max(0, (maxExitTs.getTime() - now.getTime()) / (1000 * 60 * 60));

    return {
      id: r.id,
      symbol: r.symbol,
      strategyName: r.strategyName,
      side: r.side,
      entryTs: r.entryTs.toISOString(),
      entryPrice: r.entryPrice,
      currentPrice,
      sl: r.sl,
      tp: r.tp,
      size: r.size,
      floatingPnl,
      floatingPnlPct: floatingPnlPct * 100,
      hoursRemaining: Math.round(hoursRemaining * 10) / 10,
      maxExitTs: r.maxExitTs?.toISOString() ?? null,
      peakPrice: r.peakPrice,
      confidence: r.confidence,
      mode: r.mode,
    };
  });

  res.json(positions);
});

router.get("/trade/history", async (req, res): Promise<void> => {
  const limit = Math.min(Number(req.query.limit || 50), 200);
  const filters: ReturnType<typeof eq>[] = [];
  if (req.query.symbol) filters.push(eq(tradesTable.symbol, String(req.query.symbol)));
  if (req.query.strategy) filters.push(eq(tradesTable.strategyName, String(req.query.strategy)));
  if (req.query.mode) filters.push(eq(tradesTable.mode, String(req.query.mode)));

  const rows = await db.select().from(tradesTable)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(tradesTable.entryTs))
    .limit(limit);

  res.json(rows.map(serializeTrade));
});

export default router;
