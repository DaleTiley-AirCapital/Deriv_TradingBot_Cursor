# CRASH300 Service README

## Status

CRASH300 is the active symbol-service implementation and the template for future services.

The active runtime path is:

`context + fresh 1m trigger + promoted runtime model -> TradeCandidate`

## Responsibilities

CRASH300 owns:

- feature/context snapshots
- trigger semantics
- family/archetype derivation
- bucket derivation
- candidate emission
- admission policy preview/enforcement for backtests
- parity, trigger validation, and calibration reconciliation reports

## Runtime Model Presentation

UI labels should distinguish:

- calibrated move family: `crash_expansion`
- calibrated move-size buckets: sorted numerically
- runtime entry archetypes: `crash_event_down`, `post_crash_recovery_up`, `bear_trap_reversal_up`, `failed_recovery_short`, `bull_trap_reversal_down`

## Reports

CRASH300 currently supports:

- parity report
- runtime-trigger validation
- phase identifier summary/sample/full
- backtest attribution
- calibration reconciliation
- policy comparison

These exports belong in the service Reports tab, not scattered across multiple action cards.

## Guardrails

- no native-score fallback
- no rolling-window-only admission
- no missing-bucket or missing-exit-policy fallback
- fail loudly if promoted runtime model data is missing

## Next Stage

Before integrated elite synthesis, the repo should continue consolidating:

- service-specific runtime model presentation
- service-specific decisions/trades filtering
- remaining stale score-era backend settings and fallback seams outside CRASH300
