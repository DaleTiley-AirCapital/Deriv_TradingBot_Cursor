import { db } from "@workspace/db";
import {
  detectedMovesTable,
  moveBehaviorPassesTable,
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

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p)));
  return sorted[idx] ?? 0;
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

  const [profileRows, moves, behaviorRows] = await Promise.all([
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
        qualityScore: detectedMovesTable.qualityScore,
      })
      .from(detectedMovesTable)
      .where(eq(detectedMovesTable.symbol, symbol)),
    db
      .select({
        captureablePct: moveBehaviorPassesTable.captureablePct,
        maxFavorablePct: moveBehaviorPassesTable.maxFavorablePct,
        maxAdversePct: moveBehaviorPassesTable.maxAdversePct,
        barsToMfePeak: moveBehaviorPassesTable.barsToMfePeak,
        passName: moveBehaviorPassesTable.passName,
      })
      .from(moveBehaviorPassesTable)
      .where(and(
        eq(moveBehaviorPassesTable.symbol, symbol),
        eq(moveBehaviorPassesTable.passName, "behavior"),
      )),
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

  const holdP25Hours = Number(hold.p25Hours ?? 0);
  const qualityScores = moves
    .map((m) => Number(m.qualityScore ?? NaN))
    .filter((v) => Number.isFinite(v));
  const qualityP50 = percentile(qualityScores, 0.50);
  const qualityP75 = percentile(qualityScores, 0.75);
  const qualityP90 = percentile(qualityScores, 0.90);

  const behaviorCaptureable = behaviorRows
    .map((r) => Number(r.captureablePct ?? NaN) * 100)
    .filter((v) => Number.isFinite(v) && v > 0);
  const behaviorMfe = behaviorRows
    .map((r) => Number(r.maxFavorablePct ?? NaN) * 100)
    .filter((v) => Number.isFinite(v) && v > 0);
  const behaviorMae = behaviorRows
    .map((r) => Math.abs(Number(r.maxAdversePct ?? NaN) * 100))
    .filter((v) => Number.isFinite(v) && v > 0);
  const barsToMfe = behaviorRows
    .map((r) => Number(r.barsToMfePeak ?? NaN))
    .filter((v) => Number.isFinite(v) && v > 0);

  const tpTargetPct = percentile(behaviorMfe, 0.50) || Number(Math.max(0, profile.avgMovePct ?? 0).toFixed(2));
  const slRiskPct = percentile(behaviorMae, 0.75) || Number(Math.max(0.5, (profile.avgMovePct ?? 0) * 0.35).toFixed(2));
  const captureableP50 = percentile(behaviorCaptureable, 0.50);
  const minHoldMinutesBeforeTrail = Number(
    Math.max(
      60,
      Math.min(
        12 * 60,
        barsToMfe.length > 0
          ? Math.round(percentile(barsToMfe, 0.25))
          : (holdP25Hours > 0 ? Math.round(holdP25Hours * 60 * 0.30) : 180),
      ),
    ).toFixed(0),
  );
  const trailActivationPct = Number(
    Math.max(
      1.5,
      Math.min(90, tpTargetPct * 0.35, captureableP50 > 0 ? captureableP50 * 0.5 : 90),
    ).toFixed(2),
  );
  const trailDistancePct = Number(
    Math.max(0.8, Math.min(40, slRiskPct * 0.5)).toFixed(2),
  );
  const paperGate = Math.max(40, Math.min(95, Math.round(qualityP50 || Number(scoring.mediumQualityMoveMinScore ?? 60))));
  const demoGate = Math.max(45, Math.min(97, Math.round(Math.max(qualityP75 || Number(scoring.mediumQualityMoveMinScore ?? 65), paperGate + 5))));
  const realGate = Math.max(50, Math.min(99, Math.round(Math.max(qualityP90 || Number(scoring.highQualityMoveMinScore ?? 70), demoGate + 5))));

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
      targetPct: Number(tpTargetPct.toFixed(2)),
      rationale: "Derived from behavior-pass MFE median (symbol-specific)",
    },
    recommendedSlModel: {
      structural: true,
      maxInitialRiskPct: Number(slRiskPct.toFixed(2)),
    },
    recommendedTrailingModel: {
      activationProfitPct: trailActivationPct,
      trailingDistancePct: trailDistancePct,
      minHoldMinutesBeforeTrail,
      policy: "tp_primary_trailing_safety_net",
    },
    recommendedScoreGates: {
      paper: paperGate,
      demo: demoGate,
      real: realGate,
      source: "symbol_quality_percentiles",
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
