# Research To Runtime Workflow

## Normal Service Workflow

Every symbol service should follow the same normal workflow:

1. Full Calibration
2. Review calibration runs
3. Generate or Stage Research Model
4. Run Integrated Elite Synthesis
5. Review Candidate Runtime Policy
6. Promote Candidate Runtime
7. Validate Current Runtime Backtest
8. Review Reports
9. Paper validation
10. Demo or Real escalation only after validation

CRASH300 is the current reference implementation for this workflow.

Manual tier testing, admission-policy toggles, optimiser passes, and parity debugging are not the intended workflow for future symbol services. Integrated Elite Synthesis owns the normal search over tiers, policies, triggers, buckets, entry timing, exits, and daily trade selection.

## Research Page Structure

The Research page is service-specific. Selecting a service opens that service's workspace:

- Calibration & Research
- Reports
- Runtime Model
- Backtests
- Advanced Diagnostics

## Calibration & Research

The normal workflow cards should appear in this order:

1. Full Calibration
2. Review calibration runs
3. Generate or Stage Research Model
4. Run Integrated Elite Synthesis
5. Promote Runtime or Candidate Runtime
6. Validate Current Runtime Backtest

This tab should not present parity, optimiser controls, or export-heavy diagnostics as if they are normal lifecycle steps.

## Reports

Reports are consolidated under the Reports tab. Heavy exports should not be scattered across runtime lifecycle cards or backtest action rows.

Current report families include:

- detected moves
- calibration profile
- pass results
- comparison summary
- parity report
- phase identifier summary, sample, and full
- backtest summary
- backtest trades
- backtest attribution
- calibration reconciliation
- policy comparison
- elite synthesis result exports
- elite synthesis selected-trades exports

## Candidate Runtime Lifecycle

The candidate runtime lifecycle is now:

1. run synthesis
2. fix or verify best-policy export consistency
3. stage best synthesis candidate as a paper-only artifact
4. validate the candidate runtime mimic against the synthesis result
5. if parity passes, run the candidate in paper
6. only after paper validation, consider explicit promote-to-runtime
7. live promotion remains separate and manual

Important:

- a synthesis best policy is not automatically live-ready
- paper-only candidate staging must not change the current promoted runtime
- runtime mimic must use live-safe rules, not calibrated move offsets or selected trade ids

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
- runtime archetypes: service-specific archetypes such as `crash_event_down`, `post_crash_recovery_up`, and `bear_trap_reversal_up`

Runtime feeddown or lifecycle state belongs here, not duplicated in the calibration workflow tab.

## Backtests

The normal Backtests tab should focus on:

- selected service
- research window or date range
- Run Backtest or Validate Current Runtime
- backtest history
- compact summary

Tier mode, tier sweep, and manual admission-policy presets are diagnostics only and should remain under collapsed advanced options instead of the primary validation flow.

## Advanced Diagnostics

Advanced diagnostics contain:

- parity
- runtime-trigger validation
- tier sweeps
- manual admission-policy diagnostics
- optimiser controls, disabled by default unless specifically needed
- phase identifier exports
- calibration reconciliation exports
- policy comparison exports
- internal or legacy diagnostic snapshots where still useful

Diagnostics must never be presented as the active trade-admission source.
