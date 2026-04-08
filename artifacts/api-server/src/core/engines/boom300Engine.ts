import type { EngineContext, EngineResult } from "../engineTypes.js";

const ENGINE_NAME = "boom_expansion_engine";
const SYMBOL = "BOOM300";

// BOOM300 empirical calibration (6-month research)
// Boom spikes go UP → price rises during spike clusters
// SELL after boom spike cluster + sustained rally + exhaustion
// BUY  after sustained drift-down + RSI oversold + no recent spikes
const BOOM_PROJECTED_SELL_PCT = 0.257;
const BOOM_PROJECTED_BUY_PCT  = 0.302;

export function boom300Engine(ctx: EngineContext): EngineResult | null {
  const { features, operationalRegime, regimeConfidence } = ctx;
  const f = features;

  if (f.symbol !== SYMBOL && !f.symbol.startsWith("BOOM")) return null;

  const symbol = f.symbol;
  const latestClose = f.latestClose;

  // ── SELL setup ─────────────────────────────────────────────────────────────
  // After boom spike cluster exhaustion: price near range high, RSI overbought,
  // spike hazard elevated, EMA slope turning negative
  const nearRangeHigh  = Math.abs(f.distFromRange30dHighPct) <= 0.12;
  const rsiOverbought  = f.rsi14 >= 62;
  const spikeHazardHigh = f.spikeHazardScore >= 0.55;
  const emaSlopeNeg    = f.emaSlope < -0.0002;
  const recentSpike    = f.runLengthSinceSpike <= 30;
  const bbUpperPressure = f.bbPctB >= 0.78;

  const sellSignals = [
    nearRangeHigh,
    rsiOverbought,
    spikeHazardHigh,
    emaSlopeNeg,
    recentSpike,
    bbUpperPressure,
  ].filter(Boolean).length;

  // ── BUY setup ──────────────────────────────────────────────────────────────
  // After sustained drift-down: price near range low, RSI oversold, low spike
  // hazard (no recent boom spikes to push further down), EMA slope bottoming
  const nearRangeLow   = Math.abs(f.distFromRange30dLowPct) <= 0.10;
  const rsiOversold    = f.rsi14 <= 38;
  const spikeHazardLow = f.spikeHazardScore <= 0.35;
  const emaSlopeFlat   = f.emaSlope > -0.0001;
  const noRecentSpike  = f.runLengthSinceSpike >= 80;
  const bbLowerPressure = f.bbPctB <= 0.22;

  const buySignals = [
    nearRangeLow,
    rsiOversold,
    spikeHazardLow,
    emaSlopeFlat,
    noRecentSpike,
    bbLowerPressure,
  ].filter(Boolean).length;

  let direction: "buy" | "sell";
  let signalCount: number;
  let projectedMovePct: number;
  let invalidation: number;

  if (sellSignals >= 4 && sellSignals >= buySignals) {
    direction = "sell";
    signalCount = sellSignals;
    projectedMovePct = BOOM_PROJECTED_SELL_PCT;
    invalidation = f.swingHigh * 1.005;
  } else if (buySignals >= 4 && buySignals > sellSignals) {
    direction = "buy";
    signalCount = buySignals;
    projectedMovePct = BOOM_PROJECTED_BUY_PCT;
    invalidation = f.swingLow * 0.995;
  } else {
    return null;
  }

  const rawConfidence = signalCount / 6;

  // Regime modifier: boom_expansion regime boosts sell, trend_down boosts buy
  let regimeFit = 0.5;
  if (direction === "sell") {
    if (operationalRegime === "boom_expansion" || operationalRegime === "breakout_expansion") {
      regimeFit = 0.85;
    } else if (operationalRegime === "spike_zone") {
      regimeFit = 0.80;
    } else if (operationalRegime === "trend_up") {
      regimeFit = 0.65;
    } else if (operationalRegime === "trend_down" || operationalRegime === "no_trade") {
      return null;
    }
  } else {
    if (operationalRegime === "trend_down" || operationalRegime === "mean_reversion") {
      regimeFit = 0.82;
    } else if (operationalRegime === "ranging" || operationalRegime === "compression") {
      regimeFit = 0.70;
    } else if (operationalRegime === "boom_expansion" || operationalRegime === "spike_zone") {
      return null;
    }
  }

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
    reason: `boom_expansion ${direction}: ${signalCount}/6 signals (spikeHazard=${f.spikeHazardScore.toFixed(2)}, rsi=${f.rsi14.toFixed(1)}, regime=${operationalRegime})`,
    metadata: {
      nearRangeHigh,
      nearRangeLow,
      rsiOverbought,
      rsiOversold,
      spikeHazardScore: f.spikeHazardScore,
      runLengthSinceSpike: f.runLengthSinceSpike,
      emaSlope: f.emaSlope,
      bbPctB: f.bbPctB,
      distFromRangeHighPct: f.distFromRange30dHighPct,
      distFromRangeLowPct: f.distFromRange30dLowPct,
    },
  };
}
