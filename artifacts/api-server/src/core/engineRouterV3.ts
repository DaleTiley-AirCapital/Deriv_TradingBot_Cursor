/**
 * V3 Engine Router - Live Decision Path
 */
import { db, candlesTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { computeFeatures } from "./features.js";
import { getCachedRegime, classifyRegimeFromHTF, cacheRegime, accumulateHourlyFeatures } from "./regimeEngine.js";
import { runEnginesAndCoordinate } from "./signalPipeline.js";
import type { CoordinatorOutput, EngineResult } from "./engineTypes.js";
import type { FeatureVector } from "./features.js";
import type { LiveCalibrationProfile } from "./calibration/liveCalibrationProfile.js";
import { evaluateCrash300Runtime, coordinatorFromCrash300Decision } from "../symbol-services/CRASH300/engine.js";
import type { CandleRow } from "./backtest/featureSlice.js";

const CRASH300_LIVE_LOOKBACK_BARS = 1600;

async function loadRecentCrash300Candles(symbol: string): Promise<CandleRow[]> {
  const rows = await db
    .select({
      open: candlesTable.open,
      high: candlesTable.high,
      low: candlesTable.low,
      close: candlesTable.close,
      openTs: candlesTable.openTs,
      closeTs: candlesTable.closeTs,
    })
    .from(candlesTable)
    .where(and(
      eq(candlesTable.symbol, symbol),
      eq(candlesTable.timeframe, "1m"),
      eq(candlesTable.isInterpolated, false),
    ))
    .orderBy(desc(candlesTable.openTs))
    .limit(CRASH300_LIVE_LOOKBACK_BARS);
  return (rows as CandleRow[]).reverse();
}

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
  const features = await computeFeatures(symbol);
  if (!features) {
    return {
      symbol,
      scannedAt,
      operationalRegime: "unknown",
      regimeConfidence: 0,
      engineResults: [],
      coordinatorOutput: null,
      features: null,
      runtimeCalibrationApplied: false,
      skipped: true,
      skipReason: "insufficient_data",
    };
  }

  accumulateHourlyFeatures(features);

  const cachedRegime = await getCachedRegime(symbol);
  const regime = cachedRegime ?? classifyRegimeFromHTF(features);
  if (!cachedRegime) await cacheRegime(symbol, regime);
  const operationalRegime = regime.regime;
  const regimeConfidence = regime.confidence;

  let engineResults: EngineResult[];
  let coordinatorOutput: CoordinatorOutput | null;
  try {
    if (symbol === "CRASH300") {
      const candles = await loadRecentCrash300Candles(symbol);
      const runtimeDecision = await evaluateCrash300Runtime({
        symbol,
        mode: "paper",
        ts: Math.floor(scannedAt.getTime() / 1000),
        marketState: {
          features,
          candles,
          operationalRegime,
          regimeConfidence,
        },
        runtimeModel: runtimeCalibration as unknown as Record<string, unknown> | null,
        stateMap: {},
      });
      const serviceResult = coordinatorFromCrash300Decision(
        runtimeDecision,
        runtimeCalibration as LiveCalibrationProfile,
        Number((runtimeDecision.evidence as Record<string, unknown>)["expectedMovePct"] ?? 0),
        ((runtimeDecision.evidence as Record<string, unknown>)["componentScores"] as Record<string, number>) ?? {},
      );
      engineResults = serviceResult.engineResults;
      coordinatorOutput = serviceResult.coordinatorOutput;
    } else {
      const pipelineResult = runEnginesAndCoordinate({
        symbol,
        features,
        operationalRegime,
        regimeConfidence,
        runtimeCalibration,
      });
      engineResults = pipelineResult.engineResults;
      coordinatorOutput = pipelineResult.coordinatorOutput;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[V3Router] LOUD FAILURE - ${msg}`);
    throw err;
  }

  if (coordinatorOutput) {
    const { winner, suppressedEngines, conflictResolution } = coordinatorOutput;
    console.log(
      `[V3Router] ${symbol} | regime=${operationalRegime} | engines=${engineResults.length} | ` +
      `winner=${winner.engineName} | dir=${winner.direction} | conf=${winner.confidence.toFixed(3)} | ` +
      `resolution=${conflictResolution}` +
      (suppressedEngines.length > 0 ? ` | suppressed=[${suppressedEngines.join(",")}]` : ""),
    );
  } else {
    const validCount = engineResults.filter((r) => r.valid).length;
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
