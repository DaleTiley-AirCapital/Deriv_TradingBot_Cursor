/**
 * calibrationPassRunner.ts — Async AI Pass Pipeline Runner
 *
 * Runs 4 structured AI passes against detected moves for a symbol:
 *   Pass 1 (precursor)  — what conditions existed BEFORE the move?
 *   Pass 2 (trigger)    — what was the earliest valid entry?
 *   Pass 3 (behavior)   — how did the move progress bar-by-bar?
 *   Pass 4 (extraction) — what are the structural rules distilled across all moves?
 *
 * Each move is processed independently. Failures on individual moves are
 * recorded in calibration_pass_runs.error_summary and do not abort the run.
 *
 * Honest fit reporting: targetMoves vs capturedMoves vs missedMoves is always
 * truthful. Fit score is capturedMoves/targetMoves — never inflated.
 */

import { db } from "@workspace/db";
import {
  calibrationPassRunsTable,
  detectedMovesTable,
  type DetectedMoveRow,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { runPrecursorPass } from "./passes/precursorPass.js";
import { runTriggerPass } from "./passes/triggerPass.js";
import { runBehaviorPass } from "./passes/behaviorPass.js";
import { runExtractionPass } from "./passes/extractionPass.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export type PassName = "precursor" | "trigger" | "behavior" | "extraction" | "all";

export interface RunPassesOptions {
  symbol: string;
  windowDays?: number;
  passName?: PassName;
  minTier?: "A" | "B" | "C" | "D";
  moveType?: string;
  maxMoves?: number;
}

export interface RunPassesResult {
  runId: number;
  symbol: string;
  passName: PassName;
  status: "completed" | "partial" | "failed";
  totalMoves: number;
  processedMoves: number;
  failedMoves: number;
  errors: Array<{ moveId: number; pass: string; error: string }>;
  durationMs: number;
}

// ── Tier ordering ──────────────────────────────────────────────────────────────

const TIER_ORDER: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 };

function filterByMinTier(
  moves: DetectedMoveRow[],
  minTier?: "A" | "B" | "C" | "D",
): DetectedMoveRow[] {
  if (!minTier) return moves;
  const threshold = TIER_ORDER[minTier] ?? 3;
  return moves.filter(m => TIER_ORDER[m.qualityTier] <= threshold);
}

// ── Pass router ────────────────────────────────────────────────────────────────

async function runPassForMove(
  move: DetectedMoveRow,
  passName: Exclude<PassName, "all">,
  runId: number,
): Promise<void> {
  switch (passName) {
    case "precursor":  await runPrecursorPass(move, runId);  break;
    case "trigger":    await runTriggerPass(move, runId);    break;
    case "behavior":   await runBehaviorPass(move, runId);   break;
    case "extraction": /* extraction is per-symbol, not per-move */ break;
  }
}

// ── Create pass run record ─────────────────────────────────────────────────────

async function createRunRecord(
  symbol: string,
  windowDays: number,
  passName: PassName,
  totalMoves: number,
): Promise<number> {
  const [row] = await db
    .insert(calibrationPassRunsTable)
    .values({
      symbol,
      windowDays,
      status: "running",
      passName,
      totalMoves,
      processedMoves: 0,
      failedMoves: 0,
      metaJson: { model: "gpt-4o", startedAt: new Date().toISOString() },
    })
    .returning({ id: calibrationPassRunsTable.id });
  return row.id;
}

// ── Update run record ──────────────────────────────────────────────────────────

async function updateRunRecord(
  runId: number,
  processedMoves: number,
  failedMoves: number,
  status: "running" | "completed" | "partial" | "failed",
  errors: Array<{ moveId: number; pass: string; error: string }>,
): Promise<void> {
  await db
    .update(calibrationPassRunsTable)
    .set({
      processedMoves,
      failedMoves,
      status,
      completedAt: ["completed", "partial", "failed"].includes(status) ? new Date() : undefined,
      errorSummary: errors.length > 0 ? errors : undefined,
    })
    .where(eq(calibrationPassRunsTable.id, runId));
}

// ── Core runner ────────────────────────────────────────────────────────────────

export async function runCalibrationPasses(
  opts: RunPassesOptions,
): Promise<RunPassesResult> {
  const startMs = Date.now();
  const {
    symbol,
    windowDays = 90,
    passName = "all",
    minTier,
    moveType,
    maxMoves,
  } = opts;

  const conditions: ReturnType<typeof eq>[] = [eq(detectedMovesTable.symbol, symbol)];
  if (moveType) conditions.push(eq(detectedMovesTable.moveType, moveType));

  const allMoves = await db
    .select()
    .from(detectedMovesTable)
    .where(conditions.length === 1 ? conditions[0] : and(...conditions))
    .orderBy(detectedMovesTable.startTs);

  const filteredMoves = filterByMinTier(allMoves, minTier).slice(0, maxMoves ?? allMoves.length);
  const totalMoves = filteredMoves.length;

  const runId = await createRunRecord(symbol, windowDays, passName, totalMoves);

  const errors: Array<{ moveId: number; pass: string; error: string }> = [];
  let processedMoves = 0;

  const perMovePasses: Exclude<PassName, "all">[] =
    passName === "all"
      ? ["precursor", "trigger", "behavior"]
      : passName !== "extraction" ? [passName] : [];

  for (const move of filteredMoves) {
    let moveFailed = false;
    for (const pass of perMovePasses) {
      try {
        await runPassForMove(move, pass, runId);
      } catch (err) {
        moveFailed = true;
        errors.push({
          moveId: move.id,
          pass,
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }
    if (!moveFailed) processedMoves++;

    // Checkpoint progress every 10 moves
    if ((processedMoves + errors.length) % 10 === 0) {
      await updateRunRecord(runId, processedMoves, errors.length, "running", errors);
    }
  }

  // Pass 4 (extraction) runs once across all moves — after per-move passes complete
  if (passName === "all" || passName === "extraction") {
    try {
      await runExtractionPass(symbol, filteredMoves, runId);
    } catch (err) {
      errors.push({
        moveId: -1,
        pass: "extraction",
        error: err instanceof Error ? err.message : "Extraction pass failed",
      });
    }
  }

  const failedMoves = filteredMoves.length - processedMoves;
  const status: "completed" | "partial" | "failed" =
    failedMoves === 0 ? "completed" :
    processedMoves > 0 ? "partial" : "failed";

  await updateRunRecord(runId, processedMoves, failedMoves, status, errors);

  return {
    runId,
    symbol,
    passName,
    status,
    totalMoves,
    processedMoves,
    failedMoves,
    errors,
    durationMs: Date.now() - startMs,
  };
}

// ── Get run status ─────────────────────────────────────────────────────────────

export async function getPassRunStatus(
  runId: number,
): Promise<typeof calibrationPassRunsTable.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(calibrationPassRunsTable)
    .where(eq(calibrationPassRunsTable.id, runId));
  return row ?? null;
}

export async function getLatestPassRun(
  symbol: string,
): Promise<typeof calibrationPassRunsTable.$inferSelect | null> {
  const rows = await db
    .select()
    .from(calibrationPassRunsTable)
    .where(eq(calibrationPassRunsTable.symbol, symbol))
    .orderBy(calibrationPassRunsTable.startedAt)
    .limit(1);
  return rows[0] ?? null;
}
