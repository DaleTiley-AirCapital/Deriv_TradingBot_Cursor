import { Router, type IRouter } from "express";
import { desc, eq, sql, and } from "drizzle-orm";
import { db, tradesTable, platformStateTable, signalLogTable } from "@workspace/db";
import { getActiveModes, getModeCapitalKey, getModeCapitalDefault } from "../lib/deriv.js";
import type { TradingMode } from "../lib/deriv.js";

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

  const activeModes = getActiveModes(stateMap);
  const legacyMode = stateMap["mode"] || "idle";

  const perMode: Record<string, {
    capital: number;
    openPositions: number;
    realisedPnl: number;
    winRate: number;
    totalTrades: number;
    active: boolean;
  }> = {};

  for (const mode of ["paper", "demo", "real"] as TradingMode[]) {
    const modeOpen = openTrades.filter(t => t.mode === mode);
    const modeClosed = closedTrades.filter(t => t.mode === mode);
    const modeWins = modeClosed.filter(t => (t.pnl || 0) > 0).length;
    const capitalKey = getModeCapitalKey(mode);
    const capitalDefault = getModeCapitalDefault(mode);

    perMode[mode] = {
      capital: parseFloat(stateMap[capitalKey] || stateMap["total_capital"] || capitalDefault),
      openPositions: modeOpen.length,
      realisedPnl: modeClosed.reduce((sum, t) => sum + (t.pnl || 0), 0),
      winRate: modeClosed.length > 0 ? modeWins / modeClosed.length : 0,
      totalTrades: modeClosed.length,
      active: activeModes.includes(mode),
    };
  }

  let effectiveMode = legacyMode;
  if (activeModes.length > 0) {
    effectiveMode = activeModes.length === 1 ? activeModes[0] : "multi";
  }

  res.json({
    mode: effectiveMode,
    activeModes,
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
    perMode,
    paperModeActive: stateMap["paper_mode_active"] === "true",
    demoModeActive: stateMap["demo_mode_active"] === "true",
    realModeActive: stateMap["real_mode_active"] === "true",
  });
});

export default router;
