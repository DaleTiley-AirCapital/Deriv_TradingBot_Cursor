# V3.1 Research To Runtime Workflow

## Visible Workflow

Every symbol service follows one visible workflow:

1. Data Coverage
2. Full Calibration
3. Build Runtime Model
4. Validate Runtime
5. Promote Runtime
6. Stream / Monitor

Do not add a new top-level Research button for an internal diagnostic. If a capability belongs in the workflow, absorb it into Build Runtime Model, Validate Runtime, or a read-only report export.

## Build Runtime Model

Build Runtime Model replaces the old integrated synthesis action as the user-facing runtime-building task. It may keep existing internal function and endpoint names temporarily, but UI and docs must call it Build Runtime Model.

Internal stages:

- load latest calibration source data
- build or reuse move universe
- build or reuse candidate entry matrix
- build or reuse non-move controls
- run deterministic candidate search
- run lifecycle simulation
- run return-first profit ranking
- run coverage and missed-move analysis
- run offline AI-assisted reasoning when enabled
- convert the proposal into live-safe deterministic runtime rules
- generate candidate runtime artifact
- generate reports

The consolidated output contract is `runtime_build_result_<SERVICE>_<RUN>.json`. It is an artifact over existing calibration, synthesis, backtest, and platform-state data. It must not create tables, promote runtime, enable execution modes, or auto-stage a candidate.

Final-pass CRASH300 steering is data-led. Build Runtime Model escalates high-volume promising seed families before tiny perfect subsets, with `failed_recovery_short | failed_recovery_break_down | 5_to_6_pct | sell | late` as the current primary family when it satisfies volume, win-rate, and SL gates. The build result reports pre-limit family stats, post-daily-limit stats, winner-vs-loser separation, Trade Lifecycle Manager replay, dynamic TP/protection settings, AI Strategy Review status, candidate-family comparison, and runtime artifact eligibility.

Reports describe exits as the Trade Lifecycle Manager: protection activation, protected floor, TP1, TP2/runner target, lifecycle state, continuation score, reversal pressure, momentum failure exit, time/progress failure exit, and protected exit. Historical low-level fields may be read for compatibility, but new user-facing reports must not present a fixed trailing-stop strategy.

## Validate Runtime

Validate Runtime is the single user-visible validation action for the currently staged runtime candidate.

Internal stages:

- runtime mimic validation
- historical backtest
- parity check against calibrated move universe
- runtime trigger validation
- phantom/noise trade check
- allocator visibility/provenance check
- lifecycle monitor validation
- mode-gate safety check

The consolidated output contract is `runtime_validation_result_<SERVICE>_<RUN>.json`. It must not promote runtime, enable Paper/Demo/Real, or alter live or allocator execution behavior.

## Promote Runtime

Promotion is service-level:

- action label: Promote Runtime
- promoted state key: `promoted_service_runtime_<SERVICE_ID>`
- execution destination is decided later by mode gates

Avoid paper-specific promotion language. Paper, Demo, and Real are execution modes, not separate promotion targets.

## Reports

Reports are read-only exports grouped by purpose:

- Calibration Reports: detected moves, calibration profile, pass results, comparison summary
- Runtime Build Reports: runtime build summary, selected candidate, return/profit analysis, lifecycle replay, missed move/coverage analysis, policy comparison/candidate leaderboard
- Validation Reports: runtime mimic validation, backtest result, parity result, trigger validation, phantom/noise analysis
- Execution Reports: service candidates, allocator decisions, trades, lifecycle monitor logs

Backend diagnostic endpoints may remain for debugging. They should not appear as peer-level Research workflow actions.
