# Symbol Service Architecture

## Purpose

Define the V3.2 ownership split between shared platform infrastructure and symbol-specific trading services.

Canonical runtime wording:

`Symbol Service -> Trade Candidate -> Portfolio Allocator -> Trade Execution/Manager`

## Shared Platform Responsibilities

Shared platform owns:

- UI shells: Overview, Allocator Decisions, Trades, Research, Data, Settings, Help
- shared API infrastructure and route registration
- shared DB infrastructure and persistence adapters
- shared Deriv connectivity and market data ingestion
- shared logging and operational health/status
- worker queue execution for heavy research jobs
- portfolio allocator/capital gatekeeper

Shared platform must not encode symbol-specific strategy beliefs.
It must not present native-score, composite-score, or generic confidence-threshold language as the active admission source for promoted service-runtime candidates.

## Symbol Service Responsibilities

Each symbol service owns:

- symbol-specific model shape
- runtime feeddown validation/compilation for that symbol
- symbol-specific deterministic feature interpretation
- runtime evaluation decision object
- trade candidate construction
- runtime contract/admission policy
- Trade Lifecycle Manager policy
- service-specific research, Build Runtime Model, validation, reports, and runtime-model presentation

## Current Service State

- `CRASH300`: active implementation, runtime-model driven, promoted on codex-dev
- `R_75`: active volatility-series implementation, runtime-model driven, promoted on codex-dev
- `BOOM300`: registered service awaiting its own runtime build/validation/promotion
- `R_100`: registered service awaiting its own runtime build/validation/promotion

Unsupported services must be displayed as unavailable or requiring setup, not silently routed through another service.

## Runtime Rules

- live, validation, replay, and parity must use the same promoted service-runtime contract when intended to mirror runtime
- no silent fallbacks for missing promoted runtime models, missing buckets, or missing exit policies
- rolling windows/context diagnostics must not create trades by themselves
- a valid runtime trigger/archetype match is required for candidate emission
- allocator approval is portfolio-level only: capital, exposure, drawdown, cascade timing, and mode gates

## Research and Runtime Ownership

Each symbol service follows:

1. Data Coverage
2. Full Calibration
3. Build Runtime Model
4. Validate Runtime
5. Promote Runtime
6. Stream / Monitor

Build Runtime Model consumes service-owned research data, evaluates complete runtime candidates, and returns a review runtime artifact. It does not auto-promote and it does not alter live runtime behavior by itself.

Candidate runtime promotion is service-level and manual:

1. Build Runtime Model returns a review runtime artifact
2. Validate Runtime must pass
3. Promote Runtime activates `promoted_service_runtime_<SERVICE>`
4. the existing promoted runtime remains unchanged until explicit manual promotion

Runtime mimic rules:

- must use live-safe rules only
- must not use calibrated move ids, selected trade ids, move-start timestamps, or move-end timestamps as live rules
- must not use realised pnl, future MFE/MAE, or exit reason as live inputs
