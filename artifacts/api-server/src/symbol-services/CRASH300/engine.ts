import type { CoordinatorOutput, EngineResult } from "../../core/engineTypes.js";
import type { FeatureVector } from "../../core/features.js";
import type { LiveCalibrationProfile } from "../../core/calibration/liveCalibrationProfile.js";
import { inferRuntimeLeadInShape, selectRuntimeTpBucket } from "../../core/calibration/runtimeProfileUtils.js";
import { classifyRegimeFromSamples } from "../../core/regimeEngine.js";
import { assertValidCrash300RuntimeModel } from "./runtimeFeeddown.js";
import type { SymbolRuntimeContext } from "../shared/SymbolRuntimeContext.js";
import type { SymbolDecisionResult } from "../shared/SymbolDecisionResult.js";

const SYMBOL = "CRASH300";
const SERVICE = "crash300_service";

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asFeatureVector(v: unknown): FeatureVector | null {
  if (!v || typeof v !== "object") return null;
  const row = v as Record<string, unknown>;
  if (typeof row["symbol"] !== "string" || typeof row["latestClose"] !== "number") return null;
  return row as unknown as FeatureVector;
}

function asFeatureSamples(v: unknown): Array<{
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
}> {
  if (!Array.isArray(v)) return [];
  const out: Array<{
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
  }> = [];
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

function pickDirectionFromFeatures(features: FeatureVector, entryModel: string): "buy" | "sell" {
  const model = entryModel.toLowerCase();
  if (model.includes("short") || model.includes("down")) return "sell";
  if (model.includes("long") || model.includes("up")) return "buy";

  const sellBias =
    (features.emaSlope < 0 ? 1 : 0) +
    (features.priceVsEma20 < 0 ? 1 : 0) +
    (features.rsi14 < 48 ? 1 : 0) +
    (features.zScore < 0 ? 0.5 : 0) +
    (features.priceChange24hPct < 0 ? 0.5 : 0);
  const buyBias =
    (features.emaSlope > 0 ? 1 : 0) +
    (features.priceVsEma20 > 0 ? 1 : 0) +
    (features.rsi14 > 52 ? 1 : 0) +
    (features.zScore > 0 ? 0.5 : 0) +
    (features.priceChange24hPct > 0 ? 0.5 : 0);
  return sellBias >= buyBias ? "sell" : "buy";
}

function fitFromSignedSignal(
  direction: "buy" | "sell",
  value: number,
  scale: number,
): number {
  const signed = direction === "buy" ? value : -value;
  return clamp01(0.5 + signed / scale);
}

function computeComponentFits(direction: "buy" | "sell", features: FeatureVector): Record<string, number> {
  const spikePhaseFit = clamp01((features.spikeHazardScore + 1) / 2);
  const triggerWindowFit = fitFromSignedSignal(direction, features.emaSlope, 0.0012);
  const developmentWindowFit = fitFromSignedSignal(direction, features.priceVsEma20, 0.012);
  const runwayFit = clamp01(1 - Math.min(1, Math.abs(features.zScore) / 4));
  const lowDist = clamp01(Math.abs(features.distFromRange30dLowPct));
  const highDist = clamp01(Math.abs(features.distFromRange30dHighPct));
  const rangePositionFit = direction === "sell" ? clamp01(1 - lowDist) : clamp01(1 - highDist);
  const volatilityExpansionFit = clamp01(1 - Math.abs((features.atrRank ?? 0.5) - 0.5) * 1.4);
  return {
    spikePhaseFit: spikePhaseFit * 100,
    triggerWindowFit: triggerWindowFit * 100,
    developmentWindowFit: developmentWindowFit * 100,
    runwayFit: runwayFit * 100,
    rangePositionFit: rangePositionFit * 100,
    volatilityExpansionFit: volatilityExpansionFit * 100,
  };
}

function toRuntimeFamily(direction: "buy" | "sell", leadIn: string, features: FeatureVector): string {
  if (direction === "sell") {
    return features.spikeHazardScore > 0.45 ? "crash_event_down" : "failed_recovery_short";
  }
  if (leadIn === "trending") return "drift_continuation_up";
  return "post_crash_recovery_up";
}

function resolveRuntimeEvidence(params: {
  runtimeModel: LiveCalibrationProfile;
  features: FeatureVector;
  operationalRegime: string;
  regimeConfidence: number;
}): {
  direction: "buy" | "sell";
  selectedRuntimeFamily: string;
  selectedBucket: string;
  setupMatch: number;
  confidence: number;
  expectedMovePct: number;
  qualityTier: "A" | "B" | "C";
  failReasons: string[];
  componentScores: Record<string, number>;
} {
  const direction = pickDirectionFromFeatures(params.features, String(params.runtimeModel.entryModel ?? "all"));
  const leadIn = inferRuntimeLeadInShape(params.features);
  const componentScores = computeComponentFits(direction, params.features);
  const avgFit = Object.values(componentScores).reduce((sum, v) => sum + v, 0) / Math.max(1, Object.keys(componentScores).length);
  const qualityTier = avgFit >= 75 ? "A" : avgFit >= 55 ? "B" : "C";
  const bucket = selectRuntimeTpBucket({
    runtimeCalibration: params.runtimeModel,
    direction,
    nativeScore: avgFit,
    leadInShape: leadIn,
    features: params.features,
  });

  const failReasons: string[] = [];
  if (!bucket.key || !bucket.targetPct) {
    failReasons.push(`runtime_no_calibrated_bucket:${direction === "buy" ? "up" : "down"}|${leadIn}|${qualityTier}`);
  }

  const setupThreshold = Number(params.runtimeModel.recommendedScoreGates?.paper ?? 60);
  const setupMatch = clamp01(avgFit / 100);
  if (avgFit < setupThreshold) {
    const weak = Object.entries(componentScores)
      .filter(([, score]) => score < setupThreshold)
      .map(([key, score]) => `${key}:${Math.round(score)}<${Math.round(setupThreshold)}`);
    failReasons.push(`runtime_calibrated_setup_weak:${weak.join(",")}`);
  }

  const confidence = clamp01((setupMatch * 0.75) + (clamp01(params.regimeConfidence) * 0.25));
  const selectedRuntimeFamily = toRuntimeFamily(direction, leadIn, params.features);
  return {
    direction,
    selectedRuntimeFamily,
    selectedBucket: bucket.key ?? "unknown",
    setupMatch,
    confidence,
    expectedMovePct: (bucket.targetPct ?? 0) / 100,
    qualityTier,
    failReasons,
    componentScores,
  };
}

function buildWinnerFromDecision(params: {
  decision: SymbolDecisionResult;
  expectedMovePct: number;
  componentScores: Record<string, number>;
  runtimeModel: LiveCalibrationProfile;
}): EngineResult {
  const direction = params.decision.direction ?? "sell";
  const metadata = asRecord(params.decision.evidence);
  return {
    valid: params.decision.valid,
    symbol: SYMBOL,
    engineName: direction === "sell" ? "crash300_runtime_short_engine" : "crash300_runtime_long_engine",
    direction,
    confidence: params.decision.confidence,
    regimeFit: params.decision.setupMatch,
    entryType: "expansion",
    projectedMovePct: Math.max(0, params.expectedMovePct),
    invalidation: 0.02,
    reason: params.decision.valid
      ? "runtime_model_evidence_matched"
      : params.decision.failReasons.join(",") || "runtime_model_evidence_rejected",
    metadata: {
      ...metadata,
      crash300ScoringSource: "promoted_calibrated_runtime_model",
      crash300CalibratedRuntimeScore: Math.round(params.decision.confidence * 100),
      runtimeModelRunId: params.runtimeModel.sourceRunId,
      promotedModelRunId: params.runtimeModel.sourceRunId,
      componentScores: params.componentScores,
      calibratedComponentScores: params.componentScores,
      symbolServiceDecision: params.decision,
    },
  };
}

export function coordinatorFromCrash300Decision(
  decision: SymbolDecisionResult,
  runtimeModel: LiveCalibrationProfile,
  expectedMovePct: number,
  componentScores: Record<string, number>,
): { engineResults: EngineResult[]; coordinatorOutput: CoordinatorOutput | null } {
  if (!decision.direction || !decision.valid) return { engineResults: [], coordinatorOutput: null };
  const winner = buildWinnerFromDecision({ decision, expectedMovePct, componentScores, runtimeModel });
  return {
    engineResults: [winner],
    coordinatorOutput: {
      symbol: SYMBOL,
      winner,
      all: [winner],
      suppressedEngines: [],
      conflictResolution: "symbol_service_runtime_model",
      resolvedDirection: winner.direction,
      coordinatorConfidence: decision.confidence,
    },
  };
}

export async function evaluateCrash300Runtime(
  context: SymbolRuntimeContext,
): Promise<SymbolDecisionResult> {
  const runtimeCalibration = assertValidCrash300RuntimeModel(
    (context.runtimeModel ?? null) as LiveCalibrationProfile | null,
  );
  if (runtimeCalibration.source !== "promoted_symbol_model") {
    throw new Error("CRASH300 runtime model missing/invalid. Cannot evaluate symbol service.");
  }

  const features = asFeatureVector(asRecord(context.marketState)["features"]);
  if (!features) {
    return {
      symbol: SYMBOL,
      serviceName: SERVICE,
      valid: false,
      direction: null,
      confidence: 0,
      qualityTier: "unknown",
      setupFamily: "failed_recovery_short",
      moveBucket: "unknown",
      setupMatch: 0,
      evidence: {
        runtimeModelSource: runtimeCalibration.source,
      },
      featureSnapshot: {},
      failReasons: ["runtime_feature_context_missing"],
    };
  }

  const featureHistory = asFeatureSamples(asRecord(context.marketState)["featureHistory"]);
  const regime = classifyRegimeFromSamples(features, featureHistory);
  const runtimeEvidence = resolveRuntimeEvidence({
    runtimeModel: runtimeCalibration,
    features,
    operationalRegime: regime.regime,
    regimeConfidence: regime.confidence,
  });
  const valid = runtimeEvidence.failReasons.length === 0;
  const slModel = asRecord(runtimeCalibration.slModel);
  const trailingModel = asRecord(runtimeCalibration.trailingModel);
  return {
    symbol: SYMBOL,
    serviceName: SERVICE,
    valid,
    direction: runtimeEvidence.direction,
    confidence: runtimeEvidence.confidence,
    qualityTier: runtimeEvidence.qualityTier,
    setupFamily: runtimeEvidence.selectedRuntimeFamily,
    moveBucket: runtimeEvidence.selectedBucket,
    setupMatch: runtimeEvidence.setupMatch,
    evidence: {
      runtimeModelRunId: runtimeCalibration.sourceRunId,
      promotedModelRunId: runtimeCalibration.sourceRunId,
      selectedRuntimeFamily: runtimeEvidence.selectedRuntimeFamily,
      selectedBucket: runtimeEvidence.selectedBucket,
      leadInShape: inferRuntimeLeadInShape(features),
      setupMatch: runtimeEvidence.setupMatch,
      expectedMovePct: runtimeEvidence.expectedMovePct,
      slRiskPct: Number(slModel["maxInitialRiskPct"] ?? 0) / 100,
      trailingActivationPct: Number(trailingModel["activationProfitPct"] ?? 0) / 100,
      trailingDistancePct: Number(trailingModel["trailingDistancePct"] ?? 0) / 100,
      trailingMinHoldMinutes: Number(trailingModel["minHoldMinutesBeforeTrail"] ?? 0),
      expectedHoldWindow: runtimeCalibration.confirmationWindow,
      componentScores: runtimeEvidence.componentScores,
      failReasons: runtimeEvidence.failReasons,
      generatedAt: new Date().toISOString(),
      featureSnapshot: {
        latestClose: features.latestClose,
        emaSlope: features.emaSlope,
        priceVsEma20: features.priceVsEma20,
        atrRank: features.atrRank,
        zScore: features.zScore,
        distFromRange30dLowPct: features.distFromRange30dLowPct,
        distFromRange30dHighPct: features.distFromRange30dHighPct,
      },
      operationalRegime: regime.regime,
      regimeConfidence: regime.confidence,
    },
    featureSnapshot: {
      latestClose: features.latestClose,
      emaSlope: features.emaSlope,
      priceVsEma20: features.priceVsEma20,
      atrRank: features.atrRank,
      zScore: features.zScore,
      distFromRange30dLowPct: features.distFromRange30dLowPct,
      distFromRange30dHighPct: features.distFromRange30dHighPct,
      spikeHazardScore: features.spikeHazardScore,
      bbWidth: features.bbWidth,
      bbWidthRoc: features.bbWidthRoc,
      rsi14: features.rsi14,
      priceChange24hPct: features.priceChange24hPct,
    },
    failReasons: runtimeEvidence.failReasons,
  };
}
