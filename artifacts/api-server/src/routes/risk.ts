import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, tradesTable, platformStateTable } from "@workspace/db";
import { getActiveModes, getModeCapitalKey, getModeCapitalDefault } from "../lib/deriv.js";
import type { TradingMode } from "../lib/deriv.js";

const router: IRouter = Router();

function computeRiskForMode(
  mode: TradingMode,
  stateMap: Record<string, string>,
  openTrades: (typeof tradesTable.$inferSelect)[],
  closedTrades: (typeof tradesTable.$inferSelect)[],
) {
  const capitalKey = getModeCapitalKey(mode);
  const capitalDefault = getModeCapitalDefault(mode);
  const totalCapital = parseFloat(stateMap[capitalKey] || stateMap["total_capital"] || capitalDefault);

  const modeOpen = openTrades.filter(t => t.mode === mode);
  const modeClosed = closedTrades.filter(t => t.mode === mode);

  const now = Date.now();
  const dayStart = now - 86400000;
  const weekStart = now - 604800000;

  const dailyPnl = modeClosed.filter(t => t.exitTs && t.exitTs.getTime() > dayStart).reduce((s, t) => s + (t.pnl || 0), 0);
  const weeklyPnl = modeClosed.filter(t => t.exitTs && t.exitTs.getTime() > weekStart).reduce((s, t) => s + (t.pnl || 0), 0);
  const allPnl = modeClosed.reduce((s, t) => s + (t.pnl || 0), 0);
  const openRisk = modeOpen.reduce((sum, t) => sum + t.size * 0.015, 0);

  const prefix = mode === "paper" ? "paper" : mode === "demo" ? "demo" : "real";
  const maxDailyLossPct = parseFloat(
    stateMap[`${prefix}_max_daily_loss_pct`] ||
    (mode === "paper" ? stateMap["paper_max_daily_loss_pct"] : stateMap["live_max_daily_loss_pct"]) ||
    stateMap["max_daily_loss_pct"] || (mode === "paper" ? "5" : "3")
  );
  const maxWeeklyLossPct = parseFloat(
    stateMap[`${prefix}_max_weekly_loss_pct`] ||
    (mode === "paper" ? stateMap["paper_max_weekly_loss_pct"] : stateMap["live_max_weekly_loss_pct"]) ||
    stateMap["max_weekly_loss_pct"] || (mode === "paper" ? "12" : "8")
  );
  const maxDrawdownPct = parseFloat(
    stateMap[`${prefix}_max_drawdown_pct`] ||
    (mode === "paper" ? stateMap["paper_max_drawdown_pct"] : stateMap["live_max_drawdown_pct"]) ||
    stateMap["max_drawdown_pct"] || (mode === "paper" ? "20" : "15")
  );

  const dailyLossPct = (dailyPnl / totalCapital) * 100;
  const weeklyLossPct = (weeklyPnl / totalCapital) * 100;
  const drawdownPct = Math.min(0, (allPnl / totalCapital) * 100);
  const openRiskPct = (openRisk / totalCapital) * 100;

  return {
    mode,
    totalCapital,
    dailyLossBreached: dailyLossPct <= -maxDailyLossPct,
    weeklyLossBreached: weeklyLossPct <= -maxWeeklyLossPct,
    maxDrawdownBreached: drawdownPct <= -maxDrawdownPct,
    dailyLossPct,
    weeklyLossPct,
    drawdownPct,
    maxDailyLossPct,
    maxWeeklyLossPct,
    maxDrawdownPct,
    openRiskPct,
    openTradeCount: modeOpen.length,
    realisedPnl: allPnl,
  };
}

router.get("/risk/status", async (_req, res): Promise<void> => {
  const states = await db.select().from(platformStateTable);
  const stateMap: Record<string, string> = {};
  for (const s of states) stateMap[s.key] = s.value;

  const openTrades = await db.select().from(tradesTable).where(eq(tradesTable.status, "open"));
  const closedTrades = await db.select().from(tradesTable).where(eq(tradesTable.status, "closed"));

  const activeModes = getActiveModes(stateMap);
  const allModes: TradingMode[] = ["paper", "demo", "real"];

  const perMode: Record<string, ReturnType<typeof computeRiskForMode>> = {};
  for (const mode of allModes) {
    perMode[mode] = computeRiskForMode(mode, stateMap, openTrades, closedTrades);
  }

  const totalCapital = parseFloat(stateMap["total_capital"] || "10000");
  const now = Date.now();
  const dayStart = now - 86400000;
  const weekStart = now - 604800000;
  const dailyPnl = closedTrades.filter(t => t.exitTs && t.exitTs.getTime() > dayStart).reduce((s, t) => s + (t.pnl || 0), 0);
  const weeklyPnl = closedTrades.filter(t => t.exitTs && t.exitTs.getTime() > weekStart).reduce((s, t) => s + (t.pnl || 0), 0);
  const allPnl = closedTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const openRisk = openTrades.reduce((sum, t) => sum + t.size * 0.015, 0);

  const maxDailyLossPct = parseFloat(stateMap["max_daily_loss_pct"] || "3");
  const maxWeeklyLossPct = parseFloat(stateMap["max_weekly_loss_pct"] || "8");
  const maxDrawdownPct = parseFloat(stateMap["max_drawdown_pct"] || "15");

  const dailyLossPct = (dailyPnl / totalCapital) * 100;
  const weeklyLossPct = (weeklyPnl / totalCapital) * 100;
  const drawdownPct = Math.min(0, (allPnl / totalCapital) * 100);
  const openRiskPct = (openRisk / totalCapital) * 100;

  const cooldowns = stateMap["cooldowns"] ? stateMap["cooldowns"].split(",").filter(Boolean) : [];
  const disabledStrategies = stateMap["disabled_strategies"] ? stateMap["disabled_strategies"].split(",").filter(Boolean) : [];

  res.json({
    killSwitchActive: stateMap["kill_switch"] === "true",
    dailyLossBreached: dailyLossPct <= -maxDailyLossPct,
    weeklyLossBreached: weeklyLossPct <= -maxWeeklyLossPct,
    maxDrawdownBreached: drawdownPct <= -maxDrawdownPct,
    dailyLossPct,
    weeklyLossPct,
    drawdownPct,
    maxDailyLossPct,
    maxWeeklyLossPct,
    maxDrawdownPct,
    activeCooldowns: cooldowns,
    disabledStrategies,
    openRiskPct,
    perMode,
    activeModes,
  });
});

router.post("/risk/kill-switch", async (_req, res): Promise<void> => {
  await db.insert(platformStateTable).values({ key: "kill_switch", value: "true" })
    .onConflictDoUpdate({ target: platformStateTable.key, set: { value: "true", updatedAt: new Date() } });
  for (const modeKey of ["paper_mode_active", "demo_mode_active", "real_mode_active"]) {
    await db.insert(platformStateTable).values({ key: modeKey, value: "false" })
      .onConflictDoUpdate({ target: platformStateTable.key, set: { value: "false", updatedAt: new Date() } });
  }
  await db.insert(platformStateTable).values({ key: "mode", value: "idle" })
    .onConflictDoUpdate({ target: platformStateTable.key, set: { value: "idle", updatedAt: new Date() } });
  res.json({ success: true, message: "Kill switch activated. All trading halted. Manual reset required." });
});

export default router;
