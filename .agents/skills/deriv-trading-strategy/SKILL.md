---
name: deriv-trading-strategy
description: Complete trading strategy research, philosophy, and calibration data for Deriv synthetic indices (Boom/Crash/Volatility). SINGLE SOURCE OF TRUTH for all strategy parameters, TP/SL rules, scoring thresholds, and empirical findings. Use when modifying any trading logic, strategy thresholds, signal scoring, trade management, backtest engine, or AI suggestions. All code must conform to this skill — never the other way around.
---

# Deriv Trading — Long Hold Strategy

> **This file is the SINGLE SOURCE OF TRUTH.** All trading code, strategy thresholds, scoring parameters, TP/SL calculations, and AI behavior must conform to this document. If code contradicts this skill, the code is wrong.

---

## Section 1 — Core Philosophy & Mandates

### Trading Philosophy
- **Large capital, long hold, max profit** — swing trades on highest-probability signals only
- **TP targets full spike magnitude (50-200%+)** — TP is the PRIMARY exit
- **NEVER scalp** — no 1-5% micro-trades, no high-frequency entries
- **NEVER reduce TP targets** — the system targets the full move, not partial captures

### Exit Hierarchy (NO time-based exits)
1. **TP hit** — primary exit, targeting full 50-200%+ moves
2. **SL hit** — 1:5 R:R derived from TP
3. **30% trailing stop** — safety net, activates only after reaching 30% of TP target distance

There is **NO 72-hour time exit**. Research shows trades hold 9-44 days. The trailing stop handles profit protection. Trades stay open until TP, SL, or trailing stop closes them.

### Capital Turnover
- Trade full capital at least 1-2x per month
- System should always be scanning for the next high-conviction setup once a trade closes
- ~8-9 swing trades per month across 4 symbols keeps capital active

### Active Trading Symbols
Only 4 symbols are traded: **CRASH300, BOOM300, R_75, R_100**

All other symbols are for data collection and research only.

### Scoring Thresholds (DO NOT CHANGE)
| Mode | Min Composite Score |
|------|-------------------|
| Paper | **85** |
| Demo | **90** |
| Real | **92** |

### Critical Mandates — NEVER VIOLATE
1. TP targets 50-200%+ full spike magnitude — NEVER reduce
2. Trailing stop is SAFETY NET ONLY — activates after 30% of TP target reached
3. Never use ATR-based TP/SL exits — all exits from market structure and spike magnitude
4. Use 1500+ candle structural windows for swing levels, VWAP, pivots, Fibonacci
5. Strategy directionality: **CRASH → BUY** after swing low. **BOOM → SELL** after swing high.
6. No time-based forced exits — the trailing stop handles profit protection
7. Each strategy must be calibrated PER SYMBOL — no universal static thresholds

---

## Section 2 — Empirical Research Findings

### Walk-Forward Analysis: 6 Months of Data, All 4 Active Symbols

#### CRASH300 — 185% Total Range, 11 Major Swings
| Direction | Magnitude | Duration | Entry Pattern |
|-----------|-----------|----------|---------------|
| UP | +176% | 44 days | Crash spike cluster (7+ in 24h), 14% decline, reversal |
| UP | +79% | 17 days | Crash spike cluster (5+ in 24h), 8% decline, reversal |
| UP | +45% | 9 days | Crash spike cluster (3-5 in 24h), 5% decline |
| DOWN | -62% | 24 days | 7d rally +21%, 23 spikes in 7d, exhaustion cascade |
| DOWN | -45% | 14 days | 7d rally +15%, 18 spikes in 7d, failed recovery |
| DOWN | -33% | 13 days | 7d rally +8%, 14 spikes in 7d, momentum fade |

**Entry patterns discovered:**
- **Every swing LOW**: Cluster of crash spikes (3-7 in 24h, 7-10+ in 4h), 24h decline of 5-14%, then reversal UP for 25-176%
- **Every swing HIGH**: 7d rally of 8-21%, 14-23 crash spikes in 7d but price kept recovering, then exhaustion cascade DOWN 21-62%
- **Trade frequency**: ~2 swings/month, hold 4-44 days

#### BOOM300 — 245% Total Range, 9 Major Swings (23-47% each)
- **Mirror image of CRASH300 but inverted**
- Boom spikes UP between downward drifts
- Entry: SELL after swing high / boom spike cluster exhaustion
- Entry: BUY after sustained drift-down exhaustion (swing low)
- **Trade frequency**: ~1.5 swings/month, hold 2-24 days

#### R_75 — 220% Total Range, 19 Major Swings (12-52%)
- **Most active instrument** — swings every 5-18 days
- Average swing ~22% over 8 days
- No spike-specific behavior — continuous random walk with mean reversion
- Entry based on: price at 30-day range extreme + directional reversal confirmation
- **Trade frequency**: ~3 swings/month, hold 3-18 days

#### R_100 — 164% Total Range, 11 Major Swings (18-92%)
| Direction | Magnitude | Duration |
|-----------|-----------|----------|
| UP | +92% | 27 days |
| UP | +67% | 11 days |
| DOWN | -39% | 13 days |
| DOWN | -37% | 15 days |

- Bigger moves but less frequent than R_75
- **Trade frequency**: ~2 swings/month, hold 3-27 days

#### Aggregate Statistics
| Metric | Value |
|--------|-------|
| Total trades/month (all symbols) | ~8-9 |
| Active positions at any time | 2-4 |
| Average hold time | 3-44 days |
| Move capture target | 20-176% per swing |
| Win target | 75%+ of detected swings |

### What The Current System Gets Wrong
1. `spike_event` uses hazard score threshold (>0.70) — triggered only 6 times in 6 months vs 1,096 real spikes
2. `mean_reversion` waits for RSI<32 + zScore<-1.8 — lagging indicators that fire on noise
3. `breakout_expansion` looks for BB squeeze — ZERO compression-breakout patterns exist on synthetics
4. Static thresholds applied universally — BOOM300 behavior ≠ R_100 behavior
5. EMA slope thresholds (0.0002) not normalized to instrument price/ATR
6. 72h time exit killed trades that needed 9-44 days to reach TP

---

## Section 3 — Instrument Family Behavior

### Boom Indices (BOOM300)
- **Spike direction**: Price spikes UPWARD periodically
- **Drift direction**: Price drifts DOWN between upward spikes
- **Primary trade**: SELL after swing high / spike cluster exhaustion
- **How it works**: Boom 300 has a 1-in-300 chance per tick of an upward spike. Between spikes, price slowly drifts downward. The strategy sells after price has been pushed up by multiple boom spikes and shows signs of exhaustion.

### Crash Indices (CRASH300)
- **Spike direction**: Price drops DOWNWARD periodically via spikes
- **Drift direction**: Price drifts UP between downward spikes
- **Primary trade**: BUY after swing low / spike cluster exhaustion
- **How it works**: Crash 300 has a 1-in-300 chance per tick of a downward spike. Between spikes, price slowly drifts upward. The strategy buys after price has been pushed down by multiple crash spikes and shows signs of exhaustion/recovery.

### Volatility Indices (R_75, R_100)
- **Behavior**: Continuous random walk, mean-reverting over multi-day periods
- **No spike-specific behavior** — pure price action and technicals
- **Primary trade**: BUY or SELL based on trend/reversal signals at range extremes
- **How it works**: Price oscillates within ranges. When it reaches the extreme of its 30-day range and shows reversal signals, enter counter-trend.

### Spike Counting Method
- **CRASH**: `rawMove < -0.01` (1%+ single-candle price drops are spikes)
- **BOOM**: `rawMove > 0.01` (1%+ single-candle price rises are spikes)
- Count rolling windows: 4h, 24h, 7d

---

## Section 4 — The Five Strategy Families

### 4.1 Trend Continuation
**What it captures**: After a confirmed swing reversal, ride the new trend direction.

**CRASH (BUY)** — ride the upward drift after swing low:
- Confirmed swing low: `distFromRange30dLowPct < 0.03` AND `priceChange24hPct > 0.005`
- Drift up confirmed: `emaSlope > 0.0002`
- Not exhausted: RSI 35-70
- Trend confirmed: 24h change > 1%
- Not overextended: > 2% below 30-day high

**BOOM (SELL)** — ride the downward drift after swing high:
- Confirmed swing high: `distFromRange30dHighPct > -0.03` AND `priceChange24hPct < -0.005`
- Drift down confirmed: `emaSlope < -0.0002`
- Not exhausted: RSI 30-65
- Trend confirmed: 24h change < -1%
- Not overextended: > 2% above 30-day low

**VOLATILITY (BUY/SELL)**:
- Confirmed reversal with EMA slope alignment (>0.0003 or <-0.0003)
- Pullback to EMA (|emaDist| < 0.01), RSI 35-65

### 4.2 Mean Reversion
**What it captures**: Price at multi-day/multi-week extremes showing exhaustion.

**CRASH (BUY)**: Near 30d low (< 3%), 7d decline > 5%, RSI < 35
**BOOM (SELL)**: Near 30d high (> -3%), 7d rally > 5%, RSI > 65
**VOLATILITY**: z-score extremes (±1.5) with multi-day moves

Also triggers on **liquidity sweep**: swing breached AND reclaimed within 3 candles, small candle body < 0.35.

### 4.3 Spike Cluster Recovery
**What it captures**: The reversal after a cluster of spikes exhausts the move. This is the highest-conviction setup for Boom/Crash.

**Boom/Crash only** (returns null for Volatility indices).

Entry conditions:
- 3+ spikes in 4h OR 5+ spikes in 24h
- 5%+ 24h exhaustion move (CRASH: decline, BOOM: rally)
- Reversal candle (CRASH: green candle, BOOM: red candle), small body < 0.40
- EMA slope flattening toward zero

**From the research**: This is exactly the pattern at EVERY major swing low/high in CRASH300 and BOOM300.

### 4.4 Swing Exhaustion
**What it captures**: The end of a sustained multi-day move where momentum is fading.

**CRASH (SELL — counter-trend exit signal)**:
- 14+ spikes in 7d
- Price up 8%+ in 7d
- Near 30d high
- Failed new high in 24h (momentum loss): `priceChange24hPct < 0.005`
- Slope turning down: `emaSlope < 0.0001`

**BOOM (BUY — counter-trend entry after exhaustion)**:
- 14+ spikes in 7d
- Price down 8%+ in 7d
- Near 30d low
- Failed new low in 24h: `priceChange24hPct > -0.005`
- Slope turning up: `emaSlope > -0.0001`

**VOLATILITY**: 10%+ 7d move near range extremes, RSI extreme (>72/<28), failed continuation in 24h

### 4.5 Trendline Breakout
**What it captures**: Break of a multi-touch support/resistance trendline with momentum confirmation.

Entry conditions:
- 2+ trendline touches (resistance or support)
- Price breaks through with momentum: `atrAccel > 0.01`, `candleBody > 0.30`
- Break distance within 2.5× ATR
- EMA slope aligned with breakout direction

---

## Section 5 — TP/SL & Trade Management

### Take-Profit — Boom/Crash Indices (Spike-Magnitude-Aware)
1. Primary TP = 50% of `longTermRangePct` from rolling 60-90 day spike analysis
2. Minimum TP floor = 10% of entry price
3. Targets full spike travel (50-200%+ moves). Never scalp.

### Take-Profit — Volatility Indices (Structural S/R)
1. TP = entry ± 70% of major swing range (from 1500+ candle structural levels)
2. Minimum range floor = 2% of entry price

### Stop-Loss — All Instruments
1. SL distance = TP distance / 5 (**1:5 R:R ratio**)
2. Safety cap: max loss = 10% of equity per position
3. No independent SL calculation — derived from TP

### 30% Peak-Profit Trailing Stop (PRIMARY PROFIT PROTECTION)
- **Activation**: Only after trade reaches 30% of TP target distance
- **Before activation**: Only fixed SL protects downside
- **After activation**: Tracks peak unrealized profit
- **Trigger**: Profit drops 30% from peak (e.g., peak 10% → exit at 7%)
- Constant: `PROFIT_TRAILING_DRAWDOWN_PCT = 0.30`

### Exit Priority (NO time exits)
1. **TP hit** (primary) — targeting full 50-200%+ moves
2. **SL hit** — 1:5 R:R derived from TP
3. **30% trailing stop** — activates after 30% of TP target reached

### Position Sizing
- Size = equity × `equity_pct_per_trade` × clamp(confidence, 0.5, 1.0)
- Minimum: 5% of equity
- Maximum: remaining capacity within 80% equity deployment cap
- Max open trades: 3-6 (configurable per mode)
- Max per symbol: 2 (different strategy families)

### Constants
| Constant | Value | Location |
|----------|-------|---------|
| R:R Ratio | 5 | `tradeEngine.ts` |
| Boom/Crash TP target | 50% of 90-day range | `calculateSRFibTP` |
| Boom/Crash TP floor | 10% of entry | `calculateSRFibTP` |
| Vol TP | 70% of major swing range | `calculateSRFibTP` |
| Vol TP floor | 2% of entry | `calculateSRFibTP` |
| Equity safety cap | 10% per position | `calculateSRFibSL` |
| Trailing drawdown | 30% | `PROFIT_TRAILING_DRAWDOWN_PCT` |
| Trailing activation | 30% of TP target | `calculateProfitTrailingStop` |

---

## Section 6 — Scoring System (Big Move Readiness)

### Overview
Empirical Big Move Readiness Score with **per-symbol calibrated breakpoints** based on research of actual 50-200%+ moves. No ML model — pure rule-based scoring from observed preconditions. Each symbol has its own scoring breakpoints matching its empirical swing characteristics.

### Readiness Score (5 Dimensions, 0-100)

| Dimension | Weight | What It Measures |
|-----------|--------|-----------------|
| Range Position | **25%** | Proximity to 30-day range extreme (per-symbol tiers) |
| MA Deviation | **20%** | Distance from EMA20 on HTF candles (per-symbol tiers) |
| Volatility Profile | **20%** | ATR rank + BB width expansion (per-symbol ATR/BB bonuses) |
| Range Expansion | **15%** | BB width rate-of-change, ATR acceleration (per-symbol tiers) |
| Directional Confirmation | **20%** | Reversal candle + slope + RSI + multi-day setup (per-symbol RSI thresholds) |

### Per-Symbol Scoring Breakpoints

**Range Position — buy direction (distance from 30d low for score 100):**
| Symbol | 100 | 85 | 70 | 55 | 40 | <40 |
|--------|-----|----|----|----|----|-----|
| CRASH300 | ≤8% | ≤15% | ≤22% | ≤30% | ≤38% | >38% |
| BOOM300 | ≤7% | ≤12% | ≤18% | ≤25% | ≤32% | >32% |
| R_75 | ≤5% | ≤10% | ≤14% | ≤18% | ≤22% | >22% |
| R_100 | ≤4% | ≤8% | ≤12% | ≤16% | ≤20% | >20% |

**MA Deviation — absolute EMA distance for score tiers (must be correct side):**
| Symbol | 95 | 85 | 70 | 55 | 40 |
|--------|----|----|----|----|-----|
| CRASH300 | ≥10% | ≥7% | ≥4% | ≥2% | ≥1% |
| BOOM300 | ≥8% | ≥6% | ≥3.5% | ≥1.8% | ≥0.8% |
| R_75 | ≥6% | ≥4% | ≥2.5% | ≥1.2% | ≥0.5% |
| R_100 | ≥6% | ≥4% | ≥2% | ≥1% | ≥0.5% |

All breakpoints defined in `scoring.ts` via `getSymbolScoringBreakpoints(symbol)`.

### Per-Symbol EV (Expected Value)

EV is computed using per-symbol empirical win/loss magnitudes:
| Symbol | Avg Win % | Avg Loss % | Median Hold |
|--------|-----------|-----------|-------------|
| CRASH300 | 42% | 8.4% | 8 days |
| BOOM300 | 30% | 6.0% | 6 days |
| R_75 | 18% | 3.6% | 5 days |
| R_100 | 17% | 3.4% | 2 days |

Defined in `model.ts` via `SYMBOL_EMPIRICAL_DATA`. Loss % = 20% of win % (1:5 R:R).

### Signal Metadata
Each signal candidate includes empirical metadata:
- `expectedMovePct` — estimated move based on historical average × capture rate
- `expectedHoldDays` — median hold time from empirical data
- `captureRate` — estimated percentage of move captured based on entry position
- `empiricalWinRate` — historical win probability estimate

### Indicator Timeframe Alignment
All indicators (RSI, EMA, ATR, BB, z-score) are computed on **higher-timeframe aggregated candles**, not 1m:
| Symbol | Indicator TF | Rationale |
|--------|-------------|-----------|
| CRASH300 | 12h | 8-day median hold, slow drifts between spike clusters |
| BOOM300 | 8h | 6-day median hold, intermediate speed |
| R_75 | 4h | 5-day median hold, clean swing patterns |
| R_100 | 4h | 2-day median hold, fastest but still multi-hour swings |

Percentage features (24h change, 7d change, 30d range, spike counting) remain on 1m timestamp lookback. Implemented via `aggregateCandles()` and `getSymbolIndicatorTimeframeMins()` in `features.ts`.

### State Keys for Weights
- `scoring_weight_range_position` (default: 25)
- `scoring_weight_ma_deviation` (default: 20)
- `scoring_weight_volatility_profile` (default: 20)
- `scoring_weight_range_expansion` (default: 15)
- `scoring_weight_directional_confirmation` (default: 20)

### Composite Score Thresholds
| Mode | Min Composite Score |
|------|-------------------|
| Paper | **85** |
| Demo | **90** |
| Real | **92** |

Additional filters: EV ≥ 0.001, R:R ≥ 1.5

### Signal Confirmation
Signals must persist across 2 consecutive 60-minute evaluation windows:
- Window = 60 minutes (1 hour boundary)
- Required confirmations = 2 (initial detection + 1 re-confirmation)
- Price must not reverse >0.5% against signal direction between windows
- Stale expiry = 4 hours (if gap > 4h between confirmations, signal resets)
- Pyramiding requires 3 confirmations + 1% price move in expected direction
- Implemented in `pendingSignals.ts`

**Design note — why fixed 60m windows instead of per-symbol candle-boundary confirmation:**
Indicator HTF timeframes (4h-12h) are too long for confirmation windows. Waiting 12+ hours for a single CRASH300 confirmation would miss actionable entries. The 60-minute fixed window provides a practical balance: long enough to filter noise, short enough to capture signals while the setup is still valid. Indicator timeframes control *what* the scoring sees; confirmation windows control *how long* a signal must persist before execution.

### Regime Engine (Informational Only)
The regime engine classifies market state but does NOT gate strategy execution. All 5 strategy families are allowed in ALL regime states, including `no_trade`. Regime classification is logged for analysis but never blocks signals.

---

## Section 7 — Forex Royals Reference (Proven Working Bots)

The user's brother runs profitable bots on Deriv synthetics. These are the reference benchmarks:

| Bot | Symbol | Entry | TP | SL | R:R | Gain | Hold |
|-----|--------|-------|----|----|-----|------|------|
| BOOM HUNTER X | Boom 300 | 1812 | 2412 (600pt) | 1462 (350pt) | 1.7:1 | 10.76% | Days |
| SKY BREAK | Boom 300 | Same setup | Same | Same | Same | 3 lots | Days |
| FXR-S3 | Crash 500 | 3186 | 2836 (350pt) | 3436 (250pt) | 1.4:1 | 4.18% | Days |

**Key insights from Forex Royals:**
- On $1,364 balance generating $808 floating profit (59% return)
- Wide SL/TP (hundreds of points), not tight scalping levels
- Multiple simultaneous positions on same symbol (different lot sizes)
- Simple RSI + EMA + price action timing
- R:R ratios of 1.4:1 to 2:1 are normal and profitable for these instruments

---

## Section 8 — Multi-Timeframe Analysis

### Available Timeframes
| Category | Timeframes | Purpose |
|----------|-----------|---------|
| Micro | 1m, 5m | Tick-level entry timing, spike detection |
| Short | 15m, 1h, 2h | Intraday patterns, short-term structure |
| Medium | 4h, 8h, 12h | Multi-session structure, regime detection |
| Long | 1d, 2d, 4d | Swing structure, multi-day trends |
| Macro | 7d, 15d, 30d | Trend direction, range boundaries |

### Multi-Timeframe Confluence
Higher timeframes reveal patterns invisible on 1m/5m data:
- **4h/8h**: Confirms whether a spike cluster is truly exhausting or just a blip
- **1d/2d**: Shows the multi-day swing structure that defines TP targets
- **7d/15d**: Shows the macro trend and range boundaries for the 30-day range position score
- **30d**: Monthly range for long-term trend assessment

Strategies should reference multi-timeframe confluence for highest-conviction entries. A signal that aligns across 1h, 4h, and 1d timeframes is far higher conviction than one visible only on 1m.

### Data Infrastructure
- Live tick aggregation populates all timeframes automatically from incoming ticks
- Historical enrichment aggregates existing 1m candle data into all higher timeframes
- Candles table stores: symbol, timeframe, openTs, closeTs, open, high, low, close, tickCount

---

## Section 9 — AI Monthly Recalibration Process

### Overview
The AI within the app uses EXISTING collected data (ticks are already streaming, candles already aggregated — no new download needed) to continuously improve strategy calibration.

### Monthly Recalibration Steps
1. **Identify big moves**: Query existing candle data for all moves of 25%+ within any 7-day window in the latest month
2. **Measure entry conditions**: For each big move, record the exact feature values at the entry point (EMA slope, RSI, range position, spike count, distance from MA, etc.)
3. **Test current settings**: Run the current strategy thresholds against each move — does the system detect it?
4. **Iterative refinement**: If a move is NOT detected:
   - Adjust the relevant strategy threshold
   - Test again
   - Repeat until it detects the move
5. **Per-symbol, per-strategy**: Do this for EACH big move on EACH symbol for EACH strategy family
6. **Average thresholds**: Once all moves are detected individually, average the successful detection thresholds across all moves per strategy per symbol
7. **Walk-forward validation**: Run a full backtest with the averaged settings — verify it still catches all known events without excessive false positives
8. **Trend analysis**: Compare results to previous month:
   - Are profits increasing or decreasing?
   - Are any strategies catching fewer moves? (degradation detection)
   - Has a strategy that was profitable become unprofitable? (broker may have changed algorithm)
9. **Generate suggestions**: Output specific settings suggestions with values and rationale
10. **Flag degradation**: If a strategy family is losing effectiveness across 2+ consecutive months, flag it for review

### Key Principle
The system is **self-sufficient** after initial historical data download. Live tick streaming populates all candle timeframes continuously. The AI recalibration reads from this existing data — it never needs to download new data.

---

## Section 10 — Per-Symbol Strategy Calibration Research

### Calibration Methodology
Calibration performed on 193 days of 1-minute candle data (Sep 2025 - Mar 2026) across all 4 active symbols.

**Process:**
1. Aggregated 1m candles into daily bars for swing detection
2. Identified major swings using adaptive thresholds: 15% min for Boom/Crash, 10% min for Volatility
3. Analyzed swing characteristics: magnitude, duration, frequency, direction
4. Derived per-symbol thresholds that widen entry conditions for more volatile instruments while preserving false-positive resistance
5. All thresholds implemented in `strategies.ts` via `SYMBOL_THRESHOLDS` lookup — `getSymbolThresholds(symbol)`

### Empirical Swing Statistics (from calibration data)

| Symbol | Total Swings | Swings/Month | Avg Magnitude | Median Hold | Median UP | Median DOWN |
|--------|-------------|-------------|---------------|-------------|-----------|-------------|
| CRASH300 | 20 | 3.1 | UP 42.1%, DOWN 29.0% | 8d | 7d | 9d |
| BOOM300 | 23 | 3.6 | UP 30.2%, DOWN 25.7% | 6d | 5d | 6d |
| R_75 | 38 | 5.9 | UP 17.8%, DOWN 18.2% | 5d | 5d | 5d |
| R_100 | 91 | 14.2 | UP 17.3%, DOWN 15.3% | 2d | 2d | 2d |

### CRASH300 Calibrated Thresholds
20 swings over 193 days. BUY at lows (drift up after spike cluster), SELL at highs (exhaustion).

| Strategy | Key Calibrated Thresholds | Basis |
|----------|--------------------------|-------|
| trend_continuation | distFromRange30dLow < 5%, 24h change > 0.8%, EMA slope > 0.00015, RSI 30-72 | Wider RSI band — CRASH trends run further before exhaustion |
| mean_reversion | distFromRange30dLow < 5%, 7d decline > -8%, RSI < 38 | Needs bigger 7d decline than universal — smaller declines don't reverse |
| spike_cluster_recovery | spikeCount4h >= 3 OR spikeCount24h >= 4, 24h decline > -4%, slope flattening > -0.00015 | Relaxed from 5 to 4 spikes/24h — CRASH clusters form faster |
| swing_exhaustion | spikeCount7d >= 10, 7d rally > 6%, dist from 30d high > -6%, slope < 0.00015 | Relaxed from 14 to 10 spikes/7d — CRASH exhausts with fewer spikes |
| trendline_breakout | 2+ touches, ATR accel > 0.008, candle body > 0.28, ATR mult 2.5x | Slightly more sensitive momentum filter for CRASH breakouts |

### BOOM300 Calibrated Thresholds
23 swings over 193 days. SELL at highs (drift down after spike cluster), BUY at lows (exhaustion).

| Strategy | Key Calibrated Thresholds | Basis |
|----------|--------------------------|-------|
| trend_continuation | distFromRange30dHigh > -5%, 24h change < -0.8%, EMA slope < -0.00015, RSI 28-67 | Mirror of CRASH with wider RSI — BOOM drifts down from higher extremes |
| mean_reversion | distFromRange30dHigh > -5%, 7d rally > 8%, RSI > 62 | Lower RSI threshold — BOOM reverses before extreme RSI readings |
| spike_cluster_recovery | spikeCount4h >= 3 OR spikeCount24h >= 4, 24h rally > 4%, slope flattening < 0.00015 | Same relaxation as CRASH — 4 spikes/24h sufficient for cluster |
| swing_exhaustion | spikeCount7d >= 10, 7d decline > -6%, dist from 30d low < 6%, slope > -0.00015 | BOOM bottoms with fewer spikes than the universal 14 |
| trendline_breakout | 2+ touches, ATR accel > 0.008, candle body > 0.28, ATR mult 2.5x | Same as CRASH — slightly relaxed momentum for BOOM breakdowns |

### R_75 Calibrated Thresholds
38 swings over 193 days. Both BUY and SELL — mean-reverting with larger swings than R_100.

| Strategy | Key Calibrated Thresholds | Basis |
|----------|--------------------------|-------|
| trend_continuation | distFromRange < 8%, 24h change > 0.4%, EMA slope > 0.00025, RSI 33-67, EMA dist < 1.2% | Wider range proximity — R_75 swings cover 10-52% so 8% from edge is still entry territory |
| mean_reversion | distFromRange < 5%, 7d change > 7%, z-score > 1.3 | Relaxed z-score from 1.5 — R_75 mean-reverts before extreme z readings |
| swing_exhaustion | 7d change > 8%, distFromRange < 4%, RSI extreme > 70/< 30, 24h fail < 0.3% | No spike count requirement — R_75 doesn't have crash/boom spikes; uses RSI extremes instead |
| trendline_breakout | 2+ touches, ATR accel > 0.01, candle body > 0.30, ATR mult 2.5x | Standard trendline thresholds — R_75 has clean trendline patterns |

### R_100 Calibrated Thresholds
91 swings over 193 days. Most active instrument — both BUY and SELL. Fast, frequent swings averaging 2 days.

| Strategy | Key Calibrated Thresholds | Basis |
|----------|--------------------------|-------|
| trend_continuation | distFromRange < 6%, 24h change > 0.3%, EMA slope > 0.0002, RSI 32-68, EMA dist < 1.2% | Tighter range than R_75 — R_100 reverses faster so needs earlier entry detection |
| mean_reversion | distFromRange < 4%, 7d change > 6%, z-score > 1.2 | Most sensitive z-score — R_100 mean-reverts fastest of all 4 instruments |
| swing_exhaustion | 7d change > 7%, distFromRange < 4%, RSI extreme > 68/< 32, 24h fail < 0.3% | Most sensitive RSI extremes — R_100 exhausts at lower RSI readings than R_75 |
| trendline_breakout | 2+ touches, ATR accel > 0.01, candle body > 0.30, ATR mult 2.5x | Same as R_75 — volatility indices share trendline characteristics |

### Threshold Implementation
All per-symbol thresholds are in `strategies.ts` as typed constant objects:
- `CRASH_THRESHOLDS` — applied to CRASH300 and all CRASH variants
- `BOOM_THRESHOLDS` — applied to BOOM300 and all BOOM variants
- `R75_THRESHOLDS` — applied to R_75
- `R100_THRESHOLDS` — applied to R_100
- `getSymbolThresholds(symbol)` — runtime lookup by symbol name

Key differences from previous universal thresholds:
- Boom/Crash: Relaxed spike counts (10 vs 14), wider RSI bands, bigger 7d move requirements
- R_75: Wider range proximity (8%), relaxed z-score, no spike count for exhaustion
- R_100: Most sensitive thresholds — smallest 24h change, lowest z-score, tightest RSI extremes
- All symbols: Relaxed candle body and slope flattening thresholds for better signal capture

---

## Section 11 — Settings Reference

### Configurable Per-Mode Settings
| Setting | Paper | Demo | Real |
|---------|-------|------|------|
| `capital` | 10000 | 600 | 600 |
| `equity_pct_per_trade` | 30 | 20 | 15 |
| `max_open_trades` | 4 | 3 | 3 |
| `allocation_mode` | aggressive | balanced | balanced |
| `min_composite_score` | **85** | **90** | **92** |
| `min_ev_threshold` | 0.001 | 0.001 | 0.001 |
| `min_rr_ratio` | 1.5 | 1.5 | 1.5 |
| `max_daily_loss_pct` | 8 | 5 | 3 |
| `max_weekly_loss_pct` | 15 | 10 | 6 |
| `max_drawdown_pct` | 25 | 18 | 12 |
| `extraction_target_pct` | 50 | 50 | 50 |

### Hardcoded Constants
| Constant | Value | File |
|----------|-------|------|
| `PROFIT_TRAILING_DRAWDOWN_PCT` | 0.30 | `tradeEngine.ts` |
| `MAX_EQUITY_DEPLOYED_PCT` | 0.80 | `tradeEngine.ts` |
| `MAX_OPEN_TRADES` | 6 | `tradeEngine.ts` |
| `RR_RATIO` | 5 | `tradeEngine.ts` |
| Structural candle window | 1500 (min) | `features.ts` |
| Indicator bars needed | 55 HTF bars | `features.ts` |
| Indicator TF (CRASH300) | 12h (720 min) | `features.ts` |
| Indicator TF (BOOM300) | 8h (480 min) | `features.ts` |
| Indicator TF (R_75/R_100) | 4h (240 min) | `features.ts` |
| Signal confirmation windows | 2 (60-min) | `pendingSignals.ts` |
| Signal stale expiry | 4 hours | `pendingSignals.ts` |
| Scan interval | 60s | `scheduler.ts` |
| Regime cache TTL | 1 hour | `regimeEngine.ts` |
| Regime gating | NONE (informational) | `regimeEngine.ts` |

---

## Section 12 — Key File Map

### Backend (artifacts/api-server/src/lib/)
| File | Purpose |
|------|---------|
| `strategies.ts` | 5 strategy families — entry conditions, signal generation |
| `tradeEngine.ts` | TP/SL calculation, trailing stop, position sizing, trade lifecycle |
| `backtestEngine.ts` | Walk-forward backtest simulation, mirrors live engine |
| `features.ts` | 40+ technical feature extraction from candle data |
| `model.ts` | Big Move Readiness scoring (5 dimensions) |
| `scoring.ts` | Composite score computation from readiness dimensions |
| `regimeEngine.ts` | Market regime classification (hourly, cached) |
| `signalRouter.ts` | Signal routing, threshold gates, portfolio allocation |
| `pendingSignals.ts` | Multi-window signal confirmation system |
| `deriv.ts` | Deriv WebSocket client, tick streaming, candle aggregation |
| `symbolValidator.ts` | Symbol validation, aliases, status tracking |
| `scheduler.ts` | Periodic signal scanning, AI suggestions |
| `extractionEngine.ts` | Capital extraction cycle management |
| `openai.ts` | AI signal verification, backtest analysis |

### Backend Routes (artifacts/api-server/src/routes/)
| File | Purpose |
|------|---------|
| `research.ts` | Data download, backtest execution, grouped results, AI chat |
| `settings.ts` | Settings CRUD |
| `aiChat.ts` | AI chatbot with system knowledge |

### Frontend (artifacts/deriv-quant/src/pages/)
| File | Purpose |
|------|---------|
| `research.tsx` | Research page — data status, backtest UI, results display |
| `signals.tsx` | Signal monitoring and details |
| `settings.tsx` | Settings configuration UI |
| `overview.tsx` | Dashboard overview |
| `trades.tsx` | Open and closed trades |
| `help.tsx` | Help and version info |

### Specifications
| File | Purpose |
|------|---------|
| `V2_SPECIFICATION.md` | Full V2 system specification |
| `V2_EVOLUTION_BLUEPRINT.md` | Future features roadmap |
| `replit.md` | Project memory and structure reference |
