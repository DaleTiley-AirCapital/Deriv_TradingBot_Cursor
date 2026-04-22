/**
 * feeddown.ts — Read-Only Calibration Feeddown Layer
 *
 * Exposes structured calibration outputs for consumption by:
 *   - Research tab (UI display and 3-domain comparison)
 *   - AI Analysis tab (context enrichment — research only, not live execution)
 *   - Export endpoint (JSON download for offline analysis)
 *
 * CRITICAL: ALL functions here are READ-ONLY.
 * No calibration output is connected to live entry/exit decisions.
 * The calibration schema is research-only feeddown.
 */

import { db } from "@workspace/db";
import {
  calibrationEntryIdealsTable,
  calibrationExitRiskProfilesTable,
  calibrationFeatureRelevanceTable,
  detectedMovesTable,
  movePrecursorPassesTable,
  moveFamilyInferencesTable,
  moveBehaviorPassesTable,
  moveProgressionArtifactsTable,
  strategyCalibrationProfilesTable,
  calibrationPassRunsTable,
} from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { buildCalibrationAggregate, type CalibrationAggregateSummary } from "./calibrationAggregator.js";
import { getLatestSymbolResearchProfile, type SymbolResearchProfile } from "./symbolResearchProfile.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface EngineCalibration {
  symbol: string;
  engineName: string | null;
  matchedMoves: number;
  wouldFireCount: number;
  fireRate: number;
  avgMissMovePct: number;
  topMissReasons: string[];
  topPrecursorConditions: string[];
  readOnly: true;
}

export interface ScoringCalibration {
  symbol: string;
  tierA: { count: number; avgMovePct: number; avgHoldHours: number; suggestedMinScore: number };
  tierB: { count: number; avgMovePct: number; avgHoldHours: number; suggestedMinScore: number };
  tierC: { count: number; avgMovePct: number; avgHoldHours: number; suggestedMinScore: number };
  tierD: { count: number; avgMovePct: number; avgHoldHours: number; suggestedMinScore: number };
  aiScoringCalibration: unknown;
  readOnly: true;
}

export interface TradeHealthCalibration {
  symbol: string;
  avgHoldingHours: number;
  p25HoldHours: number;
  p50HoldHours: number;
  p75HoldHours: number;
  avgCaptureablePct: number;
  avgHoldabilityScore: number;
  systemCompatibility: string;
  topBehaviorPatterns: Array<{ pattern: string; count: number }>;
  readOnly: true;
}

export interface FullCalibrationExport {
  symbol: string;
  exportedAt: string;
  windowDays: number;
  honest_fit: {
    targetMoves: number;
    capturedMoves: number;
    missedMoves: number;
    fitScore: number;
    missReasons: Array<{ reason: string; count: number }>;
  };
  aggregate: CalibrationAggregateSummary;
  profiles: typeof strategyCalibrationProfilesTable.$inferSelect[];
  familyInferences: typeof moveFamilyInferencesTable.$inferSelect[];
  progressionArtifacts: typeof moveProgressionArtifactsTable.$inferSelect[];
  featureRelevance: typeof calibrationFeatureRelevanceTable.$inferSelect[];
  entryIdeals: typeof calibrationEntryIdealsTable.$inferSelect[];
  exitRiskProfiles: typeof calibrationExitRiskProfilesTable.$inferSelect[];
  latestRunStatus: typeof calibrationPassRunsTable.$inferSelect | null;
  researchProfile: SymbolResearchProfile | null;
  costTelemetry: {
    requestCount: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedUsd: number;
    byPass: Record<string, unknown>;
    phaseDurationsMs: Record<string, number>;
    totalDurationMs: number;
  } | null;
  readOnly: true;
}

// ── Engine calibration ─────────────────────────────────────────────────────────

export async function getEngineCalibration(
  symbol: string,
): Promise<EngineCalibration[]> {
  const precursorRows = await db
    .select()
    .from(movePrecursorPassesTable)
    .where(eq(movePrecursorPassesTable.symbol, symbol));

  const engineMap: Record<string, {
    matched: number;
    fired: number;
    movePcts: number[];
    missReasons: string[];
    conditions: string[];
  }> = {};

  const moves = await db
    .select()
    .from(detectedMovesTable)
    .where(eq(detectedMovesTable.symbol, symbol));

  const moveById = new Map(moves.map(m => [m.id, m]));

  for (const p of precursorRows) {
    const key = p.engineMatched ?? "none";
    if (!engineMap[key]) {
      engineMap[key] = { matched: 0, fired: 0, movePcts: [], missReasons: [], conditions: [] };
    }
    engineMap[key].matched++;
    if (p.engineWouldFire) {
      engineMap[key].fired++;
    } else {
      const move = moveById.get(p.moveId);
      if (move) engineMap[key].movePcts.push(move.movePct * 100);
      if (p.missedReason) engineMap[key].missReasons.push(p.missedReason);
    }
    const conds = p.precursorConditions as Array<{ condition: string }> | null;
    if (Array.isArray(conds)) {
      for (const c of conds) if (c?.condition) engineMap[key].conditions.push(c.condition);
    }
  }

  return Object.entries(engineMap).map(([engineName, data]) => ({
    symbol,
    engineName: engineName === "none" ? null : engineName,
    matchedMoves:   data.matched,
    wouldFireCount: data.fired,
    fireRate:       data.matched > 0 ? data.fired / data.matched : 0,
    avgMissMovePct: data.movePcts.length > 0
      ? data.movePcts.reduce((a, b) => a + b, 0) / data.movePcts.length
      : 0,
    topMissReasons: [...new Set(data.missReasons)].slice(0, 3),
    topPrecursorConditions: topN(data.conditions, 3),
    readOnly: true as const,
  }));
}

// ── Scoring calibration ────────────────────────────────────────────────────────

export async function getScoringCalibration(
  symbol: string,
): Promise<ScoringCalibration> {
  const moves = await db
    .select()
    .from(detectedMovesTable)
    .where(eq(detectedMovesTable.symbol, symbol));

  const profile = await db
    .select()
    .from(strategyCalibrationProfilesTable)
    .where(
      and(
        eq(strategyCalibrationProfilesTable.symbol, symbol),
        eq(strategyCalibrationProfilesTable.moveType, "all"),
      ),
    )
    .limit(1);

  const aiScoringCalibration = (profile[0]?.feeddownSchema as Record<string, unknown>)
    ?.scoringCalibration ?? null;

  function tierStats(tier: string): { count: number; avgMovePct: number; avgHoldHours: number; suggestedMinScore: number } {
    const tierMoves = moves.filter(m => m.qualityTier === tier);
    const pcts  = tierMoves.map(m => m.movePct * 100);
    const hours = tierMoves.map(m => m.holdingMinutes / 60);
    const avg   = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const scores = tierMoves.map(m => m.qualityScore);
    return {
      count:             tierMoves.length,
      avgMovePct:        avg(pcts),
      avgHoldHours:      avg(hours),
      suggestedMinScore: scores.length > 0 ? Math.min(...scores) : 60,
    };
  }

  return {
    symbol,
    tierA: tierStats("A"),
    tierB: tierStats("B"),
    tierC: tierStats("C"),
    tierD: tierStats("D"),
    aiScoringCalibration,
    readOnly: true as const,
  };
}

// ── Trade health calibration ───────────────────────────────────────────────────

export async function getTradeHealthCalibration(
  symbol: string,
): Promise<TradeHealthCalibration> {
  const moves = await db
    .select()
    .from(detectedMovesTable)
    .where(eq(detectedMovesTable.symbol, symbol));

  const behaviorRows = await db
    .select()
    .from(moveBehaviorPassesTable)
    .where(
      and(
        eq(moveBehaviorPassesTable.symbol, symbol),
        eq(moveBehaviorPassesTable.passName, "behavior"),
      ),
    );

  const triggerRows = await db
    .select()
    .from(moveBehaviorPassesTable)
    .where(
      and(
        eq(moveBehaviorPassesTable.symbol, symbol),
        eq(moveBehaviorPassesTable.passName, "trigger"),
      ),
    );

  const profile = await db
    .select()
    .from(strategyCalibrationProfilesTable)
    .where(
      and(
        eq(strategyCalibrationProfilesTable.symbol, symbol),
        eq(strategyCalibrationProfilesTable.moveType, "all"),
      ),
    )
    .limit(1);

  const holdHours  = moves.map(m => m.holdingMinutes / 60).sort((a, b) => a - b);
  const captureable = triggerRows.map(r => r.captureablePct);
  const holdability = behaviorRows.map(r => r.holdabilityScore);
  const patterns: Record<string, number> = {};
  for (const r of behaviorRows) {
    patterns[r.behaviorPattern] = (patterns[r.behaviorPattern] ?? 0) + 1;
  }

  function pct(arr: number[], p: number): number {
    if (arr.length === 0) return 0;
    const idx = Math.max(0, Math.min(arr.length - 1, Math.floor(arr.length * p)));
    return arr[idx];
  }

  const feeddown = (profile[0]?.feeddownSchema as Record<string, unknown>) ?? {};
  const holdCal  = (feeddown.holdDurationCalibration as Record<string, unknown>) ?? {};

  return {
    symbol,
    avgHoldingHours:     holdHours.length > 0 ? holdHours.reduce((a, b) => a + b, 0) / holdHours.length : 0,
    p25HoldHours:        pct(holdHours, 0.25),
    p50HoldHours:        pct(holdHours, 0.50),
    p75HoldHours:        pct(holdHours, 0.75),
    avgCaptureablePct:   captureable.length > 0 ? captureable.reduce((a, b) => a + b, 0) / captureable.length : 0,
    avgHoldabilityScore: holdability.length > 0 ? holdability.reduce((a, b) => a + b, 0) / holdability.length : 0,
    systemCompatibility: String(holdCal.systemCompatibility ?? "unknown"),
    topBehaviorPatterns: Object.entries(patterns)
      .sort((a, b) => b[1] - a[1])
      .map(([pattern, count]) => ({ pattern, count })),
    readOnly: true as const,
  };
}

// ── Full export ────────────────────────────────────────────────────────────────

export async function getFullCalibrationExport(
  symbol: string,
): Promise<FullCalibrationExport> {
  const aggregate = await buildCalibrationAggregate(symbol);

  const [profiles, latestRun, researchProfile] = await Promise.all([
    db
      .select()
      .from(strategyCalibrationProfilesTable)
      .where(eq(strategyCalibrationProfilesTable.symbol, symbol)),
    db
      .select()
      .from(calibrationPassRunsTable)
      .where(eq(calibrationPassRunsTable.symbol, symbol))
      .orderBy(desc(calibrationPassRunsTable.startedAt))
      .limit(1),
    getLatestSymbolResearchProfile(symbol),
  ]);
  const [familyInferences, progressionArtifacts, featureRelevance, entryIdeals, exitRiskProfiles] = await Promise.all([
    db.select().from(moveFamilyInferencesTable).where(eq(moveFamilyInferencesTable.symbol, symbol)),
    db.select().from(moveProgressionArtifactsTable).where(eq(moveProgressionArtifactsTable.symbol, symbol)),
    db.select().from(calibrationFeatureRelevanceTable).where(eq(calibrationFeatureRelevanceTable.symbol, symbol)),
    db.select().from(calibrationEntryIdealsTable).where(eq(calibrationEntryIdealsTable.symbol, symbol)),
    db.select().from(calibrationExitRiskProfilesTable).where(eq(calibrationExitRiskProfilesTable.symbol, symbol)),
  ]);
  const latest = latestRun[0] ?? null;
  const meta = latest?.metaJson && typeof latest.metaJson === "object"
    ? (latest.metaJson as Record<string, unknown>)
    : {};
  const usage = meta.usage && typeof meta.usage === "object"
    ? (meta.usage as Record<string, unknown>)
    : null;
  const phaseDurations = meta.phaseDurationsMs && typeof meta.phaseDurationsMs === "object"
    ? (meta.phaseDurationsMs as Record<string, number>)
    : {};
  const totalDurationMs =
    typeof phaseDurations.total === "number"
      ? phaseDurations.total
      : latest?.startedAt && latest?.completedAt
        ? latest.completedAt.getTime() - latest.startedAt.getTime()
        : 0;

  return {
    symbol,
    exportedAt:  new Date().toISOString(),
    windowDays:  profiles[0]?.windowDays ?? 90,
    honest_fit: {
      targetMoves:   aggregate.overall.targetMoves,
      capturedMoves: aggregate.overall.capturedMoves,
      missedMoves:   aggregate.overall.missedMoves,
      fitScore:      aggregate.overall.fitScore,
      missReasons:   aggregate.overall.missReasons,
    },
    aggregate,
    profiles,
    familyInferences,
    progressionArtifacts,
    featureRelevance,
    entryIdeals,
    exitRiskProfiles,
    latestRunStatus: latest,
    researchProfile,
    costTelemetry: usage
      ? {
        requestCount: Number(usage.requestCount ?? 0),
        promptTokens: Number(usage.promptTokens ?? 0),
        completionTokens: Number(usage.completionTokens ?? 0),
        totalTokens: Number(usage.totalTokens ?? 0),
        estimatedUsd: Number(usage.estimatedUsd ?? 0),
        byPass: (usage.byPass as Record<string, unknown>) ?? {},
        phaseDurationsMs: phaseDurations,
        totalDurationMs,
      }
      : null,
    readOnly: true as const,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function topN(arr: string[], n: number): string[] {
  const counts: Record<string, number> = {};
  for (const s of arr) counts[s] = (counts[s] ?? 0) + 1;
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([s]) => s);
}
