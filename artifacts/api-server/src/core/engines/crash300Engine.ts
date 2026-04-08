import type { EngineContext, EngineResult } from "../engineTypes.js";

const ENGINE_NAME = "crash_expansion_engine";
const SYMBOL = "CRASH300";

// CRASH300 empirical calibration (6-month research)
// Crash spikes go DOWN → price falls during spike clusters
// BUY  after crash spike cluster + sustained decline + RSI oversold
// SELL after sustained rally + RSI overbought + increasing spike frequency
const CRASH_PROJECTED_BUY_PCT  = 0.421;
const CRASH_PROJECTED_SELL_PCT = 0.290;

export function crash300Engine(ctx: EngineContext): EngineResult | null {
  const { features, operationalRegime } = ctx;
  const f = features;

  if (f.symbol !== SYMBOL && !f.symbol.startsWith("CRASH")) return null;

  const symbol = f.symbol;

  // ── BUY setup ──────────────────────────────────────────────────────────────
  // After crash spike cluster: price near range low, RSI oversold,
  // spike hazard high (cluster), EMA slope negative (confirming decline), reversal
  const nearRangeLow   = Math.abs(f.distFromRange30dLowPct) <= 0.12;
  const rsiOversold    = f.rsi14 <= 38;
  const spikeHazardHigh = f.spikeHazardScore >= 0.55;
  const emaSlopeNeg    = f.emaSlope < -0.0002;
  const recentSpike    = f.runLengthSinceSpike <= 30;
  const bbLowerPressure = f.bbPctB <= 0.22;

  const buySignals = [
    nearRangeLow,
    rsiOversold,
    spikeHazardHigh,
    emaSlopeNeg,
    recentSpike,
    bbLowerPressure,
  ].filter(Boolean).length;

  // ── SELL setup ─────────────────────────────────────────────────────────────
  // After sustained rally: price near range high, RSI overbought,
  // spike hazard beginning to rise (early cluster signal), EMA slope topping
  const nearRangeHigh  = Math.abs(f.distFromRange30dHighPct) <= 0.10;
  const rsiOverbought  = f.rsi14 >= 62;
  const spikeHazardRising = f.spikeHazardScore >= 0.40;
  const emaSlopePos    = f.emaSlope > 0.0001;
  const noRecentSpike  = f.runLengthSinceSpike >= 60;
  const bbUpperPressure = f.bbPctB >= 0.78;

  const sellSignals = [
    nearRangeHigh,
    rsiOverbought,
    spikeHazardRising,
    emaSlopePos,
    noRecentSpike,
    bbUpperPressure,
  ].filter(Boolean).length;

  let direction: "buy" | "sell";
  let signalCount: number;
  let projectedMovePct: number;
  let invalidation: number;

  if (buySignals >= 4 && buySignals >= sellSignals) {
    direction = "buy";
    signalCount = buySignals;
    projectedMovePct = CRASH_PROJECTED_BUY_PCT;
    invalidation = f.swingLow * 0.995;
  } else if (sellSignals >= 4 && sellSignals > buySignals) {
    direction = "sell";
    signalCount = sellSignals;
    projectedMovePct = CRASH_PROJECTED_SELL_PCT;
    invalidation = f.swingHigh * 1.005;
  } else {
    return null;
  }

  let regimeFit = 0.5;
  if (direction === "buy") {
    if (operationalRegime === "crash_expansion" || operationalRegime === "spike_zone") {
      regimeFit = 0.88;
    } else if (operationalRegime === "trend_down" || operationalRegime === "mean_reversion") {
      regimeFit = 0.80;
    } else if (operationalRegime === "trend_up") {
      return null;
    }
  } else {
    if (operationalRegime === "trend_up" || operationalRegime === "breakout_expansion") {
      regimeFit = 0.82;
    } else if (operationalRegime === "ranging") {
      regimeFit = 0.65;
    } else if (operationalRegime === "crash_expansion" || operationalRegime === "spike_zone") {
      return null;
    }
  }

  const rawConfidence = signalCount / 6;
  const confidence = Math.min(0.95, rawConfidence * 0.6 + regimeFit * 0.4);

  return {
    valid: true,
    symbol,
    engineName: ENGINE_NAME,
    direction,
    confidence,
    regimeFit,
    entryType: "expansion",
    projectedMovePct,
    invalidation,
    reason: `crash_expansion ${direction}: ${signalCount}/6 signals (spikeHazard=${f.spikeHazardScore.toFixed(2)}, rsi=${f.rsi14.toFixed(1)}, regime=${operationalRegime})`,
    metadata: {
      nearRangeLow,
      nearRangeHigh,
      rsiOversold,
      rsiOverbought,
      spikeHazardScore: f.spikeHazardScore,
      runLengthSinceSpike: f.runLengthSinceSpike,
      emaSlope: f.emaSlope,
      bbPctB: f.bbPctB,
      distFromRangeLowPct: f.distFromRange30dLowPct,
      distFromRangeHighPct: f.distFromRange30dHighPct,
    },
  };
}
