import type { FeatureVector } from "./features.js";
import type { SignalCandidate } from "./strategies.js";

export interface ScoringDimensions {
  rangePosition: number;
  maDeviation: number;
  volatilityProfile: number;
  rangeExpansion: number;
  directionalConfirmation: number;
}

export interface ScoringWeights {
  rangePosition: number;
  maDeviation: number;
  volatilityProfile: number;
  rangeExpansion: number;
  directionalConfirmation: number;
}

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  rangePosition: 0.25,
  maDeviation: 0.20,
  volatilityProfile: 0.20,
  rangeExpansion: 0.15,
  directionalConfirmation: 0.20,
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function computeRangePosition(features: FeatureVector, direction: "buy" | "sell"): number {
  const distHigh = Math.abs(features.distFromRange30dHighPct);
  const distLow = Math.abs(features.distFromRange30dLowPct);

  if (direction === "buy") {
    if (distLow <= 0.03) return 100;
    if (distLow <= 0.07) return 85;
    if (distLow <= 0.10) return 70;
    if (distLow <= 0.18) return 55;
    if (distLow <= 0.25) return 40;
    return 20;
  } else {
    if (distHigh <= 0.03) return 100;
    if (distHigh <= 0.07) return 85;
    if (distHigh <= 0.10) return 70;
    if (distHigh <= 0.18) return 55;
    if (distHigh <= 0.25) return 40;
    return 20;
  }
}

function computeMaDeviation(features: FeatureVector, direction: "buy" | "sell"): number {
  const dist7d = features.emaDist;
  const absDist = Math.abs(dist7d);

  if (direction === "buy") {
    if (dist7d < -0.06) return 95;
    if (dist7d < -0.04) return 85;
    if (dist7d < -0.02) return 70;
    if (dist7d < -0.01) return 55;
    if (dist7d < 0) return 40;
    return 20;
  } else {
    if (dist7d > 0.06) return 95;
    if (dist7d > 0.04) return 85;
    if (dist7d > 0.02) return 70;
    if (dist7d > 0.01) return 55;
    if (dist7d > 0) return 40;
    return 20;
  }
}

function computeVolatilityProfile(features: FeatureVector): number {
  const atrRank = features.atrRank;
  const atr = features.atr14;

  let score = 50;

  if (atrRank >= 1.3) {
    score = 90;
  } else if (atrRank >= 1.1) {
    score = 75;
  } else if (atrRank >= 0.9) {
    score = 60;
  } else if (atrRank >= 0.7) {
    score = 45;
  } else {
    score = 30;
  }

  if (atr > 0.008) score = Math.min(100, score + 10);
  if (features.bbWidth > 0.010) score = Math.min(100, score + 5);

  return clamp(Math.round(score), 0, 100);
}

function computeRangeExpansion(features: FeatureVector): number {
  const bbWidthRoc = features.bbWidthRoc;
  const atrAccel = features.atrAccel;

  let score = 40;

  if (bbWidthRoc > 0.10) score += 30;
  else if (bbWidthRoc > 0.05) score += 20;
  else if (bbWidthRoc > 0.02) score += 10;
  else if (bbWidthRoc < -0.05) score -= 10;

  if (atrAccel > 0.10) score += 25;
  else if (atrAccel > 0.05) score += 15;
  else if (atrAccel > 0.02) score += 8;

  if (features.bbWidth < 0.005 && bbWidthRoc > 0) {
    score += 10;
  }

  return clamp(Math.round(score), 0, 100);
}

function computeDirectionalConfirmation(features: FeatureVector, direction: "buy" | "sell"): number {
  let score = 30;

  const slopeAligned = (direction === "buy" && features.emaSlope > 0) ||
    (direction === "sell" && features.emaSlope < 0);
  const slopeStrength = Math.abs(features.emaSlope);

  if (slopeAligned) {
    if (slopeStrength > 0.0005) score += 20;
    else if (slopeStrength > 0.0002) score += 12;
    else score += 5;
  }

  const isReversalCandle = (direction === "buy" && features.latestClose > features.latestOpen) ||
    (direction === "sell" && features.latestClose < features.latestOpen);
  if (isReversalCandle) score += 15;

  const rsiConfirms = (direction === "buy" && features.rsi14 < 40) ||
    (direction === "sell" && features.rsi14 > 60);
  if (rsiConfirms) score += 10;

  const rsiExtreme = (direction === "buy" && features.rsi14 < 30) ||
    (direction === "sell" && features.rsi14 > 70);
  if (rsiExtreme) score += 10;

  const priceChangeConfirms = (direction === "buy" && features.priceChange24hPct > 0.005) ||
    (direction === "sell" && features.priceChange24hPct < -0.005);
  if (priceChangeConfirms) score += 10;

  const multiDayMoveAgainst = (direction === "buy" && features.priceChange7dPct < -0.05) ||
    (direction === "sell" && features.priceChange7dPct > 0.05);
  if (multiDayMoveAgainst) score += 10;

  return clamp(Math.round(score), 0, 100);
}

export function computeScoringDimensions(
  features: FeatureVector,
  candidate: SignalCandidate,
  _modelScore?: number,
  _hourlyFeatures?: Partial<FeatureVector>,
): ScoringDimensions {
  return {
    rangePosition: computeRangePosition(features, candidate.direction),
    maDeviation: computeMaDeviation(features, candidate.direction),
    volatilityProfile: computeVolatilityProfile(features),
    rangeExpansion: computeRangeExpansion(features),
    directionalConfirmation: computeDirectionalConfirmation(features, candidate.direction),
  };
}

export function computeCompositeScore(
  dimensions: ScoringDimensions,
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS
): number {
  const totalWeight = weights.rangePosition + weights.maDeviation + weights.volatilityProfile +
    weights.rangeExpansion + weights.directionalConfirmation;

  if (totalWeight === 0) return 0;

  const weighted =
    dimensions.rangePosition * weights.rangePosition +
    dimensions.maDeviation * weights.maDeviation +
    dimensions.volatilityProfile * weights.volatilityProfile +
    dimensions.rangeExpansion * weights.rangeExpansion +
    dimensions.directionalConfirmation * weights.directionalConfirmation;

  return clamp(Math.round(weighted / totalWeight), 0, 100);
}
