/**
 * calibrationAggregator.ts — Post-pass Aggregation & Honest Fit Reporting
 *
 * Reads all completed pass results for a symbol and builds the final
 * calibration profile. Does NOT require the AI extraction pass to have run —
 * it builds deterministic aggregate metrics from raw pass rows.
 *
 * Honest fit reporting is mandatory:
 *   - targetMoves:   all detected moves for the symbol
 *   - capturedMoves: moves where precursor + trigger passes both succeeded
 *   - missedMoves:   targetMoves - capturedMoves
 *   - fitScore:      capturedMoves / targetMoves — never inflated, never rounded up
 *   - missReasons:   categorized from miss reason text in precursor pass rows
 *
 * This is READ-ONLY feeddown — it does not modify any engine, strategy, or
 * allocator logic. All outputs are schema artifacts for the UI/research layer.
 */

import { db } from "@workspace/db";
import {
  detectedMovesTable,
  movePrecursorPassesTable,
  moveBehaviorPassesTable,
  strategyCalibrationProfilesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CalibrationAggregateSummary {
  symbol: string;
  totalMoves: number;
  byMoveType: Record<string, {
    count: number;
    avgMovePct: number;
    medianMovePct: number;
    avgHoldHours: number;
    engineCoverage: number;
    avgCaptureablePct: number;
    avgHoldabilityScore: number;
  }>;
  overall: {
    targetMoves: number;
    capturedMoves: number;
    missedMoves: number;
    fitScore: number;
    avgMovePct: number;
    medianMovePct: number;
    avgHoldHours: number;
    avgCaptureablePct: number;
    avgHoldabilityScore: number;
    missReasons: Array<{ reason: string; count: number }>;
    engineCoverage: Record<string, { matched: number; fired: number; missRate: number }>;
    qualityDistribution: Record<string, number>;
    behaviorPatterns: Record<string, number>;
    leadInShapes: Record<string, number>;
    directionSplit: { up: number; down: number };
  };
  feeddownSchema: unknown;
  generatedAt: string;
}

// ── Median helper ──────────────────────────────────────────────────────────────

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

// ── Aggregate builder ──────────────────────────────────────────────────────────

export async function buildCalibrationAggregate(
  symbol: string,
): Promise<CalibrationAggregateSummary> {
  const moves = await db
    .select()
    .from(detectedMovesTable)
    .where(eq(detectedMovesTable.symbol, symbol));

  const precursorRows = await db
    .select()
    .from(movePrecursorPassesTable)
    .where(eq(movePrecursorPassesTable.symbol, symbol));

  const behaviorRows = await db
    .select()
    .from(moveBehaviorPassesTable)
    .where(eq(moveBehaviorPassesTable.symbol, symbol));

  const triggerRows  = behaviorRows.filter(r => r.passName === "trigger");
  const behaviorOnly = behaviorRows.filter(r => r.passName === "behavior");

  const moveById = new Map(moves.map(m => [m.id, m]));
  const precursorById = new Map(precursorRows.map(p => [p.moveId, p]));
  const triggerById   = new Map(triggerRows.map(t => [t.moveId, t]));
  const behaviorById  = new Map(behaviorOnly.map(b => [b.moveId, b]));

  // ── Honest coverage calculation ────────────────────────────────────────────
  // A move is "captured" only if the precursor pass ran and engineWouldFire=true
  const capturedMoves = precursorRows.filter(r => r.engineWouldFire).length;
  const missedMoves   = moves.length - capturedMoves;
  const fitScore      = moves.length > 0 ? capturedMoves / moves.length : 0;

  // ── Miss reason aggregation ────────────────────────────────────────────────
  const reasonMap: Record<string, number> = {};
  for (const p of precursorRows) {
    if (!p.engineWouldFire && p.missedReason) {
      reasonMap[p.missedReason] = (reasonMap[p.missedReason] ?? 0) + 1;
    }
  }
  const missReasons = Object.entries(reasonMap)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => ({ reason, count }));

  // ── Engine coverage ────────────────────────────────────────────────────────
  const engCovMap: Record<string, { matched: number; fired: number; missRate: number }> = {};
  for (const p of precursorRows) {
    const eng = p.engineMatched ?? "none";
    if (!engCovMap[eng]) engCovMap[eng] = { matched: 0, fired: 0, missRate: 0 };
    engCovMap[eng].matched++;
    if (p.engineWouldFire) engCovMap[eng].fired++;
  }
  for (const k of Object.keys(engCovMap)) {
    const m = engCovMap[k].matched;
    engCovMap[k].missRate = m > 0 ? (m - engCovMap[k].fired) / m : 0;
  }

  // ── Overall aggregates ─────────────────────────────────────────────────────
  const movePcts    = moves.map(m => m.movePct * 100);
  const holdHours   = moves.map(m => m.holdingMinutes / 60);
  const captureable = triggerRows.map(r => r.captureablePct);
  const holdability = behaviorOnly.map(r => r.holdabilityScore);

  const qualityDist: Record<string, number> = {};
  const leadInShapes: Record<string, number> = {};
  const behaviorPatterns: Record<string, number> = {};
  let upCount = 0, downCount = 0;

  for (const m of moves) {
    qualityDist[m.qualityTier] = (qualityDist[m.qualityTier] ?? 0) + 1;
    leadInShapes[m.leadInShape] = (leadInShapes[m.leadInShape] ?? 0) + 1;
    if (m.direction === "up") upCount++; else downCount++;
  }
  for (const b of behaviorOnly) {
    behaviorPatterns[b.behaviorPattern] = (behaviorPatterns[b.behaviorPattern] ?? 0) + 1;
  }

  // ── Per-moveType aggregates ────────────────────────────────────────────────
  const moveTypes = [...new Set(moves.map(m => m.moveType))];
  const byMoveType: CalibrationAggregateSummary["byMoveType"] = {};

  for (const mt of moveTypes) {
    const typeMoves = moves.filter(m => m.moveType === mt);
    const typePcts  = typeMoves.map(m => m.movePct * 100);
    const typeHours = typeMoves.map(m => m.holdingMinutes / 60);
    const typeEngFire = precursorRows.filter(r => {
      const mv = moveById.get(r.moveId);
      return mv?.moveType === mt && r.engineWouldFire;
    }).length;
    const typeTrigger = triggerRows.filter(r => {
      const mv = moveById.get(r.moveId);
      return mv?.moveType === mt;
    });
    const typeBehavior = behaviorOnly.filter(r => {
      const mv = moveById.get(r.moveId);
      return mv?.moveType === mt;
    });

    byMoveType[mt] = {
      count:               typeMoves.length,
      avgMovePct:          typePcts.length > 0 ? typePcts.reduce((a, b) => a + b, 0) / typePcts.length : 0,
      medianMovePct:       median(typePcts),
      avgHoldHours:        typeHours.length > 0 ? typeHours.reduce((a, b) => a + b, 0) / typeHours.length : 0,
      engineCoverage:      typeMoves.length > 0 ? typeEngFire / typeMoves.length : 0,
      avgCaptureablePct:   typeTrigger.length > 0 ? typeTrigger.reduce((a, b) => a + b.captureablePct, 0) / typeTrigger.length : 0,
      avgHoldabilityScore: typeBehavior.length > 0 ? typeBehavior.reduce((a, b) => a + b.holdabilityScore, 0) / typeBehavior.length : 0,
    };
  }

  // ── Fetch feeddown schema from extraction pass (if run) ────────────────────
  const existingProfile = await db
    .select()
    .from(strategyCalibrationProfilesTable)
    .where(eq(strategyCalibrationProfilesTable.symbol, symbol))
    .limit(1);

  const feeddownSchema = existingProfile[0]?.feeddownSchema ?? null;

  return {
    symbol,
    totalMoves: moves.length,
    byMoveType,
    overall: {
      targetMoves:         moves.length,
      capturedMoves,
      missedMoves,
      fitScore,
      avgMovePct:          movePcts.length > 0 ? movePcts.reduce((a, b) => a + b, 0) / movePcts.length : 0,
      medianMovePct:       median(movePcts),
      avgHoldHours:        holdHours.length > 0 ? holdHours.reduce((a, b) => a + b, 0) / holdHours.length : 0,
      avgCaptureablePct:   captureable.length > 0 ? captureable.reduce((a, b) => a + b, 0) / captureable.length : 0,
      avgHoldabilityScore: holdability.length > 0 ? holdability.reduce((a, b) => a + b, 0) / holdability.length : 0,
      missReasons,
      engineCoverage:      engCovMap,
      qualityDistribution: qualityDist,
      behaviorPatterns,
      leadInShapes,
      directionSplit: { up: upCount, down: downCount },
    },
    feeddownSchema,
    generatedAt: new Date().toISOString(),
  };
}

// ── Per-moveType profile getter ────────────────────────────────────────────────

export async function getCalibrationProfile(
  symbol: string,
  moveType = "all",
): Promise<typeof strategyCalibrationProfilesTable.$inferSelect | null> {
  const rows = await db
    .select()
    .from(strategyCalibrationProfilesTable)
    .where(eq(strategyCalibrationProfilesTable.symbol, symbol));

  return rows.find(r => r.moveType === moveType) ?? null;
}

export async function getAllCalibrationProfiles(
  symbol: string,
): Promise<typeof strategyCalibrationProfilesTable.$inferSelect[]> {
  return db
    .select()
    .from(strategyCalibrationProfilesTable)
    .where(eq(strategyCalibrationProfilesTable.symbol, symbol));
}
