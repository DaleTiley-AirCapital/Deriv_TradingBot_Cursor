/**
 * Behavior Profile API Routes
 *
 * POST /api/behavior/profile                    — run backtest + derive profiles for symbol(s)
 * POST /api/behavior/profile/:symbol            — run backtest + derive profile for one symbol
 * POST /api/behavior/profile/:symbol/:engine    — (re)build profile for a specific engine
 * GET  /api/behavior/profile/:symbol            — get cached profile for a symbol
 * GET  /api/behavior/profile/:symbol/:engine    — get single engine profile
 * GET  /api/behavior/export/:symbol             — export derived behavior profile as JSON (for download)
 * GET  /api/behavior/export/:symbol/:engine     — export derived engine profile as JSON (for download)
 * GET  /api/behavior/events/:symbol             — raw behavior events (debug / internal use)
 * GET  /api/behavior/events/:symbol/:engine     — raw events filtered by engine
 * POST /api/behavior/persist/:symbol            — persist derived profile to platformState
 */
import { Router, type IRouter } from "express";
import { db, platformStateTable } from "@workspace/db";
import {
  runV3Backtest,
  runV3BacktestMulti,
  type V3BacktestRequest,
} from "../core/backtest/backtestRunner.js";
import {
  getBehaviorEvents,
  clearBehaviorEvents,
} from "../core/backtest/behaviorCapture.js";
import { reloadLiveBehaviorEventsForSymbol } from "../core/backtest/behaviorDb.js";
import {
  deriveEngineProfile,
  deriveSymbolBehaviorProfile,
  type BehaviorProfileSummary,
} from "../core/backtest/behaviorProfiler.js";
import { ACTIVE_SYMBOLS } from "../core/engineTypes.js";

const router: IRouter = Router();

function validateMode(mode: unknown): mode is "paper" | "demo" | "real" | undefined {
  return mode === undefined || mode === "paper" || mode === "demo" || mode === "real";
}

// ── POST /api/behavior/profile ────────────────────────────────────────────────

/**
 * Run a backtest to populate behavior events, then derive the profile.
 * Body: { symbol?: string, startTs?: number, endTs?: number, minScore?: number, mode?: "paper"|"demo"|"real" }
 * symbol defaults to "all" (derives profiles for all 4 active symbols).
 */
router.post("/behavior/profile", async (req, res): Promise<void> => {
  const { symbol = "all", startTs, endTs, minScore, mode } = req.body ?? {};

  const validSymbols = [...ACTIVE_SYMBOLS, "all"];
  if (!validSymbols.includes(symbol)) {
    res.status(400).json({ error: `Invalid symbol. Use: ${validSymbols.join(", ")}` });
    return;
  }
  if (!validateMode(mode)) {
    res.status(400).json({ error: "mode must be one of: paper, demo, real" });
    return;
  }

  try {
    const symbols = symbol === "all" ? [...ACTIVE_SYMBOLS] : [symbol as string];

    // Clear in-memory events for each symbol, then reload durable live events
    // so that existing live-trade history is merged into the new profile build.
    for (const sym of symbols) {
      clearBehaviorEvents(sym);
      await reloadLiveBehaviorEventsForSymbol(sym);
    }

    if (symbol === "all") {
      await runV3BacktestMulti(symbols, startTs, endTs, minScore, mode);
    } else {
      await runV3Backtest({ symbol: symbol as string, startTs, endTs, minScore, mode });
    }

    const profiles = symbols
      .map(sym => deriveSymbolBehaviorProfile(sym))
      .filter((p): p is BehaviorProfileSummary => p !== null);

    res.json({ ok: true, profileCount: profiles.length, profiles });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Behavior profile derivation failed";
    console.error("[behavior/profile] error:", message);
    res.status(500).json({ error: message });
  }
});

// ── POST /api/behavior/profile/:symbol ───────────────────────────────────────

/**
 * Build or refresh the behavior profile for a specific symbol.
 * Body: { startTs?, endTs?, minScore?, mode? }
 */
router.post("/behavior/profile/:symbol", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const { startTs, endTs, minScore, mode } = req.body ?? {};

  if (!ACTIVE_SYMBOLS.includes(symbol as typeof ACTIVE_SYMBOLS[number])) {
    res.status(400).json({ error: `Invalid symbol. Use one of: ${ACTIVE_SYMBOLS.join(", ")}` });
    return;
  }
  if (!validateMode(mode)) {
    res.status(400).json({ error: "mode must be one of: paper, demo, real" });
    return;
  }

  try {
    clearBehaviorEvents(symbol);
    await reloadLiveBehaviorEventsForSymbol(symbol);
    const req2: V3BacktestRequest = { symbol, startTs, endTs, minScore, mode };
    await runV3Backtest(req2);
    const profile = deriveSymbolBehaviorProfile(symbol);
    if (!profile) {
      res.status(200).json({ ok: true, profileCount: 0, profiles: [], message: "No events captured — insufficient candle data?" });
      return;
    }
    res.json({ ok: true, profileCount: 1, profiles: [profile] });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Behavior profile build failed";
    console.error(`[behavior/profile/${symbol}] error:`, message);
    res.status(500).json({ error: message });
  }
});

// ── POST /api/behavior/profile/:symbol/:engine ────────────────────────────────

/**
 * Build or refresh the behavior profile for a specific symbol+engine pair.
 * Runs a full symbol backtest but returns only the requested engine's profile.
 * Body: { startTs?, endTs?, minScore?, mode? }
 */
router.post("/behavior/profile/:symbol/:engine", async (req, res): Promise<void> => {
  const { symbol, engine } = req.params;
  const { startTs, endTs, minScore, mode } = req.body ?? {};

  if (!ACTIVE_SYMBOLS.includes(symbol as typeof ACTIVE_SYMBOLS[number])) {
    res.status(400).json({ error: `Invalid symbol. Use one of: ${ACTIVE_SYMBOLS.join(", ")}` });
    return;
  }
  if (!validateMode(mode)) {
    res.status(400).json({ error: "mode must be one of: paper, demo, real" });
    return;
  }

  try {
    // Clear only this engine's events so other engines aren't affected, then
    // reload durable live events for this symbol so live-trade history survives.
    clearBehaviorEvents(symbol, engine);
    await reloadLiveBehaviorEventsForSymbol(symbol);
    // Must re-run full symbol backtest (engines for a symbol are evaluated together)
    const req2: V3BacktestRequest = { symbol, startTs, endTs, minScore, mode };
    await runV3Backtest(req2);
    const profile = deriveEngineProfile(symbol, engine);
    if (!profile) {
      res.status(404).json({ error: `No behavior data captured for ${symbol}/${engine}` });
      return;
    }
    res.json({ ok: true, profile });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Engine behavior build failed";
    console.error(`[behavior/profile/${symbol}/${engine}] error:`, message);
    res.status(500).json({ error: message });
  }
});

// ── GET /api/behavior/profile/:symbol ────────────────────────────────────────

router.get("/behavior/profile/:symbol", (req, res): void => {
  const { symbol } = req.params;
  const profile = deriveSymbolBehaviorProfile(symbol);
  if (!profile) {
    res.status(404).json({
      error: `No behavior data for symbol "${symbol}". Run POST /api/behavior/profile first.`,
    });
    return;
  }
  res.json(profile);
});

// ── GET /api/behavior/profile/:symbol/:engine ─────────────────────────────────

router.get("/behavior/profile/:symbol/:engine", (req, res): void => {
  const { symbol, engine } = req.params;
  const profile = deriveEngineProfile(symbol, engine);
  if (!profile) {
    res.status(404).json({
      error: `No behavior data for ${symbol}/${engine}. Run POST /api/behavior/profile first.`,
    });
    return;
  }
  res.json(profile);
});

// ── GET /api/behavior/export/:symbol ─────────────────────────────────────────
// Returns the derived behavior profile (not raw events) for downstream
// consumption by the frontend and AI suggestion layer.

router.get("/behavior/export/:symbol", (req, res): void => {
  const { symbol } = req.params;
  const profile = deriveSymbolBehaviorProfile(symbol);
  if (!profile) {
    res.status(404).json({
      error: `No behavior data for symbol "${symbol}". Run POST /api/behavior/profile first.`,
    });
    return;
  }
  res.json(profile);
});

// ── GET /api/behavior/export/:symbol/:engine ──────────────────────────────────
// Returns the derived engine behavior profile (not raw events).

router.get("/behavior/export/:symbol/:engine", (req, res): void => {
  const { symbol, engine } = req.params;
  const profile = deriveEngineProfile(symbol, engine);
  if (!profile) {
    res.status(404).json({
      error: `No behavior data for ${symbol}/${engine}. Run POST /api/behavior/profile first.`,
    });
    return;
  }
  res.json(profile);
});

// ── GET /api/behavior/events/:symbol ─────────────────────────────────────────
// Raw behavior events — for debugging and internal diagnostics only.

router.get("/behavior/events/:symbol", (req, res): void => {
  const { symbol } = req.params;
  const events = getBehaviorEvents(symbol);
  res.json({ symbol, eventCount: events.length, events });
});

// ── GET /api/behavior/events/:symbol/:engine ──────────────────────────────────
// Raw events filtered to a specific engine.

router.get("/behavior/events/:symbol/:engine", (req, res): void => {
  const { symbol, engine } = req.params;
  const events = getBehaviorEvents(symbol, engine);
  res.json({ symbol, engineName: engine, eventCount: events.length, events });
});

// ── POST /api/behavior/persist/:symbol ───────────────────────────────────────

/**
 * Persist the current in-memory behavior profile for a symbol to platformStateTable.
 * Also updates the behavior_watch_scan_interval_ms key to the recommended cadence.
 * The scheduler reads behavior_watch_scan_interval_ms to tune watch-mode cadence.
 */
router.post("/behavior/persist/:symbol", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const profile = deriveSymbolBehaviorProfile(symbol);
  if (!profile) {
    res.status(404).json({ error: `No behavior data for ${symbol}` });
    return;
  }

  try {
    const profileKey = `behavior_profile_${symbol}`;
    const profileJson = JSON.stringify(profile);
    await db.insert(platformStateTable)
      .values({ key: profileKey, value: profileJson })
      .onConflictDoUpdate({ target: platformStateTable.key, set: { value: profileJson, updatedAt: new Date() } });

    // Update recommended scan cadence for this symbol so scheduler can adapt watch mode
    const cadenceKey = `behavior_watch_cadence_${symbol}`;
    const cadenceMs = String(profile.recommendedScanCadenceMins * 60 * 1000);
    await db.insert(platformStateTable)
      .values({ key: cadenceKey, value: cadenceMs })
      .onConflictDoUpdate({ target: platformStateTable.key, set: { value: cadenceMs, updatedAt: new Date() } });

    res.json({
      ok: true,
      symbol,
      persisted: profileKey,
      recommendedScanCadenceMins: profile.recommendedScanCadenceMins,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Persist failed";
    res.status(500).json({ error: message });
  }
});

export default router;
