import { ACTIVE_TRADING_SYMBOLS, RESEARCH_ONLY_SYMBOLS } from "../../infrastructure/deriv.js";

export type SymbolDomain = "active" | "research";

const ACTIVE_SET = new Set(ACTIVE_TRADING_SYMBOLS);
const RESEARCH_SET = new Set(RESEARCH_ONLY_SYMBOLS);

export const CALIBRATION_SYMBOLS = [
  ...ACTIVE_TRADING_SYMBOLS,
  ...RESEARCH_ONLY_SYMBOLS,
] as const;

export function getSymbolDomain(symbol: string): SymbolDomain | null {
  if (ACTIVE_SET.has(symbol)) return "active";
  if (RESEARCH_SET.has(symbol)) return "research";
  return null;
}

export function assertCalibrationSymbol(symbol: string): {
  ok: true;
  symbolDomain: SymbolDomain;
} | {
  ok: false;
  error: string;
} {
  const symbolDomain = getSymbolDomain(symbol);
  if (!symbolDomain) {
    return {
      ok: false,
      error: `Invalid symbol. Valid: ${CALIBRATION_SYMBOLS.join(", ")}`,
    };
  }
  return { ok: true, symbolDomain };
}

export function isActiveCalibrationSymbol(symbol: string): boolean {
  return ACTIVE_SET.has(symbol);
}
