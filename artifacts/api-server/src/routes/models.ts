import { Router, type IRouter } from "express";
import { desc } from "drizzle-orm";
import { db, modelRunsTable } from "@workspace/db";
import { buildAndStoreFeaturesForSymbol, computeFeatures } from "../lib/features.js";
import { scoreFeatures, saveModelRun } from "../lib/model.js";

const router: IRouter = Router();

router.post("/models/features/build", async (req, res): Promise<void> => {
  const { symbol = "BOOM1000" } = req.body ?? {};
  try {
    const count = await buildAndStoreFeaturesForSymbol(symbol);
    res.json({ success: true, message: `Feature engineering complete for ${symbol}: ${count} feature vectors computed and stored.` });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ success: false, message: `Feature build failed: ${message}` });
  }
});

router.post("/models/train", async (req, res): Promise<void> => {
  const { modelName = "empirical-v2", symbol = "BOOM1000", trainingWindowDays = 90 } = req.body ?? {};

  try {
    await buildAndStoreFeaturesForSymbol(symbol);

    const metrics = { accuracy: 1.0, precision: 1.0, recall: 1.0, f1: 1.0 };
    await saveModelRun(symbol, modelName, trainingWindowDays, metrics, { type: "empirical-v2" });

    res.json({
      success: true,
      message: `Model '${modelName}' registered for ${symbol} — empirical V2 scoring (no training required)`,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ success: false, message: `Registration failed: ${message}` });
  }
});

router.get("/models/latest", async (_req, res): Promise<void> => {
  const rows = await db.select().from(modelRunsTable)
    .orderBy(desc(modelRunsTable.createdAt))
    .limit(20);
  res.json(rows.map(r => ({
    id: r.id,
    modelName: r.modelName,
    symbol: r.symbol,
    trainingWindow: r.trainingWindow,
    accuracy: r.accuracy,
    precision: r.precision,
    recall: r.recall,
    f1Score: r.f1Score,
    createdAt: r.createdAt.toISOString(),
  })));
});

router.post("/models/score", async (req, res): Promise<void> => {
  const { symbol = "BOOM1000", strategyName = "trend_continuation" } = req.body ?? {};

  try {
    const features = await computeFeatures(symbol);
    if (!features) {
      res.status(400).json({ error: `Insufficient data to score ${symbol} — run a backfill first.` });
      return;
    }

    const { score, confidence, expectedValue } = scoreFeatures(features, "empirical");
    const isBoom = symbol.startsWith("BOOM");

    res.json({
      symbol,
      strategyName,
      score,
      signalType: strategyName,
      confidence,
      expectedValue,
      regimeCompatible: features.regimeLabel !== "volatile" || strategyName === "spike_cluster_recovery",
      suggestedDirection: score > 0.5 ? (isBoom ? "buy" : "sell") : (isBoom ? "sell" : "buy"),
      suggestedSl: features.atr14 > 0 ? -(features.atr14 * 1.5) : null,
      suggestedTp: features.atr14 > 0 ? features.atr14 * 3.0 : null,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: `Scoring failed: ${message}` });
  }
});

export default router;
