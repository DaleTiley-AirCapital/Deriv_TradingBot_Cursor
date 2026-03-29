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

interface ScoringBreakpoints {
  rangePosition: { tiers: number[]; scores: number[] };
  maDeviation: { tiers: number[]; scores: number[] };
  volatilityProfile: { atrRankTiers: number[]; atrRankScores: number[]; atrBonus: number; bbBonus: number };
  rangeExpansion: { bbRocTiers: number[]; bbRocScores: number[]; atrAccelTiers: number[]; atrAccelScores: number[] };
  directionalConfirmation: { slopeStrengthTiers: number[]; slopeScores: number[]; rsiMild: number; rsiExtreme: number; pcChange: number; multiDayMove: number };
}

const CRASH300_BREAKPOINTS: ScoringBreakpoints = {
  rangePosition: { tiers: [0.08, 0.15, 0.22, 0.30, 0.38], scores: [100, 85, 70, 55, 40, 20] },
  maDeviation: { tiers: [0.10, 0.07, 0.04, 0.02, 0.01], scores: [95, 85, 70, 55, 40, 20] },
  volatilityProfile: { atrRankTiers: [1.3, 1.1, 0.9, 0.7], atrRankScores: [90, 75, 60, 45, 30], atrBonus: 0.015, bbBonus: 0.020 },
  rangeExpansion: { bbRocTiers: [0.15, 0.08, 0.03], bbRocScores: [30, 20, 10], atrAccelTiers: [0.15, 0.08, 0.03], atrAccelScores: [25, 15, 8] },
  directionalConfirmation: { slopeStrengthTiers: [0.001, 0.0004], slopeScores: [20, 12, 5], rsiMild: 42, rsiExtreme: 32, pcChange: 0.008, multiDayMove: 0.08 },
};

const BOOM300_BREAKPOINTS: ScoringBreakpoints = {
  rangePosition: { tiers: [0.07, 0.12, 0.18, 0.25, 0.32], scores: [100, 85, 70, 55, 40, 20] },
  maDeviation: { tiers: [0.08, 0.06, 0.035, 0.018, 0.008], scores: [95, 85, 70, 55, 40, 20] },
  volatilityProfile: { atrRankTiers: [1.3, 1.1, 0.9, 0.7], atrRankScores: [90, 75, 60, 45, 30], atrBonus: 0.012, bbBonus: 0.016 },
  rangeExpansion: { bbRocTiers: [0.12, 0.06, 0.025], bbRocScores: [30, 20, 10], atrAccelTiers: [0.12, 0.06, 0.025], atrAccelScores: [25, 15, 8] },
  directionalConfirmation: { slopeStrengthTiers: [0.0008, 0.0003], slopeScores: [20, 12, 5], rsiMild: 42, rsiExtreme: 32, pcChange: 0.007, multiDayMove: 0.06 },
};

const R75_BREAKPOINTS: ScoringBreakpoints = {
  rangePosition: { tiers: [0.05, 0.10, 0.14, 0.18, 0.22], scores: [100, 85, 70, 55, 40, 20] },
  maDeviation: { tiers: [0.06, 0.04, 0.025, 0.012, 0.005], scores: [95, 85, 70, 55, 40, 20] },
  volatilityProfile: { atrRankTiers: [1.3, 1.1, 0.9, 0.7], atrRankScores: [90, 75, 60, 45, 30], atrBonus: 0.010, bbBonus: 0.012 },
  rangeExpansion: { bbRocTiers: [0.10, 0.05, 0.02], bbRocScores: [30, 20, 10], atrAccelTiers: [0.10, 0.05, 0.02], atrAccelScores: [25, 15, 8] },
  directionalConfirmation: { slopeStrengthTiers: [0.0006, 0.0002], slopeScores: [20, 12, 5], rsiMild: 40, rsiExtreme: 30, pcChange: 0.005, multiDayMove: 0.05 },
};

const R100_BREAKPOINTS: ScoringBreakpoints = {
  rangePosition: { tiers: [0.04, 0.08, 0.12, 0.16, 0.20], scores: [100, 85, 70, 55, 40, 20] },
  maDeviation: { tiers: [0.06, 0.04, 0.02, 0.01, 0.005], scores: [95, 85, 70, 55, 40, 20] },
  volatilityProfile: { atrRankTiers: [1.3, 1.1, 0.9, 0.7], atrRankScores: [90, 75, 60, 45, 30], atrBonus: 0.008, bbBonus: 0.010 },
  rangeExpansion: { bbRocTiers: [0.10, 0.05, 0.02], bbRocScores: [30, 20, 10], atrAccelTiers: [0.10, 0.05, 0.02], atrAccelScores: [25, 15, 8] },
  directionalConfirmation: { slopeStrengthTiers: [0.0005, 0.0002], slopeScores: [20, 12, 5], rsiMild: 40, rsiExtreme: 30, pcChange: 0.005, multiDayMove: 0.05 },
};

export function getSymbolScoringBreakpoints(symbol: string): ScoringBreakpoints {
  if (symbol === "CRASH300" || symbol.startsWith("CRASH")) return CRASH300_BREAKPOINTS;
  if (symbol === "BOOM300" || symbol.startsWith("BOOM")) return BOOM300_BREAKPOINTS;
  if (symbol === "R_75") return R75_BREAKPOINTS;
  if (symbol === "R_100") return R100_BREAKPOINTS;
  if (symbol.startsWith("R_")) return R75_BREAKPOINTS;
  return R75_BREAKPOINTS;
}

function computeRangePosition(features: FeatureVector, direction: "buy" | "sell"): number {
  const bp = getSymbolScoringBreakpoints(features.symbol).rangePosition;
  const dist = direction === "buy"
    ? Math.abs(features.distFromRange30dLowPct)
    : Math.abs(features.distFromRange30dHighPct);

  for (let i = 0; i < bp.tiers.length; i++) {
    if (dist <= bp.tiers[i]) return bp.scores[i];
  }
  return bp.scores[bp.scores.length - 1];
}

function computeMaDeviation(features: FeatureVector, direction: "buy" | "sell"): number {
  const bp = getSymbolScoringBreakpoints(features.symbol).maDeviation;
  const dist = features.emaDist;
  const absDist = Math.abs(dist);

  const correctSide = (direction === "buy" && dist < 0) || (direction === "sell" && dist > 0);
  if (!correctSide) return 20;

  for (let i = 0; i < bp.tiers.length; i++) {
    if (absDist >= bp.tiers[i]) return bp.scores[i];
  }
  return bp.scores[bp.scores.length - 1];
}

function computeVolatilityProfile(features: FeatureVector): number {
  const bp = getSymbolScoringBreakpoints(features.symbol).volatilityProfile;
  let score = 50;

  for (let i = 0; i < bp.atrRankTiers.length; i++) {
    if (features.atrRank >= bp.atrRankTiers[i]) { score = bp.atrRankScores[i]; break; }
    if (i === bp.atrRankTiers.length - 1) score = bp.atrRankScores[i + 1];
  }

  if (features.atr14 > bp.atrBonus) score = Math.min(100, score + 10);
  if (features.bbWidth > bp.bbBonus) score = Math.min(100, score + 5);

  return clamp(Math.round(score), 0, 100);
}

function computeRangeExpansion(features: FeatureVector): number {
  const bp = getSymbolScoringBreakpoints(features.symbol).rangeExpansion;
  let score = 40;

  for (let i = 0; i < bp.bbRocTiers.length; i++) {
    if (features.bbWidthRoc > bp.bbRocTiers[i]) { score += bp.bbRocScores[i]; break; }
  }
  if (features.bbWidthRoc < -0.05) score -= 10;

  for (let i = 0; i < bp.atrAccelTiers.length; i++) {
    if (features.atrAccel > bp.atrAccelTiers[i]) { score += bp.atrAccelScores[i]; break; }
  }

  if (features.bbWidth < 0.005 && features.bbWidthRoc > 0) {
    score += 10;
  }

  return clamp(Math.round(score), 0, 100);
}

function computeDirectionalConfirmation(features: FeatureVector, direction: "buy" | "sell"): number {
  const bp = getSymbolScoringBreakpoints(features.symbol).directionalConfirmation;
  let score = 30;

  const slopeAligned = (direction === "buy" && features.emaSlope > 0) ||
    (direction === "sell" && features.emaSlope < 0);
  const slopeStrength = Math.abs(features.emaSlope);

  if (slopeAligned) {
    for (let i = 0; i < bp.slopeStrengthTiers.length; i++) {
      if (slopeStrength > bp.slopeStrengthTiers[i]) { score += bp.slopeScores[i]; break; }
      if (i === bp.slopeStrengthTiers.length - 1) score += bp.slopeScores[i + 1];
    }
  }

  const isReversalCandle = (direction === "buy" && features.latestClose > features.latestOpen) ||
    (direction === "sell" && features.latestClose < features.latestOpen);
  if (isReversalCandle) score += 15;

  const rsiConfirms = (direction === "buy" && features.rsi14 < bp.rsiMild) ||
    (direction === "sell" && features.rsi14 > (100 - bp.rsiMild));
  if (rsiConfirms) score += 10;

  const rsiExtreme = (direction === "buy" && features.rsi14 < bp.rsiExtreme) ||
    (direction === "sell" && features.rsi14 > (100 - bp.rsiExtreme));
  if (rsiExtreme) score += 10;

  const priceChangeConfirms = (direction === "buy" && features.priceChange24hPct > bp.pcChange) ||
    (direction === "sell" && features.priceChange24hPct < -bp.pcChange);
  if (priceChangeConfirms) score += 10;

  const multiDayMoveAgainst = (direction === "buy" && features.priceChange7dPct < -bp.multiDayMove) ||
    (direction === "sell" && features.priceChange7dPct > bp.multiDayMove);
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
