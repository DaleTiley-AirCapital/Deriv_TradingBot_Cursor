# V2 Specification — Deriv Capital Extraction App

> Complete specification of the V2 trading system. Covers all strategy logic, scoring calibration, trade management, active symbol policy, and AI integration.

---

## Table of Contents

1. [Design Philosophy](#1-design-philosophy)
2. [Symbol Tiers & Active Trading Policy](#2-symbol-tiers--active-trading-policy)
3. [The Five Strategy Families](#3-the-five-strategy-families)
4. [Feature Vector](#4-feature-vector)
5. [Market Regime Engine](#5-market-regime-engine)
6. [Scoring System](#6-scoring-system)
7. [Signal Pipeline](#7-signal-pipeline)
8. [Trade Management — TP/SL](#8-trade-management--tpsl)
9. [Trailing Stop & Exit Policy](#9-trailing-stop--exit-policy)
10. [Position Sizing & Risk Management](#10-position-sizing--risk-management)
11. [Capital Extraction Cycle](#11-capital-extraction-cycle)
12. [AI Integration](#12-ai-integration)
13. [Backtest Engine](#13-backtest-engine)
14. [Settings Inventory](#14-settings-inventory)

---

## 1. Design Philosophy

- **Large capital, long hold, max profit.** Swing trades on highest-probability signals only.
- **TP targets full spike magnitude (50-200%+).** TP is the PRIMARY exit. Trailing stop is SAFETY NET ONLY. Never scalp 1-5% moves.
- **TP/SL derived from market structure + spike magnitude analysis** — never from ATR multiples.
- **Active trading restricted to 4 high-performance symbols** — CRASH300, BOOM300, R_75, R_100.
- **Boom/Crash and Volatility indices treated differently** — spike-magnitude TP for Boom/Crash, structural S/R for Volatility.
- **Trailing stop protects realized profit** — trails at 30% below peak unrealized profit, activates after reaching 30% of TP target.
- **No time-based exits** — trades hold 9-44 days until TP, SL, or trailing stop.
- **Up to 2 positions per symbol** (different strategy families). No multi-stage building.
- **AI verification as strict gate** — disagree unless all 5 criteria met.

### CRITICAL DESIGN MANDATES — DO NOT VIOLATE

1. **TP is PRIMARY exit** targeting full spike magnitude (50-200%+). NEVER reduce TP targets.
2. **Trailing stop is SAFETY NET ONLY** — activates after reaching 30% of TP target.
3. **Never use ATR-based TP/SL exits.** All exits from market structure and spike magnitude.
4. **Use 1500+ candle structural windows** for swing levels, VWAP, pivots, Fibonacci.
5. **Strategy directionality**: CRASH → BUY after swing low exhaustion. BOOM → SELL after swing high exhaustion.

---

## 2. Symbol Tiers & Active Trading Policy

Data is downloaded for all 12 symbols; **active trading is restricted to 4 symbols**.

| Tier | Symbols | Characteristics | Trading Status |
|------|---------|----------------|----------------|
| **High Movers** | CRASH300, BOOM300, R_100 | Largest spike magnitudes, widest ranges, best TP potential | **ACTIVE** |
| **Mid Movers** | CRASH500/600, BOOM500/600, R_75 | Moderate ranges | R_75 **ACTIVE**; others data-only |
| **Slow Movers** | BOOM900/1000, CRASH900/1000 | Smallest moves, lowest TP potential | Data-only |

**Active Trading Set** (`ACTIVE_TRADING_SYMBOLS`): `CRASH300`, `BOOM300`, `R_75`, `R_100`

All other symbols (`V1_DEFAULT_SYMBOLS`, 12 total) have data downloaded for research/backtesting but do NOT generate live trades.

### Instrument Family Directionality

| Family | Spike Behaviour | Primary Trade Direction |
|--------|----------------|----------------------|
| Crash | Price drops periodically via spikes | **BUY** after swing low / spike cluster exhaustion |
| Boom | Price spikes upward periodically | **SELL** after swing high / spike cluster exhaustion |
| Volatility | Continuous random walk | BUY or SELL based on trend/reversal signals |

### Spike Counting

Both live (`features.ts`) and backtest (`backtestEngine.ts`) use directional candle moves >1%:
- CRASH: `rawMove < -0.01` (price drops are spikes)
- BOOM: `rawMove > 0.01` (price rises are spikes)

### Spike Cluster Recovery 24h Exhaustion Gate

- CRASH: `priceChange24hPct < -0.05` (5%+ decline in 24h)
- BOOM: `priceChange24hPct > 0.05` (5%+ rally in 24h)

---

## 3. The Five Strategy Families

### 3.1 Trend Continuation (`minModelScore: 0.60`)

**Crash (BUY)**:
- Confirmed swing low: `distFromRange30dLowPct < 0.03` AND `priceChange24hPct > 0.005`
- Drift up: `emaSlope > 0.0002`
- RSI 35-70, trend confirmed (24h change > 1%), not overextended

**Boom (SELL)**:
- Confirmed swing high: `distFromRange30dHighPct > -0.03` AND `priceChange24hPct < -0.005`
- Drift down: `emaSlope < -0.0002`
- RSI 30-65, trend confirmed (24h change < -1%), not overextended

**Volatility (BUY/SELL)**:
- Confirmed reversal with EMA slope alignment (>0.0003 or <-0.0003)
- Pullback to EMA (`|emaDist| < 0.01`), RSI 35-65

### 3.2 Mean Reversion (`minModelScore: 0.60`)

**Crash (BUY)**: Near 30d low (`< 3%`), 7d decline > 5%, RSI < 35
**Boom (SELL)**: Near 30d high (`> -3%`), 7d rally > 5%, RSI > 65
**Volatility**: z-score extremes (±1.5) with multi-day moves

Also triggers on **liquidity sweep** setup: swing breached AND reclaimed within 3 candles, small candle body < 0.35.

### 3.3 Spike Cluster Recovery (`minModelScore: 0.58`)

**Boom/Crash only** (returns null for Volatility indices).

Entry conditions:
- 3+ spikes in 4h OR 5+ spikes in 24h
- 5%+ 24h exhaustion move (CRASH: decline, BOOM: rally)
- Reversal candle (CRASH: green, BOOM: red), small body < 0.40
- EMA slope flattening toward zero

Scoring uses cluster density and spike hazard score.

### 3.4 Swing Exhaustion (`minModelScore: 0.58`)

**Crash (SELL — counter-trend)**: 14+ spikes/7d, price up 8%+, near 30d high, failed new high in 24h, slope turning down
**Boom (BUY — counter-trend)**: 14+ spikes/7d, price down 8%+, near 30d low, failed new low in 24h, slope turning up
**Volatility**: 10%+ 7d move near range extremes, RSI extreme (>72/<28), failed continuation in 24h

### 3.5 Trendline Breakout (`minModelScore: 0.65`)

Entry conditions:
- 2+ trendline touches (resistance or support)
- Price breaks through with momentum confirmation (`atrAccel > 0.01`, `candleBody > 0.30`)
- Break distance within 2.5x ATR
- EMA slope aligned with breakout direction

---

## 4. Feature Vector

40+ technical features computed from two windows:

**Structural Window (1500+ candles)**: `majorSwingHigh`, `majorSwingLow`, `swingHigh`, `swingLow`, `fibRetraceLevels`, `fibExtensionLevels`, `fibExtensionLevelsDown`, `vwap`, `pivotPoint`, `pivotR1-R3`, `pivotS1-S3`, `camarillaH3/H4/L3/L4`, `psychRound`, `prevSessionHigh/Low/Close`, `spikeMagnitude`

**Fast Window (100 candles)**: `ema20`, `emaSlope`, `emaDist`, `rsi14`, `atr14`, `atrRank`, `atrAccel`, `bbWidth`, `bbUpper`, `bbLower`, `zScore`, `consecutive`, `candleBody`, `spikeCount4h/24h/7d`, `spikeHazardScore`, `priceChange24hPct`, `priceChange7dPct`, `distFromRange30dHighPct`, `distFromRange30dLowPct`, `regimeLabel`, `trendlineSupportLevel/Slope/Touches`, `trendlineResistanceLevel/Slope/Touches`, `swingBreached/Reclaimed/BreachCandles/BreachDirection`

---

## 5. Market Regime Engine

Regime is computed once per symbol per hour and cached in `platform_state`.

| Regime | Detection Criteria | Allowed Strategies |
|--------|-------------------|-------------------|
| `trend_up` | Sustained positive EMA slope, consistent candles | trend_continuation, swing_exhaustion |
| `trend_down` | Sustained negative EMA slope | trend_continuation, swing_exhaustion |
| `mean_reversion` | Price overstretched from mean | mean_reversion, spike_cluster_recovery, swing_exhaustion |
| `ranging` | Flat EMA slope, moderate BB width, no spike hazard | mean_reversion, spike_cluster_recovery, trendline_breakout |
| `compression` | Low BB width, flat slope | trendline_breakout, spike_cluster_recovery |
| `breakout_expansion` | Expanding volatility | trend_continuation, trendline_breakout, swing_exhaustion |
| `spike_zone` | Active Boom/Crash spike cluster | spike_cluster_recovery, swing_exhaustion |
| `no_trade` | Unclear/conflicting signals | NONE — system waits |

---

## 6. Scoring System — Empirical Big Move Readiness (v2)

### 6.1 Overview

Replaced logistic regression with empirical Big Move Readiness Score based on research of actual 50-200%+ moves in Boom/Crash/Volatility indices. No ML model — pure rule-based scoring from observed preconditions.

### 6.2 Readiness Score (5 Dimensions, 0-100)

| Dimension | Weight | What It Measures | Key Thresholds |
|-----------|--------|-----------------|----------------|
| Range Position | **25%** | Proximity to 30-day range extreme (low for buy, high for sell) | ≤18% from extreme = 100, ≤30% = 70, >50% = 0 |
| MA Deviation | **20%** | Distance from 7/14-day moving average | ≥8% deviation = 100, ≥5% = 70, <2% = 0 |
| Volatility Profile | **20%** | Elevated ATR rank + BB width expansion | ATR rank ≥1.3 + BB expanding = 100 |
| Range Expansion | **15%** | BB width rate-of-change, ATR acceleration | Both accelerating = 100 |
| Directional Confirmation | **20%** | Reversal candle pattern + MA slope change | Both present = 100 |

### 6.3 Composite Score Thresholds

| Mode | Min Composite Score |
|------|-------------------|
| Paper | **85** |
| Demo | **90** |
| Real | **92** |

Additional filters: EV ≥ 0.001, R:R ≥ 1.5

---

## 7. Signal Pipeline

1. **Tick Streaming** → Live price ticks from Deriv WebSocket
2. **Feature Extraction** → 40+ features from 1500+100 candle windows
3. **Regime Classification** → Cached hourly per symbol
4. **Strategy Evaluation** → Only regime-permitted strategies run
5. **Big Move Readiness** → Empirical 5-dimension readiness score (rangePosition 25%, maDeviation 20%, volatilityProfile 20%, rangeExpansion 15%, directionalConfirmation 20%)
6. **Composite Threshold** → readiness score must exceed 85/90/92 (paper/demo/real)
7. **Quality Filtering** → composite ≥ 85/90/92, EV ≥ 0.001, R:R ≥ 1.5
8. **AI Verification** → Strict 5-criterion evaluation with strategy-specific checks
9. **Portfolio Allocation** → Daily/weekly loss limits, max drawdown, max open trades, correlated exposure cap
10. **Position Sizing** → equity × pct_per_trade × confidence factor
11. **Execution** → S/R+Fib TP/SL computed, trade opened

---

## 8. Trade Management — TP/SL

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

### Constants

| Constant | Value | Location |
|----------|-------|---------|
| R:R Ratio | 5 | `tradeEngine.ts` |
| Boom/Crash TP target | 50% of 90-day range | `calculateSRFibTP` |
| Boom/Crash TP floor | 10% of entry | `calculateSRFibTP` |
| Vol TP | 70% of major swing range | `calculateSRFibTP` |
| Vol TP floor | 2% of entry | `calculateSRFibTP` |
| Equity safety cap | 10% per position | `calculateSRFibSL` |

---

## 9. Trailing Stop & Exit Policy

### 30% Peak-Profit Trailing (SAFETY NET ONLY)

- **Activation**: Only after trade reaches 30% of TP target (e.g., TP = 50% → activates at +15%)
- **Before activation**: Only fixed SL protects downside
- **After activation**: Tracks peak unrealized profit %
- **Trigger**: Profit drops 30% from peak (e.g., peak 10% → exit at 7%)
- Constant: `PROFIT_TRAILING_DRAWDOWN_PCT = 0.30`

### Exit Priority

1. **TP hit** (primary exit) — targeting full 50-200%+ moves
2. **SL hit** — 1:5 R:R derived from TP
3. **30% trailing stop** — safety net, activates only after 30% of TP target reached

No time-based exits. Research shows trades need 9-44 days. The trailing stop handles profit protection.

---

## 10. Position Sizing & Risk Management

### Position Sizing

- Size = equity × `equity_pct_per_trade` × clamp(confidence, 0.5, 1.0) × allocation_mode multiplier
- Minimum: 5% of equity
- Maximum: remaining capacity within 80% equity deployment cap
- Max open trades: 3 (default), configurable per mode
- Max per symbol: 2 (different strategy families)

### Risk Controls

| Control | Description |
|---------|------------|
| Max equity deployed | 80% (`MAX_EQUITY_DEPLOYED_PCT`) |
| Max open trades | 3 per mode (default) |
| Max per symbol | 2 positions (different strategies) |
| Daily loss limit | Configurable per mode (paper 8%, demo 5%, real 3%) |
| Weekly loss limit | Configurable per mode (paper 15%, demo 10%, real 6%) |
| Max drawdown | Kill switch (paper 25%, demo 18%, real 12%) |
| Correlated family cap | Limits positions in same instrument family |
| Kill switch | Emergency halt — blocks all new trades |

---

## 11. Capital Extraction Cycle

1. Start with base capital
2. Trade until capital grows by `extraction_target_pct` (default 50%)
3. Extract profits (auto or manual), reset to base capital
4. Prevents compound risk

---

## 12. AI Integration

### Signal Verification (`openai.ts`)

AI uses strict 5-criterion evaluation — **disagree unless ALL conditions met**:

1. Direction matches instrument family (CRASH=BUY, BOOM=SELL, Vol=either)
2. Multi-day structural setup confirmed (not intraday noise)
3. Price at genuine exhaustion/reversal point with structural confluence
4. Sufficient room for 50%+ move to TP target
5. Recent candles show genuine reversal/continuation pattern

Each strategy family has additional specific checks (trend strength, overstretch genuineness, spike density, exhaustion significance, trendline validity).

### Per-Symbol Calibrated Thresholds

All 5 strategy families use **per-symbol calibrated thresholds** instead of universal static values. Calibration was performed on 193 days of 1-minute candle data (275k+ candles per symbol) identifying major swings:

- **CRASH300**: 20 swings (3.1/month), avg UP 42.1%, avg DOWN 29.0%, median hold 8d
- **BOOM300**: 23 swings (3.6/month), avg UP 30.2%, avg DOWN 25.7%, median hold 6d
- **R_75**: 38 swings (5.9/month), avg UP 17.8%, avg DOWN 18.2%, median hold 5d
- **R_100**: 91 swings (14.2/month), avg UP 17.3%, avg DOWN 15.3%, median hold 2d

Key calibration adjustments from universal defaults:
- **Boom/Crash**: Relaxed spike counts (10 vs 14 for exhaustion), wider RSI bands, bigger 7d move requirements (-8% vs -5%)
- **R_75**: Wider range proximity (8% vs 3%), relaxed z-score (1.3 vs 1.5), no spike count for exhaustion
- **R_100**: Most sensitive thresholds — smallest 24h change triggers (0.3%), lowest z-score (1.2), tightest RSI extremes (68/32)

Implementation: `getSymbolThresholds(symbol)` in `strategies.ts` returns typed threshold objects (`CRASH_THRESHOLDS`, `BOOM_THRESHOLDS`, `R75_THRESHOLDS`, `R100_THRESHOLDS`). Full calibration data in skill file Section 10.

### AI Advisor (`aiChat.ts`)

- ADVISOR only — never auto-changes settings
- Reads settings, writes suggestions (ai_suggest_ keys) for user review
- Updated knowledge base with:
  - Active symbol tiers (4 active, 8 data-only)
  - Recalibrated scoring weights and thresholds
  - Strategy directionality per instrument family
  - Recalibrated composite score defaults (85/90/92)

---

## 13. Backtest Engine

The backtest engine (`backtestEngine.ts`) mirrors all V2 logic:

- Uses `calculateSRFibTP` and `calculateSRFibSL` for entry TP/SL
- Passes `spikeMagnitudeBySymbol` with `beforeTs` anchor (no lookahead bias)
- Uses `calculateProfitTrailingStop` for trailing
- No time-based exits — trades hold until TP, SL, or trailing stop
- 1500-candle structural window for features
- All symbols with backtest data shown in grouped-results (not just active trading symbols)

---

## 14. Settings Inventory

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
| `MAX_OPEN_TRADES` | 3 | `tradeEngine.ts` |
| `RR_RATIO` | 5 | `tradeEngine.ts` |
| Structural candle window | 1500 | `features.ts` |
| Fast indicator window | 100 | `features.ts` |
| Regime cache TTL | 1 hour | `regimeEngine.ts` |

---

*V1_SPECIFICATION.md is preserved unchanged as historical reference.*
