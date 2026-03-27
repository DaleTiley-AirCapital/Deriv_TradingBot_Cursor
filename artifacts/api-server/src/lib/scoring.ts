import type { FeatureVector } from "./features.js";
import type { SignalCandidate } from "./strategies.js";
import type { StrategyFamily } from "./regimeEngine.js";

export interface ScoringDimensions {
  regimeFit: number;
  setupQuality: number;
  trendAlignment: number;
  volatilityCondition: number;
  rewardRisk: number;
  probabilityOfSuccess: number;
}

export interface ScoringWeights {
  regimeFit: number;
  setupQuality: number;
  trendAlignment: number;
  volatilityCondition: number;
  rewardRisk: number;
  probabilityOfSuccess: number;
}

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  regimeFit: 0.22,
  setupQuality: 0.20,
  trendAlignment: 0.15,
  volatilityCondition: 0.13,
  rewardRisk: 0.15,
  probabilityOfSuccess: 0.15,
};

const FAMILY_IDEAL_REGIMES: Record<string, string[]> = {
  "trend_continuation": ["trend_up", "trend_down", "breakout_expansion"],
  "mean_reversion": ["mean_reversion", "ranging"],
  "breakout_expansion": ["compression", "breakout_expansion", "trend_up", "trend_down"],
  "spike_event": ["spike_zone", "ranging"],
};

const FAMILY_IDEAL_VOLATILITY: Record<string, { min: number; max: number }> = {
  "trend_continuation": { min: 0.001, max: 0.004 },
  "mean_reversion": { min: 0.002, max: 0.006 },
  "breakout_expansion": { min: 0.003, max: 0.010 },
  "spike_event": { min: 0.001, max: 0.010 },
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function computeRegimeFit(features: FeatureVector, candidate: SignalCandidate): number {
  const regimeLabel = candidate.regimeState || features.regimeLabel;
  const lookupKeys = [candidate.strategyName, candidate.strategyFamily];
  let idealRegimes: string[] = [];
  for (const key of lookupKeys) {
    if (FAMILY_IDEAL_REGIMES[key]) {
      idealRegimes = FAMILY_IDEAL_REGIMES[key];
      break;
    }
  }
  if (idealRegimes.length === 0) return 50;

  const isIdeal = idealRegimes.includes(regimeLabel);
  if (!isIdeal) return 15;

  let score = 75;
  const regimeConf = candidate.regimeConfidence ?? 0.5;
  score += clamp(regimeConf * 25, 0, 25);

  return clamp(Math.round(score), 0, 100);
}

function computeSetupQuality(candidate: SignalCandidate, modelScore: number): number {
  let score = 0;

  const scoreMargin = (modelScore - 0.5) / 0.5;
  score += clamp(scoreMargin * 40, 0, 40);

  const evStrength = Math.min(candidate.expectedValue / 0.015, 1);
  score += clamp(evStrength * 30, 0, 30);

  if (candidate.regimeCompatible) score += 15;

  const confidence = candidate.confidence;
  score += clamp(confidence * 15, 0, 15);

  return clamp(Math.round(score), 0, 100);
}

function computeTrendAlignment(features: FeatureVector, direction: "buy" | "sell"): number {
  let score = 50;

  const slopeAligned = (direction === "buy" && features.emaSlope > 0) ||
    (direction === "sell" && features.emaSlope < 0);

  if (slopeAligned) {
    const slopeStrength = Math.min(Math.abs(features.emaSlope) / 0.001, 1);
    score += clamp(slopeStrength * 25, 0, 25);
  } else {
    const slopeStrength = Math.min(Math.abs(features.emaSlope) / 0.001, 1);
    score -= clamp(slopeStrength * 25, 0, 25);
  }

  const priceAboveEma = features.emaDist > 0;
  if ((direction === "buy" && priceAboveEma) || (direction === "sell" && !priceAboveEma)) {
    score += 10;
  } else {
    score -= 5;
  }

  const consecutiveAligned = (direction === "buy" && features.consecutive > 0) ||
    (direction === "sell" && features.consecutive < 0);
  if (consecutiveAligned) {
    const consStrength = Math.min(Math.abs(features.consecutive) / 5, 1);
    score += clamp(consStrength * 15, 0, 15);
  }

  return clamp(Math.round(score), 0, 100);
}

function computeVolatilityCondition(features: FeatureVector, candidate: SignalCandidate): number {
  const lookupKeys = [candidate.strategyName, candidate.strategyFamily];
  let ideal = { min: 0.001, max: 0.006 };
  for (const key of lookupKeys) {
    if (FAMILY_IDEAL_VOLATILITY[key]) {
      ideal = FAMILY_IDEAL_VOLATILITY[key];
      break;
    }
  }

  const midpoint = (ideal.min + ideal.max) / 2;
  const halfRange = (ideal.max - ideal.min) / 2;

  const atr = features.atr14;
  let score: number;

  if (atr >= ideal.min && atr <= ideal.max) {
    const distFromMid = Math.abs(atr - midpoint) / halfRange;
    score = 100 - distFromMid * 25;
  } else if (atr < ideal.min) {
    const deficit = (ideal.min - atr) / ideal.min;
    score = Math.max(10, 60 - deficit * 100);
  } else {
    const excess = (atr - ideal.max) / ideal.max;
    score = Math.max(10, 60 - excess * 80);
  }

  const bbNormal = features.bbWidth >= 0.003 && features.bbWidth <= 0.015;
  if (bbNormal) score += 10;

  const atrRankNormal = features.atrRank >= 0.5 && features.atrRank <= 1.5;
  if (atrRankNormal) score += 5;

  return clamp(Math.round(score), 0, 100);
}

function computeRewardRisk(candidate: SignalCandidate): number {
  const price = candidate.currentPrice;
  if (!price || price <= 0) return 30;

  const isBuy = candidate.direction === "buy";
  const fibExts = isBuy ? (candidate.fibExtensionLevels ?? []) : (candidate.fibExtensionLevelsDown ?? []);
  const candidates_tp = [
    isBuy ? candidate.swingHigh : candidate.swingLow,
    isBuy ? candidate.bbUpper : candidate.bbLower,
    ...fibExts,
  ].filter(l => l > 0 && (isBuy ? l > price : l < price));

  const candidates_sl = [
    isBuy ? candidate.swingLow : candidate.swingHigh,
    isBuy ? candidate.bbLower : candidate.bbUpper,
    ...(candidate.fibRetraceLevels ?? []),
  ].filter(l => l > 0 && (isBuy ? l < price : l > price));

  const nearestTp = candidates_tp.length > 0
    ? candidates_tp.reduce((best, l) => Math.abs(l - price) < Math.abs(best - price) ? l : best)
    : null;
  const nearestSl = candidates_sl.length > 0
    ? candidates_sl.reduce((best, l) => Math.abs(l - price) < Math.abs(best - price) ? l : best)
    : null;

  const tpDist = nearestTp ? Math.abs(nearestTp - price) : 0;
  const slDist = nearestSl ? Math.abs(nearestSl - price) : 0;

  if (slDist === 0 || tpDist === 0) return 30;

  const rr = tpDist / slDist;

  if (rr >= 3.0) return 100;
  if (rr >= 2.5) return 90;
  if (rr >= 2.0) return 80;
  if (rr >= 1.8) return 70;
  if (rr >= 1.5) return 60;
  if (rr >= 1.2) return 45;
  if (rr >= 1.0) return 30;
  return 15;
}

function computeProbabilityOfSuccess(modelScore: number): number {
  return clamp(Math.round(modelScore * 100), 0, 100);
}

export function computeScoringDimensions(
  features: FeatureVector,
  candidate: SignalCandidate,
  modelScore: number,
  hourlyFeatures?: Partial<FeatureVector>,
): ScoringDimensions {
  const htfFeatures: FeatureVector = hourlyFeatures
    ? { ...features, ...hourlyFeatures, symbol: features.symbol, ts: features.ts }
    : features;
  return {
    regimeFit: computeRegimeFit(features, candidate),
    setupQuality: computeSetupQuality(candidate, modelScore),
    trendAlignment: computeTrendAlignment(htfFeatures, candidate.direction),
    volatilityCondition: computeVolatilityCondition(htfFeatures, candidate),
    rewardRisk: computeRewardRisk(candidate),
    probabilityOfSuccess: computeProbabilityOfSuccess(modelScore),
  };
}

export function computeCompositeScore(
  dimensions: ScoringDimensions,
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS
): number {
  const totalWeight = weights.regimeFit + weights.setupQuality + weights.trendAlignment +
    weights.volatilityCondition + weights.rewardRisk + weights.probabilityOfSuccess;

  if (totalWeight === 0) return 0;

  const weighted =
    dimensions.regimeFit * weights.regimeFit +
    dimensions.setupQuality * weights.setupQuality +
    dimensions.trendAlignment * weights.trendAlignment +
    dimensions.volatilityCondition * weights.volatilityCondition +
    dimensions.rewardRisk * weights.rewardRisk +
    dimensions.probabilityOfSuccess * weights.probabilityOfSuccess;

  return clamp(Math.round(weighted / totalWeight), 0, 100);
}
