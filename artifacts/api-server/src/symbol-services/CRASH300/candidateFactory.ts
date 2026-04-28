import type { SymbolDecisionResult } from "../shared/SymbolDecisionResult.js";
import type { TradeCandidate } from "../shared/TradeCandidate.js";

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function readEvidence(decision: SymbolDecisionResult): Record<string, unknown> {
  return decision.evidence && typeof decision.evidence === "object"
    ? decision.evidence
    : {};
}

function readNumber(source: Record<string, unknown>, key: string): number | null {
  const n = Number(source[key]);
  return Number.isFinite(n) ? n : null;
}

function requirePositiveNumber(source: Record<string, unknown>, key: string, label: string): number {
  const n = Number(source[key]);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`CRASH300 runtime model missing/invalid. Cannot evaluate symbol service. ${label}`);
  }
  return n;
}

export function createCrash300TradeCandidate(
  decision: SymbolDecisionResult,
): TradeCandidate {
  if (!decision.valid || !decision.direction) {
    throw new Error(
      `CRASH300 invalid decision cannot create trade candidate: ${decision.failReasons.join(",") || "unknown"}`,
    );
  }

  const evidence = readEvidence(decision);
  const modelRunId = readNumber(evidence, "runtimeModelRunId");
  if (!modelRunId || modelRunId <= 0) {
    throw new Error("CRASH300 runtime model missing/invalid. Cannot evaluate symbol service. runtime_model_run_id_missing");
  }

  const featureSnapshot = (decision.featureSnapshot && typeof decision.featureSnapshot === "object")
    ? decision.featureSnapshot
    : {};
  const entryPrice = requirePositiveNumber(featureSnapshot, "latestClose", "entry_price_missing");
  const expectedMovePct = requirePositiveNumber(evidence, "expectedMovePct", "expected_move_pct_missing");

  const slRiskPct = requirePositiveNumber(evidence, "slRiskPct", "sl_policy_missing");
  const trailingActivationPct = requirePositiveNumber(evidence, "trailingActivationPct", "trailing_activation_missing");
  const trailingDistancePct = requirePositiveNumber(evidence, "trailingDistancePct", "trailing_distance_missing");
  const trailingMinHoldMinutes = requirePositiveNumber(evidence, "trailingMinHoldMinutes", "trailing_min_hold_missing");

  const tpMultiplier = decision.direction === "buy" ? 1 : -1;
  const takeProfitPrice = entryPrice * (1 + (expectedMovePct * tpMultiplier));
  const stopLossPrice = entryPrice * (1 - (slRiskPct * tpMultiplier));
  if (!Number.isFinite(takeProfitPrice) || !Number.isFinite(stopLossPrice) || takeProfitPrice <= 0 || stopLossPrice <= 0) {
    throw new Error("CRASH300 runtime model missing/invalid. Cannot evaluate symbol service. exit_policy_price_invalid");
  }

  const now = new Date();
  const expires = new Date(now.getTime() + 30 * 60_000);
  return {
    candidateId: `CRASH300:${decision.setupFamily}:${decision.moveBucket}:${now.getTime()}`,
    symbol: "CRASH300",
    direction: decision.direction,
    serviceName: "crash300_service",
    modelRunId,
    calibrationRunId: modelRunId,
    runtimeModelId: `CRASH300:${modelRunId}`,
    promotedModelRunId: modelRunId,
    setupFamily: decision.setupFamily,
    moveBucket: decision.moveBucket,
    qualityTier: decision.qualityTier,
    confidence: clamp01(decision.confidence),
    setupMatch: clamp01(decision.setupMatch),
    entryPrice,
    entryReason: decision.failReasons.length === 0
      ? "runtime_model_evidence_matched"
      : `runtime_model_evidence:${decision.failReasons.join(",")}`,
    expectedMovePct,
    expectedHoldWindow: String(evidence["expectedHoldWindow"] ?? "4h"),
    tpPolicy: {
      type: "runtime_model_tp",
      params: {
        takeProfitPrice,
        takeProfitPct: expectedMovePct,
        bucketKey: decision.moveBucket,
        setupFamily: decision.setupFamily,
      },
    },
    slPolicy: {
      type: "runtime_model_sl",
      params: {
        stopLossPrice,
        stopLossPct: slRiskPct,
      },
    },
    trailingPolicy: {
      type: "runtime_model_trailing",
      params: {
        activationPct: trailingActivationPct,
        distancePct: trailingDistancePct,
        minHoldMinutes: trailingMinHoldMinutes,
      },
    },
    invalidationPolicy: {
      type: "runtime_model_invalidation",
      params: {
        setupFamily: decision.setupFamily,
        moveBucket: decision.moveBucket,
      },
    },
    evidence: {
      ...evidence,
      selectedRuntimeFamily: decision.setupFamily,
      selectedBucket: decision.moveBucket,
      failReasons: decision.failReasons,
      candidateProduced: true,
      candidateDirection: decision.direction,
      generatedAt: new Date().toISOString(),
    },
    featureSnapshot,
    matchedCalibrationBucket: decision.moveBucket,
    parityEvidence: {
      setupMatch: decision.setupMatch,
      failReasons: decision.failReasons,
    },
    capitalRequest: {
      requestedPct: 0.15,
      maxRiskPct: slRiskPct,
      notes: "CRASH300 runtime-model candidate request",
    },
    createdAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    failReasons: decision.failReasons,
  };
}
