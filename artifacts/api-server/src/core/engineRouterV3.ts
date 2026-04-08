/**
 * V3 Engine Router — Live Decision Path
 *
 * This is the SOLE active live scan function for V3.
 * Replaces the old V2 family-based scanSingleSymbol path.
 *
 * Flow: features → operational regime → engines → coordinator → output
 *
 * Loud failure: throws if a symbol has no registered engines.
 * No silent fallback to the V2 family router.
 */
import { computeFeatures } from "./features.js";
import { getCachedRegime, classifyRegimeFromHTF, cacheRegime, accumulateHourlyFeatures } from "./regimeEngine.js";
import { getEnginesForSymbol } from "./engineRegistry.js";
import { runSymbolCoordinator } from "./symbolCoordinator.js";
import type { EngineContext, EngineResult, CoordinatorOutput } from "./engineTypes.js";
import type { FeatureVector } from "./features.js";

export interface V3ScanResult {
  symbol: string;
  scannedAt: Date;
  operationalRegime: string;
  regimeConfidence: number;
  engineResults: EngineResult[];
  coordinatorOutput: CoordinatorOutput | null;
  features: FeatureVector | null;
  skipped: boolean;
  skipReason?: string;
}

export async function scanSymbolV3(symbol: string): Promise<V3ScanResult> {
  const scannedAt = new Date();

  // ── 1. Feature extraction ──────────────────────────────────────────────────
  const features = await computeFeatures(symbol);
  if (!features) {
    return {
      symbol, scannedAt,
      operationalRegime: "unknown", regimeConfidence: 0,
      engineResults: [], coordinatorOutput: null,
      features: null,
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

  // ── 4. Get symbol-native engines (loud failure if misconfigured) ────────────
  let engines;
  try {
    engines = getEnginesForSymbol(symbol);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[V3Router] LOUD FAILURE — ${msg}`);
    throw err;
  }

  // ── 5. Evaluate each engine ────────────────────────────────────────────────
  const ctx: EngineContext = {
    features,
    operationalRegime,
    regimeConfidence,
  };

  const engineResults: EngineResult[] = [];
  for (const engine of engines) {
    try {
      const result = engine(ctx);
      if (result) engineResults.push(result);
    } catch (err) {
      console.error(`[V3Router] Engine error for ${symbol}:`, err instanceof Error ? err.message : err);
    }
  }

  // ── 6. Symbol coordinator ──────────────────────────────────────────────────
  const coordinatorOutput = runSymbolCoordinator(symbol, engineResults);

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
    skipped: false,
  };
}
