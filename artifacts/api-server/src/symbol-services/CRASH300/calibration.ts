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

function normalizeMoveDirection(direction: string): "up" | "down" | "unknown" {
  if (direction === "up" || direction === "down") return direction;
  return "unknown";
}

function expectedCandidateDirection(direction: "up" | "down" | "unknown"): "buy" | "sell" | null {
  if (direction === "up") return "buy";
  if (direction === "down") return "sell";
  return null;
}

function familyMatches(moveFamily: string | null, selectedFamily: string | null): boolean {
  if (!moveFamily || !selectedFamily) return false;
  const left = moveFamily.toLowerCase();
  const right = selectedFamily.toLowerCase();
  return left === right || right.includes(left) || left.includes(right);
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
    selectedRuntimeFamily: null,
    selectedBucket: null,
    candidateProduced: false,
    candidateDirection: null,
    confidence: 0,
    setupMatch: 0,
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

  for (const move of moves) {
    totals.totalMoves += 1;
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
      if (decision.valid && decision.direction) {
        try {
          createCrash300TradeCandidate(decision);
          candidateProduced = true;
        } catch {
          candidateProduced = false;
        }
      }

      const expectedDirection = expectedCandidateDirection(normalizeMoveDirection(move.direction));
      const directionMatched = !expectedDirection || decision.direction === expectedDirection;
      const familyMatched = familyMatches(move.moveType, decision.setupFamily);
      const bucketMatched = bucketLooksMatched(decision.moveBucket);
      const setupEvidenceFailed = isSetupEvidenceFailure(decision.setupMatch, decision.failReasons);

      const verdict: ParityMoveVerdict = {
        moveId: move.id,
        symbol: SYMBOL,
        startTs: move.startTs,
        endTs: move.endTs,
        direction: normalizeMoveDirection(move.direction),
        movePct: move.movePct,
        moveFamily: move.moveType ?? "unknown",
        selectedRuntimeFamily: decision.setupFamily ?? null,
        selectedBucket: decision.moveBucket ?? null,
        candidateProduced,
        candidateDirection: decision.direction,
        confidence: decision.confidence,
        setupMatch: decision.setupMatch,
        firstFailureReason: decision.failReasons[0] ?? null,
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

      if (!candidateProduced) totals.noCandidate += 1;
      if (!familyMatched) totals.familyMismatch += 1;
      if (!directionMatched) totals.directionMismatch += 1;
      if (!bucketMatched) totals.bucketMismatch += 1;
      if (setupEvidenceFailed) totals.setupEvidenceFailed += 1;
      if (
        candidateProduced &&
        directionMatched &&
        familyMatched &&
        bucketMatched &&
        !setupEvidenceFailed
      ) {
        totals.matchedMoves += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const verdict = buildFailureVerdict(move, message);
      verdicts.push(verdict);
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
  };
}
