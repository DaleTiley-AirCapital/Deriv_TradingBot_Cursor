# Service UI Structure

## Global vs Service Views

The UI should separate:

### Global / System

- Overview
- Data streaming and coverage
- shared settings
- allocator and portfolio exposure

### Symbol Service

- service research workflow
- runtime model state
- engine decisions
- service trades
- backtests
- reports
- diagnostics

## Canonical Research Layout

```text
Research
  Service selector
  Service status summary
  Tabs
    Data & Coverage
    Calibration
    Build Runtime Model
    Runtime Model
    Reports
```

## Workflow Intent

Normal workflow:

1. Data Coverage
2. Full Calibration
3. Build Runtime Model
4. Validate Runtime
5. Promote Runtime
6. Stream / Monitor

Advanced diagnostics:

- parity
- runtime-trigger validation
- tier sweeps
- manual admission-policy testing
- optimiser
- phase identifier exports
- calibration reconciliation
- policy comparison

Manual tier and admission-policy experimentation must not be presented as the intended workflow for future services. Build Runtime Model owns the normal search path.

## Language Rules

Do not present these as active decision concepts:

- native score
- composite score
- V3 native scoring
- score thresholds as current runtime admission logic

Preferred wording:

- symbol service runtime evidence
- trigger/archetype detection
- trade candidate
- portfolio allocator
- capital / exposure / risk gates
- Build Runtime Model
- candidate runtime artifact
- validated service runtime

## Reports Placement

Reports and heavy exports belong under the Reports tab. Other tabs may link to Reports, but should not duplicate export hubs.

## Validation Reports Placement

The normal Validation Reports tab should show:

- selected service
- window or range
- validate current runtime
- backtest history
- compact summary

Advanced backtest options should stay collapsed by default and hold tier mode, tier sweeps, and manual admission-policy controls.

## Decisions View

Engine Decisions should show:

- candidate produced or rejected
- rejection reason
- trigger/archetype
- calibrated family and bucket
- TP / SL / protection / lifecycle policy
- allocator result
- model source and version

## Trades View

Trades should show:

- selected service or all services
- service decision fields
- allocator/capital fields separately
- no stale native-score or confidence-threshold admission language for service-runtime candidates
