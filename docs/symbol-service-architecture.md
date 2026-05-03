# Symbol Service Architecture

## Purpose

Define a clean ownership split between shared platform infrastructure and symbol-specific trading services.

Canonical runtime wording:

`Symbol Service -> Trade Candidate -> Portfolio Allocator -> Trade Execution/Manager`

## Shared Platform Responsibilities

Shared platform owns:

- UI shells: Overview, Engine Decisions, Trades, Research, Data, Settings, Help
- Shared API contracts and route handlers
- Shared DB infrastructure and persistence adapters
- Shared Deriv connectivity and market data ingestion
- Shared logging and operational health/status
- Shared portfolio allocator/capital gatekeeper
- Shared orchestration flow adapters for live, backtest, and parity modes

Shared platform must not encode symbol-specific strategy beliefs.
It also must not present native-score or composite-score language as the active admission source.

## Symbol Service Responsibilities

Each symbol service owns:

- Symbol-specific model shape
- Runtime feeddown validation/compilation for that symbol
- Symbol-specific deterministic feature interpretation
- Runtime evaluation decision object
- TradeCandidate construction
- Position management policy application for that symbol
- Symbol parity/backtest adapters that use the same runtime evaluation flow
- Service-specific research, reports, and runtime-model presentation

Milestone 1 state:

- `CRASH300` service is scaffolded and marked enabled in solo registry mode.
- `BOOM300`, `R_75`, and `R_100` are scaffolded and disabled with explicit `service_not_enabled` errors.
- Existing runtime execution path is unchanged in Milestone 1.

## Service Registry Policy

Registry is the source of symbol-service availability.

- Solo mode default: only `CRASH300` enabled.
- Disabled services must fail loudly when invoked.
- No silent fallback to legacy paths inside symbol-service scaffold methods.

## Cutover Policy

Milestone 1 does not migrate active trading behavior.
Future milestones will cut over live/backtest/parity routing to shared runtime flow plus symbol services.
