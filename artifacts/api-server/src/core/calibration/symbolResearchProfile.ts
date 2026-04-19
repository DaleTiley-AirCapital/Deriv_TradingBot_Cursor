import { db } from "@workspace/db";
import {
  detectedMovesTable,
  strategyCalibrationProfilesTable,
  symbolResearchProfilesTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import {
  type SymbolDomain,
  getSymbolDomain,
} from "./symbolDomain.js";

export type ResearchStatus =
  | "engine_refinement_ready"
  | "research_complete"
  | "engine_candidate"
  | "not_worth_building";

export interface SymbolResearchProfile {
  symbol: string;
  symbolDomain: SymbolDomain;
  windowDays: number;
  dataHealthSummary: unknown;
  moveCount: number;
  moveFamilyDistribution: Record<string, number>;
  engineTypeRecommendation: string;
  buildPriority: "high" | "medium" | "low";
  estimatedTradesPerMonth: number;
  estimatedCapitalUtilizationPct: number;
  estimatedFitAdjustedMonthlyReturnPct: number;
  recommendedScanIntervalSeconds: number;
  recommendedConfirmationWindow: string;
  recommendedEntryModel: string;
  recommendedHoldProfile: Record<string, unknown>;
  recommendedTpModel: Record<string, unknown>;
  recommendedSlModel: Record<string, unknown>;
  recommendedTrailingModel: Record<string, unknown>;
  recommendedScoreGates: Record<string, unknown>;
  researchStatus: ResearchStatus;
  generatedAt: string;
  lastRunId: number;
}

function normalizedMoveFamily(moveType: string): string {
  const v = (moveType || "").toLowerCase();
  if (v === "breakout" || v === "continuation" || v === "reversal") return v;
  if (v.includes("spike") && v.includes("recover")) return "spike_cluster_recovery";
  if (v.includes("exhaust")) return "exhaustion";
  if (v.includes("drift") && v.includes("recover")) return "drift_recovery";
  return "uncategorized_emerging_pattern";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function computeResearchStatus(
  domain: SymbolDomain,
  fitAdjustedReturn: number,
  moveCount: number,
): ResearchStatus {
  if (domain === "active") return "engine_refinement_ready";
  if (moveCount < 20 || fitAdjustedReturn < 4) return "not_worth_building";
  if (fitAdjustedReturn >= 12) return "engine_candidate";
  return "research_complete";
}

function deriveScanCadenceSeconds(estimatedTradesPerMonth: number): number {
  if (estimatedTradesPerMonth >= 60) return 60;
  if (estimatedTradesPerMonth >= 30) return 120;
  if (estimatedTradesPerMonth >= 12) return 300;
  return 600;
}

function isMissingRelationError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; message?: string };
  return e.code === "42P01" || (e.message ?? "").toLowerCase().includes("does not exist");
}

export async function buildSymbolResearchProfile(
  symbol: string,
  runId: number,
  dataHealthSummary: unknown = null,
): Promise<SymbolResearchProfile | null> {
  const domain = getSymbolDomain(symbol);
  if (!domain) return null;

  const [profileRows, moves] = await Promise.all([
    db
      .select()
      .from(strategyCalibrationProfilesTable)
      .where(and(
        eq(strategyCalibrationProfilesTable.symbol, symbol),
        eq(strategyCalibrationProfilesTable.moveType, "all"),
      ))
      .orderBy(desc(strategyCalibrationProfilesTable.generatedAt))
      .limit(1),
    db
      .select({
        moveType: detectedMovesTable.moveType,
      })
      .from(detectedMovesTable)
      .where(eq(detectedMovesTable.symbol, symbol)),
  ]);

  const profile = profileRows[0];
  if (!profile) return null;

  const feeddown = asRecord(profile.feeddownSchema);
  const scoring = asRecord(feeddown.scoringCalibration);
  const hold = asRecord(feeddown.holdDurationCalibration);
  const profitability = asRecord(profile.profitabilitySummary);
  const topPath = String(profitability.topPath ?? "all");
  const fitAdjusted = Number(profitability.estimatedFitAdjustedReturn ?? 0);

  const moveFamilyDistribution: Record<string, number> = {};
  for (const move of moves) {
    const key = normalizedMoveFamily(move.moveType ?? "");
    moveFamilyDistribution[key] = (moveFamilyDistribution[key] ?? 0) + 1;
  }

  const estimatedTradesPerMonth =
    profile.avgHoldingHours > 0
      ? Number(((30 * 24) / profile.avgHoldingHours).toFixed(2))
      : 0;
  const estimatedCapitalUtilizationPct = Number(
    Math.min(95, Math.max(5, estimatedTradesPerMonth * 1.5)).toFixed(2),
  );
  const recommendedScanIntervalSeconds = deriveScanCadenceSeconds(estimatedTradesPerMonth);
  const researchStatus = computeResearchStatus(domain, fitAdjusted, profile.targetMoves);

  return {
    symbol,
    symbolDomain: domain,
    windowDays: profile.windowDays ?? 90,
    dataHealthSummary,
    moveCount: profile.targetMoves ?? moves.length,
    moveFamilyDistribution,
    engineTypeRecommendation: domain === "active"
      ? `Refine existing ${symbol} V3 engine`
      : `Candidate: ${topPath} specialized engine`,
    buildPriority: fitAdjusted >= 12 ? "high" : fitAdjusted >= 6 ? "medium" : "low",
    estimatedTradesPerMonth,
    estimatedCapitalUtilizationPct,
    estimatedFitAdjustedMonthlyReturnPct: Number(fitAdjusted.toFixed(2)),
    recommendedScanIntervalSeconds,
    recommendedConfirmationWindow: `${Math.max(2, Math.round((profile.avgHoldingHours ?? 1) / 4))}h`,
    recommendedEntryModel: String(topPath),
    recommendedHoldProfile: {
      p25Hours: Number(hold.p25Hours ?? 0),
      p50Hours: Number(hold.p50Hours ?? 0),
      p75Hours: Number(hold.p75Hours ?? 0),
      systemCompatibility: String(hold.systemCompatibility ?? "unknown"),
    },
    recommendedTpModel: {
      targetPct: Number(Math.max(0, profile.avgMovePct ?? 0).toFixed(2)),
      rationale: "Derived from average captured move profile",
    },
    recommendedSlModel: {
      structural: true,
      maxInitialRiskPct: Number(Math.max(0.5, (profile.avgMovePct ?? 0) * 0.35).toFixed(2)),
    },
    recommendedTrailingModel: {
      activationProfitPct: Number(Math.max(1.5, (profile.avgMovePct ?? 0) * 0.5).toFixed(2)),
      trailingDistancePct: Number(Math.max(0.8, (profile.avgMovePct ?? 0) * 0.25).toFixed(2)),
      policy: "tp_primary_trailing_safety_net",
    },
    recommendedScoreGates: {
      paper: Number(scoring.mediumQualityMoveMinScore ?? 60),
      demo: Math.max(65, Number(scoring.mediumQualityMoveMinScore ?? 65)),
      real: Math.max(70, Number(scoring.highQualityMoveMinScore ?? 70)),
    },
    researchStatus,
    generatedAt: new Date().toISOString(),
    lastRunId: runId,
  };
}

export async function upsertSymbolResearchProfile(
  symbol: string,
  runId: number,
  dataHealthSummary: unknown = null,
): Promise<{ profile: SymbolResearchProfile | null; persisted: boolean }> {
  const profile = await buildSymbolResearchProfile(symbol, runId, dataHealthSummary);
  if (!profile) return { profile: null, persisted: false };

  try {
    await db
      .insert(symbolResearchProfilesTable)
      .values({
        symbol: profile.symbol,
        symbolDomain: profile.symbolDomain,
        windowDays: profile.windowDays,
        dataHealthSummary: profile.dataHealthSummary,
        moveCount: profile.moveCount,
        moveFamilyDistribution: profile.moveFamilyDistribution,
        engineTypeRecommendation: profile.engineTypeRecommendation,
        buildPriority: profile.buildPriority,
        estimatedTradesPerMonth: profile.estimatedTradesPerMonth,
        estimatedCapitalUtilizationPct: profile.estimatedCapitalUtilizationPct,
        estimatedFitAdjustedMonthlyReturnPct: profile.estimatedFitAdjustedMonthlyReturnPct,
        recommendedScanIntervalSeconds: profile.recommendedScanIntervalSeconds,
        recommendedConfirmationWindow: profile.recommendedConfirmationWindow,
        recommendedEntryModel: profile.recommendedEntryModel,
        recommendedHoldProfile: profile.recommendedHoldProfile,
        recommendedTpModel: profile.recommendedTpModel,
        recommendedSlModel: profile.recommendedSlModel,
        recommendedTrailingModel: profile.recommendedTrailingModel,
        recommendedScoreGates: profile.recommendedScoreGates,
        researchStatus: profile.researchStatus,
        generatedAt: new Date(profile.generatedAt),
        lastRunId: profile.lastRunId,
        rawJson: profile,
      })
      .onConflictDoUpdate({
        target: [symbolResearchProfilesTable.symbol, symbolResearchProfilesTable.windowDays],
        set: {
          symbolDomain: profile.symbolDomain,
          dataHealthSummary: profile.dataHealthSummary,
          moveCount: profile.moveCount,
          moveFamilyDistribution: profile.moveFamilyDistribution,
          engineTypeRecommendation: profile.engineTypeRecommendation,
          buildPriority: profile.buildPriority,
          estimatedTradesPerMonth: profile.estimatedTradesPerMonth,
          estimatedCapitalUtilizationPct: profile.estimatedCapitalUtilizationPct,
          estimatedFitAdjustedMonthlyReturnPct: profile.estimatedFitAdjustedMonthlyReturnPct,
          recommendedScanIntervalSeconds: profile.recommendedScanIntervalSeconds,
          recommendedConfirmationWindow: profile.recommendedConfirmationWindow,
          recommendedEntryModel: profile.recommendedEntryModel,
          recommendedHoldProfile: profile.recommendedHoldProfile,
          recommendedTpModel: profile.recommendedTpModel,
          recommendedSlModel: profile.recommendedSlModel,
          recommendedTrailingModel: profile.recommendedTrailingModel,
          recommendedScoreGates: profile.recommendedScoreGates,
          researchStatus: profile.researchStatus,
          generatedAt: new Date(profile.generatedAt),
          lastRunId: profile.lastRunId,
          rawJson: profile,
        },
      });
    return { profile, persisted: true };
  } catch (err) {
    if (isMissingRelationError(err)) {
      console.warn("[calibration] symbol_research_profiles table missing; returning derived profile only");
      return { profile, persisted: false };
    }
    throw err;
  }
}

export async function getLatestSymbolResearchProfile(
  symbol: string,
): Promise<SymbolResearchProfile | null> {
  try {
    const rows = await db
      .select()
      .from(symbolResearchProfilesTable)
      .where(eq(symbolResearchProfilesTable.symbol, symbol))
      .orderBy(desc(symbolResearchProfilesTable.generatedAt))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const raw = asRecord(row.rawJson);
    return {
      symbol: row.symbol,
      symbolDomain: (row.symbolDomain as SymbolDomain) ?? "research",
      windowDays: row.windowDays,
      dataHealthSummary: row.dataHealthSummary,
      moveCount: row.moveCount,
      moveFamilyDistribution: asRecord(row.moveFamilyDistribution) as Record<string, number>,
      engineTypeRecommendation: row.engineTypeRecommendation ?? "",
      buildPriority: (row.buildPriority as "high" | "medium" | "low") ?? "low",
      estimatedTradesPerMonth: row.estimatedTradesPerMonth ?? 0,
      estimatedCapitalUtilizationPct: row.estimatedCapitalUtilizationPct ?? 0,
      estimatedFitAdjustedMonthlyReturnPct: row.estimatedFitAdjustedMonthlyReturnPct ?? 0,
      recommendedScanIntervalSeconds: row.recommendedScanIntervalSeconds ?? 300,
      recommendedConfirmationWindow: row.recommendedConfirmationWindow ?? "4h",
      recommendedEntryModel: row.recommendedEntryModel ?? "all",
      recommendedHoldProfile: asRecord(row.recommendedHoldProfile),
      recommendedTpModel: asRecord(row.recommendedTpModel),
      recommendedSlModel: asRecord(row.recommendedSlModel),
      recommendedTrailingModel: asRecord(row.recommendedTrailingModel),
      recommendedScoreGates: asRecord(row.recommendedScoreGates),
      researchStatus: (row.researchStatus as ResearchStatus) ?? "research_complete",
      generatedAt: row.generatedAt?.toISOString() ?? new Date().toISOString(),
      lastRunId: row.lastRunId,
      ...raw,
    };
  } catch (err) {
    if (isMissingRelationError(err)) {
      const latestRun = await db
        .select({ lastRunId: strategyCalibrationProfilesTable.lastRunId })
        .from(strategyCalibrationProfilesTable)
        .where(and(
          eq(strategyCalibrationProfilesTable.symbol, symbol),
          eq(strategyCalibrationProfilesTable.moveType, "all"),
        ))
        .orderBy(desc(strategyCalibrationProfilesTable.generatedAt))
        .limit(1);
      const runId = latestRun[0]?.lastRunId ?? 0;
      if (!runId) return null;
      return buildSymbolResearchProfile(symbol, runId);
    }
    throw err;
  }
}
