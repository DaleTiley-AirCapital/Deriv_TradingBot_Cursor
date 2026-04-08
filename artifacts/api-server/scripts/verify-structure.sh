#!/usr/bin/env bash
# verify-structure.sh
# Checks that the API server src/ follows the core/infrastructure/runtimes layout
# established in Task #86. Run from the api-server package root.
# Exit code 0 = all PASS. Exit code 1 = at least one FAIL.

set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)/src"
PASS=0
FAIL=0

pass() { echo "  PASS  $1"; ((PASS++)) || true; }
fail() { echo "  FAIL  $1"; ((FAIL++)) || true; }

echo ""
echo "══════════════════════════════════════════"
echo "  API Server — Structural Verification"
echo "══════════════════════════════════════════"

# ─── 1. lib/ must not exist ───────────────────────────────────────────────────
echo ""
echo "1. Forbidden directories"
if [ -d "$SRC/lib" ]; then
  fail "src/lib/ still exists — must be deleted"
else
  pass "src/lib/ does not exist"
fi

# ─── 2. Required directories must exist ───────────────────────────────────────
echo ""
echo "2. Required directories"
for dir in core infrastructure runtimes; do
  if [ -d "$SRC/$dir" ]; then
    pass "src/$dir/ exists"
  else
    fail "src/$dir/ is missing"
  fi
done

# ─── 3. Expected files in core/ ───────────────────────────────────────────────
echo ""
echo "3. Files in src/core/"
CORE_FILES=(
  features.ts
  regimeEngine.ts
  scoring.ts
  signalRouter.ts
  strategies.ts
  tradeEngine.ts
  extractionEngine.ts
  pendingSignals.ts
)
for f in "${CORE_FILES[@]}"; do
  if [ -f "$SRC/core/$f" ]; then
    pass "core/$f"
  else
    fail "core/$f is missing"
  fi
done

# ─── 4. Expected files in infrastructure/ ─────────────────────────────────────
echo ""
echo "4. Files in src/infrastructure/"
INFRA_FILES=(
  deriv.ts
  openai.ts
  scheduler.ts
  symbolValidator.ts
  candleExport.ts
)
for f in "${INFRA_FILES[@]}"; do
  if [ -f "$SRC/infrastructure/$f" ]; then
    pass "infrastructure/$f"
  else
    fail "infrastructure/$f is missing"
  fi
done

# ─── 5. Expected files in runtimes/ ───────────────────────────────────────────
echo ""
echo "5. Files in src/runtimes/"
RUNTIME_FILES=(backtestEngine.ts)
for f in "${RUNTIME_FILES[@]}"; do
  if [ -f "$SRC/runtimes/$f" ]; then
    pass "runtimes/$f"
  else
    fail "runtimes/$f is missing"
  fi
done

# ─── 6. No old ../lib/ import paths ───────────────────────────────────────────
echo ""
echo "6. No stale ../lib/ import strings"
HITS=$(grep -rn "\.\./lib/" "$SRC" 2>/dev/null | grep -v "node_modules" || true)
if [ -z "$HITS" ]; then
  pass "grep '../lib/' — zero matches"
else
  fail "grep '../lib/' — stale imports found:"
  echo "$HITS" | sed 's/^/        /'
fi

# ─── 7. No old ./lib/ import paths ────────────────────────────────────────────
echo ""
echo "7. No stale ./lib/ import strings"
HITS=$(grep -rn "from \"\./lib/" "$SRC" 2>/dev/null | grep -v "node_modules" || true)
if [ -z "$HITS" ]; then
  pass "grep './lib/' — zero matches"
else
  fail "grep './lib/' — stale imports found:"
  echo "$HITS" | sed 's/^/        /'
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
