/**
 * featureSlice.ts — V3 Isolated Backtest Feature Computation
 *
 * Computes a FeatureVector from an in-memory candle slice. No database calls,
 * no spike event tables, no cross-correlation DB reads. Designed for the V3
 * backtest engine which replays historical candles bar-by-bar.
 *
 * Spike hazard / cross-correlation are zeroed out (spike=0, crossCorr=0,
 * spikeMagnitude=null) — these require real-time DB state and cannot be
 * reconstructed from candle data alone without O(n²) lookups per bar.
 *
 * All private math helpers from features.ts are replicated inline — this file
 * must NOT import from features.ts to stay fully isolated.
 *
 * Exported helpers still used:
 *   aggregateCandles, getSymbolIndicatorTimeframeMins,
 *   findSwingLevels, findMultiSwingTrendlines
 * (These are pure functions with no DB access.)
 */

import type { FeatureVector } from "../features.js";
import {
  aggregateCandles,
  getSymbolIndicatorTimeframeMins,
  findSwingLevels,
  findMultiSwingTrendlines,
  findMajorSwingLevels,
} from "../features.js";

export type CandleRow = {
  open: number;
  high: number;
  low: number;
  close: number;
  openTs: number;
  closeTs: number;
};

// ── Inlined math helpers ──────────────────────────────────────────────────────

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

function calcAtr(highs: number[], lows: number[], closes: number[], period = 14): number {
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

function computeBbWidthAtIndex(closes: number[], idx: number, period = 20): number {
  const start = Math.max(0, idx - period + 1);
  const window = closes.slice(start, idx + 1);
  if (window.length < 2) return 0;
  const m = mean(window);
  const s = stdDev(window);
  return s > 0 ? (4 * s) / m : 0;
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

function computePivotPoints(prevHigh: number, prevLow: number, prevClose: number) {
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

function computeFibonacciLevels(swingLow: number, swingHigh: number): {
  retracements: number[]; extensions: number[]; extensionsDown: number[];
} {
  const range = swingHigh - swingLow;
  if (range <= 0) return { retracements: [], extensions: [], extensionsDown: [] };
  const retracementRatios = [0.236, 0.382, 0.5, 0.618, 0.786];
  const extensionRatios = [1.272, 1.618, 2.0];
  const retracements = retracementRatios.map(r => swingHigh - range * r);
  const extensions = extensionRatios.map(r => swingLow + range * r);
  const extensionsDown = extensionRatios.map(r => swingHigh - range * r).filter(l => l > 0);
  return { retracements, extensions, extensionsDown };
}

function detectRegime(closes: number[], atrVal: number, ema20Arr: number[]): string {
  if (closes.length < 20) return "ranging";
  const recentEma = ema20Arr.slice(-20);
  const slopePoints = recentEma.slice(-5);
  const slope = (slopePoints[slopePoints.length - 1] - slopePoints[0]) / slopePoints[0];
  const currentPrice = closes[closes.length - 1];
  const vol = atrVal / currentPrice;
  if (vol > 0.003) return "volatile";
  if (slope > 0.001) return "trending_up";
  if (slope < -0.001) return "trending_down";
  return "ranging";
}

// ── Spike candle counting (in-data, no DB) ────────────────────────────────────

function computeSpikeCounts(
  candles: CandleRow[],
  symbol: string
): { spikeCount4h: number; spikeCount24h: number; spikeCount7d: number } {
  const isBoomCrash = symbol.startsWith("BOOM") || symbol.startsWith("CRASH");
  if (!isBoomCrash || candles.length < 2) {
    return { spikeCount4h: 0, spikeCount24h: 0, spikeCount7d: 0 };
  }
  const isCrash = symbol.startsWith("CRASH");
  const spikeThreshold = 0.01;
  const fourH = 4 * 60;
  const twentyFourH = 24 * 60;
  const sevenD = 7 * 24 * 60;
  let count4h = 0, count24h = 0, count7d = 0;

  for (let ci = candles.length - 1; ci >= 1; ci--) {
    const back = candles.length - 1 - ci;
    if (back > sevenD) break;
    const rawMove = (candles[ci].close - candles[ci - 1].close) / candles[ci - 1].close;
    const isSpike = isCrash ? rawMove < -spikeThreshold : rawMove > spikeThreshold;
    if (isSpike) {
      if (back <= fourH) count4h++;
      if (back <= twentyFourH) count24h++;
      count7d++;
    }
  }
  return { spikeCount4h: count4h, spikeCount24h: count24h, spikeCount7d: count7d };
}

// ── Main export: computeFeaturesFromSlice ─────────────────────────────────────

/**
 * Compute a FeatureVector from an in-memory candle slice.
 *
 * @param symbol  Active symbol (CRASH300 | BOOM300 | R_75 | R_100)
 * @param candles Chronologically-ascending 1m candles (oldest first)
 *                Minimum ~100 bars recommended; 1500 for full structural coverage.
 *
 * Spike hazard fields are set to neutral defaults (spikeHazardScore=0,
 * runLengthSinceSpike=500, ticksSinceSpike=9999) — they require DB spike_events
 * which are not available in an isolated backtest slice.
 */
export function computeFeaturesFromSlice(
  symbol: string,
  candles: CandleRow[]
): FeatureVector | null {
  if (candles.length < 30) return null;

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  const last = candles[candles.length - 1];
  const price = last.close;

  const indicatorTfMins = getSymbolIndicatorTimeframeMins(symbol);
  const htfCandles = aggregateCandles(
    candles as { open: number; high: number; low: number; close: number; openTs: number; closeTs: number }[],
    indicatorTfMins
  );
  const htfCloses = htfCandles.map(c => c.close);
  const htfHighs = htfCandles.map(c => c.high);
  const htfLows = htfCandles.map(c => c.low);

  // ── EMA ───────────────────────────────────────────────────────────────────
  const ema20Arr = ema(htfCloses, 20);
  const ema20 = ema20Arr[ema20Arr.length - 1];
  const ema20Prev = ema20Arr[ema20Arr.length - 2] ?? ema20;
  const emaSlope = (ema20 - ema20Prev) / ema20;
  const emaDist = (price - ema20) / ema20;

  // ── RSI ───────────────────────────────────────────────────────────────────
  const rsi14 = rsi(htfCloses, 14);
  const rsiZone = rsi14 < 30 ? -1 : rsi14 > 70 ? 1 : 0;

  // ── ATR ───────────────────────────────────────────────────────────────────
  const atr14 = calcAtr(htfHighs, htfLows, htfCloses, 14) / price;
  const atr50 = calcAtr(htfHighs, htfLows, htfCloses, Math.min(50, htfCloses.length)) / price;
  const atrRank = atr50 > 0 ? Math.min(calcAtr(htfHighs, htfLows, htfCloses, 14) / (atr50 * price), 2) : 1;

  // ── Bollinger Bands ───────────────────────────────────────────────────────
  const bbPeriod = 20;
  const bbSlice = htfCloses.slice(-bbPeriod);
  const bbMean = mean(bbSlice);
  const bbStd = stdDev(bbSlice);
  const bbUpper = bbMean + 2 * bbStd;
  const bbLower = bbMean - 2 * bbStd;
  const bbWidth = bbStd > 0 ? (bbUpper - bbLower) / bbMean : 0;
  const bbPctB = bbStd > 0 ? (price - bbLower) / (bbUpper - bbLower) : 0.5;

  // ── Candle structure ──────────────────────────────────────────────────────
  const candleRange = last.high - last.low;
  const candleBodyAbs = Math.abs(last.close - last.open);
  const candleBody = candleRange > 0 ? candleBodyAbs / candleRange : 0;
  const upperWickRatio = candleRange > 0
    ? (last.high - Math.max(last.open, last.close)) / Math.max(candleBodyAbs, 0.0001) : 0;
  const lowerWickRatio = candleRange > 0
    ? (Math.min(last.open, last.close) - last.low) / Math.max(candleBodyAbs, 0.0001) : 0;

  // ── Consecutive candles ───────────────────────────────────────────────────
  let consecutive = 0;
  for (let i = candles.length - 1; i >= 1; i--) {
    const up = candles[i].close > candles[i].open;
    if (i === candles.length - 1) {
      consecutive = up ? 1 : -1;
    } else if ((up && consecutive > 0) || (!up && consecutive < 0)) {
      consecutive += up ? 1 : -1;
    } else {
      break;
    }
  }

  // ── Z-score & skewness ────────────────────────────────────────────────────
  const z20Closes = htfCloses.slice(-20);
  const z20Mean = mean(z20Closes);
  const z20Std = stdDev(z20Closes);
  const zScore = z20Std > 0 ? (price - z20Mean) / z20Std : 0;
  const rollingSkew = skewness(z20Closes);

  // ── Spike fields — neutral defaults (no DB in backtest) ───────────────────
  const spikeHazardScore = 0;
  const ticksSinceSpike = 9999;
  const runLengthSinceSpike = 500;

  // ── Price change metrics ──────────────────────────────────────────────────
  const priceChange24hPct = (() => {
    const target = last.openTs - 24 * 3600;
    const idx = candles.findIndex(c => c.openTs >= target);
    if (idx >= 0 && idx < candles.length - 1) {
      return (price - candles[idx].close) / candles[idx].close;
    }
    return 0;
  })();

  const priceChange7dPct = (() => {
    const target = last.openTs - 7 * 86400;
    const idx = candles.findIndex(c => c.openTs >= target);
    if (idx >= 0 && idx < candles.length - 1) {
      return (price - candles[idx].close) / candles[idx].close;
    }
    return 0;
  })();

  // ── 30-day range ──────────────────────────────────────────────────────────
  const { distFromRange30dHighPct, distFromRange30dLowPct } = (() => {
    const target30d = last.openTs - 30 * 86400;
    const range30dCandles = candles.filter(c => c.openTs >= target30d);
    if (range30dCandles.length < 10) {
      return { distFromRange30dHighPct: 0, distFromRange30dLowPct: 0 };
    }
    const high30d = Math.max(...range30dCandles.map(c => c.high));
    const low30d = Math.min(...range30dCandles.map(c => c.low));
    return {
      distFromRange30dHighPct: high30d > 0 ? (price - high30d) / high30d : 0,
      distFromRange30dLowPct: low30d > 0 ? (price - low30d) / low30d : 0,
    };
  })();

  // ── Regime label (pure function, no DB) ───────────────────────────────────
  const regimeLabel = detectRegime(
    htfCloses,
    calcAtr(htfHighs, htfLows, htfCloses, 14),
    ema20Arr
  );

  // ── Swing levels & Fibonacci ──────────────────────────────────────────────
  const { swingHigh, swingLow } = findSwingLevels(highs, lows, 5);
  const swingHighDist = (price - swingHigh) / price;
  const swingLowDist = (price - swingLow) / price;
  const swingResult = detectSwingBreachAndReclaim(candles, swingHigh, swingLow);
  const fibLevels = computeFibonacciLevels(swingLow, swingHigh);

  // ── BB width rate of change ───────────────────────────────────────────────
  const bbWidthPrev = htfCloses.length > 25
    ? computeBbWidthAtIndex(htfCloses, htfCloses.length - 6)
    : bbWidth;
  const bbWidthRoc = bbWidthPrev > 0 ? (bbWidth - bbWidthPrev) / bbWidthPrev : 0;

  // ── ATR acceleration ──────────────────────────────────────────────────────
  const atr14Abs = calcAtr(htfHighs, htfLows, htfCloses, 14);
  const atr14PrevAbs = htfCloses.length > 20
    ? calcAtr(htfHighs.slice(0, -5), htfLows.slice(0, -5), htfCloses.slice(0, -5), 14)
    : atr14Abs;
  const prevPrice5 = htfCloses[htfCloses.length - 6] ?? price;
  const atr14PrevPct = prevPrice5 > 0 ? atr14PrevAbs / prevPrice5 : atr14;
  const atrAccel = atr14PrevPct > 0 ? (atr14 / atr14PrevPct) - 1 : 0;

  // ── Time features ─────────────────────────────────────────────────────────
  const candleDate = new Date(last.closeTs * 1000);
  const hourOfDay = candleDate.getUTCHours();
  const dayOfWeek = candleDate.getUTCDay();

  // ── VWAP ─────────────────────────────────────────────────────────────────
  const vwap = computeVWAP(candles);

  // ── Pivot points ──────────────────────────────────────────────────────────
  const prevSession = getPreviousSession(
    candles as { high: number; low: number; close: number; openTs: number }[]
  );
  const pivots = computePivotPoints(prevSession.high, prevSession.low, prevSession.close);
  const psychRound = computePsychologicalRound(price);

  // ── Major swing levels ────────────────────────────────────────────────────
  const majorSwings = candles.length >= 200
    ? findMajorSwingLevels(highs, lows, 20)
    : { majorSwingHigh: swingHigh, majorSwingLow: swingLow };

  // ── Trendlines ────────────────────────────────────────────────────────────
  const trendlines = findMultiSwingTrendlines(highs, lows, closes, 5, atr14Abs);

  // ── Spike candle counts ───────────────────────────────────────────────────
  const { spikeCount4h, spikeCount24h, spikeCount7d } = computeSpikeCounts(candles, symbol);

  return {
    symbol,
    ts: last.closeTs,
    latestCandleCloseTs: last.closeTs * 1000,
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
    upperWickRatio,
    lowerWickRatio,
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
    crossCorrelation: 0,
    regimeLabel,
    swingHigh,
    swingLow,
    fibRetraceLevels: fibLevels.retracements,
    fibExtensionLevels: fibLevels.extensions,
    bbUpper,
    bbLower,
    latestClose: price,
    latestOpen: last.open,
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
    trendlineResistanceSlope: trendlines.resistance.slope,
    trendlineSupportSlope: trendlines.support.slope,
    trendlineResistanceTouches: trendlines.resistance.touches,
    trendlineSupportTouches: trendlines.support.touches,
    trendlineResistanceLevel: trendlines.resistance.level,
    trendlineSupportLevel: trendlines.support.level,
    spikeMagnitude: null,
    majorSwingHigh: majorSwings.majorSwingHigh,
    majorSwingLow: majorSwings.majorSwingLow,
    spikeCount4h,
    spikeCount24h,
    spikeCount7d,
    priceChange24hPct,
    priceChange7dPct,
    distFromRange30dHighPct,
    distFromRange30dLowPct,
  };
}
