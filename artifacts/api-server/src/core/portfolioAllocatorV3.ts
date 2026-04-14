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
import { evaluateSignalAdmission, MODE_SCORE_GATES } from "./allocatorCore.js";

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

  // ── Stage 1: Fetch all portfolio state from DB ────────────────────────────
  const modeEnabled =
    stateMap[`${prefix}_mode_active`] === "true" ||
    stateMap[`${prefix}_mode`] === "active" ||
    stateMap[`${prefix}_enabled`] === "true";

  const modeSymbolsRaw = stateMap[`${prefix}_enabled_symbols`] || stateMap["enabled_symbols"] || "";
  const modeSymbols = modeSymbolsRaw ? modeSymbolsRaw.split(",").map(s => s.trim()).filter(Boolean) : null;
  const symbolEnabled = !modeSymbols || modeSymbols.includes(symbol);

  const capitalKey = getModeCapitalKey(mode);
  const capitalDefault = getModeCapitalDefault(mode);
  const totalCapital = Math.max(1, parseFloat(stateMap[capitalKey] || stateMap["total_capital"] || capitalDefault));

  const openTrades = await db.select().from(tradesTable)
    .where(and(eq(tradesTable.status, "open"), eq(tradesTable.mode, mode)));
  const maxOpenTrades = parseInt(stateMap[`${prefix}_max_open_trades`] || stateMap["max_open_trades"] || "3");
  const openTradeForSymbol = openTrades.some(t => t.symbol === symbol);

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
  const unrealisedPnl = openTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const totalPnl = dailyPnl + unrealisedPnl;

  // Use mode-specific gate from allocatorCore (single source of truth) or platformState override
  const modeDefaultGate = MODE_SCORE_GATES[mode as string] ?? 60;
  const minScore = parseFloat(stateMap[`${prefix}_min_composite_score`] || stateMap["min_composite_score"] || String(modeDefaultGate));
  const nativeScore = Math.round(winner.confidence * 100);

  // ── Stage 2: Core admission check via shared evaluator ────────────────────
  // evaluateSignalAdmission enforces the same gate order as the live allocator.
  // Both backtest and live call this function — single shared decision path.
  const admissionResult = evaluateSignalAdmission({
    symbol,
    engineName: winner.engineName,
    direction: winner.direction,
    nativeScore,
    confidence: winner.confidence,
    mode: mode as "paper" | "demo" | "real",
    minScoreGate: minScore,
    killSwitchActive: stateMap["kill_switch"] === "true",
    modeEnabled,
    symbolEnabled,
    openTradeForSymbol,
    currentOpenCount: openTrades.length,
    maxOpenTrades,
    dailyLossLimitBreached: dailyPnl < 0 && Math.abs(dailyPnl) / totalCapital >= maxDailyLossPct,
    weeklyLossLimitBreached: weeklyPnl < 0 && Math.abs(weeklyPnl) / totalCapital >= maxWeeklyLossPct,
    maxDrawdownBreached: totalPnl < 0 && Math.abs(totalPnl) / totalCapital >= maxDrawdownPct,
    correlatedFamilyCapBreached: false,
    simulationDefaults: [],  // live path — no simulation defaults
  });

  if (!admissionResult.allowed) {
    // For score gate (stage 4), build engine-specific rejection messages for observability
    if (admissionResult.rejectionStage === 4) {
      const minConfidence = minScore / 100;
      if (winner.confidence < minConfidence) {
    // Build engine-specific rejection reason for BOOM300
    const isBoom300 = winner.engineName === "boom_expansion_engine";
    if (isBoom300 && winner.metadata) {
      const nativeScore = winner.metadata["boom300NativeScore"] as number | undefined;
      const blockReasons = winner.metadata["boom300BlockReasons"] as string[] | undefined;
      const gateThreshold = winner.metadata["boom300GateThreshold"] as number | undefined;
      const componentScores = winner.metadata["componentScores"] as Record<string, number> | undefined;
      const cs = componentScores ?? {};
      const breakdown = componentScores
        ? `spike=${cs.spikeClusterPressure?.toFixed(0)},disp=${cs.upsideDisplacement?.toFixed(0)},exhaust=${cs.exhaustionEvidence?.toFixed(0)},drift=${cs.driftResumption?.toFixed(0)},entry=${cs.entryEfficiency?.toFixed(0)},move=${cs.expectedMoveSufficiency?.toFixed(0)}`
        : "";
      const weakParts = blockReasons && blockReasons.length > 0 ? ` | weak=[${blockReasons.join("; ")}]` : "";
      return deny(
        `boom300_score_below_mode_threshold:native=${nativeScore ?? "?"}/100,engine_gate=${gateThreshold ?? "?"},mode_min=${minScore}` +
        (breakdown ? ` | breakdown:[${breakdown}]` : "") +
        weakParts
      );
    }

    // Build engine-specific rejection reason for CRASH300
    const isCrash300 = winner.engineName === "crash_expansion_engine";
    if (isCrash300 && winner.metadata) {
      const nativeScore = winner.metadata["crash300NativeScore"] as number | undefined;
      const blockReasons = winner.metadata["crash300BlockReasons"] as string[] | undefined;
      const gateThreshold = winner.metadata["crash300GateThreshold"] as number | undefined;
      const componentScores = winner.metadata["componentScores"] as Record<string, number> | undefined;
      const cs = componentScores ?? {};
      const breakdown = componentScores
        ? `cluster=${cs.crashSpikeClusterPressure?.toFixed(0)},disp=${cs.downsideDisplacement?.toFixed(0)},exhaust=${cs.exhaustionReversalEvidence?.toFixed(0)},recovery=${cs.recoveryQuality?.toFixed(0)},entry=${cs.entryEfficiency?.toFixed(0)},move=${cs.expectedMoveSufficiency?.toFixed(0)}`
        : "";
      const weakParts = blockReasons && blockReasons.length > 0 ? ` | weak=[${blockReasons.join("; ")}]` : "";
      return deny(
        `crash300_score_below_mode_threshold:native=${nativeScore ?? "?"}/100,engine_gate=${gateThreshold ?? "?"},mode_min=${minScore}` +
        (breakdown ? ` | breakdown:[${breakdown}]` : "") +
        weakParts
      );
    }

    // Build engine-specific rejection reason for R_75 Reversal
    const isR75Reversal = winner.engineName === "r75_reversal_engine";
    if (isR75Reversal && winner.metadata) {
      const nativeScore    = winner.metadata["r75ReversalNativeScore"] as number | undefined;
      const gateThreshold  = winner.metadata["r75ReversalGateThreshold"] as number | undefined;
      const componentScores= winner.metadata["componentScores"] as Record<string, number> | undefined;
      const cs = componentScores ?? {};
      const breakdown = componentScores
        ? `extreme=${cs.rangeExtremity?.toFixed(0)},reversal=${cs.reversalConfirmation?.toFixed(0)},stretch=${cs.stretchDeviationQuality?.toFixed(0)},structure=${cs.structureQuality?.toFixed(0)},entry=${cs.entryEfficiency?.toFixed(0)},move=${cs.expectedMoveSufficiency?.toFixed(0)}`
        : "";
      const weakComponents = componentScores
        ? Object.entries(cs).filter(([, v]) => v < 55).map(([k, v]) => {
            const label: Record<string, string> = {
              rangeExtremity: "insufficient_range_extremity",
              reversalConfirmation: "insufficient_reversal_confirmation",
              stretchDeviationQuality: "insufficient_stretch_deviation",
              structureQuality: "weak_structure_quality",
              entryEfficiency: "poor_entry_efficiency",
              expectedMoveSufficiency: "insufficient_expected_move",
            };
            return `${label[k] ?? k}(${v}/100)`;
          })
        : [];
      return deny(
        `r75_reversal_score_below_mode_threshold:native=${nativeScore ?? "?"}/100,engine_gate=${gateThreshold ?? "?"},mode_min=${minScore}` +
        (breakdown ? ` | breakdown:[${breakdown}]` : "") +
        (weakComponents.length > 0 ? ` | weak=[${weakComponents.join("; ")}]` : "")
      );
    }

    // Build engine-specific rejection reason for R_75 Continuation
    const isR75Continuation = winner.engineName === "r75_continuation_engine";
    if (isR75Continuation && winner.metadata) {
      const nativeScore    = winner.metadata["r75ContinuationNativeScore"] as number | undefined;
      const gateThreshold  = winner.metadata["r75ContinuationGateThreshold"] as number | undefined;
      const componentScores= winner.metadata["componentScores"] as Record<string, number> | undefined;
      const cs = componentScores ?? {};
      const breakdown = componentScores
        ? `trend=${cs.trendQuality?.toFixed(0)},pullback=${cs.pullbackQuality?.toFixed(0)},slope=${cs.slopeAlignment?.toFixed(0)},structure=${cs.structureContinuity?.toFixed(0)},entry=${cs.entryEfficiency?.toFixed(0)},move=${cs.expectedMoveSufficiency?.toFixed(0)}`
        : "";
      const weakComponents = componentScores
        ? Object.entries(cs).filter(([, v]) => v < 55).map(([k, v]) => {
            const label: Record<string, string> = {
              trendQuality: "weak_trend_quality",
              pullbackQuality: "weak_pullback_quality",
              slopeAlignment: "poor_slope_alignment",
              structureContinuity: "poor_structure_continuity",
              entryEfficiency: "poor_entry_efficiency",
              expectedMoveSufficiency: "insufficient_expected_move",
            };
            return `${label[k] ?? k}(${v}/100)`;
          })
        : [];
      return deny(
        `r75_continuation_score_below_mode_threshold:native=${nativeScore ?? "?"}/100,engine_gate=${gateThreshold ?? "?"},mode_min=${minScore}` +
        (breakdown ? ` | breakdown:[${breakdown}]` : "") +
        (weakComponents.length > 0 ? ` | weak=[${weakComponents.join("; ")}]` : "")
      );
    }

    // Build engine-specific rejection reason for R_75 Breakout
    const isR75Breakout = winner.engineName === "r75_breakout_engine";
    if (isR75Breakout && winner.metadata) {
      const nativeScore    = winner.metadata["r75BreakoutNativeScore"] as number | undefined;
      const gateThreshold  = winner.metadata["r75BreakoutGateThreshold"] as number | undefined;
      const componentScores= winner.metadata["componentScores"] as Record<string, number> | undefined;
      const cs = componentScores ?? {};
      const breakdown = componentScores
        ? `pressure=${cs.boundaryPressure?.toFixed(0)},break=${cs.breakStrength?.toFixed(0)},expand=${cs.expansionQuality?.toFixed(0)},retest=${cs.retestAcceptanceQuality?.toFixed(0)},entry=${cs.entryEfficiency?.toFixed(0)},move=${cs.expectedMoveSufficiency?.toFixed(0)}`
        : "";
      const weakComponents = componentScores
        ? Object.entries(cs).filter(([, v]) => v < 55).map(([k, v]) => {
            const label: Record<string, string> = {
              boundaryPressure: "weak_boundary_pressure",
              breakStrength: "insufficient_break_strength",
              expansionQuality: "insufficient_expansion_quality",
              retestAcceptanceQuality: "weak_retest_acceptance",
              entryEfficiency: "poor_entry_efficiency",
              expectedMoveSufficiency: "insufficient_expected_move",
            };
            return `${label[k] ?? k}(${v}/100)`;
          })
        : [];
      return deny(
        `r75_breakout_score_below_mode_threshold:native=${nativeScore ?? "?"}/100,engine_gate=${gateThreshold ?? "?"},mode_min=${minScore}` +
        (breakdown ? ` | breakdown:[${breakdown}]` : "") +
        (weakComponents.length > 0 ? ` | weak=[${weakComponents.join("; ")}]` : "")
      );
    }

    // Build engine-specific rejection reason for R_100 Reversal
    const isR100Reversal = winner.engineName === "r100_reversal_engine";
    if (isR100Reversal && winner.metadata) {
      const nativeScore    = winner.metadata["r100ReversalNativeScore"] as number | undefined;
      const gateThreshold  = winner.metadata["r100ReversalGateThreshold"] as number | undefined;
      const componentScores= winner.metadata["componentScores"] as Record<string, number> | undefined;
      const cs = componentScores ?? {};
      const breakdown = componentScores
        ? `extreme=${cs.rangeExtremity?.toFixed(0)},reversal=${cs.reversalConfirmation?.toFixed(0)},stretch=${cs.stretchDeviation?.toFixed(0)},structure=${cs.structureQuality?.toFixed(0)},entry=${cs.entryEfficiency?.toFixed(0)},move=${cs.expectedMoveSufficiency?.toFixed(0)}`
        : "";
      const weakComponents = componentScores
        ? Object.entries(cs).filter(([, v]) => v < 55).map(([k, v]) => {
            const label: Record<string, string> = {
              rangeExtremity:          "insufficient_range_extremity",
              reversalConfirmation:    "insufficient_reversal_confirmation",
              stretchDeviation:        "insufficient_stretch_deviation",
              structureQuality:        "weak_structure_quality",
              entryEfficiency:         "poor_entry_efficiency",
              expectedMoveSufficiency: "insufficient_expected_move",
            };
            return `${label[k] ?? k}(${v}/100)`;
          })
        : [];
      return deny(
        `r100_reversal_score_below_mode_threshold:native=${nativeScore ?? "?"}/100,engine_gate=${gateThreshold ?? "?"},mode_min=${minScore}` +
        (breakdown ? ` | breakdown:[${breakdown}]` : "") +
        (weakComponents.length > 0 ? ` | weak=[${weakComponents.join("; ")}]` : "")
      );
    }

    // Build engine-specific rejection reason for R_100 Breakout
    const isR100Breakout = winner.engineName === "r100_breakout_engine";
    if (isR100Breakout && winner.metadata) {
      const nativeScore    = winner.metadata["r100BreakoutNativeScore"] as number | undefined;
      const gateThreshold  = winner.metadata["r100BreakoutGateThreshold"] as number | undefined;
      const componentScores= winner.metadata["componentScores"] as Record<string, number> | undefined;
      const cs = componentScores ?? {};
      const breakdown = componentScores
        ? `pressure=${cs.boundaryPressure?.toFixed(0)},break=${cs.breakStrength?.toFixed(0)},expand=${cs.expansionQuality?.toFixed(0)},accept=${cs.acceptanceQuality?.toFixed(0)},entry=${cs.entryEfficiency?.toFixed(0)},move=${cs.expectedMoveSufficiency?.toFixed(0)}`
        : "";
      const weakComponents = componentScores
        ? Object.entries(cs).filter(([, v]) => v < 55).map(([k, v]) => {
            const label: Record<string, string> = {
              boundaryPressure:        "weak_boundary_pressure",
              breakStrength:           "insufficient_break_strength",
              expansionQuality:        "insufficient_expansion_quality",
              acceptanceQuality:       "weak_acceptance_quality",
              entryEfficiency:         "poor_entry_efficiency",
              expectedMoveSufficiency: "insufficient_expected_move",
            };
            return `${label[k] ?? k}(${v}/100)`;
          })
        : [];
      return deny(
        `r100_breakout_score_below_mode_threshold:native=${nativeScore ?? "?"}/100,engine_gate=${gateThreshold ?? "?"},mode_min=${minScore}` +
        (breakdown ? ` | breakdown:[${breakdown}]` : "") +
        (weakComponents.length > 0 ? ` | weak=[${weakComponents.join("; ")}]` : "")
      );
    }

    // Build engine-specific rejection reason for R_100 Continuation
    const isR100Continuation = winner.engineName === "r100_continuation_engine";
    if (isR100Continuation && winner.metadata) {
      const nativeScore    = winner.metadata["r100ContinuationNativeScore"] as number | undefined;
      const gateThreshold  = winner.metadata["r100ContinuationGateThreshold"] as number | undefined;
      const componentScores= winner.metadata["componentScores"] as Record<string, number> | undefined;
      const cs = componentScores ?? {};
      const breakdown = componentScores
        ? `trend=${cs.trendStrength?.toFixed(0)},pullback=${cs.pullbackQuality?.toFixed(0)},slope=${cs.slopeAlignment?.toFixed(0)},structure=${cs.structureContinuity?.toFixed(0)},entry=${cs.entryEfficiency?.toFixed(0)},move=${cs.expectedMoveSufficiency?.toFixed(0)}`
        : "";
      const weakComponents = componentScores
        ? Object.entries(cs).filter(([, v]) => v < 55).map(([k, v]) => {
            const label: Record<string, string> = {
              trendStrength:           "weak_trend_strength",
              pullbackQuality:         "weak_pullback_quality",
              slopeAlignment:          "poor_slope_alignment",
              structureContinuity:     "poor_structure_continuity",
              entryEfficiency:         "poor_entry_efficiency",
              expectedMoveSufficiency: "insufficient_expected_move",
            };
            return `${label[k] ?? k}(${v}/100)`;
          })
        : [];
      return deny(
        `r100_continuation_score_below_mode_threshold:native=${nativeScore ?? "?"}/100,engine_gate=${gateThreshold ?? "?"},mode_min=${minScore}` +
        (breakdown ? ` | breakdown:[${breakdown}]` : "") +
        (weakComponents.length > 0 ? ` | weak=[${weakComponents.join("; ")}]` : "")
      );
    }

      return deny(`confidence_below_threshold:${winner.confidence.toFixed(3)}<${minConfidence.toFixed(3)}`);
      }  // closes: if (winner.confidence < minConfidence)
    }  // closes: if (admissionResult.rejectionStage === 4)
    // Gates 1-3, 5-10: use the shared evaluator rejection reason directly
    return deny(admissionResult.rejectionReason ?? "rejected_by_allocator");
  }  // closes: if (!admissionResult.allowed)

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
