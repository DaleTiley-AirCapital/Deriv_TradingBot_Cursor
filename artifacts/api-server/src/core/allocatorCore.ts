/**
 * allocatorCore.ts — Pure Signal Admission Evaluator
 *
 * Shared logic used by both the live portfolio allocator (portfolioAllocatorV3.ts)
 * and the backtest runner (backtestRunner.ts) to apply mode-level signal admission
 * gates. This ensures historical replay answers "what would LIVE have done?" using
 * the same decision logic — not a hand-rolled approximation.
 *
 * ── Design ───────────────────────────────────────────────────────────────────
 *  Live caller: fetches ALL inputs from DB before calling evaluateSignalAdmission.
 *  Backtest caller: supplies best-available approximations for portfolio-state
 *    inputs (daily/weekly loss, drawdown, correlated-family cap) and records
 *    simulationGaps so callers know which gates were applied from defaults.
 *
 * Evaluation order (matches live portfolioAllocatorV3):
 *   1. Kill switch
 *   2. Mode active
 *   3. Symbol enabled for mode
 *   4. Min composite score / confidence gate  ← key parity gate
 *   5. One-open-trade-per-symbol
 *   6. Max concurrent open trades
 *   7. Daily loss limit
 *   8. Weekly loss limit
 *   9. Max drawdown
 *  10. Correlated family cap
 */

// ── Mode score gates — authoritative single source ────────────────────────────
// paper ≥ 60 | demo ≥ 65 | real ≥ 70  (V3 operating score gates)
export const MODE_SCORE_GATES: Record<string, number> = {
  paper: 60,
  demo:  65,
  real:  70,
};

export interface AllocatorCoreInput {
  // Signal metadata
  symbol: string;
  engineName: string;
  direction: "buy" | "sell";
  nativeScore: number;       // 0-100 integer — engine native composite score
  confidence: number;        // 0-1 float — coordinator confidence (= nativeScore/100 when direct)

  // Mode
  mode: "paper" | "demo" | "real";
  minScoreGate: number;      // from MODE_SCORE_GATES[mode]; may be overridden by platformState

  // Mode-level controls (live: from platformState; backtest: true = assumed active)
  killSwitchActive: boolean;
  modeEnabled: boolean;
  symbolEnabled: boolean;    // false if symbol not in ${mode}_enabled_symbols list

  // Portfolio state (live: from DB; backtest: approximated from local state)
  openTradeForSymbol: boolean;
  currentOpenCount: number;
  maxOpenTrades: number;     // live: from platformState ${mode}_max_open_trades

  // Risk state (live: computed from DB closed/open trades; backtest: false = not simulatable)
  dailyLossLimitBreached: boolean;
  weeklyLossLimitBreached: boolean;
  maxDrawdownBreached: boolean;
  correlatedFamilyCapBreached: boolean;

  // Simulation transparency: list keys whose values were set to defaults
  // because actual portfolio state was unavailable. Populated by caller.
  simulationDefaults?: string[];
}

export interface AllocatorCoreOutput {
  allowed: boolean;
  rejectionReason: string | null;
  rejectionStage: number | null;   // which gate (1-10) rejected the signal
  // Fields set to simulation defaults (documenting where backtest diverges from live).
  simulationGaps: string[];
}

export function evaluateSignalAdmission(input: AllocatorCoreInput): AllocatorCoreOutput {
  const gaps = input.simulationDefaults ?? [];

  const deny = (reason: string, stage: number): AllocatorCoreOutput => ({
    allowed: false,
    rejectionReason: reason,
    rejectionStage: stage,
    simulationGaps: gaps,
  });

  // Gate 1: Kill switch
  if (input.killSwitchActive) return deny("kill_switch_active", 1);

  // Gate 2: Mode active
  if (!input.modeEnabled) return deny(`mode_${input.mode}_not_active`, 2);

  // Gate 3: Symbol enabled for mode
  if (!input.symbolEnabled) return deny(`symbol_${input.symbol}_not_enabled_for_${input.mode}`, 3);

  // Gate 4: Min score / confidence (primary quality gate — same for live and backtest)
  const minConfidence = input.minScoreGate / 100;
  if (input.nativeScore < input.minScoreGate || input.confidence < minConfidence) {
    return deny(
      `score_below_gate:score=${input.nativeScore}<${input.minScoreGate},conf=${input.confidence.toFixed(3)}<${minConfidence.toFixed(3)}`,
      4,
    );
  }

  // Gate 5: One-open-trade-per-symbol
  if (input.openTradeForSymbol) {
    return deny(`symbol_already_has_open_position:${input.symbol}`, 5);
  }

  // Gate 6: Max concurrent open trades
  if (input.currentOpenCount >= input.maxOpenTrades) {
    return deny(`max_open_trades_reached:${input.currentOpenCount}/${input.maxOpenTrades}`, 6);
  }

  // Gate 7: Daily loss limit
  if (input.dailyLossLimitBreached) return deny("daily_loss_limit_breached", 7);

  // Gate 8: Weekly loss limit
  if (input.weeklyLossLimitBreached) return deny("weekly_loss_limit_breached", 8);

  // Gate 9: Max drawdown
  if (input.maxDrawdownBreached) return deny("max_drawdown_breached", 9);

  // Gate 10: Correlated family cap
  if (input.correlatedFamilyCapBreached) return deny("correlated_family_cap_breached", 10);

  return { allowed: true, rejectionReason: null, rejectionStage: null, simulationGaps: gaps };
}
