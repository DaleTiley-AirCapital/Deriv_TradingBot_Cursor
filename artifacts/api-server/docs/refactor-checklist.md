# Structural Refactor Completion Checklist

Use this checklist before closing any task that moves, renames, or restructures files.

---

## Files

- [ ] All files listed in the task have been moved to their target locations
- [ ] Original files at old locations have been deleted (not copied, not duplicated)
- [ ] No backup, temp, v2, final, old, or new variant files were left behind
- [ ] No empty directories remain

---

## Imports

- [ ] All import paths in moved files have been updated to their new relative locations
- [ ] All callers (routes, other modules, index.ts, app.ts) have been updated
- [ ] No `../lib/` import strings remain anywhere in src/
- [ ] No `./lib/` import strings remain anywhere in src/
- [ ] No dynamic `import("./old-path.js")` calls were missed (search for `await import(` too)
- [ ] No commented-out old import lines were left behind

---

## No fallback paths

- [ ] No compatibility re-export shim files were created (e.g. a file whose entire purpose is `export * from './new-location.js'`)
- [ ] No bridge files or alias wrappers were created
- [ ] No `tsconfig.json` path aliases were added to compensate for stale import strings
- [ ] No conditional import logic was added to handle old vs. new paths

---

## Validation

- [ ] `pnpm tsc --noEmit` passes with zero errors
- [ ] `pnpm --filter @workspace/api-server run verify:structure` passes
- [ ] `pnpm --filter @workspace/api-server run verify:guardrails` passes
- [ ] API server starts cleanly (no `Cannot find module`, `ENOENT`, or path resolution errors)

---

## Documentation

- [ ] Before/after file map documented in completion report
- [ ] Moved files list included in completion report
- [ ] Deleted files list included in completion report
- [ ] Canonical source-of-truth per concern declared in completion report

---

## Ownership

- [ ] No duplicate logic exists across the new structure and any remnant location
- [ ] Each concern has exactly one owner file in the new structure
- [ ] No parallel implementations of the same logic exist in different directories
