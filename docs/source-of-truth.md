# Source Of Truth Ownership

Use this map to avoid doc and implementation drift.

## Strategy And Trading Policy

- Canonical runtime policy snapshot:
  - `docs/current-operating-policy.md`
- Runtime model lifecycle and promotion policy:
  - `docs/runtime-model-lifecycle.md`
- Symbol-service architecture and ownership boundaries:
  - `docs/symbol-service-architecture.md`
  - `docs/SYMBOL_SERVICE_ARCHITECTURE.md`
- Service UI structure and selected-service research workflow:
  - `docs/RESEARCH_TO_RUNTIME_WORKFLOW.md`
  - `docs/V3_1_RESEARCH_WORKFLOW_AUDIT.md`
  - `docs/SERVICE_UI_STRUCTURE.md`
- CRASH300 service-specific implementation notes:
  - `docs/CRASH300_SERVICE_README.md`
- Runtime feeddown contract and validation:
  - `docs/runtime-feeddown-contract.md`
- Deep strategy doctrine:
  - `.agents/skills/deriv-trading-strategy/SKILL.md`
- Contextual project state summary:
  - `replit.md`

## Architecture Guardrails

- Internal architecture governance:
  - `.agents/skills/deriv-trading-repo-guardian/SKILL.md`
- Verification guardrails:
  - `artifacts/api-server/docs/guardrails.md`
- Codex implementation guardrails for this repo:
  - `docs/codex-agent-instructions.md`

## API Contract

- Public contract:
  - `lib/api-spec/openapi.yaml`
- Parity status:
  - `docs/api-parity-checklist.md`
- Implemented route source:
  - `artifacts/api-server/src/routes/*.ts`

## Deployment And Operations

- Local operational runbook:
  - `docs/operator-runbook.md`
- Docker build/runtime definition:
  - `Dockerfile`

## Calibration Reports

- Current calibration docs:
  - `artifacts/api-server/calibration-report.md`
  - `artifacts/api-server/calibration-reports/calibration-report.md`
- These may include historical or scenario-specific threshold narratives; cross-check against `docs/current-operating-policy.md` for current runtime values.

## Runtime Model Ownership

- Suggested research outputs:
  - `symbol_research_profiles`
- Staged runtime owner:
  - `platform_state` staged symbol model entries and `staged_synthesis_candidate_<SERVICE>` references
- Promoted runtime owner for trading behavior:
  - `platform_state` `promoted_service_runtime_<SERVICE>` entries
- Rule:
  - latest research output is not allowed to change runtime behavior until explicitly validated and promoted through the service-level workflow

## Change Ownership Rule

When changing behavior:

1. Update code owner file first.
2. Update relevant source-of-truth doc.
3. Update service workflow/UI docs if the selected-service research flow changes.
4. Update parity/runbook docs if externally visible behavior changed.
5. Do not leave conflicting threshold statements unresolved.

## Milestone 1 Note

Milestone 1 introduces symbol-service scaffolding and contracts only.
No scheduler, allocator, trade, or live/backtest behavior cutover is performed in this milestone.
