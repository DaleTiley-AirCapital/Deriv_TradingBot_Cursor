import type { FeatureVector, SpikeMagnitudeStats } from "./features.js";
import { computeBigMoveReadiness } from "./model.js";
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
  spikeMagnitude?: SpikeMagnitudeStats | null;
  majorSwingHigh?: number;
  majorSwingLow?: number;
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
  };
}

function trendContinuation(features: FeatureVector, regime: RegimeClassification): SignalCandidate | null {
  const isBoom = features.symbol.startsWith("BOOM");
  const isCrash = features.symbol.startsWith("CRASH");
  const isVol = features.symbol.startsWith("R_");

  let direction: "buy" | "sell" | null = null;
  let reason = "";

  if (isCrash) {
    const confirmedSwingLow = features.distFromRange30dLowPct < 0.03 && features.priceChange24hPct > 0.005;
    const driftUp = features.emaSlope > 0.0002;
    const notExhausted = features.rsi14 > 35 && features.rsi14 < 70;
    const trendConfirmed = features.priceChange24hPct > 0.01;
    const notOverextended = features.distFromRange30dHighPct < -0.02;

    if (confirmedSwingLow && driftUp && notExhausted && trendConfirmed && notOverextended) {
      direction = "buy";
      reason = `Crash drift up after swing low: slope=${features.emaSlope.toFixed(5)}, 24h_change=${(features.priceChange24hPct*100).toFixed(2)}%, dist_30d_low=${(features.distFromRange30dLowPct*100).toFixed(2)}%`;
    }
  } else if (isBoom) {
    const confirmedSwingHigh = features.distFromRange30dHighPct > -0.03 && features.priceChange24hPct < -0.005;
    const driftDown = features.emaSlope < -0.0002;
    const notExhausted = features.rsi14 > 30 && features.rsi14 < 65;
    const trendConfirmed = features.priceChange24hPct < -0.01;
    const notOverextended = features.distFromRange30dLowPct > 0.02;

    if (confirmedSwingHigh && driftDown && notExhausted && trendConfirmed && notOverextended) {
      direction = "sell";
      reason = `Boom drift down after swing high: slope=${features.emaSlope.toFixed(5)}, 24h_change=${(features.priceChange24hPct*100).toFixed(2)}%, dist_30d_high=${(features.distFromRange30dHighPct*100).toFixed(2)}%`;
    }
  } else if (isVol) {
    const confirmedReversalUp = features.priceChange24hPct > 0.005 && features.distFromRange30dLowPct < 0.10;
    const confirmedReversalDown = features.priceChange24hPct < -0.005 && features.distFromRange30dHighPct > -0.10;
    const pulledBack = Math.abs(features.emaDist) < 0.01;
    const rsiNeutral = features.rsi14 > 35 && features.rsi14 < 65;

    if (confirmedReversalUp && features.emaSlope > 0.0003 && pulledBack && rsiNeutral) {
      direction = "buy";
      reason = `Vol continuation after swing low reversal: slope=${features.emaSlope.toFixed(5)}, pullback=${(features.emaDist*100).toFixed(3)}%, dist_30d_low=${(features.distFromRange30dLowPct*100).toFixed(2)}%`;
    } else if (confirmedReversalDown && features.emaSlope < -0.0003 && pulledBack && rsiNeutral) {
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

  let direction: "buy" | "sell" | null = null;
  let reason = "";

  const nearRange30dLow = features.distFromRange30dLowPct < 0.03;
  const nearRange30dHigh = features.distFromRange30dHighPct > -0.03;
  const multiDayDecline = features.priceChange7dPct < -0.05;
  const multiDayRally = features.priceChange7dPct > 0.05;

  if (isCrash) {
    if (nearRange30dLow && multiDayDecline && features.rsi14 < 35) {
      direction = "buy";
      reason = `Crash range low reversal: dist_from_30d_low=${(features.distFromRange30dLowPct*100).toFixed(2)}%, 7d_change=${(features.priceChange7dPct*100).toFixed(2)}%, RSI=${features.rsi14.toFixed(1)}`;
    }
  } else if (isBoom) {
    if (nearRange30dHigh && multiDayRally && features.rsi14 > 65) {
      direction = "sell";
      reason = `Boom range high reversal: dist_from_30d_high=${(features.distFromRange30dHighPct*100).toFixed(2)}%, 7d_change=${(features.priceChange7dPct*100).toFixed(2)}%, RSI=${features.rsi14.toFixed(1)}`;
    }
  } else {
    if (nearRange30dLow && multiDayDecline && features.zScore < -1.5) {
      direction = "buy";
      reason = `Range low mean reversion: dist_from_30d_low=${(features.distFromRange30dLowPct*100).toFixed(2)}%, 7d_change=${(features.priceChange7dPct*100).toFixed(2)}%, z=${features.zScore.toFixed(2)}`;
    } else if (nearRange30dHigh && multiDayRally && features.zScore > 1.5) {
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

  const hasCluster4h = features.spikeCount4h >= 3;
  const hasModerateCluster = features.spikeCount24h >= 5;

  if (!hasCluster4h && !hasModerateCluster) return null;

  let direction: "buy" | "sell" | null = null;
  let reason: string = "";

  if (isCrash) {
    const priceDeclined24h = features.priceChange24hPct < -0.05;
    const reversalCandle = features.latestClose > features.latestOpen;
    const candleSmall = features.candleBody < 0.40;
    const slopeFlattening = features.emaSlope > -0.0002;

    if (priceDeclined24h && reversalCandle && candleSmall && slopeFlattening) {
      direction = "buy";
      reason = `Crash spike cluster → BUY: ${features.spikeCount4h} spikes/4h, ${features.spikeCount24h}/24h, 24h_decline=${(features.priceChange24hPct*100).toFixed(2)}%, green reversal candle, slope=${features.emaSlope.toFixed(5)}`;
    }
  } else {
    const priceRallied24h = features.priceChange24hPct > 0.05;
    const reversalCandle = features.latestClose < features.latestOpen;
    const candleSmall = features.candleBody < 0.40;
    const slopeFlattening = features.emaSlope < 0.0002;

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

  let direction: "buy" | "sell" | null = null;
  let reason = "";

  if (isCrash) {
    const highSpikeCount7d = features.spikeCount7d >= 14;
    const priceUp7d = features.priceChange7dPct > 0.08;
    const nearRangeHigh = features.distFromRange30dHighPct > -0.05;
    const failedNewHigh24h = features.priceChange24hPct < 0.005;
    const turningDown = features.emaSlope < 0.0001;

    if (highSpikeCount7d && priceUp7d && nearRangeHigh && failedNewHigh24h && turningDown) {
      direction = "sell";
      reason = `Crash topping exhaustion: ${features.spikeCount7d} spikes/7d, up ${(features.priceChange7dPct*100).toFixed(1)}%/7d, failed new high 24h (${(features.priceChange24hPct*100).toFixed(2)}%), slope turning (${features.emaSlope.toFixed(5)})`;
    }
  } else if (isBoom) {
    const highSpikeCount7d = features.spikeCount7d >= 14;
    const priceDown7d = features.priceChange7dPct < -0.08;
    const nearRangeLow = features.distFromRange30dLowPct < 0.05;
    const failedNewLow24h = features.priceChange24hPct > -0.005;
    const turningUp = features.emaSlope > -0.0001;

    if (highSpikeCount7d && priceDown7d && nearRangeLow && failedNewLow24h && turningUp) {
      direction = "buy";
      reason = `Boom bottoming exhaustion: ${features.spikeCount7d} spikes/7d, down ${(features.priceChange7dPct*100).toFixed(1)}%/7d, failed new low 24h (${(features.priceChange24hPct*100).toFixed(2)}%), slope turning (${features.emaSlope.toFixed(5)})`;
    }
  } else if (isVol) {
    const bigRally = features.priceChange7dPct > 0.10 && features.distFromRange30dHighPct > -0.03;
    const bigDecline = features.priceChange7dPct < -0.10 && features.distFromRange30dLowPct < 0.03;
    const rsiExtreme = features.rsi14 > 72 || features.rsi14 < 28;

    if (bigRally && rsiExtreme) {
      const failedNewHigh = features.priceChange24hPct < 0.005;
      if (failedNewHigh) {
        direction = "sell";
        reason = `Vol rally exhaustion: 7d=${(features.priceChange7dPct*100).toFixed(1)}%, RSI=${features.rsi14.toFixed(1)}, 24h reversal confirmed (${(features.priceChange24hPct*100).toFixed(2)}%)`;
      }
    } else if (bigDecline && rsiExtreme) {
      const failedNewLow = features.priceChange24hPct > -0.005;
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

  const resTouches = features.trendlineResistanceTouches ?? 0;
  const supTouches = features.trendlineSupportTouches ?? 0;
  const resLevel = features.trendlineResistanceLevel ?? 0;
  const supLevel = features.trendlineSupportLevel ?? 0;
  const resSlope = features.trendlineResistanceSlope ?? 0;
  const supSlope = features.trendlineSupportSlope ?? 0;

  const hasResistanceTrendline = resTouches >= 2 && resLevel > 0;
  const hasSupportTrendline = supTouches >= 2 && supLevel > 0;

  if (!hasResistanceTrendline && !hasSupportTrendline) return null;

  const momentumConfirm = features.atrAccel > 0.01 && features.candleBody > 0.30;

  let direction: "buy" | "sell" | null = null;
  let reason = "";

  if (hasResistanceTrendline) {
    const breakDistPct = (price - resLevel) / price;
    const breakAbove = breakDistPct > 0 && breakDistPct < atrNorm * 2.5 && momentumConfirm && features.emaSlope > 0;

    if (breakAbove) {
      direction = "buy";
      reason = `Trendline breakout up: price=${price.toFixed(2)}, res=${resLevel.toFixed(2)}, touches=${resTouches}, slope=${resSlope.toFixed(6)}`;
    }
  }

  if (!direction && hasSupportTrendline) {
    const breakDistPct = (supLevel - price) / price;
    const breakBelow = breakDistPct > 0 && breakDistPct < atrNorm * 2.5 && momentumConfirm && features.emaSlope < 0;

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
    const dims = computeScoringDimensions(features, candidate);
    candidate.dimensions = dims;
    candidate.compositeScore = computeCompositeScore(dims, weights);
  }

  return candidates;
}
