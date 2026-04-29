import { Router, type IRouter } from "express";
import { desc, asc, eq, gte, lte, and, sql } from "drizzle-orm";
import { db, signalLogTable, platformStateTable, candlesTable } from "@workspace/db";
import { computeFeatures } from "../core/features.js";
import { computeFeaturesFromSlice, type CandleRow } from "../core/backtest/featureSlice.js";
import { getPendingSignalStatus } from "../core/pendingSignals.js";
import { getWatchedCandidates } from "../core/candidateLifecycle.js";
import { getPromotedSymbolRuntimeModel } from "../core/calibration/promotedSymbolModel.js";
import { evaluateCrash300Runtime } from "../symbol-services/CRASH300/engine.js";

const router: IRouter = Router();

const SYMBOLS = ["BOOM1000", "BOOM900", "BOOM600", "BOOM500", "BOOM300", "CRASH1000", "CRASH900", "CRASH600", "CRASH500", "CRASH300", "R_75", "R_100"];
const ACTIVE_SYMBOLS = ["CRASH300", "BOOM300", "R_75", "R_100"];
const CRASH300_LIVE_DIAGNOSTIC_LOOKBACK = 1600;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function optionalNumber(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function optionalBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value == null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return null;
}

async function loadRecentCrash300Candles(): Promise<CandleRow[]> {
  const rows = await db
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
      eq(candlesTable.symbol, "CRASH300"),
      eq(candlesTable.timeframe, "1m"),
      eq(candlesTable.isInterpolated, false),
    ))
    .orderBy(desc(candlesTable.openTs))
    .limit(CRASH300_LIVE_DIAGNOSTIC_LOOKBACK);

  return [...rows].reverse() as CandleRow[];
}

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
  const visibilityThreshold = parseFloat(stateMap["signal_visibility_threshold"] || "50");

  const conditions = [];

  const visibilityCondition = sql`(
    ${signalLogTable.allowedFlag} = true
    OR COALESCE(${signalLogTable.compositeScore}, 0) >= ${visibilityThreshold}
    OR ${signalLogTable.executionStatus} = 'blocked'
    OR ${signalLogTable.executionStatus} = 'rejected'
    OR ${signalLogTable.rejectionReason} IS NOT NULL
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

  const rows = await db.select({
    id: signalLogTable.id,
    ts: signalLogTable.ts,
    symbol: signalLogTable.symbol,
    strategyName: signalLogTable.strategyName,
    score: signalLogTable.score,
    expectedValue: signalLogTable.expectedValue,
    allowedFlag: signalLogTable.allowedFlag,
    rejectionReason: signalLogTable.rejectionReason,
    direction: signalLogTable.direction,
    suggestedSl: signalLogTable.suggestedSl,
    suggestedTp: signalLogTable.suggestedTp,
    aiVerdict: signalLogTable.aiVerdict,
    aiReasoning: signalLogTable.aiReasoning,
    aiConfidenceAdj: signalLogTable.aiConfidenceAdj,
    compositeScore: signalLogTable.compositeScore,
    scoringDimensions: signalLogTable.scoringDimensions,
    mode: signalLogTable.mode,
    regime: signalLogTable.regime,
    regimeConfidence: signalLogTable.regimeConfidence,
    strategyFamily: signalLogTable.strategyFamily,
    subStrategy: signalLogTable.subStrategy,
    allocationPct: signalLogTable.allocationPct,
    executionStatus: signalLogTable.executionStatus,
    expectedMovePct: signalLogTable.expectedMovePct,
    expectedHoldDays: signalLogTable.expectedHoldDays,
    captureRate: signalLogTable.captureRate,
    empiricalWinRate: signalLogTable.empiricalWinRate,
  }).from(signalLogTable)
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

router.get("/signals/live-windows", async (_req, res): Promise<void> => {
  try {
    const watched = getWatchedCandidates();
    const crash300RuntimeModel = await getPromotedSymbolRuntimeModel("CRASH300").catch(() => null);
    const crash300Candles = crash300RuntimeModel ? await loadRecentCrash300Candles().catch(() => []) : [];
    const crash300Features = crash300Candles.length > 0
      ? computeFeaturesFromSlice("CRASH300", crash300Candles)
      : null;
    const crash300Decision = (crash300RuntimeModel && crash300Features && crash300Candles.length > 0)
      ? await evaluateCrash300Runtime({
          symbol: "CRASH300",
          mode: "paper",
          ts: crash300Candles[crash300Candles.length - 1]?.closeTs ?? Math.floor(Date.now() / 1000),
          marketState: {
            features: crash300Features,
            candles: crash300Candles,
            featureHistory: [],
            operationalRegime: "unknown",
            regimeConfidence: 0,
          },
          runtimeModel: crash300RuntimeModel as unknown as Record<string, unknown>,
          stateMap: {},
        }).catch(() => null)
      : null;
    const now = Date.now();
    const rows = await Promise.all(ACTIVE_SYMBOLS.map(async symbol => {
      const features = await computeFeatures(symbol).catch(() => null);
      const latestCloseMs = Number(features?.latestCandleCloseTs ?? 0);
      const watchedCandidates = (symbol === "CRASH300" ? [] : watched)
        .filter(c => c.symbol === symbol)
        .map(c => {
          const componentDelta: Record<string, number> = {};
          const last = c.lastBreakdown ?? {};
          const prev = c.prevBreakdown ?? {};
          for (const [key, value] of Object.entries(last)) {
            componentDelta[key] = value - Number(prev[key] ?? value);
          }
          return {
            key: c.key,
            engineName: c.engineName,
            direction: c.direction,
            status: c.status,
            firstSeenAt: c.firstSeenAt.toISOString(),
            lastSeenAt: c.lastSeenAt.toISOString(),
            watchDurationMins: Math.max(0, (now - c.firstSeenAt.getTime()) / 60_000),
            idleForMins: Math.max(0, (now - c.lastSeenAt.getTime()) / 60_000),
            scanCount: c.scanCount,
            lastScore: c.lastScore,
            bestScore: c.bestScore,
            scoreDeltaFromBest: c.lastScore - c.bestScore,
            consecutiveImproving: c.consecutiveImproving,
            consecutiveDegrading: c.consecutiveDegrading,
            weakComponents: c.weakComponents,
            engineGatePassed: c.engineGatePassed,
            allocatorGatePassed: c.allocatorGatePassed,
            lastRejectionReason: c.lastRejectionReason,
            lastBreakdown: c.lastBreakdown,
            prevBreakdown: c.prevBreakdown,
            componentDelta,
          };
        });

      const crashEvidence = symbol === "CRASH300" && crash300Decision
        ? asRecord(crash300Decision.evidence)
        : null;

      return {
        symbol,
        generatedAt: new Date().toISOString(),
        latestCandleCloseTs: latestCloseMs > 0 ? new Date(latestCloseMs).toISOString() : null,
        latestClose: features?.latestClose ?? null,
        latestOpen: features?.latestOpen ?? null,
        ageSeconds: latestCloseMs > 0 ? Math.max(0, Math.round((now - latestCloseMs) / 1000)) : null,
        rollingWindows: features ? {
          spikeCount4h: features.spikeCount4h,
          spikeCount24h: features.spikeCount24h,
          spikeCount7d: features.spikeCount7d,
          priceChange24hPct: features.priceChange24hPct,
          priceChange7dPct: features.priceChange7dPct,
          distFromRange30dHighPct: features.distFromRange30dHighPct,
          distFromRange30dLowPct: features.distFromRange30dLowPct,
          emaSlope: features.emaSlope,
          priceVsEma20: features.priceVsEma20,
          bbWidth: features.bbWidth,
          atrRank: features.atrRank,
        } : null,
        windowAnchors: latestCloseMs > 0 ? {
          fourHourStart: new Date(latestCloseMs - 4 * 60 * 60 * 1000).toISOString(),
          twentyFourHourStart: new Date(latestCloseMs - 24 * 60 * 60 * 1000).toISOString(),
          sevenDayStart: new Date(latestCloseMs - 7 * 24 * 60 * 60 * 1000).toISOString(),
          thirtyDayStart: new Date(latestCloseMs - 30 * 24 * 60 * 60 * 1000).toISOString(),
        } : null,
        watchedCandidates,
        contextDiagnostics: symbol === "CRASH300" ? {
          activeDecisionSource: "context_plus_fresh_1m_trigger",
          currentContextFamily: optionalString(crashEvidence?.["selectedContextFamily"] ?? crash300Decision?.setupFamily),
          currentTrigger: optionalString(crashEvidence?.["selectedTriggerTransition"]),
          triggerDirection: optionalString(crashEvidence?.["triggerDirection"] ?? crash300Decision?.direction),
          triggerStrength: optionalNumber(crashEvidence?.["triggerStrengthScore"]),
          contextAgeBars: optionalNumber(crashEvidence?.["contextAgeBars"]),
          triggerFresh: optionalBoolean(crashEvidence?.["triggerFresh"]),
          candidateProduced: optionalBoolean(crashEvidence?.["candidateProduced"] ?? crash300Decision?.valid),
          failReasons: Array.isArray(crashEvidence?.["failReasons"])
            ? (crashEvidence["failReasons"] as unknown[]).map((reason) => String(reason))
            : (Array.isArray(crash300Decision?.failReasons) ? crash300Decision.failReasons.map((reason) => String(reason)) : []),
          lastValidTriggerTs: optionalNumber(crashEvidence?.["lastValidTriggerTs"])
            ? new Date(Number(crashEvidence?.["lastValidTriggerTs"]) * 1000).toISOString()
            : null,
          lastValidTriggerDirection: optionalString(crashEvidence?.["lastValidTriggerDirection"]),
          promotedModelRunId: optionalNumber(crashEvidence?.["promotedModelRunId"] ?? crash300RuntimeModel?.sourceRunId),
        } : null,
      };
    }));

    res.json({
      generatedAt: new Date().toISOString(),
      note: "CRASH300 rolling windows are context diagnostics only. A CRASH300 trade candidate is produced only when a fresh 1m trigger fires inside a valid context.",
      symbols: rows,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to get live windows";
    res.status(500).json({ error: message });
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

// ── GET /api/signals/export ───────────────────────────────────────────────────
// Exports signal_log rows for a symbol/time range as JSON.
// Includes ALL signal decisions: allowed, blocked, and executed.
// Query params: symbol (optional), startTs (unix s), endTs (unix s), limit (max 5000)

router.get("/signals/export", async (req, res): Promise<void> => {
  const symbolParam  = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
  const startTsParam = req.query.startTs ? Number(req.query.startTs) : null;
  const endTsParam   = req.query.endTs   ? Number(req.query.endTs)   : null;
  const rawLimit     = Number(req.query.limit);
  const limitParam   = Math.min(isNaN(rawLimit) || rawLimit <= 0 ? 5000 : rawLimit, 5000);

  if (symbolParam && !SYMBOLS.includes(symbolParam)) {
    res.status(400).json({ error: `Unknown symbol. Use one of: ${SYMBOLS.join(", ")}` });
    return;
  }

  try {
    const conditions = [];
    if (symbolParam)  conditions.push(eq(signalLogTable.symbol, symbolParam));
    if (startTsParam !== null && !isNaN(startTsParam)) {
      conditions.push(gte(signalLogTable.ts, new Date(startTsParam * 1000)));
    }
    if (endTsParam !== null && !isNaN(endTsParam)) {
      conditions.push(lte(signalLogTable.ts, new Date(endTsParam * 1000)));
    }

    const rows = await db.select({
      id: signalLogTable.id,
      ts: signalLogTable.ts,
      symbol: signalLogTable.symbol,
      strategyName: signalLogTable.strategyName,
      direction: signalLogTable.direction,
      score: signalLogTable.score,
      allowedFlag: signalLogTable.allowedFlag,
      rejectionReason: signalLogTable.rejectionReason,
      executionStatus: signalLogTable.executionStatus,
      mode: signalLogTable.mode,
      aiVerdict: signalLogTable.aiVerdict,
      aiReasoning: signalLogTable.aiReasoning,
      regime: signalLogTable.regime,
      regimeConfidence: signalLogTable.regimeConfidence,
      compositeScore: signalLogTable.compositeScore,
      expectedMovePct: signalLogTable.expectedMovePct,
      suggestedTp: signalLogTable.suggestedTp,
      suggestedSl: signalLogTable.suggestedSl,
      allocationPct: signalLogTable.allocationPct,
      expectedHoldDays: signalLogTable.expectedHoldDays,
      captureRate: signalLogTable.captureRate,
      empiricalWinRate: signalLogTable.empiricalWinRate,
    }).from(signalLogTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(signalLogTable.ts))
      .limit(limitParam);

    const truncated = rows.length === limitParam;
    res.json({
      exported_at: new Date().toISOString(),
      symbol: symbolParam ?? "all",
      startTs: startTsParam,
      endTs: endTsParam,
      count: rows.length,
      truncated,
      note: truncated
        ? `Result is capped at ${limitParam} rows — use a narrower date range or add limit= to retrieve more.`
        : "Includes all signal decisions: allowed, blocked, and executed.",
      signals: rows.map(r => ({
        id:               r.id,
        ts:               r.ts.toISOString(),
        symbol:           r.symbol,
        strategy:         r.strategyName,
        direction:        r.direction,
        score:            r.score,
        composite_score:  r.compositeScore ?? null,
        native_score:     r.score ?? null,
        allowed_flag:     r.allowedFlag,
        rejection_reason: r.rejectionReason ?? null,
        execution_status: r.executionStatus ?? null,
        mode:             r.mode ?? null,
        ai_verdict:       r.aiVerdict ?? null,
        ai_reasoning:     r.aiReasoning ?? null,
        regime:           r.regime ?? null,
        regime_confidence: r.regimeConfidence ?? null,
        expected_move_pct: r.expectedMovePct ?? null,
        suggested_tp:     r.suggestedTp ?? null,
        suggested_sl:     r.suggestedSl ?? null,
        allocation_pct:   r.allocationPct ?? null,
        expected_hold_days: r.expectedHoldDays ?? null,
        capture_rate:     r.captureRate ?? null,
        empirical_win_rate: r.empiricalWinRate ?? null,
      })),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Signal export failed";
    res.status(500).json({ error: message });
  }
});

export default router;
