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
    Calibration & Research
    Reports
    Runtime Model
    Backtests
    Advanced Diagnostics
```

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

## Decisions View

Engine Decisions should show:

- candidate produced or rejected
- rejection reason
- trigger/archetype
- calibrated family and bucket
- TP / SL / trailing policy
- allocator result
- model source and version

## Trades View

Trades should show:

- selected service or all services
- service decision fields
- allocator/capital fields separately
- no stale native-score admission language
