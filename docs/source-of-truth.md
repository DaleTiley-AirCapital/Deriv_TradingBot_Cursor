# Source Of Truth Ownership

Use this map to avoid doc and implementation drift.

## Strategy And Trading Policy

- Canonical runtime policy snapshot:
  - `docs/current-operating-policy.md`
- Deep strategy doctrine:
  - `.agents/skills/deriv-trading-strategy/SKILL.md`
- Contextual project state summary:
  - `replit.md`

## Architecture Guardrails

- Internal architecture governance:
  - `.agents/skills/deriv-trading-repo-guardian/SKILL.md`
- Verification guardrails:
  - `artifacts/api-server/docs/guardrails.md`

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

## Change Ownership Rule

When changing behavior:

1. Update code owner file first.
2. Update relevant source-of-truth doc.
3. Update parity/runbook docs if externally visible behavior changed.
4. Do not leave conflicting threshold statements unresolved.
