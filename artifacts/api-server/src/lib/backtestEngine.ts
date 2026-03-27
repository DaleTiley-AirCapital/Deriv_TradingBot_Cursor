import { db, candlesTable, platformStateTable } from "@workspace/db";
import { eq, and, asc, gte, lte } from "drizzle-orm";
import { runAllStrategies, type SignalCandidate } from "./strategies.js";
import { calculateProfitTrailingStop, calculateSRFibTP, calculateSRFibSL } from "./tradeEngine.js";
import { classifyRegime, type RegimeClassification } from "./regimeEngine.js";
import type { FeatureVector } from "./features.js";
import type { ScoringWeights } from "./scoring.js";

const PROFIT_TRAILING_DRAWDOWN_PCT = 0.30;
const TIME_EXIT_PROFIT_HOURS = 72;
const MAX_EXIT_HOURS = 168;
const MAX_EQUITY_DEPLOYED_PCT = 0.80;
const HOURLY_WINDOW_SEC = 3600;

interface HourlyAccumulator {
  samples: Array<{
    emaSlope: number; rsi14: number; bbWidth: number; bbWidthRoc: number;
    atr14: number; atrRank: number; atrAccel: number; zScore: number;
    spikeHazardScore: number; bbPctB: number;
  }>;
  windowStartTs: number;
}

function backtestAccumulateHourly(
  accumulators: Record<string, HourlyAccumulator>,
  features: FeatureVector,
  ts: number,
): void {
  const sym = features.symbol;
  if (!accumulators[sym] || (ts - accumulators[sym].windowStartTs) >= HOURLY_WINDOW_SEC) {
    accumulators[sym] = { samples: [], windowStartTs: ts };
  }
  accumulators[sym].samples.push({
    emaSlope: features.emaSlope, rsi14: features.rsi14,
    bbWidth: features.bbWidth, bbWidthRoc: features.bbWidthRoc,
    atr14: features.atr14, atrRank: features.atrRank,
    atrAccel: features.atrAccel, zScore: features.zScore,
    spikeHazardScore: features.spikeHazardScore, bbPctB: features.bbPctB,
  });
}

function backtestClassifyRegimeHTF(
  accumulators: Record<string, HourlyAccumulator>,
  features: FeatureVector,
): RegimeClassification {
  const acc = accumulators[features.symbol];
  if (acc && acc.samples.length >= 3) {
    const n = acc.samples.length;
    const avg = (fn: (s: typeof acc.samples[0]) => number) => acc.samples.reduce((s, x) => s + fn(x), 0) / n;
    const htfFeatures: FeatureVector = {
      ...features,
      emaSlope: avg(s => s.emaSlope), rsi14: avg(s => s.rsi14),
      bbWidth: avg(s => s.bbWidth), bbWidthRoc: avg(s => s.bbWidthRoc),
      atr14: avg(s => s.atr14), atrRank: avg(s => s.atrRank),
      atrAccel: avg(s => s.atrAccel), zScore: avg(s => s.zScore),
      spikeHazardScore: avg(s => s.spikeHazardScore), bbPctB: avg(s => s.bbPctB),
    };
    return classifyRegime(htfFeatures);
  }
  return classifyRegime(features);
}

const DEFAULT_MAX_CONCURRENT_LIVE = 3;
const DEFAULT_MAX_CONCURRENT_PAPER = 3;
const DEFAULT_LIVE_BASE_PCT = 0.08;
const DEFAULT_PAPER_BASE_PCT = 0.16;

export interface BacktestConfig {
  symbol?: string;
  symbols?: string[];
  strategyName?: string;
  initialCapital: number;
  mode: "live" | "paper";
  maxConcurrentPositions?: number;
  basePct?: number;
  startDate?: Date;
  endDate?: Date;
  walkForward?: WalkForwardConfig;
  minCompositeScore?: number;
  minEvThreshold?: number;
  minRrRatio?: number;
  scoringWeights?: ScoringWeights;
}

export interface WalkForwardConfig {
  trainMonths: number;
  testMonths: number;
  stepMonths: number;
}

export interface CandleData {
  openTs: number;
  closeTs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  symbol: string;
}

interface OpenPosition {
  symbol: string;
  strategyName: string;
  direction: "buy" | "sell";
  entryPrice: number;
  entryTs: number;
  sl: number;
  tp: number;
  peakPrice: number;
  currentSl: number;
  confidence: number;
  positionSize: number;
  maxExitTs: number;
  extended: boolean;
}

export interface BacktestTrade {
  symbol: string;
  strategyName: string;
  direction: string;
  entryPrice: number;
  exitPrice: number;
  entryTs: Date;
  exitTs: Date;
  pnl: number;
  holdingHours: number;
  exitReason: string;
  confidence: number;
  positionSize: number;
}

export interface StrategyMetrics {
  totalReturn: number;
  netProfit: number;
  grossProfit: number;
  grossLoss: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  expectancy: number;
  profitFactor: number;
  maxDrawdown: number;
  maxDrawdownDuration: number;
  tradeCount: number;
  avgHoldingHours: number;
  sharpeRatio: number;
  equityCurve: { ts: string; equity: number }[];
  monthlyReturns: Record<string, number>;
  returnBySymbol: Record<string, number>;
  returnByRegime: Record<string, number>;
}

export interface WalkForwardFold {
  foldIndex: number;
  trainStart: string;
  trainEnd: string;
  testStart: string;
  testEnd: string;
  inSample: StrategyMetrics;
  outOfSample: StrategyMetrics;
}

export interface WalkForwardResult {
  folds: WalkForwardFold[];
  aggregateOOS: StrategyMetrics;
  overfittingRatio: number;
}

export interface BacktestResult {
  strategyMetrics: Record<string, StrategyMetrics>;
  portfolioMetrics: StrategyMetrics;
  trades: BacktestTrade[];
  walkForward?: WalkForwardResult;
  inSample?: StrategyMetrics;
  outOfSample?: StrategyMetrics;
  config: {
    symbols: string[];
    strategies: string[];
    initialCapital: number;
    mode: string;
  };
}

function emaCalc(values: number[], period: number): number[] {
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

function rsiCalc(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  const changes = closes.slice(1).map((c, i) => c - closes[i]);
  const window = changes.slice(-period);
  const gains = window.filter(c => c > 0);
  const losses = window.filter(c => c < 0).map(Math.abs);
  const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / period : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / period : 0;
  if (avgLoss === 0) return avgGain > 0 ? 100 : 50;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function atrCalc(highs: number[], lows: number[], closes: number[], period = 14): number {
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
  const w = trs.slice(-period);
  return w.reduce((a, b) => a + b, 0) / w.length;
}

function meanCalc(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdDevCalc(arr: number[]): number {
  if (arr.length === 0) return 0;
  const m = meanCalc(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
}

function skewnessCalc(arr: number[]): number {
  const m = meanCalc(arr);
  const s = stdDevCalc(arr);
  if (s === 0) return 0;
  return arr.reduce((a, b) => a + ((b - m) / s) ** 3, 0) / arr.length;
}

function detectRegime(closes: number[], atrVal: number, ema20: number[]): string {
  if (closes.length < 20) return "ranging";
  const slopePoints = ema20.slice(-5);
  const slope = (slopePoints[slopePoints.length - 1] - slopePoints[0]) / slopePoints[0];
  const currentPrice = closes[closes.length - 1];
  const vol = atrVal / currentPrice;
  if (vol > 0.003) return "volatile";
  if (slope > 0.001) return "trending_up";
  if (slope < -0.001) return "trending_down";
  return "ranging";
}

export function computeFeaturesFromCandles(
  candles: CandleData[],
  symbol: string,
): FeatureVector | null {
  if (candles.length < 30) return null;

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const last = candles[candles.length - 1];
  const price = last.close;

  const ema20Arr = emaCalc(closes, 20);
  const ema20 = ema20Arr[ema20Arr.length - 1];
  const ema20Prev = ema20Arr[ema20Arr.length - 2] || ema20;
  const emaSlope = (ema20 - ema20Prev) / ema20;
  const emaDist = (price - ema20) / ema20;

  const rsi14 = rsiCalc(closes, 14);
  const rsiZone = rsi14 < 30 ? -1 : rsi14 > 70 ? 1 : 0;

  const atr14Raw = atrCalc(highs, lows, closes, 14);
  const atr14 = atr14Raw / price;
  const atr50 = atrCalc(highs, lows, closes, Math.min(50, closes.length)) / price;
  const atrRank = atr50 > 0 ? Math.min(atr14 / atr50, 2) : 1;

  const bbPeriod = 20;
  const bbCloses = closes.slice(-bbPeriod);
  const bbMean = meanCalc(bbCloses);
  const bbStd = stdDevCalc(bbCloses);
  const bbUpper = bbMean + 2 * bbStd;
  const bbLower = bbMean - 2 * bbStd;
  const bbWidth = bbStd > 0 ? (bbUpper - bbLower) / bbMean : 0;
  const bbPctB = bbStd > 0 ? (price - bbLower) / (bbUpper - bbLower) : 0.5;

  const range = last.high - last.low;
  const body = Math.abs(last.close - last.open);
  const candleBody = range > 0 ? body / range : 0;
  const upperWick = range > 0 ? (last.high - Math.max(last.open, last.close)) / Math.max(body, 0.0001) : 0;
  const lowerWick = range > 0 ? (Math.min(last.open, last.close) - last.low) / Math.max(body, 0.0001) : 0;

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

  const z20Closes = closes.slice(-20);
  const z20Mean = meanCalc(z20Closes);
  const z20Std = stdDevCalc(z20Closes);
  const zScore = z20Std > 0 ? (price - z20Mean) / z20Std : 0;
  const rollingSkew = skewnessCalc(z20Closes);

  const regimeLabel = detectRegime(closes, atr14Raw, ema20Arr);

  const swingLookback = Math.min(10, candles.length - 1);
  let swingHigh = -Infinity;
  let swingLow = Infinity;
  for (let i = candles.length - 2; i >= Math.max(0, candles.length - 1 - swingLookback); i--) {
    if (candles[i].high > swingHigh) swingHigh = candles[i].high;
    if (candles[i].low < swingLow) swingLow = candles[i].low;
  }
  if (swingHigh === -Infinity) swingHigh = price;
  if (swingLow === Infinity) swingLow = price;
  const swingHighDist = (price - swingHigh) / price;
  const swingLowDist = (price - swingLow) / price;
  const swingBreached = last.high > swingHigh || last.low < swingLow;
  const swingReclaimed = swingBreached && last.close >= swingLow && last.close <= swingHigh;
  const swingBreachCandles = 0;
  const swingBreachDirection: "above" | "below" | null = last.high > swingHigh ? "above" : last.low < swingLow ? "below" : null;

  const bbClosesRoc = closes.slice(-25);
  let bbWidthRoc = 0;
  if (bbClosesRoc.length >= 25) {
    const prev5 = bbClosesRoc.slice(-25, -20);
    const prevMean = meanCalc(prev5);
    const prevStd = stdDevCalc(prev5);
    const prevWidth = prevStd > 0 ? (4 * prevStd) / prevMean : 0;
    bbWidthRoc = prevWidth > 0 ? (bbWidth - prevWidth) / prevWidth : 0;
  }

  let atrAccel = 0;
  if (candles.length > 19) {
    const prevHighs = highs.slice(-19, -14);
    const prevLows = lows.slice(-19, -14);
    const prevCloses = closes.slice(-19, -14);
    if (prevHighs.length >= 2) {
      const prevAtr = atrCalc(prevHighs, prevLows, prevCloses, Math.min(14, prevHighs.length)) / (prevCloses[prevCloses.length - 1] || 1);
      atrAccel = prevAtr > 0 ? atr14 / prevAtr - 1 : 0;
    }
  }

  const lastTs = last.openTs;
  const lastDate = new Date(lastTs * 1000);
  const hourOfDay = lastDate.getUTCHours();
  const dayOfWeek = lastDate.getUTCDay();

  const crossCorrelation = 0;

  const fibRange = swingHigh - swingLow;
  const fibRetraceLevels = fibRange > 0
    ? [0.236, 0.382, 0.5, 0.618, 0.786].map(r => swingHigh - fibRange * r)
    : [];
  const fibExtensionLevels = fibRange > 0
    ? [1.272, 1.618, 2.0].map(r => swingLow + fibRange * r)
    : [];
  const fibExtensionLevelsDown = fibRange > 0
    ? [1.272, 1.618, 2.0].map(r => swingHigh - fibRange * r).filter(l => l > 0)
    : [];

  const largeMoves = closes.slice(-50).filter((c, i, arr) => {
    if (i === 0) return false;
    return Math.abs(c - arr[i - 1]) / arr[i - 1] > atr14 * 3;
  });
  const candlesSinceLastLargeMove = (() => {
    for (let i = candles.length - 1; i >= 1; i--) {
      const move = Math.abs(candles[i].close - candles[i - 1].close) / candles[i - 1].close;
      if (move > atr14 * 3) return candles.length - 1 - i;
    }
    return 500;
  })();
  const spikeHazardScore = Math.min(1, candlesSinceLastLargeMove / 200);

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
    ticksSinceSpike: candlesSinceLastLargeMove * 100,
    runLengthSinceSpike: candlesSinceLastLargeMove,
    spikeHazardScore,
    swingHighDist,
    swingLowDist,
    swingBreached,
    swingReclaimed,
    swingBreachCandles,
    swingBreachDirection,
    bbWidthRoc,
    atrAccel,
    hourOfDay,
    dayOfWeek,
    crossCorrelation,
    regimeLabel,
    swingHigh,
    swingLow,
    fibRetraceLevels,
    fibExtensionLevels,
    fibExtensionLevelsDown,
    bbUpper,
    bbLower,
    latestClose: price,
  };
}

function computeMetrics(
  trades: BacktestTrade[],
  initialCapital: number,
  equityCurve: { ts: string; equity: number }[],
): StrategyMetrics {
  if (trades.length === 0) {
    return {
      totalReturn: 0, netProfit: 0, grossProfit: 0, grossLoss: 0,
      winRate: 0, avgWin: 0, avgLoss: 0, expectancy: 0, profitFactor: 0,
      maxDrawdown: 0, maxDrawdownDuration: 0, tradeCount: 0,
      avgHoldingHours: 0, sharpeRatio: 0,
      equityCurve, monthlyReturns: {}, returnBySymbol: {}, returnByRegime: {},
    };
  }

  const wins = trades.filter(t => t.pnl > 0);
  const lossTrades = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(lossTrades.reduce((s, t) => s + t.pnl, 0));
  const netProfit = trades.reduce((s, t) => s + t.pnl, 0);
  const winRate = wins.length / trades.length;
  const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
  const avgLoss = lossTrades.length > 0 ? grossLoss / lossTrades.length : 0;
  const expectancy = netProfit / trades.length;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);
  const totalReturn = netProfit / initialCapital;
  const avgHoldingHours = trades.reduce((s, t) => s + t.holdingHours, 0) / trades.length;

  let peak = initialCapital;
  let maxDrawdown = 0;
  let maxDrawdownDuration = 0;
  let drawdownStartTs = equityCurve.length > 0 ? new Date(equityCurve[0].ts).getTime() : Date.now();
  let inDrawdown = false;
  for (const point of equityCurve) {
    const pointTs = new Date(point.ts).getTime();
    if (point.equity >= peak) {
      if (inDrawdown) {
        const durationHours = (pointTs - drawdownStartTs) / 3600000;
        if (durationHours > maxDrawdownDuration) maxDrawdownDuration = durationHours;
        inDrawdown = false;
      }
      peak = point.equity;
      drawdownStartTs = pointTs;
    }
    const dd = (point.equity - peak) / peak;
    if (dd < maxDrawdown) {
      maxDrawdown = dd;
    }
    if (dd < 0 && !inDrawdown) {
      inDrawdown = true;
      drawdownStartTs = pointTs;
    }
  }
  if (inDrawdown && equityCurve.length > 0) {
    const lastTs = new Date(equityCurve[equityCurve.length - 1].ts).getTime();
    const durationHours = (lastTs - drawdownStartTs) / 3600000;
    if (durationHours > maxDrawdownDuration) maxDrawdownDuration = durationHours;
  }

  const returns = equityCurve.slice(1).map((v, i) =>
    (v.equity - equityCurve[i].equity) / equityCurve[i].equity
  );
  const meanReturn = returns.length > 0 ? meanCalc(returns) : 0;
  const stdReturn = returns.length > 0 ? stdDevCalc(returns) : 0;
  const sharpeRatio = stdReturn > 0 ? (meanReturn / stdReturn) * Math.sqrt(252) : 0;

  const monthlyReturns: Record<string, number> = {};
  for (const t of trades) {
    const key = `${t.exitTs.getFullYear()}-${String(t.exitTs.getMonth() + 1).padStart(2, "0")}`;
    monthlyReturns[key] = (monthlyReturns[key] || 0) + t.pnl;
  }

  const returnBySymbol: Record<string, number> = {};
  for (const t of trades) {
    returnBySymbol[t.symbol] = (returnBySymbol[t.symbol] || 0) + t.pnl;
  }

  const returnByRegime: Record<string, number> = {};

  return {
    totalReturn, netProfit, grossProfit, grossLoss, winRate,
    avgWin, avgLoss, expectancy, profitFactor,
    maxDrawdown, maxDrawdownDuration, tradeCount: trades.length,
    avgHoldingHours, sharpeRatio,
    equityCurve, monthlyReturns, returnBySymbol, returnByRegime,
  };
}

export async function loadCandles(
  symbol: string,
  startDate?: Date,
  endDate?: Date,
): Promise<CandleData[]> {
  const conditions = [
    eq(candlesTable.symbol, symbol),
    eq(candlesTable.timeframe, "1m"),
  ];
  if (startDate) {
    conditions.push(gte(candlesTable.openTs, Math.floor(startDate.getTime() / 1000)));
  }
  if (endDate) {
    conditions.push(lte(candlesTable.openTs, Math.floor(endDate.getTime() / 1000)));
  }

  const rows = await db.select().from(candlesTable)
    .where(and(...conditions))
    .orderBy(asc(candlesTable.openTs));

  return rows.map(r => ({
    openTs: r.openTs,
    closeTs: r.closeTs,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    symbol: r.symbol,
  }));
}

function simulateOnCandles(
  allCandlesBySymbol: Record<string, CandleData[]>,
  config: BacktestConfig,
  strategies?: string[],
): { trades: BacktestTrade[]; equityCurve: { ts: string; equity: number }[] } {
  const maxConcurrent = config.maxConcurrentPositions ??
    (config.mode === "live" ? DEFAULT_MAX_CONCURRENT_LIVE : DEFAULT_MAX_CONCURRENT_PAPER);
  const basePct = config.basePct ??
    (config.mode === "live" ? DEFAULT_LIVE_BASE_PCT : DEFAULT_PAPER_BASE_PCT);

  let equity = config.initialCapital;
  const openPositions: OpenPosition[] = [];
  const completedTrades: BacktestTrade[] = [];
  const equityCurve: { ts: string; equity: number }[] = [];
  const htfAccumulators: Record<string, HourlyAccumulator> = {};

  const regimeByTrade: Map<BacktestTrade, string> = new Map();

  const allTimestamps = new Set<number>();
  for (const candles of Object.values(allCandlesBySymbol)) {
    for (const c of candles) allTimestamps.add(c.openTs);
  }
  const sortedTimestamps = Array.from(allTimestamps).sort((a, b) => a - b);

  if (sortedTimestamps.length === 0) {
    return { trades: [], equityCurve: [{ ts: new Date().toISOString(), equity: config.initialCapital }] };
  }

  equityCurve.push({
    ts: new Date(sortedTimestamps[0] * 1000).toISOString(),
    equity: config.initialCapital,
  });

  const candleIndexBySymbol: Record<string, number> = {};
  for (const sym of Object.keys(allCandlesBySymbol)) {
    candleIndexBySymbol[sym] = 0;
  }

  const LOOKBACK = 50;

  for (let tsIdx = 0; tsIdx < sortedTimestamps.length; tsIdx++) {
    const ts = sortedTimestamps[tsIdx];
    for (const sym of Object.keys(allCandlesBySymbol)) {
      const candles = allCandlesBySymbol[sym];
      while (candleIndexBySymbol[sym] < candles.length && candles[candleIndexBySymbol[sym]].openTs < ts) {
        candleIndexBySymbol[sym]++;
      }
    }

    for (let p = openPositions.length - 1; p >= 0; p--) {
      const pos = openPositions[p];
      const candles = allCandlesBySymbol[pos.symbol];
      if (!candles) continue;

      const idx = candleIndexBySymbol[pos.symbol];
      if (idx >= candles.length || candles[idx].openTs !== ts) continue;
      const candle = candles[idx];

      const hoursOpen = (ts - pos.entryTs) * 1000 / 3600000;

      let exitPrice: number | null = null;
      let exitReason: string | null = null;

      const slHit = pos.direction === "buy"
        ? candle.low <= pos.currentSl
        : candle.high >= pos.currentSl;
      const tpHit = pos.direction === "buy"
        ? candle.high >= pos.tp
        : candle.low <= pos.tp;

      if (slHit && tpHit) {
        exitPrice = pos.direction === "buy"
          ? (candle.open <= pos.currentSl ? pos.currentSl : pos.tp)
          : (candle.open >= pos.currentSl ? pos.currentSl : pos.tp);
        exitReason = exitPrice === pos.tp ? "TP" : "SL";
      } else if (slHit) {
        exitPrice = pos.currentSl;
        exitReason = "SL";
      } else if (tpHit) {
        exitPrice = pos.tp;
        exitReason = "TP";
      }

      if (!exitPrice) {
        if (pos.direction === "buy") {
          pos.peakPrice = Math.max(pos.peakPrice, candle.high);
        } else {
          pos.peakPrice = Math.min(pos.peakPrice, candle.low);
        }
        const trailResult = calculateProfitTrailingStop({
          entryPrice: pos.entryPrice,
          currentPrice: candle.close,
          peakPrice: pos.peakPrice,
          direction: pos.direction,
          currentSl: pos.currentSl,
        });
        if (trailResult.updated) {
          pos.currentSl = trailResult.newSl;
        }
      }

      if (!exitPrice) {
        const hardMaxTs = pos.entryTs + MAX_EXIT_HOURS * 3600;
        if (ts >= hardMaxTs) {
          exitPrice = candle.close;
          exitReason = "TIME_HARD_CAP_168H";
        } else if (hoursOpen >= TIME_EXIT_PROFIT_HOURS) {
          const unrealizedPnl = pos.direction === "buy"
            ? (candle.close - pos.entryPrice) / pos.entryPrice
            : (pos.entryPrice - candle.close) / pos.entryPrice;

          if (unrealizedPnl > 0) {
            exitPrice = candle.close;
            exitReason = "PROFITABLE_AT_72H";
          }
        }
      }

      if (exitPrice !== null && exitReason !== null) {
        const priceDiff = pos.direction === "buy"
          ? (exitPrice - pos.entryPrice) / pos.entryPrice
          : (pos.entryPrice - exitPrice) / pos.entryPrice;
        const pnl = pos.positionSize * priceDiff;

        const trade: BacktestTrade = {
          symbol: pos.symbol,
          strategyName: pos.strategyName,
          direction: pos.direction,
          entryPrice: pos.entryPrice,
          exitPrice,
          entryTs: new Date(pos.entryTs * 1000),
          exitTs: new Date(ts * 1000),
          pnl,
          holdingHours: hoursOpen,
          exitReason,
          confidence: pos.confidence,
          positionSize: pos.positionSize,
        };

        completedTrades.push(trade);
        equity += pnl;
        openPositions.splice(p, 1);
      }
    }

    const totalDeployed = openPositions.reduce((s, p) => s + p.positionSize, 0);

    for (const sym of Object.keys(allCandlesBySymbol)) {
      const candles = allCandlesBySymbol[sym];
      const idx = candleIndexBySymbol[sym];
      if (idx < LOOKBACK || idx >= candles.length || candles[idx].openTs !== ts) continue;

      const window = candles.slice(Math.max(0, idx - LOOKBACK), idx + 1);
      const features = computeFeaturesFromCandles(window, sym);
      if (!features) continue;

      backtestAccumulateHourly(htfAccumulators, features, ts);
      const cachedRegime = backtestClassifyRegimeHTF(htfAccumulators, features);

      const signals = runAllStrategies(features, config.scoringWeights, cachedRegime);
      const filteredSignals = strategies
        ? signals.filter(s => strategies.includes(s.strategyName))
        : signals;

      const minComposite = config.minCompositeScore ?? 85;
      const minEv = config.minEvThreshold ?? 0.003;
      const minRr = config.minRrRatio ?? 1.5;

      for (const signal of filteredSignals) {
        if (signal.compositeScore < minComposite) continue;
        if (signal.expectedValue < minEv) continue;
        if (openPositions.length >= maxConcurrent) break;

        const alreadyHasPosition = openPositions.some(p => p.symbol === sym);
        if (alreadyHasPosition) continue;

        const currentDeployed = openPositions.reduce((s, p) => s + p.positionSize, 0);
        const maxDeployable = equity * MAX_EQUITY_DEPLOYED_PCT;
        const remainingCapacity = maxDeployable - currentDeployed;
        if (remainingCapacity <= 0) break;

        const scaledPct = basePct * (0.8 + 0.4 * signal.confidence);
        let positionSize = equity * scaledPct;
        positionSize = Math.min(positionSize, remainingCapacity);
        positionSize = Math.max(positionSize, equity * 0.05);
        if (positionSize > remainingCapacity) continue;

        const price = candles[idx].close;
        const atrPct = Math.max(features.atr14, 0.001);

        const tp = calculateSRFibTP({
          entryPrice: price,
          direction: signal.direction,
          swingHigh: features.swingHigh,
          swingLow: features.swingLow,
          fibExtensionLevels: features.fibExtensionLevels,
          fibExtensionLevelsDown: features.fibExtensionLevelsDown,
          bbUpper: features.bbUpper,
          bbLower: features.bbLower,
          atrPct,
        });

        const sl = calculateSRFibSL({
          entryPrice: price,
          direction: signal.direction,
          swingHigh: features.swingHigh,
          swingLow: features.swingLow,
          fibRetraceLevels: features.fibRetraceLevels,
          bbUpper: features.bbUpper,
          bbLower: features.bbLower,
          atrPct,
          positionSize: positionSize,
          equity,
        });

        const tpDist = Math.abs(tp - price);
        const slDist = Math.abs(sl - price);
        if (slDist <= 0 || tpDist / slDist < minRr) continue;

        const entryTs = candles[idx].openTs;
        const maxExitTs = entryTs * 1000 + TIME_EXIT_PROFIT_HOURS * 3600 * 1000;

        openPositions.push({
          symbol: sym,
          strategyName: signal.strategyName,
          direction: signal.direction,
          entryPrice: price,
          entryTs,
          sl,
          tp,
          peakPrice: price,
          currentSl: sl,
          confidence: signal.confidence,
          positionSize,
          maxExitTs,
          extended: false,
        });
      }
    }

    const unrealizedPnl = openPositions.reduce((s, pos) => {
      const sym = pos.symbol;
      const candles = allCandlesBySymbol[sym];
      if (!candles) return s;
      const idx = candleIndexBySymbol[sym];
      if (idx >= candles.length) return s;
      const currentPrice = candles[Math.min(idx, candles.length - 1)].close;
      const diff = pos.direction === "buy"
        ? (currentPrice - pos.entryPrice) / pos.entryPrice
        : (pos.entryPrice - currentPrice) / pos.entryPrice;
      return s + pos.positionSize * diff;
    }, 0);

    if (tsIdx % 24 === 0 || tsIdx === sortedTimestamps.length - 1) {
      equityCurve.push({
        ts: new Date(ts * 1000).toISOString(),
        equity: equity + unrealizedPnl,
      });
    }
  }

  for (const pos of openPositions) {
    const candles = allCandlesBySymbol[pos.symbol];
    if (!candles || candles.length === 0) continue;
    const lastCandle = candles[candles.length - 1];
    const exitPrice = lastCandle.close;
    const priceDiff = pos.direction === "buy"
      ? (exitPrice - pos.entryPrice) / pos.entryPrice
      : (pos.entryPrice - exitPrice) / pos.entryPrice;
    const pnl = pos.positionSize * priceDiff;
    const hoursOpen = (lastCandle.openTs - pos.entryTs) / 3600;

    completedTrades.push({
      symbol: pos.symbol,
      strategyName: pos.strategyName,
      direction: pos.direction,
      entryPrice: pos.entryPrice,
      exitPrice,
      entryTs: new Date(pos.entryTs * 1000),
      exitTs: new Date(lastCandle.openTs * 1000),
      pnl,
      holdingHours: hoursOpen,
      exitReason: "END_OF_DATA",
      confidence: pos.confidence,
      positionSize: pos.positionSize,
    });
    equity += pnl;
  }

  if (equityCurve.length > 0) {
    const last = equityCurve[equityCurve.length - 1];
    if (Math.abs(last.equity - equity) > 0.01) {
      equityCurve.push({
        ts: completedTrades.length > 0
          ? completedTrades[completedTrades.length - 1].exitTs.toISOString()
          : last.ts,
        equity,
      });
    }
  }

  return { trades: completedTrades, equityCurve };
}

function tagRegimes(
  trades: BacktestTrade[],
  allCandlesBySymbol: Record<string, CandleData[]>,
  metrics: StrategyMetrics,
): void {
  for (const trade of trades) {
    const candles = allCandlesBySymbol[trade.symbol];
    if (!candles || candles.length < 30) continue;
    const entryEpoch = Math.floor(trade.entryTs.getTime() / 1000);
    const idx = candles.findIndex(c => c.openTs >= entryEpoch);
    if (idx < 20) continue;
    const window = candles.slice(Math.max(0, idx - 30), idx + 1);
    const closes = window.map(c => c.close);
    const highs = window.map(c => c.high);
    const lows = window.map(c => c.low);
    const ema20Arr = emaCalc(closes, 20);
    const atrVal = atrCalc(highs, lows, closes, 14) / closes[closes.length - 1];
    const regime = detectRegime(closes, atrVal, ema20Arr);
    metrics.returnByRegime[regime] = (metrics.returnByRegime[regime] || 0) + trade.pnl;
  }
}

export async function runFullBacktest(config: BacktestConfig): Promise<BacktestResult> {
  const symbols = config.symbols || (config.symbol ? [config.symbol] : []);
  if (symbols.length === 0) throw new Error("No symbols specified for backtest");

  const strategies = config.strategyName ? [config.strategyName] : undefined;

  const allCandlesBySymbol: Record<string, CandleData[]> = {};
  for (const sym of symbols) {
    const candles = await loadCandles(sym, config.startDate, config.endDate);
    if (candles.length >= 60) {
      allCandlesBySymbol[sym] = candles;
    }
  }

  if (Object.keys(allCandlesBySymbol).length === 0) {
    throw new Error(
      `Insufficient candle data for specified symbols (minimum 60 required). ` +
      `Start the data stream and wait for historical candles to accumulate.`
    );
  }

  const { trades, equityCurve } = simulateOnCandles(allCandlesBySymbol, config, strategies);

  const portfolioMetrics = computeMetrics(trades, config.initialCapital, equityCurve);
  tagRegimes(trades, allCandlesBySymbol, portfolioMetrics);

  const strategyMetrics: Record<string, StrategyMetrics> = {};
  const strategyNames = [...new Set(trades.map(t => t.strategyName))];
  for (const sn of strategyNames) {
    const stratTrades = trades.filter(t => t.strategyName === sn);
    const stratCurve = buildEquityCurveFromTrades(stratTrades, config.initialCapital);
    const m = computeMetrics(stratTrades, config.initialCapital, stratCurve);
    tagRegimes(stratTrades, allCandlesBySymbol, m);
    strategyMetrics[sn] = m;
  }

  const result: BacktestResult = {
    strategyMetrics,
    portfolioMetrics,
    trades,
    config: {
      symbols,
      strategies: strategies || ["trend_continuation", "mean_reversion", "breakout_expansion", "spike_event"],
      initialCapital: config.initialCapital,
      mode: config.mode,
    },
  };

  const allCandles = Object.values(allCandlesBySymbol).flat();
  if (allCandles.length > 0) {
    const allTs = allCandles.map(c => c.openTs).sort((a, b) => a - b);
    const totalRange = allTs[allTs.length - 1] - allTs[0];
    const splitPoint = allTs[0] + totalRange * 0.7;

    const isTrades = trades.filter(t => t.entryTs.getTime() / 1000 <= splitPoint);
    const oosTrades = trades.filter(t => t.entryTs.getTime() / 1000 > splitPoint);

    const isCurve = buildEquityCurveFromTrades(isTrades, config.initialCapital);
    const oosCurve = buildEquityCurveFromTrades(oosTrades, config.initialCapital);

    result.inSample = computeMetrics(isTrades, config.initialCapital, isCurve);
    result.outOfSample = computeMetrics(oosTrades, config.initialCapital, oosCurve);
  }

  if (config.walkForward) {
    result.walkForward = await runWalkForward(allCandlesBySymbol, config);
  }

  return result;
}

function buildEquityCurveFromTrades(
  trades: BacktestTrade[],
  initialCapital: number,
): { ts: string; equity: number }[] {
  const sorted = [...trades].sort((a, b) => a.exitTs.getTime() - b.exitTs.getTime());
  const curve: { ts: string; equity: number }[] = [
    {
      ts: sorted.length > 0 ? sorted[0].entryTs.toISOString() : new Date().toISOString(),
      equity: initialCapital,
    },
  ];
  let equity = initialCapital;
  for (const t of sorted) {
    equity += t.pnl;
    curve.push({ ts: t.exitTs.toISOString(), equity });
  }
  return curve;
}

async function runWalkForward(
  allCandlesBySymbol: Record<string, CandleData[]>,
  config: BacktestConfig,
): Promise<WalkForwardResult> {
  const wf = config.walkForward!;
  const allTs = Object.values(allCandlesBySymbol).flat().map(c => c.openTs).sort((a, b) => a - b);
  const dataStart = allTs[0];
  const dataEnd = allTs[allTs.length - 1];

  const trainSecs = wf.trainMonths * 30 * 24 * 3600;
  const testSecs = wf.testMonths * 30 * 24 * 3600;
  const stepSecs = wf.stepMonths * 30 * 24 * 3600;

  const folds: WalkForwardFold[] = [];
  let foldStart = dataStart;
  let foldIndex = 0;

  while (foldStart + trainSecs + testSecs <= dataEnd) {
    const trainStart = foldStart;
    const trainEnd = foldStart + trainSecs;
    const testStart = trainEnd;
    const testEnd = Math.min(trainEnd + testSecs, dataEnd);

    const trainCandles: Record<string, CandleData[]> = {};
    const testCandles: Record<string, CandleData[]> = {};

    for (const [sym, candles] of Object.entries(allCandlesBySymbol)) {
      trainCandles[sym] = candles.filter(c => c.openTs >= trainStart && c.openTs < trainEnd);
      testCandles[sym] = candles.filter(c => c.openTs >= testStart && c.openTs < testEnd);
    }

    const strategies = config.strategyName ? [config.strategyName] : undefined;

    const trainResult = simulateOnCandles(trainCandles, config, strategies);
    const testResult = simulateOnCandles(testCandles, config, strategies);

    const isMet = computeMetrics(trainResult.trades, config.initialCapital, trainResult.equityCurve);
    const oosMet = computeMetrics(testResult.trades, config.initialCapital, testResult.equityCurve);

    folds.push({
      foldIndex,
      trainStart: new Date(trainStart * 1000).toISOString(),
      trainEnd: new Date(trainEnd * 1000).toISOString(),
      testStart: new Date(testStart * 1000).toISOString(),
      testEnd: new Date(testEnd * 1000).toISOString(),
      inSample: isMet,
      outOfSample: oosMet,
    });

    foldStart += stepSecs;
    foldIndex++;
  }

  const allOOSEquityCurve: { ts: string; equity: number }[] = [];
  let cumulativeEquity = config.initialCapital;
  for (const fold of folds) {
    for (const point of fold.outOfSample.equityCurve.slice(1)) {
      const diff = point.equity - config.initialCapital;
      cumulativeEquity += diff / Math.max(folds.length, 1);
      allOOSEquityCurve.push({ ts: point.ts, equity: cumulativeEquity });
    }
  }

  const totalOOSGrossProfit = folds.reduce((s, f) => s + f.outOfSample.grossProfit, 0);
  const totalOOSGrossLoss = folds.reduce((s, f) => s + f.outOfSample.grossLoss, 0);
  const totalOOSTrades = folds.reduce((s, f) => s + f.outOfSample.tradeCount, 0);
  const totalOOSNetProfit = folds.reduce((s, f) => s + f.outOfSample.netProfit, 0);

  const combinedOOSMonthly: Record<string, number> = {};
  const combinedOOSBySymbol: Record<string, number> = {};
  const combinedOOSByRegime: Record<string, number> = {};
  for (const fold of folds) {
    for (const [k, v] of Object.entries(fold.outOfSample.monthlyReturns)) {
      combinedOOSMonthly[k] = (combinedOOSMonthly[k] || 0) + v;
    }
    for (const [k, v] of Object.entries(fold.outOfSample.returnBySymbol)) {
      combinedOOSBySymbol[k] = (combinedOOSBySymbol[k] || 0) + v;
    }
    for (const [k, v] of Object.entries(fold.outOfSample.returnByRegime)) {
      combinedOOSByRegime[k] = (combinedOOSByRegime[k] || 0) + v;
    }
  }

  const winsCount = folds.reduce((s, f) => {
    return s + (f.outOfSample.winRate * f.outOfSample.tradeCount);
  }, 0);
  const combinedWinRate = totalOOSTrades > 0 ? winsCount / totalOOSTrades : 0;

  const combinedOOSMetrics: StrategyMetrics = {
    totalReturn: totalOOSNetProfit / config.initialCapital,
    netProfit: totalOOSNetProfit,
    grossProfit: totalOOSGrossProfit,
    grossLoss: totalOOSGrossLoss,
    winRate: combinedWinRate,
    avgWin: totalOOSGrossProfit / Math.max(winsCount, 1),
    avgLoss: totalOOSGrossLoss / Math.max(totalOOSTrades - winsCount, 1),
    expectancy: totalOOSTrades > 0 ? totalOOSNetProfit / totalOOSTrades : 0,
    profitFactor: totalOOSGrossLoss > 0 ? totalOOSGrossProfit / totalOOSGrossLoss : (totalOOSGrossProfit > 0 ? Infinity : 0),
    maxDrawdown: Math.min(...folds.map(f => f.outOfSample.maxDrawdown), 0),
    maxDrawdownDuration: Math.max(...folds.map(f => f.outOfSample.maxDrawdownDuration), 0),
    tradeCount: totalOOSTrades,
    avgHoldingHours: totalOOSTrades > 0
      ? folds.reduce((s, f) => s + f.outOfSample.avgHoldingHours * f.outOfSample.tradeCount, 0) / totalOOSTrades
      : 0,
    sharpeRatio: allOOSEquityCurve.length > 1
      ? (() => {
          const rets = allOOSEquityCurve.slice(1).map((v, i) =>
            (v.equity - allOOSEquityCurve[i].equity) / allOOSEquityCurve[i].equity
          );
          const m = meanCalc(rets);
          const s = stdDevCalc(rets);
          return s > 0 ? (m / s) * Math.sqrt(252) : 0;
        })()
      : 0,
    equityCurve: allOOSEquityCurve,
    monthlyReturns: combinedOOSMonthly,
    returnBySymbol: combinedOOSBySymbol,
    returnByRegime: combinedOOSByRegime,
  };

  const avgISSharpe = folds.reduce((s, f) => s + f.inSample.sharpeRatio, 0) / Math.max(folds.length, 1);
  const avgOOSSharpe = combinedOOSMetrics.sharpeRatio;
  const overfittingRatio = avgOOSSharpe !== 0 ? avgISSharpe / avgOOSSharpe : (avgISSharpe > 0 ? Infinity : 0);

  return {
    folds,
    aggregateOOS: combinedOOSMetrics,
    overfittingRatio,
  };
}

export async function runBacktestSimulation(
  strategyName: string,
  symbol: string,
  initialCapital: number,
  allocationMode: string,
): Promise<{
  totalReturn: number;
  netProfit: number;
  winRate: number;
  profitFactor: number;
  maxDrawdown: number;
  tradeCount: number;
  avgHoldingHours: number;
  expectancy: number;
  sharpeRatio: number;
  trades: {
    pnl: number;
    holdingCandles: number;
    entryTs: Date;
    exitTs: Date;
    direction: string;
    entryPrice: number;
    exitPrice: number;
    exitReason: string;
  }[];
  equityCurve: { ts: string; equity: number }[];
  grossProfit: number;
  grossLoss: number;
  avgWin: number;
  avgLoss: number;
  maxDrawdownDuration: number;
  monthlyReturns: Record<string, number>;
  returnBySymbol: Record<string, number>;
  returnByRegime: Record<string, number>;
}> {
  const mode = allocationMode === "aggressive" ? "live" : "paper";
  const basePct = allocationMode === "aggressive" ? 0.25
    : allocationMode === "conservative" ? 0.10 : 0.15;

  const states = await db.select().from(platformStateTable);
  const stateMap: Record<string, string> = {};
  for (const s of states) stateMap[s.key] = s.value;
  const weightKeys: (keyof ScoringWeights)[] = [
    "regimeFit", "setupQuality", "trendAlignment",
    "volatilityCondition", "rewardRisk", "probabilityOfSuccess",
  ];
  const weightStateMap: Record<keyof ScoringWeights, string> = {
    regimeFit: "scoring_weight_regime_fit",
    setupQuality: "scoring_weight_setup_quality",
    trendAlignment: "scoring_weight_trend_alignment",
    volatilityCondition: "scoring_weight_volatility_condition",
    rewardRisk: "scoring_weight_reward_risk",
    probabilityOfSuccess: "scoring_weight_probability_of_success",
  };
  const hasWeights = weightKeys.some(k => stateMap[weightStateMap[k]] !== undefined);
  let scoringWeights: ScoringWeights | undefined;
  if (hasWeights) {
    scoringWeights = {} as ScoringWeights;
    for (const k of weightKeys) scoringWeights[k] = parseFloat(stateMap[weightStateMap[k]] || "1");
  }

  const result = await runFullBacktest({
    symbol,
    symbols: [symbol],
    strategyName,
    initialCapital,
    mode,
    basePct,
    minCompositeScore: parseFloat(stateMap["min_composite_score"] || "85"),
    minEvThreshold: parseFloat(stateMap["min_ev_threshold"] || "0.003"),
    minRrRatio: parseFloat(stateMap["min_rr_ratio"] || "1.5"),
    scoringWeights,
  });

  const pm = result.portfolioMetrics;

  return {
    totalReturn: pm.totalReturn,
    netProfit: pm.netProfit,
    winRate: pm.winRate,
    profitFactor: pm.profitFactor,
    maxDrawdown: pm.maxDrawdown,
    tradeCount: pm.tradeCount,
    avgHoldingHours: pm.avgHoldingHours,
    expectancy: pm.expectancy,
    sharpeRatio: pm.sharpeRatio,
    grossProfit: pm.grossProfit,
    grossLoss: pm.grossLoss,
    avgWin: pm.avgWin,
    avgLoss: pm.avgLoss,
    maxDrawdownDuration: pm.maxDrawdownDuration,
    monthlyReturns: pm.monthlyReturns,
    returnBySymbol: pm.returnBySymbol,
    returnByRegime: pm.returnByRegime,
    trades: result.trades.map(t => ({
      pnl: t.pnl,
      holdingCandles: Math.round(t.holdingHours),
      entryTs: t.entryTs,
      exitTs: t.exitTs,
      direction: t.direction,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      exitReason: t.exitReason,
    })),
    equityCurve: pm.equityCurve,
  };
}

export interface SymbolBacktestResult {
  symbol: string;
  profitableStrategies: {
    strategyName: string;
    winRate: number;
    profitFactor: number;
    netProfit: number;
    tradeCount: number;
    avgHoldingHours: number;
    sharpeRatio: number;
    expectancy: number;
  }[];
  portfolioMetrics: StrategyMetrics;
  trades: BacktestTrade[];
}

export async function runSymbolBacktest(
  symbol: string,
  initialCapital: number,
  allocationMode: string,
): Promise<SymbolBacktestResult> {
  const mode = allocationMode === "aggressive" ? "live" as const : "paper" as const;
  const basePct = allocationMode === "aggressive" ? 0.25
    : allocationMode === "conservative" ? 0.10 : 0.15;

  const states = await db.select().from(platformStateTable);
  const stateMap: Record<string, string> = {};
  for (const s of states) stateMap[s.key] = s.value;
  const weightKeys: (keyof ScoringWeights)[] = [
    "regimeFit", "setupQuality", "trendAlignment",
    "volatilityCondition", "rewardRisk", "probabilityOfSuccess",
  ];
  const weightStateMap: Record<keyof ScoringWeights, string> = {
    regimeFit: "scoring_weight_regime_fit",
    setupQuality: "scoring_weight_setup_quality",
    trendAlignment: "scoring_weight_trend_alignment",
    volatilityCondition: "scoring_weight_volatility_condition",
    rewardRisk: "scoring_weight_reward_risk",
    probabilityOfSuccess: "scoring_weight_probability_of_success",
  };
  const hasWeights = weightKeys.some(k => stateMap[weightStateMap[k]] !== undefined);
  let scoringWeights: ScoringWeights | undefined;
  if (hasWeights) {
    scoringWeights = {} as ScoringWeights;
    for (const k of weightKeys) scoringWeights[k] = parseFloat(stateMap[weightStateMap[k]] || "1");
  }

  const result = await runFullBacktest({
    symbol,
    symbols: [symbol],
    initialCapital,
    mode,
    basePct,
    minCompositeScore: parseFloat(stateMap["min_composite_score"] || "85"),
    minEvThreshold: parseFloat(stateMap["min_ev_threshold"] || "0.003"),
    minRrRatio: parseFloat(stateMap["min_rr_ratio"] || "1.5"),
    scoringWeights,
  });

  const strategies = ["trend_continuation", "mean_reversion", "breakout_expansion", "spike_event"];
  const profitableStrategies: SymbolBacktestResult["profitableStrategies"] = [];

  for (const stratName of strategies) {
    const stratTrades = result.trades.filter(t => t.strategyName === stratName);
    if (stratTrades.length === 0) continue;

    const netProfit = stratTrades.reduce((s, t) => s + t.pnl, 0);
    if (netProfit <= 0) continue;

    const wins = stratTrades.filter(t => t.pnl > 0);
    const losses = stratTrades.filter(t => t.pnl <= 0);
    const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

    profitableStrategies.push({
      strategyName: stratName,
      winRate: wins.length / stratTrades.length,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
      netProfit,
      tradeCount: stratTrades.length,
      avgHoldingHours: stratTrades.reduce((s, t) => s + t.holdingHours, 0) / stratTrades.length,
      sharpeRatio: result.strategyMetrics[stratName]?.sharpeRatio ?? 0,
      expectancy: netProfit / stratTrades.length,
    });
  }

  return {
    symbol,
    profitableStrategies,
    portfolioMetrics: result.portfolioMetrics,
    trades: result.trades,
  };
}
