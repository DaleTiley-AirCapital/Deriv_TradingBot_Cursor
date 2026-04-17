# Documentation Guardrails

These guardrails keep docs aligned with runtime behavior.

## Rules

- Every runtime policy change must update:
  - `docs/current-operating-policy.md`
  - `replit.md` (if user-facing behavior summary changes)
- Every route addition/removal must update:
  - `lib/api-spec/openapi.yaml`
  - `docs/api-parity-checklist.md`
- Threshold changes must be reflected in one canonical current-state section and historical values must be labeled as historical.
- Runbook-impacting changes (ports, env vars, startup flow) must update `docs/operator-runbook.md`.

## Suggested PR Checklist

- [ ] Runtime behavior change documented in `docs/current-operating-policy.md`
- [ ] API route changes reflected in `openapi.yaml` and parity checklist
- [ ] No conflicting threshold statements introduced
- [ ] Local run instructions still valid
- [ ] Source ownership map still accurate

## Suggested CI Follow-Up

Implement a docs parity check script that:

1. Parses `artifacts/api-server/src/routes/*.ts` for route strings.
2. Parses `lib/api-spec/openapi.yaml` path entries.
3. Produces:
   - missing-in-spec list
   - missing-in-code list
4. Fails CI when mismatch count exceeds allowed baseline.
