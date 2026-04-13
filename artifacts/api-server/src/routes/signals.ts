import { Router, type IRouter } from "express";
import { desc, eq, gte, lte, and, sql } from "drizzle-orm";
import { db, signalLogTable, platformStateTable } from "@workspace/db";
import { computeFeatures } from "../core/features.js";
import { getPendingSignalStatus } from "../core/pendingSignals.js";

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

export default router;
