import { scanSymbolV3 } from "../../core/engineRouterV3.js";
import { buildSymbolTradeCandidate, type BuiltSymbolTradeCandidate } from "../../core/symbolModels/candidateBuilder.js";
import type { LiveCalibrationProfile } from "../../core/calibration/liveCalibrationProfile.js";
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

  const scan = await scanSymbolV3("CRASH300", runtimeCalibration);
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

function decisionFromBuiltCandidate(
  scan: Awaited<ReturnType<typeof scanSymbolV3>>,
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
