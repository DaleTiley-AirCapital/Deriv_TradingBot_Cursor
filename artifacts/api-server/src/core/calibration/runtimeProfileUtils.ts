import type { EngineResult } from "../engineTypes.js";
import type { FeatureVector } from "../features.js";
import type { LiveCalibrationProfile } from "./liveCalibrationProfile.js";

export type RuntimeLeadInShape = "expanding" | "compressing" | "ranging" | "trending" | "all";
export type RuntimeQualityBand = "A" | "B" | "C";

export interface RuntimeTpBucketSelection {
  key: string | null;
  targetPct: number | null;
  bucketCount: number;
  leadInShape: RuntimeLeadInShape;
  qualityBand: RuntimeQualityBand;
}

export interface RuntimeEntryEvidenceResult {
  allowed: boolean;
  reason: string;
  leadInShape: RuntimeLeadInShape;
  qualityBand: RuntimeQualityBand;
  matchedBucketKey: string | null;
  evidenceScore: number;
  weakComponents: string[];
}

export function asPlainRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asFiniteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function inferRuntimeLeadInShape(features?: FeatureVector | null): RuntimeLeadInShape {
  if (!features) return "all";
  const emaSlope = Math.abs(features.emaSlope ?? 0);
  const priceChange7dPct = Math.abs(features.priceChange7dPct ?? 0);
  const bbWidthRoc = features.bbWidthRoc ?? 0;
  const atrAccel = features.atrAccel ?? 0;
  const atrRank = features.atrRank ?? 0.5;
  const bbWidth = features.bbWidth ?? 0;

  if (emaSlope >= 0.00035 || priceChange7dPct >= 0.08) return "trending";
  if (bbWidthRoc > 0 || atrAccel > 0 || atrRank >= 0.75) return "expanding";
  if (bbWidth > 0 && (bbWidth <= 0.006 || atrRank <= 0.35)) return "compressing";
  return "ranging";
}

export function scoreToRuntimeQualityBand(score?: number | null): RuntimeQualityBand {
  const s = Number(score ?? NaN);
  if (Number.isFinite(s) && s >= 70) return "A";
  if (Number.isFinite(s) && s >= 50) return "B";
  return "C";
}

export function normalizeRuntimeLeadInShape(
  value: unknown,
  features?: FeatureVector | null,
): RuntimeLeadInShape {
  const v = String(value ?? "").toLowerCase();
  if (v === "expanding" || v === "compressing" || v === "ranging" || v === "trending") return v;
  return inferRuntimeLeadInShape(features);
}

export function selectRuntimeTpBucket(params: {
  runtimeCalibration: LiveCalibrationProfile;
  direction: "buy" | "sell";
  nativeScore?: number | null;
  leadInShape?: string | null;
  features?: FeatureVector | null;
}): RuntimeTpBucketSelection {
  const tpModel = asPlainRecord(params.runtimeCalibration.tpModel);
  const buckets = asPlainRecord(tpModel.buckets);
  const directionKey = params.direction === "buy" ? "up" : "down";
  const leadInShape = normalizeRuntimeLeadInShape(params.leadInShape, params.features);
  const qualityBand = scoreToRuntimeQualityBand(params.nativeScore);
  const bucketCount = Object.keys(buckets).length;

  const candidateKeys = [
    `${directionKey}|${leadInShape}|${qualityBand}`,
    `${directionKey}|${leadInShape}|all`,
    `${directionKey}|all|${qualityBand}`,
    `${directionKey}|all|all`,
    `all|${leadInShape}|${qualityBand}`,
    `all|${leadInShape}|all`,
    `all|all|${qualityBand}`,
    "all|all|all",
  ];

  for (const key of candidateKeys) {
    const bucket = asPlainRecord(buckets[key]);
    const targetPct = asFiniteNumber(bucket.targetPct);
    if (targetPct && targetPct > 0) {
      return { key, targetPct, bucketCount, leadInShape, qualityBand };
    }
  }

  return { key: null, targetPct: null, bucketCount, leadInShape, qualityBand };
}

export function selectRuntimeTpTargetPct(params: {
  runtimeCalibration: LiveCalibrationProfile;
  direction: "buy" | "sell";
  fallbackTargetPct: number;
  nativeScore?: number | null;
  leadInShape?: string | null;
  features?: FeatureVector | null;
}): number {
  const tpModel = asPlainRecord(params.runtimeCalibration.tpModel);
  const fallbackFromModel = asFiniteNumber(tpModel.fallbackTargetPct);
  const baseTargetPct = params.fallbackTargetPct > 0
    ? params.fallbackTargetPct
    : Math.max(0, fallbackFromModel ?? 0);
  const selected = selectRuntimeTpBucket(params);

  if (!selected.targetPct) return baseTargetPct;
  if (baseTargetPct <= 0) return Math.max(1, Math.min(30, selected.targetPct));

  const minPct = Math.max(1, baseTargetPct * 0.75);
  const maxPct = Math.min(30, baseTargetPct * 1.75);
  return Math.max(minPct, Math.min(maxPct, selected.targetPct));
}

function calibratedComponentScore(winner: EngineResult, key: string): number | null {
  const components = asPlainRecord(winner.metadata?.["calibratedComponentScores"]);
  return asFiniteNumber(components[key]);
}

function runtimeFormula(params: { runtimeCalibration?: LiveCalibrationProfile | null }): Record<string, unknown> {
  return asPlainRecord(params.runtimeCalibration?.formulaOverride);
}

function runtimeNumber(source: Record<string, unknown>, key: string): number | null {
  return asFiniteNumber(source[key]);
}

function engineRuntimeSetupOverride(
  formula: Record<string, unknown>,
  engineName: string,
): Record<string, unknown> {
  const runtimeSetup = asPlainRecord(formula["runtimeSetup"]);
  const r75RuntimeSetup = asPlainRecord(formula["r75RuntimeSetup"]);
  const engines = asPlainRecord(formula["engines"]);
  const engineOverride = asPlainRecord(engines[engineName]);
  return {
    ...runtimeSetup,
    ...r75RuntimeSetup,
    ...engineOverride,
  };
}

export function evaluateRuntimeEntryEvidence(params: {
  symbol: string;
  direction: "buy" | "sell";
  nativeScore: number;
  winner: EngineResult;
  features: FeatureVector;
  runtimeCalibration?: LiveCalibrationProfile | null;
  allowedQualityBands?: RuntimeQualityBand[] | null;
}): RuntimeEntryEvidenceResult {
  const leadInShape = inferRuntimeLeadInShape(params.features);
  const qualityBand = scoreToRuntimeQualityBand(params.nativeScore);

  if (!params.runtimeCalibration || params.runtimeCalibration.source !== "promoted_symbol_model") {
    return {
      allowed: true,
      reason: "native_runtime_not_applied",
      leadInShape,
      qualityBand,
      matchedBucketKey: null,
      evidenceScore: params.nativeScore,
      weakComponents: [],
    };
  }

  if (params.allowedQualityBands?.length && !params.allowedQualityBands.includes(qualityBand)) {
    return {
      allowed: false,
      reason: `runtime_quality_band_filtered:${qualityBand}`,
      leadInShape,
      qualityBand,
      matchedBucketKey: null,
      evidenceScore: 0,
      weakComponents: [`quality_band:${qualityBand}`],
    };
  }

  const selectedBucket = selectRuntimeTpBucket({
    runtimeCalibration: params.runtimeCalibration,
    direction: params.direction,
    nativeScore: params.nativeScore,
    features: params.features,
  });

  if (selectedBucket.bucketCount === 0) {
    return {
      allowed: false,
      reason: "runtime_tp_buckets_missing_restage_promote_required",
      leadInShape,
      qualityBand,
      matchedBucketKey: null,
      evidenceScore: 0,
      weakComponents: ["tp_buckets"],
    };
  }

  if (!selectedBucket.key) {
    return {
      allowed: false,
      reason: `runtime_no_calibrated_bucket:${params.direction}|${leadInShape}|${qualityBand}`,
      leadInShape,
      qualityBand,
      matchedBucketKey: null,
      evidenceScore: 0,
      weakComponents: ["bucket_match"],
    };
  }

  // CRASH300 is now calibrated from move windows, so require the actual
  // calibrated setup components to be present before a watched window can mature.
  if (params.symbol === "CRASH300") {
    const scoringSource = String(params.winner.metadata?.["crash300ScoringSource"] ?? "");
    if (scoringSource !== "promoted_calibrated_runtime_model") {
      return {
        allowed: false,
        reason: "runtime_crash300_promoted_scoring_not_applied",
        leadInShape,
        qualityBand,
        matchedBucketKey: selectedBucket.key,
        evidenceScore: 0,
        weakComponents: ["scoring_source"],
      };
    }

    const thresholds: Record<string, number> = {
      spikePhaseFit: 58,
      rangePositionFit: 55,
      developmentWindowFit: 60,
      triggerWindowFit: 60,
      volatilityExpansionFit: 45,
      runwayFit: 58,
    };
    const scored = Object.entries(thresholds).map(([key, min]) => ({
      key,
      min,
      value: calibratedComponentScore(params.winner, key),
    }));
    const weakComponents = scored
      .filter(({ value, min }) => value == null || value < min)
      .map(({ key, value, min }) => `${key}:${value ?? "missing"}<${min}`);

    if (weakComponents.length > 0) {
      return {
        allowed: false,
        reason: `runtime_calibrated_setup_weak:${weakComponents.join(",")}`,
        leadInShape,
        qualityBand,
        matchedBucketKey: selectedBucket.key,
        evidenceScore: 0,
        weakComponents,
      };
    }

    const evidenceScore = scored.reduce((sum, item) => sum + (item.value ?? 0), 0) / scored.length;
    return {
      allowed: true,
      reason: `runtime_calibrated_setup_matched:${selectedBucket.key}`,
      leadInShape,
      qualityBand,
      matchedBucketKey: selectedBucket.key,
      evidenceScore,
      weakComponents: [],
    };
  }

  if (params.symbol === "R_75") {
    const components = asPlainRecord(params.winner.metadata?.["componentScores"]);
    const engineName = params.winner.engineName;
    const formula = runtimeFormula(params);
    const setupOverride = engineRuntimeSetupOverride(formula, engineName);
    const minNativeScore = runtimeNumber(setupOverride, "minNativeScore");
    const minConfidence = runtimeNumber(setupOverride, "minConfidence");
    const minExpectedMovePct = runtimeNumber(setupOverride, "minExpectedMovePct");
    const expectedMovePct = asFiniteNumber(params.winner.metadata?.["expectedMovePct"])
      ?? asFiniteNumber(params.winner.projectedMovePct)
      ?? 0;
    const confidence = asFiniteNumber(params.winner.confidence) ?? 0;
    const gateWeakComponents = [
      ...(minNativeScore != null && params.nativeScore < minNativeScore
        ? [`nativeScore:${params.nativeScore}<${minNativeScore}`]
        : []),
      ...(minConfidence != null && confidence < minConfidence
        ? [`confidence:${Number(confidence.toFixed(3))}<${minConfidence}`]
        : []),
      ...(minExpectedMovePct != null && expectedMovePct < minExpectedMovePct
        ? [`expectedMovePct:${Number(expectedMovePct.toFixed(4))}<${minExpectedMovePct}`]
        : []),
    ];
    if (gateWeakComponents.length > 0) {
      return {
        allowed: false,
        reason: `runtime_r75_promoted_setup_weak:${gateWeakComponents.join(",")}`,
        leadInShape,
        qualityBand,
        matchedBucketKey: selectedBucket.key,
        evidenceScore: 0,
        weakComponents: gateWeakComponents,
      };
    }

    const componentGateMode = String(setupOverride["componentGateMode"] ?? "strict_components");
    const configuredComponentThresholds = asPlainRecord(setupOverride["componentThresholds"]);
    const thresholds: Record<string, number> = Object.keys(configuredComponentThresholds).length > 0
      ? Object.fromEntries(Object.entries(configuredComponentThresholds)
          .map(([key, value]) => [key, Number(value)])
          .filter(([, value]) => Number.isFinite(value))) as Record<string, number>
      : componentGateMode === "build_selected_rules"
        ? {}
        :
      engineName === "r75_reversal_engine"
        ? {
            rangeExtremity: 55,
            reversalConfirmation: 55,
            stretchDeviationQuality: 55,
            structureQuality: 55,
            entryEfficiency: 55,
            expectedMoveSufficiency: 55,
          }
        : engineName === "r75_breakout_engine"
          ? {
              boundaryPressure: 55,
              breakStrength: 55,
              expansionQuality: 55,
              retestAcceptanceQuality: 55,
              entryEfficiency: 55,
              expectedMoveSufficiency: 55,
            }
          : engineName === "r75_continuation_engine"
            ? {
                trendQuality: 55,
                pullbackQuality: 55,
                slopeAlignment: 55,
                structureContinuity: 55,
                entryEfficiency: 55,
                expectedMoveSufficiency: 55,
          }
        : {};

    const scored = Object.entries(thresholds).map(([key, min]) => ({
      key,
      min,
      value: asFiniteNumber(components[key]),
    }));
    const weakComponents = scored
      .filter(({ value, min }) => value == null || value < min)
      .map(({ key, value, min }) => `${key}:${value ?? "missing"}<${min}`);

    if (weakComponents.length > 0) {
      return {
        allowed: false,
        reason: `runtime_r75_promoted_setup_weak:${weakComponents.join(",")}`,
        leadInShape,
        qualityBand,
        matchedBucketKey: selectedBucket.key,
        evidenceScore: 0,
        weakComponents,
      };
    }

    const evidenceScore = scored.length > 0
      ? scored.reduce((sum, item) => sum + (item.value ?? 0), 0) / scored.length
      : Math.max(params.nativeScore, confidence * 100);

    return {
      allowed: true,
      reason: `runtime_r75_promoted_setup_matched:${engineName}:${selectedBucket.key}`,
      leadInShape,
      qualityBand,
      matchedBucketKey: selectedBucket.key,
      evidenceScore,
      weakComponents: [],
    };
  }

  return {
    allowed: true,
    reason: `runtime_bucket_matched:${selectedBucket.key}`,
    leadInShape,
    qualityBand,
    matchedBucketKey: selectedBucket.key,
    evidenceScore: params.nativeScore,
    weakComponents: [],
  };
}
