import type { FeatureVector } from "./features.js";

export type RegimeState =
  | "trend_up"
  | "trend_down"
  | "mean_reversion"
  | "compression"
  | "breakout_expansion"
  | "spike_zone"
  | "no_trade";

export type InstrumentFamily = "boom" | "crash" | "volatility" | "other_synthetic";

export type StrategyFamily =
  | "trend_continuation"
  | "mean_reversion"
  | "breakout_expansion"
  | "spike_event";

export interface RegimeClassification {
  regime: RegimeState;
  confidence: number;
  allowedFamilies: StrategyFamily[];
  instrumentFamily: InstrumentFamily;
  macroBiasModifier: number;
}

export function classifyInstrument(symbol: string): InstrumentFamily {
  if (symbol.startsWith("BOOM")) return "boom";
  if (symbol.startsWith("CRASH")) return "crash";
  if (symbol.startsWith("R_")) return "volatility";
  return "other_synthetic";
}

const STRATEGY_PERMISSION_MATRIX: Record<RegimeState, StrategyFamily[]> = {
  trend_up: ["trend_continuation"],
  trend_down: ["trend_continuation"],
  mean_reversion: ["mean_reversion"],
  compression: ["breakout_expansion"],
  breakout_expansion: ["breakout_expansion"],
  spike_zone: ["spike_event"],
  no_trade: [],
};

export function classifyRegime(features: FeatureVector): RegimeClassification {
  const instrumentFamily = classifyInstrument(features.symbol);
  const isBoomCrash = instrumentFamily === "boom" || instrumentFamily === "crash";

  let regime: RegimeState;
  let confidence: number;

  const slopeAbs = Math.abs(features.emaSlope);
  const isSqueeze = features.bbWidth < 0.005;
  const isExpanding = features.bbWidthRoc > 0.15 && features.atrAccel > 0.10;
  const isOverstretched = Math.abs(features.zScore) > 2.0;
  const rsiExtreme = features.rsi14 < 28 || features.rsi14 > 72;
  const strongTrend = slopeAbs > 0.0005;
  const veryStrongTrend = slopeAbs > 0.001;
  const highVol = features.atr14 > 0.004;
  const spikeImminent = isBoomCrash && features.spikeHazardScore > 0.72;

  if (spikeImminent) {
    regime = "spike_zone";
    confidence = Math.min(0.95, 0.5 + features.spikeHazardScore * 0.5);
  } else if (isSqueeze && !isExpanding && slopeAbs < 0.0003) {
    regime = "compression";
    confidence = Math.min(0.90, 0.6 + (0.005 - features.bbWidth) * 100);
  } else if (isExpanding && (features.atrRank > 1.2 || highVol)) {
    regime = "breakout_expansion";
    confidence = Math.min(0.90, 0.5 + features.bbWidthRoc + features.atrAccel * 0.5);
  } else if (isOverstretched && rsiExtreme && !veryStrongTrend) {
    regime = "mean_reversion";
    confidence = Math.min(0.90, 0.5 + Math.abs(features.zScore) * 0.15 + (rsiExtreme ? 0.1 : 0));
  } else if (veryStrongTrend) {
    regime = features.emaSlope > 0 ? "trend_up" : "trend_down";
    confidence = Math.min(0.95, 0.5 + slopeAbs * 500);
  } else if (strongTrend && !isOverstretched) {
    regime = features.emaSlope > 0 ? "trend_up" : "trend_down";
    confidence = Math.min(0.80, 0.4 + slopeAbs * 400);
  } else {
    const conflictingSignals =
      (features.rsi14 > 40 && features.rsi14 < 60) &&
      slopeAbs < 0.0002 &&
      features.bbWidth > 0.003 && features.bbWidth < 0.012;

    if (conflictingSignals) {
      regime = "no_trade";
      confidence = 0.6;
    } else if (isOverstretched || rsiExtreme) {
      regime = "mean_reversion";
      confidence = 0.55;
    } else {
      regime = "no_trade";
      confidence = 0.5;
    }
  }

  const allowedFamilies = STRATEGY_PERMISSION_MATRIX[regime];

  const macroBiasModifier = computeMacroBias(features, instrumentFamily);

  return { regime, confidence, allowedFamilies, instrumentFamily, macroBiasModifier };
}

function computeMacroBias(features: FeatureVector, instrumentFamily: InstrumentFamily): number {
  const hour = features.hourOfDay;
  const dow = features.dayOfWeek;
  const isBoom = instrumentFamily === "boom";
  const isCrash = instrumentFamily === "crash";

  let modifier = 0;

  const isHighActivity = (hour >= 8 && hour <= 11) || (hour >= 14 && hour <= 17);
  const isLowActivity = hour >= 0 && hour <= 4;
  const isWeekday = dow >= 1 && dow <= 5;

  if (isHighActivity) modifier += 0.05;
  if (isLowActivity) modifier -= 0.08;
  if (isWeekday) modifier += 0.02;

  if (isBoom || isCrash) {
    const trendAligned = isBoom
      ? features.emaSlope > 0.0001
      : features.emaSlope < -0.0001;
    if (trendAligned) modifier += 0.06;

    const momentumConfirms = isBoom
      ? features.rsi14 > 45 && features.rsi14 < 70
      : features.rsi14 > 30 && features.rsi14 < 55;
    if (momentumConfirms) modifier += 0.04;

    const crossCorrConfirms = isBoom
      ? features.crossCorrelation < -0.3
      : features.crossCorrelation > 0.3;
    if (crossCorrConfirms) modifier += 0.04;

    const skewFavorable = isBoom
      ? features.rollingSkew > 0.1
      : features.rollingSkew < -0.1;
    if (skewFavorable) modifier += 0.03;
  }

  const volatilityModerate = features.atrRank > 0.3 && features.atrRank < 1.5;
  if (volatilityModerate) modifier += 0.02;

  return Math.max(-0.15, Math.min(0.15, modifier));
}

export function isStrategyAllowedForRegime(family: StrategyFamily, regime: RegimeState): boolean {
  return STRATEGY_PERMISSION_MATRIX[regime].includes(family);
}

export function getCorrelatedInstruments(symbol: string): string[] {
  const family = classifyInstrument(symbol);
  const num = symbol.replace(/[A-Z_]/g, "");

  const correlated: string[] = [];

  if (family === "boom") {
    correlated.push(`CRASH${num}`);
    ["1000", "500", "300", "200"].forEach(n => {
      if (n !== num) {
        correlated.push(`BOOM${n}`);
      }
    });
  } else if (family === "crash") {
    correlated.push(`BOOM${num}`);
    ["1000", "500", "300", "200"].forEach(n => {
      if (n !== num) {
        correlated.push(`CRASH${n}`);
      }
    });
  } else if (family === "volatility") {
    if (symbol === "R_75") correlated.push("R_100");
    if (symbol === "R_100") correlated.push("R_75");
  }

  return correlated;
}
