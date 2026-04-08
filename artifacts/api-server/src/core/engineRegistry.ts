import type { SymbolEngine } from "./engineTypes.js";
import { boom300Engine } from "./engines/boom300Engine.js";
import { crash300Engine } from "./engines/crash300Engine.js";
import {
  r75ContinuationEngine,
  r75ReversalEngine,
  r75BreakoutEngine,
} from "./engines/r75Engines.js";
import {
  r100ContinuationEngine,
  r100ReversalEngine,
  r100BreakoutEngine,
} from "./engines/r100Engines.js";

// ─── V3 Engine Registry ───────────────────────────────────────────────────────
// Single source of truth for which engines run on which symbols.
// BOOM300 and CRASH300: 1 engine each.
// R_75 and R_100: 3 engines each.
// Total live engines = 8.
//
// To disable an engine: remove it from this map.
// To re-enable: add it back here.
// There is no fallback — if a symbol has no engines, V3 scanner logs an error.

export const ENGINE_REGISTRY: Record<string, SymbolEngine[]> = {
  BOOM300:  [boom300Engine],
  CRASH300: [crash300Engine],
  R_75:     [r75ContinuationEngine, r75ReversalEngine, r75BreakoutEngine],
  R_100:    [r100ContinuationEngine, r100ReversalEngine, r100BreakoutEngine],
};

export function getEnginesForSymbol(symbol: string): SymbolEngine[] {
  const engines = ENGINE_REGISTRY[symbol];
  if (!engines || engines.length === 0) {
    throw new Error(
      `[V3] No engines registered for symbol "${symbol}". ` +
      `Valid symbols: ${Object.keys(ENGINE_REGISTRY).join(", ")}. ` +
      `This is a loud V3 misconfiguration — do not suppress.`
    );
  }
  return engines;
}

export function getRegisteredSymbols(): string[] {
  return Object.keys(ENGINE_REGISTRY);
}
