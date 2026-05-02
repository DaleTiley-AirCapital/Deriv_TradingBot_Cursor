import { buildCrash300TradeOutcomeAttributionReport } from "./tradeOutcomeAttribution.js";
import { runV3Backtest, type V3BacktestResult, type V3BacktestRequest } from "./backtestRunner.js";

type AttributionReport = Awaited<ReturnType<typeof buildCrash300TradeOutcomeAttributionReport>>;
type AttributionTrade = AttributionReport["trades"][number];

type ComparisonClassification =
  | "same_as_baseline_trade"
  | "replacement_after_blocked_candidate"
  | "new_trade_same_move"
  | "new_trade_different_move"
  | "new_trade_outside_calibrated_move"
  | "baseline_trade_shifted_entry";

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

function tradeSignature(trade: AttributionTrade) {
  return [
    trade.symbol,
    trade.direction,
    keyOf(trade.runtimeFamily),
    keyOf(trade.selectedBucket),
    keyOf(trade.selectedTriggerTransition),
    keyOf(trade.contextEpochId),
    String(trade.matchedCalibratedMove?.moveId ?? "none"),
  ].join("|");
}

function minutesBetween(aTs: number, bTs: number) {
  return Math.abs(aTs - bTs) / 60;
}

function derivePolicyBlockReasonsFromTrade(
  trade: AttributionTrade,
  config: V3BacktestResult["admissionPolicy"]["config"],
): string[] {
  if (!config?.enabled || config.mode === "off") return [];
  const reasons: string[] = [];
  if (
    config.blockWrongDirectionWithTrigger &&
    (
      (trade.outcomeClassification === "wrong_direction" && trade.triggerFresh === true) ||
      trade.directionConsistencyFlags.includes("trigger_trade_direction_mismatch") ||
      trade.directionConsistencyFlags.includes("family_bucket_direction_mismatch")
    )
  ) {
    reasons.push("wrong_direction_with_trigger");
  }
  if (config.blockPostCrashRecoveryUp && trade.runtimeFamily === "post_crash_recovery_up") {
    reasons.push("post_crash_recovery_up");
  }
  if (config.blockUpRecovery10PlusPct && trade.selectedBucket === "up|recovery|10_plus_pct") {
    reasons.push("up_recovery_10_plus_pct");
  }
  if (config.blockRecoveryUpOnDownMove && trade.directionConsistencyFlags.includes("recovery_up_family_on_down_move")) {
    reasons.push("recovery_up_on_down_move");
  }
  if (config.blockCrashDownOnUpMove && trade.directionConsistencyFlags.includes("crash_down_family_on_up_move")) {
    reasons.push("crash_down_on_up_move");
  }
  return reasons;
}

function summarizeTradeSet(trades: AttributionTrade[]) {
  const wins = trades.filter((trade) => trade.pnlPct > 0);
  const losses = trades.length - wins.length;
  return {
    count: trades.length,
    wins: wins.length,
    losses,
    winRate: trades.length > 0 ? wins.length / trades.length : 0,
    totalPnlPct: trades.reduce((sum, trade) => sum + trade.pnlPct, 0),
    avgPnlPct: avg(trades.map((trade) => trade.pnlPct)),
    slHitCount: trades.filter((trade) => trade.exitReason === "sl_hit").length,
    trailingStopCount: trades.filter((trade) => trade.exitReason === "trailing_stop").length,
    runtimeFamilyDistribution: trades.reduce<Record<string, number>>((acc, trade) => {
      bump(acc, keyOf(trade.runtimeFamily));
      return acc;
    }, {}),
    selectedBucketDistribution: trades.reduce<Record<string, number>>((acc, trade) => {
      bump(acc, keyOf(trade.selectedBucket));
      return acc;
    }, {}),
    triggerTransitionDistribution: trades.reduce<Record<string, number>>((acc, trade) => {
      bump(acc, keyOf(trade.selectedTriggerTransition));
      return acc;
    }, {}),
    matchedMoveCaptureCount: trades.filter((trade) => trade.matchedCalibratedMove !== null).length,
    averageEntryDelayFromMoveStartMinutes: avg(trades.map((trade) => trade.minutesFromMoveStartToEntry ?? 0)),
  };
}

function classifyPolicyTrades(params: {
  baselineTrades: AttributionTrade[];
  policyTrades: AttributionTrade[];
  policyConfig: V3BacktestResult["admissionPolicy"]["config"];
}) {
  const { baselineTrades, policyTrades, policyConfig } = params;
  const baselineExactBySignature = new Map<string, AttributionTrade[]>();
  const baselineByMove = new Map<number, AttributionTrade[]>();
  const baselineBlockedReasons = new Map<string, string[]>();

  for (const trade of baselineTrades) {
    const signature = tradeSignature(trade);
    const existing = baselineExactBySignature.get(signature);
    if (existing) existing.push(trade);
    else baselineExactBySignature.set(signature, [trade]);
    const moveId = trade.matchedCalibratedMove?.moveId;
    if (typeof moveId === "number") {
      const moveTrades = baselineByMove.get(moveId);
      if (moveTrades) moveTrades.push(trade);
      else baselineByMove.set(moveId, [trade]);
    }
    baselineBlockedReasons.set(trade.tradeId, derivePolicyBlockReasonsFromTrade(trade, policyConfig));
  }

  const baselineMatchedTradeIds = new Set<string>();
  const policyTradeRows = policyTrades.map((trade) => {
    const signature = tradeSignature(trade);
    const exactMatches = (baselineExactBySignature.get(signature) ?? [])
      .filter((candidate) => !baselineMatchedTradeIds.has(candidate.tradeId));
    const closestExact = exactMatches.sort((a, b) => minutesBetween(a.entryTs, trade.entryTs) - minutesBetween(b.entryTs, trade.entryTs))[0] ?? null;
    let classification: ComparisonClassification;
    let matchedBaselineTradeId: string | null = null;
    let blockedReasonsOpeningSlot: string[] = [];

    if (closestExact && minutesBetween(closestExact.entryTs, trade.entryTs) <= 1) {
      classification = "same_as_baseline_trade";
      matchedBaselineTradeId = closestExact.tradeId;
      baselineMatchedTradeIds.add(closestExact.tradeId);
    } else {
      const moveId = trade.matchedCalibratedMove?.moveId ?? null;
      const baselineSameMove = typeof moveId === "number"
        ? (baselineByMove.get(moveId) ?? []).filter((candidate) => !baselineMatchedTradeIds.has(candidate.tradeId))
        : [];
      const closestSameMove = baselineSameMove.sort((a, b) => minutesBetween(a.entryTs, trade.entryTs) - minutesBetween(b.entryTs, trade.entryTs))[0] ?? null;

      if (closestSameMove && minutesBetween(closestSameMove.entryTs, trade.entryTs) <= 15) {
        classification = "baseline_trade_shifted_entry";
        matchedBaselineTradeId = closestSameMove.tradeId;
        baselineMatchedTradeIds.add(closestSameMove.tradeId);
      } else if (closestSameMove) {
        const reasons = baselineBlockedReasons.get(closestSameMove.tradeId) ?? [];
        if (reasons.length > 0) {
          classification = "replacement_after_blocked_candidate";
          blockedReasonsOpeningSlot = reasons;
        } else {
          classification = "new_trade_same_move";
        }
      } else if (!trade.matchedCalibratedMove) {
        classification = "new_trade_outside_calibrated_move";
      } else {
        classification = "new_trade_different_move";
      }
    }

    return {
      ...trade,
      comparisonClassification: classification,
      matchedBaselineTradeId,
      blockedReasonsOpeningSlot,
    };
  });

  const removedBaselineTrades = baselineTrades
    .filter((trade) => !baselineMatchedTradeIds.has(trade.tradeId))
    .map((trade) => ({
      ...trade,
      simulatedBlockedReasons: baselineBlockedReasons.get(trade.tradeId) ?? [],
    }));

  return { policyTradeRows, removedBaselineTrades };
}

async function buildWindowStabilityReport(params: {
  baselineResult: V3BacktestResult;
  policyResult: V3BacktestResult;
  windows: number[];
}) {
  const endTs = params.policyResult.endTs;
  const symbol = params.policyResult.symbol;
  const mode = params.policyResult.mode as "paper" | "demo" | "real";
  const tierMode = params.policyResult.tierMode;
  const startingCapitalUsd = params.policyResult.summary.capitalModel?.startingCapitalUsd ?? 600;
  const baselinePolicy = params.baselineResult.admissionPolicy?.config ?? {
    enabled: false,
    mode: "off",
    blockWrongDirectionWithTrigger: false,
    blockPostCrashRecoveryUp: false,
    blockUpRecovery10PlusPct: false,
    blockRecoveryUpOnDownMove: false,
    blockCrashDownOnUpMove: false,
  };
  const policyConfig = params.policyResult.admissionPolicy?.config ?? baselinePolicy;

  const windowsToRun = params.windows.filter((days) => Number.isFinite(days) && days > 0);
  const results: Array<Record<string, unknown>> = [];
  for (const days of windowsToRun) {
    const startTs = endTs - (days * 86400) + 86400;
    const [baselineWindow, policyWindow] = await Promise.all([
      runV3Backtest({
        symbol,
        startTs,
        endTs,
        mode,
        tierMode,
        startingCapitalUsd,
        crash300AdmissionPolicy: baselinePolicy,
      } as V3BacktestRequest),
      runV3Backtest({
        symbol,
        startTs,
        endTs,
        mode,
        tierMode,
        startingCapitalUsd,
        crash300AdmissionPolicy: policyConfig,
      } as V3BacktestRequest),
    ]);
    results.push({
      windowDays: days,
      baseline: {
        winRate: baselineWindow.summary.winRate,
        totalPnlPct: baselineWindow.summary.totalPnlPct,
        accountReturnPct: baselineWindow.summary.accountReturnPct,
        maxDrawdownPct: baselineWindow.summary.maxDrawdownPct,
        trades: baselineWindow.summary.tradeCount,
        moveCapture: baselineWindow.moveOverlap.captureRate,
        slHits: baselineWindow.summary.byExitReason?.sl_hit ?? 0,
      },
      policy: {
        winRate: policyWindow.summary.winRate,
        totalPnlPct: policyWindow.summary.totalPnlPct,
        accountReturnPct: policyWindow.summary.accountReturnPct,
        maxDrawdownPct: policyWindow.summary.maxDrawdownPct,
        trades: policyWindow.summary.tradeCount,
        moveCapture: policyWindow.moveOverlap.captureRate,
        slHits: policyWindow.summary.byExitReason?.sl_hit ?? 0,
      },
    });
  }
  return results;
}

export async function buildCrash300BacktestComparisonReport(params: {
  baselineRunId: number;
  baselineResult: V3BacktestResult;
  baselineCreatedAt?: string | null;
  policyRunId: number;
  policyResult: V3BacktestResult;
  policyCreatedAt?: string | null;
  includeWindowStability?: boolean;
}) {
  if (String(params.baselineResult.symbol).toUpperCase() !== "CRASH300" || String(params.policyResult.symbol).toUpperCase() !== "CRASH300") {
    throw new Error("Backtest comparison is currently available for CRASH300 only.");
  }

  const [baselineAttribution, policyAttribution] = await Promise.all([
    buildCrash300TradeOutcomeAttributionReport({
      runId: params.baselineRunId,
      result: params.baselineResult,
      createdAt: params.baselineCreatedAt,
    }),
    buildCrash300TradeOutcomeAttributionReport({
      runId: params.policyRunId,
      result: params.policyResult,
      createdAt: params.policyCreatedAt,
    }),
  ]);

  const policyConfig = params.policyResult.admissionPolicy?.config ?? params.baselineResult.admissionPolicy?.config;
  if (!policyConfig) {
    throw new Error("Policy run is missing admission policy config.");
  }

  const { policyTradeRows, removedBaselineTrades } = classifyPolicyTrades({
    baselineTrades: baselineAttribution.trades,
    policyTrades: policyAttribution.trades,
    policyConfig,
  });

  const replacementTrades = policyTradeRows.filter((trade) => trade.comparisonClassification === "replacement_after_blocked_candidate");
  const newSameMoveTrades = policyTradeRows.filter((trade) => trade.comparisonClassification === "new_trade_same_move");
  const newDifferentMoveTrades = policyTradeRows.filter((trade) => trade.comparisonClassification === "new_trade_different_move");
  const newOutsideTrades = policyTradeRows.filter((trade) => trade.comparisonClassification === "new_trade_outside_calibrated_move");
  const shiftedTrades = policyTradeRows.filter((trade) => trade.comparisonClassification === "baseline_trade_shifted_entry");

  const removedSummary = summarizeTradeSet(removedBaselineTrades);
  const replacementSummary = summarizeTradeSet(replacementTrades);
  const policySummary = summarizeTradeSet(policyTradeRows);
  const baselineSummary = summarizeTradeSet(baselineAttribution.trades);
  const blockedReasonCountsLeadingToReplacement: Record<string, number> = {};
  for (const trade of replacementTrades) {
    for (const reason of trade.blockedReasonsOpeningSlot) bump(blockedReasonCountsLeadingToReplacement, reason);
  }

  const policyTradeIncreaseExplanation = {
    baselineTrades: baselineAttribution.trades.length,
    policyTrades: policyTradeRows.length,
    extraTrades: policyTradeRows.length - baselineAttribution.trades.length,
    removedBaselineTrades: removedBaselineTrades.length,
    replacementTrades: replacementTrades.length,
    netNewTrades: newSameMoveTrades.length + newDifferentMoveTrades.length + newOutsideTrades.length,
    replacementWins: replacementTrades.filter((trade) => trade.pnlPct > 0).length,
    replacementLosses: replacementTrades.filter((trade) => trade.pnlPct <= 0).length,
    replacementPnl: replacementTrades.reduce((sum, trade) => sum + trade.pnlPct, 0),
    replacementSlHits: replacementTrades.filter((trade) => trade.exitReason === "sl_hit").length,
    topBlockedReasonsLeadingToReplacementTrades: Object.entries(blockedReasonCountsLeadingToReplacement)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([reason, count]) => ({ reason, count })),
  };

  const replacementSlRate = replacementTrades.length > 0
    ? replacementTrades.filter((trade) => trade.exitReason === "sl_hit").length / replacementTrades.length
    : 0;
  const baselineSlRate = baselineAttribution.trades.length > 0
    ? baselineAttribution.trades.filter((trade) => trade.exitReason === "sl_hit").length / baselineAttribution.trades.length
    : 0;

  const policySafetyVerdict = {
    improvesWinRate: params.policyResult.summary.winRate > params.baselineResult.summary.winRate,
    improvesTotalPnl: params.policyResult.summary.totalPnlPct > params.baselineResult.summary.totalPnlPct,
    reducesMaxDrawdown: params.policyResult.summary.maxDrawdownPct < params.baselineResult.summary.maxDrawdownPct,
    improvesMoveCapture: params.policyResult.moveOverlap.captureRate > params.baselineResult.moveOverlap.captureRate,
    replacementTradesAreProfitable: replacementSummary.totalPnlPct > 0,
    replacementTradesIncreaseSLRisk: replacementTrades.length > 0 && replacementSlRate > baselineSlRate,
  };
  const verdict = policySafetyVerdict.improvesWinRate
    && policySafetyVerdict.improvesTotalPnl
    && policySafetyVerdict.reducesMaxDrawdown
    && policySafetyVerdict.improvesMoveCapture
    && policySafetyVerdict.replacementTradesAreProfitable
    ? (policySafetyVerdict.replacementTradesIncreaseSLRisk ? "needs_more_backtest_windows" : "safe_to_promote_to_paper_test")
    : (policySafetyVerdict.improvesWinRate || policySafetyVerdict.improvesTotalPnl ? "needs_more_backtest_windows" : "reject_policy");

  const windowStability = params.includeWindowStability
    ? await buildWindowStabilityReport({
        baselineResult: params.baselineResult,
        policyResult: params.policyResult,
        windows: [7, 14, 30, 60],
      })
    : null;

  return {
    symbol: "CRASH300",
    generatedAt: new Date().toISOString(),
    baselineRun: {
      runId: params.baselineRunId,
      createdAt: params.baselineCreatedAt ?? null,
      summary: params.baselineResult.summary,
      moveOverlap: params.baselineResult.moveOverlap,
      admissionPolicy: params.baselineResult.admissionPolicy,
    },
    policyRun: {
      runId: params.policyRunId,
      createdAt: params.policyCreatedAt ?? null,
      summary: params.policyResult.summary,
      moveOverlap: params.policyResult.moveOverlap,
      admissionPolicy: params.policyResult.admissionPolicy,
    },
    policyTradeClassifications: {
      counts: policyTradeRows.reduce<Record<string, number>>((acc, trade) => {
        bump(acc, trade.comparisonClassification);
        return acc;
      }, {}),
      trades: policyTradeRows,
    },
    removedBaselineTrades: {
      summary: removedSummary,
      trades: removedBaselineTrades,
    },
    replacementTradeQuality: {
      ...replacementSummary,
      blockedReasonsLeadingToReplacement: blockedReasonCountsLeadingToReplacement,
    },
    policyTradeIncreaseExplanation,
    policySafetyVerdict: {
      ...policySafetyVerdict,
      verdict,
    },
    comparisonSummary: {
      baseline: baselineSummary,
      policy: policySummary,
      newTradeSameMoveCount: newSameMoveTrades.length,
      newTradeDifferentMoveCount: newDifferentMoveTrades.length,
      newTradeOutsideCalibratedMoveCount: newOutsideTrades.length,
      shiftedEntryCount: shiftedTrades.length,
    },
    parityTimingIssueSummary: policyAttribution.recommendationReport?.parityTimingIssueSummary ?? null,
    windowStability,
  };
}
