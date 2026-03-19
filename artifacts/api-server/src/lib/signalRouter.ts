import { db, signalLogTable, platformStateTable, tradesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { SignalCandidate } from "./strategies.js";

export interface AllocationDecision {
  signal: SignalCandidate;
  allowed: boolean;
  rejectionReason: string | null;
  capitalAllocationPct: number;
  capitalAmount: number;
  aiVerdict?: string | null;
  aiReasoning?: string | null;
  aiConfidenceAdj?: number | null;
}

interface PortfolioContext {
  totalCapital: number;
  availableCapital: number;
  openRiskPct: number;
  allocationMode: "conservative" | "balanced" | "aggressive";
  killSwitchActive: boolean;
  dailyLossPct: number;
  maxDailyLossPct: number;
  maxWeeklyLossPct: number;
  weeklyLossPct: number;
  openTradeCount: number;
  maxOpenTrades: number;
  disabledStrategies: string[];
  totalDeployedCapital: number;
  equityPctPerTrade: number;
  tpMultiplierStrong: number;
  tpMultiplierMedium: number;
  tpMultiplierWeak: number;
  slRatio: number;
  trailingStopBufferPct: number;
  timeExitWindowHours: number;
}

export async function getPortfolioContext(): Promise<PortfolioContext> {
  const states = await db.select().from(platformStateTable);
  const stateMap: Record<string, string> = {};
  for (const s of states) stateMap[s.key] = s.value;

  const openTrades = await db.select().from(tradesTable).where(eq(tradesTable.status, "open"));
  const closedTrades = await db.select().from(tradesTable).where(eq(tradesTable.status, "closed"));
  const totalCapital = parseFloat(stateMap["total_capital"] || "10000");
  const totalDeployedCapital = openTrades.reduce((sum, t) => sum + t.size, 0);
  const openRisk = totalDeployedCapital;

  const now = Date.now();
  const dayStart = now - 86400000;
  const weekStart = now - 604800000;
  const dailyPnl = closedTrades.filter(t => t.exitTs && t.exitTs.getTime() > dayStart).reduce((s, t) => s + (t.pnl || 0), 0);
  const weeklyPnl = closedTrades.filter(t => t.exitTs && t.exitTs.getTime() > weekStart).reduce((s, t) => s + (t.pnl || 0), 0);
  const disabled = stateMap["disabled_strategies"] ? stateMap["disabled_strategies"].split(",").filter(Boolean) : [];

  const currentMode = stateMap["mode"] || "idle";
  const isLive = currentMode === "live";

  const modeEquityPct = isLive
    ? parseFloat(stateMap["live_equity_pct_per_trade"] || stateMap["equity_pct_per_trade"] || "2")
    : parseFloat(stateMap["paper_equity_pct_per_trade"] || stateMap["equity_pct_per_trade"] || "1");
  const modeMaxTrades = isLive
    ? parseInt(stateMap["live_max_open_trades"] || stateMap["max_open_trades"] || "3")
    : parseInt(stateMap["paper_max_open_trades"] || stateMap["max_open_trades"] || "4");

  const modeMaxDailyLoss = isLive
    ? parseFloat(stateMap["live_max_daily_loss_pct"] || stateMap["max_daily_loss_pct"] || "3")
    : parseFloat(stateMap["paper_max_daily_loss_pct"] || stateMap["max_daily_loss_pct"] || "5");
  const modeMaxWeeklyLoss = isLive
    ? parseFloat(stateMap["live_max_weekly_loss_pct"] || stateMap["max_weekly_loss_pct"] || "8")
    : parseFloat(stateMap["paper_max_weekly_loss_pct"] || stateMap["max_weekly_loss_pct"] || "12");
  const modeMaxDrawdown = isLive
    ? parseFloat(stateMap["live_max_drawdown_pct"] || stateMap["max_drawdown_pct"] || "15")
    : parseFloat(stateMap["paper_max_drawdown_pct"] || stateMap["max_drawdown_pct"] || "20");

  return {
    totalCapital,
    availableCapital: Math.max(0, totalCapital - openRisk),
    openRiskPct: (openRisk / totalCapital) * 100,
    allocationMode: (stateMap["allocation_mode"] || "balanced") as "conservative" | "balanced" | "aggressive",
    killSwitchActive: stateMap["kill_switch"] === "true",
    dailyLossPct: (dailyPnl / totalCapital) * 100,
    maxDailyLossPct: modeMaxDailyLoss,
    maxWeeklyLossPct: modeMaxWeeklyLoss,
    weeklyLossPct: (weeklyPnl / totalCapital) * 100,
    openTradeCount: openTrades.length,
    maxOpenTrades: modeMaxTrades,
    disabledStrategies: disabled,
    totalDeployedCapital,
    equityPctPerTrade: modeEquityPct,
    tpMultiplierStrong: parseFloat(stateMap["tp_multiplier_strong"] || "2.5"),
    tpMultiplierMedium: parseFloat(stateMap["tp_multiplier_medium"] || "2.0"),
    tpMultiplierWeak: parseFloat(stateMap["tp_multiplier_weak"] || "1.5"),
    slRatio: parseFloat(stateMap["sl_ratio"] || "1.0"),
    trailingStopBufferPct: parseFloat(stateMap["trailing_stop_buffer_pct"] || "0.3"),
    timeExitWindowHours: parseFloat(stateMap["time_exit_window_hours"] || "4"),
  };
}

function getAllocationPct(score: number, mode: string): number {
  const strong = score >= 0.75;
  const medium = score >= 0.65 && score < 0.75;

  switch (mode) {
    case "conservative":
      if (strong) return 0.25;
      if (medium) return 0.20;
      return 0.15;
    case "aggressive":
      if (strong) return 0.25;
      if (medium) return 0.23;
      return 0.20;
    case "balanced":
    default:
      if (strong) return 0.25;
      if (medium) return 0.22;
      return 0.20;
  }
}

export async function routeSignals(candidates: SignalCandidate[]): Promise<AllocationDecision[]> {
  const ctx = await getPortfolioContext();
  const decisions: AllocationDecision[] = [];

  const sorted = [...candidates].sort((a, b) => b.score - a.score);

  let remainingCapital = ctx.availableCapital;
  let currentOpenCount = ctx.openTradeCount;

  for (const signal of sorted) {
    let allowed = true;
    let rejectionReason: string | null = null;
    let capitalAllocationPct = 0;
    let capitalAmount = 0;

    if (ctx.killSwitchActive) {
      allowed = false;
      rejectionReason = "Kill switch is active — all trading halted";
    } else if (ctx.dailyLossPct <= -ctx.maxDailyLossPct) {
      allowed = false;
      rejectionReason = `Daily loss limit breached (${ctx.dailyLossPct.toFixed(2)}% / -${ctx.maxDailyLossPct}%)`;
    } else if (ctx.weeklyLossPct <= -ctx.maxWeeklyLossPct) {
      allowed = false;
      rejectionReason = `Weekly loss limit breached (${ctx.weeklyLossPct.toFixed(2)}% / -${ctx.maxWeeklyLossPct}%)`;
    } else if (ctx.openRiskPct > 80) {
      allowed = false;
      rejectionReason = `Max open risk exceeded (${ctx.openRiskPct.toFixed(1)}% > 80%)`;
    } else if (currentOpenCount >= ctx.maxOpenTrades) {
      allowed = false;
      rejectionReason = `Max simultaneous trades reached (${currentOpenCount}/${ctx.maxOpenTrades})`;
    } else if (ctx.disabledStrategies.includes(signal.strategyName)) {
      allowed = false;
      rejectionReason = `Strategy '${signal.strategyName}' is disabled`;
    } else if (!signal.regimeCompatible) {
      allowed = false;
      rejectionReason = `Regime mismatch for ${signal.signalType} strategy`;
    } else if (signal.score < 0.55) {
      allowed = false;
      rejectionReason = `Score below threshold (${signal.score.toFixed(2)} < 0.55)`;
    } else if (signal.expectedValue < 0.003) {
      allowed = false;
      rejectionReason = `Expected value too low (${signal.expectedValue.toFixed(4)} < 0.003)`;
    } else if (remainingCapital < ctx.totalCapital * 0.05) {
      allowed = false;
      rejectionReason = "Insufficient available capital";
    } else {
      capitalAllocationPct = getAllocationPct(signal.score, ctx.allocationMode);
      const maxPerTrade = ctx.totalCapital * (ctx.equityPctPerTrade / 100);
      capitalAmount = Math.min(
        ctx.totalCapital * capitalAllocationPct,
        maxPerTrade,
        remainingCapital
      );
      remainingCapital -= capitalAmount;
      currentOpenCount++;

      const tpMultiplier = signal.score >= 0.75
        ? ctx.tpMultiplierStrong
        : signal.score >= 0.65
          ? ctx.tpMultiplierMedium
          : ctx.tpMultiplierWeak;
      const baseTp = signal.suggestedTp ?? 0;
      const baseSl = signal.suggestedSl ?? 0;
      if (baseTp !== 0) {
        signal.suggestedTp = baseTp * (tpMultiplier / 2.0);
      }
      if (baseSl !== 0) {
        signal.suggestedSl = baseSl * ctx.slRatio;
      }
    }

    decisions.push({ signal, allowed, rejectionReason, capitalAllocationPct, capitalAmount });
  }

  return decisions;
}

export async function logSignalDecisions(decisions: AllocationDecision[]): Promise<void> {
  for (const d of decisions) {
    await db.insert(signalLogTable).values({
      ts: new Date(d.signal.timestamp),
      symbol: d.signal.symbol,
      strategyName: d.signal.strategyName,
      score: d.signal.score,
      expectedValue: d.signal.expectedValue,
      allowedFlag: d.allowed,
      rejectionReason: d.rejectionReason,
      direction: d.signal.direction,
      suggestedSl: d.signal.suggestedSl,
      suggestedTp: d.signal.suggestedTp,
      aiVerdict: d.aiVerdict ?? null,
      aiReasoning: d.aiReasoning ?? null,
      aiConfidenceAdj: d.aiConfidenceAdj ?? null,
    });
  }
}
