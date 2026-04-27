# Runtime Feeddown Contract

## Definition

Runtime feeddown compiles symbol-specific research/calibration/parity artifacts into a staged or promoted runtime model consumed by that symbol service.

## Contract Requirements

Each symbol runtime feeddown implementation must:

1. Validate symbol identity.
2. Validate required runtime-model fields.
3. Validate family/bucket consistency for that symbol.
4. Return accepted and rejected artifacts with explicit reasons.
5. Fail loudly on missing/invalid required model fields.
6. Never silently fallback to unrelated symbol families.

## Lifecycle Semantics

- `Stage` compiles and stores staged runtime model.
- `Promote` activates a staged runtime model for runtime usage.
- Runtime behavior changes only on promote.

Milestone 1 note:

- This document defines required behavior.
- Milestone 1 only scaffolds contracts and service modules.
- Lifecycle behavior cutover and stricter endpoint semantics are future milestones.

## Error Semantics

Use explicit typed error codes where possible:

- `runtime_model_missing`
- `runtime_model_invalid`
- `runtime_family_invalid`
- `runtime_bucket_inconsistent`
- `service_not_enabled`
- `service_not_implemented`

Errors must be operator-actionable and include symbol + failing contract section.