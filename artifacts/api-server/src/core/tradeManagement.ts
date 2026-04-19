/**
 * tradeManagement.ts — Shared Trade Exit + Lifecycle Evaluation
 *
 * Single source of truth for bar-level trade management logic used by both:
 *   - backtestRunner.ts (historical replay)
 *   - tradeEngine.ts / manageOpenPositions (live tick management)
 *
 * Covers:
 *   1. evaluateBarExits()          — SL/TP check per bar (SL-first, matching live priority)
 *   2. calcTpProgress()            — normalized progress toward TP (0-1)
 *   3. calculateAdaptiveTrailingStop() — ATR-based trailing SL computation
 *   4. applyBarStateTransitions()  — combined MFE/MAE tracking + BE promotion + trailing
 *   5. MAX_HOLD_MINS               — shared max duration constant
 */

// ── Bar exit evaluation ───────────────────────────────────────────────────────

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

export function evaluateBarExits(input: BarExitInput): BarExitOutput {
  const { direction, barHigh, barLow, barClose, tp, sl } = input;

  const slBreached = direction === "buy" ? barLow <= sl : barHigh >= sl;
  if (slBreached) return { exitReason: "sl_hit", exitPrice: sl };

  const tpReached = direction === "buy" ? barHigh >= tp : barLow <= tp;
  if (tpReached) return { exitReason: "tp_hit", exitPrice: tp };

  return { exitReason: null, exitPrice: barClose };
}

// ── Stage thresholds (single source of truth) ─────────────────────────────────

export const BREAKEVEN_THRESHOLD_PCT    = 0.20;
export const TRAILING_ACTIVATION_THRESHOLD_PCT = 0.30;

// ── Maximum hold duration ─────────────────────────────────────────────────────

/** 43,200 min = 30 days. Applied in both live and replay. */
export const MAX_HOLD_MINS = 43_200;

// ── TP progress helper ────────────────────────────────────────────────────────

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

// ── Adaptive trailing stop ────────────────────────────────────────────────────

export function calculateAdaptiveTrailingStop(params: {
  entryPrice: number;
  currentPrice: number;
  peakPrice: number;
  direction: "buy" | "sell";
  currentSl: number;
  tpPrice: number;
  atr14Pct: number;
  instrumentFamily: "crash" | "boom" | "volatility";
  adverseCandleCount: number;
  emaSlope: number;
  spikeCountAdverse4h?: number;
  trailingActivationThresholdPct?: number;
  trailingDistancePct?: number;
}): { newSl: number; updated: boolean; reason?: string } {
  const {
    entryPrice, currentPrice, peakPrice, direction, currentSl, tpPrice,
    atr14Pct, instrumentFamily, adverseCandleCount, emaSlope, spikeCountAdverse4h,
    trailingActivationThresholdPct, trailingDistancePct,
  } = params;

  const currentPnlPct = direction === "buy"
    ? (currentPrice - entryPrice) / entryPrice
    : (entryPrice - currentPrice) / entryPrice;
  if (currentPnlPct <= 0) return { newSl: currentSl, updated: false };

  const tpPct = direction === "buy"
    ? (tpPrice - entryPrice) / entryPrice
    : (entryPrice - tpPrice) / entryPrice;
  if (tpPct <= 0) return { newSl: currentSl, updated: false };

  const progress = currentPnlPct / tpPct;
  const effectiveTrailingActivationThreshold =
    Number.isFinite(trailingActivationThresholdPct) && (trailingActivationThresholdPct ?? 0) > 0
      ? Math.max(0.05, Math.min(0.90, trailingActivationThresholdPct as number))
      : TRAILING_ACTIVATION_THRESHOLD_PCT;
  if (progress < effectiveTrailingActivationThreshold) return { newSl: currentSl, updated: false };

  const isCrashBoom = instrumentFamily === "crash" || instrumentFamily === "boom";

  let multiplier: number;
  if (progress < 0.60) {
    multiplier = isCrashBoom ? 3.0 : 2.0;
  } else if (progress < 0.85) {
    multiplier = isCrashBoom ? 2.0 : 1.5;
  } else {
    multiplier = isCrashBoom ? 1.5 : 1.0;
  }

  const emaFlipped   = direction === "buy" ? emaSlope < -0.0002 : emaSlope > 0.0002;
  const adverseCandles = adverseCandleCount >= 3;
  const adverseSpikes  = (spikeCountAdverse4h ?? 0) >= 3;
  const reversalCount  = [adverseCandles, emaFlipped, adverseSpikes].filter(Boolean).length;
  if (reversalCount === 3) {
    multiplier = 1.0;
  } else if (reversalCount >= 1) {
    multiplier = Math.max(1.0, multiplier - 0.5);
  }

  const minMultiplier = 2.0;
  multiplier = Math.max(multiplier, minMultiplier);

  const peakPnlPct = direction === "buy"
    ? (peakPrice - entryPrice) / entryPrice
    : (entryPrice - peakPrice) / entryPrice;
  if (peakPnlPct <= 0) return { newSl: currentSl, updated: false };

  const atr = Math.max(atr14Pct, 0.001);
  const atrTrailPct = peakPnlPct - (atr * multiplier);
  const calibratedTrailPct = Number.isFinite(trailingDistancePct) && (trailingDistancePct ?? 0) > 0
    ? peakPnlPct - (trailingDistancePct as number)
    : atrTrailPct;
  const trailPct = Math.max(atrTrailPct, calibratedTrailPct);
  if (trailPct <= 0) return { newSl: currentSl, updated: false };

  if (direction === "buy") {
    const trailingSl = entryPrice * (1 + trailPct);
    if (trailingSl > currentSl) {
      return { newSl: trailingSl, updated: true, reason: `ATR×${multiplier.toFixed(1)} trail (progress=${(progress * 100).toFixed(0)}%, reversals=${reversalCount})` };
    }
  } else {
    const trailingSl = entryPrice * (1 - trailPct);
    if (trailingSl < currentSl) {
      return { newSl: trailingSl, updated: true, reason: `ATR×${multiplier.toFixed(1)} trail (progress=${(progress * 100).toFixed(0)}%, reversals=${reversalCount})` };
    }
  }

  return { newSl: currentSl, updated: false };
}

// ── Shared bar-level state transition (BE + trailing) ─────────────────────────
//
// Pure function. Owns the full lifecycle state machine for one bar:
//   1. Peak-price / MFE / MAE / adverse-candle tracking
//   2. Stage 1 → 2 breakeven promotion at BREAKEVEN_THRESHOLD_PCT
//   3. Stage 2 → 3 trailing activation at TRAILING_ACTIVATION_THRESHOLD_PCT
//   4. Adaptive trailing SL update
//
// Called by backtestRunner per bar AND can be used by live tick management.
// Returns new state + promotion/activation flags so callers can record events.

export interface OpenTradeBarInput {
  direction: "buy" | "sell";
  entryPrice: number;
  tp: number;
  holdBars: number;
  barHigh: number;
  barLow: number;
  barClose: number;
  barOpen: number;
  // Mutable state passed in — returned as updated values
  stage: 1 | 2 | 3;
  sl: number;
  peakPrice: number;
  mfePct: number;
  maePct: number;
  adverseCandleCount: number;
  // Instrument context for trailing computation
  atr14AtEntry: number;
  instrumentFamily: "crash" | "boom" | "volatility";
  emaSlope: number;
  spikeCount4h: number;
  trailingActivationThresholdPct?: number;
  trailingMinHoldBars?: number;
  trailingDistancePct?: number;
}

export interface OpenTradeBarOutput {
  stage: 1 | 2 | 3;
  sl: number;
  peakPrice: number;
  mfePct: number;
  maePct: number;
  adverseCandleCount: number;
  bePromoted: boolean;
  trailingActivated: boolean;
  tpProgressAtBe: number;
  tpProgressAtTrailing: number;
  mfePctAtPromotion: number;
}

export function applyBarStateTransitions(input: OpenTradeBarInput): OpenTradeBarOutput {
  const {
    direction, entryPrice, tp,
    holdBars, barHigh, barLow, barClose, barOpen,
    atr14AtEntry, instrumentFamily, emaSlope, spikeCount4h,
    trailingActivationThresholdPct, trailingMinHoldBars, trailingDistancePct,
  } = input;

  let { stage, sl, peakPrice, mfePct, maePct, adverseCandleCount } = input;

  // 1. Peak-price tracking
  const favorable = direction === "buy" ? barHigh : barLow;
  if (direction === "buy" && favorable > peakPrice) peakPrice = favorable;
  if (direction === "sell" && favorable < peakPrice) peakPrice = favorable;

  // 2. MFE / MAE
  const barMfe = direction === "buy" ? (barHigh - entryPrice) / entryPrice : (entryPrice - barLow) / entryPrice;
  const barMae = direction === "buy" ? (barLow - entryPrice) / entryPrice  : (entryPrice - barHigh) / entryPrice;
  if (barMfe > mfePct) mfePct = barMfe;
  if (barMae < maePct) maePct = barMae;

  // 3. Adverse candle count (reset on favorable close, increment on adverse)
  const isFavorable = direction === "buy" ? barClose >= barOpen : barClose <= barOpen;
  adverseCandleCount = isFavorable ? 0 : adverseCandleCount + 1;

  // 4. Stage 1 → 2: breakeven promotion
  let bePromoted = false;
  let tpProgressAtBe = 0;
  let mfePctAtPromotion = 0;

  if (stage === 1) {
    const tpProgress = calcTpProgress({ direction, entryPrice, currentPrice: barClose, tpPrice: tp });
    if (tpProgress >= BREAKEVEN_THRESHOLD_PCT) {
      const buffer = entryPrice * 0.0005;
      const beSlPrice = direction === "buy" ? entryPrice + buffer : entryPrice - buffer;
      const slImproved = direction === "buy" ? beSlPrice > sl : beSlPrice < sl;
      if (slImproved) {
        mfePctAtPromotion = mfePct;
        tpProgressAtBe = tpProgress;
        sl = beSlPrice;
        stage = 2;
        bePromoted = true;
      }
    }
  }

  // 5. Stage 2 → 3: trailing activation + adaptive SL update
  let trailingActivated = false;
  let tpProgressAtTrailing = 0;

  if (stage >= 2) {
    const progress = calcTpProgress({ direction, entryPrice, currentPrice: barClose, tpPrice: tp });
    const effectiveTrailingActivationThreshold =
      Number.isFinite(trailingActivationThresholdPct) && (trailingActivationThresholdPct ?? 0) > 0
        ? Math.max(0.05, Math.min(0.90, trailingActivationThresholdPct as number))
        : TRAILING_ACTIVATION_THRESHOLD_PCT;
    const effectiveTrailingMinHoldBars =
      Number.isFinite(trailingMinHoldBars) && (trailingMinHoldBars ?? 0) > 0
        ? Math.max(1, Math.min(MAX_HOLD_MINS, Math.round(trailingMinHoldBars as number)))
        : 1;
    if (progress >= effectiveTrailingActivationThreshold && holdBars >= effectiveTrailingMinHoldBars) {
      if (stage === 2) {
        stage = 3;
        trailingActivated = true;
        tpProgressAtTrailing = progress;
      }
      const { newSl, updated } = calculateAdaptiveTrailingStop({
        entryPrice,
        currentPrice: barClose,
        peakPrice,
        direction,
        currentSl: sl,
        tpPrice: tp,
        atr14Pct: atr14AtEntry,
        instrumentFamily,
        adverseCandleCount,
        emaSlope,
        spikeCountAdverse4h: spikeCount4h,
        trailingActivationThresholdPct: effectiveTrailingActivationThreshold,
        trailingDistancePct,
      });
      if (updated) sl = newSl;
    }
  }

  return {
    stage, sl, peakPrice, mfePct, maePct, adverseCandleCount,
    bePromoted, trailingActivated, tpProgressAtBe, tpProgressAtTrailing, mfePctAtPromotion,
  };
}
