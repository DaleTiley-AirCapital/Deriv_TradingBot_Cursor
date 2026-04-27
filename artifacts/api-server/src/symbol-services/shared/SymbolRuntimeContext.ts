export type TradingMode = "paper" | "demo" | "real";

export interface SymbolRuntimeContext {
  symbol: string;
  mode: TradingMode;
  ts: number;
  marketState: Record<string, unknown>;
  runtimeModel: Record<string, unknown> | null;
  stateMap: Record<string, string>;
  metadata?: Record<string, unknown>;
}