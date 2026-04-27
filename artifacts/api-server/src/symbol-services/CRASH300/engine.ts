import { scanSymbolV3 } from "../../core/engineRouterV3.js";
import { runEnginesAndCoordinate } from "../../core/signalPipeline.js";
import { buildSymbolTradeCandidate, type BuiltSymbolTradeCandidate } from "../../core/symbolModels/candidateBuilder.js";
import type { LiveCalibrationProfile } from "../../core/calibration/liveCalibrationProfile.js";
import { classifyRegimeFromSamples } from "../../core/regimeEngine.js";
import type { CoordinatorOutput } from "../../core/engineTypes.js";
import type { FeatureVector } from "../../core/features.js";
import type { SymbolRuntimeContext } from "../shared/SymbolRuntimeContext.js";
import type { SymbolDecisionResult } from "../shared/SymbolDecisionResult.js";

function asQualityTier(v: string | undefined): "A" | "B" | "C" | "D" | "unknown" {
  if (v === "A" || v === "B" || v === "C" || v === "D") return v;
  return "unknown";
}

export async function evaluateCrash300Runtime(
  context: SymbolRuntimeContext,
): Promise<SymbolDecisionResult> {
  const runtimeCalibration = (context.runtimeModel ?? null) as LiveCalibrationProfile | null;
  if (!runtimeCalibration || runtimeCalibration.source !== "promoted_symbol_model") {
    throw new Error("CRASH300 runtime model missing/invalid. Cannot evaluate symbol service.");
  }

  const scan = await resolveScanFromContext(context, runtimeCalibration);
  if (scan.skipped || !scan.features || !scan.coordinatorOutput) {
    return {
      symbol: "CRASH300",
      serviceName: "crash300_service",
      valid: false,
      direction: null,
      confidence: 0,
      qualityTier: "unknown",
      setupFamily: "crash_expansion",
      moveBucket: "unknown",
      setupMatch: 0,
      evidence: {
        scanSkipped: scan.skipped,
        skipReason: scan.skipReason ?? null,
        runtimeModelSource: runtimeCalibration.source,
      },
      featureSnapshot: (scan.features ?? {}) as unknown as Record<string, unknown>,
      failReasons: [scan.skipReason ?? "no_coordinator_output"],
    };
  }

  const built = buildSymbolTradeCandidate({
    symbol: "CRASH300",
    mode: context.mode,
    coordinatorOutput: scan.coordinatorOutput,
    winner: scan.coordinatorOutput.winner,
    features: scan.features,
    spotPrice: scan.features.latestClose,
    runtimeCalibration,
  });

  if (!built) {
    return {
      symbol: "CRASH300",
      serviceName: "crash300_service",
      valid: false,
      direction: null,
      confidence: scan.coordinatorOutput.coordinatorConfidence,
      qualityTier: "unknown",
      setupFamily: "crash_expansion",
      moveBucket: "unknown",
      setupMatch: 0,
      evidence: {
        coordinatorOutput: scan.coordinatorOutput,
      },
      featureSnapshot: scan.features as unknown as Record<string, unknown>,
      failReasons: ["candidate_build_failed"],
    };
  }

  return decisionFromBuiltCandidate(scan, built);
}

type FeatureSample = {
  emaSlope: number;
  rsi14: number;
  bbWidth: number;
  bbWidthRoc: number;
  atr14: number;
  atrRank: number;
  atrAccel: number;
  zScore: number;
  spikeHazardScore: number;
  bbPctB: number;
};

type ScanLike = {
  coordinatorOutput: CoordinatorOutput | null;
  features: FeatureVector | null;
  skipped: boolean;
  skipReason?: string;
};

function asFeatureVector(v: unknown): FeatureVector | null {
  if (!v || typeof v !== "object") return null;
  const candidate = v as Record<string, unknown>;
  if (typeof candidate["symbol"] !== "string") return null;
  if (typeof candidate["latestClose"] !== "number") return null;
  return candidate as unknown as FeatureVector;
}

function asFeatureSamples(v: unknown): FeatureSample[] {
  if (!Array.isArray(v)) return [];
  const out: FeatureSample[] = [];
  for (const row of v) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (
      typeof r["emaSlope"] === "number" &&
      typeof r["rsi14"] === "number" &&
      typeof r["bbWidth"] === "number" &&
      typeof r["bbWidthRoc"] === "number" &&
      typeof r["atr14"] === "number" &&
      typeof r["atrRank"] === "number" &&
      typeof r["atrAccel"] === "number" &&
      typeof r["zScore"] === "number" &&
      typeof r["spikeHazardScore"] === "number" &&
      typeof r["bbPctB"] === "number"
    ) {
      out.push({
        emaSlope: r["emaSlope"],
        rsi14: r["rsi14"],
        bbWidth: r["bbWidth"],
        bbWidthRoc: r["bbWidthRoc"],
        atr14: r["atr14"],
        atrRank: r["atrRank"],
        atrAccel: r["atrAccel"],
        zScore: r["zScore"],
        spikeHazardScore: r["spikeHazardScore"],
        bbPctB: r["bbPctB"],
      });
    }
  }
  return out;
}

async function resolveScanFromContext(
  context: SymbolRuntimeContext,
  runtimeCalibration: LiveCalibrationProfile,
): Promise<ScanLike> {
  const marketState = context.marketState ?? {};
  const features = asFeatureVector((marketState as Record<string, unknown>)["features"]);
  if (!features) {
    return scanSymbolV3("CRASH300", runtimeCalibration);
  }

  const existingCoordinatorOutput = (marketState as Record<string, unknown>)["coordinatorOutput"];
  if (existingCoordinatorOutput && typeof existingCoordinatorOutput === "object") {
    return {
      coordinatorOutput: existingCoordinatorOutput as CoordinatorOutput,
      features,
      skipped: false,
    };
  }

  let operationalRegime = "unknown";
  let regimeConfidence = 0;
  const rawRegime = (marketState as Record<string, unknown>)["operationalRegime"];
  const rawConfidence = (marketState as Record<string, unknown>)["regimeConfidence"];
  if (typeof rawRegime === "string") {
    operationalRegime = rawRegime;
  }
  if (typeof rawConfidence === "number") {
    regimeConfidence = rawConfidence;
  }

  if (operationalRegime === "unknown") {
    const samples = asFeatureSamples((marketState as Record<string, unknown>)["featureHistory"]);
    const derivedRegime = classifyRegimeFromSamples(features, samples);
    operationalRegime = derivedRegime.regime;
    regimeConfidence = derivedRegime.confidence;
  }

  const pipeline = runEnginesAndCoordinate({
    symbol: "CRASH300",
    features,
    operationalRegime,
    regimeConfidence,
    runtimeCalibration,
  });
  return {
    coordinatorOutput: pipeline.coordinatorOutput,
    features,
    skipped: false,
  };
}

function decisionFromBuiltCandidate(
  scan: ScanLike,
  built: BuiltSymbolTradeCandidate,
): SymbolDecisionResult {
  const setup = built.candidate.runtimeSetup;
  const bucketKey = setup.matchedBucketKey ?? "unknown";
  const family = setup.matchedBucketKey?.split("|")[0] ?? "crash_expansion";

  return {
    symbol: "CRASH300",
    serviceName: "crash300_service",
    valid: setup.allowed,
    direction: built.candidate.direction,
    confidence: scan.coordinatorOutput?.coordinatorConfidence ?? built.candidate.confidenceScore,
    qualityTier: asQualityTier(built.candidate.qualityBand),
    setupFamily: family,
    moveBucket: bucketKey,
    setupMatch: setup.evidenceScore,
    evidence: {
      runtimeSetup: setup,
      setupSignature: built.setupSignature,
      engineName: built.candidate.engineName,
      reason: built.candidate.reason,
      __builtCandidate: built as unknown as Record<string, unknown>,
    },
    featureSnapshot: built.candidate.features as unknown as Record<string, unknown>,
    failReasons: setup.allowed ? [] : [setup.reason],
  };
}
