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
import { db } from "@workspace/db";
import { movePrecursorPassesTable, moveBehaviorPassesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
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
import { deriveSymbolBehaviorProfile } from "../core/backtest/behaviorProfiler.js";

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
    const resolvedMoveType = moveType && String(moveType) === "all" ? undefined : (moveType ? String(moveType) : undefined);
    const moves = await getDetectedMoves(
      symbol,
      resolvedMoveType,
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
    if (!raw) return undefined;
    const normalized = String(raw);
    return normalized === "all" ? undefined : normalized;
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
  // :strategy and legacy :moveType callers share the same URL shape and value space.
  // Keep a single canonical route to avoid ambiguous duplicate route registration.
  await handleProfileRequest(req.params.symbol, req.params.strategy, res);
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
// Optional ?type= param selects which slice to export:
//   type=moves      — detected moves for this symbol
//   type=passes     — all calibration pass runs for this symbol
//   type=profile    — all calibration profiles (all move types)
//   type=comparison — aggregate + engine coverage comparison summary
//   (no type)       — full calibration export (existing behaviour)

router.get("/calibration/export/:symbol", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  if (!VALID_SYMBOLS.includes(symbol as typeof ACTIVE_SYMBOLS[number])) {
    res.status(400).json({ error: `Invalid symbol. Valid: ${VALID_SYMBOLS.join(", ")}` });
    return;
  }

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
      response = { symbol, exportType: "moves", exportedAt: new Date().toISOString(), moveCount: moves.length, moves };
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
        symbol,
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
      response = { symbol, exportType: "profile", exportedAt: new Date().toISOString(), profileCount: profiles.length, profiles };
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
        symbol,
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
      const [exportData, moves] = await Promise.all([
        getFullCalibrationExport(symbol),
        getDetectedMoves(symbol),
      ]);
      response = { ...exportData, detected_moves: moves, detected_moves_count: moves.length };
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
