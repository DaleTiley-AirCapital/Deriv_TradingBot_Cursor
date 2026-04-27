import type { SymbolServiceContract } from "./SymbolServiceContract.js";
import { crash300Service } from "../CRASH300/index.js";
import { boom300Service } from "../BOOM300/index.js";
import { r75Service } from "../R_75/index.js";
import { r100Service } from "../R_100/index.js";

export type SymbolRegistryMode = "solo" | "multi";

export interface SymbolRegistryConfig {
  mode: SymbolRegistryMode;
  enabledSymbols: string[];
}

export const DEFAULT_SOLO_CONFIG: SymbolRegistryConfig = {
  mode: "solo",
  enabledSymbols: ["CRASH300"],
};

const ALL_SERVICES: SymbolServiceContract[] = [
  crash300Service,
  boom300Service,
  r75Service,
  r100Service,
];

function uniqueUpper(values: string[]): string[] {
  return Array.from(new Set(values.map((v) => v.toUpperCase())));
}

export function resolveRegistryConfig(
  mode: SymbolRegistryMode = "solo",
  enabledSymbols: string[] = DEFAULT_SOLO_CONFIG.enabledSymbols,
): SymbolRegistryConfig {
  const normalized = uniqueUpper(enabledSymbols);
  if (mode === "solo") {
    return {
      mode,
      enabledSymbols: normalized.includes("CRASH300") ? ["CRASH300"] : ["CRASH300"],
    };
  }
  return { mode, enabledSymbols: normalized };
}

export function getRegisteredSymbolServices(): SymbolServiceContract[] {
  return ALL_SERVICES;
}

export function getSymbolService(symbol: string): SymbolServiceContract | undefined {
  const sym = symbol.toUpperCase();
  return ALL_SERVICES.find((svc) => svc.symbol.toUpperCase() === sym);
}

export function isSymbolEnabled(symbol: string, config: SymbolRegistryConfig): boolean {
  return config.enabledSymbols.includes(symbol.toUpperCase());
}