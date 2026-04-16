/**
 * aiContext.ts — Context Indexing API
 *
 * POST /api/ai/index-context
 * Triggers embedding ingestion for selected context sources.
 * AI RESEARCH ONLY — not wired to live trading.
 */

import { Router, type IRouter } from "express";
import {
  indexRepoContext,
  indexSchemaContext,
  indexStrategyContext,
  indexCalibrationContext,
} from "../core/ai/contextRetriever.js";
import { isOpenAIConfigured } from "../infrastructure/openai.js";

const router: IRouter = Router();

let lastIndexAt = 0;
const INDEX_COOLDOWN_MS = 30 * 60 * 1000;

const ALL_SOURCES = ["repo", "schema", "strategy", "calibration"] as const;
type SourceName = typeof ALL_SOURCES[number];

const SOURCE_FNS: Record<SourceName, () => Promise<number>> = {
  repo:        indexRepoContext,
  schema:      indexSchemaContext,
  strategy:    indexStrategyContext,
  calibration: indexCalibrationContext,
};

router.post("/ai/index-context", async (req, res): Promise<void> => {
  if (!(await isOpenAIConfigured())) {
    res.status(503).json({ error: "OpenAI not configured — cannot index context" });
    return;
  }
  const now = Date.now();
  if (now - lastIndexAt < INDEX_COOLDOWN_MS) {
    const waitSecs = Math.ceil((INDEX_COOLDOWN_MS - (now - lastIndexAt)) / 1000);
    res.status(429).json({ error: `Rate limited — context was indexed recently. Retry in ${waitSecs}s.` });
    return;
  }

  const { sources } = req.body as { sources?: string[] };
  const requested: SourceName[] = Array.isArray(sources) && sources.length > 0
    ? sources.filter((s): s is SourceName => ALL_SOURCES.includes(s as SourceName))
    : [...ALL_SOURCES];

  if (requested.length === 0) {
    res.status(400).json({ error: "No valid sources specified. Valid: " + ALL_SOURCES.join(", ") });
    return;
  }

  const results: Record<string, { chunks: number; error?: string }> = {};
  let totalChunks = 0;

  for (const source of requested) {
    try {
      const chunks = await SOURCE_FNS[source]();
      results[source] = { chunks };
      totalChunks += chunks;
      console.log(`[ContextIndex] ${source}: ${chunks} chunks indexed`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results[source] = { chunks: 0, error: msg };
      console.error(`[ContextIndex] ${source} failed:`, msg);
    }
  }

  lastIndexAt = Date.now();
  res.json({
    indexed: requested,
    totalChunks,
    results,
    message: `Indexed ${totalChunks} context chunks across ${requested.length} source(s)`,
  });
});

router.get("/ai/index-status", async (_req, res): Promise<void> => {
  try {
    const { db, aiContextEmbeddingsTable } = await import("@workspace/db");
    const { count, eq } = await import("drizzle-orm");

    const rows = await db.select({
      sourceType: aiContextEmbeddingsTable.sourceType,
      cnt: count(),
    })
      .from(aiContextEmbeddingsTable)
      .groupBy(aiContextEmbeddingsTable.sourceType);

    const byType: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      byType[r.sourceType] = Number(r.cnt);
      total += Number(r.cnt);
    }

    res.json({ total, byType, indexed: total > 0 });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to get index status" });
  }
});

export default router;
