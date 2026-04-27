import type {
  BacktestInput,
  CalibrationParityInput,
  RuntimeModelEnvelope,
  SymbolServiceContract,
  SymbolServiceStatus,
} from "../shared/SymbolServiceContract.js";
import type { SymbolRuntimeContext } from "../shared/SymbolRuntimeContext.js";
import type { SymbolDecisionResult } from "../shared/SymbolDecisionResult.js";
import type { TradeCandidate } from "../shared/TradeCandidate.js";
import { failServiceNotEnabled } from "../shared/runtimeFlow.js";
import {
  loadCrash300RuntimeEnvelope,
  promoteCrash300StagedRuntimeModel,
  stageCrash300RuntimeModel,
} from "./model.js";
import { evaluateCrash300Runtime } from "./engine.js";
import { createCrash300TradeCandidate } from "./candidateFactory.js";
import { runCrash300CalibrationParity } from "./calibration.js";
import { manageCrash300OpenPosition } from "./tradeManagement.js";
import { runCrash300Backtest } from "./parityBacktest.js";

const SYMBOL = "CRASH300";
const SERVICE = "crash300_service";
const ENABLED = true;

function assertEnabled(): void {
  if (!ENABLED) failServiceNotEnabled(SYMBOL, SERVICE);
}

async function getStatus(): Promise<SymbolServiceStatus> {
  assertEnabled();
  const envelope = await loadCrash300RuntimeEnvelope();
  return {
    symbol: SYMBOL,
    serviceName: SERVICE,
    enabled: ENABLED,
    activeMode: "solo",
    ready: Boolean(envelope.promotedModel),
    message: envelope.promotedModel
      ? "CRASH300 service ready with promoted runtime model."
      : "CRASH300 service requires promoted runtime model before evaluation.",
  };
}

async function getRuntimeModel(): Promise<RuntimeModelEnvelope> {
  assertEnabled();
  const env = await loadCrash300RuntimeEnvelope();
  return {
    symbol: env.symbol,
    stagedModel: env.stagedModel as unknown as Record<string, unknown> | null,
    promotedModel: env.promotedModel as unknown as Record<string, unknown> | null,
  };
}

async function stageRuntimeModel(): Promise<RuntimeModelEnvelope> {
  assertEnabled();
  const env = await stageCrash300RuntimeModel();
  return {
    symbol: env.symbol,
    stagedModel: env.stagedModel as unknown as Record<string, unknown> | null,
    promotedModel: env.promotedModel as unknown as Record<string, unknown> | null,
  };
}

async function promoteStagedRuntimeModel(): Promise<RuntimeModelEnvelope> {
  assertEnabled();
  const env = await promoteCrash300StagedRuntimeModel();
  return {
    symbol: env.symbol,
    stagedModel: env.stagedModel as unknown as Record<string, unknown> | null,
    promotedModel: env.promotedModel as unknown as Record<string, unknown> | null,
  };
}

async function buildRuntimeContext(input: Record<string, unknown>): Promise<SymbolRuntimeContext> {
  assertEnabled();
  const mode = (input.mode === "paper" || input.mode === "demo" || input.mode === "real")
    ? input.mode
    : "paper";
  const stateMap = (input.stateMap && typeof input.stateMap === "object" && !Array.isArray(input.stateMap))
    ? (input.stateMap as Record<string, string>)
    : {};
  const envelope = await loadCrash300RuntimeEnvelope();

  return {
    symbol: SYMBOL,
    mode,
    ts: Number(input.ts ?? Math.floor(Date.now() / 1000)),
    marketState: (input.marketState && typeof input.marketState === "object" && !Array.isArray(input.marketState))
      ? (input.marketState as Record<string, unknown>)
      : {},
    runtimeModel: envelope.promotedModel as unknown as Record<string, unknown> | null,
    stateMap,
    metadata: {
      stagedModelRunId: envelope.stagedModel?.sourceRunId ?? null,
      promotedModelRunId: envelope.promotedModel?.sourceRunId ?? null,
      source: "symbol_service_context",
    },
  };
}

async function evaluateRuntime(context: SymbolRuntimeContext): Promise<SymbolDecisionResult> {
  assertEnabled();
  return evaluateCrash300Runtime(context);
}

async function createTradeCandidate(decision: SymbolDecisionResult): Promise<TradeCandidate> {
  assertEnabled();
  return createCrash300TradeCandidate(decision);
}

async function manageOpenPosition(
  position: Record<string, unknown>,
  marketState: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  assertEnabled();
  return manageCrash300OpenPosition(position, marketState);
}

async function runCalibrationParity(input: CalibrationParityInput): Promise<Record<string, unknown>> {
  assertEnabled();
  return runCrash300CalibrationParity({
    startTs: input.startTs,
    endTs: input.endTs,
    mode: input.mode,
  });
}

async function runBacktest(input: BacktestInput): Promise<Record<string, unknown>> {
  assertEnabled();
  const result = await runCrash300Backtest({
    startTs: input.startTs,
    endTs: input.endTs,
    mode: input.mode,
  });
  return result as unknown as Record<string, unknown>;
}

export const crash300Service: SymbolServiceContract = {
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
