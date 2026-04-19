import type { FeatureVector } from "./features.js";
import type { LiveCalibrationProfile } from "./calibration/liveCalibrationProfile.js";

export type EngineEntryType =
  | "expansion"
  | "continuation"
  | "reversal"
  | "breakout";

export interface EngineResult {
  valid: boolean;
  symbol: string;
  engineName: string;
  direction: "buy" | "sell";
  confidence: number;
  regimeFit: number;
  entryType: EngineEntryType;
  projectedMovePct: number;
  invalidation: number;
  reason: string;
  metadata: Record<string, unknown>;
}

export interface EngineContext {
  features: FeatureVector;
  operationalRegime: string;
  regimeConfidence: number;
  runtimeCalibration?: LiveCalibrationProfile | null;
}

export type SymbolEngine = (ctx: EngineContext) => EngineResult | null;

export const ACTIVE_SYMBOLS = ["CRASH300", "BOOM300", "R_75", "R_100"] as const;
export type ActiveSymbol = typeof ACTIVE_SYMBOLS[number];

export interface CoordinatorOutput {
  symbol: string;
  winner: EngineResult;
  all: EngineResult[];
  suppressedEngines: string[];
  conflictResolution: string;
  /** Direction resolved after conflict resolution — matches winner.direction */
  resolvedDirection: "buy" | "sell";
  /** Overall coordinator confidence — derived from winner + regimeFit */
  coordinatorConfidence: number;
}
