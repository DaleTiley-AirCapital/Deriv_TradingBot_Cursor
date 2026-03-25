# Deriv Capital Extraction App — V1 Specification

## 1. Vision and Purpose

The Deriv Capital Extraction App is a fully automated trading system designed for Deriv synthetic indices. It replaces manual "Forex Royals" bots with a systematic, machine-learning-driven approach that identifies high-probability trading opportunities, executes trades with precision, manages risk automatically, and extracts profits on a regular cycle.

The core philosophy is **Capital Extraction** — not compound growth. The system grows a trading account to a target, extracts the profits, resets to the original capital, and repeats. This prevents unchecked risk growth and ensures regular realised returns.

### Monthly Return Targets

| Mode | Monthly Target | Risk Profile |
|------|---------------|-------------|
| Paper | 120% | Aggressive — simulated trades, no real money at risk |
| Demo | 80% | Balanced — virtual funds on a real Deriv demo account |
| Real | 50% | Conservative — real money, tightest risk controls |

### Core Trading Principles

- **High capital per trade**: Deploy 15-30% equity per position. Large, meaningful trades.
- **Highest-value signals only**: Composite score threshold of 80+. Fewer trades, high conviction.
- **Hold for longer periods**: Time exit windows of 72-336 hours. Swing trade with patience.
- **Wide take profits**: TP distances of 4-12x ATR depending on strategy family.
- **Tight trailing stops**: Trail 20-25% behind peak price. Protect profits aggressively.
- **Few simultaneous positions**: Max 3-4 open trades. Concentrate capital.
- **Extract profits regularly**: Don't let compound risk grow unchecked.

---

## 2. Supported Instruments

V1 supports 12 Deriv synthetic indices across three families:

### Boom Indices (5)
BOOM1000, BOOM900, BOOM600, BOOM500, BOOM300

Price trends gradually downward and periodically spikes sharply upward. The number indicates roughly how many ticks pass between spikes — lower numbers mean more frequent spikes.

### Crash Indices (5)
CRASH1000, CRASH900, CRASH600, CRASH500, CRASH300

Price trends gradually upward and periodically drops sharply downward. Same numbering convention as Boom.

### Volatility Indices (2)
R_75 (Volatility 75 Index), R_100 (Volatility 100 Index)

Continuous random-walk instruments with defined volatility levels. No directional bias. The number represents the percentage volatility.

### Deriv API Symbol Mapping

The system maps configured symbol names to their Deriv API equivalents using a multi-strategy lookup:

| Configured Name | Primary Aliases |
|----------------|----------------|
| BOOM1000 | BOOM1000, 1HZ1000V, BOOM1000_ |
| CRASH1000 | CRASH1000, 1HZ1000V, CRASH1000_ |
| BOOM900 | BOOM900, BOOM900N, 1HZ900V |
| CRASH900 | CRASH900, CRASH900N, 1HZ900V |
| BOOM600 | BOOM600, BOOM600N, 1HZ600V |
| CRASH600 | CRASH600, CRASH600N, 1HZ600V |
| BOOM500 | BOOM500, 1HZ500V, BOOM500_ |
| CRASH500 | CRASH500, 1HZ500V, CRASH500_ |
| BOOM300 | BOOM300, BOOM300N, 1HZ300V |
| CRASH300 | CRASH300, CRASH300N, 1HZ300V |
| R_75 | R_75, 1HZ75V |
| R_100 | R_100, 1HZ100V |

Symbol validation runs against the Deriv `active_symbols` API. If the primary name isn't found, aliases are tried. If no alias matches, a fuzzy substring match is attempted. Invalid symbols are refused.

### Future Instrument Catalog
Planned for future versions: R_10, R_25, R_50, RDBULL, RDBEAR, JD10-JD100, stpRNG, STP2-5, RDBR100, RDBR200.

---

## 3. Architecture

### Technology Stack

| Component | Technology |
|-----------|-----------|
| Frontend | React, Vite, Tailwind CSS v4, shadcn/ui, Recharts |
| Backend | Express 5, TypeScript |
| Database | PostgreSQL with Drizzle ORM |
| Validation | Zod (v4), drizzle-zod |
| API Codegen | Orval (OpenAPI specification) |
| Build | esbuild for CJS bundle |
| AI | OpenAI GPT-4o |
| Market Data | Deriv WebSocket API |
| Package Manager | pnpm workspace monorepo |

### Two-Layer Architecture

**Layer 1 — Market Intelligence (Always On)**
The scanner runs whenever tick streaming is active, analysing all 12 instruments continuously. It produces signal decisions regardless of whether any trading mode is active. When no modes are active, decisions are logged with status "blocked" and reason "No execution mode active — intelligence only". This means the system is always learning and recording market conditions.

**Layer 2 — Execution (Only When Modes Active)**
Trades are only placed when Paper, Demo, or Real mode is explicitly enabled. Each mode operates independently with its own capital, settings, and risk limits.

### Database Tables

| Table | Purpose |
|-------|---------|
| ticks | Raw tick data from Deriv WebSocket |
| candles | 1-minute and 5-minute OHLCV candles built from ticks |
| spike_events | Detected Boom/Crash spike events |
| features | Computed technical feature vectors per symbol |
| model_runs | ML model training/evaluation records |
| backtest_runs | Backtest session metadata |
| backtest_trades | Individual backtest trade records |
| trades | Live/paper/demo trade records |
| signal_log | All signal decisions (allowed and rejected) |
| platform_state | Key-value store for all settings and system state |

### Startup Sequence (Production)

1. Database schema initialisation and column migrations
2. Data tables truncated for clean state (API keys preserved)
3. V1 default settings seeded into platform_state
4. Listen on PORT (required for health checks)
5. Start scheduler (signal scan every 30s, position management every 10s)
6. AI auto-configuration (enable AI verification if OpenAI key present)
7. Symbol validation against Deriv active_symbols API
8. 12-month candle backfill (paginated, 5000 candles per page, all 12 symbols, partial success if ≥8/12 succeed)
9. Tick streaming begins
10. If initial setup is complete: auto-start tick streaming for enabled symbols
11. Health endpoint available at /api/healthz

### Setup Wizard Flow

The setup wizard is a multi-step guided process that runs on first launch (before `initial_setup_complete` is set to `true` in platform_state). It must complete before any trading or streaming begins.

**Step 1 — Welcome**: Introduction to the platform and what the wizard will do.

**Step 2 — API Keys**: User enters Deriv API tokens (Demo and/or Real) and optionally an OpenAI API key. At least one Deriv token is required. Keys are encrypted and stored in platform_state.

**Step 3 — Connection Testing**: The system tests each provided API key against the live Deriv WebSocket API and OpenAI API. If no Deriv connection succeeds, the user is returned to step 2 to fix their tokens.

**Step 4 — Initialisation** (SSE stream with 6 phases):

**Architecture**: The initialise endpoint uses a **background job + polling** pattern instead of SSE. POST `/api/setup/initialise` starts the process in the background and returns immediately. The frontend polls GET `/api/setup/progress?since=N` every 1.5 seconds to receive new events incrementally. This avoids proxy timeout issues on Railway/Replit hosting.

1. **Probing Phase**: Instant — no API calls. All 12 probe_result events are emitted FIRST (before any database operations or Deriv WS connections) using a fixed 1-year expected record count (525,600 per symbol × 1m + 105,120 × 5m = 630,720 total). After probe results are sent, the endpoint DELETEs all data tables and connects to Deriv WS. This ensures the UI shows immediate progress regardless of backend connection speed.

2. **Backfill Phase**: Downloads 1-minute and 5-minute candle history for all 12 V1 symbols. Uses paginated API calls (5,000 candles per page) working backwards from the current time. Uses INSERT ... ON CONFLICT DO NOTHING for deduplication (no pre-query needed). Features per-symbol progress tracking with:
   - Individual progress percentages based on expected vs fetched records
   - Real-time status updates on every page (waiting, downloading, retrying, done, error)
   - Automatic WebSocket reconnection on connection loss (up to 5 consecutive retries per symbol)
   - Rate limiting (150ms delay between API calls) to avoid throttling
   - Partial failure handling: if a symbol fails, remaining symbols continue

3. **Backtest Phase**: Runs backtests for every combination of symbol × strategy family (up to 48 combinations). Each backtest simulates trades using the downloaded candle data and records win rate, profit factor, Sharpe ratio, trade count, and average holding hours.

4. **AI Review Phase** (optional, requires OpenAI key): GPT-4o analyses backtest results per symbol — identifies the best strategy and summarises performance patterns. Produces per-symbol text summaries and suggestion lists displayed in the UI. Does not directly write `ai_suggest_` keys (that happens in the optimisation phase).

5. **Optimisation Phase**: Computes optimised trading parameters from backtest aggregates (TP multipliers, SL ratio, equity sizing, time exits, trailing stops) and writes them as `ai_suggest_` prefixed keys in the platform_state table. Also records AI-recommended strategies and symbols. All values are suggestions only — none override user settings.

6. **Streaming Phase**: Starts live tick streaming for all 12 V1 default symbols (not limited to symbols that succeeded during backfill). Streaming is required for the system to begin receiving market data.

**Step 5 — Complete**: Summary of results including total candles downloaded, backtest results per symbol, AI insights, and any failed symbols with error details.

**Partial Failure Handling**: The wizard aborts only if all 12 symbols fail to download. If at least one symbol succeeds, the wizard proceeds through backtesting, AI review, optimisation, and streaming. Failed symbols are clearly shown with error codes (CONNECTION_FAILED, WS_DISCONNECTED, REQUEST_TIMEOUT, RATE_LIMITED, NULL_RESPONSE, API_ERROR). The `/setup/status` endpoint separately tracks whether 50%+ of symbols have sufficient data (100+ candles) for the `hasEnoughData` flag used by the dashboard.

**Reset**: A factory reset option in Settings clears all data (preserving API keys) and returns the system to the setup wizard state.

---

## 4. The Four Strategy Families

Each family is a distinct trading approach. The system only runs a strategy when the current market regime matches that strategy's ideal conditions.

### 4.1 Trend Continuation

**What it does**: Enters in the direction of an established trend when price pulls back toward the moving average.

**When it fires**:
- EMA slope > 0.0003 (uptrend) or < -0.0003 (downtrend)
- Price has pulled back near the EMA (distance < 0.008)
- RSI is neutral (38-65), confirming no extreme condition
- z-Score is moderate (< 2.0)
- Minimum model score: 0.58, minimum EV: 0.005

**Ideal regime**: trend_up or trend_down

**Hold Profile (defaults)**:
- TP: 6x ATR
- SL: 2.5x ATR
- Initial exit: 168 hours (7 days)
- Extension: 48 hours
- Max exit: 336 hours (14 days)
- Harvest sensitivity: 0.8

**Best suited for**: R_75 and R_100 during trending periods.

### 4.2 Mean Reversion

**What it does**: Bets that an overextended price will snap back to its average. Two sub-strategies operate under this family.

**Sub-strategy: Exhaustion Rebound**
- RSI extreme (< 32 oversold or > 68 overbought)
- z-Score extreme (< -1.8 or > 1.8)
- 3+ consecutive adverse candles

**Sub-strategy: Liquidity Sweep**
- Price breaches a swing high/low then reclaims it within 3 candles
- Small candle body (< 0.35), indicating rejection

**Minimum model score**: 0.60, minimum EV: 0.006

**Ideal regime**: mean_reversion

**Hold Profile (defaults)**:
- TP: 4x ATR
- SL: 3x ATR
- Initial exit: 120 hours (5 days)
- Extension: 36 hours
- Max exit: 240 hours (10 days)
- Harvest sensitivity: 1.0

**Best suited for**: Boom/Crash indices that overshoot.

### 4.3 Breakout Expansion

**What it does**: Catches explosive moves after periods of low volatility compression.

**Sub-strategy: Volatility Breakout**
- Bollinger Band width < 0.006 (squeeze)
- ATR rank > 0.8 (expanding)
- Price at upper band (> 0.85 %B) or lower band (< 0.15 %B)

**Sub-strategy: Volatility Expansion**
- BB width was compressed (< 0.008)
- BB width rate of change > 0.10
- ATR acceleration > 0.08
- Candle body expanding (> 0.6)

**Minimum model score**: 0.55, minimum EV: 0.005

**Ideal regime**: compression or breakout_expansion

**Hold Profile (defaults)**:
- TP: 8x ATR
- SL: 2x ATR
- Initial exit: 168 hours (7 days)
- Extension: 48 hours
- Max exit: 336 hours (14 days)
- Harvest sensitivity: 0.7

**Best suited for**: All instruments during consolidation-to-expansion transitions.

### 4.4 Spike Event

**What it does**: Predicts when a Boom spike (upward) or Crash spike (downward) is imminent, based on tick patterns and spike hazard scoring.

**When it fires**:
- Spike hazard score > 0.70
- Symbol must be a Boom or Crash index
- Direction: buy for Boom, sell for Crash

**Minimum model score**: 0.62, minimum EV: 0.008

**Ideal regime**: spike_zone

**Hold Profile (defaults)**:
- TP: 4x ATR
- SL: 1.5x ATR
- Initial exit: 72 hours (3 days)
- Extension: 24 hours
- Max exit: 168 hours (7 days)
- Harvest sensitivity: 1.2

**Best suited for**: BOOM and CRASH indices exclusively.

---

## 5. Signal Pipeline

Every potential trade goes through an 11-step pipeline from raw data to execution.

### Step 1: Tick Streaming
Live price ticks arrive from the Deriv WebSocket for all 12 instruments continuously.

### Step 2: Feature Extraction
20+ technical features are computed from tick and candle data:
- EMA slope and distance from EMA
- RSI (14-period)
- z-Score (standard deviations from mean)
- ATR (14-period average true range)
- Bollinger Band width, %B position, width rate of change
- ATR rank and acceleration
- Candle body ratio
- Consecutive candle count
- Swing breach detection (direction, candle count, reclaim status)
- Spike hazard score (Boom/Crash only)
- Ticks since last spike

### Step 3: Regime Classification
The market is classified into one of seven regimes:

| Regime | Conditions | Allowed Strategies |
|--------|-----------|-------------------|
| spike_zone | Boom/Crash with spike hazard > 0.72 | spike_event |
| compression | BB squeeze, no expansion, low slope | breakout_expansion |
| breakout_expansion | BB expanding, high ATR/acceleration | breakout_expansion |
| mean_reversion | z-Score extreme, RSI extreme, no strong trend | mean_reversion |
| trend_up | Strong positive EMA slope | trend_continuation |
| trend_down | Strong negative EMA slope | trend_continuation |
| no_trade | Conflicting or unclear signals | NONE — system waits |

### Step 4: Strategy Evaluation
Only strategies permitted by the current regime are run. Each permitted family evaluates the feature vector against its specific entry conditions.

### Step 5: ML Scoring
Each family has its own logistic regression model that produces a probability score (0-1) and confidence estimate from the feature vector.

### Step 6: Composite Scoring
A 6-dimension weighted score (0-100) is computed for each candidate signal:

| Dimension | Default Weight | What it measures |
|-----------|---------------|-----------------|
| Regime Fit | 22% | How well the regime matches the strategy's ideal |
| Setup Quality | 20% | Model score strength + expected value |
| Trend Alignment | 15% | EMA slope alignment with trade direction |
| Volatility Condition | 13% | Whether ATR is in the strategy's ideal range |
| Reward/Risk | 15% | TP distance vs SL distance ratio |
| Probability of Success | 15% | Win probability estimate |

### Step 7: Filtering
Signals must pass three minimum thresholds:
- Composite score >= min_composite_score (default: 80)
- Expected value >= min_ev_threshold (default: 0.003)
- Reward/risk ratio >= min_rr_ratio (default: 1.5)

### Step 8: AI Verification (Optional)
When enabled, OpenAI GPT-4o reviews each signal that scores 75+ and provides a verdict:
- **Agree**: Signal proceeds with possible confidence boost
- **Uncertain**: Signal proceeds but capital allocation halved
- **Disagree**: Signal blocked

### Step 9: Portfolio Allocation
Risk checks are applied in order:
1. Kill switch not active
2. Daily loss limit not breached
3. Weekly loss limit not breached
4. Max drawdown not breached
5. Open risk below 80% of equity
6. Max simultaneous trades not reached
7. Strategy is enabled for this mode
8. Regime is compatible
9. Composite score above threshold
10. Expected value above threshold
11. Valid SL/TP values
12. R:R ratio above threshold
13. Sufficient available capital
14. No opposing direction conflict on same symbol
15. Same-family exposure limit not exceeded
16. Correlated instrument exposure cap not reached

### Step 10: Position Sizing
Size = equity x equity_pct_per_trade x confidence_factor x stage_multiplier

**Confidence factor** = base_pct x (0.8 + 0.4 x confidence)

**Allocation mode modifier**:
- Conservative: 0.7x
- Balanced: 1.0x
- Aggressive: 1.3x

**Score-based tier adjustment**:
- Score >= 90: base + 6% extra
- Score >= 85: base + 3% extra
- Score >= 80: base allocation
- Score < 80: rejected

### Step 11: Execution
Trade is opened at the current spot price with calculated TP, SL, and trailing stop.

---

## 6. Position Sizing — Worked Example

**Given**: $10,000 equity, 22% equity per trade, confidence 0.85, probe stage

1. Base percent = 22 / 100 = 0.22
2. Confidence-adjusted = 0.22 x (0.8 + 0.4 x 0.85) = 0.22 x 1.14 = 0.2508
3. Raw size = $10,000 x 0.2508 = $2,508
4. Stage multiplier for probe (1.0): $2,508 x 1.0 = $2,508
5. Clamped to minimum 5% of equity ($500) and maximum remaining capacity (80% of equity minus already deployed)

**Same signal at confirmation stage** (multiplier 0.60): $2,508 x 0.60 = $1,505
**Same signal at momentum stage** (multiplier 0.50): $2,508 x 0.50 = $1,254

---

## 7. Trade Lifecycle

### Phase 1: Entry
Signal passes all 11 pipeline steps. Position opened at spot price with calculated TP, SL, and trailing stop percentage.

### Phase 2: Position Building
The system can build up to 3 entries on the same symbol at progressively higher confidence requirements:

| Stage | Existing Trades on Symbol | Score Requirement (Paper / Demo / Real) | Size Multiplier (Paper / Demo / Real) |
|-------|--------------------------|----------------------------------------|--------------------------------------|
| Probe | 0 | 75 / 82 / 88 | 1.00 / 0.85 / 0.70 |
| Confirmation | 1 | 80 / 86 / 91 | 0.90 / 0.75 / 0.60 |
| Momentum | 2 | 85 / 90 / 94 | 0.80 / 0.65 / 0.50 |

### Phase 3: Monitoring
Every 10 seconds, for each open trade:
- Update current price from live tick data
- Track peak price (highest for buys, lowest for sells)
- Check if TP or SL has been hit
- Evaluate trailing stop adjustment
- Check profit harvest conditions
- Check time exit conditions

### Phase 4: Trailing Stop
Once price moves favourably, the stop-loss ratchets in the profitable direction. It never moves backwards.

For a buy trade: trailing SL = peak_price x (1 - trailing_stop_pct)
For a sell trade: trailing SL = peak_price x (1 + trailing_stop_pct)

The trailing stop only updates if the new calculated SL is better than the existing one.

### Phase 5: Profit Harvest
Two harvest conditions:
1. **Standard harvest**: Peak profit >= min_peak_profit_pct AND drawdown from peak >= peak_drawdown_exit_pct
2. **Large peak harvest**: Peak profit >= large_peak_threshold_pct AND drawdown from peak >= peak_drawdown_exit_pct x 0.6 (tighter trigger for big winners)

### Phase 6: Time Exit
After the initial exit window:
- **Profitable**: Close immediately, capture gains
- **Small loss** (< 2%): Extend by extension_hours, capped at max_exit_hours
- **Large loss**: Close immediately, cut losses
- **Hard maximum**: At max_exit_hours, close regardless of PnL

### Phase 7: Close
Trade closed, PnL calculated, capital updated. Exit reason recorded for analysis.

---

## 8. Take Profit and Stop Loss Calculation

### Dynamic TP Calculation

```
predictedMovePct = ATR x familyTpAtrMultiplier x confidence
tpPct = predictedMovePct x tpCaptureRatio
clampedTpPct = clamp(tpPct, ATR x 2.5, ATR x 15.0)
TP = entryPrice x (1 + clampedTpPct) for buys
TP = entryPrice x (1 - clampedTpPct) for sells
```

If historical average move data is available (from past 50 trades on the same symbol/strategy), the system uses the larger of the ATR-based prediction and the historical estimate.

A confidence-tiered multiplier adjusts the TP further:
- Confidence >= 0.75: tp_multiplier_strong
- Confidence >= 0.65: tp_multiplier_medium
- Below 0.65: tp_multiplier_weak

### Initial SL Calculation

```
effectiveMultiplier = max(familySlAtrMultiplier, minSlAtrMultiplier)
slPct = ATR x effectiveMultiplier x slRatio
SL = entryPrice x (1 - slPct) for buys
SL = entryPrice x (1 + slPct) for sells
```

The min_sl_atr_multiplier setting ensures the SL is never too tight. Real mode uses a higher minimum (4.0x ATR) than Paper mode (3.0x ATR) for additional safety.

---

## 9. Capital Extraction Cycle

1. Start with base capital (e.g., $10,000 for Paper, $600 for Demo/Real)
2. Trade normally using the system
3. When capital grows by extraction_target_pct (default 50%) above the starting amount, extraction is triggered
4. If auto_extraction is enabled, profits are automatically extracted and capital resets to starting amount
5. If auto_extraction is disabled, the user is prompted to review
6. The extraction cycle number increments and total extracted amount is tracked
7. Process repeats indefinitely

**Example**: Start at $10,000 with 50% target. Grow to $15,000. Extract $5,000. Reset to $10,000. Cycle 2 begins.

This prevents the "double-or-nothing" trap — profits are realised regularly and risk stays controlled at the original capital base.

---

## 10. Three Trading Modes — V1 Default Profiles

### Paper Mode (120% Monthly Target — Aggressive)

| Setting | Default Value |
|---------|-------------|
| Capital | $10,000 |
| Equity per trade | 30% |
| Max open trades | 4 |
| Allocation mode | Aggressive |
| Probe threshold | 75 |
| Confirmation threshold | 80 |
| Momentum threshold | 85 |
| Stage multiplier (probe / confirm / momentum) | 1.00 / 0.90 / 0.80 |
| TP multiplier (strong / medium / weak) | 3.5 / 2.8 / 2.0 |
| SL ratio | 1.0 |
| Trailing stop | 20% |
| Time exit window | 336 hours |
| TP capture ratio | 0.80 |
| Min SL ATR multiplier | 3.0 |
| Max daily loss | 8% |
| Max weekly loss | 15% |
| Max drawdown | 25% |
| Extraction target | 50% |
| Peak drawdown exit | 25% |
| Min peak profit | 3% |
| Large peak threshold | 8% |
| Correlated family cap | 4 |

### Demo Mode (80% Monthly Target — Balanced)

| Setting | Default Value |
|---------|-------------|
| Capital | $600 |
| Equity per trade | 20% |
| Max open trades | 3 |
| Allocation mode | Balanced |
| Probe threshold | 82 |
| Confirmation threshold | 86 |
| Momentum threshold | 90 |
| Stage multiplier (probe / confirm / momentum) | 0.85 / 0.75 / 0.65 |
| TP multiplier (strong / medium / weak) | 3.0 / 2.5 / 1.8 |
| SL ratio | 1.0 |
| Trailing stop | 22% |
| Time exit window | 168 hours |
| TP capture ratio | 0.70 |
| Min SL ATR multiplier | 3.5 |
| Max daily loss | 5% |
| Max weekly loss | 10% |
| Max drawdown | 18% |
| Extraction target | 50% |
| Peak drawdown exit | 30% |
| Min peak profit | 3% |
| Large peak threshold | 8% |
| Correlated family cap | 3 |

### Real Mode (50% Monthly Target — Conservative)

| Setting | Default Value |
|---------|-------------|
| Capital | $600 |
| Equity per trade | 15% |
| Max open trades | 3 |
| Allocation mode | Balanced |
| Probe threshold | 88 |
| Confirmation threshold | 91 |
| Momentum threshold | 94 |
| Stage multiplier (probe / confirm / momentum) | 0.70 / 0.60 / 0.50 |
| TP multiplier (strong / medium / weak) | 2.5 / 2.0 / 1.5 |
| SL ratio | 1.0 |
| Trailing stop | 25% |
| Time exit window | 168 hours |
| TP capture ratio | 0.60 |
| Min SL ATR multiplier | 4.0 |
| Max daily loss | 3% |
| Max weekly loss | 6% |
| Max drawdown | 12% |
| Extraction target | 50% |
| Peak drawdown exit | 30% |
| Min peak profit | 3% |
| Large peak threshold | 8% |
| Correlated family cap | 3 |

### Per-Family Hold Profiles (Defaults)

Each strategy family has its own TP/SL distances and time exit windows. These are further customisable per mode.

#### Paper Mode Family Profiles

| Family | TP ATR | SL ATR | Initial Exit | Extension | Max Exit | Harvest Sensitivity |
|--------|--------|--------|-------------|-----------|---------|-------------------|
| Trend Continuation | 10.0 | 4.0 | 168h | 48h | 336h | 0.7 |
| Mean Reversion | 8.0 | 4.0 | 120h | 36h | 240h | 0.9 |
| Breakout Expansion | 12.0 | 3.0 | 168h | 48h | 336h | 0.6 |
| Spike Event | 6.0 | 3.0 | 72h | 24h | 168h | 1.0 |

#### Demo Mode Family Profiles

| Family | TP ATR | SL ATR | Initial Exit | Extension | Max Exit | Harvest Sensitivity |
|--------|--------|--------|-------------|-----------|---------|-------------------|
| Trend Continuation | 8.0 | 3.0 | 168h | 48h | 336h | 0.8 |
| Mean Reversion | 6.0 | 3.5 | 120h | 36h | 240h | 1.0 |
| Breakout Expansion | 10.0 | 2.5 | 168h | 48h | 336h | 0.7 |
| Spike Event | 5.0 | 2.0 | 72h | 24h | 168h | 1.1 |

#### Real Mode Family Profiles

| Family | TP ATR | SL ATR | Initial Exit | Extension | Max Exit | Harvest Sensitivity |
|--------|--------|--------|-------------|-----------|---------|-------------------|
| Trend Continuation | 6.0 | 3.5 | 168h | 48h | 336h | 0.8 |
| Mean Reversion | 4.0 | 4.0 | 120h | 36h | 240h | 1.0 |
| Breakout Expansion | 8.0 | 3.0 | 168h | 48h | 336h | 0.7 |
| Spike Event | 4.0 | 2.5 | 72h | 24h | 168h | 1.2 |

---

## 11. Risk Management

### Multi-Layer Protection

The system enforces risk at multiple levels:

1. **Signal Quality Gate**: Only signals scoring 80+ composite enter the pipeline
2. **AI Verification**: Optional GPT-4o review can veto signals
3. **Position Sizing**: Equity percentage caps limit individual trade exposure
4. **Max Open Trades**: Hard limit on simultaneous positions
5. **Equity Deployment Cap**: Maximum 80% of equity deployed at any time
6. **Daily Loss Limit**: Halts trading when daily losses exceed the threshold
7. **Weekly Loss Limit**: Halts trading when weekly losses exceed the threshold
8. **Max Drawdown**: Halts trading when drawdown from peak exceeds the threshold
9. **Correlated Exposure Cap**: Limits positions in related instruments (e.g., all Boom indices count as correlated)
10. **Conflict Prevention**: No opposing direction on the same symbol, no more than 2 trades from the same strategy family on one symbol
11. **Kill Switch**: Emergency stop that instantly blocks all new trades
12. **Trailing Stops**: Automatic profit protection that ratchets in the favourable direction
13. **Time Exits**: Prevents holding losing trades indefinitely
14. **Profit Harvest**: Closes trades that have given back too much from their peak

### Kill Switch

The kill switch is a global emergency control. When active:
- All new trade signals are blocked immediately
- Existing open trades continue to be managed (trailing stops, time exits)
- No new positions can be opened in any mode
- Must be manually deactivated to resume trading

The kill switch is locked by default in the settings UI and requires explicit unlocking with a risk warning acknowledgment.

---

## 12. AI Advisor System

### Fundamental Rule: Suggestions Only

The AI system is an **advisor, not a controller**. It can never directly change any setting. Every AI recommendation is stored as an `ai_suggest_` prefixed key in the database. The user must explicitly review and apply each suggestion through the Settings page.

### AI Components

#### AI Signal Verification
- Runs on each signal scoring 75+
- Reviews signal context: features, regime, recent candles, recent trade history
- Produces verdict: agree / uncertain / disagree
- Can block or reduce allocation, but never override user settings

#### Weekly Analysis (Sundays)
- Requires at least 5 closed trades
- Analyses performance per mode: win rate, PnL, duration, TP/SL hit rates, harvest effectiveness
- Generates suggestions for every adjustable setting based on performance data
- Covers: equity sizing, max trades, TP multipliers, SL ratio, trailing stops, time exits, risk limits, entry thresholds, stage multipliers, harvest thresholds, min SL ATR multiplier, correlated family cap, allocation mode, extraction target, per-family hold profiles, enabled instruments, enabled strategies
- Applies conservatism factor: Real mode suggestions are most conservative (0.85x), Paper most aggressive (1.05x)
- Analyses regime distribution and adjusts regime_fit scoring weight suggestion

#### Monthly Re-Optimisation
- Runs backtests and optimises strategy parameters
- All results written as ai_suggest_ keys only
- Never overrides user settings directly

#### AI Chatbot
- Comprehensive knowledge base covering all platform concepts
- Dynamic context injection: current settings, active modes, recent performance, pending suggestions
- Trade analysis tool: queries recent trades across 7 focus areas
- Signal analysis tool: queries signal logs across 5 focus areas
- Can write new suggestions for user review
- Explains concepts in plain language with examples

### Suggestion Flow

1. AI writes `ai_suggest_{setting_key}` to platform_state table
2. Settings page displays suggestion badges next to affected settings
3. User reviews suggestion and clicks "Apply" (or "Unlock to Apply" if setting is locked)
4. Setting unlocks with risk warning, suggestion value is applied
5. User saves the section to persist the change

---

## 13. Settings Structure

### Setting Categories

All settings are stored as key-value pairs in the platform_state table.

**Global Settings** (no prefix — apply to all modes):
- Signal quality: min_composite_score, min_ev_threshold, min_rr_ratio
- Scoring weights: scoring_weight_regime_fit, scoring_weight_setup_quality, scoring_weight_trend_alignment, scoring_weight_volatility_condition, scoring_weight_reward_risk, scoring_weight_probability_of_success
- Scan timing: scan_interval_seconds, scan_stagger_seconds
- AI: ai_verification_enabled
- Emergency: kill_switch

**Per-Mode Settings** (prefixed with paper_, demo_, or real_):
- Capital: capital, equity_pct_per_trade, max_open_trades, allocation_mode
- TP/SL: tp_multiplier_strong/medium/weak, sl_ratio, trailing_stop_pct, time_exit_window_hours, tp_capture_ratio, min_sl_atr_multiplier
- Risk limits: max_daily_loss_pct, max_weekly_loss_pct, max_drawdown_pct
- Entry thresholds: probe_threshold, confirmation_threshold, momentum_threshold
- Stage multipliers: stage_multiplier_probe/confirmation/momentum
- Harvest: peak_drawdown_exit_pct, min_peak_profit_pct, large_peak_threshold_pct
- Extraction: extraction_target_pct, auto_extraction
- Portfolio: correlated_family_cap, enabled_symbols, enabled_strategies

**Per-Family Settings** (prefixed with {mode}_{family}_):
- tp_atr_multiplier, sl_atr_multiplier
- initial_exit_hours, extension_hours, max_exit_hours
- harvest_sensitivity

### Settings UX

- All settings are **locked by default** (read-only display)
- Unlocking requires clicking the lock icon and acknowledging a risk warning
- Settings are saved per section (each Card has its own Save button)
- AI suggestion badges appear inline next to settings that have pending suggestions
- A "Review Suggestions" button highlights all AI suggestions with a visual glow effect
- The kill switch has special handling: always locked, saves immediately with an override pattern

---

## 14. Deployment

### Recommended: Railway

The project deploys to Railway using:
- `railway.toml` for configuration
- Multi-stage `Dockerfile` with esbuild bundling
- PostgreSQL database provisioned by Railway
- Auto-rebuilds on GitHub push

### Alternative: Docker Compose

Docker Compose configurations support:
- Standard Docker environments
- Synology NAS deployments

### Environment Variables

| Variable | Purpose |
|----------|---------|
| DATABASE_URL | PostgreSQL connection string |
| PORT | Server port (assigned by platform) |
| NODE_ENV | Environment (development/production) |

API keys are stored encrypted in the database (not as environment variables):
- deriv_api_token_demo — Deriv demo account API token
- deriv_api_token_real — Deriv real account API token
- openai_api_key — OpenAI API key for AI features

### Data Backfill

<<<<<<< HEAD
The setup wizard handles initial data backfill for all 12 instruments:
- Probing phase queries each symbol's oldest available data from the Deriv API
- 1-minute and 5-minute timeframes downloaded in paginated API calls (5,000 candles per page)
- Uses conflict-safe inserts so re-runs fill gaps without duplicating
- Per-symbol progress tracking with real-time status updates and individual progress bars
- Automatic WebSocket reconnection with up to 5 retry attempts per symbol
- Rate-limited API calls (150ms between requests) to avoid throttling
- Partial failure resilience: individual symbol failures do not block the remaining symbols
=======
On startup, the system automatically backfills 12 months of candle history for all 12 instruments:
- 1-minute and 5-minute timeframes
- Paginated Deriv API calls (5,000 candles per page)
- 12-month rolling window: candles older than 12 months are automatically pruned
- Uses conflict-safe inserts so re-runs fill gaps without duplicating
- Partial success model: setup proceeds if ≥8 of 12 symbols succeed; failed symbols can be re-downloaded from Research > Data Status
- Per-symbol progress tracking with visual progress bars
>>>>>>> d764284 (V1 Research Page Overhaul, Setup Failure Handling & Backtest Restructure)

### Backtest Structure

Backtesting runs 1 pass per symbol, executing all 4 strategy families in a single pass:
- Produces 12 backtests (1 per symbol) instead of 48 (4 strategies × 12 symbols)
- Only profitable strategies (net profit > 0 and trade count > 0) are stored
- Each backtest run stores a `strategyBreakdown` in `metricsJson` with per-strategy metrics
- Uses `strategyName: "all_strategies"` in `backtest_runs` table

### Research Page

The Research page provides data health monitoring and per-symbol analysis:
- **Data Status section**: Per-symbol health cards showing candle counts, date ranges, and backtest freshness (healthy/stale/no_data)
- **Download & Simulate**: Per-symbol SSE-powered download of 12 months of data followed by automatic backtesting
- **Re-run Backtest**: Re-run all strategies on existing data for a symbol
- **Grouped Results**: Backtest results grouped by symbol, showing only profitable strategies
- **AI Chat**: Per-backtest AI chat powered by OpenAI, with full context of the backtest metrics and trade log

### Data Retention

Candles older than 12 months are automatically pruned:
- `pruneOldCandles()` runs at the start of setup initialisation and download-simulate operations
- Manual trigger available via Research > Data Status "Prune Old" button
- Cutoff calculated as `now - (365 * 24 * 3600)` seconds

### Symbol Validation

At startup, all configured symbols are validated against the Deriv active_symbols API. Invalid symbols are refused. A stale-stream watchdog monitors tick freshness and auto-resubscribes symbols that stop receiving data.

---

## 15. Future Vision

V1 establishes the foundation. The platform is designed to evolve in several directions:

- **Expanded instrument catalog**: Adding R_10, R_25, R_50, RDBULL, RDBEAR, Jump indices (JD10-JD100), Step indices (stpRNG, STP2-5), and Range Break indices (RDBR100, RDBR200) as new strategy families and regime classifiers are validated for each instrument type.
- **Advanced ML models**: Replacing logistic regression with gradient-boosted models and eventually neural networks, trained on the growing database of labelled trade outcomes.
- **Walk-forward optimisation**: Automated rolling-window backtests that continuously recalibrate strategy parameters against recent market behaviour.
- **Multi-timeframe analysis**: Incorporating 5-minute, 15-minute, and hourly candle features alongside the current 1-minute data for higher-confidence regime classification.
- **Correlation-aware portfolio management**: Dynamic cross-instrument correlation matrices that adjust position sizing and exposure caps based on measured real-time correlations rather than static family groupings.
- **Mobile monitoring**: A companion mobile interface for monitoring trades, reviewing AI suggestions, and triggering the kill switch remotely.
- **Performance attribution**: Detailed reporting that breaks down returns by strategy family, regime, instrument, time of day, and market condition to identify the highest-value edges.

---

## 16. Glossary

| Term | Meaning |
|------|---------|
| ATR | Average True Range — measures how much the price typically moves per period |
| R:R | Reward-to-Risk ratio — TP distance divided by SL distance |
| Composite Score | Overall signal quality (0-100), combining 6 weighted dimensions |
| Regime | The current market condition: trending, reverting, compressing, or spiking |
| EMA | Exponential Moving Average — a smoothed price trend line |
| RSI | Relative Strength Index (0-100), measures momentum. Below 30 = oversold, above 70 = overbought |
| z-Score | How many standard deviations price is from its mean. Beyond ±2 is considered extreme |
| Bollinger Bands | Volatility bands around price. When narrow ("squeeze"), a breakout is likely |
| BB Width | Width of Bollinger Bands. Below 0.006 indicates a squeeze |
| %B | Where price sits within Bollinger Bands (0 = lower band, 1 = upper band) |
| Spike Hazard | Probability (0-1) that a Boom/Crash spike is imminent |
| Trailing Stop | A stop-loss that moves with profitable price action, locking in gains |
| Profit Harvest | Closing a trade that has given back a significant portion of its peak profit |
| Capital Extraction | Taking profits out of the account at a target level and resetting to the original base |
| Expected Value (EV) | Average profit per dollar risked if this trade were repeated many times |
| Probe | First entry on a symbol — lowest score requirement, full size multiplier |
| Confirmation | Second entry on the same symbol — higher score required, smaller position |
| Momentum | Third entry on the same symbol — highest score required, smallest position |
| Kill Switch | Emergency control that blocks all new trades immediately |
| Allocation Mode | Conservative (0.7x), Balanced (1.0x), or Aggressive (1.3x) position sizing modifier |
