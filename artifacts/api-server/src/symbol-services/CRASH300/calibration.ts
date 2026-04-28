import { db, candlesTable, detectedMovesTable } from "@workspace/db";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { classifyRegimeFromSamples } from "../../core/regimeEngine.js";
import { computeFeaturesFromSlice, type CandleRow } from "../../core/backtest/featureSlice.js";
import type { SymbolRuntimeContext } from "../shared/SymbolRuntimeContext.js";
import type { ParityAggregateReport, ParityMoveVerdict } from "../shared/parityTypes.js";
import { loadCrash300RuntimeEnvelope } from "./model.js";
import { evaluateCrash300Runtime } from "./engine.js";
import { createCrash300TradeCandidate } from "./candidateFactory.js";

const SYMBOL = "CRASH300";
const LOOKBACK_BARS = 1500;
const MIN_CANDLES = 60;
const SAMPLE_STEP_BARS = 20;
const SAMPLE_MIN_BARS = 120;
const SAMPLE_MAX = 24;

type DetectedMoveRow = {
  id: number;
  startTs: number;
  endTs: number;
  direction: "up" | "down" | string;
  movePct: number;
  moveType: string | null;
};

const CRASH300_FAMILY_COMPATIBILITY: Record<string, string[]> = {
  crash_expansion: [
    "failed_recovery_short",
    "drift_continuation_up",
    "post_crash_recovery_up",
    "crash_event_down",
  ],
};

function normalizeMoveDirection(direction: string): "up" | "down" | "unknown" {
  if (direction === "up" || direction === "down") return direction;
  return "unknown";
}

function hasReason(
  reasons: string[],
  needle: string,
): boolean {
  const n = needle.toLowerCase();
  return reasons.some((reason) => reason.toLowerCase().includes(n));
}

function normalizeFamily(value: string | null | undefined): string {
  return String(value ?? "unknown").trim().toLowerCase();
}

function familyMatches(moveFamily: string | null, selectedFamily: string | null): boolean {
  const calibrationFamily = normalizeFamily(moveFamily);
  const runtimeFamily = normalizeFamily(selectedFamily);
  if (calibrationFamily === "unknown" || runtimeFamily === "unknown") return false;
  const compatible = CRASH300_FAMILY_COMPATIBILITY[calibrationFamily];
  if (compatible?.includes(runtimeFamily)) return true;
  return calibrationFamily === runtimeFamily;
}

function expectedTradeDirection(params: {
  moveDirection: "up" | "down" | "unknown";
  runtimeFamily: string | null;
}): "buy" | "sell" | null {
  const family = normalizeFamily(params.runtimeFamily);
  if (family === "drift_continuation_up" || family === "post_crash_recovery_up") return "buy";
  if (family === "failed_recovery_short" || family === "crash_event_down") return "sell";
  if (params.moveDirection === "up") return "buy";
  if (params.moveDirection === "down") return "sell";
  return null;
}

function describeDirectionInterpretation(runtimeFamily: string | null): string {
  const family = normalizeFamily(runtimeFamily);
  if (family === "post_crash_recovery_up") return "recovery family trades the post-crash rebound upward";
  if (family === "drift_continuation_up") return "drift family trades continuation of the upward drift";
  if (family === "failed_recovery_short") return "failed recovery family trades the rejection back downward";
  if (family === "crash_event_down") return "crash event family trades the downward event leg";
  return "direction inferred from move direction fallback";
}

function resolveFamilyMismatchReason(calibrationFamily: string, runtimeFamily: string | null): string | null {
  if (familyMatches(calibrationFamily, runtimeFamily)) return null;
  return `family_incompatible:${calibrationFamily}->${normalizeFamily(runtimeFamily)}`;
}

function resolveDirectionMismatchReason(params: {
  calibrationDirection: "up" | "down" | "unknown";
  expectedDirection: "buy" | "sell" | null;
  actualDirection: "buy" | "sell" | null;
  runtimeFamily: string | null;
}): string | null {
  if (!params.expectedDirection) return "expected_trade_direction_unknown";
  if (!params.actualDirection) return "candidate_direction_missing";
  if (params.expectedDirection === params.actualDirection) return null;
  return `direction_incompatible:${params.calibrationDirection}->${params.actualDirection}|${describeDirectionInterpretation(params.runtimeFamily)}`;
}

function resolveMatchReason(params: {
  candidateProduced: boolean;
  familyCompatible: boolean;
  directionCompatible: boolean;
  bucketMatched: boolean;
  setupEvidenceFailed: boolean;
}): string | null {
  if (
    params.candidateProduced &&
    params.familyCompatible &&
    params.directionCompatible &&
    params.bucketMatched &&
    !params.setupEvidenceFailed
  ) {
    return "runtime_candidate_matches_calibration_umbrella_family_and_direction";
  }
  return null;
}

function resolveMismatchReason(params: {
  candidateProduced: boolean;
  familyCompatible: boolean;
  directionCompatible: boolean;
  bucketMatched: boolean;
  setupEvidenceFailed: boolean;
  familyMismatchReason: string | null;
  directionMismatchReason: string | null;
  failReasons: string[];
}): string | null {
  if (!params.candidateProduced) return "no_candidate_produced";
  if (!params.familyCompatible) return params.familyMismatchReason ?? "family_incompatible";
  if (!params.directionCompatible) return params.directionMismatchReason ?? "direction_incompatible";
  if (!params.bucketMatched) return "bucket_unmatched";
  if (params.setupEvidenceFailed) return params.failReasons[0] ?? "setup_evidence_failed";
  if (params.failReasons.length > 0) return params.failReasons[0]!;
  return null;
}

function bucketLooksMatched(selectedBucket: string | null): boolean {
  if (!selectedBucket) return false;
  const bucket = selectedBucket.toLowerCase();
  return bucket !== "unknown" && bucket.includes("|");
}

function isRuntimeMissingError(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("runtime model missing");
}

function isInvalidRuntimeError(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("runtime model missing/invalid") || m.includes("invalid");
}

function isSetupEvidenceFailure(setupMatch: number, reasons: string[]): boolean {
  if (setupMatch < 0.5) return true;
  const text = reasons.join("|").toLowerCase();
  return text.includes("setup") || text.includes("evidence") || text.includes("runtime_gate");
}

function computeParityDistance(params: {
  candidateProduced: boolean;
  directionMatched: boolean;
  familyMatched: boolean;
  bucketMatched: boolean;
  setupMatch: number;
}): number {
  let score = 1;
  if (!params.candidateProduced) score -= 0.55;
  if (!params.directionMatched) score -= 0.2;
  if (!params.familyMatched) score -= 0.1;
  if (!params.bucketMatched) score -= 0.1;
  if (params.setupMatch < 0.5) score -= 0.05;
  return Math.max(0, Math.min(1, score));
}

async function loadCandlesForMove(startTs: number): Promise<CandleRow[]> {
  const lookbackStart = startTs - LOOKBACK_BARS * 60;
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
      eq(candlesTable.symbol, SYMBOL),
      eq(candlesTable.timeframe, "1m"),
      eq(candlesTable.isInterpolated, false),
      gte(candlesTable.openTs, lookbackStart),
      lte(candlesTable.openTs, startTs),
    ))
    .orderBy(asc(candlesTable.openTs));
  return rows as CandleRow[];
}

function buildFeatureHistory(candles: CandleRow[]) {
  const samples: Array<{
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
  for (let len = SAMPLE_MIN_BARS; len <= candles.length; len += SAMPLE_STEP_BARS) {
    const features = computeFeaturesFromSlice(SYMBOL, candles.slice(0, len));
    if (!features) continue;
    samples.push({
      emaSlope: features.emaSlope,
      rsi14: features.rsi14,
      bbWidth: features.bbWidth,
      bbWidthRoc: features.bbWidthRoc,
      atr14: features.atr14,
      atrRank: features.atrRank,
      atrAccel: features.atrAccel,
      zScore: features.zScore,
      spikeHazardScore: features.spikeHazardScore,
      bbPctB: features.bbPctB,
    });
  }
  return samples.slice(-SAMPLE_MAX);
}

function initAggregateReport(): ParityAggregateReport {
  return {
    symbol: SYMBOL,
    totalMoves: 0,
    matchedMoves: 0,
    noCandidate: 0,
    familyMismatch: 0,
    directionMismatch: 0,
    bucketMismatch: 0,
    setupEvidenceFailed: 0,
    runtimeModelMissing: 0,
    invalidRuntimeModel: 0,
  };
}

function buildFailureVerdict(move: DetectedMoveRow, reason: string): ParityMoveVerdict {
  return {
    moveId: move.id,
    symbol: SYMBOL,
    startTs: move.startTs,
    endTs: move.endTs,
    direction: normalizeMoveDirection(move.direction),
    movePct: move.movePct,
    moveFamily: move.moveType ?? "unknown",
    calibrationMoveFamily: move.moveType ?? "unknown",
    runtimeFamily: null,
    selectedRuntimeFamily: null,
    selectedBucket: null,
    candidateProduced: false,
    expectedTradeDirection: null,
    actualCandidateDirection: null,
    candidateDirection: null,
    familyCompatible: false,
    directionCompatible: false,
    confidence: 0,
    setupMatch: 0,
    matchReason: null,
    mismatchReason: reason,
    firstFailureReason: reason,
    allFailureReasons: [reason],
    parityDistanceScore: null,
  };
}

export async function runCrash300CalibrationParity(params: {
  startTs?: number;
  endTs?: number;
  mode?: "parity" | "trading_sim";
}) {
  const endTs = params.endTs ?? Math.floor(Date.now() / 1000);
  const startTs = params.startTs ?? (endTs - 365 * 86400);
  const envelope = await loadCrash300RuntimeEnvelope();
  const runtimeModel = envelope.promotedModel;
  if (!runtimeModel) {
    throw new Error("CRASH300 runtime model missing/invalid. Cannot evaluate symbol service.");
  }

  const whereClause = and(
    eq(detectedMovesTable.symbol, SYMBOL),
    gte(detectedMovesTable.startTs, startTs),
    lte(detectedMovesTable.startTs, endTs),
  );
  const moves = await db
    .select({
      id: detectedMovesTable.id,
      startTs: detectedMovesTable.startTs,
      endTs: detectedMovesTable.endTs,
      direction: detectedMovesTable.direction,
      movePct: detectedMovesTable.movePct,
      moveType: detectedMovesTable.moveType,
    })
    .from(detectedMovesTable)
    .where(whereClause)
    .orderBy(asc(detectedMovesTable.startTs)) as DetectedMoveRow[];

  const totals = initAggregateReport();
  const verdicts: ParityMoveVerdict[] = [];
  const failureReasonCounts: Record<string, number> = {};
  const rawDetectedMoveFamilyCounts: Record<string, number> = {};
  const selectedRuntimeFamilyCounts: Record<string, number> = {};
  const selectedBucketCounts: Record<string, number> = {};
  const familyCompatibilityMatrix: Record<string, number> = {};
  const directionMatrixCounts: Record<string, number> = {};
  const matchedByRuntimeFamily: Record<string, number> = {};
  const gateComponentFailures: Record<string, number> = {
    spikePhaseFit: 0,
    developmentWindowFit: 0,
    runwayFit: 0,
    triggerWindowFit: 0,
  };
  let noCoordinatorOutput = 0;
  let runtimeCalibratedSetupWeak = 0;

  for (const move of moves) {
    totals.totalMoves += 1;
    const calibrationFamily = normalizeFamily(move.moveType);
    rawDetectedMoveFamilyCounts[calibrationFamily] = (rawDetectedMoveFamilyCounts[calibrationFamily] ?? 0) + 1;
    try {
      const candles = await loadCandlesForMove(move.startTs);
      if (candles.length < MIN_CANDLES) {
        const verdict = buildFailureVerdict(move, "insufficient_historical_candles");
        verdicts.push(verdict);
        totals.noCandidate += 1;
        continue;
      }

      const features = computeFeaturesFromSlice(SYMBOL, candles);
      if (!features) {
        const verdict = buildFailureVerdict(move, "feature_extraction_failed");
        verdicts.push(verdict);
        totals.noCandidate += 1;
        continue;
      }

      const featureHistory = buildFeatureHistory(candles);
      const regime = classifyRegimeFromSamples(features, featureHistory);

      const context: SymbolRuntimeContext = {
        symbol: SYMBOL,
        mode: "paper",
        ts: move.startTs,
        marketState: {
          features,
          featureHistory,
          operationalRegime: regime.regime,
          regimeConfidence: regime.confidence,
        },
        runtimeModel: runtimeModel as unknown as Record<string, unknown>,
        stateMap: {},
        metadata: {
          parityMode: params.mode ?? "parity",
          moveId: move.id,
        },
      };

      const decision = await evaluateCrash300Runtime(context);
      let candidateProduced = false;
      if (decision.direction && decision.valid) {
        candidateProduced = true;
      } else if (decision.valid && decision.direction) {
        try {
          createCrash300TradeCandidate(decision);
          candidateProduced = true;
        } catch {
          candidateProduced = false;
        }
      }

      const moveDirection = normalizeMoveDirection(move.direction);
      const familyMatched = familyMatches(move.moveType, decision.setupFamily);
      const expectedDirection = expectedTradeDirection({
        moveDirection,
        runtimeFamily: decision.setupFamily ?? null,
      });
      const directionMatched = !expectedDirection || decision.direction === expectedDirection;
      const bucketMatched = bucketLooksMatched(decision.moveBucket);
      const setupEvidenceFailed = isSetupEvidenceFailure(decision.setupMatch, decision.failReasons);
      const familyMismatchReason = resolveFamilyMismatchReason(calibrationFamily, decision.setupFamily ?? null);
      const directionMismatchReason = resolveDirectionMismatchReason({
        calibrationDirection: moveDirection,
        expectedDirection,
        actualDirection: decision.direction,
        runtimeFamily: decision.setupFamily ?? null,
      });
      const matchReason = resolveMatchReason({
        candidateProduced,
        familyCompatible: familyMatched,
        directionCompatible: directionMatched,
        bucketMatched,
        setupEvidenceFailed,
      });
      const mismatchReason = resolveMismatchReason({
        candidateProduced,
        familyCompatible: familyMatched,
        directionCompatible: directionMatched,
        bucketMatched,
        setupEvidenceFailed,
        familyMismatchReason,
        directionMismatchReason,
        failReasons: decision.failReasons,
      });

      const verdict: ParityMoveVerdict = {
        moveId: move.id,
        symbol: SYMBOL,
        startTs: move.startTs,
        endTs: move.endTs,
        direction: moveDirection,
        movePct: move.movePct,
        moveFamily: move.moveType ?? "unknown",
        calibrationMoveFamily: move.moveType ?? "unknown",
        runtimeFamily: decision.setupFamily ?? null,
        selectedRuntimeFamily: decision.setupFamily ?? null,
        selectedBucket: decision.moveBucket ?? null,
        candidateProduced,
        expectedTradeDirection: expectedDirection,
        actualCandidateDirection: decision.direction,
        candidateDirection: decision.direction,
        familyCompatible: familyMatched,
        directionCompatible: directionMatched,
        confidence: decision.confidence,
        setupMatch: decision.setupMatch,
        matchReason,
        mismatchReason,
        firstFailureReason: decision.failReasons[0] ?? mismatchReason ?? null,
        allFailureReasons: decision.failReasons,
        parityDistanceScore: computeParityDistance({
          candidateProduced,
          directionMatched,
          familyMatched,
          bucketMatched,
          setupMatch: decision.setupMatch,
        }),
      };
      verdicts.push(verdict);

      const firstFailureReason = verdict.firstFailureReason ?? "none";
      failureReasonCounts[firstFailureReason] = (failureReasonCounts[firstFailureReason] ?? 0) + 1;
      const runtimeFamilyKey = verdict.selectedRuntimeFamily ?? "none";
      selectedRuntimeFamilyCounts[runtimeFamilyKey] = (selectedRuntimeFamilyCounts[runtimeFamilyKey] ?? 0) + 1;
      const bucketKey = verdict.selectedBucket ?? "none";
      selectedBucketCounts[bucketKey] = (selectedBucketCounts[bucketKey] ?? 0) + 1;
      const familyCompatibilityKey = `${calibrationFamily}->${runtimeFamilyKey}:${familyMatched ? "compatible" : "incompatible"}`;
      familyCompatibilityMatrix[familyCompatibilityKey] = (familyCompatibilityMatrix[familyCompatibilityKey] ?? 0) + 1;
      const expectedLabel = expectedDirection ?? "unknown";
      const candidateLabel = verdict.candidateDirection ?? "none";
      const matrixKey = `${expectedLabel}->${candidateLabel}`;
      directionMatrixCounts[matrixKey] = (directionMatrixCounts[matrixKey] ?? 0) + 1;

      if (hasReason(verdict.allFailureReasons, "no_coordinator_output")) {
        noCoordinatorOutput += 1;
      }
      if (hasReason(verdict.allFailureReasons, "runtime_calibrated_setup_weak")) {
        runtimeCalibratedSetupWeak += 1;
      }
      for (const component of Object.keys(gateComponentFailures)) {
        if (hasReason(verdict.allFailureReasons, component)) {
          gateComponentFailures[component] += 1;
        }
      }

      if (!candidateProduced) totals.noCandidate += 1;
      if (candidateProduced && !familyMatched) totals.familyMismatch += 1;
      if (candidateProduced && !directionMatched) totals.directionMismatch += 1;
      if (candidateProduced && !bucketMatched) totals.bucketMismatch += 1;
      if (setupEvidenceFailed) totals.setupEvidenceFailed += 1;
      if (
        candidateProduced &&
        directionMatched &&
        familyMatched &&
        bucketMatched &&
        !setupEvidenceFailed
      ) {
        totals.matchedMoves += 1;
        matchedByRuntimeFamily[runtimeFamilyKey] = (matchedByRuntimeFamily[runtimeFamilyKey] ?? 0) + 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const verdict = buildFailureVerdict(move, message);
      verdicts.push(verdict);
      failureReasonCounts[verdict.firstFailureReason ?? "none"] =
        (failureReasonCounts[verdict.firstFailureReason ?? "none"] ?? 0) + 1;
      selectedRuntimeFamilyCounts.none = (selectedRuntimeFamilyCounts.none ?? 0) + 1;
      selectedBucketCounts.none = (selectedBucketCounts.none ?? 0) + 1;
      const calibrationFamilyKey = normalizeFamily(move.moveType);
      const expectedDirection = expectedTradeDirection({
        moveDirection: normalizeMoveDirection(move.direction),
        runtimeFamily: null,
      }) ?? "unknown";
      familyCompatibilityMatrix[`${calibrationFamilyKey}->none:incompatible`] =
        (familyCompatibilityMatrix[`${calibrationFamilyKey}->none:incompatible`] ?? 0) + 1;
      const matrixKey = `${expectedDirection}->none`;
      directionMatrixCounts[matrixKey] = (directionMatrixCounts[matrixKey] ?? 0) + 1;
      if ((verdict.firstFailureReason ?? "").toLowerCase().includes("no_coordinator_output")) {
        noCoordinatorOutput += 1;
      }
      totals.noCandidate += 1;
      if (isRuntimeMissingError(message)) totals.runtimeModelMissing += 1;
      if (isInvalidRuntimeError(message)) totals.invalidRuntimeModel += 1;
    }
  }

  return {
    symbol: SYMBOL,
    mode: params.mode ?? "parity",
    runtimeModel: {
      stagedModelRunId: envelope.stagedModel?.sourceRunId ?? null,
      promotedModelRunId: envelope.promotedModel?.sourceRunId ?? null,
      source: envelope.promotedModel?.source ?? null,
    },
    totals,
    verdicts,
    diagnostics: {
      failureReasonCounts,
      rawDetectedMoveFamilyCounts,
      selectedRuntimeFamilyCounts,
      selectedBucketCounts,
      familyCompatibilityMatrix,
      directionMatrixCounts,
      matchedByRuntimeFamily,
      noCoordinatorOutput,
      runtimeCalibratedSetupWeak,
      gateComponentFailures,
    },
  };
}
