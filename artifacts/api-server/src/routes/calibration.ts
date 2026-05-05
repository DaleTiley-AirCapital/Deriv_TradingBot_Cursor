/**
 * Calibration API Routes — Move-First Calibration System
 *
 * POST /api/calibration/detect-moves/:symbol          — run structural move detection, store to DB
 * GET  /api/calibration/moves/:symbol                 — list detected moves (with filters)
 * POST /api/calibration/run-passes/:symbol            — start async AI pass pipeline (optional body: continueOnMoveErrors)
 * GET  /api/calibration/run-status/:runId             — poll run progress
 * GET  /api/calibration/aggregate/:symbol             — deterministic aggregate from pass results
 * GET  /api/calibration/profile/:symbol/:moveType     — stored calibration profile for symbol+type
 * GET  /api/calibration/profiles/:symbol              — all profiles for a symbol
 * GET  /api/calibration/engine/:symbol                — engine coverage calibration (read-only)
 * GET  /api/calibration/scoring/:symbol               — scoring calibration by tier (read-only)
 * GET  /api/calibration/health/:symbol                — trade health calibration (read-only)
 * GET  /api/calibration/export/:symbol                — full calibration export (JSON download)
 * POST /api/calibration/reset/:symbol               — delete all calibration data + runs + moves for symbol
 *
 * ALL outputs are read-only feeddown — nothing here modifies live engine or allocator behavior.
 */

import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  calibrationFamilyBucketProfilesTable,
  calibrationFeatureFramesTable,
  calibrationMoveWindowSummariesTable,
  calibrationEntryIdealsTable,
  calibrationExitRiskProfilesTable,
  calibrationFeatureRelevanceTable,
  movePrecursorPassesTable,
  moveBehaviorPassesTable,
  calibrationPassRunsTable,
  detectedMovesTable,
  moveFamilyInferencesTable,
  moveProgressionArtifactsTable,
  platformStateTable,
  strategyCalibrationProfilesTable,
  candlesTable,
} from "@workspace/db";
import { count, desc, eq, and, gte, lte, asc } from "drizzle-orm";
import { detectAndStoreMoves, getDetectedMoves, clearCalibrationArtifactsForSymbol } from "../core/calibration/moveDetector.js";
import {
  createQueuedCalibrationRunRecord,
  getPassRunStatus,
  getLatestPassRun,
  getAllPassRuns,
  getRunningPassRunForSymbol,
  type PassName,
} from "../core/calibration/calibrationPassRunner.js";
import { createWorkerJob } from "../core/worker/jobs.js";
import {
  buildCalibrationAggregate,
  getCalibrationProfile,
  getAllCalibrationProfiles,
} from "../core/calibration/calibrationAggregator.js";
import {
  getEngineCalibration,
  getScoringCalibration,
  getTradeHealthCalibration,
  getFullCalibrationExport,
} from "../core/calibration/feeddown.js";
import { deriveSymbolBehaviorProfile } from "../core/backtest/behaviorProfiler.js";
import { getComprehensiveIntegrityReport } from "../core/dataIntegrity.js";
import {
  assertCalibrationSymbol,
  type SymbolDomain,
} from "../core/calibration/symbolDomain.js";
import {
  getLatestSymbolResearchProfile,
  upsertSymbolResearchProfile,
} from "../core/calibration/symbolResearchProfile.js";
import {
  promoteStagedSymbolRuntimeModel,
  getPromotedSymbolRuntimeModel,
  getStagedSymbolRuntimeModel,
  stageLatestSymbolResearchProfile,
} from "../core/calibration/promotedSymbolModel.js";
import {
  cancelBacktestOptimisationRun,
  getBacktestOptimisationStatus,
  stageBacktestOptimisationWinner,
  startBacktestOptimisation,
} from "../core/calibration/backtestOptimiser.js";
import { getSymbolService } from "../symbol-services/shared/SymbolServiceRegistry.js";
import { loadCrash300RuntimeEnvelope } from "../symbol-services/CRASH300/model.js";
import { runCrash300CalibrationParity } from "../symbol-services/CRASH300/calibration.js";
import { buildCrash300PreMoveSnapshots, summarizeCrash300PreMoveSnapshots } from "../symbol-services/CRASH300/featureSnapshots.js";
import { buildCrash300PhaseIdentifierReport } from "../symbol-services/CRASH300/phaseIdentifiers.js";
import { buildCalibrationParityReport, buildRuntimeTriggerValidationReport } from "../core/calibration/runtimeDiagnostics.js";

const router: IRouter = Router();

const VALID_PASS_NAMES: PassName[] = ["enrichment", "family_inference", "model_synthesis", "all"];
const VALID_TIERS = ["A", "B", "C", "D"];
const VALID_MOVE_TYPES = ["breakout", "continuation", "reversal", "unknown", "boom_expansion", "crash_expansion", "all"];

function asRouteRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function runtimeModelDiagnostics(model: { tpModel?: Record<string, unknown>; promotedAt?: string } | null) {
  if (!model) {
    return {
      tpBucketCount: 0,
      dynamicTpEnabled: false,
      promotedAt: null,
    };
  }
  const tpModel = asRouteRecord(model.tpModel);
  const buckets = asRouteRecord(tpModel.buckets);
  return {
    tpBucketCount: Object.keys(buckets).length,
    dynamicTpEnabled: tpModel.dynamicByQualityLeadIn === true && Object.keys(buckets).length > 0,
    promotedAt: model.promotedAt ?? null,
  };
}

function normaliseRuntimeModelForCompare(model: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!model) return null;
  const copy = { ...model };
  delete copy.promotedAt;
  return copy;
}

async function refreshResearchProfileFromLatestCalibration(symbol: string): Promise<void> {
  const latestAllProfile = await getCalibrationProfile(symbol, "all");
  if (latestAllProfile?.lastRunId) {
    await upsertSymbolResearchProfile(symbol, latestAllProfile.lastRunId);
  }
}
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

function withSymbolDomain<T extends object>(
  symbol: string,
  symbolDomain: SymbolDomain,
  payload: T,
): T & { symbol: string; symbolDomain: SymbolDomain } {
  return {
    symbol,
    symbolDomain,
    ...payload,
  };
}

async function getLatestFailedPassRunForSymbol(symbol: string): Promise<typeof calibrationPassRunsTable.$inferSelect | null> {
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

// ── POST /api/calibration/detect-moves/:symbol ────────────────────────────────

router.post("/calibration/detect-moves/:symbol", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const checked = assertCalibrationSymbol(symbol);
  if (!checked.ok) {
    res.status(400).json({ error: checked.error });
    return;
  }
  const { symbolDomain } = checked;

  const {
    windowDays = 90,
    minMovePct = 0.05,
    clearExisting = true,
  } = req.body ?? {};

  if (windowDays < 7 || windowDays > 730) {
    res.status(400).json({ error: "windowDays must be between 7 and 730" });
    return;
  }
  if (minMovePct < 0.01 || minMovePct > 0.5) {
    res.status(400).json({ error: "minMovePct must be between 0.01 (1%) and 0.5 (50%)" });
    return;
  }

  try {
    const result = await detectAndStoreMoves(symbol, windowDays, minMovePct, clearExisting);
    res.json(withSymbolDomain(symbol, symbolDomain, { ok: true, ...result }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Move detection failed";
    console.error(`[calibration/detect-moves/${symbol}] error:`, message);
    res.status(500).json({ error: message });
  }
});

// ── POST /api/calibration/reset/:symbol ───────────────────────────────────────
// Removes calibration-only artifacts, pass runs, and detected moves.

router.post("/calibration/reset/:symbol", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const checked = assertCalibrationSymbol(symbol);
  if (!checked.ok) {
    res.status(400).json({ error: checked.error });
    return;
  }
  const { symbolDomain } = checked;

  try {
    await clearCalibrationArtifactsForSymbol(symbol);
    res.json(withSymbolDomain(symbol, symbolDomain, {
      ok: true,
      cleared: ["profiles", "pass_runs", "detected_moves", "feature_frames", "move_window_summaries", "family_inferences", "family_bucket_profiles", "progression_artifacts", "feature_relevance", "entry_ideals", "exit_risk_profiles"],
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Calibration reset failed";
    console.error(`[calibration/reset/${symbol}] error:`, message);
    res.status(500).json({ error: message });
  }
});

// ── GET /api/calibration/preflight/:symbol ────────────────────────────────────
// Lightweight readiness report before running full calibration.
router.get("/calibration/preflight/:symbol", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const checked = assertCalibrationSymbol(symbol);
  if (!checked.ok) {
    res.status(400).json({ error: checked.error });
    return;
  }
  const { symbolDomain } = checked;

  const lookbackDays = Math.max(30, Number(req.query.lookbackDays ?? 365));
  try {
    const integrity = await getComprehensiveIntegrityReport(symbol, lookbackDays);
    const readyForCalibration =
      integrity.base1mCount >= MIN_BASE_1M_CANDLES &&
      integrity.base1mGapCount <= MAX_BASE_1M_GAPS_FOR_HEALTHY &&
      integrity.base1mCoveragePct >= MIN_BASE_1M_COVERAGE_PCT;

    const needsReconcile =
      integrity.base1mGapCount > MAX_BASE_1M_GAPS_FOR_HEALTHY ||
      integrity.base1mInterpolatedCount > 0 ||
      integrity.base1mCoveragePct < MIN_BASE_1M_COVERAGE_PCT;

    const recommendedAction = readyForCalibration
      ? "ready"
      : integrity.base1mCount < MIN_BASE_1M_CANDLES
        ? "run_data_top_up"
        : needsReconcile
          ? "run_reconcile"
          : "inspect_integrity";

    res.json(withSymbolDomain(symbol, symbolDomain, {
      latestCandleTime: integrity.base1mLastDate,
      latestCandleTs: integrity.base1mLastDate
        ? Math.floor(new Date(integrity.base1mLastDate).getTime() / 1000)
        : null,
      total1mCandlesInWindow: integrity.base1mCount,
      base1mCount: integrity.base1mCount,
      gapCount: integrity.base1mGapCount,
      base1mGapCount: integrity.base1mGapCount,
      interpolatedCount: integrity.base1mInterpolatedCount,
      base1mInterpolatedCount: integrity.base1mInterpolatedCount,
      dataCoveragePct: integrity.base1mCoveragePct,
      base1mCoveragePct: integrity.base1mCoveragePct,
      integrityStatus: readyForCalibration ? "healthy" : "reconcile_required",
      readyForCalibration,
      recommendedAction,
      integritySummary: integrity,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Calibration preflight failed";
    res.status(500).json({ error: message });
  }
});

// ── POST /api/calibration/full/:symbol ────────────────────────────────────────
// Canonical operator workflow: reconcile -> integrity verify -> detect -> passes.
router.post("/calibration/full/:symbol", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const checked = assertCalibrationSymbol(symbol);
  if (!checked.ok) {
    res.status(400).json({ error: checked.error });
    return;
  }
  const { symbolDomain } = checked;

  const {
    windowDays = 90,
    minMovePct = 0.05,
    minTier,
    moveType,
    maxMoves,
    force = false,
  } = req.body ?? {};

  if (windowDays < 7 || windowDays > 730) {
    res.status(400).json({ error: "windowDays must be between 7 and 730" });
    return;
  }
  if (minMovePct < 0.01 || minMovePct > 0.5) {
    res.status(400).json({ error: "minMovePct must be between 0.01 (1%) and 0.5 (50%)" });
    return;
  }
  if (minTier && !VALID_TIERS.includes(String(minTier))) {
    res.status(400).json({ error: `Invalid minTier. Valid: A, B, C, D` });
    return;
  }

  const normalizedMoveType =
    moveType && String(moveType) !== "all" ? String(moveType) : undefined;

  try {
    const existing = await getRunningPassRunForSymbol(symbol);
    if (existing) {
      res.status(409).json(withSymbolDomain(symbol, symbolDomain, {
        ok: false,
        error: "A calibration run is already in progress for this symbol.",
        runId: existing.id,
        status: "running",
        totalMoves: existing.totalMoves ?? 0,
      }));
      return;
    }
    const typedMinTier = minTier ? (String(minTier) as "A" | "B" | "C" | "D") : undefined;
    const typedMaxMoves = maxMoves ? Number(maxMoves) : undefined;
    const runId = await createQueuedCalibrationRunRecord({
      symbol,
      windowDays: Number(windowDays),
      passName: "all",
      stage: "Queued",
      metaPatch: {
        queue: "worker_service",
        requestedWorkflow: "full_calibration",
      },
    });
    const workerJobId = await createWorkerJob({
      taskType: "full_calibration",
      serviceId: symbol,
      symbol,
      message: `Queued full calibration for ${symbol}`,
      taskState: { runId },
      jobParams: {
        symbol,
        windowDays: Number(windowDays),
        minMovePct: Number(minMovePct),
        minTier: typedMinTier ?? null,
        moveType: normalizedMoveType ?? null,
        maxMoves: typedMaxMoves ?? null,
        force: Boolean(force),
      },
    });

    res.json(withSymbolDomain(symbol, symbolDomain, {
      ok: true,
      runId,
      workerJobId,
      status: "queued",
      totalMoves: 0,
      stages: [
        "Data Integrity",
        "Move Detection",
        "Deterministic Enrichment",
        "Family Inference",
        "Bucket Model Synthesis",
        "Research Profile Complete",
      ],
      executionModel: "worker_service",
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Full calibration failed";
    console.error(`[calibration/full/${symbol}] error:`, message);
    res.status(500).json({ error: message });
  }
});

// ── GET /api/calibration/moves/:symbol ────────────────────────────────────────

router.get("/calibration/moves/:symbol", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const checked = assertCalibrationSymbol(symbol);
  if (!checked.ok) {
    res.status(400).json({ error: checked.error });
    return;
  }
  const { symbolDomain } = checked;

  const { moveType, minTier } = req.query;

  if (moveType && !VALID_MOVE_TYPES.includes(String(moveType))) {
    res.status(400).json({ error: `Invalid moveType. Valid: ${VALID_MOVE_TYPES.join(", ")}` });
    return;
  }
  if (minTier && !VALID_TIERS.includes(String(minTier))) {
    res.status(400).json({ error: `Invalid minTier. Valid: A, B, C, D` });
    return;
  }

  try {
    const resolvedMoveType = moveType && String(moveType) === "all" ? undefined : (moveType ? String(moveType) : undefined);
    const moves = await getDetectedMoves(
      symbol,
      resolvedMoveType,
      minTier ? (String(minTier) as "A" | "B" | "C" | "D") : undefined,
    );
    res.json(withSymbolDomain(symbol, symbolDomain, { moveCount: moves.length, moves }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch moves";
    res.status(500).json({ error: message });
  }
});

// ── POST /api/calibration/run-passes/:symbol ──────────────────────────────────
// Starts the AI pass pipeline in the background; poll GET /run-status/:runId for progress.

router.post("/calibration/run-passes/:symbol", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const checked = assertCalibrationSymbol(symbol);
  if (!checked.ok) {
    res.status(400).json({ error: checked.error });
    return;
  }
  const { symbolDomain } = checked;

  const body = req.body ?? {};

  // Accept both original field names and spec-aligned aliases.
  // strategyFamily maps to moveType.
  // passNumber maps to the new deterministic-first sequence.
  const PASS_NUMBER_MAP: Record<number, PassName> = { 1: "enrichment", 2: "family_inference", 3: "model_synthesis" };
  const windowDays: number = Number(body.windowDays ?? 90);
  const resolvedPassName: PassName = (() => {
    if (body.passNumber !== undefined) return PASS_NUMBER_MAP[Number(body.passNumber)] ?? "all";
    return (body.passName as PassName) ?? "all";
  })();
  const resolvedMoveType: string | undefined = (() => {
    const raw = body.strategyFamily ?? body.moveType;
    if (!raw) return undefined;
    const normalized = String(raw);
    return normalized === "all" ? undefined : normalized;
  })();
  const minTier:  string | undefined = body.minTier ? String(body.minTier) : undefined;
  const maxMoves: number | undefined = body.maxMoves ? Number(body.maxMoves) : undefined;
  const force:    boolean            = Boolean(body.force ?? false);
  /** Collect all per-move errors (legacy). Default: abort on first pass error. */
  const continueOnMoveErrors = Boolean(body.continueOnMoveErrors);

  if (!VALID_PASS_NAMES.includes(resolvedPassName)) {
    res.status(400).json({ error: `Invalid passName/passNumber. Valid passNames: ${VALID_PASS_NAMES.join(", ")}` });
    return;
  }
  if (minTier && !VALID_TIERS.includes(minTier)) {
    res.status(400).json({ error: `Invalid minTier. Valid: A, B, C, D` });
    return;
  }

  try {
    const existing = await getRunningPassRunForSymbol(symbol);
    if (existing) {
      res.status(409).json({
        error: "A calibration pass run is already in progress for this symbol.",
        ok: false,
        symbol,
        symbolDomain,
        runId: existing.id,
        status: "running",
        totalMoves: existing.totalMoves ?? 0,
      });
      return;
    }

    const runId = await createQueuedCalibrationRunRecord({
      symbol,
      windowDays,
      passName: resolvedPassName,
      stage: "Queued",
      metaPatch: {
        queue: "worker_service",
        requestedWorkflow: "calibration_passes",
      },
    });
    const workerJobId = await createWorkerJob({
      taskType: "calibration_passes",
      serviceId: symbol,
      symbol,
      message: `Queued calibration pass run for ${symbol}`,
      taskState: { runId },
      jobParams: {
        symbol,
        windowDays,
        passName: resolvedPassName,
        minTier: (minTier as "A" | "B" | "C" | "D" | undefined) ?? null,
        moveType: resolvedMoveType ?? null,
        maxMoves: maxMoves ?? null,
        force,
        continueOnMoveErrors,
      },
    });
    res.json(withSymbolDomain(symbol, symbolDomain, {
      ok: true,
      runId,
      workerJobId,
      status: "queued",
      totalMoves: 0,
      executionModel: "worker_service",
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Pass run failed";
    console.error(`[calibration/run-passes/${symbol}] error:`, message);
    res.status(500).json({ error: message });
  }
});

// ── GET /api/calibration/run-status/:runId ────────────────────────────────────

router.get("/calibration/run-status/:runId", async (req, res): Promise<void> => {
  const runId = parseInt(req.params.runId, 10);
  if (isNaN(runId)) {
    res.status(400).json({ error: "runId must be a valid integer" });
    return;
  }

  try {
    const status = await getPassRunStatus(runId);
    if (!status) {
      res.status(404).json({ error: `No run found with id ${runId}` });
      return;
    }
    const checked = assertCalibrationSymbol(status.symbol);
    if (!checked.ok) {
      res.json(status);
      return;
    }
    res.json(withSymbolDomain(status.symbol, checked.symbolDomain, status));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Status fetch failed";
    res.status(500).json({ error: message });
  }
});

// ── GET /api/calibration/runs/:symbol ─────────────────────────────────────────
// All pass runs for a symbol, most-recent first.

router.get("/calibration/runs/:symbol", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const checked = assertCalibrationSymbol(symbol);
  if (!checked.ok) {
    res.status(400).json({ error: checked.error });
    return;
  }
  const { symbolDomain } = checked;

  try {
    const runs = await getAllPassRuns(symbol);
    res.json(withSymbolDomain(symbol, symbolDomain, { ok: true, runCount: runs.length, runs }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Runs fetch failed";
    res.status(500).json({ error: message });
  }
});

// ── GET /api/calibration/aggregate/:symbol ────────────────────────────────────

router.get("/calibration/aggregate/:symbol", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const checked = assertCalibrationSymbol(symbol);
  if (!checked.ok) {
    res.status(400).json({ error: checked.error });
    return;
  }
  const { symbolDomain } = checked;

  try {
    const aggregate = await buildCalibrationAggregate(symbol);
    res.json(withSymbolDomain(symbol, symbolDomain, { ok: true, ...aggregate }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Aggregate build failed";
    res.status(500).json({ error: message });
  }
});

// ── GET /api/calibration/profile/:symbol/:strategy ────────────────────────────
// :strategy accepts either the spec-aligned name ("breakout", "continuation",
// "reversal", "unknown", "all") or the legacy :moveType param — they are the
// same value space. Both routes are registered so old callers still work.

async function handleProfileRequest(
  symbol: string,
  strategy: string,
  res: import("express").Response,
): Promise<void> {
  const checked = assertCalibrationSymbol(symbol);
  if (!checked.ok) {
    res.status(400).json({ error: checked.error });
    return;
  }
  const { symbolDomain } = checked;
  if (!VALID_MOVE_TYPES.includes(strategy)) {
    res.status(400).json({ error: `Invalid strategy/moveType. Valid: ${VALID_MOVE_TYPES.join(", ")}` });
    return;
  }
  try {
    const profile = await getCalibrationProfile(symbol, strategy);
    if (!profile) {
      res.status(404).json({
        error: `No calibration profile for ${symbol}/${strategy}. Run POST /api/calibration/detect-moves then /api/calibration/run-passes first.`,
      });
      return;
    }
    res.json(withSymbolDomain(symbol, symbolDomain, { ok: true, ...profile }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Profile fetch failed";
    res.status(500).json({ error: message });
  }
}

router.get("/calibration/profile/:symbol/:strategy", async (req, res): Promise<void> => {
  // :strategy and legacy :moveType callers share the same URL shape and value space.
  // Keep a single canonical route to avoid ambiguous duplicate route registration.
  await handleProfileRequest(req.params.symbol, req.params.strategy, res);
});

// ── GET /api/calibration/profiles/:symbol ─────────────────────────────────────

router.get("/calibration/profiles/:symbol", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const checked = assertCalibrationSymbol(symbol);
  if (!checked.ok) {
    res.status(400).json({ error: checked.error });
    return;
  }
  const { symbolDomain } = checked;

  try {
    const profiles = await getAllCalibrationProfiles(symbol);
    res.json(withSymbolDomain(symbol, symbolDomain, { profileCount: profiles.length, profiles }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Profiles fetch failed";
    res.status(500).json({ error: message });
  }
});

// ── GET /api/calibration/research-profile/:symbol ─────────────────────────────

router.get("/calibration/research-profile/:symbol", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const checked = assertCalibrationSymbol(symbol);
  if (!checked.ok) {
    res.status(400).json({ error: checked.error });
    return;
  }
  const { symbolDomain } = checked;

  try {
    const profile = await getLatestSymbolResearchProfile(symbol);
    if (!profile) {
      res.status(404).json(withSymbolDomain(symbol, symbolDomain, {
        error: `No symbol research profile for ${symbol}. Run full calibration first.`,
      }));
      return;
    }
    res.json(withSymbolDomain(symbol, symbolDomain, profile));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Research profile fetch failed";
    res.status(500).json({ error: message });
  }
});

// ── GET /api/calibration/engine/:symbol ───────────────────────────────────────

router.get("/calibration/engine/:symbol", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const checked = assertCalibrationSymbol(symbol);
  if (!checked.ok) {
    res.status(400).json({ error: checked.error });
    return;
  }
  const { symbolDomain } = checked;

  try {
    const calibration = await getEngineCalibration(symbol);
    res.json(withSymbolDomain(symbol, symbolDomain, { engines: calibration }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Engine calibration fetch failed";
    res.status(500).json({ error: message });
  }
});

// ── GET /api/calibration/scoring/:symbol ──────────────────────────────────────

router.get("/calibration/scoring/:symbol", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const checked = assertCalibrationSymbol(symbol);
  if (!checked.ok) {
    res.status(400).json({ error: checked.error });
    return;
  }
  const { symbolDomain } = checked;

  try {
    const calibration = await getScoringCalibration(symbol);
    res.json(withSymbolDomain(symbol, symbolDomain, calibration));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Scoring calibration fetch failed";
    res.status(500).json({ error: message });
  }
});

// ── GET /api/calibration/health/:symbol ───────────────────────────────────────

router.get("/calibration/health/:symbol", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const checked = assertCalibrationSymbol(symbol);
  if (!checked.ok) {
    res.status(400).json({ error: checked.error });
    return;
  }
  const { symbolDomain } = checked;

  try {
    const calibration = await getTradeHealthCalibration(symbol);
    res.json(withSymbolDomain(symbol, symbolDomain, calibration));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Health calibration fetch failed";
    res.status(500).json({ error: message });
  }
});

// ── GET /api/calibration/export/:symbol ───────────────────────────────────────
// Optional ?type= param selects which slice to export:
//   type=moves      — detected moves for this symbol
//   type=passes     — all calibration pass runs for this symbol
//   type=profile    — all calibration profiles (all move types)
//   type=comparison — aggregate + engine coverage comparison summary
//   (no type)       — full calibration export (existing behaviour)

router.get("/calibration/export/:symbol", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const checked = assertCalibrationSymbol(symbol);
  if (!checked.ok) {
    res.status(400).json({ error: checked.error });
    return;
  }
  const { symbolDomain } = checked;

  const exportType = req.query.type ? String(req.query.type) : null;
  const VALID_EXPORT_TYPES = ["moves", "passes", "profile", "comparison", "parity"];
  if (exportType && !VALID_EXPORT_TYPES.includes(exportType)) {
    res.status(400).json({ error: `Invalid export type. Valid: ${VALID_EXPORT_TYPES.join(", ")} (or omit for full export)` });
    return;
  }
  const includeFeatureFrames = req.query.includeFeatureFrames === "true";

  const asDownload = req.query.download === "true";
  const ts = new Date().toISOString().slice(0, 10);

  try {
    let response: unknown;
    let filename: string;

    if (exportType === "moves") {
      const moves = await getDetectedMoves(symbol);
      response = withSymbolDomain(symbol, symbolDomain, {
        exportType: "moves",
        exportedAt: new Date().toISOString(),
        moveCount: moves.length,
        moves,
      });
      filename = `calibration_moves_${symbol}_${ts}.json`;

    } else if (exportType === "passes") {
      // Return run headers + raw per-move pass records (precursor pass + behavior/trigger passes)
      const [runs, profiles, precursorRaw, behaviorRaw, familyInferences, progressionArtifacts, featureFrameCountRows, moveWindowSummaries, familyBucketProfiles, featureRelevance, entryIdeals, exitRiskProfiles] = await Promise.all([
        getAllPassRuns(symbol),
        getAllCalibrationProfiles(symbol),
        db.select().from(movePrecursorPassesTable).where(eq(movePrecursorPassesTable.symbol, symbol)),
        db.select().from(moveBehaviorPassesTable).where(eq(moveBehaviorPassesTable.symbol, symbol)),
        db.select().from(moveFamilyInferencesTable).where(eq(moveFamilyInferencesTable.symbol, symbol)),
        db.select().from(moveProgressionArtifactsTable).where(eq(moveProgressionArtifactsTable.symbol, symbol)),
        db.select({ count: count() }).from(calibrationFeatureFramesTable).where(eq(calibrationFeatureFramesTable.symbol, symbol)),
        db.select().from(calibrationMoveWindowSummariesTable).where(eq(calibrationMoveWindowSummariesTable.symbol, symbol)),
        db.select().from(calibrationFamilyBucketProfilesTable).where(eq(calibrationFamilyBucketProfilesTable.symbol, symbol)),
        db.select().from(calibrationFeatureRelevanceTable).where(eq(calibrationFeatureRelevanceTable.symbol, symbol)),
        db.select().from(calibrationEntryIdealsTable).where(eq(calibrationEntryIdealsTable.symbol, symbol)),
        db.select().from(calibrationExitRiskProfilesTable).where(eq(calibrationExitRiskProfilesTable.symbol, symbol)),
      ]);
      const featureFrames = includeFeatureFrames
        ? await db.select().from(calibrationFeatureFramesTable).where(eq(calibrationFeatureFramesTable.symbol, symbol))
        : null;
      const featureFrameCount = Number(featureFrameCountRows[0]?.count ?? 0);
      response = {
        ...withSymbolDomain(symbol, symbolDomain, {}),
        exportType: "passes",
        exportedAt: new Date().toISOString(),
        runCount: runs.length,
        runs,
        rawPassRecords: {
          description: "Raw AI pass records per detected move — precursor (Pass 1) and behavior/trigger (Passes 2+3).",
          precursorPassCount: precursorRaw.length,
          precursorPasses: precursorRaw,
          behaviorPassCount: behaviorRaw.length,
          behaviorPasses: behaviorRaw,
          familyInferenceCount: familyInferences.length,
          familyInferences,
          progressionArtifactCount: progressionArtifacts.length,
          progressionArtifacts,
          featureFrameCount,
          featureFramesIncluded: includeFeatureFrames,
          featureFrames: featureFrames ?? undefined,
          featureFrameExportNote: includeFeatureFrames
            ? undefined
            : "Feature frames are omitted from the default UI export because they are very large. Add includeFeatureFrames=true to this endpoint for the raw frame dataset.",
          moveWindowSummaryCount: moveWindowSummaries.length,
          moveWindowSummaries,
          familyBucketProfileCount: familyBucketProfiles.length,
          familyBucketProfiles,
          featureRelevanceCount: featureRelevance.length,
          featureRelevance,
          entryIdealCount: entryIdeals.length,
          entryIdeals,
          exitRiskProfileCount: exitRiskProfiles.length,
          exitRiskProfiles,
        },
        profileSummaries: {
          description: "Aggregated calibration profiles per move type from all passes (extraction pass output).",
          profileCount: profiles.length,
          profiles,
        },
      };
      filename = `calibration_passes_${symbol}_${ts}.json`;

    } else if (exportType === "profile") {
      const [profiles, researchProfile, familyBucketProfiles, featureRelevance, entryIdeals, exitRiskProfiles] = await Promise.all([
        getAllCalibrationProfiles(symbol),
        getLatestSymbolResearchProfile(symbol),
        db.select().from(calibrationFamilyBucketProfilesTable).where(eq(calibrationFamilyBucketProfilesTable.symbol, symbol)),
        db.select().from(calibrationFeatureRelevanceTable).where(eq(calibrationFeatureRelevanceTable.symbol, symbol)),
        db.select().from(calibrationEntryIdealsTable).where(eq(calibrationEntryIdealsTable.symbol, symbol)),
        db.select().from(calibrationExitRiskProfilesTable).where(eq(calibrationExitRiskProfilesTable.symbol, symbol)),
      ]);
      response = withSymbolDomain(symbol, symbolDomain, {
        exportType: "profile",
        exportedAt: new Date().toISOString(),
        profileCount: profiles.length,
        profiles,
        researchProfile,
        familyBucketProfileCount: familyBucketProfiles.length,
        familyBucketProfiles,
        featureRelevanceCount: featureRelevance.length,
        featureRelevance,
        entryIdealCount: entryIdeals.length,
        entryIdeals,
        exitRiskProfileCount: exitRiskProfiles.length,
        exitRiskProfiles,
      });
      filename = `calibration_profile_${symbol}_${ts}.json`;

    } else if (exportType === "comparison") {
      // 3-domain comparison: Current Engine Behavior vs Target Moves vs Recommended Calibration
      const [moves, profiles, engine] = await Promise.all([
        getDetectedMoves(symbol),
        getAllCalibrationProfiles(symbol),
        getEngineCalibration(symbol),
      ]);
      const behaviorProfile = deriveSymbolBehaviorProfile(symbol);
      const mags = moves.map(m => Number(m.movePct ?? 0)).sort((a, b) => a - b);
      const median = mags.length > 0 ? mags[Math.floor(mags.length / 2)] : null;
      const moveTypeDistribution = moves.reduce<Record<string, number>>((acc, m) => {
        const t = String(m.moveType ?? "unknown");
        acc[t] = (acc[t] ?? 0) + 1;
        return acc;
      }, {});
      response = {
        ...withSymbolDomain(symbol, symbolDomain, {}),
        exportType: "comparison",
        exportedAt: new Date().toISOString(),
        currentEngineBehavior: {
          description: "Signal-driven engine behavior profile from /api/behavior/profile/:symbol",
          source: `/api/behavior/profile/${symbol}`,
          data: behaviorProfile,
          engineCoverage: engine,
        },
        targetMoves: {
          description: "Structurally detected moves from /api/calibration/moves/:symbol",
          source: `/api/calibration/moves/${symbol}`,
          totalMoves: moves.length,
          medianMagnitudePct: median,
          moveTypeDistribution,
          sampleMoves: moves.slice(0, 10),
        },
        recommendedCalibration: {
          description: "AI-generated calibration profiles from /api/calibration/profile/:symbol/:strategy",
          source: `/api/calibration/profiles/${symbol}`,
          profileCount: profiles.length,
          profiles,
        },
      };
      filename = `calibration_comparison_${symbol}_${ts}.json`;

    } else if (exportType === "parity") {
      const service = getSymbolService(symbol);
      if (!service) {
        res.status(404).json({ error: `No symbol service registered for ${symbol}` });
        return;
      }
      const endTs = Number(req.query.endTs ?? Math.floor(Date.now() / 1000));
      const startTs = Number(
        req.query.startTs ??
          (Math.floor(Date.now() / 1000) - Math.max(30, Math.min(730, Number(req.query.windowDays ?? 365))) * 86400),
      );
      const parity = await service.runCalibrationParity({
        symbol,
        startTs,
        endTs,
        mode: "parity",
      });
      const parityRecord = parity as Record<string, unknown>;
      const runtimeModel = (parityRecord.runtimeModel ?? null) as Record<string, unknown> | null;
      response = withSymbolDomain(symbol, symbolDomain, {
        exportType: "parity",
        exportedAt: new Date().toISOString(),
        generatedAt: new Date().toISOString(),
        promotedModelRunId: runtimeModel?.promotedModelRunId ?? null,
        stagedModelRunId: runtimeModel?.stagedModelRunId ?? null,
        totals: parityRecord.totals ?? {},
        verdicts: Array.isArray(parityRecord.verdicts) ? parityRecord.verdicts : [],
        diagnostics: parityRecord.diagnostics ?? {},
        report: parityRecord,
      });
      filename = `calibration_parity_${symbol}_${ts}.json`;
    } else {
      const [exportData, moves, integrity] = await Promise.all([
        getFullCalibrationExport(symbol),
        getDetectedMoves(symbol),
        getComprehensiveIntegrityReport(symbol, 365).catch(() => null),
      ]);
      response = withSymbolDomain(symbol, symbolDomain, {
        ...exportData,
        integritySummary: integrity,
        detected_moves: moves,
        detected_moves_count: moves.length,
      });
      filename = `calibration_full_${symbol}_${ts}.json`;
    }

    if (asDownload) {
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Type", "application/json");
    }
    res.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Calibration export failed";
    res.status(500).json({ error: message });
  }
});

// ── POST /api/calibration/import/:symbol ──────────────────────────────────────
// Import previously exported calibration artifacts so we can reuse completed
// AI calibration runs without re-consuming API budget.
// Query:
//   type = moves | passes | profile | comparison
//   replace = true|false (default true)
router.post("/calibration/import/:symbol", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const checked = assertCalibrationSymbol(symbol);
  if (!checked.ok) {
    res.status(400).json({ error: checked.error });
    return;
  }
  const { symbolDomain } = checked;

  const importType = String(req.query.type ?? "").toLowerCase();
  const replace = req.query.replace !== "false";
  const VALID_IMPORT_TYPES = ["moves", "passes", "profile", "comparison"];
  if (!VALID_IMPORT_TYPES.includes(importType)) {
    res.status(400).json({ error: `Invalid import type. Valid: ${VALID_IMPORT_TYPES.join(", ")}` });
    return;
  }

  const payload = req.body ?? {};
  const asArray = (v: unknown): Record<string, unknown>[] =>
    Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];
  const num = (v: unknown, fallback = 0): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const txt = (v: unknown, fallback = ""): string =>
    typeof v === "string" && v.trim().length > 0 ? v.trim() : fallback;
  const json = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

  try {
      let imported = {
        moves: 0,
        passRuns: 0,
        precursorPasses: 0,
        behaviorPasses: 0,
        profiles: 0,
        familyInferences: 0,
        progressionArtifacts: 0,
        featureRelevance: 0,
        entryIdeals: 0,
        exitRiskProfiles: 0,
      };

    if (importType === "moves") {
      const moves = asArray((payload as Record<string, unknown>).moves ?? (payload as Record<string, unknown>).detected_moves);
      if (replace) {
        await db.delete(detectedMovesTable).where(eq(detectedMovesTable.symbol, symbol));
      }
      if (moves.length > 0) {
        await db.insert(detectedMovesTable).values(moves.map((m) => ({
          symbol,
          direction: txt(m.direction, "up"),
          moveType: txt(m.moveType, "unknown"),
          startTs: num(m.startTs),
          endTs: num(m.endTs),
          startPrice: num(m.startPrice),
          endPrice: num(m.endPrice),
          movePct: num(m.movePct),
          holdingMinutes: num(m.holdingMinutes),
          leadInShape: txt(m.leadInShape, "unknown"),
          leadInBars: Math.round(num(m.leadInBars, 0)),
          directionalPersistence: num(m.directionalPersistence, 0),
          rangeExpansion: num(m.rangeExpansion, 1),
          spikeCount4h: Math.round(num(m.spikeCount4h, 0)),
          qualityScore: num(m.qualityScore, 0),
          qualityTier: txt(m.qualityTier, "D"),
          windowDays: Math.round(num(m.windowDays, 90)),
          isInterpolatedExcluded: m.isInterpolatedExcluded === false ? false : true,
          strategyFamilyCandidate: txt(m.strategyFamilyCandidate, "unknown"),
          contextJson: json(m.contextJson),
          triggerZoneJson: json(m.triggerZoneJson),
        })));
      }
      imported.moves = moves.length;
    }

    if (importType === "passes") {
      const runs = asArray((payload as Record<string, unknown>).runs);
      const raw = json((payload as Record<string, unknown>).rawPassRecords) ?? {};
      const precursor = asArray(raw.precursorPasses ?? (payload as Record<string, unknown>).precursorPasses);
      const behavior = asArray(raw.behaviorPasses ?? (payload as Record<string, unknown>).behaviorPasses);
      const familyInferences = asArray(raw.familyInferences ?? (payload as Record<string, unknown>).familyInferences);
      const progressionArtifacts = asArray(raw.progressionArtifacts ?? (payload as Record<string, unknown>).progressionArtifacts);
      const featureRelevance = asArray(raw.featureRelevance ?? (payload as Record<string, unknown>).featureRelevance);
      const entryIdeals = asArray(raw.entryIdeals ?? (payload as Record<string, unknown>).entryIdeals);
      const exitRiskProfiles = asArray(raw.exitRiskProfiles ?? (payload as Record<string, unknown>).exitRiskProfiles);
      const profiles = asArray((payload as Record<string, unknown>).profiles ?? json((payload as Record<string, unknown>).profileSummaries)?.profiles);

      if (replace) {
        await db.delete(calibrationEntryIdealsTable).where(eq(calibrationEntryIdealsTable.symbol, symbol));
        await db.delete(calibrationExitRiskProfilesTable).where(eq(calibrationExitRiskProfilesTable.symbol, symbol));
        await db.delete(calibrationFeatureRelevanceTable).where(eq(calibrationFeatureRelevanceTable.symbol, symbol));
        await db.delete(moveProgressionArtifactsTable).where(eq(moveProgressionArtifactsTable.symbol, symbol));
        await db.delete(moveFamilyInferencesTable).where(eq(moveFamilyInferencesTable.symbol, symbol));
        await db.delete(movePrecursorPassesTable).where(eq(movePrecursorPassesTable.symbol, symbol));
        await db.delete(moveBehaviorPassesTable).where(eq(moveBehaviorPassesTable.symbol, symbol));
        await db.delete(calibrationPassRunsTable).where(eq(calibrationPassRunsTable.symbol, symbol));
      }

      if (runs.length > 0) {
        await db.insert(calibrationPassRunsTable).values(runs.map((r) => ({
          symbol,
          windowDays: Math.round(num(r.windowDays, 90)),
          status: txt(r.status, "completed"),
          passName: txt(r.passName, "all"),
          totalMoves: Math.round(num(r.totalMoves, 0)),
          processedMoves: Math.round(num(r.processedMoves, 0)),
          failedMoves: Math.round(num(r.failedMoves, 0)),
          startedAt: r.startedAt ? new Date(String(r.startedAt)) : new Date(),
          completedAt: r.completedAt ? new Date(String(r.completedAt)) : null,
          errorSummary: json(r.errorSummary),
          metaJson: json(r.metaJson),
        })));
      }
      if (precursor.length > 0) {
        await db.insert(movePrecursorPassesTable).values(precursor.map((p) => ({
          moveId: Math.round(num(p.moveId, 0)),
          symbol,
          direction: txt(p.direction, "up"),
          moveType: txt(p.moveType, "unknown"),
          engineMatched: txt(p.engineMatched, "none"),
          engineWouldFire: Boolean(p.engineWouldFire),
          precursorConditions: json(p.precursorConditions),
          missedReason: txt(p.missedReason, ""),
          leadInSummary: txt(p.leadInSummary, ""),
          confidenceScore: num(p.confidenceScore, 0),
          rawAiResponse: json(p.rawAiResponse),
          passRunId: Number.isFinite(num(p.passRunId, NaN)) ? Math.round(num(p.passRunId, 0)) : null,
        })));
      }
      if (behavior.length > 0) {
        await db.insert(moveBehaviorPassesTable).values(behavior.map((b) => ({
          moveId: Math.round(num(b.moveId, 0)),
          symbol,
          direction: txt(b.direction, "up"),
          passName: txt(b.passName, "behavior"),
          earliestEntryTs: Number.isFinite(num(b.earliestEntryTs, NaN)) ? num(b.earliestEntryTs, 0) : null,
          earliestEntryPrice: Number.isFinite(num(b.earliestEntryPrice, NaN)) ? num(b.earliestEntryPrice, 0) : null,
          entrySlippage: num(b.entrySlippage, 0),
          captureablePct: num(b.captureablePct, 0),
          maxFavorablePct: num(b.maxFavorablePct, 0),
          maxAdversePct: num(b.maxAdversePct, 0),
          barsToMfePeak: Math.round(num(b.barsToMfePeak, 0)),
          exitNarrative: txt(b.exitNarrative, ""),
          triggerConditions: json(b.triggerConditions),
          behaviorPattern: txt(b.behaviorPattern, "unknown"),
          holdabilityScore: num(b.holdabilityScore, 0),
          rawAiResponse: json(b.rawAiResponse),
          passRunId: Number.isFinite(num(b.passRunId, NaN)) ? Math.round(num(b.passRunId, 0)) : null,
        })));
      }
      if (familyInferences.length > 0) {
        await db.insert(moveFamilyInferencesTable).values(familyInferences.map((f) => ({
          moveId: Math.round(num(f.moveId, 0)),
          symbol,
          strategyFamily: txt(f.strategyFamily, "unknown"),
          confidenceScore: num(f.confidenceScore, 0),
          developmentBars: Math.round(num(f.developmentBars, 0)),
          precursorBars: Math.round(num(f.precursorBars, 0)),
          triggerBars: Math.round(num(f.triggerBars, 0)),
          behaviorBars: Math.round(num(f.behaviorBars, 0)),
          reasoningSummary: txt(f.reasoningSummary, ""),
          rawAiResponse: json(f.rawAiResponse),
          passRunId: Number.isFinite(num(f.passRunId, NaN)) ? Math.round(num(f.passRunId, 0)) : null,
        })));
      }
      if (progressionArtifacts.length > 0) {
        await db.insert(moveProgressionArtifactsTable).values(progressionArtifacts.map((p) => ({
          moveId: Math.round(num(p.moveId, 0)),
          symbol,
          strategyFamily: txt(p.strategyFamily, "unknown"),
          windowModel: p.windowModel as never,
          progressionSummary: p.progressionSummary as never,
          featureStats: p.featureStats as never,
          compactRawSlices: p.compactRawSlices as never,
          passRunId: Number.isFinite(num(p.passRunId, NaN)) ? Math.round(num(p.passRunId, 0)) : null,
        })));
      }
      if (featureRelevance.length > 0) {
        for (const row of featureRelevance) {
          await db.insert(calibrationFeatureRelevanceTable).values({
            symbol,
            strategyFamily: txt(row.strategyFamily, "unknown"),
            movePctBucket: txt(row.movePctBucket, "all"),
            featureName: txt(row.featureName, "unknown"),
            relevanceScore: num(row.relevanceScore, 0),
            precursorUsefulness: num(row.precursorUsefulness, 0),
            triggerUsefulness: num(row.triggerUsefulness, 0),
            behaviorUsefulness: num(row.behaviorUsefulness, 0),
            notes: txt(row.notes, ""),
            sourceRunId: Number.isFinite(num(row.sourceRunId, NaN)) ? Math.round(num(row.sourceRunId, 0)) : null,
          }).onConflictDoUpdate({
            target: [
              calibrationFeatureRelevanceTable.symbol,
              calibrationFeatureRelevanceTable.strategyFamily,
              calibrationFeatureRelevanceTable.movePctBucket,
              calibrationFeatureRelevanceTable.featureName,
            ],
            set: {
              relevanceScore: num(row.relevanceScore, 0),
              precursorUsefulness: num(row.precursorUsefulness, 0),
              triggerUsefulness: num(row.triggerUsefulness, 0),
              behaviorUsefulness: num(row.behaviorUsefulness, 0),
              notes: txt(row.notes, ""),
              sourceRunId: Number.isFinite(num(row.sourceRunId, NaN)) ? Math.round(num(row.sourceRunId, 0)) : null,
              updatedAt: new Date(),
            },
          });
        }
      }
      if (entryIdeals.length > 0) {
        for (const row of entryIdeals) {
          await db.insert(calibrationEntryIdealsTable).values({
            symbol,
            strategyFamily: txt(row.strategyFamily, "unknown"),
            movePctBucket: txt(row.movePctBucket, "all"),
            idealPrecursorProfile: row.idealPrecursorProfile as never,
            idealTriggerProfile: row.idealTriggerProfile as never,
            featureBands: row.featureBands as never,
            entryQualityNarrative: txt(row.entryQualityNarrative, ""),
            progressionSummary: row.progressionSummary as never,
            sourceRunId: Number.isFinite(num(row.sourceRunId, NaN)) ? Math.round(num(row.sourceRunId, 0)) : null,
          }).onConflictDoUpdate({
            target: [
              calibrationEntryIdealsTable.symbol,
              calibrationEntryIdealsTable.strategyFamily,
              calibrationEntryIdealsTable.movePctBucket,
            ],
            set: {
              idealPrecursorProfile: row.idealPrecursorProfile as never,
              idealTriggerProfile: row.idealTriggerProfile as never,
              featureBands: row.featureBands as never,
              entryQualityNarrative: txt(row.entryQualityNarrative, ""),
              progressionSummary: row.progressionSummary as never,
              sourceRunId: Number.isFinite(num(row.sourceRunId, NaN)) ? Math.round(num(row.sourceRunId, 0)) : null,
              updatedAt: new Date(),
            },
          });
        }
      }
      if (exitRiskProfiles.length > 0) {
        for (const row of exitRiskProfiles) {
          await db.insert(calibrationExitRiskProfilesTable).values({
            symbol,
            strategyFamily: txt(row.strategyFamily, "unknown"),
            movePctBucket: txt(row.movePctBucket, "all"),
            regressionFingerprints: row.regressionFingerprints as never,
            moveBreakWarningPatterns: row.moveBreakWarningPatterns as never,
            closureSignals: row.closureSignals as never,
            trailingInterpretationNotes: txt(row.trailingInterpretationNotes, ""),
            sourceRunId: Number.isFinite(num(row.sourceRunId, NaN)) ? Math.round(num(row.sourceRunId, 0)) : null,
          }).onConflictDoUpdate({
            target: [
              calibrationExitRiskProfilesTable.symbol,
              calibrationExitRiskProfilesTable.strategyFamily,
              calibrationExitRiskProfilesTable.movePctBucket,
            ],
            set: {
              regressionFingerprints: row.regressionFingerprints as never,
              moveBreakWarningPatterns: row.moveBreakWarningPatterns as never,
              closureSignals: row.closureSignals as never,
              trailingInterpretationNotes: txt(row.trailingInterpretationNotes, ""),
              sourceRunId: Number.isFinite(num(row.sourceRunId, NaN)) ? Math.round(num(row.sourceRunId, 0)) : null,
              updatedAt: new Date(),
            },
          });
        }
      }

      if (profiles.length > 0) {
        for (const p of profiles) {
          await db
            .insert(strategyCalibrationProfilesTable)
            .values({
              symbol,
              moveType: txt(p.moveType, "all"),
              windowDays: Math.round(num(p.windowDays, 90)),
              targetMoves: Math.round(num(p.targetMoves, 0)),
              capturedMoves: Math.round(num(p.capturedMoves, 0)),
              missedMoves: Math.round(num(p.missedMoves, 0)),
              fitScore: num(p.fitScore, 0),
              missReasons: p.missReasons as never,
              avgMovePct: num(p.avgMovePct, 0),
              medianMovePct: num(p.medianMovePct, 0),
              avgHoldingHours: num(p.avgHoldingHours, 0),
              avgCaptureablePct: num(p.avgCaptureablePct, 0),
              avgHoldabilityScore: num(p.avgHoldabilityScore, 0),
              engineCoverage: p.engineCoverage as never,
              precursorSummary: p.precursorSummary as never,
              triggerSummary: p.triggerSummary as never,
              feeddownSchema: p.feeddownSchema as never,
              profitabilitySummary: p.profitabilitySummary as never,
              lastRunId: Number.isFinite(num(p.lastRunId, NaN)) ? Math.round(num(p.lastRunId, 0)) : null,
              generatedAt: p.generatedAt ? new Date(String(p.generatedAt)) : new Date(),
            })
            .onConflictDoUpdate({
              target: [strategyCalibrationProfilesTable.symbol, strategyCalibrationProfilesTable.moveType],
              set: {
                windowDays: Math.round(num(p.windowDays, 90)),
                targetMoves: Math.round(num(p.targetMoves, 0)),
                capturedMoves: Math.round(num(p.capturedMoves, 0)),
                missedMoves: Math.round(num(p.missedMoves, 0)),
                fitScore: num(p.fitScore, 0),
                missReasons: p.missReasons as never,
                avgMovePct: num(p.avgMovePct, 0),
                medianMovePct: num(p.medianMovePct, 0),
                avgHoldingHours: num(p.avgHoldingHours, 0),
                avgCaptureablePct: num(p.avgCaptureablePct, 0),
                avgHoldabilityScore: num(p.avgHoldabilityScore, 0),
                engineCoverage: p.engineCoverage as never,
                precursorSummary: p.precursorSummary as never,
                triggerSummary: p.triggerSummary as never,
                feeddownSchema: p.feeddownSchema as never,
                profitabilitySummary: p.profitabilitySummary as never,
                lastRunId: Number.isFinite(num(p.lastRunId, NaN)) ? Math.round(num(p.lastRunId, 0)) : null,
                generatedAt: p.generatedAt ? new Date(String(p.generatedAt)) : new Date(),
              },
            });
        }
      }

      imported.passRuns = runs.length;
      imported.precursorPasses = precursor.length;
      imported.behaviorPasses = behavior.length;
      imported.profiles = profiles.length;
      imported.familyInferences = familyInferences.length;
      imported.progressionArtifacts = progressionArtifacts.length;
      imported.featureRelevance = featureRelevance.length;
      imported.entryIdeals = entryIdeals.length;
      imported.exitRiskProfiles = exitRiskProfiles.length;
    }

    if (importType === "profile") {
      const profiles = asArray((payload as Record<string, unknown>).profiles);
      if (replace) {
        await db.delete(strategyCalibrationProfilesTable).where(eq(strategyCalibrationProfilesTable.symbol, symbol));
      }
      for (const p of profiles) {
        await db
          .insert(strategyCalibrationProfilesTable)
          .values({
            symbol,
            moveType: txt(p.moveType, "all"),
            windowDays: Math.round(num(p.windowDays, 90)),
            targetMoves: Math.round(num(p.targetMoves, 0)),
            capturedMoves: Math.round(num(p.capturedMoves, 0)),
            missedMoves: Math.round(num(p.missedMoves, 0)),
            fitScore: num(p.fitScore, 0),
            missReasons: p.missReasons as never,
            avgMovePct: num(p.avgMovePct, 0),
            medianMovePct: num(p.medianMovePct, 0),
            avgHoldingHours: num(p.avgHoldingHours, 0),
            avgCaptureablePct: num(p.avgCaptureablePct, 0),
            avgHoldabilityScore: num(p.avgHoldabilityScore, 0),
            engineCoverage: p.engineCoverage as never,
            precursorSummary: p.precursorSummary as never,
            triggerSummary: p.triggerSummary as never,
            feeddownSchema: p.feeddownSchema as never,
            profitabilitySummary: p.profitabilitySummary as never,
            lastRunId: Number.isFinite(num(p.lastRunId, NaN)) ? Math.round(num(p.lastRunId, 0)) : null,
            generatedAt: p.generatedAt ? new Date(String(p.generatedAt)) : new Date(),
          })
          .onConflictDoUpdate({
            target: [strategyCalibrationProfilesTable.symbol, strategyCalibrationProfilesTable.moveType],
            set: {
              windowDays: Math.round(num(p.windowDays, 90)),
              targetMoves: Math.round(num(p.targetMoves, 0)),
              capturedMoves: Math.round(num(p.capturedMoves, 0)),
              missedMoves: Math.round(num(p.missedMoves, 0)),
              fitScore: num(p.fitScore, 0),
              missReasons: p.missReasons as never,
              avgMovePct: num(p.avgMovePct, 0),
              medianMovePct: num(p.medianMovePct, 0),
              avgHoldingHours: num(p.avgHoldingHours, 0),
              avgCaptureablePct: num(p.avgCaptureablePct, 0),
              avgHoldabilityScore: num(p.avgHoldabilityScore, 0),
              engineCoverage: p.engineCoverage as never,
              precursorSummary: p.precursorSummary as never,
              triggerSummary: p.triggerSummary as never,
              feeddownSchema: p.feeddownSchema as never,
              profitabilitySummary: p.profitabilitySummary as never,
              lastRunId: Number.isFinite(num(p.lastRunId, NaN)) ? Math.round(num(p.lastRunId, 0)) : null,
              generatedAt: p.generatedAt ? new Date(String(p.generatedAt)) : new Date(),
            },
          });
      }
      imported.profiles = profiles.length;
    }

    if (importType === "comparison") {
      // Comparison is derived/read-only and does not map 1:1 to base tables.
      // Accept as no-op so users can still upload it for bookkeeping.
    }

    const latestAllProfile = await getCalibrationProfile(symbol, "all");
    if (latestAllProfile?.lastRunId) {
      await upsertSymbolResearchProfile(symbol, latestAllProfile.lastRunId);
    }

    res.json(withSymbolDomain(symbol, symbolDomain, {
      ok: true,
      importType,
      replace,
      imported,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Calibration import failed";
    console.error(`[calibration/import/${symbol}] error:`, message);
    res.status(500).json({ error: message });
  }
});

// —— GET /api/calibration/runtime-model/:symbol ————————————————————————————————————————
// Returns the latest research profile plus staged/promoted runtime model state.
router.get("/calibration/runtime-model/:symbol", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const checked = assertCalibrationSymbol(symbol);
  if (!checked.ok) {
    res.status(400).json({ error: checked.error });
    return;
  }
  const { symbolDomain } = checked;

  try {
    const [researchProfile, stagedModel, promotedModel] = await Promise.all([
      getLatestSymbolResearchProfile(symbol),
      getStagedSymbolRuntimeModel(symbol),
      getPromotedSymbolRuntimeModel(symbol),
    ]);

    const latestRunId = researchProfile?.lastRunId ?? null;
    const promotedRunId = promotedModel?.sourceRunId ?? null;
    const stagedRunId = stagedModel?.sourceRunId ?? null;
    const stagedDiagnostics = runtimeModelDiagnostics(stagedModel);
    const promotedDiagnostics = runtimeModelDiagnostics(promotedModel);
    const stagedOptimisationRunId = stagedModel?.optimisationRunId ?? null;
    const promotedOptimisationRunId = promotedModel?.optimisationRunId ?? null;
    const stagedOptimisationCandidateId = stagedModel?.optimisationCandidateId ?? null;
    const promotedOptimisationCandidateId = promotedModel?.optimisationCandidateId ?? null;
    const promotedMatchesStaged =
      Boolean(stagedModel && promotedModel) &&
      JSON.stringify(normaliseRuntimeModelForCompare(stagedModel as unknown as Record<string, unknown>)) ===
        JSON.stringify(normaliseRuntimeModelForCompare(promotedModel as unknown as Record<string, unknown>));

    res.json(withSymbolDomain(symbol, symbolDomain, {
      ok: true,
      researchProfile,
      stagedModel,
      promotedModel,
      lifecycle: {
        hasResearchProfile: Boolean(researchProfile),
        hasStagedModel: Boolean(stagedModel),
        hasPromotedModel: Boolean(promotedModel),
        latestRunId,
        stagedRunId,
        promotedRunId,
        runtimeSource: promotedModel ? "promoted_symbol_model" : "none",
        stagedAt: stagedModel?.promotedAt ?? null,
        promotedAt: promotedModel?.promotedAt ?? null,
        stagedOptimisationRunId,
        promotedOptimisationRunId,
        stagedOptimisationCandidateId,
        promotedOptimisationCandidateId,
        promotedMatchesStaged,
        stagedTpBucketCount: stagedDiagnostics.tpBucketCount,
        promotedTpBucketCount: promotedDiagnostics.tpBucketCount,
        stagedDynamicTpEnabled: stagedDiagnostics.dynamicTpEnabled,
        promotedDynamicTpEnabled: promotedDiagnostics.dynamicTpEnabled,
        driftPendingPromotion: Boolean(
          latestRunId &&
            ((promotedRunId !== null && latestRunId !== promotedRunId) ||
              (promotedRunId === null && researchProfile)),
        ),
      },
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Runtime model fetch failed";
    res.status(500).json({ error: message });
  }
});

// —— POST /api/calibration/runtime-model/:symbol/stage ———————————————————————————————————
// Builds a non-runtime staged model from the latest research profile.
router.post("/calibration/runtime-model/:symbol/stage", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const checked = assertCalibrationSymbol(symbol);
  if (!checked.ok) {
    res.status(400).json({ error: checked.error });
    return;
  }
  const { symbolDomain } = checked;

  try {
    const stateRows = await db.select().from(platformStateTable);
    const stateMap: Record<string, string> = {};
    for (const row of stateRows) stateMap[row.key] = row.value;

    await refreshResearchProfileFromLatestCalibration(symbol);
    const model = await stageLatestSymbolResearchProfile(symbol, stateMap);
    if (!model) {
      res.status(404).json(withSymbolDomain(symbol, symbolDomain, {
        error: `No symbol research profile for ${symbol}. Run full calibration first.`,
      }));
      return;
    }

    res.json(withSymbolDomain(symbol, symbolDomain, {
      ok: true,
      staged: true,
      runtimeChanged: false,
      model,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Runtime model staging failed";
    res.status(500).json({ error: message });
  }
});

// —— POST /api/calibration/runtime-model/:symbol/promote —————————————————————————————————
// Explicitly promotes the currently staged runtime model into runtime ownership.
router.post("/calibration/runtime-model/:symbol/promote", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const checked = assertCalibrationSymbol(symbol);
  if (!checked.ok) {
    res.status(400).json({ error: checked.error });
    return;
  }
  const { symbolDomain } = checked;

  try {
    const model = await promoteStagedSymbolRuntimeModel(symbol);
    if (!model) {
      res.status(404).json(withSymbolDomain(symbol, symbolDomain, {
        error: `No staged runtime model found for ${symbol}. Click Stage Research Model (or Stage Optimised Winner) first.`,
      }));
      return;
    }

    await db
      .insert(platformStateTable)
      .values({ key: "use_calibrated_runtime_profiles", value: "true" })
      .onConflictDoUpdate({
        target: platformStateTable.key,
        set: { value: "true", updatedAt: new Date() },
      });

    res.json(withSymbolDomain(symbol, symbolDomain, {
      ok: true,
      promoted: true,
      runtimeChanged: true,
      runtimeProfilesEnabled: true,
      model,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Runtime model promotion failed";
    res.status(500).json({ error: message });
  }
});

// ── GET /api/calibration/latest-run/:symbol ───────────────────────────────────

router.post("/calibration/runtime-model/:symbol/optimise-backtest", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const checked = assertCalibrationSymbol(symbol);
  if (!checked.ok) {
    res.status(400).json({ error: checked.error });
    return;
  }

  try {
    const windowDays = Math.max(30, Math.min(730, Number(req.body?.windowDays ?? 365)));
    const maxIterations = Math.max(1, Math.min(5, Number(req.body?.maxIterations ?? 5)));
    const enableAiReview = req.body?.enableAiReview === true;
    const runId = await startBacktestOptimisation({
      symbol,
      windowDays,
      maxIterations,
      enableAiReview,
    });
    res.json(withSymbolDomain(symbol, checked.symbolDomain, {
      ok: true,
      runId,
      status: "running",
      promoted: false,
      message: "Backtest optimiser started. Results are stored as candidates and do not change runtime.",
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Backtest optimiser failed to start";
    res.status(500).json({ error: message });
  }
});

router.post("/calibration/runtime-model/:symbol/optimise-backtest/:runId/cancel", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const checked = assertCalibrationSymbol(symbol);
  if (!checked.ok) {
    res.status(400).json({ error: checked.error });
    return;
  }

  try {
    const runId = Number(req.params.runId);
    if (!Number.isInteger(runId) || runId <= 0) {
      res.status(400).json({ error: "Invalid optimiser run id" });
      return;
    }
    const reason = typeof req.body?.reason === "string" ? req.body.reason : "cancelled_by_user";
    const cancelled = await cancelBacktestOptimisationRun(runId, symbol, reason);
    if (!cancelled) {
      res.status(404).json({ error: "Optimiser run not found for symbol" });
      return;
    }
    res.json(withSymbolDomain(symbol, checked.symbolDomain, {
      ok: true,
      ...cancelled,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Backtest optimiser cancel failed";
    res.status(500).json({ error: message });
  }
});

router.get("/calibration/runtime-model/:symbol/optimise-backtest/:runId", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const checked = assertCalibrationSymbol(symbol);
  if (!checked.ok) {
    res.status(400).json({ error: checked.error });
    return;
  }

  try {
    const runId = Number(req.params.runId);
    if (!Number.isInteger(runId) || runId <= 0) {
      res.status(400).json({ error: "Invalid optimiser run id" });
      return;
    }
    const status = await getBacktestOptimisationStatus(runId);
    if (!status || status.run.symbol !== symbol) {
      res.status(404).json({ error: "Optimiser run not found for symbol" });
      return;
    }
    res.json(withSymbolDomain(symbol, checked.symbolDomain, { ok: true, ...status }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Backtest optimiser status failed";
    res.status(500).json({ error: message });
  }
});

router.get("/calibration/runtime-model/:symbol/parity-report", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const checked = assertCalibrationSymbol(symbol);
  if (!checked.ok) {
    res.status(400).json({ error: checked.error });
    return;
  }

  try {
    const endTs = Number(req.query.endTs ?? Math.floor(Date.now() / 1000));
    const startTs = Number(
      req.query.startTs ??
        (Math.floor(Date.now() / 1000) - Math.max(30, Math.min(730, Number(req.query.windowDays ?? 365))) * 86400),
    );
    const report = await buildCalibrationParityReport({ symbol, startTs, endTs });
    res.json(withSymbolDomain(symbol, checked.symbolDomain, report));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Parity report generation failed";
    res.status(500).json({ error: message });
  }
});

router.post("/calibration/runtime-model/:symbol/parity-report/run", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const checked = assertCalibrationSymbol(symbol);
  if (!checked.ok) {
    res.status(400).json({ error: checked.error });
    return;
  }

  try {
    const endTs = Number(req.body?.endTs ?? Math.floor(Date.now() / 1000));
    const startTs = Number(
      req.body?.startTs ??
        (Math.floor(Date.now() / 1000) - Math.max(30, Math.min(730, Number(req.body?.windowDays ?? 365))) * 86400),
    );
    const workerJobId = await createWorkerJob({
      taskType: "parity_run",
      serviceId: symbol,
      symbol,
      message: `Queued parity report for ${symbol}`,
      jobParams: { symbol, startTs, endTs },
    });
    res.json(withSymbolDomain(symbol, checked.symbolDomain, {
      ok: true,
      workerJobId,
      status: "queued",
      executionModel: "worker_service",
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Parity report queue failed";
    res.status(500).json({ error: message });
  }
});

router.get("/calibration/runtime-model/:symbol/runtime-trigger-validation", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const checked = assertCalibrationSymbol(symbol);
  if (!checked.ok) {
    res.status(400).json({ error: checked.error });
    return;
  }
  if (symbol !== "CRASH300") {
    res.status(400).json({ error: "Runtime trigger validation is currently available for CRASH300 only." });
    return;
  }

  try {
    const endTs = Number(req.query.endTs ?? Math.floor(Date.now() / 1000));
    const startTs = Number(
      req.query.startTs ??
        (Math.floor(Date.now() / 1000) - Math.max(30, Math.min(730, Number(req.query.windowDays ?? 30))) * 86400),
    );
    const report = await buildRuntimeTriggerValidationReport({ symbol, startTs, endTs });
    res.json(withSymbolDomain(symbol, checked.symbolDomain, report));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Runtime trigger validation failed";
    res.status(500).json({ error: message });
  }
});

router.post("/calibration/runtime-model/:symbol/runtime-trigger-validation/run", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const checked = assertCalibrationSymbol(symbol);
  if (!checked.ok) {
    res.status(400).json({ error: checked.error });
    return;
  }
  if (symbol !== "CRASH300") {
    res.status(400).json({ error: "Runtime trigger validation is currently available for CRASH300 only." });
    return;
  }

  try {
    const endTs = Number(req.body?.endTs ?? Math.floor(Date.now() / 1000));
    const startTs = Number(
      req.body?.startTs ??
        (Math.floor(Date.now() / 1000) - Math.max(30, Math.min(730, Number(req.body?.windowDays ?? 30))) * 86400),
    );
    const workerJobId = await createWorkerJob({
      taskType: "runtime_trigger_validation",
      serviceId: symbol,
      symbol,
      message: `Queued runtime trigger validation for ${symbol}`,
      jobParams: { symbol, startTs, endTs },
    });
    res.json(withSymbolDomain(symbol, checked.symbolDomain, {
      ok: true,
      workerJobId,
      status: "queued",
      executionModel: "worker_service",
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Runtime trigger validation queue failed";
    res.status(500).json({ error: message });
  }
});

router.get("/calibration/runtime-model/:symbol/pre-move-feature-snapshots", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const checked = assertCalibrationSymbol(symbol);
  if (!checked.ok) {
    res.status(400).json({ error: checked.error });
    return;
  }
  if (symbol !== "CRASH300") {
    res.status(400).json({ error: "Pre-move feature snapshots are currently available for CRASH300 only." });
    return;
  }

  try {
    const endTs = Number(req.query.endTs ?? Math.floor(Date.now() / 1000));
    const startTs = Number(
      req.query.startTs ??
        (Math.floor(Date.now() / 1000) - Math.max(30, Math.min(730, Number(req.query.windowDays ?? 365))) * 86400),
    );
    const envelope = await loadCrash300RuntimeEnvelope();
    if (!envelope.promotedModel) {
      res.status(409).json({ error: "CRASH300 runtime model missing/invalid. Cannot evaluate symbol service." });
      return;
    }

    const moves = await db
      .select({
        id: detectedMovesTable.id,
        startTs: detectedMovesTable.startTs,
        endTs: detectedMovesTable.endTs,
        direction: detectedMovesTable.direction,
        moveType: detectedMovesTable.moveType,
        movePct: detectedMovesTable.movePct,
        qualityTier: detectedMovesTable.qualityTier,
        leadInShape: detectedMovesTable.leadInShape,
        leadInBars: detectedMovesTable.leadInBars,
        rangeExpansion: detectedMovesTable.rangeExpansion,
        directionalPersistence: detectedMovesTable.directionalPersistence,
        holdingMinutes: detectedMovesTable.holdingMinutes,
      })
      .from(detectedMovesTable)
      .where(and(
        eq(detectedMovesTable.symbol, symbol),
        gte(detectedMovesTable.startTs, startTs),
        lte(detectedMovesTable.startTs, endTs),
      ))
      .orderBy(asc(detectedMovesTable.startTs));

    const parity = await runCrash300CalibrationParity({ startTs, endTs, mode: "parity" });
    const parityByMoveId = new Map(
      parity.verdicts.map((verdict) => [Number(verdict.moveId), verdict] as const),
    );

    const minCandleTs = moves.length > 0
      ? Math.min(...moves.map((move) => Math.max(0, Number(move.startTs) - 240 * 60)))
      : 0;
    const maxCandleTs = moves.length > 0
      ? Math.max(...moves.map((move) => Number(move.startTs) + 5 * 60))
      : 0;
    const candles = moves.length === 0
      ? []
      : await db
          .select({
            open: candlesTable.open,
            high: candlesTable.high,
            low: candlesTable.low,
            close: candlesTable.close,
            openTs: candlesTable.openTs,
            closeTs: candlesTable.closeTs,
          })
          .from(candlesTable)
          .where(and(
            eq(candlesTable.symbol, symbol),
            eq(candlesTable.timeframe, "1m"),
            eq(candlesTable.isInterpolated, false),
            gte(candlesTable.openTs, minCandleTs),
            lte(candlesTable.openTs, maxCandleTs),
          ))
          .orderBy(asc(candlesTable.openTs));

    const rows = moves.map((move) => {
      const moveCandles = candles.filter((candle) => candle.openTs <= Number(move.startTs) + 5 * 60);
      const verdict = parityByMoveId.get(Number(move.id));
      const snapshot = buildCrash300PreMoveSnapshots({
        symbol,
        runtimeModel: envelope.promotedModel!,
        candles: moveCandles,
        moveStartTs: Number(move.startTs),
        moveMetadata: {
          moveId: move.id,
          direction: move.direction,
          moveType: move.moveType,
          movePct: move.movePct,
          qualityTier: move.qualityTier,
          leadInShape: move.leadInShape,
          leadInBars: move.leadInBars,
          rangeExpansion: move.rangeExpansion,
          directionalPersistence: move.directionalPersistence,
          startTs: move.startTs,
          endTs: move.endTs,
          holdingMinutes: move.holdingMinutes,
          trendPersistenceScore: verdict?.parityDistanceScore ?? null,
        },
        selectedRuntimeFamily: verdict?.runtimeFamily ?? verdict?.selectedRuntimeFamily ?? null,
        selectedBucket: verdict?.selectedBucket ?? null,
      });

      const t0Context = Array.isArray(snapshot.contextSnapshots)
        ? snapshot.contextSnapshots.find((row) => Number(row["offsetBars"]) === 0) ?? snapshot.contextSnapshots[snapshot.contextSnapshots.length - 1]
        : null;
      const t0Trigger = Array.isArray(snapshot.triggerSnapshots)
        ? snapshot.triggerSnapshots.find((row) => Number(row["offsetBars"]) === 0) ?? snapshot.triggerSnapshots[snapshot.triggerSnapshots.length - 1]
        : null;

      return {
        ...snapshot,
        trendPersistenceScore: Number(t0Context?.["trendPersistenceScore"] ?? 0),
        recoveryQualityScore: Number(t0Context?.["recoveryQualityScore"] ?? 0),
        compressionToExpansionScore: Number(t0Context?.["compressionToExpansionScore"] ?? 0),
        crashRecencyScore: Number(t0Context?.["crashRecencyScore"] ?? 0),
        barsSinceLastCrash: Number(t0Context?.["barsSinceLastCrash"] ?? 0),
        priceDistanceFromLastCrashLowPct: Number(t0Context?.["priceDistanceFromLastCrashLowPct"] ?? 0),
        recoveryFromLastCrashPct: Number(t0Context?.["recoveryFromLastCrashPct"] ?? 0),
        triggerStrengthScore: Number(t0Trigger?.["triggerStrengthScore"] ?? 0),
        oneBarReturnPct: Number(t0Trigger?.["oneBarReturnPct"] ?? 0),
        threeBarReturnPct: Number(t0Trigger?.["threeBarReturnPct"] ?? 0),
        fiveBarReturnPct: Number(t0Trigger?.["fiveBarReturnPct"] ?? 0),
        candleBodyPct: Number(t0Trigger?.["candleBodyPct"] ?? 0),
        closeLocationInRangePct: Number(t0Trigger?.["closeLocationInRangePct"] ?? 0),
      };
    });

    res.json(withSymbolDomain(symbol, checked.symbolDomain, {
      ok: true,
      generatedAt: new Date().toISOString(),
      promotedModelRunId: envelope.promotedModel.sourceRunId ?? null,
      stagedModelRunId: envelope.stagedModel?.sourceRunId ?? null,
      window: { startTs, endTs },
      count: rows.length,
      snapshots: rows,
      aggregates: summarizeCrash300PreMoveSnapshots(rows as Array<Record<string, unknown>>),
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Pre-move feature snapshot generation failed";
    res.status(500).json({ error: message });
  }
});

router.get("/calibration/runtime-model/:symbol/phase-identifiers", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const checked = assertCalibrationSymbol(symbol);
  if (!checked.ok) {
    res.status(400).json({ error: checked.error });
    return;
  }
  if (symbol !== "CRASH300") {
    res.status(400).json({ error: "Phase identifiers are currently available for CRASH300 only." });
    return;
  }

  try {
    const report = await buildCrash300PhaseIdentifierReport({
      startTs: req.query.startTs != null ? Number(req.query.startTs) : null,
      endTs: req.query.endTs != null ? Number(req.query.endTs) : null,
      limit: req.query.limit != null ? Number(req.query.limit) : null,
      includeMoves: req.query.includeMoves == null ? true : String(req.query.includeMoves).toLowerCase() !== "false",
      includeAggregates: req.query.includeAggregates == null ? true : String(req.query.includeAggregates).toLowerCase() !== "false",
    });
    res.json(withSymbolDomain(symbol, checked.symbolDomain, {
      ok: true,
      ...report,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Phase identifier report generation failed";
    res.status(500).json({ error: message });
  }
});

router.get("/calibration/runtime-model/:symbol/phase-identifiers/summary", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const checked = assertCalibrationSymbol(symbol);
  if (!checked.ok) {
    res.status(400).json({ error: checked.error });
    return;
  }
  if (symbol !== "CRASH300") {
    res.status(400).json({ error: "Phase identifier summaries are currently available for CRASH300 only." });
    return;
  }

  try {
    const report = await buildCrash300PhaseIdentifierReport({
      startTs: req.query.startTs != null ? Number(req.query.startTs) : null,
      endTs: req.query.endTs != null ? Number(req.query.endTs) : null,
      limit: req.query.limit != null ? Number(req.query.limit) : null,
      includeMoves: false,
      includeAggregates: true,
    });
    res.json(withSymbolDomain(symbol, checked.symbolDomain, {
      ok: true,
      symbol: report.symbol,
      generatedAt: report.generatedAt,
      source: report.source,
      window: report.window,
      promotedModelRunId: report.promotedModelRunId,
      detectedMoveCount: report.detectedMoveCount,
      aggregates: report.aggregates,
      diagnostics: report.diagnostics,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Phase identifier summary generation failed";
    res.status(500).json({ error: message });
  }
});

router.get("/calibration/runtime-model/:symbol/phase-identifiers/move/:moveId", async (req, res): Promise<void> => {
  const { symbol, moveId } = req.params;
  const checked = assertCalibrationSymbol(symbol);
  if (!checked.ok) {
    res.status(400).json({ error: checked.error });
    return;
  }
  if (symbol !== "CRASH300") {
    res.status(400).json({ error: "Single-move phase identifiers are currently available for CRASH300 only." });
    return;
  }

  try {
    const report = await buildCrash300PhaseIdentifierReport({
      startTs: req.query.startTs != null ? Number(req.query.startTs) : null,
      endTs: req.query.endTs != null ? Number(req.query.endTs) : null,
      includeMoves: true,
      includeAggregates: false,
    });
    const numericMoveId = Number(moveId);
    const row = report.moves.find((move) => move.moveId === numericMoveId) ?? null;
    if (!row) {
      res.status(404).json({ error: `No CRASH300 phase identifier report row found for move ${moveId}` });
      return;
    }
    res.json(withSymbolDomain(symbol, checked.symbolDomain, {
      ok: true,
      symbol: report.symbol,
      generatedAt: report.generatedAt,
      source: report.source,
      window: report.window,
      promotedModelRunId: report.promotedModelRunId,
      move: row,
      diagnostics: report.diagnostics,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Single-move phase identifier generation failed";
    res.status(500).json({ error: message });
  }
});

router.post("/calibration/runtime-model/:symbol/optimise-backtest/:runId/stage-winner", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const checked = assertCalibrationSymbol(symbol);
  if (!checked.ok) {
    res.status(400).json({ error: checked.error });
    return;
  }

  try {
    const runId = Number(req.params.runId);
    if (!Number.isInteger(runId) || runId <= 0) {
      res.status(400).json({ error: "Invalid optimiser run id" });
      return;
    }
    const staged = await stageBacktestOptimisationWinner(runId);
    if (staged.model.symbol !== symbol) {
      res.status(409).json({ error: "Optimiser run symbol mismatch" });
      return;
    }
    res.json(withSymbolDomain(symbol, checked.symbolDomain, {
      ok: true,
      staged: true,
      promoted: false,
      runtimeChanged: false,
      model: staged.model,
      selected: staged.selected,
      message: "Optimised winner staged only. Runtime remains unchanged until explicit promotion.",
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Backtest optimiser stage failed";
    res.status(500).json({ error: message });
  }
});

router.get("/calibration/latest-run/:symbol", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const checked = assertCalibrationSymbol(symbol);
  if (!checked.ok) {
    res.status(400).json({ error: checked.error });
    return;
  }
  const { symbolDomain } = checked;

  try {
    const run = await getLatestPassRun(symbol);
    if (!run) {
      res.status(404).json({ error: `No calibration runs found for ${symbol}` });
      return;
    }
    res.json(withSymbolDomain(symbol, symbolDomain, run));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Latest run fetch failed";
    res.status(500).json({ error: message });
  }
});

export default router;
