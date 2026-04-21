# Current Operating Policy

This document is the canonical snapshot of the **current runtime operating policy**.
It separates live operating values from historical and calibration-analysis values.

## Product Intent

- High-conviction swing trading, not scalping.
- TP-first trade management targeting large moves.
- Live path uses V3 symbol-native engines only.
- Active symbols only: `CRASH300`, `BOOM300`, `R_75`, `R_100`.

## Current Live Operating Gates

These are the current operating gates documented in current-state runtime docs:

- Paper: `>= 60`
- Demo: `>= 65`
- Real: `>= 70`
- Signal visibility threshold: `50`

Reference: `replit.md` and V3 runtime notes.

## Historical / Analysis Threshold Context

Several documents contain historical or analysis-era threshold values that are not the current live operating gates:

- `80/85/90` (older strategy policy section)
- `85/90/92` (calibration report floor policy statements)

These must be interpreted as historical policy or calibration discussion unless explicitly re-adopted in runtime configuration.

## Live Architecture Guardrail

Live signal flow is V3-native:

- `engineRouterV3.ts` -> `symbolCoordinator.ts` -> `portfolioAllocatorV3.ts`
- backtest-only modules (`strategies.ts`, `signalRouter.ts`, `scoring.ts`) must not be reintroduced into the live path

## Runtime Model Promotion Guardrail

- Calibration and AI analysis produce suggestions, not automatic runtime changes.
- Live and paper runtime calibration behavior must be sourced from explicitly promoted symbol models only.
- The latest research profile must never be treated as the active runtime model by default.
- Promotion is the only path that may change runtime behavior for paper, demo, or real trading.

## Non-Negotiable Behavior Constraints

- No time-based forced exits.
- TP is primary exit; trailing is safety net.
- No shared generic scoring fallback for live.
- No fallback logic preserving superseded behavior.

## Related Docs

- `README.md`
- `docs/source-of-truth.md`
- `docs/api-parity-checklist.md`
- `docs/operator-runbook.md`
- `docs/docs-guardrails.md`
