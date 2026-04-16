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
import { eq, and, inArray } from "drizzle-orm";

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
    avgMfe: number | null;
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

  // Scope pass queries to CURRENT detected move IDs only.
  // Without this scoping, stale pass rows from a prior detect run (whose moves were
  // deleted but whose pass rows were not) pollute the captured/missed calculation
  // and can produce capturedMoves > targetMoves (fitScore > 1) or negative missedMoves.
  const currentMoveIds = moves.map(m => m.id);

  const precursorRows = currentMoveIds.length > 0
    ? await db.select().from(movePrecursorPassesTable)
        .where(and(
          eq(movePrecursorPassesTable.symbol, symbol),
          inArray(movePrecursorPassesTable.moveId, currentMoveIds),
        ))
    : [];

  const behaviorRows = currentMoveIds.length > 0
    ? await db.select().from(moveBehaviorPassesTable)
        .where(and(
          eq(moveBehaviorPassesTable.symbol, symbol),
          inArray(moveBehaviorPassesTable.moveId, currentMoveIds),
        ))
    : [];

  const triggerRows  = behaviorRows.filter(r => r.passName === "trigger");
  const behaviorOnly = behaviorRows.filter(r => r.passName === "behavior");

  const moveById = new Map(moves.map(m => [m.id, m]));
  const precursorById = new Map(precursorRows.map(p => [p.moveId, p]));
  const triggerById   = new Map(triggerRows.map(t => [t.moveId, t]));
  const behaviorById  = new Map(behaviorOnly.map(b => [b.moveId, b]));

  // ── Honest coverage calculation ────────────────────────────────────────────
  // A move is "captured" only if ALL three conditions hold:
  //   1. precursor pass ran and engineWouldFire=true
  //   2. trigger pass ran for the same moveId
  //   3. trigger pass captureablePct > 0  (the move was genuinely reachable)
  //
  // Moves where captureablePct === 0 are classified as miss reason
  // "trigger_zero_captureable" and must NOT be in capturedMoves, otherwise
  // fitScore can exceed 1 or miss counts go negative.
  //
  // We use DISTINCT moveId Sets so force=true reruns never inflate counts.
  const triggerMoveIds = new Set(triggerRows.map(t => t.moveId));

  // Build a set of moveIds where trigger ran but captureablePct === 0.
  const triggerZeroIds = new Set(
    triggerRows
      .filter(r => r.captureablePct === 0)
      .map(r => r.moveId),
  );

  // Deduplicate: one precursor row per moveId (keep the most-permissive — if any
  // row for a moveId has engineWouldFire=true, that moveId counts as fired).
  const precursorFiredSet = new Set(precursorRows.filter(r => r.engineWouldFire).map(r => r.moveId));

  // capturedMoves = precursor fired ∩ trigger ran ∩ captureablePct > 0
  const capturedMoveIdSet = new Set(
    [...precursorFiredSet].filter(mid => triggerMoveIds.has(mid) && !triggerZeroIds.has(mid)),
  );
  const capturedMoves = capturedMoveIdSet.size;
  const missedMoves   = moves.length - capturedMoves;
  const fitScore      = moves.length > 0 ? capturedMoves / moves.length : 0;

  // ── Miss reason aggregation (three miss paths, deduped by moveId) ──────────
  // Path 1 — Precursor-level misses (explicit missedReason from AI)
  const seenMissedMoveIds = new Set<number>();
  const reasonMap: Record<string, number> = {};
  for (const p of precursorRows) {
    if (!p.engineWouldFire && p.missedReason && !seenMissedMoveIds.has(p.moveId)) {
      seenMissedMoveIds.add(p.moveId);
      reasonMap[p.missedReason] = (reasonMap[p.missedReason] ?? 0) + 1;
    }
  }
  // Path 2 — Precursor fired but no trigger row → trigger never ran
  const triggerGapMoveIds = [...precursorFiredSet].filter(mid => !triggerMoveIds.has(mid));
  if (triggerGapMoveIds.length > 0) {
    reasonMap["trigger_pass_not_run"] = (reasonMap["trigger_pass_not_run"] ?? 0) + triggerGapMoveIds.length;
  }
  // Path 3 — Trigger ran but captureablePct === 0 (and precursor fired) → unreachable
  const zeroCapturePrecursorFired = [...triggerZeroIds].filter(mid => precursorFiredSet.has(mid));
  if (zeroCapturePrecursorFired.length > 0) {
    reasonMap["trigger_zero_captureable"] = (reasonMap["trigger_zero_captureable"] ?? 0) + zeroCapturePrecursorFired.length;
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
  const mfePcts     = behaviorOnly.map(r => r.maxFavorablePct * 100);

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
    // Use distinct moveIds to guard against inflation from force=true reruns
    const typeMoveIdSet = new Set(typeMoves.map(m => m.id));
    const typeEngFire   = [...precursorFiredSet].filter(mid => typeMoveIdSet.has(mid)).length;
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
      avgMfe:              mfePcts.length > 0 ? mfePcts.reduce((a, b) => a + b, 0) / mfePcts.length : null,
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
