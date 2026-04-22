import { db, platformStateTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getDerivClientWithDbToken } from "./deriv.js";
import {
  V1_DEFAULT_SYMBOLS,
  ACTIVE_TRADING_SYMBOLS,
  RESEARCH_ONLY_SYMBOLS,
} from "./deriv.js";

export type SymbolStreamingState = "streaming" | "available" | "idle" | "disabled";

export interface SymbolStatus {
  symbol: string;
  configured: string;
  instrumentFamily: string;
  isActiveTradingSymbol: boolean;
  isResearchOnly: boolean;
  activeSymbolFound: boolean;
  apiSymbol: string | null;
  displayName: string | null;
  marketType: string | null;
  streamingState: SymbolStreamingState;
  streaming: boolean;
  lastTickTs: number | null;
  lastTickValue: number | null;
  tickCount5min: number;
  stale: boolean;
  error: string | null;
}

interface ActiveSymbol {
  symbol: string;
  display_name: string;
  market: string;
  market_display_name: string;
  submarket: string;
  submarket_display_name: string;
  symbol_type: string;
  is_trading_suspended: number;
  exchange_is_open: number;
}

const SYMBOL_ALIASES: Record<string, string[]> = {
  "BOOM1000":  ["BOOM1000", "1HZ1000V", "BOOM1000_"],
  "CRASH1000": ["CRASH1000", "1HZ1000V", "CRASH1000_"],
  "BOOM900":   ["BOOM900", "BOOM900N", "1HZ900V"],
  "CRASH900":  ["CRASH900", "CRASH900N", "1HZ900V"],
  "BOOM600":   ["BOOM600", "BOOM600N", "1HZ600V"],
  "CRASH600":  ["CRASH600", "CRASH600N", "1HZ600V"],
  "BOOM500":   ["BOOM500", "1HZ500V", "BOOM500_"],
  "CRASH500":  ["CRASH500", "1HZ500V", "CRASH500_"],
  "BOOM300":   ["BOOM300", "BOOM300N", "1HZ300V"],
  "CRASH300":  ["CRASH300", "CRASH300N", "1HZ300V"],
  "R_75":      ["R_75", "1HZ75V"],
  "R_100":     ["R_100", "1HZ100V"],
  "R_10":      ["R_10", "1HZ10V"],
  "R_25":      ["R_25", "1HZ25V"],
  "R_50":      ["R_50", "1HZ50V"],
  "RDBULL":    ["RDBULL"],
  "RDBEAR":    ["RDBEAR"],
  "JD10":      ["JD10"],
  "JD25":      ["JD25"],
  "JD50":      ["JD50"],
  "JD75":      ["JD75"],
  "JD100":     ["JD100"],
  "stpRNG":    ["stpRNG"],
  "stpRNG2":   ["stpRNG2"],
  "stpRNG3":   ["stpRNG3"],
  "stpRNG5":   ["stpRNG5"],
  "RB100":     ["RB100"],
  "RB200":     ["RB200"],
};

const symbolHealthStore: Map<string, {
  lastTickTs: number;
  lastTickValue: number;
  tickTimestamps: number[];
  streaming: boolean;
  error: string | null;
}> = new Map();

const disabledSymbols = new Set<string>();

export async function initStreamingStateFromDb(): Promise<void> {
  try {
    const rows = await db.select().from(platformStateTable);
    for (const row of rows) {
      if (row.key.startsWith("streaming_disabled_") && row.value === "true") {
        const symbol = row.key.slice("streaming_disabled_".length);
        disabledSymbols.add(symbol);
        console.log(`[SymbolValidator] Loaded persisted DISABLED state for ${symbol}`);
      }
    }
  } catch (err) {
    console.warn("[SymbolValidator] Could not load streaming state from DB:", err instanceof Error ? err.message : err);
  }
}

let validatedSymbolMap: Map<string, { apiSymbol: string; displayName: string; marketType: string }> = new Map();
let lastValidationTs = 0;
const VALIDATION_CACHE_MS = 300_000;
const STALE_THRESHOLD_MS = 120_000;
let watchdogHandle: ReturnType<typeof setInterval> | null = null;

// All 28 known symbols: 12 V1 + 16 research-only
// Lazy function avoids circular-import TDZ (deriv.ts ↔ symbolValidator.ts)
function getAllKnownSymbols(): string[] {
  return [...V1_DEFAULT_SYMBOLS, ...RESEARCH_ONLY_SYMBOLS];
}

export function recordTick(symbol: string, price: number, epochTs: number): void {
  const now = Date.now();
  let health = symbolHealthStore.get(symbol);
  if (!health) {
    health = { lastTickTs: 0, lastTickValue: 0, tickTimestamps: [], streaming: true, error: null };
    symbolHealthStore.set(symbol, health);
  }
  health.lastTickTs = epochTs * 1000;
  health.lastTickValue = price;
  health.streaming = true;
  health.error = null;
  health.tickTimestamps.push(now);
  const cutoff = now - 300_000;
  health.tickTimestamps = health.tickTimestamps.filter(t => t > cutoff);
}

export function markSymbolSubscribed(symbol: string): void {
  let health = symbolHealthStore.get(symbol);
  if (!health) {
    health = { lastTickTs: Date.now(), lastTickValue: 0, tickTimestamps: [], streaming: true, error: null };
    symbolHealthStore.set(symbol, health);
  } else {
    health.streaming = true;
    health.error = null;
  }
}

export function markSymbolError(symbol: string, error: string): void {
  let health = symbolHealthStore.get(symbol);
  if (!health) {
    health = { lastTickTs: 0, lastTickValue: 0, tickTimestamps: [], streaming: false, error };
    symbolHealthStore.set(symbol, health);
  }
  health.streaming = false;
  health.error = error;
}

/**
 * Enable streaming for a specific symbol.
 * Removes it from the disabled set. The symbol will resume streaming
 * on the next subscription cycle if it is an active trading symbol.
 */
export function enableSymbolStreaming(symbol: string): void {
  disabledSymbols.delete(symbol);
  console.log(`[SymbolValidator] Streaming ENABLED for ${symbol}`);
}

/**
 * Disable streaming for a specific symbol.
 * Adds it to the disabled set. The symbol will be treated as "disabled"
 * in status reports and skipped for live streaming subscriptions.
 */
export function disableSymbolStreaming(symbol: string): void {
  disabledSymbols.add(symbol);
  const health = symbolHealthStore.get(symbol);
  if (health) health.streaming = false;
  console.log(`[SymbolValidator] Streaming DISABLED for ${symbol}`);
}

export function isSymbolStreamingDisabled(symbol: string): boolean {
  return disabledSymbols.has(symbol);
}

export function getDisabledSymbols(): string[] {
  return Array.from(disabledSymbols);
}

function classifyInstrumentFamily(symbol: string): string {
  if (symbol.startsWith("BOOM"))  return "Boom/Crash";
  if (symbol.startsWith("CRASH")) return "Boom/Crash";
  if (symbol.startsWith("R_"))    return "Volatility";
  if (symbol.startsWith("JD"))    return "Jump";
  if (symbol.startsWith("RD"))    return "Bull/Bear";
  if (symbol.startsWith("stp"))   return "Step";
  if (symbol.startsWith("RB"))    return "Range Break";
  return "Other";
}

/**
 * Resolves the streaming state for a symbol.
 *
 * disabled  — explicitly disabled via per-symbol toggle
 * streaming — actively receiving ticks right now
 * available — validated against Deriv API but not currently streaming
 * idle      — not validated / not in active streaming set
 */
function resolveStreamingState(
  symbol: string,
  health: { streaming: boolean; lastTickTs: number } | undefined,
  validated: boolean,
): SymbolStreamingState {
  if (disabledSymbols.has(symbol)) return "disabled";
  if (health?.streaming) return "streaming";
  if (validated) return "available";
  return "idle";
}

export async function validateActiveSymbols(
  forceRefresh = false,
): Promise<Map<string, { apiSymbol: string; displayName: string; marketType: string }>> {
  if (!forceRefresh && validatedSymbolMap.size > 0 && Date.now() - lastValidationTs < VALIDATION_CACHE_MS) {
    return validatedSymbolMap;
  }

  try {
    const client = await getDerivClientWithDbToken();
    const response = await (client as any).send({ active_symbols: "brief", product_type: "basic" }) as Record<string, unknown>;

    if (response.error) {
      console.error("[SymbolValidator] Failed to fetch active symbols:", (response.error as any).message);
      return validatedSymbolMap;
    }

    const activeSymbols = (response.active_symbols || []) as ActiveSymbol[];
    const activeMap = new Map<string, ActiveSymbol>();
    for (const s of activeSymbols) {
      activeMap.set(s.symbol, s);
    }

    const newMap = new Map<string, { apiSymbol: string; displayName: string; marketType: string }>();
    const configuredSymbols = await getConfiguredSymbols();

    for (const configured of configuredSymbols) {
      const directMatch = activeMap.get(configured);
      if (directMatch) {
        newMap.set(configured, {
          apiSymbol: directMatch.symbol,
          displayName: directMatch.display_name,
          marketType: directMatch.market_display_name,
        });
        console.log(`[SymbolValidator] ✓ ${configured} → ${directMatch.display_name} (${directMatch.market_display_name})`);
        continue;
      }

      const aliases = SYMBOL_ALIASES[configured] || [];
      let found = false;
      for (const alias of aliases) {
        const aliasMatch = activeMap.get(alias);
        if (aliasMatch) {
          newMap.set(configured, {
            apiSymbol: aliasMatch.symbol,
            displayName: aliasMatch.display_name,
            marketType: aliasMatch.market_display_name,
          });
          console.log(`[SymbolValidator] ✓ ${configured} → ${aliasMatch.symbol} (alias: ${aliasMatch.display_name})`);
          found = true;
          break;
        }
      }

      if (!found) {
        const fuzzyMatches = activeSymbols.filter(s =>
          s.display_name.toLowerCase().includes(configured.toLowerCase().replace(/_/g, " ")) ||
          s.symbol.toLowerCase().includes(configured.toLowerCase()),
        );
        if (fuzzyMatches.length > 0) {
          const best = fuzzyMatches[0];
          newMap.set(configured, {
            apiSymbol: best.symbol,
            displayName: best.display_name,
            marketType: best.market_display_name,
          });
          console.log(`[SymbolValidator] ~ ${configured} → ${best.symbol} (fuzzy: ${best.display_name})`);
        } else {
          console.warn(`[SymbolValidator] ✗ ${configured} — NOT FOUND in active symbols.`);
          markSymbolError(configured, "Not found in Deriv active symbols");
        }
      }
    }

    validatedSymbolMap = newMap;
    lastValidationTs = Date.now();

    const validCount = newMap.size;
    const invalidCount = configuredSymbols.length - validCount;
    console.log(`[SymbolValidator] Validation complete: ${validCount} valid, ${invalidCount} invalid out of ${configuredSymbols.length} configured`);

    return newMap;
  } catch (err) {
    console.error("[SymbolValidator] Validation error:", err instanceof Error ? err.message : err);
    return validatedSymbolMap;
  }
}

async function getConfiguredSymbols(): Promise<string[]> {
  try {
    const rows = await db.select().from(platformStateTable).where(eq(platformStateTable.key, "enabled_symbols"));
    if (rows.length > 0 && rows[0].value) {
      const enabled = rows[0].value.split(",").filter(Boolean);
      return Array.from(new Set([...getAllKnownSymbols(), ...enabled]));
    }
  } catch {}
  return getAllKnownSymbols();
}

export function getValidatedSymbols(): string[] {
  return Array.from(validatedSymbolMap.keys());
}

export function isSymbolValid(symbol: string): boolean {
  return validatedSymbolMap.has(symbol);
}

export function getApiSymbol(configured: string): string {
  return validatedSymbolMap.get(configured)?.apiSymbol || configured;
}

/**
 * Returns status for ALL 28 known symbols.
 *
 * Each symbol has a `streamingState` field:
 *   streaming — actively receiving live ticks
 *   available — validated against Deriv API, not currently streaming
 *   idle      — known symbol, not validated / no live data
 *   disabled  — explicitly disabled via per-symbol toggle
 */
export function getAllSymbolStatuses(): SymbolStatus[] {
  const now = Date.now();

  return getAllKnownSymbols().map(symbol => {
    const validated  = validatedSymbolMap.get(symbol);
    const health     = symbolHealthStore.get(symbol);
    const isStale    = health ? (now - health.lastTickTs > STALE_THRESHOLD_MS && health.streaming) : false;
    const streaming  = !disabledSymbols.has(symbol) && (health?.streaming || false);

    const streamingState = resolveStreamingState(symbol, health, !!validated);

    return {
      symbol:                symbol,
      configured:            symbol,
      instrumentFamily:      classifyInstrumentFamily(symbol),
      isActiveTradingSymbol: ACTIVE_TRADING_SYMBOLS.includes(symbol),
      isResearchOnly:        !V1_DEFAULT_SYMBOLS.includes(symbol),
      activeSymbolFound:     !!validated,
      apiSymbol:             validated?.apiSymbol   || null,
      displayName:           validated?.displayName || null,
      marketType:            validated?.marketType  || null,
      streamingState,
      streaming,
      lastTickTs:      health?.lastTickTs  || null,
      lastTickValue:   health?.lastTickValue || null,
      tickCount5min:   health?.tickTimestamps.filter(t => t > now - 300_000).length || 0,
      stale:           isStale,
      error:           !validated ? "Not found in active symbols" : (health?.error || null),
    };
  });
}

export function startWatchdog(resubscribeFn: (symbol: string) => Promise<void>): void {
  if (watchdogHandle) {
    clearInterval(watchdogHandle);
    watchdogHandle = null;
  }

  watchdogHandle = setInterval(async () => {
    const now = Date.now();

    for (const [symbol, health] of symbolHealthStore.entries()) {
      if (!health.streaming) continue;
      if (disabledSymbols.has(symbol)) continue;

      if (now - health.lastTickTs > STALE_THRESHOLD_MS) {
        console.warn(`[Watchdog] Stream stale for ${symbol} — no tick in ${((now - health.lastTickTs) / 1000).toFixed(0)}s. Auto-resubscribing...`);
        health.streaming = false;
        health.error = "Stream stale — resubscribing";

        try {
          await resubscribeFn(symbol);
          health.streaming = true;
          health.error = null;
          health.lastTickTs = Date.now();
          console.log(`[Watchdog] Resubscribed to ${symbol} successfully`);
        } catch (err) {
          health.error = `Resubscribe failed: ${err instanceof Error ? err.message : String(err)}`;
          console.error(`[Watchdog] Resubscribe failed for ${symbol}:`, health.error);
        }
      }
    }
  }, 30_000);
}

export function stopWatchdog(): void {
  if (watchdogHandle) {
    clearInterval(watchdogHandle);
    watchdogHandle = null;
  }
}
