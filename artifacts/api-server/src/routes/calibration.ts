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
import { movePrecursorPassesTable, moveBehaviorPassesTable, calibrationPassRunsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { detectAndStoreMoves, getDetectedMoves, clearCalibrationArtifactsForSymbol } from "../core/calibration/moveDetector.js";
import {
  startCalibrationPassesBackground,
  getPassRunStatus,
  getLatestPassRun,
  getAllPassRuns,
  getRunningPassRunForSymbol,
  type PassName,
} from "../core/calibration/calibrationPassRunner.js";
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
import { getComprehensiveIntegrityReport, reconcileSymbolData } from "../core/dataIntegrity.js";
import { getDerivClientWithDbToken } from "../infrastructure/deriv.js";
import {
  assertCalibrationSymbol,
  type SymbolDomain,
} from "../core/calibration/symbolDomain.js";
import { getLatestSymbolResearchProfile } from "../core/calibration/symbolResearchProfile.js";

const router: IRouter = Router();

const VALID_PASS_NAMES: PassName[] = ["precursor", "trigger", "behavior", "extraction", "all"];
const VALID_TIERS = ["A", "B", "C", "D"];
const VALID_MOVE_TYPES = ["breakout", "continuation", "reversal", "unknown", "boom_expansion", "crash_expansion", "all"];
const MAX_BASE_1M_GAPS_FOR_HEALTHY = 0;
const MIN_BASE_1M_COVERAGE_PCT = 70;
const MIN_BASE_1M_CANDLES = 1_000;

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
// Removes profiles, precursor/behavior passes, calibration_pass_runs, and detected_moves.

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
      cleared: ["profiles", "precursor_passes", "behavior_passes", "pass_runs", "detected_moves"],
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

    const client = await getDerivClientWithDbToken();
    const reconcile = await reconcileSymbolData(symbol, client);
    const integrity = await getComprehensiveIntegrityReport(symbol, Math.max(365, Number(windowDays)));

    const integrityHealthy =
      integrity.base1mCount >= MIN_BASE_1M_CANDLES &&
      integrity.base1mGapCount <= MAX_BASE_1M_GAPS_FOR_HEALTHY &&
      integrity.base1mCoveragePct >= MIN_BASE_1M_COVERAGE_PCT;

    if (!integrityHealthy) {
      res.status(422).json(withSymbolDomain(symbol, symbolDomain, {
        ok: false,
        error: "Calibration aborted: data integrity is unhealthy after reconcile.",
        failureReason: {
          kind: "integrity_unhealthy_after_reconcile",
          minBase1mCandles: MIN_BASE_1M_CANDLES,
          minCoveragePct: MIN_BASE_1M_COVERAGE_PCT,
          maxAllowedGaps: MAX_BASE_1M_GAPS_FOR_HEALTHY,
          base1mCount: integrity.base1mCount,
          base1mCoveragePct: integrity.base1mCoveragePct,
          base1mGapCount: integrity.base1mGapCount,
          base1mInterpolatedCount: integrity.base1mInterpolatedCount,
        },
        reconcile,
        integrity,
      }));
      return;
    }

    const detected = await detectAndStoreMoves(symbol, Number(windowDays), Number(minMovePct), true);
    const { runId, totalMoves } = await startCalibrationPassesBackground({
      symbol,
      windowDays: Number(windowDays),
      passName: "all",
      minTier: minTier ? (String(minTier) as "A" | "B" | "C" | "D") : undefined,
      moveType: normalizedMoveType,
      maxMoves: maxMoves ? Number(maxMoves) : undefined,
      force: Boolean(force),
      continueOnMoveErrors: false,
    });
    const [runRow] = await db
      .select({ metaJson: calibrationPassRunsTable.metaJson })
      .from(calibrationPassRunsTable)
      .where(eq(calibrationPassRunsTable.id, runId))
      .limit(1);
    const existingMeta =
      runRow?.metaJson && typeof runRow.metaJson === "object"
        ? (runRow.metaJson as Record<string, unknown>)
        : {};
    await db
      .update(calibrationPassRunsTable)
      .set({
        metaJson: {
          ...existingMeta,
          stage: "AI Passes",
          preflight: {
            readyForCalibration: integrityHealthy,
            integrityStatus: integrityHealthy ? "healthy" : "reconcile_required",
          },
          reconcileSummary: reconcile,
          integritySummary: integrity,
          detectSummary: detected,
        } as never,
      })
      .where(eq(calibrationPassRunsTable.id, runId));

    res.json(withSymbolDomain(symbol, symbolDomain, {
      ok: true,
      runId,
      status: "running",
      totalMoves,
      stages: [
        "Data Integrity",
        "Move Detection",
        "AI Passes",
        "Extraction Model",
        "Research Profile Complete",
      ],
      reconcileSummary: reconcile,
      integritySummary: integrity,
      detectSummary: detected,
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
  // strategyFamily maps to moveType (same concept — "breakout"|"continuation"|"reversal"|"unknown"|"all")
  // passNumber (1=precursor, 2=trigger, 3=behavior, 4=extraction) maps to passName.
  const PASS_NUMBER_MAP: Record<number, PassName> = { 1: "precursor", 2: "trigger", 3: "behavior", 4: "extraction" };
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

    const { runId, totalMoves } = await startCalibrationPassesBackground({
      symbol,
      windowDays,
      passName: resolvedPassName,
      minTier: minTier as "A" | "B" | "C" | "D" | undefined,
      moveType: resolvedMoveType,
      maxMoves,
      force,
      continueOnMoveErrors,
    });
    res.json(withSymbolDomain(symbol, symbolDomain, { ok: true, runId, status: "running", totalMoves }));
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
  const VALID_EXPORT_TYPES = ["moves", "passes", "profile", "comparison"];
  if (exportType && !VALID_EXPORT_TYPES.includes(exportType)) {
    res.status(400).json({ error: `Invalid export type. Valid: ${VALID_EXPORT_TYPES.join(", ")} (or omit for full export)` });
    return;
  }

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
      const [runs, profiles, precursorRaw, behaviorRaw] = await Promise.all([
        getAllPassRuns(symbol),
        getAllCalibrationProfiles(symbol),
        db.select().from(movePrecursorPassesTable).where(eq(movePrecursorPassesTable.symbol, symbol)),
        db.select().from(moveBehaviorPassesTable).where(eq(moveBehaviorPassesTable.symbol, symbol)),
      ]);
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
        },
        profileSummaries: {
          description: "Aggregated calibration profiles per move type from all passes (extraction pass output).",
          profileCount: profiles.length,
          profiles,
        },
      };
      filename = `calibration_passes_${symbol}_${ts}.json`;

    } else if (exportType === "profile") {
      const profiles = await getAllCalibrationProfiles(symbol);
      response = withSymbolDomain(symbol, symbolDomain, {
        exportType: "profile",
        exportedAt: new Date().toISOString(),
        profileCount: profiles.length,
        profiles,
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

// ── GET /api/calibration/latest-run/:symbol ───────────────────────────────────

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
