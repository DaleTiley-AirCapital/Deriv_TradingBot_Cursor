/**
 * Native Score Calibration Runner — Task #104
 *
 * Replays ALL historical 1m candles through every V3 engine's component scoring
 * functions to compute realistic native-score distributions from real market data.
 *
 * Goals:
 *  1. Measure what fraction of candle-positions would pass each mode threshold
 *  2. Surface ideal vs weak setup examples for human review
 *  3. Produce evidence-based threshold recommendations
 *  4. Optionally update platform_state with calibrated values
 *
 * Architecture:
 *  - Loads 1m candles from DB per symbol, aggregates to symbol-specific HTF
 *    (BOOM300=480m, CRASH300=720m, R_75=240m, R_100=240m — same as features.ts)
 *  - Precomputes 30d rolling high/low with O(N) monotone-deque algorithm
 *  - For BOOM300/CRASH300: loads spike_events for hazard + recency computation
 *  - Inlines all component scoring functions verbatim from the engine files
 *  - Scores every HTF candle (after 55-bar warmup) — no random sampling
 *  - Primary engines per symbol: BOOM300=sell, CRASH300=buy, R_75=reversal,
 *    R_100=reversal; secondary engines also scored
 */

import { backgroundDb, db, candlesTable, spikeEventsTable, platformStateTable } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface CalibrationReport {
  generatedAt: string;
  symbolCount: number;
  totalHTFBarsAnalyzed: number;
  engines: EngineCalibrationSummary[];
  recommendations: ThresholdRecommendations;
  platformStateUpdateApplied: boolean;
}

interface ThresholdRecommendations {
  paper: number;
  demo: number;
  real: number;
  rationale: string;
}

interface EngineCalibrationSummary {
  symbol: string;
  engineName: string;
  direction: "buy" | "sell";
  htfBarsAnalyzed: number;
  htfPeriodMins: number;
  scoreDistribution: {
    min: number; p10: number; p25: number; p50: number; p75: number;
    p85: number; p90: number; p92: number; p95: number; p99: number; max: number;
    mean: number;
  };
  passRates: {
    at85: number;
    at90: number;
    at92: number;
  };
  bestSetups: SetupExample[];
  weakestSetups: SetupExample[];
  engineGate: number;
  gatePassRate: number;
}

interface SetupExample {
  ts: number;
  isoDate: string;
  nativeScore: number;
  components: Record<string, number>;
}

interface Candle1m {
  openTs: number;
  closeTs: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface SpikeEventRow {
  eventTs: number;
  ticksSincePreviousSpike: number | null;
}

// ── Utility functions ─────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function meanArr(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdArr(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = meanArr(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[Math.min(idx, sorted.length - 1)];
}

// ── HTF aggregation (same logic as features.ts aggregateCandles) ──────────────

function getHTFPeriodMins(symbol: string): number {
  if (symbol.startsWith("CRASH")) return 720;
  if (symbol.startsWith("BOOM")) return 480;
  return 240;
}

interface HTFCandle {
  openTs: number; closeTs: number;
  open: number; high: number; low: number; close: number;
}

function aggregateToHTF(candles: Candle1m[], periodMins: number): HTFCandle[] {
  const periodSecs = periodMins * 60;
  const result: HTFCandle[] = [];
  let cur: HTFCandle | null = null;
  let bucket = -1;
  for (const c of candles) {
    const b = Math.floor(c.openTs / periodSecs) * periodSecs;
    if (b !== bucket || !cur) {
      if (cur) result.push(cur);
      bucket = b;
      cur = { openTs: c.openTs, closeTs: c.closeTs, open: c.open, high: c.high, low: c.low, close: c.close };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low  = Math.min(cur.low,  c.low);
      cur.close    = c.close;
      cur.closeTs  = c.closeTs;
    }
  }
  if (cur) result.push(cur);
  return result;
}

// ── Rolling indicator computations ────────────────────────────────────────────

function computeEMAArr(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const r: number[] = [];
  let prev = values[0];
  for (const v of values) {
    const cur = v * k + prev * (1 - k);
    r.push(cur);
    prev = cur;
  }
  return r;
}

function computeRSIAt(closes: number[], i: number, period = 14): number {
  if (i < period + 1) return 50;
  const window = closes.slice(i - period, i + 1);
  const changes = window.slice(1).map((c, j) => c - window[j]);
  const gains = changes.filter(c => c > 0);
  const losses = changes.filter(c => c < 0).map(Math.abs);
  const avgGain = gains.reduce((a, b) => a + b, 0) / period;
  const avgLoss = losses.reduce((a, b) => a + b, 0) / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function computeATRAt(highs: number[], lows: number[], closes: number[], i: number, period = 14): number {
  if (i < 1) return 0;
  const start = Math.max(1, i - period + 1);
  let sum = 0;
  let count = 0;
  for (let j = start; j <= i; j++) {
    const tr = Math.max(highs[j] - lows[j], Math.abs(highs[j] - closes[j-1]), Math.abs(lows[j] - closes[j-1]));
    sum += tr;
    count++;
  }
  return count > 0 ? sum / count : 0;
}

// ── O(N) sliding-window 30d high/low using monotone deque ────────────────────

function computeRolling30dHigh(candles: Candle1m[]): Float64Array {
  const W = 30 * 24 * 60; // 43200 1m bars
  const n = candles.length;
  const result = new Float64Array(n);
  const dq: number[] = [];
  for (let i = 0; i < n; i++) {
    while (dq.length > 0 && dq[0] < i - W) dq.shift();
    while (dq.length > 0 && candles[dq[dq.length - 1]].high <= candles[i].high) dq.pop();
    dq.push(i);
    result[i] = candles[dq[0]].high;
  }
  return result;
}

function computeRolling30dLow(candles: Candle1m[]): Float64Array {
  const W = 30 * 24 * 60;
  const n = candles.length;
  const result = new Float64Array(n);
  const dq: number[] = [];
  for (let i = 0; i < n; i++) {
    while (dq.length > 0 && dq[0] < i - W) dq.shift();
    while (dq.length > 0 && candles[dq[dq.length - 1]].low >= candles[i].low) dq.pop();
    dq.push(i);
    result[i] = candles[dq[0]].low;
  }
  return result;
}

function findCandle1mIdx(candles: Candle1m[], ts: number): number {
  let lo = 0, hi = candles.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (candles[mid].openTs <= ts) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// ── Spike hazard (corrected: runLengthSinceSpike = 1m bars since last spike) ──

function computeSpikeFeatures(ts: number, spikes: SpikeEventRow[]): { spikeHazardScore: number; runLengthSinceSpike: number } {
  let latestIdx = -1;
  for (let i = spikes.length - 1; i >= 0; i--) {
    if (spikes[i].eventTs <= ts) { latestIdx = i; break; }
  }
  if (latestIdx === -1) return { spikeHazardScore: 0, runLengthSinceSpike: 999 };

  const lastSpikeTs = spikes[latestIdx].eventTs;
  const runLengthSinceSpike = Math.max(0, Math.round((ts - lastSpikeTs) / 60));

  const start = Math.max(0, latestIdx - 7);
  const intervals = spikes.slice(start, latestIdx + 1)
    .map(s => s.ticksSincePreviousSpike ?? 0)
    .filter(x => x > 0);

  let spikeHazardScore = 0;
  if (intervals.length >= 3) {
    const m = meanArr(intervals);
    const s = stdArr(intervals);
    const ticks = spikes[latestIdx].ticksSincePreviousSpike ?? 999;
    if (s > 0) {
      spikeHazardScore = 1 / (1 + Math.exp(-((ticks - m) / s)));
    } else {
      spikeHazardScore = ticks > m ? 0.7 : 0.3;
    }
  }
  return { spikeHazardScore: clamp(spikeHazardScore, 0, 1), runLengthSinceSpike };
}

// ══════════════════════════════════════════════════════════════════════════════
// BOOM300 COMPONENT FUNCTIONS — inlined from boom300Engine.ts
// ══════════════════════════════════════════════════════════════════════════════

function boomC1SpikeClusterPressure(spikeHazardScore: number, runLengthSinceSpike: number): number {
  let s = spikeHazardScore * 55;
  if      (runLengthSinceSpike <= 5)  s += 35;
  else if (runLengthSinceSpike <= 15) s += 25;
  else if (runLengthSinceSpike <= 30) s += 15;
  else if (runLengthSinceSpike <= 60) s += 5;
  if (spikeHazardScore >= 0.55 && runLengthSinceSpike <= 20) s += 15;
  return clamp(Math.round(s), 0, 100);
}

function boomC2UpsideDisplacement(distFromRange30dHighPct: number, bbPctB: number, rsi14: number): number {
  const dist = Math.abs(distFromRange30dHighPct);
  let s = dist <= 0.03 ? 50 : dist <= 0.07 ? 40 : dist <= 0.12 ? 28 : dist <= 0.18 ? 16 : dist <= 0.25 ? 8 : 2;
  s += clamp(bbPctB * 30, 0, 30);
  s += rsi14 >= 75 ? 20 : rsi14 >= 65 ? 13 : rsi14 >= 58 ? 7 : 0;
  return clamp(Math.round(s), 0, 100);
}

function boomC3ExhaustionEvidence(emaSlope: number, latestClose: number, latestOpen: number, candleBody: number): number {
  let s = emaSlope <= -0.0006 ? 50 : emaSlope <= -0.0003 ? 40 : emaSlope <= -0.0001 ? 28 : emaSlope < 0 ? 15 : emaSlope <= 0.0002 ? 5 : 0;
  const bearish = latestClose < latestOpen;
  s += (bearish && candleBody >= 0.6) ? 35 : (bearish && candleBody >= 0.35) ? 25 : bearish ? 12 : 0;
  if (candleBody < 0.15) s += 10;
  return clamp(Math.round(s), 0, 100);
}

function boomC4DriftResumption(emaDist: number, bbWidthRoc: number, atrAccel: number, atrRank: number): number {
  let s = 30;
  s += emaDist > 0.015 ? 25 : emaDist > 0.005 ? 15 : emaDist > 0 ? 8 : -5;
  s += bbWidthRoc < -0.10 ? 25 : bbWidthRoc < -0.04 ? 18 : bbWidthRoc < 0 ? 8 : bbWidthRoc < 0.05 ? 0 : -8;
  s += atrAccel < -0.08 ? 20 : atrAccel < -0.03 ? 12 : atrAccel < 0 ? 5 : -5;
  return clamp(Math.round(s), 0, 100);
}

function boomC5EntryEfficiency(distFromRange30dHighPct: number, emaDist: number): number {
  const dist = Math.abs(distFromRange30dHighPct);
  let s = dist <= 0.02 ? 90 : dist <= 0.05 ? 75 : dist <= 0.09 ? 58 : dist <= 0.14 ? 40 : dist <= 0.22 ? 22 : 8;
  if (emaDist > 0.008) s = Math.min(100, s + 10);
  return clamp(Math.round(s), 0, 100);
}

function boomC6MoveSufficiency(distFromRange30dLowPct: number, atrRank: number): number {
  const downside = Math.abs(distFromRange30dLowPct);
  let s = clamp(downside * 220, 0, 70);
  s += atrRank >= 1.3 ? 25 : atrRank >= 1.0 ? 15 : atrRank >= 0.7 ? 8 : 0;
  if (downside < 0.08) s = Math.min(s, 30);
  return clamp(Math.round(s), 0, 100);
}

function boomLowSpikeHazard(spikeHazardScore: number, runLengthSinceSpike: number): number {
  let s = (1 - spikeHazardScore) * 60;
  s += spikeHazardScore <= 0.25 ? 30 : spikeHazardScore <= 0.40 ? 15 : spikeHazardScore <= 0.55 ? 0 : -20;
  s += runLengthSinceSpike >= 100 ? 20 : runLengthSinceSpike >= 60 ? 10 : runLengthSinceSpike < 30 ? -15 : 0;
  return clamp(Math.round(s), 0, 100);
}

function boomBuyDisplacementDown(distFromRange30dLowPct: number, bbPctB: number, rsi14: number): number {
  const dist = Math.abs(distFromRange30dLowPct);
  let s = dist <= 0.03 ? 50 : dist <= 0.07 ? 40 : dist <= 0.12 ? 28 : dist <= 0.18 ? 16 : 5;
  s += clamp((1 - bbPctB) * 30, 0, 30);
  s += rsi14 <= 25 ? 20 : rsi14 <= 38 ? 13 : rsi14 <= 45 ? 6 : 0;
  return clamp(Math.round(s), 0, 100);
}

interface Boom300Scores {
  sellNative: number; buyNative: number;
  sellComponents: Record<string, number>;
  buyComponents: Record<string, number>;
}

function scoreBoom300(f: {
  spikeHazardScore: number; runLengthSinceSpike: number;
  distFromRange30dHighPct: number; distFromRange30dLowPct: number;
  bbPctB: number; rsi14: number; emaSlope: number; emaDist: number;
  candleBody: number; latestClose: number; latestOpen: number;
  bbWidthRoc: number; atrAccel: number; atrRank: number;
}): Boom300Scores {
  const c1 = boomC1SpikeClusterPressure(f.spikeHazardScore, f.runLengthSinceSpike);
  const c2 = boomC2UpsideDisplacement(f.distFromRange30dHighPct, f.bbPctB, f.rsi14);
  const c3 = boomC3ExhaustionEvidence(f.emaSlope, f.latestClose, f.latestOpen, f.candleBody);
  const c4 = boomC4DriftResumption(f.emaDist, f.bbWidthRoc, f.atrAccel, f.atrRank);
  const c5 = boomC5EntryEfficiency(f.distFromRange30dHighPct, f.emaDist);
  const c6 = boomC6MoveSufficiency(f.distFromRange30dLowPct, f.atrRank);
  const sellNative = Math.round(c1 * 0.25 + c2 * 0.20 + c3 * 0.20 + c4 * 0.15 + c5 * 0.10 + c6 * 0.10);

  const b1 = boomLowSpikeHazard(f.spikeHazardScore, f.runLengthSinceSpike);
  const b2 = boomBuyDisplacementDown(f.distFromRange30dLowPct, f.bbPctB, f.rsi14);
  const b3 = boomC3ExhaustionEvidence(Math.abs(f.emaSlope), f.latestOpen, f.latestClose, f.candleBody);
  const b4 = boomC4DriftResumption(-f.emaDist, f.bbWidthRoc, f.atrAccel, f.atrRank);
  const b5 = boomC5EntryEfficiency(f.distFromRange30dLowPct, -f.emaDist);
  const b6 = boomC6MoveSufficiency(f.distFromRange30dHighPct, f.atrRank);
  const buyNative = Math.round(b1 * 0.25 + b2 * 0.20 + b3 * 0.20 + b4 * 0.15 + b5 * 0.10 + b6 * 0.10);

  return {
    sellNative, buyNative,
    sellComponents: { spikeClusterPressure: c1, upsideDisplacement: c2, exhaustionEvidence: c3, driftResumption: c4, entryEfficiency: c5, expectedMoveSufficiency: c6 },
    buyComponents:  { lowSpikeHazard: b1, downsideDisplacement: b2, exhaustionEvidence: b3, driftResumption: b4, entryEfficiency: b5, expectedMoveSufficiency: b6 },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// CRASH300 COMPONENT FUNCTIONS — inlined from crash300Engine.ts
// ══════════════════════════════════════════════════════════════════════════════

function crashBuyC1ClusterPressure(spikeHazardScore: number, runLengthSinceSpike: number): number {
  let s = spikeHazardScore * 55;
  if      (runLengthSinceSpike <= 5)  s += 35;
  else if (runLengthSinceSpike <= 15) s += 25;
  else if (runLengthSinceSpike <= 30) s += 15;
  else if (runLengthSinceSpike <= 60) s += 5;
  if (spikeHazardScore >= 0.55 && runLengthSinceSpike <= 20) s += 15;
  return clamp(Math.round(s), 0, 100);
}

function crashBuyC2DownsideDisplacement(distFromRange30dLowPct: number, bbPctB: number, rsi14: number): number {
  const dist = Math.abs(distFromRange30dLowPct);
  let s = dist <= 0.03 ? 50 : dist <= 0.07 ? 40 : dist <= 0.12 ? 28 : dist <= 0.18 ? 16 : dist <= 0.25 ? 8 : 2;
  s += clamp((1 - bbPctB) * 30, 0, 30);
  s += rsi14 <= 25 ? 20 : rsi14 <= 38 ? 13 : rsi14 <= 45 ? 7 : 0;
  return clamp(Math.round(s), 0, 100);
}

function crashBuyC3ExhaustionReversal(emaSlope: number, latestClose: number, latestOpen: number, candleBody: number): number {
  let s = emaSlope > 0.0003 ? 50 : emaSlope > 0 ? 38 : emaSlope > -0.0001 ? 28 : emaSlope > -0.0003 ? 18 : emaSlope > -0.0006 ? 8 : 0;
  const bullish = latestClose > latestOpen;
  s += (bullish && candleBody >= 0.6) ? 35 : (bullish && candleBody >= 0.35) ? 25 : bullish ? 12 : 0;
  if (candleBody < 0.15) s += 10;
  return clamp(Math.round(s), 0, 100);
}

function crashBuyC4RecoveryQuality(emaDist: number, bbWidthRoc: number, atrAccel: number, atrRank: number): number {
  let s = 30;
  s += emaDist >= 0.010 ? 25 : emaDist >= 0 ? 15 : emaDist >= -0.005 ? 8 : emaDist >= -0.015 ? 3 : -5;
  s += bbWidthRoc < -0.10 ? 25 : bbWidthRoc < -0.04 ? 18 : bbWidthRoc < 0 ? 8 : bbWidthRoc < 0.05 ? 0 : -8;
  s += atrAccel < -0.08 ? 20 : atrAccel < -0.03 ? 12 : atrAccel < 0 ? 5 : -5;
  return clamp(Math.round(s), 0, 100);
}

function crashBuyC5EntryEfficiency(distFromRange30dLowPct: number, emaDist: number): number {
  const dist = Math.abs(distFromRange30dLowPct);
  let s = dist <= 0.02 ? 90 : dist <= 0.05 ? 75 : dist <= 0.09 ? 58 : dist <= 0.14 ? 40 : dist <= 0.22 ? 22 : 8;
  if (emaDist < -0.008) s = Math.min(100, s + 10);
  return clamp(Math.round(s), 0, 100);
}

function crashBuyC6MoveSufficiency(distFromRange30dHighPct: number, atrRank: number): number {
  const upside = Math.abs(distFromRange30dHighPct);
  let s = clamp(upside * 220, 0, 70);
  s += atrRank >= 1.3 ? 25 : atrRank >= 1.0 ? 15 : atrRank >= 0.7 ? 8 : 0;
  if (upside < 0.08) s = Math.min(s, 30);
  return clamp(Math.round(s), 0, 100);
}

function crashSellC1RallyExtension(spikeHazardScore: number, runLengthSinceSpike: number): number {
  let s = (1 - spikeHazardScore) * 55;
  s += runLengthSinceSpike >= 120 ? 35 : runLengthSinceSpike >= 60 ? 25 : runLengthSinceSpike >= 30 ? 15 : runLengthSinceSpike >= 15 ? 8 : 0;
  if (spikeHazardScore >= 0.45 && runLengthSinceSpike >= 20) s += 10;
  return clamp(Math.round(s), 0, 100);
}

function crashSellC2UpsideStretch(distFromRange30dHighPct: number, bbPctB: number, rsi14: number): number {
  const dist = Math.abs(distFromRange30dHighPct);
  let s = dist <= 0.03 ? 50 : dist <= 0.07 ? 40 : dist <= 0.12 ? 28 : dist <= 0.18 ? 16 : dist <= 0.25 ? 8 : 2;
  s += clamp(bbPctB * 30, 0, 30);
  s += rsi14 >= 75 ? 20 : rsi14 >= 62 ? 13 : rsi14 >= 55 ? 7 : 0;
  return clamp(Math.round(s), 0, 100);
}

function crashSellC4CascadePotential(emaDist: number, bbWidthRoc: number, atrRank: number): number {
  let s = 30;
  s += emaDist > 0.015 ? 25 : emaDist > 0.005 ? 15 : emaDist > 0 ? 8 : -5;
  s += bbWidthRoc > 0.05 ? 15 : bbWidthRoc > 0 ? 8 : bbWidthRoc > -0.04 ? 3 : -5;
  s += atrRank >= 1.3 ? 20 : atrRank >= 1.0 ? 12 : atrRank >= 0.7 ? 5 : 0;
  return clamp(Math.round(s), 0, 100);
}

function crashSellC5EntryEfficiency(distFromRange30dHighPct: number, emaDist: number): number {
  const dist = Math.abs(distFromRange30dHighPct);
  let s = dist <= 0.02 ? 90 : dist <= 0.05 ? 75 : dist <= 0.09 ? 58 : dist <= 0.14 ? 40 : dist <= 0.22 ? 22 : 8;
  if (emaDist > 0.008) s = Math.min(100, s + 10);
  return clamp(Math.round(s), 0, 100);
}

function crashSellC6MoveSufficiency(distFromRange30dLowPct: number, atrRank: number): number {
  const downside = Math.abs(distFromRange30dLowPct);
  let s = clamp(downside * 220, 0, 70);
  s += atrRank >= 1.3 ? 25 : atrRank >= 1.0 ? 15 : atrRank >= 0.7 ? 8 : 0;
  if (downside < 0.08) s = Math.min(s, 30);
  return clamp(Math.round(s), 0, 100);
}

interface Crash300Scores {
  buyNative: number; sellNative: number;
  buyComponents: Record<string, number>;
  sellComponents: Record<string, number>;
}

function scoreCrash300(f: {
  spikeHazardScore: number; runLengthSinceSpike: number;
  distFromRange30dHighPct: number; distFromRange30dLowPct: number;
  bbPctB: number; rsi14: number; emaSlope: number; emaDist: number;
  candleBody: number; latestClose: number; latestOpen: number;
  bbWidthRoc: number; atrAccel: number; atrRank: number;
}): Crash300Scores {
  const b1 = crashBuyC1ClusterPressure(f.spikeHazardScore, f.runLengthSinceSpike);
  const b2 = crashBuyC2DownsideDisplacement(f.distFromRange30dLowPct, f.bbPctB, f.rsi14);
  const b3 = crashBuyC3ExhaustionReversal(f.emaSlope, f.latestClose, f.latestOpen, f.candleBody);
  const b4 = crashBuyC4RecoveryQuality(f.emaDist, f.bbWidthRoc, f.atrAccel, f.atrRank);
  const b5 = crashBuyC5EntryEfficiency(f.distFromRange30dLowPct, f.emaDist);
  const b6 = crashBuyC6MoveSufficiency(f.distFromRange30dHighPct, f.atrRank);
  const buyNative = Math.round(b1 * 0.25 + b2 * 0.20 + b3 * 0.20 + b4 * 0.15 + b5 * 0.10 + b6 * 0.10);

  const s1 = crashSellC1RallyExtension(f.spikeHazardScore, f.runLengthSinceSpike);
  const s2 = crashSellC2UpsideStretch(f.distFromRange30dHighPct, f.bbPctB, f.rsi14);
  const s3 = boomC3ExhaustionEvidence(f.emaSlope, f.latestClose, f.latestOpen, f.candleBody); // same function as BOOM sell
  const s4 = crashSellC4CascadePotential(f.emaDist, f.bbWidthRoc, f.atrRank);
  const s5 = crashSellC5EntryEfficiency(f.distFromRange30dHighPct, f.emaDist);
  const s6 = crashSellC6MoveSufficiency(f.distFromRange30dLowPct, f.atrRank);
  const sellNative = Math.round(s1 * 0.25 + s2 * 0.20 + s3 * 0.20 + s4 * 0.15 + s5 * 0.10 + s6 * 0.10);

  return {
    buyNative, sellNative,
    buyComponents:  { crashSpikeClusterPressure: b1, downsideDisplacement: b2, exhaustionReversalEvidence: b3, recoveryQuality: b4, entryEfficiency: b5, expectedMoveSufficiency: b6 },
    sellComponents: { rallyExtension: s1, upsideStretch: s2, rallyExhaustionEvidence: s3, cascadePotential: s4, entryEfficiency: s5, expectedMoveSufficiency: s6 },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// R_75 / R_100 REVERSAL COMPONENT FUNCTIONS — inlined from r75Engines.ts
// R_100 uses the same component logic with slightly wider range thresholds;
// for calibration we use the R_75 functions for both (approximation noted).
// ══════════════════════════════════════════════════════════════════════════════

function revC1RangeExtremity(distFromExtreme: number): number {
  const dist = Math.abs(distFromExtreme);
  let s: number;
  if (dist <= 0.005)       s = 95;
  else if (dist <= 0.02)   s = 95 - ((dist - 0.005) / 0.015) * 18;
  else if (dist <= 0.05)   s = 77 - ((dist - 0.02)  / 0.03)  * 22;
  else if (dist <= 0.10)   s = 55 - ((dist - 0.05)  / 0.05)  * 25;
  else if (dist <= 0.15)   s = 30 - ((dist - 0.10)  / 0.05)  * 18;
  else                     s = 12;
  return clamp(Math.round(s), 0, 100);
}

function revC2ReversalConfirmation(direction: "buy" | "sell", f: {
  lowerWickRatio: number; upperWickRatio: number; candleBody: number;
  latestClose: number; latestOpen: number; rsi14: number; emaSlope: number;
}): number {
  let s = 0;
  if (direction === "buy") {
    s += f.lowerWickRatio >= 0.60 ? 30 : f.lowerWickRatio >= 0.40 ? 20 : f.lowerWickRatio >= 0.25 ? 10 : 0;
    const bull = f.latestClose > f.latestOpen;
    s += (bull && f.candleBody >= 0.55) ? 25 : (bull && f.candleBody >= 0.30) ? 16 : bull ? 8 : 0;
    s += f.rsi14 <= 22 ? 25 : f.rsi14 <= 28 ? 20 : f.rsi14 <= 35 ? 12 : f.rsi14 <= 42 ? 5 : 0;
    s += f.emaSlope >= 0.0001 ? 20 : f.emaSlope >= -0.0001 ? 14 : f.emaSlope >= -0.0003 ? 7 : 0;
  } else {
    s += f.upperWickRatio >= 0.60 ? 30 : f.upperWickRatio >= 0.40 ? 20 : f.upperWickRatio >= 0.25 ? 10 : 0;
    const bear = f.latestClose < f.latestOpen;
    s += (bear && f.candleBody >= 0.55) ? 25 : (bear && f.candleBody >= 0.30) ? 16 : bear ? 8 : 0;
    s += f.rsi14 >= 78 ? 25 : f.rsi14 >= 72 ? 20 : f.rsi14 <= 65 ? 12 : f.rsi14 >= 60 ? 5 : 0;
    s += f.emaSlope <= -0.0001 ? 20 : f.emaSlope <= 0.0001 ? 14 : f.emaSlope <= 0.0003 ? 7 : 0;
  }
  return clamp(Math.round(s), 0, 100);
}

function revC3StretchDeviation(direction: "buy" | "sell", zScore: number, bbPctB: number, emaDist: number): number {
  let s = 0;
  if (direction === "buy") {
    s += zScore <= -2.5 ? 40 : zScore <= -2.0 ? 32 : zScore <= -1.5 ? 22 : zScore <= -1.0 ? 12 : 0;
    s += bbPctB <= 0.05 ? 35 : bbPctB <= 0.12 ? 27 : bbPctB <= 0.22 ? 17 : bbPctB <= 0.35 ? 8 : 0;
    s += emaDist <= -0.015 ? 25 : emaDist <= -0.008 ? 18 : emaDist <= -0.003 ? 10 : 0;
  } else {
    s += zScore >= 2.5 ? 40 : zScore >= 2.0 ? 32 : zScore >= 1.5 ? 22 : zScore >= 1.0 ? 12 : 0;
    s += bbPctB >= 0.95 ? 35 : bbPctB >= 0.88 ? 27 : bbPctB >= 0.78 ? 17 : bbPctB >= 0.65 ? 8 : 0;
    s += emaDist >= 0.015 ? 25 : emaDist >= 0.008 ? 18 : emaDist >= 0.003 ? 10 : 0;
  }
  return clamp(Math.round(s), 0, 100);
}

function revC4StructureQuality(direction: "buy" | "sell", emaSlope: number, consecutive: number, bbWidth: number, atrRank: number): number {
  let s = 0;
  if (direction === "buy") {
    s += emaSlope >= 0.0001 ? 35 : emaSlope >= -0.0001 ? 26 : emaSlope >= -0.0004 ? 16 : 6;
    s += (consecutive >= -2 && consecutive <= 1) ? 30 : (consecutive >= -4 && consecutive < -2) ? 20 : consecutive < -4 ? 8 : 18;
    s += bbWidth <= 0.015 ? 25 : bbWidth <= 0.022 ? 18 : bbWidth <= 0.032 ? 10 : 3;
    s += atrRank <= 1.0 ? 10 : atrRank <= 1.3 ? 5 : 0;
  } else {
    s += emaSlope <= -0.0001 ? 35 : emaSlope <= 0.0001 ? 26 : emaSlope <= 0.0004 ? 16 : 6;
    s += (consecutive >= -1 && consecutive <= 2) ? 30 : (consecutive > 2 && consecutive <= 4) ? 20 : consecutive > 4 ? 8 : 18;
    s += bbWidth <= 0.015 ? 25 : bbWidth <= 0.022 ? 18 : bbWidth <= 0.032 ? 10 : 3;
    s += atrRank <= 1.0 ? 10 : atrRank <= 1.3 ? 5 : 0;
  }
  return clamp(Math.round(s), 0, 100);
}

function revC5EntryEfficiency(direction: "buy" | "sell", distFromExtreme: number, emaDist: number): number {
  const dist = Math.abs(distFromExtreme);
  let s: number;
  if (dist <= 0.005)       s = 90;
  else if (dist <= 0.015)  s = 90 - ((dist - 0.005) / 0.01) * 18;
  else if (dist <= 0.04)   s = 72 - ((dist - 0.015) / 0.025) * 28;
  else if (dist <= 0.08)   s = 44 - ((dist - 0.04)  / 0.04) * 20;
  else                     s = 24;
  if (direction === "buy" && emaDist < -0.005) s += 10;
  else if (direction === "sell" && emaDist > 0.005) s += 10;
  return clamp(Math.round(s), 0, 100);
}

function revC6MoveSufficiency(distToOpposite: number, atrRank: number): number {
  const runway = Math.abs(distToOpposite);
  let s = clamp(Math.round(runway * 220), 0, 80);
  s += atrRank >= 1.4 ? 20 : atrRank >= 1.1 ? 12 : atrRank >= 0.8 ? 5 : 0;
  return clamp(Math.round(s), 0, 100);
}

interface VolatilityScores {
  buyNative: number; sellNative: number;
  buyComponents: Record<string, number>;
  sellComponents: Record<string, number>;
}

function scoreVolatilityReversal(f: {
  distFromRange30dHighPct: number; distFromRange30dLowPct: number;
  lowerWickRatio: number; upperWickRatio: number; candleBody: number;
  latestClose: number; latestOpen: number; rsi14: number; emaSlope: number;
  emaDist: number; zScore: number; bbPctB: number; bbWidth: number;
  atrRank: number; consecutive: number;
}): VolatilityScores {
  const buyExtremity  = Math.abs(f.distFromRange30dLowPct);
  const sellExtremity = Math.abs(f.distFromRange30dHighPct);

  const buyDistFromExtreme  = f.distFromRange30dLowPct;
  const sellDistFromExtreme = f.distFromRange30dHighPct;

  const bc1 = revC1RangeExtremity(buyDistFromExtreme);
  const bc2 = revC2ReversalConfirmation("buy", f);
  const bc3 = revC3StretchDeviation("buy", f.zScore, f.bbPctB, f.emaDist);
  const bc4 = revC4StructureQuality("buy", f.emaSlope, f.consecutive, f.bbWidth, f.atrRank);
  const bc5 = revC5EntryEfficiency("buy", buyDistFromExtreme, f.emaDist);
  const bc6 = revC6MoveSufficiency(f.distFromRange30dHighPct, f.atrRank);
  const buyNative = Math.round(bc1 * 0.25 + bc2 * 0.20 + bc3 * 0.20 + bc4 * 0.15 + bc5 * 0.10 + bc6 * 0.10);

  const sc1 = revC1RangeExtremity(sellDistFromExtreme);
  const sc2 = revC2ReversalConfirmation("sell", f);
  const sc3 = revC3StretchDeviation("sell", f.zScore, f.bbPctB, f.emaDist);
  const sc4 = revC4StructureQuality("sell", f.emaSlope, f.consecutive, f.bbWidth, f.atrRank);
  const sc5 = revC5EntryEfficiency("sell", sellDistFromExtreme, f.emaDist);
  const sc6 = revC6MoveSufficiency(f.distFromRange30dLowPct, f.atrRank);
  const sellNative = Math.round(sc1 * 0.25 + sc2 * 0.20 + sc3 * 0.20 + sc4 * 0.15 + sc5 * 0.10 + sc6 * 0.10);

  return {
    buyNative, sellNative,
    buyComponents:  { rangeExtremity: bc1, reversalConfirmation: bc2, stretchDeviation: bc3, structureQuality: bc4, entryEfficiency: bc5, expectedMoveSufficiency: bc6 },
    sellComponents: { rangeExtremity: sc1, reversalConfirmation: sc2, stretchDeviation: sc3, structureQuality: sc4, entryEfficiency: sc5, expectedMoveSufficiency: sc6 },
  };
}

// ── Distribution computation ──────────────────────────────────────────────────

interface ScoreSample {
  ts: number;
  native: number;
  components: Record<string, number>;
}

function buildDistribution(samples: ScoreSample[], gate: number): {
  scoreDistribution: EngineCalibrationSummary["scoreDistribution"];
  passRates: EngineCalibrationSummary["passRates"];
  bestSetups: SetupExample[];
  weakestSetups: SetupExample[];
  gatePassRate: number;
  engineGate: number;
} {
  if (samples.length === 0) {
    const empty = { min: 0, p10: 0, p25: 0, p50: 0, p75: 0, p85: 0, p90: 0, p92: 0, p95: 0, p99: 0, max: 0, mean: 0 };
    return { scoreDistribution: empty, passRates: { at85: 0, at90: 0, at92: 0 }, bestSetups: [], weakestSetups: [], gatePassRate: 0, engineGate: gate };
  }

  const scores = samples.map(s => s.native).sort((a, b) => a - b);
  const n = scores.length;
  const scoreDistribution = {
    min:  scores[0],
    p10:  pct(scores, 10),
    p25:  pct(scores, 25),
    p50:  pct(scores, 50),
    p75:  pct(scores, 75),
    p85:  pct(scores, 85),
    p90:  pct(scores, 90),
    p92:  pct(scores, 92),
    p95:  pct(scores, 95),
    p99:  pct(scores, 99),
    max:  scores[n - 1],
    mean: Math.round(meanArr(scores) * 10) / 10,
  };
  const passRates = {
    at85: Math.round(samples.filter(s => s.native >= 85).length / n * 1000) / 10,
    at90: Math.round(samples.filter(s => s.native >= 90).length / n * 1000) / 10,
    at92: Math.round(samples.filter(s => s.native >= 92).length / n * 1000) / 10,
  };
  const gatePassRate = Math.round(samples.filter(s => s.native >= gate).length / n * 1000) / 10;

  const sorted = [...samples].sort((a, b) => b.native - a.native);
  const mkExample = (s: ScoreSample): SetupExample => ({
    ts: s.ts,
    isoDate: new Date(s.ts * 1000).toISOString(),
    nativeScore: s.native,
    components: s.components,
  });
  const bestSetups = sorted.slice(0, 5).map(mkExample);
  const weakestSetups = sorted.slice(-5).map(mkExample);

  return { scoreDistribution, passRates, bestSetups, weakestSetups, gatePassRate, engineGate: gate };
}

// ── Main calibration entry point ──────────────────────────────────────────────

const SYMBOLS = ["BOOM300", "CRASH300", "R_75", "R_100"] as const;
const WARMUP = 55;

const ENGINE_GATES: Record<string, Record<string, number>> = {
  BOOM300:  { sell: 55, buy: 50 },
  CRASH300: { buy: 55, sell: 50 },
  R_75:     { buy: 55, sell: 55 },
  R_100:    { buy: 58, sell: 58 },
};

export async function runNativeScoreCalibration(
  updatePlatformState = false,
): Promise<CalibrationReport> {
  console.log("[Calibration] Starting native score calibration across all symbols...");

  const engines: EngineCalibrationSummary[] = [];
  let totalHTFBars = 0;

  for (const symbol of SYMBOLS) {
    console.log(`[Calibration] Loading 1m candles for ${symbol}...`);

    const raw = await backgroundDb
      .select({
        openTs: candlesTable.openTs, closeTs: candlesTable.closeTs,
        open: candlesTable.open, high: candlesTable.high,
        low: candlesTable.low, close: candlesTable.close,
      })
      .from(candlesTable)
      .where(and(eq(candlesTable.symbol, symbol), eq(candlesTable.timeframe, "1m")))
      .orderBy(asc(candlesTable.openTs));

    if (raw.length < 500) {
      console.warn(`[Calibration] ${symbol}: insufficient candles (${raw.length}) — skipping`);
      continue;
    }

    const candles1m: Candle1m[] = raw;
    console.log(`[Calibration] ${symbol}: ${candles1m.length} 1m candles loaded`);

    // Precompute 30d rolling max/min — O(N)
    const rolling30dHigh = computeRolling30dHigh(candles1m);
    const rolling30dLow  = computeRolling30dLow(candles1m);

    // Aggregate to HTF
    const htfMins = getHTFPeriodMins(symbol);
    const htf = aggregateToHTF(candles1m, htfMins);
    console.log(`[Calibration] ${symbol}: ${htf.length} HTF bars (${htfMins}m)`);

    if (htf.length < WARMUP + 5) {
      console.warn(`[Calibration] ${symbol}: insufficient HTF bars (${htf.length}) — skipping`);
      continue;
    }

    // Load spike events for BOOM/CRASH
    let spikes: SpikeEventRow[] = [];
    if (symbol.startsWith("BOOM") || symbol.startsWith("CRASH")) {
      const rawSpikes = await db
        .select({ eventTs: spikeEventsTable.eventTs, ticksSincePreviousSpike: spikeEventsTable.ticksSincePreviousSpike })
        .from(spikeEventsTable)
        .where(eq(spikeEventsTable.symbol, symbol))
        .orderBy(asc(spikeEventsTable.eventTs));
      spikes = rawSpikes;
      console.log(`[Calibration] ${symbol}: ${spikes.length} spike events loaded`);
    }

    // Build HTF indicator arrays
    const htfHighs  = htf.map(c => c.high);
    const htfLows   = htf.map(c => c.low);
    const htfCloses = htf.map(c => c.close);
    const htfOpens  = htf.map(c => c.open);
    const ema20Arr  = computeEMAArr(htfCloses, 20);

    // Collect samples per engine
    const boomSellSamples:   ScoreSample[] = [];
    const boomBuySamples:    ScoreSample[] = [];
    const crashBuySamples:   ScoreSample[] = [];
    const crashSellSamples:  ScoreSample[] = [];
    const volBuySamples:     ScoreSample[] = [];
    const volSellSamples:    ScoreSample[] = [];

    for (let i = WARMUP; i < htf.length; i++) {
      const c = htf[i];
      const price = c.close;
      if (price <= 0) continue;

      // EMA slope + dist
      const ema20      = ema20Arr[i];
      const ema20prev  = ema20Arr[i - 1] || ema20;
      const emaSlope   = ema20 > 0 ? (ema20 - ema20prev) / ema20 : 0;
      const emaDist    = ema20 > 0 ? (price - ema20) / ema20 : 0;

      // RSI (computed on-demand; affordable at ~617 HTF bars)
      const rsi14 = computeRSIAt(htfCloses, i, 14);

      // ATR14 + ATR50 for atrRank
      const atr14abs = computeATRAt(htfHighs, htfLows, htfCloses, i, 14);
      const atr50abs = computeATRAt(htfHighs, htfLows, htfCloses, i, 50);
      const atr14    = price > 0 ? atr14abs / price : 0;
      const atr50    = price > 0 ? atr50abs / price : 0;
      const atrRank  = atr50 > 0 ? Math.min(atr14 / atr50, 2) : 1;

      // BB(20)
      const bbStart   = Math.max(0, i - 19);
      const bbSlice   = htfCloses.slice(bbStart, i + 1);
      const bbMean    = meanArr(bbSlice);
      const bbStdV    = stdArr(bbSlice);
      const bbWidth   = bbStdV > 0 ? (4 * bbStdV) / bbMean : 0;
      const bbPctB    = bbStdV > 0 ? (price - (bbMean - 2 * bbStdV)) / (4 * bbStdV) : 0.5;

      // zScore(20)
      const z20Mean   = bbMean;
      const z20Std    = bbStdV;
      const zScore    = z20Std > 0 ? (price - z20Mean) / z20Std : 0;

      // bbWidthRoc: compare to 5 HTF bars ago
      const bbWidthPrev = (() => {
        if (i < 25) return bbWidth;
        const sl = htfCloses.slice(Math.max(0, i - 24), i - 4);
        const mp = meanArr(sl); const sp = stdArr(sl);
        return sp > 0 ? (4 * sp) / mp : bbWidth;
      })();
      const bbWidthRoc = bbWidthPrev > 0 ? (bbWidth - bbWidthPrev) / bbWidthPrev : 0;

      // atrAccel: compare to 5 HTF bars ago
      const atr14prev5 = i >= 5 ? (computeATRAt(htfHighs, htfLows, htfCloses, i - 5, 14) / Math.max(htfCloses[i - 5], 1)) : atr14;
      const atrAccel   = atr14prev5 > 0 ? (atr14 / atr14prev5) - 1 : 0;

      // Candle structure from HTF candle
      const range      = c.high - c.low;
      const body       = Math.abs(c.close - c.open);
      const candleBody = range > 0 ? body / range : 0;
      const upperWick  = range > 0 ? (c.high - Math.max(c.open, c.close)) / Math.max(body, 1e-6) : 0;
      const lowerWick  = range > 0 ? (Math.min(c.open, c.close) - c.low) / Math.max(body, 1e-6) : 0;

      // Consecutive from HTF
      let consecutive = 0;
      for (let j = i; j >= Math.max(0, i - 20); j--) {
        const up = htf[j].close > htf[j].open;
        if (j === i) { consecutive = up ? 1 : -1; }
        else if ((up && consecutive > 0) || (!up && consecutive < 0)) { consecutive += up ? 1 : -1; }
        else break;
      }

      // 30d range from precomputed arrays (find nearest 1m candle)
      const idx1m = findCandle1mIdx(candles1m, c.openTs);
      const high30d = rolling30dHigh[idx1m];
      const low30d  = rolling30dLow[idx1m];
      const distFromRange30dHighPct = high30d > 0 ? (price - high30d) / high30d : 0;
      const distFromRange30dLowPct  = low30d  > 0 ? (price - low30d)  / low30d  : 0;

      // Spike features
      const { spikeHazardScore, runLengthSinceSpike } = computeSpikeFeatures(c.openTs, spikes);

      const f = {
        spikeHazardScore, runLengthSinceSpike,
        distFromRange30dHighPct, distFromRange30dLowPct,
        bbPctB, rsi14, emaSlope, emaDist, priceVsEma20: emaDist,
        candleBody, latestClose: c.close, latestOpen: c.open,
        bbWidthRoc, atrAccel, atrRank, bbWidth, zScore, consecutive,
        lowerWickRatio: lowerWick, upperWickRatio: upperWick,
      };

      if (symbol === "BOOM300") {
        const s = scoreBoom300(f);
        boomSellSamples.push({ ts: c.openTs, native: s.sellNative, components: s.sellComponents });
        boomBuySamples.push ({ ts: c.openTs, native: s.buyNative,  components: s.buyComponents  });
      } else if (symbol === "CRASH300") {
        const s = scoreCrash300(f);
        crashBuySamples.push ({ ts: c.openTs, native: s.buyNative,  components: s.buyComponents  });
        crashSellSamples.push({ ts: c.openTs, native: s.sellNative, components: s.sellComponents });
      } else {
        const s = scoreVolatilityReversal(f);
        volBuySamples.push ({ ts: c.openTs, native: s.buyNative,  components: s.buyComponents  });
        volSellSamples.push({ ts: c.openTs, native: s.sellNative, components: s.sellComponents });
      }
    }

    const htfBarsAnalyzed = htf.length - WARMUP;
    totalHTFBars += htfBarsAnalyzed;

    if (symbol === "BOOM300") {
      const sd = buildDistribution(boomSellSamples, ENGINE_GATES.BOOM300.sell);
      const bd = buildDistribution(boomBuySamples, ENGINE_GATES.BOOM300.buy);
      engines.push({ symbol, engineName: "boom_expansion_engine", direction: "sell", htfBarsAnalyzed, htfPeriodMins: htfMins, ...sd });
      engines.push({ symbol, engineName: "boom_expansion_engine", direction: "buy",  htfBarsAnalyzed, htfPeriodMins: htfMins, ...bd });
    } else if (symbol === "CRASH300") {
      const bd = buildDistribution(crashBuySamples, ENGINE_GATES.CRASH300.buy);
      const sd = buildDistribution(crashSellSamples, ENGINE_GATES.CRASH300.sell);
      engines.push({ symbol, engineName: "crash_expansion_engine", direction: "buy",  htfBarsAnalyzed, htfPeriodMins: htfMins, ...bd });
      engines.push({ symbol, engineName: "crash_expansion_engine", direction: "sell", htfBarsAnalyzed, htfPeriodMins: htfMins, ...sd });
    } else {
      const engineName = symbol === "R_75" ? "r75_reversal_engine" : "r100_reversal_engine";
      const gate = ENGINE_GATES[symbol]?.buy ?? 55;
      const bd = buildDistribution(volBuySamples,  gate);
      const sd = buildDistribution(volSellSamples, gate);
      engines.push({ symbol, engineName, direction: "buy",  htfBarsAnalyzed, htfPeriodMins: htfMins, ...bd });
      engines.push({ symbol, engineName, direction: "sell", htfBarsAnalyzed, htfPeriodMins: htfMins, ...sd });
    }

    console.log(`[Calibration] ${symbol}: complete`);
  }

  // ── Compute threshold recommendations ──────────────────────────────────────
  // Primary engines: BOOM300 sell, CRASH300 buy, R_75 buy/sell, R_100 buy/sell
  const primaryEngines = engines.filter(e =>
    (e.symbol === "BOOM300"  && e.direction === "sell") ||
    (e.symbol === "CRASH300" && e.direction === "buy")  ||
    (e.symbol === "R_75"     && (e.direction === "buy" || e.direction === "sell")) ||
    (e.symbol === "R_100"    && (e.direction === "buy" || e.direction === "sell"))
  );

  // Recommended paper threshold = median of primary engine p90 values
  // This ensures ~10% of historically "good" setups pass paper mode
  const p90Values = primaryEngines.map(e => e.scoreDistribution.p90).filter(v => v > 0);
  const p92Values = primaryEngines.map(e => e.scoreDistribution.p92).filter(v => v > 0);
  const p95Values = primaryEngines.map(e => e.scoreDistribution.p95).filter(v => v > 0);

  const medianOf = (arr: number[]) => {
    if (arr.length === 0) return 85;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  const recommendedPaper = Math.max(70, Math.min(92, medianOf(p90Values)));
  const recommendedDemo  = Math.max(recommendedPaper + 2, Math.min(96, medianOf(p92Values)));
  const recommendedReal  = Math.max(recommendedDemo + 2, Math.min(98, medianOf(p95Values)));

  const currentPassRates = primaryEngines.map(e =>
    `${e.symbol}(${e.direction})@85=${e.passRates.at85}%`
  ).join(", ");

  const recommendations: ThresholdRecommendations = {
    paper: recommendedPaper,
    demo:  recommendedDemo,
    real:  recommendedReal,
    rationale: `Based on ${totalHTFBars} HTF bars across ${SYMBOLS.length} symbols. ` +
      `Current pass rates at 85: [${currentPassRates}]. ` +
      `Recommended thresholds set at p90/p92/p95 of primary engine score distributions. ` +
      `Paper=${recommendedPaper} (p90 median), Demo=${recommendedDemo} (p92 median), Real=${recommendedReal} (p95 median). ` +
      `Thresholds ≥85/90/92 are the non-negotiable MINIMUM — do not set lower.`,
  };

  // Enforce non-negotiable minimums
  recommendations.paper = Math.max(85, recommendations.paper);
  recommendations.demo  = Math.max(90, recommendations.demo);
  recommendations.real  = Math.max(92, recommendations.real);

  let platformStateUpdateApplied = false;

  if (updatePlatformState) {
    const upsert = async (key: string, value: string) => {
      await db.insert(platformStateTable).values({ key, value })
        .onConflictDoUpdate({ target: platformStateTable.key, set: { value, updatedAt: new Date() } });
    };
    await upsert("paper_min_composite_score", String(recommendations.paper));
    await upsert("demo_min_composite_score",  String(recommendations.demo));
    await upsert("real_min_composite_score",  String(recommendations.real));
    await upsert("calibration_last_run", new Date().toISOString());
    platformStateUpdateApplied = true;
    console.log(`[Calibration] Platform state updated: paper=${recommendations.paper}, demo=${recommendations.demo}, real=${recommendations.real}`);
  }

  const report: CalibrationReport = {
    generatedAt: new Date().toISOString(),
    symbolCount: SYMBOLS.length,
    totalHTFBarsAnalyzed: totalHTFBars,
    engines,
    recommendations,
    platformStateUpdateApplied,
  };

  console.log(`[Calibration] Complete — ${engines.length} engine reports, ${totalHTFBars} total HTF bars analyzed`);
  console.log(`[Calibration] Recommendations: paper=${recommendations.paper}, demo=${recommendations.demo}, real=${recommendations.real}`);

  return report;
}
