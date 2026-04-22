import { backgroundDb, db } from "@workspace/db";
import {
  candlesTable,
  spikeEventsTable,
  type DetectedMoveRow,
  type MoveFamilyInferenceRow,
} from "@workspace/db";
import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import {
  aggregateCandles,
  findMajorSwingLevels,
  findMultiSwingTrendlines,
  findSwingLevels,
  getSpikeMagnitudeStats,
  getSymbolIndicatorTimeframeMins,
} from "../features.js";

export type CandlePoint = {
  openTs: number;
  closeTs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  tickCount?: number | null;
};

export type NumericFeatureMap = Record<string, number>;

export interface FeatureFramePoint {
  openTs: number;
  relativeBarFromMoveStart: number;
  relativeBarToMoveEnd: number;
  featureValues: NumericFeatureMap;
  normalizedFeatureValues: NumericFeatureMap;
}

export interface MoveFeatureFrameDataset {
  strategyFamily: string;
  windowModel: ProgressionWindowModel;
  frames: FeatureFramePoint[];
  compactRawSlices: CompactRawSlices;
  heuristicSummary: Record<string, unknown>;
}

export interface ProgressionWindowModel {
  strategyFamily: string;
  developmentBars: number;
  precursorBars: number;
  triggerBars: number;
  behaviorBars: number;
  developmentStartTs: number;
  precursorStartTs: number;
  triggerStartTs: number;
  behaviorStartTs: number;
  behaviorEndTs: number;
  moveStartTs: number;
  moveEndTs: number;
}

export interface FeatureWindowStats {
  pointInTime: number;
  normalizedValue: number;
  rollingAverage: number;
  rollingSlope: number;
  min: number;
  max: number;
  median: number;
  distanceFromTriggerValue: number;
  distanceFromIdealMedian: number | null;
  sampled: number[];
}

export interface ProgressionFeatureStats {
  [featureName: string]: {
    development: FeatureWindowStats;
    precursor: FeatureWindowStats;
    trigger: FeatureWindowStats;
    behavior: FeatureWindowStats;
  };
}

export interface CompactRawSlices {
  developmentWindow: Array<{ ts: number; open: number; high: number; low: number; close: number }>;
  precursorWindow: Array<{ ts: number; open: number; high: number; low: number; close: number }>;
  triggerWindow: Array<{ ts: number; open: number; high: number; low: number; close: number }>;
  behaviorWindow: Array<{ ts: number; open: number; high: number; low: number; close: number }>;
}

export interface MoveProgressionComputation {
  strategyFamily: string;
  windowModel: ProgressionWindowModel;
  progressionSummary: Record<string, unknown>;
  featureStats: ProgressionFeatureStats;
  compactRawSlices: CompactRawSlices;
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function stdDev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
}

function skewness(arr: number[]): number {
  const s = stdDev(arr);
  if (arr.length < 3 || s === 0) return 0;
  const m = mean(arr);
  return arr.reduce((a, b) => a + ((b - m) / s) ** 3, 0) / arr.length;
}

function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const result: number[] = [];
  let prev = values[0]!;
  for (const v of values) {
    const cur = v * k + prev * (1 - k);
    result.push(cur);
    prev = cur;
  }
  return result;
}

function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  const changes = closes.slice(1).map((c, i) => c - closes[i]!);
  const window = changes.slice(-period);
  const gains = window.filter((c) => c > 0);
  const losses = window.filter((c) => c < 0).map(Math.abs);
  const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / period : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / period : 0;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function atr(highs: number[], lows: number[], closes: number[], period = 14): number {
  if (highs.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i]! - lows[i]!,
      Math.abs(highs[i]! - closes[i - 1]!),
      Math.abs(lows[i]! - closes[i - 1]!),
    );
    trs.push(tr);
  }
  const window = trs.slice(-period);
  return window.length > 0 ? window.reduce((a, b) => a + b, 0) / window.length : 0;
}

function normalizeUnit(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  if (max <= min) return 0.5;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

function sampleSeries(values: number[], target = 12): number[] {
  if (values.length <= target) return values.map((v) => Number(v.toFixed(6)));
  const step = Math.max(1, Math.floor(values.length / target));
  return values.filter((_, idx) => idx % step === 0).slice(0, target).map((v) => Number(v.toFixed(6)));
}

function sampleCandles(candles: CandlePoint[], target = 18): Array<{ ts: number; open: number; high: number; low: number; close: number }> {
  if (candles.length <= target) {
    return candles.map((c) => ({ ts: c.openTs, open: c.open, high: c.high, low: c.low, close: c.close }));
  }
  const step = Math.max(1, Math.floor(candles.length / target));
  return candles
    .filter((_, idx) => idx % step === 0)
    .slice(0, target)
    .map((c) => ({ ts: c.openTs, open: c.open, high: c.high, low: c.low, close: c.close }));
}

function computeBbWidthAtIndex(closes: number[], idx: number, period = 20): number {
  const start = Math.max(0, idx - period + 1);
  const window = closes.slice(start, idx + 1);
  if (window.length < 2) return 0;
  const m = mean(window);
  const s = stdDev(window);
  return m !== 0 ? (4 * s) / m : 0;
}

function detectRegime(closes: number[], atrVal: number, ema20: number[]): string {
  if (closes.length < 20) return "ranging";
  const recentEma = ema20.slice(-20);
  const slopePoints = recentEma.slice(-5);
  const slope = slopePoints.length >= 2
    ? (slopePoints[slopePoints.length - 1]! - slopePoints[0]!) / Math.max(Math.abs(slopePoints[0]!), 0.0001)
    : 0;
  const currentPrice = closes[closes.length - 1]!;
  const vol = currentPrice !== 0 ? atrVal / currentPrice : 0;
  if (vol > 0.003) return "volatile";
  if (slope > 0.001) return "trending_up";
  if (slope < -0.001) return "trending_down";
  return "ranging";
}

function computeMacd(closes: number[]): { line: number; signal: number; hist: number; confirmation: number } {
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const minLen = Math.min(ema12.length, ema26.length);
  if (minLen === 0) return { line: 0, signal: 0, hist: 0, confirmation: 0 };
  const macdSeries = Array.from({ length: minLen }, (_, idx) => ema12[idx]! - ema26[idx]!);
  const signalSeries = ema(macdSeries, 9);
  const line = macdSeries[macdSeries.length - 1] ?? 0;
  const signal = signalSeries[signalSeries.length - 1] ?? 0;
  const hist = line - signal;
  const confirmation = Math.tanh(hist * 10);
  return { line, signal, hist, confirmation };
}

function computeDonchianPressure(highs: number[], lows: number[], price: number, period = 20): { upper: number; lower: number; pressure: number } {
  const upper = Math.max(...highs.slice(-period));
  const lower = Math.min(...lows.slice(-period));
  const span = upper - lower;
  const pressure = span > 0 ? ((price - lower) / span) * 2 - 1 : 0;
  return { upper, lower, pressure };
}

function classifyInstrumentFamily(symbol: string): "boom" | "crash" | "volatility" | "other" {
  if (symbol.startsWith("BOOM")) return "boom";
  if (symbol.startsWith("CRASH")) return "crash";
  if (symbol.startsWith("R_")) return "volatility";
  return "other";
}

function inferDirectionalSpike(rawMove: number, symbol: string): boolean {
  if (symbol.startsWith("CRASH")) return rawMove < -0.01;
  if (symbol.startsWith("BOOM")) return rawMove > 0.01;
  return Math.abs(rawMove) > 0.0125;
}

export function buildWindowModel(move: DetectedMoveRow, inference: Pick<MoveFamilyInferenceRow, "strategyFamily" | "developmentBars" | "precursorBars" | "triggerBars" | "behaviorBars">): ProgressionWindowModel {
  const developmentBars = Math.max(30, Number(inference.developmentBars ?? 120));
  const precursorBars = Math.max(15, Math.min(developmentBars, Number(inference.precursorBars ?? 60)));
  const triggerBars = Math.max(3, Number(inference.triggerBars ?? 24));
  const behaviorBars = Math.max(15, Number(inference.behaviorBars ?? Math.max(30, Math.round(move.holdingMinutes))));
  const developmentStartTs = move.startTs - developmentBars * 60;
  const precursorStartTs = move.startTs - precursorBars * 60;
  const triggerStartTs = move.startTs;
  const behaviorStartTs = move.startTs;
  const behaviorEndTs = Math.min(move.endTs, move.startTs + behaviorBars * 60);
  return {
    strategyFamily: inference.strategyFamily,
    developmentBars,
    precursorBars,
    triggerBars,
    behaviorBars,
    developmentStartTs,
    precursorStartTs,
    triggerStartTs,
    behaviorStartTs,
    behaviorEndTs,
    moveStartTs: move.startTs,
    moveEndTs: move.endTs,
  };
}

export async function fetchCanonicalWindow(symbol: string, fromTs: number, toTs: number): Promise<CandlePoint[]> {
  return backgroundDb
    .select({
      openTs: candlesTable.openTs,
      closeTs: candlesTable.closeTs,
      open: candlesTable.open,
      high: candlesTable.high,
      low: candlesTable.low,
      close: candlesTable.close,
      tickCount: candlesTable.tickCount,
    })
    .from(candlesTable)
    .where(and(
      eq(candlesTable.symbol, symbol),
      eq(candlesTable.timeframe, "1m"),
      gte(candlesTable.openTs, fromTs),
      lte(candlesTable.openTs, toTs),
      eq(candlesTable.isInterpolated, false),
    ))
    .orderBy(asc(candlesTable.openTs));
}

async function fetchPairedWindow(symbol: string, fromTs: number, toTs: number): Promise<CandlePoint[]> {
  const pairedSymbol = symbol.startsWith("BOOM")
    ? symbol.replace("BOOM", "CRASH")
    : symbol.startsWith("CRASH")
      ? symbol.replace("CRASH", "BOOM")
      : null;
  if (!pairedSymbol) return [];
  return fetchCanonicalWindow(pairedSymbol, fromTs, toTs);
}

function alignPairedCloses(pairedCandles: CandlePoint[], candle: CandlePoint, fallback: number): number {
  const match = pairedCandles.find((p) => p.openTs === candle.openTs);
  return match?.close ?? fallback;
}

export function computeFeaturePoint(
  symbol: string,
  strategyFamily: string,
  candles: CandlePoint[],
  pairedCandles: CandlePoint[],
  idx: number,
  spikeIntervals: number[],
  spikeMagnitude: Awaited<ReturnType<typeof getSpikeMagnitudeStats>>,
): NumericFeatureMap {
  const slice = candles.slice(0, idx + 1);
  const last = slice[slice.length - 1]!;
  const price = last.close;
  const highs = slice.map((c) => c.high);
  const lows = slice.map((c) => c.low);
  const closes = slice.map((c) => c.close);
  const indicatorTfMins = getSymbolIndicatorTimeframeMins(symbol);
  const htfCandles = aggregateCandles(slice, indicatorTfMins);
  const htfCloses = htfCandles.map((c) => c.close);
  const htfHighs = htfCandles.map((c) => c.high);
  const htfLows = htfCandles.map((c) => c.low);
  const ema20Arr = ema(htfCloses, 20);
  const ema20 = ema20Arr[ema20Arr.length - 1] ?? price;
  const ema20Prev = ema20Arr[ema20Arr.length - 2] ?? ema20;
  const emaSlope = ema20 !== 0 ? (ema20 - ema20Prev) / ema20 : 0;
  const emaDist = ema20 !== 0 ? (price - ema20) / ema20 : 0;
  const rsi14 = rsi(htfCloses, 14);
  const atr14Abs = atr(htfHighs, htfLows, htfCloses, 14);
  const atr14 = price !== 0 ? atr14Abs / price : 0;
  const atr50 = price !== 0 ? atr(htfHighs, htfLows, htfCloses, Math.min(50, htfCloses.length)) / price : 0;
  const atrRank = atr50 > 0 ? Math.min(atr14 / atr50, 3) : 1;
  const bbSlice = htfCloses.slice(-20);
  const bbMean = bbSlice.length > 0 ? mean(bbSlice) : price;
  const bbStd = bbSlice.length > 1 ? stdDev(bbSlice) : 0;
  const bbUpper = bbMean + 2 * bbStd;
  const bbLower = bbMean - 2 * bbStd;
  const bbWidth = bbMean !== 0 ? (bbUpper - bbLower) / bbMean : 0;
  const bbPctB = bbUpper !== bbLower ? (price - bbLower) / (bbUpper - bbLower) : 0.5;
  const range = last.high - last.low;
  const body = Math.abs(last.close - last.open);
  const candleBody = range > 0 ? body / range : 0;
  const upperWickRatio = range > 0 ? (last.high - Math.max(last.open, last.close)) / Math.max(body, 0.0001) : 0;
  const lowerWickRatio = range > 0 ? (Math.min(last.open, last.close) - last.low) / Math.max(body, 0.0001) : 0;
  let consecutive = 0;
  for (let i = slice.length - 1; i >= 1; i--) {
    const up = slice[i]!.close > slice[i]!.open;
    const prevUp = slice[i - 1]!.close > slice[i - 1]!.open;
    if (i === slice.length - 1) {
      consecutive = up ? 1 : -1;
    } else if ((up && consecutive > 0 && prevUp) || (!up && consecutive < 0 && !prevUp)) {
      consecutive += up ? 1 : -1;
    } else {
      break;
    }
  }
  const zWindow = htfCloses.slice(-20);
  const zMean = zWindow.length > 0 ? mean(zWindow) : price;
  const zStd = zWindow.length > 1 ? stdDev(zWindow) : 0;
  const zScore = zStd > 0 ? (price - zMean) / zStd : 0;
  const rollingSkew = zWindow.length > 2 ? skewness(zWindow) : 0;
  let spikeCount4h = 0;
  let spikeCount24h = 0;
  let spikeCount7d = 0;
  for (let i = Math.max(1, slice.length - 7 * 24 * 60); i < slice.length; i++) {
    const prev = slice[i - 1]!;
    const curr = slice[i]!;
    const rawMove = prev.close !== 0 ? (curr.close - prev.close) / prev.close : 0;
    const directionalSpike = inferDirectionalSpike(rawMove, symbol);
    if (directionalSpike) {
      const barsBack = slice.length - 1 - i;
      if (barsBack <= 4 * 60) spikeCount4h++;
      if (barsBack <= 24 * 60) spikeCount24h++;
      if (barsBack <= 7 * 24 * 60) spikeCount7d++;
    }
  }
  const lastSpikeInterval = spikeIntervals[spikeIntervals.length - 1] ?? 0;
  const eventIntervalMean = spikeIntervals.length > 0 ? mean(spikeIntervals) : 0;
  const eventIntervalStd = spikeIntervals.length > 1 ? stdDev(spikeIntervals) : 0;
  const eventIntervalZScore = eventIntervalStd > 0 ? (lastSpikeInterval - eventIntervalMean) / eventIntervalStd : 0;
  const spikeHazardScore = eventIntervalStd > 0 ? 1 / (1 + Math.exp(-(eventIntervalZScore))) : 0;
  const ticksSinceSpike = lastSpikeInterval;
  const runLengthSinceSpike = lastSpikeInterval;
  const priceChange24hPct = (() => {
    const targetTs = last.openTs - 24 * 3600;
    const reference = slice.find((c) => c.openTs >= targetTs);
    return reference && reference.close !== 0 ? (price - reference.close) / reference.close : 0;
  })();
  const priceChange7dPct = (() => {
    const targetTs = last.openTs - 7 * 24 * 3600;
    const reference = slice.find((c) => c.openTs >= targetTs);
    return reference && reference.close !== 0 ? (price - reference.close) / reference.close : 0;
  })();
  const target30dTs = last.openTs - 30 * 24 * 3600;
  const range30d = slice.filter((c) => c.openTs >= target30dTs);
  const high30d = range30d.length > 0 ? Math.max(...range30d.map((c) => c.high)) : price;
  const low30d = range30d.length > 0 ? Math.min(...range30d.map((c) => c.low)) : price;
  const distFromRange30dHighPct = high30d !== 0 ? (price - high30d) / high30d : 0;
  const distFromRange30dLowPct = low30d !== 0 ? (price - low30d) / low30d : 0;
  const { swingHigh, swingLow } = findSwingLevels(highs, lows, 5);
  const swingHighDist = price !== 0 ? (price - swingHigh) / price : 0;
  const swingLowDist = price !== 0 ? (price - swingLow) / price : 0;
  const swingBreached = Number(last.high > swingHigh || last.low < swingLow);
  const swingReclaimed = Number((last.close < swingHigh && last.high > swingHigh) || (last.close > swingLow && last.low < swingLow));
  const bbWidthPrev = htfCloses.length > 25 ? computeBbWidthAtIndex(htfCloses, htfCloses.length - 6) : bbWidth;
  const bbWidthRoc = bbWidthPrev !== 0 ? (bbWidth - bbWidthPrev) / Math.abs(bbWidthPrev) : 0;
  const atr14Prev = htfCloses.length > 20
    ? atr(htfHighs.slice(0, -5), htfLows.slice(0, -5), htfCloses.slice(0, -5), 14) / Math.max(htfCloses[htfCloses.length - 6] ?? price, 0.0001)
    : atr14;
  const atrAccel = atr14Prev !== 0 ? atr14 / atr14Prev - 1 : 0;
  const regimeLabel = detectRegime(htfCloses, atr14Abs, ema20Arr);
  let regimeDurationBars = 1;
  for (let lookback = slice.length - 2; lookback >= 20; lookback--) {
    const testCloses = closes.slice(0, lookback + 1);
    const testAgg = aggregateCandles(slice.slice(0, lookback + 1), indicatorTfMins);
    const testHtfCloses = testAgg.map((c) => c.close);
    const testHtfHighs = testAgg.map((c) => c.high);
    const testHtfLows = testAgg.map((c) => c.low);
    const testEma = ema(testHtfCloses, 20);
    const testRegime = detectRegime(testHtfCloses, atr(testHtfHighs, testHtfLows, testHtfCloses, 14), testEma);
    if (testRegime === regimeLabel) regimeDurationBars++;
    else break;
  }
  const pairedClose = alignPairedCloses(pairedCandles, last, price);
  const crossCorrelation = pairedClose !== 0 ? (price - pairedClose) / pairedClose : 0;
  const vwapNumerator = slice.reduce((sum, c) => sum + ((c.high + c.low + c.close) / 3) * (c.tickCount && c.tickCount > 0 ? c.tickCount : Math.max(c.high - c.low, 1)), 0);
  const vwapDenominator = slice.reduce((sum, c) => sum + (c.tickCount && c.tickCount > 0 ? c.tickCount : Math.max(c.high - c.low, 1)), 0);
  const vwap = vwapDenominator > 0 ? vwapNumerator / vwapDenominator : price;
  const prevSession = slice.slice(Math.max(0, slice.length - 24 * 60), slice.length - 1);
  const prevSessionHigh = prevSession.length > 0 ? Math.max(...prevSession.map((c) => c.high)) : price;
  const prevSessionLow = prevSession.length > 0 ? Math.min(...prevSession.map((c) => c.low)) : price;
  const prevSessionClose = prevSession.length > 0 ? prevSession[prevSession.length - 1]!.close : price;
  const pivotPoint = (prevSessionHigh + prevSessionLow + prevSessionClose) / 3;
  const pivotR1 = 2 * pivotPoint - prevSessionLow;
  const pivotS1 = 2 * pivotPoint - prevSessionHigh;
  const pivotR2 = pivotPoint + (prevSessionHigh - prevSessionLow);
  const pivotS2 = pivotPoint - (prevSessionHigh - prevSessionLow);
  const pivotR3 = prevSessionHigh + 2 * (pivotPoint - prevSessionLow);
  const pivotS3 = prevSessionLow - 2 * (prevSessionHigh - pivotPoint);
  const rangePrevSession = prevSessionHigh - prevSessionLow;
  const camarillaH3 = prevSessionClose + rangePrevSession * 1.1 / 4;
  const camarillaH4 = prevSessionClose + rangePrevSession * 1.1 / 2;
  const camarillaL3 = prevSessionClose - rangePrevSession * 1.1 / 4;
  const camarillaL4 = prevSessionClose - rangePrevSession * 1.1 / 2;
  const fibLevels = swingHigh > swingLow
    ? {
        retrace50: swingHigh - (swingHigh - swingLow) * 0.5,
        retrace618: swingHigh - (swingHigh - swingLow) * 0.618,
        extension1272: swingLow + (swingHigh - swingLow) * 1.272,
        extension1618: swingLow + (swingHigh - swingLow) * 1.618,
      }
    : { retrace50: price, retrace618: price, extension1272: price, extension1618: price };
  const trendlines = findMultiSwingTrendlines(highs, lows, closes, 5, atr14Abs);
  const majorSwings = slice.length >= 50
    ? findMajorSwingLevels(highs, lows, Math.min(20, Math.max(5, Math.floor(slice.length / 8))))
    : { majorSwingHigh: swingHigh, majorSwingLow: swingLow };
  const macd = computeMacd(htfCloses);
  const donchian = computeDonchianPressure(highs, lows, price, Math.min(20, highs.length));
  const family = classifyInstrumentFamily(symbol);
  const longTermRangePct = spikeMagnitude?.longTermRangePct ?? (high30d !== 0 && low30d !== 0 ? (high30d - low30d) / Math.max(low30d, 0.0001) : 0);
  const volatilityNormalizedByClass = longTermRangePct > 0 ? atr14 / Math.max(longTermRangePct, 0.0001) : atr14;
  const rangeExtremePressure = Math.max(Math.abs(distFromRange30dHighPct), Math.abs(distFromRange30dLowPct));
  const trendPullbackFit = Math.max(0, 1 - Math.min(Math.abs(emaDist) * 10, 1)) * (1 - Math.min(Math.abs(rsi14 - 50) / 50, 1));
  const eventExhaustionFit = family === "boom" || family === "crash"
    ? normalizeUnit(spikeCount24h + spikeCount4h * 2, 0, 30) * normalizeUnit(rangeExtremePressure, 0, 0.2)
    : 0;
  const breakoutPressureFit = normalizeUnit(Math.abs(donchian.pressure), 0, 1) * normalizeUnit(bbWidthRoc + atrAccel, -1, 2);
  const reversalFit = normalizeUnit(swingReclaimed + rangeExtremePressure * 5 + Math.abs(zScore), 0, 5);
  const continuationFit = normalizeUnit(Math.abs(emaSlope) * 1000 + Math.abs(macd.confirmation) + atrAccel, 0, 5);
  const familyStructuralFit = (() => {
    switch (strategyFamily) {
      case "continuation":
        return continuationFit;
      case "reversal":
        return reversalFit;
      case "breakout":
        return breakoutPressureFit;
      case "boom_expansion":
      case "crash_expansion":
        return eventExhaustionFit;
      default:
        return Math.max(continuationFit, reversalFit, breakoutPressureFit, eventExhaustionFit);
    }
  })();

  return {
    emaSlope,
    emaDist,
    priceVsEma20: emaDist,
    rsi14,
    atr14,
    bbWidth,
    bbPctB,
    candleBody,
    upperWickRatio,
    lowerWickRatio,
    zScore,
    rollingSkew,
    spikeHazardScore,
    ticksSinceSpike,
    runLengthSinceSpike,
    swingHighDist,
    swingLowDist,
    swingBreached,
    swingReclaimed,
    priceChange24hPct,
    priceChange7dPct,
    distFromRange30dHighPct,
    distFromRange30dLowPct,
    vwap,
    pivotPoint,
    pivotR1,
    pivotR2,
    pivotR3,
    pivotS1,
    pivotS2,
    pivotS3,
    fibRetrace50: fibLevels.retrace50,
    fibRetrace618: fibLevels.retrace618,
    fibExtension1272: fibLevels.extension1272,
    fibExtension1618: fibLevels.extension1618,
    trendlineResistanceSlope: trendlines.resistance.slope,
    trendlineSupportSlope: trendlines.support.slope,
    trendlineResistanceTouches: trendlines.resistance.touches,
    trendlineSupportTouches: trendlines.support.touches,
    macdLine: macd.line,
    macdSignal: macd.signal,
    macdHist: macd.hist,
    macdMomentumConfirmation: macd.confirmation,
    donchianUpper: donchian.upper,
    donchianLower: donchian.lower,
    donchianPressure: donchian.pressure,
    rangeBreakPressure: Math.abs(donchian.pressure),
    eventIntervalMean,
    eventIntervalStd,
    eventIntervalZScore,
    regimeDurationBars,
    volatilityNormalizedByClass,
    familyStructuralFit,
    trendPullbackFit,
    eventExhaustionFit,
    breakoutPressureFit,
    reversalFit,
    continuationFit,
    atrRank,
    bbWidthRoc,
    atrAccel,
    crossCorrelation,
    majorSwingHighDist: price !== 0 ? (price - majorSwings.majorSwingHigh) / price : 0,
    majorSwingLowDist: price !== 0 ? (price - majorSwings.majorSwingLow) / price : 0,
    spikeCount4h,
    spikeCount24h,
    spikeCount7d,
    rangePosition: rangeExtremePressure,
    prevSessionHighDist: price !== 0 ? (price - prevSessionHigh) / price : 0,
    prevSessionLowDist: price !== 0 ? (price - prevSessionLow) / price : 0,
    camarillaH3Dist: price !== 0 ? (price - camarillaH3) / price : 0,
    camarillaL3Dist: price !== 0 ? (price - camarillaL3) / price : 0,
    symbolFamilyVolatilityFit: family === "volatility" ? normalizeUnit(atr14 * 100, 0, 1) : normalizeUnit(spikeCount24h, 0, 15),
  };
}

export function buildWindowStats(values: number[], triggerValue: number): FeatureWindowStats {
  const min = values.length > 0 ? Math.min(...values) : 0;
  const max = values.length > 0 ? Math.max(...values) : 0;
  const pointInTime = values.length > 0 ? values[values.length - 1]! : 0;
  return {
    pointInTime: Number(pointInTime.toFixed(6)),
    normalizedValue: Number(normalizeUnit(pointInTime, min, max).toFixed(6)),
    rollingAverage: Number(mean(values).toFixed(6)),
    rollingSlope: Number((values.length >= 2 ? values[values.length - 1]! - values[0]! : 0).toFixed(6)),
    min: Number(min.toFixed(6)),
    max: Number(max.toFixed(6)),
    median: Number(median(values).toFixed(6)),
    distanceFromTriggerValue: Number((pointInTime - triggerValue).toFixed(6)),
    distanceFromIdealMedian: null,
    sampled: sampleSeries(values),
  };
}

export function subsetIndices(candles: CandlePoint[], fromTs: number, toTs: number): number[] {
  return candles
    .map((c, idx) => ({ c, idx }))
    .filter(({ c }) => c.openTs >= fromTs && c.openTs <= toTs)
    .map(({ idx }) => idx);
}

export async function computeMoveProgressionArtifact(
  move: DetectedMoveRow,
  inference: MoveFamilyInferenceRow,
): Promise<MoveProgressionComputation> {
  const dataset = await computeMoveFeatureFrameDataset(move, inference);
  const { windowModel, compactRawSlices } = dataset;
  const candles = await fetchCanonicalWindow(move.symbol, windowModel.developmentStartTs, windowModel.behaviorEndTs);
  const featurePoints = dataset.frames.map((frame) => frame.featureValues);
  const developmentIndices = subsetIndices(candles, windowModel.developmentStartTs, move.startTs - 60);
  const precursorIndices = subsetIndices(candles, windowModel.precursorStartTs, move.startTs - 60);
  const triggerIndices = subsetIndices(candles, windowModel.triggerStartTs, windowModel.triggerStartTs + windowModel.triggerBars * 60);
  const triggerIndex = triggerIndices.length > 0 ? triggerIndices[0]! : Math.max(0, candles.findIndex((c) => c.openTs >= move.startTs));
  const behaviorIndices = subsetIndices(candles, windowModel.behaviorStartTs, windowModel.behaviorEndTs);
  const effectiveTriggerIndices = triggerIndices.length > 0 ? triggerIndices : [triggerIndex];

  const featureNames = Object.keys(featurePoints[featurePoints.length - 1] ?? {});
  const triggerPoint = featurePoints[triggerIndex] ?? featurePoints[featurePoints.length - 1]!;
  const featureStats: ProgressionFeatureStats = {};

  for (const featureName of featureNames) {
    const developmentValues = developmentIndices.map((idx) => featurePoints[idx]![featureName] ?? 0);
    const precursorValues = precursorIndices.map((idx) => featurePoints[idx]![featureName] ?? 0);
    const triggerValues = effectiveTriggerIndices.map((idx) => featurePoints[idx]![featureName] ?? 0);
    const behaviorValues = behaviorIndices.map((idx) => featurePoints[idx]![featureName] ?? 0);
    const triggerValue = triggerPoint[featureName] ?? 0;
    featureStats[featureName] = {
      development: buildWindowStats(developmentValues, triggerValue),
      precursor: buildWindowStats(precursorValues, triggerValue),
      trigger: buildWindowStats(triggerValues, triggerValue),
      behavior: buildWindowStats(behaviorValues, triggerValue),
    };
  }

  const behaviorCandles = candles.filter((c) => c.openTs >= windowModel.behaviorStartTs && c.openTs <= windowModel.behaviorEndTs);
  const regressionDepthPct = (() => {
    if (behaviorCandles.length < 2) return 0;
    const entryPrice = behaviorCandles[0]!.close;
    let maxAdverse = 0;
    for (const c of behaviorCandles) {
      const adverse = move.direction === "up"
        ? Math.max(0, (entryPrice - c.low) / Math.max(entryPrice, 0.0001))
        : Math.max(0, (c.high - entryPrice) / Math.max(entryPrice, 0.0001));
      maxAdverse = Math.max(maxAdverse, adverse);
    }
    return Number((maxAdverse * 100).toFixed(4));
  })();

  const progressionSummary = {
    moveId: move.id,
    symbol: move.symbol,
    strategyFamily: inference.strategyFamily,
    detectedMoveType: move.moveType,
    qualityTier: move.qualityTier,
    qualityScore: move.qualityScore,
    movePct: Number((move.movePct * 100).toFixed(4)),
    holdingHours: Number((move.holdingMinutes / 60).toFixed(4)),
    developmentBars: developmentIndices.length,
    precursorBars: precursorIndices.length,
    triggerBars: effectiveTriggerIndices.length,
    behaviorBars: behaviorIndices.length,
    triggerIndexFromDevelopmentStart: triggerIndex,
    triggerPrice: candles[triggerIndex]?.close ?? move.startPrice,
    triggerTs: candles[triggerIndex]?.openTs ?? move.startTs,
    regressionDepthPct,
    sampledFeatureNames: featureNames.slice(0, 12),
  };

  return {
    strategyFamily: inference.strategyFamily,
    windowModel,
    progressionSummary,
    featureStats,
    compactRawSlices,
  };
}

export function buildHeuristicWindowModel(move: DetectedMoveRow, strategyFamily?: string): ProgressionWindowModel {
  const moveBars = Math.max(15, Math.round(move.holdingMinutes));
  const developmentBars = Math.max(90, Math.min(360, moveBars * 3));
  const precursorBars = Math.max(30, Math.min(120, Math.round(developmentBars * 0.5)));
  const triggerBars = Math.max(6, Math.min(36, Math.round(moveBars * 0.15)));
  const behaviorBars = Math.max(moveBars, 30);
  return buildWindowModel(move, {
    strategyFamily: strategyFamily ?? move.strategyFamilyCandidate ?? move.moveType,
    developmentBars,
    precursorBars,
    triggerBars,
    behaviorBars,
  });
}

function normalizeFeatureFrames(featurePoints: NumericFeatureMap[]): NumericFeatureMap[] {
  const featureNames = Object.keys(featurePoints[featurePoints.length - 1] ?? {});
  const bounds = Object.fromEntries(
    featureNames.map((featureName) => {
      const values = featurePoints.map((point) => point[featureName] ?? 0);
      return [featureName, { min: Math.min(...values), max: Math.max(...values) }];
    }),
  ) as Record<string, { min: number; max: number }>;

  return featurePoints.map((point) =>
    Object.fromEntries(
      featureNames.map((featureName) => [
        featureName,
        Number(normalizeUnit(point[featureName] ?? 0, bounds[featureName]!.min, bounds[featureName]!.max).toFixed(6)),
      ]),
    ),
  );
}

export async function computeMoveFeatureFrameDataset(
  move: DetectedMoveRow,
  inferenceLike?: Pick<MoveFamilyInferenceRow, "strategyFamily" | "developmentBars" | "precursorBars" | "triggerBars" | "behaviorBars">,
): Promise<MoveFeatureFrameDataset> {
  const windowModel = inferenceLike
    ? buildWindowModel(move, inferenceLike)
    : buildHeuristicWindowModel(move);
  const candles = await fetchCanonicalWindow(move.symbol, windowModel.developmentStartTs, windowModel.behaviorEndTs);
  if (candles.length < 30) {
    throw new Error(`Insufficient canonical candles for move feature dataset: moveId=${move.id}`);
  }
  const pairedCandles = await fetchPairedWindow(move.symbol, windowModel.developmentStartTs, windowModel.behaviorEndTs);
  const spikeMagnitude = await getSpikeMagnitudeStats(move.symbol, 90, windowModel.behaviorEndTs);
  const recentSpikes = await db
    .select({
      eventTs: spikeEventsTable.eventTs,
      ticksSincePreviousSpike: spikeEventsTable.ticksSincePreviousSpike,
    })
    .from(spikeEventsTable)
    .where(and(
      eq(spikeEventsTable.symbol, move.symbol),
      gte(spikeEventsTable.eventTs, windowModel.developmentStartTs - 7 * 24 * 3600),
      lte(spikeEventsTable.eventTs, windowModel.behaviorEndTs),
    ))
    .orderBy(asc(spikeEventsTable.eventTs));

  const featurePoints: NumericFeatureMap[] = [];
  const spikeIntervals: number[] = [];
  for (let idx = 0; idx < candles.length; idx++) {
    const candle = candles[idx]!;
    const intervalsAtPoint = recentSpikes
      .filter((s) => s.eventTs <= candle.openTs)
      .map((s) => Number(s.ticksSincePreviousSpike ?? 0))
      .filter((v) => Number.isFinite(v) && v > 0);
    spikeIntervals.splice(0, spikeIntervals.length, ...intervalsAtPoint);
    featurePoints.push(computeFeaturePoint(
      move.symbol,
      windowModel.strategyFamily,
      candles,
      pairedCandles,
      idx,
      spikeIntervals,
      spikeMagnitude,
    ));
  }

  const normalizedPoints = normalizeFeatureFrames(featurePoints);
  const frames = candles.map((candle, idx) => ({
    openTs: candle.openTs,
    relativeBarFromMoveStart: Math.round((candle.openTs - move.startTs) / 60),
    relativeBarToMoveEnd: Math.round((move.endTs - candle.openTs) / 60),
    featureValues: featurePoints[idx]!,
    normalizedFeatureValues: normalizedPoints[idx]!,
  }));

  return {
    strategyFamily: windowModel.strategyFamily,
    windowModel,
    frames,
    compactRawSlices: {
      developmentWindow: sampleCandles(candles.filter((c) => c.openTs >= windowModel.developmentStartTs && c.openTs < move.startTs)),
      precursorWindow: sampleCandles(candles.filter((c) => c.openTs >= windowModel.precursorStartTs && c.openTs < move.startTs)),
      triggerWindow: sampleCandles(candles.filter((c) => c.openTs >= windowModel.triggerStartTs && c.openTs <= windowModel.triggerStartTs + windowModel.triggerBars * 60)),
      behaviorWindow: sampleCandles(candles.filter((c) => c.openTs >= windowModel.behaviorStartTs && c.openTs <= windowModel.behaviorEndTs)),
    },
    heuristicSummary: {
      moveId: move.id,
      strategyFamily: windowModel.strategyFamily,
      developmentBars: windowModel.developmentBars,
      precursorBars: windowModel.precursorBars,
      triggerBars: windowModel.triggerBars,
      behaviorBars: windowModel.behaviorBars,
      frameCount: frames.length,
    },
  };
}
