import { db } from "@workspace/db";
import {
  calibrationEntryIdealsTable,
  calibrationExitRiskProfilesTable,
  calibrationFeatureFramesTable,
  calibrationFeatureRelevanceTable,
  calibrationFamilyBucketProfilesTable,
  calibrationMoveWindowSummariesTable,
  calibrationPassRunsTable,
  detectedMovesTable,
  moveFamilyInferencesTable,
  strategyCalibrationProfilesTable,
  type DetectedMoveRow,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { CALIBRATION_MODEL } from "../ai/aiConfig.js";
import { runEnrichmentPass } from "./passes/enrichmentPass.js";
import { runFamilyInferencePass } from "./passes/familyInferencePass.js";
import { runModelSynthesisPass } from "./passes/modelSynthesisPass.js";
import {
  clearCalibrationAiTelemetry,
  getCalibrationAiTelemetry,
} from "./aiTelemetry.js";

export type PassName = "enrichment" | "family_inference" | "model_synthesis" | "all";

export interface RunPassesOptions {
  symbol: string;
  windowDays?: number;
  passName?: PassName;
  minTier?: "A" | "B" | "C" | "D";
  moveType?: string;
  maxMoves?: number;
  force?: boolean;
  continueOnMoveErrors?: boolean;
}

export interface RunPassesResult {
  runId: number;
  symbol: string;
  passName: PassName;
  status: "completed" | "partial" | "failed" | "cancelled";
  totalMoves: number;
  processedMoves: number;
  failedMoves: number;
  errors: Array<{ moveId: number; pass: string; error: string }>;
  durationMs: number;
}

export type CalibrationCancellationCheck = () => Promise<void>;

const TIER_ORDER: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 };
const STALE_RUNNING_MS = 6 * 60 * 60 * 1000;

function filterByMinTier(
  moves: DetectedMoveRow[],
  minTier?: "A" | "B" | "C" | "D",
): DetectedMoveRow[] {
  if (!minTier) return moves;
  const threshold = TIER_ORDER[minTier] ?? 3;
  return moves.filter((move) => TIER_ORDER[move.qualityTier] <= threshold);
}

async function hasEnrichment(moveId: number): Promise<boolean> {
  const [frame, summary] = await Promise.all([
    db.select({ id: calibrationFeatureFramesTable.id }).from(calibrationFeatureFramesTable).where(eq(calibrationFeatureFramesTable.moveId, moveId)).limit(1),
    db.select({ id: calibrationMoveWindowSummariesTable.id }).from(calibrationMoveWindowSummariesTable).where(eq(calibrationMoveWindowSummariesTable.moveId, moveId)).limit(1),
  ]);
  return frame.length > 0 && summary.length > 0;
}

async function hasFamilyInference(moveId: number): Promise<boolean> {
  const rows = await db.select({ id: moveFamilyInferencesTable.id }).from(moveFamilyInferencesTable).where(eq(moveFamilyInferencesTable.moveId, moveId)).limit(1);
  return rows.length > 0;
}

async function hasModelSynthesis(symbol: string, runId: number): Promise<boolean> {
  const [profiles, featureRows, entryRows, exitRows] = await Promise.all([
    db.select({ id: strategyCalibrationProfilesTable.id }).from(strategyCalibrationProfilesTable)
      .where(and(eq(strategyCalibrationProfilesTable.symbol, symbol), eq(strategyCalibrationProfilesTable.lastRunId, runId))).limit(1),
    db.select({ id: calibrationFeatureRelevanceTable.id }).from(calibrationFeatureRelevanceTable).where(eq(calibrationFeatureRelevanceTable.symbol, symbol)).limit(1),
    db.select({ id: calibrationEntryIdealsTable.id }).from(calibrationEntryIdealsTable).where(eq(calibrationEntryIdealsTable.symbol, symbol)).limit(1),
    db.select({ id: calibrationExitRiskProfilesTable.id }).from(calibrationExitRiskProfilesTable).where(eq(calibrationExitRiskProfilesTable.symbol, symbol)).limit(1),
  ]);
  return profiles.length > 0 && featureRows.length > 0 && entryRows.length > 0 && exitRows.length > 0;
}

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
      metaJson: {
        model: CALIBRATION_MODEL,
        startedAt: new Date().toISOString(),
        stage: passName === "model_synthesis" ? "Bucket Model Synthesis" : "AI Passes",
      },
    })
    .returning({ id: calibrationPassRunsTable.id });
  return row.id;
}

export async function createQueuedCalibrationRunRecord(params: {
  symbol: string;
  windowDays: number;
  passName: PassName;
  stage?: string;
  metaPatch?: Record<string, unknown>;
}): Promise<number> {
  const [row] = await db
    .insert(calibrationPassRunsTable)
    .values({
      symbol: params.symbol,
      windowDays: params.windowDays,
      status: "running",
      passName: params.passName,
      totalMoves: 0,
      processedMoves: 0,
      failedMoves: 0,
      metaJson: {
        model: CALIBRATION_MODEL,
        startedAt: new Date().toISOString(),
        stage: params.stage ?? "Queued",
        executionModel: "worker_service",
        ...(params.metaPatch ?? {}),
      },
    })
    .returning({ id: calibrationPassRunsTable.id });
  return row.id;
}

async function updateRunRecord(
  runId: number,
  processedMoves: number,
  failedMoves: number,
  status: "running" | "completed" | "partial" | "failed" | "cancelled",
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

export async function failCalibrationRunRecord(
  runId: number,
  error: { moveId: number; pass: string; error: string },
  metaPatch?: Record<string, unknown>,
): Promise<void> {
  const [row] = await db
    .select({ meta: calibrationPassRunsTable.metaJson })
    .from(calibrationPassRunsTable)
    .where(eq(calibrationPassRunsTable.id, runId))
    .limit(1);
  await db
    .update(calibrationPassRunsTable)
    .set({
      status: "failed",
      completedAt: new Date(),
      failedMoves: 1,
      errorSummary: [error] as never,
      metaJson: {
        ...(row?.meta && typeof row.meta === "object" ? row.meta as Record<string, unknown> : {}),
        stage: "Failed",
        ...(metaPatch ?? {}),
      } as never,
    })
    .where(eq(calibrationPassRunsTable.id, runId));
}

export async function cancelCalibrationRunRecord(
  runId: number,
  metaPatch?: Record<string, unknown>,
): Promise<void> {
  const [row] = await db
    .select({ meta: calibrationPassRunsTable.metaJson })
    .from(calibrationPassRunsTable)
    .where(eq(calibrationPassRunsTable.id, runId))
    .limit(1);
  await db
    .update(calibrationPassRunsTable)
    .set({
      status: "cancelled" as never,
      completedAt: new Date(),
      metaJson: {
        ...(row?.meta && typeof row.meta === "object" ? row.meta as Record<string, unknown> : {}),
        stage: "Cancelled",
        failure: {
          kind: "cancelled_by_operator",
          message: "Calibration cancelled by operator",
        },
        ...(metaPatch ?? {}),
      } as never,
      errorSummary: [{
        moveId: -1,
        pass: "runner",
        error: "Calibration cancelled by operator",
      }] as never,
    })
    .where(eq(calibrationPassRunsTable.id, runId));
}

function isStaleRunningRun(row: typeof calibrationPassRunsTable.$inferSelect): boolean {
  if (row.status !== "running") return false;
  const startedMs = row.startedAt ? new Date(row.startedAt).getTime() : 0;
  return startedMs > 0 && Date.now() - startedMs > STALE_RUNNING_MS;
}

async function failStaleRunningRun(row: typeof calibrationPassRunsTable.$inferSelect): Promise<void> {
  const staleError = {
    moveId: -1,
    pass: "runner",
    error: "Run auto-failed because it was stale in running state for more than 6 hours",
  };
  await db
    .update(calibrationPassRunsTable)
    .set({
      status: "failed",
      completedAt: new Date(),
      failedMoves: Math.max(1, row.failedMoves ?? 0),
      errorSummary: [staleError] as never,
      metaJson: {
        ...(row.metaJson && typeof row.metaJson === "object" ? row.metaJson as Record<string, unknown> : {}),
        stage: "Failed",
        failure: {
          kind: "stale_running_timeout",
          message: "Run was auto-failed after remaining in running state > 6 hours",
        },
      } as never,
    })
    .where(eq(calibrationPassRunsTable.id, row.id));
}

async function mergeRunMeta(runId: number, patch: Record<string, unknown>): Promise<void> {
  const [row] = await db
    .select({ meta: calibrationPassRunsTable.metaJson })
    .from(calibrationPassRunsTable)
    .where(eq(calibrationPassRunsTable.id, runId))
    .limit(1);
  const prev = (row?.meta && typeof row.meta === "object" ? row.meta : {}) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...prev, ...patch };
  if (prev.progress && patch.progress && typeof patch.progress === "object") {
    next.progress = { ...(prev.progress as object), ...(patch.progress as object) };
  }
  await db
    .update(calibrationPassRunsTable)
    .set({ metaJson: next as never })
    .where(eq(calibrationPassRunsTable.id, runId));
}

export async function updateCalibrationRunMeta(runId: number, patch: Record<string, unknown>): Promise<void> {
  await mergeRunMeta(runId, patch);
}

async function loadFilteredMoves(opts: RunPassesOptions): Promise<DetectedMoveRow[]> {
  const { symbol, minTier, moveType, maxMoves } = opts;
  const conditions: ReturnType<typeof eq>[] = [eq(detectedMovesTable.symbol, symbol)];
  if (moveType && moveType !== "all") conditions.push(eq(detectedMovesTable.moveType, moveType));

  const allMoves = await db
    .select()
    .from(detectedMovesTable)
    .where(conditions.length === 1 ? conditions[0] : and(...conditions))
    .orderBy(detectedMovesTable.startTs);

  return filterByMinTier(allMoves, minTier).slice(0, maxMoves ?? allMoves.length);
}

async function runPerMovePass(
  move: DetectedMoveRow,
  passName: Exclude<PassName, "all" | "model_synthesis">,
  runId: number,
): Promise<void> {
  if (passName === "enrichment") {
    await runEnrichmentPass(move, runId);
    return;
  }
  await runFamilyInferencePass(move, runId);
}

async function executeCalibrationRun(
  runId: number,
  filteredMoves: DetectedMoveRow[],
  opts: RunPassesOptions,
  cancellationCheck?: CalibrationCancellationCheck,
): Promise<RunPassesResult> {
  const startMs = Date.now();
  const { symbol, passName = "all", force = false, continueOnMoveErrors = false } = opts;

  clearCalibrationAiTelemetry(runId);

  const errors: Array<{ moveId: number; pass: string; error: string }> = [];
  let processedMoves = 0;
  const phaseDurationsMs: Record<string, number> = {};
  const perMovePasses: Array<Exclude<PassName, "all" | "model_synthesis">> =
    passName === "all" ? ["enrichment", "family_inference"] : passName === "model_synthesis" ? [] : [passName];
  const totalMoves = filteredMoves.length;

  for (let index = 0; index < filteredMoves.length; index++) {
    if (cancellationCheck && (index === 0 || index % 3 === 0)) {
      await cancellationCheck();
    }
    const move = filteredMoves[index]!;
    let moveFailed = false;
    for (const pass of perMovePasses) {
      if (cancellationCheck) {
        await cancellationCheck();
      }
      if (!force) {
        const done = pass === "enrichment"
          ? await hasEnrichment(move.id)
          : (await hasFamilyInference(move.id)) && (await hasEnrichment(move.id));
        if (done) continue;
      }

      await mergeRunMeta(runId, {
        stage: pass === "enrichment" ? "Deterministic Enrichment" : "Family Inference",
        progress: {
          phase: "per_move",
          currentPass: pass,
          moveIndex: index + 1,
          totalMoves,
          moveId: move.id,
          label: `${index + 1}/${totalMoves} - ${pass}`,
        },
      });
      const passStart = Date.now();
      try {
        await runPerMovePass(move, pass, runId);
        phaseDurationsMs[pass] = (phaseDurationsMs[pass] ?? 0) + (Date.now() - passStart);
      } catch (err) {
        moveFailed = true;
        const message = err instanceof Error ? err.message : "Unknown error";
        errors.push({ moveId: move.id, pass, error: message });
        if (!continueOnMoveErrors) {
          const aiTelemetry = getCalibrationAiTelemetry(runId);
          phaseDurationsMs.total = Date.now() - startMs;
          await mergeRunMeta(runId, {
            stage: pass === "enrichment" ? "Deterministic Enrichment" : "Family Inference",
            phaseDurationsMs,
            usage: aiTelemetry,
            progress: {
              phase: "aborted",
              currentPass: pass,
              moveIndex: index + 1,
              totalMoves,
              moveId: move.id,
              label: `Aborted on first error: ${pass} @ move ${index + 1}/${totalMoves}`,
            },
            failure: {
              kind: "abort_on_first_pass_error",
              symbol,
              moveOrdinal: index + 1,
              totalMoves,
              moveId: move.id,
              pass,
              error: message,
            },
          });
          await updateRunRecord(runId, processedMoves, errors.length, "failed", errors);
          clearCalibrationAiTelemetry(runId);
          return {
            runId,
            symbol,
            passName,
            status: "failed",
            totalMoves,
            processedMoves,
            failedMoves: errors.length,
            errors,
            durationMs: Date.now() - startMs,
          };
        }
      }
    }
    if (!moveFailed && perMovePasses.length > 0) processedMoves++;
    if ((index + 1) % 5 === 0 || index + 1 === totalMoves) {
      await updateRunRecord(runId, processedMoves, errors.length, "running", errors);
    }
  }

  if (passName === "all" || passName === "model_synthesis") {
    if (cancellationCheck) {
      await cancellationCheck();
    }
    const synthesisStart = Date.now();
    await mergeRunMeta(runId, {
      stage: "Bucket Model Synthesis",
      progress: {
        phase: "model_synthesis",
        currentPass: "model_synthesis",
        moveIndex: totalMoves,
        totalMoves,
        label: "Running deterministic family bucket aggregation and AI bucket synthesis...",
      },
    });
    try {
      await runModelSynthesisPass(symbol, filteredMoves, runId, opts.windowDays ?? 90);
      phaseDurationsMs.model_synthesis = Date.now() - synthesisStart;
      if (!(await hasModelSynthesis(symbol, runId))) {
        throw new Error("Model synthesis completed but calibration profiles were not persisted");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Model synthesis failed";
      errors.push({ moveId: -1, pass: "model_synthesis", error: message });
      if (!continueOnMoveErrors) {
        const aiTelemetry = getCalibrationAiTelemetry(runId);
        phaseDurationsMs.total = Date.now() - startMs;
        await mergeRunMeta(runId, {
          stage: "Bucket Model Synthesis",
          phaseDurationsMs,
          usage: aiTelemetry,
          progress: {
            phase: "aborted",
            currentPass: "model_synthesis",
            label: "Aborted: model synthesis failed",
          },
          failure: {
            kind: "model_synthesis_failed",
            symbol,
            error: message,
          },
        });
        await updateRunRecord(runId, processedMoves, errors.length, "failed", errors);
        clearCalibrationAiTelemetry(runId);
        return {
          runId,
          symbol,
          passName,
          status: "failed",
          totalMoves,
          processedMoves,
          failedMoves: errors.length,
          errors,
          durationMs: Date.now() - startMs,
        };
      }
    }
  }

  const status: "completed" | "partial" | "failed" =
    errors.length === 0 ? "completed" :
    processedMoves > 0 ? "partial" : "failed";

  const aiTelemetry = getCalibrationAiTelemetry(runId);
  phaseDurationsMs.total = Date.now() - startMs;
  await mergeRunMeta(runId, {
    stage: status === "completed" ? "Research Profile Complete" : "AI Passes",
    phaseDurationsMs,
    usage: aiTelemetry,
    progress: { phase: "done", label: status === "completed" ? "Completed" : `Finished (${status})` },
  });
  await updateRunRecord(runId, processedMoves, errors.length, status, errors);
  clearCalibrationAiTelemetry(runId);

  return {
    runId,
    symbol,
    passName,
    status,
    totalMoves,
    processedMoves,
    failedMoves: errors.length,
    errors,
    durationMs: Date.now() - startMs,
  };
}

export async function runCalibrationPassesForExistingRun(
  runId: number,
  opts: RunPassesOptions,
  cancellationCheck?: CalibrationCancellationCheck,
): Promise<RunPassesResult> {
  const filteredMoves = await loadFilteredMoves(opts);
  const totalMoves = filteredMoves.length;
  await db
    .update(calibrationPassRunsTable)
    .set({
      totalMoves,
      processedMoves: 0,
      failedMoves: 0,
      errorSummary: null,
      metaJson: {
        model: CALIBRATION_MODEL,
        startedAt: new Date().toISOString(),
        stage: opts.passName === "model_synthesis" ? "Bucket Model Synthesis" : "AI Passes",
        executionModel: "worker_service",
      } as never,
    })
    .where(eq(calibrationPassRunsTable.id, runId));
  return executeCalibrationRun(runId, filteredMoves, opts, cancellationCheck);
}

export async function startCalibrationPassesBackground(opts: RunPassesOptions): Promise<{ runId: number; totalMoves: number }> {
  const { symbol, windowDays = 90, passName = "all" } = opts;
  const filteredMoves = await loadFilteredMoves(opts);
  const totalMoves = filteredMoves.length;
  const runId = await createRunRecord(symbol, windowDays, passName, totalMoves);

  void executeCalibrationRun(runId, filteredMoves, opts)
    .then((result) => {
      console.log(`[calibration] run ${runId} finished: ${result.status} in ${result.durationMs}ms`);
    })
    .catch((err) => {
      console.error(`[calibration] run ${runId} crashed:`, err);
      clearCalibrationAiTelemetry(runId);
      void updateRunRecord(
        runId,
        0,
        1,
        "failed",
        [{ moveId: -1, pass: "runner", error: err instanceof Error ? err.message : String(err) }],
      );
    });

  return { runId, totalMoves };
}

export async function runCalibrationPasses(opts: RunPassesOptions): Promise<RunPassesResult> {
  const { symbol, windowDays = 90, passName = "all" } = opts;
  const filteredMoves = await loadFilteredMoves(opts);
  const totalMoves = filteredMoves.length;
  const runId = await createRunRecord(symbol, windowDays, passName, totalMoves);
  return executeCalibrationRun(runId, filteredMoves, opts);
}

export async function getPassRunStatus(runId: number): Promise<typeof calibrationPassRunsTable.$inferSelect | null> {
  let [row] = await db.select().from(calibrationPassRunsTable).where(eq(calibrationPassRunsTable.id, runId));
  if (row && isStaleRunningRun(row)) {
    await failStaleRunningRun(row);
    [row] = await db.select().from(calibrationPassRunsTable).where(eq(calibrationPassRunsTable.id, runId));
  }
  return row ?? null;
}

export async function getRunningPassRunForSymbol(symbol: string): Promise<typeof calibrationPassRunsTable.$inferSelect | null> {
  const rows = await db
    .select()
    .from(calibrationPassRunsTable)
    .where(and(eq(calibrationPassRunsTable.symbol, symbol), eq(calibrationPassRunsTable.status, "running")))
    .orderBy(desc(calibrationPassRunsTable.startedAt))
    .limit(1);
  const row = rows[0] ?? null;
  if (!row) return null;
  if (isStaleRunningRun(row)) {
    await failStaleRunningRun(row);
    return null;
  }
  return row;
}

export async function getLatestPassRun(symbol: string): Promise<typeof calibrationPassRunsTable.$inferSelect | null> {
  const rows = await db
    .select()
    .from(calibrationPassRunsTable)
    .where(eq(calibrationPassRunsTable.symbol, symbol))
    .orderBy(desc(calibrationPassRunsTable.startedAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function getAllPassRuns(symbol: string): Promise<typeof calibrationPassRunsTable.$inferSelect[]> {
  const rows = await db
    .select()
    .from(calibrationPassRunsTable)
    .where(eq(calibrationPassRunsTable.symbol, symbol))
    .orderBy(desc(calibrationPassRunsTable.startedAt));
  const staleRows = rows.filter(isStaleRunningRun);
  if (staleRows.length > 0) {
    for (const row of staleRows) await failStaleRunningRun(row);
    return db
      .select()
      .from(calibrationPassRunsTable)
      .where(eq(calibrationPassRunsTable.symbol, symbol))
      .orderBy(desc(calibrationPassRunsTable.startedAt));
  }
  return rows;
}
