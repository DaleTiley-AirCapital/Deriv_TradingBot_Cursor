import type { EngineContext, EngineResult } from "../engineTypes.js";

const SYMBOL = "R_100";

// R_100 empirical calibration
// Higher volatility than R_75 — ~14 swings/month, hold ~2 days
// avgUp 17.3%, avgDown 15.3%
const R100_PROJECTED_PCT = 0.163;

// ── Continuation Engine ───────────────────────────────────────────────────────
// R_100 has sharper trends than R_75 — use tighter slope/consecutive thresholds
export function r100ContinuationEngine(ctx: EngineContext): EngineResult | null {
  const { features: f, operationalRegime } = ctx;
  if (f.symbol !== SYMBOL) return null;

  const strongTrendUp   = f.emaSlope > 0.0005 && f.priceVsEma20 > 0.015;
  const strongTrendDown = f.emaSlope < -0.0005 && f.priceVsEma20 < -0.015;
  const momentumUp      = f.consecutive >= 3 && f.rsi14 >= 53 && f.rsi14 <= 73;
  const momentumDown    = f.consecutive <= -3 && f.rsi14 >= 27 && f.rsi14 <= 47;
  const atrExpanding    = f.atrRank >= 0.80;
  const notExtreme      = f.zScore >= -2.0 && f.zScore <= 2.0;

  let direction: "buy" | "sell";
  let signalCount: number;

  if (strongTrendUp && momentumUp && notExtreme) {
    direction = "buy";
    signalCount = [strongTrendUp, momentumUp, atrExpanding, notExtreme].filter(Boolean).length;
  } else if (strongTrendDown && momentumDown && notExtreme) {
    direction = "sell";
    signalCount = [strongTrendDown, momentumDown, atrExpanding, notExtreme].filter(Boolean).length;
  } else {
    return null;
  }

  if (signalCount < 3) return null;

  if (operationalRegime === "ranging" || operationalRegime === "compression") {
    return null;
  }

  let regimeFit = 0.55;
  if (direction === "buy" && (operationalRegime === "trend_up" || operationalRegime === "breakout_expansion")) {
    regimeFit = 0.87;
  } else if (direction === "sell" && (operationalRegime === "trend_down" || operationalRegime === "breakout_expansion")) {
    regimeFit = 0.87;
  } else if (operationalRegime === "mean_reversion") {
    regimeFit = 0.30;
  }

  const confidence = Math.min(0.90, (signalCount / 4) * 0.60 + regimeFit * 0.40);

  return {
    valid: true,
    symbol: SYMBOL,
    engineName: "r100_continuation_engine",
    direction,
    confidence,
    regimeFit,
    entryType: "continuation",
    projectedMovePct: R100_PROJECTED_PCT,
    invalidation: direction === "buy"
      ? f.swingLow * 0.997
      : f.swingHigh * 1.003,
    reason: `r100_continuation ${direction}: emaSlope=${f.emaSlope.toFixed(5)}, consecutive=${f.consecutive}, rsi=${f.rsi14.toFixed(1)}`,
    metadata: {
      emaSlope: f.emaSlope,
      priceVsEma20: f.priceVsEma20,
      consecutive: f.consecutive,
      atrRank: f.atrRank,
      zScore: f.zScore,
    },
  };
}

// ── Reversal Engine ───────────────────────────────────────────────────────────
// R_100 reversals are sharper — use tighter thresholds
export function r100ReversalEngine(ctx: EngineContext): EngineResult | null {
  const { features: f, operationalRegime } = ctx;
  if (f.symbol !== SYMBOL) return null;

  const extremeOversold   = f.rsi14 <= 25 && f.zScore <= -2.2;
  const bbLowerBreak      = f.bbPctB <= 0.04;
  const lowerWickStrong   = f.lowerWickRatio >= 0.50;
  const emaSlopeFloor     = f.emaSlope > -0.0002;

  const extremeOverbought = f.rsi14 >= 75 && f.zScore >= 2.2;
  const bbUpperBreak      = f.bbPctB >= 0.96;
  const upperWickStrong   = f.upperWickRatio >= 0.50;
  const emaSlopePeak      = f.emaSlope < 0.0002;

  const buySigs  = [extremeOversold, bbLowerBreak, lowerWickStrong, emaSlopeFloor].filter(Boolean).length;
  const sellSigs = [extremeOverbought, bbUpperBreak, upperWickStrong, emaSlopePeak].filter(Boolean).length;

  let direction: "buy" | "sell";
  if (buySigs >= 3 && buySigs >= sellSigs) {
    direction = "buy";
  } else if (sellSigs >= 3 && sellSigs > buySigs) {
    direction = "sell";
  } else {
    return null;
  }

  if (operationalRegime === "trend_up" && direction === "buy") return null;
  if (operationalRegime === "trend_down" && direction === "sell") return null;

  let regimeFit = 0.60;
  if (operationalRegime === "mean_reversion" || operationalRegime === "ranging") {
    regimeFit = 0.88;
  } else if (operationalRegime === "compression") {
    regimeFit = 0.70;
  }

  const signalCount = direction === "buy" ? buySigs : sellSigs;
  const confidence = Math.min(0.88, (signalCount / 4) * 0.55 + regimeFit * 0.45);

  return {
    valid: true,
    symbol: SYMBOL,
    engineName: "r100_reversal_engine",
    direction,
    confidence,
    regimeFit,
    entryType: "reversal",
    projectedMovePct: R100_PROJECTED_PCT * 0.80,
    invalidation: direction === "buy"
      ? f.latestClose * 0.990
      : f.latestClose * 1.010,
    reason: `r100_reversal ${direction}: rsi=${f.rsi14.toFixed(1)}, zScore=${f.zScore.toFixed(2)}, bbPctB=${f.bbPctB.toFixed(2)}`,
    metadata: {
      rsi14: f.rsi14,
      zScore: f.zScore,
      bbPctB: f.bbPctB,
      upperWickRatio: f.upperWickRatio,
      lowerWickRatio: f.lowerWickRatio,
    },
  };
}

// ── Breakout Engine ───────────────────────────────────────────────────────────
// R_100 breakouts are fast and sharp — require strong ATR acceleration
export function r100BreakoutEngine(ctx: EngineContext): EngineResult | null {
  const { features: f, operationalRegime } = ctx;
  if (f.symbol !== SYMBOL) return null;

  const wasCompressed  = f.bbWidth <= 0.010;
  const nowExpanding   = f.bbWidthRoc >= 0.10 || f.atrAccel >= 0.10;
  const atrConfirm     = f.atrRank >= 0.92;

  if (!wasCompressed && !nowExpanding) return null;
  if (!atrConfirm) return null;

  const swingBreakUp   = f.swingBreached && f.swingBreachDirection === "above";
  const swingBreakDown = f.swingBreached && f.swingBreachDirection === "below";

  let direction: "buy" | "sell";
  if (swingBreakUp) {
    direction = "buy";
  } else if (swingBreakDown) {
    direction = "sell";
  } else if (f.emaSlope > 0.0006) {
    direction = "buy";
  } else if (f.emaSlope < -0.0006) {
    direction = "sell";
  } else {
    return null;
  }

  let regimeFit = 0.62;
  if (operationalRegime === "breakout_expansion") {
    regimeFit = 0.93;
  } else if (operationalRegime === "compression") {
    regimeFit = 0.82;
  } else if (operationalRegime === "trend_up" || operationalRegime === "trend_down") {
    regimeFit = 0.70;
  }

  const signalStrength = [wasCompressed, nowExpanding, atrConfirm, swingBreakUp || swingBreakDown].filter(Boolean).length;
  const confidence = Math.min(0.93, (signalStrength / 4) * 0.55 + regimeFit * 0.45);

  return {
    valid: true,
    symbol: SYMBOL,
    engineName: "r100_breakout_engine",
    direction,
    confidence,
    regimeFit,
    entryType: "breakout",
    projectedMovePct: R100_PROJECTED_PCT * 1.1,
    invalidation: direction === "buy"
      ? f.swingLow * 0.996
      : f.swingHigh * 1.004,
    reason: `r100_breakout ${direction}: bbWidth=${f.bbWidth.toFixed(4)}, bbWidthRoc=${f.bbWidthRoc.toFixed(3)}, atrRank=${f.atrRank.toFixed(2)}`,
    metadata: {
      bbWidth: f.bbWidth,
      bbWidthRoc: f.bbWidthRoc,
      atrAccel: f.atrAccel,
      atrRank: f.atrRank,
      swingBreached: f.swingBreached,
      swingBreachDirection: f.swingBreachDirection,
    },
  };
}
