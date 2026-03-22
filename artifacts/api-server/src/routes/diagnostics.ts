import { Router, type IRouter } from "express";
import { getAllSymbolStatuses, validateActiveSymbols } from "../lib/symbolValidator.js";

const router: IRouter = Router();

router.get("/diagnostics/symbols", async (_req, res) => {
  try {
    const statuses = getAllSymbolStatuses();
    const validCount = statuses.filter(s => s.activeSymbolFound).length;
    const streamingCount = statuses.filter(s => s.streaming).length;
    const staleCount = statuses.filter(s => s.stale).length;
    const errorCount = statuses.filter(s => s.error).length;

    res.json({
      summary: {
        total: statuses.length,
        valid: validCount,
        streaming: streamingCount,
        stale: staleCount,
        errors: errorCount,
      },
      symbols: statuses,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

router.post("/diagnostics/symbols/revalidate", async (_req, res) => {
  try {
    const validated = await validateActiveSymbols(true);
    const statuses = getAllSymbolStatuses();
    res.json({
      revalidated: true,
      validCount: validated.size,
      symbols: statuses,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

export default router;
