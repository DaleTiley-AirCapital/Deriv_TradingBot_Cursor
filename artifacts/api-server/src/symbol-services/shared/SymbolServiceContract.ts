import type { TradeCandidate } from "./TradeCandidate.js";
import type { SymbolRuntimeContext } from "./SymbolRuntimeContext.js";
import type { SymbolDecisionResult } from "./SymbolDecisionResult.js";

export interface SymbolServiceStatus {
  symbol: string;
  serviceName: string;
  enabled: boolean;
  activeMode: "solo" | "multi";
  ready: boolean;
  message: string;
}

export interface RuntimeModelEnvelope {
  symbol: string;
  stagedModel: Record<string, unknown> | null;
  promotedModel: Record<string, unknown> | null;
}

export interface CalibrationParityInput {
  symbol: string;
  startTs?: number;
  endTs?: number;
  mode?: "parity" | "trading_sim";
}

export interface BacktestInput {
  symbol: string;
  startTs: number;
  endTs: number;
  mode: "paper" | "demo" | "real";
}

export interface SymbolServiceContract {
  symbol: string;
  serviceName: string;
  supportedModes: Array<"paper" | "demo" | "real">;
  getStatus(): Promise<SymbolServiceStatus>;
  getRuntimeModel(): Promise<RuntimeModelEnvelope>;
  stageRuntimeModel(): Promise<RuntimeModelEnvelope>;
  promoteStagedRuntimeModel(): Promise<RuntimeModelEnvelope>;
  buildRuntimeContext(input: Record<string, unknown>): Promise<SymbolRuntimeContext>;
  evaluateRuntime(context: SymbolRuntimeContext): Promise<SymbolDecisionResult>;
  createTradeCandidate(decision: SymbolDecisionResult): Promise<TradeCandidate>;
  manageOpenPosition(position: Record<string, unknown>, marketState: Record<string, unknown>): Promise<Record<string, unknown>>;
  runCalibrationParity(input: CalibrationParityInput): Promise<Record<string, unknown>>;
  runBacktest(input: BacktestInput): Promise<Record<string, unknown>>;
}