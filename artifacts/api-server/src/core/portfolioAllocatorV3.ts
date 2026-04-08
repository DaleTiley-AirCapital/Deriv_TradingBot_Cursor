/**
 * V3 Portfolio Allocator
 *
 * Engine-aware allocation. Consumes CoordinatorOutput from the symbol coordinator.
 * Applies risk rules, enforces mode separation, and sizes using engine confidence
 * and projected move.
 *
 * Does NOT consume legacy family-based signals. If a caller passes a V2 signal,
 * it will fail the engine name check.
 */
import { db, platformStateTable, tradesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import type { CoordinatorOutput } from "./engineTypes.js";
import type { TradingMode } from "../infrastructure/deriv.js";
import { getModeCapitalKey, getModeCapitalDefault } from "../infrastructure/deriv.js";

export interface V3AllocationDecision {
  coordinatorOutput: CoordinatorOutput;
  allowed: boolean;
  rejectionReason: string | null;
  capitalAmount: number;
  capitalAllocationPct: number;
  mode: TradingMode;
  engineName: string;
  direction: "buy" | "sell";
  confidence: number;
  projectedMovePct: number;
}

function getModePrefix(mode: TradingMode): string {
  return mode === "real" ? "real" : mode === "demo" ? "demo" : "paper";
}

export async function allocateV3Signal(
  coordinatorOutput: CoordinatorOutput,
  mode: TradingMode,
  stateMap: Record<string, string>,
): Promise<V3AllocationDecision> {
  const { winner, symbol } = coordinatorOutput;
  const prefix = getModePrefix(mode);

  const base: Omit<V3AllocationDecision, "allowed" | "rejectionReason" | "capitalAmount" | "capitalAllocationPct"> = {
    coordinatorOutput,
    mode,
    engineName: winner.engineName,
    direction: winner.direction,
    confidence: winner.confidence,
    projectedMovePct: winner.projectedMovePct,
  };

  const deny = (reason: string): V3AllocationDecision => ({
    ...base, allowed: false, rejectionReason: reason, capitalAmount: 0, capitalAllocationPct: 0,
  });

  // Kill switch
  if (stateMap["kill_switch"] === "true") return deny("kill_switch_active");

  // Mode-level enabled check
  const modeEnabled = stateMap[`${prefix}_mode`] === "active" || stateMap[`${prefix}_enabled`] === "true";
  if (!modeEnabled) return deny(`mode_${mode}_not_active`);

  // Symbol-level check
  const modeSymbolsRaw = stateMap[`${prefix}_enabled_symbols`] || stateMap["enabled_symbols"] || "";
  const modeSymbols = modeSymbolsRaw ? modeSymbolsRaw.split(",").map(s => s.trim()).filter(Boolean) : null;
  if (modeSymbols && !modeSymbols.includes(symbol)) {
    return deny(`symbol_${symbol}_not_enabled_for_${mode}`);
  }

  // Capital
  const capitalKey = getModeCapitalKey(mode);
  const capitalDefault = getModeCapitalDefault(mode);
  const totalCapital = Math.max(1, parseFloat(stateMap[capitalKey] || stateMap["total_capital"] || capitalDefault));

  // Open trades
  const openTrades = await db.select().from(tradesTable)
    .where(and(eq(tradesTable.status, "open"), eq(tradesTable.mode, mode)));

  const maxOpenTrades = parseInt(stateMap[`${prefix}_max_open_trades`] || stateMap["max_open_trades"] || "3");
  if (openTrades.length >= maxOpenTrades) return deny(`max_open_trades_reached:${openTrades.length}/${maxOpenTrades}`);

  // No duplicate symbol+direction
  const existingForSymbol = openTrades.filter(t => t.symbol === symbol);
  if (existingForSymbol.length > 0) return deny(`symbol_already_has_open_position:${symbol}`);

  // Risk guards
  const closedTrades = await db.select().from(tradesTable)
    .where(and(eq(tradesTable.status, "closed"), eq(tradesTable.mode, mode)));

  const now = Date.now();
  const dayStart = now - 86400000;
  const weekStart = now - 604800000;

  const dailyPnl = closedTrades
    .filter(t => t.exitTs && new Date(t.exitTs).getTime() > dayStart)
    .reduce((s, t) => s + (t.pnl ?? 0), 0);
  const weeklyPnl = closedTrades
    .filter(t => t.exitTs && new Date(t.exitTs).getTime() > weekStart)
    .reduce((s, t) => s + (t.pnl ?? 0), 0);

  const maxDailyLossPct  = parseFloat(stateMap[`${prefix}_max_daily_loss_pct`] || stateMap["max_daily_loss_pct"] || "5") / 100;
  const maxWeeklyLossPct = parseFloat(stateMap[`${prefix}_max_weekly_loss_pct`] || stateMap["max_weekly_loss_pct"] || "10") / 100;
  const maxDrawdownPct   = parseFloat(stateMap[`${prefix}_max_drawdown_pct`] || stateMap["max_drawdown_pct"] || "15") / 100;

  if (dailyPnl < 0 && Math.abs(dailyPnl) / totalCapital >= maxDailyLossPct) {
    return deny(`daily_loss_limit_reached:${(Math.abs(dailyPnl) / totalCapital * 100).toFixed(1)}%`);
  }
  if (weeklyPnl < 0 && Math.abs(weeklyPnl) / totalCapital >= maxWeeklyLossPct) {
    return deny(`weekly_loss_limit_reached`);
  }

  // All open trade PnL for drawdown
  const unrealisedPnl = openTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const totalPnl = dailyPnl + unrealisedPnl;
  if (totalPnl < 0 && Math.abs(totalPnl) / totalCapital >= maxDrawdownPct) {
    return deny("max_drawdown_reached");
  }

  // ── Minimum confidence gate ────────────────────────────────────────────────
  // Use mode min_composite_score as confidence floor (mapped to 0-1)
  const minScore = parseFloat(stateMap[`${prefix}_min_composite_score`] || stateMap["min_composite_score"] || "80");
  const minConfidence = minScore / 100;
  if (winner.confidence < minConfidence) {
    return deny(`confidence_below_threshold:${winner.confidence.toFixed(3)}<${minConfidence.toFixed(3)}`);
  }

  // ── Capital sizing ─────────────────────────────────────────────────────────
  // Base on equity_pct_per_trade, scaled by engine confidence
  const equityPctPerTrade = parseFloat(stateMap[`${prefix}_equity_pct_per_trade`] || stateMap["equity_pct_per_trade"] || "15");
  const deployedCapital   = openTrades.reduce((s, t) => s + t.size, 0);
  const maxDeployable     = totalCapital * 0.80;
  const remaining         = maxDeployable - deployedCapital;

  if (remaining <= 0) return deny("80pct_equity_cap_reached");

  const confidenceScale = Math.max(0.60, Math.min(1.0, winner.confidence));
  let size = totalCapital * (equityPctPerTrade / 100) * confidenceScale;
  size = Math.min(size, remaining);
  size = Math.max(size, totalCapital * 0.05);

  if (size > remaining) return deny("insufficient_remaining_capacity");

  const capitalAllocationPct = (size / totalCapital) * 100;

  return {
    ...base,
    allowed: true,
    rejectionReason: null,
    capitalAmount: size,
    capitalAllocationPct,
  };
}
