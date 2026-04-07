import { Router, type IRouter } from "express";
import { streamResearchExport } from "../lib/candleExport.js";

const router: IRouter = Router();

router.post("/export/research", async (req, res): Promise<void> => {
  const { symbol, timeframe = "1m", startDate, endDate, maxCandlesPerChunk } = req.body ?? {};
  const includeCsv = req.query.csv === "true";

  if (!symbol || typeof symbol !== "string") {
    res.status(400).json({ error: "symbol is required" });
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

  const maxChunk = maxCandlesPerChunk !== undefined ? Number(maxCandlesPerChunk) : undefined;
  if (maxChunk !== undefined && (isNaN(maxChunk) || maxChunk < 1)) {
    res.status(400).json({ error: "maxCandlesPerChunk must be a positive integer (max 50000)" });
    return;
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
