import type { EngineResult, CoordinatorOutput } from "./engineTypes.js";

// ─── Symbol Coordinator ───────────────────────────────────────────────────────
// Resolves conflicts when multiple engines fire on the same symbol.
// BOOM300/CRASH300: only 1 engine per symbol, so coordination is trivial.
// R_75/R_100: resolves across continuation, reversal, breakout engines.
//
// Priority rules (explicit, deterministic):
// 1. Breakout outranks all when active (high ATR, swing breach)
// 2. Continuation outranks reversal when trend is clearly established
// 3. Reversal wins only when continuation/breakout are not dominant
// 4. Conflicting directions (buy vs sell) → pick highest confidence,
//    but only if confidence gap >= 0.12 (else no signal this cycle)

function makeOutput(
  symbol: string,
  winner: EngineResult,
  all: EngineResult[],
  suppressedEngines: string[],
  conflictResolution: string,
): CoordinatorOutput {
  return {
    symbol,
    winner,
    all,
    suppressedEngines,
    conflictResolution,
    resolvedDirection: winner.direction,
    coordinatorConfidence: Math.min(1, winner.confidence * (0.8 + winner.regimeFit * 0.2)),
  };
}

export function runSymbolCoordinator(
  symbol: string,
  candidates: EngineResult[],
): CoordinatorOutput | null {
  const valid = candidates.filter(r => r.valid);

  if (valid.length === 0) return null;

  // Single engine result — no coordination needed
  if (valid.length === 1) {
    return makeOutput(symbol, valid[0], valid, [], "single_engine");
  }

  // ── Check for direction conflict ──────────────────────────────────────────
  const buyResults  = valid.filter(r => r.direction === "buy");
  const sellResults = valid.filter(r => r.direction === "sell");

  const hasConflict = buyResults.length > 0 && sellResults.length > 0;

  if (hasConflict) {
    const bestBuy  = buyResults.reduce((a, b) => a.confidence > b.confidence ? a : b);
    const bestSell = sellResults.reduce((a, b) => a.confidence > b.confidence ? a : b);

    if (Math.abs(bestBuy.confidence - bestSell.confidence) < 0.12) {
      console.log(`[Coordinator] ${symbol} — buy/sell conflict too close (${bestBuy.confidence.toFixed(2)} vs ${bestSell.confidence.toFixed(2)}) — no signal`);
      return null;
    }

    const winner = bestBuy.confidence > bestSell.confidence ? bestBuy : bestSell;
    const loser  = winner === bestBuy ? bestSell : bestBuy;

    return makeOutput(
      symbol, winner, valid, [loser.engineName],
      `direction_conflict_resolved:${winner.direction}_wins_by_confidence`,
    );
  }

  // ── All engines agree on direction — apply priority rules ─────────────────
  const breakout = valid.find(r => r.entryType === "breakout");
  if (breakout) {
    const suppressed = valid.filter(r => r !== breakout).map(r => r.engineName);
    return makeOutput(symbol, breakout, valid, suppressed, "breakout_priority");
  }

  const continuation = valid.find(r => r.entryType === "continuation");
  const reversal = valid.find(r => r.entryType === "reversal");

  if (continuation && reversal) {
    return makeOutput(
      symbol, continuation, valid, [reversal.engineName],
      "continuation_over_reversal",
    );
  }

  // Single engine in same direction — winner is highest confidence
  const winner = valid.reduce((a, b) => a.confidence > b.confidence ? a : b);
  const suppressed = valid.filter(r => r !== winner).map(r => r.engineName);

  return makeOutput(symbol, winner, valid, suppressed, "highest_confidence");
}
