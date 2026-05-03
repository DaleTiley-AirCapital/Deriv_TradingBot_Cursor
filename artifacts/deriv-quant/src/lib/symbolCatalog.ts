export interface SymbolCatalogEntry {
  symbol: string;
  label: string;
  group: string;
  serviceEnabled: boolean;
  serviceScaffolded: boolean;
}

export const SYMBOL_GROUPS_IN_ORDER = [
  "Continuous Indices",
  "Boom Indices",
  "Crash Indices",
  "Step Indices",
  "Range Break Indices",
  "Jump Indices",
  "Other Indices",
] as const;

export const SYMBOL_CATALOG: SymbolCatalogEntry[] = [
  { symbol: "R_10", label: "Volatility 10 Index", group: "Continuous Indices", serviceEnabled: false, serviceScaffolded: false },
  { symbol: "R_25", label: "Volatility 25 Index", group: "Continuous Indices", serviceEnabled: false, serviceScaffolded: false },
  { symbol: "R_50", label: "Volatility 50 Index", group: "Continuous Indices", serviceEnabled: false, serviceScaffolded: false },
  { symbol: "R_75", label: "Volatility 75 Index", group: "Continuous Indices", serviceEnabled: true, serviceScaffolded: true },
  { symbol: "R_100", label: "Volatility 100 Index", group: "Continuous Indices", serviceEnabled: true, serviceScaffolded: true },

  { symbol: "BOOM50", label: "Boom 50 Index", group: "Boom Indices", serviceEnabled: false, serviceScaffolded: false },
  { symbol: "BOOM150", label: "Boom 150 Index", group: "Boom Indices", serviceEnabled: false, serviceScaffolded: false },
  { symbol: "BOOM300", label: "Boom 300 Index", group: "Boom Indices", serviceEnabled: true, serviceScaffolded: true },
  { symbol: "BOOM500", label: "Boom 500 Index", group: "Boom Indices", serviceEnabled: false, serviceScaffolded: false },
  { symbol: "BOOM600", label: "Boom 600 Index", group: "Boom Indices", serviceEnabled: false, serviceScaffolded: false },
  { symbol: "BOOM900", label: "Boom 900 Index", group: "Boom Indices", serviceEnabled: false, serviceScaffolded: false },
  { symbol: "BOOM1000", label: "Boom 1000 Index", group: "Boom Indices", serviceEnabled: false, serviceScaffolded: false },

  { symbol: "CRASH50", label: "Crash 50 Index", group: "Crash Indices", serviceEnabled: false, serviceScaffolded: false },
  { symbol: "CRASH150", label: "Crash 150 Index", group: "Crash Indices", serviceEnabled: false, serviceScaffolded: false },
  { symbol: "CRASH300", label: "Crash 300 Index", group: "Crash Indices", serviceEnabled: true, serviceScaffolded: true },
  { symbol: "CRASH500", label: "Crash 500 Index", group: "Crash Indices", serviceEnabled: false, serviceScaffolded: false },
  { symbol: "CRASH600", label: "Crash 600 Index", group: "Crash Indices", serviceEnabled: false, serviceScaffolded: false },
  { symbol: "CRASH900", label: "Crash 900 Index", group: "Crash Indices", serviceEnabled: false, serviceScaffolded: false },
  { symbol: "CRASH1000", label: "Crash 1000 Index", group: "Crash Indices", serviceEnabled: false, serviceScaffolded: false },

  { symbol: "STEP100", label: "Step Index 100", group: "Step Indices", serviceEnabled: false, serviceScaffolded: false },
  { symbol: "STEP200", label: "Step Index 200", group: "Step Indices", serviceEnabled: false, serviceScaffolded: false },
  { symbol: "STEP300", label: "Step Index 300", group: "Step Indices", serviceEnabled: false, serviceScaffolded: false },
  { symbol: "STEP400", label: "Step Index 400", group: "Step Indices", serviceEnabled: false, serviceScaffolded: false },
  { symbol: "STEP500", label: "Step Index 500", group: "Step Indices", serviceEnabled: false, serviceScaffolded: false },

  { symbol: "RB100", label: "Range Break 100 Index", group: "Range Break Indices", serviceEnabled: false, serviceScaffolded: false },
  { symbol: "RB200", label: "Range Break 200 Index", group: "Range Break Indices", serviceEnabled: false, serviceScaffolded: false },

  { symbol: "JD10", label: "Jump 10 Index", group: "Jump Indices", serviceEnabled: false, serviceScaffolded: false },
  { symbol: "JD25", label: "Jump 25 Index", group: "Jump Indices", serviceEnabled: false, serviceScaffolded: false },
  { symbol: "JD50", label: "Jump 50 Index", group: "Jump Indices", serviceEnabled: false, serviceScaffolded: false },
  { symbol: "JD75", label: "Jump 75 Index", group: "Jump Indices", serviceEnabled: false, serviceScaffolded: false },
  { symbol: "JD100", label: "Jump 100 Index", group: "Jump Indices", serviceEnabled: false, serviceScaffolded: false },

  { symbol: "RDBULL", label: "RD Bull", group: "Other Indices", serviceEnabled: false, serviceScaffolded: false },
  { symbol: "RDBEAR", label: "RD Bear", group: "Other Indices", serviceEnabled: false, serviceScaffolded: false },
];

export const ACTIVE_SERVICE_SYMBOLS = ["CRASH300", "BOOM300", "R_75", "R_100"] as const;

export const SERVICE_SELECTOR_OPTIONS = ACTIVE_SERVICE_SYMBOLS.map((symbol) => {
  const entry = SYMBOL_CATALOG.find((row) => row.symbol === symbol);
  return {
    symbol,
    label: entry?.label ?? symbol,
    group: entry?.group ?? "Services",
  };
});

export function getSymbolLabel(symbol: string): string {
  return SYMBOL_CATALOG.find((entry) => entry.symbol === symbol)?.label ?? symbol;
}

export function getSymbolGroup(symbol: string): string {
  return SYMBOL_CATALOG.find((entry) => entry.symbol === symbol)?.group ?? "Other Indices";
}

export function isScaffoldedService(symbol: string): boolean {
  return Boolean(SYMBOL_CATALOG.find((entry) => entry.symbol === symbol)?.serviceScaffolded);
}

export function isEnabledService(symbol: string): boolean {
  return Boolean(SYMBOL_CATALOG.find((entry) => entry.symbol === symbol)?.serviceEnabled);
}

export function getGroupedSymbols(symbols?: readonly string[]) {
  const allowed = symbols ? new Set(symbols) : null;
  return SYMBOL_GROUPS_IN_ORDER.map((group) => ({
    group,
    entries: SYMBOL_CATALOG.filter((entry) => entry.group === group && (!allowed || allowed.has(entry.symbol))),
  })).filter((section) => section.entries.length > 0);
}

export function inferServiceFromEngine(strategyName: string | null | undefined): string {
  const value = String(strategyName ?? "").toUpperCase();
  if (value.includes("CRASH")) return "CRASH300";
  if (value.includes("BOOM")) return "BOOM300";
  if (value.includes("R75")) return "R_75";
  if (value.includes("R100")) return "R_100";
  return "unknown";
}
