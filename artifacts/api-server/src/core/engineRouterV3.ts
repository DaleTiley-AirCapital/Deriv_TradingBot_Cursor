/**
 * V3 Engine Router — Live Decision Path
 *
 * This is the SOLE active live scan function for V3.
 * Replaces the old V2 family-based scanSingleSymbol path.
 *
 * Flow: features → operational regime → engines → coordinator → output
 *
 * Engine evaluation + coordinator conflict resolution are delegated to the
 * shared signalPipeline.runEnginesAndCoordinate, which is also used by
 * backtestRunner to guarantee identical decision logic in both paths.
 *
 * Loud failure: throws if a symbol has no registered engines.
 * No silent fallback to the V2 family router.
 */
import { computeFeatures } from "./features.js";
import { getCachedRegime, classifyRegimeFromHTF, cacheRegime, accumulateHourlyFeatures } from "./regimeEngine.js";
import { runEnginesAndCoordinate } from "./signalPipeline.js";
import type { CoordinatorOutput, EngineResult } from "./engineTypes.js";
import type { FeatureVector } from "./features.js";
import type { LiveCalibrationProfile } from "./calibration/liveCalibrationProfile.js";

export interface V3ScanResult {
  symbol: string;
  scannedAt: Date;
  operationalRegime: string;
  regimeConfidence: number;
  engineResults: EngineResult[];
  coordinatorOutput: CoordinatorOutput | null;
  features: FeatureVector | null;
  runtimeCalibrationApplied: boolean;
  skipped: boolean;
  skipReason?: string;
}

export async function scanSymbolV3(
  symbol: string,
  runtimeCalibration: LiveCalibrationProfile | null = null,
): Promise<V3ScanResult> {
  const scannedAt = new Date();

  // ── 1. Feature extraction ──────────────────────────────────────────────────
  const features = await computeFeatures(symbol);
  if (!features) {
    return {
      symbol, scannedAt,
      operationalRegime: "unknown", regimeConfidence: 0,
      engineResults: [], coordinatorOutput: null,
      features: null,
      runtimeCalibrationApplied: false,
      skipped: true, skipReason: "insufficient_data",
    };
  }

  // ── 2. Hourly feature accumulation (unchanged from V2 infra) ───────────────
  accumulateHourlyFeatures(features);

  // ── 3. Operational regime classification (secondary role in V3) ─────────────
  const cachedRegime = await getCachedRegime(symbol);
  const regime = cachedRegime ?? classifyRegimeFromHTF(features);
  if (!cachedRegime) {
    await cacheRegime(symbol, regime);
  }
  const operationalRegime = regime.regime;
  const regimeConfidence  = regime.confidence;

  // ── 4-5. Engine evaluation + coordinator — shared runtime pipeline ──────────
  // backtestRunner uses the same runEnginesAndCoordinate function so
  // both live and historical replay paths are identical from this point.
  let engineResults: EngineResult[];
  let coordinatorOutput: CoordinatorOutput | null;
  try {
    const pipelineResult = runEnginesAndCoordinate({
      symbol,
      features,
      operationalRegime,
      regimeConfidence,
      runtimeCalibration,
    });
    engineResults = pipelineResult.engineResults;
    coordinatorOutput = pipelineResult.coordinatorOutput;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[V3Router] LOUD FAILURE — ${msg}`);
    throw err;
  }

  if (coordinatorOutput) {
    const { winner, suppressedEngines, conflictResolution } = coordinatorOutput;
    console.log(
      `[V3Router] ${symbol} | regime=${operationalRegime} | engines=${engineResults.length} | ` +
      `winner=${winner.engineName} | dir=${winner.direction} | conf=${winner.confidence.toFixed(3)} | ` +
      `resolution=${conflictResolution}` +
      (suppressedEngines.length > 0 ? ` | suppressed=[${suppressedEngines.join(",")}]` : "")
    );
  } else {
    const validCount = engineResults.filter(r => r.valid).length;
    if (validCount > 0) {
      console.log(`[V3Router] ${symbol} | regime=${operationalRegime} | engines=${engineResults.length} | coordinator=no_signal`);
    } else {
      console.log(`[V3Router] ${symbol} | regime=${operationalRegime} | engines=0_valid | SKIP=no_engine_signals`);
    }
  }

  return {
    symbol,
    scannedAt,
    operationalRegime,
    regimeConfidence,
    engineResults,
    coordinatorOutput,
    features,
    runtimeCalibrationApplied: Boolean(runtimeCalibration),
    skipped: false,
  };
}
