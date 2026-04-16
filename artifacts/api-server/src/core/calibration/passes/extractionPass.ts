/**
 * extractionPass.ts — AI Pass 4: Cross-Move Rule Extraction
 *
 * Runs ONCE per symbol (not per-move) after precursor+trigger+behavior passes
 * are complete. Synthesizes findings across all detected moves to extract:
 *   - Repeatable structural rules for entry (IF-THEN format)
 *   - Engine gaps (moves the current engine set would consistently miss)
 *   - Score calibration guidance (what score level aligns with move quality)
 *   - Hold duration guidance (how long moves last vs system TP targets)
 *   - Honest fit summary (what % of moves are covered by current engines)
 *
 * Output is stored in strategy_calibration_profiles (move_type="all").
 * This is read-only feeddown — it does NOT modify engine logic.
 */

import { db } from "@workspace/db";
import {
  detectedMovesTable,
  movePrecursorPassesTable,
  moveBehaviorPassesTable,
  strategyCalibrationProfilesTable,
  type DetectedMoveRow,
} from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { getOpenAIClient } from "../../../infrastructure/openai.js";

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

export async function runExtractionPass(
  symbol: string,
  moves: DetectedMoveRow[],
  runId: number,
): Promise<void> {
  if (moves.length === 0) return;

  // Scope all pass queries to the CURRENT detected move IDs so stale rows from
  // a previous detect run never inflate captured/fit or skew miss reasons.
  const currentMoveIds = moves.map(m => m.id);

  const precursorRows = currentMoveIds.length > 0
    ? await db.select().from(movePrecursorPassesTable)
        .where(and(
          eq(movePrecursorPassesTable.symbol, symbol),
          inArray(movePrecursorPassesTable.moveId, currentMoveIds),
        ))
    : [];

  const allBehaviorRows = currentMoveIds.length > 0
    ? await db.select().from(moveBehaviorPassesTable)
        .where(and(
          eq(moveBehaviorPassesTable.symbol, symbol),
          inArray(moveBehaviorPassesTable.moveId, currentMoveIds),
        ))
    : [];
  const triggerRows = allBehaviorRows;

  const behaviorRows = triggerRows.filter(r => r.passName === "behavior");
  const triggerOnlyRows = triggerRows.filter(r => r.passName === "trigger");

  // Compute aggregate stats
  const movePcts      = moves.map(m => m.movePct * 100);
  const holdHours     = moves.map(m => m.holdingMinutes / 60);
  const holdability   = behaviorRows.map(r => r.holdabilityScore);
  const capturable    = triggerOnlyRows.map(r => r.captureablePct);

  // Honest fit: a move is "captured" only if ALL THREE hold:
  //   1. precursor ran and engineWouldFire=true
  //   2. trigger pass ran for that moveId
  //   3. trigger captureablePct > 0  (the move was genuinely reachable)
  // Moves with captureablePct === 0 are NOT captured — they go to miss reason
  // "trigger_zero_captureable". Using distinct moveId Sets prevents force=true reruns
  // from inflating counts and ensures fitScore ≤ 1 and missedMoves ≥ 0 always.
  const triggerMoveIdSet    = new Set(triggerOnlyRows.map(r => r.moveId));
  const triggerZeroIdSet    = new Set(triggerOnlyRows.filter(r => r.captureablePct === 0).map(r => r.moveId));
  const precursorFiredIdSet = new Set(precursorRows.filter(r => r.engineWouldFire).map(r => r.moveId));
  const capturedIdSet       = new Set(
    [...precursorFiredIdSet].filter(mid => triggerMoveIdSet.has(mid) && !triggerZeroIdSet.has(mid)),
  );
  const captured            = capturedIdSet.size;
  const fitScore            = moves.length > 0 ? captured / moves.length : 0;
  // engineFired = distinct moveIds where precursor alone would fire (for prompt context)
  const engineFired         = precursorFiredIdSet.size;

  const byType: Record<string, number> = {};
  for (const m of moves) byType[m.moveType] = (byType[m.moveType] ?? 0) + 1;

  // Comprehensive miss-reason aggregation — three paths, all deduped by moveId.
  //   1. Precursor miss: engine would NOT fire (missedReason from AI)
  //   2. Trigger gap: precursor fired but no trigger row ran
  //   3. Trigger failure: trigger ran but captureablePct == 0
  // precursorFiredIdSet already deduped above.
  const reasonMap: Record<string, number> = {};

  // Path 1 — Precursor-level misses: one reason per moveId (first seen)
  const seenMissedIds = new Set<number>();
  for (const p of precursorRows) {
    if (!p.engineWouldFire && p.missedReason && !seenMissedIds.has(p.moveId)) {
      seenMissedIds.add(p.moveId);
      reasonMap[p.missedReason] = (reasonMap[p.missedReason] ?? 0) + 1;
    }
  }

  // Path 2 — Precursor fired but no trigger row exists
  const triggerGapCount = [...precursorFiredIdSet].filter(mid => !triggerMoveIdSet.has(mid)).length;
  if (triggerGapCount > 0) {
    reasonMap["trigger_pass_not_run"] = (reasonMap["trigger_pass_not_run"] ?? 0) + triggerGapCount;
  }

  // Path 3 — Trigger ran but captureablePct == 0 (deduped by moveId via Set)
  const triggerZeroIds = new Set(
    triggerOnlyRows.filter(r => precursorFiredIdSet.has(r.moveId) && r.captureablePct === 0).map(r => r.moveId),
  );
  if (triggerZeroIds.size > 0) {
    reasonMap["trigger_zero_captureable"] = (reasonMap["trigger_zero_captureable"] ?? 0) + triggerZeroIds.size;
  }

  const missReasons: Array<{ reason: string; count: number }> = Object.entries(reasonMap)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  const behaviorPatterns: Record<string, number> = {};
  for (const r of behaviorRows) {
    behaviorPatterns[r.behaviorPattern] = (behaviorPatterns[r.behaviorPattern] ?? 0) + 1;
  }

  const topConditions = extractTopConditions(precursorRows);
  const topTriggers   = extractTopConditions(triggerOnlyRows);

  // Build prompt for rule extraction
  const prompt = `You are extracting structural trading rules from completed calibration analysis.

Symbol: ${symbol}
Analysis window: ${moves.length} detected moves
Move size range: ${Math.min(...movePcts).toFixed(1)}% – ${Math.max(...movePcts).toFixed(1)}% (median ${median(movePcts).toFixed(1)}%)
Hold duration range: ${Math.min(...holdHours).toFixed(1)}h – ${Math.max(...holdHours).toFixed(1)}h
Move types: ${JSON.stringify(byType)}
Engine coverage (current engines would fire): ${(fitScore * 100).toFixed(0)}% of detected moves

Average holdability score: ${holdability.length > 0 ? (holdability.reduce((a, b) => a + b, 0) / holdability.length).toFixed(2) : 'N/A'}
Average capturable fraction: ${capturable.length > 0 ? (capturable.reduce((a, b) => a + b, 0) / capturable.length * 100).toFixed(1) : 'N/A'}%

Top precursor conditions (across all moves):
${topConditions.slice(0, 5).map(c => `  - ${c.name} (seen in ${c.count} moves)`).join('\n') || '  None identified'}

Top trigger conditions (across all moves):
${topTriggers.slice(0, 5).map(c => `  - ${c.name} (seen in ${c.count} moves)`).join('\n') || '  None identified'}

Behavior patterns: ${JSON.stringify(behaviorPatterns)}

Miss reasons (why current engines would not fire on ${Math.round((1 - fitScore) * moves.length)} moves):
${missReasons.slice(0, 3).map(r => `  - "${r.reason}" (${r.count} moves)`).join('\n') || '  None'}

SYSTEM CONSTRAINTS (non-negotiable):
- TP targets: 50–200%+ moves only. No scalp suggestions.
- Hold: 3–44 days. Long hold IS the system.
- Score gates: Paper≥60, Demo≥65, Real≥70
- Instruments: CRASH300, BOOM300, R_75, R_100 only
- AI output is RESEARCH ONLY — not wired to live execution

TASK: Extract calibration intelligence.

Respond with ONLY valid JSON:
{
  "structuralRules": [
    {"rule": "<IF [condition] AND [condition] THEN [entry signal]>", "moveTypeTarget": "breakout|continuation|reversal|all", "confidence": "high|medium|low"}
  ],
  "engineGaps": [
    {"description": "<what pattern current engines miss>", "frequency": <estimated % of moves>, "suggestedFix": "<research suggestion, NOT a code change>"}
  ],
  "scoringCalibration": {
    "highQualityMoveMinScore": <suggested min score for A-tier moves>,
    "mediumQualityMoveMinScore": <suggested min score for B-tier moves>,
    "reasoning": "<1-2 sentences>"
  },
  "holdDurationCalibration": {
    "p25Hours": <25th percentile hold hours>,
    "p50Hours": <median>,
    "p75Hours": <75th percentile>,
    "systemCompatibility": "excellent|good|marginal|poor",
    "reasoning": "<1-2 sentences>"
  },
  "overallFitNarrative": "<2-3 sentences: honest assessment of how well the current system covers the detected moves and what the primary gaps are>",
  "topImprovementOpportunity": "<1 sentence: single most impactful calibration change — must be research output, not a live code change>"
}`;

  const client = await getOpenAIClient();
  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 900,
    temperature: 0.3,
  });

  const raw = response.choices[0]?.message?.content?.trim() ?? "";
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON in extraction pass response");
  const parsed = JSON.parse(match[0]);

  const feeddownSchema = {
    structuralRules:        parsed.structuralRules ?? [],
    engineGaps:             parsed.engineGaps ?? [],
    scoringCalibration:     parsed.scoringCalibration ?? {},
    holdDurationCalibration: parsed.holdDurationCalibration ?? {},
    overallFitNarrative:    parsed.overallFitNarrative ?? "",
    topImprovementOpportunity: parsed.topImprovementOpportunity ?? "",
    rawExtraction:          parsed,
  };

  const avgMovePct      = movePcts.length  > 0 ? movePcts.reduce((a, b) => a + b, 0) / movePcts.length : 0;
  const avgHoldHours    = holdHours.length > 0 ? holdHours.reduce((a, b) => a + b, 0) / holdHours.length : 0;
  const avgCaptureable  = capturable.length > 0 ? capturable.reduce((a, b) => a + b, 0) / capturable.length : 0;
  const avgHoldability  = holdability.length > 0 ? holdability.reduce((a, b) => a + b, 0) / holdability.length : 0;

  // ── Profitability summary ──────────────────────────────────────────────────
  // Ranks extraction paths (by move type) by their estimated monthly return.
  // Estimated monthly return = (avgMovePct * fitScore * avgCaptureablePct) / (avgHoldHours / 720)
  // This is a research estimate only — not wired to live trading.
  const profitabilitySummary = buildProfitabilitySummary(moves, precursorFiredIdSet, triggerMoveIdSet, triggerOnlyRows);

  await db
    .insert(strategyCalibrationProfilesTable)
    .values({
      symbol,
      moveType:           "all",
      windowDays:         90,
      targetMoves:        moves.length,
      capturedMoves:      captured,
      missedMoves:        moves.length - captured,
      fitScore,
      missReasons,
      avgMovePct,
      medianMovePct:      median(movePcts),
      avgHoldingHours:    avgHoldHours,
      avgCaptureablePct:  avgCaptureable,
      avgHoldabilityScore: avgHoldability,
      engineCoverage:     buildEngineCoverage(precursorRows),
      precursorSummary:   topConditions.slice(0, 10),
      triggerSummary:     topTriggers.slice(0, 10),
      feeddownSchema,
      profitabilitySummary,
      lastRunId:          runId,
    })
    .onConflictDoUpdate({
      target: [strategyCalibrationProfilesTable.symbol, strategyCalibrationProfilesTable.moveType],
      set: {
        targetMoves:        moves.length,
        capturedMoves:      captured,
        missedMoves:        moves.length - captured,
        fitScore,
        missReasons,
        avgMovePct,
        medianMovePct:      median(movePcts),
        avgHoldingHours:    avgHoldHours,
        avgCaptureablePct:  avgCaptureable,
        avgHoldabilityScore: avgHoldability,
        engineCoverage:     buildEngineCoverage(precursorRows),
        precursorSummary:   topConditions.slice(0, 10),
        triggerSummary:     topTriggers.slice(0, 10),
        feeddownSchema,
        profitabilitySummary,
        lastRunId:          runId,
        generatedAt:        new Date(),
      },
    });

  // Also upsert per-moveType profiles (deterministic aggregates only)
  const types = [...new Set(moves.map(m => m.moveType))];
  for (const mt of types) {
    const typeMoves   = moves.filter(m => m.moveType === mt);
    const typePcts    = typeMoves.map(m => m.movePct * 100);
    const typeHours   = typeMoves.map(m => m.holdingMinutes / 60);
    // Honest fit per move-type: both precursor fired AND trigger ran for that move.
    // Use distinct moveIds to prevent inflation from force=true reruns.
    const typeMoveIdSet  = new Set(typeMoves.map(m => m.id));
    // Trigger rows scoped to this move type's IDs
    const typeTriggered  = new Set(triggerOnlyRows.filter(r => typeMoveIdSet.has(r.moveId)).map(r => r.moveId));
    // Zero-captureable IDs scoped to this move type
    const typeZeroIds    = new Set(triggerOnlyRows.filter(r => typeMoveIdSet.has(r.moveId) && r.captureablePct === 0).map(r => r.moveId));
    // precursorFiredIdSet already deduped globally — intersect with this type's move IDs
    const typeFiredSet   = new Set([...precursorFiredIdSet].filter(mid => typeMoveIdSet.has(mid)));
    // Captured = precursor fired ∩ trigger ran ∩ captureablePct > 0 (honest)
    const typeCaptured   = [...typeFiredSet].filter(mid => typeTriggered.has(mid) && !typeZeroIds.has(mid)).length;
    const typeFitScore   = typeMoves.length > 0 ? typeCaptured / typeMoves.length : 0;

    await db
      .insert(strategyCalibrationProfilesTable)
      .values({
        symbol,
        moveType:        mt,
        windowDays:      90,
        targetMoves:     typeMoves.length,
        capturedMoves:   typeCaptured,
        missedMoves:     typeMoves.length - typeCaptured,
        fitScore:        typeFitScore,
        avgMovePct:      typePcts.length  > 0 ? typePcts.reduce((a, b) => a + b, 0) / typePcts.length : 0,
        medianMovePct:   median(typePcts),
        avgHoldingHours: typeHours.length > 0 ? typeHours.reduce((a, b) => a + b, 0) / typeHours.length : 0,
        lastRunId:       runId,
      })
      .onConflictDoUpdate({
        target: [strategyCalibrationProfilesTable.symbol, strategyCalibrationProfilesTable.moveType],
        set: {
          targetMoves:     typeMoves.length,
          capturedMoves:   typeCaptured,
          missedMoves:     typeMoves.length - typeCaptured,
          fitScore:        typeFitScore,
          avgMovePct:      typePcts.length  > 0 ? typePcts.reduce((a, b) => a + b, 0) / typePcts.length : 0,
          medianMovePct:   median(typePcts),
          avgHoldingHours: typeHours.length > 0 ? typeHours.reduce((a, b) => a + b, 0) / typeHours.length : 0,
          lastRunId:       runId,
          generatedAt:     new Date(),
        },
      });
  }
}

// ── Profitability summary builder ─────────────────────────────────────────────
// Ranks extraction paths by estimated monthly return (research estimate only).
// Formula per path (moveType):
//   estimatedMonthlyReturnPct = (avgMovePct * fitScore * avgCaptureablePct) / (avgHoldDays / 30)
// Capped at realistic values; flagged with confidence based on sample size.

function buildProfitabilitySummary(
  moves: DetectedMoveRow[],
  precursorFiredIdSet: Set<number>,
  triggerMoveIds: Set<number>,
  triggerOnlyRows: Array<{ moveId: number; captureablePct: number }>,
): {
  paths: Array<{
    name: string;
    estimatedMonthlyReturnPct: number;
    fitScore: number;
    captureablePct: number;
    holdDays: number;
    moveCount: number;
    confidence: "high" | "medium" | "low";
  }>;
  topPath: string;
  estimatedFitAdjustedReturn: number;
} {
  const types = [...new Set(moves.map(m => m.moveType))];
  const paths = types.map(mt => {
    const typeMoves   = moves.filter(m => m.moveType === mt);
    const typeMoveIds = new Set(typeMoves.map(m => m.id));
    const typeFired   = [...precursorFiredIdSet].filter(mid => typeMoveIds.has(mid));
    // Exclude zero-captureable moves so profitability fitScore matches honest-fit
    const typeZeroIds = new Set(triggerOnlyRows.filter(r => typeMoveIds.has(r.moveId) && r.captureablePct === 0).map(r => r.moveId));
    const typeCapt    = typeFired.filter(mid => triggerMoveIds.has(mid) && !typeZeroIds.has(mid)).length;
    const fs          = typeMoves.length > 0 ? typeCapt / typeMoves.length : 0;
    const avgPct      = typeMoves.length > 0 ? typeMoves.reduce((s, m) => s + m.movePct, 0) / typeMoves.length : 0;
    const typeTriggers = triggerOnlyRows.filter(r => typeMoveIds.has(r.moveId));
    const avgCapt     = typeTriggers.length > 0 ? typeTriggers.reduce((s, r) => s + r.captureablePct, 0) / typeTriggers.length : 0;
    const avgHoldDays = typeMoves.length > 0 ? typeMoves.reduce((s, m) => s + m.holdingMinutes / 1440, 0) / typeMoves.length : 1;
    const estimatedMonthlyReturnPct = avgHoldDays > 0
      ? Math.min(500, (avgPct * 100 * fs * Math.max(0, avgCapt)) / (avgHoldDays / 30))
      : 0;
    const confidence: "high" | "medium" | "low" =
      typeMoves.length >= 20 ? "high" :
      typeMoves.length >= 8  ? "medium" : "low";
    return {
      name: mt,
      estimatedMonthlyReturnPct: parseFloat(estimatedMonthlyReturnPct.toFixed(2)),
      fitScore: parseFloat(fs.toFixed(4)),
      captureablePct: parseFloat(avgCapt.toFixed(4)),
      holdDays: parseFloat(avgHoldDays.toFixed(2)),
      moveCount: typeMoves.length,
      confidence,
    };
  }).sort((a, b) => b.estimatedMonthlyReturnPct - a.estimatedMonthlyReturnPct);

  const topPath = paths[0]?.name ?? "unknown";
  const estimatedFitAdjustedReturn = paths.reduce((best, p) => Math.max(best, p.estimatedMonthlyReturnPct), 0);

  return { paths, topPath, estimatedFitAdjustedReturn };
}

function extractTopConditions(
  rows: Array<{ precursorConditions?: unknown; triggerConditions?: unknown }>,
): Array<{ name: string; count: number }> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const conditions = (row.precursorConditions ?? row.triggerConditions) as Array<{ condition: string }> | null;
    if (!Array.isArray(conditions)) continue;
    for (const c of conditions) {
      if (c?.condition) counts[c.condition] = (counts[c.condition] ?? 0) + 1;
    }
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));
}

function buildEngineCoverage(
  precursorRows: Array<{ engineMatched: string | null; engineWouldFire: boolean; missedReason: string | null }>,
): Record<string, { matched: number; fired: number; missRate: number }> {
  const coverage: Record<string, { matched: number; fired: number; missRate: number }> = {};
  for (const r of precursorRows) {
    const engine = r.engineMatched ?? "none";
    if (!coverage[engine]) coverage[engine] = { matched: 0, fired: 0, missRate: 0 };
    coverage[engine].matched++;
    if (r.engineWouldFire) coverage[engine].fired++;
  }
  for (const k of Object.keys(coverage)) {
    const m = coverage[k].matched;
    coverage[k].missRate = m > 0 ? (m - coverage[k].fired) / m : 0;
  }
  return coverage;
}
