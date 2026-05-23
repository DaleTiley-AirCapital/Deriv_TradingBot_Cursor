# Runtime Feeddown Contract

## Definition

Runtime feeddown compiles symbol-specific research, calibration, build, and validation artifacts into a staged or promoted runtime model consumed by that symbol service.

## Contract Requirements

Each symbol runtime feeddown implementation must:

1. Validate symbol identity.
2. Validate required runtime-model fields.
3. Validate family/bucket consistency for that symbol.
4. Return accepted and rejected artifacts with explicit reasons.
5. Fail loudly on missing/invalid required model fields.
6. Never silently fallback to unrelated symbol families.

## Lifecycle Semantics

- `Build Runtime Model` creates a review runtime candidate.
- `Validate Runtime` proves the staged/review candidate can behave live-safely.
- `Promote Runtime` activates the validated runtime model for service usage.
- Runtime behavior changes only on promote.

V3.2 note:

- `CRASH300` and `R_75` use promoted service runtime artifacts on codex-dev.
- `BOOM300` and `R_100` must follow the same service-level build, validation, and promotion workflow before candidate emission is enabled.

## Error Semantics

Use explicit typed error codes where possible:

- `runtime_model_missing`
- `runtime_model_invalid`
- `runtime_family_invalid`
- `runtime_bucket_inconsistent`
- `service_not_enabled`
- `service_not_implemented`

Errors must be operator-actionable and include symbol + failing contract section.
