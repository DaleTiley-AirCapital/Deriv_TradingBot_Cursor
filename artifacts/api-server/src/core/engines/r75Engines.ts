/**
 * R_75 Engines  Native Scoring, Gating & Decision Explanation
 *
 * R_75 is a continuous random walk with mean reversion over multi-day periods.
 * - No spike behavior, no spike-cluster pressure
 * - Swings every 518 days, average swing ~22% over 8 days
 * - Primary trade logic: entry at 30-day range extreme + directional reversal confirmation
 * - Hierarchy: Reversal (primary)  Continuation (secondary)  Breakout (tertiary)
 * - Long-hold swing only  no scalp, no time-based forced exits
 *
 *  Scoring architecture 
 * Each engine has 6 native components scored 0100.
 * confidence = nativeScore / 100  (direct 1:1 mapping  no boolean-count blending)
 *
 *  Engine gates (primary) 
 * R75_REVERSAL_MIN_GATE    = 55   (primary setup  lowest gate)
 * R75_CONTINUATION_MIN_GATE = 58  (secondary  slightly stricter)
 * R75_BREAKOUT_MIN_GATE    = 60   (tertiary  strictest)
 *
 *  Calibration 
 * Based on 296,377 cleaned R_75 candles (0 duplicates, 0 missing intervals,
 * 20 interpolated candles explicitly excluded from signal generation).
 */

import type { EngineContext, EngineResult } from "../engineTypes.js";

const SYMBOL = "R_75";

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

//  Projected move calibration (R_75 empirical swing data) 
const R75_REVERSAL_PROJECTED_PCT     = 0.22;   // avg swing ~22% from 30d extreme
const R75_CONTINUATION_PROJECTED_PCT = 0.15;   // continuation captures mid-leg
const R75_BREAKOUT_PROJECTED_PCT     = 0.25;   // breakout can extend beyond range

//  Engine-native gates (primary) 
// These are the PRIMARY pass thresholds for each R_75 engine.
// The allocator's mode-level confidence check (paper0.60/demo0.65/real0.70)
// remains as the SECONDARY gate applied after engine acceptance.
const R75_REVERSAL_MIN_GATE     = 55;
const R75_CONTINUATION_MIN_GATE = 58;
const R75_BREAKOUT_MIN_GATE     = 60;

//  Component weights 
// Reversal: range extremity drives the thesis
const W_REV_RANGE_EXTREMITY  = 0.25;
const W_REV_REVERSAL_CONFIRM = 0.20;
const W_REV_STRETCH          = 0.20;
const W_REV_STRUCTURE        = 0.15;
const W_REV_ENTRY_EFF        = 0.10;
const W_REV_MOVE_SUFF        = 0.10;

// Continuation: trend quality + pullback confirmation
const W_CONT_TREND_QUALITY   = 0.25;
const W_CONT_PULLBACK        = 0.20;
const W_CONT_SLOPE_ALIGN     = 0.20;
const W_CONT_STRUCT_CONT     = 0.15;
const W_CONT_ENTRY_EFF       = 0.10;
const W_CONT_MOVE_SUFF       = 0.10;

// Breakout: break strength is the dominant component
const W_BRK_BOUNDARY         = 0.20;
const W_BRK_BREAK_STRENGTH   = 0.25;
const W_BRK_EXPANSION        = 0.20;
const W_BRK_RETEST           = 0.15;
const W_BRK_ENTRY_EFF        = 0.10;
const W_BRK_MOVE_SUFF        = 0.10;

//  Expected hold profiles 
const R75_REVERSAL_HOLD     = "518 days | trailing activation at 15% move | max 25d";
const R75_CONTINUATION_HOLD = "310 days | trailing activation at 10% move | max 18d";
const R75_BREAKOUT_HOLD     = "414 days | trailing activation at 12% move | max 20d";

//  TP / SL logic summaries 
const R75_REVERSAL_TP     = "Primary TP: 22% swing target from 30d extreme. Stage 1: 8%, Stage 2: 15%, Stage 3: 22%. Trail from 15%.";
const R75_REVERSAL_SL     = "SL below 30d range low (BUY) or above 30d range high (SELL) + 0.4% buffer. Tightens to breakeven after 8% move.";
const R75_REVERSAL_TRAIL  = "Trailing stop activates at 15% unrealised gain. Initial trail 8%, tightens to 5% above 18%.";

const R75_CONT_TP    = "Primary TP: continuation to next 30d extreme. Stage 1: 6%, Stage 2: 11%, Stage 3: 16%. Trail from 10%.";
const R75_CONT_SL    = "SL at most recent swing low (BUY) or swing high (SELL) + 0.3% buffer. Tightens after 7% move.";
const R75_CONT_TRAIL = "Trailing stop activates at 10% unrealised gain. Initial trail 7%, tightens to 4% above 14%.";

const R75_BRK_TP    = "Primary TP: breakout target 25% beyond prior range boundary. Stage 1: 8%, Stage 2: 15%, Stage 3: 25%. Trail from 12%.";
const R75_BRK_SL    = "SL just inside prior range boundary + 0.3% buffer. Tightens after 8% move.";
const R75_BRK_TRAIL = "Trailing stop activates at 12% unrealised gain. Initial trail 8%, tightens to 5% above 18%.";

// 
// REVERSAL ENGINE  PRIMARY R_75 SETUP FAMILY
// 

//  REV Component 1: Range Extremity (0100) 
// How close price is to the 30-day range extreme.
// BUY: price near 30d low (distFromRange30dLowPct near 0)
// SELL: price near 30d high (|distFromRange30dHighPct| near 0)
function scoreRevRangeExtremity(distFromExtreme: number): { score: number; flags: string[] } {
  const flags: string[] = [];
  const dist = Math.abs(distFromExtreme);
  // Score gradient: within 0.5%  95, within 2%  82, within 5%  60, 10%+  15
  let score: number;
  if (dist <= 0.005) {
    score = 95;
    flags.push("at_30d_extreme(0.5%)");
  } else if (dist <= 0.02) {
    score = 95 - ((dist - 0.005) / 0.015) * 18;
    flags.push("very_near_30d_extreme(2%)");
  } else if (dist <= 0.05) {
    score = 77 - ((dist - 0.02) / 0.03) * 22;
    flags.push("near_30d_extreme(5%)");
  } else if (dist <= 0.10) {
    score = 55 - ((dist - 0.05) / 0.05) * 25;
    flags.push("moderate_from_extreme(10%)");
  } else if (dist <= 0.15) {
    score = 30 - ((dist - 0.10) / 0.05) * 18;
    flags.push("far_from_extreme(15%)");
  } else {
    score = 12;
    flags.push("mid_range(>15%)");
  }
  return { score: clamp(Math.round(score), 0, 100), flags };
}

//  REV Component 2: Reversal Confirmation (0100) 
// Actual directional reversal evidence at the extreme.
// BUY: lowerWickRatio, bullish candle, RSI oversold, EMA slope recovering
// SELL: upperWickRatio, bearish candle, RSI overbought, EMA slope fading
function scoreRevReversalConfirmation(
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
    if (f.rsi14 <= 22) { score += 25; flags.push("deeply_oversold(rsi22)"); }
    else if (f.rsi14 <= 28) { score += 20; flags.push("oversold(rsi28)"); }
    else if (f.rsi14 <= 35) { score += 12; flags.push("mildly_oversold(rsi35)"); }
    else if (f.rsi14 <= 42) { score += 5;  flags.push("near_oversold(rsi42)"); }
    else flags.push("rsi_not_oversold");

    // EMA slope recovering (not accelerating down)  max 20
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
    if (f.rsi14 >= 78) { score += 25; flags.push("deeply_overbought(rsi78)"); }
    else if (f.rsi14 >= 72) { score += 20; flags.push("overbought(rsi72)"); }
    else if (f.rsi14 <= 65) { score += 12; flags.push("mildly_overbought(rsi65)"); }
    else if (f.rsi14 >= 60) { score += 5;  flags.push("near_overbought(rsi60)"); }
    else flags.push("rsi_not_overbought");

    // EMA slope fading (not accelerating up)  max 20
    if (f.emaSlope <= -0.0001)       { score += 20; flags.push("ema_turning_down"); }
    else if (f.emaSlope <= 0.0001)   { score += 14; flags.push("ema_flattening"); }
    else if (f.emaSlope <= 0.0003)   { score += 7;  flags.push("ema_decelerating"); }
    else flags.push("ema_still_rising");
  }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

//  REV Component 3: Stretch / Deviation Quality (0100) 
// How stretched price is relative to statistical context.
// BUY: zScore deeply negative, bbPctB low, emaDist negative
// SELL: zScore deeply positive, bbPctB high, emaDist positive
function scoreRevStretchDeviation(
  direction: "buy" | "sell",
  f: { zScore: number; bbPctB: number; emaDist: number }
): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;

  if (direction === "buy") {
    // zScore stretch below mean  max 40
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
    if (f.emaDist <= -0.015)    { score += 25; flags.push("deeply_below_ema"); }
    else if (f.emaDist <= -0.008) { score += 18; flags.push("below_ema"); }
    else if (f.emaDist <= -0.003) { score += 10; flags.push("mildly_below_ema"); }
    else flags.push("near_or_above_ema");

  } else {
    // zScore stretch above mean  max 40
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
    if (f.emaDist >= 0.015)     { score += 25; flags.push("deeply_above_ema"); }
    else if (f.emaDist >= 0.008){ score += 18; flags.push("above_ema"); }
    else if (f.emaDist >= 0.003){ score += 10; flags.push("mildly_above_ema"); }
    else flags.push("near_or_below_ema");
  }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

//  REV Component 4: Structure Quality (0100) 
// Whether the reversal is at a meaningful structural level, not mid-range noise.
// Checks: EMA slope change, consecutive candle deceleration, BB width (not explosive)
function scoreRevStructureQuality(
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

    // Consecutive deceleration (BUY: should be in downswing but slowing)  max 30
    if (f.consecutive >= -2 && f.consecutive <= 1) { score += 30; flags.push("reversal_zone_candles"); }
    else if (f.consecutive >= -4 && f.consecutive < -2) { score += 20; flags.push("late_downswing"); }
    else if (f.consecutive < -4) { score += 8; flags.push("extended_downswing"); }
    else { score += 18; flags.push("already_recovering"); }

    // BB width: tight = clean structure; very wide = disorderly  max 25
    if (f.bbWidth <= 0.015)      { score += 25; flags.push("tight_bb_structure"); }
    else if (f.bbWidth <= 0.022) { score += 18; flags.push("moderate_bb_structure"); }
    else if (f.bbWidth <= 0.032) { score += 10; flags.push("wider_bb"); }
    else { score += 3; flags.push("wide_disorderly_bb"); }

    // ATR not extreme  max 10
    if (f.atrRank <= 1.0)        { score += 10; flags.push("stable_volatility"); }
    else if (f.atrRank <= 1.3)   { score += 5;  flags.push("moderate_volatility"); }

  } else {
    // EMA slope at or near reversal  max 35
    if (f.emaSlope <= -0.0001)      { score += 35; flags.push("ema_already_turning_down"); }
    else if (f.emaSlope <= 0.0001)  { score += 26; flags.push("ema_neutral"); }
    else if (f.emaSlope <= 0.0004)  { score += 16; flags.push("ema_decelerating_up"); }
    else { score += 6; flags.push("ema_rising"); }

    // Consecutive deceleration (SELL: in upswing but slowing)  max 30
    if (f.consecutive >= -1 && f.consecutive <= 2) { score += 30; flags.push("reversal_zone_candles"); }
    else if (f.consecutive > 2 && f.consecutive <= 4) { score += 20; flags.push("late_upswing"); }
    else if (f.consecutive > 4) { score += 8; flags.push("extended_upswing"); }
    else { score += 18; flags.push("already_declining"); }

    // BB width  max 25
    if (f.bbWidth <= 0.015)      { score += 25; flags.push("tight_bb_structure"); }
    else if (f.bbWidth <= 0.022) { score += 18; flags.push("moderate_bb_structure"); }
    else if (f.bbWidth <= 0.032) { score += 10; flags.push("wider_bb"); }
    else { score += 3; flags.push("wide_disorderly_bb"); }

    // ATR not extreme  max 10
    if (f.atrRank <= 1.0)        { score += 10; flags.push("stable_volatility"); }
    else if (f.atrRank <= 1.3)   { score += 5;  flags.push("moderate_volatility"); }
  }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

//  REV Component 5: Entry Efficiency (0100) 
// How clean and early the entry is relative to the reversal point.
// BUY: close to 30d low; SELL: close to 30d high. Below/above EMA bonus.
function scoreRevEntryEfficiency(
  direction: "buy" | "sell",
  distFromExtreme: number,
  emaDist: number
): { score: number; flags: string[] } {
  const flags: string[] = [];
  const dist = Math.abs(distFromExtreme);

  // Proximity to extreme  max 90
  let score: number;
  if (dist <= 0.005)      { score = 90; flags.push("at_extreme(0.5%)"); }
  else if (dist <= 0.015) { score = 90 - ((dist - 0.005) / 0.01) * 18; flags.push("very_near_extreme(1.5%)"); }
  else if (dist <= 0.04)  { score = 72 - ((dist - 0.015) / 0.025) * 28; flags.push("near_extreme(4%)"); }
  else if (dist <= 0.08)  { score = 44 - ((dist - 0.04) / 0.04) * 20; flags.push("moderate_distance(8%)"); }
  else                    { score = 24; flags.push("late_entry(>8%)"); }

  // EMA alignment bonus  max 10
  if (direction === "buy" && emaDist < -0.005) { score += 10; flags.push("below_ema_bonus"); }
  else if (direction === "sell" && emaDist > 0.005) { score += 10; flags.push("above_ema_bonus"); }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

//  REV Component 6: Expected Move Sufficiency (0100) 
// Whether there is enough runway to justify a real swing trade.
// BUY: runway = distFromRange30dHighPct (how far to 30d high from current price)
// SELL: runway = |distFromRange30dLowPct|
function scoreRevMoveSufficiency(
  direction: "buy" | "sell",
  distToOpposite: number,
  atrRank: number
): { score: number; flags: string[] } {
  const flags: string[] = [];
  const runway = Math.abs(distToOpposite);

  // Runway score  max 80
  let score = clamp(Math.round(runway * 220), 0, 80);
  if (runway >= 0.15)     flags.push("large_runway(15%)");
  else if (runway >= 0.10) flags.push("good_runway(10%)");
  else if (runway >= 0.06) flags.push("moderate_runway(6%)");
  else flags.push("limited_runway(<6%)");

  // ATR expansion bonus  max 20
  if (atrRank >= 1.4)     { score += 20; flags.push("atr_elevated"); }
  else if (atrRank >= 1.1){ score += 12; flags.push("atr_moderate"); }
  else if (atrRank >= 0.8){ score += 5;  flags.push("atr_normal"); }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

//  Reversal Rejection Reason Builder 
function buildReversalRejectionReason(
  cs: Record<string, number>,
  nativeScore: number,
  gateThreshold: number,
  modeMin: number
): string {
  const breakdown = `extreme=${cs.rangeExtremity},reversal=${cs.reversalConfirmation},stretch=${cs.stretchDeviationQuality},structure=${cs.structureQuality},entry=${cs.entryEfficiency},move=${cs.expectedMoveSufficiency}`;
  const weak = Object.entries(cs)
    .filter(([, v]) => v < 55)
    .map(([k, v]) => {
      const label: Record<string, string> = {
        rangeExtremity: "insufficient_range_extremity",
        reversalConfirmation: "insufficient_reversal_confirmation",
        stretchDeviationQuality: "insufficient_stretch_deviation",
        structureQuality: "weak_structure_quality",
        entryEfficiency: "poor_entry_efficiency",
        expectedMoveSufficiency: "insufficient_expected_move",
      };
      return `${label[k] ?? k}(${v}/100)`;
    });
  return (
    `r75_reversal_score_below_mode_threshold:native=${nativeScore}/100,engine_gate=${gateThreshold},mode_min=${modeMin}` +
    ` | breakdown:[${breakdown}]` +
    (weak.length > 0 ? ` | weak=[${weak.join("; ")}]` : "")
  );
}

// 
// r75ReversalEngine  PRIMARY R_75 SETUP
// 

export function r75ReversalEngine(ctx: EngineContext): EngineResult | null {
  const { features: f, operationalRegime, regimeConfidence } = ctx;
  if (f.symbol !== SYMBOL) return null;

  //  Regime filters 
  // BUY reversals blocked in strong established downtrends (trend is still valid)
  // SELL reversals blocked in strong established uptrends
  // Allow in: mean_reversion, ranging, compression, trend_up (for BUY), trend_down (for SELL)

  // Determine candidate direction from extremity
  const buyExtremity  = Math.abs(f.distFromRange30dLowPct);   // small = near 30d low
  const sellExtremity = Math.abs(f.distFromRange30dHighPct);  // small = near 30d high

  // Require at least one side to be near the extreme
  const buyCandidate  = buyExtremity <= 0.12;
  const sellCandidate = sellExtremity <= 0.12;
  if (!buyCandidate && !sellCandidate) return null;

  // Regime-based direction blocking
  const trendUpBlocked   = operationalRegime === "trend_up";   // block SELL in uptrend
  const trendDownBlocked = operationalRegime === "trend_down"; // block BUY in downtrend

  // Choose direction: prefer whichever extreme is closer; apply regime filter
  let direction: "buy" | "sell";
  if (buyExtremity <= sellExtremity) {
    if (trendDownBlocked) {
      // Try SELL as fallback if near high too
      if (sellCandidate && !trendUpBlocked) { direction = "sell"; }
      else return null;
    } else {
      direction = "buy";
    }
  } else {
    if (trendUpBlocked) {
      // Try BUY as fallback if near low too
      if (buyCandidate && !trendDownBlocked) { direction = "buy"; }
      else return null;
    } else {
      direction = "sell";
    }
  }

  const distFromExtreme = direction === "buy" ? f.distFromRange30dLowPct : f.distFromRange30dHighPct;
  const distToOpposite  = direction === "buy" ? f.distFromRange30dHighPct : f.distFromRange30dLowPct;

  //  Score all 6 components 
  const c1 = scoreRevRangeExtremity(distFromExtreme);
  const c2 = scoreRevReversalConfirmation(direction, f);
  const c3 = scoreRevStretchDeviation(direction, f);
  const c4 = scoreRevStructureQuality(direction, f);
  const c5 = scoreRevEntryEfficiency(direction, distFromExtreme, f.emaDist);
  const c6 = scoreRevMoveSufficiency(direction, distToOpposite, f.atrRank);

  const componentScores = {
    rangeExtremity:        c1.score,
    reversalConfirmation:  c2.score,
    stretchDeviationQuality: c3.score,
    structureQuality:      c4.score,
    entryEfficiency:       c5.score,
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
  const gatePassed = nativeScore >= R75_REVERSAL_MIN_GATE;
  const blockReasons: string[] = [];

  if (!gatePassed) {
    blockReasons.push(`native_score_${nativeScore}_below_reversal_gate_${R75_REVERSAL_MIN_GATE}`);
    const weakComponents = Object.entries(componentScores)
      .filter(([, v]) => v < 50)
      .map(([k, v]) => `${k}(${v}/100)`);
    blockReasons.push(...weakComponents);
    return null;
  }

  //  Confidence (direct from native score) 
  const confidence = nativeScore / 100;

  //  RegimeFit (informational  not blended into confidence) 
  let regimeFit = 0.60;
  if (operationalRegime === "mean_reversion" || operationalRegime === "ranging") regimeFit = 0.88;
  else if (operationalRegime === "compression") regimeFit = 0.72;
  else if (operationalRegime === "trend_up" && direction === "sell") regimeFit = 0.50;
  else if (operationalRegime === "trend_down" && direction === "buy") regimeFit = 0.50;

  const setupDetected = direction === "buy"
    ? "reversal_buy_at_30d_range_low"
    : "reversal_sell_at_30d_range_high";

  const structuralContext = `regime=${operationalRegime}(${(regimeConfidence * 100).toFixed(0)}%) | ` +
    `distFromExtreme=${(Math.abs(distFromExtreme) * 100).toFixed(1)}% | ` +
    `zScore=${f.zScore.toFixed(2)} | rsi=${f.rsi14.toFixed(1)} | bbPctB=${f.bbPctB.toFixed(2)}`;

  return {
    valid: true,
    symbol: SYMBOL,
    engineName: "r75_reversal_engine",
    direction,
    confidence,
    regimeFit,
    entryType: "reversal",
    projectedMovePct: R75_REVERSAL_PROJECTED_PCT,
    invalidation: direction === "buy"
      ? f.swingLow * 0.996
      : f.swingHigh * 1.004,
    reason: `r75_reversal_${direction}: native=${nativeScore}/100 | regime=${operationalRegime} | extreme=${(Math.abs(distFromExtreme)*100).toFixed(1)}%`,
    metadata: {
      r75ReversalNativeScore:   nativeScore,
      r75ReversalGatePassed:    gatePassed,
      r75ReversalGateThreshold: R75_REVERSAL_MIN_GATE,
      r75ReversalBlockReasons:  blockReasons,
      setupDetected,
      setupFamily:              "r75_swing_structure",
      componentScores,
      componentFlags: {
        rangeExtremity:         c1.flags,
        reversalConfirmation:   c2.flags,
        stretchDeviationQuality:c3.flags,
        structureQuality:       c4.flags,
        entryEfficiency:        c5.flags,
        expectedMoveSufficiency:c6.flags,
      },
      expectedHoldProfile:        R75_REVERSAL_HOLD,
      tpLogicSummary:             R75_REVERSAL_TP,
      slLogicSummary:             R75_REVERSAL_SL,
      trailingActivationSummary:  R75_REVERSAL_TRAIL,
      structuralContextSummary:   structuralContext,
      buildReversalRejectionReason,
    },
  };
}

// 
// CONTINUATION ENGINE  SECONDARY R_75 SETUP
// 

//  CONT Component 1: Trend Quality (0100) 
// Quality of the established move that makes continuation valid.
function scoreContTrendQuality(
  direction: "buy" | "sell",
  f: { emaSlope: number; rsi14: number; priceVsEma20: number }
): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;

  if (direction === "buy") {
    // EMA slope strength  max 40
    if (f.emaSlope >= 0.0006)       { score += 40; flags.push("strong_up_slope"); }
    else if (f.emaSlope >= 0.0003)  { score += 30; flags.push("good_up_slope"); }
    else if (f.emaSlope >= 0.0001)  { score += 18; flags.push("mild_up_slope"); }
    else { flags.push("flat_slope"); }

    // RSI in trend continuation zone  max 35
    if (f.rsi14 >= 48 && f.rsi14 <= 65)      { score += 35; flags.push("rsi_continuation_zone"); }
    else if (f.rsi14 >= 42 && f.rsi14 <= 72) { score += 22; flags.push("rsi_trend_range"); }
    else if (f.rsi14 < 42) { score += 8; flags.push("rsi_too_low"); }
    else { flags.push("rsi_overbought"); }

    // Price above EMA  max 25
    if (f.priceVsEma20 >= 0.010)    { score += 25; flags.push("well_above_ema"); }
    else if (f.priceVsEma20 >= 0.004){ score += 16; flags.push("above_ema"); }
    else if (f.priceVsEma20 >= 0)   { score += 8;  flags.push("at_ema"); }
    else { flags.push("below_ema"); }

  } else {
    // EMA slope strength (down)  max 40
    if (f.emaSlope <= -0.0006)      { score += 40; flags.push("strong_down_slope"); }
    else if (f.emaSlope <= -0.0003) { score += 30; flags.push("good_down_slope"); }
    else if (f.emaSlope <= -0.0001) { score += 18; flags.push("mild_down_slope"); }
    else { flags.push("flat_slope"); }

    // RSI in downtrend continuation zone  max 35
    if (f.rsi14 >= 35 && f.rsi14 <= 52)      { score += 35; flags.push("rsi_continuation_zone"); }
    else if (f.rsi14 >= 28 && f.rsi14 <= 58) { score += 22; flags.push("rsi_trend_range"); }
    else if (f.rsi14 > 58) { score += 8; flags.push("rsi_too_high"); }
    else { flags.push("rsi_oversold"); }

    // Price below EMA  max 25
    if (f.priceVsEma20 <= -0.010)   { score += 25; flags.push("well_below_ema"); }
    else if (f.priceVsEma20 <= -0.004){ score += 16; flags.push("below_ema"); }
    else if (f.priceVsEma20 <= 0)   { score += 8;  flags.push("at_ema"); }
    else { flags.push("above_ema"); }
  }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

//  CONT Component 2: Pullback Quality (0100) 
// Whether price has pulled back cleanly into a continuation entry zone.
function scoreContPullbackQuality(
  direction: "buy" | "sell",
  f: { bbPctB: number; emaDist: number; zScore: number }
): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;

  if (direction === "buy") {
    // BB position showing pullback (not overbought, not too oversold)  max 35
    if (f.bbPctB >= 0.30 && f.bbPctB <= 0.55)  { score += 35; flags.push("clean_pullback_zone(30-55%)"); }
    else if (f.bbPctB >= 0.20 && f.bbPctB <= 0.65) { score += 22; flags.push("acceptable_pullback(20-65%)"); }
    else if (f.bbPctB < 0.20) { score += 8; flags.push("deep_pullback_zone"); }
    else { flags.push("still_extended"); }

    // EMA proximity  close to EMA is ideal continuation entry  max 40
    const absEma = Math.abs(f.emaDist);
    if (absEma <= 0.004)        { score += 40; flags.push("at_ema_pullback"); }
    else if (absEma <= 0.008)   { score += 28; flags.push("near_ema_pullback"); }
    else if (absEma <= 0.015)   { score += 16; flags.push("moderate_from_ema"); }
    else { score += 5; flags.push("far_from_ema"); }

    // zScore in pullback zone  max 25
    if (f.zScore >= -0.5 && f.zScore <= 0.8)   { score += 25; flags.push("zscore_pullback_zone"); }
    else if (f.zScore >= -1.0 && f.zScore <= 1.2){ score += 15; flags.push("acceptable_zscore"); }
    else { flags.push("zscore_outside_pullback"); }

  } else {
    // BB position (for SELL cont: should rally back toward mid/upper  not extremes)  max 35
    if (f.bbPctB >= 0.45 && f.bbPctB <= 0.70)  { score += 35; flags.push("clean_rally_pullback(45-70%)"); }
    else if (f.bbPctB >= 0.35 && f.bbPctB <= 0.80) { score += 22; flags.push("acceptable_rally(35-80%)"); }
    else if (f.bbPctB > 0.80) { score += 8; flags.push("deep_rally_zone"); }
    else { flags.push("still_compressed"); }

    // EMA proximity  max 40
    const absEma = Math.abs(f.emaDist);
    if (absEma <= 0.004)        { score += 40; flags.push("at_ema_pullback"); }
    else if (absEma <= 0.008)   { score += 28; flags.push("near_ema_pullback"); }
    else if (absEma <= 0.015)   { score += 16; flags.push("moderate_from_ema"); }
    else { score += 5; flags.push("far_from_ema"); }

    // zScore  max 25
    if (f.zScore >= -0.8 && f.zScore <= 0.5)   { score += 25; flags.push("zscore_pullback_zone"); }
    else if (f.zScore >= -1.2 && f.zScore <= 1.0){ score += 15; flags.push("acceptable_zscore"); }
    else { flags.push("zscore_outside_pullback"); }
  }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

//  CONT Component 3: Slope Alignment (0100) 
// Directional alignment and continuation strength.
function scoreContSlopeAlignment(
  direction: "buy" | "sell",
  f: { emaSlope: number; consecutive: number; priceVsEma20: number }
): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;

  if (direction === "buy") {
    // EMA slope aligned up  max 55
    if (f.emaSlope >= 0.0005)       { score += 55; flags.push("strong_upward_slope"); }
    else if (f.emaSlope >= 0.0002)  { score += 40; flags.push("good_upward_slope"); }
    else if (f.emaSlope >= 0.0001)  { score += 25; flags.push("mild_upward_slope"); }
    else if (f.emaSlope >= 0)       { score += 12; flags.push("flat_slope"); }
    else { flags.push("slope_misaligned"); }

    // Consecutive candles (moderate alignment without extremes)  max 30
    if (f.consecutive >= 2 && f.consecutive <= 5) { score += 30; flags.push("good_consecutive_up"); }
    else if (f.consecutive >= 0 && f.consecutive < 2) { score += 18; flags.push("mild_continuation"); }
    else if (f.consecutive > 5) { score += 20; flags.push("extended_consecutive"); }
    else { flags.push("consecutive_misaligned"); }

    // EMA margin  max 15
    if (f.priceVsEma20 >= 0.008)    { score += 15; flags.push("price_above_ema"); }
    else if (f.priceVsEma20 >= 0.002){ score += 8; flags.push("price_near_ema"); }

  } else {
    // EMA slope aligned down  max 55
    if (f.emaSlope <= -0.0005)      { score += 55; flags.push("strong_downward_slope"); }
    else if (f.emaSlope <= -0.0002) { score += 40; flags.push("good_downward_slope"); }
    else if (f.emaSlope <= -0.0001) { score += 25; flags.push("mild_downward_slope"); }
    else if (f.emaSlope <= 0)       { score += 12; flags.push("flat_slope"); }
    else { flags.push("slope_misaligned"); }

    // Consecutive  max 30
    if (f.consecutive <= -2 && f.consecutive >= -5) { score += 30; flags.push("good_consecutive_down"); }
    else if (f.consecutive <= 0 && f.consecutive > -2) { score += 18; flags.push("mild_continuation"); }
    else if (f.consecutive < -5) { score += 20; flags.push("extended_consecutive"); }
    else { flags.push("consecutive_misaligned"); }

    // EMA margin  max 15
    if (f.priceVsEma20 <= -0.008)   { score += 15; flags.push("price_below_ema"); }
    else if (f.priceVsEma20 <= -0.002){ score += 8; flags.push("price_near_ema"); }
  }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

//  CONT Component 4: Structure Continuity (0100) 
// Is the move holding structure  not becoming sloppy or choppy?
function scoreContStructureContinuity(
  f: { zScore: number; atrRank: number; bbWidth: number }
): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;

  // zScore in valid continuation range (not at extremes)  max 40
  const absZ = Math.abs(f.zScore);
  if (absZ <= 1.2)        { score += 40; flags.push("zscore_continuation_range"); }
  else if (absZ <= 1.8)   { score += 26; flags.push("zscore_moderate"); }
  else if (absZ <= 2.3)   { score += 12; flags.push("zscore_approaching_extreme"); }
  else { flags.push("zscore_at_extreme"); }

  // ATR in healthy trend range  max 35
  if (f.atrRank >= 0.75 && f.atrRank <= 1.35) { score += 35; flags.push("healthy_trend_volatility"); }
  else if (f.atrRank >= 0.55 && f.atrRank <= 1.55) { score += 22; flags.push("acceptable_volatility"); }
  else if (f.atrRank < 0.55) { score += 8; flags.push("volatility_too_low"); }
  else { score += 8; flags.push("volatility_too_high"); }

  // BB width  orderly structure  max 25
  if (f.bbWidth >= 0.010 && f.bbWidth <= 0.024) { score += 25; flags.push("orderly_bb_structure"); }
  else if (f.bbWidth >= 0.008 && f.bbWidth <= 0.030) { score += 16; flags.push("acceptable_bb_structure"); }
  else if (f.bbWidth > 0.030) { score += 5; flags.push("wide_bb_chaotic"); }
  else { score += 8; flags.push("compressed_bb"); }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

//  CONT Component 5: Entry Efficiency (0100) 
// Is the continuation entry clean and not a late chase?
function scoreContEntryEfficiency(
  direction: "buy" | "sell",
  f: { emaDist: number; bbPctB: number }
): { score: number; flags: string[] } {
  const flags: string[] = [];

  // Near EMA = ideal continuation entry
  const absEma = Math.abs(f.emaDist);
  let score: number;
  if (absEma <= 0.003)        { score = 88; flags.push("at_ema_clean_entry"); }
  else if (absEma <= 0.008)   { score = 72; flags.push("near_ema_entry"); }
  else if (absEma <= 0.015)   { score = 52; flags.push("moderate_ema_distance"); }
  else { score = 25; flags.push("far_from_ema_late_chase"); }

  // BB position adjustment
  if (direction === "buy" && f.bbPctB >= 0.30 && f.bbPctB <= 0.58) { score += 12; flags.push("bb_pullback_zone"); }
  else if (direction === "sell" && f.bbPctB >= 0.42 && f.bbPctB <= 0.70) { score += 12; flags.push("bb_rally_zone"); }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

//  CONT Component 6: Expected Move Sufficiency (0100) 
// Is there enough continuation runway left for a worthwhile swing?
function scoreContMoveSufficiency(
  direction: "buy" | "sell",
  f: { distFromRange30dHighPct: number; distFromRange30dLowPct: number; atrRank: number }
): { score: number; flags: string[] } {
  const flags: string[] = [];
  // BUY continuation: runway = distance to 30d high
  // SELL continuation: runway = distance to 30d low
  const runway = direction === "buy"
    ? Math.abs(f.distFromRange30dHighPct)
    : Math.abs(f.distFromRange30dLowPct);

  let score = clamp(Math.round(runway * 220), 0, 80);
  if (runway >= 0.12)      flags.push("ample_runway(12%)");
  else if (runway >= 0.07) flags.push("good_runway(7%)");
  else if (runway >= 0.04) flags.push("moderate_runway(4%)");
  else flags.push("limited_runway(<4%)");

  if (f.atrRank >= 1.3)    { score += 20; flags.push("atr_elevated"); }
  else if (f.atrRank >= 1.0){ score += 12; flags.push("atr_normal"); }
  else { score += 4; flags.push("atr_low"); }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

//  Continuation Rejection Reason Builder 
function buildContinuationRejectionReason(
  cs: Record<string, number>,
  nativeScore: number,
  gateThreshold: number,
  modeMin: number
): string {
  const breakdown = `trend=${cs.trendQuality},pullback=${cs.pullbackQuality},slope=${cs.slopeAlignment},structure=${cs.structureContinuity},entry=${cs.entryEfficiency},move=${cs.expectedMoveSufficiency}`;
  const weak = Object.entries(cs)
    .filter(([, v]) => v < 55)
    .map(([k, v]) => {
      const label: Record<string, string> = {
        trendQuality: "weak_trend_quality",
        pullbackQuality: "weak_pullback_quality",
        slopeAlignment: "poor_slope_alignment",
        structureContinuity: "poor_structure_continuity",
        entryEfficiency: "poor_entry_efficiency",
        expectedMoveSufficiency: "insufficient_expected_move",
      };
      return `${label[k] ?? k}(${v}/100)`;
    });
  return (
    `r75_continuation_score_below_mode_threshold:native=${nativeScore}/100,engine_gate=${gateThreshold},mode_min=${modeMin}` +
    ` | breakdown:[${breakdown}]` +
    (weak.length > 0 ? ` | weak=[${weak.join("; ")}]` : "")
  );
}

// 
// r75ContinuationEngine  SECONDARY R_75 SETUP
// 

export function r75ContinuationEngine(ctx: EngineContext): EngineResult | null {
  const { features: f, operationalRegime, regimeConfidence } = ctx;
  if (f.symbol !== SYMBOL) return null;

  //  Regime filter 
  // Continuation requires a clear trend; block in mean_reversion or ranging
  if (operationalRegime === "mean_reversion" || operationalRegime === "ranging") return null;

  //  Direction: must have established trend 
  let direction: "buy" | "sell";
  const trendingUp   = f.emaSlope > 0.0001 && f.priceVsEma20 >= -0.005;
  const trendingDown = f.emaSlope < -0.0001 && f.priceVsEma20 <= 0.005;

  if (trendingUp && (!trendingDown)) {
    direction = "buy";
  } else if (trendingDown && (!trendingUp)) {
    direction = "sell";
  } else if (!trendingUp && !trendingDown) {
    return null;
  } else {
    // Conflict  prefer the stronger slope
    direction = Math.abs(f.emaSlope) > 0 && f.emaSlope > 0 ? "buy" : "sell";
  }

  //  Score all 6 components 
  const c1 = scoreContTrendQuality(direction, f);
  const c2 = scoreContPullbackQuality(direction, f);
  const c3 = scoreContSlopeAlignment(direction, f);
  const c4 = scoreContStructureContinuity(f);
  const c5 = scoreContEntryEfficiency(direction, f);
  const c6 = scoreContMoveSufficiency(direction, f);

  const componentScores = {
    trendQuality:         c1.score,
    pullbackQuality:      c2.score,
    slopeAlignment:       c3.score,
    structureContinuity:  c4.score,
    entryEfficiency:      c5.score,
    expectedMoveSufficiency: c6.score,
  };

  const nativeScore = Math.round(
    c1.score * W_CONT_TREND_QUALITY +
    c2.score * W_CONT_PULLBACK      +
    c3.score * W_CONT_SLOPE_ALIGN   +
    c4.score * W_CONT_STRUCT_CONT   +
    c5.score * W_CONT_ENTRY_EFF     +
    c6.score * W_CONT_MOVE_SUFF
  );

  //  Engine-native gate 
  const gatePassed = nativeScore >= R75_CONTINUATION_MIN_GATE;
  const blockReasons: string[] = [];

  if (!gatePassed) {
    blockReasons.push(`native_score_${nativeScore}_below_continuation_gate_${R75_CONTINUATION_MIN_GATE}`);
    return null;
  }

  const confidence = nativeScore / 100;

  let regimeFit = 0.65;
  if (direction === "buy" && operationalRegime === "trend_up")   regimeFit = 0.88;
  if (direction === "sell" && operationalRegime === "trend_down") regimeFit = 0.88;
  if (operationalRegime === "breakout_expansion") regimeFit = 0.80;

  const setupDetected = direction === "buy"
    ? "continuation_buy_in_established_uptrend"
    : "continuation_sell_in_established_downtrend";

  const structuralContext = `regime=${operationalRegime}(${(regimeConfidence * 100).toFixed(0)}%) | ` +
    `emaSlope=${f.emaSlope.toFixed(5)} | rsi=${f.rsi14.toFixed(1)} | bbPctB=${f.bbPctB.toFixed(2)} | emaDist=${f.emaDist.toFixed(4)}`;

  return {
    valid: true,
    symbol: SYMBOL,
    engineName: "r75_continuation_engine",
    direction,
    confidence,
    regimeFit,
    entryType: "continuation",
    projectedMovePct: R75_CONTINUATION_PROJECTED_PCT,
    invalidation: direction === "buy"
      ? f.swingLow * 0.997
      : f.swingHigh * 1.003,
    reason: `r75_continuation_${direction}: native=${nativeScore}/100 | regime=${operationalRegime} | emaSlope=${f.emaSlope.toFixed(5)}`,
    metadata: {
      r75ContinuationNativeScore:   nativeScore,
      r75ContinuationGatePassed:    gatePassed,
      r75ContinuationGateThreshold: R75_CONTINUATION_MIN_GATE,
      r75ContinuationBlockReasons:  blockReasons,
      setupDetected,
      setupFamily:                  "r75_swing_structure",
      componentScores,
      componentFlags: {
        trendQuality:        c1.flags,
        pullbackQuality:     c2.flags,
        slopeAlignment:      c3.flags,
        structureContinuity: c4.flags,
        entryEfficiency:     c5.flags,
        expectedMoveSufficiency: c6.flags,
      },
      expectedHoldProfile:       R75_CONTINUATION_HOLD,
      tpLogicSummary:            R75_CONT_TP,
      slLogicSummary:            R75_CONT_SL,
      trailingActivationSummary: R75_CONT_TRAIL,
      structuralContextSummary:  structuralContext,
      buildContinuationRejectionReason,
    },
  };
}

// 
// BREAKOUT ENGINE  TERTIARY R_75 SETUP
// 

//  BRK Component 1: Boundary Pressure (0100) 
// Quality of repeated tests / pressure against the meaningful level before the break.
function scoreBrkBoundaryPressure(
  direction: "buy" | "sell",
  f: { distFromRange30dHighPct: number; distFromRange30dLowPct: number; bbPctB: number }
): { score: number; flags: string[] } {
  const flags: string[] = [];

  const dist = direction === "buy"
    ? Math.abs(f.distFromRange30dHighPct)   // near top = BUY breakout
    : Math.abs(f.distFromRange30dLowPct);   // near bottom = SELL breakout

  // Proximity to boundary  max 80
  let score: number;
  if (dist <= 0.005)      { score = 80; flags.push("at_boundary(0.5%)"); }
  else if (dist <= 0.015) { score = 80 - ((dist - 0.005) / 0.01) * 22; flags.push("very_near_boundary(1.5%)"); }
  else if (dist <= 0.03)  { score = 58 - ((dist - 0.015) / 0.015) * 18; flags.push("near_boundary(3%)"); }
  else if (dist <= 0.06)  { score = 40 - ((dist - 0.03) / 0.03) * 20; flags.push("approaching_boundary(6%)"); }
  else                    { score = 20; flags.push("far_from_boundary(>6%)"); }

  // BB edge confirmation  max 20
  if (direction === "buy" && f.bbPctB >= 0.88)  { score += 20; flags.push("bb_upper_confirming"); }
  else if (direction === "sell" && f.bbPctB <= 0.12) { score += 20; flags.push("bb_lower_confirming"); }
  else if (direction === "buy" && f.bbPctB >= 0.75)  { score += 10; flags.push("bb_upper_zone"); }
  else if (direction === "sell" && f.bbPctB <= 0.25) { score += 10; flags.push("bb_lower_zone"); }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

//  BRK Component 2: Break Strength (0100) 
// Actual breakout strength  decisive movement beyond the level.
function scoreBrkBreakStrength(
  direction: "buy" | "sell",
  f: {
    swingBreached: boolean; swingBreachDirection: string | null;
    emaSlope: number; candleBody: number; consecutive: number;
  }
): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;

  // Swing breach  max 50
  const breachAligned = f.swingBreached &&
    ((direction === "buy" && f.swingBreachDirection === "above") ||
     (direction === "sell" && f.swingBreachDirection === "below"));
  if (breachAligned) { score += 50; flags.push("swing_breach_confirmed"); }
  else { flags.push("no_swing_breach"); }

  // EMA slope in direction  max 30
  if (direction === "buy") {
    if (f.emaSlope >= 0.0006)      { score += 30; flags.push("strong_up_slope"); }
    else if (f.emaSlope >= 0.0003) { score += 20; flags.push("good_up_slope"); }
    else if (f.emaSlope >= 0.0001) { score += 10; flags.push("mild_up_slope"); }
    else { flags.push("weak_slope"); }
  } else {
    if (f.emaSlope <= -0.0006)     { score += 30; flags.push("strong_down_slope"); }
    else if (f.emaSlope <= -0.0003){ score += 20; flags.push("good_down_slope"); }
    else if (f.emaSlope <= -0.0001){ score += 10; flags.push("mild_down_slope"); }
    else { flags.push("weak_slope"); }
  }

  // Breakout candle body  max 25 (strong directional candle)
  if (f.candleBody >= 0.65)       { score += 25; flags.push("strong_breakout_candle"); }
  else if (f.candleBody >= 0.40)  { score += 16; flags.push("moderate_breakout_candle"); }
  else if (f.candleBody >= 0.20)  { score += 8;  flags.push("weak_breakout_candle"); }
  else { flags.push("no_breakout_candle"); }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

//  BRK Component 3: Expansion Quality (0100) 
// Volatility/range expansion supporting the breakout.
function scoreBrkExpansionQuality(
  f: { bbWidthRoc: number; atrAccel: number; atrRank: number }
): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;

  // BB width expansion  max 50
  if (f.bbWidthRoc >= 0.10)       { score += 50; flags.push("strong_bb_expansion"); }
  else if (f.bbWidthRoc >= 0.06)  { score += 38; flags.push("good_bb_expansion"); }
  else if (f.bbWidthRoc >= 0.03)  { score += 24; flags.push("moderate_bb_expansion"); }
  else if (f.bbWidthRoc >= 0.01)  { score += 12; flags.push("mild_bb_expansion"); }
  else { flags.push("no_bb_expansion"); }

  // ATR acceleration  max 35
  if (f.atrAccel >= 0.08)         { score += 35; flags.push("strong_atr_accel"); }
  else if (f.atrAccel >= 0.04)    { score += 24; flags.push("good_atr_accel"); }
  else if (f.atrAccel >= 0.015)   { score += 14; flags.push("mild_atr_accel"); }
  else { flags.push("weak_atr_accel"); }

  // ATR rank confirming elevated volatility  max 15
  if (f.atrRank >= 1.3)           { score += 15; flags.push("elevated_atr_rank"); }
  else if (f.atrRank >= 1.1)      { score += 8;  flags.push("moderate_atr_rank"); }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

//  BRK Component 4: Retest / Acceptance Quality (0100) 
// Whether price accepts beyond the broken level or immediately rejects.
function scoreBrkRetestAcceptance(
  direction: "buy" | "sell",
  f: { priceVsEma20: number; emaDist: number; consecutive: number }
): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;

  if (direction === "buy") {
    // Price holding above EMA  max 45
    if (f.priceVsEma20 >= 0.020)    { score += 45; flags.push("strong_acceptance_above_ema"); }
    else if (f.priceVsEma20 >= 0.010){ score += 32; flags.push("good_acceptance"); }
    else if (f.priceVsEma20 >= 0.002){ score += 18; flags.push("mild_acceptance"); }
    else { flags.push("weak_acceptance"); }

    // EMA distance above  max 30
    if (f.emaDist >= 0.015)          { score += 30; flags.push("well_above_ema"); }
    else if (f.emaDist >= 0.008)     { score += 20; flags.push("above_ema"); }
    else if (f.emaDist >= 0.002)     { score += 10; flags.push("mildly_above_ema"); }
    else { flags.push("not_above_ema"); }

    // Consecutive up bars  max 25
    if (f.consecutive >= 3)          { score += 25; flags.push("holding_breakout"); }
    else if (f.consecutive >= 1)     { score += 15; flags.push("early_acceptance"); }
    else { flags.push("no_consecutive_confirmation"); }

  } else {
    // Price holding below EMA  max 45
    if (f.priceVsEma20 <= -0.020)   { score += 45; flags.push("strong_acceptance_below_ema"); }
    else if (f.priceVsEma20 <= -0.010){ score += 32; flags.push("good_acceptance"); }
    else if (f.priceVsEma20 <= -0.002){ score += 18; flags.push("mild_acceptance"); }
    else { flags.push("weak_acceptance"); }

    // EMA distance below  max 30
    if (f.emaDist <= -0.015)         { score += 30; flags.push("well_below_ema"); }
    else if (f.emaDist <= -0.008)    { score += 20; flags.push("below_ema"); }
    else if (f.emaDist <= -0.002)    { score += 10; flags.push("mildly_below_ema"); }
    else { flags.push("not_below_ema"); }

    // Consecutive down bars  max 25
    if (f.consecutive <= -3)         { score += 25; flags.push("holding_breakdown"); }
    else if (f.consecutive <= -1)    { score += 15; flags.push("early_acceptance"); }
    else { flags.push("no_consecutive_confirmation"); }
  }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

//  BRK Component 5: Entry Efficiency (0100) 
// Early breakout entry or clean retest entry  not a late chase.
function scoreBrkEntryEfficiency(
  direction: "buy" | "sell",
  f: { distFromRange30dHighPct: number; distFromRange30dLowPct: number; emaDist: number }
): { score: number; flags: string[] } {
  const flags: string[] = [];
  const dist = direction === "buy"
    ? Math.abs(f.distFromRange30dHighPct)
    : Math.abs(f.distFromRange30dLowPct);

  // Proximity to breakout boundary  max 90
  let score: number;
  if (dist <= 0.008)       { score = 88; flags.push("at_breakout_boundary"); }
  else if (dist <= 0.020)  { score = 88 - ((dist - 0.008) / 0.012) * 20; flags.push("near_breakout(2%)"); }
  else if (dist <= 0.04)   { score = 68 - ((dist - 0.020) / 0.02) * 26; flags.push("moderate_distance(4%)"); }
  else                     { score = 42; flags.push("late_breakout_entry(>4%)"); }

  // EMA alignment bonus  max 10
  if (direction === "buy" && f.emaDist >= 0.003)  { score += 10; flags.push("above_ema_confirming"); }
  else if (direction === "sell" && f.emaDist <= -0.003) { score += 10; flags.push("below_ema_confirming"); }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

//  BRK Component 6: Expected Move Sufficiency (0100) 
// Enough room remains for a worthwhile swing capture beyond the range.
function scoreBrkMoveSufficiency(
  direction: "buy" | "sell",
  f: { distFromRange30dHighPct: number; distFromRange30dLowPct: number; atrRank: number }
): { score: number; flags: string[] } {
  const flags: string[] = [];
  // Full range width as potential breakout move (both sides of range)
  const fullRangeWidth = Math.abs(f.distFromRange30dHighPct) + Math.abs(f.distFromRange30dLowPct);
  let score = clamp(Math.round(fullRangeWidth * 180), 0, 80);

  if (fullRangeWidth >= 0.25)  flags.push("wide_range(25%)");
  else if (fullRangeWidth >= 0.15) flags.push("good_range(15%)");
  else if (fullRangeWidth >= 0.08) flags.push("moderate_range(8%)");
  else flags.push("narrow_range(<8%)");

  if (f.atrRank >= 1.3)    { score += 20; flags.push("atr_elevated"); }
  else if (f.atrRank >= 1.0){ score += 12; flags.push("atr_normal"); }
  else { score += 4; flags.push("atr_low"); }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

//  Breakout Rejection Reason Builder 
function buildBreakoutRejectionReason(
  cs: Record<string, number>,
  nativeScore: number,
  gateThreshold: number,
  modeMin: number
): string {
  const breakdown = `pressure=${cs.boundaryPressure},break=${cs.breakStrength},expand=${cs.expansionQuality},retest=${cs.retestAcceptanceQuality},entry=${cs.entryEfficiency},move=${cs.expectedMoveSufficiency}`;
  const weak = Object.entries(cs)
    .filter(([, v]) => v < 55)
    .map(([k, v]) => {
      const label: Record<string, string> = {
        boundaryPressure: "weak_boundary_pressure",
        breakStrength: "insufficient_break_strength",
        expansionQuality: "insufficient_expansion_quality",
        retestAcceptanceQuality: "weak_retest_acceptance",
        entryEfficiency: "poor_entry_efficiency",
        expectedMoveSufficiency: "insufficient_expected_move",
      };
      return `${label[k] ?? k}(${v}/100)`;
    });
  return (
    `r75_breakout_score_below_mode_threshold:native=${nativeScore}/100,engine_gate=${gateThreshold},mode_min=${modeMin}` +
    ` | breakdown:[${breakdown}]` +
    (weak.length > 0 ? ` | weak=[${weak.join("; ")}]` : "")
  );
}

// 
// r75BreakoutEngine  TERTIARY R_75 SETUP
// 

export function r75BreakoutEngine(ctx: EngineContext): EngineResult | null {
  const { features: f, operationalRegime, regimeConfidence } = ctx;
  if (f.symbol !== SYMBOL) return null;

  //  Regime filter 
  // Breakouts are unreliable in mean_reversion and ranging regimes
  if (operationalRegime === "mean_reversion" || operationalRegime === "ranging") return null;

  //  Direction: require expansion or clear trend, plus boundary approach 
  const nearHigh = Math.abs(f.distFromRange30dHighPct) <= 0.06;
  const nearLow  = Math.abs(f.distFromRange30dLowPct)  <= 0.06;
  if (!nearHigh && !nearLow) return null;

  // Require some expansion signal (BB width or ATR)
  const expandingBB  = f.bbWidthRoc >= 0.015;
  const expandingATR = f.atrAccel >= 0.01;
  if (!expandingBB && !expandingATR) return null;

  let direction: "buy" | "sell";
  if (nearHigh && f.emaSlope >= 0) {
    direction = "buy";
  } else if (nearLow && f.emaSlope <= 0) {
    direction = "sell";
  } else if (f.swingBreached && f.swingBreachDirection === "above") {
    direction = "buy";
  } else if (f.swingBreached && f.swingBreachDirection === "below") {
    direction = "sell";
  } else if (nearHigh && !nearLow) {
    direction = "buy";
  } else if (nearLow && !nearHigh) {
    direction = "sell";
  } else {
    direction = f.emaSlope >= 0 ? "buy" : "sell";
  }

  //  Score all 6 components 
  const c1 = scoreBrkBoundaryPressure(direction, f);
  const c2 = scoreBrkBreakStrength(direction, f);
  const c3 = scoreBrkExpansionQuality(f);
  const c4 = scoreBrkRetestAcceptance(direction, f);
  const c5 = scoreBrkEntryEfficiency(direction, f);
  const c6 = scoreBrkMoveSufficiency(direction, f);

  const componentScores = {
    boundaryPressure:         c1.score,
    breakStrength:            c2.score,
    expansionQuality:         c3.score,
    retestAcceptanceQuality:  c4.score,
    entryEfficiency:          c5.score,
    expectedMoveSufficiency:  c6.score,
  };

  const nativeScore = Math.round(
    c1.score * W_BRK_BOUNDARY       +
    c2.score * W_BRK_BREAK_STRENGTH +
    c3.score * W_BRK_EXPANSION      +
    c4.score * W_BRK_RETEST         +
    c5.score * W_BRK_ENTRY_EFF      +
    c6.score * W_BRK_MOVE_SUFF
  );

  //  Engine-native gate 
  const gatePassed = nativeScore >= R75_BREAKOUT_MIN_GATE;
  const blockReasons: string[] = [];

  if (!gatePassed) {
    blockReasons.push(`native_score_${nativeScore}_below_breakout_gate_${R75_BREAKOUT_MIN_GATE}`);
    return null;
  }

  const confidence = nativeScore / 100;

  let regimeFit = 0.65;
  if (operationalRegime === "breakout_expansion") regimeFit = 0.92;
  else if (operationalRegime === "compression")  regimeFit = 0.82;
  else if (operationalRegime === "trend_up" || operationalRegime === "trend_down") regimeFit = 0.72;

  const setupDetected = direction === "buy"
    ? "breakout_buy_above_30d_range_high"
    : "breakout_sell_below_30d_range_low";

  const structuralContext = `regime=${operationalRegime}(${(regimeConfidence * 100).toFixed(0)}%) | ` +
    `bbWidthRoc=${f.bbWidthRoc.toFixed(3)} | atrAccel=${f.atrAccel.toFixed(3)} | atrRank=${f.atrRank.toFixed(2)} | swingBreach=${f.swingBreached}`;

  return {
    valid: true,
    symbol: SYMBOL,
    engineName: "r75_breakout_engine",
    direction,
    confidence,
    regimeFit,
    entryType: "breakout",
    projectedMovePct: R75_BREAKOUT_PROJECTED_PCT,
    invalidation: direction === "buy"
      ? f.swingLow * 0.997
      : f.swingHigh * 1.003,
    reason: `r75_breakout_${direction}: native=${nativeScore}/100 | regime=${operationalRegime} | breach=${f.swingBreached}`,
    metadata: {
      r75BreakoutNativeScore:   nativeScore,
      r75BreakoutGatePassed:    gatePassed,
      r75BreakoutGateThreshold: R75_BREAKOUT_MIN_GATE,
      r75BreakoutBlockReasons:  blockReasons,
      setupDetected,
      setupFamily:              "r75_swing_structure",
      componentScores,
      componentFlags: {
        boundaryPressure:        c1.flags,
        breakStrength:           c2.flags,
        expansionQuality:        c3.flags,
        retestAcceptanceQuality: c4.flags,
        entryEfficiency:         c5.flags,
        expectedMoveSufficiency: c6.flags,
      },
      expectedHoldProfile:       R75_BREAKOUT_HOLD,
      tpLogicSummary:            R75_BRK_TP,
      slLogicSummary:            R75_BRK_SL,
      trailingActivationSummary: R75_BRK_TRAIL,
      structuralContextSummary:  structuralContext,
      buildBreakoutRejectionReason,
    },
  };
}
