# V2 Evolution Blueprint

> Planning document for all features to be built **after V1 is stable**.
> This document covers UI enrichment features AND system evolution features.
> **No code changes are included — this is a specification and design document only.**

---

## Table of Contents

1. [V1 Completion Checklist](#section-1-v1-completion-checklist)
2. [UI Enrichment Roadmap](#section-2-ui-enrichment-roadmap)
   - 2a. Research — Backtest Detail Popup
   - 2b. Trades — Enriched Open & Closed Trade Details
   - 2c. Signals — "See Details" Popup
   - 2d. Data — Price Charts with Timeframe Selector
3. [Strategy Threshold Inventory](#section-3-strategy-threshold-inventory)
4. [Dynamic Threshold Calibration](#section-4-dynamic-threshold-calibration)
5. [Strategy Degradation Detection](#section-5-strategy-degradation-detection)
6. [Emerging Pattern Detection](#section-6-emerging-pattern-detection)
7. [Competitive Adaptation](#section-7-competitive-adaptation)
8. [Implementation Phases](#section-8-implementation-phases)

---

## Section 1: V1 Completion Checklist

| Feature | Status |
|---|---|
| Rolling monthly backtests (1 per symbol, all strategies) | ✅ DONE |
| 12-month data retention with auto-pruning | ✅ DONE |
| AI per-backtest chat | ✅ DONE |
| Research page data status with per-symbol health cards | ✅ DONE |
| Setup partial failure handling | ✅ DONE |
| 12-month backfill limit | ✅ DONE |

All V1 features are complete. The items below describe work that begins only once V1 is stable in production.

---

## Section 2: UI Enrichment Roadmap

### 2a. Research — Backtest Detail Popup with Charts & Metrics

**Goal:** When a user clicks a backtest result row in the Research page's grouped results section, a full-screen modal opens showing rich metrics, charts, and the trade list for that backtest run.

#### Metrics Grid

Display the following metrics in a 4×2 grid of stat cards at the top of the modal:

| Metric | Source field in `StrategyMetrics` | Format |
|---|---|---|
| Net Profit | `netProfit` | Currency ($X,XXX.XX) |
| Win Rate | `winRate` | Percentage (XX.X%) |
| Profit Factor | `profitFactor` | Decimal (X.XX) |
| Sharpe Ratio | `sharpeRatio` | Decimal (X.XX) |
| Max Drawdown | `maxDrawdown` | Percentage (−XX.X%) |
| Trade Count | `tradeCount` | Integer |
| Avg Holding Hours | `avgHoldingHours` | Hours/days string (e.g. "3d 12h") |
| Expectancy | `expectancy` | Currency ($X.XX per trade) |

Colour coding: green for positive values (profit, high win rate), red for negative (losses, drawdown), amber for neutral.

#### Equity Curve Chart

- Use recharts `LineChart` (already in the project).
- X-axis: timestamps from `equityCurve[].ts`.
- Y-axis: equity values from `equityCurve[].equity`.
- Green line, 2px stroke, no dots.
- A dashed horizontal reference line at the initial capital value.
- Tooltip showing date and equity on hover.
- Responsive container, 300px height.

#### Candlestick Chart with Trade Markers

- Render a candlestick/OHLC chart for the symbol over the backtest period.
- Green candles (close > open), red candles (close < open).
- Overlay trade entry markers: **green upward triangles** for buy entries, **red downward triangles** for sell entries.
- Overlay trade exit markers: **green dots** for profitable exits, **red dots** for losing exits.
- Data source: candles from the `candles` table for the backtest's symbol and date range.
- Recharts `ComposedChart` with custom `Bar` shapes for candlestick rendering, or consider a lightweight library like `lightweight-charts` if recharts proves limiting.
- Include a zoom/pan scroll bar for navigating the date range.

#### Trade List Table

Every trade from `BacktestTrade[]` displayed in a sortable table:

| Column | Source | Notes |
|---|---|---|
| Entry Time | `entryTs` | Date + time |
| Exit Time | `exitTs` | Date + time |
| Direction | `direction` | Badge: green "BUY" / red "SELL" |
| Entry Price | `entryPrice` | 4 decimal places |
| Exit Price | `exitPrice` | 4 decimal places |
| P&L | `pnl` | Green/red coloured currency |
| Exit Reason | `exitReason` | Badge: TP, SL, TIME_EXIT, etc. |
| Hold Duration | `holdingHours` | Formatted as "Xd Yh" |
| Position Size | `positionSize` | Currency |
| Confidence | `confidence` | Percentage |

Default sort: by entry time descending. Allow sorting by any column.

#### AI Chat Button

- A floating "Ask AI" button within the modal (bottom-right corner).
- Clicking it opens the existing `AIChatPanel` component, passing the `backtestId`.
- Allows the user to ask questions about the specific backtest without leaving the modal.

#### API Requirements

- Existing endpoint: `GET /api/backtest/results` returns `metricsJson` which contains `StrategyMetrics` including `equityCurve`.
- New endpoint needed: `GET /api/backtest/:id/trades` — returns all `BacktestTrade[]` for a given backtest run ID.
- New endpoint needed: `GET /api/backtest/:id/candles` — returns OHLC candle data for the symbol and date range of the backtest.

---

### 2b. Trades — Enriched Open & Closed Trade Details

**Goal:** Add more context columns to the Open Positions and Trade History tables so users can understand why each trade was taken and how it performed.

#### Open Positions — Additional Columns

| New Column | Source | Notes |
|---|---|---|
| Signal Family | `strategyName` mapped to family label | Badge with family colour |
| Composite Score | From signal log at entry time | Numeric badge (colour-coded) |
| Amount | `size` field | Already shown, rename header for clarity |
| Duration | Computed: `now - entryTs` | Live updating "Xd Yh Zm" |
| Entry Reason | `notes` field (contains strategy reason) | Truncated with tooltip on hover |

#### Trade History — Additional Columns

| New Column | Source | Notes |
|---|---|---|
| Signal Family | `strategyName` mapped to family label | Badge with family colour |
| Composite Score | From signal log at entry time | Numeric badge |
| Hold Duration | Computed: `exitTs - entryTs` | Formatted as "Xd Yh" |
| Exit Reason | `exitReason` field | Badge: TP (green), SL (red), trailing (amber), time (grey), manual (blue) |
| Amount | `size` field | Currency format |

#### Backend Fields to Expose

The `trades` table already has `strategyName`, `exitReason`, `size`, `entryTs`, `exitTs`, and `notes`. The following may need to be added or exposed:

- `compositeScore` — store the signal's composite score at entry time on the trade record. Currently not persisted on the trade row; would need to be captured during `openPosition()`.
- `strategyFamily` — can be derived from `strategyName` but storing it explicitly would be cleaner.
- `entryReason` — the `notes` field currently contains this, but a dedicated column would allow filtering.

#### Export

Existing CSV/JSON export functionality remains unchanged. The new columns should be included in exports automatically.

---

### 2c. Signals — "See Details" Popup

**Goal:** When a user clicks a signal row in the Decision Review page, a detail popup/drawer opens showing the full signal data.

#### Full Signal Header

- Symbol, direction (BUY/SELL badge), strategy family (coloured badge), timestamp.
- Composite score (large, coloured badge).
- Execution status: Approved (green) or Blocked (red) with rejection reason.

#### 6 Scoring Dimensions with Visual Bars

Display all 6 dimensions from `ScoringDimensions` with horizontal progress bars and numeric values:

| Dimension | Description | Bar Colour Logic |
|---|---|---|
| Regime Fit | How well the current regime matches the strategy | ≥80 green, ≥60 amber, <60 red |
| Setup Quality | Model score margin + EV strength + regime compatibility | Same |
| Trend Alignment | EMA slope alignment with trade direction | Same |
| Volatility Condition | ATR/BB width relative to ideal range for the family | Same |
| Reward/Risk | TP/SL ratio scoring | Same |
| Probability of Success | Model score as percentage | Same |

Each bar should be ~200px wide, filled proportionally (0-100 scale). Numeric value displayed to the right.

#### Feature Vector Snapshot

Show the raw technical indicators at the time the signal was generated:

| Feature | Field | Format |
|---|---|---|
| RSI (14) | `rsi14` | XX.X |
| EMA Slope | `emaSlope` | ±X.XXXXX |
| ATR (14) | `atr14` | X.XXXX (as % of price) |
| BB Width | `bbWidth` | X.XXXX |
| Z-Score | `zScore` | ±X.XX |

**Backend requirement:** The feature vector is not currently persisted with the signal log. To support this, either:
- Store a `featureSnapshot` JSON column on `signal_log` during `logSignalDecisions()`.
- Or re-compute features on demand (slower, less accurate for historical signals).

Recommendation: store a compressed feature snapshot at log time.

#### Regime Classification

- Regime state label (e.g. "trend_up", "compression", "spike_zone").
- Confidence level as a percentage with a visual indicator (circular gauge or bar).
- Already available: `regime` and `regimeConfidence` fields on the signal log.

#### AI Verdict

- Full verdict: Agree / Disagree / Uncertain (coloured badge).
- Full reasoning text (multi-line, scrollable).
- Confidence adjustment value.
- Already available: `aiVerdict`, `aiReasoning`, `aiConfidenceAdj` fields.

#### Entry/Exit Parameters

| Parameter | Source | Notes |
|---|---|---|
| Suggested SL | `suggestedSl` | As percentage distance from entry |
| Suggested TP | `suggestedTp` | As percentage distance from entry |
| Position Size | `allocationPct * capital` | Currency amount |
| Expected Hold Time | From `FAMILY_HOLD_PROFILE[family].initialExitHours` | "Xd" format |

#### API Requirements

- Existing endpoint `GET /api/signals` returns signal data with scoring dimensions, AI verdict, regime info.
- May need a new detail endpoint `GET /api/signals/:id` returning the full signal record including feature snapshot (once stored).

---

### 2d. Data — Price Charts with Timeframe Selector

**Goal:** Add interactive price charts to the Data page so users can visually inspect price action across different timeframes.

#### Chart Types

Toggle between two chart modes:
1. **Line Chart** — Simple close-price line. Recharts `LineChart`, green stroke.
2. **Candlestick Chart** — OHLC bars. Green for bullish (close > open), red for bearish (close < open).

Default: Line chart. Toggle button in the chart header.

#### Timeframe Selector

Horizontal button group with the following options:

| Label | Duration | Candle Resolution | Approx Candle Count |
|---|---|---|---|
| 1H | Last 1 hour | 1m candles | 60 |
| 6H | Last 6 hours | 1m candles | 360 |
| 12H | Last 12 hours | 1m candles | 720 |
| 24H | Last 24 hours | 5m candles | 288 |
| 1M | Last 1 month | 5m candles | ~8,640 |
| 3M | Last 3 months | 1h candles | ~2,160 |
| 12M | Last 12 months | 1h candles | ~8,760 |

For short timeframes (1H–12H), use raw 1m candles from the `candles` table.
For 24H and 1M, use 5m candles.
For 3M and 12M, use 1h candles (already stored with `timeframe = '1h'`).

#### OHLC Candlestick Colouring

- Bullish candle (close > open): green body, green border.
- Bearish candle (close < open): red body, red border.
- Doji (close ≈ open): grey body.
- Wicks extend to high/low.

#### 5m Candles Tab

Add a "5m Candles" tab alongside the existing "M1 Candles" tab in the Data page's data table section. This tab shows the 5-minute aggregated candle data in the same tabular format as the M1 tab.

#### Backend Endpoint Requirements

- New endpoint: `GET /api/data/chart` with query parameters:
  - `symbol` (required): instrument symbol
  - `timeframe` (required): `1m`, `5m`, or `1h`
  - `from` (optional): start timestamp (epoch seconds)
  - `to` (optional): end timestamp (epoch seconds)
  - `limit` (optional): max candles to return (default 1000)
- Returns: `{ candles: { openTs, closeTs, open, high, low, close, tickCount }[] }`
- For 5m candles: if not pre-aggregated, aggregate on-the-fly from 1m candles (group by `Math.floor(openTs / 300) * 300`).

---

## Section 3: Strategy Threshold Inventory

A complete catalog of every hardcoded threshold ("magic number") across all 4 strategy families and supporting systems.

### 3.1 Strategy Entry Thresholds

#### Trend Continuation (`strategies.ts` → `trendContinuation()`)

| Threshold | Current Value | Variable/Expression | Purpose | Impact of Change |
|---|---|---|---|---|
| EMA slope (uptrend) | > 0.0003 | `features.emaSlope > 0.0003` | Minimum slope to consider price in an uptrend | Lower → more signals in weak trends; higher → fewer but stronger trend signals |
| EMA slope (downtrend) | < −0.0003 | `features.emaSlope < -0.0003` | Minimum slope for downtrend | Same as above, for sell direction |
| EMA distance (pullback) | < 0.008 | `Math.abs(features.emaDist) < 0.008` | Price must be close to EMA (pullback) | Higher → allows entries farther from EMA; lower → tighter pullback requirement |
| RSI lower bound | > 38 | `features.rsi14 > 38` | RSI must not be oversold | Lower → allows entries in weaker momentum; higher → stricter momentum filter |
| RSI upper bound | < 65 | `features.rsi14 < 65` | RSI must not be overbought | Lower → more restrictive; higher → allows entries in stronger momentum |
| Z-score extreme | < 2.0 | `Math.abs(features.zScore) < 2.0` | Price must not be statistically extreme | Lower → filters out more volatile moments; higher → allows more deviation |

#### Mean Reversion (`strategies.ts` → `meanReversion()`)

| Threshold | Current Value | Variable/Expression | Purpose | Impact of Change |
|---|---|---|---|---|
| RSI oversold | < 32 | `features.rsi14 < 32` | RSI level for oversold condition | Lower → fewer but more extreme signals; higher → more frequent signals |
| RSI overbought | > 68 | `features.rsi14 > 68` | RSI level for overbought condition | Higher → fewer signals; lower → more signals |
| Z-score oversold | < −1.8 | `features.zScore < -1.8` | Statistical deviation for oversold | Lower (more negative) → stricter; higher → more signals |
| Z-score overbought | > 1.8 | `features.zScore > 1.8` | Statistical deviation for overbought | Higher → stricter; lower → more signals |
| Consecutive candles | ≥ 3 | `Math.abs(features.consecutive) >= 3` | Minimum adverse candle run | Higher → requires more exhaustion; lower → triggers earlier |
| Candle body (sweep) | < 0.35 | `features.candleBody < 0.35` | Small body indicates rejection wick | Higher → allows bigger bodies; lower → stricter rejection wick filter |
| Swing breach candles | 0–3 | `swingBreachCandles >= 0 && <= 3` | Breach must be recent (last 0-3 candles) | Wider range → allows older breaches |

#### Breakout Expansion (`strategies.ts` → `breakoutExpansion()`)

| Threshold | Current Value | Variable/Expression | Purpose | Impact of Change |
|---|---|---|---|---|
| BB width (squeeze) | < 0.006 | `features.bbWidth < 0.006` | Bollinger Band squeeze detection | Higher → more instruments qualify as squeezed; lower → stricter squeeze |
| ATR rank (expanding) | > 0.8 | `features.atrRank > 0.8` | Volatility expansion confirmation | Lower → allows lower volatility expansion; higher → stricter |
| BB %B upper band | > 0.85 | `features.bbPctB > 0.85` | Price at upper Bollinger Band | Lower → triggers on weaker breakouts; higher → requires stronger push |
| BB %B lower band | < 0.15 | `features.bbPctB < 0.15` | Price at lower Bollinger Band | Higher → triggers on weaker breakdowns; lower → requires stronger push |
| BB width (compressed) | < 0.008 | `features.bbWidth < 0.008` | Compression for expansion sub-strategy | Higher → more lenient; lower → stricter |
| BB width RoC | > 0.10 | `features.bbWidthRoc > 0.10` | Rate of BB expansion | Lower → triggers on slower expansion; higher → requires faster expansion |
| ATR acceleration | > 0.08 | `features.atrAccel > 0.08` | Volatility momentum | Lower → triggers earlier; higher → requires stronger acceleration |
| Candle body (expansion) | > 0.6 | `features.candleBody > 0.6` | Strong directional candle body | Lower → allows weaker candles; higher → requires more conviction |

#### Spike Event (`strategies.ts` → `spikeEvent()`)

| Threshold | Current Value | Variable/Expression | Purpose | Impact of Change |
|---|---|---|---|---|
| Spike hazard score | > 0.70 | `features.spikeHazardScore > 0.70` | Probability threshold for spike imminence | Lower → more frequent spike signals; higher → fewer but higher probability |
| Boosted score blend | 0.4 × score + 0.5 × hazard | `score * 0.4 + spikeHazardScore * 0.5` | Weight balance between model and hazard | Adjusting weights shifts reliance between ML model and statistical hazard |
| Minimum expected value | 0.008 (floor) | `Math.max(expectedValue, 0.008)` | Minimum EV override for spike signals | Lower → allows lower quality setups; higher → stricter quality gate |

### 3.2 Per-Family Config (`strategies.ts` → `FAMILY_CONFIG`)

| Family | minModelScore | minEV | minRR | slMultiple | tpMultiple |
|---|---|---|---|---|---|
| trend_continuation | 0.58 | 0.005 | 1.5 | 2.5 | 6.0 |
| mean_reversion | 0.60 | 0.006 | 1.8 | 3.0 | 4.0 |
| breakout_expansion | 0.55 | 0.005 | 1.5 | 2.0 | 8.0 |
| spike_event | 0.62 | 0.008 | 2.0 | 1.5 | 4.0 |

- **minModelScore**: Minimum ML model score to proceed with signal generation. Lower → more signals but potentially lower quality.
- **minEV**: Minimum expected value. Filters out low-edge setups.
- **minRR**: Minimum reward-to-risk ratio (unused directly in entry filter, used in signal router).
- **slMultiple**: ATR multiplier for stop-loss distance. Higher → wider stops, fewer SL hits, but larger losses when hit.
- **tpMultiple**: ATR multiplier for take-profit distance. Higher → larger targets, fewer TP hits, but larger wins when hit.

### 3.3 Regime Engine Thresholds (`regimeEngine.ts`)

| Threshold | Current Value | Purpose | Impact of Change |
|---|---|---|---|
| Strong trend (EMA slope) | > 0.0005 | Minimum slope for trend classification | Lower → more trend regimes; higher → fewer, stronger trends only |
| Very strong trend | > 0.001 | Override threshold for strong trend | Same direction, higher bar |
| BB width squeeze | < 0.005 | Compression regime detection | Higher → more squeezes detected |
| BB width RoC (expanding) | > 0.15 | Breakout expansion regime detection | Lower → more expansion regimes |
| ATR acceleration (expanding) | > 0.10 | Confirms volatility expansion | Lower → earlier expansion detection |
| High volatility ATR | > 0.004 | High vol environment marker | Lower → more instruments flagged |
| Z-score overstretched | > 2.0 | Mean reversion regime trigger | Lower → more MR regime classifications |
| RSI extreme (oversold) | < 28 | RSI threshold for MR regime | Higher → more MR regimes |
| RSI extreme (overbought) | > 72 | RSI threshold for MR regime | Lower → more MR regimes |
| Spike hazard imminent | > 0.72 | Spike zone regime trigger | Lower → more spike zone classifications |
| Compression flat slope | < 0.0003 | Required for compression regime (no trend) | Higher → allows slight trending to be compression |

### 3.4 Scoring Weights (`scoring.ts` → `DEFAULT_SCORING_WEIGHTS`)

| Dimension | Default Weight | Purpose |
|---|---|---|
| regimeFit | 0.22 | How well strategy matches current market regime |
| setupQuality | 0.20 | Model score, EV, regime compatibility, confidence |
| trendAlignment | 0.15 | EMA slope and price position alignment with direction |
| volatilityCondition | 0.13 | ATR/BB width within ideal range for family |
| rewardRisk | 0.15 | TP/SL ratio scoring |
| probabilityOfSuccess | 0.15 | Raw model score as probability |

### 3.5 Scoring Sub-Thresholds (`scoring.ts`)

| Location | Threshold | Current Value | Purpose |
|---|---|---|---|
| `computeRegimeFit` | Non-ideal regime score | 15 | Score when regime doesn't match ideal |
| `computeRegimeFit` | Ideal regime base score | 75 | Base score when regime is ideal |
| `computeSetupQuality` | EV normalizer | 0.015 | EV divided by this for strength calc |
| `computeSetupQuality` | Regime compatible bonus | 15 | Points added for regime compatibility |
| `computeTrendAlignment` | Slope strength normalizer | 0.001 | Slope divided by this for strength |
| `computeTrendAlignment` | Price above EMA bonus | 10 | Points for aligned price position |
| `computeTrendAlignment` | Consecutive strength cap | 5 | Max consecutive candles for full score |
| `computeVolatilityCondition` | BB normal range | 0.003–0.015 | Normal BB width bonus range |
| `computeVolatilityCondition` | ATR rank normal range | 0.5–1.5 | Normal ATR rank bonus range |
| `computeRewardRisk` | RR ≥ 3.0 | 100 | Maximum reward/risk score |
| `computeRewardRisk` | RR ≥ 2.0 | 80 | Good reward/risk score |
| `computeRewardRisk` | RR ≥ 1.5 | 60 | Acceptable reward/risk score |
| `computeRewardRisk` | RR < 1.0 | 15 | Minimum reward/risk score |

### 3.6 Family Ideal Volatility Ranges (`scoring.ts`)

| Family | Min ATR | Max ATR |
|---|---|---|
| trend_continuation | 0.001 | 0.004 |
| mean_reversion | 0.002 | 0.006 |
| breakout_expansion | 0.003 | 0.010 |
| spike_event | 0.001 | 0.010 |

### 3.7 Trade Engine Thresholds (`tradeEngine.ts`)

| Threshold | Current Value | Purpose |
|---|---|---|
| MAX_OPEN_TRADES | 3 | Maximum simultaneous open positions |
| MAX_EQUITY_DEPLOYED_PCT | 0.80 | Max 80% of equity deployed at once |
| POSITION_SIZE_MIN_PCT | 0.05 | Minimum 5% of equity per position |
| POSITION_SIZE_MAX_PCT | 0.25 | Maximum 25% of equity per position |
| DEFAULT_TRAILING_STOP_PCT | 0.25 | 25% trailing stop from peak price |
| INITIAL_EXIT_HOURS | 168 | 7 days initial time limit |
| EXTENSION_HOURS | 48 | 2 days extension for near-break-even trades |
| MAX_EXIT_HOURS | 336 | 14 days absolute hard limit |
| Min TP (dynamic) | 2.5 × ATR | Minimum take-profit distance |
| Max TP (dynamic) | 15.0 × ATR | Maximum take-profit distance |
| TP capture ratio (paper) | 0.80 | Predicted move captured as TP |
| TP capture ratio (demo) | 0.70 | More conservative for demo |
| TP capture ratio (real) | 0.60 | Most conservative for real |
| Min SL ATR multiplier (paper) | 3.0 | Minimum SL distance |
| Min SL ATR multiplier (demo) | 3.5 | Wider for demo |
| Min SL ATR multiplier (real) | 4.0 | Widest for real |
| Small loss threshold (time exit) | −0.02 | Losses above −2% can get extensions |

### 3.8 Family Hold Profiles (`tradeEngine.ts` → `FAMILY_HOLD_PROFILE`)

| Family | tpAtrMultiplier | slAtrMultiplier | initialExitHours | extensionHours | maxExitHours | harvestSensitivity |
|---|---|---|---|---|---|---|
| trend_continuation | 6.0 | 2.5 | 168 | 48 | 336 | 0.8 |
| mean_reversion | 4.0 | 3.0 | 120 | 36 | 240 | 1.0 |
| breakout_expansion | 8.0 | 2.0 | 168 | 48 | 336 | 0.7 |
| spike_event | 4.0 | 1.5 | 72 | 24 | 168 | 1.2 |

### 3.9 Backtest Engine Defaults (`backtestEngine.ts`)

| Threshold | Current Value | Purpose |
|---|---|---|
| DEFAULT_TRAILING_STOP_PCT | 0.25 | Trailing stop in backtest |
| INITIAL_EXIT_HOURS | 72 | Shorter than live (backtest is 1h candles) |
| EXTENSION_HOURS | 24 | Extension period in backtest |
| MAX_EXIT_HOURS | 168 | Hard max in backtest |
| MAX_EQUITY_DEPLOYED_PCT | 0.80 | Same as live |
| DEFAULT_MAX_CONCURRENT_LIVE | 3 | Max positions in live backtest |
| DEFAULT_MAX_CONCURRENT_PAPER | 3 | Max positions in paper backtest |
| DEFAULT_LIVE_BASE_PCT | 0.08 | 8% base position size (live) |
| DEFAULT_PAPER_BASE_PCT | 0.16 | 16% base position size (paper) |
| LOOKBACK window | 50 | Candles for feature computation |
| Default minCompositeScore | 85 | Backtest entry filter |
| Default minEvThreshold | 0.003 | Backtest EV filter |
| Default minRrRatio | 1.5 | Backtest RR filter |
| Backtest SL multiplier | 1.5 × ATR | Fixed SL in backtest simulation |
| Backtest TP multiplier | 3.0 × ATR | Fixed TP in backtest simulation |

### 3.10 Signal Router Thresholds (`signalRouter.ts`)

| Threshold | Current Value | Purpose |
|---|---|---|
| Score ≥ 90 allocation bonus | +6% over base | Large position tier |
| Score ≥ 85 allocation bonus | +3% over base | Medium position tier |
| Score ≥ 80 allocation | base % | Base position tier |
| Score < 80 | 0% (rejected) | Below allocation threshold |
| Min composite for AI verification | 75 | Threshold to invoke AI verification |
| Max open risk | 80% | Same as equity deployed cap |
| Min remaining capital | 5% of total | Below this, no new positions |
| Ranking weights: score | 0.50 | Composite score weight in ranking |
| Ranking weights: EV | 0.30 | Expected value weight in ranking |
| Ranking weights: regime | 0.20 | Regime confidence weight in ranking |
| Conservative allocation mode | 0.7× | Reduces position size |
| Aggressive allocation mode | 1.3× | Increases position size |

### 3.11 Extraction Engine Thresholds (`extractionEngine.ts`)

| Threshold | Current Value | Purpose |
|---|---|---|
| DEFAULT_EXTRACTION_TARGET_PCT | 50 | Target profit % before extraction |
| DEFAULT_PEAK_DRAWDOWN_EXIT_PCT | 40 | Exit if drawdown from peak exceeds this |
| DEFAULT_PARTIAL_CLOSE_PCT | 50 | Close 50% of position at partial target |
| Default probe threshold | 88 (real) | Min score for probe entry |
| Default confirmation threshold | 91 (real) | Min score for confirmation entry |
| Default momentum threshold | 94 (real) | Min score for momentum entry |
| Default probe size multiplier | 0.70 (real) | Position size reduction for probe |
| Default confirmation multiplier | 0.60 (real) | Position size reduction for confirmation |
| Default momentum multiplier | 0.50 (real) | Position size reduction for momentum |

### 3.12 Scheduler Defaults (`scheduler.ts`)

| Threshold | Current Value | Purpose |
|---|---|---|
| DEFAULT_SCAN_INTERVAL_MS | 30,000 | 30-second scan cycle |
| DEFAULT_STAGGER_SECONDS | 10 | 10 seconds between symbol scans |
| POSITION_MGMT_INTERVAL_MS | 10,000 | 10-second position check cycle |
| MONTHLY_CHECK_INTERVAL_MS | 3,600,000 | 1-hour check for monthly tasks |
| Weekly analysis min trades | 5 | Minimum closed trades for weekly analysis |
| Weekly conservatism (real) | 0.85 | Most conservative adjustments |
| Weekly conservatism (demo) | 0.95 | Moderate adjustments |
| Weekly conservatism (paper) | 1.05 | Slightly aggressive adjustments |

---

## Section 4: Dynamic Threshold Calibration

### Overview

The current system uses static thresholds (Section 3). Market conditions evolve, and thresholds that were optimal 6 months ago may underperform today. A dynamic calibration system would monitor threshold effectiveness over time and suggest adjustments.

### Detection Mechanism

For each threshold in the inventory:

1. **Partition historical trades** by the threshold value that was active when each signal was generated.
2. **Compute rolling win rate** using a sliding window (e.g., last 100 trades or last 30 days, whichever is smaller).
3. **Compare historical vs recent performance:**
   - Historical baseline: win rate over the full backtest period.
   - Recent performance: win rate over the last 30 days.
   - If recent win rate drops more than 15 percentage points below baseline, flag the threshold for review.

### Suggestion Mechanism

When a threshold is flagged:

- Run a parameter sweep over a bounded range (e.g., RSI oversold: test values 25, 28, 30, 32, 35).
- For each candidate value, compute a mini-backtest over the last 30 days of data.
- Select the value that maximizes the Sharpe ratio (or profitability, configurable).
- Generate a human-readable suggestion, e.g.:

> "RSI < 32 produced 65% win rate 6 months ago but only 40% now. Testing alternatives: RSI < 28 yields 55% win rate over last 30 days. Recommend adjusting to RSI < 28."

### Safety Guardrails

| Guardrail | Description |
|---|---|
| Min/max bounds | Each threshold has a hard floor and ceiling (e.g., RSI: 20–45 for oversold). No suggestion can exceed these bounds. |
| Maximum adjustment step | No single adjustment can change a threshold by more than 20% from its current value. |
| User approval required | All suggestions are presented as recommendations. No automatic changes without explicit user confirmation. |
| Rollback capability | The previous threshold value is stored. A one-click rollback button reverts the change. |
| Cooldown period | After a threshold is adjusted, it cannot be re-adjusted for at least 7 days to allow the new value to accumulate data. |
| Minimum sample size | Suggestions require at least 30 trades with the current threshold value before a change is proposed. |

### Data Storage

- New table: `threshold_history` — records every threshold value change with timestamp, old value, new value, reason, and approval status.
- New table: `threshold_performance` — stores rolling win rate snapshots per threshold per time period.

### UI Integration

- A "Threshold Health" section on the Settings or Research page.
- Table showing each threshold, its current value, historical win rate, recent win rate, and a status indicator (green/amber/red).
- "Review Suggestion" button opens a detail panel with the mini-backtest results and a confirmation dialog.

---

## Section 5: Strategy Degradation Detection

### Overview

Strategies can degrade over time as market microstructure changes. This system monitors the health of each strategy family on a per-symbol basis and alerts when effectiveness drops.

### Win Rate Trend Monitoring

For each (strategy_family, symbol) pair:

1. **Compute rolling 30-day win rate** from closed trades.
2. **Compute rolling 30-day profit factor** from closed trades.
3. **Store snapshots** at the end of each day (or week) in a `strategy_health` table.
4. **Track trend direction**: compare the current 30-day win rate to the 90-day average. If the current window is more than 10 percentage points below the 90-day average, flag as degrading.

### Automatic Alerts

| Alert Level | Condition | Action |
|---|---|---|
| Green (Healthy) | Win rate within 10% of 90-day average AND profit factor > 1.0 | No action |
| Amber (Caution) | Win rate 10–20% below 90-day average OR profit factor between 0.7 and 1.0 | Warning banner on Research page |
| Red (Degraded) | Win rate > 20% below 90-day average OR profit factor < 0.7 for > 14 days | Alert notification + suggestion to disable strategy for that symbol |

Alerts should be delivered via:
- In-app notification banner (persistent until dismissed).
- Entry in a "System Health" section on the dashboard.
- Optional: webhook/email notification (configurable).

### Dashboard Health Indicators

On the Research page and/or Dashboard:

- Per-strategy health card showing:
  - Strategy family name and icon.
  - Current 30-day win rate (number + trend arrow ↑ ↓ →).
  - Sparkline of win rate over last 6 months.
  - Status badge: Green / Amber / Red.
  - Number of symbols where this strategy is healthy vs degraded.

- Per-symbol breakdown (expandable):
  - Win rate by strategy on each symbol.
  - Heat map: rows = symbols, columns = strategy families, cells = win rate (coloured green/amber/red).

### Monthly Comparison Reports

At the end of each month, automatically generate a summary:

- Total trades per strategy per symbol.
- Win rate vs previous month (delta with arrow).
- Profit factor vs previous month.
- Best/worst performing (strategy, symbol) combinations.
- Recommendations: "Consider disabling spike_event on BOOM300 (win rate dropped from 62% to 35% over 2 months)."

Store as a `monthly_report` record in the database, viewable from the Research page.

### Data Requirements

- New table: `strategy_health_snapshots` with columns: `date`, `strategy_family`, `symbol`, `win_rate_30d`, `profit_factor_30d`, `trade_count_30d`, `avg_pnl_30d`.
- New table: `monthly_reports` with columns: `month`, `report_json`, `created_at`.
- Scheduled job: run daily after midnight UTC to compute and store snapshots.

---

## Section 6: Emerging Pattern Detection

### Overview

The current system uses 4 fixed strategy families. AI analysis of historical trade data could reveal new tradable patterns not covered by these families — for example, time-of-day effects, cross-instrument correlations, or candle pattern sequences.

### How AI Analyzes Trades for New Patterns

1. **Data preparation**: Export all backtest and live trades with their feature vectors at entry time, plus the outcome (win/loss, P&L, hold duration).

2. **Feature importance analysis**: Use the AI model to identify which features are most predictive of winning trades that were NOT generated by existing strategies. Focus on:
   - Time features (hourOfDay, dayOfWeek) — are there profitable time windows?
   - Cross-correlation — do trades on correlated instruments have predictive value?
   - Candle structure patterns — specific sequences of candleBody, upperWickRatio, lowerWickRatio.
   - Multi-timeframe divergence — 1m regime vs 5m regime vs 1h regime disagreements.

3. **Clustering**: Group winning trades by feature similarity (unsupervised clustering). Identify clusters that don't map to any existing strategy family. These are "emerging pattern candidates."

4. **Pattern validation**: For each candidate cluster:
   - Run a targeted backtest using only the cluster's entry criteria.
   - Require minimum 30 trades, > 50% win rate, profit factor > 1.2.
   - Cross-validate with walk-forward testing.

### Patterns Not Covered by Current Families

Potential patterns the system cannot currently detect:

| Pattern Type | Description | Why Not Currently Covered |
|---|---|---|
| Session open effects | Increased volatility at synthetic index generation boundaries | No session/time-based entry logic |
| Cross-pair divergence | BOOM and CRASH of same index diverging unusually | Cross-correlation feature exists but isn't used for entries |
| Volatility index regime shift | R_75/R_100 transitioning between low and high vol regimes | Covered partially by regime engine but no dedicated strategy |
| Wick rejection patterns | Specific candle sequences (hammer, engulfing) | candleBody feature exists but no pattern sequence detection |
| Clustering exhaustion | Multiple strategies firing on the same symbol simultaneously | Correlation check exists but no "signal clustering" entry |

### Suggesting New Strategy Rules

The AI system would output suggestions in a structured format:

```
{
  "patternName": "session_boundary_breakout",
  "description": "Breakout signals that occur within 30 minutes of hourOfDay=0 have 15% higher win rate",
  "entryConditions": {
    "hourOfDay": [23, 0, 1],
    "bbWidth": "< 0.007",
    "emaSlope": "> 0.0002"
  },
  "backtestResults": {
    "winRate": 0.63,
    "profitFactor": 1.8,
    "tradeCount": 47,
    "sharpeRatio": 1.2
  },
  "confidence": "medium",
  "recommendation": "Add as time filter to breakout_expansion strategy"
}
```

### Human Review and Approval Workflow

1. AI generates pattern suggestion → stored in `pattern_suggestions` table with status "pending".
2. Notification appears in the Research page: "1 new pattern suggestion."
3. User clicks to review: sees the pattern description, entry conditions, backtest results, and confidence level.
4. User can:
   - **Approve** → Pattern rules are added to a "custom patterns" configuration (not hardcoded).
   - **Reject** → Pattern is archived with reason.
   - **Request more data** → System runs additional backtests with different parameters.
5. Approved patterns enter a "paper only" trial period (configurable, default 30 days).
6. After the trial, the system reports actual performance vs predicted performance.
7. User can then promote to demo/real or retire the pattern.

---

## Section 7: Competitive Adaptation

### Overview

If other algorithmic traders identify the same signals (same indicators, same thresholds), "signal crowding" occurs — multiple bots enter at the same time and price, reducing the edge. The system needs mechanisms to maintain an advantage.

### Varying Entry Timing

- **Staggered entry**: Instead of entering immediately when a signal fires, add a randomized delay of 1–5 candles (configurable).
- **Confirmation candle**: Wait for the next candle to close in the expected direction before entering. This reduces crowded entries at the exact signal candle.
- **Entry price improvement**: Use limit orders slightly better than the current price (e.g., 0.1% below for buys) instead of market orders.
- **Time-weighted entry**: Spread the position across 2–3 entries over a short window (already partially implemented via the probe/confirmation/momentum staging system).

### Position Sizing Variation

- **Randomized sizing**: Add ±5–15% random variation to position sizes. This makes the system's footprint less predictable.
- **Inverse crowding sizing**: If signal crowding indicators suggest high crowding, reduce position size by 30–50%. If no crowding detected, use full size.

### Exit Strategy Variation

- **Randomized TP levels**: Instead of fixed ATR multiples, vary the TP target by ±10% per trade.
- **Time-based partial exits**: Close 30% of position at 50% of TP, 30% at 75% of TP, and let the remaining 40% run to full TP or trailing stop. Different bots likely use different exit structures.
- **Adaptive trailing stop**: Vary the trailing stop percentage based on the current volatility regime rather than using a fixed percentage.

### Randomized Delays to Avoid Crowded Entries

Implementation concept:
- When a signal is generated, compute a "crowding risk score" based on:
  - How "textbook" the setup is (high score = common pattern that other bots likely detect).
  - Time of day (certain hours may have more bot activity).
  - Recent signal density on this symbol (many signals in a short window = potential crowding).
- If crowding risk is HIGH (> 0.7): add 2–5 minute delay + randomize ±30 seconds.
- If crowding risk is MEDIUM (0.4–0.7): add 30–120 second delay.
- If crowding risk is LOW (< 0.4): enter immediately.

### Monitoring for Signal Crowding Indicators

Metrics to track that may indicate crowding:

| Indicator | How to Detect | What It Means |
|---|---|---|
| Slippage increase | Compare expected entry price vs actual (for demo/real modes) | Other bots moving price before our entry |
| Win rate compression | Gradual win rate decline on a previously profitable strategy | Edge is being arbitraged away |
| Entry price clusters | Multiple entries at very similar prices within a short window | Multiple bots entering the same signal |
| Decreased hold time to TP | TP hit faster than historical average | Market structure changing due to competition |
| Increased SL hit rate | SL hit rate rising without volatility increase | Other bots creating false breakouts |

Dashboard display:
- "Crowding Risk" indicator per strategy family (low/medium/high).
- Trend chart of slippage and win rate over time.
- Alert when crowding metrics exceed configurable thresholds.

---

## Section 8: Implementation Phases

### Phase 1: UI Enrichment (Immediate Next)

**Scope:** Section 2 — all UI enrichment features.

| Task | Estimated Effort | Dependencies |
|---|---|---|
| 2a. Backtest detail popup with metrics grid | 2–3 days | None |
| 2a. Equity curve chart in popup | 1 day | Popup structure |
| 2a. Candlestick chart with trade markers | 3–4 days | Popup structure, candle data endpoint |
| 2a. Trade list table | 1–2 days | Trades endpoint |
| 2a. AI chat integration in popup | 0.5 day | Popup structure, existing AI chat |
| 2b. Enriched trades columns | 1–2 days | May need compositeScore on trade record |
| 2c. Signal detail popup | 2–3 days | Feature snapshot storage |
| 2d. Price charts with timeframe selector | 3–4 days | Chart data endpoint, 5m candle aggregation |
| 2d. 5m candles tab | 0.5 day | 5m aggregation logic |
| **Total Phase 1** | **~15–20 days** | |

**Key backend work:**
- Add `GET /api/backtest/:id/trades` endpoint.
- Add `GET /api/backtest/:id/candles` endpoint.
- Add `GET /api/data/chart` endpoint with timeframe parameter.
- Add `featureSnapshot` JSON column to `signal_log` table.
- Add `compositeScore` and `strategyFamily` columns to `trades` table.
- Implement 5m candle aggregation (on-the-fly or pre-aggregated).

### Phase 2: Threshold Inventory + Degradation Detection (Medium Term)

**Scope:** Sections 3 and 5.

| Task | Estimated Effort | Dependencies |
|---|---|---|
| Build threshold inventory UI (read-only dashboard) | 2–3 days | None |
| Create `strategy_health_snapshots` table + daily job | 2 days | None |
| Strategy health dashboard cards | 2–3 days | Health snapshot data |
| Per-symbol heat map | 1–2 days | Health snapshot data |
| Amber/red alert system | 1–2 days | Health snapshots |
| Monthly comparison report generation | 2–3 days | Health snapshots |
| Monthly report viewer UI | 1–2 days | Report data |
| **Total Phase 2** | **~12–18 days** | Phase 1 not required |

**Key backend work:**
- Create `strategy_health_snapshots` table schema.
- Create `monthly_reports` table schema.
- Implement daily cron job for health computation.
- Implement monthly report generation job.
- API endpoints for health data and reports.

### Phase 3: Dynamic Calibration + Emerging Patterns + Competitive Adaptation (Longer Term)

**Scope:** Sections 4, 6, and 7.

| Task | Estimated Effort | Dependencies |
|---|---|---|
| Threshold history tracking table | 1 day | Phase 2 |
| Rolling performance computation per threshold | 3–4 days | Phase 2 health data |
| Parameter sweep mini-backtest engine | 4–5 days | Backtest engine |
| Threshold suggestion UI with approval workflow | 3–4 days | Suggestion data |
| AI pattern analysis pipeline | 5–7 days | Sufficient trade history |
| Pattern suggestion storage + review UI | 3–4 days | Analysis pipeline |
| Paper trial system for approved patterns | 2–3 days | Pattern approval |
| Crowding risk scoring | 3–4 days | Slippage data (demo/real only) |
| Entry timing randomization | 1–2 days | None |
| Exit strategy variation | 2–3 days | None |
| Crowding dashboard | 2–3 days | Crowding metrics |
| **Total Phase 3** | **~30–40 days** | Phase 2 recommended first |

**Key backend work:**
- Create `threshold_history` and `threshold_performance` tables.
- Create `pattern_suggestions` table.
- Implement parameter sweep engine (extension of backtest engine).
- AI integration for pattern analysis (extend existing OpenAI integration).
- Crowding risk scoring algorithm.
- Entry delay and exit variation logic in trade engine.

### Phase Summary

| Phase | Sections | Timeline | Effort | Prerequisites |
|---|---|---|---|---|
| Phase 1 | 2 (UI Enrichment) | Immediate next | ~15–20 dev days | V1 stable |
| Phase 2 | 3, 5 (Thresholds + Degradation) | After Phase 1 | ~12–18 dev days | None (can parallel with Phase 1) |
| Phase 3 | 4, 6, 7 (Calibration + Patterns + Competition) | After Phase 2 | ~30–40 dev days | Phase 2 health data |
| **Total** | All | | **~57–78 dev days** | |

---

*This document is a planning specification. No code changes are included. Implementation begins after review and prioritization.*
