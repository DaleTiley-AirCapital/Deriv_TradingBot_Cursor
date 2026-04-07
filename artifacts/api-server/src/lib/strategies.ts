import type { FeatureVector, SpikeMagnitudeStats } from "./features.js";
import { computeScoringDimensions, computeCompositeScore, type ScoringWeights } from "./scoring.js";
import { classifyRegime, getCachedRegime, cacheRegime, getHourlyAveragedFeatures, type StrategyFamily, type RegimeClassification } from "./regimeEngine.js";

interface SymbolEmpiricalData {
  avgWinPct: number;
  avgLossPct: number;
  medianHoldDays: number;
  swingsPerMonth: number;
  avgUpMagnitude: number;
  avgDownMagnitude: number;
}

const SYMBOL_EMPIRICAL_DATA: Record<string, SymbolEmpiricalData> = {
  CRASH300: { avgWinPct: 0.42, avgLossPct: 0.084, medianHoldDays: 8, swingsPerMonth: 3.1, avgUpMagnitude: 0.421, avgDownMagnitude: 0.290 },
  BOOM300:  { avgWinPct: 0.30, avgLossPct: 0.06,  medianHoldDays: 6, swingsPerMonth: 3.6, avgUpMagnitude: 0.302, avgDownMagnitude: 0.257 },
  R_75:     { avgWinPct: 0.18, avgLossPct: 0.036, medianHoldDays: 5, swingsPerMonth: 5.9, avgUpMagnitude: 0.178, avgDownMagnitude: 0.182 },
  R_100:    { avgWinPct: 0.17, avgLossPct: 0.034, medianHoldDays: 2, swingsPerMonth: 14.2, avgUpMagnitude: 0.173, avgDownMagnitude: 0.153 },
};

function getSymbolEmpirical(symbol: string): SymbolEmpiricalData {
  if (SYMBOL_EMPIRICAL_DATA[symbol]) return SYMBOL_EMPIRICAL_DATA[symbol];
  if (symbol.startsWith("CRASH")) return SYMBOL_EMPIRICAL_DATA.CRASH300;
  if (symbol.startsWith("BOOM"))  return SYMBOL_EMPIRICAL_DATA.BOOM300;
  if (symbol.startsWith("R_"))    return SYMBOL_EMPIRICAL_DATA.R_75;
  return SYMBOL_EMPIRICAL_DATA.R_75;
}

export interface SignalMetadata {
  expectedMovePct: number;
  expectedHoldDays: number;
  captureRate: number;
  empiricalWinRate: number;
}

export function computeSignalMetadata(features: FeatureVector, direction: "buy" | "sell"): SignalMetadata {
  const emp = getSymbolEmpirical(features.symbol);
  const avgMag = direction === "buy" ? emp.avgUpMagnitude : emp.avgDownMagnitude;
  const distLow  = Math.abs(features.distFromRange30dLowPct);
  const distHigh = Math.abs(features.distFromRange30dHighPct);
  const rangePos = direction === "buy" ? distLow : distHigh;
  const captureRate = Math.min(0.95, Math.max(0.4, 1 - rangePos * 3));
  const expectedMovePct = avgMag * captureRate;
  const expectedHoldDays = emp.medianHoldDays;
  const empiricalWinRate = Math.min(0.90, emp.swingsPerMonth / 30 * emp.medianHoldDays * 1.5);
  return { expectedMovePct, expectedHoldDays, captureRate, empiricalWinRate: Math.max(0.5, empiricalWinRate) };
}

export function computeBigMoveReadiness(
  features: FeatureVector,
  family: StrategyFamily,
  direction: "buy" | "sell",
): { score: number; confidence: number; expectedValue: number } {
  const emp = getSymbolEmpirical(features.symbol);
  let readiness = 0;
  let factors = 0;

  const distLow  = Math.abs(features.distFromRange30dLowPct);
  const distHigh = Math.abs(features.distFromRange30dHighPct);

  if (direction === "buy") {
    if      (distLow <= 0.03) { readiness += 1.0; factors++; }
    else if (distLow <= 0.10) { readiness += 0.7; factors++; }
    else if (distLow <= 0.18) { readiness += 0.4; factors++; }
    else                       { readiness += 0.15; factors++; }
  } else {
    if      (distHigh <= 0.03) { readiness += 1.0; factors++; }
    else if (distHigh <= 0.10) { readiness += 0.7; factors++; }
    else if (distHigh <= 0.18) { readiness += 0.4; factors++; }
    else                        { readiness += 0.15; factors++; }
  }

  const maDist = features.emaDist;
  if (direction === "buy") {
    if      (maDist < -0.06) { readiness += 1.0; factors++; }
    else if (maDist < -0.03) { readiness += 0.75; factors++; }
    else if (maDist < -0.01) { readiness += 0.5; factors++; }
    else                      { readiness += 0.2; factors++; }
  } else {
    if      (maDist > 0.06) { readiness += 1.0; factors++; }
    else if (maDist > 0.03) { readiness += 0.75; factors++; }
    else if (maDist > 0.01) { readiness += 0.5; factors++; }
    else                     { readiness += 0.2; factors++; }
  }

  if      (features.atrRank >= 1.3) { readiness += 0.9; factors++; }
  else if (features.atrRank >= 1.0) { readiness += 0.6; factors++; }
  else if (features.atrRank >= 0.7) { readiness += 0.4; factors++; }
  else                               { readiness += 0.2; factors++; }

  if      (features.bbWidthRoc > 0.08 || features.atrAccel > 0.08) { readiness += 0.8; factors++; }
  else if (features.bbWidthRoc > 0.03 || features.atrAccel > 0.03) { readiness += 0.5; factors++; }
  else                                                               { readiness += 0.25; factors++; }

  const slopeAligned   = (direction === "buy" && features.emaSlope > 0) || (direction === "sell" && features.emaSlope < 0);
  const reversalCandle = (direction === "buy" && features.latestClose > features.latestOpen) || (direction === "sell" && features.latestClose < features.latestOpen);
  const multiDaySetup  = (direction === "buy" && features.priceChange7dPct < -0.05) || (direction === "sell" && features.priceChange7dPct > 0.05);
  const rsiConfirm     = (direction === "buy" && features.rsi14 < 35) || (direction === "sell" && features.rsi14 > 65);

  let confirmScore = 0;
  if (slopeAligned)   confirmScore += 0.3;
  if (reversalCandle) confirmScore += 0.25;
  if (multiDaySetup)  confirmScore += 0.25;
  if (rsiConfirm)     confirmScore += 0.2;
  readiness += Math.min(1.0, confirmScore);
  factors++;

  if (family === "spike_cluster_recovery") {
    const isBoomCrash = features.symbol.startsWith("BOOM") || features.symbol.startsWith("CRASH");
    if (isBoomCrash) {
      const clusterDensity = Math.min(1, features.spikeCount4h / 8);
      if (clusterDensity > 0.3) { readiness += clusterDensity * 0.8; factors++; }
    }
  }
  if (family === "swing_exhaustion") {
    const exhaustion = Math.min(1, Math.abs(features.priceChange7dPct) / 0.15);
    if (exhaustion > 0.4) { readiness += exhaustion * 0.7; factors++; }
  }

  const normalizedScore = factors > 0 ? readiness / factors : 0;
  const score = Math.min(0.95, normalizedScore);
  const confidence = Math.max(0.1, Math.min(0.95, score * 1.1 - 0.05));
  const winProb = score;
  const expectedValue = winProb * emp.avgWinPct - (1 - winProb) * emp.avgLossPct;
  return { score, confidence, expectedValue };
}


interface TrendContinuationThresholds {
  distFromRangeLow: number;
  distFromRangeHigh: number;
  priceChange24hEntry: number;
  priceChange24hConfirm: number;
  emaSlope: number;
  rsiLow: number;
  rsiHigh: number;
  notOverextended: number;
  emaDist?: number;
}

interface MeanReversionThresholds {
  distFromRange: number;
  priceChange7d: number;
  rsi: number;
  zScore?: number;
}

interface SpikeClusterThresholds {
  spikeCount4h: number;
  spikeCount24h: number;
  priceChange24h: number;
  emaSlopeFlattening: number;
  candleBody: number;
}

interface SwingExhaustionThresholds {
  spikeCount7d: number;
  priceChange7d: number;
  distFromRange: number;
  priceChange24hFail: number;
  emaSlopeTurning: number;
  rsiExtreme?: number;
}

interface TrendlineBreakoutThresholds {
  minTouches: number;
  atrAccel: number;
  candleBody: number;
  atrMultiplier: number;
}

interface SymbolThresholds {
  trend_continuation: TrendContinuationThresholds;
  mean_reversion: MeanReversionThresholds;
  spike_cluster_recovery: SpikeClusterThresholds;
  swing_exhaustion: SwingExhaustionThresholds;
  trendline_breakout: TrendlineBreakoutThresholds;
}

const CRASH_THRESHOLDS: SymbolThresholds = {
  trend_continuation: {
    distFromRangeLow: 0.05,
    distFromRangeHigh: -0.03,
    priceChange24hEntry: 0.008,
    priceChange24hConfirm: 0.008,
    emaSlope: 0.00015,
    rsiLow: 30,
    rsiHigh: 72,
    notOverextended: -0.03,
  },
  mean_reversion: {
    distFromRange: 0.05,
    priceChange7d: -0.08,
    rsi: 38,
  },
  spike_cluster_recovery: {
    spikeCount4h: 3,
    spikeCount24h: 4,
    priceChange24h: -0.04,
    emaSlopeFlattening: -0.00015,
    candleBody: 0.45,
  },
  swing_exhaustion: {
    spikeCount7d: 10,
    priceChange7d: 0.06,
    distFromRange: -0.06,
    priceChange24hFail: 0.003,
    emaSlopeTurning: 0.00015,
  },
  trendline_breakout: {
    minTouches: 2,
    atrAccel: 0.008,
    candleBody: 0.28,
    atrMultiplier: 2.5,
  },
};

const BOOM_THRESHOLDS: SymbolThresholds = {
  trend_continuation: {
    distFromRangeLow: 0.03,
    distFromRangeHigh: -0.05,
    priceChange24hEntry: -0.008,
    priceChange24hConfirm: -0.008,
    emaSlope: -0.00015,
    rsiLow: 28,
    rsiHigh: 67,
    notOverextended: 0.03,
  },
  mean_reversion: {
    distFromRange: -0.05,
    priceChange7d: 0.08,
    rsi: 62,
  },
  spike_cluster_recovery: {
    spikeCount4h: 3,
    spikeCount24h: 4,
    priceChange24h: 0.04,
    emaSlopeFlattening: 0.00015,
    candleBody: 0.45,
  },
  swing_exhaustion: {
    spikeCount7d: 10,
    priceChange7d: -0.06,
    distFromRange: 0.06,
    priceChange24hFail: -0.003,
    emaSlopeTurning: -0.00015,
  },
  trendline_breakout: {
    minTouches: 2,
    atrAccel: 0.008,
    candleBody: 0.28,
    atrMultiplier: 2.5,
  },
};

const R75_THRESHOLDS: SymbolThresholds = {
  trend_continuation: {
    distFromRangeLow: 0.08,
    distFromRangeHigh: -0.08,
    priceChange24hEntry: 0.004,
    priceChange24hConfirm: 0.004,
    emaSlope: 0.00025,
    rsiLow: 33,
    rsiHigh: 67,
    notOverextended: -0.08,
    emaDist: 0.012,
  },
  mean_reversion: {
    distFromRange: 0.05,
    priceChange7d: -0.07,
    rsi: 33,
    zScore: -1.3,
  },
  spike_cluster_recovery: {
    spikeCount4h: 3,
    spikeCount24h: 5,
    priceChange24h: -0.05,
    emaSlopeFlattening: -0.0002,
    candleBody: 0.40,
  },
  swing_exhaustion: {
    spikeCount7d: 0,
    priceChange7d: 0.08,
    distFromRange: -0.04,
    priceChange24hFail: 0.003,
    emaSlopeTurning: 0.0001,
    rsiExtreme: 70,
  },
  trendline_breakout: {
    minTouches: 2,
    atrAccel: 0.01,
    candleBody: 0.30,
    atrMultiplier: 2.5,
  },
};

const R100_THRESHOLDS: SymbolThresholds = {
  trend_continuation: {
    distFromRangeLow: 0.06,
    distFromRangeHigh: -0.06,
    priceChange24hEntry: 0.003,
    priceChange24hConfirm: 0.003,
    emaSlope: 0.0002,
    rsiLow: 32,
    rsiHigh: 68,
    notOverextended: -0.06,
    emaDist: 0.012,
  },
  mean_reversion: {
    distFromRange: 0.04,
    priceChange7d: -0.06,
    rsi: 32,
    zScore: -1.2,
  },
  spike_cluster_recovery: {
    spikeCount4h: 3,
    spikeCount24h: 5,
    priceChange24h: -0.05,
    emaSlopeFlattening: -0.0002,
    candleBody: 0.40,
  },
  swing_exhaustion: {
    spikeCount7d: 0,
    priceChange7d: 0.07,
    distFromRange: -0.04,
    priceChange24hFail: 0.003,
    emaSlopeTurning: 0.0001,
    rsiExtreme: 68,
  },
  trendline_breakout: {
    minTouches: 2,
    atrAccel: 0.01,
    candleBody: 0.30,
    atrMultiplier: 2.5,
  },
};

const DEFAULT_VOL_THRESHOLDS: SymbolThresholds = R75_THRESHOLDS;

function getSymbolThresholds(symbol: string): SymbolThresholds {
  if (symbol === "CRASH300") return CRASH_THRESHOLDS;
  if (symbol === "BOOM300") return BOOM_THRESHOLDS;
  if (symbol === "R_75") return R75_THRESHOLDS;
  if (symbol === "R_100") return R100_THRESHOLDS;
  if (symbol.startsWith("CRASH")) return CRASH_THRESHOLDS;
  if (symbol.startsWith("BOOM")) return BOOM_THRESHOLDS;
  if (symbol.startsWith("R_")) return DEFAULT_VOL_THRESHOLDS;
  return R75_THRESHOLDS;
}

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
  spikeMagnitude?: SpikeMagnitudeStats | null;
  majorSwingHigh?: number;
  majorSwingLow?: number;
  expectedMovePct?: number;
  expectedHoldDays?: number;
  captureRate?: number;
  empiricalWinRate?: number;
}

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
  const meta = computeSignalMetadata(features, direction);
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
    spikeMagnitude: features.spikeMagnitude,
    majorSwingHigh: features.majorSwingHigh,
    majorSwingLow: features.majorSwingLow,
    expectedMovePct: meta.expectedMovePct,
    expectedHoldDays: meta.expectedHoldDays,
    captureRate: meta.captureRate,
    empiricalWinRate: meta.empiricalWinRate,
  };
}

function trendContinuation(features: FeatureVector, regime: RegimeClassification): SignalCandidate | null {
  const isBoom = features.symbol.startsWith("BOOM");
  const isCrash = features.symbol.startsWith("CRASH");
  const isVol = features.symbol.startsWith("R_");
  const th = getSymbolThresholds(features.symbol).trend_continuation;

  let direction: "buy" | "sell" | null = null;
  let reason = "";

  if (isCrash) {
    const confirmedSwingLow = features.distFromRange30dLowPct < th.distFromRangeLow && features.priceChange24hPct > Math.abs(th.priceChange24hEntry);
    const driftUp = features.emaSlope > Math.abs(th.emaSlope);
    const notExhausted = features.rsi14 > th.rsiLow && features.rsi14 < th.rsiHigh;
    const trendConfirmed = features.priceChange24hPct > Math.abs(th.priceChange24hConfirm);
    const notOverextended = features.distFromRange30dHighPct < th.notOverextended;

    if (confirmedSwingLow && driftUp && notExhausted && trendConfirmed && notOverextended) {
      direction = "buy";
      reason = `Crash drift up after swing low: slope=${features.emaSlope.toFixed(5)}, 24h_change=${(features.priceChange24hPct*100).toFixed(2)}%, dist_30d_low=${(features.distFromRange30dLowPct*100).toFixed(2)}%`;
    }
  } else if (isBoom) {
    const confirmedSwingHigh = features.distFromRange30dHighPct > th.distFromRangeHigh && features.priceChange24hPct < th.priceChange24hEntry;
    const driftDown = features.emaSlope < th.emaSlope;
    const notExhausted = features.rsi14 > th.rsiLow && features.rsi14 < th.rsiHigh;
    const trendConfirmed = features.priceChange24hPct < th.priceChange24hConfirm;
    const notOverextended = features.distFromRange30dLowPct > th.notOverextended;

    if (confirmedSwingHigh && driftDown && notExhausted && trendConfirmed && notOverextended) {
      direction = "sell";
      reason = `Boom drift down after swing high: slope=${features.emaSlope.toFixed(5)}, 24h_change=${(features.priceChange24hPct*100).toFixed(2)}%, dist_30d_high=${(features.distFromRange30dHighPct*100).toFixed(2)}%`;
    }
  } else if (isVol) {
    const maxEmaDist = th.emaDist ?? 0.01;
    const confirmedReversalUp = features.priceChange24hPct > Math.abs(th.priceChange24hEntry) && features.distFromRange30dLowPct < th.distFromRangeLow;
    const confirmedReversalDown = features.priceChange24hPct < -Math.abs(th.priceChange24hEntry) && features.distFromRange30dHighPct > th.distFromRangeHigh;
    const pulledBack = Math.abs(features.emaDist) < maxEmaDist;
    const rsiNeutral = features.rsi14 > th.rsiLow && features.rsi14 < th.rsiHigh;

    if (confirmedReversalUp && features.emaSlope > Math.abs(th.emaSlope) && pulledBack && rsiNeutral) {
      direction = "buy";
      reason = `Vol continuation after swing low reversal: slope=${features.emaSlope.toFixed(5)}, pullback=${(features.emaDist*100).toFixed(3)}%, dist_30d_low=${(features.distFromRange30dLowPct*100).toFixed(2)}%`;
    } else if (confirmedReversalDown && features.emaSlope < -Math.abs(th.emaSlope) && pulledBack && rsiNeutral) {
      direction = "sell";
      reason = `Vol continuation after swing high reversal: slope=${features.emaSlope.toFixed(5)}, pullback=${(features.emaDist*100).toFixed(3)}%, dist_30d_high=${(features.distFromRange30dHighPct*100).toFixed(2)}%`;
    }
  }

  if (!direction) return null;

  const { score, confidence, expectedValue } = computeBigMoveReadiness(features, "trend_continuation", direction);

  return buildCandidate(features, regime, "trend_continuation", direction, score, confidence, expectedValue, reason, "trend_continuation");
}

function meanReversion(features: FeatureVector, regime: RegimeClassification): SignalCandidate | null {
  const isBoom = features.symbol.startsWith("BOOM");
  const isCrash = features.symbol.startsWith("CRASH");
  const th = getSymbolThresholds(features.symbol).mean_reversion;

  let direction: "buy" | "sell" | null = null;
  let reason = "";

  if (isCrash) {
    const nearRange30dLow = features.distFromRange30dLowPct < th.distFromRange;
    const multiDayDecline = features.priceChange7dPct < th.priceChange7d;
    if (nearRange30dLow && multiDayDecline && features.rsi14 < th.rsi) {
      direction = "buy";
      reason = `Crash range low reversal: dist_from_30d_low=${(features.distFromRange30dLowPct*100).toFixed(2)}%, 7d_change=${(features.priceChange7dPct*100).toFixed(2)}%, RSI=${features.rsi14.toFixed(1)}`;
    }
  } else if (isBoom) {
    const nearRange30dHigh = features.distFromRange30dHighPct > th.distFromRange;
    const multiDayRally = features.priceChange7dPct > Math.abs(th.priceChange7d);
    if (nearRange30dHigh && multiDayRally && features.rsi14 > th.rsi) {
      direction = "sell";
      reason = `Boom range high reversal: dist_from_30d_high=${(features.distFromRange30dHighPct*100).toFixed(2)}%, 7d_change=${(features.priceChange7dPct*100).toFixed(2)}%, RSI=${features.rsi14.toFixed(1)}`;
    }
  } else {
    const zThreshold = th.zScore ?? -1.5;
    const nearRange30dLow = features.distFromRange30dLowPct < th.distFromRange;
    const nearRange30dHigh = features.distFromRange30dHighPct > -th.distFromRange;
    const multiDayDecline = features.priceChange7dPct < th.priceChange7d;
    const multiDayRally = features.priceChange7dPct > Math.abs(th.priceChange7d);

    if (nearRange30dLow && multiDayDecline && features.zScore < zThreshold) {
      direction = "buy";
      reason = `Range low mean reversion: dist_from_30d_low=${(features.distFromRange30dLowPct*100).toFixed(2)}%, 7d_change=${(features.priceChange7dPct*100).toFixed(2)}%, z=${features.zScore.toFixed(2)}`;
    } else if (nearRange30dHigh && multiDayRally && features.zScore > Math.abs(zThreshold)) {
      direction = "sell";
      reason = `Range high mean reversion: dist_from_30d_high=${(features.distFromRange30dHighPct*100).toFixed(2)}%, 7d_change=${(features.priceChange7dPct*100).toFixed(2)}%, z=${features.zScore.toFixed(2)}`;
    }
  }

  const sweepSetup = features.swingBreached && features.swingReclaimed &&
    features.swingBreachCandles >= 0 && features.swingBreachCandles <= 3 &&
    features.candleBody < 0.35;

  if (!direction && sweepSetup) {
    if (features.swingBreachDirection === "above") {
      direction = "sell";
      reason = `Liquidity sweep above swing high: breach ${features.swingBreachCandles} candles ago`;
    } else if (features.swingBreachDirection === "below") {
      direction = "buy";
      reason = `Liquidity sweep below swing low: breach ${features.swingBreachCandles} candles ago`;
    }
  }

  if (!direction) return null;

  const { score, confidence, expectedValue } = computeBigMoveReadiness(features, "mean_reversion", direction);

  return buildCandidate(features, regime, "mean_reversion", direction, score, confidence, expectedValue, `[${regime.regime}] ${reason}`, "mean_reversion");
}

function spikeClusterRecovery(features: FeatureVector, regime: RegimeClassification): SignalCandidate | null {
  const isBoom = features.symbol.startsWith("BOOM");
  const isCrash = features.symbol.startsWith("CRASH");

  if (!isBoom && !isCrash) return null;

  const th = getSymbolThresholds(features.symbol).spike_cluster_recovery;

  const hasCluster4h = features.spikeCount4h >= th.spikeCount4h;
  const hasModerateCluster = features.spikeCount24h >= th.spikeCount24h;

  if (!hasCluster4h && !hasModerateCluster) return null;

  let direction: "buy" | "sell" | null = null;
  let reason: string = "";

  if (isCrash) {
    const priceDeclined24h = features.priceChange24hPct < th.priceChange24h;
    const reversalCandle = features.latestClose > features.latestOpen;
    const candleSmall = features.candleBody < th.candleBody;
    const slopeFlattening = features.emaSlope > th.emaSlopeFlattening;

    if (priceDeclined24h && reversalCandle && candleSmall && slopeFlattening) {
      direction = "buy";
      reason = `Crash spike cluster → BUY: ${features.spikeCount4h} spikes/4h, ${features.spikeCount24h}/24h, 24h_decline=${(features.priceChange24hPct*100).toFixed(2)}%, green reversal candle, slope=${features.emaSlope.toFixed(5)}`;
    }
  } else {
    const priceRallied24h = features.priceChange24hPct > Math.abs(th.priceChange24h);
    const reversalCandle = features.latestClose < features.latestOpen;
    const candleSmall = features.candleBody < th.candleBody;
    const slopeFlattening = features.emaSlope < Math.abs(th.emaSlopeFlattening);

    if (priceRallied24h && reversalCandle && candleSmall && slopeFlattening) {
      direction = "sell";
      reason = `Boom spike cluster → SELL: ${features.spikeCount4h} spikes/4h, ${features.spikeCount24h}/24h, 24h_rally=${(features.priceChange24hPct*100).toFixed(2)}%, red reversal candle, slope=${features.emaSlope.toFixed(5)}`;
    }
  }

  if (!direction) return null;

  const { score, confidence, expectedValue } = computeBigMoveReadiness(features, "spike_cluster_recovery", direction);

  return buildCandidate(features, regime, "spike_cluster_recovery", direction, score, confidence, expectedValue, `[${regime.regime}] ${reason}`, "spike_cluster_recovery");
}

function swingExhaustion(features: FeatureVector, regime: RegimeClassification): SignalCandidate | null {
  const isBoom = features.symbol.startsWith("BOOM");
  const isCrash = features.symbol.startsWith("CRASH");
  const isVol = features.symbol.startsWith("R_");
  const th = getSymbolThresholds(features.symbol).swing_exhaustion;

  let direction: "buy" | "sell" | null = null;
  let reason = "";

  if (isCrash) {
    const highSpikeCount7d = th.spikeCount7d > 0 ? features.spikeCount7d >= th.spikeCount7d : true;
    const priceUp7d = features.priceChange7dPct > th.priceChange7d;
    const nearRangeHigh = features.distFromRange30dHighPct > th.distFromRange;
    const failedNewHigh24h = features.priceChange24hPct < th.priceChange24hFail;
    const turningDown = features.emaSlope < th.emaSlopeTurning;

    if (highSpikeCount7d && priceUp7d && nearRangeHigh && failedNewHigh24h && turningDown) {
      direction = "sell";
      reason = `Crash topping exhaustion: ${features.spikeCount7d} spikes/7d, up ${(features.priceChange7dPct*100).toFixed(1)}%/7d, failed new high 24h (${(features.priceChange24hPct*100).toFixed(2)}%), slope turning (${features.emaSlope.toFixed(5)})`;
    }
  } else if (isBoom) {
    const highSpikeCount7d = th.spikeCount7d > 0 ? features.spikeCount7d >= th.spikeCount7d : true;
    const priceDown7d = features.priceChange7dPct < th.priceChange7d;
    const nearRangeLow = features.distFromRange30dLowPct < Math.abs(th.distFromRange);
    const failedNewLow24h = features.priceChange24hPct > th.priceChange24hFail;
    const turningUp = features.emaSlope > th.emaSlopeTurning;

    if (highSpikeCount7d && priceDown7d && nearRangeLow && failedNewLow24h && turningUp) {
      direction = "buy";
      reason = `Boom bottoming exhaustion: ${features.spikeCount7d} spikes/7d, down ${(features.priceChange7dPct*100).toFixed(1)}%/7d, failed new low 24h (${(features.priceChange24hPct*100).toFixed(2)}%), slope turning (${features.emaSlope.toFixed(5)})`;
    }
  } else if (isVol) {
    const rsiExtremeHigh = th.rsiExtreme ?? 72;
    const rsiExtremeLow = 100 - rsiExtremeHigh;
    const bigRally = features.priceChange7dPct > th.priceChange7d && features.distFromRange30dHighPct > th.distFromRange;
    const bigDecline = features.priceChange7dPct < -th.priceChange7d && features.distFromRange30dLowPct < Math.abs(th.distFromRange);
    const rsiExtreme = features.rsi14 > rsiExtremeHigh || features.rsi14 < rsiExtremeLow;

    if (bigRally && rsiExtreme) {
      const failedNewHigh = features.priceChange24hPct < th.priceChange24hFail;
      if (failedNewHigh) {
        direction = "sell";
        reason = `Vol rally exhaustion: 7d=${(features.priceChange7dPct*100).toFixed(1)}%, RSI=${features.rsi14.toFixed(1)}, 24h reversal confirmed (${(features.priceChange24hPct*100).toFixed(2)}%)`;
      }
    } else if (bigDecline && rsiExtreme) {
      const failedNewLow = features.priceChange24hPct > -th.priceChange24hFail;
      if (failedNewLow) {
        direction = "buy";
        reason = `Vol decline exhaustion: 7d=${(features.priceChange7dPct*100).toFixed(1)}%, RSI=${features.rsi14.toFixed(1)}, 24h reversal confirmed (${(features.priceChange24hPct*100).toFixed(2)}%)`;
      }
    }
  }

  if (!direction) return null;

  const { score, confidence, expectedValue } = computeBigMoveReadiness(features, "swing_exhaustion", direction);

  return buildCandidate(features, regime, "swing_exhaustion", direction, score, confidence, expectedValue, `[${regime.regime}] ${reason}`, "swing_exhaustion");
}

function trendlineBreakout(features: FeatureVector, regime: RegimeClassification): SignalCandidate | null {
  const price = features.latestClose;
  const atrNorm = features.atr14;
  if (price <= 0 || atrNorm <= 0) return null;

  const th = getSymbolThresholds(features.symbol).trendline_breakout;

  const resTouches = features.trendlineResistanceTouches ?? 0;
  const supTouches = features.trendlineSupportTouches ?? 0;
  const resLevel = features.trendlineResistanceLevel ?? 0;
  const supLevel = features.trendlineSupportLevel ?? 0;
  const resSlope = features.trendlineResistanceSlope ?? 0;
  const supSlope = features.trendlineSupportSlope ?? 0;

  const hasResistanceTrendline = resTouches >= th.minTouches && resLevel > 0;
  const hasSupportTrendline = supTouches >= th.minTouches && supLevel > 0;

  if (!hasResistanceTrendline && !hasSupportTrendline) return null;

  const momentumConfirm = features.atrAccel > th.atrAccel && features.candleBody > th.candleBody;

  let direction: "buy" | "sell" | null = null;
  let reason = "";

  if (hasResistanceTrendline) {
    const breakDistPct = (price - resLevel) / price;
    const breakAbove = breakDistPct > 0 && breakDistPct < atrNorm * th.atrMultiplier && momentumConfirm && features.emaSlope > 0;

    if (breakAbove) {
      direction = "buy";
      reason = `Trendline breakout up: price=${price.toFixed(2)}, res=${resLevel.toFixed(2)}, touches=${resTouches}, slope=${resSlope.toFixed(6)}`;
    }
  }

  if (!direction && hasSupportTrendline) {
    const breakDistPct = (supLevel - price) / price;
    const breakBelow = breakDistPct > 0 && breakDistPct < atrNorm * th.atrMultiplier && momentumConfirm && features.emaSlope < 0;

    if (breakBelow) {
      direction = "sell";
      reason = `Trendline breakout down: price=${price.toFixed(2)}, sup=${supLevel.toFixed(2)}, touches=${supTouches}, slope=${supSlope.toFixed(6)}`;
    }
  }

  if (!direction) return null;

  const { score, confidence, expectedValue } = computeBigMoveReadiness(features, "trendline_breakout", direction);

  return buildCandidate(features, regime, "trendline_breakout", direction, score, confidence, expectedValue, `[${regime.regime}] ${reason}`, "trendline_breakout");
}

const FAMILY_RUNNERS: Record<StrategyFamily, (f: FeatureVector, r: RegimeClassification) => SignalCandidate | null> = {
  trend_continuation: trendContinuation,
  mean_reversion: meanReversion,
  spike_cluster_recovery: spikeClusterRecovery,
  swing_exhaustion: swingExhaustion,
  trendline_breakout: trendlineBreakout,
};

export function runAllStrategies(features: FeatureVector, weights?: ScoringWeights, cachedRegime?: RegimeClassification, explicitHourlyFeatures?: Partial<FeatureVector>): SignalCandidate[] {
  const regime = cachedRegime ?? classifyRegime(features);

  const candidates: SignalCandidate[] = [];

  for (const family of regime.allowedFamilies) {
    const runner = FAMILY_RUNNERS[family];
    if (!runner) continue;
    const candidate = runner(features, regime);
    if (candidate) candidates.push(candidate);
  }

  for (const candidate of candidates) {
    const dims = computeScoringDimensions(features, candidate);
    candidate.dimensions = dims;
    candidate.compositeScore = computeCompositeScore(dims, weights);
  }

  return candidates;
}
