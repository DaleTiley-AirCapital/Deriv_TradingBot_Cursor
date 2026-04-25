/**
 * CRASH300 Engine — Native Scoring, Gating & Decision Explanation
 *
 * Primary setup:   BUY after crash-spike-cluster / swing-low exhaustion / reversal
 * Secondary setup: SELL after extended rally / exhaustion cascade from swing high
 *
 * ── CRASH300 behavior ─────────────────────────────────────────────────────────
 * - Crash spikes push price DOWN in sharp impulses (opposite of BOOM300)
 * - Swing-low structure:
 *     crash spike clusters → 24h decline 5–14% → reversal UP 25–176%
 * - Swing-high structure:
 *     7d rally 8–21% → 14–23 crash spikes in 7d while price still recovers
 *     → downside exhaustion cascade 21–62%
 *
 * ── Scoring architecture ──────────────────────────────────────────────────────
 * 6 CRASH300-native scoring components, each scored 0–100:
 *   1. Crash Spike Cluster Pressure   (25%) — crash-spike energy driving price to low
 *   2. Downside Displacement          (20%) — how stretched price is into the lower zone
 *   3. Exhaustion / Reversal Evidence (20%) — signs the downward push is exhausting
 *   4. Recovery Quality               (15%) — quality of upward rebound after the low
 *   5. Entry Efficiency               (10%) — entry location vs swing low / swing high
 *   6. Expected Move Sufficiency      (10%) — remaining upside / downside runway
 *
 * ── Gate ─────────────────────────────────────────────────────────────────────
 * CRASH300_BUY_MIN_GATE:  primary engine gate (BUY = primary setup)
 * CRASH300_SELL_MIN_GATE: secondary engine gate (SELL = secondary)
 * These replace the inherited generic V2 composite threshold as the PRIMARY gate.
 * The allocator's mode-level confidence check (paper≥0.60 / demo≥0.65 / real≥0.70)
 * remains as the SECONDARY gate applied after engine acceptance.
 *
 * ── Calibration ──────────────────────────────────────────────────────────────
 * Based on 296,367 cleaned CRASH300 candles (0 duplicates, 28 interpolated).
 * All constants are named and documented for future recalibration.
 */

import type { EngineContext, EngineResult } from "../engineTypes.js";

const BUY_ENGINE_NAME = "crash_expansion_engine";
const SELL_ENGINE_NAME = "crash_expansion_short_engine";
const SYMBOL = "CRASH300";

// ── Projected move calibration (6-month empirical, CRASH300 only) ─────────────
const CRASH300_BUY_PROJECTED_PCT  = 0.421;  // median upside capture after BUY reversal signal
const CRASH300_SELL_PROJECTED_PCT = 0.290;  // median downside capture after SELL exhaustion signal

// ── CRASH300-native engine gates ──────────────────────────────────────────────
// These are the PRIMARY pass thresholds — engine-native and CRASH300-specific.
// Do NOT confuse with the global min_composite_score from settings (which is secondary).
// BUY requires stronger case as it is the primary setup.
const CRASH300_BUY_MIN_GATE  = 55;  // native score 0-100; BUY is primary, requires stronger case
const CRASH300_SELL_MIN_GATE = 50;  // SELL is secondary, allowed at slightly lower threshold

// ── Component weights ─────────────────────────────────────────────────────────
// Must sum to 1.0. Adjust here for recalibration.
const W_CRASH_SPIKE_CLUSTER = 0.25;
const W_DOWNSIDE_DISP       = 0.20;
const W_EXHAUSTION_REVERSAL = 0.20;
const W_RECOVERY_QUALITY    = 0.15;
const W_ENTRY_EFFICIENCY    = 0.10;
const W_MOVE_SUFFICIENCY    = 0.10;

// ── Expected hold profile ─────────────────────────────────────────────────────
const CRASH300_BUY_HOLD_PROFILE  = "3–12 days | trailing activation at 20% move | max 21d";
const CRASH300_SELL_HOLD_PROFILE = "2–8 days | trailing activation at 15% move | max 21d";

// ── TP / SL logic summaries ───────────────────────────────────────────────────
const CRASH300_BUY_TP_LOGIC  = "Primary TP: 42.1% above entry (empirical CRASH300 swing-low reversal). Stage 1: 15%, Stage 2: 25%, Stage 3: 42.1%. Trail from 20%.";
const CRASH300_SELL_TP_LOGIC = "Primary TP: 29% below entry. Stage 1: 12%, Stage 2: 20%, Stage 3: 29%. Trail from 15%.";
const CRASH300_BUY_SL_LOGIC  = "SL below 30d range low + 0.5% buffer. Tightens to breakeven after 12% move.";
const CRASH300_SELL_SL_LOGIC = "SL above most recent swing high + 0.5% buffer. Tightens to breakeven after 8% move.";
const CRASH300_BUY_TRAIL     = "Trailing stop activates at 20% unrealised gain. Initial trail 10%, tightens to 6% above 25%.";
const CRASH300_SELL_TRAIL    = "Trailing stop activates at 15% unrealised gain. Initial trail 8%, tightens to 5% above 20%.";

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

type CrashWeightSet = {
  cluster: number;
  displacement: number;
  exhaustion: number;
  recovery: number;
  entry: number;
  move: number;
};

type ComponentScore = { score: number; flags: string[] };

type ComponentSet = {
  c1: ComponentScore;
  c2: ComponentScore;
  c3: ComponentScore;
  c4: ComponentScore;
  c5: ComponentScore;
  c6: ComponentScore;
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function asFinite(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function getCrashEngineOverride(ctx: EngineContext, engineName: string): Record<string, unknown> {
  const root = asRecord(ctx.runtimeCalibration?.formulaOverride);
  const engines = asRecord(root.engines);
  return asRecord(engines[engineName] ?? root[engineName]);
}

function resolveCrashWeights(ctx: EngineContext, engineName: string): CrashWeightSet {
  const fallback: CrashWeightSet = {
    cluster: W_CRASH_SPIKE_CLUSTER,
    displacement: W_DOWNSIDE_DISP,
    exhaustion: W_EXHAUSTION_REVERSAL,
    recovery: W_RECOVERY_QUALITY,
    entry: W_ENTRY_EFFICIENCY,
    move: W_MOVE_SUFFICIENCY,
  };
  const engineOverride = getCrashEngineOverride(ctx, engineName);
  const w = asRecord(engineOverride.weights);
  if (Object.keys(w).length === 0) return fallback;

  const cluster = asFinite(w.crashSpikeClusterPressure ?? w.cluster) ?? fallback.cluster;
  const displacement = asFinite(w.downsideDisplacement ?? w.displacement) ?? fallback.displacement;
  const exhaustion = asFinite(w.exhaustionReversalEvidence ?? w.exhaustion) ?? fallback.exhaustion;
  const recovery = asFinite(w.recoveryQuality ?? w.recovery) ?? fallback.recovery;
  const entry = asFinite(w.entryEfficiency ?? w.entry) ?? fallback.entry;
  const move = asFinite(w.expectedMoveSufficiency ?? w.move) ?? fallback.move;
  const sum = cluster + displacement + exhaustion + recovery + entry + move;
  if (!Number.isFinite(sum) || sum <= 0) return fallback;

  return {
    cluster: cluster / sum,
    displacement: displacement / sum,
    exhaustion: exhaustion / sum,
    recovery: recovery / sum,
    entry: entry / sum,
    move: move / sum,
  };
}

function scoreThreshold(bands: Array<[boolean, number, string]>): ComponentScore {
  const match = bands.find(([passed]) => passed) ?? bands[bands.length - 1];
  return {
    score: clamp(Math.round(match?.[1] ?? 0), 0, 100),
    flags: [match?.[2] ?? "no_calibrated_band_match"],
  };
}

function scoreVolatilityExpansionFit(f: EngineContext["features"]): ComponentScore {
  const score = clamp(
    Math.round(
      (Math.min(1.4, Math.max(0, f.atrRank)) / 1.4) * 45 +
      (Math.min(0.018, Math.max(0, f.bbWidth)) / 0.018) * 35 +
      (f.bbWidthRoc > 0 ? 20 : f.atrAccel > 0 ? 12 : 4),
    ),
    0,
    100,
  );
  return {
    score,
    flags: [
      `atr_rank=${f.atrRank.toFixed(2)}`,
      `bb_width=${(f.bbWidth * 100).toFixed(2)}pct`,
      f.bbWidthRoc > 0 ? "bb_width_expanding" : "bb_width_not_expanding",
    ],
  };
}

function scoreBuyCalibratedSpikeRecoveryFit(f: EngineContext["features"]): ComponentScore {
  const spikeScore = Math.max(
    f.spikeCount4h >= 7 ? 100 : f.spikeCount4h >= 5 ? 90 : f.spikeCount4h >= 3 ? 78 : f.spikeCount4h >= 1 ? 55 : 25,
    f.spikeCount24h >= 7 ? 95 : f.spikeCount24h >= 4 ? 82 : f.spikeCount24h >= 2 ? 60 : 25,
  );
  const exhaustionBonus = f.priceChange24hPct <= -0.04 ? 10 : f.priceChange24hPct <= -0.015 ? 5 : 0;
  return {
    score: clamp(spikeScore + exhaustionBonus, 0, 100),
    flags: [
      `spikes4h=${f.spikeCount4h}`,
      `spikes24h=${f.spikeCount24h}`,
      `change24h=${(f.priceChange24hPct * 100).toFixed(2)}pct`,
    ],
  };
}

function scoreBuyCalibratedRangePosition(f: EngineContext["features"]): ComponentScore {
  return scoreThreshold([
    [f.distFromRange30dLowPct <= 0.05, 96, "within_5pct_of_30d_low"],
    [f.distFromRange30dLowPct <= 0.10, 86, "within_10pct_of_30d_low"],
    [f.distFromRange30dLowPct <= 0.18, 72, "within_18pct_of_30d_low"],
    [f.distFromRange30dLowPct <= 0.30, 58, "within_30pct_of_30d_low"],
    [true, 32, "too_far_from_30d_low"],
  ]);
}

function scoreBuyCalibratedDevelopmentFit(f: EngineContext["features"]): ComponentScore {
  return scoreThreshold([
    [f.priceChange24hPct <= -0.04 && f.priceChange7dPct <= -0.04, 96, "crash_cluster_decline_developed"],
    [f.priceChange24hPct <= -0.015 || f.priceChange7dPct <= -0.05, 82, "controlled_decline_into_setup"],
    [f.priceChange24hPct <= 0.008 && f.distFromRange30dLowPct <= 0.12, 68, "near_low_without_large_decline"],
    [true, 38, "development_window_not_crash_like"],
  ]);
}

function scoreBuyCalibratedTriggerFit(f: EngineContext["features"]): ComponentScore {
  const reclaim = f.priceVsEma20 >= -0.01 ? 20 : 0;
  const slope = f.emaSlope > 0.00015 ? 40 : f.emaSlope > -0.00015 ? 28 : 8;
  const candle = f.latestClose > f.latestOpen ? 25 : 5;
  const rsi = f.rsi14 >= 30 && f.rsi14 <= 72 ? 15 : 4;
  return {
    score: clamp(slope + reclaim + candle + rsi, 0, 100),
    flags: [
      `ema_slope=${f.emaSlope.toFixed(6)}`,
      `price_vs_ema20=${(f.priceVsEma20 * 100).toFixed(2)}pct`,
      f.latestClose > f.latestOpen ? "reversal_candle_up" : "no_reversal_candle",
      `rsi=${f.rsi14.toFixed(1)}`,
    ],
  };
}

function scoreBuyCalibratedRunwayFit(f: EngineContext["features"]): ComponentScore {
  const upsideRunway = Math.abs(f.distFromRange30dHighPct);
  return scoreThreshold([
    [upsideRunway >= 0.18, 96, "large_upside_runway_to_30d_high"],
    [upsideRunway >= 0.10, 82, "healthy_upside_runway"],
    [upsideRunway >= 0.05, 64, "limited_but_usable_upside_runway"],
    [true, 35, "insufficient_upside_runway"],
  ]);
}

function scoreSellCalibratedSpikeExhaustionFit(f: EngineContext["features"]): ComponentScore {
  const spikeScore = f.spikeCount7d >= 18 ? 100 : f.spikeCount7d >= 10 ? 88 : f.spikeCount24h >= 4 ? 70 : 35;
  const rallyBonus = f.priceChange7dPct >= 0.06 ? 10 : f.priceChange24hPct >= 0.02 ? 5 : 0;
  return {
    score: clamp(spikeScore + rallyBonus, 0, 100),
    flags: [
      `spikes7d=${f.spikeCount7d}`,
      `spikes24h=${f.spikeCount24h}`,
      `change7d=${(f.priceChange7dPct * 100).toFixed(2)}pct`,
    ],
  };
}

function scoreSellCalibratedRangePosition(f: EngineContext["features"]): ComponentScore {
  const nearHigh = Math.abs(f.distFromRange30dHighPct);
  return scoreThreshold([
    [nearHigh <= 0.06, 94, "within_6pct_of_30d_high"],
    [nearHigh <= 0.12, 82, "within_12pct_of_30d_high"],
    [nearHigh <= 0.20, 66, "near_upper_range"],
    [true, 35, "too_far_from_30d_high"],
  ]);
}

function scoreSellCalibratedDevelopmentFit(f: EngineContext["features"]): ComponentScore {
  return scoreThreshold([
    [f.priceChange7dPct >= 0.06 && f.priceChange24hPct <= 0.005, 96, "seven_day_rally_24h_failure"],
    [f.priceChange7dPct >= 0.06, 84, "seven_day_rally_exhaustion"],
    [f.priceChange24hPct >= 0.02, 68, "short_term_rally_extension"],
    [true, 36, "development_window_not_exhausted"],
  ]);
}

function scoreSellCalibratedTriggerFit(f: EngineContext["features"]): ComponentScore {
  const slope = f.emaSlope < -0.00015 ? 40 : f.emaSlope < 0.00015 ? 28 : 8;
  const candle = f.latestClose < f.latestOpen ? 25 : 5;
  const overEma = f.priceVsEma20 <= 0.015 ? 20 : 8;
  const rsi = f.rsi14 >= 28 && f.rsi14 <= 72 ? 15 : 4;
  return {
    score: clamp(slope + candle + overEma + rsi, 0, 100),
    flags: [
      `ema_slope=${f.emaSlope.toFixed(6)}`,
      `price_vs_ema20=${(f.priceVsEma20 * 100).toFixed(2)}pct`,
      f.latestClose < f.latestOpen ? "cascade_candle_down" : "no_cascade_candle",
      `rsi=${f.rsi14.toFixed(1)}`,
    ],
  };
}

function scoreSellCalibratedRunwayFit(f: EngineContext["features"]): ComponentScore {
  return scoreThreshold([
    [f.distFromRange30dLowPct >= 0.18, 96, "large_downside_runway_to_30d_low"],
    [f.distFromRange30dLowPct >= 0.10, 82, "healthy_downside_runway"],
    [f.distFromRange30dLowPct >= 0.05, 64, "limited_but_usable_downside_runway"],
    [true, 35, "insufficient_downside_runway"],
  ]);
}

function calibratedCrashScore(
  ctx: EngineContext,
  direction: "buy" | "sell",
  legacyScore: number,
): { nativeScore: number; components: ComponentSet; gate: number; setupFamily: string; setupLabel: string } | null {
  const runtime = ctx.runtimeCalibration;
  if (!runtime || runtime.source !== "promoted_symbol_model") return null;

  const f = ctx.features;
  const components: ComponentSet = direction === "buy"
    ? {
        c1: scoreBuyCalibratedSpikeRecoveryFit(f),
        c2: scoreBuyCalibratedRangePosition(f),
        c3: scoreBuyCalibratedDevelopmentFit(f),
        c4: scoreBuyCalibratedTriggerFit(f),
        c5: scoreVolatilityExpansionFit(f),
        c6: scoreBuyCalibratedRunwayFit(f),
      }
    : {
        c1: scoreSellCalibratedSpikeExhaustionFit(f),
        c2: scoreSellCalibratedRangePosition(f),
        c3: scoreSellCalibratedDevelopmentFit(f),
        c4: scoreSellCalibratedTriggerFit(f),
        c5: scoreVolatilityExpansionFit(f),
        c6: scoreSellCalibratedRunwayFit(f),
      };

  const calibratedScore = Math.round(
    components.c1.score * 0.18 +
    components.c2.score * 0.20 +
    components.c3.score * 0.22 +
    components.c4.score * 0.22 +
    components.c5.score * 0.10 +
    components.c6.score * 0.08
  );
  const runtimeGate = runtime.recommendedScoreGates.paper;

  return {
    nativeScore: clamp(Math.round(legacyScore * 0.35 + calibratedScore * 0.65), 0, 100),
    components,
    gate: clamp(Math.round(Math.max(55, Math.min(80, runtimeGate || 60))), 40, 95),
    setupFamily: "calibrated_crash_expansion_runtime",
    setupLabel: direction === "buy"
      ? "calibrated_buy_crash_expansion_recovery_window"
      : "calibrated_sell_crash_expansion_exhaustion_window",
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// BUY-SIDE COMPONENTS
// ══════════════════════════════════════════════════════════════════════════════

// ── BUY Component 1: Crash Spike Cluster Pressure (0–100) ─────────────────────
// Measures how much crash-spike energy drove the recent downside move.
// For CRASH300 BUY: high score = recent crash spike cluster drove price to the bottom.
// High score: high spikeHazardScore + recent crash spikes (cluster at the low).
// Low score:  no recent spikes or hazard decayed — price not in a genuine crash zone.
function scoreBuyCrashSpikeClusterPressure(f: {
  spikeHazardScore: number;
  runLengthSinceSpike: number;
}): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;

  // Base: spike hazard scale (0–1) → maps to 0–55
  const hazardBase = f.spikeHazardScore * 55;
  score += hazardBase;
  if (f.spikeHazardScore >= 0.70) flags.push("extreme_crash_hazard");
  else if (f.spikeHazardScore >= 0.55) flags.push("high_crash_hazard");
  else if (f.spikeHazardScore >= 0.40) flags.push("moderate_crash_hazard");
  else flags.push("low_crash_hazard");

  // Recency bonus: more recent crash spike = stronger cluster signal at the bottom
  if (f.runLengthSinceSpike <= 5)       { score += 35; flags.push("fresh_crash_spike(≤5)"); }
  else if (f.runLengthSinceSpike <= 15) { score += 25; flags.push("very_recent_crash_spike(≤15)"); }
  else if (f.runLengthSinceSpike <= 30) { score += 15; flags.push("recent_crash_spike(≤30)"); }
  else if (f.runLengthSinceSpike <= 60) { score += 5;  flags.push("aging_crash_spike(≤60)"); }
  else flags.push("stale_crash_spike(>60)");

  // Cluster confirmation bonus: high hazard + recent crash = confirmed crash cluster at low
  if (f.spikeHazardScore >= 0.55 && f.runLengthSinceSpike <= 20) {
    score += 15;
    flags.push("crash_cluster_confirmed");
  }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

// ── BUY Component 2: Downside Displacement (0–100) ────────────────────────────
// Measures how structurally stretched price is into the lower zone after the crash.
// High score: price near 30d low, BB lower pressure, RSI oversold.
// Low score:  price in mid-range — not a genuine swing low.
function scoreBuyDownsideDisplacement(f: {
  distFromRange30dLowPct: number;
  bbPctB: number;
  rsi14: number;
}): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;

  // Range proximity score (closer to 30d low = better for BUY reversal)
  const dist = Math.abs(f.distFromRange30dLowPct);
  if (dist <= 0.03)      { score += 50; flags.push("at_range_bottom(≤3%)"); }
  else if (dist <= 0.07) { score += 40; flags.push("near_range_bottom(≤7%)"); }
  else if (dist <= 0.12) { score += 28; flags.push("approaching_bottom(≤12%)"); }
  else if (dist <= 0.18) { score += 16; flags.push("mid_range(≤18%)"); }
  else if (dist <= 0.25) { score += 8;  flags.push("lower_mid(≤25%)"); }
  else                   { score += 2;  flags.push("far_from_bottom(>25%)"); }

  // BB lower pressure (bbPctB 0-1 scale, <0.2 = near lower band)
  const bbScore = clamp((1 - f.bbPctB) * 30, 0, 30);
  score += bbScore;
  if (f.bbPctB <= 0.15) flags.push("bb_lower_breach");
  else if (f.bbPctB <= 0.30) flags.push("bb_lower_approach");
  else flags.push("bb_mid_upper");

  // RSI oversold confirmation
  if (f.rsi14 <= 25)      { score += 20; flags.push("rsi_extreme_oversold(≤25)"); }
  else if (f.rsi14 <= 38) { score += 13; flags.push("rsi_oversold(≤38)"); }
  else if (f.rsi14 <= 45) { score += 7;  flags.push("rsi_low(≤45)"); }
  else flags.push("rsi_not_oversold");

  return { score: clamp(Math.round(score), 0, 100), flags };
}

// ── BUY Component 3: Exhaustion / Reversal Evidence (0–100) ───────────────────
// Signs that the downward crash push is exhausting and reversal conditions are appearing.
// High score: EMA slope flattening or turning positive, bullish candle body at the low.
// Low score:  crash still in full force — EMA strongly negative, bearish candle body.
//
// Field notes (from FeatureVector):
//   candleBody  = |open-close| / (high-low), always 0-1
//   latestClose = last tick/candle close price
//   latestOpen  = last candle open price
//   emaSlope    = change in EMA per tick (negative = EMA still declining)
function scoreBuyExhaustionReversalEvidence(f: {
  emaSlope: number;
  latestClose: number;
  latestOpen: number;
  candleBody: number;
}): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;

  // EMA slope: for BUY exhaustion, we want slope turning less negative or positive
  // Very negative slope = crash still in force (bad for BUY); flattening = exhaustion
  if (f.emaSlope > 0.0003)       { score += 50; flags.push("ema_turning_positive_reversal"); }
  else if (f.emaSlope > 0)       { score += 38; flags.push("ema_just_turning_positive"); }
  else if (f.emaSlope > -0.0001) { score += 28; flags.push("ema_slope_flattening"); }
  else if (f.emaSlope > -0.0003) { score += 18; flags.push("ema_slope_decelerating"); }
  else if (f.emaSlope > -0.0006) { score += 8;  flags.push("ema_slope_moderately_neg"); }
  else                           { score += 0;  flags.push("ema_slope_strongly_neg_crash_force"); }

  // Bullish reversal candle evidence — close > open at the bottom = reversal signal
  const isBullish = f.latestClose > f.latestOpen;
  const bodyRatio = f.candleBody;

  if (isBullish && bodyRatio >= 0.6) {
    score += 35; flags.push("strong_bullish_reversal_candle(body≥60%)");
  } else if (isBullish && bodyRatio >= 0.35) {
    score += 25; flags.push("bullish_reversal_candle(body≥35%)");
  } else if (isBullish) {
    score += 12; flags.push("weak_bullish_candle");
  } else {
    score += 0; flags.push("bearish_candle_crash_continues");
  }

  // Small body = indecision / exhaustion at the bottom
  if (bodyRatio < 0.15) {
    score += 10; flags.push("indecision_doji_at_bottom");
  }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

// ── BUY Component 4: Recovery Quality (0–100) ─────────────────────────────────
// Measures the quality of the upward rebound after the crash-spike low.
// High score: BB compressing after crash expansion, ATR decelerating, price bouncing.
// Low score:  BB still expanding (crash ongoing), ATR still accelerating.
function scoreBuyRecoveryQuality(f: {
  emaDist: number;
  bbWidthRoc: number;
  atrAccel: number;
  atrRank: number;
}): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 30; // base — always some recovery tendency after a CRASH300 low

  // emaDist (price vs EMA): after crash, price is below EMA (emaDist < 0)
  // Price crossing back toward/above EMA = strong recovery signal
  if (f.emaDist >= 0.010)       { score += 25; flags.push("price_above_ema_recovery"); }
  else if (f.emaDist >= 0)      { score += 15; flags.push("price_crossing_ema_up"); }
  else if (f.emaDist >= -0.005) { score += 8;  flags.push("price_just_below_ema"); }
  else if (f.emaDist >= -0.015) { score += 3;  flags.push("price_below_ema_recovering"); }
  else                          { score -= 5;  flags.push("price_deep_below_ema_crash_zone"); }

  // BB width Rate of Change: compressing after crash expansion = crash energy fading
  if (f.bbWidthRoc < -0.10)      { score += 25; flags.push("bb_strongly_compressing"); }
  else if (f.bbWidthRoc < -0.04) { score += 18; flags.push("bb_compressing"); }
  else if (f.bbWidthRoc < 0)     { score += 8;  flags.push("bb_slightly_compressing"); }
  else if (f.bbWidthRoc < 0.05)  { score += 0;  flags.push("bb_flat"); }
  else                           { score -= 8;  flags.push("bb_still_expanding_crash"); }

  // ATR deceleration: crash energy fading = recovery establishing
  if (f.atrAccel < -0.08)      { score += 20; flags.push("atr_strongly_decelerating"); }
  else if (f.atrAccel < -0.03) { score += 12; flags.push("atr_decelerating"); }
  else if (f.atrAccel < 0)     { score += 5;  flags.push("atr_slightly_decelerating"); }
  else                         { score -= 5;  flags.push("atr_still_accelerating_crash"); }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

// ── BUY Component 5: Entry Efficiency (0–100) ────────────────────────────────
// How close to the optimal BUY entry location relative to the swing low.
// High score: entering very close to swing low — maximum upside capture potential.
// Low score:  entering too far above the swing low — missed the best entry.
function scoreBuyEntryEfficiency(f: {
  distFromRange30dLowPct: number;
  emaDist: number;
}): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;

  const dist = Math.abs(f.distFromRange30dLowPct);

  if (dist <= 0.02)      { score = 90; flags.push("ideal_entry(≤2%_from_bottom)"); }
  else if (dist <= 0.05) { score = 75; flags.push("excellent_entry(≤5%)"); }
  else if (dist <= 0.09) { score = 58; flags.push("good_entry(≤9%)"); }
  else if (dist <= 0.14) { score = 40; flags.push("acceptable_entry(≤14%)"); }
  else if (dist <= 0.22) { score = 22; flags.push("late_entry(≤22%)"); }
  else                   { score = 8;  flags.push("very_late_entry(>22%)"); }

  // Bonus: price below EMA confirms entry is near the genuine crash low
  if (f.emaDist < -0.008) { score = Math.min(100, score + 10); flags.push("below_ema_crash_zone_bonus"); }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

// ── BUY Component 6: Expected Move Sufficiency (0–100) ───────────────────────
// Does the remaining upside runway justify the long-hold swing trade?
// High score: large distance from current price to 30d high (lots of upside), high ATR rank.
// Low score:  price is already near the 30d high — insufficient upside remaining.
function scoreBuyExpectedMoveSufficiency(f: {
  distFromRange30dHighPct: number;
  atrRank: number;
}): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;

  // Distance to 30d high = available upside runway for BUY
  const upside = Math.abs(f.distFromRange30dHighPct);
  const distScore = clamp(upside * 220, 0, 70);
  score += distScore;

  if (upside >= 0.25)      flags.push("large_upside_runway(≥25%)");
  else if (upside >= 0.15) flags.push("adequate_upside_runway(≥15%)");
  else if (upside >= 0.08) flags.push("modest_upside_runway(≥8%)");
  else                     flags.push("insufficient_upside_runway(<8%)");

  // Volatility rank bonus: higher ATR rank = CRASH300 is active = move likely substantial
  if (f.atrRank >= 1.3)      { score += 25; flags.push("high_volatility_rank"); }
  else if (f.atrRank >= 1.0) { score += 15; flags.push("normal_volatility_rank"); }
  else if (f.atrRank >= 0.7) { score += 8;  flags.push("below_avg_volatility"); }
  else                       { score += 0;  flags.push("low_volatility_rank"); }

  // Minimum runway guard: if less than 8% upside, cap score severely
  if (upside < 0.08) {
    score = Math.min(score, 30);
    flags.push("runway_cap_applied");
  }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

// ══════════════════════════════════════════════════════════════════════════════
// SELL-SIDE COMPONENTS
// ══════════════════════════════════════════════════════════════════════════════

// ── SELL Component 1: Rally Extension / Spike Persistence (0–100) ─────────────
// For SELL: measures how extended the rally has been without crash-spike interruption.
// Also picks up spike persistence (cascade signal if spikes begin again after rally).
// High score: long since last crash spike (extended clean rally) OR spike persistence at top.
// Low score:  very recent crash spike (rally was just interrupted = not a SELL setup).
function scoreSellRallyExtension(f: {
  spikeHazardScore: number;
  runLengthSinceSpike: number;
}): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;

  // For SELL: low hazard = clean sustained rally = prime SELL zone
  const inverseHazard = (1 - f.spikeHazardScore) * 55;
  score += inverseHazard;

  if (f.spikeHazardScore <= 0.25) flags.push("minimal_hazard_clean_rally");
  else if (f.spikeHazardScore <= 0.40) flags.push("low_hazard_rally");
  else if (f.spikeHazardScore <= 0.60) flags.push("moderate_hazard_rally");
  else flags.push("high_hazard_cascade_building");

  // Rally extension: longer since last crash spike = more extended rally = better SELL
  if (f.runLengthSinceSpike >= 120) { score += 35; flags.push("very_extended_rally(≥120)"); }
  else if (f.runLengthSinceSpike >= 60) { score += 25; flags.push("extended_rally(≥60)"); }
  else if (f.runLengthSinceSpike >= 30) { score += 15; flags.push("moderate_rally(≥30)"); }
  else if (f.runLengthSinceSpike >= 15) { score += 8;  flags.push("short_rally(≥15)"); }
  else                                  { score += 0;  flags.push("very_recent_crash_rally_short"); }

  // Spike persistence: hazard building again after extended rally = cascade signal
  if (f.spikeHazardScore >= 0.45 && f.runLengthSinceSpike >= 20) {
    score += 10; flags.push("spike_persistence_cascade_signal");
  }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

// ── SELL Component 2: Upside Stretch / Swing-High Reach (0–100) ──────────────
// Measures how elevated price is above fair value and into a swing high.
// High score: price near 30d high, BB upper pressure, RSI overbought.
// Low score:  price in mid-range — not extended enough for a SELL.
function scoreSellUpsideStretch(f: {
  distFromRange30dHighPct: number;
  bbPctB: number;
  rsi14: number;
}): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;

  // Range proximity (closer to 30d high = better for SELL)
  const dist = Math.abs(f.distFromRange30dHighPct);
  if (dist <= 0.03)      { score += 50; flags.push("at_range_top(≤3%)"); }
  else if (dist <= 0.07) { score += 40; flags.push("near_range_top(≤7%)"); }
  else if (dist <= 0.12) { score += 28; flags.push("approaching_top(≤12%)"); }
  else if (dist <= 0.18) { score += 16; flags.push("mid_range(≤18%)"); }
  else if (dist <= 0.25) { score += 8;  flags.push("lower_mid(≤25%)"); }
  else                   { score += 2;  flags.push("far_from_top(>25%)"); }

  // BB upper pressure
  const bbScore = clamp(f.bbPctB * 30, 0, 30);
  score += bbScore;
  if (f.bbPctB >= 0.85) flags.push("bb_upper_breach");
  else if (f.bbPctB >= 0.70) flags.push("bb_upper_approach");
  else flags.push("bb_mid_lower");

  // RSI overbought confirmation
  if (f.rsi14 >= 75)      { score += 20; flags.push("rsi_extreme_overbought(≥75)"); }
  else if (f.rsi14 >= 62) { score += 13; flags.push("rsi_overbought(≥62)"); }
  else if (f.rsi14 >= 55) { score += 7;  flags.push("rsi_elevated(≥55)"); }
  else flags.push("rsi_not_overbought");

  return { score: clamp(Math.round(score), 0, 100), flags };
}

// ── SELL Component 3: Rally Exhaustion Evidence (0–100) ───────────────────────
// Signs that the upward rally is running out of energy at the swing high.
// High score: EMA slope turning negative, bearish candle body near top.
// Low score:  rally still in full upward momentum — not exhausted yet.
function scoreSellRallyExhaustionEvidence(f: {
  emaSlope: number;
  latestClose: number;
  latestOpen: number;
  candleBody: number;
}): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;

  // EMA slope turning: negative slope = rally exhausting
  if (f.emaSlope <= -0.0006)      { score += 50; flags.push("ema_slope_strongly_neg"); }
  else if (f.emaSlope <= -0.0003) { score += 40; flags.push("ema_slope_moderately_neg"); }
  else if (f.emaSlope <= -0.0001) { score += 28; flags.push("ema_slope_weakly_neg"); }
  else if (f.emaSlope < 0)        { score += 15; flags.push("ema_slope_just_neg"); }
  else if (f.emaSlope <= 0.0002)  { score += 5;  flags.push("ema_slope_flat"); }
  else                            { score += 0;  flags.push("ema_slope_still_positive"); }

  // Bearish candle near top = rally exhausting
  const isBearish = f.latestClose < f.latestOpen;
  const bodyRatio = f.candleBody;

  if (isBearish && bodyRatio >= 0.6) {
    score += 35; flags.push("strong_bearish_candle(body≥60%)");
  } else if (isBearish && bodyRatio >= 0.35) {
    score += 25; flags.push("bearish_candle(body≥35%)");
  } else if (isBearish) {
    score += 12; flags.push("weak_bearish_candle");
  } else {
    score += 0; flags.push("bullish_candle_rally_continuing");
  }

  // Small body = indecision at top (exhaustion signal)
  if (bodyRatio < 0.15) {
    score += 10; flags.push("indecision_doji_at_top");
  }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

// ── SELL Component 4: Cascade Potential (0–100) ───────────────────────────────
// Evidence of downside cascade conditions forming — the natural CRASH300 behavior.
// High score: price well above EMA (stretched), ATR rank elevated, BB has room to drop.
// Low score:  price already near EMA, low volatility, BB compressed — limited cascade room.
function scoreSellCascadePotential(f: {
  emaDist: number;
  bbWidthRoc: number;
  atrRank: number;
  atrAccel: number;
}): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 30; // base — always some cascade tendency in CRASH300

  // Price above EMA (inflated by rally) = elevated position = cascade potential
  if (f.emaDist > 0.015)       { score += 25; flags.push("price_extended_above_ema"); }
  else if (f.emaDist > 0.005)  { score += 15; flags.push("price_above_ema"); }
  else if (f.emaDist > 0)      { score += 8;  flags.push("price_just_above_ema"); }
  else                         { score -= 5;  flags.push("price_below_ema_no_cascade"); }

  // BB width: still wide or expanding = room for cascade
  if (f.bbWidthRoc > 0.05)        { score += 15; flags.push("bb_still_expanding"); }
  else if (f.bbWidthRoc > 0)      { score += 8;  flags.push("bb_slightly_expanding"); }
  else if (f.bbWidthRoc > -0.04)  { score += 3;  flags.push("bb_flat"); }
  else                            { score -= 5;  flags.push("bb_compressing_no_cascade"); }

  // ATR rank: higher volatility = more potential cascade energy
  if (f.atrRank >= 1.3)      { score += 20; flags.push("high_volatility_rank"); }
  else if (f.atrRank >= 1.0) { score += 12; flags.push("normal_volatility_rank"); }
  else if (f.atrRank >= 0.7) { score += 5;  flags.push("below_avg_volatility"); }
  else                       { score += 0;  flags.push("low_volatility_rank"); }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

// ── SELL Component 5: Entry Efficiency Sell (0–100) ──────────────────────────
// How close to the optimal SELL entry location relative to the swing high.
// High score: entering very close to swing high — maximum downside capture potential.
// Low score:  entering too far below the swing high — missed the best SELL entry.
function scoreSellEntryEfficiency(f: {
  distFromRange30dHighPct: number;
  emaDist: number;
}): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;

  const dist = Math.abs(f.distFromRange30dHighPct);

  if (dist <= 0.02)      { score = 90; flags.push("ideal_sell_entry(≤2%_from_top)"); }
  else if (dist <= 0.05) { score = 75; flags.push("excellent_sell_entry(≤5%)"); }
  else if (dist <= 0.09) { score = 58; flags.push("good_sell_entry(≤9%)"); }
  else if (dist <= 0.14) { score = 40; flags.push("acceptable_sell_entry(≤14%)"); }
  else if (dist <= 0.22) { score = 22; flags.push("late_sell_entry(≤22%)"); }
  else                   { score = 8;  flags.push("very_late_sell_entry(>22%)"); }

  // Bonus: price above EMA confirms entry is near the genuine elevated top
  if (f.emaDist > 0.008) { score = Math.min(100, score + 10); flags.push("above_ema_elevated_bonus"); }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

// ── SELL Component 6: Expected Move Sufficiency Sell (0–100) ─────────────────
// Does the remaining downside runway justify the long-hold cascade trade?
// High score: large distance from current price to 30d low (lots of downside room).
// Low score:  price is already near the 30d low — insufficient downside remaining.
function scoreSellExpectedMoveSufficiency(f: {
  distFromRange30dLowPct: number;
  atrRank: number;
}): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;

  // Distance to 30d low = available downside runway for SELL
  const downside = Math.abs(f.distFromRange30dLowPct);
  const distScore = clamp(downside * 220, 0, 70);
  score += distScore;

  if (downside >= 0.25)      flags.push("large_downside_runway(≥25%)");
  else if (downside >= 0.15) flags.push("adequate_downside_runway(≥15%)");
  else if (downside >= 0.08) flags.push("modest_downside_runway(≥8%)");
  else                       flags.push("insufficient_downside_runway(<8%)");

  // Volatility rank bonus
  if (f.atrRank >= 1.3)      { score += 25; flags.push("high_volatility_rank"); }
  else if (f.atrRank >= 1.0) { score += 15; flags.push("normal_volatility_rank"); }
  else if (f.atrRank >= 0.7) { score += 8;  flags.push("below_avg_volatility"); }
  else                       { score += 0;  flags.push("low_volatility_rank"); }

  // Minimum runway guard: if less than 8% downside, cap score severely
  if (downside < 0.08) {
    score = Math.min(score, 30);
    flags.push("runway_cap_applied");
  }

  return { score: clamp(Math.round(score), 0, 100), flags };
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN ENGINE FUNCTION
// ══════════════════════════════════════════════════════════════════════════════

export interface Crash300NativeScoreBreakdown {
  engineScore: number;
  direction: "buy" | "sell";
  setupDetected: string;
  setupFamily: string;
  componentScores: {
    crashSpikeClusterPressure: number;
    downsideDisplacement: number;
    exhaustionReversalEvidence: number;
    recoveryQuality: number;
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

function evaluateCrash300Direction(
  ctx: EngineContext,
  forcedDirection: "buy" | "sell" | "auto",
): EngineResult | null {
  const { features, operationalRegime, regimeConfidence } = ctx;
  const f = features;

  if (f.symbol !== SYMBOL && !f.symbol.startsWith("CRASH")) return null;

  const symbol = f.symbol;
  const engineNameForOverride =
    forcedDirection === "sell" ? SELL_ENGINE_NAME : BUY_ENGINE_NAME;
  const engineOverride = getCrashEngineOverride(ctx, engineNameForOverride);
  const weights = resolveCrashWeights(ctx, engineNameForOverride);

  // ── Regime pre-filter ──────────────────────────────────────────────────────
  // Directional guard:
  // - BUY should not trigger into sustained upside trend.
  // - SELL should stay enabled in crash_expansion/spike_zone because CRASH300
  //   calibration indicates downside expansion is the primary capturable leg.
  const regimeBlocksBuy = operationalRegime === "trend_up";
  const regimeBlocksSell = operationalRegime === "trend_up";

  // ── Compute BUY components (primary setup) ─────────────────────────────────
  const b1_cluster  = scoreBuyCrashSpikeClusterPressure({ spikeHazardScore: f.spikeHazardScore, runLengthSinceSpike: f.runLengthSinceSpike });
  const b2_disp     = scoreBuyDownsideDisplacement({ distFromRange30dLowPct: f.distFromRange30dLowPct, bbPctB: f.bbPctB, rsi14: f.rsi14 });
  const b3_exhaust  = scoreBuyExhaustionReversalEvidence({ emaSlope: f.emaSlope, latestClose: f.latestClose, latestOpen: f.latestOpen, candleBody: f.candleBody });
  const b4_recovery = scoreBuyRecoveryQuality({ emaDist: f.emaDist, bbWidthRoc: f.bbWidthRoc, atrAccel: f.atrAccel, atrRank: f.atrRank });
  const b5_entry    = scoreBuyEntryEfficiency({ distFromRange30dLowPct: f.distFromRange30dLowPct, emaDist: f.emaDist });
  const b6_move     = scoreBuyExpectedMoveSufficiency({ distFromRange30dHighPct: f.distFromRange30dHighPct, atrRank: f.atrRank });

  const buyNativeScore = Math.round(
    b1_cluster.score  * weights.cluster +
    b2_disp.score     * weights.displacement +
    b3_exhaust.score  * weights.exhaustion +
    b4_recovery.score * weights.recovery +
    b5_entry.score    * weights.entry +
    b6_move.score     * weights.move
  );

  // ── Compute SELL components (secondary setup) ──────────────────────────────
  const s1_rally    = scoreSellRallyExtension({ spikeHazardScore: f.spikeHazardScore, runLengthSinceSpike: f.runLengthSinceSpike });
  const s2_stretch  = scoreSellUpsideStretch({ distFromRange30dHighPct: f.distFromRange30dHighPct, bbPctB: f.bbPctB, rsi14: f.rsi14 });
  const s3_exhaust  = scoreSellRallyExhaustionEvidence({ emaSlope: f.emaSlope, latestClose: f.latestClose, latestOpen: f.latestOpen, candleBody: f.candleBody });
  const s4_cascade  = scoreSellCascadePotential({ emaDist: f.emaDist, bbWidthRoc: f.bbWidthRoc, atrRank: f.atrRank, atrAccel: f.atrAccel });
  const s5_entry    = scoreSellEntryEfficiency({ distFromRange30dHighPct: f.distFromRange30dHighPct, emaDist: f.emaDist });
  const s6_move     = scoreSellExpectedMoveSufficiency({ distFromRange30dLowPct: f.distFromRange30dLowPct, atrRank: f.atrRank });

  const sellNativeScore = Math.round(
    s1_rally.score   * weights.cluster +
    s2_stretch.score * weights.displacement +
    s3_exhaust.score * weights.exhaustion +
    s4_cascade.score * weights.recovery +
    s5_entry.score   * weights.entry +
    s6_move.score    * weights.move
  );

  // ── Direction selection (BUY is primary) ──────────────────────────────────
  const paperGate = asFinite(ctx.runtimeCalibration?.recommendedScoreGates?.paper);
  const blendedBuyGate = paperGate != null
    ? clamp(Math.round(CRASH300_BUY_MIN_GATE * 0.7 + paperGate * 0.3), 45, 90)
    : CRASH300_BUY_MIN_GATE;
  const blendedSellGate = paperGate != null
    ? clamp(Math.round(CRASH300_SELL_MIN_GATE * 0.65 + paperGate * 0.35), 45, 90)
    : CRASH300_SELL_MIN_GATE;
  const buyGateOverride = asFinite(engineOverride.buyGate ?? engineOverride.minBuyGate ?? engineOverride.minGate);
  const sellGateOverride = asFinite(engineOverride.sellGate ?? engineOverride.minSellGate ?? engineOverride.minGate);
  const resolvedBuyGate = clamp(Math.round(buyGateOverride ?? blendedBuyGate), 40, 95);
  const resolvedSellGate = clamp(Math.round(sellGateOverride ?? blendedSellGate), 40, 95);
  const calibratedBuy = calibratedCrashScore(ctx, "buy", buyNativeScore);
  const calibratedSell = calibratedCrashScore(ctx, "sell", sellNativeScore);
  const effectiveBuyScore = calibratedBuy?.nativeScore ?? buyNativeScore;
  const effectiveSellScore = calibratedSell?.nativeScore ?? sellNativeScore;
  const effectiveBuyGate = calibratedBuy?.gate ?? resolvedBuyGate;
  const effectiveSellGate = calibratedSell?.gate ?? resolvedSellGate;

  const buyViable  = effectiveBuyScore  >= effectiveBuyGate  && !regimeBlocksBuy;
  const sellViable = effectiveSellScore >= effectiveSellGate && !regimeBlocksSell;

  let direction: "buy" | "sell";
  let nativeScore: number;
  let minGate: number;
  let components: ComponentSet;
  let projectedMovePct: number;
  let invalidation: number;
  let holdProfile: string;
  let tpLogic: string;
  let slLogic: string;
  let trailLogic: string;
  let setupLabel: string;

  if (forcedDirection === "buy") {
    if (!buyViable) return null;
    direction       = "buy";
    nativeScore     = effectiveBuyScore;
    minGate         = effectiveBuyGate;
    components      = calibratedBuy?.components ?? { c1: b1_cluster, c2: b2_disp, c3: b3_exhaust, c4: b4_recovery, c5: b5_entry, c6: b6_move };
    projectedMovePct = CRASH300_BUY_PROJECTED_PCT;
    invalidation    = f.swingLow * 0.995;
    holdProfile     = CRASH300_BUY_HOLD_PROFILE;
    tpLogic         = CRASH300_BUY_TP_LOGIC;
    slLogic         = CRASH300_BUY_SL_LOGIC;
    trailLogic      = CRASH300_BUY_TRAIL;
    setupLabel      = calibratedBuy?.setupLabel ?? "buy_after_crash_spike_cluster_swing_low_reversal";
  } else if (forcedDirection === "sell") {
    if (!sellViable) return null;
    direction       = "sell";
    nativeScore     = effectiveSellScore;
    minGate         = effectiveSellGate;
    components      = calibratedSell?.components ?? { c1: s1_rally, c2: s2_stretch, c3: s3_exhaust, c4: s4_cascade, c5: s5_entry, c6: s6_move };
    projectedMovePct = CRASH300_SELL_PROJECTED_PCT;
    invalidation    = f.swingHigh * 1.005;
    holdProfile     = CRASH300_SELL_HOLD_PROFILE;
    tpLogic         = CRASH300_SELL_TP_LOGIC;
    slLogic         = CRASH300_SELL_SL_LOGIC;
    trailLogic      = CRASH300_SELL_TRAIL;
    setupLabel      = calibratedSell?.setupLabel ?? "sell_after_extended_rally_exhaustion_cascade";
  } else if (buyViable && (!sellViable || effectiveBuyScore >= effectiveSellScore)) {
    // Auto mode: BUY preferred when both viable (BUY = primary setup)
    direction       = "buy";
    nativeScore     = effectiveBuyScore;
    minGate         = effectiveBuyGate;
    components      = calibratedBuy?.components ?? { c1: b1_cluster, c2: b2_disp, c3: b3_exhaust, c4: b4_recovery, c5: b5_entry, c6: b6_move };
    projectedMovePct = CRASH300_BUY_PROJECTED_PCT;
    invalidation    = f.swingLow * 0.995;
    holdProfile     = CRASH300_BUY_HOLD_PROFILE;
    tpLogic         = CRASH300_BUY_TP_LOGIC;
    slLogic         = CRASH300_BUY_SL_LOGIC;
    trailLogic      = CRASH300_BUY_TRAIL;
    setupLabel      = calibratedBuy?.setupLabel ?? "buy_after_crash_spike_cluster_swing_low_reversal";
  } else if (sellViable) {
    direction       = "sell";
    nativeScore     = effectiveSellScore;
    minGate         = effectiveSellGate;
    components      = calibratedSell?.components ?? { c1: s1_rally, c2: s2_stretch, c3: s3_exhaust, c4: s4_cascade, c5: s5_entry, c6: s6_move };
    projectedMovePct = CRASH300_SELL_PROJECTED_PCT;
    invalidation    = f.swingHigh * 1.005;
    holdProfile     = CRASH300_SELL_HOLD_PROFILE;
    tpLogic         = CRASH300_SELL_TP_LOGIC;
    slLogic         = CRASH300_SELL_SL_LOGIC;
    trailLogic      = CRASH300_SELL_TRAIL;
    setupLabel      = calibratedSell?.setupLabel ?? "sell_after_extended_rally_exhaustion_cascade";
  } else {
    // Neither setup meets the CRASH300-native gate — no signal
    return null;
  }

  // ── CRASH300-native regime modifier ───────────────────────────────────────
  const calibratedRuntimeApplied = direction === "buy" ? calibratedBuy : calibratedSell;
  const legacyScore = direction === "buy" ? buyNativeScore : sellNativeScore;

  let regimeFit = 0.55; // neutral baseline
  if (direction === "buy") {
    if (operationalRegime === "crash_expansion" || operationalRegime === "spike_zone") regimeFit = 0.88;
    else if (operationalRegime === "trend_down" || operationalRegime === "mean_reversion") regimeFit = 0.80;
    else if (operationalRegime === "ranging" || operationalRegime === "compression") regimeFit = 0.65;
  } else {
    if (operationalRegime === "trend_up" || operationalRegime === "breakout_expansion") regimeFit = 0.82;
    else if (operationalRegime === "ranging") regimeFit = 0.65;
    else if (operationalRegime === "mean_reversion") regimeFit = 0.60;
  }

  // ── Final confidence: CRASH300 native score maps 1:1 to confidence ─────────
  // confidence = nativeScore / 100 (direct mapping)
  // The allocator's mode-level gate (paper≥0.60 / demo≥0.65 / real≥0.70) is
  // applied as the SECONDARY gate after the engine's own native gate passes.
  const confidence = clamp(nativeScore / 100, 0, 0.98);

  // ── Block reason analysis ─────────────────────────────────────────────────
  const blockReasons: string[] = [];
  if (calibratedRuntimeApplied) {
    if (components.c1.score < 55) blockReasons.push(`weak_calibrated_spike_phase(${components.c1.score}/100)`);
    if (components.c2.score < 55) blockReasons.push(`weak_calibrated_range_position(${components.c2.score}/100)`);
    if (components.c3.score < 55) blockReasons.push(`weak_calibrated_development_window(${components.c3.score}/100)`);
    if (components.c4.score < 55) blockReasons.push(`weak_calibrated_trigger_window(${components.c4.score}/100)`);
    if (components.c5.score < 45) blockReasons.push(`weak_calibrated_volatility_expansion(${components.c5.score}/100)`);
    if (components.c6.score < 45) blockReasons.push(`weak_calibrated_runway(${components.c6.score}/100)`);
  } else if (direction === "buy") {
    if (b1_cluster.score  < 40) blockReasons.push(`insufficient_crash_spike_cluster(${b1_cluster.score}/100)`);
    if (b2_disp.score     < 40) blockReasons.push(`insufficient_downside_displacement(${b2_disp.score}/100)`);
    if (b3_exhaust.score  < 35) blockReasons.push(`insufficient_reversal_evidence(${b3_exhaust.score}/100)`);
    if (b4_recovery.score < 30) blockReasons.push(`weak_recovery_quality(${b4_recovery.score}/100)`);
    if (b5_entry.score    < 30) blockReasons.push(`entry_too_late_above_swing_low(${b5_entry.score}/100)`);
    if (b6_move.score     < 30) blockReasons.push(`expected_upside_move_insufficient(${b6_move.score}/100)`);
  } else {
    if (s1_rally.score   < 35) blockReasons.push(`insufficient_rally_extension(${s1_rally.score}/100)`);
    if (s2_stretch.score < 40) blockReasons.push(`insufficient_upside_stretch(${s2_stretch.score}/100)`);
    if (s3_exhaust.score < 35) blockReasons.push(`insufficient_rally_exhaustion(${s3_exhaust.score}/100)`);
    if (s4_cascade.score < 30) blockReasons.push(`weak_downside_cascade_potential(${s4_cascade.score}/100)`);
    if (s5_entry.score   < 30) blockReasons.push(`sell_entry_too_late(${s5_entry.score}/100)`);
    if (s6_move.score    < 30) blockReasons.push(`expected_downside_move_insufficient(${s6_move.score}/100)`);
  }

  // ── Structural context summary ────────────────────────────────────────────
  const structuralContext = [
    `CRASH300 ${direction.toUpperCase()} | native_score=${nativeScore}/100 | regime=${operationalRegime}(${(regimeConfidence * 100).toFixed(0)}%)`,
    `price_dist_from_30d_low=${(f.distFromRange30dLowPct * 100).toFixed(1)}% | dist_from_30d_high=${(f.distFromRange30dHighPct * 100).toFixed(1)}%`,
    `spikeHazard=${f.spikeHazardScore.toFixed(2)} | runLengthSinceSpike=${f.runLengthSinceSpike} | rsi14=${f.rsi14.toFixed(1)}`,
    `emaSlope=${f.emaSlope.toFixed(5)} | bbPctB=${f.bbPctB.toFixed(2)} | atrRank=${f.atrRank.toFixed(2)}`,
  ].join(" | ");

  // ── Assemble CRASH300-native score breakdown ──────────────────────────────
  const nativeBreakdown: Crash300NativeScoreBreakdown = {
    engineScore: nativeScore,
    direction,
    setupDetected: setupLabel,
    setupFamily: calibratedRuntimeApplied?.setupFamily ?? "crash300_swing_structure",
    componentScores: {
      crashSpikeClusterPressure:  components.c1.score,
      downsideDisplacement:       components.c2.score,
      exhaustionReversalEvidence: components.c3.score,
      recoveryQuality:            components.c4.score,
      entryEfficiency:            components.c5.score,
      expectedMoveSufficiency:    components.c6.score,
    },
    componentFlags: {
      crashSpikeClusterPressure:  components.c1.flags,
      downsideDisplacement:       components.c2.flags,
      exhaustionReversalEvidence: components.c3.flags,
      recoveryQuality:            components.c4.flags,
      entryEfficiency:            components.c5.flags,
      expectedMoveSufficiency:    components.c6.flags,
    },
    gatePassed: true, // reached this point = passed engine-native gate
    gateThreshold: minGate,
    gateReason: calibratedRuntimeApplied
      ? `calibrated_runtime_score ${nativeScore} >= promoted_model_gate ${minGate}`
      : `native_score ${nativeScore} >= CRASH300_MIN_GATE ${minGate}`,
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
    engineName: direction === "buy" ? BUY_ENGINE_NAME : SELL_ENGINE_NAME,
    direction,
    confidence,
    regimeFit,
    entryType: "expansion",
    projectedMovePct,
    invalidation,
    reason: calibratedRuntimeApplied
      ? `CRASH300 ${direction} | calibrated_runtime=${nativeScore}/100 | legacy_native=${legacyScore}/100 | gate=${minGate} | ` +
      `spikePhase=${components.c1.score} range=${components.c2.score} development=${components.c3.score} ` +
      `trigger=${components.c4.score} volatility=${components.c5.score} runway=${components.c6.score} | ` +
      `regime=${operationalRegime}(fit=${regimeFit.toFixed(2)})` +
      (blockReasons.length > 0 ? ` | weakComponents=[${blockReasons.join(", ")}]` : "")
      : `CRASH300 ${direction} | native=${nativeScore}/100 | gate=${minGate} | ` +
      `cluster=${components.c1.score} disp=${components.c2.score} exhaust=${components.c3.score} ` +
      `recovery=${components.c4.score} entry=${components.c5.score} move=${components.c6.score} | ` +
      `regime=${operationalRegime}(fit=${regimeFit.toFixed(2)})` +
      (blockReasons.length > 0 ? ` | weakComponents=[${blockReasons.join(", ")}]` : ""),
    metadata: {
      crash300: nativeBreakdown,
      // Flat aliases for easy access in allocator/scheduler
      crash300NativeScore: nativeScore,
      crash300GatePassed: true,
      crash300GateThreshold: minGate,
      crash300BlockReasons: blockReasons,
      crash300RuntimeCalibrationApplied: Boolean(ctx.runtimeCalibration),
      crash300RuntimeCalibrationRunId: ctx.runtimeCalibration?.sourceRunId ?? null,
      crash300ScoringSource: calibratedRuntimeApplied ? "promoted_calibrated_runtime_model" : "legacy_native_six_component",
      crash300LegacyNativeScore: legacyScore,
      crash300CalibratedRuntimeScore: calibratedRuntimeApplied ? nativeScore : null,
      crash300CalibratedRuntimeGate: calibratedRuntimeApplied ? minGate : null,
      setupDetected: nativeBreakdown.setupDetected,
      setupFamily: nativeBreakdown.setupFamily,
      componentScores: nativeBreakdown.componentScores,
      calibratedComponentScores: calibratedRuntimeApplied
        ? {
            spikePhaseFit: components.c1.score,
            rangePositionFit: components.c2.score,
            developmentWindowFit: components.c3.score,
            triggerWindowFit: components.c4.score,
            volatilityExpansionFit: components.c5.score,
            runwayFit: components.c6.score,
          }
        : null,
      expectedHoldProfile: holdProfile,
      tpLogicSummary: tpLogic,
      slLogicSummary: slLogic,
      structuralContextSummary: structuralContext,
    },
  };
}

export function crash300Engine(ctx: EngineContext): EngineResult | null {
  return evaluateCrash300Direction(ctx, "buy");
}

export function crash300ShortExpansionEngine(ctx: EngineContext): EngineResult | null {
  return evaluateCrash300Direction(ctx, "sell");
}
