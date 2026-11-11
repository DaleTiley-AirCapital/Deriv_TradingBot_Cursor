# Runtime Lab Root Reset Plan

## Purpose

The current platform must stop trying to make a complex production runtime profitable before proving the underlying signal has real forward edge.

This plan defines a separate, bare-bones Runtime Lab whose only job is to answer one question:

> Can a deterministic runtime look at the current candle with no future information, open a trade, manage it to completion, and produce profitable walk-forward results?

Until that is proven, no new allocator, live scanner, promotion, AI assistant, or advanced platform feature should be built around the current research runtime.

## Why This Reset Is Required

Recent external AI reviews converged on the same core concern:

- The 100 percent win-rate build results are not credible until proven no-lookahead.
- The current system mixes research labels, runtime promotion, live scanning, allocator decisions, and lifecycle management across too many layers.
- Debugging serialization, allocator rejection, UI labels, or trailing-stop terminology does not prove that the strategy has predictive edge.
- Detected moves are useful as labels, but they must not become entry selection.
- The only reliable proof is strict candle-by-candle walk-forward execution using only information available at each entry candle.

This plan therefore separates strategy truth from platform plumbing.

## Non-Negotiable Goal

Build a profitable swing-trading runtime only after proving it in a clean lab environment.

The lab must prove:

- no future candles are used for entry decisions
- detected moves are labels only
- live-style rules can open trades from current candle data
- trade management can hold, protect, and exit without knowing the future
- results remain profitable after spread/slippage assumptions
- the runtime can be expressed as a deterministic contract

## What We Are Not Building Yet

Do not build or modify:

- allocator logic
- paper/demo/real execution
- production promotion workflow
- current Build Runtime Model UI
- live scanner behavior
- service runtime gates
- new dashboards
- additional reports
- AI strategy automation

The lab is deliberately separate from the trading app.

## Proposed Railway Layout

Create a new Railway environment/service pair:

```text
runtime-lab
```

The service should use a cloned database from the current deployment so historical candles and detected moves are available without re-downloading data.

The runtime-lab service must not share the live platform state tables for active trading decisions. It may read copied historical data, but it must not write to live trading, allocator, promotion, or paper-trade tables.

## Database Clone Requirements

Clone the current Railway database into a lab database containing:

- candles
- ticks, if needed for later tick-level validation
- detected_moves
- calibrated move/profile data if trustworthy
- feature/enrichment tables if they are point-in-time safe
- symbol metadata

Do not require:

- open trades
- closed paper trades
- allocator decisions
- promoted runtime state
- live service candidates
- platform state
- app settings except read-only reference values

Lab outputs can initially be JSON files. If tables are needed later, use lab-prefixed tables only:

```text
lab_feature_fingerprints
lab_control_samples
lab_candidate_rules
lab_walkforward_runs
lab_walkforward_trades
lab_rule_scores
```

## Bare-Bones UI

The frontend should be a single simple page:

```text
Runtime Lab

Service: [CRASH300 | R_75 | BOOM300 | R_100]
Window:  [date range]
Family:  [all | breakout | reversal | continuation | crash_expansion | boom_expansion]
Target:  [>=5% | >=9% | custom]

[Run Data Audit]
[Run Move Fingerprints]
[Run Control Comparison]
[Generate Rules]
[Run Walk-Forward]
[Export JSON]
```

The page should show only:

- run status
- key metrics
- trade list
- rule details
- blockers
- JSON export

No allocator. No promotion. No staged runtime. No mode gates. No live scanner. No paper trading.

## Research Flow

### Phase 1: Data Integrity Audit

Before strategy work, prove the dataset is usable.

For each selected symbol:

- candle count by timeframe
- first/last candle timestamp
- missing gaps
- duplicate timestamps
- out-of-order candles
- interpolated candle count
- detected move count
- move start/end validity
- move magnitude distribution
- move duration distribution

Output:

```json
{
  "serviceId": "R_75",
  "candlesUsable": true,
  "movesUsableAsLabels": true,
  "dateWindow": {},
  "blockers": [],
  "warnings": []
}
```

Acceptance:

- no strategy test may run until candles and labels pass integrity checks
- detected moves are explicitly marked as labels, not tradable signals

### Phase 2: Move-Start Fingerprinting

For every detected move, calculate what the market looked like at or before the move start.

The feature builder must enforce:

```text
feature_timestamp <= move_start_timestamp
```

Feature windows:

- 1m
- 5m
- 15m
- 1h
- 4h
- 24h
- 7d
- 30d where available

Feature categories:

- ATR and ATR rank
- volatility expansion/compression
- Bollinger width/rank
- range position
- distance from rolling highs/lows
- trend slope by window
- return by window
- wick/body structure
- pullback depth
- momentum acceleration/failure
- reversal pressure
- compression-to-expansion score
- bars since prior move
- bars since prior spike cluster
- Crash/Boom spike counts
- Volatility breakout/reversal/continuation shape

Output:

```json
{
  "moveId": "...",
  "serviceId": "R_75",
  "family": "breakout",
  "direction": "buy",
  "moveStart": "...",
  "movePct": 6.42,
  "featuresAtMoveStart": {}
}
```

Acceptance:

- no feature can use future candles
- every feature must declare its lookback window

### Phase 3: Control Candle Comparison

Compare move-start fingerprints against candles that did not become target moves.

Control samples:

- random non-move candles
- candles near failed moves
- candles in sideways/noise windows
- candles with similar volatility but no profitable continuation

For every candidate feature:

```text
target_move_presence_rate
control_presence_rate
separation_score
false_positive_pressure
```

Acceptance:

- a feature is useful only if it separates target moves from controls
- a feature that appears everywhere is discarded

### Phase 4: Rule Mining

Use the strongest separating feature ranges to generate deterministic candidate rules.

Example:

```json
{
  "ruleId": "r75_breakout_buy_a",
  "serviceId": "R_75",
  "family": "breakout",
  "direction": "buy",
  "entryConditions": [
    { "feature": "atrRank4h", "min": 0.45, "max": 0.85 },
    { "feature": "compressionToExpansionScore1h", "min": 0.62 },
    { "feature": "rangePosition30d", "min": 0.70 },
    { "feature": "trendSlope1h", "min": 0 }
  ]
}
```

Rules must be:

- deterministic
- human-readable
- directly executable
- versioned
- tied to feature definitions

No AI-generated rule may be accepted unless converted to deterministic conditions and retested.

### Phase 5: Strict Walk-Forward Engine

This is the truth test.

For each candle:

```text
1. calculate features using candles <= current candle
2. evaluate rule against current features
3. if rule matches, open simulated trade
4. manage trade forward candle by candle
5. close by TP, hard SL, protection, exhaustion, or maturity
6. log the full trade
7. only after close, compare against detected move labels
```

The walk-forward engine must not know:

- future MFE
- future MAE
- future move end
- future move bucket
- whether the entry is inside a detected move
- whether the trade will win

Acceptance:

- if a rule cannot be tested this way, it cannot become a runtime

### Phase 6: Entry And Exit Separation

Test entry and exit independently.

Entry test:

- after entry, what happens over the next N candles?
- did price reach 3%, 5%, 7%, 9%?
- what was MFE?
- what was MAE?
- did it overlap a detected target move?

Exit test:

- did the lifecycle manager close too early?
- did it hold through normal pullback?
- did it let winners become losers?
- did it close on validated exhaustion?
- did hard SL fire correctly?

Acceptance:

- bad exits must not be misdiagnosed as bad entries
- good entries must be visible even before lifecycle tuning

### Phase 7: Scoring

Win rate alone is not a pass condition.

Primary metrics:

- profit factor after spread/slippage
- net return
- max drawdown
- monthly stability
- trade frequency
- average and median PnL
- gross profit
- gross loss
- longest losing streak
- target move coverage
- false positive count
- missed target move count

Minimum first-pass thresholds:

```text
profit factor > 1.20
positive expectancy after costs
max drawdown within configured risk budget
sufficient trade count for the window
monthly result not dependent on one lucky cluster
```

Expected realistic outcomes:

- 50-70% win rate may be good
- 100% win rate should be treated as suspicious until proven
- profit factor matters more than perfection

### Phase 8: Controlled Iteration

Do not brute force infinite combinations.

Use move fingerprints to define the search space, then mutate around useful ranges.

Example:

```text
atrRank4h 0.45-0.85
try 0.40-0.85
try 0.50-0.80
try 0.55-0.78
```

Every iteration must produce:

- rule version
- parameter changes
- walk-forward result
- comparison against previous best
- reason kept/rejected

### Phase 9: Runtime Contract Export

Only after a rule passes strict walk-forward, export a compact runtime contract:

```json
{
  "runtimeId": "r75_lab_runtime_001",
  "serviceId": "R_75",
  "source": "runtime_lab_walkforward",
  "ruleSet": [],
  "featureDefinitions": {},
  "entryRules": {},
  "tpRules": {},
  "slRules": {},
  "lifecycleRules": {},
  "walkForwardStats": {},
  "costAssumptions": {},
  "createdAt": "..."
}
```

This contract must be directly executable. The production app must not reinterpret it through generic confidence, setup match, or fallback component scores.

### Phase 10: Return To Dev/Live

Only after the lab proves a runtime:

1. import runtime contract into dev
2. run the exact same walk-forward in dev
3. compare lab result vs dev result
4. run recent-candle replay
5. paper trade only if parity passes
6. promote live only after paper behavior matches lab expectations

## Symbol Research Priorities

### R_75

Target:

- >=5% moves
- breakout buy/sell
- reversal buy/sell
- continuation buy/sell

Rationale:

- frequent enough to test
- multiple families
- should not be reduced to one generic breakout policy

### CRASH300

Target:

- >=5% first
- inspect >=9% separately

Families:

- crash spike cluster recovery
- crash expansion
- post-crash recovery
- failed recovery / exhaustion only if proven no-lookahead

Rationale:

- current 100% results are suspicious
- must prove live-style entries exist before trusting promoted runtime

### BOOM300

Target:

- mirror CRASH logic
- boom spike cluster exhaustion
- sustained drift and swing reversal

### R_100

Target:

- same framework as R_75
- independently mined ranges

## AI Usage

AI may assist only after deterministic summaries exist.

Allowed:

- summarize feature separation
- suggest candidate rule mutations
- explain why a rule may be overfit
- propose additional control samples

Not allowed:

- select trades
- decide entries using raw future-labelled moves
- promote runtimes
- change live behavior
- bypass walk-forward proof

## Success Criteria

The lab succeeds when it produces at least one runtime candidate that:

- uses no future data for entry
- opens trades from candle-by-candle live-style conditions
- has positive expectancy after costs
- has profit factor greater than 1.20
- has acceptable drawdown
- has enough trade frequency to matter
- survives out-of-sample or later-window testing
- can be exported as a deterministic runtime contract

The existing platform should remain downstream of this proof.

## Failure Criteria

The lab must reject a candidate if:

- it requires knowing future move magnitude
- it requires knowing future move end
- it only wins after filtering by detected move labels
- it fires constantly in control candles
- profit factor fails after costs
- max drawdown is unacceptable
- results collapse out of sample
- runtime cannot be expressed deterministically

## Immediate Build Sequence

1. Create branch:

```text
codex/runtime-lab-root-reset
```

2. Create Railway service:

```text
runtime-lab
```

3. Clone current DB into a lab DB.

4. Add minimal lab backend:

```text
GET /health
GET /symbols
POST /runs/data-audit
POST /runs/fingerprints
POST /runs/control-comparison
POST /runs/generate-rules
POST /runs/walk-forward
GET /runs/:id
GET /runs/:id/export
```

5. Add minimal lab frontend:

```text
symbol selector
date window
family selector
target selector
run buttons
results panel
trade table
export JSON
```

6. First research pass:

```text
R_75 >=5% multi-family fingerprints and walk-forward
```

7. Second research pass:

```text
CRASH300 >=5% and >=9% no-lookahead validation
```

8. Only after a runtime passes:

```text
import deterministic contract into dev
```

## Operating Rule

If the lab cannot prove a profitable no-lookahead walk-forward runtime, the production platform has no runtime worth promoting.

That is the point of the reset.
