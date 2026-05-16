import { allocatorDecisionsTable, db, serviceCandidatesTable, tradesTable } from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { TradingMode } from "../infrastructure/deriv.js";
import type { ServiceExecutionGate } from "./serviceExecutionGate.js";
import type { CoordinatorOutput } from "./engineTypes.js";
import type { ServicePromotedRuntimeArtifact } from "./serviceRuntimeLifecycle.js";
import type { V3AllocationDecision } from "./portfolioAllocatorV3.js";
import type { BuiltSymbolTradeCandidate } from "./symbolModels/candidateBuilder.js";

export interface PersistedServiceCandidateContext {
  serviceId: string;
  symbol: string;
  mode: TradingMode;
  gate: ServiceExecutionGate;
  runtimeArtifact: ServicePromotedRuntimeArtifact;
  coordinatorOutput: CoordinatorOutput;
  builtCandidate: BuiltSymbolTradeCandidate;
  sourcePolicyId: string | null;
  sourceSynthesisJobId: number | null;
  lifecyclePlanId: string;
}

export async function createServiceCandidateRecord(
  context: PersistedServiceCandidateContext,
): Promise<string> {
  const { winner } = context.coordinatorOutput;
  const metadata = winner.metadata && typeof winner.metadata === "object"
    ? winner.metadata as Record<string, unknown>
    : {};
  const featureSnapshot = metadata.featureSnapshot && typeof metadata.featureSnapshot === "object"
    ? metadata.featureSnapshot as Record<string, unknown>
    : null;
  const candidateId = `${context.serviceId.toLowerCase()}-candidate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const confidence = Number(metadata.confidence ?? winner.confidence ?? 0);
  const setupMatch = Number(metadata.setupMatch ?? metadata.runtimeSetupMatch ?? 0);
  const triggerStrengthScore = Number(metadata.triggerStrengthScore ?? 0);
  const expectedMovePct = Number(metadata.expectedMovePct ?? winner.projectedMovePct ?? 0);
  const direction = winner.direction;
  const exitPolicy = context.builtCandidate.candidate.exitPolicy;
  const tp1Pct = Number(exitPolicy.takeProfitPct ?? 0);
  const trailingActivationPct = Number(exitPolicy.trailingArmPct ?? 0);
  const hardSlPct = Number(exitPolicy.stopLossPct ?? 0);
  const requestedLeverage = Number(metadata.requestedLeverage ?? 1);

  await db.insert(serviceCandidatesTable).values({
    candidateId,
    serviceId: context.serviceId,
    symbol: context.symbol,
    activeMode: context.mode,
    runtimeArtifactId: context.runtimeArtifact.artifactId,
    sourcePolicyId: context.sourcePolicyId,
    sourceSynthesisJobId: context.sourceSynthesisJobId,
    generatedAt: new Date(),
    candleTs: context.gate.latestCandleTs ? new Date(context.gate.latestCandleTs) : null,
    direction,
    runtimeFamily: String(metadata.selectedRuntimeFamily ?? metadata.runtimeFamily ?? winner.engineName),
    triggerTransition: String(metadata.triggerTransition ?? metadata.selectedTriggerTransition ?? ""),
    predictedMoveSizeBucket: String(metadata.selectedMoveSizeBucket ?? metadata.moveSizeBucket ?? ""),
    expectedMovePct,
    confidence,
    setupMatch,
    triggerStrengthScore,
    winRateEstimate: Number(context.runtimeArtifact.expectedPerformance?.winRate ?? 0),
    slHitRateEstimate: Number(context.runtimeArtifact.expectedPerformance?.slHitRate ?? 0),
    profitFactorEstimate: Number(context.runtimeArtifact.expectedPerformance?.profitFactor ?? 0),
    expectedMonthlyContributionPct: Number(context.runtimeArtifact.expectedPerformance?.averageMonthlyAccountReturnPct ?? 0),
    tp1Pct: tp1Pct > 0 ? tp1Pct : null,
    tp2Pct: trailingActivationPct > tp1Pct ? trailingActivationPct : tp1Pct > 0 ? tp1Pct : null,
    hardSlPct: hardSlPct > 0 ? hardSlPct : null,
    lifecyclePlanId: context.lifecyclePlanId,
    requestedAllocationPct: Number.isFinite(confidence)
      ? Math.max(5, Math.min(90, Number((confidence * 100).toFixed(2))))
      : null,
    requestedLeverage: requestedLeverage > 0 ? requestedLeverage : 1,
    liveSafeFeatures: featureSnapshot,
    warnings: context.gate.warnings,
    blockers: [],
    emissionGate: context.gate,
    executionStatus: "emitted",
  });

  return candidateId;
}

export async function createAllocatorDecisionRecord(params: {
  candidateId: string;
  serviceId: string;
  symbol: string;
  mode: TradingMode;
  allocationDecision: V3AllocationDecision;
  builtCandidate: BuiltSymbolTradeCandidate;
  lifecyclePlanId: string;
}): Promise<string> {
  const decisionId = `${params.serviceId.toLowerCase()}-allocator-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const openTrades = await db.select({ size: tradesTable.size }).from(tradesTable)
    .where(and(eq(tradesTable.status, "open"), eq(tradesTable.mode, params.mode)));
  const portfolioExposureBefore = openTrades.reduce((sum, trade) => sum + (trade.size ?? 0), 0);
  const approvedCapitalAmount = params.allocationDecision.allowed ? params.allocationDecision.capitalAmount : 0;
  const portfolioExposureAfter = portfolioExposureBefore + approvedCapitalAmount;
  const exitPolicy = params.builtCandidate.candidate.exitPolicy;
  const requestedLeverage = Number(params.allocationDecision.requestedLeverage ?? 1);

  await db.insert(allocatorDecisionsTable).values({
    decisionId,
    candidateId: params.candidateId,
    serviceId: params.serviceId,
    symbol: params.symbol,
    approved: params.allocationDecision.allowed,
    rejectionReason: params.allocationDecision.rejectionReason,
    requestedAllocationPct: params.allocationDecision.capitalAllocationPct,
    approvedAllocationPct: params.allocationDecision.allowed ? params.allocationDecision.capitalAllocationPct : 0,
    approvedCapitalAmount,
    requestedLeverage: requestedLeverage > 0 ? requestedLeverage : 1,
    approvedLeverage: params.allocationDecision.allowed ? params.allocationDecision.approvedLeverage : 0,
    finalTp1Pct: Number(exitPolicy.takeProfitPct ?? 0) || null,
    finalTp2Pct: Number(exitPolicy.trailingArmPct ?? 0) || Number(exitPolicy.takeProfitPct ?? 0) || null,
    finalHardSlPct: Number(exitPolicy.stopLossPct ?? 0) || null,
    lifecyclePlanId: params.lifecyclePlanId,
    executionAllowed: params.allocationDecision.allowed,
    activeMode: params.mode,
    portfolioExposureBefore: params.allocationDecision.portfolioExposureBefore ?? portfolioExposureBefore,
    portfolioExposureAfter: params.allocationDecision.portfolioExposureAfter ?? portfolioExposureAfter,
    warnings: [
      ...(params.allocationDecision.rejectionReason ? [params.allocationDecision.rejectionReason] : []),
      "allocator=max_idle_capital_compounding",
      `drawdown=${params.allocationDecision.actualDrawdownPct.toFixed(2)}pct`,
      `drawdown_budget=${params.allocationDecision.remainingDrawdownBudgetPct.toFixed(2)}pct`,
      `leverage=${params.allocationDecision.approvedLeverage.toFixed(2)}x`,
    ],
    decidedAt: new Date(),
  });
  return decisionId;
}

export async function attachTradeToExecutionRecords(params: {
  tradeId: number;
  candidateId: string;
  decisionId: string;
}): Promise<void> {
  await db.update(serviceCandidatesTable)
    .set({ executionStatus: "opened", openedTradeId: params.tradeId })
    .where(eq(serviceCandidatesTable.candidateId, params.candidateId));
  await db.update(allocatorDecisionsTable)
    .set({ openedTradeId: params.tradeId, tradeId: params.tradeId })
    .where(eq(allocatorDecisionsTable.decisionId, params.decisionId));
}

export async function listAllocatorDecisionFeed(limit = 100) {
  return db.select().from(allocatorDecisionsTable).orderBy(desc(allocatorDecisionsTable.decidedAt)).limit(limit);
}

export async function listServiceCandidateFeed(limit = 100) {
  return db.select().from(serviceCandidatesTable).orderBy(desc(serviceCandidatesTable.generatedAt)).limit(limit);
}

export async function listAllocatorExecutionFeed(limit = 100) {
  const decisions = await db.select()
    .from(allocatorDecisionsTable)
    .orderBy(desc(allocatorDecisionsTable.decidedAt))
    .limit(limit);

  if (decisions.length === 0) return [];

  const candidateIds = Array.from(new Set(decisions.map((decision) => decision.candidateId)));
  const tradeIds = Array.from(new Set(
    decisions
      .map((decision) => decision.tradeId ?? decision.openedTradeId)
      .filter((value): value is number => typeof value === "number"),
  ));

  const candidates = await db.select()
    .from(serviceCandidatesTable)
    .where(candidateIds.length > 0 ? inArray(serviceCandidatesTable.candidateId, candidateIds) : undefined);
  const trades = await db.select()
    .from(tradesTable)
    .where(tradeIds.length > 0 ? inArray(tradesTable.id, tradeIds) : undefined);

  const candidateMap = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  const tradeMap = new Map(trades.map((trade) => [trade.id, trade]));

  return decisions.map((decision) => {
    const candidate = candidateMap.get(decision.candidateId) ?? null;
    const tradeId = decision.tradeId ?? decision.openedTradeId ?? null;
    const trade = tradeId != null ? tradeMap.get(tradeId) ?? null : null;
    return {
      decision,
      candidate,
      trade,
    };
  });
}
