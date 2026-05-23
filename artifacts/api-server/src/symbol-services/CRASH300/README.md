# CRASH300 Symbol Service

Status:

- Active service-runtime implementation.
- Build Runtime Model, Validate Runtime, Promote Runtime, Stream / Monitor are the operator workflow.
- Promoted runtime artifacts are the only source of candidate-emission rules.

Behavior policy:

- CRASH300 emits service candidates only when the promoted runtime contract matches the live-safe context and trigger.
- The allocator must not re-score CRASH300 candidates; it owns capital, exposure, drawdown, cascade, and mode gates.
- Reports should describe exits through the Trade Lifecycle Manager, not fixed trailing-stop language.
