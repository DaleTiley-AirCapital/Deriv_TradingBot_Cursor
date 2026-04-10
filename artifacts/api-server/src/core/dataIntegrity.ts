/**
 * Data Integrity Service — V3 Canonical Candle Pipeline
 *
 * Provides gap detection, full gap repair (API + carry-forward interpolation),
 * and comprehensive integrity reporting for the canonical `candles` table.
 *
 * CANONICAL TRUTH: The `candles` table is the SINGLE source of truth.
 * All pipelines write here. All reads come from here. No other candle store.
 *
 * Source tags on every candle:
 *   'historical'   — initial API backfill
 *   'live'         — completed live candles from tick stream
 *   'topup'        — API gap-fill from repairGapFromApi()
 *   'enriched'     — derived from 1m aggregation by candleEnrichment
 *   'interpolated' — carry-forward fill (API returned no data for gap)
 *
 * isInterpolated=true marks synthetic candles. These MUST NOT be used
 * in strategy signal generation.
 */
import { db, backgroundDb, candlesTable } from "@workspace/db";
import { eq, and, gte, lt, min, max, count, asc, sql } from "drizzle-orm";
import type { DerivClient } from "../infrastructure/deriv.js";
type DerivClientPublic = DerivClient;

export interface CandleGap {
  symbol: string;
  timeframe: string;
  gapStart: number;
  gapEnd: number;
  expectedCount: number;
  label: string;
}

export interface IntegrityReport {
  symbol: string;
  timeframe: string;
  totalCandles: number;
  firstTs: number | null;
  lastTs: number | null;
  firstDate: string | null;
  lastDate: string | null;
  duplicateCount: number;
  missingIntervalCount: number;
  gapCount: number;
  gaps: CandleGap[];
  strictlyAscending: boolean;
  coveragePct: number;
  isHealthy: boolean;
  checkedAt: string;
  interpolatedCount: number;
  sourceBreakdown: Record<string, number>;
}

export interface ComprehensiveIntegrityReport {
  symbol: string;
  checkedAt: string;
  base1mCount: number;
  base1mFirstDate: string | null;
  base1mLastDate: string | null;
  base1mAgeHours: number | null;
  base1mGapCount: number;
  base1mMissingCandles: number;
  base1mCoveragePct: number;
  base1mInterpolatedCount: number;
  overallHealthy: boolean;
  totalGaps: number;
  totalMissingCandles: number;
  totalInterpolated: number;
  timeframes: Array<{
    timeframe: string;
    count: number;
    firstDate: string | null;
    lastDate: string | null;
    ageHours: number | null;
    gapCount: number;
    missingCandles: number;
    coveragePct: number;
    interpolatedCount: number;
    isHealthy: boolean;
  }>;
}

export interface TopUpResult {
  symbol: string;
  timeframes: string[];
  gapsFound: number;
  gapsRepaired: number;
  gapsInterpolated: number;
  candlesInserted: number;
  errors: string[];
  durationMs: number;
}

// Candle intervals in seconds for all supported timeframes
export const ENRICHMENT_TIMEFRAMES: Record<string, number> = {
  "1m":  60,
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

// Base timeframes that can be fetched from API (all others derived from 1m)
export const API_FETCHABLE_TIMEFRAMES = ["1m", "5m"] as const;

/**
 * Detects ALL missing candle intervals (gaps) for a given symbol/timeframe.
 *
 * Reads all stored openTs values and finds segments where timestamps are
 * non-consecutive beyond 1.5× the expected interval.
 *
 * @param minGapCandles  Minimum gap size to report (default: 1 — ALL gaps).
 *                       Set to 3 for noise filtering when gap count matters more than precision.
 *
 * Returns gaps sorted by gapStart ascending.
 */
export async function detectCandleGaps(
  symbol: string,
  timeframe: string,
  lookbackDays = 365,
  minGapCandles = 1,
): Promise<CandleGap[]> {
  const tfSecs = ENRICHMENT_TIMEFRAMES[timeframe];
  if (!tfSecs) throw new Error(`[DataIntegrity] Unknown timeframe: ${timeframe}`);

  const cutoff = Math.floor(Date.now() / 1000) - lookbackDays * 86400;

  const rows = await backgroundDb
    .select({ ts: candlesTable.openTs })
    .from(candlesTable)
    .where(and(
      eq(candlesTable.symbol, symbol),
      eq(candlesTable.timeframe, timeframe),
      gte(candlesTable.openTs, cutoff),
    ))
    .orderBy(asc(candlesTable.openTs));

  if (rows.length < 2) return [];

  const gaps: CandleGap[] = [];
  const maxGapSecs = tfSecs * 1.5;

  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1].ts;
    const curr = rows[i].ts;
    const delta = curr - prev;

    if (delta > maxGapSecs) {
      const missedCandles = Math.round(delta / tfSecs) - 1;
      if (missedCandles >= minGapCandles) {
        gaps.push({
          symbol,
          timeframe,
          gapStart: prev + tfSecs,
          gapEnd: curr - 1,
          expectedCount: missedCandles,
          label: `${new Date(prev * 1000).toISOString().slice(0, 16)} → ${new Date(curr * 1000).toISOString().slice(0, 16)} (${missedCandles} missing)`,
        });
      }
    }
  }

  return gaps;
}

/**
 * Counts duplicate timestamps for a given symbol/timeframe.
 * The uniqueIndex should prevent new duplicates, but existing data may have them.
 */
export async function countDuplicateTimestamps(
  symbol: string,
  timeframe: string,
): Promise<number> {
  const result = await db.execute(sql`
    SELECT COUNT(*) - COUNT(DISTINCT open_ts) AS dupes
    FROM candles
    WHERE symbol = ${symbol} AND timeframe = ${timeframe}
  `);
  return Number((result.rows[0] as { dupes: unknown })?.dupes ?? 0);
}

/**
 * Counts interpolated candles (is_interpolated=true) for a symbol/timeframe.
 */
async function countInterpolatedCandles(symbol: string, timeframe: string): Promise<number> {
  const result = await db.execute(sql`
    SELECT COUNT(*) AS cnt
    FROM candles
    WHERE symbol = ${symbol} AND timeframe = ${timeframe} AND is_interpolated = true
  `);
  return Number((result.rows[0] as { cnt: unknown })?.cnt ?? 0);
}

/**
 * Returns a breakdown of candle counts by source for a symbol/timeframe.
 */
async function getSourceBreakdown(symbol: string, timeframe: string): Promise<Record<string, number>> {
  const result = await db.execute(sql`
    SELECT source, COUNT(*) AS cnt
    FROM candles
    WHERE symbol = ${symbol} AND timeframe = ${timeframe}
    GROUP BY source
  `);
  const breakdown: Record<string, number> = {};
  for (const row of result.rows as Array<{ source: string; cnt: unknown }>) {
    breakdown[row.source] = Number(row.cnt);
  }
  return breakdown;
}

/**
 * Produces a full integrity report for a symbol/timeframe pair.
 * Includes gap list, duplicate count, coverage %, source breakdown, and health flag.
 */
export async function getIntegrityReport(
  symbol: string,
  timeframe: string,
  lookbackDays = 365,
): Promise<IntegrityReport> {
  const tfSecs = ENRICHMENT_TIMEFRAMES[timeframe];
  if (!tfSecs) throw new Error(`[DataIntegrity] Unknown timeframe: ${timeframe}`);

  const cutoff = Math.floor(Date.now() / 1000) - lookbackDays * 86400;
  const now = Math.floor(Date.now() / 1000);

  const [summary] = await db
    .select({
      cnt: count(),
      firstTs: min(candlesTable.openTs),
      lastTs: max(candlesTable.openTs),
    })
    .from(candlesTable)
    .where(and(
      eq(candlesTable.symbol, symbol),
      eq(candlesTable.timeframe, timeframe),
      gte(candlesTable.openTs, cutoff),
    ));

  const totalCandles = Number(summary?.cnt ?? 0);
  const firstTs = summary?.firstTs ?? null;
  const lastTs = summary?.lastTs ?? null;

  // Detect ALL gaps (minGapCandles=1)
  const gaps = await detectCandleGaps(symbol, timeframe, lookbackDays, 1);
  const dupes = await countDuplicateTimestamps(symbol, timeframe);
  const interpolatedCount = await countInterpolatedCandles(symbol, timeframe);
  const sourceBreakdown = await getSourceBreakdown(symbol, timeframe);

  const missingIntervalCount = gaps.reduce((s, g) => s + g.expectedCount, 0);
  const expectedTotal = firstTs ? Math.ceil((now - firstTs) / tfSecs) : 0;
  const coveragePct = expectedTotal > 0 ? Math.min(100, (totalCandles / expectedTotal) * 100) : 0;

  // Check ascending order (sample first 200 rows)
  const sample = await backgroundDb
    .select({ ts: candlesTable.openTs })
    .from(candlesTable)
    .where(and(
      eq(candlesTable.symbol, symbol),
      eq(candlesTable.timeframe, timeframe),
      gte(candlesTable.openTs, cutoff),
    ))
    .orderBy(asc(candlesTable.openTs))
    .limit(200);

  let strictlyAscending = true;
  for (let i = 1; i < sample.length; i++) {
    if (sample[i].ts <= sample[i - 1].ts) { strictlyAscending = false; break; }
  }

  const isHealthy = dupes === 0 && gaps.length === 0 && strictlyAscending && coveragePct >= 70;

  return {
    symbol,
    timeframe,
    totalCandles,
    firstTs,
    lastTs,
    firstDate: firstTs ? new Date(firstTs * 1000).toISOString() : null,
    lastDate: lastTs ? new Date(lastTs * 1000).toISOString() : null,
    duplicateCount: dupes,
    missingIntervalCount,
    gapCount: gaps.length,
    gaps: gaps.slice(0, 50),
    strictlyAscending,
    coveragePct: Math.round(coveragePct * 10) / 10,
    isHealthy,
    checkedAt: new Date().toISOString(),
    interpolatedCount,
    sourceBreakdown,
  };
}

/**
 * Comprehensive integrity report across ALL timeframes for a symbol.
 * Lightweight — uses COUNT queries + detectCandleGaps for each TF.
 * Returns the base 1m stats prominently plus a per-TF array.
 */
export async function getComprehensiveIntegrityReport(
  symbol: string,
  lookbackDays = 365,
): Promise<ComprehensiveIntegrityReport> {
  const now = Math.floor(Date.now() / 1000);
  const checkedAt = new Date().toISOString();
  const tfKeys = Object.keys(ENRICHMENT_TIMEFRAMES);

  const tfResults: ComprehensiveIntegrityReport["timeframes"] = [];
  let base1mCount = 0;
  let base1mFirstDate: string | null = null;
  let base1mLastDate: string | null = null;
  let base1mAgeHours: number | null = null;
  let base1mGapCount = 0;
  let base1mMissingCandles = 0;
  let base1mCoveragePct = 0;
  let base1mInterpolatedCount = 0;

  for (const tf of tfKeys) {
    const tfSecs = ENRICHMENT_TIMEFRAMES[tf];
    const cutoff = now - lookbackDays * 86400;

    const [row] = await backgroundDb
      .select({
        cnt: count(),
        first: min(candlesTable.openTs),
        last: max(candlesTable.openTs),
      })
      .from(candlesTable)
      .where(and(
        eq(candlesTable.symbol, symbol),
        eq(candlesTable.timeframe, tf),
        gte(candlesTable.openTs, cutoff),
      ));

    const cnt     = Number(row?.cnt ?? 0);
    const firstTs = row?.first ?? null;
    const lastTs  = row?.last  ?? null;
    const ageHours = lastTs ? Math.round((now - lastTs) / 360) / 10 : null;

    const gaps = await detectCandleGaps(symbol, tf, lookbackDays, 1);
    const missingCandles = gaps.reduce((s, g) => s + g.expectedCount, 0);
    const expectedTotal = firstTs ? Math.ceil((now - firstTs) / tfSecs) : 0;
    const coveragePct = expectedTotal > 0
      ? Math.round(Math.min(100, (cnt / expectedTotal) * 100) * 10) / 10
      : 0;

    const interpolatedCount = await countInterpolatedCandles(symbol, tf);
    const isHealthy = gaps.length === 0 && coveragePct >= 70 && cnt > 0;

    const entry = {
      timeframe: tf,
      count: cnt,
      firstDate: firstTs ? new Date(firstTs * 1000).toISOString().slice(0, 10) : null,
      lastDate:  lastTs  ? new Date(lastTs  * 1000).toISOString().slice(0, 10) : null,
      ageHours,
      gapCount: gaps.length,
      missingCandles,
      coveragePct,
      interpolatedCount,
      isHealthy,
    };

    if (tf === "1m") {
      base1mCount            = cnt;
      base1mFirstDate        = entry.firstDate;
      base1mLastDate         = entry.lastDate;
      base1mAgeHours         = ageHours;
      base1mGapCount         = gaps.length;
      base1mMissingCandles   = missingCandles;
      base1mCoveragePct      = coveragePct;
      base1mInterpolatedCount = interpolatedCount;
    }

    tfResults.push(entry);
  }

  const overallHealthy = base1mCount >= 1000 && base1mGapCount === 0;

  const totalGaps           = tfResults.reduce((s, t) => s + t.gapCount, 0);
  const totalMissingCandles = tfResults.reduce((s, t) => s + t.missingCandles, 0);
  const totalInterpolated   = tfResults.reduce((s, t) => s + t.interpolatedCount, 0);

  return {
    symbol,
    checkedAt,
    base1mCount,
    base1mFirstDate,
    base1mLastDate,
    base1mAgeHours,
    base1mGapCount,
    base1mMissingCandles,
    base1mCoveragePct,
    base1mInterpolatedCount,
    overallHealthy,
    totalGaps,
    totalMissingCandles,
    totalInterpolated,
    timeframes: tfResults,
  };
}

/**
 * Fetches and inserts candles for a specific time range for a symbol/timeframe.
 * Used to fill individual gaps. Only works for API-fetchable timeframes (1m, 5m).
 * Tags inserted candles with source='topup'.
 *
 * Returns the number of candles inserted.
 */
export async function repairGapFromApi(
  symbol: string,
  timeframe: string,
  gapStart: number,
  gapEnd: number,
  client: DerivClientPublic,
): Promise<number> {
  const tfSecs = ENRICHMENT_TIMEFRAMES[timeframe];
  if (!tfSecs) throw new Error(`[DataIntegrity] Unknown timeframe: ${timeframe}`);
  if (!(API_FETCHABLE_TIMEFRAMES as readonly string[]).includes(timeframe)) {
    throw new Error(`[DataIntegrity] ${timeframe} is not API-fetchable; derive from 1m instead`);
  }

  const MAX_PER_PAGE = 5000;
  const granularity = tfSecs;
  let inserted = 0;
  let endEpoch = gapEnd;

  while (endEpoch > gapStart) {
    const candles = await client.getCandleHistoryWithEnd(symbol, granularity, MAX_PER_PAGE, endEpoch, true);
    if (!candles || candles.length === 0) break;

    const inRange = candles.filter(c => c.epoch >= gapStart && c.epoch <= gapEnd);
    if (inRange.length === 0) break;

    const values = inRange.map(c => ({
      symbol,
      timeframe,
      openTs:         c.epoch,
      closeTs:        c.epoch + tfSecs,
      open:           c.open,
      high:           c.high,
      low:            c.low,
      close:          c.close,
      tickCount:      0,
      source:         "topup",
      isInterpolated: false,
    }));

    for (let i = 0; i < values.length; i += 500) {
      const chunk = values.slice(i, i + 500);
      await db.insert(candlesTable).values(chunk).onConflictDoNothing();
      inserted += chunk.length;
    }

    const oldest = inRange[0].epoch;
    if (oldest <= gapStart || oldest >= endEpoch) break;
    endEpoch = oldest - 1;

    await new Promise(r => setTimeout(r, 120));
  }

  return inserted;
}

/**
 * Fills a gap by carry-forward interpolation from the candle immediately before gapStart.
 * Inserts synthetic candles with source='interpolated' and isInterpolated=true.
 * Used as a fallback when the API cannot provide real data for a gap.
 *
 * These candles MUST NOT be used for signal generation — they are placeholder continuity only.
 *
 * Returns number of interpolated candles inserted.
 */
export async function interpolateGap(
  symbol: string,
  timeframe: string,
  gapStart: number,
  gapEnd: number,
): Promise<number> {
  const tfSecs = ENRICHMENT_TIMEFRAMES[timeframe];
  if (!tfSecs) return 0;

  // Get the last real candle before the gap
  const [prior] = await db
    .select({
      close: candlesTable.close,
    })
    .from(candlesTable)
    .where(and(
      eq(candlesTable.symbol, symbol),
      eq(candlesTable.timeframe, timeframe),
      lt(candlesTable.openTs, gapStart),
    ))
    .orderBy(asc(candlesTable.openTs));

  if (!prior) {
    console.warn(`[DataIntegrity] Cannot interpolate ${symbol}/${timeframe} gap at ${gapStart}: no prior candle`);
    return 0;
  }

  const price = prior.close;
  const values: Array<{
    symbol: string; timeframe: string; openTs: number; closeTs: number;
    open: number; high: number; low: number; close: number;
    tickCount: number; source: string; isInterpolated: boolean;
  }> = [];

  let ts = gapStart;
  while (ts <= gapEnd) {
    values.push({
      symbol,
      timeframe,
      openTs:         ts,
      closeTs:        ts + tfSecs,
      open:           price,
      high:           price,
      low:            price,
      close:          price,
      tickCount:      0,
      source:         "interpolated",
      isInterpolated: true,
    });
    ts += tfSecs;
  }

  let inserted = 0;
  for (let i = 0; i < values.length; i += 500) {
    const chunk = values.slice(i, i + 500);
    await db.insert(candlesTable).values(chunk).onConflictDoNothing();
    inserted += chunk.length;
  }

  console.log(`[DataIntegrity] Interpolated ${inserted} carry-forward candles for ${symbol}/${timeframe} gap at ${new Date(gapStart * 1000).toISOString()}`);
  return inserted;
}

/**
 * Full gap repair for a symbol/timeframe: API fetch first, interpolation fallback.
 *
 * For each detected gap:
 * 1. Try to fetch from API (topup source)
 * 2. If API returns fewer candles than expected, fill remainder by carry-forward (interpolated)
 *
 * Only works for API-fetchable timeframes (1m, 5m).
 * For derived timeframes, call candleEnrichment.enrichTimeframes() after repairing 1m.
 */
export async function repairAllGaps(
  symbol: string,
  timeframe: string,
  client: DerivClientPublic,
  lookbackDays = 365,
): Promise<{ inserted: number; interpolated: number; errors: string[] }> {
  if (!(API_FETCHABLE_TIMEFRAMES as readonly string[]).includes(timeframe)) {
    return { inserted: 0, interpolated: 0, errors: [`${timeframe} cannot be repaired from API — derive from 1m`] };
  }

  const gaps = await detectCandleGaps(symbol, timeframe, lookbackDays, 1);
  if (gaps.length === 0) return { inserted: 0, interpolated: 0, errors: [] };

  let totalInserted = 0;
  let totalInterpolated = 0;
  const errors: string[] = [];

  for (const gap of gaps) {
    try {
      console.log(`[DataIntegrity] Repairing gap ${gap.label} for ${symbol}/${timeframe}`);

      // Step 1: Try API fetch
      const apiInserted = await repairGapFromApi(symbol, timeframe, gap.gapStart, gap.gapEnd, client);
      totalInserted += apiInserted;

      // Step 2: Check if gap is still there (API may return partial data)
      if (apiInserted < gap.expectedCount) {
        const remaining = await detectCandleGaps(symbol, timeframe, lookbackDays + 30, 1);
        const stillGapped = remaining.some(g =>
          g.gapStart <= gap.gapEnd && g.gapEnd >= gap.gapStart,
        );

        if (stillGapped) {
          // Interpolate what the API couldn't fill
          const interpInserted = await interpolateGap(symbol, timeframe, gap.gapStart, gap.gapEnd);
          totalInterpolated += interpInserted;
          console.log(`[DataIntegrity] Interpolated ${interpInserted} candles for remaining gap`);
        }
      }

      console.log(`[DataIntegrity] Gap repaired: ${apiInserted} real + ${totalInterpolated} interpolated`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[DataIntegrity] Gap repair failed for ${gap.label}: ${msg}`);
      errors.push(`gap@${gap.gapStart}: ${msg}`);
    }
  }

  return { inserted: totalInserted, interpolated: totalInterpolated, errors };
}

/**
 * Full data top-up / reconciliation pipeline for a symbol.
 *
 * Steps:
 * 1. Check 1m and 5m base data integrity (detect ALL gaps)
 * 2. Repair detected gaps via API (with interpolation fallback)
 * 3. Trigger timeframe enrichment for derived TFs
 * 4. Final integrity re-check
 */
export async function runDataTopUp(
  symbol: string,
  client: DerivClientPublic,
): Promise<TopUpResult> {
  const start = Date.now();
  const errors: string[] = [];
  let gapsFound = 0;
  let gapsRepaired = 0;
  let gapsInterpolated = 0;
  let candlesInserted = 0;

  const baseTimeframes: string[] = ["1m", "5m"];

  for (const tf of baseTimeframes) {
    try {
      const gaps = await detectCandleGaps(symbol, tf, 365, 1);
      gapsFound += gaps.length;

      if (gaps.length > 0) {
        console.log(`[DataTopUp] ${symbol}/${tf}: ${gaps.length} gaps found, starting repair...`);
        const { inserted, interpolated, errors: repairErrors } = await repairAllGaps(symbol, tf, client);
        candlesInserted += inserted + interpolated;
        gapsInterpolated += interpolated;
        gapsRepaired += gaps.length - repairErrors.length;
        errors.push(...repairErrors);
      } else {
        console.log(`[DataTopUp] ${symbol}/${tf}: no gaps detected`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${tf} check failed: ${msg}`);
      console.error(`[DataTopUp] ${symbol}/${tf} error: ${msg}`);
    }
  }

  // Trigger enrichment for derived timeframes
  try {
    const { enrichTimeframes } = await import("./candleEnrichment.js");
    const enriched = await enrichTimeframes(symbol);
    candlesInserted += enriched.inserted;
    console.log(`[DataTopUp] ${symbol}: enrichment complete — ${enriched.inserted} derived candles inserted/updated`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`enrichment failed: ${msg}`);
    console.error(`[DataTopUp] ${symbol} enrichment error: ${msg}`);
  }

  const durationMs = Date.now() - start;
  const enrichedTfs = Object.keys(ENRICHMENT_TIMEFRAMES);

  console.log(
    `[DataTopUp] ${symbol}: complete in ${durationMs}ms | ` +
    `gaps=${gapsFound} repaired=${gapsRepaired} interpolated=${gapsInterpolated} ` +
    `inserted=${candlesInserted} errors=${errors.length}`,
  );

  return {
    symbol,
    timeframes: enrichedTfs,
    gapsFound,
    gapsRepaired,
    gapsInterpolated,
    candlesInserted,
    errors,
    durationMs,
  };
}

/**
 * Reconcile result from the integrity-first top-up + enrichment pipeline.
 */
export interface ReconcileResult {
  symbol: string;
  baseCheck: {
    base1mCount: number;
    base5mCount: number;
    sufficientForEnrichment: boolean;
    insufficiencyReason: string | null;
  };
  repair: {
    gapsFound: number;
    gapsRepaired: number;
    gapsInterpolated: number;
    candlesInserted: number;
    errors: string[];
  };
  enrichment: {
    inserted: number;
    skipped: number;
    errors: string[];
    ran: boolean;
  };
  postCheck: {
    base1mCount: number;
    improvementDelta: number;
  };
  errors: string[];
  durationMs: number;
}

const MIN_BASE_1M_FOR_ENRICHMENT = 1000;

/**
 * Integrity-first reconcile pipeline for a symbol.
 *
 * Order of operations (mandatory):
 * 1. Inspect canonical 1m base data count
 * 2. Fail loudly if insufficient for enrichment
 * 3. Repair 1m and 5m gaps from API (with interpolation fallback)
 * 4. Validate that base data is now sufficient
 * 5. Enrich derived timeframes from clean 1m base
 * 6. Final post-check and return
 *
 * This replaces the old "run top-up and enrichment separately" pattern.
 * Enrichment never runs on dirty or insufficient base data.
 */
export async function reconcileSymbolData(
  symbol: string,
  client: DerivClientPublic,
): Promise<ReconcileResult> {
  const start = Date.now();
  const errors: string[] = [];

  // ── Step 1: Inspect base data before repair ──────────────────────────
  const [pre1m] = await db
    .select({ cnt: count() })
    .from(candlesTable)
    .where(and(eq(candlesTable.symbol, symbol), eq(candlesTable.timeframe, "1m")));
  const [pre5m] = await db
    .select({ cnt: count() })
    .from(candlesTable)
    .where(and(eq(candlesTable.symbol, symbol), eq(candlesTable.timeframe, "5m")));

  const priorBase1m = Number(pre1m?.cnt ?? 0);
  const priorBase5m = Number(pre5m?.cnt ?? 0);

  let insufficiencyReason: string | null = null;
  if (priorBase1m < MIN_BASE_1M_FOR_ENRICHMENT) {
    insufficiencyReason = `Only ${priorBase1m} 1m candles — minimum is ${MIN_BASE_1M_FOR_ENRICHMENT} for enrichment. Run data top-up (historical download) first.`;
    console.warn(`[Reconcile] ${symbol}: ${insufficiencyReason}`);
  }

  // ── Step 2: Repair gaps in 1m and 5m (even if base is thin) ─────────
  let gapsFound = 0;
  let gapsRepaired = 0;
  let gapsInterpolated = 0;
  let candlesInserted = 0;
  const repairErrors: string[] = [];

  if (priorBase1m > 0) {
    for (const tf of ["1m", "5m"] as const) {
      try {
        const gaps = await detectCandleGaps(symbol, tf, 365, 1);
        gapsFound += gaps.length;
        if (gaps.length > 0) {
          console.log(`[Reconcile] ${symbol}/${tf}: ${gaps.length} gaps found — repairing...`);
          const { inserted, interpolated, errors: repErr } = await repairAllGaps(symbol, tf, client);
          candlesInserted += inserted + interpolated;
          gapsInterpolated += interpolated;
          gapsRepaired += gaps.length - repErr.length;
          repairErrors.push(...repErr);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        repairErrors.push(`${tf} repair: ${msg}`);
      }
    }
  } else {
    console.warn(`[Reconcile] ${symbol}: No 1m base data — skipping gap repair. Download historical data first.`);
  }

  // ── Step 3: Re-check after repair ────────────────────────────────────
  const [post1m] = await db
    .select({ cnt: count() })
    .from(candlesTable)
    .where(and(eq(candlesTable.symbol, symbol), eq(candlesTable.timeframe, "1m")));
  const postBase1m = Number(post1m?.cnt ?? 0);
  const canEnrich = postBase1m >= MIN_BASE_1M_FOR_ENRICHMENT;

  // ── Step 4: Enrich derived TFs (only if base is sufficient) ──────────
  let enrichInserted = 0;
  let enrichSkipped = 0;
  const enrichErrors: string[] = [];
  let enrichRan = false;

  if (canEnrich) {
    try {
      const { enrichTimeframes } = await import("./candleEnrichment.js");
      const result = await enrichTimeframes(symbol);
      enrichInserted = result.inserted;
      enrichSkipped  = result.skipped;
      enrichRan = true;
      console.log(`[Reconcile] ${symbol}: enrichment complete — ${result.inserted} inserted, ${result.skipped} skipped`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      enrichErrors.push(`enrichment failed: ${msg}`);
      console.error(`[Reconcile] ${symbol} enrichment error: ${msg}`);
      errors.push(msg);
    }
  } else {
    const reason = `Skipping enrichment: only ${postBase1m} 1m candles after repair (minimum ${MIN_BASE_1M_FOR_ENRICHMENT})`;
    enrichErrors.push(reason);
    console.warn(`[Reconcile] ${symbol}: ${reason}`);
    if (insufficiencyReason) errors.push(insufficiencyReason);
  }

  const durationMs = Date.now() - start;
  console.log(
    `[Reconcile] ${symbol}: done in ${durationMs}ms | gaps=${gapsFound} repaired=${gapsRepaired} ` +
    `interpolated=${gapsInterpolated} inserted=${candlesInserted} enriched=${enrichInserted} ` +
    `errors=${errors.length + repairErrors.length + enrichErrors.length}`,
  );

  return {
    symbol,
    baseCheck: {
      base1mCount:              priorBase1m,
      base5mCount:              priorBase5m,
      sufficientForEnrichment:  priorBase1m >= MIN_BASE_1M_FOR_ENRICHMENT,
      insufficiencyReason,
    },
    repair: {
      gapsFound,
      gapsRepaired,
      gapsInterpolated,
      candlesInserted,
      errors: repairErrors,
    },
    enrichment: {
      inserted: enrichInserted,
      skipped:  enrichSkipped,
      errors:   enrichErrors,
      ran:      enrichRan,
    },
    postCheck: {
      base1mCount:      postBase1m,
      improvementDelta: postBase1m - priorBase1m,
    },
    errors,
    durationMs,
  };
}

/**
 * Quick data status summary for a symbol — counts per timeframe.
 * Lightweight — uses COUNT queries only.
 */
export async function getSymbolDataSummary(symbol: string): Promise<{
  symbol: string;
  base1mCount: number;
  timeframes: Array<{
    timeframe: string;
    count: number;
    firstDate: string | null;
    lastDate: string | null;
    ageHours: number | null;
  }>;
}> {
  const results = [];
  let base1mCount = 0;

  for (const tf of Object.keys(ENRICHMENT_TIMEFRAMES)) {
    const [row] = await db
      .select({
        cnt: count(),
        first: min(candlesTable.openTs),
        last: max(candlesTable.openTs),
      })
      .from(candlesTable)
      .where(and(eq(candlesTable.symbol, symbol), eq(candlesTable.timeframe, tf)));

    const cnt = Number(row?.cnt ?? 0);
    const first = row?.first ?? null;
    const last = row?.last ?? null;
    const ageHours = last ? Math.round((Date.now() / 1000 - last) / 3600 * 10) / 10 : null;

    if (tf === "1m") base1mCount = cnt;

    results.push({
      timeframe: tf,
      count: cnt,
      firstDate: first ? new Date(first * 1000).toISOString().slice(0, 10) : null,
      lastDate: last ? new Date(last * 1000).toISOString().slice(0, 10) : null,
      ageHours,
    });
  }

  return { symbol, base1mCount, timeframes: results };
}
