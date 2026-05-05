import { db, calibrationMoveWindowSummariesTable, calibrationPassRunsTable, detectedMovesTable, moveFamilyInferencesTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { getComprehensiveIntegrityReport } from "../dataIntegrity.js";
import { clearCalibrationArtifactsForSymbol, detectAndStoreMoves, getDetectedMoves } from "./moveDetector.js";
import {
  cancelCalibrationRunRecord,
  failCalibrationRunRecord,
  runCalibrationPassesForExistingRun,
  updateCalibrationRunMeta,
  type CalibrationCancellationCheck,
  type PassName,
  type RunPassesResult,
  type RunPassesOptions,
} from "./calibrationPassRunner.js";
import { WorkerJobCancelledError } from "../worker/jobs.js";

const TIER_ORDER: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 };
const MAX_BASE_1M_GAPS_FOR_HEALTHY = 0;
const MIN_BASE_1M_COVERAGE_PCT = 70;
const MIN_BASE_1M_CANDLES = 1_000;

type FullCalibrationResumePlan = {
  shouldResume: boolean;
  passName: PassName;
  reason: string;
  latestFailedRunId?: number;
  existingMoveCount: number;
  missingEnrichmentMoves: number;
  missingFamilyInferenceMoves: number;
};

type FullCalibrationJobParams = {
  symbol: string;
  windowDays: number;
  minMovePct: number;
  minTier?: "A" | "B" | "C" | "D";
  moveType?: string;
  maxMoves?: number;
  force?: boolean;
};

async function getLatestFailedPassRunForSymbol(symbol: string) {
  const [row] = await db
    .select()
    .from(calibrationPassRunsTable)
    .where(eq(calibrationPassRunsTable.symbol, symbol))
    .orderBy(desc(calibrationPassRunsTable.startedAt))
    .limit(1);

  return row?.status === "failed" ? row : null;
}

async function getFullCalibrationResumePlan(
  symbol: string,
  windowDays: number,
  moveType: string | undefined,
  minTier: "A" | "B" | "C" | "D" | undefined,
  maxMoves: number | undefined,
): Promise<FullCalibrationResumePlan> {
  const latestFailed = await getLatestFailedPassRunForSymbol(symbol);
  if (!latestFailed || latestFailed.windowDays !== windowDays) {
    return {
      shouldResume: false,
      passName: "all",
      reason: latestFailed ? "Latest failed run used a different research window" : "No failed run to resume",
      existingMoveCount: 0,
      missingEnrichmentMoves: 0,
      missingFamilyInferenceMoves: 0,
    };
  }

  const moves = (await getDetectedMoves(symbol, moveType, minTier)).slice(0, maxMoves ?? undefined);
  if (moves.length === 0) {
    return {
      shouldResume: false,
      passName: "all",
      reason: "No detected moves exist to resume",
      latestFailedRunId: latestFailed.id,
      existingMoveCount: 0,
      missingEnrichmentMoves: 0,
      missingFamilyInferenceMoves: 0,
    };
  }

  const moveIds = new Set(moves.map((move) => move.id));
  const [summaryRows, inferenceRows] = await Promise.all([
    db
      .select({ moveId: calibrationMoveWindowSummariesTable.moveId })
      .from(calibrationMoveWindowSummariesTable)
      .where(eq(calibrationMoveWindowSummariesTable.symbol, symbol)),
    db
      .select({ moveId: moveFamilyInferencesTable.moveId })
      .from(moveFamilyInferencesTable)
      .where(eq(moveFamilyInferencesTable.symbol, symbol)),
  ]);

  const summaryCounts = new Map<number, number>();
  for (const row of summaryRows) {
    if (!moveIds.has(row.moveId)) continue;
    summaryCounts.set(row.moveId, (summaryCounts.get(row.moveId) ?? 0) + 1);
  }

  const inferredMoveIds = new Set(
    inferenceRows
      .filter((row) => moveIds.has(row.moveId))
      .map((row) => row.moveId),
  );

  const missingEnrichmentMoves = moves.filter((move) => (summaryCounts.get(move.id) ?? 0) < 4).length;
  const missingFamilyInferenceMoves = moves.filter((move) => !inferredMoveIds.has(move.id)).length;
  const passName: PassName =
    missingEnrichmentMoves === 0 && missingFamilyInferenceMoves === 0
      ? "model_synthesis"
      : "all";

  return {
    shouldResume: true,
    passName,
    reason: passName === "model_synthesis"
      ? "Previous full calibration failed after per-move artifacts were persisted"
      : "Previous full calibration failed before all per-move artifacts were persisted",
    latestFailedRunId: latestFailed.id,
    existingMoveCount: moves.length,
    missingEnrichmentMoves,
    missingFamilyInferenceMoves,
  };
}

export async function runQueuedCalibrationPassJob(
  runId: number,
  opts: RunPassesOptions,
  cancellationCheck?: CalibrationCancellationCheck,
): Promise<RunPassesResult> {
  try {
    return await runCalibrationPassesForExistingRun(runId, opts, cancellationCheck);
  } catch (error) {
    if (error instanceof WorkerJobCancelledError || (error instanceof Error && error.message === "cancelled_by_operator")) {
      await cancelCalibrationRunRecord(runId, {
        workerCancellation: true,
        reason: error instanceof Error ? error.message : "cancelled_by_operator",
      });
      throw error;
    }
    await failCalibrationRunRecord(runId, {
      moveId: -1,
      pass: "runner",
      error: error instanceof Error ? error.message : "Calibration pass worker failed",
    });
    throw error;
  }
}

export async function runQueuedFullCalibrationJob(
  runId: number,
  params: FullCalibrationJobParams,
  cancellationCheck?: CalibrationCancellationCheck,
): Promise<RunPassesResult> {
  try {
    await cancellationCheck?.();
    const normalizedMoveType = params.moveType && params.moveType !== "all" ? params.moveType : undefined;
    const integrity = await getComprehensiveIntegrityReport(params.symbol, Math.max(365, Number(params.windowDays)));
    const integrityHealthy =
      integrity.base1mCount >= MIN_BASE_1M_CANDLES &&
      integrity.base1mGapCount <= MAX_BASE_1M_GAPS_FOR_HEALTHY &&
      integrity.base1mCoveragePct >= MIN_BASE_1M_COVERAGE_PCT;

    if (!integrityHealthy) {
      await failCalibrationRunRecord(
        runId,
        {
          moveId: -1,
          pass: "preflight",
          error: "Calibration blocked: canonical data is not ready. Run Data Operations first.",
        },
        {
          failure: {
            kind: "integrity_not_ready",
            minBase1mCandles: MIN_BASE_1M_CANDLES,
            minCoveragePct: MIN_BASE_1M_COVERAGE_PCT,
            maxAllowedGaps: MAX_BASE_1M_GAPS_FOR_HEALTHY,
            base1mCount: integrity.base1mCount,
            base1mCoveragePct: integrity.base1mCoveragePct,
            base1mGapCount: integrity.base1mGapCount,
            base1mInterpolatedCount: integrity.base1mInterpolatedCount,
          },
          integritySummary: integrity,
        },
      );
      throw new Error("Calibration blocked: canonical data is not ready. Run Data Operations first.");
    }

    const resumePlan = await getFullCalibrationResumePlan(
      params.symbol,
      Number(params.windowDays),
      normalizedMoveType,
      params.minTier,
      params.maxMoves,
    );

    const detected = resumePlan.shouldResume
      ? null
      : await detectAndStoreMoves(params.symbol, Number(params.windowDays), Number(params.minMovePct), true);
    await cancellationCheck?.();

    await updateCalibrationRunMeta(runId, {
      stage: "Deterministic Enrichment",
      preflight: {
        readyForCalibration: true,
        integrityStatus: "healthy",
      },
      integritySummary: integrity,
      detectSummary: detected,
      resumePlan,
    });

    return await runCalibrationPassesForExistingRun(runId, {
      symbol: params.symbol,
      windowDays: Number(params.windowDays),
      passName: resumePlan.shouldResume ? resumePlan.passName : "all",
      minTier: params.minTier,
      moveType: normalizedMoveType,
      maxMoves: params.maxMoves,
      force: resumePlan.shouldResume ? false : Boolean(params.force),
      continueOnMoveErrors: false,
    }, cancellationCheck);
  } catch (error) {
    if (error instanceof WorkerJobCancelledError || (error instanceof Error && error.message === "cancelled_by_operator")) {
      await cancelCalibrationRunRecord(runId, {
        workerCancellation: true,
        reason: error instanceof Error ? error.message : "cancelled_by_operator",
      }).catch(() => {
        // best effort
      });
      throw error;
    }
    await failCalibrationRunRecord(runId, {
      moveId: -1,
      pass: "runner",
      error: error instanceof Error ? error.message : "Full calibration worker failed",
    }).catch(() => {
      // best effort
    });
    throw error;
  }
}

export async function countCalibrationMoves(symbol: string): Promise<number> {
  const rows = await db
    .select({ id: detectedMovesTable.id })
    .from(detectedMovesTable)
    .where(eq(detectedMovesTable.symbol, symbol));
  return rows.length;
}

export async function clearCalibrationForSymbol(symbol: string): Promise<void> {
  await clearCalibrationArtifactsForSymbol(symbol);
}
