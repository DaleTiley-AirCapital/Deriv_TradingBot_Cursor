/**
 * Calibration API Routes — Move-First Calibration System
 *
 * POST /api/calibration/detect-moves/:symbol          — run structural move detection, store to DB
 * GET  /api/calibration/moves/:symbol                 — list detected moves (with filters)
 * POST /api/calibration/run-passes/:symbol            — start async AI pass pipeline
 * GET  /api/calibration/run-status/:runId             — poll run progress
 * GET  /api/calibration/aggregate/:symbol             — deterministic aggregate from pass results
 * GET  /api/calibration/profile/:symbol/:moveType     — stored calibration profile for symbol+type
 * GET  /api/calibration/profiles/:symbol              — all profiles for a symbol
 * GET  /api/calibration/engine/:symbol                — engine coverage calibration (read-only)
 * GET  /api/calibration/scoring/:symbol               — scoring calibration by tier (read-only)
 * GET  /api/calibration/health/:symbol                — trade health calibration (read-only)
 * GET  /api/calibration/export/:symbol                — full calibration export (JSON download)
 *
 * ALL outputs are read-only feeddown — nothing here modifies live engine or allocator behavior.
 */

import { Router, type IRouter } from "express";
import { ACTIVE_SYMBOLS } from "../core/engineTypes.js";
import { detectAndStoreMoves, getDetectedMoves } from "../core/calibration/moveDetector.js";
import {
  runCalibrationPasses,
  getPassRunStatus,
  getLatestPassRun,
  getAllPassRuns,
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

const router: IRouter = Router();

const VALID_SYMBOLS = [...ACTIVE_SYMBOLS];
const VALID_PASS_NAMES: PassName[] = ["precursor", "trigger", "behavior", "extraction", "all"];
const VALID_TIERS = ["A", "B", "C", "D"];
const VALID_MOVE_TYPES = ["breakout", "continuation", "reversal", "unknown", "all"];

// ── POST /api/calibration/detect-moves/:symbol ────────────────────────────────

router.post("/calibration/detect-moves/:symbol", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  if (!VALID_SYMBOLS.includes(symbol as typeof ACTIVE_SYMBOLS[number])) {
    res.status(400).json({ error: `Invalid symbol. Valid: ${VALID_SYMBOLS.join(", ")}` });
    return;
  }

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
    res.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Move detection failed";
    console.error(`[calibration/detect-moves/${symbol}] error:`, message);
    res.status(500).json({ error: message });
  }
});

// ── GET /api/calibration/moves/:symbol ────────────────────────────────────────

router.get("/calibration/moves/:symbol", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  if (!VALID_SYMBOLS.includes(symbol as typeof ACTIVE_SYMBOLS[number])) {
    res.status(400).json({ error: `Invalid symbol. Valid: ${VALID_SYMBOLS.join(", ")}` });
    return;
  }

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
    const moves = await getDetectedMoves(
      symbol,
      moveType ? String(moveType) : undefined,
      minTier ? (String(minTier) as "A" | "B" | "C" | "D") : undefined,
    );
    res.json({ symbol, moveCount: moves.length, moves });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch moves";
    res.status(500).json({ error: message });
  }
});

// ── POST /api/calibration/run-passes/:symbol ──────────────────────────────────
// Starts the async AI pass pipeline. Runs synchronously (awaits completion).
// For large windows, consider polling /run-status/:runId.

router.post("/calibration/run-passes/:symbol", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  if (!VALID_SYMBOLS.includes(symbol as typeof ACTIVE_SYMBOLS[number])) {
    res.status(400).json({ error: `Invalid symbol. Valid: ${VALID_SYMBOLS.join(", ")}` });
    return;
  }

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
    return raw ? String(raw) : undefined;
  })();
  const minTier:  string | undefined = body.minTier ? String(body.minTier) : undefined;
  const maxMoves: number | undefined = body.maxMoves ? Number(body.maxMoves) : undefined;
  const force:    boolean            = Boolean(body.force ?? false);

  if (!VALID_PASS_NAMES.includes(resolvedPassName)) {
    res.status(400).json({ error: `Invalid passName/passNumber. Valid passNames: ${VALID_PASS_NAMES.join(", ")}` });
    return;
  }
  if (minTier && !VALID_TIERS.includes(minTier)) {
    res.status(400).json({ error: `Invalid minTier. Valid: A, B, C, D` });
    return;
  }

  try {
    const result = await runCalibrationPasses({
      symbol,
      windowDays,
      passName:   resolvedPassName,
      minTier:    minTier as "A" | "B" | "C" | "D" | undefined,
      moveType:   resolvedMoveType,
      maxMoves,
      force,
    });
    res.json({ ok: true, ...result });
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
    res.json(status);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Status fetch failed";
    res.status(500).json({ error: message });
  }
});

// ── GET /api/calibration/runs/:symbol ─────────────────────────────────────────
// All pass runs for a symbol, most-recent first.

router.get("/calibration/runs/:symbol", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  if (!VALID_SYMBOLS.includes(symbol as typeof ACTIVE_SYMBOLS[number])) {
    res.status(400).json({ error: `Invalid symbol. Valid: ${VALID_SYMBOLS.join(", ")}` });
    return;
  }

  try {
    const runs = await getAllPassRuns(symbol);
    res.json({ ok: true, symbol, runCount: runs.length, runs });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Runs fetch failed";
    res.status(500).json({ error: message });
  }
});

// ── GET /api/calibration/aggregate/:symbol ────────────────────────────────────

router.get("/calibration/aggregate/:symbol", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  if (!VALID_SYMBOLS.includes(symbol as typeof ACTIVE_SYMBOLS[number])) {
    res.status(400).json({ error: `Invalid symbol. Valid: ${VALID_SYMBOLS.join(", ")}` });
    return;
  }

  try {
    const aggregate = await buildCalibrationAggregate(symbol);
    res.json({ ok: true, ...aggregate });
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
  if (!VALID_SYMBOLS.includes(symbol as typeof ACTIVE_SYMBOLS[number])) {
    res.status(400).json({ error: `Invalid symbol. Valid: ${VALID_SYMBOLS.join(", ")}` });
    return;
  }
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
    res.json({ ok: true, ...profile });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Profile fetch failed";
    res.status(500).json({ error: message });
  }
}

router.get("/calibration/profile/:symbol/:strategy", async (req, res): Promise<void> => {
  await handleProfileRequest(req.params.symbol, req.params.strategy, res);
});

// Legacy alias (kept for backward compat — :moveType and :strategy are the same value space)
router.get("/calibration/profile/:symbol/:moveType", async (req, res): Promise<void> => {
  await handleProfileRequest(req.params.symbol, req.params.moveType, res);
});

// ── GET /api/calibration/profiles/:symbol ─────────────────────────────────────

router.get("/calibration/profiles/:symbol", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  if (!VALID_SYMBOLS.includes(symbol as typeof ACTIVE_SYMBOLS[number])) {
    res.status(400).json({ error: `Invalid symbol. Valid: ${VALID_SYMBOLS.join(", ")}` });
    return;
  }

  try {
    const profiles = await getAllCalibrationProfiles(symbol);
    res.json({ symbol, profileCount: profiles.length, profiles });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Profiles fetch failed";
    res.status(500).json({ error: message });
  }
});

// ── GET /api/calibration/engine/:symbol ───────────────────────────────────────

router.get("/calibration/engine/:symbol", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  if (!VALID_SYMBOLS.includes(symbol as typeof ACTIVE_SYMBOLS[number])) {
    res.status(400).json({ error: `Invalid symbol. Valid: ${VALID_SYMBOLS.join(", ")}` });
    return;
  }

  try {
    const calibration = await getEngineCalibration(symbol);
    res.json({ symbol, engines: calibration });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Engine calibration fetch failed";
    res.status(500).json({ error: message });
  }
});

// ── GET /api/calibration/scoring/:symbol ──────────────────────────────────────

router.get("/calibration/scoring/:symbol", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  if (!VALID_SYMBOLS.includes(symbol as typeof ACTIVE_SYMBOLS[number])) {
    res.status(400).json({ error: `Invalid symbol. Valid: ${VALID_SYMBOLS.join(", ")}` });
    return;
  }

  try {
    const calibration = await getScoringCalibration(symbol);
    res.json(calibration);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Scoring calibration fetch failed";
    res.status(500).json({ error: message });
  }
});

// ── GET /api/calibration/health/:symbol ───────────────────────────────────────

router.get("/calibration/health/:symbol", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  if (!VALID_SYMBOLS.includes(symbol as typeof ACTIVE_SYMBOLS[number])) {
    res.status(400).json({ error: `Invalid symbol. Valid: ${VALID_SYMBOLS.join(", ")}` });
    return;
  }

  try {
    const calibration = await getTradeHealthCalibration(symbol);
    res.json(calibration);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Health calibration fetch failed";
    res.status(500).json({ error: message });
  }
});

// ── GET /api/calibration/export/:symbol ───────────────────────────────────────

router.get("/calibration/export/:symbol", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  if (!VALID_SYMBOLS.includes(symbol as typeof ACTIVE_SYMBOLS[number])) {
    res.status(400).json({ error: `Invalid symbol. Valid: ${VALID_SYMBOLS.join(", ")}` });
    return;
  }

  const asDownload = req.query.download === "true";

  try {
    const [exportData, moves] = await Promise.all([
      getFullCalibrationExport(symbol),
      getDetectedMoves(symbol),
    ]);
    const response = {
      ...exportData,
      detected_moves: moves,
      detected_moves_count: moves.length,
    };
    if (asDownload) {
      res.setHeader("Content-Disposition", `attachment; filename="calibration_${symbol}_${new Date().toISOString().slice(0, 10)}.json"`);
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
  if (!VALID_SYMBOLS.includes(symbol as typeof ACTIVE_SYMBOLS[number])) {
    res.status(400).json({ error: `Invalid symbol. Valid: ${VALID_SYMBOLS.join(", ")}` });
    return;
  }

  try {
    const run = await getLatestPassRun(symbol);
    if (!run) {
      res.status(404).json({ error: `No calibration runs found for ${symbol}` });
      return;
    }
    res.json(run);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Latest run fetch failed";
    res.status(500).json({ error: message });
  }
});

export default router;
