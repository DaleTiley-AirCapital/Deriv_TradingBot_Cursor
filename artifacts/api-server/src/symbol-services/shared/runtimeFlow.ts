import type { SymbolServiceContract } from "./SymbolServiceContract.js";
import type { SymbolRuntimeContext } from "./SymbolRuntimeContext.js";
import type { SymbolDecisionResult } from "./SymbolDecisionResult.js";
import type { TradeCandidate } from "./TradeCandidate.js";

export class SymbolServiceError extends Error {
  readonly code: string;
  readonly symbol: string;

  constructor(code: string, symbol: string, message: string) {
    super(message);
    this.code = code;
    this.symbol = symbol;
  }
}

export function failServiceNotEnabled(symbol: string, serviceName: string): never {
  throw new SymbolServiceError(
    "service_not_enabled",
    symbol,
    `${serviceName} is disabled for ${symbol} in current registry mode.`,
  );
}

export function failServiceNotImplemented(symbol: string, serviceName: string, action: string): never {
  throw new SymbolServiceError(
    "service_not_implemented",
    symbol,
    `${serviceName} does not implement ${action} in Milestone 1 scaffold.`,
  );
}

export async function evaluateSymbolService(
  service: SymbolServiceContract,
  context: SymbolRuntimeContext,
): Promise<SymbolDecisionResult> {
  return service.evaluateRuntime(context);
}

export async function createSymbolTradeCandidate(
  service: SymbolServiceContract,
  decision: SymbolDecisionResult,
): Promise<TradeCandidate> {
  return service.createTradeCandidate(decision);
}

export async function runSymbolRuntimeFlow(
  service: SymbolServiceContract,
  context: SymbolRuntimeContext,
): Promise<{ decision: SymbolDecisionResult; candidate: TradeCandidate }> {
  const decision = await evaluateSymbolService(service, context);
  const candidate = await createSymbolTradeCandidate(service, decision);
  return { decision, candidate };
}