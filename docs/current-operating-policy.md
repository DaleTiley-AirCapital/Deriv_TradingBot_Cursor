# Current Operating Policy

This document is the canonical V3.2 snapshot of the current runtime operating policy.
It separates live operating values from historical and calibration-analysis values.

## Product Intent

- High-conviction swing trading, not scalping.
- TP-first trade management targeting large moves.
- Live path uses symbol-service runtime ownership.
- Current promoted/scanning services: `CRASH300` and `R_75`.
- Registered active-service roadmap: `CRASH300`, `BOOM300`, `R_75`, `R_100`.

## Current Global Operating Controls

Shared/global controls should be expressed as:

- kill switch
- paper/demo/real mode
- use promoted runtime profiles
- capital settings
- max total portfolio exposure
- max per-symbol exposure
- max per-trade exposure
- max open positions
- max drawdown protection

Global settings should not be used to present symbol-specific score thresholds or native-score admission rules.

## Symbol-Service Runtime Policy

- symbol services own feature snapshots, trigger/archetype detection, bucket derivation, candidate emission, and trade-management policies
- promoted runtime artifacts are the only source of paper/demo/real candidate rules
- the allocator owns only capital, exposure, drawdown, cascade timing, mode gates, and portfolio risk gates
- frontend surfaces selected service state and must not calculate trade admission logic
- no native-score or composite-score wording should be treated as current decision logic

## Architecture Transition Snapshot

- `artifacts/api-server/src/symbol-services/*` is the service boundary for symbol-owned contracts
- `CRASH300` and `R_75` have promoted service runtime artifacts on codex-dev
- `BOOM300` and `R_100` remain registered service roadmap items until their runtime models are built, validated, and promoted
- rolling-window/watch diagnostics are not the active admission source
- `live-safe context + trigger/archetype match + promoted runtime model` is the current admission pattern

## Runtime Model Promotion Guardrail

- Calibration and research produce suggestions, not automatic runtime changes.
- Live and paper runtime calibration behavior must be sourced from explicitly promoted symbol models only.
- The latest research profile must never be treated as the active runtime model by default.
- Promotion is the only path that may change runtime behavior for paper, demo, or real trading.

## Non-Negotiable Behavior Constraints

- No time-based panic exits.
- TP1/TP2/runner and protection floors are managed by the Trade Lifecycle Manager.
- Historical low-level trailing fields may still exist for compatibility, but user-facing reports should describe protection activation, protected exits, and lifecycle exhaustion.
- No shared generic scoring fallback for live.
- No fallback logic preserving superseded behavior.
- No silent fallback for missing promoted runtime models, missing buckets, or missing exit-policy data.

## Related Docs

- `README.md`
- `docs/source-of-truth.md`
- `docs/symbol-service-architecture.md`
- `docs/RESEARCH_TO_RUNTIME_WORKFLOW.md`
- `docs/SERVICE_UI_STRUCTURE.md`
- `docs/CRASH300_SERVICE_README.md`
- `docs/runtime-feeddown-contract.md`
- `docs/api-parity-checklist.md`
- `docs/operator-runbook.md`
- `docs/docs-guardrails.md`
