/**
 * Candle Enrichment Service — V3 Backend Foundation
 *
 * Deterministically derives higher-timeframe candles from stored 1m base data.
 * This is the single source of truth for multi-TF candle availability.
 *
 * Supported enrichment timeframes (derived from 1m):
 *   5m, 10m, 20m, 40m, 1h, 2h, 4h, 8h, 1d, 2d, 4d
 *
 * OHLCV aggregation semantics:
 *   open  = first 1m candle open in the bucket
 *   high  = max of all highs in the bucket
 *   low   = min of all lows in the bucket
 *   close = last 1m candle close in the bucket
 *   tickCount = sum of all tickCounts in the bucket
 *
 * Enrichment is idempotent: existing candles are upserted via onConflictDoNothing().
 * The unique constraint (symbol, timeframe, openTs) prevents duplicates.
 *
 * Does NOT touch trading logic, strategies, or live engine path.
 */
import { backgroundDb, db, candlesTable } from "@workspace/db";
import { eq, and, gte, lt, asc, min, max, count } from "drizzle-orm";

// Timeframes that are derived from stored 1m data.
// 5m is also fetched from API but we can derive it too as a cross-check.
// 1m is the base — not derived.
export const DERIVED_TIMEFRAMES: Record<string, number> = {
  "5m":  300,
  "10m": 600,
  "20m": 1200,
  "40m": 2400,
  "1h":  3600,
  "2h":  7200,
  "4h":  14400,
  "8h":  28800,
  "1d":  86400,
  "2d":  172800,
  "4d":  345600,
};

// Batch size for reading 1m candles per enrichment pass
const BATCH_SIZE = 50_000;

// Max rows to insert per DB transaction
const INSERT_CHUNK = 500;

export interface EnrichmentResult {
  symbol: string;
  timeframe: string;
  bucketsProcessed: number;
  inserted: number;
  skipped: number;
}

export interface EnrichAllResult {
  symbol: string;
  inserted: number;
  skipped: number;
  byTimeframe: EnrichmentResult[];
  durationMs: number;
  errors: string[];
}

/**
 * Derives and persists higher-TF candles for a single target timeframe.
 *
 * @param symbol     Trading symbol (e.g. "CRASH300")
 * @param targetTf   Target timeframe key (e.g. "1h")
 * @param startTs    Optional: only enrich from this timestamp (Unix seconds)
 * @param endTs      Optional: only enrich up to this timestamp (Unix seconds)
 */
export async function enrichSingleTimeframe(
  symbol: string,
  targetTf: string,
  startTs?: number,
  endTs?: number,
): Promise<EnrichmentResult> {
  const tfSecs = DERIVED_TIMEFRAMES[targetTf];
  if (!tfSecs) throw new Error(`[Enrichment] Unknown derived timeframe: ${targetTf}`);

  const effectiveStart = startTs ?? 0;
  const effectiveEnd   = endTs ?? Math.floor(Date.now() / 1000);

  // Align start to bucket boundary
  const bucketStart = Math.floor(effectiveStart / tfSecs) * tfSecs;

  let inserted = 0;
  let skipped  = 0;
  let bucketsProcessed = 0;
  let offset = 0;

  while (true) {
    // Read a batch of 1m candles in the range
    const batch = await backgroundDb
      .select({
        openTs:    candlesTable.openTs,
        open:      candlesTable.open,
        high:      candlesTable.high,
        low:       candlesTable.low,
        close:     candlesTable.close,
        tickCount: candlesTable.tickCount,
      })
      .from(candlesTable)
      .where(and(
        eq(candlesTable.symbol,    symbol),
        eq(candlesTable.timeframe, "1m"),
        gte(candlesTable.openTs,   bucketStart),
        lt(candlesTable.openTs,    effectiveEnd + 1),
      ))
      .orderBy(asc(candlesTable.openTs))
      .limit(BATCH_SIZE)
      .offset(offset);

    if (batch.length === 0) break;

    // Aggregate into buckets
    const buckets = new Map<number, {
      open: number; high: number; low: number; close: number; tickCount: number; count: number;
    }>();

    for (const row of batch) {
      const bucket = Math.floor(row.openTs / tfSecs) * tfSecs;

      // Skip incomplete leading bucket if we're in the middle
      if (bucket < bucketStart) continue;

      const existing = buckets.get(bucket);
      if (!existing) {
        buckets.set(bucket, {
          open:      row.open,
          high:      row.high,
          low:       row.low,
          close:     row.close,
          tickCount: row.tickCount,
          count:     1,
        });
      } else {
        existing.high      = Math.max(existing.high, row.high);
        existing.low       = Math.min(existing.low,  row.low);
        existing.close     = row.close;
        existing.tickCount += row.tickCount;
        existing.count++;
      }
    }

    // Determine the last (potentially incomplete) bucket from this batch
    const lastBatchTs   = batch[batch.length - 1].openTs;
    const lastBucket    = Math.floor(lastBatchTs / tfSecs) * tfSecs;
    const isLastBatch   = batch.length < BATCH_SIZE;

    // Build insert values — exclude the last bucket unless this is the final batch
    const insertValues: Array<{
      symbol: string; timeframe: string; openTs: number; closeTs: number;
      open: number; high: number; low: number; close: number; tickCount: number;
      source: string; isInterpolated: boolean;
    }> = [];

    for (const [bucketTs, agg] of buckets.entries()) {
      if (!isLastBatch && bucketTs === lastBucket) continue; // incomplete tail
      insertValues.push({
        symbol,
        timeframe:      targetTf,
        openTs:         bucketTs,
        closeTs:        bucketTs + tfSecs,
        open:           agg.open,
        high:           agg.high,
        low:            agg.low,
        close:          agg.close,
        tickCount:      agg.tickCount,
        source:         "enriched",
        isInterpolated: false,
      });
      bucketsProcessed++;
    }

    // Upsert in chunks
    for (let i = 0; i < insertValues.length; i += INSERT_CHUNK) {
      const chunk = insertValues.slice(i, i + INSERT_CHUNK);
      if (chunk.length === 0) continue;
      const result = await db.insert(candlesTable).values(chunk).onConflictDoNothing();
      const rowsInserted = (result as { rowCount?: number }).rowCount ?? 0;
      inserted += rowsInserted;
      skipped  += chunk.length - rowsInserted;
    }

    if (isLastBatch) break;
    offset += BATCH_SIZE;
  }

  return { symbol, timeframe: targetTf, bucketsProcessed, inserted, skipped };
}

/**
 * Derives and persists all supported higher-TF candles for a symbol.
 * Processes all DERIVED_TIMEFRAMES from stored 1m data.
 * Idempotent — safe to re-run after gap fill.
 *
 * @param symbol    Trading symbol
 * @param startTs   Optional: only enrich from this timestamp
 * @param endTs     Optional: only enrich up to this timestamp
 */
export async function enrichTimeframes(
  symbol: string,
  startTs?: number,
  endTs?: number,
): Promise<EnrichAllResult> {
  const start = Date.now();
  const byTimeframe: EnrichmentResult[] = [];
  const errors: string[] = [];
  let totalInserted = 0;
  let totalSkipped  = 0;

  // Check that 1m base data exists
  const [base] = await db
    .select({ cnt: count() })
    .from(candlesTable)
    .where(and(eq(candlesTable.symbol, symbol), eq(candlesTable.timeframe, "1m")));

  const base1mCount = Number(base?.cnt ?? 0);
  if (base1mCount === 0) {
    console.warn(`[Enrichment] ${symbol}: no 1m base data — skipping enrichment`);
    return {
      symbol,
      inserted: 0,
      skipped:  0,
      byTimeframe: [],
      durationMs: Date.now() - start,
      errors: [`no_1m_base_data`],
    };
  }

  console.log(`[Enrichment] ${symbol}: starting enrichment from ${base1mCount.toLocaleString()} 1m candles`);

  for (const [tf] of Object.entries(DERIVED_TIMEFRAMES)) {
    try {
      const result = await enrichSingleTimeframe(symbol, tf, startTs, endTs);
      byTimeframe.push(result);
      totalInserted += result.inserted;
      totalSkipped  += result.skipped;
      console.log(`[Enrichment] ${symbol}/${tf}: ${result.bucketsProcessed} buckets, ${result.inserted} inserted, ${result.skipped} already existed`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${tf}: ${msg}`);
      console.error(`[Enrichment] ${symbol}/${tf} error: ${msg}`);
    }
  }

  const durationMs = Date.now() - start;
  console.log(`[Enrichment] ${symbol}: complete in ${durationMs}ms | inserted=${totalInserted} skipped=${totalSkipped} errors=${errors.length}`);

  return { symbol, inserted: totalInserted, skipped: totalSkipped, byTimeframe, durationMs, errors };
}

/**
 * Returns the availability of enriched timeframes for a symbol.
 * Lightweight — COUNT queries only.
 */
export async function getEnrichmentStatus(symbol: string): Promise<Array<{
  timeframe: string;
  tfSecs: number;
  count: number;
  firstDate: string | null;
  lastDate: string | null;
  status: "ready" | "empty" | "no_base";
}>> {
  const [base] = await db
    .select({ cnt: count() })
    .from(candlesTable)
    .where(and(eq(candlesTable.symbol, symbol), eq(candlesTable.timeframe, "1m")));

  const hasBase = Number(base?.cnt ?? 0) > 0;

  const results = [];

  for (const [tf, secs] of Object.entries(DERIVED_TIMEFRAMES)) {
    const [row] = await db
      .select({ cnt: count(), first: min(candlesTable.openTs), last: max(candlesTable.openTs) })
      .from(candlesTable)
      .where(and(eq(candlesTable.symbol, symbol), eq(candlesTable.timeframe, tf)));

    const cnt = Number(row?.cnt ?? 0);

    results.push({
      timeframe: tf,
      tfSecs: secs,
      count: cnt,
      firstDate: row?.first ? new Date(row.first * 1000).toISOString().slice(0, 10) : null,
      lastDate:  row?.last  ? new Date(row.last  * 1000).toISOString().slice(0, 10) : null,
      status: cnt > 0 ? "ready" as const : hasBase ? "empty" as const : "no_base" as const,
    });
  }

  return results;
}
