import { db, platformStateTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getDerivClientWithDbToken } from "./deriv.js";

export interface SymbolStatus {
  configured: string;
  instrumentFamily: string;
  activeSymbolFound: boolean;
  apiSymbol: string | null;
  displayName: string | null;
  marketType: string | null;
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
  "BOOM1000": ["BOOM1000", "1HZ1000V", "BOOM1000_"],
  "CRASH1000": ["CRASH1000", "1HZ1000V", "CRASH1000_"],
  "BOOM500": ["BOOM500", "1HZ500V", "BOOM500_"],
  "CRASH500": ["CRASH500", "1HZ500V", "CRASH500_"],
  "BOOM300": ["BOOM300", "BOOM300N", "1HZ300V"],
  "CRASH300": ["CRASH300", "CRASH300N", "1HZ300V"],
  "BOOM200": ["BOOM200", "BOOM200N", "1HZ200V"],
  "CRASH200": ["CRASH200", "CRASH200N", "1HZ200V"],
  "R_75": ["R_75", "1HZ75V"],
  "R_100": ["R_100", "1HZ100V"],
  "JD75": ["JD75", "JD_75"],
  "STPIDX": ["STPIDX", "stpRNG"],
  "RDBEAR": ["RDBEAR", "RDBEARV"],
};

const symbolHealthStore: Map<string, {
  lastTickTs: number;
  lastTickValue: number;
  tickTimestamps: number[];
  streaming: boolean;
  error: string | null;
}> = new Map();

let validatedSymbolMap: Map<string, { apiSymbol: string; displayName: string; marketType: string }> = new Map();
let lastValidationTs = 0;
const VALIDATION_CACHE_MS = 300_000;
const STALE_THRESHOLD_MS = 120_000;
let watchdogHandle: ReturnType<typeof setInterval> | null = null;

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

export function markSymbolError(symbol: string, error: string): void {
  let health = symbolHealthStore.get(symbol);
  if (!health) {
    health = { lastTickTs: 0, lastTickValue: 0, tickTimestamps: [], streaming: false, error };
    symbolHealthStore.set(symbol, health);
  }
  health.streaming = false;
  health.error = error;
}

function classifyInstrumentFamily(symbol: string): string {
  if (symbol.startsWith("BOOM")) return "boom";
  if (symbol.startsWith("CRASH")) return "crash";
  if (symbol.startsWith("R_")) return "volatility";
  return "other_synthetic";
}

export async function validateActiveSymbols(forceRefresh = false): Promise<Map<string, { apiSymbol: string; displayName: string; marketType: string }>> {
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
          console.log(`[SymbolValidator] ✓ ${configured} → ${aliasMatch.symbol} (alias match: ${aliasMatch.display_name})`);
          found = true;
          break;
        }
      }

      if (!found) {
        const fuzzyMatches = activeSymbols.filter(s =>
          s.display_name.toLowerCase().includes(configured.toLowerCase().replace(/_/g, " ")) ||
          s.symbol.toLowerCase().includes(configured.toLowerCase())
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
          console.warn(`[SymbolValidator] ✗ ${configured} — NOT FOUND in active symbols. Will not subscribe.`);
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
      return rows[0].value.split(",").filter(Boolean);
    }
  } catch {}
  return ["BOOM1000", "CRASH1000", "BOOM500", "CRASH500", "BOOM300", "CRASH300", "BOOM200", "CRASH200", "R_75", "R_100", "JD75", "STPIDX", "RDBEAR"];
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

export function getAllSymbolStatuses(): SymbolStatus[] {
  const configuredSymbols = [
    "BOOM1000", "CRASH1000", "BOOM500", "CRASH500",
    "BOOM300", "CRASH300", "BOOM200", "CRASH200",
    "R_75", "R_100", "JD75", "STPIDX", "RDBEAR",
  ];

  const now = Date.now();

  return configuredSymbols.map(symbol => {
    const validated = validatedSymbolMap.get(symbol);
    const health = symbolHealthStore.get(symbol);
    const isStale = health ? (now - health.lastTickTs > STALE_THRESHOLD_MS && health.streaming) : false;

    return {
      configured: symbol,
      instrumentFamily: classifyInstrumentFamily(symbol),
      activeSymbolFound: !!validated,
      apiSymbol: validated?.apiSymbol || null,
      displayName: validated?.displayName || null,
      marketType: validated?.marketType || null,
      streaming: health?.streaming || false,
      lastTickTs: health?.lastTickTs || null,
      lastTickValue: health?.lastTickValue || null,
      tickCount5min: health?.tickTimestamps.filter(t => t > now - 300_000).length || 0,
      stale: isStale,
      error: !validated ? "Not found in active symbols" : (health?.error || null),
    };
  });
}

export function startWatchdog(resubscribeFn: (symbol: string) => Promise<void>): void {
  if (watchdogHandle) return;

  watchdogHandle = setInterval(async () => {
    const now = Date.now();

    for (const [symbol, health] of symbolHealthStore.entries()) {
      if (!health.streaming) continue;

      if (now - health.lastTickTs > STALE_THRESHOLD_MS) {
        console.warn(`[Watchdog] Stream stale for ${symbol} — no tick in ${((now - health.lastTickTs) / 1000).toFixed(0)}s. Auto-resubscribing...`);
        health.streaming = false;
        health.error = "Stream stale — resubscribing";

        try {
          await resubscribeFn(symbol);
          health.streaming = true;
          health.error = null;
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
