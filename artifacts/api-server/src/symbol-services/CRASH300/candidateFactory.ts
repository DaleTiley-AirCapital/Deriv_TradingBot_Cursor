import type { BuiltSymbolTradeCandidate } from "../../core/symbolModels/candidateBuilder.js";
import type { SymbolDecisionResult } from "../shared/SymbolDecisionResult.js";
import type { TradeCandidate } from "../shared/TradeCandidate.js";

function readBuiltCandidate(decision: SymbolDecisionResult): BuiltSymbolTradeCandidate {
  const raw = (decision.evidence as Record<string, unknown>)?.__builtCandidate;
  if (!raw || typeof raw !== "object") {
    throw new Error("CRASH300 decision missing built candidate payload.");
  }
  return raw as BuiltSymbolTradeCandidate;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

export function createCrash300TradeCandidate(
  decision: SymbolDecisionResult,
): TradeCandidate {
  if (!decision.valid || !decision.direction) {
    throw new Error(
      `CRASH300 invalid decision cannot create trade candidate: ${decision.failReasons.join(",") || "unknown"}`,
    );
  }

  const built = readBuiltCandidate(decision);
  const source = built.candidate.runtimeCalibration;
  const now = new Date();
  const expires = new Date(now.getTime() + 30 * 60_000);

  return {
    candidateId: `CRASH300:${built.candidate.engineName}:${now.getTime()}`,
    symbol: "CRASH300",
    direction: built.candidate.direction,
    serviceName: "crash300_service",
    modelRunId: source?.sourceRunId ?? null,
    calibrationRunId: source?.sourceRunId ?? null,
    runtimeModelId: source ? `${source.symbol}:${source.sourceRunId}:${source.promotedAt}` : null,
    promotedModelRunId: source?.sourceRunId ?? null,
    setupFamily: decision.setupFamily,
    moveBucket: decision.moveBucket,
    qualityTier: decision.qualityTier,
    confidence: clamp01(decision.confidence),
    setupMatch: clamp01(decision.setupMatch),
    entryPrice: Number(built.candidate.features.latestClose ?? 0),
    entryReason: built.candidate.reason,
    expectedMovePct: built.candidate.exitPolicy.takeProfitPct,
    expectedHoldWindow: source?.confirmationWindow ?? "4h",
    tpPolicy: {
      type: "price_target",
      params: {
        takeProfitPrice: built.candidate.exitPolicy.takeProfitPrice,
        takeProfitPct: built.candidate.exitPolicy.takeProfitPct,
        bucketKey: built.candidate.exitPolicy.bucketKey ?? null,
      },
    },
    slPolicy: {
      type: "price_stop",
      params: {
        stopLossPrice: built.candidate.exitPolicy.stopLossPrice,
        stopLossPct: built.candidate.exitPolicy.stopLossPct,
      },
    },
    trailingPolicy: {
      type: "dynamic_trailing",
      params: {
        activationPct: built.candidate.exitPolicy.trailingArmPct,
        distancePct: built.candidate.exitPolicy.trailingDistancePct,
        minHoldMinutes: built.candidate.exitPolicy.minHoldMinutes ?? null,
      },
    },
    invalidationPolicy: {
      type: "engine_invalidation",
      params: {
        engine: built.candidate.engineName,
        setupSignature: built.setupSignature,
      },
    },
    evidence: {
      ...decision.evidence,
      nativeScore: built.nativeScore,
      scoringSource: built.candidate.metadata?.scoringSource ?? "promoted_calibrated_runtime_model",
    },
    featureSnapshot: decision.featureSnapshot,
    matchedCalibrationBucket: built.candidate.exitPolicy.bucketKey ?? null,
    parityEvidence: {
      runtimeSetupReason: built.candidate.runtimeSetup.reason,
      runtimeSetupAllowed: built.candidate.runtimeSetup.allowed,
    },
    capitalRequest: {
      requestedPct: 0.15,
      maxRiskPct: built.candidate.exitPolicy.stopLossPct,
      notes: "CRASH300 candidate default allocation request",
    },
    createdAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    failReasons: decision.failReasons,
  };
}
