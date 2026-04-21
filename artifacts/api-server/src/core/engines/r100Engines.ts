/**
 * R_100 Engines  Native Scoring, Gating & Decision Explanation
 *
 * R_100 is a volatility-family instrument (not spike-based).
 * - About 2 swings/month  less frequent, bigger-moving than R_75
 * - Major swings from ~18% to 92%, hold profile ~327 days
 * - Primary trade logic: entry at 30-day range extreme + directional reversal confirmation
 * - Hierarchy: Reversal (primary)  Breakout (secondary)  Continuation (tertiary)
 * - Long-hold swing only  no scalp, no time-based forced exits
 *
 *  Scoring architecture 
 * Each engine has 6 native components scored 0100.
 * confidence = nativeScore / 100  (direct 1:1 mapping  no boolean-count blending)
 *
 *  Engine gates (primary) 
 * R100_REVERSAL_MIN_GATE     = 58  (primary setup  lowest gate)
 * R100_BREAKOUT_MIN_GATE     = 60  (secondary  stricter than reversal)
 * R100_CONTINUATION_MIN_GATE = 62  (tertiary  strictest; R_100 must not chase)
 *
 *  Calibration 
 * Based on 296,376 cleaned R_100 candles (0 duplicates, 0 missing intervals,
 * 20 interpolated candles explicitly excluded from signal generation).
 */

import type { EngineContext, EngineResult } from "../engineTypes.js";

const SYMBOL = "R_100";

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function asFinite(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function getR100EngineOverride(ctx: EngineContext, engineName: string): Record<string, unknown> {
  const root = asRecord(ctx.runtimeCalibration?.formulaOverride);
  const engines = asRecord(root.engines);
  return asRecord(engines[engineName] ?? root[engineName]);
}

function resolveR100RuntimeGate(
  ctx: EngineContext,
  engineName: string,
  baseGate: number,
): { gate: number; calibrated: boolean; sourceRunId: number | null } {
  const paperGate = asFinite(ctx.runtimeCalibration?.recommendedScoreGates?.paper);
  const engineOverride = getR100EngineOverride(ctx, engineName);
  const overrideGate = asFinite(
    engineOverride.minGate ?? engineOverride.gate ?? engineOverride.threshold,
  );
  if (paperGate === null) {
    return {
      gate: clamp(Math.round(overrideGate ?? baseGate), 40, 95),
      calibrated: false,
      sourceRunId: null,
    };
  }

  const blendedGate = clamp(Math.round(baseGate * 0.7 + paperGate * 0.3), 45, 90);
  return {
    gate: clamp(Math.round(overrideGate ?? blendedGate), 40, 95),
    calibrated: true,
    sourceRunId: ctx.runtimeCalibration?.sourceRunId ?? null,
  };
}

//  Projected move calibration (R_100 empirical swing data) 
const R100_REVERSAL_PROJECTED_PCT     = 0.35;   // avg major swing ~35% from 30d extreme
const R100_BREAKOUT_PROJECTED_PCT     = 0.42;   // breakout can extend well beyond range
const R100_CONTINUATION_PROJECTED_PCT = 0.22;   // continuation captures mid-leg only

//  Engine-native gates (primary) 
// These are the PRIMARY pass thresholds for each R_100 engine.
// The allocator's mode-level confidence check (paper0.60/demo0.65/real0.70)
// remains as the SECONDARY gate applied after engine acceptance.
const R100_REVERSAL_MIN_GATE     = 58;
const R100_BREAKOUT_MIN_GATE     = 60;
const R100_CONTINUATION_MIN_GATE = 62;

//  Component weights 
// Reversal: range extremity + reversal confirmation dominate
const W_REV_RANGE_EXTREMITY  = 0.25;
const W_REV_REVERSAL_CONFIRM = 0.22;
const W_REV_STRETCH          = 0.18;
const W_REV_STRUCTURE        = 0.15;
const W_REV_ENTRY_EFF        = 0.10;
const W_REV_MOVE_SUFF        = 0.10;

// Breakout: break strength + expansion quality dominate
const W_BRK_BREAK_STRENGTH   = 0.25;
const W_BRK_BOUNDARY         = 0.18;
const W_BRK_EXPANSION        = 0.22;
const W_BRK_ACCEPTANCE       = 0.15;
const W_BRK_ENTRY_EFF        = 0.10;
const W_BRK_MOVE_SUFF        = 0.10;

// Continuation: trend strength drives the thesis
const W_CONT_TREND_STRENGTH  = 0.25;
const W_CONT_PULLBACK        = 0.20;
const W_CONT_SLOPE_ALIGN     = 0.20;
const W_CONT_STRUCT_CONT     = 0.15;
const W_CONT_ENTRY_EFF       = 0.10;
const W_CONT_MOVE_SUFF       = 0.10;

//  Expected hold profiles 
const R100_REVERSAL_HOLD     = "527 days | trailing activation at 18% move | max 35d";
const R100_BREAKOUT_HOLD     = "422 days | trailing activation at 15% move | max 28d";
const R100_CONTINUATION_HOLD = "314 days | trailing activation at 12% move | max 20d";

//  TP / SL logic summaries 
const R100_REVERSAL_TP    = "Primary TP: 35% swing target from 30d extreme. Stage 1: 12%, Stage 2: 22%, Stage 3: 35%. Trail from 18%.";
const R100_REVERSAL_SL    = "SL below 30d range low (BUY) or above 30d range high (SELL) + 0.5% buffer. Tightens to breakeven after 12% move.";
const R100_REVERSAL_TRAIL = "Trailing stop activates at 18% unrealised gain. Initial trail 10%, tightens to 6% above 25%.";

const R100_BRK_TP    = "Primary TP: breakout target 42% beyond prior range boundary. Stage 1: 12%, Stage 2: 22%, Stage 3: 42%. Trail from 15%.";
const R100_BRK_SL    = "SL just inside prior range boundary + 0.4% buffer. Tightens after 10% move.";
const R100_BRK_TRAIL = "Trailing stop activates at 15% unrealised gain. Initial trail 9%, tightens to 5% above 22%.";

const R100_CONT_TP    = "Primary TP: continuation to next 30d extreme. Stage 1: 8%, Stage 2: 15%, Stage 3: 22%. Trail from 12%.";
const R100_CONT_SL    = "SL at most recent swing low (BUY) or swing high (SELL) + 0.4% buffer. Tightens after 8% move.";
const R100_CONT_TRAIL = "Trailing stop activates at 12% unrealised gain. Initial trail 8%, tightens to 5% above 18%.";

// 
// REVERSAL ENGINE  PRIMARY R_100 SETUP FAMILY
// Component key names: rangeExtremity, reversalConfirmation, stretchDeviation,
//   structureQuality, entryEfficiency, expectedMoveSufficiency
// "stretchDeviation" (not "stretchDeviationQuality") distinguishes from R_75
// 

//  REV Component 1: Range Extremity (0100) 
// R_100 has bigger range widths (60-120% wide), so "near extreme" thresholds
// are wider than R_75.
// BUY: price near 30d low (distFromRange30dLowPct near 0)
// SELL: price near 30d high (|distFromRange30dHighPct| near 0)
function scoreR100RevRangeExtremity(distFromExtreme: number): { score: number; flags: string[] } {
  const flags: string[] = [];
  const dist = Math.abs(distFromExtreme);
  let score: number;
  if (dist <= 0.01) {
    score = 95;
    flags.push("at_30d_extreme(1%)");
  } else if (dist <= 0.03) {
    score = 95 - ((dist - 0.01) / 0.02) * 16;
    flags.push("very_near_30d_extreme(3%)");
  } else if (dist <= 0.07) {
    score = 79 - ((dist - 0.03) / 0.04) * 22;
    flags.push("near_30d_extreme(7%)");
  } else if (dist <= 0.12) {
    score = 57 - ((dist - 0.07) / 0.05) * 22;
    flags.push("moderate_from_extreme(12%)");
  } else if (dist <= 0.18) {
    score = 35 - ((dist - 0.12) / 0.06) * 18;
    flags.push("far_from_extreme(18%)");
  } else {
    score = 8;
    flags.push("mid_range(>18%)");
  }
  return { score: clamp(Math.round(score), 0, 100), flags };
}

//  REV Component 2: Reversal Confirmation (0100) 
// Directional reversal evidence at the extreme.
// BUY: lower wick rejection, bullish candle, RSI oversold, EMA slope recovering
// SELL: upper wick rejection, bearish candle, RSI overbought, EMA slope fading
function scoreR100RevReversalConfirmation(
  direction: "buy" | "sell",
  f: {
    lowerWickRatio: number; upperWickRatio: number;
    candleBody: number; latestClose: number; latestOpen: number;
    rsi14: number; emaSlope: number;
  }
): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;

  if (direction === "buy") {
    // Lower wick (rejection of low)  max 30
    if (f.lowerWickRatio >= 0.60) { score += 30; flags.push("strong_lower_wick"); }
    else if (f.lowerWickRatio >= 0.40) { score += 20; flags.push("moderate_lower_wick"); }
    else if (f.lowerWickRatio >= 0.25) { score += 10; flags.push("weak_lower_wick"); }
    else flags.push("no_lower_wick");

    // Bullish candle body  max 25
    const bullish = f.latestClose > f.latestOpen;
    if (bullish && f.candleBody >= 0.55) { score += 25; flags.push("strong_bullish_candle"); }
    else if (bullish && f.candleBody >= 0.30) { score += 16; flags.push("moderate_bullish_candle"); }
    else if (bullish) { score += 8; flags.push("weak_bullish_candle"); }
    else flags.push("bearish_candle");

    // RSI oversold zone  max 25
    if (f.rsi14 <= 20) { score += 25; flags.push("deeply_oversold(rsi20)"); }
    else if (f.rsi14 <= 28) { score += 20; flags.push("oversold(rsi28)"); }
    else if (f.rsi14 <= 35) { score += 12; flags.push("mildly_oversold(rsi35)"); }
    else if (f.rsi14 <= 42) { score += 5;  flags.push("near_oversold(rsi42)"); }
    else flags.push("rsi_not_oversold");

    // EMA slope recovering  max 20
    if (f.emaSlope >= 0.0001)        { score += 20; flags.push("ema_turning_up"); }
    else if (f.emaSlope >= -0.0001)  { score += 14; flags.push("ema_flattening"); }
    else if (f.emaSlope >= -0.0003)  { score += 7;  flags.push("ema_decelerating"); }
    else flags.push("ema_still_declining");

  } else {
    // Upper wick (rejection of high)  max 30
    if (f.upperWickRatio >= 0.60) { score += 30; flags.push("strong_upper_wick"); }
    else if (f.upperWickRatio >= 0.40) { score += 20; flags.push("moderate_upper_wick"); }
    else if (f.upperWickRatio >= 0.25) { score += 10; flags.push("weak_upper_wick"); }
    else flags.push("no_upper_wick");

    // Bearish candle body  max 25
    const bearish = f.latestClose < f.latestOpen;
    if (bearish && f.candleBody >= 0.55) { score += 25; flags.push("strong_bearish_candle"); }
    else if (bearish && f.candleBody >= 0.30) { score += 16; flags.push("moderate_bearish_candle"); }
    else if (bearish) { score += 8; flags.push("weak_bearish_candle"); }
    else flags.push("bullish_candle");

    // RSI overbought zone  max 25
    if (f.rsi14 >= 80) { score += 25; flags.push("deeply_overbought(rsi80)"); }
    else if (f.rsi14 >= 72) { score += 20; flags.push("overbought(rsi72)"); }
    else if (f.rsi14 >= 65) { score += 12; flags.push("mildly_overbought(rsi65)"); }
    else if (f.rsi14 >= 60) { score += 5;  flags.push("near_overbought(rsi60)"); }
    else flags.push("rsi_not_overbought");

    // EMA slope fading  max 20
    if (f.emaSlope <= -0.0001)       { score += 20; flags.push("ema_turning_down"); }
    else if (f.emaSlope <= 0.0001)   { score += 14; flags.push("ema_flattening"); }
    else if (f.emaSlope <= 0.0003)   { score += 7;  flags.push("ema_decelerating"); }
    else flags.push("ema_still_rising");
  }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

//  REV Component 3: Stretch / Deviation (0100) 
// Key name: "stretchDeviation" (unique  R_75 uses "stretchDeviationQuality")
// BUY: zScore deeply negative, bbPctB low, emaDist negative
// SELL: zScore deeply positive, bbPctB high, emaDist positive
function scoreR100RevStretchDeviation(
  direction: "buy" | "sell",
  f: { zScore: number; bbPctB: number; emaDist: number }
): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;

  if (direction === "buy") {
    // zScore stretch  max 40
    if (f.zScore <= -2.5)       { score += 40; flags.push("extreme_negative_zscore(-2.5)"); }
    else if (f.zScore <= -2.0)  { score += 32; flags.push("deep_negative_zscore(-2.0)"); }
    else if (f.zScore <= -1.5)  { score += 22; flags.push("negative_zscore(-1.5)"); }
    else if (f.zScore <= -1.0)  { score += 12; flags.push("mild_negative_zscore(-1.0)"); }
    else flags.push("zscore_not_stretched");

    // BB lower pressure  max 35
    if (f.bbPctB <= 0.05)       { score += 35; flags.push("extreme_bb_lower(5%)"); }
    else if (f.bbPctB <= 0.12)  { score += 27; flags.push("deep_bb_lower(12%)"); }
    else if (f.bbPctB <= 0.22)  { score += 17; flags.push("bb_lower_zone(22%)"); }
    else if (f.bbPctB <= 0.35)  { score += 8;  flags.push("moderate_bb(35%)"); }
    else flags.push("bb_not_stretched");

    // EMA distance negative  max 25
    if (f.emaDist <= -0.018)    { score += 25; flags.push("deeply_below_ema"); }
    else if (f.emaDist <= -0.009) { score += 18; flags.push("below_ema"); }
    else if (f.emaDist <= -0.003) { score += 10; flags.push("mildly_below_ema"); }
    else flags.push("near_or_above_ema");

  } else {
    // zScore stretch  max 40
    if (f.zScore >= 2.5)        { score += 40; flags.push("extreme_positive_zscore(2.5)"); }
    else if (f.zScore >= 2.0)   { score += 32; flags.push("deep_positive_zscore(2.0)"); }
    else if (f.zScore >= 1.5)   { score += 22; flags.push("positive_zscore(1.5)"); }
    else if (f.zScore >= 1.0)   { score += 12; flags.push("mild_positive_zscore(1.0)"); }
    else flags.push("zscore_not_stretched");

    // BB upper pressure  max 35
    if (f.bbPctB >= 0.95)       { score += 35; flags.push("extreme_bb_upper(95%)"); }
    else if (f.bbPctB >= 0.88)  { score += 27; flags.push("deep_bb_upper(88%)"); }
    else if (f.bbPctB >= 0.78)  { score += 17; flags.push("bb_upper_zone(78%)"); }
    else if (f.bbPctB >= 0.65)  { score += 8;  flags.push("moderate_bb(65%)"); }
    else flags.push("bb_not_stretched");

    // EMA distance positive  max 25
    if (f.emaDist >= 0.018)     { score += 25; flags.push("deeply_above_ema"); }
    else if (f.emaDist >= 0.009){ score += 18; flags.push("above_ema"); }
    else if (f.emaDist >= 0.003){ score += 10; flags.push("mildly_above_ema"); }
    else flags.push("near_or_below_ema");
  }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

//  REV Component 4: Structure Quality (0100) 
// Whether the reversal is at a meaningful structural level, not mid-range noise.
function scoreR100RevStructureQuality(
  direction: "buy" | "sell",
  f: { emaSlope: number; consecutive: number; bbWidth: number; atrRank: number }
): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;

  if (direction === "buy") {
    // EMA slope at or near reversal  max 35
    if (f.emaSlope >= 0.0001)       { score += 35; flags.push("ema_already_turning_up"); }
    else if (f.emaSlope >= -0.0001) { score += 26; flags.push("ema_neutral"); }
    else if (f.emaSlope >= -0.0004) { score += 16; flags.push("ema_decelerating_down"); }
    else { score += 6; flags.push("ema_declining"); }

    // Consecutive (BUY: in downswing but slowing)  max 30
    if (f.consecutive >= -2 && f.consecutive <= 1) { score += 30; flags.push("reversal_zone_candles"); }
    else if (f.consecutive >= -4 && f.consecutive < -2) { score += 20; flags.push("late_downswing"); }
    else if (f.consecutive < -4) { score += 8; flags.push("extended_downswing"); }
    else { score += 18; flags.push("already_recovering"); }

    // BB width: tight = clean structure  max 25
    if (f.bbWidth <= 0.018)      { score += 25; flags.push("tight_bb_structure"); }
    else if (f.bbWidth <= 0.028) { score += 18; flags.push("moderate_bb_structure"); }
    else if (f.bbWidth <= 0.042) { score += 10; flags.push("wider_bb"); }
    else { score += 3; flags.push("wide_disorderly_bb"); }

    // ATR stability  max 10
    if (f.atrRank <= 1.0)        { score += 10; flags.push("stable_volatility"); }
    else if (f.atrRank <= 1.3)   { score += 5;  flags.push("moderate_volatility"); }

  } else {
    // EMA slope  max 35
    if (f.emaSlope <= -0.0001)      { score += 35; flags.push("ema_already_turning_down"); }
    else if (f.emaSlope <= 0.0001)  { score += 26; flags.push("ema_neutral"); }
    else if (f.emaSlope <= 0.0004)  { score += 16; flags.push("ema_decelerating_up"); }
    else { score += 6; flags.push("ema_rising"); }

    // Consecutive (SELL: in upswing but slowing)  max 30
    if (f.consecutive >= -1 && f.consecutive <= 2) { score += 30; flags.push("reversal_zone_candles"); }
    else if (f.consecutive > 2 && f.consecutive <= 4) { score += 20; flags.push("late_upswing"); }
    else if (f.consecutive > 4) { score += 8; flags.push("extended_upswing"); }
    else { score += 18; flags.push("already_declining"); }

    // BB width  max 25
    if (f.bbWidth <= 0.018)      { score += 25; flags.push("tight_bb_structure"); }
    else if (f.bbWidth <= 0.028) { score += 18; flags.push("moderate_bb_structure"); }
    else if (f.bbWidth <= 0.042) { score += 10; flags.push("wider_bb"); }
    else { score += 3; flags.push("wide_disorderly_bb"); }

    // ATR stability  max 10
    if (f.atrRank <= 1.0)        { score += 10; flags.push("stable_volatility"); }
    else if (f.atrRank <= 1.3)   { score += 5;  flags.push("moderate_volatility"); }
  }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

//  REV Component 5: Entry Efficiency (0100) 
// How clean and early the entry is relative to the reversal point.
function scoreR100RevEntryEfficiency(
  direction: "buy" | "sell",
  distFromExtreme: number,
  emaDist: number
): { score: number; flags: string[] } {
  const flags: string[] = [];
  const dist = Math.abs(distFromExtreme);

  // Proximity to extreme  max 90
  let score: number;
  if (dist <= 0.01)       { score = 90; flags.push("at_extreme(1%)"); }
  else if (dist <= 0.03)  { score = 90 - ((dist - 0.01) / 0.02) * 16; flags.push("very_near_extreme(3%)"); }
  else if (dist <= 0.07)  { score = 74 - ((dist - 0.03) / 0.04) * 26; flags.push("near_extreme(7%)"); }
  else if (dist <= 0.12)  { score = 48 - ((dist - 0.07) / 0.05) * 20; flags.push("moderate_distance(12%)"); }
  else                    { score = 22; flags.push("late_entry(>12%)"); }

  // EMA alignment bonus  max 10
  if (direction === "buy" && emaDist < -0.006)  { score += 10; flags.push("below_ema_bonus"); }
  else if (direction === "sell" && emaDist > 0.006) { score += 10; flags.push("above_ema_bonus"); }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

//  REV Component 6: Expected Move Sufficiency (0100) 
// Whether enough runway exists to justify a long-hold R_100 trade.
// R_100 has larger range widths  calibrate multiplier accordingly.
// BUY: runway = |distFromRange30dHighPct|  (how far to 30d high)
// SELL: runway = |distFromRange30dLowPct|
function scoreR100RevMoveSufficiency(
  distToOpposite: number,
  atrRank: number
): { score: number; flags: string[] } {
  const flags: string[] = [];
  const runway = Math.abs(distToOpposite);

  // Runway score  max 80 (R_100 range widths ~60-120%,  140 calibration)
  let score = clamp(Math.round(runway * 140), 0, 80);
  if (runway >= 0.25)      flags.push("large_runway(25%)");
  else if (runway >= 0.15) flags.push("good_runway(15%)");
  else if (runway >= 0.08) flags.push("moderate_runway(8%)");
  else flags.push("limited_runway(<8%)");

  // ATR expansion bonus  max 20
  if (atrRank >= 1.4)     { score += 20; flags.push("atr_elevated"); }
  else if (atrRank >= 1.1){ score += 12; flags.push("atr_moderate"); }
  else if (atrRank >= 0.8){ score += 5;  flags.push("atr_normal"); }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

//  Reversal Rejection Reason Builder 
function buildR100ReversalRejectionReason(
  cs: Record<string, number>,
  nativeScore: number,
  gateThreshold: number,
  modeMin: number
): string {
  const breakdown = `extreme=${cs.rangeExtremity},reversal=${cs.reversalConfirmation},stretch=${cs.stretchDeviation},structure=${cs.structureQuality},entry=${cs.entryEfficiency},move=${cs.expectedMoveSufficiency}`;
  const weak = Object.entries(cs)
    .filter(([, v]) => v < 55)
    .map(([k, v]) => {
      const label: Record<string, string> = {
        rangeExtremity:         "insufficient_range_extremity",
        reversalConfirmation:   "insufficient_reversal_confirmation",
        stretchDeviation:       "insufficient_stretch_deviation",
        structureQuality:       "weak_structure_quality",
        entryEfficiency:        "poor_entry_efficiency",
        expectedMoveSufficiency:"insufficient_expected_move",
      };
      return `${label[k] ?? k}(${v}/100)`;
    });
  return (
    `r100_reversal_score_below_mode_threshold:native=${nativeScore}/100,engine_gate=${gateThreshold},mode_min=${modeMin}` +
    ` | breakdown:[${breakdown}]` +
    (weak.length > 0 ? ` | weak=[${weak.join("; ")}]` : "")
  );
}

// 
// r100ReversalEngine  PRIMARY R_100 SETUP
// 

export function r100ReversalEngine(ctx: EngineContext): EngineResult | null {
  const { features: f, operationalRegime, regimeConfidence } = ctx;
  if (f.symbol !== SYMBOL) return null;
  const runtimeGate = resolveR100RuntimeGate(ctx, "r100_reversal_engine", R100_REVERSAL_MIN_GATE);

  //  Candidate direction from 30d range extremity 
  // R_100 has bigger ranges  allow up to 18% from extreme as candidate
  const buyExtremity  = Math.abs(f.distFromRange30dLowPct);
  const sellExtremity = Math.abs(f.distFromRange30dHighPct);

  const buyCandidate  = buyExtremity <= 0.18;
  const sellCandidate = sellExtremity <= 0.18;
  if (!buyCandidate && !sellCandidate) return null;

  //  Regime-based direction blocking 
  const trendUpBlocked   = operationalRegime === "trend_up";   // block SELL in uptrend
  const trendDownBlocked = operationalRegime === "trend_down"; // block BUY in downtrend

  let direction: "buy" | "sell";
  if (buyExtremity <= sellExtremity) {
    if (trendDownBlocked) {
      if (sellCandidate && !trendUpBlocked) { direction = "sell"; }
      else return null;
    } else {
      direction = "buy";
    }
  } else {
    if (trendUpBlocked) {
      if (buyCandidate && !trendDownBlocked) { direction = "buy"; }
      else return null;
    } else {
      direction = "sell";
    }
  }

  const distFromExtreme = direction === "buy" ? f.distFromRange30dLowPct : f.distFromRange30dHighPct;
  const distToOpposite  = direction === "buy" ? f.distFromRange30dHighPct : f.distFromRange30dLowPct;

  //  Score all 6 components 
  const c1 = scoreR100RevRangeExtremity(distFromExtreme);
  const c2 = scoreR100RevReversalConfirmation(direction, f);
  const c3 = scoreR100RevStretchDeviation(direction, f);
  const c4 = scoreR100RevStructureQuality(direction, f);
  const c5 = scoreR100RevEntryEfficiency(direction, distFromExtreme, f.emaDist);
  const c6 = scoreR100RevMoveSufficiency(distToOpposite, f.atrRank);

  const componentScores = {
    rangeExtremity:         c1.score,
    reversalConfirmation:   c2.score,
    stretchDeviation:       c3.score,
    structureQuality:       c4.score,
    entryEfficiency:        c5.score,
    expectedMoveSufficiency: c6.score,
  };

  const nativeScore = Math.round(
    c1.score * W_REV_RANGE_EXTREMITY  +
    c2.score * W_REV_REVERSAL_CONFIRM +
    c3.score * W_REV_STRETCH          +
    c4.score * W_REV_STRUCTURE        +
    c5.score * W_REV_ENTRY_EFF        +
    c6.score * W_REV_MOVE_SUFF
  );

  //  Engine-native gate 
  const gatePassed = nativeScore >= runtimeGate.gate;
  const blockReasons: string[] = [];

  if (!gatePassed) {
    blockReasons.push(`native_score_${nativeScore}_below_reversal_gate_${runtimeGate.gate}`);
    const weakComponents = Object.entries(componentScores)
      .filter(([, v]) => v < 50)
      .map(([k, v]) => `${k}(${v}/100)`);
    blockReasons.push(...weakComponents);
    return null;
  }

  //  Confidence (direct from native score) 
  const confidence = nativeScore / 100;

  //  RegimeFit (informational only) 
  let regimeFit = 0.60;
  if (operationalRegime === "mean_reversion" || operationalRegime === "ranging") regimeFit = 0.88;
  else if (operationalRegime === "compression") regimeFit = 0.72;
  else if (operationalRegime === "trend_up" && direction === "sell") regimeFit = 0.50;
  else if (operationalRegime === "trend_down" && direction === "buy") regimeFit = 0.50;

  const setupDetected = direction === "buy"
    ? "r100_reversal_buy_at_30d_range_low"
    : "r100_reversal_sell_at_30d_range_high";

  const structuralContext = `regime=${operationalRegime}(${(regimeConfidence * 100).toFixed(0)}%) | ` +
    `distFromExtreme=${(Math.abs(distFromExtreme) * 100).toFixed(1)}% | ` +
    `zScore=${f.zScore.toFixed(2)} | rsi=${f.rsi14.toFixed(1)} | bbPctB=${f.bbPctB.toFixed(2)}`;

  return {
    valid: true,
    symbol: SYMBOL,
    engineName: "r100_reversal_engine",
    direction,
    confidence,
    regimeFit,
    entryType: "reversal",
    projectedMovePct: R100_REVERSAL_PROJECTED_PCT,
    invalidation: direction === "buy"
      ? f.swingLow * 0.995
      : f.swingHigh * 1.005,
    reason: `r100_reversal ${direction}: native=${nativeScore}/100 | extreme=${c1.score} reversal=${c2.score} stretch=${c3.score} structure=${c4.score} entry=${c5.score} move=${c6.score}`,
    metadata: {
      r100ReversalNativeScore:   nativeScore,
      r100ReversalGatePassed:    gatePassed,
      r100ReversalGateThreshold: runtimeGate.gate,
      r100ReversalRuntimeCalibrated: runtimeGate.calibrated,
      r100ReversalRuntimeCalibrationRunId: runtimeGate.sourceRunId,
      r100ReversalBlockReasons:  blockReasons,
      componentScores,
      componentFlags: {
        rangeExtremity:         c1.flags,
        reversalConfirmation:   c2.flags,
        stretchDeviation:       c3.flags,
        structureQuality:       c4.flags,
        entryEfficiency:        c5.flags,
        expectedMoveSufficiency: c6.flags,
      },
      setupFamily:              "r100_swing_structure",
      setupDetected,
      expectedHoldProfile:      R100_REVERSAL_HOLD,
      tpLogicSummary:           R100_REVERSAL_TP,
      slLogicSummary:           R100_REVERSAL_SL,
      trailingActivationSummary: R100_REVERSAL_TRAIL,
      structuralContextSummary: structuralContext,
    },
  };
}

// 
// BREAKOUT ENGINE  SECONDARY R_100 SETUP FAMILY
// Component key names: breakStrength, boundaryPressure, expansionQuality,
//   acceptanceQuality, entryEfficiency, expectedMoveSufficiency
// "acceptanceQuality" (not "retestAcceptanceQuality") distinguishes from R_75
// 

//  BRK Component 1: Break Strength (0100) 
// Decisiveness of the actual breakout  candle body quality, EMA alignment,
// swing breach confirmation.
function scoreR100BrkBreakStrength(
  direction: "buy" | "sell",
  f: {
    swingBreached: boolean; swingBreachDirection: string | null;
    candleBody: number; latestClose: number; latestOpen: number;
    emaSlope: number; consecutive: number;
  }
): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;

  const breakConfirmed = f.swingBreached && (
    direction === "buy" ? f.swingBreachDirection === "above" : f.swingBreachDirection === "below"
  );

  // Swing breach  max 35
  if (breakConfirmed) { score += 35; flags.push("swing_breach_confirmed"); }
  else { flags.push("no_swing_breach"); }

  // Breakout candle body  max 30
  const directional = direction === "buy"
    ? f.latestClose > f.latestOpen
    : f.latestClose < f.latestOpen;
  if (directional && f.candleBody >= 0.65) { score += 30; flags.push("strong_break_candle"); }
  else if (directional && f.candleBody >= 0.45) { score += 22; flags.push("moderate_break_candle"); }
  else if (directional && f.candleBody >= 0.25) { score += 12; flags.push("weak_break_candle"); }
  else { score += 3; flags.push("no_directional_body"); }

  // EMA slope alignment  max 20
  if (direction === "buy") {
    if (f.emaSlope >= 0.0006)       { score += 20; flags.push("strong_upward_ema"); }
    else if (f.emaSlope >= 0.0003)  { score += 14; flags.push("moderate_upward_ema"); }
    else if (f.emaSlope >= 0.0001)  { score += 8;  flags.push("mild_upward_ema"); }
    else flags.push("ema_not_aligned_up");
  } else {
    if (f.emaSlope <= -0.0006)      { score += 20; flags.push("strong_downward_ema"); }
    else if (f.emaSlope <= -0.0003) { score += 14; flags.push("moderate_downward_ema"); }
    else if (f.emaSlope <= -0.0001) { score += 8;  flags.push("mild_downward_ema"); }
    else flags.push("ema_not_aligned_down");
  }

  // Consecutive momentum  max 15
  const cons = direction === "buy" ? f.consecutive : -f.consecutive;
  if (cons >= 4)      { score += 15; flags.push("strong_momentum(4)"); }
  else if (cons >= 2) { score += 9;  flags.push("moderate_momentum(2)"); }
  else if (cons >= 1) { score += 4;  flags.push("weak_momentum"); }
  else flags.push("no_directional_momentum");

  return { score: clamp(Math.round(score), 0, 100), flags };
}

//  BRK Component 2: Boundary Pressure (0100) 
// How much structural pressure exists at the range boundary before the break.
// BUY: price near 30d high (about to break out above)
// SELL: price near 30d low (about to break out below)
function scoreR100BrkBoundaryPressure(
  direction: "buy" | "sell",
  distFromBoundary: number,
  bbPctB: number
): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;
  const dist = Math.abs(distFromBoundary);

  // Proximity to boundary  max 60
  if (dist <= 0.01)       { score += 60; flags.push("at_boundary(1%)"); }
  else if (dist <= 0.03)  { score += 60 - ((dist - 0.01) / 0.02) * 16; flags.push("very_near_boundary(3%)"); }
  else if (dist <= 0.08)  { score += 44 - ((dist - 0.03) / 0.05) * 22; flags.push("near_boundary(8%)"); }
  else if (dist <= 0.15)  { score += 22 - ((dist - 0.08) / 0.07) * 12; flags.push("moderate_from_boundary(15%)"); }
  else { score += 5; flags.push("far_from_boundary(>15%)"); }

  // BB edge confirmation  max 40
  if (direction === "buy") {
    if (bbPctB >= 0.95)       { score += 40; flags.push("extreme_bb_upper_pressure"); }
    else if (bbPctB >= 0.85)  { score += 30; flags.push("deep_bb_upper"); }
    else if (bbPctB >= 0.75)  { score += 18; flags.push("bb_upper_zone"); }
    else if (bbPctB >= 0.65)  { score += 8;  flags.push("moderate_bb_upper"); }
    else flags.push("bb_not_at_upper"); 
  } else {
    if (bbPctB <= 0.05)       { score += 40; flags.push("extreme_bb_lower_pressure"); }
    else if (bbPctB <= 0.15)  { score += 30; flags.push("deep_bb_lower"); }
    else if (bbPctB <= 0.25)  { score += 18; flags.push("bb_lower_zone"); }
    else if (bbPctB <= 0.35)  { score += 8;  flags.push("moderate_bb_lower"); }
    else flags.push("bb_not_at_lower");
  }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

//  BRK Component 3: Expansion Quality (0100) 
// Volatility / range expansion confirming the break  critical for R_100.
function scoreR100BrkExpansionQuality(
  f: { bbWidthRoc: number; atrAccel: number; atrRank: number }
): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;

  // BB width ROC (rate of expansion)  max 40
  if (f.bbWidthRoc >= 0.15)      { score += 40; flags.push("strong_bb_expansion"); }
  else if (f.bbWidthRoc >= 0.10) { score += 30; flags.push("moderate_bb_expansion"); }
  else if (f.bbWidthRoc >= 0.05) { score += 18; flags.push("mild_bb_expansion"); }
  else if (f.bbWidthRoc >= 0.02) { score += 8;  flags.push("marginal_bb_expansion"); }
  else flags.push("no_bb_expansion");

  // ATR acceleration  max 35
  if (f.atrAccel >= 0.12)        { score += 35; flags.push("strong_atr_acceleration"); }
  else if (f.atrAccel >= 0.08)   { score += 26; flags.push("moderate_atr_acceleration"); }
  else if (f.atrAccel >= 0.04)   { score += 15; flags.push("mild_atr_acceleration"); }
  else if (f.atrAccel >= 0.01)   { score += 6;  flags.push("marginal_atr_acceleration"); }
  else flags.push("no_atr_acceleration");

  // ATR rank elevated  max 25
  if (f.atrRank >= 1.5)          { score += 25; flags.push("elevated_atr_rank"); }
  else if (f.atrRank >= 1.2)     { score += 18; flags.push("above_average_atr_rank"); }
  else if (f.atrRank >= 1.0)     { score += 10; flags.push("normal_atr_rank"); }
  else { score += 3; flags.push("below_average_atr_rank"); }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

//  BRK Component 4: Acceptance Quality (0100) 
// Key name: "acceptanceQuality" (unique  R_75 uses "retestAcceptanceQuality")
// Hold above/below the break level: price vs EMA, consecutive bars, BB hold.
function scoreR100BrkAcceptanceQuality(
  direction: "buy" | "sell",
  f: { priceVsEma20: number; consecutive: number; bbPctB: number; emaDist: number }
): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;

  if (direction === "buy") {
    // Price above EMA (holding breakout)  max 40
    if (f.priceVsEma20 >= 0.025)       { score += 40; flags.push("strongly_above_ema"); }
    else if (f.priceVsEma20 >= 0.012)  { score += 30; flags.push("above_ema"); }
    else if (f.priceVsEma20 >= 0.004)  { score += 18; flags.push("mildly_above_ema"); }
    else if (f.priceVsEma20 >= 0)      { score += 8;  flags.push("just_above_ema"); }
    else flags.push("failed_to_hold_above_ema");

    // Consecutive bullish bars after break  max 35
    if (f.consecutive >= 4)     { score += 35; flags.push("sustained_acceptance(4)"); }
    else if (f.consecutive >= 2){ score += 24; flags.push("moderate_acceptance(2)"); }
    else if (f.consecutive >= 1){ score += 12; flags.push("initial_acceptance"); }
    else flags.push("no_acceptance");

    // BB hold in upper zone  max 25
    if (f.bbPctB >= 0.85)       { score += 25; flags.push("bb_upper_hold"); }
    else if (f.bbPctB >= 0.70)  { score += 16; flags.push("bb_upper_zone_hold"); }
    else if (f.bbPctB >= 0.55)  { score += 8;  flags.push("bb_mid_hold"); }
    else flags.push("failed_bb_hold");

  } else {
    // Price below EMA (holding breakdown)  max 40
    if (f.priceVsEma20 <= -0.025)      { score += 40; flags.push("strongly_below_ema"); }
    else if (f.priceVsEma20 <= -0.012) { score += 30; flags.push("below_ema"); }
    else if (f.priceVsEma20 <= -0.004) { score += 18; flags.push("mildly_below_ema"); }
    else if (f.priceVsEma20 <= 0)      { score += 8;  flags.push("just_below_ema"); }
    else flags.push("failed_to_hold_below_ema");

    // Consecutive bearish bars after break  max 35
    if (f.consecutive <= -4)    { score += 35; flags.push("sustained_acceptance(-4)"); }
    else if (f.consecutive <= -2){ score += 24; flags.push("moderate_acceptance(-2)"); }
    else if (f.consecutive <= -1){ score += 12; flags.push("initial_acceptance"); }
    else flags.push("no_acceptance");

    // BB hold in lower zone  max 25
    if (f.bbPctB <= 0.15)       { score += 25; flags.push("bb_lower_hold"); }
    else if (f.bbPctB <= 0.30)  { score += 16; flags.push("bb_lower_zone_hold"); }
    else if (f.bbPctB <= 0.45)  { score += 8;  flags.push("bb_mid_hold"); }
    else flags.push("failed_bb_hold");
  }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

//  BRK Component 5: Entry Efficiency (0100) 
// Early breakout or clean retest entry  penalize late chase.
function scoreR100BrkEntryEfficiency(
  direction: "buy" | "sell",
  distFromBoundary: number,
  emaDist: number
): { score: number; flags: string[] } {
  const flags: string[] = [];
  const dist = Math.abs(distFromBoundary);

  // Proximity to boundary  max 90
  let score: number;
  if (dist <= 0.01)       { score = 90; flags.push("at_breakout_boundary"); }
  else if (dist <= 0.03)  { score = 90 - ((dist - 0.01) / 0.02) * 18; flags.push("near_boundary(3%)"); }
  else if (dist <= 0.08)  { score = 72 - ((dist - 0.03) / 0.05) * 24; flags.push("pullback_retest(8%)"); }
  else if (dist <= 0.15)  { score = 48 - ((dist - 0.08) / 0.07) * 20; flags.push("extended_from_break(15%)"); }
  else                    { score = 20; flags.push("late_chase(>15%)"); }

  // EMA alignment bonus  max 10
  if (direction === "buy" && emaDist > 0.004)   { score += 10; flags.push("above_ema_bonus"); }
  else if (direction === "sell" && emaDist < -0.004) { score += 10; flags.push("below_ema_bonus"); }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

//  BRK Component 6: Expected Move Sufficiency (0100) 
// Sufficient structural runway after breakout  R_100 breakouts extend further.
function scoreR100BrkMoveSufficiency(
  direction: "buy" | "sell",
  distFromRange30dLowPct: number,
  distFromRange30dHighPct: number,
  atrRank: number
): { score: number; flags: string[] } {
  const flags: string[] = [];
  // For BUY breakout (above high): runway = total range width
  // For SELL breakout (below low): runway = total range width
  const rangeWidth = Math.abs(distFromRange30dHighPct) + Math.abs(distFromRange30dLowPct);
  const runway = rangeWidth;

  // Runway score  120 for breakout extension potential  max 80
  let score = clamp(Math.round(runway * 120), 0, 80);
  if (runway >= 0.40)      flags.push("large_range_width(40%)");
  else if (runway >= 0.25) flags.push("good_range_width(25%)");
  else if (runway >= 0.15) flags.push("moderate_range_width(15%)");
  else flags.push("narrow_range(<15%)");

  // ATR rank bonus  max 20
  if (atrRank >= 1.4)     { score += 20; flags.push("atr_elevated"); }
  else if (atrRank >= 1.1){ score += 12; flags.push("atr_moderate"); }
  else if (atrRank >= 0.8){ score += 5;  flags.push("atr_normal"); }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

//  Breakout Rejection Reason Builder 
function buildR100BreakoutRejectionReason(
  cs: Record<string, number>,
  nativeScore: number,
  gateThreshold: number,
  modeMin: number
): string {
  const breakdown = `pressure=${cs.boundaryPressure},break=${cs.breakStrength},expand=${cs.expansionQuality},accept=${cs.acceptanceQuality},entry=${cs.entryEfficiency},move=${cs.expectedMoveSufficiency}`;
  const weak = Object.entries(cs)
    .filter(([, v]) => v < 55)
    .map(([k, v]) => {
      const label: Record<string, string> = {
        boundaryPressure:        "weak_boundary_pressure",
        breakStrength:           "insufficient_break_strength",
        expansionQuality:        "insufficient_expansion_quality",
        acceptanceQuality:       "weak_acceptance_quality",
        entryEfficiency:         "poor_entry_efficiency",
        expectedMoveSufficiency: "insufficient_expected_move",
      };
      return `${label[k] ?? k}(${v}/100)`;
    });
  return (
    `r100_breakout_score_below_mode_threshold:native=${nativeScore}/100,engine_gate=${gateThreshold},mode_min=${modeMin}` +
    ` | breakdown:[${breakdown}]` +
    (weak.length > 0 ? ` | weak=[${weak.join("; ")}]` : "")
  );
}

// 
// r100BreakoutEngine  SECONDARY R_100 SETUP
// 

export function r100BreakoutEngine(ctx: EngineContext): EngineResult | null {
  const { features: f, operationalRegime, regimeConfidence } = ctx;
  if (f.symbol !== SYMBOL) return null;
  const runtimeGate = resolveR100RuntimeGate(ctx, "r100_breakout_engine", R100_BREAKOUT_MIN_GATE);

  //  Regime filter: breakout is invalid in mean_reversion / ranging 
  if (operationalRegime === "mean_reversion" || operationalRegime === "ranging") return null;

  //  Direction from swing breach or strong EMA slope 
  let direction: "buy" | "sell";
  if (f.swingBreached && f.swingBreachDirection === "above") {
    direction = "buy";
  } else if (f.swingBreached && f.swingBreachDirection === "below") {
    direction = "sell";
  } else if (f.emaSlope >= 0.0006 && f.distFromRange30dHighPct != null && Math.abs(f.distFromRange30dHighPct) <= 0.08) {
    direction = "buy";
  } else if (f.emaSlope <= -0.0006 && f.distFromRange30dLowPct != null && Math.abs(f.distFromRange30dLowPct) <= 0.08) {
    direction = "sell";
  } else {
    return null;
  }

  //  Boundary for the breakout direction 
  const distFromBoundary = direction === "buy"
    ? f.distFromRange30dHighPct
    : f.distFromRange30dLowPct;

  //  Score all 6 components 
  const c1 = scoreR100BrkBreakStrength(direction, f);
  const c2 = scoreR100BrkBoundaryPressure(direction, distFromBoundary, f.bbPctB);
  const c3 = scoreR100BrkExpansionQuality(f);
  const c4 = scoreR100BrkAcceptanceQuality(direction, f);
  const c5 = scoreR100BrkEntryEfficiency(direction, distFromBoundary, f.emaDist);
  const c6 = scoreR100BrkMoveSufficiency(direction, f.distFromRange30dLowPct, f.distFromRange30dHighPct, f.atrRank);

  const componentScores = {
    breakStrength:           c1.score,
    boundaryPressure:        c2.score,
    expansionQuality:        c3.score,
    acceptanceQuality:       c4.score,
    entryEfficiency:         c5.score,
    expectedMoveSufficiency: c6.score,
  };

  const nativeScore = Math.round(
    c1.score * W_BRK_BREAK_STRENGTH +
    c2.score * W_BRK_BOUNDARY       +
    c3.score * W_BRK_EXPANSION      +
    c4.score * W_BRK_ACCEPTANCE     +
    c5.score * W_BRK_ENTRY_EFF      +
    c6.score * W_BRK_MOVE_SUFF
  );

  //  Engine-native gate 
  const gatePassed = nativeScore >= runtimeGate.gate;
  const blockReasons: string[] = [];

  if (!gatePassed) {
    blockReasons.push(`native_score_${nativeScore}_below_breakout_gate_${runtimeGate.gate}`);
    const weakComponents = Object.entries(componentScores)
      .filter(([, v]) => v < 50)
      .map(([k, v]) => `${k}(${v}/100)`);
    blockReasons.push(...weakComponents);
    return null;
  }

  const confidence = nativeScore / 100;

  let regimeFit = 0.65;
  if (operationalRegime === "breakout_expansion") regimeFit = 0.93;
  else if (operationalRegime === "compression") regimeFit = 0.82;
  else if (operationalRegime === "trend_up" || operationalRegime === "trend_down") regimeFit = 0.72;

  const setupDetected = direction === "buy"
    ? "r100_breakout_above_30d_range_high"
    : "r100_breakout_below_30d_range_low";

  const structuralContext = `regime=${operationalRegime}(${(regimeConfidence * 100).toFixed(0)}%) | ` +
    `swingBreached=${f.swingBreached} | bbWidthRoc=${f.bbWidthRoc.toFixed(3)} | atrRank=${f.atrRank.toFixed(2)}`;

  return {
    valid: true,
    symbol: SYMBOL,
    engineName: "r100_breakout_engine",
    direction,
    confidence,
    regimeFit,
    entryType: "breakout",
    projectedMovePct: R100_BREAKOUT_PROJECTED_PCT,
    invalidation: direction === "buy"
      ? f.swingLow * 0.996
      : f.swingHigh * 1.004,
    reason: `r100_breakout ${direction}: native=${nativeScore}/100 | break=${c1.score} boundary=${c2.score} expand=${c3.score} accept=${c4.score} entry=${c5.score} move=${c6.score}`,
    metadata: {
      r100BreakoutNativeScore:   nativeScore,
      r100BreakoutGatePassed:    gatePassed,
      r100BreakoutGateThreshold: runtimeGate.gate,
      r100BreakoutRuntimeCalibrated: runtimeGate.calibrated,
      r100BreakoutRuntimeCalibrationRunId: runtimeGate.sourceRunId,
      r100BreakoutBlockReasons:  blockReasons,
      componentScores,
      componentFlags: {
        breakStrength:           c1.flags,
        boundaryPressure:        c2.flags,
        expansionQuality:        c3.flags,
        acceptanceQuality:       c4.flags,
        entryEfficiency:         c5.flags,
        expectedMoveSufficiency: c6.flags,
      },
      setupFamily:              "r100_swing_structure",
      setupDetected,
      expectedHoldProfile:      R100_BREAKOUT_HOLD,
      tpLogicSummary:           R100_BRK_TP,
      slLogicSummary:           R100_BRK_SL,
      trailingActivationSummary: R100_BRK_TRAIL,
      structuralContextSummary: structuralContext,
    },
  };
}

// 
// CONTINUATION ENGINE  TERTIARY R_100 SETUP FAMILY
// Component key names: trendStrength, pullbackQuality, slopeAlignment,
//   structureContinuity, entryEfficiency, expectedMoveSufficiency
// "trendStrength" (not "trendQuality") distinguishes from R_75
// 

//  CONT Component 1: Trend Strength (0100) 
// Key name: "trendStrength" (unique  R_75 uses "trendQuality")
// Quality of already-established move  direction, slope, structural cleanliness.
function scoreR100ContTrendStrength(
  direction: "buy" | "sell",
  f: { emaSlope: number; priceVsEma20: number; rsi14: number }
): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;

  if (direction === "buy") {
    // EMA slope magnitude  max 40
    if (f.emaSlope >= 0.0008)       { score += 40; flags.push("strong_uptrend_slope"); }
    else if (f.emaSlope >= 0.0005)  { score += 30; flags.push("moderate_uptrend_slope"); }
    else if (f.emaSlope >= 0.0002)  { score += 18; flags.push("mild_uptrend_slope"); }
    else if (f.emaSlope >= 0.0001)  { score += 8;  flags.push("weak_uptrend_slope"); }
    else flags.push("no_uptrend_slope");

    // Price vs EMA  max 35
    if (f.priceVsEma20 >= 0.025)    { score += 35; flags.push("strongly_above_ema"); }
    else if (f.priceVsEma20 >= 0.012){ score += 26; flags.push("above_ema"); }
    else if (f.priceVsEma20 >= 0.004){ score += 14; flags.push("mildly_above_ema"); }
    else if (f.priceVsEma20 >= 0)   { score += 5;  flags.push("just_above_ema"); }
    else flags.push("below_ema");

    // RSI in continuation zone  max 25
    if (f.rsi14 >= 55 && f.rsi14 <= 68)   { score += 25; flags.push("rsi_trend_zone(55-68)"); }
    else if (f.rsi14 >= 48 && f.rsi14 < 55){ score += 16; flags.push("rsi_mid_zone(48-55)"); }
    else if (f.rsi14 > 68 && f.rsi14 <= 75){ score += 12; flags.push("rsi_upper_zone"); }
    else flags.push("rsi_not_in_continuation_zone");

  } else {
    // EMA slope magnitude  max 40
    if (f.emaSlope <= -0.0008)      { score += 40; flags.push("strong_downtrend_slope"); }
    else if (f.emaSlope <= -0.0005) { score += 30; flags.push("moderate_downtrend_slope"); }
    else if (f.emaSlope <= -0.0002) { score += 18; flags.push("mild_downtrend_slope"); }
    else if (f.emaSlope <= -0.0001) { score += 8;  flags.push("weak_downtrend_slope"); }
    else flags.push("no_downtrend_slope");

    // Price vs EMA  max 35
    if (f.priceVsEma20 <= -0.025)   { score += 35; flags.push("strongly_below_ema"); }
    else if (f.priceVsEma20 <= -0.012){ score += 26; flags.push("below_ema"); }
    else if (f.priceVsEma20 <= -0.004){ score += 14; flags.push("mildly_below_ema"); }
    else if (f.priceVsEma20 <= 0)    { score += 5;  flags.push("just_below_ema"); }
    else flags.push("above_ema");

    // RSI in continuation zone  max 25
    if (f.rsi14 >= 32 && f.rsi14 <= 45)   { score += 25; flags.push("rsi_downtrend_zone(32-45)"); }
    else if (f.rsi14 > 45 && f.rsi14 <= 52){ score += 16; flags.push("rsi_mid_zone(45-52)"); }
    else if (f.rsi14 >= 25 && f.rsi14 < 32){ score += 12; flags.push("rsi_lower_zone"); }
    else flags.push("rsi_not_in_downtrend_zone");
  }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

//  CONT Component 2: Pullback Quality (0100) 
// Orderly pullback into a valid continuation zone  not too deep, not too shallow.
function scoreR100ContPullbackQuality(
  direction: "buy" | "sell",
  f: { bbPctB: number; emaDist: number; zScore: number }
): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;

  if (direction === "buy") {
    // BB pullback zone (not at extreme but pulled back toward midline)  max 40
    if (f.bbPctB >= 0.35 && f.bbPctB <= 0.58)  { score += 40; flags.push("ideal_pullback_zone(bb:35-58%)"); }
    else if (f.bbPctB >= 0.25 && f.bbPctB < 0.35){ score += 28; flags.push("deeper_pullback(bb:25-35%)"); }
    else if (f.bbPctB >= 0.58 && f.bbPctB <= 0.72){ score += 22; flags.push("shallow_pullback(bb:58-72%)"); }
    else if (f.bbPctB >= 0.15 && f.bbPctB < 0.25){ score += 12; flags.push("very_deep_pullback"); }
    else flags.push("pullback_not_in_zone");

    // EMA near (pullback to EMA support)  max 35
    const dist = f.emaDist;
    if (dist >= -0.006 && dist <= 0.006) { score += 35; flags.push("at_ema_support"); }
    else if (dist >= -0.015 && dist < -0.006){ score += 24; flags.push("below_ema_support"); }
    else if (dist > 0.006 && dist <= 0.015){ score += 18; flags.push("above_ema"); }
    else flags.push("far_from_ema");

    // zScore pullback zone  max 25
    if (f.zScore >= -0.5 && f.zScore <= 0.8)    { score += 25; flags.push("zscore_pullback_zone"); }
    else if (f.zScore >= -1.0 && f.zScore < -0.5){ score += 16; flags.push("deeper_zscore_pullback"); }
    else if (f.zScore > 0.8 && f.zScore <= 1.5)  { score += 12; flags.push("mild_zscore_extension"); }
    else flags.push("zscore_not_in_pullback_zone");

  } else {
    // BB bounce zone (pullback toward midline from below)  max 40
    if (f.bbPctB >= 0.42 && f.bbPctB <= 0.65)  { score += 40; flags.push("ideal_pullback_zone(bb:42-65%)"); }
    else if (f.bbPctB > 0.65 && f.bbPctB <= 0.75){ score += 28; flags.push("deeper_pullback(bb:65-75%)"); }
    else if (f.bbPctB >= 0.28 && f.bbPctB < 0.42){ score += 22; flags.push("shallow_pullback(bb:28-42%)"); }
    else if (f.bbPctB > 0.75 && f.bbPctB <= 0.85){ score += 12; flags.push("very_deep_pullback"); }
    else flags.push("pullback_not_in_zone");

    // EMA near (pullback to EMA resistance)  max 35
    const dist = f.emaDist;
    if (dist >= -0.006 && dist <= 0.006) { score += 35; flags.push("at_ema_resistance"); }
    else if (dist > 0.006 && dist <= 0.015){ score += 24; flags.push("above_ema_resistance"); }
    else if (dist >= -0.015 && dist < -0.006){ score += 18; flags.push("below_ema"); }
    else flags.push("far_from_ema");

    // zScore pullback zone  max 25
    if (f.zScore >= -0.8 && f.zScore <= 0.5)    { score += 25; flags.push("zscore_pullback_zone"); }
    else if (f.zScore > 0.5 && f.zScore <= 1.0)  { score += 16; flags.push("shallow_zscore_bounce"); }
    else if (f.zScore >= -1.5 && f.zScore < -0.8){ score += 12; flags.push("mild_zscore_extension"); }
    else flags.push("zscore_not_in_pullback_zone");
  }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

//  CONT Component 3: Slope Alignment (0100) 
// EMA slope alignment and directional continuity.
function scoreR100ContSlopeAlignment(
  direction: "buy" | "sell",
  f: { emaSlope: number; consecutive: number; emaDist: number }
): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;

  if (direction === "buy") {
    // EMA slope strength  max 40
    if (f.emaSlope >= 0.0006)       { score += 40; flags.push("strong_slope_alignment"); }
    else if (f.emaSlope >= 0.0003)  { score += 30; flags.push("moderate_slope_alignment"); }
    else if (f.emaSlope >= 0.0001)  { score += 18; flags.push("mild_slope_alignment"); }
    else { score += 5; flags.push("weak_slope"); }

    // Consecutive bullish bars (but not exhausted)  max 35
    if (f.consecutive >= 2 && f.consecutive <= 5) { score += 35; flags.push("healthy_continuation_candles"); }
    else if (f.consecutive >= 1)               { score += 22; flags.push("early_continuation"); }
    else if (f.consecutive === 0)              { score += 10; flags.push("neutral_candles"); }
    else { score += 3; flags.push("pullback_candles"); }

    // EMA margin (price above EMA but not too stretched)  max 25
    if (f.emaDist >= 0.004 && f.emaDist <= 0.018) { score += 25; flags.push("ideal_ema_margin"); }
    else if (f.emaDist > 0.018)                    { score += 12; flags.push("stretched_from_ema"); }
    else if (f.emaDist >= 0 && f.emaDist < 0.004)  { score += 18; flags.push("near_ema"); }
    else flags.push("below_ema");

  } else {
    // EMA slope strength  max 40
    if (f.emaSlope <= -0.0006)      { score += 40; flags.push("strong_slope_alignment"); }
    else if (f.emaSlope <= -0.0003) { score += 30; flags.push("moderate_slope_alignment"); }
    else if (f.emaSlope <= -0.0001) { score += 18; flags.push("mild_slope_alignment"); }
    else { score += 5; flags.push("weak_slope"); }

    // Consecutive bearish bars  max 35
    if (f.consecutive <= -2 && f.consecutive >= -5) { score += 35; flags.push("healthy_continuation_candles"); }
    else if (f.consecutive <= -1)                    { score += 22; flags.push("early_continuation"); }
    else if (f.consecutive === 0)                    { score += 10; flags.push("neutral_candles"); }
    else { score += 3; flags.push("pullback_candles"); }

    // EMA margin (price below EMA but not too stretched)  max 25
    if (f.emaDist >= -0.018 && f.emaDist <= -0.004) { score += 25; flags.push("ideal_ema_margin"); }
    else if (f.emaDist < -0.018)                     { score += 12; flags.push("stretched_from_ema"); }
    else if (f.emaDist > -0.004 && f.emaDist <= 0)   { score += 18; flags.push("near_ema"); }
    else flags.push("above_ema");
  }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

//  CONT Component 4: Structure Continuity (0100) 
// Move remains orderly rather than degraded/noisy.
function scoreR100ContStructureContinuity(
  f: { zScore: number; atrRank: number; bbWidth: number }
): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;

  // zScore in valid trending range (not near extreme = not exhausted)  max 40
  const zAbs = Math.abs(f.zScore);
  if (zAbs >= 0.5 && zAbs <= 1.8)      { score += 40; flags.push("healthy_trend_zscore"); }
  else if (zAbs > 1.8 && zAbs <= 2.2)  { score += 22; flags.push("extended_zscore"); }
  else if (zAbs < 0.5)                  { score += 16; flags.push("flat_zscore"); }
  else flags.push("exhausted_zscore");

  // ATR in healthy continuation range  max 35
  if (f.atrRank >= 0.8 && f.atrRank <= 1.3)   { score += 35; flags.push("healthy_atr_range"); }
  else if (f.atrRank >= 1.3 && f.atrRank <= 1.6){ score += 22; flags.push("elevated_atr"); }
  else if (f.atrRank >= 0.6 && f.atrRank < 0.8){ score += 18; flags.push("moderate_atr"); }
  else { score += 6; flags.push("extreme_atr"); }

  // BB width orderly (not too wide = no explosion, not too tight = not dead)  max 25
  if (f.bbWidth >= 0.014 && f.bbWidth <= 0.030)  { score += 25; flags.push("orderly_bb_width"); }
  else if (f.bbWidth > 0.030 && f.bbWidth <= 0.045){ score += 14; flags.push("expanding_bb"); }
  else if (f.bbWidth >= 0.008 && f.bbWidth < 0.014){ score += 16; flags.push("tight_bb"); }
  else { score += 4; flags.push("extreme_bb_width"); }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

//  CONT Component 5: Entry Efficiency (0100) 
// Early enough re-entry, not late-chase.
function scoreR100ContEntryEfficiency(
  direction: "buy" | "sell",
  f: { emaDist: number; bbPctB: number; priceVsEma20: number }
): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;

  if (direction === "buy") {
    // Near-EMA entry  max 60
    const dist = Math.abs(f.emaDist);
    if (dist <= 0.004)       { score += 60; flags.push("at_ema_entry"); }
    else if (dist <= 0.010)  { score += 44; flags.push("near_ema_entry"); }
    else if (dist <= 0.020)  { score += 26; flags.push("moderate_ema_distance"); }
    else                     { score += 8;  flags.push("far_from_ema_entry"); }

    // BB pullback zone bonus  max 40
    if (f.bbPctB >= 0.35 && f.bbPctB <= 0.60)  { score += 40; flags.push("ideal_bb_entry_zone"); }
    else if (f.bbPctB >= 0.25 && f.bbPctB < 0.35){ score += 26; flags.push("deep_pullback_entry"); }
    else if (f.bbPctB >= 0.60 && f.bbPctB <= 0.75){ score += 18; flags.push("minor_pullback_entry"); }
    else { score += 6; flags.push("poor_bb_entry_zone"); }

  } else {
    // Near-EMA entry  max 60
    const dist = Math.abs(f.emaDist);
    if (dist <= 0.004)       { score += 60; flags.push("at_ema_entry"); }
    else if (dist <= 0.010)  { score += 44; flags.push("near_ema_entry"); }
    else if (dist <= 0.020)  { score += 26; flags.push("moderate_ema_distance"); }
    else                     { score += 8;  flags.push("far_from_ema_entry"); }

    // BB bounce zone bonus  max 40
    if (f.bbPctB >= 0.40 && f.bbPctB <= 0.65)  { score += 40; flags.push("ideal_bb_entry_zone"); }
    else if (f.bbPctB > 0.65 && f.bbPctB <= 0.75){ score += 26; flags.push("deep_pullback_entry"); }
    else if (f.bbPctB >= 0.25 && f.bbPctB < 0.40){ score += 18; flags.push("minor_pullback_entry"); }
    else { score += 6; flags.push("poor_bb_entry_zone"); }
  }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

//  CONT Component 6: Expected Move Sufficiency (0100) 
// Enough continuation runway remains.
function scoreR100ContMoveSufficiency(
  direction: "buy" | "sell",
  distFromRange30dLowPct: number,
  distFromRange30dHighPct: number,
  atrRank: number
): { score: number; flags: string[] } {
  const flags: string[] = [];
  // Remaining runway: for BUY, how far to 30d high; for SELL, how far to 30d low
  const runway = direction === "buy"
    ? Math.abs(distFromRange30dHighPct)
    : Math.abs(distFromRange30dLowPct);

  // Runway score  140  max 80
  let score = clamp(Math.round(runway * 140), 0, 80);
  if (runway >= 0.25)      flags.push("large_runway(25%)");
  else if (runway >= 0.15) flags.push("good_runway(15%)");
  else if (runway >= 0.08) flags.push("moderate_runway(8%)");
  else flags.push("limited_runway(<8%)");

  // ATR rank bonus  max 20
  if (atrRank >= 1.4)     { score += 20; flags.push("atr_elevated"); }
  else if (atrRank >= 1.1){ score += 12; flags.push("atr_moderate"); }
  else if (atrRank >= 0.8){ score += 5;  flags.push("atr_normal"); }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

//  Continuation Rejection Reason Builder 
function buildR100ContinuationRejectionReason(
  cs: Record<string, number>,
  nativeScore: number,
  gateThreshold: number,
  modeMin: number
): string {
  const breakdown = `trend=${cs.trendStrength},pullback=${cs.pullbackQuality},slope=${cs.slopeAlignment},structure=${cs.structureContinuity},entry=${cs.entryEfficiency},move=${cs.expectedMoveSufficiency}`;
  const weak = Object.entries(cs)
    .filter(([, v]) => v < 55)
    .map(([k, v]) => {
      const label: Record<string, string> = {
        trendStrength:           "weak_trend_strength",
        pullbackQuality:         "weak_pullback_quality",
        slopeAlignment:          "poor_slope_alignment",
        structureContinuity:     "poor_structure_continuity",
        entryEfficiency:         "poor_entry_efficiency",
        expectedMoveSufficiency: "insufficient_expected_move",
      };
      return `${label[k] ?? k}(${v}/100)`;
    });
  return (
    `r100_continuation_score_below_mode_threshold:native=${nativeScore}/100,engine_gate=${gateThreshold},mode_min=${modeMin}` +
    ` | breakdown:[${breakdown}]` +
    (weak.length > 0 ? ` | weak=[${weak.join("; ")}]` : "")
  );
}

// 
// r100ContinuationEngine  TERTIARY R_100 SETUP (strictest gate)
// 

export function r100ContinuationEngine(ctx: EngineContext): EngineResult | null {
  const { features: f, operationalRegime, regimeConfidence } = ctx;
  if (f.symbol !== SYMBOL) return null;
  const runtimeGate = resolveR100RuntimeGate(ctx, "r100_continuation_engine", R100_CONTINUATION_MIN_GATE);

  //  Regime filter: continuation is invalid without an established trend 
  if (
    operationalRegime === "mean_reversion" ||
    operationalRegime === "ranging" ||
    operationalRegime === "compression"
  ) return null;

  //  Direction from trend slope 
  const trendUp   = f.emaSlope > 0.0001 && f.priceVsEma20 > 0;
  const trendDown = f.emaSlope < -0.0001 && f.priceVsEma20 < 0;

  let direction: "buy" | "sell";
  if (trendUp)        direction = "buy";
  else if (trendDown) direction = "sell";
  else return null;

  //  Score all 6 components 
  const c1 = scoreR100ContTrendStrength(direction, f);
  const c2 = scoreR100ContPullbackQuality(direction, f);
  const c3 = scoreR100ContSlopeAlignment(direction, f);
  const c4 = scoreR100ContStructureContinuity(f);
  const c5 = scoreR100ContEntryEfficiency(direction, f);
  const c6 = scoreR100ContMoveSufficiency(direction, f.distFromRange30dLowPct, f.distFromRange30dHighPct, f.atrRank);

  const componentScores = {
    trendStrength:           c1.score,
    pullbackQuality:         c2.score,
    slopeAlignment:          c3.score,
    structureContinuity:     c4.score,
    entryEfficiency:         c5.score,
    expectedMoveSufficiency: c6.score,
  };

  const nativeScore = Math.round(
    c1.score * W_CONT_TREND_STRENGTH +
    c2.score * W_CONT_PULLBACK       +
    c3.score * W_CONT_SLOPE_ALIGN    +
    c4.score * W_CONT_STRUCT_CONT    +
    c5.score * W_CONT_ENTRY_EFF      +
    c6.score * W_CONT_MOVE_SUFF
  );

  //  Engine-native gate 
  const gatePassed = nativeScore >= runtimeGate.gate;
  const blockReasons: string[] = [];

  if (!gatePassed) {
    blockReasons.push(`native_score_${nativeScore}_below_continuation_gate_${runtimeGate.gate}`);
    const weakComponents = Object.entries(componentScores)
      .filter(([, v]) => v < 50)
      .map(([k, v]) => `${k}(${v}/100)`);
    blockReasons.push(...weakComponents);
    return null;
  }

  const confidence = nativeScore / 100;

  let regimeFit = 0.60;
  if (direction === "buy" && (operationalRegime === "trend_up" || operationalRegime === "breakout_expansion")) regimeFit = 0.88;
  else if (direction === "sell" && (operationalRegime === "trend_down" || operationalRegime === "breakout_expansion")) regimeFit = 0.88;
  else if (operationalRegime === "spike_zone") regimeFit = 0.40;

  const setupDetected = direction === "buy"
    ? "r100_continuation_buy_pullback_reentry"
    : "r100_continuation_sell_bounce_reentry";

  const structuralContext = `regime=${operationalRegime}(${(regimeConfidence * 100).toFixed(0)}%) | ` +
    `emaSlope=${f.emaSlope.toFixed(5)} | rsi=${f.rsi14.toFixed(1)} | priceVsEma=${f.priceVsEma20.toFixed(4)}`;

  return {
    valid: true,
    symbol: SYMBOL,
    engineName: "r100_continuation_engine",
    direction,
    confidence,
    regimeFit,
    entryType: "continuation",
    projectedMovePct: R100_CONTINUATION_PROJECTED_PCT,
    invalidation: direction === "buy"
      ? f.swingLow * 0.997
      : f.swingHigh * 1.003,
    reason: `r100_continuation ${direction}: native=${nativeScore}/100 | trend=${c1.score} pullback=${c2.score} slope=${c3.score} structure=${c4.score} entry=${c5.score} move=${c6.score}`,
    metadata: {
      r100ContinuationNativeScore:   nativeScore,
      r100ContinuationGatePassed:    gatePassed,
      r100ContinuationGateThreshold: runtimeGate.gate,
      r100ContinuationRuntimeCalibrated: runtimeGate.calibrated,
      r100ContinuationRuntimeCalibrationRunId: runtimeGate.sourceRunId,
      r100ContinuationBlockReasons:  blockReasons,
      componentScores,
      componentFlags: {
        trendStrength:           c1.flags,
        pullbackQuality:         c2.flags,
        slopeAlignment:          c3.flags,
        structureContinuity:     c4.flags,
        entryEfficiency:         c5.flags,
        expectedMoveSufficiency: c6.flags,
      },
      setupFamily:              "r100_swing_structure",
      setupDetected,
      expectedHoldProfile:      R100_CONTINUATION_HOLD,
      tpLogicSummary:           R100_CONT_TP,
      slLogicSummary:           R100_CONT_SL,
      trailingActivationSummary: R100_CONT_TRAIL,
      structuralContextSummary: structuralContext,
    },
  };
}

//  R_100 rejection reason builders (exported for allocator) 
export { buildR100ReversalRejectionReason, buildR100BreakoutRejectionReason, buildR100ContinuationRejectionReason };
