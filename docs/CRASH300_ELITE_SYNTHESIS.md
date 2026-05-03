# CRASH300 Integrated Elite Synthesis

## Scope

CRASH300 is the first full service used to stand up Integrated Elite Synthesis.

This pass does not change live runtime behavior. It adds the async synthesis foundation, the CRASH300 adapter, unified dataset construction, pass logging, and result exports needed to search for a future candidate runtime policy artifact.

## CRASH300 Data Sources

The CRASH300 synthesis adapter consumes existing stored research data only:

- calibration pass runs
- detected moves
- promoted runtime model
- persisted V3 backtest runs
- persisted backtest trades
- phase identifier reports
- calibration reconciliation
- 1m candles for live-safe control samples

No calibration rerun is required.

## Unified Dataset Shape

CRASH300 synthesis builds:

### Calibrated moves

- move id
- start and end timestamps
- direction
- move percent
- quality tier
- calibrated base family `crash_expansion`
- calibrated move-size bucket
- phase-derived family and bucket where available
- trigger offset snapshots where available
- live-safe feature vector built from the entry-candle slice

### Runtime trades

- trade id
- entry and exit timestamps
- direction
- runtime family
- selected bucket
- trigger transition
- setup match
- confidence
- trigger strength
- quality tier
- context and trigger age
- projected move
- exit settings
- pnl, mfe, mae
- exit reason
- matched move relation
- phantom or noise label

### Non-move controls

- live-safe feature vectors sampled away from calibrated moves
- `non_move_control` label

## CRASH300 Live-Safe Runtime Inputs

The adapter uses the existing CRASH300 runtime seams:

- `buildCrash300ContextSnapshot`
- `buildCrash300TriggerSnapshot`
- `detectCrash300TriggerTransition`
- `deriveCrash300RuntimeFamilyWithSemantics`
- `deriveCrash300RuntimeBucket`

This keeps the synthesis inputs aligned with the current service runtime semantics instead of inventing a parallel trigger language.

## Search Flow

The CRASH300 synthesis engine currently follows this deterministic flow:

1. Load the selected or latest research inputs.
2. Build the unified synthesis dataset.
3. Evaluate current runtime-policy seeds grouped from persisted trades.
4. If the current pool is insufficient, rebuild trigger-policy seeds from calibrated move offsets.
5. Compute live-safe feature separability summaries.
6. Evaluate complete policy candidates across passes.
7. Derive candidate exit-policy settings from elite trade subsets.
8. Persist pass logs, best-so-far summaries, and final result artifacts.

The engine must not stop early just because the current runtime candidate pool is weak. Rebuilt trigger candidates are mandatory before returning an exhausted-search verdict.

## Current Foundation Limits

This pass establishes the foundation. It is intentionally not the final elite search quality bar yet.

Known current limits:

- policy generation is still smoke-profile oriented
- entry-timing optimisation is represented in the artifact contract but not yet deeply searched per archetype
- exit optimisation currently derives percentile-based candidate rules from trade subsets rather than full exhaustive CRASH300-specific search tables
- top-policy ranking and bottleneck summaries are implemented, but future passes can deepen monthly stability and drawdown analysis further

## Result Artifact Expectations

CRASH300 synthesis returns:

- best policy summary
- top 20 policy summaries
- best policy artifact
- compact pass log summary
- full pass log export
- leakage audit
- bottleneck or exhaustion summary
- trigger rebuild summary
- dataset summary

If the target objective is not achieved, the result still returns the best candidate found, whether trigger rebuild was attempted, and the bottleneck classification rather than silently pretending a weak policy is acceptable.

## Operator Workflow

Recommended CRASH300 workflow:

1. Full Calibration
2. Stage or Generate Research Model
3. Run Integrated Elite Synthesis
4. Review best candidate policy, top 20, pass log, and leakage audit
5. Promote a runtime candidate only in a later explicit task
6. Run validation backtests
7. Review reconciliation and policy comparison reports
8. Paper validate before any further escalation
