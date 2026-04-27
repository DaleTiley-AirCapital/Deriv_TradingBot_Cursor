# R_75 Symbol Service (Milestone 1 Scaffold)

Status:

- Service contract scaffold exists.
- Runtime logic is not migrated in Milestone 1.
- Fail-loud behavior is intentional for non-implemented operations.

Behavior policy in Milestone 1:

- CRASH300 is enabled in solo-mode registry but not yet cut over into active runtime path.
- BOOM300, R_75, and R_100 are scaffolded as disabled services with explicit service_not_enabled errors.