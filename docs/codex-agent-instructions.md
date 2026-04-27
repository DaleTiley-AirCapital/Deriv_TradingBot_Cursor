# Codex Agent Instructions (Repo-Specific)

## Milestone 1 Baseline

This repository is in a staged architecture reset.
Milestone 1 is scaffolding only.

Do:

- Add contracts, docs, and symbol-service scaffolding.
- Keep old runtime path behavior unchanged.
- Preserve scheduler/allocator/trade behavior.
- Fail loudly in scaffold service stubs where behavior is intentionally unavailable.

Do not:

- Migrate strategy logic in Milestone 1.
- Delete active runtime code in Milestone 1.
- Change live/backtest route behavior in Milestone 1.
- Introduce silent fallbacks.

## Ownership Rule

- Shared platform owns orchestration/infrastructure.
- Symbol services own symbol strategy/model behavior.
- UI displays backend state only.
- Allocator allocates capital only.

## Safety Rule

If a requested change can alter live trading behavior, require explicit milestone approval before applying.