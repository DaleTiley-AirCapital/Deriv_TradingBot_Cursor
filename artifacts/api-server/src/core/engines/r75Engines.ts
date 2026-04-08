import type { EngineContext, EngineResult } from "../engineTypes.js";

const SYMBOL = "R_75";

// R_75 empirical calibration
// Volatility index — no directional spike bias
// Moves: avgUp 17.8%, avgDown 18.2%, ~6 swings/month, hold ~5 days
const R75_PROJECTED_PCT = 0.18;

// ── Continuation Engine ───────────────────────────────────────────────────────
// Detects strong trending price action and enters in trend direction
// Suppressed when breakout engine has a valid signal
export function r75ContinuationEngine(ctx: EngineContext): EngineResult | null {
  const { features: f, operationalRegime } = ctx;
  if (f.symbol !== SYMBOL) return null;

  // Require clear trend with momentum
  const strongTrendUp   = f.emaSlope > 0.0004 && f.priceVsEma20 > 0.012;
  const strongTrendDown = f.emaSlope < -0.0004 && f.priceVsEma20 < -0.012;
  const momentumUp      = f.consecutive >= 4 && f.rsi14 >= 52 && f.rsi14 <= 72;
  const momentumDown    = f.consecutive <= -4 && f.rsi14 >= 28 && f.rsi14 <= 48;
  const atrExpanding    = f.atrRank >= 0.85;
  const notExtreme      = f.zScore >= -1.8 && f.zScore <= 1.8;

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

  // Suppress in ranging/compression regime
  if (operationalRegime === "ranging" || operationalRegime === "compression") {
    return null;
  }

  let regimeFit = 0.55;
  if (direction === "buy" && (operationalRegime === "trend_up" || operationalRegime === "breakout_expansion")) {
    regimeFit = 0.85;
  } else if (direction === "sell" && (operationalRegime === "trend_down" || operationalRegime === "breakout_expansion")) {
    regimeFit = 0.85;
  } else if (operationalRegime === "mean_reversion") {
    regimeFit = 0.35;
  }

  const confidence = Math.min(0.90, (signalCount / 4) * 0.6 + regimeFit * 0.4);

  return {
    valid: true,
    symbol: SYMBOL,
    engineName: "r75_continuation_engine",
    direction,
    confidence,
    regimeFit,
    entryType: "continuation",
    projectedMovePct: R75_PROJECTED_PCT,
    invalidation: direction === "buy"
      ? f.swingLow * 0.998
      : f.swingHigh * 1.002,
    reason: `r75_continuation ${direction}: emaSlope=${f.emaSlope.toFixed(5)}, consecutive=${f.consecutive}, rsi=${f.rsi14.toFixed(1)}`,
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
// Detects exhaustion/mean reversion setups at extremes
// Enters counter-trend when price is statistically stretched and momentum waning
export function r75ReversalEngine(ctx: EngineContext): EngineResult | null {
  const { features: f, operationalRegime } = ctx;
  if (f.symbol !== SYMBOL) return null;

  // Buy reversal: extreme oversold with mean reversion signals
  const extremeOversold  = f.rsi14 <= 28 && f.zScore <= -2.0;
  const bbLowerBreak     = f.bbPctB <= 0.05;
  const emaSlopeRecovery = f.emaSlope > -0.0001;
  const lowerWickStrong  = f.lowerWickRatio >= 0.45;

  // Sell reversal: extreme overbought with mean reversion signals
  const extremeOverbought = f.rsi14 >= 72 && f.zScore >= 2.0;
  const bbUpperBreak      = f.bbPctB >= 0.95;
  const emaSlopeWaning    = f.emaSlope < 0.0001;
  const upperWickStrong   = f.upperWickRatio >= 0.45;

  let direction: "buy" | "sell";
  let buySigs: number;
  let sellSigs: number;

  buySigs  = [extremeOversold, bbLowerBreak, emaSlopeRecovery, lowerWickStrong].filter(Boolean).length;
  sellSigs = [extremeOverbought, bbUpperBreak, emaSlopeWaning, upperWickStrong].filter(Boolean).length;

  if (buySigs >= 3 && buySigs >= sellSigs) {
    direction = "buy";
  } else if (sellSigs >= 3 && sellSigs > buySigs) {
    direction = "sell";
  } else {
    return null;
  }

  const signalCount = direction === "buy" ? buySigs : sellSigs;

  // Reversal is weaker in strong trending regimes
  if (operationalRegime === "trend_up" && direction === "buy") return null;
  if (operationalRegime === "trend_down" && direction === "sell") return null;

  let regimeFit = 0.60;
  if (operationalRegime === "mean_reversion" || operationalRegime === "ranging") {
    regimeFit = 0.88;
  } else if (operationalRegime === "compression") {
    regimeFit = 0.72;
  }

  const confidence = Math.min(0.88, (signalCount / 4) * 0.55 + regimeFit * 0.45);

  return {
    valid: true,
    symbol: SYMBOL,
    engineName: "r75_reversal_engine",
    direction,
    confidence,
    regimeFit,
    entryType: "reversal",
    projectedMovePct: R75_PROJECTED_PCT * 0.8,
    invalidation: direction === "buy"
      ? f.latestClose * 0.992
      : f.latestClose * 1.008,
    reason: `r75_reversal ${direction}: rsi=${f.rsi14.toFixed(1)}, zScore=${f.zScore.toFixed(2)}, bbPctB=${f.bbPctB.toFixed(2)}`,
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
// Detects BB compression followed by confirmed directional breakout
// This engine outranks continuation/reversal when breakout is active
export function r75BreakoutEngine(ctx: EngineContext): EngineResult | null {
  const { features: f, operationalRegime } = ctx;
  if (f.symbol !== SYMBOL) return null;

  // Require prior compression then expansion
  const wasCompressed   = f.bbWidth <= 0.012;
  const nowExpanding    = f.bbWidthRoc >= 0.08 || f.atrAccel >= 0.08;
  const atrConfirm      = f.atrRank >= 0.90;

  if (!wasCompressed && !nowExpanding) return null;
  if (!atrConfirm) return null;

  const swingBreakUp   = f.swingBreached && f.swingBreachDirection === "above";
  const swingBreakDown = f.swingBreached && f.swingBreachDirection === "below";

  let direction: "buy" | "sell";
  if (swingBreakUp) {
    direction = "buy";
  } else if (swingBreakDown) {
    direction = "sell";
  } else if (f.emaSlope > 0.0005) {
    direction = "buy";
  } else if (f.emaSlope < -0.0005) {
    direction = "sell";
  } else {
    return null;
  }

  // Breakout is most reliable in expansion/breakout regimes
  let regimeFit = 0.65;
  if (operationalRegime === "breakout_expansion") {
    regimeFit = 0.92;
  } else if (operationalRegime === "compression") {
    regimeFit = 0.82;
  } else if (operationalRegime === "trend_up" || operationalRegime === "trend_down") {
    regimeFit = 0.70;
  } else if (operationalRegime === "ranging") {
    regimeFit = 0.50;
  }

  const signalStrength = [wasCompressed, nowExpanding, atrConfirm, swingBreakUp || swingBreakDown].filter(Boolean).length;
  const confidence = Math.min(0.93, (signalStrength / 4) * 0.55 + regimeFit * 0.45);

  return {
    valid: true,
    symbol: SYMBOL,
    engineName: "r75_breakout_engine",
    direction,
    confidence,
    regimeFit,
    entryType: "breakout",
    projectedMovePct: R75_PROJECTED_PCT * 1.1,
    invalidation: direction === "buy"
      ? f.swingLow * 0.997
      : f.swingHigh * 1.003,
    reason: `r75_breakout ${direction}: bbWidth=${f.bbWidth.toFixed(4)}, bbWidthRoc=${f.bbWidthRoc.toFixed(3)}, swingBreach=${f.swingBreached}`,
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
