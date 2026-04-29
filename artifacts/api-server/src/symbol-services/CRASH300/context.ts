import type { PromotedSymbolRuntimeModel } from "../../core/calibration/promotedSymbolModel.js";
import type { CandleRow } from "../../core/backtest/featureSlice.js";
import type { Crash300ContextSnapshot, Crash300CrashEvent } from "./features.js";

type DetectedMoveDiagnostic = {
  id: number;
  startTs: number;
  endTs: number;
  direction: "up" | "down" | "unknown";
  movePct?: number | null;
  startPrice?: number | null;
  endPrice?: number | null;
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function num(value: number | null | undefined, fallback = 0): number {
  return Number.isFinite(value) ? (value as number) : fallback;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], pct: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * pct)));
  return sorted[idx] ?? 0;
}

function stdDev(values: number[]): number {
  if (values.length <= 1) return 0;
  const avg = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - avg) ** 2)));
}

function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const out: number[] = [];
  const k = 2 / (period + 1);
  let prev = values[0] ?? 0;
  for (const value of values) {
    const current = value * k + prev * (1 - k);
    out.push(current);
    prev = current;
  }
  return out;
}

function atr(candles: CandleRow[], period: number): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  const start = Math.max(1, candles.length - period);
  for (let i = start; i < candles.length; i++) {
    const current = candles[i]!;
    const prev = candles[i - 1]!;
    trs.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - prev.close),
      Math.abs(current.low - prev.close),
    ));
  }
  return mean(trs);
}

function rangeWidth(candles: CandleRow[]): number {
  if (candles.length === 0) return 0;
  const high = Math.max(...candles.map((c) => c.high));
  const low = Math.min(...candles.map((c) => c.low));
  const close = candles[candles.length - 1]?.close ?? 1;
  return close > 0 ? (high - low) / close : 0;
}

function ratioOfPositiveCloses(candles: CandleRow[]): number {
  if (candles.length < 2) return 0;
  let positive = 0;
  for (let i = 1; i < candles.length; i++) {
    if ((candles[i]?.close ?? 0) > (candles[i - 1]?.close ?? 0)) positive += 1;
  }
  return positive / Math.max(1, candles.length - 1);
}

function countHigherHighs(candles: CandleRow[]): number {
  let count = 0;
  for (let i = 1; i < candles.length; i++) {
    if ((candles[i]?.high ?? 0) > (candles[i - 1]?.high ?? 0)) count += 1;
  }
  return count;
}

function countHigherLows(candles: CandleRow[]): number {
  let count = 0;
  for (let i = 1; i < candles.length; i++) {
    if ((candles[i]?.low ?? 0) > (candles[i - 1]?.low ?? 0)) count += 1;
  }
  return count;
}

function countLowerHighs(candles: CandleRow[]): number {
  let count = 0;
  for (let i = 1; i < candles.length; i++) {
    if ((candles[i]?.high ?? 0) < (candles[i - 1]?.high ?? 0)) count += 1;
  }
  return count;
}

function countLowerLows(candles: CandleRow[]): number {
  let count = 0;
  for (let i = 1; i < candles.length; i++) {
    if ((candles[i]?.low ?? 0) < (candles[i - 1]?.low ?? 0)) count += 1;
  }
  return count;
}

function slopePct(series: number[], lookback: number): number {
  if (series.length === 0) return 0;
  const end = series[series.length - 1] ?? 0;
  const start = series[Math.max(0, series.length - 1 - lookback)] ?? end;
  if (!Number.isFinite(start) || start === 0) return 0;
  return (end - start) / Math.abs(start);
}

function bbWidth(closes: number[], period: number): number {
  if (closes.length < period) return 0;
  const window = closes.slice(-period);
  const avg = mean(window);
  const dev = stdDev(window);
  return avg > 0 ? (dev * 4) / avg : 0;
}

function normalizedRank(value: number, values: number[]): number {
  if (values.length === 0) return 0.5;
  const low = Math.min(...values);
  const high = Math.max(...values);
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) return 0.5;
  return clamp01((value - low) / (high - low));
}

function recoveryPct(preCrashHigh: number, crashLow: number, currentPrice: number): number {
  const drop = preCrashHigh - crashLow;
  if (!Number.isFinite(drop) || drop <= 0) return 0;
  return clamp01((currentPrice - crashLow) / drop);
}

function readFormulaNumber(model: PromotedSymbolRuntimeModel, keys: string[], fallback: number): number {
  const formula = model.formulaOverride && typeof model.formulaOverride === "object"
    ? (model.formulaOverride as Record<string, unknown>)
    : {};
  for (const key of keys) {
    const direct = Number(formula[key]);
    if (Number.isFinite(direct) && direct > 0) return direct;
    const crash300 = formula["crash300"];
    if (crash300 && typeof crash300 === "object") {
      const nested = Number((crash300 as Record<string, unknown>)[key]);
      if (Number.isFinite(nested) && nested > 0) return nested;
    }
  }
  return fallback;
}

function detectCrashEvents(
  candles: CandleRow[],
  runtimeModel: PromotedSymbolRuntimeModel,
): Crash300CrashEvent[] {
  if (candles.length < 20) return [];
  const closes = candles.map((c) => c.close);
  const oneBarReturns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1] ?? 0;
    oneBarReturns.push(prev > 0 ? (closes[i]! - prev) / prev : 0);
  }
  const negativeAbs = oneBarReturns.filter((v) => v < 0).map((v) => Math.abs(v));
  const atr14Pct = atr(candles, 14) / Math.max(1, closes[closes.length - 1] ?? 1);
  const derivedDepthPct = Math.max(
    readFormulaNumber(runtimeModel, ["crashDepthPct", "crashEventDepthPct"], 0),
    atr14Pct * 3,
    percentile(negativeAbs, 0.9) * 2.25,
  );
  const depthPct = derivedDepthPct > 0 ? derivedDepthPct : Math.max(atr14Pct * 3, 0.008);
  const velocityPct = Math.max(
    readFormulaNumber(runtimeModel, ["crashVelocityPctPerBar", "crashEventVelocityPctPerBar"], 0),
    Math.max(percentile(negativeAbs, 0.75), depthPct / 6),
  );
  const maxBars = Math.max(3, Math.round(readFormulaNumber(runtimeModel, ["crashMaxDurationBars"], 8)));

  const events: Crash300CrashEvent[] = [];
  for (let i = 1; i < candles.length; i++) {
    const preHigh = candles[i - 1]?.high ?? candles[i]?.high ?? 0;
    let low = candles[i]?.low ?? preHigh;
    let end = i;
    for (let j = i; j < Math.min(candles.length, i + maxBars); j++) {
      low = Math.min(low, candles[j]?.low ?? low);
      const depth = preHigh > 0 ? (preHigh - low) / preHigh : 0;
      const duration = j - (i - 1);
      const velocity = duration > 0 ? depth / duration : 0;
      if (depth >= depthPct && velocity >= velocityPct) {
        end = j;
      }
    }
    if (end === i) continue;
    const crashLow = Math.min(...candles.slice(i, end + 1).map((c) => c.low));
    const recovery15 = candles[Math.min(candles.length - 1, end + 15)]?.close ?? crashLow;
    const recovery60 = candles[Math.min(candles.length - 1, end + 60)]?.close ?? recovery15;
    const recovery240 = candles[Math.min(candles.length - 1, end + 240)]?.close ?? recovery60;
    events.push({
      eventStartTs: candles[i - 1]?.closeTs ?? candles[i]?.closeTs ?? 0,
      eventEndTs: candles[end]?.closeTs ?? candles[i]?.closeTs ?? 0,
      direction: "down",
      depthPct: preHigh > 0 ? (preHigh - crashLow) / preHigh : 0,
      durationBars: Math.max(1, end - (i - 1)),
      velocityPctPerBar: preHigh > 0 ? ((preHigh - crashLow) / preHigh) / Math.max(1, end - (i - 1)) : 0,
      preCrashHigh: preHigh,
      crashLow,
      recoveryPctAfter15Bars: recoveryPct(preHigh, crashLow, recovery15),
      recoveryPctAfter60Bars: recoveryPct(preHigh, crashLow, recovery60),
      recoveryPctAfter240Bars: recoveryPct(preHigh, crashLow, recovery240),
    });
    i = end;
  }
  return events;
}

function resolveMoveDiagnostics(
  ts: number,
  latestClose: number,
  detectedMoves: DetectedMoveDiagnostic[],
) {
  const previous = [...detectedMoves].reverse().find((move) => move.startTs <= ts) ?? null;
  const previousEnd = [...detectedMoves].reverse().find((move) => move.endTs <= ts) ?? null;
  const next = detectedMoves.find((move) => move.startTs > ts) ?? null;
  const overlap = detectedMoves.find((move) => move.startTs <= ts && move.endTs >= ts) ?? null;
  return {
    barsSinceLastDetectedMoveStart: previous ? Math.max(0, Math.round((ts - previous.startTs) / 60)) : null,
    barsSinceLastDetectedMoveEnd: previousEnd ? Math.max(0, Math.round((ts - previousEnd.endTs) / 60)) : null,
    distanceFromLastMoveStartPricePct: previous?.startPrice && latestClose > 0
      ? (latestClose - previous.startPrice) / latestClose
      : null,
    distanceFromLastMoveEndPricePct: previousEnd?.endPrice && latestClose > 0
      ? (latestClose - previousEnd.endPrice) / latestClose
      : null,
    barsUntilNearestFutureCalibratedMoveStart: next ? Math.max(0, Math.round((next.startTs - ts) / 60)) : null,
    barsFromPreviousCalibratedMoveEnd: previousEnd ? Math.max(0, Math.round((ts - previousEnd.endTs) / 60)) : null,
    currentMoveOverlapId: overlap?.id ?? null,
  };
}

export function buildCrash300ContextSnapshot(params: {
  symbol: string;
  ts: number;
  candles: CandleRow[];
  runtimeModel: PromotedSymbolRuntimeModel;
  detectedMoves?: DetectedMoveDiagnostic[];
}): {
  snapshot: Crash300ContextSnapshot;
  crashEvents: Crash300CrashEvent[];
} {
  const candles = params.candles;
  if (candles.length < 20) {
    throw new Error("CRASH300 runtime feature context missing: insufficient candle lookback.");
  }
  const closes = candles.map((c) => c.close);
  const latestClose = closes[closes.length - 1] ?? 0;
  const last60 = candles.slice(-60);
  const last240 = candles.slice(-240);
  const last15 = candles.slice(-15);
  const last1440 = candles.slice(-1440);
  const ema20Series = ema(closes, 20);
  const ema50Series = ema(closes, 50);
  const ema200Series = ema(closes, 200);
  const ema20 = ema20Series[ema20Series.length - 1] ?? latestClose;
  const ema50 = ema50Series[ema50Series.length - 1] ?? latestClose;
  const ema200 = ema200Series[ema200Series.length - 1] ?? latestClose;
  const atr14 = atr(candles, 14);
  const atr60 = atr(candles, 60);
  const atr240 = atr(candles, 240);
  const atrSamples60 = Array.from({ length: Math.max(1, last60.length - 13) }, (_, idx) => atr(candles.slice(0, candles.length - last60.length + 14 + idx), 14));
  const atrSamples240 = Array.from({ length: Math.max(1, last240.length - 13) }, (_, idx) => atr(candles.slice(0, candles.length - last240.length + 14 + idx), 14));
  const bbWidth20 = bbWidth(closes, 20);
  const bbWidthSeries60 = Array.from({ length: Math.max(1, last60.length - 19) }, (_, idx) => bbWidth(closes.slice(0, closes.length - last60.length + 20 + idx), 20));
  const bbWidthSeries240 = Array.from({ length: Math.max(1, last240.length - 19) }, (_, idx) => bbWidth(closes.slice(0, closes.length - last240.length + 20 + idx), 20));
  const trendPersistence60 = clamp01(
    ratioOfPositiveCloses(last60) * 0.4 +
      (countHigherHighs(last60) / Math.max(1, last60.length - 1)) * 0.3 +
      (countHigherLows(last60) / Math.max(1, last60.length - 1)) * 0.3,
  );
  const trendPersistence240 = clamp01(
    ratioOfPositiveCloses(last240) * 0.4 +
      (countHigherHighs(last240) / Math.max(1, last240.length - 1)) * 0.3 +
      (countHigherLows(last240) / Math.max(1, last240.length - 1)) * 0.3,
  );
  const trendPersistenceScore = clamp01(
    trendPersistence60 * 0.45 +
      trendPersistence240 * 0.35 +
      clamp01((latestClose - ema50) / Math.max(ema50 * 0.03, 1e-9)) * 0.2,
  );

  const crashEvents = detectCrashEvents(candles.slice(-1440), params.runtimeModel);
  const lastCrash = [...crashEvents].reverse().find((event) => event.eventEndTs <= params.ts) ?? null;
  const barsSinceLastCrash = lastCrash ? Math.max(0, Math.round((params.ts - lastCrash.eventEndTs) / 60)) : null;
  const recoveryBars = lastCrash ? Math.max(0, Math.round((params.ts - lastCrash.eventEndTs) / 60)) : null;
  const recoveryFromLastCrashPct = lastCrash ? recoveryPct(lastCrash.preCrashHigh, lastCrash.crashLow, latestClose) : null;
  const recoveryWindow = lastCrash
    ? candles.filter((c) => c.closeTs >= lastCrash.eventEndTs).slice(-60)
    : [];
  const recoverySlope60 = recoveryWindow.length > 1
    ? slopePct(recoveryWindow.map((c) => c.close), Math.min(60, recoveryWindow.length - 1))
    : 0;
  const recoverySlope240 = lastCrash
    ? slopePct(candles.filter((c) => c.closeTs >= lastCrash.eventEndTs).map((c) => c.close), 240)
    : 0;
  const recoveryPersistence60 = clamp01(
    recoveryWindow.length > 1 ? ratioOfPositiveCloses(recoveryWindow) : 0,
  );
  const recoveryHigh = recoveryWindow.length > 0 ? Math.max(...recoveryWindow.map((c) => c.high)) : latestClose;
  const recoveryPullbackDepthPct = recoveryHigh > 0 ? Math.max(0, (recoveryHigh - latestClose) / recoveryHigh) : 0;
  const recoveryHigherLowCount60 = countHigherLows(recoveryWindow);
  const recoveryFailedBreakCount60 = Math.max(0, countLowerHighs(recoveryWindow) - countHigherHighs(recoveryWindow));
  const recoveryQualityScore = clamp01(
    (recoveryFromLastCrashPct ?? 0) * 0.35 +
      clamp01(recoverySlope60 / 0.04) * 0.25 +
      recoveryPersistence60 * 0.25 +
      clamp01(1 - recoveryPullbackDepthPct / 0.04) * 0.15,
  );
  const crashRecencyScore = lastCrash && barsSinceLastCrash != null
    ? clamp01(1 - Math.min(1, barsSinceLastCrash / 240))
    : 0;

  const rangeCompressionScore60 = clamp01(1 - normalizedRank(rangeWidth(last60), Array.from({ length: Math.max(1, last240.length - 59) }, (_, idx) => rangeWidth(last240.slice(Math.max(0, idx), idx + 60)))));
  const rangeCompressionScore240 = clamp01(1 - normalizedRank(rangeWidth(last240), [rangeWidth(last240), rangeWidth(last1440)]));
  const rangeExpansionScore15 = clamp01(normalizedRank(rangeWidth(last15), [rangeWidth(last15), rangeWidth(last60), rangeWidth(last240)]));
  const rangeExpansionScore60 = clamp01(normalizedRank(rangeWidth(last60), [rangeWidth(last15), rangeWidth(last60), rangeWidth(last240)]));
  const compressionToExpansionScore = clamp01(
    ((rangeCompressionScore60 + rangeCompressionScore240) / 2) * 0.45 +
      ((rangeExpansionScore15 + rangeExpansionScore60) / 2) * 0.55,
  );

  const moveDiagnostics = resolveMoveDiagnostics(params.ts, latestClose, params.detectedMoves ?? []);

  return {
    snapshot: {
      ts: params.ts,
      symbol: params.symbol,
      lookbackBarsAvailable: candles.length,
      ema20,
      ema50,
      ema200,
      ema20Slope60: slopePct(ema20Series, 60),
      ema50Slope240: slopePct(ema50Series, 240),
      priceVsEma20Pct: ema20 > 0 ? (latestClose - ema20) / ema20 : 0,
      priceVsEma50Pct: ema50 > 0 ? (latestClose - ema50) / ema50 : 0,
      priceVsEma200Pct: ema200 > 0 ? (latestClose - ema200) / ema200 : 0,
      positiveCloseRatio60: ratioOfPositiveCloses(last60),
      positiveCloseRatio240: ratioOfPositiveCloses(last240),
      higherHighCount60: countHigherHighs(last60),
      higherLowCount60: countHigherLows(last60),
      lowerHighCount60: countLowerHighs(last60),
      lowerLowCount60: countLowerLows(last60),
      driftPersistence60: trendPersistence60,
      driftPersistence240: trendPersistence240,
      trendPersistenceScore,
      lastCrashTs: lastCrash?.eventEndTs ?? null,
      barsSinceLastCrash,
      lastCrashDepthPct: lastCrash?.depthPct ?? null,
      lastCrashDurationBars: lastCrash?.durationBars ?? null,
      lastCrashVelocityPctPerBar: lastCrash?.velocityPctPerBar ?? null,
      lastCrashLow: lastCrash?.crashLow ?? null,
      lastCrashHighBeforeDrop: lastCrash?.preCrashHigh ?? null,
      priceDistanceFromLastCrashLowPct: lastCrash && latestClose > 0
        ? (latestClose - lastCrash.crashLow) / latestClose
        : null,
      recoveryFromLastCrashPct,
      crashRecencyScore,
      recoveryBars,
      recoverySlope60,
      recoverySlope240,
      recoveryPersistence60,
      recoveryPullbackDepthPct,
      recoveryHigherLowCount60,
      recoveryFailedBreakCount60,
      recoveryQualityScore,
      atr14,
      atr60,
      atr240,
      atrRank60: normalizedRank(atr14, atrSamples60),
      atrRank240: normalizedRank(atr14, atrSamples240),
      bbWidth20,
      bbWidthRank60: normalizedRank(bbWidth20, bbWidthSeries60),
      bbWidthRank240: normalizedRank(bbWidth20, bbWidthSeries240),
      rangeCompressionScore60,
      rangeCompressionScore240,
      rangeExpansionScore15,
      rangeExpansionScore60,
      compressionToExpansionScore,
      barsSinceLastDetectedMoveStart: moveDiagnostics.barsSinceLastDetectedMoveStart,
      barsSinceLastDetectedMoveEnd: moveDiagnostics.barsSinceLastDetectedMoveEnd,
      distanceFromLastMoveStartPricePct: moveDiagnostics.distanceFromLastMoveStartPricePct,
      distanceFromLastMoveEndPricePct: moveDiagnostics.distanceFromLastMoveEndPricePct,
      barsUntilNearestFutureCalibratedMoveStart: moveDiagnostics.barsUntilNearestFutureCalibratedMoveStart,
      barsFromPreviousCalibratedMoveEnd: moveDiagnostics.barsFromPreviousCalibratedMoveEnd,
      currentMoveOverlapId: moveDiagnostics.currentMoveOverlapId,
      latestClose,
    },
    crashEvents,
  };
}

