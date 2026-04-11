import { Router, type IRouter } from "express";
import { desc, eq, gte, lte, and, sql } from "drizzle-orm";
import { db, signalLogTable, platformStateTable } from "@workspace/db";
import { computeFeatures } from "../core/features.js";
import { runAllStrategies } from "../core/strategies.js";
import { routeSignals, logSignalDecisions } from "../core/signalRouter.js";
import { type ScoringWeights, DEFAULT_SCORING_WEIGHTS } from "../core/scoring.js";
import { getPendingSignalStatus } from "../core/pendingSignals.js";

async function loadScoringWeights(): Promise<ScoringWeights | undefined> {
  const states = await db.select().from(platformStateTable);
  const m: Record<string, string> = {};
  for (const s of states) m[s.key] = s.value;
  const map: Record<keyof ScoringWeights, string> = {
    rangePosition: "scoring_weight_range_position",
    maDeviation: "scoring_weight_ma_deviation",
    volatilityProfile: "scoring_weight_volatility_profile",
    rangeExpansion: "scoring_weight_range_expansion",
    directionalConfirmation: "scoring_weight_directional_confirmation",
  };
  const keys = Object.keys(map) as (keyof ScoringWeights)[];
  const hasAny = keys.some(k => m[map[k]] !== undefined);
  if (!hasAny) return undefined;
  const w = {} as ScoringWeights;
  for (const k of keys) w[k] = parseFloat(m[map[k]] || String(DEFAULT_SCORING_WEIGHTS[k]));
  return w;
}

const router: IRouter = Router();

const SYMBOLS = ["BOOM1000", "BOOM900", "BOOM600", "BOOM500", "BOOM300", "CRASH1000", "CRASH900", "CRASH600", "CRASH500", "CRASH300", "R_75", "R_100"];

router.get("/signals/latest", async (req, res): Promise<void> => {
  const limit = Math.min(Number(req.query.limit || 50), 200);
  const offset = Math.max(Number(req.query.offset || 0), 0);
  const symbolFilter = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
  const familyFilter = req.query.family ? String(req.query.family) : null;
  const modeFilter = req.query.mode ? String(req.query.mode) : null;
  const statusFilter = req.query.status ? String(req.query.status) : null;
  const aiFilter = req.query.ai ? String(req.query.ai) : null;
  const fromDate = req.query.from ? String(req.query.from) : null;
  const toDate = req.query.to ? String(req.query.to) : null;

  const states = await db.select().from(platformStateTable);
  const stateMap: Record<string, string> = {};
  for (const s of states) stateMap[s.key] = s.value;
  const visibilityThreshold = parseFloat(stateMap["signal_visibility_threshold"] || "75");

  const conditions = [];

  // Show: allowed signals, high-score signals above threshold, and all blocked/rejected V3 decisions
  const visibilityCondition = sql`(
    ${signalLogTable.allowedFlag} = true
    OR COALESCE(${signalLogTable.compositeScore}, 0) >= ${visibilityThreshold}
    OR ${signalLogTable.executionStatus} = 'blocked'
    OR ${signalLogTable.executionStatus} = 'rejected'
  )`;
  conditions.push(visibilityCondition);

  if (symbolFilter) conditions.push(eq(signalLogTable.symbol, symbolFilter));
  if (familyFilter) conditions.push(eq(signalLogTable.strategyFamily, familyFilter));
  if (modeFilter) conditions.push(eq(signalLogTable.mode, modeFilter));
  if (statusFilter === "approved") conditions.push(eq(signalLogTable.allowedFlag, true));
  if (statusFilter === "blocked") conditions.push(eq(signalLogTable.allowedFlag, false));
  if (aiFilter) conditions.push(eq(signalLogTable.aiVerdict, aiFilter));
  if (fromDate) conditions.push(gte(signalLogTable.ts, new Date(fromDate)));
  if (toDate) conditions.push(lte(signalLogTable.ts, new Date(toDate)));

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const countResult = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(signalLogTable)
    .where(whereClause);
  const totalCount = countResult[0]?.count ?? 0;

  const rows = await db.select().from(signalLogTable)
    .where(whereClause)
    .orderBy(desc(signalLogTable.ts))
    .limit(limit)
    .offset(offset);

  res.json({
    signals: rows.map(r => ({
      id: r.id,
      ts: r.ts.toISOString(),
      symbol: r.symbol,
      strategyName: r.strategyName,
      strategyFamily: r.strategyFamily ?? null,
      subStrategy: r.subStrategy ?? null,
      score: r.score,
      expectedValue: r.expectedValue,
      allowedFlag: r.allowedFlag,
      rejectionReason: r.rejectionReason,
      direction: r.direction,
      suggestedSl: r.suggestedSl,
      suggestedTp: r.suggestedTp,
      aiVerdict: r.aiVerdict ?? null,
      aiReasoning: r.aiReasoning ?? null,
      aiConfidenceAdj: r.aiConfidenceAdj ?? null,
      compositeScore: r.compositeScore ?? null,
      scoringDimensions: r.scoringDimensions ?? null,
      mode: r.mode ?? null,
      regime: r.regime ?? null,
      regimeConfidence: r.regimeConfidence ?? null,
      allocationPct: r.allocationPct ?? null,
      executionStatus: r.executionStatus ?? null,
      expectedMovePct: r.expectedMovePct ?? null,
      expectedHoldDays: r.expectedHoldDays ?? null,
      captureRate: r.captureRate ?? null,
      empiricalWinRate: r.empiricalWinRate ?? null,
    })),
    total: totalCount,
    visibilityThreshold,
  });
});

router.post("/signals/scan", async (_req, res): Promise<void> => {
  try {
    const weights = await loadScoringWeights();
    const allCandidates = [];
    const symbolResults: Record<string, number> = {};

    for (const symbol of SYMBOLS) {
      const features = await computeFeatures(symbol);
      if (!features) { symbolResults[symbol] = 0; continue; }

      const candidates = runAllStrategies(features, weights);
      allCandidates.push(...candidates);
      symbolResults[symbol] = candidates.length;
    }

    if (allCandidates.length === 0) {
      res.json({
        success: true,
        message: "Scan complete — no signals fired on current market conditions.",
        candidates: 0, allowed: 0, decisions: [],
      });
      return;
    }

    const decisions = await routeSignals(allCandidates, "paper");
    await logSignalDecisions(decisions, "paper");

    const allowed = decisions.filter(d => d.allowed);
    const rejected = decisions.filter(d => !d.allowed);

    res.json({
      success: true,
      message: `Scan complete: ${allCandidates.length} candidates → ${allowed.length} allowed, ${rejected.length} rejected`,
      candidates: allCandidates.length,
      allowed: allowed.length,
      symbolBreakdown: symbolResults,
      decisions: decisions.map(d => ({
        symbol: d.signal.symbol,
        strategy: d.signal.strategyName,
        direction: d.signal.direction,
        score: d.signal.score.toFixed(3),
        ev: d.signal.expectedValue.toFixed(4),
        allowed: d.allowed,
        rejectionReason: d.rejectionReason,
        capitalAmount: d.capitalAmount.toFixed(2),
        reason: d.signal.reason,
      })),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ success: false, message: `Scan failed: ${message}` });
  }
});

router.get("/signals/features/:symbol", async (req, res): Promise<void> => {
  const symbol = req.params.symbol?.toUpperCase() ?? "";
  if (!SYMBOLS.includes(symbol)) {
    res.status(400).json({ error: `Unknown symbol. Use: ${SYMBOLS.join(", ")}` });
    return;
  }
  try {
    const features = await computeFeatures(symbol);
    if (!features) {
      res.status(404).json({ error: `Insufficient data for ${symbol} — run backfill first.` });
      return;
    }
    res.json(features);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: `Feature computation failed: ${message}` });
  }
});

router.get("/signals/pending", async (_req, res): Promise<void> => {
  try {
    const status = getPendingSignalStatus();
    res.json(status);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: `Failed to get pending signals: ${message}` });
  }
});

router.get("/signals/strategies/:symbol", async (req, res): Promise<void> => {
  const symbol = req.params.symbol?.toUpperCase() ?? "";
  if (!SYMBOLS.includes(symbol)) {
    res.status(400).json({ error: `Unknown symbol. Use: ${SYMBOLS.join(", ")}` });
    return;
  }
  try {
    const features = await computeFeatures(symbol);
    if (!features) {
      res.status(404).json({ error: `Insufficient data for ${symbol} — run backfill first.` });
      return;
    }
    const w = await loadScoringWeights();
    const candidates = runAllStrategies(features, w);
    res.json({
      symbol,
      regime: features.regimeLabel,
      rsi14: features.rsi14,
      emaSlope: features.emaSlope,
      spikeHazard: features.spikeHazardScore,
      bbWidth: features.bbWidth,
      zScore: features.zScore,
      strategies: candidates.map(c => ({
        name: c.strategyName,
        direction: c.direction,
        score: c.score,
        confidence: c.confidence,
        ev: c.expectedValue,
        reason: c.reason,
      })),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: `Strategy scan failed: ${message}` });
  }
});

export default router;
