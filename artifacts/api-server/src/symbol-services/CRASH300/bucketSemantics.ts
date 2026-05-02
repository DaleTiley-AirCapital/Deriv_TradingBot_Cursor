import type { LiveCalibrationProfile } from "../../core/calibration/liveCalibrationProfile.js";
import { asFiniteNumber, asPlainRecord, scoreToRuntimeQualityBand } from "../../core/calibration/runtimeProfileUtils.js";
import type {
  Crash300ContextSnapshot,
  Crash300MoveSizeBucket,
  Crash300PhaseBucketContext,
  Crash300PhaseDerivedBucket,
  Crash300PhaseDerivedFamily,
  Crash300SemanticTriggerSnapshot,
} from "./features.js";

export interface Crash300RuntimeBucketResolution {
  phaseDerivedBucket: Crash300PhaseDerivedBucket;
  runtimeModelBucketKey: string;
  targetPct: number;
  bucketSource: "phase-derived-exact" | "phase-derived-compatibility-map";
  qualityBand: "A" | "B" | "C";
}

function directionFromFamily(family: Crash300PhaseDerivedFamily): "up" | "down" | "unknown" {
  if (
    family === "drift_continuation_up" ||
    family === "post_crash_recovery_up" ||
    family === "bear_trap_reversal_up"
  ) {
    return "up";
  }
  if (
    family === "failed_recovery_short" ||
    family === "crash_event_down" ||
    family === "bull_trap_reversal_down"
  ) {
    return "down";
  }
  return "unknown";
}

function bucketContextFromFamily(
  family: Crash300PhaseDerivedFamily,
  trigger: Crash300SemanticTriggerSnapshot,
): Crash300PhaseBucketContext {
  if (trigger.triggerTransition === "compression_break_up" || trigger.triggerTransition === "compression_break_down") {
    return "compression";
  }
  if (family === "post_crash_recovery_up") return "recovery";
  if (family === "failed_recovery_short") return "failed_recovery";
  if (family === "crash_event_down") return "crash_event";
  if (family === "bear_trap_reversal_up" || family === "bull_trap_reversal_down") return "reversal";
  return "trending";
}

export function deriveCrash300RuntimeBucket(params: {
  moveDirection?: "up" | "down" | "unknown";
  family: Crash300PhaseDerivedFamily;
  trigger: Crash300SemanticTriggerSnapshot;
  moveSizeBucket: Crash300MoveSizeBucket;
}): Crash300PhaseDerivedBucket {
  const direction = params.moveDirection === "unknown" || params.moveDirection == null
    ? directionFromFamily(params.family)
    : params.moveDirection;
  const safeDirection = direction === "down" ? "down" : "up";
  const context = bucketContextFromFamily(params.family, params.trigger);
  return `${safeDirection}|${context}|${params.moveSizeBucket}`;
}

function contextCompatibilityOrder(context: Crash300PhaseBucketContext): string[] {
  switch (context) {
    case "trending":
      return ["trending", "expanding", "all"];
    case "recovery":
      return ["ranging", "compressing", "trending", "all"];
    case "compression":
      return ["compressing", "expanding", "all"];
    case "failed_recovery":
      return ["expanding", "ranging", "all"];
    case "crash_event":
      return ["expanding", "trending", "all"];
    case "reversal":
      return ["ranging", "expanding", "compressing", "all"];
    default:
      return ["all"];
  }
}

function parsePhaseBucket(bucket: Crash300PhaseDerivedBucket): {
  direction: "up" | "down";
  context: Crash300PhaseBucketContext;
} {
  const [direction, context] = bucket.split("|");
  return {
    direction: direction === "down" ? "down" : "up",
    context: (context as Crash300PhaseBucketContext) ?? "trending",
  };
}

export function resolveCrash300RuntimeBucket(params: {
  runtimeCalibration: LiveCalibrationProfile;
  phaseDerivedBucket: Crash300PhaseDerivedBucket;
  context: Crash300ContextSnapshot;
  trigger: Crash300SemanticTriggerSnapshot;
  qualityScore: number;
}): Crash300RuntimeBucketResolution | null {
  const tpModel = asPlainRecord(params.runtimeCalibration.tpModel);
  const buckets = asPlainRecord(tpModel.buckets);
  const exact = asPlainRecord(buckets[params.phaseDerivedBucket]);
  const exactTargetPct = asFiniteNumber(exact.targetPct);
  if (exactTargetPct && exactTargetPct > 0) {
    return {
      phaseDerivedBucket: params.phaseDerivedBucket,
      runtimeModelBucketKey: params.phaseDerivedBucket,
      targetPct: exactTargetPct,
      bucketSource: "phase-derived-exact",
      qualityBand: scoreToRuntimeQualityBand(params.qualityScore),
    };
  }

  const { direction, context } = parsePhaseBucket(params.phaseDerivedBucket);
  const qualityBand = scoreToRuntimeQualityBand(params.qualityScore);
  const leadIns = contextCompatibilityOrder(context);
  const candidateKeys = [
    ...leadIns.flatMap((leadIn) => [
      `${direction}|${leadIn}|${qualityBand}`,
      `${direction}|${leadIn}|all`,
    ]),
    `${direction}|all|${qualityBand}`,
    `${direction}|all|all`,
    `all|all|${qualityBand}`,
    "all|all|all",
  ];

  for (const key of candidateKeys) {
    const bucket = asPlainRecord(buckets[key]);
    const targetPct = asFiniteNumber(bucket.targetPct);
    if (targetPct && targetPct > 0) {
      return {
        phaseDerivedBucket: params.phaseDerivedBucket,
        runtimeModelBucketKey: key,
        targetPct,
        bucketSource: "phase-derived-compatibility-map",
        qualityBand,
      };
    }
  }

  return null;
}

export function resolveCrash300RuntimeBucketForFamily(params: {
  runtimeCalibration: LiveCalibrationProfile;
  family: Crash300PhaseDerivedFamily;
  context: Crash300ContextSnapshot;
  trigger: Crash300SemanticTriggerSnapshot;
  qualityScore: number;
  moveDirection?: "up" | "down" | "unknown";
}): Crash300RuntimeBucketResolution | null {
  const tpModel = asPlainRecord(params.runtimeCalibration.tpModel);
  const buckets = asPlainRecord(tpModel.buckets);
  const direction = params.trigger.triggerDirection === "sell" ? "down" : "up";
  const contextKey = bucketContextFromFamily(params.family, params.trigger);
  const qualityBand = scoreToRuntimeQualityBand(params.qualityScore);
  const leadIns = contextCompatibilityOrder(contextKey);
  const candidateKeys = [
    ...leadIns.flatMap((leadIn) => [
      `${direction}|${leadIn}|${qualityBand}`,
      `${direction}|${leadIn}|all`,
    ]),
    `${direction}|all|${qualityBand}`,
    `${direction}|all|all`,
    `all|all|${qualityBand}`,
    "all|all|all",
  ];

  for (const key of candidateKeys) {
    const bucket = asPlainRecord(buckets[key]);
    const targetPct = asFiniteNumber(bucket.targetPct);
    if (targetPct && targetPct > 0) {
      const phaseBucket = deriveCrash300RuntimeBucket({
        moveDirection: params.moveDirection ?? direction,
        family: params.family,
        trigger: params.trigger,
        moveSizeBucket: targetPct < 6 ? "5_to_6_pct" : targetPct < 8 ? "6_to_8_pct" : targetPct < 10 ? "8_to_10_pct" : "10_plus_pct",
      });
      return {
        phaseDerivedBucket: phaseBucket,
        runtimeModelBucketKey: key,
        targetPct,
        bucketSource: "phase-derived-compatibility-map",
        qualityBand,
      };
    }
  }

  return null;
}
