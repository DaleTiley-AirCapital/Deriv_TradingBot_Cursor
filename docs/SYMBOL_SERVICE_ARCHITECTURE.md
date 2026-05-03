# Symbol Service Architecture

## Purpose

The platform is split into a shared system layer and independent symbol services.

Canonical flow:

`Symbol Service -> Trade Candidate -> Portfolio Allocator -> Trade Execution/Manager`

CRASH300 is the active reference implementation. BOOM300, R_75, and R_100 are scaffolded into the same shape and must follow the same lifecycle.

## Shared System

The shared system owns:

- overview and global status
- data streaming and database state
- shared Deriv connectivity
- portfolio allocator
- capital and exposure limits
- max open positions and drawdown protection
- shared API contracts
- shared UI components

The allocator does **not** calculate symbol-specific entries, exits, TP, SL, trailing, or trigger semantics.

## Symbol Service

Each symbol service owns:

- calibration model
- runtime model
- feature snapshot generation
- context and trigger/archetype detection
- bucket selection
- candidate factory
- admission policy
- trade-management policy
- research, backtest, parity, and service reports

Each service emits a complete `TradeCandidate`. The allocator either approves capital or rejects the candidate for portfolio-level reasons.

## Canonical Service Shape

```text
service/
  index.ts
  model.ts
  features.ts
  context.ts
  trigger.ts
  archetypes.ts
  buckets.ts
  candidateFactory.ts
  admissionPolicy.ts
  tradeManagement.ts
  calibration.ts
  backtestAdapter.ts
  reports.ts
  README.md
```

Code does not need to be fully moved into that shape in one pass, but new work should converge toward it.

## Runtime Rules

- live, backtest, and parity must use the same symbol-service runtime evaluation path
- no silent fallbacks for missing promoted runtime models, missing buckets, or missing exit policies
- rolling windows/context diagnostics must not create trades by themselves
- a valid runtime trigger is required for candidate emission

## Current Service State

- `CRASH300`: active implementation, runtime-model driven
- `BOOM300`: scaffolded service
- `R_75`: scaffolded service
- `R_100`: scaffolded service

Unsupported symbols should be displayed as unavailable or scaffoldable, not mixed with active services.

## Research and Synthesis Ownership

Each symbol service also owns its research-to-runtime preparation flow:

1. calibration outputs
2. staged research model
3. integrated elite synthesis search
4. candidate runtime policy artifact
5. promoted runtime model
6. service-specific backtest, parity, and reconciliation reports

Integrated Elite Synthesis is the normal search engine for future services. It consumes service-owned research data, evaluates complete runtime-policy candidates, and returns a candidate runtime artifact. It does not auto-promote and it does not alter live runtime behavior by itself.

## Reusable Service Synthesis Shape

Symbol services that support integrated synthesis should provide an adapter with capabilities equivalent to:

- load calibration runs
- load calibrated moves
- load runtime model
- load backtest runs
- load backtest trades
- load phase snapshots
- load calibration reconciliation
- build live-safe feature vectors
- derive move-size buckets
- derive runtime archetypes
- generate trigger candidates from move offsets
- evaluate policy candidates on historical data
- derive exit-policy candidates from elite subsets
- validate no future leakage
