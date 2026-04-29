import type { CoordinatorOutput, EngineResult } from "../../core/engineTypes.js";
import type { FeatureVector } from "../../core/features.js";
import type { LiveCalibrationProfile } from "../../core/calibration/liveCalibrationProfile.js";
import { inferRuntimeLeadInShape, selectRuntimeTpBucket } from "../../core/calibration/runtimeProfileUtils.js";
import type { CandleRow } from "../../core/backtest/featureSlice.js";
import { assertValidCrash300RuntimeModel } from "./runtimeFeeddown.js";
import type { SymbolRuntimeContext } from "../shared/SymbolRuntimeContext.js";
import type { SymbolDecisionResult } from "../shared/SymbolDecisionResult.js";
import {
  type Crash300ContextSnapshot,
  type Crash300EpochState,
  type Crash300FamilyCandidate,
  type Crash300RuntimeFamily,
  type Crash300RuntimeState,
  type Crash300TriggerSnapshot,
} from "./features.js";
import { buildCrash300ContextSnapshot } from "./context.js";
import { buildCrash300TriggerSnapshot } from "./trigger.js";

const SYMBOL = "CRASH300";
const SERVICE = "crash300_service";

type DetectedMoveDiagnostic = {
  id: number;
  startTs: number;
  endTs: number;
  direction: "up" | "down" | "unknown";
  movePct?: number | null;
  startPrice?: number | null;
  endPrice?: number | null;
};

const liveRuntimeStateBySymbol = new Map<string, Crash300RuntimeState>();

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

function asCandles(v: unknown): CandleRow[] {
  if (!Array.isArray(v)) return [];
  const out: CandleRow[] = [];
  for (const row of v) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (
      typeof r["open"] === "number" &&
      typeof r["high"] === "number" &&
      typeof r["low"] === "number" &&
      typeof r["close"] === "number" &&
      typeof r["openTs"] === "number" &&
      typeof r["closeTs"] === "number"
    ) {
      out.push({
        open: r["open"],
        high: r["high"],
        low: r["low"],
        close: r["close"],
        openTs: r["openTs"],
        closeTs: r["closeTs"],
      });
    }
  }
  return out;
}

function asDetectedMoves(v: unknown): DetectedMoveDiagnostic[] {
  if (!Array.isArray(v)) return [];
  const out: DetectedMoveDiagnostic[] = [];
  for (const row of v) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    out.push({
      id: Number(r["id"] ?? 0),
      startTs: Number(r["startTs"] ?? 0),
      endTs: Number(r["endTs"] ?? 0),
      direction: r["direction"] === "up" || r["direction"] === "down" ? r["direction"] : "unknown",
      movePct: Number.isFinite(Number(r["movePct"])) ? Number(r["movePct"]) : null,
      startPrice: Number.isFinite(Number(r["startPrice"])) ? Number(r["startPrice"]) : null,
      endPrice: Number.isFinite(Number(r["endPrice"])) ? Number(r["endPrice"]) : null,
    });
  }
  return out.filter((move) => Number.isFinite(move.startTs) && move.startTs > 0);
}

function getRuntimeState(context: SymbolRuntimeContext): Crash300RuntimeState {
  const marketState = asRecord(context.marketState);
  const supplied = marketState["runtimeState"];
  if (supplied && typeof supplied === "object" && !Array.isArray(supplied)) {
    return supplied as Crash300RuntimeState;
  }
  const key = `${context.symbol}:${context.mode}`;
  let state = liveRuntimeStateBySymbol.get(key);
  if (!state) {
    state = {
      currentEpoch: null,
      previousEpochId: null,
      lastValidTriggerTs: null,
      lastValidTriggerDirection: null,
      lastValidTriggerStrength: null,
    };
    liveRuntimeStateBySymbol.set(key, state);
  }
  return state;
}

function leadInShapeFromContext(context: Crash300ContextSnapshot): "expanding" | "compressing" | "ranging" | "trending" | "all" {
  if (context.compressionToExpansionScore > 0.65 && context.rangeExpansionScore15 > 0.55) return "expanding";
  if (context.rangeCompressionScore60 > 0.6) return "compressing";
  if (context.trendPersistenceScore > 0.6) return "trending";
  return "ranging";
}

function buildFamilyCandidates(context: Crash300ContextSnapshot): Crash300FamilyCandidate[] {
  const trendStrength = clamp01(context.trendPersistenceScore);
  const crashRecent = clamp01(context.crashRecencyScore);
  const recoveryQuality = clamp01(context.recoveryQualityScore);
  const compressionToExpansion = clamp01(context.compressionToExpansionScore);
  const priceOffCrashLow = clamp01((context.priceDistanceFromLastCrashLowPct ?? 0) / 0.08);
  const failedRecoveryPressure = clamp01(
    (context.recoveryPullbackDepthPct / 0.03) * 0.4 +
      clamp01(context.recoveryFailedBreakCount60 / 8) * 0.35 +
      clamp01((0.55 - recoveryQuality) / 0.55) * 0.25,
  );
  const activeCrashPressure = clamp01(
    crashRecent * 0.4 +
      clamp01((context.lastCrashVelocityPctPerBar ?? 0) / 0.01) * 0.35 +
      context.rangeExpansionScore15 * 0.25,
  );
  const leadInShape = leadInShapeFromContext(context);

  return [
    {
      family: "drift_continuation_up",
      direction: "buy",
      leadInShape,
      score: clamp01(
        trendStrength * 0.5 +
          compressionToExpansion * 0.25 +
          clamp01((context.priceVsEma20Pct + 0.02) / 0.05) * 0.15 +
          clamp01((context.positiveCloseRatio60 - 0.45) / 0.35) * 0.1,
      ),
      components: {
        trendPersistenceScore: trendStrength * 100,
        compressionToExpansionScore: compressionToExpansion * 100,
        priceVsEma20Pct: clamp01((context.priceVsEma20Pct + 0.02) / 0.05) * 100,
        positiveCloseRatio60: clamp01((context.positiveCloseRatio60 - 0.45) / 0.35) * 100,
      },
    },
    {
      family: "post_crash_recovery_up",
      direction: "buy",
      leadInShape,
      score: clamp01(
        crashRecent * 0.25 +
          recoveryQuality * 0.4 +
          priceOffCrashLow * 0.2 +
          clamp01((context.recoverySlope60 + 0.01) / 0.05) * 0.15,
      ),
      components: {
        crashRecencyScore: crashRecent * 100,
        recoveryQualityScore: recoveryQuality * 100,
        priceDistanceFromLastCrashLowPct: priceOffCrashLow * 100,
        recoverySlope60: clamp01((context.recoverySlope60 + 0.01) / 0.05) * 100,
      },
    },
    {
      family: "failed_recovery_short",
      direction: "sell",
      leadInShape,
      score: clamp01(
        crashRecent * 0.2 +
          failedRecoveryPressure * 0.45 +
          clamp01((0.02 - context.priceVsEma20Pct) / 0.04) * 0.2 +
          context.rangeExpansionScore15 * 0.15,
      ),
      components: {
        crashRecencyScore: crashRecent * 100,
        failedRecoveryPressure: failedRecoveryPressure * 100,
        priceVsEma20Pct: clamp01((0.02 - context.priceVsEma20Pct) / 0.04) * 100,
        rangeExpansionScore15: context.rangeExpansionScore15 * 100,
      },
    },
    {
      family: "crash_event_down",
      direction: "sell",
      leadInShape,
      score: clamp01(
        activeCrashPressure * 0.55 +
          clamp01((0.01 - context.priceVsEma20Pct) / 0.04) * 0.2 +
          clamp01((0.5 - context.priceVsEma50Pct) / 0.08) * 0.1 +
          context.rangeExpansionScore15 * 0.15,
      ),
      components: {
        activeCrashPressure: activeCrashPressure * 100,
        priceVsEma20Pct: clamp01((0.01 - context.priceVsEma20Pct) / 0.04) * 100,
        priceVsEma50Pct: clamp01((0.5 - context.priceVsEma50Pct) / 0.08) * 100,
        rangeExpansionScore15: context.rangeExpansionScore15 * 100,
      },
    },
  ];
}

function readFormulaNumber(model: LiveCalibrationProfile, keys: string[], fallback: number): number {
  const formula = model.formulaOverride && typeof model.formulaOverride === "object"
    ? (model.formulaOverride as Record<string, unknown>)
    : {};
  for (const key of keys) {
    const direct = Number(formula[key]);
    if (Number.isFinite(direct) && direct >= 0) return direct;
    const crash300 = formula["crash300"];
    if (crash300 && typeof crash300 === "object") {
      const nested = Number((crash300 as Record<string, unknown>)[key]);
      if (Number.isFinite(nested) && nested >= 0) return nested;
    }
  }
  return fallback;
}

function contextThreshold(model: LiveCalibrationProfile): number {
  const override = readFormulaNumber(model, ["contextMatchThreshold", "contextThreshold"], NaN);
  if (Number.isFinite(override) && override > 0 && override <= 1) return override;
  return clamp01(Number(model.recommendedScoreGates?.paper ?? 60) / 100);
}

function triggerThreshold(model: LiveCalibrationProfile): number {
  const override = readFormulaNumber(model, ["triggerStrengthThreshold", "triggerThreshold"], NaN);
  if (Number.isFinite(override) && override > 0 && override <= 1) return override;
  return clamp01(Number(model.recommendedScoreGates?.paper ?? 60) / 100);
}

function maxTriggerCarryBars(model: LiveCalibrationProfile): number {
  const override = readFormulaNumber(model, ["triggerCarryBars", "maxTriggerCarryBars"], 0);
  return Math.max(0, Math.min(1, Math.round(override)));
}

function maxContextAgeBars(model: LiveCalibrationProfile, context: Crash300ContextSnapshot): number {
  const override = readFormulaNumber(model, ["maxContextAgeBars"], NaN);
  if (Number.isFinite(override) && override > 0) return Math.round(override);
  const confirmationRaw = String(model.confirmationWindow ?? "60m").trim().toLowerCase();
  const match = confirmationRaw.match(/^(\d+(?:\.\d+)?)\s*(m|min|mins|h|hr|hrs|hour|hours)?$/);
  const minutes = match
    ? ((match[2] ?? "m").startsWith("h") ? Number(match[1]) * 60 : Number(match[1]))
    : 60;
  const derived = Math.round(Math.max(15, Math.min(240, minutes)));
  const crashAware = context.crashRecencyScore > 0.35 ? Math.min(derived, 60) : derived;
  return Math.max(15, crashAware);
}

function qualityTierFromScores(contextScore: number, triggerScore: number): "A" | "B" | "C" {
  const composite = (contextScore * 0.65 + triggerScore * 0.35) * 100;
  if (composite >= 80) return "A";
  if (composite >= 60) return "B";
  return "C";
}

function componentScores(
  context: Crash300ContextSnapshot,
  trigger: Crash300TriggerSnapshot,
  selectedFamily: Crash300RuntimeFamily,
): Record<string, number> {
  return {
    spikePhaseFit: Math.round(context.crashRecencyScore * 100),
    developmentWindowFit: Math.round(
      (selectedFamily === "drift_continuation_up"
        ? context.trendPersistenceScore
        : context.recoveryQualityScore) * 100,
    ),
    runwayFit: Math.round(context.compressionToExpansionScore * 100),
    triggerWindowFit: Math.round(trigger.triggerStrengthScore * 100),
  };
}

function createEpochId(params: {
  family: Crash300RuntimeFamily;
  bucket: string;
  direction: "buy" | "sell";
  anchorTs: number;
}): string {
  return `${params.family}|${params.bucket}|${params.direction}|${params.anchorTs}`;
}

function resolveEpochAnchorTs(context: Crash300ContextSnapshot, ts: number, family: Crash300RuntimeFamily): number {
  if (
    (family === "post_crash_recovery_up" || family === "failed_recovery_short" || family === "crash_event_down") &&
    context.lastCrashTs
  ) {
    return context.lastCrashTs;
  }
  return ts;
}

function ensureEpoch(
  runtimeState: Crash300RuntimeState,
  ts: number,
  family: Crash300RuntimeFamily,
  bucket: string,
  direction: "buy" | "sell",
  anchorTs: number,
): Crash300EpochState {
  const nextId = createEpochId({ family, bucket, direction, anchorTs });
  if (
    !runtimeState.currentEpoch ||
    runtimeState.currentEpoch.epochId !== nextId
  ) {
    if (runtimeState.currentEpoch) {
      runtimeState.previousEpochId = runtimeState.currentEpoch.epochId;
    }
    runtimeState.currentEpoch = {
      epochId: nextId,
      family,
      bucket,
      direction,
      startTs: ts,
      lastSeenTs: ts,
      lastTriggerTs: null,
      candidateProducedTs: null,
    };
  } else {
    runtimeState.currentEpoch.lastSeenTs = ts;
  }
  return runtimeState.currentEpoch;
}

function invalidateEpoch(runtimeState: Crash300RuntimeState) {
  if (runtimeState.currentEpoch) {
    runtimeState.previousEpochId = runtimeState.currentEpoch.epochId;
  }
  runtimeState.currentEpoch = null;
}

function failDecision(params: {
  runtimeCalibration: LiveCalibrationProfile;
  direction: "buy" | "sell" | null;
  qualityTier?: "A" | "B" | "C" | "unknown";
  family?: Crash300RuntimeFamily;
  bucket?: string;
  setupMatch?: number;
  confidence?: number;
  context?: Crash300ContextSnapshot | null;
  trigger?: Crash300TriggerSnapshot | null;
  componentScoreMap?: Record<string, number>;
  failReasons: string[];
  epochId?: string | null;
  triggerFresh?: boolean;
  contextAgeBars?: number | null;
  triggerAgeBars?: number | null;
  candidateProduced?: boolean;
  lastValidTriggerTs?: number | null;
  lastValidTriggerDirection?: "buy" | "sell" | null;
  previousTradeInSameContextEpoch?: number | null;
  wouldBlockNoTrigger?: boolean;
  wouldBlockStaleContext?: boolean;
  wouldBlockDuplicateEpoch?: boolean;
  wouldBlockDirectionMismatch?: boolean;
  wouldBlockLateAfterMoveWindow?: boolean;
}): SymbolDecisionResult {
  const slModel = asRecord(params.runtimeCalibration.slModel);
  const trailingModel = asRecord(params.runtimeCalibration.trailingModel);
  return {
    symbol: SYMBOL,
    serviceName: SERVICE,
    valid: false,
    direction: params.direction,
    confidence: params.confidence ?? 0,
    qualityTier: params.qualityTier ?? "unknown",
    setupFamily: params.family ?? "failed_recovery_short",
    moveBucket: params.bucket ?? "unknown",
    setupMatch: params.setupMatch ?? 0,
    evidence: {
      runtimeModelRunId: params.runtimeCalibration.sourceRunId,
      promotedModelRunId: params.runtimeCalibration.sourceRunId,
      selectedRuntimeFamily: params.family ?? null,
      selectedBucket: params.bucket ?? null,
      leadInShape: params.context ? leadInShapeFromContext(params.context) : "all",
      setupMatch: params.setupMatch ?? 0,
      expectedMovePct: 0,
      slRiskPct: Number(slModel["maxInitialRiskPct"] ?? 0) / 100,
      trailingActivationPct: Number(trailingModel["activationProfitPct"] ?? 0) / 100,
      trailingDistancePct: Number(trailingModel["trailingDistancePct"] ?? 0) / 100,
      trailingMinHoldMinutes: Number(trailingModel["minHoldMinutesBeforeTrail"] ?? 0),
      expectedHoldWindow: params.runtimeCalibration.confirmationWindow,
      componentScores: params.componentScoreMap ?? {},
      failReasons: params.failReasons,
      generatedAt: new Date().toISOString(),
      contextSnapshot: params.context ?? null,
      triggerSnapshot: params.trigger ?? null,
      contextFamilyCandidates: [],
      contextEpochId: params.epochId ?? null,
      contextAgeBars: params.contextAgeBars ?? null,
      contextAgeMinutes: params.contextAgeBars ?? null,
      triggerAgeBars: params.triggerAgeBars ?? null,
      triggerFresh: params.triggerFresh ?? false,
      selectedTriggerTransition: params.trigger?.triggerTransition ?? "none",
      triggerDirection: params.trigger?.triggerDirection ?? "none",
      triggerStrengthScore: params.trigger?.triggerStrengthScore ?? 0,
      lastValidTriggerTs: params.lastValidTriggerTs ?? null,
      lastValidTriggerDirection: params.lastValidTriggerDirection ?? null,
      previousTradeInSameContextEpoch: params.previousTradeInSameContextEpoch ?? null,
      duplicateWithinContextEpoch: Boolean(params.previousTradeInSameContextEpoch),
      wouldBlockNoTrigger: params.wouldBlockNoTrigger ?? false,
      wouldBlockStaleContext: params.wouldBlockStaleContext ?? false,
      wouldBlockDuplicateEpoch: params.wouldBlockDuplicateEpoch ?? false,
      wouldBlockDirectionMismatch: params.wouldBlockDirectionMismatch ?? false,
      wouldBlockLateAfterMoveWindow: params.wouldBlockLateAfterMoveWindow ?? false,
      candidateProduced: params.candidateProduced ?? false,
      featureSnapshot: {
        context: params.context ?? null,
        trigger: params.trigger ?? null,
      },
    },
    featureSnapshot: {
      context: params.context ?? null,
      trigger: params.trigger ?? null,
    },
    failReasons: params.failReasons,
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
    invalidation: Number((metadata["slRiskPct"] as number | undefined) ?? 0.02),
    reason: params.decision.valid
      ? "runtime_model_context_trigger_matched"
      : params.decision.failReasons.join(",") || "runtime_model_context_trigger_rejected",
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
  const candles = asCandles(asRecord(context.marketState)["candles"]);
  if (!features || candles.length < 20) {
    return failDecision({
      runtimeCalibration,
      direction: null,
      failReasons: ["runtime_feature_context_missing"],
      candidateProduced: false,
    });
  }

  const detectedMoves = asDetectedMoves(asRecord(context.marketState)["detectedMoves"]);
  const runtimeState = getRuntimeState(context);
  const { snapshot: contextSnapshot } = buildCrash300ContextSnapshot({
    symbol: SYMBOL,
    ts: context.ts,
    candles,
    runtimeModel: runtimeCalibration,
    detectedMoves,
  });
  const triggerSnapshot = buildCrash300TriggerSnapshot({
    symbol: SYMBOL,
    ts: context.ts,
    candles,
    context: contextSnapshot,
  });

  const familyCandidates = buildFamilyCandidates(contextSnapshot).sort((a, b) => b.score - a.score);
  const selectedFamily = familyCandidates[0];
  if (!selectedFamily) {
    invalidateEpoch(runtimeState);
    return failDecision({
      runtimeCalibration,
      direction: null,
      context: contextSnapshot,
      trigger: triggerSnapshot,
      failReasons: ["no_context_match"],
      candidateProduced: false,
    });
  }

  const direction = selectedFamily.direction;
  const leadInShape = selectedFamily.leadInShape === "all" ? inferRuntimeLeadInShape(features) : selectedFamily.leadInShape;
  const bucket = selectRuntimeTpBucket({
    runtimeCalibration,
    direction,
    nativeScore: selectedFamily.score * 100,
    leadInShape,
    features,
  });
  if (!bucket.key || !bucket.targetPct) {
    invalidateEpoch(runtimeState);
    return failDecision({
      runtimeCalibration,
      direction,
      family: selectedFamily.family,
      context: contextSnapshot,
      trigger: triggerSnapshot,
      setupMatch: selectedFamily.score,
      confidence: selectedFamily.score,
      componentScoreMap: componentScores(contextSnapshot, triggerSnapshot, selectedFamily.family),
      failReasons: ["runtime_family_bucket_missing"],
      candidateProduced: false,
    });
  }

  const ctxThreshold = contextThreshold(runtimeCalibration);
  const trgThreshold = triggerThreshold(runtimeCalibration);
  const epochAnchorTs = resolveEpochAnchorTs(contextSnapshot, context.ts, selectedFamily.family);
  const epoch = ensureEpoch(runtimeState, context.ts, selectedFamily.family, bucket.key, direction, epochAnchorTs);
  const contextAgeBars = Math.max(0, Math.round((context.ts - epoch.startTs) / 60));
  const maxAgeBars = maxContextAgeBars(runtimeCalibration, contextSnapshot);
  const carryBars = maxTriggerCarryBars(runtimeCalibration);
  const triggerFresh = triggerSnapshot.triggerDirection !== "none";
  const triggerDirectionMismatch = triggerSnapshot.triggerDirection !== "none" && triggerSnapshot.triggerDirection !== direction;
  const componentScoreMap = componentScores(contextSnapshot, triggerSnapshot, selectedFamily.family);

  if (selectedFamily.score < ctxThreshold) {
    invalidateEpoch(runtimeState);
    return failDecision({
      runtimeCalibration,
      direction,
      family: selectedFamily.family,
      bucket: bucket.key,
      qualityTier: qualityTierFromScores(selectedFamily.score, triggerSnapshot.triggerStrengthScore),
      context: contextSnapshot,
      trigger: triggerSnapshot,
      setupMatch: selectedFamily.score,
      confidence: selectedFamily.score * 0.6,
      componentScoreMap,
      failReasons: ["context_below_model_threshold"],
      candidateProduced: false,
    });
  }

  if (contextAgeBars > maxAgeBars) {
    return failDecision({
      runtimeCalibration,
      direction,
      family: selectedFamily.family,
      bucket: bucket.key,
      qualityTier: qualityTierFromScores(selectedFamily.score, triggerSnapshot.triggerStrengthScore),
      context: contextSnapshot,
      trigger: triggerSnapshot,
      setupMatch: selectedFamily.score,
      confidence: selectedFamily.score * 0.65,
      componentScoreMap,
      epochId: epoch.epochId,
      contextAgeBars,
      triggerAgeBars: triggerFresh ? 0 : null,
      triggerFresh: false,
      lastValidTriggerTs: runtimeState.lastValidTriggerTs,
      lastValidTriggerDirection: runtimeState.lastValidTriggerDirection,
      wouldBlockStaleContext: true,
      failReasons: ["stale_context_without_trigger"],
      candidateProduced: false,
    });
  }

  if (!triggerFresh) {
    return failDecision({
      runtimeCalibration,
      direction,
      family: selectedFamily.family,
      bucket: bucket.key,
      qualityTier: qualityTierFromScores(selectedFamily.score, 0),
      context: contextSnapshot,
      trigger: triggerSnapshot,
      setupMatch: selectedFamily.score,
      confidence: selectedFamily.score * 0.7,
      componentScoreMap,
      epochId: epoch.epochId,
      contextAgeBars,
      triggerAgeBars: carryBars > 0 && runtimeState.lastValidTriggerTs
        ? Math.round((context.ts - runtimeState.lastValidTriggerTs) / 60)
        : null,
      triggerFresh: false,
      lastValidTriggerTs: runtimeState.lastValidTriggerTs,
      lastValidTriggerDirection: runtimeState.lastValidTriggerDirection,
      wouldBlockNoTrigger: true,
      failReasons: ["no_trigger"],
      candidateProduced: false,
    });
  }

  runtimeState.lastValidTriggerTs = context.ts;
  runtimeState.lastValidTriggerDirection = triggerSnapshot.triggerDirection === "none" ? null : triggerSnapshot.triggerDirection;
  runtimeState.lastValidTriggerStrength = triggerSnapshot.triggerStrengthScore;
  epoch.lastTriggerTs = context.ts;

  if (triggerDirectionMismatch) {
    return failDecision({
      runtimeCalibration,
      direction,
      family: selectedFamily.family,
      bucket: bucket.key,
      qualityTier: qualityTierFromScores(selectedFamily.score, triggerSnapshot.triggerStrengthScore),
      context: contextSnapshot,
      trigger: triggerSnapshot,
      setupMatch: selectedFamily.score,
      confidence: selectedFamily.score * 0.7,
      componentScoreMap,
      epochId: epoch.epochId,
      contextAgeBars,
      triggerAgeBars: 0,
      triggerFresh: true,
      lastValidTriggerTs: runtimeState.lastValidTriggerTs,
      lastValidTriggerDirection: runtimeState.lastValidTriggerDirection,
      wouldBlockDirectionMismatch: true,
      failReasons: ["trigger_direction_mismatch"],
      candidateProduced: false,
    });
  }

  if (triggerSnapshot.triggerStrengthScore < trgThreshold) {
    return failDecision({
      runtimeCalibration,
      direction,
      family: selectedFamily.family,
      bucket: bucket.key,
      qualityTier: qualityTierFromScores(selectedFamily.score, triggerSnapshot.triggerStrengthScore),
      context: contextSnapshot,
      trigger: triggerSnapshot,
      setupMatch: selectedFamily.score,
      confidence: selectedFamily.score * 0.75,
      componentScoreMap,
      epochId: epoch.epochId,
      contextAgeBars,
      triggerAgeBars: 0,
      triggerFresh: true,
      failReasons: ["trigger_below_model_threshold"],
      candidateProduced: false,
    });
  }

  if (epoch.candidateProducedTs != null) {
    return failDecision({
      runtimeCalibration,
      direction,
      family: selectedFamily.family,
      bucket: bucket.key,
      qualityTier: qualityTierFromScores(selectedFamily.score, triggerSnapshot.triggerStrengthScore),
      context: contextSnapshot,
      trigger: triggerSnapshot,
      setupMatch: selectedFamily.score,
      confidence: selectedFamily.score * 0.8,
      componentScoreMap,
      epochId: epoch.epochId,
      contextAgeBars,
      triggerAgeBars: 0,
      triggerFresh: true,
      lastValidTriggerTs: runtimeState.lastValidTriggerTs,
      lastValidTriggerDirection: runtimeState.lastValidTriggerDirection,
      previousTradeInSameContextEpoch: epoch.candidateProducedTs,
      wouldBlockDuplicateEpoch: true,
      failReasons: ["duplicate_signal_same_context_epoch"],
      candidateProduced: false,
    });
  }

  epoch.candidateProducedTs = context.ts;
  const qualityTier = qualityTierFromScores(selectedFamily.score, triggerSnapshot.triggerStrengthScore);
  const setupMatch = clamp01(selectedFamily.score);
  const confidence = clamp01(setupMatch * 0.6 + triggerSnapshot.triggerStrengthScore * 0.4);
  const slModel = asRecord(runtimeCalibration.slModel);
  const trailingModel = asRecord(runtimeCalibration.trailingModel);
  const featureSnapshot = {
    context: contextSnapshot,
    trigger: triggerSnapshot,
  };

  return {
    symbol: SYMBOL,
    serviceName: SERVICE,
    valid: true,
    direction,
    confidence,
    qualityTier,
    setupFamily: selectedFamily.family,
    moveBucket: bucket.key,
    setupMatch,
    evidence: {
      runtimeModelRunId: runtimeCalibration.sourceRunId,
      promotedModelRunId: runtimeCalibration.sourceRunId,
      selectedRuntimeFamily: selectedFamily.family,
      selectedBucket: bucket.key,
      leadInShape,
      setupMatch,
      expectedMovePct: bucket.targetPct / 100,
      slRiskPct: Number(slModel["maxInitialRiskPct"] ?? 0) / 100,
      trailingActivationPct: Number(trailingModel["activationProfitPct"] ?? 0) / 100,
      trailingDistancePct: Number(trailingModel["trailingDistancePct"] ?? 0) / 100,
      trailingMinHoldMinutes: Number(trailingModel["minHoldMinutesBeforeTrail"] ?? 0),
      expectedHoldWindow: runtimeCalibration.confirmationWindow,
      componentScores: componentScoreMap,
      failReasons: [],
      generatedAt: new Date().toISOString(),
      contextSnapshot,
      triggerSnapshot,
      contextFamilyCandidates: familyCandidates,
      selectedContextFamily: selectedFamily.family,
      selectedTriggerTransition: triggerSnapshot.triggerTransition,
      triggerDirection: triggerSnapshot.triggerDirection,
      triggerStrengthScore: triggerSnapshot.triggerStrengthScore,
      contextEpochId: epoch.epochId,
      contextAgeBars,
      contextAgeMinutes: contextAgeBars,
      triggerAgeBars: 0,
      triggerFresh: true,
      lastValidTriggerTs: runtimeState.lastValidTriggerTs,
      lastValidTriggerDirection: runtimeState.lastValidTriggerDirection,
      previousTradeInSameContextEpoch: null,
      duplicateWithinContextEpoch: false,
      wouldBlockNoTrigger: false,
      wouldBlockStaleContext: false,
      wouldBlockDuplicateEpoch: false,
      wouldBlockDirectionMismatch: false,
      wouldBlockLateAfterMoveWindow: false,
      candidateProduced: true,
      candidateDirection: direction,
      featureSnapshot,
    },
    featureSnapshot,
    failReasons: [],
  };
}
