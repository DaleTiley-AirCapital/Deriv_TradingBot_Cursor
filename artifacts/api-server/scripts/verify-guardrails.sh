#!/usr/bin/env bash
# verify-guardrails.sh
# Detects regression patterns: backup/temp/v2 filenames, commented-out imports,
# empty directories, and compatibility re-export shims.
# Run from the api-server package root.
# Exit code 0 = all PASS. Exit code 1 = at least one FAIL.

set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)/src"
PASS=0
FAIL=0

pass() { echo "  PASS  $1"; ((PASS++)) || true; }
fail() { echo "  FAIL  $1"; ((FAIL++)) || true; }

echo ""
echo "══════════════════════════════════════════"
echo "  API Server — Guardrail Checks"
echo "══════════════════════════════════════════"

# ─── 1. No backup/temp/v2/duplicate-style filenames ───────────────────────────
# Checks filenames (not content) for accumulation anti-patterns.
echo ""
echo "1. No forbidden filename patterns (v2/backup/temp/final/old/new)"
FORBIDDEN_NAMES=$(find "$SRC" -type f -name "*.ts" \
  \( -iname "*v2*" \
  -o -iname "*backup*" \
  -o -iname "*temp*" \
  -o -iname "*final*" \
  -o -iname "*.old.*" \
  -o -iname "*.new.*" \
  -o -iname "*-old.*" \
  -o -iname "*-new.*" \
  -o -iname "*_old.*" \
  -o -iname "*_new.*" \
  -o -iname "*_backup*" \
  -o -iname "*_temp*" \) \
  2>/dev/null | grep -v "node_modules" || true)
if [ -z "$FORBIDDEN_NAMES" ]; then
  pass "No backup/temp/v2/duplicate-style .ts filenames found"
else
  fail "Forbidden filename pattern detected:"
  echo "$FORBIDDEN_NAMES" | sed 's/^/        /'
fi

# ─── 2. No commented-out import lines ─────────────────────────────────────────
# Flags lines that are commented-out imports — a pattern that hides dead paths.
echo ""
echo "2. No commented-out import statements"
COMMENTED=$(grep -rn "^[[:space:]]*//" "$SRC" --include="*.ts" 2>/dev/null \
  | grep -E "//[[:space:]]*(import|export).*from[[:space:]]*['\"]" \
  | grep -v "node_modules" || true)
if [ -z "$COMMENTED" ]; then
  pass "No commented-out import/export lines found"
else
  fail "Commented-out import/export lines found (old path preserved as comment):"
  echo "$COMMENTED" | sed 's/^/        /'
fi

# ─── 3. No empty directories in src/ ──────────────────────────────────────────
echo ""
echo "3. No empty directories in src/"
EMPTY_DIRS=$(find "$SRC" -type d -empty 2>/dev/null | grep -v "node_modules" || true)
if [ -z "$EMPTY_DIRS" ]; then
  pass "No empty directories found"
else
  fail "Empty directories found:"
  echo "$EMPTY_DIRS" | sed 's/^/        /'
fi

# ─── 4. No compatibility re-export shim files ─────────────────────────────────
# A shim file is a .ts file whose non-blank, non-comment lines consist ONLY
# of re-export statements. These are used to preserve old import paths.
echo ""
echo "4. No compatibility re-export shim files"
SHIM_FILES=()
while IFS= read -r -d '' file; do
  # Count non-blank lines via wc -l (always exits 0, no || fallback needed)
  total_lines=$(grep -v "^[[:space:]]*$" "$file" 2>/dev/null | wc -l | tr -d ' ')
  # Count lines that are purely re-export statements
  reexport_lines=$(grep -E "^[[:space:]]*(export \* from|export \{[^}]*\} from)[[:space:]]*['\"]" "$file" 2>/dev/null | wc -l | tr -d ' ')
  # If file has content and ALL non-blank lines are re-exports → shim
  if [ "$total_lines" -gt 0 ] && [ "$reexport_lines" -eq "$total_lines" ]; then
    SHIM_FILES+=("$file")
  fi
done < <(find "$SRC" -name "*.ts" -not -path "*/node_modules/*" -print0 2>/dev/null)

if [ "${#SHIM_FILES[@]}" -eq 0 ]; then
  pass "No pure re-export shim files found"
else
  fail "Compatibility shim files detected (files consisting entirely of re-exports):"
  for f in "${SHIM_FILES[@]}"; do
    echo "        $f"
  done
fi

# ─── 5. No src/lib/ reintroduction ────────────────────────────────────────────
# Belt-and-suspenders: already checked in verify-structure but repeated here
# so guardrail runs catch this even without running verify-structure first.
echo ""
echo "5. src/lib/ not reintroduced"
if [ -d "$SRC/lib" ]; then
  fail "src/lib/ exists — the flat lib/ layout must not be reintroduced"
else
  pass "src/lib/ does not exist"
fi

# ─── 6. No stale cross-boundary imports (core importing from old flat paths) ──
# If any file in core/ or runtimes/ imports from infrastructure via a ./xxx path
# instead of ../infrastructure/xxx, it indicates a structural regression.
echo ""
echo "6. No cross-boundary flat imports in core/ or runtimes/"
FLAT_CROSS=$(grep -rn "from \"\.\/" "$SRC/core" "$SRC/runtimes" 2>/dev/null \
  | grep -E "\/(deriv|openai|scheduler|symbolValidator|candleExport|backtestEngine)\.js" \
  | grep -v "node_modules" || true)
if [ -z "$FLAT_CROSS" ]; then
  pass "No flat cross-boundary imports in core/ or runtimes/"
else
  fail "Cross-boundary flat imports found (should use ../infrastructure/ or ../runtimes/):"
  echo "$FLAT_CROSS" | sed 's/^/        /'
fi

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════"
TOTAL=$((PASS + FAIL))
echo "  Result: $PASS/$TOTAL passed"
if [ "$FAIL" -gt 0 ]; then
  echo "  STATUS: FAIL ($FAIL check(s) failed)"
  echo "══════════════════════════════════════════"
  echo ""
  exit 1
else
  echo "  STATUS: PASS"
  echo "══════════════════════════════════════════"
  echo ""
  exit 0
fi
