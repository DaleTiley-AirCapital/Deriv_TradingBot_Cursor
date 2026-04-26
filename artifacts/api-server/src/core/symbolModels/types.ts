import type { EngineResult } from "../engineTypes.js";
import type { FeatureVector } from "../features.js";
import type { RuntimeEntryEvidenceResult, RuntimeLeadInShape, RuntimeQualityBand } from "../calibration/runtimeProfileUtils.js";
import type { LiveCalibrationProfile } from "../calibration/liveCalibrationProfile.js";

export type SymbolModelId = "CRASH300" | "BOOM300" | "R_75" | "R_100" | (string & {});
export type TradeDirection = "buy" | "sell";

export interface SymbolExitPolicy {
  source: "promoted_runtime_model" | "native_symbol_engine";
  takeProfitPct: number;
  stopLossPct: number;
  trailingArmPct: number;
  trailingDistancePct: number;
  minHoldMinutes?: number;
  maxHoldMinutes?: number;
  bucketKey?: string | null;
}

export interface SymbolTradeCandidate {
  symbol: SymbolModelId;
  engineName: string;
  direction: TradeDirection;
  nativeScore: number;
  confidenceScore: number;
  qualityBand: RuntimeQualityBand;
  leadInShape: RuntimeLeadInShape;
  runtimeSetup: RuntimeEntryEvidenceResult;
  exitPolicy: SymbolExitPolicy;
  features: FeatureVector;
  runtimeCalibration?: LiveCalibrationProfile | null;
  sourceEngineResult: EngineResult;
  reason: string;
  metadata?: Record<string, unknown>;
}

export interface SymbolModelContext {
  symbol: SymbolModelId;
  mode: "paper" | "demo" | "real";
  features: FeatureVector;
  runtimeCalibration?: LiveCalibrationProfile | null;
}

export interface SymbolTradingModel {
  symbol: SymbolModelId;
  buildCandidate(context: SymbolModelContext): SymbolTradeCandidate | null;
  manageOpenTrade?(candidate: SymbolTradeCandidate): SymbolExitPolicy;
}

export interface PortfolioAllocationCandidate {
  candidate: SymbolTradeCandidate;
  requestedCapitalPct?: number;
  priorityScore?: number;
}
