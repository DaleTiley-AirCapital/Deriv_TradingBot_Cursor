# V2 Specification — Dynamic Trade Management

> This document describes all V2 changes implemented on top of V1. V1_SPECIFICATION.md is preserved unchanged.

---

## Table of Contents

1. [Design Philosophy](#1-design-philosophy)
2. [TP/SL: S/R + Fibonacci Confluence](#2-tpsl-sr--fibonacci-confluence)
3. [Trailing Stop: Profit-Based](#3-trailing-stop-profit-based)
4. [Exit Policy: No Time Exits](#4-exit-policy-no-time-exits)
5. [Regime Engine: Hourly Caching + Ranging](#5-regime-engine-hourly-caching--ranging)
6. [Scoring Updates](#6-scoring-updates)
7. [Entry Simplification](#7-entry-simplification)
8. [Removed V1 Concepts](#8-removed-v1-concepts)
9. [Settings Inventory (V2)](#9-settings-inventory-v2)
10. [Backtest Engine Alignment](#10-backtest-engine-alignment)
11. [AI Integration Updates](#11-ai-integration-updates)
12. [File-by-File Change Summary](#12-file-by-file-change-summary)

---

## 1. Design Philosophy

V2 replaces V1's static ATR-multiplier trade management with dynamic, market-structure-aware logic. The core principles:

- **Large capital, long hold, max profit.** Swing trades on highest-probability signals only.
- **TP targets full spike magnitude (50-200%+).** TP is the PRIMARY exit. Trailing stop is SAFETY NET ONLY. Never scalp 1-5% moves.
- **TP/SL derived from actual market structure + spike magnitude analysis** — never from ATR multiples.
- **Rolling 60-90 day spike magnitude analysis** from `spike_events` table drives TP distance for Boom/Crash indices.
- **1500+ candle structural window** for swing levels, VWAP, pivots, Fibonacci — never just 100 one-minute candles.
- **Boom/Crash and Volatility indices treated differently** — spike-magnitude TP for Boom/Crash, multi-day S/R for Volatility.
- **Trailing stop protects realized profit** — trails at 30% below peak unrealized profit percentage, not price.
- **No time exits** — trades hold until TP, SL, or trailing stop. Long-hold strategy.
- **Up to 2 positions per symbol** (different strategy families). No multi-stage building.
- **AI never auto-changes settings.** Blocked signals get `aiVerdict="skipped"`.

### CRITICAL DESIGN MANDATES — DO NOT VIOLATE
1. **TP is PRIMARY exit** targeting full spike magnitude (50-200%+). Trailing stop is SAFETY NET ONLY.
2. **Never use ATR-based TP/SL exits.** All exits from market structure and spike magnitude analysis.
3. **Never compute structural indicators from only 100 one-minute candles.** Use 1500+ candles for structure, 100 for fast indicators.
4. **Use rolling 60-90 day windows** (not static all-time levels) for spike magnitude analysis.

---

## 2. TP/SL: S/R + Fibonacci Confluence

### Feature Vector Additions (`features.ts`)

New fields computed in `computeFeatures()` (1500-candle structural window, 100-candle fast window):

| Field | Type | Description |
|---|---|---|
| `swingHigh` | `number` | Highest high in lookback window (50 candles) |
| `swingLow` | `number` | Lowest low in lookback window |
| `majorSwingHigh` | `number` | 20-bar major swing high from 1500+ candle window |
| `majorSwingLow` | `number` | 20-bar major swing low from 1500+ candle window |
| `spikeMagnitude` | `SpikeMagnitudeStats \| null` | Rolling 60-90 day spike stats: `{ median, p75, p90, count }` (absolute price change) |
| `fibRetraceLevels` | `number[]` | Fibonacci retracement levels: 23.6%, 38.2%, 50%, 61.8%, 78.6% between swing low and swing high |
| `fibExtensionLevels` | `number[]` | Fibonacci extension levels: 127.2%, 161.8%, 200% projected beyond swing range |
| `bbUpper` | `number` | Upper Bollinger Band value (fast 100-candle window) |
| `bbLower` | `number` | Lower Bollinger Band value (fast 100-candle window) |
| `vwap` | `number` | Volume-Weighted Average Price (range-proxy) |
| `pivotPoint` | `number` | Classic pivot point from previous session H/L/C |
| `pivotR1`–`pivotR3` | `number` | Classic pivot resistance levels |
| `pivotS1`–`pivotS3` | `number` | Classic pivot support levels |
| `camarillaH3`/`camarillaH4` | `number` | Camarilla resistance levels |
| `camarillaL3`/`camarillaL4` | `number` | Camarilla support levels |
| `psychRound` | `number` | Nearest psychological round number |
| `prevSessionHigh` | `number` | Previous session high |
| `prevSessionLow` | `number` | Previous session low |
| `prevSessionClose` | `number` | Previous session close |

### `calculateSRFibTP()` (`tradeEngine.ts`)

**Boom/Crash indices** (spike-magnitude primary):
1. Primary TP = entry ± spike p75 (converted to percentage). Targets full spike travel.
2. If spike data unavailable, falls back to structural S/R confluence (major swing levels, fib extensions, pivots).
3. No ATR fallback ever.

**Volatility indices** (structural S/R primary):
1. Compute full swing range from `majorSwingHigh - majorSwingLow`.
2. Buy TP: entry + 70% of swing range. Sell TP: entry - 70% of swing range.
3. Clamped to major swing level if beyond it.
4. No ATR fallback ever.

For **sell** trades: mirror logic in both cases.

### `calculateSRFibSL()` (`tradeEngine.ts`)

**Boom/Crash indices** (spike-drift SL):
1. SL distance = 30% of median spike magnitude (converted to percentage).
2. Buy SL: entry × (1 - driftPct). Sell SL: entry × (1 + driftPct).
3. Safety cap: max loss 10% of equity.
4. No ATR fallback ever.

**Volatility indices** (structural S/R SL):
1. Compute nearest structural support/resistance beyond entry using major swing, pivot, Camarilla, VWAP levels.
2. Find nearest confluence cluster below (buy) or above (sell) entry.
3. Buffer 0.3% outside the level.
4. Safety cap: max loss 10% of equity.
5. No ATR fallback ever.

### Strategy-Level Integration (`strategies.ts`)

Strategy functions (`trendContinuation`, `meanReversion`, `breakoutExpansion`, `spikeEvent`) set `suggestedTp` and `suggestedSl` to `null` — TP/SL are computed later at execution time by `calculateSRFibTP`/`calculateSRFibSL` in the trade engine and backtest engine, where the entry price and position size are known.

---

## 3. Trailing Stop: Profit-Based

### `calculateProfitTrailingStop()` (`tradeEngine.ts`)

Replaces the old price-based trailing stop with profit-percentage trailing:

- **Peak tracking:** Tracks the highest unrealized profit percentage reached.
- **Activation:** Only activates when trade is **in profit** (unrealized P&L > 0).
- **Drawdown threshold:** 30% drawdown from peak profit triggers close.
  - Example: Peak profit was 10%. Current profit drops to 7% → drawdown = 30% → close.
- **Below breakeven:** If current price is at or below breakeven, returns the original S/R-based SL (no trailing).

### Constants

| Constant | Value | Description |
|---|---|---|
| `PROFIT_TRAIL_DRAWDOWN_PCT` | 0.30 | 30% drawdown from peak profit |

---

## 4. Exit Policy: No Time Exits

Trades exit ONLY via:
1. **TP hit** (primary exit) — targeting full spike magnitude (50-200%+ moves)
2. **SL hit** — structural S/R confluence placement
3. **30% trailing stop** — safety net, activates only in profit

### Removed (V2.1)

- `TIME_EXIT_PROFIT_HOURS` (72h) and `TIME_EXIT_HARD_CAP_HOURS` (168h) constants — deleted.
- `checkTimeExit()` function — now returns `{shouldExit: false}` always (no-op).
- `INITIAL_EXIT_HOURS`, `EXTENSION_HOURS`, `MAX_EXIT_HOURS` constants.
- Extension logic for near-breakeven trades.
- Per-family hold profiles (`FAMILY_HOLD_PROFILE`).
- All time-based forced closures from both live engine and backtest engine.

---

## 5. Regime Engine: Hourly Caching + Ranging

### Hourly Caching (`regimeEngine.ts` + `scheduler.ts`)

- Regime is computed once per symbol per hour and cached in `platform_state` with key `regime_cache_{symbol}`.
- Cache includes: `regime`, `confidence`, `timestamp`.
- `getCachedRegime(symbol)` returns cached regime if < 1 hour old; otherwise returns `null`.
- `cacheRegime(symbol, regime, confidence)` stores the result.
- The scanner loop in `scheduler.ts` calls `getCachedRegime()` first and only computes regime fresh on cache miss.

### "Ranging" Regime

Added `"ranging"` to the `RegimeType` union. Detected when:
- EMA slope is flat (< 0.0003 absolute).
- BB width is moderate (0.005–0.015).
- No spike hazard (< 0.50).
- Z-score is moderate (< 1.5 absolute).

### Trendline Breakout Strategy (`strategies.ts`)

New `trendline_breakout` family added. Uses `scoreFeaturesForFamily("breakout_expansion")` scoring. Entry conditions:
- BB width expansion (bbWidth > 0.008)
- Price breaking above/below trendline with ATR confirmation
- Allowed in regimes: `compression`, `ranging`, `breakout_expansion`, `trend_up`, `trend_down`

### Strategy Permission Matrix

`STRATEGY_PERMISSION_MATRIX` updated:
- `mean_reversion` and `spike_event` strategies are now also allowed in `"ranging"` regime.
- `trend_continuation` allowed in: `trend_up`, `trend_down`, `breakout_expansion`.
- `breakout_expansion` allowed in: `compression`, `breakout_expansion`, `high_volatility`.
- `trendline_breakout` allowed in: `compression`, `ranging`, `breakout_expansion`, `trend_up`, `trend_down`.

---

## 6. Scoring Updates

### `FAMILY_IDEAL_REGIMES` (`scoring.ts`)

Updated to include `"ranging"` for families that benefit from it:

| Family | Ideal Regimes |
|---|---|
| `trend_continuation` | `trend_up`, `trend_down`, `breakout_expansion` |
| `mean_reversion` | `mean_reversion`, `ranging` |
| `breakout_expansion` | `compression`, `breakout_expansion`, `trend_up`, `trend_down` |
| `spike_event` | `spike_zone`, `ranging` |
| `trendline_breakout` | `compression`, `ranging`, `breakout_expansion`, `trend_up`, `trend_down` |

### Regime Data Source

Regime fit, trend alignment, and volatility condition scores use the hourly-cached regime from `platform_state`. Setup quality, reward/risk, and probability of success are computed per-signal in real time.

---

## 7. Entry Simplification

### Two Positions Per Symbol (Different Strategies)

- No more probe/confirmation/momentum stages.
- Each symbol allows up to **2 concurrent positions** from different strategy families.
- Same strategy family blocked on same symbol if already open.
- Position size = `equity_pct_per_trade` (from settings) × equity.

### Signal Quality Gates

Signals must pass these minimum thresholds (configurable per mode in settings):

| Setting | Paper | Demo | Real |
|---|---|---|---|
| `min_composite_score` | 55 | 65 | 75 |
| `min_ev_threshold` | 0.001 | 0.001 | 0.001 |
| `min_rr_ratio` | 1.5 | 1.5 | 1.5 |

### Trade Frequency Target

8-15 trades per symbol per month. Thresholds calibrated for Boom/Crash/Volatility synthetic indices.

---

## 8. Removed V1 Concepts

### Settings Removed

| Setting | Reason |
|---|---|
| `tp_multiplier_strong/medium/weak` | Replaced by S/R + Fib TP |
| `sl_ratio` | Replaced by S/R + Fib SL |
| `tp_capture_ratio` | No longer applicable |
| `min_sl_atr_multiplier` | SL uses spike drift (Boom/Crash) or structural S/R (Volatility) |
| `trailing_stop_pct` | Replaced by 30% profit trailing |
| `peak_drawdown_exit_pct` | Replaced by profit trailing |
| `min_peak_profit_pct` | Removed (trailing activates on any profit) |
| `large_peak_threshold_pct` | Removed |
| `time_exit_window_hours` | Removed — no time exits |
| `probe_threshold` | No entry stages |
| `confirmation_threshold` | No entry stages |
| `momentum_threshold` | No entry stages |
| `stage_multiplier_probe/confirmation/momentum` | No entry stages |
| All per-family overrides (`*_tp_atr_multiplier`, `*_sl_atr_multiplier`, `*_initial_exit_hours`, `*_extension_hours`, `*_max_exit_hours`, `*_harvest_sensitivity`) | Trade management is now universal |

### Code Removed

| Concept | Files Affected |
|---|---|
| `evaluateProfitHarvest()` | `tradeEngine.ts` |
| `calculateTrailingStop()` (price-based) | `tradeEngine.ts` |
| `calculateDynamicTP()` / `calculateInitialSL()` | `tradeEngine.ts` |
| `FAMILY_HOLD_PROFILE` | `tradeEngine.ts` |
| Entry stage logic (probe/confirmation/momentum) | `signalRouter.ts`, `extractionEngine.ts` |
| `FamilyProfileSection` UI component | `settings.tsx` |
| Per-family config sections in UI | `settings.tsx` |

---

## 9. Settings Inventory (V2)

### Configurable Settings (Per Mode)

| Setting | Paper Default | Demo Default | Real Default | Description |
|---|---|---|---|---|
| `capital` | 10000 | 600 | 600 | Starting capital |
| `equity_pct_per_trade` | 30 | 20 | 15 | % of equity per position |
| `max_open_trades` | 4 | 3 | 3 | Max simultaneous positions |
| `allocation_mode` | aggressive | balanced | balanced | Capital deployment aggressiveness |
| `min_composite_score` | 55 | 65 | 75 | Min composite score for entry |
| `min_ev_threshold` | 0.001 | 0.001 | 0.001 | Min expected value |
| `min_rr_ratio` | 1.5 | 1.5 | 1.5 | Min reward-to-risk ratio |
| `max_daily_loss_pct` | 8 | 5 | 3 | Daily loss limit |
| `max_weekly_loss_pct` | 15 | 10 | 6 | Weekly loss limit |
| `max_drawdown_pct` | 25 | 18 | 12 | Kill switch drawdown |
| `extraction_target_pct` | 50 | 50 | 50 | Profit extraction target |
| `auto_extraction` | false | false | false | Auto-extract toggle |
| `correlated_family_cap` | 4 | 3 | 3 | Max trades per instrument family |

### Non-Configurable Constants (Hardcoded in V2)

| Constant | Value | Location |
|---|---|---|
| `PROFIT_TRAIL_DRAWDOWN_PCT` | 0.30 | `tradeEngine.ts` |
| Boom/Crash TP target | 50% of 90-day price range (min 10%) | `calculateSRFibTP` |
| Boom/Crash TP floor | 10% of entry price | `calculateSRFibTP` |
| Boom/Crash SL drift | 5% of 90-day range (min 2%) | `calculateSRFibSL` |
| Boom/Crash SL min drift | 2% | `calculateSRFibSL` |
| Volatility TP | 70% of major swing range | `calculateSRFibTP` |
| Volatility SL buffer | 0.3% outside cluster | `calculateSRFibSL` |
| Safety floor SL | 10% equity | `calculateSRFibSL` |
| Spike rolling window | 60-90 days | `getSpikeMagnitudeStats` |
| Structural candle window | 1500 candles | `computeFeatures` |
| Fast indicator window | 100 candles | `computeFeatures` |
| Regime cache TTL | 1 hour | `regimeEngine.ts` |

---

## 10. Backtest Engine Alignment

The backtest engine (`backtestEngine.ts`) mirrors all V2 logic:

- Uses `calculateSRFibTP` and `calculateSRFibSL` for entry TP/SL (spike-magnitude-aware).
- Passes `spikeMagnitudeBySymbol` from `getSpikeMagnitudeStats()` with `beforeTs` anchor to prevent lookahead bias.
- Uses `calculateProfitTrailingStop` for trailing.
- No time exits — trades hold until TP, SL, or trailing stop.
- Feature computation with 1500-candle LOOKBACK includes `swingHigh`, `swingLow`, `majorSwingHigh`, `majorSwingLow`, `spikeMagnitude`, `fibRetraceLevels`, `fibExtensionLevels`, `bbUpper`, `bbLower`, `vwap`, `pivotPoint`, `pivotR1`–`R3`, `pivotS1`–`S3`, `camarillaH3/H4/L3/L4`, `psychRound`, `prevSessionHigh/Low/Close`.
- Default thresholds raised: minComposite 80 (paper), minEv 0.001, minRr 1.5.
- Multi-position: up to 2 positions per symbol (different strategies).
- Removed: old ATR-based SL/TP, `calculateTrailingStop`, `INITIAL_EXIT_HOURS`/`EXTENSION_HOURS`/`MAX_EXIT_HOURS`.

---

## 11. AI Integration Updates

### Signal Verification Prompt (`openai.ts`)

- Removed `entryStage` from the `SignalContext` interface.
- AI prompt updated to reflect V2 spike-magnitude-aware trade management:
  - Boom/Crash TP from spike p75, SL from 30% median drift.
  - Volatility TP from 70% major swing range, SL from structural confluence.
  - References 30% profit trailing stop (safety net only).
  - Explicitly states NO time exits — trades hold until TP/SL/trailing.
  - No ATR-based TP/SL references.
  - No longer mentions entry stages or profit harvesting.

### AI Mandate

- AI **never** auto-changes settings.
- Blocked signals receive `aiVerdict="skipped"`.
- AI provides analysis and recommendations only.

---

## 12. File-by-File Change Summary

| File | Changes |
|---|---|
| `features.ts` | Added `swingHigh`, `swingLow`, `fibRetraceLevels`, `fibExtensionLevels`, `bbUpper`, `bbLower`, `vwap`, pivots (classic + Camarilla), `psychRound`, `prevSessionHigh/Low/Close` to `FeatureVector`; added `computeVWAP`, `computePivotPoints`, `computePsychologicalRound`, `getPreviousSession` helpers |
| `regimeEngine.ts` | Added `"ranging"` regime, `"trendline_breakout"` family, hourly caching via `getCachedRegime`/`cacheRegime`, updated `STRATEGY_PERMISSION_MATRIX` |
| `strategies.ts` | Widened entry thresholds for synthetics; added `trendlineBreakout()` strategy; replaced ATR-based SL/TP with `calculateSRFibTP`/`calculateSRFibSL` calls |
| `tradeEngine.ts` | Added `calculateSRFibTP`, `calculateSRFibSL` with pivot/VWAP/psychRound/prevSession confluence; added `calculateProfitTrailingStop`; removed legacy SL/TP functions |
| `signalRouter.ts` | Removed entry stage logic; allows 2 positions per symbol (blocks same strategy on same symbol); lowered composite/EV/RR defaults |
| `scoring.ts` | Widened volatility ranges (0.015-0.030); raised non-ideal regime score 15→40 |
| `model.ts` | Added `trendline_breakout` family weights and rule configs |
| `extractionEngine.ts` | Removed entry stage references |
| `scoring.ts` | Updated `FAMILY_IDEAL_REGIMES` to include `"ranging"` |
| `backtestEngine.ts` | Mirrored all V2 changes: S/R+Fib TP/SL, profit trailing, no time exits |
| `scheduler.ts` | Integrated regime caching in scanner; removed V1 setting references |
| `openai.ts` | Updated `SignalContext` interface and AI prompt for V2 |
| `settings.tsx` | Removed V1 settings from defaults and UI; added Signal Quality Thresholds and Trade Management info card |

---

*V1_SPECIFICATION.md is preserved unchanged as historical reference.*
