/**
 * BOOM300 Engine — Native Scoring, Gating & Decision Explanation
 *
 * Primary setup: SELL after boom spike-cluster exhaustion / swing-high stretch
 * Secondary setup: BUY after prolonged drift-down exhaustion (low-hazard reversal)
 *
 * ── BOOM300 behavior ──────────────────────────────────────────────────────────
 * - Boom spikes push price UP in sharp impulses
 * - Between spikes: sustained downward drift (the natural gravity)
 * - SELL opportunity: after spike cluster exhausts and price is extended near swing high
 * - BUY opportunity: after prolonged drift-down when spike hazard is minimal
 *
 * ── Scoring architecture ─────────────────────────────────────────────────────
 * 6 BOOM300-native scoring components, each scored 0–100:
 *   1. Spike Cluster Pressure     (25%) — spike energy behind the move
 *   2. Upside Displacement        (20%) — how elevated price is vs structural high
 *   3. Exhaustion Evidence        (20%) — signs upside momentum is fading
 *   4. Drift Resumption Quality   (15%) — early signals the drift is re-asserting
 *   5. Entry Efficiency           (10%) — entry location quality vs swing high
 *   6. Expected Move Sufficiency  (10%) — remaining downside runway justifies the hold
 *
 * ── Gate ─────────────────────────────────────────────────────────────────────
 * BOOM300_SELL_MIN_GATE: engine-native minimum before forwarding to allocator
 * BOOM300_BUY_MIN_GATE:  engine-native minimum for buy setups
 * These replace the inherited generic V2 composite threshold as the PRIMARY gate.
 * The allocator's mode-level confidence check (paper≥0.60 / demo≥0.65 / real≥0.70)
 * remains as the SECONDARY gate applied after engine acceptance.
 *
 * ── Calibration ──────────────────────────────────────────────────────────────
 * Based on 296,376 cleaned BOOM300 candles (0 duplicates, 28 interpolated).
 * All constants are named and documented for future recalibration.
 */

import type { EngineContext, EngineResult } from "../engineTypes.js";

const ENGINE_NAME = "boom_expansion_engine";
const ENGINE_NAME_LONG = "boom_expansion_long_engine";
const SYMBOL = "BOOM300";

// ── Projected move calibration (6-month empirical, BOOM300 only) ─────────────
const BOOM300_SELL_PROJECTED_PCT = 0.257;   // median downside capture after SELL signal
const BOOM300_BUY_PROJECTED_PCT  = 0.302;   // median upside capture after BUY signal

// ── BOOM300-native engine gates ───────────────────────────────────────────────
// These are the PRIMARY pass thresholds — engine-native and BOOM300-specific.
// Do NOT confuse with the global min_composite_score from settings (which is secondary).
// Recalibrate by adjusting these constants based on live performance data.
const BOOM300_SELL_MIN_GATE = 55;  // native score 0-100; below this → no signal forwarded
const BOOM300_BUY_MIN_GATE  = 50;  // buy setups allowed at slightly lower threshold
const BOOM300_LONG_BUY_MIN_GATE = 52;

// ── Component weights ─────────────────────────────────────────────────────────
// Must sum to 1.0. Adjust here for recalibration.
const W_SPIKE_CLUSTER    = 0.25;
const W_UPSIDE_DISP      = 0.20;
const W_EXHAUSTION       = 0.20;
const W_DRIFT_RESUMPTION = 0.15;
const W_ENTRY_EFFICIENCY = 0.10;
const W_MOVE_SUFFICIENCY = 0.10;

// ── Expected hold profile ─────────────────────────────────────────────────────
const BOOM300_SELL_HOLD_PROFILE = "2–8 days | trailing activation at 15% move | max 21d";
const BOOM300_BUY_HOLD_PROFILE  = "3–10 days | trailing activation at 18% move | max 21d";

// ── TP / SL logic summaries ───────────────────────────────────────────────────
const BOOM300_SELL_TP_LOGIC = "Primary TP: 25.7% below entry (empirical median BOOM300 drift). Stage 1: 12%, Stage 2: 20%, Stage 3: 25.7%. Trail from 15%.";
const BOOM300_BUY_TP_LOGIC  = "Primary TP: 30.2% above entry. Stage 1: 15%, Stage 2: 22%, Stage 3: 30.2%. Trail from 18%.";
const BOOM300_SELL_SL_LOGIC = "SL above most recent swing high + 0.5% buffer. Tightens to breakeven after 8% move.";
const BOOM300_BUY_SL_LOGIC  = "SL below 30d range low + 0.5% buffer. Tightens to breakeven after 10% move.";
const BOOM300_SELL_TRAIL    = "Trailing stop activates at 15% unrealised gain. Initial trail 8%, tightens to 5% above 20%.";
const BOOM300_BUY_TRAIL     = "Trailing stop activates at 18% unrealised gain. Initial trail 10%, tightens to 6% above 22%.";

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function resolveBoom300RuntimeGates(
  ctx: EngineContext,
  baseSellGate: number,
  baseBuyGate: number,
): { sellGate: number; buyGate: number; calibrated: boolean; sourceRunId: number | null } {
  const paperGate = Number(ctx.runtimeCalibration?.recommendedScoreGates?.paper ?? NaN);
  if (!Number.isFinite(paperGate)) {
    return {
      sellGate: baseSellGate,
      buyGate: baseBuyGate,
      calibrated: false,
      sourceRunId: null,
    };
  }

  // Blend profile gate into engine-native gates conservatively.
  const sellGate = clamp(Math.round(baseSellGate * 0.7 + paperGate * 0.3), 45, 90);
  const buyGate = clamp(Math.round(baseBuyGate * 0.6 + paperGate * 0.4), 45, 90);
  return {
    sellGate,
    buyGate,
    calibrated: true,
    sourceRunId: ctx.runtimeCalibration?.sourceRunId ?? null,
  };
}

// ── Component 1: Spike Cluster Pressure (0–100) ───────────────────────────────
// Measures how much boom-spike energy drove the recent upside move.
// High score: recent spike cluster at elevated hazard level.
// Low score:  no recent spikes or hazard decayed — upside may be drift-driven.
function scoreSpikeClusterPressure(f: {
  spikeHazardScore: number;
  runLengthSinceSpike: number;
}): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;

  // Base: spike hazard scale (0–1) → maps to 0–55
  const hazardBase = f.spikeHazardScore * 55;
  score += hazardBase;
  if (f.spikeHazardScore >= 0.70) flags.push("extreme_hazard");
  else if (f.spikeHazardScore >= 0.55) flags.push("high_hazard");
  else if (f.spikeHazardScore >= 0.40) flags.push("moderate_hazard");
  else flags.push("low_hazard");

  // Recency bonus: more recent spike = stronger cluster signal
  if (f.runLengthSinceSpike <= 5)        { score += 35; flags.push("fresh_spike(≤5)"); }
  else if (f.runLengthSinceSpike <= 15)  { score += 25; flags.push("very_recent_spike(≤15)"); }
  else if (f.runLengthSinceSpike <= 30)  { score += 15; flags.push("recent_spike(≤30)"); }
  else if (f.runLengthSinceSpike <= 60)  { score += 5;  flags.push("aging_spike(≤60)"); }
  else flags.push("stale_spike(>60)");

  // Cluster confirmation bonus: high hazard + recent = confirmed cluster
  if (f.spikeHazardScore >= 0.55 && f.runLengthSinceSpike <= 20) {
    score += 15;
    flags.push("cluster_confirmed");
  }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

// ── Component 2: Upside Displacement / Swing-High Stretch (0–100) ─────────────
// Measures how extended price is above its natural level and into a swing high.
// High score: price near 30d high, BB upper pressure, RSI overbought.
// Low score:  price in mid-range or below median — not a good SELL location.
function scoreUpsideDisplacement(f: {
  distFromRange30dHighPct: number;
  bbPctB: number;
  rsi14: number;
}): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;

  // Range proximity score (closer to 30d high = better for SELL)
  const dist = Math.abs(f.distFromRange30dHighPct);
  if (dist <= 0.03)       { score += 50; flags.push("at_range_top(≤3%)"); }
  else if (dist <= 0.07)  { score += 40; flags.push("near_range_top(≤7%)"); }
  else if (dist <= 0.12)  { score += 28; flags.push("approaching_top(≤12%)"); }
  else if (dist <= 0.18)  { score += 16; flags.push("mid_range(≤18%)"); }
  else if (dist <= 0.25)  { score += 8;  flags.push("lower_mid(≤25%)"); }
  else                    { score += 2;  flags.push("far_from_top(>25%)"); }

  // BB upper pressure (bbPctB 0-1 scale, >0.8 = near upper band)
  const bbScore = clamp(f.bbPctB * 30, 0, 30);
  score += bbScore;
  if (f.bbPctB >= 0.85) flags.push("bb_upper_breach");
  else if (f.bbPctB >= 0.70) flags.push("bb_upper_approach");
  else flags.push("bb_mid_lower");

  // RSI overbought confirmation
  if (f.rsi14 >= 75)      { score += 20; flags.push("rsi_extreme_overbought(≥75)"); }
  else if (f.rsi14 >= 65) { score += 13; flags.push("rsi_overbought(≥65)"); }
  else if (f.rsi14 >= 58) { score += 7;  flags.push("rsi_elevated(≥58)"); }
  else flags.push("rsi_not_overbought");

  return { score: clamp(Math.round(score), 0, 100), flags };
}

// ── Component 3: Exhaustion Evidence (0–100) ──────────────────────────────────
// Signs that the spike-driven upside move is running out of energy.
// High score: EMA slope turning negative, bearish candle body, momentum decelerating.
// Low score:  strong continuing upside momentum — not exhausted yet.
//
// Field notes (from FeatureVector):
//   candleBody   = |open-close| / (high-low), always 0-1 (fraction of range that is body)
//   latestClose  = last tick/candle close price
//   latestOpen   = last candle open price
//   emaSlope     = change in EMA per tick (negative = EMA bending down)
function scoreExhaustionEvidence(f: {
  emaSlope: number;
  latestClose: number;
  latestOpen: number;
  candleBody: number;  // |body|/range, always 0-1
}): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;

  // EMA slope turning: negative slope = exhaustion starting
  if (f.emaSlope <= -0.0006)      { score += 50; flags.push("ema_slope_strongly_neg"); }
  else if (f.emaSlope <= -0.0003) { score += 40; flags.push("ema_slope_moderately_neg"); }
  else if (f.emaSlope <= -0.0001) { score += 28; flags.push("ema_slope_weakly_neg"); }
  else if (f.emaSlope < 0)        { score += 15; flags.push("ema_slope_just_neg"); }
  else if (f.emaSlope <= 0.0002)  { score += 5;  flags.push("ema_slope_flat"); }
  else                            { score += 0;  flags.push("ema_slope_still_positive"); }

  // Bearish candle evidence — direction from close vs open
  const isBearish = f.latestClose < f.latestOpen;
  const bodyRatio = f.candleBody; // already |body|/range

  if (isBearish && bodyRatio >= 0.6) {
    score += 35; flags.push("strong_bearish_candle(body≥60%)");
  } else if (isBearish && bodyRatio >= 0.35) {
    score += 25; flags.push("bearish_candle(body≥35%)");
  } else if (isBearish) {
    score += 12; flags.push("weak_bearish_candle");
  } else {
    score += 0; flags.push("bullish_candle_no_exhaustion");
  }

  // Small body = indecision / exhaustion (even if not bearish)
  if (bodyRatio < 0.15) {
    score += 10; flags.push("indecision_doji");
  }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

// ── Component 4: Drift Resumption Quality (0–100) ─────────────────────────────
// Evidence that BOOM300's natural downward drift is reasserting after the spike.
// High score: BB width compressing after spike expansion, ATR decelerating, price at EMA.
// Low score:  BB still expanding, ATR still accelerating — drift not yet resumed.
function scoreDriftResuption(f: {
  emaDist: number;
  bbWidthRoc: number;
  atrAccel: number;
  atrRank: number;
}): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 30; // base — always some drift tendency in BOOM300

  // EMA distance: price above EMA (positive emaDist) means spike drove price up,
  // price should now drift back toward EMA — good drift resumption setup
  if (f.emaDist > 0.015)      { score += 25; flags.push("price_extended_above_ema"); }
  else if (f.emaDist > 0.005) { score += 15; flags.push("price_above_ema"); }
  else if (f.emaDist > 0)     { score += 8;  flags.push("price_just_above_ema"); }
  else                        { score -= 5;  flags.push("price_below_ema_no_drift_signal"); }

  // BB width Rate of Change: negative = compressing after expansion = post-spike signature
  if (f.bbWidthRoc < -0.10)       { score += 25; flags.push("bb_strongly_compressing"); }
  else if (f.bbWidthRoc < -0.04)  { score += 18; flags.push("bb_compressing"); }
  else if (f.bbWidthRoc < 0)      { score += 8;  flags.push("bb_slightly_compressing"); }
  else if (f.bbWidthRoc < 0.05)   { score += 0;  flags.push("bb_flat"); }
  else                            { score -= 8;  flags.push("bb_still_expanding"); }

  // ATR deceleration: ATR slowing = impulse fading = drift re-establishing
  if (f.atrAccel < -0.08)      { score += 20; flags.push("atr_strongly_decelerating"); }
  else if (f.atrAccel < -0.03) { score += 12; flags.push("atr_decelerating"); }
  else if (f.atrAccel < 0)     { score += 5;  flags.push("atr_slightly_decelerating"); }
  else                         { score -= 5;  flags.push("atr_still_accelerating"); }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

// ── Component 5: Entry Efficiency (0–100) ─────────────────────────────────────
// How close to the optimal SELL entry location relative to the swing high.
// High score: entering very close to swing high — maximum downside capture.
// Low score:  entering too far below the swing high — missed the best entry.
function scoreEntryEfficiency(f: {
  distFromRange30dHighPct: number;
  emaDist: number;
}): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;

  const dist = Math.abs(f.distFromRange30dHighPct);

  if (dist <= 0.02)       { score = 90; flags.push("ideal_entry(≤2%_from_top)"); }
  else if (dist <= 0.05)  { score = 75; flags.push("excellent_entry(≤5%)"); }
  else if (dist <= 0.09)  { score = 58; flags.push("good_entry(≤9%)"); }
  else if (dist <= 0.14)  { score = 40; flags.push("acceptable_entry(≤14%)"); }
  else if (dist <= 0.22)  { score = 22; flags.push("late_entry(≤22%)"); }
  else                    { score = 8;  flags.push("very_late_entry(>22%)"); }

  // Bonus: price above EMA means spike inflated price = real entry near actual high
  if (f.emaDist > 0.008) { score = Math.min(100, score + 10); flags.push("above_ema_bonus"); }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

// ── Component 6: Expected Move Sufficiency (0–100) ────────────────────────────
// Does the remaining downside runway justify the long-hold approach?
// High score: large distance from current price to 30d low, high ATR rank.
// Low score:  price is already near the 30d low — insufficient runway remaining.
function scoreExpectedMoveSufficiency(f: {
  distFromRange30dLowPct: number;
  atrRank: number;
}): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;

  // Distance to 30d low = available downside runway
  const downside = Math.abs(f.distFromRange30dLowPct);
  const distScore = clamp(downside * 220, 0, 70);
  score += distScore;

  if (downside >= 0.25)      flags.push("large_runway(≥25%)");
  else if (downside >= 0.15) flags.push("adequate_runway(≥15%)");
  else if (downside >= 0.08) flags.push("modest_runway(≥8%)");
  else                       flags.push("insufficient_runway(<8%)");

  // Volatility rank bonus: higher ATR rank = BOOM300 is active = move likely substantial
  if (f.atrRank >= 1.3)      { score += 25; flags.push("high_volatility_rank"); }
  else if (f.atrRank >= 1.0) { score += 15; flags.push("normal_volatility_rank"); }
  else if (f.atrRank >= 0.7) { score += 8;  flags.push("below_avg_volatility"); }
  else                       { score += 0;  flags.push("low_volatility_rank"); }

  // Minimum runway guard: if less than 8% runway, cap the score severely
  if (downside < 0.08) {
    score = Math.min(score, 30);
    flags.push("runway_cap_applied");
  }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

// ── Buy-side mirror components (simplified) ───────────────────────────────────
function scoreBuyDisplacementDown(f: {
  distFromRange30dLowPct: number;
  bbPctB: number;
  rsi14: number;
}): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;
  const dist = Math.abs(f.distFromRange30dLowPct);

  if (dist <= 0.03)      { score += 50; flags.push("at_range_bottom(≤3%)"); }
  else if (dist <= 0.07) { score += 40; flags.push("near_range_bottom(≤7%)"); }
  else if (dist <= 0.12) { score += 28; flags.push("approaching_bottom(≤12%)"); }
  else if (dist <= 0.18) { score += 16; flags.push("mid_range(≤18%)"); }
  else                   { score += 5;  flags.push("far_from_bottom(>18%)"); }

  score += clamp((1 - f.bbPctB) * 30, 0, 30);
  if (f.bbPctB <= 0.15) flags.push("bb_lower_breach");

  if (f.rsi14 <= 25)      { score += 20; flags.push("rsi_extreme_oversold(≤25)"); }
  else if (f.rsi14 <= 38) { score += 13; flags.push("rsi_oversold(≤38)"); }
  else if (f.rsi14 <= 45) { score += 6;  flags.push("rsi_low(≤45)"); }
  else flags.push("rsi_not_oversold");

  return { score: clamp(Math.round(score), 0, 100), flags };
}

function scoreLowSpikeHazard(f: {
  spikeHazardScore: number;
  runLengthSinceSpike: number;
}): { score: number; flags: string[] } {
  const flags: string[] = [];
  // For BUY: want LOW spike hazard (no recent spikes that would push price up then spike away)
  const hazardInverse = (1 - f.spikeHazardScore) * 60;
  let score = hazardInverse;
  if (f.spikeHazardScore <= 0.25) { score += 30; flags.push("minimal_spike_hazard"); }
  else if (f.spikeHazardScore <= 0.40) { score += 15; flags.push("low_spike_hazard"); }
  else if (f.spikeHazardScore <= 0.55) { score += 0; flags.push("moderate_hazard"); }
  else { score -= 20; flags.push("high_spike_hazard_buySetupRisk"); }

  if (f.runLengthSinceSpike >= 100) { score += 20; flags.push("long_since_spike(≥100)"); }
  else if (f.runLengthSinceSpike >= 60) { score += 10; flags.push("moderate_since_spike(≥60)"); }
  else if (f.runLengthSinceSpike < 30) { score -= 15; flags.push("recent_spike_buy_risk"); }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

function scoreLongMomentumConfirmation(f: {
  emaSlope: number;
  bbWidthRoc: number;
  atrAccel: number;
  latestClose: number;
  latestOpen: number;
}): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;

  if (f.emaSlope >= 0.0004)      { score += 35; flags.push("ema_slope_strongly_pos"); }
  else if (f.emaSlope >= 0.0002) { score += 28; flags.push("ema_slope_pos"); }
  else if (f.emaSlope > 0)       { score += 18; flags.push("ema_slope_weakly_pos"); }
  else                           { score += 2;  flags.push("ema_slope_not_supportive"); }

  if (f.bbWidthRoc > 0.04)       { score += 25; flags.push("bb_expanding"); }
  else if (f.bbWidthRoc > 0)     { score += 15; flags.push("bb_slightly_expanding"); }
  else                           { score += 5;  flags.push("bb_not_expanding"); }

  if (f.atrAccel > 0.03)         { score += 20; flags.push("atr_accelerating"); }
  else if (f.atrAccel > 0)       { score += 10; flags.push("atr_slightly_accelerating"); }
  else                           { score += 4;  flags.push("atr_flat_or_decelerating"); }

  if (f.latestClose > f.latestOpen) {
    score += 20;
    flags.push("bullish_confirmation_candle");
  } else {
    flags.push("no_bullish_confirmation");
  }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

// ── Main engine function ──────────────────────────────────────────────────────

export interface Boom300NativeScoreBreakdown {
  engineScore: number;
  direction: "sell" | "buy";
  setupDetected: string;
  setupFamily: string;
  componentScores: {
    spikeClusterPressure: number;
    upsideDisplacement: number;
    exhaustionEvidence: number;
    driftResumption: number;
    entryEfficiency: number;
    expectedMoveSufficiency: number;
  };
  componentFlags: Record<string, string[]>;
  gatePassed: boolean;
  gateThreshold: number;
  gateReason: string;
  blockReasons: string[];
  expectedMovePct: number;
  expectedHoldProfile: string;
  tpLogicSummary: string;
  slLogicSummary: string;
  trailingActivationSummary: string;
  structuralContextSummary: string;
}

export function boom300Engine(ctx: EngineContext): EngineResult | null {
  const { features, operationalRegime, regimeConfidence } = ctx;
  const f = features;

  if (f.symbol !== SYMBOL && !f.symbol.startsWith("BOOM")) return null;

  const symbol = f.symbol;

  // ── Regime pre-filter ─────────────────────────────────────────────────────
  // no_trade and trend_down are incompatible with SELL.
  // BUY is allowed in boom_expansion regimes because long-expansion opportunities
  // are now covered explicitly and should not be structurally blocked here.
  const regimeBlocksSell = operationalRegime === "trend_down" || operationalRegime === "no_trade";
  const regimeBlocksBuy  = operationalRegime === "no_trade";
  const gateCfg = resolveBoom300RuntimeGates(ctx, BOOM300_SELL_MIN_GATE, BOOM300_BUY_MIN_GATE);

  // ── Compute SELL components ────────────────────────────────────────────────
  const c1_spike  = scoreSpikeClusterPressure({ spikeHazardScore: f.spikeHazardScore, runLengthSinceSpike: f.runLengthSinceSpike });
  const c2_disp   = scoreUpsideDisplacement({ distFromRange30dHighPct: f.distFromRange30dHighPct, bbPctB: f.bbPctB, rsi14: f.rsi14 });
  const c3_exhaust = scoreExhaustionEvidence({ emaSlope: f.emaSlope, latestClose: f.latestClose, latestOpen: f.latestOpen, candleBody: f.candleBody });
  const c4_drift  = scoreDriftResuption({ emaDist: f.emaDist, bbWidthRoc: f.bbWidthRoc, atrAccel: f.atrAccel, atrRank: f.atrRank });
  const c5_entry  = scoreEntryEfficiency({ distFromRange30dHighPct: f.distFromRange30dHighPct, emaDist: f.emaDist });
  const c6_move   = scoreExpectedMoveSufficiency({ distFromRange30dLowPct: f.distFromRange30dLowPct, atrRank: f.atrRank });

  const sellNativeScore = Math.round(
    c1_spike.score  * W_SPIKE_CLUSTER    +
    c2_disp.score   * W_UPSIDE_DISP      +
    c3_exhaust.score * W_EXHAUSTION      +
    c4_drift.score  * W_DRIFT_RESUMPTION +
    c5_entry.score  * W_ENTRY_EFFICIENCY +
    c6_move.score   * W_MOVE_SUFFICIENCY
  );

  // ── Compute BUY components ────────────────────────────────────────────────
  const b1_lowHazard = scoreLowSpikeHazard({ spikeHazardScore: f.spikeHazardScore, runLengthSinceSpike: f.runLengthSinceSpike });
  const b2_dispDown  = scoreBuyDisplacementDown({ distFromRange30dLowPct: f.distFromRange30dLowPct, bbPctB: f.bbPctB, rsi14: f.rsi14 });
  const b3_exhaust   = scoreExhaustionEvidence({ emaSlope: Math.abs(f.emaSlope), latestClose: f.latestOpen, latestOpen: f.latestClose, candleBody: f.candleBody });
  const b4_drift     = scoreDriftResuption({ emaDist: -f.emaDist, bbWidthRoc: f.bbWidthRoc, atrAccel: f.atrAccel, atrRank: f.atrRank });
  const b5_entry     = scoreEntryEfficiency({ distFromRange30dHighPct: f.distFromRange30dLowPct, emaDist: -f.emaDist });
  const b6_move      = scoreExpectedMoveSufficiency({ distFromRange30dLowPct: f.distFromRange30dHighPct, atrRank: f.atrRank });

  const buyNativeScore = Math.round(
    b1_lowHazard.score * W_SPIKE_CLUSTER    +
    b2_dispDown.score  * W_UPSIDE_DISP      +
    b3_exhaust.score   * W_EXHAUSTION       +
    b4_drift.score     * W_DRIFT_RESUMPTION +
    b5_entry.score     * W_ENTRY_EFFICIENCY +
    b6_move.score      * W_MOVE_SUFFICIENCY
  );

  // ── Direction selection ───────────────────────────────────────────────────
  let direction: "sell" | "buy";
  let nativeScore: number;
  let minGate: number;
  let components: { c1: typeof c1_spike; c2: typeof c2_disp; c3: typeof c3_exhaust; c4: typeof c4_drift; c5: typeof c5_entry; c6: typeof c6_move };
  let projectedMovePct: number;
  let invalidation: number;
  let holdProfile: string;
  let tpLogic: string;
  let slLogic: string;
  let trailLogic: string;
  let setupLabel: string;

  const sellViable = sellNativeScore >= gateCfg.sellGate && !regimeBlocksSell;
  const buyViable  = buyNativeScore  >= gateCfg.buyGate  && !regimeBlocksBuy;

  if (sellViable && (!buyViable || sellNativeScore >= buyNativeScore)) {
    direction      = "sell";
    nativeScore    = sellNativeScore;
    minGate        = gateCfg.sellGate;
    components     = { c1: c1_spike, c2: c2_disp, c3: c3_exhaust, c4: c4_drift, c5: c5_entry, c6: c6_move };
    projectedMovePct = BOOM300_SELL_PROJECTED_PCT;
    invalidation   = f.swingHigh * 1.005;
    holdProfile    = BOOM300_SELL_HOLD_PROFILE;
    tpLogic        = BOOM300_SELL_TP_LOGIC;
    slLogic        = BOOM300_SELL_SL_LOGIC;
    trailLogic     = BOOM300_SELL_TRAIL;
    setupLabel     = "sell_after_spike_cluster_exhaustion";
  } else if (buyViable) {
    direction      = "buy";
    nativeScore    = buyNativeScore;
    minGate        = gateCfg.buyGate;
    components     = { c1: b1_lowHazard, c2: b2_dispDown, c3: b3_exhaust, c4: b4_drift, c5: b5_entry, c6: b6_move };
    projectedMovePct = BOOM300_BUY_PROJECTED_PCT;
    invalidation   = f.swingLow * 0.995;
    holdProfile    = BOOM300_BUY_HOLD_PROFILE;
    tpLogic        = BOOM300_BUY_TP_LOGIC;
    slLogic        = BOOM300_BUY_SL_LOGIC;
    trailLogic     = BOOM300_BUY_TRAIL;
    setupLabel     = "buy_after_drift_exhaustion_low_hazard";
  } else {
    // Neither setup meets the BOOM300-native gate — no signal
    return null;
  }

  // ── BOOM300-native regime modifier ────────────────────────────────────────
  let regimeFit = 0.55; // neutral baseline
  if (direction === "sell") {
    if (operationalRegime === "boom_expansion" || operationalRegime === "breakout_expansion") regimeFit = 0.85;
    else if (operationalRegime === "spike_zone") regimeFit = 0.80;
    else if (operationalRegime === "trend_up")   regimeFit = 0.65;
    else if (operationalRegime === "ranging")    regimeFit = 0.58;
  } else {
    if (operationalRegime === "trend_down" || operationalRegime === "mean_reversion") regimeFit = 0.82;
    else if (operationalRegime === "ranging" || operationalRegime === "compression") regimeFit = 0.68;
  }

  // ── Final confidence: BOOM300 native score maps 1:1 to confidence ──────────
  // confidence = nativeScore / 100 (direct mapping)
  // The allocator's mode-level gate (paper≥0.60 / demo≥0.65 / real≥0.70) is
  // applied as the SECONDARY gate after the engine's own native gate passes.
  // Regime fit is used only for direction selection and reason logging — it does
  // NOT reduce confidence here (it was already the engine gate criteria above).
  const confidence = clamp(nativeScore / 100, 0, 0.98);

  // ── Block reason analysis ─────────────────────────────────────────────────
  const blockReasons: string[] = [];
  if (direction === "sell") {
    if (c1_spike.score  < 40) blockReasons.push(`insufficient_spike_cluster_pressure(${c1_spike.score}/100)`);
    if (c2_disp.score   < 40) blockReasons.push(`insufficient_upside_displacement(${c2_disp.score}/100)`);
    if (c3_exhaust.score < 35) blockReasons.push(`insufficient_exhaustion_evidence(${c3_exhaust.score}/100)`);
    if (c4_drift.score  < 30) blockReasons.push(`drift_not_yet_resuming(${c4_drift.score}/100)`);
    if (c5_entry.score  < 30) blockReasons.push(`entry_too_late(${c5_entry.score}/100)`);
    if (c6_move.score   < 30) blockReasons.push(`expected_move_insufficient(${c6_move.score}/100)`);
  } else {
    if (b1_lowHazard.score < 40) blockReasons.push(`spike_hazard_still_elevated(${b1_lowHazard.score}/100)`);
    if (b2_dispDown.score  < 40) blockReasons.push(`price_not_near_range_low(${b2_dispDown.score}/100)`);
    if (b3_exhaust.score   < 30) blockReasons.push(`drift_exhaustion_not_confirmed(${b3_exhaust.score}/100)`);
  }

  // ── Structural context summary ────────────────────────────────────────────
  const structuralContext = [
    `BOOM300 ${direction.toUpperCase()} | native_score=${nativeScore}/100 | regime=${operationalRegime}(${(regimeConfidence * 100).toFixed(0)}%)`,
    `price_dist_from_30d_high=${(f.distFromRange30dHighPct * 100).toFixed(1)}% | dist_from_30d_low=${(f.distFromRange30dLowPct * 100).toFixed(1)}%`,
    `spikeHazard=${f.spikeHazardScore.toFixed(2)} | runLengthSinceSpike=${f.runLengthSinceSpike} | rsi14=${f.rsi14.toFixed(1)}`,
    `emaSlope=${f.emaSlope.toFixed(5)} | bbPctB=${f.bbPctB.toFixed(2)} | atrRank=${f.atrRank.toFixed(2)}`,
  ].join(" | ");

  // ── Assemble native score breakdown ──────────────────────────────────────
  const nativeBreakdown: Boom300NativeScoreBreakdown = {
    engineScore: nativeScore,
    direction,
    setupDetected: setupLabel,
    setupFamily: "boom300_spike_cluster",
    componentScores: {
      spikeClusterPressure:    components.c1.score,
      upsideDisplacement:      components.c2.score,
      exhaustionEvidence:      components.c3.score,
      driftResumption:         components.c4.score,
      entryEfficiency:         components.c5.score,
      expectedMoveSufficiency: components.c6.score,
    },
    componentFlags: {
      spikeClusterPressure:    components.c1.flags,
      upsideDisplacement:      components.c2.flags,
      exhaustionEvidence:      components.c3.flags,
      driftResumption:         components.c4.flags,
      entryEfficiency:         components.c5.flags,
      expectedMoveSufficiency: components.c6.flags,
    },
    gatePassed: true, // reached this point = passed engine-native gate
    gateThreshold: minGate,
    gateReason: `native_score ${nativeScore} ≥ BOOM300_MIN_GATE ${minGate}`,
    blockReasons,
    expectedMovePct: projectedMovePct,
    expectedHoldProfile: holdProfile,
    tpLogicSummary: tpLogic,
    slLogicSummary: slLogic,
    trailingActivationSummary: trailLogic,
    structuralContextSummary: structuralContext,
  };

  return {
    valid: true,
    symbol,
    engineName: ENGINE_NAME,
    direction,
    confidence,
    regimeFit,
    entryType: "expansion",
    projectedMovePct,
    invalidation,
    reason: `BOOM300 ${direction} | native=${nativeScore}/100 | gate=${minGate} | ` +
      `spike=${components.c1.score} disp=${components.c2.score} exhaust=${components.c3.score} ` +
      `drift=${components.c4.score} entry=${components.c5.score} move=${components.c6.score} | ` +
      `regime=${operationalRegime}(fit=${regimeFit.toFixed(2)})` +
      (blockReasons.length > 0 ? ` | weakComponents=[${blockReasons.join(", ")}]` : ""),
    metadata: {
      boom300: nativeBreakdown,
      // Flat aliases for easy access in allocator/scheduler
      boom300NativeScore: nativeScore,
      boom300GatePassed: true,
      boom300GateThreshold: minGate,
      boom300BlockReasons: blockReasons,
      boom300RuntimeCalibrationApplied: gateCfg.calibrated,
      boom300RuntimeCalibrationRunId: gateCfg.sourceRunId,
      setupDetected: nativeBreakdown.setupDetected,
      setupFamily: nativeBreakdown.setupFamily,
      componentScores: nativeBreakdown.componentScores,
      expectedHoldProfile: holdProfile,
      tpLogicSummary: tpLogic,
      slLogicSummary: slLogic,
      structuralContextSummary: structuralContext,
    },
  };
}

export function boom300LongExpansionEngine(ctx: EngineContext): EngineResult | null {
  const { features, operationalRegime, regimeConfidence } = ctx;
  const f = features;
  if (f.symbol !== SYMBOL && !f.symbol.startsWith("BOOM")) return null;

  const regimeBlocked = operationalRegime === "no_trade" || operationalRegime === "trend_down";
  const gateCfg = resolveBoom300RuntimeGates(ctx, BOOM300_SELL_MIN_GATE, BOOM300_LONG_BUY_MIN_GATE);

  const c1_lowHazard = scoreLowSpikeHazard({
    spikeHazardScore: f.spikeHazardScore,
    runLengthSinceSpike: f.runLengthSinceSpike,
  });
  const c2_displacement = scoreBuyDisplacementDown({
    distFromRange30dLowPct: f.distFromRange30dLowPct,
    bbPctB: f.bbPctB,
    rsi14: f.rsi14,
  });
  const c3_momentum = scoreLongMomentumConfirmation({
    emaSlope: f.emaSlope,
    bbWidthRoc: f.bbWidthRoc,
    atrAccel: f.atrAccel,
    latestClose: f.latestClose,
    latestOpen: f.latestOpen,
  });
  const c4_structure = scoreDriftResuption({
    emaDist: -f.emaDist,
    bbWidthRoc: f.bbWidthRoc,
    atrAccel: f.atrAccel,
    atrRank: f.atrRank,
  });
  const c5_entry = scoreEntryEfficiency({
    distFromRange30dHighPct: f.distFromRange30dLowPct,
    emaDist: -f.emaDist,
  });
  const c6_move = scoreExpectedMoveSufficiency({
    distFromRange30dLowPct: f.distFromRange30dHighPct,
    atrRank: f.atrRank,
  });

  const nativeScore = Math.round(
    c1_lowHazard.score * W_SPIKE_CLUSTER +
    c2_displacement.score * W_UPSIDE_DISP +
    c3_momentum.score * W_EXHAUSTION +
    c4_structure.score * W_DRIFT_RESUMPTION +
    c5_entry.score * W_ENTRY_EFFICIENCY +
    c6_move.score * W_MOVE_SUFFICIENCY
  );

  const minGate = gateCfg.buyGate;
  if (regimeBlocked || nativeScore < minGate) return null;

  let regimeFit = 0.6;
  if (operationalRegime === "boom_expansion" || operationalRegime === "breakout_expansion") regimeFit = 0.9;
  else if (operationalRegime === "spike_zone") regimeFit = 0.82;
  else if (operationalRegime === "trend_up") regimeFit = 0.74;
  else if (operationalRegime === "ranging" || operationalRegime === "compression") regimeFit = 0.66;

  const confidence = clamp(nativeScore / 100, 0, 0.98);
  const invalidation = f.swingLow * 0.995;
  const blockReasons: string[] = [];
  if (c1_lowHazard.score < 40) blockReasons.push(`spike_hazard_still_elevated(${c1_lowHazard.score}/100)`);
  if (c2_displacement.score < 40) blockReasons.push(`price_not_near_range_low(${c2_displacement.score}/100)`);
  if (c3_momentum.score < 35) blockReasons.push(`momentum_confirmation_weak(${c3_momentum.score}/100)`);
  if (c4_structure.score < 30) blockReasons.push(`structure_not_supportive(${c4_structure.score}/100)`);

  return {
    valid: true,
    symbol: f.symbol,
    engineName: ENGINE_NAME_LONG,
    direction: "buy",
    confidence,
    regimeFit,
    entryType: "expansion",
    projectedMovePct: BOOM300_BUY_PROJECTED_PCT,
    invalidation,
    reason:
      `BOOM300 buy_long_expansion | native=${nativeScore}/100 | gate=${minGate} | ` +
      `hazard=${c1_lowHazard.score} disp=${c2_displacement.score} momentum=${c3_momentum.score} ` +
      `structure=${c4_structure.score} entry=${c5_entry.score} move=${c6_move.score} | ` +
      `regime=${operationalRegime}(fit=${regimeFit.toFixed(2)})`,
    metadata: {
      boom300Long: true,
      boom300NativeScore: nativeScore,
      boom300GatePassed: true,
      boom300GateThreshold: minGate,
      boom300BlockReasons: blockReasons,
      boom300RuntimeCalibrationApplied: gateCfg.calibrated,
      boom300RuntimeCalibrationRunId: gateCfg.sourceRunId,
      setupDetected: "buy_long_expansion",
      setupFamily: "boom300_long_expansion",
      componentScores: {
        spikeClusterPressure: c1_lowHazard.score,
        upsideDisplacement: c2_displacement.score,
        exhaustionEvidence: c3_momentum.score,
        driftResumption: c4_structure.score,
        entryEfficiency: c5_entry.score,
        expectedMoveSufficiency: c6_move.score,
      },
      expectedHoldProfile: BOOM300_BUY_HOLD_PROFILE,
      tpLogicSummary: BOOM300_BUY_TP_LOGIC,
      slLogicSummary: BOOM300_BUY_SL_LOGIC,
    },
  };
}
