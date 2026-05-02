import { db, detectedMovesTable } from "@workspace/db";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import type { V3BacktestResult, V3BacktestTrade } from "./backtestRunner.js";
import { runCrash300CalibrationParity, runCrash300RuntimeTriggerValidation } from "../../symbol-services/CRASH300/calibration.js";
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
  contextSnapshotAtEntry: Record<string, unknown> | null;
  triggerSnapshotAtEntry: Record<string, unknown> | null;
  contextFamilyCandidates: Array<Record<string, unknown>> | null;
  selectedContextFamily: string | null;
  selectedTriggerTransition: string | null;
  triggerDirection: string | null;
  triggerStrengthScore: number | null;
  contextAgeBars: number | null;
  contextAgeMinutes: number | null;
  triggerAgeBars: number | null;
  triggerFresh: boolean | null;
  contextEpochId: string | null;
  duplicateWithinContextEpoch: boolean | null;
  previousTradeInSameContextEpoch: string | null;
  wouldBlockNoTrigger: boolean | null;
  wouldBlockStaleContext: boolean | null;
  wouldBlockDuplicateEpoch: boolean | null;
  wouldBlockDirectionMismatch: boolean | null;
  wouldBlockLateAfterMoveWindow: boolean | null;
  admissionPolicyWouldBlock: boolean | null;
  admissionPolicyBlockedReasons: string[] | null;
  admissionPolicyMode: string | null;
  familyDirection: "buy" | "sell" | "unknown";
  bucketDirection: "buy" | "sell" | "unknown";
  moveExpectedDirection: "buy" | "sell" | "unknown";
  directionConsistencyFlags: string[];
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

function keyOf(value: string | null | undefined): string {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized : "unknown";
}

function avgNullable(values: Array<number | null | undefined>): number {
  const filtered = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return avg(filtered);
}

function familyDirection(runtimeFamily: string | null): "buy" | "sell" | "unknown" {
  const family = keyOf(runtimeFamily).toLowerCase();
  if ([
    "drift_continuation_up",
    "post_crash_recovery_up",
    "bear_trap_reversal_up",
  ].includes(family)) return "buy";
  if ([
    "failed_recovery_short",
    "crash_event_down",
    "bull_trap_reversal_down",
  ].includes(family)) return "sell";
  return "unknown";
}

function bucketDirection(selectedBucket: string | null): "buy" | "sell" | "unknown" {
  const [direction] = keyOf(selectedBucket).split("|");
  if (direction === "up") return "buy";
  if (direction === "down") return "sell";
  return "unknown";
}

function moveDirectionToTradeDirection(direction: "up" | "down" | "unknown"): "buy" | "sell" | "unknown" {
  if (direction === "up") return "buy";
  if (direction === "down") return "sell";
  return "unknown";
}

function summarizeSimulatedTrades(trades: AttributionTradeRow[]) {
  const wins = trades.filter((trade) => trade.pnlPct > 0);
  const losses = trades.length - wins.length;
  const totalPnlPct = trades.reduce((sum, trade) => sum + trade.pnlPct, 0);
  return {
    remainingTrades: trades.length,
    wins: wins.length,
    losses,
    newWinRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    newSlHitCount: trades.filter((trade) => trade.exitReason === "sl_hit").length,
    newTrailingStopCount: trades.filter((trade) => trade.exitReason === "trailing_stop").length,
    newTotalPnlPct: totalPnlPct,
  };
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
    const derivedFamilyDirection = familyDirection(trade.runtimeFamily ?? null);
    const derivedBucketDirection = bucketDirection(trade.selectedBucket ?? null);
    const matchedMoveDirection = moveDirectionToTradeDirection(matchedMove?.direction ?? "unknown");
    const directionConsistencyFlags: string[] = [];
    if (derivedFamilyDirection !== "unknown" && derivedBucketDirection !== "unknown" && derivedFamilyDirection !== derivedBucketDirection) {
      directionConsistencyFlags.push("family_bucket_direction_mismatch");
    }
    if (trade.triggerDirection && trade.triggerDirection !== "unknown" && trade.triggerDirection !== "none" && trade.triggerDirection !== trade.direction) {
      directionConsistencyFlags.push("trigger_trade_direction_mismatch");
    }
    if (matchedMoveDirection !== "unknown" && trade.direction !== matchedMoveDirection) {
      directionConsistencyFlags.push("trade_move_direction_mismatch");
    }
    if ((trade.runtimeFamily ?? null) === "post_crash_recovery_up" && matchedMove?.direction === "down") {
      directionConsistencyFlags.push("recovery_up_family_on_down_move");
    }
    if ((trade.runtimeFamily ?? null) === "crash_event_down" && matchedMove?.direction === "up") {
      directionConsistencyFlags.push("crash_down_family_on_up_move");
    }

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
      contextSnapshotAtEntry: trade.contextSnapshotAtEntry ?? null,
      triggerSnapshotAtEntry: trade.triggerSnapshotAtEntry ?? null,
      contextFamilyCandidates: trade.contextFamilyCandidates ?? null,
      selectedContextFamily: trade.selectedContextFamily ?? null,
      selectedTriggerTransition: trade.selectedTriggerTransition ?? null,
      triggerDirection: trade.triggerDirection ?? null,
      triggerStrengthScore: trade.triggerStrengthScore ?? null,
      contextAgeBars: trade.contextAgeBars ?? null,
      contextAgeMinutes: trade.contextAgeMinutes ?? null,
      triggerAgeBars: trade.triggerAgeBars ?? null,
      triggerFresh: trade.triggerFresh ?? null,
      contextEpochId: trade.contextEpochId ?? null,
      duplicateWithinContextEpoch: trade.duplicateWithinContextEpoch ?? null,
      previousTradeInSameContextEpoch: trade.previousTradeInSameContextEpoch ?? null,
      wouldBlockNoTrigger: trade.wouldBlockNoTrigger ?? null,
      wouldBlockStaleContext: trade.wouldBlockStaleContext ?? null,
      wouldBlockDuplicateEpoch: trade.wouldBlockDuplicateEpoch ?? null,
      wouldBlockDirectionMismatch: trade.wouldBlockDirectionMismatch ?? null,
      wouldBlockLateAfterMoveWindow: trade.wouldBlockLateAfterMoveWindow ?? null,
      admissionPolicyWouldBlock: trade.admissionPolicyWouldBlock ?? null,
      admissionPolicyBlockedReasons: trade.admissionPolicyBlockedReasons ?? null,
      admissionPolicyMode: trade.admissionPolicyMode ?? null,
      familyDirection: derivedFamilyDirection,
      bucketDirection: derivedBucketDirection,
      moveExpectedDirection: matchedMoveDirection,
      directionConsistencyFlags,
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

  const losses = trades.filter((trade) => trade.pnlPct <= 0);
  const wins = trades.filter((trade) => trade.pnlPct > 0);
  const slLosses = trades.filter((trade) => trade.exitReason === "sl_hit");
  const matchedTrades = trades.filter((trade) => trade.matchedCalibratedMove);
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
    const familyKey = keyOf(trade.runtimeFamily);
    const bucketKey = keyOf(trade.selectedBucket);
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

  const tradesWithNoFreshTrigger = trades.filter((trade) => trade.triggerFresh === false).length;
  const tradesFromStaleContext = trades.filter((trade) => trade.wouldBlockStaleContext === true).length;
  const duplicateEpochTrades = trades.filter((trade) => trade.duplicateWithinContextEpoch === true || trade.wouldBlockDuplicateEpoch === true).length;
  const wrongDirectionWithTrigger = trades.filter((trade) => trade.tradeDirectionAlignedWithCalibratedMove === false && trade.triggerFresh === true).length;
  const lossesFromStaleContext = losses.filter((trade) => trade.wouldBlockStaleContext === true).length;
  const lossesFromDuplicateEpoch = losses.filter((trade) => trade.duplicateWithinContextEpoch === true || trade.wouldBlockDuplicateEpoch === true).length;
  const lossesWithNoFreshTrigger = losses.filter((trade) => trade.triggerFresh === false || trade.wouldBlockNoTrigger === true).length;
  const estimatedTradesAfterFreshTriggerOnly = trades.filter((trade) => trade.triggerFresh !== false && trade.wouldBlockNoTrigger !== true && trade.wouldBlockStaleContext !== true).length;
  const estimatedLossesRemovedByFreshTriggerOnly = losses.filter((trade) => trade.triggerFresh === false || trade.wouldBlockNoTrigger === true || trade.wouldBlockStaleContext === true).length;
  const estimatedTradesAfterOnePerContextEpoch = trades.filter((trade) => trade.duplicateWithinContextEpoch !== true && trade.wouldBlockDuplicateEpoch !== true).length;
  const estimatedLossesRemovedByOnePerEpoch = losses.filter((trade) => trade.duplicateWithinContextEpoch === true || trade.wouldBlockDuplicateEpoch === true).length;
  const totalLosses = losses.length;
  const overallWinRate = trades.length > 0 ? wins.length / trades.length : 0;
  const overallSlHitRate = trades.length > 0 ? trades.filter((trade) => trade.exitReason === "sl_hit").length / trades.length : 0;
  const overallTargetUnrealisticRate = trades.length > 0 ? trades.filter((trade) => trade.outcomeClassification === "target_unrealistic_for_bucket").length / trades.length : 0;
  const overallWrongDirectionRate = trades.length > 0 ? trades.filter((trade) => trade.outcomeClassification === "wrong_direction").length / trades.length : 0;
  const familyBucketDirectionMismatchCount = trades.filter((trade) => trade.directionConsistencyFlags.includes("family_bucket_direction_mismatch")).length;
  const triggerTradeDirectionMismatchCount = trades.filter((trade) => trade.directionConsistencyFlags.includes("trigger_trade_direction_mismatch")).length;
  const tradeMoveDirectionMismatchCount = trades.filter((trade) => trade.directionConsistencyFlags.includes("trade_move_direction_mismatch")).length;
  const recoveryUpFamilyOnDownMoveCount = trades.filter((trade) => trade.directionConsistencyFlags.includes("recovery_up_family_on_down_move")).length;
  const crashDownFamilyOnUpMoveCount = trades.filter((trade) => trade.directionConsistencyFlags.includes("crash_down_family_on_up_move")).length;

  const buildGroupReport = (groupName: string, keyFn: (trade: AttributionTradeRow) => string) => {
    const map = new Map<string, AttributionTradeRow[]>();
    for (const trade of trades) {
      const key = keyFn(trade);
      const bucket = map.get(key);
      if (bucket) bucket.push(trade);
      else map.set(key, [trade]);
    }
    const materialLossFloor = Math.max(2, Math.ceil(totalLosses / Math.max(1, map.size)));
    return Array.from(map.entries()).map(([key, groupTrades]) => {
      const groupWins = groupTrades.filter((trade) => trade.pnlPct > 0);
      const groupLosses = groupTrades.length - groupWins.length;
      const slHitCount = groupTrades.filter((trade) => trade.exitReason === "sl_hit").length;
      const trailingStopCount = groupTrades.filter((trade) => trade.exitReason === "trailing_stop").length;
      const wrongDirectionCount = groupTrades.filter((trade) => trade.outcomeClassification === "wrong_direction").length;
      const enteredTooEarlyCount = groupTrades.filter((trade) => trade.outcomeClassification === "entered_too_early").length;
      const enteredTooLateCount = groupTrades.filter((trade) => trade.outcomeClassification === "entered_too_late").length;
      const targetUnrealisticCount = groupTrades.filter((trade) => trade.outcomeClassification === "target_unrealistic_for_bucket").length;
      const trailingTooEarlyCount = groupTrades.filter((trade) => trade.outcomeClassification === "good_entry_trailing_too_early").length;
      const winRate = groupTrades.length > 0 ? groupWins.length / groupTrades.length : 0;
      const slHitRate = groupTrades.length > 0 ? slHitCount / groupTrades.length : 0;
      const wrongDirectionRate = groupTrades.length > 0 ? wrongDirectionCount / groupTrades.length : 0;
      const targetUnrealisticRate = groupTrades.length > 0 ? targetUnrealisticCount / groupTrades.length : 0;
      const weakGroupReasons: string[] = [];
      const materialLosses = groupLosses >= materialLossFloor;
      if (materialLosses && slHitRate > overallSlHitRate) weakGroupReasons.push("sl_hit_rate_above_month_average");
      if (materialLosses && winRate < overallWinRate) weakGroupReasons.push("win_rate_below_month_average");
      if (materialLosses && targetUnrealisticRate > overallTargetUnrealisticRate) weakGroupReasons.push("target_unrealistic_rate_above_month_average");
      if (materialLosses && wrongDirectionRate > overallWrongDirectionRate) weakGroupReasons.push("wrong_direction_rate_above_month_average");
      if (groupTrades.some((trade) => trade.directionConsistencyFlags.includes("family_bucket_direction_mismatch"))) weakGroupReasons.push("family_bucket_direction_mismatch_present");
      return {
        groupName,
        key,
        trades: groupTrades.length,
        wins: groupWins.length,
        losses: groupLosses,
        winRatePct: winRate * 100,
        slHitCount,
        trailingStopCount,
        avgPnlPct: avg(groupTrades.map((trade) => trade.pnlPct)),
        avgMfePct: avg(groupTrades.map((trade) => trade.mfePct)),
        avgMaePct: avg(groupTrades.map((trade) => trade.maePct)),
        avgMfeBeforeSl: avg(groupTrades.filter((trade) => trade.exitReason === "sl_hit").map((trade) => trade.mfePct)),
        avgMaeBeforeWin: avg(groupWins.map((trade) => trade.maePct)),
        avgEntryDelayFromMoveStartMinutes: avgNullable(groupTrades.map((trade) => trade.minutesFromMoveStartToEntry)),
        wrongDirectionCount,
        enteredTooEarlyCount,
        enteredTooLateCount,
        targetUnrealisticCount,
        trailingTooEarlyCount,
        weakGroupReasons,
      };
    }).sort((a, b) => b.trades - a.trades || a.key.localeCompare(b.key));
  };

  const groupedPerformance = {
    byRuntimeFamily: buildGroupReport("runtimeFamily", (trade) => keyOf(trade.runtimeFamily)),
    bySelectedBucket: buildGroupReport("selectedBucket", (trade) => keyOf(trade.selectedBucket)),
    byTriggerTransition: buildGroupReport("triggerTransition", (trade) => keyOf(trade.selectedTriggerTransition)),
    byTriggerDirection: buildGroupReport("triggerDirection", (trade) => keyOf(trade.triggerDirection)),
    byQualityTier: buildGroupReport("qualityTier", (trade) => keyOf(trade.qualityTier)),
    byContextFamilyAndTriggerTransition: buildGroupReport("contextFamily+triggerTransition", (trade) => `${keyOf(trade.selectedContextFamily)}|${keyOf(trade.selectedTriggerTransition)}`),
    byRuntimeFamilyBucketTrigger: buildGroupReport("runtimeFamily+selectedBucket+triggerTransition", (trade) => `${keyOf(trade.runtimeFamily)}|${keyOf(trade.selectedBucket)}|${keyOf(trade.selectedTriggerTransition)}`),
  };

  const weakGroups = Object.values(groupedPerformance)
    .flat()
    .filter((group) => group.weakGroupReasons.length > 0);

  const buildSimulation = (name: string, reason: string, removePredicate: (trade: AttributionTradeRow) => boolean) => {
    const removedTrades = trades.filter(removePredicate);
    const keptTrades = trades.filter((trade) => !removePredicate(trade));
    const removedWins = removedTrades.filter((trade) => trade.pnlPct > 0).length;
    const removedLosses = removedTrades.length - removedWins;
    const keptSummary = summarizeSimulatedTrades(keptTrades);
    const baselinePnl = trades.reduce((sum, trade) => sum + trade.pnlPct, 0);
    return {
      name,
      reason,
      removedTrades: removedTrades.length,
      removedWins,
      removedLosses,
      estimatedNetPnlChange: keptSummary.newTotalPnlPct - baselinePnl,
      ...keptSummary,
    };
  };

  const whatIfDisabled = [
    buildSimulation("disable_post_crash_recovery_up", "Disable post_crash_recovery_up family", (trade) => trade.runtimeFamily === "post_crash_recovery_up"),
    buildSimulation("disable_up_recovery_10_plus_pct", "Disable up|recovery|10_plus_pct bucket", (trade) => trade.selectedBucket === "up|recovery|10_plus_pct"),
    buildSimulation("disable_family_bucket_direction_mismatch", "Disable trades with family/bucket direction mismatch", (trade) => trade.directionConsistencyFlags.includes("family_bucket_direction_mismatch")),
    buildSimulation("disable_wrong_direction_with_trigger", "Disable trades with wrong direction despite fresh trigger", (trade) => trade.outcomeClassification === "wrong_direction" && trade.triggerFresh === true),
    buildSimulation("disable_entered_too_early", "Disable entries classified entered_too_early", (trade) => trade.outcomeClassification === "entered_too_early"),
    buildSimulation("disable_entered_too_late", "Disable entries classified entered_too_late", (trade) => trade.outcomeClassification === "entered_too_late"),
    buildSimulation("allow_only_bear_trap_reversal_up", "Allow only bear_trap_reversal_up family", (trade) => trade.runtimeFamily !== "bear_trap_reversal_up"),
    buildSimulation("allow_only_crash_event_down", "Allow only crash_event_down family", (trade) => trade.runtimeFamily !== "crash_event_down"),
    buildSimulation("allow_only_crash_event_down_plus_bear_trap_reversal_up", "Allow only crash_event_down and bear_trap_reversal_up families", (trade) => !["crash_event_down", "bear_trap_reversal_up"].includes(keyOf(trade.runtimeFamily))),
  ];

  const parityTimingDiagnostic = await runCrash300RuntimeTriggerValidation({
    startTs: params.result.startTs,
    endTs: params.result.endTs,
  });

  const recommendationReport = {
    groupsToDisableFirst: weakGroups
      .filter((group) => group.weakGroupReasons.some((reason) => [
        "sl_hit_rate_above_month_average",
        "wrong_direction_rate_above_month_average",
        "family_bucket_direction_mismatch_present",
      ].includes(reason)))
      .map((group) => ({ groupName: group.groupName, key: group.key, reasons: group.weakGroupReasons })),
    groupsToKeep: groupedPerformance.byRuntimeFamily
      .filter((group) => group.losses === 0 || (group.winRatePct >= overallWinRate * 100 && group.weakGroupReasons.length === 0))
      .map((group) => ({ groupName: group.groupName, key: group.key })),
    groupsNeedingMoreData: Object.values(groupedPerformance)
      .flat()
      .filter((group) => group.trades <= 3)
      .map((group) => ({ groupName: group.groupName, key: group.key, trades: group.trades })),
    parityTimingIssueSummary: {
      totalMoves: parityTimingDiagnostic.aggregates.totalMoves,
      movesWithCandidateAtT0: parityTimingDiagnostic.aggregates.candidateAtT0Count,
      movesWithCandidateBeforeT0: parityTimingDiagnostic.aggregates.movesWithCandidateBeforeT0,
      movesWithCandidateAfterT0: parityTimingDiagnostic.aggregates.movesWithCandidateAfterT0,
      movesWithNoCandidateAtAnyOffset: parityTimingDiagnostic.aggregates.movesWithNoCandidateAtAnyOffset,
      commonBestTriggerOffsets: parityTimingDiagnostic.aggregates.commonBestTriggerOffsets,
      commonT0FailureReasons: parityTimingDiagnostic.aggregates.commonT0FailureReasons,
    },
    safestNextRuntimeChange: {
      previewOnly: true,
      recommendation: "Use this report to preview disabling weak family/bucket groups before any runtime admission change.",
      strongestDisableCandidate: whatIfDisabled.sort((a, b) => b.estimatedNetPnlChange - a.estimatedNetPnlChange)[0] ?? null,
    },
  };

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
    admissionPolicy: params.result.admissionPolicy,
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
      tradesWithNoFreshTrigger,
      tradesFromStaleContext,
      duplicateEpochTrades,
      wrongDirectionWithTrigger,
      lossesFromStaleContext,
      lossesFromDuplicateEpoch,
      lossesWithNoFreshTrigger,
      estimatedTradesAfterFreshTriggerOnly,
      estimatedLossesRemovedByFreshTriggerOnly,
      estimatedTradesAfterOnePerContextEpoch,
      estimatedLossesRemovedByOnePerEpoch,
      familyBucketDirectionMismatchCount,
      triggerTradeDirectionMismatchCount,
      tradeMoveDirectionMismatchCount,
      recoveryUpFamilyOnDownMoveCount,
      crashDownFamilyOnUpMoveCount,
    },
    familyBucketAdmissionAnalysis: {
      monthAverages: {
        totalTrades: trades.length,
        wins: wins.length,
        losses: totalLosses,
        winRatePct: overallWinRate * 100,
        slHitRatePct: overallSlHitRate * 100,
        targetUnrealisticRatePct: overallTargetUnrealisticRate * 100,
        wrongDirectionRatePct: overallWrongDirectionRate * 100,
      },
      groupedPerformance,
      weakGroups,
      directionConsistency: {
        familyBucketDirectionMismatchCount,
        triggerTradeDirectionMismatchCount,
        tradeMoveDirectionMismatchCount,
        recoveryUpFamilyOnDownMoveCount,
        crashDownFamilyOnUpMoveCount,
      },
      whatIfDisabled,
    },
    parityTimingDiagnostic,
    recommendationReport,
    trades,
  };
}
