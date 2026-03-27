import type { FeatureVector } from "./features.js";
import { scoreFeaturesForFamily } from "./model.js";
import { computeScoringDimensions, computeCompositeScore, type ScoringWeights } from "./scoring.js";
import { classifyRegime, getCachedRegime, cacheRegime, getHourlyAveragedFeatures, type StrategyFamily, type RegimeClassification } from "./regimeEngine.js";

export interface SignalCandidate {
  symbol: string;
  strategyName: string;
  strategyFamily: StrategyFamily;
  direction: "buy" | "sell";
  score: number;
  confidence: number;
  expectedValue: number;
  regimeCompatible: boolean;
  signalType: string;
  suggestedSl: number | null;
  suggestedTp: number | null;
  reason: string;
  timestamp: number;
  compositeScore: number;
  dimensions: import("./scoring.js").ScoringDimensions | null;
  regimeState: string;
  regimeConfidence: number;
  swingHigh: number;
  swingLow: number;
  fibRetraceLevels: number[];
  fibExtensionLevels: number[];
  fibExtensionLevelsDown: number[];
  bbUpper: number;
  bbLower: number;
  currentPrice: number;
  vwap?: number;
  pivotPoint?: number;
  pivotR1?: number;
  pivotR2?: number;
  pivotR3?: number;
  pivotS1?: number;
  pivotS2?: number;
  pivotS3?: number;
  camarillaH3?: number;
  camarillaH4?: number;
  camarillaL3?: number;
  camarillaL4?: number;
  psychRound?: number;
  prevSessionHigh?: number;
  prevSessionLow?: number;
  prevSessionClose?: number;
}

const FAMILY_CONFIG: Record<StrategyFamily, {
  minModelScore: number;
}> = {
  trend_continuation: { minModelScore: 0.50 },
  mean_reversion: { minModelScore: 0.52 },
  breakout_expansion: { minModelScore: 0.48 },
  spike_event: { minModelScore: 0.55 },
  trendline_breakout: { minModelScore: 0.50 },
};

function buildCandidate(
  features: FeatureVector,
  regime: RegimeClassification,
  family: StrategyFamily,
  direction: "buy" | "sell",
  score: number,
  confidence: number,
  expectedValue: number,
  reason: string,
  signalType: string,
): SignalCandidate {
  return {
    symbol: features.symbol,
    strategyName: family,
    strategyFamily: family,
    direction,
    score,
    confidence,
    expectedValue,
    regimeCompatible: true,
    signalType,
    suggestedSl: null,
    suggestedTp: null,
    reason,
    timestamp: Date.now(),
    compositeScore: 0,
    dimensions: null,
    regimeState: regime.regime,
    regimeConfidence: regime.confidence,
    swingHigh: features.swingHigh,
    swingLow: features.swingLow,
    fibRetraceLevels: features.fibRetraceLevels,
    fibExtensionLevels: features.fibExtensionLevels,
    fibExtensionLevelsDown: features.fibExtensionLevelsDown,
    bbUpper: features.bbUpper,
    bbLower: features.bbLower,
    currentPrice: features.latestClose,
    vwap: features.vwap,
    pivotPoint: features.pivotPoint,
    pivotR1: features.pivotR1,
    pivotR2: features.pivotR2,
    pivotR3: features.pivotR3,
    pivotS1: features.pivotS1,
    pivotS2: features.pivotS2,
    pivotS3: features.pivotS3,
    camarillaH3: features.camarillaH3,
    camarillaH4: features.camarillaH4,
    camarillaL3: features.camarillaL3,
    camarillaL4: features.camarillaL4,
    psychRound: features.psychRound,
    prevSessionHigh: features.prevSessionHigh,
    prevSessionLow: features.prevSessionLow,
    prevSessionClose: features.prevSessionClose,
  };
}

function trendContinuation(features: FeatureVector, regime: RegimeClassification): SignalCandidate | null {
  const cfg = FAMILY_CONFIG.trend_continuation;

  const inUptrend = features.emaSlope > 0.0001;
  const inDowntrend = features.emaSlope < -0.0001;
  const pulledBack = Math.abs(features.emaDist) < 0.015;
  const rsiNeutral = features.rsi14 > 30 && features.rsi14 < 70;
  const noExtreme = Math.abs(features.zScore) < 2.5;

  let direction: "buy" | "sell" | null = null;
  let reason = "";

  if (inUptrend && pulledBack && rsiNeutral && noExtreme) {
    direction = "buy";
    reason = `Trend continuation pullback (slope=${features.emaSlope.toFixed(5)}, RSI=${features.rsi14.toFixed(1)}, regime=${regime.regime})`;
  } else if (inDowntrend && pulledBack && rsiNeutral && noExtreme) {
    direction = "sell";
    reason = `Trend continuation pullback (slope=${features.emaSlope.toFixed(5)}, RSI=${features.rsi14.toFixed(1)}, regime=${regime.regime})`;
  }

  if (!direction) return null;

  const { score, confidence, expectedValue } = scoreFeaturesForFamily(features, "trend_continuation");
  if (score < cfg.minModelScore) return null;

  return buildCandidate(features, regime, "trend_continuation", direction, score, confidence, expectedValue, reason, "trend_continuation");
}

function meanReversion(features: FeatureVector, regime: RegimeClassification): SignalCandidate | null {
  const cfg = FAMILY_CONFIG.mean_reversion;

  const oversold = features.rsi14 < 38 && features.zScore < -1.2;
  const overbought = features.rsi14 > 62 && features.zScore > 1.2;
  const multipleAdverse = Math.abs(features.consecutive) >= 2;

  const sweepSetup = features.swingBreached && features.swingReclaimed &&
    features.swingBreachCandles >= 0 && features.swingBreachCandles <= 3 &&
    features.candleBody < 0.35;

  let direction: "buy" | "sell" | null = null;
  let reason = "";

  if (oversold && multipleAdverse) {
    direction = "buy";
    reason = `Exhaustion rebound: RSI=${features.rsi14.toFixed(1)}, z=${features.zScore.toFixed(2)}, ${Math.abs(features.consecutive)} consecutive down`;
  } else if (overbought && multipleAdverse) {
    direction = "sell";
    reason = `Exhaustion rebound: RSI=${features.rsi14.toFixed(1)}, z=${features.zScore.toFixed(2)}, ${Math.abs(features.consecutive)} consecutive up`;
  } else if (sweepSetup) {
    if (features.swingBreachDirection === "above") {
      direction = "sell";
      reason = `Liquidity sweep above swing high: breach ${features.swingBreachCandles} candles ago, body=${features.candleBody.toFixed(2)}`;
    } else if (features.swingBreachDirection === "below") {
      direction = "buy";
      reason = `Liquidity sweep below swing low: breach ${features.swingBreachCandles} candles ago, body=${features.candleBody.toFixed(2)}`;
    }
  }

  if (!direction) return null;

  const { score, confidence, expectedValue } = scoreFeaturesForFamily(features, "mean_reversion");
  if (score < cfg.minModelScore) return null;

  return buildCandidate(features, regime, "mean_reversion", direction, score, confidence, expectedValue, `[${regime.regime}] ${reason}`, "mean_reversion");
}

function breakoutExpansion(features: FeatureVector, regime: RegimeClassification): SignalCandidate | null {
  const cfg = FAMILY_CONFIG.breakout_expansion;

  const squeeze = features.bbWidth < 0.012;
  const atrExpanding = features.atrRank > 0.6;
  const atUpperBand = features.bbPctB > 0.85;
  const atLowerBand = features.bbPctB < 0.15;

  const wasCompressed = features.bbWidth < 0.015;
  const bbExpanding = features.bbWidthRoc > 0.06;
  const atrAccelerating = features.atrAccel > 0.04;
  const bodyExpanding = features.candleBody > 0.5;

  let direction: "buy" | "sell" | null = null;
  let reason = "";

  if (squeeze && atrExpanding && atUpperBand) {
    direction = "buy";
    reason = `BB squeeze breakout up: width=${features.bbWidth.toFixed(4)}, %B=${features.bbPctB.toFixed(2)}, ATR rank=${features.atrRank.toFixed(2)}`;
  } else if (squeeze && atrExpanding && atLowerBand) {
    direction = "sell";
    reason = `BB squeeze breakout down: width=${features.bbWidth.toFixed(4)}, %B=${features.bbPctB.toFixed(2)}, ATR rank=${features.atrRank.toFixed(2)}`;
  } else if (wasCompressed && bbExpanding && atrAccelerating && bodyExpanding) {
    direction = features.bbPctB > 0.5 ? "buy" : "sell";
    reason = `Volatility expansion: bbWidthRoC=${features.bbWidthRoc.toFixed(3)}, atrAccel=${features.atrAccel.toFixed(3)}, body=${features.candleBody.toFixed(2)}`;
  }

  if (!direction) return null;

  const { score, confidence, expectedValue } = scoreFeaturesForFamily(features, "breakout_expansion");
  if (score < cfg.minModelScore) return null;

  return buildCandidate(features, regime, "breakout_expansion", direction, score, confidence, expectedValue, `[${regime.regime}] ${reason}`, "breakout_expansion");
}

function spikeEvent(features: FeatureVector, regime: RegimeClassification): SignalCandidate | null {
  const cfg = FAMILY_CONFIG.spike_event;

  const hazardHigh = features.spikeHazardScore > 0.70;
  const isBoom = features.symbol.startsWith("BOOM");
  const isCrash = features.symbol.startsWith("CRASH");

  if (!hazardHigh || (!isBoom && !isCrash)) return null;

  const direction: "buy" | "sell" = isBoom ? "buy" : "sell";
  const reason = `Spike hazard elevated: score=${features.spikeHazardScore.toFixed(2)}, ticks since last=${features.ticksSinceSpike}`;

  const { score, confidence, expectedValue } = scoreFeaturesForFamily(features, "spike_event");
  const boostedScore = Math.min(0.99, score * 0.4 + features.spikeHazardScore * 0.5);
  if (boostedScore < cfg.minModelScore) return null;

  return buildCandidate(features, regime, "spike_event", direction, boostedScore, features.spikeHazardScore, Math.max(expectedValue, 0.008), `[${regime.regime}] ${reason}`, "spike_capture");
}

function trendlineBreakout(features: FeatureVector, regime: RegimeClassification): SignalCandidate | null {
  const cfg = FAMILY_CONFIG.trendline_breakout;

  const hasSwings = features.swingHigh > 0 && features.swingLow > 0;
  if (!hasSwings) return null;

  const price = features.latestClose;
  const swingRange = features.swingHigh - features.swingLow;
  if (swingRange <= 0) return null;

  const atr = features.atr14;

  const resistanceTouches: number[] = [];
  if (features.swingHigh > 0) resistanceTouches.push(features.swingHigh);
  if (features.pivotR1 && Math.abs(features.pivotR1 - features.swingHigh) / features.swingHigh < 0.005) resistanceTouches.push(features.pivotR1);
  if (features.pivotR2 && Math.abs(features.pivotR2 - features.swingHigh) / features.swingHigh < 0.008) resistanceTouches.push(features.pivotR2);
  if (features.camarillaH3 && Math.abs(features.camarillaH3 - features.swingHigh) / features.swingHigh < 0.005) resistanceTouches.push(features.camarillaH3);
  if (features.prevSessionHigh && Math.abs(features.prevSessionHigh - features.swingHigh) / features.swingHigh < 0.005) resistanceTouches.push(features.prevSessionHigh);
  if (features.bbUpper > 0 && Math.abs(features.bbUpper - features.swingHigh) / features.swingHigh < 0.005) resistanceTouches.push(features.bbUpper);

  const supportTouches: number[] = [];
  if (features.swingLow > 0) supportTouches.push(features.swingLow);
  if (features.pivotS1 && Math.abs(features.pivotS1 - features.swingLow) / features.swingLow < 0.005) supportTouches.push(features.pivotS1);
  if (features.pivotS2 && Math.abs(features.pivotS2 - features.swingLow) / features.swingLow < 0.008) supportTouches.push(features.pivotS2);
  if (features.camarillaL3 && Math.abs(features.camarillaL3 - features.swingLow) / features.swingLow < 0.005) supportTouches.push(features.camarillaL3);
  if (features.prevSessionLow && Math.abs(features.prevSessionLow - features.swingLow) / features.swingLow < 0.005) supportTouches.push(features.prevSessionLow);
  if (features.bbLower > 0 && Math.abs(features.bbLower - features.swingLow) / features.swingLow < 0.005) supportTouches.push(features.bbLower);

  const momentumConfirm = features.atrAccel > 0.02 && features.candleBody > 0.35;
  const bbExpanding = features.bbWidth > 0.008;

  let direction: "buy" | "sell" | null = null;
  let reason = "";

  const breakAboveResistance = price > features.swingHigh &&
    (price - features.swingHigh) < atr * 2 &&
    resistanceTouches.length >= 3 &&
    momentumConfirm &&
    features.emaSlope > 0;

  const breakBelowSupport = price < features.swingLow &&
    (features.swingLow - price) < atr * 2 &&
    supportTouches.length >= 3 &&
    momentumConfirm &&
    features.emaSlope < 0;

  const nearResistanceBreak = !breakAboveResistance &&
    resistanceTouches.length >= 3 &&
    features.swingHighDist > -0.003 && features.swingHighDist < 0.005 &&
    features.bbPctB > 0.85 &&
    features.emaSlope > 0.0001 &&
    bbExpanding;

  const nearSupportBreak = !breakBelowSupport &&
    supportTouches.length >= 3 &&
    features.swingLowDist < 0.003 && features.swingLowDist > -0.005 &&
    features.bbPctB < 0.15 &&
    features.emaSlope < -0.0001 &&
    bbExpanding;

  if (breakAboveResistance || nearResistanceBreak) {
    direction = "buy";
    const touches = resistanceTouches.length;
    reason = `Trendline breakout up: price=${price.toFixed(2)}, swingHigh=${features.swingHigh.toFixed(2)}, touches=${touches}, atrAccel=${features.atrAccel.toFixed(3)}, body=${features.candleBody.toFixed(2)}`;
  } else if (breakBelowSupport || nearSupportBreak) {
    direction = "sell";
    const touches = supportTouches.length;
    reason = `Trendline breakout down: price=${price.toFixed(2)}, swingLow=${features.swingLow.toFixed(2)}, touches=${touches}, atrAccel=${features.atrAccel.toFixed(3)}, body=${features.candleBody.toFixed(2)}`;
  }

  if (!direction) return null;

  const vwapConfirm = features.vwap && features.vwap > 0
    ? (direction === "buy" ? price > features.vwap : price < features.vwap)
    : true;
  if (!vwapConfirm) return null;

  const { score, confidence, expectedValue } = scoreFeaturesForFamily(features, "breakout_expansion");
  if (score < cfg.minModelScore) return null;

  return buildCandidate(features, regime, "trendline_breakout", direction, score, confidence, expectedValue, `[${regime.regime}] ${reason}`, "trendline_breakout");
}

const FAMILY_RUNNERS: Record<StrategyFamily, (f: FeatureVector, r: RegimeClassification) => SignalCandidate | null> = {
  trend_continuation: trendContinuation,
  mean_reversion: meanReversion,
  breakout_expansion: breakoutExpansion,
  spike_event: spikeEvent,
  trendline_breakout: trendlineBreakout,
};

export function runAllStrategies(features: FeatureVector, weights?: ScoringWeights, cachedRegime?: RegimeClassification, explicitHourlyFeatures?: Partial<FeatureVector>): SignalCandidate[] {
  const regime = cachedRegime ?? classifyRegime(features);

  if (regime.regime === "no_trade") {
    return [];
  }

  const candidates: SignalCandidate[] = [];

  for (const family of regime.allowedFamilies) {
    const runner = FAMILY_RUNNERS[family];
    if (!runner) continue;
    const candidate = runner(features, regime);
    if (candidate) candidates.push(candidate);
  }

  const hourlyFeats = explicitHourlyFeatures ?? getHourlyAveragedFeatures(features.symbol) ?? undefined;

  for (const candidate of candidates) {
    const dims = computeScoringDimensions(features, candidate, candidate.score, hourlyFeats);
    candidate.dimensions = dims;
    candidate.compositeScore = computeCompositeScore(dims, weights);
  }

  return candidates;
}
