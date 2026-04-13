---
name: deriv-trading-repo-guardian
description: Governs how the agent analyzes, cleans, refactors, and extends this repo. Use when doing any structural, architectural, refactor, audit, cleanup, or UI/backend wiring work on the Deriv trading system.
---

# Deriv Trading Repo Guardian

A governing repo skill that forces future agent work on this project to follow a strict architecture, deletion policy, consolidation policy, and UI/backend parity workflow.

---

## Target Architecture

```
core/           — market models, indicators/features/regimes, strategies, signal pipeline,
                  entry logic, exit logic, TP/SL/trailing, risk logic,
                  portfolio/trade state logic, settings schemas

runtimes/       — research runner, backtest runner, paper runner, demo runner, live runner

infrastructure/ — db/storage, data adapters, broker adapters, logging, stream/scheduler plumbing

ui/             — research, live, settings

app/            — routing, app wiring, dependency composition
```

---

## V3 Live Architecture (current — as of Task #102)

**The live path runs exclusively on V3 native-engine scoring. There is no V2 shared scoring path in the live system.**
`strategies.ts` / `signalRouter.ts` / `scoring.ts` are BACKTEST-ONLY — not called in live scan.

### 8 Symbol-Native Engines
| Symbol  | Engine(s) |
|---------|-----------|
| BOOM300 | `boom_expansion_engine` |
| CRASH300| `crash_expansion_engine` |
| R_75    | `r75_continuation_engine`, `r75_reversal_engine`, `r75_breakout_engine` |
| R_100   | `r100_continuation_engine`, `r100_reversal_engine`, `r100_breakout_engine` |

### V3 Core Files (all in `src/core/`)
| File | Responsibility |
|------|---------------|
| `engineTypes.ts` | `EngineResult`, `EngineContext`, `CoordinatorOutput` types |
| `engines/boom300Engine.ts` | boom_expansion_engine |
| `engines/crash300Engine.ts` | crash_expansion_engine |
| `engines/r75Engines.ts` | r75_continuation, r75_reversal, r75_breakout |
| `engines/r100Engines.ts` | r100_continuation, r100_reversal, r100_breakout |
| `engineRegistry.ts` | Symbol → engine(s) mapping; loud failure on misconfiguration |
| `symbolCoordinator.ts` | Per-symbol conflict resolution; sets `resolvedDirection` + `coordinatorConfidence` |
| `engineRouterV3.ts` | Live scan entry: `scanSymbolV3()` → `V3ScanResult` (includes features) |
| `portfolioAllocatorV3.ts` | Engine-aware risk allocation; `allocateV3Signal()` |
| `hybridTradeManager.ts` | Stage 1→2 SL promotion at 20% TP; `promoteBreakevenSls()` |

### V3 Scheduler Live Path
```
scheduleStaggeredScan → scanSingleSymbolV3(symbol, stateMap)
  → scanSymbolV3(symbol)           # engineRouterV3
  → allocateV3Signal(coordinator)  # portfolioAllocatorV3
  → [verifySignal()]               # openai.ts (optional AI verify)
  → openPositionV3(...)            # tradeEngine.ts
```

### V3 Position Management
```
positionManagementCycle:
  1. promoteBreakevenSls()   # hybridTradeManager — stage 1→2 SL promotion
  2. manageOpenPositions()   # tradeEngine — stage 3 trailing + closes
```

### DB Notes
- No schema changes for V3. `strategyName` field stores engine name. `notes` field has `"V3 HybridStaged | ..."` prefix.
- `signalLogTable.strategyFamily` = `"v3_engine"` for V3 signals.

---

## Architecture Rules

- Code is organized by responsibility, not by UI tab or screen
- Research, backtest, paper, demo, and live all share the same core trading logic (strategy logic, signal scanning, entry logic, exit logic, TP/SL/trailing, risk logic, symbol-specific thresholds)
- Backtests must replay the same trading logic used in live trading — no separate trading-decision implementation for backtests
- Runtimes are thin wrappers only — differences allowed only for: data source, scheduling, execution adapter, simulation details
- Risk logic belongs in core; risk configuration belongs in settings UI
- **Backtest simulation files (strategies.ts, signalRouter.ts, scoring.ts)**: BACKTEST-ONLY — do not add them to live path
- **V3 engines (live)**: all live signal decisions flow through `engineRouterV3.ts` → `symbolCoordinator.ts` → `portfolioAllocatorV3.ts`

---

## Strict Working Policy

- One concern = one owner file/module
- No duplicate strategy logic, risk logic, TP/SL logic, scanner logic, or threshold definitions
- No duplicate constants across files
- No `v2`, `new`, `backup`, `temp`, `old`, `final`, or alternate implementation files
- No silent fallback paths in trading logic
- No preserving replaced implementations — when behavior changes, the old path is removed
- Any new logic must declare: source-of-truth file, direct callers, deleted/replaced files
- UI items must map to real endpoints or real local functions — if a UI item has no working backend path, remove it; if backend exists and is intended to be user-facing, wire the UI

### Non-Negotiable Clause

> Never preserve old behavior through fallback logic. When behavior is intentionally changed, remove the previous path completely and update all callers to the new path.

---

## Deletion Policy

- Delete replaced code — do not comment it out
- Do not preserve legacy code without explicit written justification
- Remove backup/temp/alternate implementation files
- Remove fallback branches and alternate paths

---

## Mandatory 6-Phase Workflow

**Phase 1 — Audit**: Enumerate all files; identify what each does, whether it is imported/used, what imports it; identify duplicates, mixed-responsibility files, dead/legacy/fallback code; identify UI routes/components; identify backend endpoints/functions; produce UI-to-endpoint mapping.

**Phase 2 — Delete**: Delete unused, obsolete, duplicate, superseded, backup-like, temp-like, and legacy files; remove commented-out dead code; remove fallback branches and alternate paths.

**Phase 3 — Consolidate**: Move trading decision logic into shared core; ensure all runtimes call the same core engine; remove separate research/live decision paths.

**Phase 4 — Runtime cleanup**: Make runtimes thin wrappers only; allow differences only for data source, scheduling, execution adapter, or simulation details.

**Phase 5 — UI/backend parity**: Inspect every UI item; verify each visible user action is wired to a real backend endpoint or function; if backend exists but UI is not wired, add the wiring; if UI exists without real support, remove it; backend-only completion is not acceptable.

**Phase 6 — Validation**: Report deleted files, consolidated files, moved files, canonical source-of-truth files, UI items removed, UI items newly wired, endpoint changes, any remaining technical debt explicitly.

---

## Output Templates

All 6 templates are required. Fill in each section after completing the corresponding phase.

---

### Template 1 — Repo Audit Summary

```markdown
## Repo Audit Summary

### File Inventory
| File | Responsibility | Imported By | Status |
|------|---------------|-------------|--------|
| [path] | [what it does] | [callers] | [active/dead/duplicate/mixed] |

### Duplicate/Overlap Groups
- [Group 1]: [list of files with overlapping responsibility]
- [Group 2]: ...

### Mixed-Responsibility Files
- [file]: [responsibilities found, which should be separated]

### Dead/Legacy/Fallback Code
- [file]: [description of dead or fallback code]

### UI Routes/Components Identified
- [route/component]: [purpose]

### Backend Endpoints/Functions Identified
- [endpoint/function]: [purpose]

### UI-to-Endpoint Mapping (preliminary)
| UI Item | Expected Backend | Wired? | Notes |
|---------|-----------------|--------|-------|
| [component/action] | [endpoint/function] | [yes/no/partial] | |
```

---

### Template 2 — Dead/Duplicate File Report

```markdown
## Dead/Duplicate File Report

### Confirmed Dead Files (zero imports, zero callers)
- [file path] — reason: [why it is dead]

### Confirmed Duplicate Logic
- [file A] duplicates [file B]: [description of duplicated concern]

### Backup/Temp/Alternate Implementation Files
- [file path] — matches pattern: [v2/new/backup/temp/old/final/etc.]

### Fallback Branches Identified
- [file:line] — fallback description: [what it falls back to and why it must be removed]

### Commented-Out Dead Code
- [file:line range] — description: [what the commented code was]
```

---

### Template 3 — Deletion Plan

```markdown
## Deletion Plan

### Files to Delete
| File | Reason | Safe to Delete? | Replacement (if any) |
|------|--------|----------------|----------------------|
| [path] | [duplicate/dead/backup/etc.] | [yes/confirm] | [path or "none"] |

### Fallback Branches to Remove
| File | Line(s) | Description |
|------|---------|-------------|
| [path] | [line range] | [what the branch does] |

### Commented-Out Code to Remove
| File | Line(s) | Description |
|------|---------|-------------|
| [path] | [line range] | [what it was] |

### Callers to Update After Deletion
| Deleted File/Export | Callers Affected | Update Required |
|--------------------|-----------------|-----------------|
| [file/export] | [list of callers] | [what to change] |
```

---

### Template 4 — Refactor Plan

```markdown
## Refactor Plan

### Source-of-Truth Declarations
| Concern | Canonical File | Previous Locations (to be deleted) |
|---------|---------------|-------------------------------------|
| [concern] | [path] | [old paths] |

### Consolidation Moves
| Logic Being Moved | From | To | Direct Callers After Move |
|------------------|------|----|--------------------------|
| [description] | [source path] | [target path] | [list of callers] |

### Runtime Wrapper Cleanup
| Runtime | Current Extra Logic | Should Be in Core | Action |
|---------|-------------------|-------------------|--------|
| [runner] | [description] | [yes/no] | [move/remove] |

### New Files to Create (if any)
| File | Responsibility | Replaces |
|------|---------------|---------|
| [path] | [description] | [old files] |
```

---

### Template 5 — UI-to-Endpoint Mismatch Report

```markdown
## UI-to-Endpoint Mismatch Report

### UI Items with No Backend (Remove These)
| UI Component/Action | Expected Backend | Disposition |
|--------------------|-----------------|-------------|
| [component] | [none found] | Remove UI item |

### Backend Endpoints with No UI Wiring (Wire These)
| Endpoint/Function | Purpose | UI Location to Wire |
|------------------|---------|---------------------|
| [endpoint] | [description] | [where to add UI wiring] |

### Partially Wired Items (Fix These)
| UI Item | Backend | Issue | Fix Required |
|---------|---------|-------|--------------|
| [component] | [endpoint] | [description of gap] | [action] |

### Confirmed Fully Wired Items
| UI Item | Backend | Status |
|---------|---------|--------|
| [component] | [endpoint] | wired and functional |
```

---

### Template 6 — Final Completion Report

```markdown
## Final Completion Report

### Deleted Files
| File | Reason |
|------|--------|
| [path] | [duplicate/dead/backup/legacy] |

### Consolidated Files
| Original Files | Canonical Location | Notes |
|---------------|-------------------|-------|
| [list] | [path] | |

### Moved Files
| From | To | Reason |
|------|----|--------|
| [path] | [path] | [responsibility realignment] |

### Canonical Source-of-Truth Files
| Concern | File |
|---------|------|
| [concern] | [path] |

### UI Changes
| Item | Action | Reason |
|------|--------|--------|
| [component/action] | [removed/wired] | [no backend / backend newly wired] |

### Endpoint Changes
| Endpoint | Change | Reason |
|----------|--------|--------|
| [endpoint] | [added/removed/renamed] | |

### Remaining Technical Debt
| Item | Description | Priority |
|------|-------------|----------|
| [description] | [details] | [high/medium/low] |

### Summary
- Files deleted: [N]
- Files consolidated: [N]
- UI items removed: [N]
- UI items newly wired: [N]
- Remaining debt items: [N]
```
