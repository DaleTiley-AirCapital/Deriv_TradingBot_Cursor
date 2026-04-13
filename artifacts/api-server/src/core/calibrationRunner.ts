/**
 * Native Score Calibration Runner — Task #104
 *
 * Replays ALL historical 1m candles through every V3 engine's component scoring
 * functions to compute realistic native-score distributions from real market data.
 *
 * Coverage: 8 engine families × 2 directions
 *   BOOM300: sell (primary), buy (secondary)
 *   CRASH300: buy (primary), sell (secondary)
 *   R_75: reversal, continuation, breakout — each buy + sell
 *   R_100: reversal, breakout, continuation — each buy + sell
 *
 * All component functions inlined verbatim from the respective engine source files.
 * R_100 uses its own component functions (not the R_75 approximation).
 *
 * Outputs:
 *  - CalibrationReport returned from runNativeScoreCalibration()
 *  - calibration-report.json written to artifacts/api-server/
 *  - platform_state updated when updatePlatformState=true
 */

import { backgroundDb, db, candlesTable, spikeEventsTable, platformStateTable } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";
import { writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = join(__dirname, "../../calibration-report.json");

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface CalibrationReport {
  reportGeneratedAt: string;
  enginesAnalyzed: number;
  totalHTFBarsAnalyzed: number;
  oldThresholds: { paper: number; demo: number; real: number };
  newThresholds: { paper: number; demo: number; real: number };
  perEngineDistributions: EngineCalibrationSummary[];
  recommendations: ThresholdRecommendations;
  platformStateUpdateApplied: boolean;
}

interface ThresholdRecommendations {
  paper: number;
  demo: number;
  real: number;
  rationale: string;
  mandatoryMinimums: { paper: 85; demo: 90; real: 92 };
}

interface EngineCalibrationSummary {
  symbol: string;
  engineName: string;
  direction: "buy" | "sell";
  htfBarsScored: number;
  htfPeriodMins: number;
  engineGate: number;
  scoreDistribution: {
    min: number; p10: number; p25: number; p50: number;
    p75: number; p85: number; p90: number; p92: number;
    p95: number; p99: number; max: number; mean: number;
  };
  passCountsAt: Record<string, number>;
  passRatesPct: Record<string, number>;
  gatePassCount: number;
  gatePassRatePct: number;
  idealCohort: IdealCohortSummary;
  bestSetups: SetupExample[];
  weakestSetups: SetupExample[];
}

interface IdealCohortSummary {
  thresholdUsed: number;
  count: number;
  meanScore: number;
  medianScore: number;
  p90Score: number;
  examples: SetupExample[];
}

interface SetupExample {
  ts: number;
  isoDate: string;
  nativeScore: number;
  components: Record<string, number>;
}

interface Candle1m {
  openTs: number; closeTs: number;
  open: number; high: number; low: number; close: number;
}

interface HTFCandle extends Candle1m {}

interface SpikeEventRow {
  eventTs: number;
  ticksSincePreviousSpike: number | null;
}

// ── Utility ───────────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function meanArr(arr: number[]): number {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdArr(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = meanArr(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
}

function pctile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(Math.floor((p / 100) * (sorted.length - 1)), sorted.length - 1)];
}

const PASS_THRESHOLDS = [60, 65, 70, 75, 80, 85, 90, 95];

// ── HTF aggregation ───────────────────────────────────────────────────────────

function getHTFMins(symbol: string): number {
  if (symbol.startsWith("CRASH")) return 720;
  if (symbol.startsWith("BOOM"))  return 480;
  return 240;
}

function aggregateHTF(candles: Candle1m[], periodMins: number): HTFCandle[] {
  const p = periodMins * 60;
  const result: HTFCandle[] = [];
  let cur: HTFCandle | null = null;
  let bucket = -1;
  for (const c of candles) {
    const b = Math.floor(c.openTs / p) * p;
    if (b !== bucket || !cur) {
      if (cur) result.push(cur);
      bucket = b;
      cur = { ...c };
    } else {
      cur.high  = Math.max(cur.high, c.high);
      cur.low   = Math.min(cur.low,  c.low);
      cur.close = c.close;
      cur.closeTs = c.closeTs;
    }
  }
  if (cur) result.push(cur);
  return result;
}

// ── Rolling indicators ────────────────────────────────────────────────────────

function emaArr(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const r: number[] = [];
  let prev = values[0];
  for (const v of values) { const c = v * k + prev * (1 - k); r.push(c); prev = c; }
  return r;
}

function rsiAt(closes: number[], i: number, period = 14): number {
  if (i < period + 1) return 50;
  const w = closes.slice(i - period, i + 1);
  const ch = w.slice(1).map((c, j) => c - w[j]);
  const ag = ch.filter(x => x > 0).reduce((a, b) => a + b, 0) / period;
  const al = ch.filter(x => x < 0).map(Math.abs).reduce((a, b) => a + b, 0) / period;
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

function atrAt(highs: number[], lows: number[], closes: number[], i: number, period = 14): number {
  if (i < 1) return 0;
  let sum = 0, cnt = 0;
  for (let j = Math.max(1, i - period + 1); j <= i; j++) {
    sum += Math.max(highs[j] - lows[j], Math.abs(highs[j] - closes[j-1]), Math.abs(lows[j] - closes[j-1]));
    cnt++;
  }
  return cnt > 0 ? sum / cnt : 0;
}

// ── O(N) sliding-window 30d high/low ─────────────────────────────────────────

function rolling30dHigh(c: Candle1m[]): Float64Array {
  const W = 43200, n = c.length, r = new Float64Array(n);
  const dq: number[] = [];
  for (let i = 0; i < n; i++) {
    while (dq.length && dq[0] < i - W) dq.shift();
    while (dq.length && c[dq[dq.length-1]].high <= c[i].high) dq.pop();
    dq.push(i); r[i] = c[dq[0]].high;
  }
  return r;
}

function rolling30dLow(c: Candle1m[]): Float64Array {
  const W = 43200, n = c.length, r = new Float64Array(n);
  const dq: number[] = [];
  for (let i = 0; i < n; i++) {
    while (dq.length && dq[0] < i - W) dq.shift();
    while (dq.length && c[dq[dq.length-1]].low >= c[i].low) dq.pop();
    dq.push(i); r[i] = c[dq[0]].low;
  }
  return r;
}

function bsIdx(c: Candle1m[], ts: number): number {
  let lo = 0, hi = c.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (c[m].openTs <= ts) lo = m; else hi = m - 1; }
  return lo;
}

// ── Spike hazard (corrected runLengthSinceSpike) ─────────────────────────────

function spikeFeats(ts: number, spikes: SpikeEventRow[]): { spikeHazardScore: number; runLengthSinceSpike: number } {
  let li = -1;
  for (let i = spikes.length - 1; i >= 0; i--) { if (spikes[i].eventTs <= ts) { li = i; break; } }
  if (li === -1) return { spikeHazardScore: 0, runLengthSinceSpike: 999 };
  const run = Math.max(0, Math.round((ts - spikes[li].eventTs) / 60));
  const ivs = spikes.slice(Math.max(0, li - 7), li + 1).map(s => s.ticksSincePreviousSpike ?? 0).filter(x => x > 0);
  let haz = 0;
  if (ivs.length >= 3) {
    const m = meanArr(ivs), s = stdArr(ivs), t = spikes[li].ticksSincePreviousSpike ?? 999;
    haz = s > 0 ? 1 / (1 + Math.exp(-((t - m) / s))) : (t > m ? 0.7 : 0.3);
  }
  return { spikeHazardScore: clamp(haz, 0, 1), runLengthSinceSpike: run };
}

// ══════════════════════════════════════════════════════════════════════════════
// BOOM300 COMPONENT FUNCTIONS (inlined from boom300Engine.ts)
// ══════════════════════════════════════════════════════════════════════════════

function boomSellC1SpikeClusterPressure(spikeHazardScore: number, runLengthSinceSpike: number): number {
  let s = spikeHazardScore * 55;
  if      (runLengthSinceSpike <= 5)  s += 35;
  else if (runLengthSinceSpike <= 15) s += 25;
  else if (runLengthSinceSpike <= 30) s += 15;
  else if (runLengthSinceSpike <= 60) s += 5;
  if (spikeHazardScore >= 0.55 && runLengthSinceSpike <= 20) s += 15;
  return clamp(Math.round(s), 0, 100);
}

function boomSellC2UpsideDisplacement(distFromRange30dHighPct: number, bbPctB: number, rsi14: number): number {
  const d = Math.abs(distFromRange30dHighPct);
  let s = d <= 0.03 ? 50 : d <= 0.07 ? 40 : d <= 0.12 ? 28 : d <= 0.18 ? 16 : d <= 0.25 ? 8 : 2;
  s += clamp(bbPctB * 30, 0, 30);
  s += rsi14 >= 75 ? 20 : rsi14 >= 65 ? 13 : rsi14 >= 58 ? 7 : 0;
  return clamp(Math.round(s), 0, 100);
}

function boomSellC3ExhaustionEvidence(emaSlope: number, latestClose: number, latestOpen: number, candleBody: number): number {
  let s = emaSlope <= -0.0006 ? 50 : emaSlope <= -0.0003 ? 40 : emaSlope <= -0.0001 ? 28 : emaSlope < 0 ? 15 : emaSlope <= 0.0002 ? 5 : 0;
  const bear = latestClose < latestOpen;
  s += (bear && candleBody >= 0.6) ? 35 : (bear && candleBody >= 0.35) ? 25 : bear ? 12 : 0;
  if (candleBody < 0.15) s += 10;
  return clamp(Math.round(s), 0, 100);
}

function boomSellC4DriftResumption(emaDist: number, bbWidthRoc: number, atrAccel: number, atrRank: number): number {
  let s = 30;
  s += emaDist > 0.015 ? 25 : emaDist > 0.005 ? 15 : emaDist > 0 ? 8 : -5;
  s += bbWidthRoc < -0.10 ? 25 : bbWidthRoc < -0.04 ? 18 : bbWidthRoc < 0 ? 8 : bbWidthRoc < 0.05 ? 0 : -8;
  s += atrAccel < -0.08 ? 20 : atrAccel < -0.03 ? 12 : atrAccel < 0 ? 5 : -5;
  return clamp(Math.round(s), 0, 100);
}

function boomSellC5EntryEfficiency(distFromRange30dHighPct: number, emaDist: number): number {
  const d = Math.abs(distFromRange30dHighPct);
  let s = d <= 0.02 ? 90 : d <= 0.05 ? 75 : d <= 0.09 ? 58 : d <= 0.14 ? 40 : d <= 0.22 ? 22 : 8;
  if (emaDist > 0.008) s = Math.min(100, s + 10);
  return clamp(Math.round(s), 0, 100);
}

function boomSellC6MoveSufficiency(distFromRange30dLowPct: number, atrRank: number): number {
  const d = Math.abs(distFromRange30dLowPct);
  let s = clamp(d * 220, 0, 70);
  s += atrRank >= 1.3 ? 25 : atrRank >= 1.0 ? 15 : atrRank >= 0.7 ? 8 : 0;
  if (d < 0.08) s = Math.min(s, 30);
  return clamp(Math.round(s), 0, 100);
}

function scoreBoom300Sell(f: { spikeHazardScore: number; runLengthSinceSpike: number; distFromRange30dHighPct: number; distFromRange30dLowPct: number; bbPctB: number; rsi14: number; emaSlope: number; emaDist: number; candleBody: number; latestClose: number; latestOpen: number; bbWidthRoc: number; atrAccel: number; atrRank: number }): { native: number; components: Record<string, number> } {
  const c1 = boomSellC1SpikeClusterPressure(f.spikeHazardScore, f.runLengthSinceSpike);
  const c2 = boomSellC2UpsideDisplacement(f.distFromRange30dHighPct, f.bbPctB, f.rsi14);
  const c3 = boomSellC3ExhaustionEvidence(f.emaSlope, f.latestClose, f.latestOpen, f.candleBody);
  const c4 = boomSellC4DriftResumption(f.emaDist, f.bbWidthRoc, f.atrAccel, f.atrRank);
  const c5 = boomSellC5EntryEfficiency(f.distFromRange30dHighPct, f.emaDist);
  const c6 = boomSellC6MoveSufficiency(f.distFromRange30dLowPct, f.atrRank);
  return { native: Math.round(c1*0.25+c2*0.20+c3*0.20+c4*0.15+c5*0.10+c6*0.10), components: { spikeClusterPressure:c1,upsideDisplacement:c2,exhaustionEvidence:c3,driftResumption:c4,entryEfficiency:c5,expectedMoveSufficiency:c6 } };
}

function scoreBoom300Buy(f: { spikeHazardScore: number; runLengthSinceSpike: number; distFromRange30dHighPct: number; distFromRange30dLowPct: number; bbPctB: number; rsi14: number; emaSlope: number; emaDist: number; candleBody: number; latestClose: number; latestOpen: number; bbWidthRoc: number; atrAccel: number; atrRank: number }): { native: number; components: Record<string, number> } {
  const b1 = clamp(Math.round((1-f.spikeHazardScore)*60 + (f.spikeHazardScore<=0.25?30:f.spikeHazardScore<=0.40?15:f.spikeHazardScore<=0.55?0:-20) + (f.runLengthSinceSpike>=100?20:f.runLengthSinceSpike>=60?10:f.runLengthSinceSpike<30?-15:0)), 0, 100);
  const b2 = boomSellC2UpsideDisplacement(f.distFromRange30dLowPct, 1-f.bbPctB, 100-f.rsi14);
  const b3 = clamp(Math.round((f.emaSlope>=0.0003?50:f.emaSlope>0?38:f.emaSlope>-0.0001?28:f.emaSlope>-0.0003?18:8) + ((f.latestClose>f.latestOpen&&f.candleBody>=0.6)?35:(f.latestClose>f.latestOpen&&f.candleBody>=0.35)?25:f.latestClose>f.latestOpen?12:0) + (f.candleBody<0.15?10:0)), 0, 100);
  const b4 = clamp(Math.round(30 + (f.emaDist<-0.015?25:f.emaDist<-0.005?15:f.emaDist<0?8:-5) + (f.bbWidthRoc<-0.10?25:f.bbWidthRoc<-0.04?18:f.bbWidthRoc<0?8:f.bbWidthRoc<0.05?0:-8) + (f.atrAccel<-0.08?20:f.atrAccel<-0.03?12:f.atrAccel<0?5:-5)), 0, 100);
  const b5 = boomSellC5EntryEfficiency(f.distFromRange30dLowPct, -f.emaDist);
  const b6 = boomSellC6MoveSufficiency(f.distFromRange30dHighPct, f.atrRank);
  return { native: Math.round(b1*0.25+b2*0.20+b3*0.20+b4*0.15+b5*0.10+b6*0.10), components: { lowSpikeHazard:b1,downsideDisplacement:b2,exhaustionEvidence:b3,driftResumption:b4,entryEfficiency:b5,expectedMoveSufficiency:b6 } };
}

// ══════════════════════════════════════════════════════════════════════════════
// CRASH300 COMPONENT FUNCTIONS (inlined from crash300Engine.ts)
// ══════════════════════════════════════════════════════════════════════════════

function scoreCrash300Buy(f: { spikeHazardScore: number; runLengthSinceSpike: number; distFromRange30dHighPct: number; distFromRange30dLowPct: number; bbPctB: number; rsi14: number; emaSlope: number; emaDist: number; candleBody: number; latestClose: number; latestOpen: number; bbWidthRoc: number; atrAccel: number; atrRank: number }): { native: number; components: Record<string, number> } {
  const b1 = boomSellC1SpikeClusterPressure(f.spikeHazardScore, f.runLengthSinceSpike);
  const d2 = Math.abs(f.distFromRange30dLowPct);
  const b2 = clamp(Math.round((d2<=0.03?50:d2<=0.07?40:d2<=0.12?28:d2<=0.18?16:d2<=0.25?8:2) + clamp((1-f.bbPctB)*30,0,30) + (f.rsi14<=25?20:f.rsi14<=38?13:f.rsi14<=45?7:0)), 0, 100);
  const b3 = clamp(Math.round((f.emaSlope>0.0003?50:f.emaSlope>0?38:f.emaSlope>-0.0001?28:f.emaSlope>-0.0003?18:f.emaSlope>-0.0006?8:0) + ((f.latestClose>f.latestOpen&&f.candleBody>=0.6)?35:(f.latestClose>f.latestOpen&&f.candleBody>=0.35)?25:f.latestClose>f.latestOpen?12:0) + (f.candleBody<0.15?10:0)), 0, 100);
  const b4 = clamp(Math.round(30 + (f.emaDist>=0.010?25:f.emaDist>=0?15:f.emaDist>=-0.005?8:f.emaDist>=-0.015?3:-5) + (f.bbWidthRoc<-0.10?25:f.bbWidthRoc<-0.04?18:f.bbWidthRoc<0?8:f.bbWidthRoc<0.05?0:-8) + (f.atrAccel<-0.08?20:f.atrAccel<-0.03?12:f.atrAccel<0?5:-5)), 0, 100);
  const d5 = Math.abs(f.distFromRange30dLowPct);
  const b5 = clamp(Math.round((d5<=0.02?90:d5<=0.05?75:d5<=0.09?58:d5<=0.14?40:d5<=0.22?22:8) + (f.emaDist<-0.008?10:0)), 0, 100);
  const d6 = Math.abs(f.distFromRange30dHighPct);
  const b6 = clamp(Math.round(Math.min(d6*220,70) + (f.atrRank>=1.3?25:f.atrRank>=1.0?15:f.atrRank>=0.7?8:0)), 0, 100);
  if (d6 < 0.08) return { native: Math.round(b1*0.25+b2*0.20+b3*0.20+b4*0.15+b5*0.10+Math.min(b6,30)*0.10), components: { crashSpikeClusterPressure:b1,downsideDisplacement:b2,exhaustionReversalEvidence:b3,recoveryQuality:b4,entryEfficiency:b5,expectedMoveSufficiency:Math.min(b6,30) } };
  return { native: Math.round(b1*0.25+b2*0.20+b3*0.20+b4*0.15+b5*0.10+b6*0.10), components: { crashSpikeClusterPressure:b1,downsideDisplacement:b2,exhaustionReversalEvidence:b3,recoveryQuality:b4,entryEfficiency:b5,expectedMoveSufficiency:b6 } };
}

function scoreCrash300Sell(f: { spikeHazardScore: number; runLengthSinceSpike: number; distFromRange30dHighPct: number; distFromRange30dLowPct: number; bbPctB: number; rsi14: number; emaSlope: number; emaDist: number; candleBody: number; latestClose: number; latestOpen: number; bbWidthRoc: number; atrAccel: number; atrRank: number }): { native: number; components: Record<string, number> } {
  const s1 = clamp(Math.round((1-f.spikeHazardScore)*55 + (f.runLengthSinceSpike>=120?35:f.runLengthSinceSpike>=60?25:f.runLengthSinceSpike>=30?15:f.runLengthSinceSpike>=15?8:0) + (f.spikeHazardScore>=0.45&&f.runLengthSinceSpike>=20?10:0)), 0, 100);
  const d2 = Math.abs(f.distFromRange30dHighPct);
  const s2 = clamp(Math.round((d2<=0.03?50:d2<=0.07?40:d2<=0.12?28:d2<=0.18?16:d2<=0.25?8:2) + clamp(f.bbPctB*30,0,30) + (f.rsi14>=75?20:f.rsi14>=62?13:f.rsi14>=55?7:0)), 0, 100);
  const s3 = boomSellC3ExhaustionEvidence(f.emaSlope, f.latestClose, f.latestOpen, f.candleBody);
  const s4 = clamp(Math.round(30 + (f.emaDist>0.015?25:f.emaDist>0.005?15:f.emaDist>0?8:-5) + (f.bbWidthRoc>0.05?15:f.bbWidthRoc>0?8:f.bbWidthRoc>-0.04?3:-5) + (f.atrRank>=1.3?20:f.atrRank>=1.0?12:f.atrRank>=0.7?5:0)), 0, 100);
  const d5 = Math.abs(f.distFromRange30dHighPct);
  const s5 = clamp(Math.round((d5<=0.02?90:d5<=0.05?75:d5<=0.09?58:d5<=0.14?40:d5<=0.22?22:8) + (f.emaDist>0.008?10:0)), 0, 100);
  const d6 = Math.abs(f.distFromRange30dLowPct);
  const s6 = clamp(Math.round(Math.min(d6*220,70) + (f.atrRank>=1.3?25:f.atrRank>=1.0?15:f.atrRank>=0.7?8:0)), 0, 100);
  return { native: Math.round(s1*0.25+s2*0.20+s3*0.20+s4*0.15+s5*0.10+s6*0.10), components: { rallyExtension:s1,upsideStretch:s2,rallyExhaustionEvidence:s3,cascadePotential:s4,entryEfficiency:s5,expectedMoveSufficiency:s6 } };
}

// ══════════════════════════════════════════════════════════════════════════════
// R_75 REVERSAL (inlined from r75Engines.ts scoreRevXxx functions)
// ══════════════════════════════════════════════════════════════════════════════

function r75RevC1(distFromExtreme: number): number {
  const d = Math.abs(distFromExtreme);
  let s: number;
  if (d<=0.005) s=95;
  else if (d<=0.02) s=95-((d-0.005)/0.015)*18;
  else if (d<=0.05) s=77-((d-0.02)/0.03)*22;
  else if (d<=0.10) s=55-((d-0.05)/0.05)*25;
  else if (d<=0.15) s=30-((d-0.10)/0.05)*18;
  else s=12;
  return clamp(Math.round(s),0,100);
}

function r75RevC2(dir: "buy"|"sell", f: { lowerWickRatio:number;upperWickRatio:number;candleBody:number;latestClose:number;latestOpen:number;rsi14:number;emaSlope:number }): number {
  let s = 0;
  if (dir==="buy") {
    s += f.lowerWickRatio>=0.60?30:f.lowerWickRatio>=0.40?20:f.lowerWickRatio>=0.25?10:0;
    const bull = f.latestClose>f.latestOpen;
    s += (bull&&f.candleBody>=0.55)?25:(bull&&f.candleBody>=0.30)?16:bull?8:0;
    s += f.rsi14<=22?25:f.rsi14<=28?20:f.rsi14<=35?12:f.rsi14<=42?5:0;
    s += f.emaSlope>=0.0001?20:f.emaSlope>=-0.0001?14:f.emaSlope>=-0.0003?7:0;
  } else {
    s += f.upperWickRatio>=0.60?30:f.upperWickRatio>=0.40?20:f.upperWickRatio>=0.25?10:0;
    const bear = f.latestClose<f.latestOpen;
    s += (bear&&f.candleBody>=0.55)?25:(bear&&f.candleBody>=0.30)?16:bear?8:0;
    s += f.rsi14>=78?25:f.rsi14>=72?20:f.rsi14<=65?12:f.rsi14>=60?5:0;
    s += f.emaSlope<=-0.0001?20:f.emaSlope<=0.0001?14:f.emaSlope<=0.0003?7:0;
  }
  return clamp(Math.round(s),0,100);
}

function r75RevC3(dir: "buy"|"sell", zScore:number, bbPctB:number, emaDist:number): number {
  let s=0;
  if (dir==="buy") {
    s += zScore<=-2.5?40:zScore<=-2.0?32:zScore<=-1.5?22:zScore<=-1.0?12:0;
    s += bbPctB<=0.05?35:bbPctB<=0.12?27:bbPctB<=0.22?17:bbPctB<=0.35?8:0;
    s += emaDist<=-0.015?25:emaDist<=-0.008?18:emaDist<=-0.003?10:0;
  } else {
    s += zScore>=2.5?40:zScore>=2.0?32:zScore>=1.5?22:zScore>=1.0?12:0;
    s += bbPctB>=0.95?35:bbPctB>=0.88?27:bbPctB>=0.78?17:bbPctB>=0.65?8:0;
    s += emaDist>=0.015?25:emaDist>=0.008?18:emaDist>=0.003?10:0;
  }
  return clamp(Math.round(s),0,100);
}

function r75RevC4(dir: "buy"|"sell", emaSlope:number, consecutive:number, bbWidth:number, atrRank:number): number {
  let s=0;
  if (dir==="buy") {
    s += emaSlope>=0.0001?35:emaSlope>=-0.0001?26:emaSlope>=-0.0004?16:6;
    s += (consecutive>=-2&&consecutive<=1)?30:(consecutive>=-4&&consecutive<-2)?20:consecutive<-4?8:18;
    s += bbWidth<=0.015?25:bbWidth<=0.022?18:bbWidth<=0.032?10:3;
    s += atrRank<=1.0?10:atrRank<=1.3?5:0;
  } else {
    s += emaSlope<=-0.0001?35:emaSlope<=0.0001?26:emaSlope<=0.0004?16:6;
    s += (consecutive>=-1&&consecutive<=2)?30:(consecutive>2&&consecutive<=4)?20:consecutive>4?8:18;
    s += bbWidth<=0.015?25:bbWidth<=0.022?18:bbWidth<=0.032?10:3;
    s += atrRank<=1.0?10:atrRank<=1.3?5:0;
  }
  return clamp(Math.round(s),0,100);
}

function r75RevC5(dir: "buy"|"sell", distFromExtreme:number, emaDist:number): number {
  const d=Math.abs(distFromExtreme);
  let s: number;
  if (d<=0.005) s=90;
  else if (d<=0.015) s=90-((d-0.005)/0.01)*18;
  else if (d<=0.04) s=72-((d-0.015)/0.025)*28;
  else if (d<=0.08) s=44-((d-0.04)/0.04)*20;
  else s=24;
  if (dir==="buy"&&emaDist<-0.005) s+=10;
  else if (dir==="sell"&&emaDist>0.005) s+=10;
  return clamp(Math.round(s),0,100);
}

function r75RevC6(distToOpposite:number, atrRank:number): number {
  const r=Math.abs(distToOpposite);
  let s=clamp(Math.round(r*220),0,80);
  s += atrRank>=1.4?20:atrRank>=1.1?12:atrRank>=0.8?5:0;
  return clamp(Math.round(s),0,100);
}

function scoreR75Reversal(dir: "buy"|"sell", f: { distFromRange30dHighPct:number;distFromRange30dLowPct:number;lowerWickRatio:number;upperWickRatio:number;candleBody:number;latestClose:number;latestOpen:number;rsi14:number;emaSlope:number;emaDist:number;zScore:number;bbPctB:number;bbWidth:number;atrRank:number;consecutive:number }): { native:number;components:Record<string,number> } {
  const distE = dir==="buy"?f.distFromRange30dLowPct:f.distFromRange30dHighPct;
  const distO = dir==="buy"?f.distFromRange30dHighPct:f.distFromRange30dLowPct;
  const c1=r75RevC1(distE), c2=r75RevC2(dir,f), c3=r75RevC3(dir,f.zScore,f.bbPctB,f.emaDist);
  const c4=r75RevC4(dir,f.emaSlope,f.consecutive,f.bbWidth,f.atrRank), c5=r75RevC5(dir,distE,f.emaDist), c6=r75RevC6(distO,f.atrRank);
  return { native:Math.round(c1*0.25+c2*0.20+c3*0.20+c4*0.15+c5*0.10+c6*0.10), components:{rangeExtremity:c1,reversalConfirmation:c2,stretchDeviationQuality:c3,structureQuality:c4,entryEfficiency:c5,expectedMoveSufficiency:c6} };
}

// ══════════════════════════════════════════════════════════════════════════════
// R_75 CONTINUATION (inlined from r75Engines.ts scoreContXxx functions)
// ══════════════════════════════════════════════════════════════════════════════

function r75ContC1(dir: "buy"|"sell", emaSlope:number, rsi14:number, priceVsEma20:number): number {
  let s=0;
  if (dir==="buy") {
    s += emaSlope>=0.0006?40:emaSlope>=0.0003?30:emaSlope>=0.0001?18:0;
    s += (rsi14>=48&&rsi14<=65)?35:(rsi14>=42&&rsi14<=72)?22:rsi14<42?8:0;
    s += priceVsEma20>=0.010?25:priceVsEma20>=0.004?16:priceVsEma20>=0?8:0;
  } else {
    s += emaSlope<=-0.0006?40:emaSlope<=-0.0003?30:emaSlope<=-0.0001?18:0;
    s += (rsi14>=35&&rsi14<=52)?35:(rsi14>=28&&rsi14<=58)?22:rsi14>58?8:0;
    s += priceVsEma20<=-0.010?25:priceVsEma20<=-0.004?16:priceVsEma20<=0?8:0;
  }
  return clamp(Math.round(s),0,100);
}

function r75ContC2(dir: "buy"|"sell", bbPctB:number, emaDist:number, zScore:number): number {
  let s=0;
  const ae=Math.abs(emaDist);
  if (dir==="buy") {
    s += (bbPctB>=0.30&&bbPctB<=0.55)?35:(bbPctB>=0.20&&bbPctB<=0.65)?22:bbPctB<0.20?8:0;
    s += ae<=0.004?40:ae<=0.008?28:ae<=0.015?16:5;
    s += (zScore>=-0.5&&zScore<=0.8)?25:(zScore>=-1.0&&zScore<=1.2)?15:0;
  } else {
    s += (bbPctB>=0.45&&bbPctB<=0.70)?35:(bbPctB>=0.35&&bbPctB<=0.80)?22:bbPctB>0.80?8:0;
    s += ae<=0.004?40:ae<=0.008?28:ae<=0.015?16:5;
    s += (zScore>=-0.8&&zScore<=0.5)?25:(zScore>=-1.2&&zScore<=1.0)?15:0;
  }
  return clamp(Math.round(s),0,100);
}

function r75ContC3(dir: "buy"|"sell", emaSlope:number, consecutive:number, priceVsEma20:number): number {
  let s=0;
  if (dir==="buy") {
    s += emaSlope>=0.0005?55:emaSlope>=0.0002?40:emaSlope>=0.0001?25:emaSlope>=0?12:0;
    s += (consecutive>=2&&consecutive<=5)?30:(consecutive>=0&&consecutive<2)?18:consecutive>5?20:0;
    s += priceVsEma20>=0.008?15:priceVsEma20>=0.002?8:0;
  } else {
    s += emaSlope<=-0.0005?55:emaSlope<=-0.0002?40:emaSlope<=-0.0001?25:emaSlope<=0?12:0;
    s += (consecutive<=-2&&consecutive>=-5)?30:(consecutive<=0&&consecutive>-2)?18:consecutive<-5?20:0;
    s += priceVsEma20<=-0.008?15:priceVsEma20<=-0.002?8:0;
  }
  return clamp(Math.round(s),0,100);
}

function r75ContC4(zScore:number, atrRank:number, bbWidth:number): number {
  let s=0;
  const az=Math.abs(zScore);
  s += az<=1.2?40:az<=1.8?26:az<=2.3?12:0;
  s += (atrRank>=0.75&&atrRank<=1.35)?35:(atrRank>=0.55&&atrRank<=1.55)?22:atrRank<0.55?8:8;
  s += (bbWidth>=0.010&&bbWidth<=0.024)?25:(bbWidth>=0.008&&bbWidth<=0.030)?16:bbWidth>0.030?5:8;
  return clamp(Math.round(s),0,100);
}

function r75ContC5(dir: "buy"|"sell", emaDist:number, bbPctB:number): number {
  const ae=Math.abs(emaDist);
  let s: number = ae<=0.003?88:ae<=0.008?72:ae<=0.015?52:25;
  if (dir==="buy"&&bbPctB>=0.30&&bbPctB<=0.58) s+=12;
  else if (dir==="sell"&&bbPctB>=0.42&&bbPctB<=0.70) s+=12;
  return clamp(Math.round(s),0,100);
}

function r75ContC6(dir: "buy"|"sell", distH:number, distL:number, atrRank:number): number {
  const r=dir==="buy"?Math.abs(distH):Math.abs(distL);
  let s=clamp(Math.round(r*220),0,80);
  s += atrRank>=1.3?20:atrRank>=1.0?12:4;
  return clamp(Math.round(s),0,100);
}

function scoreR75Continuation(dir: "buy"|"sell", f: { emaSlope:number;rsi14:number;priceVsEma20:number;emaDist:number;bbPctB:number;zScore:number;consecutive:number;atrRank:number;bbWidth:number;distFromRange30dHighPct:number;distFromRange30dLowPct:number }): { native:number;components:Record<string,number> } {
  const c1=r75ContC1(dir,f.emaSlope,f.rsi14,f.priceVsEma20), c2=r75ContC2(dir,f.bbPctB,f.emaDist,f.zScore);
  const c3=r75ContC3(dir,f.emaSlope,f.consecutive,f.priceVsEma20), c4=r75ContC4(f.zScore,f.atrRank,f.bbWidth);
  const c5=r75ContC5(dir,f.emaDist,f.bbPctB), c6=r75ContC6(dir,f.distFromRange30dHighPct,f.distFromRange30dLowPct,f.atrRank);
  return { native:Math.round(c1*0.25+c2*0.20+c3*0.20+c4*0.15+c5*0.10+c6*0.10), components:{trendQuality:c1,pullbackQuality:c2,slopeAlignment:c3,structureContinuity:c4,entryEfficiency:c5,expectedMoveSufficiency:c6} };
}

// ══════════════════════════════════════════════════════════════════════════════
// R_75 BREAKOUT (inlined from r75Engines.ts scoreBrkXxx functions)
// ══════════════════════════════════════════════════════════════════════════════

function r75BrkC1(dir: "buy"|"sell", distH:number, distL:number, bbPctB:number): number {
  const dist=dir==="buy"?Math.abs(distH):Math.abs(distL);
  let s: number = dist<=0.005?80:dist<=0.015?80-((dist-0.005)/0.01)*22:dist<=0.03?58-((dist-0.015)/0.015)*18:dist<=0.06?40-((dist-0.03)/0.03)*20:20;
  if (dir==="buy"&&bbPctB>=0.88) s+=20; else if (dir==="sell"&&bbPctB<=0.12) s+=20;
  else if (dir==="buy"&&bbPctB>=0.75) s+=10; else if (dir==="sell"&&bbPctB<=0.25) s+=10;
  return clamp(Math.round(s),0,100);
}

function r75BrkC2(dir: "buy"|"sell", emaSlope:number, candleBody:number, swingBreached:boolean): number {
  let s=0;
  s += swingBreached?50:0;
  if (dir==="buy") s += emaSlope>=0.0006?30:emaSlope>=0.0003?20:emaSlope>=0.0001?10:0;
  else s += emaSlope<=-0.0006?30:emaSlope<=-0.0003?20:emaSlope<=-0.0001?10:0;
  s += candleBody>=0.65?25:candleBody>=0.40?16:candleBody>=0.20?8:0;
  return clamp(Math.round(s),0,100);
}

function r75BrkC3(bbWidthRoc:number, atrAccel:number, atrRank:number): number {
  let s=0;
  s += bbWidthRoc>=0.10?50:bbWidthRoc>=0.06?38:bbWidthRoc>=0.03?24:bbWidthRoc>=0.01?12:0;
  s += atrAccel>=0.08?35:atrAccel>=0.04?24:atrAccel>=0.015?14:0;
  s += atrRank>=1.3?15:atrRank>=1.1?8:0;
  return clamp(Math.round(s),0,100);
}

function r75BrkC4(dir: "buy"|"sell", priceVsEma20:number, emaDist:number, consecutive:number): number {
  let s=0;
  if (dir==="buy") {
    s += priceVsEma20>=0.020?45:priceVsEma20>=0.010?32:priceVsEma20>=0.002?18:0;
    s += emaDist>=0.015?30:emaDist>=0.008?20:emaDist>=0.002?10:0;
    s += consecutive>=3?25:consecutive>=1?15:0;
  } else {
    s += priceVsEma20<=-0.020?45:priceVsEma20<=-0.010?32:priceVsEma20<=-0.002?18:0;
    s += emaDist<=-0.015?30:emaDist<=-0.008?20:emaDist<=-0.002?10:0;
    s += consecutive<=-3?25:consecutive<=-1?15:0;
  }
  return clamp(Math.round(s),0,100);
}

function r75BrkC5(dir: "buy"|"sell", distH:number, distL:number, emaDist:number): number {
  const dist=dir==="buy"?Math.abs(distH):Math.abs(distL);
  let s: number = dist<=0.008?88:dist<=0.020?88-((dist-0.008)/0.012)*20:dist<=0.04?68-((dist-0.020)/0.02)*26:42;
  if (dir==="buy"&&emaDist>=0.003) s+=10; else if (dir==="sell"&&emaDist<=-0.003) s+=10;
  return clamp(Math.round(s),0,100);
}

function r75BrkC6(distH:number, distL:number, atrRank:number): number {
  const rw=Math.abs(distH)+Math.abs(distL);
  let s=clamp(Math.round(rw*180),0,80);
  s += atrRank>=1.3?20:atrRank>=1.0?12:4;
  return clamp(Math.round(s),0,100);
}

function scoreR75Breakout(dir: "buy"|"sell", f: { distFromRange30dHighPct:number;distFromRange30dLowPct:number;bbPctB:number;emaSlope:number;candleBody:number;bbWidthRoc:number;atrAccel:number;atrRank:number;priceVsEma20:number;emaDist:number;consecutive:number }): { native:number;components:Record<string,number> } {
  const c1=r75BrkC1(dir,f.distFromRange30dHighPct,f.distFromRange30dLowPct,f.bbPctB);
  const c2=r75BrkC2(dir,f.emaSlope,f.candleBody,false);
  const c3=r75BrkC3(f.bbWidthRoc,f.atrAccel,f.atrRank);
  const c4=r75BrkC4(dir,f.priceVsEma20,f.emaDist,f.consecutive);
  const c5=r75BrkC5(dir,f.distFromRange30dHighPct,f.distFromRange30dLowPct,f.emaDist);
  const c6=r75BrkC6(f.distFromRange30dHighPct,f.distFromRange30dLowPct,f.atrRank);
  return { native:Math.round(c1*0.20+c2*0.25+c3*0.20+c4*0.15+c5*0.10+c6*0.10), components:{boundaryPressure:c1,breakStrength:c2,expansionQuality:c3,retestAcceptanceQuality:c4,entryEfficiency:c5,expectedMoveSufficiency:c6} };
}

// ══════════════════════════════════════════════════════════════════════════════
// R_100 REVERSAL (inlined from r100Engines.ts scoreR100RevXxx functions)
// ══════════════════════════════════════════════════════════════════════════════

function r100RevC1(distFromExtreme: number): number {
  const d=Math.abs(distFromExtreme);
  let s: number;
  if (d<=0.01) s=95;
  else if (d<=0.03) s=95-((d-0.01)/0.02)*16;
  else if (d<=0.07) s=79-((d-0.03)/0.04)*22;
  else if (d<=0.12) s=57-((d-0.07)/0.05)*22;
  else if (d<=0.18) s=35-((d-0.12)/0.06)*18;
  else s=8;
  return clamp(Math.round(s),0,100);
}

function r100RevC2(dir: "buy"|"sell", f: { lowerWickRatio:number;upperWickRatio:number;candleBody:number;latestClose:number;latestOpen:number;rsi14:number;emaSlope:number }): number {
  let s=0;
  if (dir==="buy") {
    s += f.lowerWickRatio>=0.60?30:f.lowerWickRatio>=0.40?20:f.lowerWickRatio>=0.25?10:0;
    const bull=f.latestClose>f.latestOpen;
    s += (bull&&f.candleBody>=0.55)?25:(bull&&f.candleBody>=0.30)?16:bull?8:0;
    s += f.rsi14<=20?25:f.rsi14<=28?20:f.rsi14<=35?12:f.rsi14<=42?5:0;
    s += f.emaSlope>=0.0001?20:f.emaSlope>=-0.0001?14:f.emaSlope>=-0.0003?7:0;
  } else {
    s += f.upperWickRatio>=0.60?30:f.upperWickRatio>=0.40?20:f.upperWickRatio>=0.25?10:0;
    const bear=f.latestClose<f.latestOpen;
    s += (bear&&f.candleBody>=0.55)?25:(bear&&f.candleBody>=0.30)?16:bear?8:0;
    s += f.rsi14>=80?25:f.rsi14>=72?20:f.rsi14>=65?12:f.rsi14>=60?5:0;
    s += f.emaSlope<=-0.0001?20:f.emaSlope<=0.0001?14:f.emaSlope<=0.0003?7:0;
  }
  return clamp(Math.round(s),0,100);
}

function r100RevC3(dir: "buy"|"sell", zScore:number, bbPctB:number, emaDist:number): number {
  let s=0;
  if (dir==="buy") {
    s += zScore<=-2.5?40:zScore<=-2.0?32:zScore<=-1.5?22:zScore<=-1.0?12:0;
    s += bbPctB<=0.05?35:bbPctB<=0.12?27:bbPctB<=0.22?17:bbPctB<=0.35?8:0;
    s += emaDist<=-0.018?25:emaDist<=-0.009?18:emaDist<=-0.003?10:0;
  } else {
    s += zScore>=2.5?40:zScore>=2.0?32:zScore>=1.5?22:zScore>=1.0?12:0;
    s += bbPctB>=0.95?35:bbPctB>=0.88?27:bbPctB>=0.78?17:bbPctB>=0.65?8:0;
    s += emaDist>=0.018?25:emaDist>=0.009?18:emaDist>=0.003?10:0;
  }
  return clamp(Math.round(s),0,100);
}

function r100RevC4(dir: "buy"|"sell", emaSlope:number, consecutive:number, bbWidth:number, atrRank:number): number {
  let s=0;
  if (dir==="buy") {
    s += emaSlope>=0.0001?35:emaSlope>=-0.0001?26:emaSlope>=-0.0004?16:6;
    s += (consecutive>=-2&&consecutive<=1)?30:(consecutive>=-4&&consecutive<-2)?20:consecutive<-4?8:18;
    s += bbWidth<=0.018?25:bbWidth<=0.028?18:bbWidth<=0.042?10:3;
    s += atrRank<=1.0?10:atrRank<=1.3?5:0;
  } else {
    s += emaSlope<=-0.0001?35:emaSlope<=0.0001?26:emaSlope<=0.0004?16:6;
    s += (consecutive>=-1&&consecutive<=2)?30:(consecutive>2&&consecutive<=4)?20:consecutive>4?8:18;
    s += bbWidth<=0.018?25:bbWidth<=0.028?18:bbWidth<=0.042?10:3;
    s += atrRank<=1.0?10:atrRank<=1.3?5:0;
  }
  return clamp(Math.round(s),0,100);
}

function r100RevC5(dir: "buy"|"sell", distFromExtreme:number, emaDist:number): number {
  const d=Math.abs(distFromExtreme);
  let s: number = d<=0.01?90:d<=0.03?90-((d-0.01)/0.02)*16:d<=0.07?74-((d-0.03)/0.04)*26:d<=0.12?48-((d-0.07)/0.05)*20:22;
  if (dir==="buy"&&emaDist<-0.006) s+=10;
  else if (dir==="sell"&&emaDist>0.006) s+=10;
  return clamp(Math.round(s),0,100);
}

function r100RevC6(distToOpposite:number, atrRank:number): number {
  const r=Math.abs(distToOpposite);
  let s=clamp(Math.round(r*140),0,80);
  s += atrRank>=1.4?20:atrRank>=1.1?12:atrRank>=0.8?5:0;
  return clamp(Math.round(s),0,100);
}

function scoreR100Reversal(dir: "buy"|"sell", f: { distFromRange30dHighPct:number;distFromRange30dLowPct:number;lowerWickRatio:number;upperWickRatio:number;candleBody:number;latestClose:number;latestOpen:number;rsi14:number;emaSlope:number;emaDist:number;zScore:number;bbPctB:number;bbWidth:number;atrRank:number;consecutive:number }): { native:number;components:Record<string,number> } {
  const distE=dir==="buy"?f.distFromRange30dLowPct:f.distFromRange30dHighPct;
  const distO=dir==="buy"?f.distFromRange30dHighPct:f.distFromRange30dLowPct;
  const c1=r100RevC1(distE),c2=r100RevC2(dir,f),c3=r100RevC3(dir,f.zScore,f.bbPctB,f.emaDist);
  const c4=r100RevC4(dir,f.emaSlope,f.consecutive,f.bbWidth,f.atrRank),c5=r100RevC5(dir,distE,f.emaDist),c6=r100RevC6(distO,f.atrRank);
  return { native:Math.round(c1*0.25+c2*0.22+c3*0.18+c4*0.15+c5*0.10+c6*0.10), components:{rangeExtremity:c1,reversalConfirmation:c2,stretchDeviation:c3,structureQuality:c4,entryEfficiency:c5,expectedMoveSufficiency:c6} };
}

// ══════════════════════════════════════════════════════════════════════════════
// R_100 BREAKOUT (inlined from r100Engines.ts scoreR100BrkXxx functions)
// ══════════════════════════════════════════════════════════════════════════════

function scoreR100Breakout(dir: "buy"|"sell", f: { distFromRange30dHighPct:number;distFromRange30dLowPct:number;bbPctB:number;emaSlope:number;candleBody:number;latestClose:number;latestOpen:number;consecutive:number;bbWidthRoc:number;atrAccel:number;atrRank:number;priceVsEma20:number;emaDist:number }): { native:number;components:Record<string,number> } {
  const distB=dir==="buy"?f.distFromRange30dHighPct:f.distFromRange30dLowPct;
  // C1 Break Strength (no swing breach in calibration)
  let c1=0;
  const dc=dir==="buy"?f.latestClose>f.latestOpen:f.latestClose<f.latestOpen;
  c1 += (dc&&f.candleBody>=0.65)?30:(dc&&f.candleBody>=0.45)?22:(dc&&f.candleBody>=0.25)?12:3;
  if (dir==="buy") c1+=f.emaSlope>=0.0006?20:f.emaSlope>=0.0003?14:f.emaSlope>=0.0001?8:0;
  else c1+=f.emaSlope<=-0.0006?20:f.emaSlope<=-0.0003?14:f.emaSlope<=-0.0001?8:0;
  const cm=dir==="buy"?f.consecutive:-f.consecutive;
  c1+=cm>=4?15:cm>=2?9:cm>=1?4:0;
  c1=clamp(Math.round(c1),0,100);
  // C2 Boundary Pressure
  let c2=0;
  const d2=Math.abs(distB);
  c2+=d2<=0.01?60:d2<=0.03?60-((d2-0.01)/0.02)*16:d2<=0.08?44-((d2-0.03)/0.05)*22:d2<=0.15?22-((d2-0.08)/0.07)*12:5;
  if (dir==="buy") c2+=f.bbPctB>=0.95?40:f.bbPctB>=0.85?30:f.bbPctB>=0.75?18:f.bbPctB>=0.65?8:0;
  else c2+=f.bbPctB<=0.05?40:f.bbPctB<=0.15?30:f.bbPctB<=0.25?18:f.bbPctB<=0.35?8:0;
  c2=clamp(Math.round(c2),0,100);
  // C3 Expansion
  let c3=0;
  c3+=f.bbWidthRoc>=0.15?40:f.bbWidthRoc>=0.10?30:f.bbWidthRoc>=0.05?18:f.bbWidthRoc>=0.02?8:0;
  c3+=f.atrAccel>=0.12?35:f.atrAccel>=0.08?26:f.atrAccel>=0.04?15:f.atrAccel>=0.01?6:0;
  c3+=f.atrRank>=1.5?25:f.atrRank>=1.2?18:f.atrRank>=1.0?10:3;
  c3=clamp(Math.round(c3),0,100);
  // C4 Acceptance
  let c4=0;
  if (dir==="buy") {
    c4+=f.priceVsEma20>=0.025?40:f.priceVsEma20>=0.012?30:f.priceVsEma20>=0.004?18:f.priceVsEma20>=0?8:0;
    c4+=f.consecutive>=4?35:f.consecutive>=2?24:f.consecutive>=1?12:0;
    c4+=f.bbPctB>=0.85?25:f.bbPctB>=0.70?16:f.bbPctB>=0.55?8:0;
  } else {
    c4+=f.priceVsEma20<=-0.025?40:f.priceVsEma20<=-0.012?30:f.priceVsEma20<=-0.004?18:f.priceVsEma20<=0?8:0;
    c4+=f.consecutive<=-4?35:f.consecutive<=-2?24:f.consecutive<=-1?12:0;
    c4+=f.bbPctB<=0.15?25:f.bbPctB<=0.30?16:f.bbPctB<=0.45?8:0;
  }
  c4=clamp(Math.round(c4),0,100);
  // C5 Entry Efficiency
  const d5=Math.abs(distB);
  let c5: number = d5<=0.01?90:d5<=0.03?90-((d5-0.01)/0.02)*18:d5<=0.08?72-((d5-0.03)/0.05)*24:d5<=0.15?48-((d5-0.08)/0.07)*20:20;
  if (dir==="buy"&&f.emaDist>0.004) c5+=10; else if (dir==="sell"&&f.emaDist<-0.004) c5+=10;
  c5=clamp(Math.round(c5),0,100);
  // C6 Move Sufficiency
  const rw=Math.abs(f.distFromRange30dHighPct)+Math.abs(f.distFromRange30dLowPct);
  let c6=clamp(Math.round(rw*120),0,80);
  c6+=f.atrRank>=1.4?20:f.atrRank>=1.1?12:f.atrRank>=0.8?5:0;
  c6=clamp(Math.round(c6),0,100);
  return { native:Math.round(c1*0.25+c2*0.18+c3*0.22+c4*0.15+c5*0.10+c6*0.10), components:{breakStrength:c1,boundaryPressure:c2,expansionQuality:c3,acceptanceQuality:c4,entryEfficiency:c5,expectedMoveSufficiency:c6} };
}

// ══════════════════════════════════════════════════════════════════════════════
// R_100 CONTINUATION (inlined from r100Engines.ts scoreR100ContXxx functions)
// ══════════════════════════════════════════════════════════════════════════════

function scoreR100Continuation(dir: "buy"|"sell", f: { emaSlope:number;priceVsEma20:number;rsi14:number;bbPctB:number;emaDist:number;zScore:number;consecutive:number;atrRank:number;bbWidth:number;distFromRange30dHighPct:number;distFromRange30dLowPct:number }): { native:number;components:Record<string,number> } {
  // C1 Trend Strength
  let c1=0;
  if (dir==="buy") {
    c1+=f.emaSlope>=0.0008?40:f.emaSlope>=0.0005?30:f.emaSlope>=0.0002?18:f.emaSlope>=0.0001?8:0;
    c1+=f.priceVsEma20>=0.025?35:f.priceVsEma20>=0.012?26:f.priceVsEma20>=0.004?14:f.priceVsEma20>=0?5:0;
    c1+=(f.rsi14>=55&&f.rsi14<=68)?25:(f.rsi14>=48&&f.rsi14<55)?16:(f.rsi14>68&&f.rsi14<=75)?12:0;
  } else {
    c1+=f.emaSlope<=-0.0008?40:f.emaSlope<=-0.0005?30:f.emaSlope<=-0.0002?18:f.emaSlope<=-0.0001?8:0;
    c1+=f.priceVsEma20<=-0.025?35:f.priceVsEma20<=-0.012?26:f.priceVsEma20<=-0.004?14:f.priceVsEma20<=0?5:0;
    c1+=(f.rsi14>=32&&f.rsi14<=45)?25:(f.rsi14>45&&f.rsi14<=52)?16:(f.rsi14>=25&&f.rsi14<32)?12:0;
  }
  c1=clamp(Math.round(c1),0,100);
  // C2 Pullback Quality
  let c2=0;
  if (dir==="buy") {
    c2+=(f.bbPctB>=0.35&&f.bbPctB<=0.58)?40:(f.bbPctB>=0.25&&f.bbPctB<0.35)?28:(f.bbPctB>=0.58&&f.bbPctB<=0.72)?22:(f.bbPctB>=0.15&&f.bbPctB<0.25)?12:0;
    const d=f.emaDist; c2+=(d>=-0.006&&d<=0.006)?35:(d>=-0.015&&d<-0.006)?24:(d>0.006&&d<=0.015)?18:0;
    c2+=(f.zScore>=-0.5&&f.zScore<=0.8)?25:(f.zScore>=-1.0&&f.zScore<-0.5)?16:(f.zScore>0.8&&f.zScore<=1.5)?12:0;
  } else {
    c2+=(f.bbPctB>=0.42&&f.bbPctB<=0.65)?40:(f.bbPctB>0.65&&f.bbPctB<=0.75)?28:(f.bbPctB>=0.28&&f.bbPctB<0.42)?22:(f.bbPctB>0.75&&f.bbPctB<=0.85)?12:0;
    const d=f.emaDist; c2+=(d>=-0.006&&d<=0.006)?35:(d>0.006&&d<=0.015)?24:(d>=-0.015&&d<-0.006)?18:0;
    c2+=(f.zScore>=-0.8&&f.zScore<=0.5)?25:(f.zScore>0.5&&f.zScore<=1.0)?16:(f.zScore>=-1.5&&f.zScore<-0.8)?12:0;
  }
  c2=clamp(Math.round(c2),0,100);
  // C3 Slope Alignment
  let c3=0;
  if (dir==="buy") {
    c3+=f.emaSlope>=0.0006?40:f.emaSlope>=0.0003?30:f.emaSlope>=0.0001?18:5;
    c3+=(f.consecutive>=2&&f.consecutive<=5)?35:f.consecutive>=1?22:f.consecutive===0?10:3;
    c3+=(f.emaDist>=0.004&&f.emaDist<=0.018)?25:f.emaDist>0.018?12:(f.emaDist>=0&&f.emaDist<0.004)?18:0;
  } else {
    c3+=f.emaSlope<=-0.0006?40:f.emaSlope<=-0.0003?30:f.emaSlope<=-0.0001?18:5;
    c3+=(f.consecutive<=-2&&f.consecutive>=-5)?35:f.consecutive<=-1?22:f.consecutive===0?10:3;
    c3+=(f.emaDist>=-0.018&&f.emaDist<=-0.004)?25:f.emaDist<-0.018?12:(f.emaDist>-0.004&&f.emaDist<=0)?18:0;
  }
  c3=clamp(Math.round(c3),0,100);
  // C4 Structure Continuity
  let c4=0;
  const za=Math.abs(f.zScore);
  c4+=za>=0.5&&za<=1.8?40:za>1.8&&za<=2.2?22:za<0.5?16:0;
  c4+=f.atrRank>=0.8&&f.atrRank<=1.3?35:f.atrRank>=1.3&&f.atrRank<=1.6?22:f.atrRank>=0.6&&f.atrRank<0.8?18:6;
  c4+=f.bbWidth>=0.014&&f.bbWidth<=0.030?25:f.bbWidth>0.030&&f.bbWidth<=0.045?14:f.bbWidth>=0.008&&f.bbWidth<0.014?16:4;
  c4=clamp(Math.round(c4),0,100);
  // C5 Entry Efficiency
  let c5=0;
  const ae5=Math.abs(f.emaDist);
  c5+=ae5<=0.004?60:ae5<=0.010?44:ae5<=0.020?26:8;
  if (dir==="buy") c5+=f.bbPctB>=0.35&&f.bbPctB<=0.60?40:f.bbPctB>=0.25&&f.bbPctB<0.35?26:f.bbPctB>=0.60&&f.bbPctB<=0.75?18:6;
  else c5+=f.bbPctB>=0.40&&f.bbPctB<=0.65?40:f.bbPctB>0.65&&f.bbPctB<=0.75?26:f.bbPctB>=0.25&&f.bbPctB<0.40?18:6;
  c5=clamp(Math.round(c5),0,100);
  // C6 Move Sufficiency
  const r6=dir==="buy"?Math.abs(f.distFromRange30dHighPct):Math.abs(f.distFromRange30dLowPct);
  let c6=clamp(Math.round(r6*140),0,80);
  c6+=f.atrRank>=1.4?20:f.atrRank>=1.1?12:f.atrRank>=0.8?5:0;
  c6=clamp(Math.round(c6),0,100);
  return { native:Math.round(c1*0.25+c2*0.20+c3*0.20+c4*0.15+c5*0.10+c6*0.10), components:{trendStrength:c1,pullbackQuality:c2,slopeAlignment:c3,structureContinuity:c4,entryEfficiency:c5,expectedMoveSufficiency:c6} };
}

// ── Distribution + ideal cohort computation ───────────────────────────────────

interface ScoreSample { ts:number; native:number; components:Record<string,number> }

function buildEngineSummary(
  symbol:string, engineName:string, direction: "buy"|"sell",
  samples: ScoreSample[], gate:number, htfPeriodMins:number
): EngineCalibrationSummary {
  const n = samples.length;
  if (n===0) {
    const empty={min:0,p10:0,p25:0,p50:0,p75:0,p85:0,p90:0,p92:0,p95:0,p99:0,max:0,mean:0};
    const emptyPcts = Object.fromEntries(PASS_THRESHOLDS.map(t=>[String(t),0]));
    return { symbol,engineName,direction,htfBarsScored:0,htfPeriodMins,engineGate:gate,scoreDistribution:empty,passCountsAt:emptyPcts,passRatesPct:emptyPcts,gatePassCount:0,gatePassRatePct:0,idealCohort:{thresholdUsed:gate,count:0,meanScore:0,medianScore:0,p90Score:0,examples:[]},bestSetups:[],weakestSetups:[] };
  }
  const sorted=[...samples].sort((a,b)=>a.native-b.native);
  const scores=sorted.map(s=>s.native);
  const scoreDistribution={
    min:scores[0], p10:pctile(scores,10), p25:pctile(scores,25), p50:pctile(scores,50),
    p75:pctile(scores,75), p85:pctile(scores,85), p90:pctile(scores,90),
    p92:pctile(scores,92), p95:pctile(scores,95), p99:pctile(scores,99),
    max:scores[n-1], mean:Math.round(meanArr(scores)*10)/10
  };
  const passCountsAt=Object.fromEntries(PASS_THRESHOLDS.map(t=>[String(t),samples.filter(s=>s.native>=t).length]));
  const passRatesPct=Object.fromEntries(PASS_THRESHOLDS.map(t=>[String(t),Math.round(samples.filter(s=>s.native>=t).length/n*1000)/10]));
  const gatePassCount=samples.filter(s=>s.native>=gate).length;
  const gatePassRatePct=Math.round(gatePassCount/n*1000)/10;

  // Ideal cohort: samples ≥ p80 (or at least 20 examples)
  const p80=pctile(scores,80);
  let idealThreshold=p80;
  let idealSamples=samples.filter(s=>s.native>=idealThreshold);
  if (idealSamples.length<20 && p80>0) {
    const p70=pctile(scores,70);
    idealSamples=samples.filter(s=>s.native>=p70);
    idealThreshold=p70;
  }
  const idealScores=idealSamples.map(s=>s.native).sort((a,b)=>a-b);
  const idealCohort: IdealCohortSummary = {
    thresholdUsed: idealThreshold,
    count: idealSamples.length,
    meanScore: Math.round(meanArr(idealScores)*10)/10,
    medianScore: pctile(idealScores,50),
    p90Score: pctile(idealScores,90),
    examples: [...idealSamples].sort((a,b)=>b.native-a.native).slice(0,20).map(s=>({ ts:s.ts, isoDate:new Date(s.ts*1000).toISOString(), nativeScore:s.native, components:s.components })),
  };

  const byDesc=[...samples].sort((a,b)=>b.native-a.native);
  const bestSetups=byDesc.slice(0,5).map(s=>({ ts:s.ts, isoDate:new Date(s.ts*1000).toISOString(), nativeScore:s.native, components:s.components }));
  const weakestSetups=byDesc.slice(-5).map(s=>({ ts:s.ts, isoDate:new Date(s.ts*1000).toISOString(), nativeScore:s.native, components:s.components }));

  return { symbol,engineName,direction,htfBarsScored:n,htfPeriodMins,engineGate:gate,scoreDistribution,passCountsAt,passRatesPct,gatePassCount,gatePassRatePct,idealCohort,bestSetups,weakestSetups };
}

// ── Main calibration function ─────────────────────────────────────────────────

const WARMUP = 55;
const OLD_THRESHOLDS = { paper:85, demo:90, real:92 };

const ENGINE_GATES: Record<string, Record<string, number>> = {
  BOOM300:  { sell:55, buy:50 },
  CRASH300: { buy:55, sell:50 },
  R_75:  { reversal_buy:55, reversal_sell:55, continuation_buy:58, continuation_sell:58, breakout_buy:60, breakout_sell:60 },
  R_100: { reversal_buy:58, reversal_sell:58, breakout_buy:60, breakout_sell:60, continuation_buy:62, continuation_sell:62 },
};

export async function runNativeScoreCalibration(
  updatePlatformState = false,
): Promise<CalibrationReport> {
  console.log("[Calibration] Starting full native score calibration across all 8 engine families...");

  const allEngines: EngineCalibrationSummary[] = [];
  let totalHTFBars = 0;

  for (const symbol of ["BOOM300","CRASH300","R_75","R_100"]) {
    console.log(`[Calibration] ${symbol}: loading 1m candles...`);
    const raw = await backgroundDb.select({
      openTs:candlesTable.openTs, closeTs:candlesTable.closeTs,
      open:candlesTable.open, high:candlesTable.high, low:candlesTable.low, close:candlesTable.close,
    }).from(candlesTable)
      .where(and(eq(candlesTable.symbol,symbol), eq(candlesTable.timeframe,"1m")))
      .orderBy(asc(candlesTable.openTs));

    if (raw.length<500) { console.warn(`[Calibration] ${symbol}: insufficient data (${raw.length}) — skipping`); continue; }

    const c1m: Candle1m[] = raw;
    const rHigh = rolling30dHigh(c1m);
    const rLow  = rolling30dLow(c1m);
    const htfMins = getHTFMins(symbol);
    const htf = aggregateHTF(c1m, htfMins);
    console.log(`[Calibration] ${symbol}: ${c1m.length} 1m bars → ${htf.length} HTF bars (${htfMins}m)`);

    if (htf.length < WARMUP+5) { console.warn(`[Calibration] ${symbol}: too few HTF bars — skipping`); continue; }

    let spikes: SpikeEventRow[] = [];
    if (symbol.startsWith("BOOM")||symbol.startsWith("CRASH")) {
      const sr = await db.select({ eventTs:spikeEventsTable.eventTs, ticksSincePreviousSpike:spikeEventsTable.ticksSincePreviousSpike })
        .from(spikeEventsTable).where(eq(spikeEventsTable.symbol,symbol)).orderBy(asc(spikeEventsTable.eventTs));
      spikes=sr;
      console.log(`[Calibration] ${symbol}: ${spikes.length} spike events loaded`);
    }

    // Build HTF indicator arrays
    const Hs=htf.map(c=>c.high), Ls=htf.map(c=>c.low), Cs=htf.map(c=>c.close);
    const ema20A=emaArr(Cs,20);

    // Per-engine sample collectors
    const boomSellS:ScoreSample[]=[], boomBuyS:ScoreSample[]=[];
    const crashBuyS:ScoreSample[]=[], crashSellS:ScoreSample[]=[];
    const r75RevBS:ScoreSample[]=[], r75RevSS:ScoreSample[]=[];
    const r75ContBS:ScoreSample[]=[], r75ContSS:ScoreSample[]=[];
    const r75BrkBS:ScoreSample[]=[], r75BrkSS:ScoreSample[]=[];
    const r100RevBS:ScoreSample[]=[], r100RevSS:ScoreSample[]=[];
    const r100BrkBS:ScoreSample[]=[], r100BrkSS:ScoreSample[]=[];
    const r100ContBS:ScoreSample[]=[], r100ContSS:ScoreSample[]=[];

    for (let i=WARMUP; i<htf.length; i++) {
      const c=htf[i], price=c.close;
      if (price<=0) continue;

      const ema20=ema20A[i], ema20p=ema20A[i-1]||ema20;
      const emaSlope=ema20>0?(ema20-ema20p)/ema20:0;
      const emaDist=ema20>0?(price-ema20)/ema20:0;
      const priceVsEma20=emaDist;
      const rsi14=rsiAt(Cs,i,14);

      const atr14abs=atrAt(Hs,Ls,Cs,i,14), atr50abs=atrAt(Hs,Ls,Cs,i,50);
      const atr14=price>0?atr14abs/price:0, atr50=price>0?atr50abs/price:0;
      const atrRank=atr50>0?Math.min(atr14/atr50,2):1;

      const bbS=Cs.slice(Math.max(0,i-19),i+1);
      const bbM=meanArr(bbS), bbSD=stdArr(bbS);
      const bbWidth=bbSD>0?(4*bbSD)/bbM:0;
      const bbPctB=bbSD>0?(price-(bbM-2*bbSD))/(4*bbSD):0.5;
      const zScore=bbSD>0?(price-bbM)/bbSD:0;

      const bbWp=i<25?bbWidth:(()=>{ const sl=Cs.slice(Math.max(0,i-24),i-4); const mp=meanArr(sl),sp=stdArr(sl); return sp>0?(4*sp)/mp:bbWidth; })();
      const bbWidthRoc=bbWp>0?(bbWidth-bbWp)/bbWp:0;
      const atr14p=i>=5?atrAt(Hs,Ls,Cs,i-5,14)/Math.max(Cs[i-5],1):atr14;
      const atrAccel=atr14p>0?(atr14/atr14p)-1:0;

      const range=c.high-c.low, body=Math.abs(c.close-c.open);
      const candleBody=range>0?body/range:0;
      const upperWickRatio=range>0?(c.high-Math.max(c.open,c.close))/Math.max(body,1e-9):0;
      const lowerWickRatio=range>0?(Math.min(c.open,c.close)-c.low)/Math.max(body,1e-9):0;

      let consecutive=0;
      for (let j=i; j>=Math.max(0,i-20); j--) {
        const up=htf[j].close>htf[j].open;
        if (j===i) { consecutive=up?1:-1; }
        else if ((up&&consecutive>0)||(!up&&consecutive<0)) { consecutive+=up?1:-1; }
        else break;
      }

      const idx1m=bsIdx(c1m,c.openTs);
      const high30d=rHigh[idx1m], low30d=rLow[idx1m];
      const distFromRange30dHighPct=high30d>0?(price-high30d)/high30d:0;
      const distFromRange30dLowPct=low30d>0?(price-low30d)/low30d:0;

      const { spikeHazardScore, runLengthSinceSpike }=spikeFeats(c.openTs,spikes);

      const ts=c.openTs;
      const bf={ spikeHazardScore,runLengthSinceSpike,distFromRange30dHighPct,distFromRange30dLowPct,bbPctB,rsi14,emaSlope,emaDist,priceVsEma20,candleBody,latestClose:c.close,latestOpen:c.open,bbWidthRoc,atrAccel,atrRank,bbWidth,zScore,consecutive,lowerWickRatio,upperWickRatio };

      if (symbol==="BOOM300") {
        const s1=scoreBoom300Sell(bf); boomSellS.push({ts,native:s1.native,components:s1.components});
        const b1=scoreBoom300Buy(bf);  boomBuyS.push({ts,native:b1.native,components:b1.components});
      } else if (symbol==="CRASH300") {
        const b1=scoreCrash300Buy(bf);  crashBuyS.push({ts,native:b1.native,components:b1.components});
        const s1=scoreCrash300Sell(bf); crashSellS.push({ts,native:s1.native,components:s1.components});
      } else {
        // R_75 or R_100 — reversal both dirs
        if (symbol==="R_75") {
          const rb=scoreR75Reversal("buy",bf);  r75RevBS.push({ts,native:rb.native,components:rb.components});
          const rs=scoreR75Reversal("sell",bf); r75RevSS.push({ts,native:rs.native,components:rs.components});
          const cb=scoreR75Continuation("buy",bf);  r75ContBS.push({ts,native:cb.native,components:cb.components});
          const cs=scoreR75Continuation("sell",bf); r75ContSS.push({ts,native:cs.native,components:cs.components});
          const bkb=scoreR75Breakout("buy",bf);  r75BrkBS.push({ts,native:bkb.native,components:bkb.components});
          const bks=scoreR75Breakout("sell",bf); r75BrkSS.push({ts,native:bks.native,components:bks.components});
        } else {
          const rb=scoreR100Reversal("buy",bf);  r100RevBS.push({ts,native:rb.native,components:rb.components});
          const rs=scoreR100Reversal("sell",bf); r100RevSS.push({ts,native:rs.native,components:rs.components});
          const bkb=scoreR100Breakout("buy",bf);  r100BrkBS.push({ts,native:bkb.native,components:bkb.components});
          const bks=scoreR100Breakout("sell",bf); r100BrkSS.push({ts,native:bks.native,components:bks.components});
          const conb=scoreR100Continuation("buy",bf);  r100ContBS.push({ts,native:conb.native,components:conb.components});
          const cons=scoreR100Continuation("sell",bf); r100ContSS.push({ts,native:cons.native,components:cons.components});
        }
      }
    }

    const htfBars = htf.length-WARMUP;
    totalHTFBars += htfBars;

    if (symbol==="BOOM300") {
      allEngines.push(buildEngineSummary("BOOM300","boom_expansion_engine","sell",boomSellS,ENGINE_GATES.BOOM300.sell,htfMins));
      allEngines.push(buildEngineSummary("BOOM300","boom_expansion_engine","buy", boomBuyS, ENGINE_GATES.BOOM300.buy, htfMins));
    } else if (symbol==="CRASH300") {
      allEngines.push(buildEngineSummary("CRASH300","crash_expansion_engine","buy",  crashBuyS, ENGINE_GATES.CRASH300.buy, htfMins));
      allEngines.push(buildEngineSummary("CRASH300","crash_expansion_engine","sell", crashSellS,ENGINE_GATES.CRASH300.sell,htfMins));
    } else if (symbol==="R_75") {
      allEngines.push(buildEngineSummary("R_75","r75_reversal_engine","buy", r75RevBS, ENGINE_GATES.R_75.reversal_buy, htfMins));
      allEngines.push(buildEngineSummary("R_75","r75_reversal_engine","sell",r75RevSS, ENGINE_GATES.R_75.reversal_sell,htfMins));
      allEngines.push(buildEngineSummary("R_75","r75_continuation_engine","buy", r75ContBS,ENGINE_GATES.R_75.continuation_buy, htfMins));
      allEngines.push(buildEngineSummary("R_75","r75_continuation_engine","sell",r75ContSS,ENGINE_GATES.R_75.continuation_sell,htfMins));
      allEngines.push(buildEngineSummary("R_75","r75_breakout_engine","buy", r75BrkBS,ENGINE_GATES.R_75.breakout_buy, htfMins));
      allEngines.push(buildEngineSummary("R_75","r75_breakout_engine","sell",r75BrkSS,ENGINE_GATES.R_75.breakout_sell,htfMins));
    } else {
      allEngines.push(buildEngineSummary("R_100","r100_reversal_engine","buy", r100RevBS, ENGINE_GATES.R_100.reversal_buy, htfMins));
      allEngines.push(buildEngineSummary("R_100","r100_reversal_engine","sell",r100RevSS, ENGINE_GATES.R_100.reversal_sell,htfMins));
      allEngines.push(buildEngineSummary("R_100","r100_breakout_engine","buy", r100BrkBS, ENGINE_GATES.R_100.breakout_buy, htfMins));
      allEngines.push(buildEngineSummary("R_100","r100_breakout_engine","sell",r100BrkSS, ENGINE_GATES.R_100.breakout_sell,htfMins));
      allEngines.push(buildEngineSummary("R_100","r100_continuation_engine","buy", r100ContBS,ENGINE_GATES.R_100.continuation_buy, htfMins));
      allEngines.push(buildEngineSummary("R_100","r100_continuation_engine","sell",r100ContSS,ENGINE_GATES.R_100.continuation_sell,htfMins));
    }

    console.log(`[Calibration] ${symbol}: complete`);
  }

  // ── Threshold recommendations ─────────────────────────────────────────────
  // Use primary engine distributions to set evidence-based thresholds.
  // Primary: BOOM300 sell, CRASH300 buy, R_75 reversal both dirs, R_100 reversal both dirs.
  const primaryEngines = allEngines.filter(e =>
    (e.symbol==="BOOM300"  && e.direction==="sell") ||
    (e.symbol==="CRASH300" && e.direction==="buy")  ||
    (e.symbol==="R_75"  && e.engineName==="r75_reversal_engine")  ||
    (e.symbol==="R_100" && e.engineName==="r100_reversal_engine")
  );

  const p90vals = primaryEngines.map(e=>e.scoreDistribution.p90).filter(v=>v>0);
  const p92vals = primaryEngines.map(e=>e.scoreDistribution.p92).filter(v=>v>0);
  const p95vals = primaryEngines.map(e=>e.scoreDistribution.p95).filter(v=>v>0);

  const medOf = (arr: number[]) => { if (!arr.length) return 0; const s=[...arr].sort((a,b)=>a-b); return s[Math.floor(s.length/2)]; };
  const recPaper = medOf(p90vals);
  const recDemo  = Math.max(recPaper+2, medOf(p92vals));
  const recReal  = Math.max(recDemo+2, medOf(p95vals));

  const passAtCurrent = primaryEngines.map(e=>`${e.symbol}(${e.direction})@85=${e.passRatesPct["85"]}%`).join(", ");

  const recommendations: ThresholdRecommendations = {
    paper: recPaper, demo: recDemo, real: recReal,
    rationale: `Data-driven: ${totalHTFBars} HTF bars across 4 symbols. Primary engine p90/p92/p95 medians: ${recPaper}/${recDemo}/${recReal}. ` +
      `Current pass rates at 85: [${passAtCurrent}]. ` +
      `Recommended thresholds derived from actual score distributions without enforcing minimum floors. ` +
      `If these are below the mandatory minimums (85/90/92), the engines need component recalibration — not threshold lowering.`,
    mandatoryMinimums: { paper:85, demo:90, real:92 },
  };

  let platformStateUpdateApplied = false;
  if (updatePlatformState) {
    const upsert = async (key:string, value:string) => {
      await db.insert(platformStateTable).values({key,value}).onConflictDoUpdate({target:platformStateTable.key,set:{value,updatedAt:new Date()}});
    };
    await upsert("calibration_last_run", new Date().toISOString());
    await upsert("calibration_paper_evidence_threshold", String(recPaper));
    await upsert("calibration_demo_evidence_threshold",  String(recDemo));
    await upsert("calibration_real_evidence_threshold",  String(recReal));
    platformStateUpdateApplied = true;
    console.log(`[Calibration] Platform state updated with evidence thresholds: paper=${recPaper}, demo=${recDemo}, real=${recReal}`);
  }

  const report: CalibrationReport = {
    reportGeneratedAt: new Date().toISOString(),
    enginesAnalyzed: 8,
    totalHTFBarsAnalyzed: totalHTFBars,
    oldThresholds: OLD_THRESHOLDS,
    newThresholds: { paper:recPaper, demo:recDemo, real:recReal },
    perEngineDistributions: allEngines,
    recommendations,
    platformStateUpdateApplied,
  };

  // Persist JSON report
  try {
    await writeFile(REPORT_PATH, JSON.stringify(report, null, 2), "utf-8");
    console.log(`[Calibration] Report written to ${REPORT_PATH}`);
  } catch (err) {
    console.warn("[Calibration] Failed to write report JSON:", err instanceof Error ? err.message : err);
  }

  console.log(`[Calibration] Complete — ${allEngines.length} engine×direction entries, ${totalHTFBars} HTF bars`);
  return report;
}

export { REPORT_PATH };
