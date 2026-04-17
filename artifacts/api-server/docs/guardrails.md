# Repository Guardrails

Canonical policy links:

- Current runtime operating policy: `docs/current-operating-policy.md`
- Documentation guardrails: `docs/docs-guardrails.md`
- Source-of-truth ownership map: `docs/source-of-truth.md`

## What exists

Two runnable verification scripts:

| Script | Purpose |
|--------|---------|
| `pnpm run verify:structure` | Checks the src/ directory layout matches the canonical core/infrastructure/runtimes structure |
| `pnpm run verify:guardrails` | Detects regression patterns: forbidden filenames, commented-out imports, empty dirs, shim files, cross-boundary flat imports |

Both scripts print PASS/FAIL per check and exit with code 1 on any failure.

---

## Why they exist

The flat `src/lib/` layout was replaced in Task #86 with a responsibility-based structure:

- `core/` — trading engine, strategies, signal pipeline, entry/exit/TP/SL/risk logic
- `infrastructure/` — broker adapter, OpenAI, scheduler, symbol validator, candle export
- `runtimes/` — backtest/research runner

Without guardrails, future tasks can silently reintroduce the `lib/` dumping ground, create backup/temp files, leave commented-out dead paths, or add compatibility shims that mask structural regressions.

---

## How to run

From the `artifacts/api-server/` directory:

```bash
pnpm run verify:structure
pnpm run verify:guardrails
```

Or from the workspace root:

```bash
pnpm --filter @workspace/api-server run verify:structure
pnpm --filter @workspace/api-server run verify:guardrails
```

---

## What failures mean

### `verify:structure` failures

| Failure | Meaning | Fix |
|---------|---------|-----|
| `src/lib/ still exists` | The flat lib layout was reintroduced | Move files to correct subdir and delete lib/ |
| `src/core/ is missing` | Core directory was deleted or renamed | Restore the directory and its files |
| `core/X.ts is missing` | A core file was moved or deleted without updating the check | Move it back or update the manifest if ownership changed |
| `stale ../lib/ imports found` | Import paths were not updated after a file move | Update all callers to the new path |
| `stale ./lib/ imports found` | Same as above from index.ts or app.ts | Update imports in the reported files |

### `verify:guardrails` failures

| Failure | Meaning | Fix |
|---------|---------|-----|
| Forbidden filename pattern | A v2/backup/temp/old/new file was left behind | Delete the file; if it has content worth keeping, merge it into the canonical owner |
| Commented-out import lines | An old import was commented out instead of deleted | Delete the comment entirely |
| Empty directory | A directory was created but left empty, or all files were moved out | Delete the empty directory |
| Pure re-export shim file | A compatibility shim was created to preserve old import paths | Delete the shim; update all callers to the new canonical path directly |
| Cross-boundary flat imports | A file in core/ or runtimes/ imports infrastructure as `./X.js` | Fix to `../infrastructure/X.js` |

---

## Forbidden patterns

These are never allowed:

- `src/lib/` directory (the old flat layout)
- Compatibility re-export files (files whose sole content is `export * from './somewhere-else.js'`)
- Commented-out import/export statements (dead paths disguised as documentation)
- Filenames containing: `v2`, `backup`, `temp`, `final`, `.old.`, `.new.`, `_backup`, `_temp`
- `tsconfig.json` path aliases added to paper over stale import strings
- Bridge or shim files of any kind unless explicitly justified and documented

