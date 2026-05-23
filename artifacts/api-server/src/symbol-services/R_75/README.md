# R_75 Symbol Service

Status:

- Active volatility-series service-runtime implementation on codex-dev.
- Build Runtime Model evaluates the calibrated >=5 percent move universe across breakout, reversal, and continuation families.
- Promoted runtime artifacts can be narrower than the full build search when deterministic validation selects only specific engine/direction contracts.

Behavior policy:

- R_75 emits service candidates only when the promoted runtime contract matches the live-safe engine/direction pair.
- Contract blocks such as `runtime_r75_engine_direction_not_selected_by_build` are expected safety behavior when live conditions produce a family/direction not selected by the promoted build.
- The allocator must not re-score R_75 candidates; it owns capital, exposure, drawdown, cascade, and mode gates.
