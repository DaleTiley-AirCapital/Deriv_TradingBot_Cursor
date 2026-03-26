import type { FeatureVector } from "./features.js";
import { scoreFeaturesForFamily } from "./model.js";
import { computeScoringDimensions, computeCompositeScore, type ScoringWeights } from "./scoring.js";
import { classifyRegime, getCachedRegime, cacheRegime, type StrategyFamily, type RegimeClassification } from "./regimeEngine.js";

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
  bbUpper: number;
  bbLower: number;
  currentPrice: number;
}

const FAMILY_CONFIG: Record<StrategyFamily, {
  minModelScore: number;
  minEV: number;
  minRR: number;
}> = {
  trend_continuation: {
    minModelScore: 0.58,
    minEV: 0.005,
    minRR: 1.5,
  },
  mean_reversion: {
    minModelScore: 0.60,
    minEV: 0.006,
    minRR: 1.8,
  },
  breakout_expansion: {
    minModelScore: 0.55,
    minEV: 0.005,
    minRR: 1.5,
  },
  spike_event: {
    minModelScore: 0.62,
    minEV: 0.008,
    minRR: 2.0,
  },
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
    bbUpper: features.bbUpper,
    bbLower: features.bbLower,
    currentPrice: (features.bbUpper + features.bbLower) / 2,
  };
}

function trendContinuation(features: FeatureVector, regime: RegimeClassification): SignalCandidate | null {
  const cfg = FAMILY_CONFIG.trend_continuation;

  const inUptrend = features.emaSlope > 0.0003;
  const inDowntrend = features.emaSlope < -0.0003;
  const pulledBack = Math.abs(features.emaDist) < 0.008;
  const rsiNeutral = features.rsi14 > 38 && features.rsi14 < 65;
  const noExtreme = Math.abs(features.zScore) < 2.0;

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
  if (score < cfg.minModelScore || expectedValue < cfg.minEV) return null;

  return buildCandidate(features, regime, "trend_continuation", direction, score, confidence, expectedValue, reason, "trend_continuation");
}

function meanReversion(features: FeatureVector, regime: RegimeClassification): SignalCandidate | null {
  const cfg = FAMILY_CONFIG.mean_reversion;

  const oversold = features.rsi14 < 32 && features.zScore < -1.8;
  const overbought = features.rsi14 > 68 && features.zScore > 1.8;
  const multipleAdverse = Math.abs(features.consecutive) >= 3;

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
  if (score < cfg.minModelScore || expectedValue < cfg.minEV) return null;

  return buildCandidate(features, regime, "mean_reversion", direction, score, confidence, expectedValue, `[${regime.regime}] ${reason}`, "mean_reversion");
}

function breakoutExpansion(features: FeatureVector, regime: RegimeClassification): SignalCandidate | null {
  const cfg = FAMILY_CONFIG.breakout_expansion;

  const squeeze = features.bbWidth < 0.006;
  const atrExpanding = features.atrRank > 0.8;
  const atUpperBand = features.bbPctB > 0.85;
  const atLowerBand = features.bbPctB < 0.15;

  const wasCompressed = features.bbWidth < 0.008;
  const bbExpanding = features.bbWidthRoc > 0.10;
  const atrAccelerating = features.atrAccel > 0.08;
  const bodyExpanding = features.candleBody > 0.6;

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
  if (score < cfg.minModelScore || expectedValue < cfg.minEV) return null;

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

const FAMILY_RUNNERS: Record<StrategyFamily, (f: FeatureVector, r: RegimeClassification) => SignalCandidate | null> = {
  trend_continuation: trendContinuation,
  mean_reversion: meanReversion,
  breakout_expansion: breakoutExpansion,
  spike_event: spikeEvent,
};

export function runAllStrategies(features: FeatureVector, weights?: ScoringWeights, cachedRegime?: RegimeClassification): SignalCandidate[] {
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

  for (const candidate of candidates) {
    const dims = computeScoringDimensions(features, candidate, candidate.score);
    candidate.dimensions = dims;
    candidate.compositeScore = computeCompositeScore(dims, weights);
  }

  return candidates;
}
