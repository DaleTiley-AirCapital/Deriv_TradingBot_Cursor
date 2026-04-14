/**
 * tradeManagement.ts — Shared Trade Exit Evaluation
 *
 * Pure bar-level exit logic shared between:
 *   - backtestRunner.ts (historical replay)
 *   - tradeEngine.ts / manageOpenPositions (live tick management)
 *
 * Priority order (matches live manageOpenPositions):
 *   1. SL breached  → sl_hit   (SL checked BEFORE TP to match live priority)
 *   2. TP reached   → tp_hit
 *   3. None         → null (trade still open)
 *
 * Also exports the breakeven and trailing stage transition logic so both
 * backtest and live code use the same thresholds.
 */

export interface BarExitInput {
  direction: "buy" | "sell";
  barHigh: number;
  barLow: number;
  barClose: number;
  tp: number;
  sl: number;
}

export interface BarExitOutput {
  exitReason: "tp_hit" | "sl_hit" | null;
  exitPrice: number;
}

/**
 * Evaluate exit conditions for a single bar.
 * SL is checked before TP — matching live manageOpenPositions order.
 * When both hit on the same bar, SL wins (conservative, matches live).
 */
export function evaluateBarExits(input: BarExitInput): BarExitOutput {
  const { direction, barHigh, barLow, barClose, tp, sl } = input;

  // Stage 1: SL check (first, matching live priority)
  const slBreached = direction === "buy"
    ? barLow <= sl
    : barHigh >= sl;

  if (slBreached) {
    return { exitReason: "sl_hit", exitPrice: sl };
  }

  // Stage 2: TP check
  const tpReached = direction === "buy"
    ? barHigh >= tp
    : barLow <= tp;

  if (tpReached) {
    return { exitReason: "tp_hit", exitPrice: tp };
  }

  return { exitReason: null, exitPrice: barClose };
}

// ── Breakeven and trailing thresholds ────────────────────────────────────────
// These constants must match hybridTradeManager.ts — single source of truth here.

/** Progress toward TP at which breakeven promotion is triggered (matches live) */
export const BREAKEVEN_THRESHOLD_PCT = 0.20;

/** Progress toward TP at which adaptive trailing stop activates (matches live) */
export const TRAILING_ACTIVATION_THRESHOLD_PCT = 0.30;

/**
 * Calculate progress toward TP.
 * Returns a 0-1 value; 1.0 = TP reached.
 */
export function calcTpProgress(params: {
  direction: "buy" | "sell";
  entryPrice: number;
  currentPrice: number;
  tpPrice: number;
}): number {
  const { direction, entryPrice, currentPrice, tpPrice } = params;
  const tpDist = Math.abs(tpPrice - entryPrice);
  if (tpDist <= 0) return 0;
  const currentDist = direction === "buy"
    ? Math.max(0, currentPrice - entryPrice)
    : Math.max(0, entryPrice - currentPrice);
  return currentDist / tpDist;
}
