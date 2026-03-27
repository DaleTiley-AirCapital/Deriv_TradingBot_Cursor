/**
 * Feature Engineering Service
 * Computes technical indicators and regime features from candle/tick data
 */
import { db, candlesTable, spikeEventsTable, featuresTable } from "@workspace/db";
import { desc, eq, and, gte } from "drizzle-orm";

export interface FeatureVector {
  symbol: string;
  ts: number;
  emaSlope: number;
  emaDist: number;
  priceVsEma20: number;
  rsi14: number;
  rsiZone: number;
  atr14: number;
  bbWidth: number;
  bbPctB: number;
  atrRank: number;
  candleBody: number;
  upperWickRatio: number;
  lowerWickRatio: number;
  consecutive: number;
  zScore: number;
  rollingSkew: number;
  ticksSinceSpike: number;
  runLengthSinceSpike: number;
  spikeHazardScore: number;
  swingHighDist: number;
  swingLowDist: number;
  swingBreached: boolean;
  swingReclaimed: boolean;
  swingBreachCandles: number;
  swingBreachDirection: "above" | "below" | null;
  bbWidthRoc: number;
  atrAccel: number;
  hourOfDay: number;
  dayOfWeek: number;
  crossCorrelation: number;
  regimeLabel: string;
  swingHigh: number;
  swingLow: number;
  fibRetraceLevels: number[];
  fibExtensionLevels: number[];
  bbUpper: number;
  bbLower: number;
  latestClose: number;
  fibExtensionLevelsDown: number[];
  vwap: number;
  pivotPoint: number;
  pivotR1: number;
  pivotR2: number;
  pivotR3: number;
  pivotS1: number;
  pivotS2: number;
  pivotS3: number;
  camarillaH3: number;
  camarillaH4: number;
  camarillaL3: number;
  camarillaL4: number;
  psychRound: number;
  prevSessionHigh: number;
  prevSessionLow: number;
  prevSessionClose: number;
}

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [];
  let prev = values[0];
  for (const v of values) {
    const cur = v * k + prev * (1 - k);
    result.push(cur);
    prev = cur;
  }
  return result;
}

function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  const changes = closes.slice(1).map((c, i) => c - closes[i]);
  const window = changes.slice(-period);
  const gains = window.filter(c => c > 0);
  const losses = window.filter(c => c < 0).map(Math.abs);
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
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }
  const window = trs.slice(-period);
  return window.reduce((a, b) => a + b, 0) / window.length;
}

function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdDev(arr: number[]): number {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
}

function skewness(arr: number[]): number {
  const m = mean(arr);
  const s = stdDev(arr);
  if (s === 0) return 0;
  return arr.reduce((a, b) => a + ((b - m) / s) ** 3, 0) / arr.length;
}

export function findSwingLevels(highs: number[], lows: number[], pivotBars = 5): { swingHigh: number; swingLow: number; swingHighIdx: number; swingLowIdx: number } {
  let swingHigh = -Infinity;
  let swingLow = Infinity;
  let swingHighIdx = 0;
  let swingLowIdx = 0;

  for (let i = highs.length - pivotBars - 1; i >= pivotBars; i--) {
    let isSwingHigh = true;
    let isSwingLow = true;
    for (let j = 1; j <= pivotBars; j++) {
      if (highs[i] <= highs[i - j] || highs[i] <= highs[i + j]) isSwingHigh = false;
      if (lows[i] >= lows[i - j] || lows[i] >= lows[i + j]) isSwingLow = false;
    }
    if (isSwingHigh && swingHigh === -Infinity) {
      swingHigh = highs[i];
      swingHighIdx = i;
    }
    if (isSwingLow && swingLow === Infinity) {
      swingLow = lows[i];
      swingLowIdx = i;
    }
    if (swingHigh !== -Infinity && swingLow !== Infinity) break;
  }

  if (swingHigh === -Infinity) {
    swingHigh = Math.max(...highs.slice(-20));
    swingHighIdx = highs.length - 1;
  }
  if (swingLow === Infinity) {
    swingLow = Math.min(...lows.slice(-20));
    swingLowIdx = lows.length - 1;
  }

  return { swingHigh, swingLow, swingHighIdx, swingLowIdx };
}

function computeBbWidthAtIndex(closes: number[], idx: number, period = 20): number {
  const start = Math.max(0, idx - period + 1);
  const window = closes.slice(start, idx + 1);
  if (window.length < 2) return 0;
  const m = mean(window);
  const s = stdDev(window);
  return s > 0 ? (4 * s) / m : 0;
}

function pearsonCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 5) return 0;
  const xSlice = x.slice(-n);
  const ySlice = y.slice(-n);
  const mx = mean(xSlice);
  const my = mean(ySlice);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xSlice[i] - mx;
    const b = ySlice[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const denom = Math.sqrt(dx * dy);
  return denom > 0 ? num / denom : 0;
}

function getPairedSymbol(symbol: string): string | null {
  if (symbol.startsWith("BOOM")) return symbol.replace("BOOM", "CRASH");
  if (symbol.startsWith("CRASH")) return symbol.replace("CRASH", "BOOM");
  return null;
}

function detectSwingBreachAndReclaim(
  candles: { high: number; low: number; close: number }[],
  swingHigh: number,
  swingLow: number
): { breached: boolean; reclaimed: boolean; breachCandles: number; breachDirection: "above" | "below" | null } {
  const len = candles.length;
  if (len < 2) return { breached: false, reclaimed: false, breachCandles: 0, breachDirection: null };

  const lastCandle = candles[len - 1];
  const lastClose = lastCandle.close;

  for (let lookback = 1; lookback <= Math.min(3, len - 1); lookback++) {
    const idx = len - 1 - lookback;
    const c = candles[idx];

    if (c.high > swingHigh && lastClose < swingHigh) {
      return { breached: true, reclaimed: true, breachCandles: lookback, breachDirection: "above" };
    }

    if (c.low < swingLow && lastClose > swingLow) {
      return { breached: true, reclaimed: true, breachCandles: lookback, breachDirection: "below" };
    }
  }

  if (lastCandle.high > swingHigh && lastClose < swingHigh) {
    return { breached: true, reclaimed: true, breachCandles: 0, breachDirection: "above" };
  }
  if (lastCandle.low < swingLow && lastClose > swingLow) {
    return { breached: true, reclaimed: true, breachCandles: 0, breachDirection: "below" };
  }

  return { breached: false, reclaimed: false, breachCandles: 0, breachDirection: null };
}

function computeVWAP(candles: { close: number; high: number; low: number }[]): number {
  if (candles.length === 0) return 0;
  let cumTPV = 0;
  let cumV = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    const vol = c.high - c.low || 1;
    cumTPV += tp * vol;
    cumV += vol;
  }
  return cumV > 0 ? cumTPV / cumV : candles[candles.length - 1].close;
}

function computePivotPoints(prevHigh: number, prevLow: number, prevClose: number): {
  pp: number; r1: number; r2: number; r3: number; s1: number; s2: number; s3: number;
  camH3: number; camH4: number; camL3: number; camL4: number;
} {
  const pp = (prevHigh + prevLow + prevClose) / 3;
  const r1 = 2 * pp - prevLow;
  const s1 = 2 * pp - prevHigh;
  const r2 = pp + (prevHigh - prevLow);
  const s2 = pp - (prevHigh - prevLow);
  const r3 = prevHigh + 2 * (pp - prevLow);
  const s3 = prevLow - 2 * (prevHigh - pp);
  const range = prevHigh - prevLow;
  const camH3 = prevClose + range * 1.1 / 4;
  const camH4 = prevClose + range * 1.1 / 2;
  const camL3 = prevClose - range * 1.1 / 4;
  const camL4 = prevClose - range * 1.1 / 2;
  return { pp, r1, r2, r3, s1, s2, s3, camH3, camH4, camL3, camL4 };
}

function computePsychologicalRound(price: number): number {
  if (price <= 0) return 0;
  const magnitude = Math.pow(10, Math.floor(Math.log10(price)));
  const roundUnit = magnitude >= 100 ? 100 : magnitude >= 10 ? 10 : magnitude >= 1 ? 1 : 0.1;
  return Math.round(price / roundUnit) * roundUnit;
}

function getPreviousSession(candles: { high: number; low: number; close: number; openTs: number }[]): {
  high: number; low: number; close: number;
} {
  if (candles.length < 2) {
    const c = candles[candles.length - 1] || { high: 0, low: 0, close: 0 };
    return { high: c.high, low: c.low, close: c.close };
  }
  const lastTs = candles[candles.length - 1].openTs;
  const oneDayAgo = lastTs - 86400;
  const sessionCandles = candles.filter(c => c.openTs >= oneDayAgo && c.openTs < lastTs);
  if (sessionCandles.length === 0) {
    const half = Math.floor(candles.length / 2);
    const prevHalf = candles.slice(0, half);
    return {
      high: Math.max(...prevHalf.map(c => c.high)),
      low: Math.min(...prevHalf.map(c => c.low)),
      close: prevHalf[prevHalf.length - 1].close,
    };
  }
  return {
    high: Math.max(...sessionCandles.map(c => c.high)),
    low: Math.min(...sessionCandles.map(c => c.low)),
    close: sessionCandles[sessionCandles.length - 1].close,
  };
}

function computeFibonacciLevels(swingLow: number, swingHigh: number): { retracements: number[]; extensions: number[]; extensionsDown: number[] } {
  const range = swingHigh - swingLow;
  if (range <= 0) return { retracements: [], extensions: [], extensionsDown: [] };
  const retracementRatios = [0.236, 0.382, 0.5, 0.618, 0.786];
  const extensionRatios = [1.272, 1.618, 2.0];
  const retracements = retracementRatios.map(r => swingHigh - range * r);
  const extensions = extensionRatios.map(r => swingLow + range * r);
  const extensionsDown = extensionRatios.map(r => swingHigh - range * r).filter(l => l > 0);
  return { retracements, extensions, extensionsDown };
}

function detectRegime(closes: number[], atrVal: number, ema20: number[]): string {
  if (closes.length < 20) return "ranging";
  const recentEma = ema20.slice(-20);
  const slopePoints = recentEma.slice(-5);
  const slope = (slopePoints[slopePoints.length - 1] - slopePoints[0]) / slopePoints[0];
  const currentPrice = closes[closes.length - 1];
  const vol = atrVal / currentPrice;
  if (vol > 0.003) return "volatile";
  if (slope > 0.001) return "trending_up";
  if (slope < -0.001) return "trending_down";
  return "ranging";
}

export async function computeFeatures(symbol: string, lookback = 100): Promise<FeatureVector | null> {
  // Get recent candles
  const candles = await db.select().from(candlesTable)
    .where(and(eq(candlesTable.symbol, symbol), eq(candlesTable.timeframe, "1m")))
    .orderBy(desc(candlesTable.openTs))
    .limit(lookback);

  if (candles.length < 30) return null;

  // Reverse to chronological order
  candles.reverse();

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const opens = candles.map(c => c.open);

  const last = candles[candles.length - 1];
  const price = last.close;

  // EMA
  const ema20Arr = ema(closes, 20);
  const ema50Arr = ema(closes, Math.min(50, closes.length));
  const ema20 = ema20Arr[ema20Arr.length - 1];
  const ema20Prev = ema20Arr[ema20Arr.length - 2] || ema20;
  const emaSlope = (ema20 - ema20Prev) / ema20;
  const emaDist = (price - ema20) / ema20;

  // RSI
  const rsi14 = rsi(closes, 14);
  const rsiZone = rsi14 < 30 ? -1 : rsi14 > 70 ? 1 : 0;

  // ATR
  const atr14 = atr(highs, lows, closes, 14) / price;
  const atr50 = atr(highs, lows, closes, Math.min(50, closes.length)) / price;
  const atrRank = atr50 > 0 ? Math.min(atr14 / atr50, 2) : 1;

  // Bollinger Bands (20, 2)
  const bbPeriod = 20;
  const bbCloses = closes.slice(-bbPeriod);
  const bbMean = mean(bbCloses);
  const bbStd = stdDev(bbCloses);
  const bbUpper = bbMean + 2 * bbStd;
  const bbLower = bbMean - 2 * bbStd;
  const bbWidth = bbStd > 0 ? (bbUpper - bbLower) / bbMean : 0;
  const bbPctB = bbStd > 0 ? (price - bbLower) / (bbUpper - bbLower) : 0.5;

  // Candle structure
  const range = last.high - last.low;
  const body = Math.abs(last.close - last.open);
  const candleBody = range > 0 ? body / range : 0;
  const upperWick = range > 0 ? (last.high - Math.max(last.open, last.close)) / Math.max(body, 0.0001) : 0;
  const lowerWick = range > 0 ? (Math.min(last.open, last.close) - last.low) / Math.max(body, 0.0001) : 0;

  // Consecutive candles
  let consecutive = 0;
  for (let i = candles.length - 1; i >= 1; i--) {
    const up = candles[i].close > candles[i].open;
    const prevUp = candles[i - 1].close > candles[i - 1].open;
    if (i === candles.length - 1) {
      consecutive = up ? 1 : -1;
    } else if ((up && consecutive > 0) || (!up && consecutive < 0)) {
      consecutive += up ? 1 : -1;
    } else {
      break;
    }
  }

  // Z-score
  const z20Closes = closes.slice(-20);
  const z20Mean = mean(z20Closes);
  const z20Std = stdDev(z20Closes);
  const zScore = z20Std > 0 ? (price - z20Mean) / z20Std : 0;
  const rollingSkew = skewness(z20Closes);

  // Spike features
  const recentSpikes = await db.select().from(spikeEventsTable)
    .where(eq(spikeEventsTable.symbol, symbol))
    .orderBy(desc(spikeEventsTable.eventTs))
    .limit(10);

  let ticksSinceSpike = 9999;
  let runLengthSinceSpike = 500;
  let spikeHazardScore = 0;

  if (recentSpikes.length > 0) {
    const lastSpike = recentSpikes[0];
    ticksSinceSpike = lastSpike.ticksSincePreviousSpike ?? 999;
    runLengthSinceSpike = candles.length; // approximation

    // Compute mean interval between spikes
    if (recentSpikes.length >= 3) {
      const intervals = recentSpikes
        .slice(0, 8)
        .map(s => s.ticksSincePreviousSpike ?? 0)
        .filter(i => i > 0);
      const meanInterval = mean(intervals);
      const stdInterval = stdDev(intervals);
      // Hazard score: how many std devs past the mean interval have we gone?
      if (stdInterval > 0) {
        const z = (ticksSinceSpike - meanInterval) / stdInterval;
        // Sigmoid to compress into 0-1
        spikeHazardScore = 1 / (1 + Math.exp(-z));
      } else {
        spikeHazardScore = ticksSinceSpike > meanInterval ? 0.7 : 0.3;
      }
    }
  }

  const regimeLabel = detectRegime(closes, atr14, ema20Arr);

  const { swingHigh, swingLow } = findSwingLevels(highs, lows, 5);
  const swingHighDist = (price - swingHigh) / price;
  const swingLowDist = (price - swingLow) / price;
  const swingResult = detectSwingBreachAndReclaim(candles, swingHigh, swingLow);
  const fibLevels = computeFibonacciLevels(swingLow, swingHigh);

  // BB width rate-of-change
  const bbWidthPrev = closes.length > 25 ? computeBbWidthAtIndex(closes, closes.length - 6) : bbWidth;
  const bbWidthRoc = bbWidthPrev > 0 ? (bbWidth - bbWidthPrev) / bbWidthPrev : 0;

  // ATR acceleration
  const atr14Prev = closes.length > 20 ? atr(highs.slice(0, -5), lows.slice(0, -5), closes.slice(0, -5), 14) / (closes[closes.length - 6] || price) : atr14;
  const atrAccel = atr14Prev > 0 ? (atr14 / atr14Prev) - 1 : 0;

  // Time features
  const candleDate = new Date(last.closeTs * 1000);
  const hourOfDay = candleDate.getUTCHours();
  const dayOfWeek = candleDate.getUTCDay();

  // Cross-index rolling correlation
  let crossCorrelation = 0;
  const pairedSymbol = getPairedSymbol(symbol);
  if (pairedSymbol) {
    const pairedCandles = await db.select().from(candlesTable)
      .where(and(eq(candlesTable.symbol, pairedSymbol), eq(candlesTable.timeframe, "1m")))
      .orderBy(desc(candlesTable.openTs))
      .limit(30);
    if (pairedCandles.length >= 10) {
      pairedCandles.reverse();
      const pairedCloses = pairedCandles.map(c => c.close);
      const alignedOwn = closes.slice(-pairedCloses.length);
      crossCorrelation = pearsonCorrelation(alignedOwn, pairedCloses);
    }
  }

  const vwap = computeVWAP(candles);

  const prevSession = getPreviousSession(candles as unknown as { high: number; low: number; close: number; openTs: number }[]);
  const pivots = computePivotPoints(prevSession.high, prevSession.low, prevSession.close);
  const psychRound = computePsychologicalRound(price);

  return {
    symbol,
    ts: last.closeTs,
    emaSlope,
    emaDist,
    priceVsEma20: emaDist,
    rsi14,
    rsiZone,
    atr14,
    bbWidth,
    bbPctB,
    atrRank,
    candleBody,
    upperWickRatio: upperWick,
    lowerWickRatio: lowerWick,
    consecutive,
    zScore,
    rollingSkew,
    ticksSinceSpike,
    runLengthSinceSpike,
    spikeHazardScore,
    swingHighDist,
    swingLowDist,
    swingBreached: swingResult.breached,
    swingReclaimed: swingResult.reclaimed,
    swingBreachCandles: swingResult.breachCandles,
    swingBreachDirection: swingResult.breachDirection,
    bbWidthRoc,
    atrAccel,
    hourOfDay,
    dayOfWeek,
    crossCorrelation,
    regimeLabel,
    swingHigh,
    swingLow,
    fibRetraceLevels: fibLevels.retracements,
    fibExtensionLevels: fibLevels.extensions,
    bbUpper,
    bbLower,
    latestClose: price,
    fibExtensionLevelsDown: fibLevels.extensionsDown,
    vwap,
    pivotPoint: pivots.pp,
    pivotR1: pivots.r1,
    pivotR2: pivots.r2,
    pivotR3: pivots.r3,
    pivotS1: pivots.s1,
    pivotS2: pivots.s2,
    pivotS3: pivots.s3,
    camarillaH3: pivots.camH3,
    camarillaH4: pivots.camH4,
    camarillaL3: pivots.camL3,
    camarillaL4: pivots.camL4,
    psychRound,
    prevSessionHigh: prevSession.high,
    prevSessionLow: prevSession.low,
    prevSessionClose: prevSession.close,
  };
}

export async function buildAndStoreFeaturesForSymbol(symbol: string): Promise<number> {
  const candles = await db.select().from(candlesTable)
    .where(and(eq(candlesTable.symbol, symbol), eq(candlesTable.timeframe, "1m")))
    .orderBy(desc(candlesTable.openTs))
    .limit(500);

  if (candles.length < 30) return 0;
  candles.reverse();

  let stored = 0;
  // Compute features every 10 candles (sliding window)
  for (let i = 50; i < candles.length; i += 10) {
    const window = candles.slice(0, i + 1);
    const closes = window.map(c => c.close);
    const highs = window.map(c => c.high);
    const lows = window.map(c => c.low);
    const last = window[window.length - 1];
    const price = last.close;

    const ema20Arr = ema(closes, 20);
    const ema20 = ema20Arr[ema20Arr.length - 1];
    const ema20Prev = ema20Arr[ema20Arr.length - 2] || ema20;
    const emaSlope = (ema20 - ema20Prev) / ema20;
    const rsi14 = rsi(closes, 14);
    const atr14v = atr(highs, lows, closes, 14) / price;
    const bbCloses = closes.slice(-20);
    const bbMean = mean(bbCloses);
    const bbStd = stdDev(bbCloses);
    const bbWidth = bbStd > 0 ? (4 * bbStd) / bbMean : 0;
    const zScore = bbStd > 0 ? (price - bbMean) / bbStd : 0;
    const regimeLabel = detectRegime(closes, atr14v, ema20Arr);

    // Target label: did price go up in next 10 candles?
    const futureClose = i + 10 < candles.length ? candles[i + 10].close : null;
    const targetLabel = futureClose ? (futureClose > price ? "1" : "0") : null;

    try {
      await db.insert(featuresTable).values({
        symbol,
        ts: last.closeTs,
        featureJson: { emaSlope, rsi14, atr14: atr14v, bbWidth, zScore },
        regimeLabel,
        targetLabel,
      });
      stored++;
    } catch {
      // skip duplicates
    }
  }
  return stored;
}
