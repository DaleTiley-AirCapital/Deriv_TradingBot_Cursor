import { Router, type IRouter } from "express";
import { desc, eq, sql, and } from "drizzle-orm";
import { db, tradesTable, platformStateTable, signalLogTable } from "@workspace/db";

const router: IRouter = Router();

router.get("/portfolio/status", async (_req, res): Promise<void> => {
  const states = await db.select().from(platformStateTable);
  const stateMap: Record<string, string> = {};
  for (const s of states) stateMap[s.key] = s.value;

  const totalCapital = parseFloat(stateMap["total_capital"] || "10000");
  const openTrades = await db.select().from(tradesTable).where(eq(tradesTable.status, "open"));
  const closedTrades = await db.select().from(tradesTable).where(eq(tradesTable.status, "closed"));

  const openRisk = openTrades.reduce((sum, t) => sum + t.size * 0.015, 0);
  const realisedPnl = closedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const unrealisedPnl = openTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);

  const now = Date.now();
  const dayStart = now - 86400000;
  const weekStart = now - 604800000;
  const dailyPnl = closedTrades.filter(t => t.exitTs && t.exitTs.getTime() > dayStart).reduce((s, t) => s + (t.pnl || 0), 0);
  const weeklyPnl = closedTrades.filter(t => t.exitTs && t.exitTs.getTime() > weekStart).reduce((s, t) => s + (t.pnl || 0), 0);

  const withdrawalThreshold = parseFloat(stateMap["withdrawal_threshold"] || "15000");
  const equity = totalCapital + realisedPnl;

  res.json({
    allocationMode: stateMap["allocation_mode"] || "balanced",
    totalCapital,
    availableCapital: totalCapital - openRisk,
    openRisk,
    openTradeCount: openTrades.length,
    realisedPnl,
    unrealisedPnl,
    dailyPnl,
    weeklyPnl,
    drawdownPct: Math.min(0, (realisedPnl / totalCapital) * 100),
    withdrawalThreshold,
    suggestWithdrawal: equity >= withdrawalThreshold,
  });
});

router.post("/portfolio/mode", async (req, res): Promise<void> => {
  const { mode } = req.body ?? {};
  if (!["conservative", "balanced", "aggressive"].includes(mode)) {
    res.status(400).json({ error: "Invalid mode. Must be conservative, balanced, or aggressive." });
    return;
  }
  await db.insert(platformStateTable).values({ key: "allocation_mode", value: mode })
    .onConflictDoUpdate({ target: platformStateTable.key, set: { value: mode, updatedAt: new Date() } });
  res.json({ success: true, message: `Portfolio allocation mode set to '${mode}'` });
});

router.get("/overview", async (_req, res): Promise<void> => {
  const states = await db.select().from(platformStateTable);
  const stateMap: Record<string, string> = {};
  for (const s of states) stateMap[s.key] = s.value;

  const openTrades = await db.select().from(tradesTable).where(eq(tradesTable.status, "open"));
  const closedTrades = await db.select().from(tradesTable).where(eq(tradesTable.status, "closed"));
  const totalCapital = parseFloat(stateMap["total_capital"] || "10000");
  const openRisk = openTrades.reduce((sum, t) => sum + t.size * 0.015, 0);
  const realisedPnl = closedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const wins = closedTrades.filter(t => (t.pnl || 0) > 0).length;
  const winRate = closedTrades.length > 0 ? wins / closedTrades.length : 0;

  res.json({
    mode: stateMap["mode"] || "idle",
    openPositions: openTrades.length,
    availableCapital: totalCapital - openRisk,
    openRisk,
    modelStatus: stateMap["model_status"] || "untrained",
    lastDataSyncAt: stateMap["last_sync_at"] || null,
    totalTrades: closedTrades.length,
    winRate,
    realisedPnl,
    activeStrategies: parseInt(stateMap["active_strategies"] || "4"),
    killSwitchActive: stateMap["kill_switch"] === "true",
  });
});

export default router;
