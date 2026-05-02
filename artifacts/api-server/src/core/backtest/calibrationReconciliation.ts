import { db, detectedMovesTable } from "@workspace/db";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { buildCrash300TradeOutcomeAttributionReport } from "./tradeOutcomeAttribution.js";
import { runCrash300RuntimeTriggerValidation } from "../../symbol-services/CRASH300/calibration.js";
import { directionFromCrash300Bucket } from "../../symbol-services/CRASH300/bucketSemantics.js";
import { directionFromCrash300Family, moveDirectionFromCrash300Family } from "../../symbol-services/CRASH300/familySemantics.js";
import type { V3BacktestResult } from "./backtestRunner.js";

type AttributionReport = Awaited<ReturnType<typeof buildCrash300TradeOutcomeAttributionReport>>;
type AttributionTrade = AttributionReport["trades"][number];
type ValidationReport = Awaited<ReturnType<typeof runCrash300RuntimeTriggerValidation>>;
type ValidationRow = ValidationReport["rows"][number];

function keyOf(value: string | null | undefined): string {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized : "unknown";
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function bump(map: Record<string, number>, key: string) {
  map[key] = (map[key] ?? 0) + 1;
}

function moveSizeBucket(movePct: number): string {
  if (movePct >= 10) return "10_plus_pct";
  if (movePct >= 8) return "8_to_10_pct";
  if (movePct >= 6) return "6_to_8_pct";
  return "5_to_6_pct";
}

function directionMatches(moveDirection: string | null | undefined, tradeDirection: string | null | undefined): boolean {
  if (moveDirection === "up") return tradeDirection === "buy";
  if (moveDirection === "down") return tradeDirection === "sell";
  return false;
}

function moveDirectionToTradeDirection(direction: string | null | undefined): "buy" | "sell" | "unknown" {
  if (direction === "up") return "buy";
  if (direction === "down") return "sell";
  return "unknown";
}

function normalizeMoveDirection(direction: string | null | undefined): "up" | "down" | "unknown" {
  if (direction === "up" || direction === "down") return direction;
  return "unknown";
}

function isSemanticConflictFlag(flag: string): boolean {
  return [
    "family_bucket_direction_mismatch",
    "trigger_trade_direction_mismatch",
    "trade_move_direction_mismatch",
    "recovery_up_family_on_down_move",
    "crash_down_family_on_up_move",
  ].includes(flag);
}

function moveValidationConflictReasons(params: {
  moveDirection: "up" | "down" | "unknown";
  familyAtT0: string | null;
  bucketAtT0: string | null;
  triggerDirectionAtT0: "buy" | "sell" | "none";
  bestRuntimeFamily: string | null;
  bestSelectedBucket: string | null;
}): string[] {
  const reasons: string[] = [];
  const expectedTradeDirection = moveDirectionToTradeDirection(params.moveDirection);
  const t0FamilyDirection = directionFromCrash300Family((params.familyAtT0 as Parameters<typeof directionFromCrash300Family>[0]) ?? "unknown");
  const t0BucketDirection = directionFromCrash300Bucket(params.bucketAtT0);
  const bestFamilyMoveDirection = moveDirectionFromCrash300Family((params.bestRuntimeFamily as Parameters<typeof moveDirectionFromCrash300Family>[0]) ?? "unknown");
  const bestBucketDirection = directionFromCrash300Bucket(params.bestSelectedBucket);

  if (expectedTradeDirection !== "unknown" && params.triggerDirectionAtT0 !== "none" && params.triggerDirectionAtT0 !== expectedTradeDirection) {
    reasons.push("trigger_trade_direction_mismatch");
  }
  if (t0FamilyDirection !== "unknown" && params.triggerDirectionAtT0 !== "none" && t0FamilyDirection !== params.triggerDirectionAtT0) {
    reasons.push("family_trigger_direction_mismatch");
  }
  if (t0BucketDirection !== "unknown" && params.triggerDirectionAtT0 !== "none" && t0BucketDirection !== params.triggerDirectionAtT0) {
    reasons.push("bucket_trigger_direction_mismatch");
  }
  if (t0FamilyDirection !== "unknown" && t0BucketDirection !== "unknown" && t0FamilyDirection !== t0BucketDirection) {
    reasons.push("family_bucket_direction_mismatch");
  }
  if (params.moveDirection === "down" && bestFamilyMoveDirection === "up") {
    reasons.push("recovery_up_family_on_down_move");
  }
  if (params.moveDirection === "up" && bestFamilyMoveDirection === "down") {
    reasons.push("crash_down_family_on_up_move");
  }
  if (expectedTradeDirection !== "unknown" && bestBucketDirection !== "unknown" && bestBucketDirection !== expectedTradeDirection) {
    reasons.push("trade_move_direction_mismatch");
  }
  return [...new Set(reasons)];
}

function buildNearestRef(trade: AttributionTrade, field: "nearestCalibratedMoveBefore" | "nearestCalibratedMoveAfter") {
  const move = trade[field];
  if (!move) return null;
  return {
    moveId: move.moveId,
    startTs: move.startTs,
    endTs: move.endTs,
    direction: move.direction,
    movePct: move.movePct,
    moveFamily: move.moveFamily,
    qualityTier: move.qualityTier,
  };
}

function relationToMove(trade: AttributionTrade) {
  const matched = trade.matchedCalibratedMove;
  if (matched) {
    if (trade.entryTs >= matched.startTs && trade.entryTs <= matched.endTs) return "inside_move";
    if (trade.entryTs < matched.startTs) return "before_move_precursor";
    if (trade.entryTs > matched.endTs) return "after_move_late";
  }
  if (trade.nearestCalibratedMoveBefore && trade.nearestCalibratedMoveAfter) return "between_moves";
  return "outside_all_moves";
}

function wouldHaveCapturedMoveIfHeld(trade: AttributionTrade) {
  const matched = trade.matchedCalibratedMove;
  if (!matched) return false;
  return trade.tradeDirectionAlignedWithCalibratedMove && trade.reachedProjectedMove50PctBeforeExit;
}

function isNoiseTrade(trade: AttributionTrade) {
  const relation = relationToMove(trade);
  return relation === "outside_all_moves" || relation === "between_moves";
}

function classifyCapturedMove(trades: AttributionTrade[]): string {
  const first = trades[0];
  if (!first) return "missed_no_candidate";
  if (!first.tradeDirectionAlignedWithCalibratedMove) return "wrong_direction_trade";
  if (first.entryTs < (first.matchedCalibratedMove?.startTs ?? 0)) return "captured_early";
  if ((first.minutesFromMoveStartToEntry ?? 0) > 0) return "captured_late";
  if (first.exitReason === "sl_hit" && !first.reachedProjectedMove25PctBeforeExit) return "stopped_before_move_developed";
  if (first.trailingExitBeforeCalibratedMoveEnd) return "exited_before_mfe";
  return "captured_clean";
}

function classifyMissedMove(params: {
  validation: ValidationRow | null;
  admissionPolicyEnabled: boolean;
  admissionPolicyConfig: Record<string, unknown> | null;
}): string {
  const { validation, admissionPolicyEnabled, admissionPolicyConfig } = params;
  if (!validation) return "missed_no_candidate";
  if (String(validation.failReasonAtT0 ?? "") === "runtime_exit_policy_missing_for_phase_bucket") {
    return "missed_exit_policy_missing";
  }
  const runtimeAtT0 = (validation.runtimeAtT0 ?? {}) as Record<string, unknown>;
  const runtimeAtBest = validation.bestTriggerOffset
    ? (Object.values(validation).find((value) => {
        if (!value || typeof value !== "object") return false;
        return String((value as Record<string, unknown>).label ?? "") === String(validation.bestTriggerOffset);
      }) as Record<string, unknown> | undefined)
    : undefined;
  const candidateExists = Boolean(runtimeAtT0["candidateProduced"]) || Boolean(runtimeAtBest?.["candidateProduced"]);
  if (candidateExists && admissionPolicyEnabled) {
    const family = String(validation.bestRuntimeFamily ?? validation.familyAtT0 ?? "");
    const bucket = String(validation.bestSelectedBucket ?? validation.bucketAtT0 ?? "");
    const config = admissionPolicyConfig ?? {};
    if (Boolean(config["blockPostCrashRecoveryUp"]) && family === "post_crash_recovery_up") {
      return "missed_candidate_blocked";
    }
    if (Boolean(config["blockUpRecovery10PlusPct"]) && bucket === "up|recovery|10_plus_pct") {
      return "missed_candidate_blocked";
    }
  }
  return "missed_no_candidate";
}

function allocationPctForConfidence(confidence: number | null | undefined): number {
  const value = typeof confidence === "number" && Number.isFinite(confidence) ? confidence : 0;
  if (value < 0.45) return 0.10;
  if (value <= 0.55) return 0.20;
  if (value <= 0.65) return 0.30;
  if (value <= 0.75) return 0.40;
  return 0.50;
}

function simulateAllocation(trades: AttributionTrade[], params: {
  startingCapitalUsd: number;
  mode: "fixed_15" | "fixed_30" | "fixed_50" | "confidence";
}) {
  const sorted = trades.slice().sort((a, b) => a.entryTs - b.entryTs);
  let capital = params.startingCapitalUsd;
  let peak = capital;
  let worstDayLoss = 0;
  let maxConsecutiveLossImpact = 0;
  let currentConsecutiveLossImpact = 0;
  let maxOverlap = 0;
  const dayPnL = new Map<string, number>();
  const active: Array<{ exitTs: number; allocationPct: number }> = [];
  let peakExposure = 0;
  for (const trade of sorted) {
    for (let i = active.length - 1; i >= 0; i -= 1) {
      if (active[i].exitTs <= trade.entryTs) active.splice(i, 1);
    }
    const usedExposure = active.reduce((sum, item) => sum + item.allocationPct, 0);
    const requested = params.mode === "fixed_15"
      ? 0.15
      : params.mode === "fixed_30"
        ? 0.30
        : params.mode === "fixed_50"
          ? 0.50
          : allocationPctForConfidence(trade.confidence);
    const allocationPct = Math.max(0, Math.min(requested, 0.90 - usedExposure));
    peakExposure = Math.max(peakExposure, usedExposure + allocationPct);
    maxOverlap = Math.max(maxOverlap, active.length + 1);
    const positionCapital = capital * allocationPct;
    const pnlUsd = positionCapital * trade.pnlPct;
    capital += pnlUsd;
    peak = Math.max(peak, capital);
    const drawdownPct = peak > 0 ? (peak - capital) / peak : 0;
    const exitDay = new Date(trade.exitTs * 1000).toISOString().slice(0, 10);
    dayPnL.set(exitDay, (dayPnL.get(exitDay) ?? 0) + pnlUsd);
    if (pnlUsd < 0) {
      currentConsecutiveLossImpact += Math.abs(pnlUsd);
      maxConsecutiveLossImpact = Math.max(maxConsecutiveLossImpact, currentConsecutiveLossImpact);
    } else {
      currentConsecutiveLossImpact = 0;
    }
    active.push({ exitTs: trade.exitTs, allocationPct });
    peakExposure = Math.max(peakExposure, active.reduce((sum, item) => sum + item.allocationPct, 0));
    (trade as AttributionTrade & { __simDrawdownPct?: number }).__simDrawdownPct = drawdownPct;
  }
  worstDayLoss = Math.min(0, ...dayPnL.values());
  const maxDrawdownPct = sorted.reduce((max, trade) => {
    const value = (trade as AttributionTrade & { __simDrawdownPct?: number }).__simDrawdownPct ?? 0;
    return Math.max(max, value);
  }, 0);
  return {
    accountReturnPct: params.startingCapitalUsd > 0 ? (capital - params.startingCapitalUsd) / params.startingCapitalUsd : 0,
    endingCapitalUsd: capital,
    maxDrawdownPct,
    maxConsecutiveLossImpact,
    worstDayLoss,
    exposureUsed: peakExposure,
    numberOfOverlappingTrades: Math.max(0, maxOverlap - 1),
    marginRiskWarnings: [
      ...(peakExposure > 0.90 ? ["max_exposure_capped"] : []),
      ...(maxOverlap > 1 ? ["overlapping_trades_present"] : []),
    ],
  };
}

export async function buildCrash300CalibrationReconciliationReport(params: {
  runId: number;
  result: V3BacktestResult;
  createdAt?: string | null;
}) {
  if (params.result.symbol !== "CRASH300") {
    throw new Error("Calibration reconciliation is currently available for CRASH300 only.");
  }
  const attribution = await buildCrash300TradeOutcomeAttributionReport(params);
  const validation = await runCrash300RuntimeTriggerValidation({
    startTs: params.result.startTs,
    endTs: params.result.endTs,
  });
  const detectedMoves = await db
    .select({
      id: detectedMovesTable.id,
      startTs: detectedMovesTable.startTs,
      endTs: detectedMovesTable.endTs,
      direction: detectedMovesTable.direction,
      movePct: detectedMovesTable.movePct,
      qualityTier: detectedMovesTable.qualityTier,
      moveType: detectedMovesTable.moveType,
    })
    .from(detectedMovesTable)
    .where(and(
      eq(detectedMovesTable.symbol, "CRASH300"),
      gte(detectedMovesTable.startTs, params.result.startTs),
      lte(detectedMovesTable.startTs, params.result.endTs),
    ))
    .orderBy(asc(detectedMovesTable.startTs));
  const detectedMoveById = new Map<number, typeof detectedMoves[number]>();
  for (const move of detectedMoves) detectedMoveById.set(Number(move.id), move);

  const trades = attribution.trades.map((trade) => {
    const relation = relationToMove(trade);
    const semanticConflictFlags = trade.directionConsistencyFlags.filter(isSemanticConflictFlag);
    return {
      tradeId: trade.tradeId,
      entryTs: trade.entryTs,
      exitTs: trade.exitTs,
      direction: trade.direction,
      runtimeFamily: trade.runtimeFamily,
      selectedBucket: trade.selectedBucket,
      triggerTransition: trade.selectedTriggerTransition,
      matchedMoveId: trade.matchedCalibratedMove?.moveId ?? null,
      relationToMove: relation,
      nearestMoveBefore: buildNearestRef(trade, "nearestCalibratedMoveBefore"),
      nearestMoveAfter: buildNearestRef(trade, "nearestCalibratedMoveAfter"),
      minutesToNearestMoveStart: trade.nearestCalibratedMoveAfter
        ? Math.round((trade.nearestCalibratedMoveAfter.startTs - trade.entryTs) / 60)
        : null,
      minutesFromPreviousMoveEnd: trade.nearestCalibratedMoveBefore
        ? Math.round((trade.entryTs - trade.nearestCalibratedMoveBefore.endTs) / 60)
        : null,
      tradeOutcomeClassification: trade.outcomeClassification,
      wasProfitable: trade.pnlPct > 0,
      exitReason: trade.exitReason,
      pnlPct: trade.pnlPct,
      mfePct: trade.mfePct,
      maePct: trade.maePct,
      wouldHaveCapturedMoveIfHeld: wouldHaveCapturedMoveIfHeld(trade),
      wasNoiseTrade: isNoiseTrade(trade),
      semanticConflictFlags,
      hasSemanticConflict: semanticConflictFlags.length > 0,
    };
  });

  const tradesByMoveId = new Map<number, AttributionTrade[]>();
  for (const trade of attribution.trades) {
    const moveId = trade.matchedCalibratedMove?.moveId;
    if (typeof moveId !== "number") continue;
    const list = tradesByMoveId.get(moveId);
    if (list) list.push(trade);
    else tradesByMoveId.set(moveId, [trade]);
  }

  const moves = validation.rows.map((row) => {
    const validationRow = row;
    const moveId = Number(row.moveId);
    const moveMeta = detectedMoveById.get(moveId);
    const linkedTrades = (tradesByMoveId.get(moveId) ?? []).slice().sort((a, b) => a.entryTs - b.entryTs);
    const first = linkedTrades[0] ?? null;
    const wasCaptured = linkedTrades.length > 0;
    const semanticConflictReasons = moveValidationConflictReasons({
      moveDirection: normalizeMoveDirection(String(row.moveDirection ?? "unknown")),
      familyAtT0: typeof row.familyAtT0 === "string" ? row.familyAtT0 : null,
      bucketAtT0: typeof row.bucketAtT0 === "string" ? row.bucketAtT0 : null,
      triggerDirectionAtT0: row.triggerDirectionAtT0 === "buy" || row.triggerDirectionAtT0 === "sell" ? row.triggerDirectionAtT0 : "none",
      bestRuntimeFamily: typeof row.bestRuntimeFamily === "string" ? row.bestRuntimeFamily : null,
      bestSelectedBucket: typeof row.bestSelectedBucket === "string" ? row.bestSelectedBucket : null,
    });
    const captureClassification = wasCaptured
      ? classifyCapturedMove(linkedTrades)
      : classifyMissedMove({
          validation: row,
          admissionPolicyEnabled: Boolean(params.result.admissionPolicy?.enabled),
          admissionPolicyConfig: params.result.admissionPolicy?.config as Record<string, unknown> | null,
        });
    return {
      moveId,
      startTs: moveMeta?.startTs ?? null,
      endTs: moveMeta?.endTs ?? null,
      direction: row.moveDirection,
      movePct: row.movePct,
      qualityTier: moveMeta?.qualityTier ?? null,
      phaseDerivedFamily: row.phaseDerivedFamily,
      phaseDerivedBucket: row.phaseDerivedBucket,
      detectedMoveSizeBucket: moveSizeBucket(Number(row.movePct ?? 0)),
      wasCaptured,
      captureClassification,
      firstLinkedTradeId: first?.tradeId ?? null,
      allLinkedTradeIds: linkedTrades.map((trade) => trade.tradeId),
      entryDelayMinutes: first?.minutesFromMoveStartToEntry ?? null,
      exitDelayMinutes: first?.minutesFromEntryToMoveEnd ?? null,
      tradeDirection: first?.direction ?? null,
      tradeRuntimeFamily: first?.runtimeFamily ?? null,
      tradeSelectedBucket: first?.selectedBucket ?? null,
      triggerTransition: first?.selectedTriggerTransition ?? null,
      pnlPct: first?.pnlPct ?? null,
      mfePct: first?.mfePct ?? null,
      maePct: first?.maePct ?? null,
      exitReason: first?.exitReason ?? null,
      didHitSL: first?.exitReason === "sl_hit",
      didTrail: first?.exitReason === "trailing_stop",
      didReach25PctOfMove: first?.reachedProjectedMove25PctBeforeExit ?? false,
      didReach50PctOfMove: first?.reachedProjectedMove50PctBeforeExit ?? false,
      didReach75PctOfMove: first?.reachedProjectedMove75PctBeforeExit ?? false,
      didReach100PctOfMove: first?.reachedProjectedMove100PctBeforeExit ?? false,
      slBeforeMoveReached25PctMfe: first?.exitReason === "sl_hit" && !first.reachedProjectedMove25PctBeforeExit,
      trailingExitedBeforeMoveEnd: first?.trailingExitBeforeCalibratedMoveEnd ?? false,
      semanticConflictReasons,
      hasSemanticConflict: semanticConflictReasons.length > 0,
      validation: validationRow,
    };
  });

  const capturedMoves = moves.filter((move) => move.wasCaptured);
  const missedMoves = moves.filter((move) => !move.wasCaptured);
  const noiseTrades = trades.filter((trade) => trade.wasNoiseTrade);

  const missedByGroup = {
    family: {} as Record<string, number>,
    bucket: {} as Record<string, number>,
    direction: {} as Record<string, number>,
  };
  const capturedByGroup = {
    family: {} as Record<string, number>,
    bucket: {} as Record<string, number>,
    direction: {} as Record<string, number>,
  };
  for (const move of missedMoves) {
    bump(missedByGroup.family, keyOf(String(move.phaseDerivedFamily ?? "")));
    bump(missedByGroup.bucket, keyOf(String(move.phaseDerivedBucket ?? "")));
    bump(missedByGroup.direction, keyOf(String(move.direction ?? "")));
  }
  for (const move of capturedMoves) {
    bump(capturedByGroup.family, keyOf(String(move.phaseDerivedFamily ?? "")));
    bump(capturedByGroup.bucket, keyOf(String(move.phaseDerivedBucket ?? "")));
    bump(capturedByGroup.direction, keyOf(String(move.direction ?? "")));
  }

  const slInside = attribution.trades.filter((trade) => trade.exitReason === "sl_hit" && trade.entryInsideCalibratedMoveWindow).length;
  const slOutside = attribution.trades.filter((trade) => trade.exitReason === "sl_hit" && !trade.entryInsideCalibratedMoveWindow).length;
  const semanticConflictTrades = trades.filter((trade) => trade.hasSemanticConflict);
  const semanticConflictMoves = moves.filter((move) => move.hasSemanticConflict);
  const semanticConflictTradeIds = new Set(semanticConflictTrades.map((trade) => String(trade.tradeId)));
  const hypotheticalConflictBlocked = attribution.trades.filter((trade) => !semanticConflictTradeIds.has(String(trade.tradeId)));
  const hypotheticalConflictBlockedWins = hypotheticalConflictBlocked.filter((trade) => trade.pnlPct > 0).length;
  const hypotheticalConflictBlockedLosses = hypotheticalConflictBlocked.length - hypotheticalConflictBlockedWins;
  const topSemanticConflictMoves = semanticConflictMoves
    .slice()
    .sort((a, b) => {
      const aScore = (a.didHitSL ? 2 : 0) + (a.wasCaptured ? 0 : 1) + a.semanticConflictReasons.length;
      const bScore = (b.didHitSL ? 2 : 0) + (b.wasCaptured ? 0 : 1) + b.semanticConflictReasons.length;
      return bScore - aScore;
    })
    .slice(0, 20)
    .map((move) => ({
      moveId: move.moveId,
      direction: move.direction,
      movePct: move.movePct,
      phaseDerivedFamily: move.phaseDerivedFamily,
      phaseDerivedBucket: move.phaseDerivedBucket,
      triggerDirectionAtT0: typeof move.validation?.triggerDirectionAtT0 === "string" ? move.validation.triggerDirectionAtT0 : null,
      familyAtT0: typeof move.validation?.familyAtT0 === "string" ? move.validation.familyAtT0 : null,
      bucketAtT0: typeof move.validation?.bucketAtT0 === "string" ? move.validation.bucketAtT0 : null,
      bestTriggerOffset: typeof move.validation?.bestTriggerOffset === "string" ? move.validation.bestTriggerOffset : null,
      bestRuntimeFamily: typeof move.validation?.bestRuntimeFamily === "string" ? move.validation.bestRuntimeFamily : null,
      bestSelectedBucket: typeof move.validation?.bestSelectedBucket === "string" ? move.validation.bestSelectedBucket : null,
      whyT0Failed: typeof move.validation?.failReasonAtT0 === "string" ? move.validation.failReasonAtT0 : null,
      semanticConflictReasons: move.semanticConflictReasons,
    }));

  const allocationSimulations = {
    fixed15Pct: simulateAllocation(attribution.trades, {
      startingCapitalUsd: params.result.summary.capitalModel?.startingCapitalUsd ?? 600,
      mode: "fixed_15",
    }),
    fixed30Pct: simulateAllocation(attribution.trades, {
      startingCapitalUsd: params.result.summary.capitalModel?.startingCapitalUsd ?? 600,
      mode: "fixed_30",
    }),
    fixed50Pct: simulateAllocation(attribution.trades, {
      startingCapitalUsd: params.result.summary.capitalModel?.startingCapitalUsd ?? 600,
      mode: "fixed_50",
    }),
    confidenceCapped90Pct: simulateAllocation(attribution.trades, {
      startingCapitalUsd: params.result.summary.capitalModel?.startingCapitalUsd ?? 600,
      mode: "confidence",
    }),
  };

  const runtimeTuningEvidence = {
    familiesBucketsCausingMostMissedMoves: Object.entries(missedByGroup.bucket)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([bucket, count]) => ({ bucket, count })),
    familiesBucketsCausingMostOutsideNoiseTrades: Object.entries(
      noiseTrades.reduce<Record<string, number>>((acc, trade) => {
        bump(acc, `${keyOf(trade.runtimeFamily)}|${keyOf(trade.selectedBucket)}`);
        return acc;
      }, {}),
    )
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([group, count]) => ({ group, count })),
    triggersCausingMostSlBeforeMoveDevelops: Object.entries(
      attribution.trades
        .filter((trade) => trade.exitReason === "sl_hit" && !trade.reachedProjectedMove25PctBeforeExit)
        .reduce<Record<string, number>>((acc, trade) => {
          bump(acc, keyOf(trade.selectedTriggerTransition));
          return acc;
        }, {}),
    ).sort((a, b) => b[1] - a[1]).map(([triggerTransition, count]) => ({ triggerTransition, count })),
    bucketsWhereTpIsUnrealistic: Object.entries(
      attribution.trades
        .filter((trade) => trade.outcomeClassification === "target_unrealistic_for_bucket")
        .reduce<Record<string, number>>((acc, trade) => {
          bump(acc, keyOf(trade.selectedBucket));
          return acc;
        }, {}),
    ).sort((a, b) => b[1] - a[1]).map(([bucket, count]) => ({ bucket, count })),
    bucketsWhereSlLooksTight: Object.entries(
      attribution.trades
        .filter((trade) => trade.outcomeClassification === "good_entry_sl_too_tight")
        .reduce<Record<string, number>>((acc, trade) => {
          bump(acc, keyOf(trade.selectedBucket));
          return acc;
        }, {}),
    ).sort((a, b) => b[1] - a[1]).map(([bucket, count]) => ({ bucket, count })),
    bucketsWhereTrailingActivatesEarly: Object.entries(
      attribution.trades
        .filter((trade) => trade.outcomeClassification === "good_entry_trailing_too_early")
        .reduce<Record<string, number>>((acc, trade) => {
          bump(acc, keyOf(trade.selectedBucket));
          return acc;
        }, {}),
    ).sort((a, b) => b[1] - a[1]).map(([bucket, count]) => ({ bucket, count })),
    candidatesForDisabling: attribution.recommendationReport?.groupsToDisableFirst ?? [],
    candidatesForStricterEntryTiming: Object.entries(
      attribution.trades
        .filter((trade) => trade.outcomeClassification === "entered_too_early" || trade.outcomeClassification === "entered_too_late")
        .reduce<Record<string, number>>((acc, trade) => {
          bump(acc, `${keyOf(trade.runtimeFamily)}|${keyOf(trade.selectedBucket)}|${trade.outcomeClassification}`);
          return acc;
        }, {}),
    ).sort((a, b) => b[1] - a[1]).map(([group, count]) => ({ group, count })),
    candidatesForExitPolicyTuningLater: {
      unrealisticTp: attribution.trades.filter((trade) => trade.outcomeClassification === "target_unrealistic_for_bucket").length,
      slTooTight: attribution.trades.filter((trade) => trade.outcomeClassification === "good_entry_sl_too_tight").length,
      trailingTooEarly: attribution.trades.filter((trade) => trade.outcomeClassification === "good_entry_trailing_too_early").length,
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
      runtimeModelRunId: params.result.runtimeModel?.sourceRunId ?? null,
      admissionPolicy: params.result.admissionPolicy ?? null,
    },
    calibratedMoves: moves,
    trades,
    aggregates: {
      calibratedMovesTotal: moves.length,
      capturedMoves: capturedMoves.length,
      missedMoves: missedMoves.length,
      captureRate: moves.length > 0 ? capturedMoves.length / moves.length : 0,
      tradesTotal: trades.length,
      tradesInsideMoves: trades.filter((trade) => trade.relationToMove === "inside_move").length,
      tradesBeforeMoves: trades.filter((trade) => trade.relationToMove === "before_move_precursor").length,
      tradesAfterMoves: trades.filter((trade) => trade.relationToMove === "after_move_late").length,
      tradesOutsideAllMoves: trades.filter((trade) => trade.relationToMove === "outside_all_moves").length,
      noiseTradeCount: noiseTrades.length,
      noiseTradeWins: noiseTrades.filter((trade) => trade.wasProfitable).length,
      noiseTradeLosses: noiseTrades.filter((trade) => !trade.wasProfitable).length,
      semanticConflictMoves: semanticConflictMoves.length,
      semanticConflictTrades: semanticConflictTrades.length,
      semanticConflictSlHits: semanticConflictTrades.filter((trade) => trade.exitReason === "sl_hit").length,
      semanticConflictWins: semanticConflictTrades.filter((trade) => trade.wasProfitable).length,
      semanticConflictLosses: semanticConflictTrades.filter((trade) => !trade.wasProfitable).length,
      topSemanticConflictMoves,
      hypotheticalResultIfSemanticConflictsBlocked: {
        remainingTrades: hypotheticalConflictBlocked.length,
        removedTrades: semanticConflictTrades.length,
        wins: hypotheticalConflictBlockedWins,
        losses: hypotheticalConflictBlockedLosses,
        removedWins: semanticConflictTrades.filter((trade) => trade.wasProfitable).length,
        removedLosses: semanticConflictTrades.filter((trade) => !trade.wasProfitable).length,
        removedSlHits: semanticConflictTrades.filter((trade) => trade.exitReason === "sl_hit").length,
        newWinRate: hypotheticalConflictBlocked.length > 0 ? hypotheticalConflictBlockedWins / hypotheticalConflictBlocked.length : 0,
        estimatedSummedTradePnlPct: hypotheticalConflictBlocked.reduce((sum, trade) => sum + trade.pnlPct, 0),
      },
      slHitsInsideCalibratedMoves: slInside,
      slHitsOutsideCalibratedMoves: slOutside,
      missedMovesByFamilyBucketDirection: missedByGroup,
      capturedMovesByFamilyBucketDirection: capturedByGroup,
      avgEntryDelayForCapturedMoves: avg(capturedMoves.map((move) => Number(move.entryDelayMinutes ?? 0))),
      avgMfeCapturedVsCalibratedMfe: avg(capturedMoves.map((move) => Number(move.mfePct ?? 0))) ,
      avgMaeBeforeSuccessByFamilyBucket: Object.entries(
        attribution.trades
          .filter((trade) => trade.pnlPct > 0)
          .reduce<Record<string, number[]>>((acc, trade) => {
            const key = `${keyOf(trade.runtimeFamily)}|${keyOf(trade.selectedBucket)}`;
            if (!acc[key]) acc[key] = [];
            acc[key].push(trade.maePct);
            return acc;
          }, {}),
      ).map(([group, values]) => ({ group, avgMaePct: avg(values) })),
      exitReasonByGroup: {
        captured: capturedMoves.reduce<Record<string, number>>((acc, move) => {
          bump(acc, keyOf(move.exitReason));
          return acc;
        }, {}),
        missed: missedMoves.reduce<Record<string, number>>((acc, move) => {
          bump(acc, keyOf(move.captureClassification));
          return acc;
        }, {}),
        noise: noiseTrades.reduce<Record<string, number>>((acc, trade) => {
          bump(acc, keyOf(trade.exitReason));
          return acc;
        }, {}),
      },
    },
    runtimeTuningEvidence,
    allocationSimulation: allocationSimulations,
  };
}
