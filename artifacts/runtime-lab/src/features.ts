import type { Candle, FeatureVector } from "./types.js";
import { pctChange, percentile } from "./math.js";

const BARS_1H = 60;
const BARS_4H = 240;
const BARS_24H = 1440;
const BARS_7D = 10080;
const BARS_30D = 43200;

export function computePointInTimeFeatures(candles: Candle[], index: number): FeatureVector | null {
  if (index < BARS_1H || index >= candles.length) return null;
  const current = candles[index];
  if (!current || current.isInterpolated) return null;

  const close = current.close;
  const atr14 = averageTrueRange(candles, index, 14);
  const atr60 = averageTrueRange(candles, index, 60);
  const atr240 = averageTrueRange(candles, index, 240);
  const atrRank4h = rankCurrent(rollingAtrSeries(candles, index, 240), atr14);
  const bbWidth60 = bollingerWidth(candles, index, 60);
  const bbWidth240 = bollingerWidth(candles, index, 240);
  const range7d = rangePosition(candles, index, BARS_7D);
  const range30d = rangePosition(candles, index, BARS_30D);
  const recentHigh20 = high(candles, index, 20);
  const recentLow20 = low(candles, index, 20);

  return {
    return5m: returnOver(candles, index, 5),
    return15m: returnOver(candles, index, 15),
    return1h: returnOver(candles, index, BARS_1H),
    return4h: returnOver(candles, index, BARS_4H),
    return24h: returnOver(candles, index, BARS_24H),
    atr14Pct: close > 0 ? atr14 / close : 0,
    atr60Pct: close > 0 ? atr60 / close : 0,
    atr240Pct: close > 0 ? atr240 / close : 0,
    atrRank4h,
    bbWidth60Pct: bbWidth60,
    bbWidth240Pct: bbWidth240,
    compressionToExpansionScore: bbWidth240 > 0 ? bbWidth60 / bbWidth240 : 0,
    rangePosition7d: range7d,
    rangePosition30d: range30d,
    distanceFrom20HighPct: close > 0 ? (recentHigh20 - close) / close : 0,
    distanceFrom20LowPct: close > 0 ? (close - recentLow20) / close : 0,
    candleBodyPct: current.open > 0 ? Math.abs(current.close - current.open) / current.open : 0,
    upperWickPct: close > 0 ? (current.high - Math.max(current.open, current.close)) / close : 0,
    lowerWickPct: close > 0 ? (Math.min(current.open, current.close) - current.low) / close : 0,
    trendSlope1h: slope(candles, index, BARS_1H),
    trendSlope4h: slope(candles, index, BARS_4H),
    breakoutPressureUp: close > recentHigh20 ? (close - recentHigh20) / close : 0,
    breakoutPressureDown: close < recentLow20 ? (recentLow20 - close) / close : 0,
  };
}

function returnOver(candles: Candle[], index: number, bars: number): number {
  const current = candles[index];
  const previous = candles[index - bars];
  if (!current || !previous) return 0;
  return pctChange(previous.close, current.close);
}

function averageTrueRange(candles: Candle[], index: number, bars: number): number {
  const values: number[] = [];
  for (let i = Math.max(1, index - bars + 1); i <= index; i += 1) {
    const candle = candles[i];
    const previous = candles[i - 1];
    if (!candle || !previous) continue;
    const trueRange = Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previous.close),
      Math.abs(candle.low - previous.close),
    );
    values.push(trueRange);
  }
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rollingAtrSeries(candles: Candle[], index: number, windowBars: number): number[] {
  const start = Math.max(60, index - windowBars + 1);
  const values: number[] = [];
  for (let i = start; i <= index; i += 1) {
    values.push(averageTrueRange(candles, i, 14));
  }
  return values;
}

function rankCurrent(series: number[], current: number): number {
  const finite = series.filter((value) => Number.isFinite(value) && value >= 0);
  if (finite.length === 0) return 0;
  const belowOrEqual = finite.filter((value) => value <= current).length;
  return belowOrEqual / finite.length;
}

function bollingerWidth(candles: Candle[], index: number, bars: number): number {
  const closes = candles.slice(Math.max(0, index - bars + 1), index + 1).map((candle) => candle.close);
  if (closes.length < 2) return 0;
  const mean = closes.reduce((sum, value) => sum + value, 0) / closes.length;
  const variance = closes.reduce((sum, value) => sum + (value - mean) ** 2, 0) / closes.length;
  const stdDev = Math.sqrt(variance);
  return mean > 0 ? (4 * stdDev) / mean : 0;
}

function rangePosition(candles: Candle[], index: number, bars: number): number {
  const start = Math.max(0, index - bars + 1);
  const window = candles.slice(start, index + 1);
  const highest = Math.max(...window.map((candle) => candle.high));
  const lowest = Math.min(...window.map((candle) => candle.low));
  const current = candles[index];
  if (!current || highest <= lowest) return 0.5;
  return (current.close - lowest) / (highest - lowest);
}

function high(candles: Candle[], index: number, bars: number): number {
  return Math.max(...candles.slice(Math.max(0, index - bars + 1), index + 1).map((candle) => candle.high));
}

function low(candles: Candle[], index: number, bars: number): number {
  return Math.min(...candles.slice(Math.max(0, index - bars + 1), index + 1).map((candle) => candle.low));
}

function slope(candles: Candle[], index: number, bars: number): number {
  const current = candles[index];
  const previous = candles[index - bars];
  if (!current || !previous || bars <= 0) return 0;
  return pctChange(previous.close, current.close) / bars;
}

export function featureKeys(): string[] {
  return [
    "return5m",
    "return15m",
    "return1h",
    "return4h",
    "return24h",
    "atr14Pct",
    "atr60Pct",
    "atr240Pct",
    "atrRank4h",
    "bbWidth60Pct",
    "bbWidth240Pct",
    "compressionToExpansionScore",
    "rangePosition7d",
    "rangePosition30d",
    "distanceFrom20HighPct",
    "distanceFrom20LowPct",
    "candleBodyPct",
    "upperWickPct",
    "lowerWickPct",
    "trendSlope1h",
    "trendSlope4h",
    "breakoutPressureUp",
    "breakoutPressureDown",
  ];
}

export function featureValueRange(values: number[]): { min?: number; max?: number } {
  const p10 = percentile(values, 0.1);
  const p90 = percentile(values, 0.9);
  return {
    min: p10 ?? undefined,
    max: p90 ?? undefined,
  };
}
