import { db, signalLogTable, platformStateTable, tradesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import type { SignalCandidate } from "./strategies.js";
import type { TradingMode } from "./deriv.js";
import { getModeCapitalKey, getModeCapitalDefault } from "./deriv.js";
import { getCorrelatedInstruments, classifyInstrument } from "./regimeEngine.js";

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
  maxDrawdownPct: number;
  currentDrawdownPct: number;
  openTradeCount: number;
  maxOpenTrades: number;
  disabledStrategies: string[];
  enabledStrategies: string[] | null;
  totalDeployedCapital: number;
  equityPctPerTrade: number;
  tpMultiplierStrong: number;
  tpMultiplierMedium: number;
  tpMultiplierWeak: number;
  slRatio: number;
  trailingStopPct: number;
  timeExitWindowHours: number;
  minCompositeScore: number;
  minEvThreshold: number;
  minRrRatio: number;
  correlatedFamilyCap: number;
  openTrades: { symbol: string; side: string; strategyName: string; mode: string }[];
}

function getModePrefix(mode: TradingMode): string {
  switch (mode) {
    case "paper": return "paper";
    case "demo": return "demo";
    case "real": return "real";
  }
}

export async function getPortfolioContext(mode: TradingMode): Promise<PortfolioContext> {
  const states = await db.select().from(platformStateTable);
  const stateMap: Record<string, string> = {};
  for (const s of states) stateMap[s.key] = s.value;

  const openTrades = await db.select().from(tradesTable).where(
    and(eq(tradesTable.status, "open"), eq(tradesTable.mode, mode))
  );
  const closedTrades = await db.select().from(tradesTable).where(
    and(eq(tradesTable.status, "closed"), eq(tradesTable.mode, mode))
  );

  const capitalKey = getModeCapitalKey(mode);
  const capitalDefault = getModeCapitalDefault(mode);
  const totalCapital = Math.max(1, parseFloat(stateMap[capitalKey] || stateMap["total_capital"] || capitalDefault));
  const totalDeployedCapital = openTrades.reduce((sum, t) => sum + t.size, 0);
  const openRisk = totalDeployedCapital;

  const now = Date.now();
  const dayStart = now - 86400000;
  const weekStart = now - 604800000;
  const dailyPnl = closedTrades.filter(t => t.exitTs && t.exitTs.getTime() > dayStart).reduce((s, t) => s + (t.pnl || 0), 0);
  const weeklyPnl = closedTrades.filter(t => t.exitTs && t.exitTs.getTime() > weekStart).reduce((s, t) => s + (t.pnl || 0), 0);
  const prefix = getModePrefix(mode);

  const modeEnabledStrategiesRaw = stateMap[`${prefix}_enabled_strategies`];
  const globalEnabledStrategiesRaw = stateMap["enabled_strategies"];
  const disabled = stateMap["disabled_strategies"] ? stateMap["disabled_strategies"].split(",").filter(Boolean) : [];
  const modeEnabledStrategies = modeEnabledStrategiesRaw
    ? modeEnabledStrategiesRaw.split(",").filter(Boolean)
    : globalEnabledStrategiesRaw
      ? globalEnabledStrategiesRaw.split(",").filter(Boolean)
      : null;

  const modeEquityPct = parseFloat(
    stateMap[`${prefix}_equity_pct_per_trade`] ||
    (mode === "paper" ? stateMap["paper_equity_pct_per_trade"] : stateMap["live_equity_pct_per_trade"]) ||
    stateMap["equity_pct_per_trade"] ||
    (mode === "paper" ? "13" : "22")
  );
  const modeMaxTrades = parseInt(
    stateMap[`${prefix}_max_open_trades`] ||
    (mode === "paper" ? stateMap["paper_max_open_trades"] : stateMap["live_max_open_trades"]) ||
    stateMap["max_open_trades"] ||
    (mode === "paper" ? "4" : "3")
  );

  const modeMaxDailyLoss = parseFloat(
    stateMap[`${prefix}_max_daily_loss_pct`] ||
    (mode === "paper" ? stateMap["paper_max_daily_loss_pct"] : stateMap["live_max_daily_loss_pct"]) ||
    stateMap["max_daily_loss_pct"] ||
    (mode === "paper" ? "5" : "3")
  );
  const modeMaxWeeklyLoss = parseFloat(
    stateMap[`${prefix}_max_weekly_loss_pct`] ||
    (mode === "paper" ? stateMap["paper_max_weekly_loss_pct"] : stateMap["live_max_weekly_loss_pct"]) ||
    stateMap["max_weekly_loss_pct"] ||
    (mode === "paper" ? "12" : "8")
  );

  const modeAllocation = (stateMap[`${prefix}_allocation_mode`] || stateMap["allocation_mode"] || "balanced") as "conservative" | "balanced" | "aggressive";

  const modeMaxDrawdown = parseFloat(
    stateMap[`${prefix}_max_drawdown_pct`] ||
    stateMap["max_drawdown_pct"] ||
    (mode === "paper" ? "20" : "15")
  );
  const startCapitalKey = `${prefix}_extraction_start_capital`;
  const startCapital = parseFloat(stateMap[startCapitalKey] || stateMap[capitalKey] || capitalDefault);
  const peakCapital = Math.max(startCapital, totalCapital);
  const currentDrawdownPct = peakCapital > 0 ? ((peakCapital - totalCapital) / peakCapital) * 100 : 0;

  const correlatedFamilyCap = parseInt(
    stateMap[`${prefix}_correlated_family_cap`] ||
    stateMap["correlated_family_cap"] ||
    "3"
  );

  return {
    totalCapital,
    availableCapital: Math.max(0, totalCapital - openRisk),
    openRiskPct: (openRisk / totalCapital) * 100,
    allocationMode: modeAllocation,
    killSwitchActive: stateMap["kill_switch"] === "true",
    dailyLossPct: (dailyPnl / totalCapital) * 100,
    maxDailyLossPct: modeMaxDailyLoss,
    maxWeeklyLossPct: modeMaxWeeklyLoss,
    weeklyLossPct: (weeklyPnl / totalCapital) * 100,
    maxDrawdownPct: modeMaxDrawdown,
    currentDrawdownPct,
    openTradeCount: openTrades.length,
    maxOpenTrades: modeMaxTrades,
    disabledStrategies: disabled,
    enabledStrategies: modeEnabledStrategies,
    totalDeployedCapital,
    equityPctPerTrade: modeEquityPct,
    tpMultiplierStrong: parseFloat(stateMap[`${prefix}_tp_multiplier_strong`] || stateMap["tp_multiplier_strong"] || "2.5"),
    tpMultiplierMedium: parseFloat(stateMap[`${prefix}_tp_multiplier_medium`] || stateMap["tp_multiplier_medium"] || "2.0"),
    tpMultiplierWeak: parseFloat(stateMap[`${prefix}_tp_multiplier_weak`] || stateMap["tp_multiplier_weak"] || "1.5"),
    slRatio: parseFloat(stateMap[`${prefix}_sl_ratio`] || stateMap["sl_ratio"] || "1.0"),
    trailingStopPct: parseFloat(stateMap[`${prefix}_trailing_stop_pct`] || stateMap["trailing_stop_pct"] || "25"),
    timeExitWindowHours: parseFloat(stateMap[`${prefix}_time_exit_window_hours`] || stateMap["time_exit_window_hours"] || "72"),
    minCompositeScore: parseFloat(stateMap["min_composite_score"] || "85"),
    minEvThreshold: parseFloat(stateMap["min_ev_threshold"] || "0.003"),
    minRrRatio: parseFloat(stateMap["min_rr_ratio"] || "1.5"),
    correlatedFamilyCap,
    openTrades: openTrades.map(t => ({
      symbol: t.symbol,
      side: t.side,
      strategyName: t.strategyName,
      mode: t.mode,
    })),
  };
}

function getAllocationPctByScore(compositeScore: number): { pct: number; tier: string } {
  if (compositeScore >= 90) return { pct: 0.25, tier: "high" };
  if (compositeScore >= 85) return { pct: 0.20, tier: "medium" };
  return { pct: 0, tier: "reject" };
}

function checkConflicts(
  signal: SignalCandidate,
  openTrades: { symbol: string; side: string; strategyName: string }[],
  alreadyAllowed: SignalCandidate[],
): { blocked: boolean; reason: string | null } {
  const existingOnSymbol = openTrades.filter(t => t.symbol === signal.symbol);
  const pendingOnSymbol = alreadyAllowed.filter(s => s.symbol === signal.symbol);
  const allOnSymbol = [...existingOnSymbol, ...pendingOnSymbol.map(s => ({ symbol: s.symbol, side: s.direction, strategyName: s.strategyName }))];

  for (const existing of allOnSymbol) {
    if (existing.side !== signal.direction) {
      return { blocked: true, reason: `Opposing direction on ${signal.symbol}: existing ${existing.side} vs new ${signal.direction}` };
    }
  }

  const sameFamily = allOnSymbol.filter(t => {
    const family = (signal as any).strategyFamily;
    return family && t.strategyName.includes(family.replace("_", "-"));
  });
  if (sameFamily.length >= 2) {
    return { blocked: true, reason: `Too many entries from same family on ${signal.symbol}` };
  }

  return { blocked: false, reason: null };
}

function checkCorrelationExposure(
  signal: SignalCandidate,
  openTrades: { symbol: string; side: string }[],
  alreadyAllowed: SignalCandidate[],
  cap: number = 3,
): { blocked: boolean; reason: string | null } {
  const correlated = getCorrelatedInstruments(signal.symbol);
  const signalFamily = classifyInstrument(signal.symbol);

  const allActive = [
    ...openTrades.map(t => ({ symbol: t.symbol, side: t.side })),
    ...alreadyAllowed.map(s => ({ symbol: s.symbol, side: s.direction })),
  ];

  let familyExposure = 0;
  for (const active of allActive) {
    if (correlated.includes(active.symbol) || classifyInstrument(active.symbol) === signalFamily) {
      familyExposure++;
    }
  }

  if (familyExposure >= cap) {
    return { blocked: true, reason: `Max correlated exposure (${familyExposure} positions in ${signalFamily} family, cap=${cap})` };
  }

  return { blocked: false, reason: null };
}

function rankCandidates(candidates: SignalCandidate[]): SignalCandidate[] {
  return [...candidates].sort((a, b) => {
    const scoreWeight = 0.50;
    const evWeight = 0.30;
    const regimeWeight = 0.20;

    const aRank = a.compositeScore * scoreWeight +
      (a.expectedValue * 10000) * evWeight +
      ((a as any).regimeConfidence ?? 0.5) * 100 * regimeWeight;

    const bRank = b.compositeScore * scoreWeight +
      (b.expectedValue * 10000) * evWeight +
      ((b as any).regimeConfidence ?? 0.5) * 100 * regimeWeight;

    return bRank - aRank;
  });
}

export async function routeSignals(candidates: SignalCandidate[], tradingMode: TradingMode): Promise<AllocationDecision[]> {
  const ctx = await getPortfolioContext(tradingMode);
  const decisions: AllocationDecision[] = [];

  const ranked = rankCandidates(candidates);

  let remainingCapital = ctx.availableCapital;
  let currentOpenCount = ctx.openTradeCount;
  const allowedSignals: SignalCandidate[] = [];

  for (const signal of ranked) {
    let allowed = true;
    let rejectionReason: string | null = null;
    let capitalAllocationPct = 0;
    let capitalAmount = 0;

    const tp = Math.abs(signal.suggestedTp ?? 0);
    const sl = Math.abs(signal.suggestedSl ?? 0);
    const rrRatio = sl > 0 ? tp / sl : 0;

    if (ctx.killSwitchActive) {
      allowed = false;
      rejectionReason = "Kill switch is active — all trading halted";
    } else if (ctx.dailyLossPct <= -ctx.maxDailyLossPct) {
      allowed = false;
      rejectionReason = `Daily loss limit breached (${ctx.dailyLossPct.toFixed(2)}% / -${ctx.maxDailyLossPct}%)`;
    } else if (ctx.weeklyLossPct <= -ctx.maxWeeklyLossPct) {
      allowed = false;
      rejectionReason = `Weekly loss limit breached (${ctx.weeklyLossPct.toFixed(2)}% / -${ctx.maxWeeklyLossPct}%)`;
    } else if (ctx.currentDrawdownPct >= ctx.maxDrawdownPct) {
      allowed = false;
      rejectionReason = `Max drawdown breached (${ctx.currentDrawdownPct.toFixed(2)}% / ${ctx.maxDrawdownPct}%) — kill switch territory`;
    } else if (ctx.openRiskPct > 80) {
      allowed = false;
      rejectionReason = `Max open risk exceeded (${ctx.openRiskPct.toFixed(1)}% > 80%)`;
    } else if (currentOpenCount >= ctx.maxOpenTrades) {
      allowed = false;
      rejectionReason = `Max simultaneous trades reached (${currentOpenCount}/${ctx.maxOpenTrades})`;
    } else if (ctx.disabledStrategies.includes(signal.strategyName)) {
      allowed = false;
      rejectionReason = `Strategy '${signal.strategyName}' is disabled`;
    } else if (ctx.enabledStrategies && !ctx.enabledStrategies.includes(signal.strategyName)) {
      allowed = false;
      rejectionReason = `Strategy '${signal.strategyName}' is not enabled for this mode`;
    } else if (!signal.regimeCompatible) {
      allowed = false;
      rejectionReason = `Regime mismatch for ${signal.signalType} strategy`;
    } else if (signal.compositeScore < ctx.minCompositeScore) {
      allowed = false;
      rejectionReason = `Composite score below threshold (${signal.compositeScore} < ${ctx.minCompositeScore})`;
    } else if (signal.expectedValue < ctx.minEvThreshold) {
      allowed = false;
      rejectionReason = `Expected value too low (${signal.expectedValue.toFixed(4)} < ${ctx.minEvThreshold})`;
    } else if (sl <= 0 || tp <= 0) {
      allowed = false;
      rejectionReason = `Invalid SL/TP values`;
    } else if (rrRatio < ctx.minRrRatio) {
      allowed = false;
      rejectionReason = `Reward/risk too low (${rrRatio.toFixed(2)} < ${ctx.minRrRatio})`;
    } else if (remainingCapital < ctx.totalCapital * 0.05) {
      allowed = false;
      rejectionReason = "Insufficient available capital";
    }

    if (allowed) {
      const conflictCheck = checkConflicts(signal, ctx.openTrades, allowedSignals);
      if (conflictCheck.blocked) {
        allowed = false;
        rejectionReason = conflictCheck.reason;
      }
    }

    if (allowed) {
      const corrCheck = checkCorrelationExposure(signal, ctx.openTrades, allowedSignals, ctx.correlatedFamilyCap);
      if (corrCheck.blocked) {
        allowed = false;
        rejectionReason = corrCheck.reason;
      }
    }

    if (allowed) {
      const { pct, tier } = getAllocationPctByScore(signal.compositeScore);
      if (tier === "reject") {
        allowed = false;
        rejectionReason = `Score ${signal.compositeScore} below 85 allocation threshold`;
      } else {
        capitalAllocationPct = pct;
        const maxPerTrade = ctx.totalCapital * (ctx.equityPctPerTrade / 100);
        capitalAmount = Math.min(
          ctx.totalCapital * capitalAllocationPct,
          maxPerTrade,
          remainingCapital
        );
        remainingCapital -= capitalAmount;
        currentOpenCount++;
        allowedSignals.push(signal);

        const tpMultiplier = signal.compositeScore >= 92
          ? ctx.tpMultiplierStrong
          : signal.compositeScore >= 85
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
      compositeScore: d.signal.compositeScore,
      scoringDimensions: d.signal.dimensions,
    });
  }
}
