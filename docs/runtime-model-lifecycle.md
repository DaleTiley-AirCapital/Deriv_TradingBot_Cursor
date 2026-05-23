# Runtime Model Lifecycle

This document locks the trading architecture to a single ownership chain:

`Symbol Service -> Trade Candidate -> Portfolio Allocator -> Trade Execution/Manager`

## Core Rule

Calibration, research analysis, and backtest runs may generate **suggestions**.
They must not automatically change the live or paper runtime.

Runtime behavior may only change when a symbol model is explicitly **promoted**.

## Lifecycle States

### 1. Suggested

- Produced by move calibration, stored pass results, research profiling, or backtest diagnostics.
- Can recommend:
  - runtime contract gates
  - entry maturity windows
  - scan cadence
  - TP1, TP2/runner, hard SL, protection floor, and lifecycle manager policy
  - formula overrides
- Must be treated as research output only.

### 2. Staged

- A suggested model can be staged for review after Build Runtime Model produces a review artifact.
- Staging is still non-promoted and does not enable execution by itself.
- Backtests may compare against staged models, but staged models must not become live implicitly.

### 3. Promoted

- Only promoted models may influence:
  - live paper trading
  - demo trading
  - real trading
  - live/backtest parity runs that are intended to mirror runtime
- Promotion must be explicit and traceable to a source Build Runtime Model and Validate Runtime result.

## Ownership By Layer

### Symbol Model

- Converts calibration and research output into a symbol-native runtime specification.
- Stores the promoted runtime model as the only approved runtime source.
- Owns:
  - runtime contract gates
  - cadence
  - entry, hold, TP1, TP2/runner, hard SL, protection, and lifecycle model values
  - engine formula override payloads

### Engine

- Reads the promoted symbol model.
- Must not read the "latest research profile" directly.
- Must not auto-tune itself from fresh calibration output.

### Coordinator

- Resolves engine candidates using the shared decision path.
- Must not create a second scoring or routing path outside the promoted model + engine outputs.

### Allocator

- Applies mode-specific permission, capital, exposure, drawdown, cascade, and portfolio logic.
- Must not re-score a service candidate that already came from a promoted service runtime.
- Must not source research output directly.

## Non-Negotiable Guardrails

- Future calibration runs are sticky suggestions only.
- No automatic runtime drift from newly completed research runs.
- No bypass path from AI output directly into live trading.
- Backtest and live must use the same promoted runtime model when parity testing is intended.

## Change Rule

Any runtime behavior change must update all of:

1. The promoted symbol model source
2. The affected engine logic
3. The parity/backtest path if externally visible
4. This document and the source-of-truth map if ownership changes
