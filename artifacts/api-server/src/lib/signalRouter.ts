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
    stateMap["equity_pct_per_trade"] ||
    (mode === "paper" ? "13" : "22")
  );
  const modeMaxTrades = parseInt(
    stateMap[`${prefix}_max_open_trades`] ||
    stateMap["max_open_trades"] ||
    (mode === "paper" ? "4" : "3")
  );

  const modeMaxDailyLoss = parseFloat(
    stateMap[`${prefix}_max_daily_loss_pct`] ||
    stateMap["max_daily_loss_pct"] ||
    (mode === "paper" ? "5" : "3")
  );
  const modeMaxWeeklyLoss = parseFloat(
    stateMap[`${prefix}_max_weekly_loss_pct`] ||
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
    minCompositeScore: parseFloat(
      stateMap[`${prefix}_min_composite_score`] ||
      stateMap["min_composite_score"] ||
      (mode === "paper" ? "80" : mode === "demo" ? "85" : "90")
    ),
    minEvThreshold: parseFloat(stateMap[`${prefix}_min_ev_threshold`] || stateMap["min_ev_threshold"] || "0.003"),
    minRrRatio: parseFloat(stateMap[`${prefix}_min_rr_ratio`] || stateMap["min_rr_ratio"] || "3.0"),
    correlatedFamilyCap,
    openTrades: openTrades.map(t => ({
      symbol: t.symbol,
      side: t.side,
      strategyName: t.strategyName,
      mode: t.mode,
    })),
  };
}

function getAllocationPctByScore(compositeScore: number, baseEquityPct: number, modeMinScore: number): { pct: number; tier: string } {
  const basePct = baseEquityPct / 100;
  if (compositeScore >= modeMinScore + 10) return { pct: basePct + 0.06, tier: "large" };
  if (compositeScore >= modeMinScore + 5) return { pct: basePct + 0.03, tier: "medium" };
  if (compositeScore >= modeMinScore) return { pct: basePct, tier: "base" };
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

  if (allOnSymbol.length > 0) {
    return { blocked: true, reason: `Already has position on ${signal.symbol}` };
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
      (a.regimeConfidence ?? 0.5) * 100 * regimeWeight;

    const bRank = b.compositeScore * scoreWeight +
      (b.expectedValue * 10000) * evWeight +
      (b.regimeConfidence ?? 0.5) * 100 * regimeWeight;

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
    } else if (remainingCapital < ctx.totalCapital * 0.05) {
      allowed = false;
      rejectionReason = "Insufficient available capital";
    }

    if (allowed && ctx.minRrRatio > 0 && signal.currentPrice > 0) {
      const isBuy = signal.direction === "buy";
      const price = signal.currentPrice;
      const tpCands = [signal.swingHigh, signal.bbUpper, ...(signal.fibExtensionLevels ?? [])].filter(l => l > 0 && (isBuy ? l > price : l < price));
      const slCands = [signal.swingLow, signal.bbLower, ...(signal.fibRetraceLevels ?? [])].filter(l => l > 0 && (isBuy ? l < price : l > price));
      const nearTp = tpCands.length > 0 ? tpCands.reduce((b, l) => Math.abs(l - price) < Math.abs(b - price) ? l : b) : null;
      const nearSl = slCands.length > 0 ? slCands.reduce((b, l) => Math.abs(l - price) < Math.abs(b - price) ? l : b) : null;
      if (nearTp && nearSl && Math.abs(nearSl - price) > 0) {
        const signalRr = Math.abs(nearTp - price) / Math.abs(nearSl - price);
        if (signalRr < ctx.minRrRatio) {
          allowed = false;
          rejectionReason = `R:R ratio too low (${signalRr.toFixed(2)} < ${ctx.minRrRatio})`;
        }
      }
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
      const allocationMultiplier = ctx.allocationMode === "conservative" ? 0.7
        : ctx.allocationMode === "aggressive" ? 1.3
        : 1.0;
      const adjustedEquityPct = ctx.equityPctPerTrade * allocationMultiplier;
      const { pct, tier } = getAllocationPctByScore(signal.compositeScore, adjustedEquityPct, ctx.minCompositeScore);
      if (tier === "reject") {
        allowed = false;
        rejectionReason = `Score ${signal.compositeScore} below ${ctx.minCompositeScore} allocation threshold`;
      } else {
        capitalAllocationPct = pct;
        capitalAmount = Math.min(
          ctx.totalCapital * capitalAllocationPct,
          remainingCapital
        );
        remainingCapital -= capitalAmount;
        currentOpenCount++;
        allowedSignals.push(signal);
      }
    }

    decisions.push({ signal, allowed, rejectionReason, capitalAllocationPct, capitalAmount });
  }

  return decisions;
}

export async function logSignalDecisions(decisions: AllocationDecision[], tradingMode?: TradingMode): Promise<void> {
  for (const d of decisions) {
    try {
      const sig = d.signal as any;
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
        mode: tradingMode ?? null,
        regime: sig.regimeState ?? null,
        regimeConfidence: sig.regimeConfidence ?? null,
        strategyFamily: sig.strategyFamily ?? null,
        subStrategy: sig.strategyName ?? null,
        allocationPct: d.capitalAllocationPct > 0 ? d.capitalAllocationPct * 100 : null,
        executionStatus: d.allowed ? "approved" : "blocked",
      });
    } catch (err) {
      console.error(`[SignalLog] INSERT failed for ${d.signal.symbol}/${d.signal.strategyName}:`, err instanceof Error ? err.message : err);
    }
  }
}
