# Research To Runtime Workflow

## Service Workflow

Every symbol service should follow the same ordered workflow:

1. Full Calibration
2. Review calibration runs
3. Stage Research Model
4. Promote Runtime
5. Run Parity / runtime-trigger validation
6. Run Backtest
7. Review Reports
8. Run Paper

CRASH300 is the current production template for this workflow.

## Research Page Structure

The Research page is service-specific. Selecting a service opens that service's workspace:

- Calibration & Research
- Reports
- Runtime Model
- Backtests
- Advanced Diagnostics

## Reports

Reports are consolidated under the Reports tab. Heavy exports should not be scattered across runtime feeddown or backtest action rows.

Report types currently include:

- detected moves
- calibration profile
- pass results
- comparison summary
- parity report
- phase identifier summary/sample/full
- backtest summary
- backtest trades
- backtest attribution
- calibration reconciliation
- policy comparison

## Runtime Model

The runtime model view should clearly distinguish:

- calibrated move family
- calibrated move-size buckets
- runtime entry archetypes
- staged runtime
- promoted runtime
- model validation errors

For CRASH300:

- calibrated family: `crash_expansion`
- runtime archetypes: service-specific archetypes such as `crash_event_down`, `post_crash_recovery_up`, `bear_trap_reversal_up`

## Advanced Diagnostics

Advanced diagnostics contain:

- parity
- runtime-trigger validation
- deep/internal exports
- optimiser controls, disabled by default unless specifically needed

Diagnostics must never be presented as the active trade-admission source.
