import type { FeatureVector } from "./features.js";
import { db, platformStateTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export type RegimeState =
  | "trend_up"
  | "trend_down"
  | "mean_reversion"
  | "ranging"
  | "compression"
  | "breakout_expansion"
  | "spike_zone"
  | "no_trade";

export type InstrumentFamily = "boom" | "crash" | "volatility" | "other_synthetic";

export type StrategyFamily =
  | "trend_continuation"
  | "mean_reversion"
  | "breakout_expansion"
  | "spike_event"
  | "trendline_breakout";

export interface RegimeClassification {
  regime: RegimeState;
  confidence: number;
  allowedFamilies: StrategyFamily[];
  instrumentFamily: InstrumentFamily;
}

export function classifyInstrument(symbol: string): InstrumentFamily {
  if (symbol.startsWith("BOOM")) return "boom";
  if (symbol.startsWith("CRASH")) return "crash";
  if (symbol.startsWith("R_")) return "volatility";
  return "other_synthetic";
}

const STRATEGY_PERMISSION_MATRIX: Record<RegimeState, StrategyFamily[]> = {
  trend_up: ["trend_continuation", "breakout_expansion", "trendline_breakout"],
  trend_down: ["trend_continuation", "breakout_expansion", "trendline_breakout"],
  mean_reversion: ["mean_reversion"],
  ranging: ["mean_reversion", "spike_event", "trendline_breakout"],
  compression: ["breakout_expansion", "trendline_breakout"],
  breakout_expansion: ["breakout_expansion", "trend_continuation", "trendline_breakout"],
  spike_zone: ["spike_event"],
  no_trade: [],
};

const REGIME_CACHE_TTL_MS = 60 * 60 * 1000;

interface CachedRegime {
  regime: RegimeState;
  confidence: number;
  allowedFamilies: StrategyFamily[];
  instrumentFamily: InstrumentFamily;
  cachedAt: number;
}

const inMemoryRegimeCache: Record<string, CachedRegime> = {};

interface HourlyFeatureAccumulator {
  samples: Array<{
    emaSlope: number;
    rsi14: number;
    bbWidth: number;
    bbWidthRoc: number;
    atr14: number;
    atrRank: number;
    atrAccel: number;
    zScore: number;
    spikeHazardScore: number;
    bbPctB: number;
    ts: number;
  }>;
  windowStartMs: number;
}

const hourlyAccumulators: Record<string, HourlyFeatureAccumulator> = {};
const HOURLY_WINDOW_MS = 60 * 60 * 1000;

export function accumulateHourlyFeatures(features: FeatureVector): void {
  const sym = features.symbol;
  const now = Date.now();
  if (!hourlyAccumulators[sym] || (now - hourlyAccumulators[sym].windowStartMs) >= HOURLY_WINDOW_MS) {
    hourlyAccumulators[sym] = { samples: [], windowStartMs: now };
  }
  hourlyAccumulators[sym].samples.push({
    emaSlope: features.emaSlope,
    rsi14: features.rsi14,
    bbWidth: features.bbWidth,
    bbWidthRoc: features.bbWidthRoc,
    atr14: features.atr14,
    atrRank: features.atrRank,
    atrAccel: features.atrAccel,
    zScore: features.zScore,
    spikeHazardScore: features.spikeHazardScore,
    bbPctB: features.bbPctB,
    ts: now,
  });
}

export function getHourlyAveragedFeatures(symbol: string): Partial<FeatureVector> | null {
  const acc = hourlyAccumulators[symbol];
  if (!acc || acc.samples.length < 3) return null;
  const n = acc.samples.length;
  const avg = (fn: (s: typeof acc.samples[0]) => number) => acc.samples.reduce((s, x) => s + fn(x), 0) / n;
  return {
    emaSlope: avg(s => s.emaSlope),
    rsi14: avg(s => s.rsi14),
    bbWidth: avg(s => s.bbWidth),
    bbWidthRoc: avg(s => s.bbWidthRoc),
    atr14: avg(s => s.atr14),
    atrRank: avg(s => s.atrRank),
    atrAccel: avg(s => s.atrAccel),
    zScore: avg(s => s.zScore),
    spikeHazardScore: avg(s => s.spikeHazardScore),
    bbPctB: avg(s => s.bbPctB),
  };
}

export function classifyRegimeFromHTF(features: FeatureVector): RegimeClassification {
  const hourly = getHourlyAveragedFeatures(features.symbol);
  if (hourly) {
    const htfFeatures: FeatureVector = {
      ...features,
      emaSlope: hourly.emaSlope ?? features.emaSlope,
      rsi14: hourly.rsi14 ?? features.rsi14,
      bbWidth: hourly.bbWidth ?? features.bbWidth,
      bbWidthRoc: hourly.bbWidthRoc ?? features.bbWidthRoc,
      atr14: hourly.atr14 ?? features.atr14,
      atrRank: hourly.atrRank ?? features.atrRank,
      atrAccel: hourly.atrAccel ?? features.atrAccel,
      zScore: hourly.zScore ?? features.zScore,
      spikeHazardScore: hourly.spikeHazardScore ?? features.spikeHazardScore,
      bbPctB: hourly.bbPctB ?? features.bbPctB,
    };
    return classifyRegime(htfFeatures);
  }
  return classifyRegime(features);
}

export function classifyRegime(features: FeatureVector): RegimeClassification {
  const instrumentFamily = classifyInstrument(features.symbol);
  const isBoomCrash = instrumentFamily === "boom" || instrumentFamily === "crash";

  let regime: RegimeState;
  let confidence: number;

  const slopeAbs = Math.abs(features.emaSlope);
  const isSqueeze = features.bbWidth < 0.010;
  const isExpanding = features.bbWidthRoc > 0.08 && features.atrAccel > 0.05;
  const isOverstretched = Math.abs(features.zScore) > 1.8;
  const rsiExtreme = features.rsi14 < 32 || features.rsi14 > 68;
  const strongTrend = slopeAbs > 0.0003;
  const veryStrongTrend = slopeAbs > 0.0008;
  const highVol = features.atr14 > 0.008;
  const spikeImminent = isBoomCrash && features.spikeHazardScore > 0.72;

  if (spikeImminent) {
    regime = "spike_zone";
    confidence = Math.min(0.95, 0.5 + features.spikeHazardScore * 0.5);
  } else if (isSqueeze && !isExpanding && slopeAbs < 0.0003) {
    regime = "compression";
    confidence = Math.min(0.90, 0.6 + (0.005 - features.bbWidth) * 100);
  } else if (isExpanding && (features.atrRank > 1.2 || highVol)) {
    regime = "breakout_expansion";
    confidence = Math.min(0.90, 0.5 + features.bbWidthRoc + features.atrAccel * 0.5);
  } else if (isOverstretched && rsiExtreme && !veryStrongTrend) {
    regime = "mean_reversion";
    confidence = Math.min(0.90, 0.5 + Math.abs(features.zScore) * 0.15 + (rsiExtreme ? 0.1 : 0));
  } else if (veryStrongTrend) {
    regime = features.emaSlope > 0 ? "trend_up" : "trend_down";
    confidence = Math.min(0.95, 0.5 + slopeAbs * 500);
  } else if (strongTrend && !isOverstretched) {
    regime = features.emaSlope > 0 ? "trend_up" : "trend_down";
    confidence = Math.min(0.80, 0.4 + slopeAbs * 400);
  } else if (isOverstretched || rsiExtreme) {
    regime = "mean_reversion";
    confidence = 0.55;
  } else {
    regime = "ranging";
    confidence = 0.60;
  }

  const allowedFamilies = STRATEGY_PERMISSION_MATRIX[regime];

  return { regime, confidence, allowedFamilies, instrumentFamily };
}

export async function getCachedRegime(symbol: string, features?: FeatureVector): Promise<RegimeClassification | null> {
  const now = Date.now();
  const cached = inMemoryRegimeCache[symbol];
  if (cached && (now - cached.cachedAt) < REGIME_CACHE_TTL_MS) {
    return {
      regime: cached.regime,
      confidence: cached.confidence,
      allowedFamilies: cached.allowedFamilies,
      instrumentFamily: cached.instrumentFamily,
    };
  }

  const cacheKey = `regime_cache_${symbol}`;
  try {
    const rows = await db.select().from(platformStateTable).where(eq(platformStateTable.key, cacheKey));
    if (rows.length > 0) {
      const parsed = JSON.parse(rows[0].value);
      if (parsed.cachedAt && (now - parsed.cachedAt) < REGIME_CACHE_TTL_MS) {
        const result: RegimeClassification = {
          regime: parsed.regime,
          confidence: parsed.confidence,
          allowedFamilies: STRATEGY_PERMISSION_MATRIX[parsed.regime as RegimeState] || [],
          instrumentFamily: parsed.instrumentFamily,
        };
        inMemoryRegimeCache[symbol] = { ...result, cachedAt: parsed.cachedAt };
        return result;
      }
    }
  } catch {
  }

  if (features) {
    const fresh = classifyRegime(features);
    await cacheRegime(symbol, fresh);
    return fresh;
  }

  return null;
}

export async function cacheRegime(symbol: string, regime: RegimeClassification): Promise<void> {
  const now = Date.now();
  const cacheKey = `regime_cache_${symbol}`;
  const value = JSON.stringify({
    regime: regime.regime,
    confidence: regime.confidence,
    instrumentFamily: regime.instrumentFamily,
    cachedAt: now,
  });

  inMemoryRegimeCache[symbol] = {
    ...regime,
    cachedAt: now,
  };

  try {
    await db.insert(platformStateTable).values({ key: cacheKey, value })
      .onConflictDoUpdate({ target: platformStateTable.key, set: { value, updatedAt: new Date() } });
  } catch {
  }
}

export function isStrategyAllowedForRegime(family: StrategyFamily, regime: RegimeState): boolean {
  return STRATEGY_PERMISSION_MATRIX[regime].includes(family);
}

export function getCorrelatedInstruments(symbol: string): string[] {
  const family = classifyInstrument(symbol);
  const num = symbol.replace(/[A-Z_]/g, "");

  const correlated: string[] = [];

  if (family === "boom") {
    correlated.push(`CRASH${num}`);
    ["1000", "500", "300", "200"].forEach(n => {
      if (n !== num) {
        correlated.push(`BOOM${n}`);
      }
    });
  } else if (family === "crash") {
    correlated.push(`BOOM${num}`);
    ["1000", "500", "300", "200"].forEach(n => {
      if (n !== num) {
        correlated.push(`CRASH${n}`);
      }
    });
  } else if (family === "volatility") {
    if (symbol === "R_75") correlated.push("R_100");
    if (symbol === "R_100") correlated.push("R_75");
  }

  return correlated;
}
