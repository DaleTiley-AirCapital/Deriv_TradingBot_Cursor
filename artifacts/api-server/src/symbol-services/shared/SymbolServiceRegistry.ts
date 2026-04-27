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

function parseCsvSymbols(raw: string | undefined): string[] {
  if (!raw) return [];
  return uniqueUpper(raw.split(",").map((v) => v.trim()).filter(Boolean));
}

export function resolveRegistryConfigFromStateMap(
  stateMap: Record<string, string>,
): SymbolRegistryConfig {
  const modeRaw = (stateMap["symbol_service_mode"] ?? "solo").toLowerCase();
  const mode: SymbolRegistryMode = modeRaw === "multi" ? "multi" : "solo";

  const configuredSymbols = parseCsvSymbols(
    stateMap["symbol_services_enabled"] ??
      stateMap["enabled_symbol_services"] ??
      stateMap["enabled_symbols"],
  );

  const serviceExplicitFlags = ALL_SERVICES
    .map((svc) => ({
      symbol: svc.symbol.toUpperCase(),
      enabled:
        (stateMap[`symbol_service_enabled_${svc.symbol.toUpperCase()}`] ?? "").toLowerCase() === "true",
    }))
    .filter((row) => row.enabled)
    .map((row) => row.symbol);

  const mergedEnabled = uniqueUpper([...configuredSymbols, ...serviceExplicitFlags]);
  const baseline = resolveRegistryConfig(mode, mergedEnabled.length > 0 ? mergedEnabled : DEFAULT_SOLO_CONFIG.enabledSymbols);

  const available = new Set(getRegisteredSymbolServices().map((s) => s.symbol.toUpperCase()));
  return {
    mode: baseline.mode,
    enabledSymbols: baseline.enabledSymbols.filter((s) => available.has(s)),
  };
}

export function getEnabledRegisteredSymbols(
  stateMap: Record<string, string>,
): string[] {
  const cfg = resolveRegistryConfigFromStateMap(stateMap);
  return getRegisteredSymbolServices()
    .map((svc) => svc.symbol.toUpperCase())
    .filter((sym) => isSymbolEnabled(sym, cfg));
}
