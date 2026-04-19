/**
 * signalPipeline.ts — Shared Signal Decision Pipeline
 *
 * Extracts the engine evaluation + coordinator step into a single shared
 * function that is invoked by BOTH the live scanner (engineRouterV3) and
 * the historical replay (backtestRunner). This ensures both paths use
 * identical engine execution and coordinator conflict resolution logic.
 *
 * Input: symbol + HTF-averaged feature vector + regime classification
 * Output: coordinator output + raw engine results
 *
 * The caller is responsible for:
 *  - Feature extraction (live: computeFeatures; backtest: computeFeaturesFromSlice)
 *  - HTF averaging (live: accumulateHourlyFeatures; backtest: barFeatureBuffer)
 *  - Regime classification (live: classifyRegimeFromHTF; backtest: classifyRegimeHTFLocal)
 *  - Admission decision (live: allocateV3Signal; backtest: evaluateSignalAdmission)
 *  - Trade execution (live: openPositionV3; backtest: in-memory simulation)
 */

import { getEnginesForSymbol } from "./engineRegistry.js";
import { runSymbolCoordinator } from "./symbolCoordinator.js";
import type { EngineContext, EngineResult, CoordinatorOutput } from "./engineTypes.js";
import type { FeatureVector } from "./features.js";
import type { LiveCalibrationProfile } from "./calibration/liveCalibrationProfile.js";

export interface EngineCoordinatorInput {
  symbol: string;
  features: FeatureVector;
  operationalRegime: string;
  regimeConfidence: number;
  runtimeCalibration?: LiveCalibrationProfile | null;
}

export interface EngineCoordinatorOutput {
  engineResults: EngineResult[];
  coordinatorOutput: CoordinatorOutput | null;
}

/**
 * Evaluate all registered engines for `symbol` and resolve conflicts via the
 * symbol coordinator. Used by both live (engineRouterV3) and backtest replay
 * (backtestRunner) so that engine logic and coordinator rules have a single
 * implementation.
 *
 * Throws if the symbol has no registered engines (loud failure).
 */
export function runEnginesAndCoordinate(
  input: EngineCoordinatorInput,
): EngineCoordinatorOutput {
  const { symbol, features, operationalRegime, regimeConfidence, runtimeCalibration } = input;

  const engines = getEnginesForSymbol(symbol);

  const ctx: EngineContext = {
    features,
    operationalRegime,
    regimeConfidence,
    runtimeCalibration: runtimeCalibration ?? null,
  };

  const engineResults: EngineResult[] = [];
  for (const engine of engines) {
    try {
      const result = engine(ctx);
      if (result) engineResults.push(result);
    } catch (err) {
      console.error(`[SignalPipeline] Engine error for ${symbol}:`, err instanceof Error ? err.message : err);
    }
  }

  if (runtimeCalibration) {
    for (const result of engineResults) {
      result.confidence = Math.max(0, Math.min(0.99, result.confidence * runtimeCalibration.confidenceMultiplier));
      result.projectedMovePct = Math.max(0, result.projectedMovePct * runtimeCalibration.projectedMoveMultiplier);
      result.metadata = {
        ...result.metadata,
        runtimeCalibrationApplied: true,
        runtimeCalibrationRunId: runtimeCalibration.sourceRunId,
      };
    }
  }

  const coordinatorOutput = runSymbolCoordinator(symbol, engineResults);

  return { engineResults, coordinatorOutput };
}
