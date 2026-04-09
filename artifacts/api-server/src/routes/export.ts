import { Router, type IRouter } from "express";
import { streamResearchExport } from "../infrastructure/candleExport.js";
import { ENRICHMENT_TIMEFRAMES } from "../core/dataIntegrity.js";

const router: IRouter = Router();

// Aligned with ENRICHMENT_TIMEFRAMES — the single source of truth for all supported TFs.
const SUPPORTED_TIMEFRAMES = new Set(Object.keys(ENRICHMENT_TIMEFRAMES));
const SYMBOL_RE = /^[A-Z0-9_]{1,20}$/;

router.post("/export/research", async (req, res): Promise<void> => {
  const { symbol, timeframe = "1m", startDate, endDate, maxCandlesPerChunk } = req.body ?? {};
  const includeCsv = req.query.csv === "true";

  if (!symbol || typeof symbol !== "string" || !SYMBOL_RE.test(symbol)) {
    res.status(400).json({ error: "symbol is required and must be uppercase alphanumeric/underscore (max 20 chars)" });
    return;
  }
  if (typeof timeframe !== "string" || !SUPPORTED_TIMEFRAMES.has(timeframe)) {
    res.status(400).json({ error: `timeframe must be one of: ${[...SUPPORTED_TIMEFRAMES].join(", ")}` });
    return;
  }
  if (!startDate || typeof startDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    res.status(400).json({ error: "startDate is required and must be YYYY-MM-DD" });
    return;
  }
  if (!endDate || typeof endDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    res.status(400).json({ error: "endDate is required and must be YYYY-MM-DD" });
    return;
  }
  if (startDate > endDate) {
    res.status(400).json({ error: "startDate must be on or before endDate" });
    return;
  }

  let maxChunk: number | undefined;
  if (maxCandlesPerChunk !== undefined) {
    const raw = Number(maxCandlesPerChunk);
    if (!Number.isInteger(raw) || raw < 1 || raw > 50_000) {
      res.status(400).json({ error: "maxCandlesPerChunk must be an integer between 1 and 50000" });
      return;
    }
    maxChunk = raw;
  }

  console.log(`[Export] Research bundle requested: ${symbol}/${timeframe} ${startDate} → ${endDate} (maxChunk=${maxChunk ?? 25000}, csv=${includeCsv})`);

  try {
    await streamResearchExport(
      { symbol, timeframe, startDate, endDate, maxCandlesPerChunk: maxChunk, includeCsv },
      res,
    );
    console.log(`[Export] Bundle complete: ${symbol}/${timeframe} ${startDate} → ${endDate}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`[Export] Error: ${msg}`);
    if (!res.headersSent) {
      res.status(500).json({ error: `Export failed: ${msg}` });
    } else {
      res.end();
    }
  }
});

export default router;
