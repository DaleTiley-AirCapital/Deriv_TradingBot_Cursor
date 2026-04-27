import type { SymbolServiceContract, SymbolServiceStatus, RuntimeModelEnvelope, CalibrationParityInput, BacktestInput } from "../shared/SymbolServiceContract.js";
import type { SymbolRuntimeContext } from "../shared/SymbolRuntimeContext.js";
import type { SymbolDecisionResult } from "../shared/SymbolDecisionResult.js";
import type { TradeCandidate } from "../shared/TradeCandidate.js";
import { failServiceNotEnabled, failServiceNotImplemented } from "../shared/runtimeFlow.js";

const SYMBOL = "BOOM300";
const SERVICE = "boom300_service";
const ENABLED = false;

function assertEnabled(action: string): never {
  if (!ENABLED) failServiceNotEnabled(SYMBOL, SERVICE);
  failServiceNotImplemented(SYMBOL, SERVICE, action);
}

async function getStatus(): Promise<SymbolServiceStatus> {
  return {
    symbol: SYMBOL,
    serviceName: SERVICE,
    enabled: ENABLED,
    activeMode: "solo",
    ready: false,
    message: ENABLED
      ? "Milestone 1 scaffold: enabled in registry, runtime logic not migrated yet."
      : "Milestone 1 scaffold: disabled service with fail-loud guard.",
  };
}

async function getRuntimeModel(): Promise<RuntimeModelEnvelope> {
  return assertEnabled("getRuntimeModel");
}

async function stageRuntimeModel(): Promise<RuntimeModelEnvelope> {
  return assertEnabled("stageRuntimeModel");
}

async function promoteStagedRuntimeModel(): Promise<RuntimeModelEnvelope> {
  return assertEnabled("promoteStagedRuntimeModel");
}

async function buildRuntimeContext(_input: Record<string, unknown>): Promise<SymbolRuntimeContext> {
  return assertEnabled("buildRuntimeContext");
}

async function evaluateRuntime(_context: SymbolRuntimeContext): Promise<SymbolDecisionResult> {
  return assertEnabled("evaluateRuntime");
}

async function createTradeCandidate(_decision: SymbolDecisionResult): Promise<TradeCandidate> {
  return assertEnabled("createTradeCandidate");
}

async function manageOpenPosition(_position: Record<string, unknown>, _marketState: Record<string, unknown>): Promise<Record<string, unknown>> {
  return assertEnabled("manageOpenPosition");
}

async function runCalibrationParity(_input: CalibrationParityInput): Promise<Record<string, unknown>> {
  return assertEnabled("runCalibrationParity");
}

async function runBacktest(_input: BacktestInput): Promise<Record<string, unknown>> {
  return assertEnabled("runBacktest");
}

export const boom300Service : SymbolServiceContract = {
  symbol: SYMBOL,
  serviceName: SERVICE,
  supportedModes: ["paper", "demo", "real"],
  getStatus,
  getRuntimeModel,
  stageRuntimeModel,
  promoteStagedRuntimeModel,
  buildRuntimeContext,
  evaluateRuntime,
  createTradeCandidate,
  manageOpenPosition,
  runCalibrationParity,
  runBacktest,
};
