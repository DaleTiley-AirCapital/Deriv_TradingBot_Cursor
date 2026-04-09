import { Router, type IRouter } from "express";
import { getAllSymbolStatuses, validateActiveSymbols } from "../infrastructure/symbolValidator.js";
import {
  getIntegrityReport,
  getSymbolDataSummary,
  ENRICHMENT_TIMEFRAMES,
} from "../core/dataIntegrity.js";
import { getEnrichmentStatus } from "../core/candleEnrichment.js";
import { ALL_SYMBOLS } from "../infrastructure/deriv.js";
import { db } from "@workspace/db";
import { candlesTable } from "@workspace/db";
import { inArray, and, gte, count, min, max, sql } from "drizzle-orm";

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

/**
 * GET /diagnostics/data-integrity
 *
 * Returns a per-symbol, per-timeframe data integrity summary.
 * Query params:
 *   symbol    — filter to a specific symbol (optional)
 *   timeframe — filter to a specific timeframe (optional, default: all enrichment TFs)
 *   full      — if "true", include gap list in response (default: false for brevity)
 *   days      — lookback window in days (default: 30 for the summary endpoint)
 *
 * Lightweight mode (no "full"): returns counts + health flag only.
 * Full mode: includes gap list per symbol/TF.
 */
router.get("/diagnostics/data-integrity", async (req, res) => {
  try {
    const symbolFilter = req.query.symbol as string | undefined;
    const tfFilter = req.query.timeframe as string | undefined;
    const fullReport = req.query.full === "true";
    const lookbackDays = Math.min(365, Math.max(1, Number(req.query.days ?? 30)));

    const symbols = symbolFilter ? [symbolFilter] : ALL_SYMBOLS;
    const timeframes = tfFilter
      ? [tfFilter]
      : Object.keys(ENRICHMENT_TIMEFRAMES);

    if (tfFilter && !ENRICHMENT_TIMEFRAMES[tfFilter]) {
      res.status(400).json({
        error: `Unknown timeframe "${tfFilter}". Supported: ${Object.keys(ENRICHMENT_TIMEFRAMES).join(", ")}`,
      });
      return;
    }

    const results: Array<{
      symbol: string;
      timeframe: string;
      totalCandles: number;
      firstDate: string | null;
      lastDate: string | null;
      ageHours: number | null;
      gapCount: number;
      duplicateCount: number;
      missingIntervalCount: number;
      coveragePct: number;
      isHealthy: boolean;
      gaps?: Array<{ gapStart: number; gapEnd: number; expectedCount: number; label: string }>;
    }> = [];

    if (!fullReport) {
      // Fast path: single GROUP BY query — O(1) instead of O(symbols × timeframes)
      const cutoff = Math.floor(Date.now() / 1000) - lookbackDays * 86400;
      const nowSecs = Math.floor(Date.now() / 1000);

      const rows = await db
        .select({
          symbol:    candlesTable.symbol,
          timeframe: candlesTable.timeframe,
          cnt:       count(),
          firstTs:   min(candlesTable.openTs),
          lastTs:    max(candlesTable.openTs),
        })
        .from(candlesTable)
        .where(
          and(
            inArray(candlesTable.symbol, symbols),
            inArray(candlesTable.timeframe, timeframes),
            gte(candlesTable.openTs, cutoff),
          ),
        )
        .groupBy(candlesTable.symbol, candlesTable.timeframe);

      // Build a lookup from the aggregate results
      const lookup = new Map<string, typeof rows[0]>();
      for (const r of rows) lookup.set(`${r.symbol}|${r.timeframe}`, r);

      for (const symbol of symbols) {
        for (const tf of timeframes) {
          const r = lookup.get(`${symbol}|${tf}`);
          const cnt = Number(r?.cnt ?? 0);
          const lastTs = r?.lastTs ?? null;
          const ageHours = lastTs ? Math.round((nowSecs - lastTs) / 3600 * 10) / 10 : null;
          results.push({
            symbol,
            timeframe: tf,
            totalCandles: cnt,
            firstDate: r?.firstTs ? new Date(r.firstTs * 1000).toISOString().slice(0, 10) : null,
            lastDate:  lastTs     ? new Date(lastTs  * 1000).toISOString().slice(0, 10) : null,
            ageHours,
            gapCount: 0,
            duplicateCount: 0,
            missingIntervalCount: 0,
            coveragePct: 0,
            isHealthy: cnt > 0,
          });
        }
      }
    } else {
      // Full path: per-symbol/TF gap analysis (slower but thorough)
      for (const symbol of symbols) {
        for (const tf of timeframes) {
          try {
            const report = await getIntegrityReport(symbol, tf, lookbackDays);
            results.push({
              symbol,
              timeframe: tf,
              totalCandles: report.totalCandles,
              firstDate: report.firstDate,
              lastDate: report.lastDate,
              ageHours: report.lastTs
                ? Math.round((Date.now() / 1000 - report.lastTs) / 3600 * 10) / 10
                : null,
              gapCount: report.gapCount,
              duplicateCount: report.duplicateCount,
              missingIntervalCount: report.missingIntervalCount,
              coveragePct: report.coveragePct,
              isHealthy: report.isHealthy,
              gaps: report.gaps.map(g => ({
                gapStart: g.gapStart,
                gapEnd: g.gapEnd,
                expectedCount: g.expectedCount,
                label: g.label,
              })),
            });
          } catch (err) {
            results.push({
              symbol,
              timeframe: tf,
              totalCandles: 0,
              firstDate: null,
              lastDate: null,
              ageHours: null,
              gapCount: -1,
              duplicateCount: -1,
              missingIntervalCount: -1,
              coveragePct: 0,
              isHealthy: false,
            });
          }
        }
      }
    }

    const healthyCount = results.filter(r => r.isHealthy).length;
    const totalCount = results.length;
    const unhealthyCount = totalCount - healthyCount;

    res.json({
      summary: {
        totalChecked: totalCount,
        healthy: healthyCount,
        unhealthy: unhealthyCount,
        lookbackDays,
        symbols: symbols.length,
        timeframes: timeframes.length,
      },
      results,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

/**
 * GET /diagnostics/data-integrity/:symbol
 *
 * Full enrichment status for a specific symbol.
 * Returns per-timeframe row counts and readiness flags.
 */
router.get("/diagnostics/data-integrity/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;

    const [summary, enrichment] = await Promise.all([
      getSymbolDataSummary(symbol),
      getEnrichmentStatus(symbol),
    ]);

    const ready = enrichment.filter(e => e.status === "ready").length;
    const empty = enrichment.filter(e => e.status === "empty").length;
    const noBase = enrichment.filter(e => e.status === "no_base").length;

    res.json({
      symbol,
      base1mCount: summary.timeframes.find(t => t.timeframe === "1m")?.count ?? 0,
      enrichmentSummary: { ready, empty, noBase },
      timeframes: enrichment,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

export default router;
