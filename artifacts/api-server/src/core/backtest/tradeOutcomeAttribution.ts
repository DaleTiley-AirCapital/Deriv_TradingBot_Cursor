import { db, detectedMovesTable } from "@workspace/db";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import type { V3BacktestResult, V3BacktestTrade } from "./backtestRunner.js";
import { runCrash300CalibrationParity } from "../../symbol-services/CRASH300/calibration.js";
import type { ParityMoveVerdict } from "../../symbol-services/shared/parityTypes.js";

type DetectedMove = {
  id: number;
  startTs: number;
  endTs: number;
  direction: "up" | "down" | "unknown";
  movePct: number;
  moveType: string | null;
  qualityTier: string | null;
};

type TradeOutcomeClassification =
  | "good_entry_good_exit"
  | "good_entry_sl_too_tight"
  | "good_entry_trailing_too_early"
  | "entered_too_late"
  | "entered_too_early"
  | "wrong_direction"
  | "no_matching_calibrated_move"
  | "target_unrealistic_for_bucket"
  | "volatility_exceeded_sl";

type AttributionTradeRow = {
  tradeId: string;
  symbol: string;
  direction: "buy" | "sell";
  runtimeFamily: string | null;
  selectedBucket: string | null;
  qualityTier: string | null;
  confidence: number | null;
  setupMatch: number | null;
  entryPrice: number;
  entryTs: number;
  exitTs: number;
  exitReason: string;
  pnlPct: number;
  mfePct: number;
  maePct: number;
  tpPct: number;
  slPct: number;
  trailingActivationPct: number | null;
  trailingDistancePct: number | null;
  minHoldBars: number | null;
  minHoldMinutes: number | null;
  projectedMovePct: number;
  nearestCalibratedMoveBefore: MoveReference | null;
  nearestCalibratedMoveAfter: MoveReference | null;
  matchedCalibratedMove: MoveReference | null;
  parityVerdict: {
    moveId: number | string;
    runtimeFamily: string | null;
    selectedBucket: string | null;
    candidateProduced: boolean;
    familyCompatible: boolean | null;
    directionCompatible: boolean | null;
    matchReason: string | null;
    mismatchReason: string | null;
  } | null;
  entryInsideCalibratedMoveWindow: boolean;
  tradeDirectionAlignedWithCalibratedMove: boolean;
  minutesFromMoveStartToEntry: number | null;
  minutesFromEntryToMoveEnd: number | null;
  reachedProjectedMove25PctBeforeExit: boolean;
  reachedProjectedMove50PctBeforeExit: boolean;
  reachedProjectedMove75PctBeforeExit: boolean;
  reachedProjectedMove100PctBeforeExit: boolean;
  trailingActivated: boolean;
  trailingExitBeforeCalibratedMoveEnd: boolean;
  slHitBeforeCalibratedMoveDirectionDeveloped: boolean;
  outcomeClassification: TradeOutcomeClassification;
};

type MoveReference = {
  moveId: number;
  startTs: number;
  endTs: number;
  direction: "up" | "down" | "unknown";
  movePct: number;
  moveFamily: string | null;
  qualityTier: string | null;
};

function normalizeDirection(value: unknown): "up" | "down" | "unknown" {
  if (value === "up" || value === "down") return value;
  return "unknown";
}

function expectedTradeDirection(moveDirection: "up" | "down" | "unknown"): "buy" | "sell" | null {
  if (moveDirection === "up") return "buy";
  if (moveDirection === "down") return "sell";
  return null;
}

function moveRef(move: DetectedMove | null): MoveReference | null {
  if (!move) return null;
  return {
    moveId: move.id,
    startTs: move.startTs,
    endTs: move.endTs,
    direction: move.direction,
    movePct: move.movePct,
    moveFamily: move.moveType,
    qualityTier: move.qualityTier,
  };
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function bump(map: Record<string, number>, key: string) {
  map[key] = (map[key] ?? 0) + 1;
}

function resolveNearestMoves(entryTs: number, moves: DetectedMove[]) {
  let before: DetectedMove | null = null;
  let after: DetectedMove | null = null;
  for (const move of moves) {
    if (move.startTs <= entryTs) {
      if (!before || move.startTs > before.startTs) before = move;
    } else if (!after || move.startTs < after.startTs) {
      after = move;
    }
  }
  return { before, after };
}

function resolveMatchedMove(trade: V3BacktestTrade, moves: DetectedMove[]): DetectedMove | null {
  const inside = moves.filter((move) => trade.entryTs >= move.startTs && trade.entryTs <= move.endTs);
  const insideSameDirection = inside.filter((move) => expectedTradeDirection(move.direction) === trade.direction);
  if (insideSameDirection.length > 0) {
    return insideSameDirection.sort((a, b) => Math.abs(trade.entryTs - a.startTs) - Math.abs(trade.entryTs - b.startTs))[0] ?? null;
  }
  if (inside.length > 0) {
    return inside.sort((a, b) => Math.abs(trade.entryTs - a.startTs) - Math.abs(trade.entryTs - b.startTs))[0] ?? null;
  }
  const sameDirection = moves.filter((move) => expectedTradeDirection(move.direction) === trade.direction);
  const source = sameDirection.length > 0 ? sameDirection : moves;
  return source.sort((a, b) => Math.abs(trade.entryTs - a.startTs) - Math.abs(trade.entryTs - b.startTs))[0] ?? null;
}

function classifyOutcome(params: {
  trade: V3BacktestTrade;
  matchedMove: DetectedMove | null;
  directionAligned: boolean;
  reached25: boolean;
  reached50: boolean;
  reached75: boolean;
  trailingExitBeforeMoveEnd: boolean;
  entryInsideMove: boolean;
}): TradeOutcomeClassification {
  const { trade, matchedMove, directionAligned, reached25, reached50, reached75, trailingExitBeforeMoveEnd, entryInsideMove } = params;
  if (!matchedMove) return "no_matching_calibrated_move";
  if (!directionAligned) return "wrong_direction";
  if (trade.entryTs < matchedMove.startTs) return "entered_too_early";
  if (trade.entryTs > matchedMove.endTs) return "entered_too_late";
  if (trade.exitReason === "trailing_stop" && trailingExitBeforeMoveEnd && reached50) return "good_entry_trailing_too_early";
  if (trade.exitReason === "sl_hit" && reached25) return "good_entry_sl_too_tight";
  if (trade.projectedMovePct > 0 && matchedMove.movePct > 0 && trade.projectedMovePct > (matchedMove.movePct / 100) * 1.2) {
    return "target_unrealistic_for_bucket";
  }
  if (trade.exitReason === "sl_hit" && entryInsideMove && !reached25) return "volatility_exceeded_sl";
  if (trade.pnlPct > 0 || trade.exitReason === "tp_hit") return "good_entry_good_exit";
  if (trade.exitReason === "sl_hit" && reached75) return "good_entry_sl_too_tight";
  return "volatility_exceeded_sl";
}

export async function buildCrash300TradeOutcomeAttributionReport(params: {
  runId: number;
  result: V3BacktestResult;
  createdAt?: string | null;
}) {
  if (params.result.symbol !== "CRASH300") {
    throw new Error("Trade-outcome attribution is currently available for CRASH300 only.");
  }

  const moves = await db
    .select({
      id: detectedMovesTable.id,
      startTs: detectedMovesTable.startTs,
      endTs: detectedMovesTable.endTs,
      direction: detectedMovesTable.direction,
      movePct: detectedMovesTable.movePct,
      moveType: detectedMovesTable.moveType,
      qualityTier: detectedMovesTable.qualityTier,
    })
    .from(detectedMovesTable)
    .where(and(
      eq(detectedMovesTable.symbol, "CRASH300"),
      gte(detectedMovesTable.startTs, params.result.startTs),
      lte(detectedMovesTable.startTs, params.result.endTs),
    ))
    .orderBy(asc(detectedMovesTable.startTs)) as DetectedMove[];

  const parity = await runCrash300CalibrationParity({
    startTs: params.result.startTs,
    endTs: params.result.endTs,
    mode: "parity",
  });
  const parityByMoveId = new Map<number | string, ParityMoveVerdict>(
    parity.verdicts.map((verdict) => [verdict.moveId, verdict]),
  );

  const trades: AttributionTradeRow[] = params.result.trades.map((trade, index) => {
    const { before, after } = resolveNearestMoves(trade.entryTs, moves);
    const matchedMove = resolveMatchedMove(trade, moves);
    const entryInsideMove = Boolean(matchedMove && trade.entryTs >= matchedMove.startTs && trade.entryTs <= matchedMove.endTs);
    const directionAligned = Boolean(
      matchedMove &&
      expectedTradeDirection(matchedMove.direction) &&
      expectedTradeDirection(matchedMove.direction) === trade.direction
    );
    const matchedVerdict = matchedMove ? parityByMoveId.get(matchedMove.id) ?? null : null;
    const projectedMovePct = Number(trade.projectedMovePct ?? 0);
    const reached25 = projectedMovePct > 0 ? trade.mfePct >= projectedMovePct * 0.25 : false;
    const reached50 = projectedMovePct > 0 ? trade.mfePct >= projectedMovePct * 0.5 : false;
    const reached75 = projectedMovePct > 0 ? trade.mfePct >= projectedMovePct * 0.75 : false;
    const reached100 = projectedMovePct > 0 ? trade.mfePct >= projectedMovePct : false;
    const trailingActivated = Boolean(trade.trailingActivated || trade.exitReason === "trailing_stop");
    const trailingExitBeforeMoveEnd = Boolean(
      matchedMove &&
      trade.exitReason === "trailing_stop" &&
      trade.exitTs < matchedMove.endTs
    );
    const slHitBeforeMoveDirectionDeveloped = Boolean(
      matchedMove &&
      trade.exitReason === "sl_hit" &&
      directionAligned &&
      !reached25
    );

    return {
      tradeId: `${trade.symbol}:${trade.entryTs}:${index + 1}`,
      symbol: trade.symbol,
      direction: trade.direction,
      runtimeFamily: trade.runtimeFamily ?? null,
      selectedBucket: trade.selectedBucket ?? null,
      qualityTier: trade.qualityTier ?? null,
      confidence: trade.confidence ?? null,
      setupMatch: trade.setupMatch ?? null,
      entryPrice: trade.entryPrice,
      entryTs: trade.entryTs,
      exitTs: trade.exitTs,
      exitReason: trade.exitReason,
      pnlPct: trade.pnlPct,
      mfePct: trade.mfePct,
      maePct: trade.maePct,
      tpPct: trade.tpPct,
      slPct: trade.slPct,
      trailingActivationPct: trade.trailingActivationPct ?? null,
      trailingDistancePct: trade.trailingDistancePct ?? null,
      minHoldBars: trade.trailingMinHoldBars ?? null,
      minHoldMinutes: trade.trailingMinHoldBars ?? null,
      projectedMovePct,
      nearestCalibratedMoveBefore: moveRef(before),
      nearestCalibratedMoveAfter: moveRef(after),
      matchedCalibratedMove: moveRef(matchedMove),
      parityVerdict: matchedVerdict ? {
        moveId: matchedVerdict.moveId,
        runtimeFamily: matchedVerdict.runtimeFamily ?? matchedVerdict.selectedRuntimeFamily ?? null,
        selectedBucket: matchedVerdict.selectedBucket ?? null,
        candidateProduced: matchedVerdict.candidateProduced,
        familyCompatible: matchedVerdict.familyCompatible ?? null,
        directionCompatible: matchedVerdict.directionCompatible ?? null,
        matchReason: matchedVerdict.matchReason ?? null,
        mismatchReason: matchedVerdict.mismatchReason ?? null,
      } : null,
      entryInsideCalibratedMoveWindow: entryInsideMove,
      tradeDirectionAlignedWithCalibratedMove: directionAligned,
      minutesFromMoveStartToEntry: matchedMove ? (trade.entryTs - matchedMove.startTs) / 60 : null,
      minutesFromEntryToMoveEnd: matchedMove ? (matchedMove.endTs - trade.entryTs) / 60 : null,
      reachedProjectedMove25PctBeforeExit: reached25,
      reachedProjectedMove50PctBeforeExit: reached50,
      reachedProjectedMove75PctBeforeExit: reached75,
      reachedProjectedMove100PctBeforeExit: reached100,
      trailingActivated,
      trailingExitBeforeCalibratedMoveEnd: trailingExitBeforeMoveEnd,
      slHitBeforeCalibratedMoveDirectionDeveloped: slHitBeforeMoveDirectionDeveloped,
      outcomeClassification: classifyOutcome({
        trade,
        matchedMove,
        directionAligned,
        reached25,
        reached50,
        reached75,
        trailingExitBeforeMoveEnd,
        entryInsideMove: entryInsideMove,
      }),
    };
  });

  const byRuntimeFamily: Record<string, number> = {};
  const bySelectedBucket: Record<string, number> = {};
  const winLossByRuntimeFamily: Record<string, { wins: number; losses: number }> = {};
  const winLossBySelectedBucket: Record<string, { wins: number; losses: number }> = {};
  const slHitsByRuntimeFamily: Record<string, number> = {};
  const slHitsByBucket: Record<string, number> = {};
  const trailingExitsByRuntimeFamily: Record<string, number> = {};
  const trailingExitsByBucket: Record<string, number> = {};
  const matchedByRuntimeFamily: Record<string, number> = {};
  const classificationCounts: Record<string, number> = {};
  const exitReasonCounts: Record<string, number> = {};

  for (const trade of trades) {
    const familyKey = trade.runtimeFamily ?? "unknown";
    const bucketKey = trade.selectedBucket ?? "unknown";
    bump(byRuntimeFamily, familyKey);
    bump(bySelectedBucket, bucketKey);
    bump(classificationCounts, trade.outcomeClassification);
    bump(exitReasonCounts, trade.exitReason);
    winLossByRuntimeFamily[familyKey] ??= { wins: 0, losses: 0 };
    winLossBySelectedBucket[bucketKey] ??= { wins: 0, losses: 0 };
    if (trade.pnlPct > 0) {
      winLossByRuntimeFamily[familyKey].wins += 1;
      winLossBySelectedBucket[bucketKey].wins += 1;
    } else {
      winLossByRuntimeFamily[familyKey].losses += 1;
      winLossBySelectedBucket[bucketKey].losses += 1;
    }
    if (trade.exitReason === "sl_hit") {
      bump(slHitsByRuntimeFamily, familyKey);
      bump(slHitsByBucket, bucketKey);
    }
    if (trade.exitReason === "trailing_stop") {
      bump(trailingExitsByRuntimeFamily, familyKey);
      bump(trailingExitsByBucket, bucketKey);
    }
    if (trade.parityVerdict?.candidateProduced) {
      bump(matchedByRuntimeFamily, familyKey);
    }
  }

  const losses = trades.filter((trade) => trade.pnlPct <= 0);
  const wins = trades.filter((trade) => trade.pnlPct > 0);
  const slLosses = trades.filter((trade) => trade.exitReason === "sl_hit");
  const matchedTrades = trades.filter((trade) => trade.matchedCalibratedMove);

  return {
    symbol: "CRASH300",
    generatedAt: new Date().toISOString(),
    sourceRun: {
      runId: params.runId,
      createdAt: params.createdAt ?? null,
      startTs: params.result.startTs,
      endTs: params.result.endTs,
      tierMode: params.result.tierMode,
      mode: params.result.mode,
    },
    runtimeModel: {
      promotedModelRunId: parity.runtimeModel.promotedModelRunId ?? params.result.runtimeModel.sourceRunId ?? null,
      stagedModelRunId: parity.runtimeModel.stagedModelRunId ?? null,
      scoringSource: params.result.runtimeModel.source ?? null,
      scoringSourceCounts: params.result.runtimeModel.scoringSourceCounts ?? {},
    },
    parity: {
      totals: parity.totals,
      diagnostics: parity.diagnostics,
    },
    summary: {
      totalTrades: trades.length,
      byRuntimeFamily,
      bySelectedBucket,
      winLossByRuntimeFamily,
      winLossBySelectedBucket,
      slHitsByRuntimeFamily,
      slHitsByBucket,
      trailingExitsByRuntimeFamily,
      trailingExitsByBucket,
      averageMfeBeforeSl: avg(slLosses.map((trade) => trade.mfePct)),
      averageMaeBeforeWin: avg(wins.map((trade) => trade.maePct)),
      averageEntryDelayFromMoveStartMinutes: avg(matchedTrades.map((trade) => trade.minutesFromMoveStartToEntry ?? 0)),
      averageExitTimeVsMoveEndMinutes: avg(matchedTrades.map((trade) => ((trade.exitTs - (trade.matchedCalibratedMove?.endTs ?? trade.exitTs)) / 60))),
      exitCounts: exitReasonCounts,
      lossesWhereMfeExceeded1PctBeforeSl: losses.filter((trade) => trade.exitReason === "sl_hit" && trade.mfePct >= 0.01).length,
      lossesWhereMfeExceeded2PctBeforeSl: losses.filter((trade) => trade.exitReason === "sl_hit" && trade.mfePct >= 0.02).length,
      lossesWhereMfeExceeded3PctBeforeSl: losses.filter((trade) => trade.exitReason === "sl_hit" && trade.mfePct >= 0.03).length,
      tradesWithNoMatchingCalibratedMove: trades.filter((trade) => !trade.matchedCalibratedMove).length,
      matchedByRuntimeFamily,
      outcomeClassificationCounts: classificationCounts,
    },
    trades,
  };
}
