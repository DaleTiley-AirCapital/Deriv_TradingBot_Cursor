import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, tradesTable, platformStateTable } from "@workspace/db";

const router: IRouter = Router();

router.get("/risk/status", async (_req, res): Promise<void> => {
  const states = await db.select().from(platformStateTable);
  const stateMap: Record<string, string> = {};
  for (const s of states) stateMap[s.key] = s.value;

  const totalCapital = parseFloat(stateMap["total_capital"] || "1000");
  const closedTrades = await db.select().from(tradesTable).where(eq(tradesTable.status, "closed"));
  const openTrades = await db.select().from(tradesTable).where(eq(tradesTable.status, "open"));

  const now = Date.now();
  const dayStart = now - 86400000;
  const weekStart = now - 604800000;

  const dailyPnl = closedTrades.filter(t => t.exitTs && t.exitTs.getTime() > dayStart).reduce((s, t) => s + (t.pnl || 0), 0);
  const weeklyPnl = closedTrades.filter(t => t.exitTs && t.exitTs.getTime() > weekStart).reduce((s, t) => s + (t.pnl || 0), 0);
  const allPnl = closedTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const openRisk = openTrades.reduce((sum, t) => sum + t.size * 0.015, 0);

  const currentMode = stateMap["mode"] || "idle";
  const isLive = currentMode === "live";
  const maxDailyLossPct = isLive
    ? parseFloat(stateMap["live_max_daily_loss_pct"] || stateMap["max_daily_loss_pct"] || "3")
    : parseFloat(stateMap["paper_max_daily_loss_pct"] || stateMap["max_daily_loss_pct"] || "5");
  const maxWeeklyLossPct = isLive
    ? parseFloat(stateMap["live_max_weekly_loss_pct"] || stateMap["max_weekly_loss_pct"] || "8")
    : parseFloat(stateMap["paper_max_weekly_loss_pct"] || stateMap["max_weekly_loss_pct"] || "12");
  const maxDrawdownPct = isLive
    ? parseFloat(stateMap["live_max_drawdown_pct"] || stateMap["max_drawdown_pct"] || "15")
    : parseFloat(stateMap["paper_max_drawdown_pct"] || stateMap["max_drawdown_pct"] || "20");

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
    activeCooldowns: cooldowns,
    disabledStrategies,
    openRiskPct,
  });
});

router.post("/risk/kill-switch", async (_req, res): Promise<void> => {
  await db.insert(platformStateTable).values({ key: "kill_switch", value: "true" })
    .onConflictDoUpdate({ target: platformStateTable.key, set: { value: "true", updatedAt: new Date() } });
  await db.insert(platformStateTable).values({ key: "mode", value: "idle" })
    .onConflictDoUpdate({ target: platformStateTable.key, set: { value: "idle", updatedAt: new Date() } });
  res.json({ success: true, message: "Kill switch activated. All trading halted. Manual reset required." });
});

export default router;
