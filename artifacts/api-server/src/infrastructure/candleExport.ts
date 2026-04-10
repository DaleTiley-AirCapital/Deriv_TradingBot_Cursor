/**
 * Research Export Library
 * Streams a ZIP bundle of raw candle data with manifest and validation metadata.
 * Export-layer only — no trading, signal, or strategy logic.
 *
 * Supported timeframes align exactly with candleEnrichment.ts DERIVED_TIMEFRAMES
 * plus the 1m base. Any unsupported TF throws immediately — no silent 60s fallback.
 */
import { backgroundDb, candlesTable } from "@workspace/db";
import { eq, and, gte, lt, asc, sql } from "drizzle-orm";
import archiver from "archiver";
import type { Response } from "express";
import { ENRICHMENT_TIMEFRAMES } from "../core/dataIntegrity.js";

const DB_BATCH_SIZE = 10_000;
const DEFAULT_MAX_CHUNK = 25_000;

export interface ResearchExportRequest {
  symbol: string;
  timeframe: string;
  startDate: string;
  endDate: string;
  maxCandlesPerChunk?: number;
  includeCsv?: boolean;
}

interface ExportCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  tickCount: number;
  isInterpolated?: boolean;
  source?: string;
}

interface ChunkMeta {
  fileName: string;
  candleCount: number;
  firstTimestamp: number;
  lastTimestamp: number;
}

interface ChunkPlan {
  fileName: string;
  monthKey: string;
  mStart: number;
  mEnd: number;
  offsetInMonth: number;
  limit: number;
  chunkIndex: number;
  totalChunks: number;
}

/**
 * Converts a timeframe key to its duration in seconds.
 * Covers all 12 enrichment timeframes (1m → 4d).
 * Throws for any unsupported timeframe — no silent 60s fallback.
 */
function tfToSeconds(tf: string): number {
  const secs = ENRICHMENT_TIMEFRAMES[tf];
  if (!secs) {
    throw new Error(
      `Unsupported timeframe "${tf}". Supported: ${Object.keys(ENRICHMENT_TIMEFRAMES).join(", ")}`,
    );
  }
  return secs;
}

function monthKeyToStartTs(mk: string): number {
  const [y, m] = mk.split("-").map(Number);
  return Date.UTC(y, m - 1, 1) / 1000;
}

function monthKeyToEndTs(mk: string): number {
  const [y, m] = mk.split("-").map(Number);
  return Date.UTC(y, m, 1) / 1000;
}

function getMonthKeys(startTs: number, endTs: number): string[] {
  const keys: string[] = [];
  const d = new Date(startTs * 1000);
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  const endDate = new Date(endTs * 1000);
  while (d < endDate) {
    keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return keys;
}

export async function streamResearchExport(
  req: ResearchExportRequest,
  res: Response,
): Promise<void> {
  const { symbol, timeframe, startDate, endDate, includeCsv = false } = req;
  const maxChunk = req.maxCandlesPerChunk ?? DEFAULT_MAX_CHUNK;
  const tfSecs = tfToSeconds(timeframe);
  const exportDate = new Date().toISOString();

  const startTs = new Date(startDate + "T00:00:00.000Z").getTime() / 1000;
  const endTs = new Date(endDate + "T00:00:00.000Z").getTime() / 1000 + 86400;

  const monthKeys = getMonthKeys(startTs, endTs);

  interface MonthInfo {
    key: string;
    startTs: number;
    endTs: number;
    count: number;
  }

  const months: MonthInfo[] = [];
  for (const key of monthKeys) {
    const mStart = Math.max(monthKeyToStartTs(key), startTs);
    const mEnd = Math.min(monthKeyToEndTs(key), endTs);
    const result = await backgroundDb
      .select({ cnt: sql<number>`count(*)::int` })
      .from(candlesTable)
      .where(and(
        eq(candlesTable.symbol, symbol),
        eq(candlesTable.timeframe, timeframe),
        gte(candlesTable.openTs, mStart),
        lt(candlesTable.openTs, mEnd),
      ));
    const cnt = Number(result[0]?.cnt ?? 0);
    if (cnt > 0) {
      months.push({ key, startTs: mStart, endTs: mEnd, count: cnt });
    }
  }

  if (months.length === 0) {
    res.status(404).json({
      error: `No candles found for ${symbol}/${timeframe} between ${startDate} and ${endDate}`,
    });
    return;
  }

  const chunkPlans: ChunkPlan[] = [];
  let globalIdx = 0;

  for (const month of months) {
    const nChunks = Math.max(1, Math.ceil(month.count / maxChunk));
    for (let c = 0; c < nChunks; c++) {
      const chunkNum = String(c + 1).padStart(3, "0");
      chunkPlans.push({
        fileName: `${symbol}_${month.key}_chunk_${chunkNum}.json`,
        monthKey: month.key,
        mStart: month.startTs,
        mEnd: month.endTs,
        offsetInMonth: c * maxChunk,
        limit: maxChunk,
        chunkIndex: ++globalIdx,
        totalChunks: 0,
      });
    }
  }

  const totalChunks = chunkPlans.length;
  for (const p of chunkPlans) p.totalChunks = totalChunks;
  const totalExpected = months.reduce((s, m) => s + m.count, 0);

  const zipName = `${symbol}_research_pack_${startDate}_to_${endDate}.zip`;
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);

  const archive = archiver("zip", { zlib: { level: 6 } });

  const finalizePromise = new Promise<void>((resolve, reject) => {
    archive.on("close", resolve);
    archive.on("error", reject);
  });

  archive.pipe(res);

  const chunkMetas: ChunkMeta[] = [];
  let totalExported = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let prevTs: number | null = null;
  let duplicateCount = 0;
  let missingCount = 0;
  let interpolatedCount = 0;
  let strictlyAscending = true;

  for (const plan of chunkPlans) {
    const candles: ExportCandle[] = [];

    let batchOffset = plan.offsetInMonth;
    let remaining = plan.limit;

    while (remaining > 0) {
      const batchSize = Math.min(DB_BATCH_SIZE, remaining);
      const batch = await backgroundDb
        .select({
          openTs:         candlesTable.openTs,
          open:           candlesTable.open,
          high:           candlesTable.high,
          low:            candlesTable.low,
          close:          candlesTable.close,
          tickCount:      candlesTable.tickCount,
          isInterpolated: candlesTable.isInterpolated,
          source:         candlesTable.source,
        })
        .from(candlesTable)
        .where(and(
          eq(candlesTable.symbol, symbol),
          eq(candlesTable.timeframe, timeframe),
          gte(candlesTable.openTs, plan.mStart),
          lt(candlesTable.openTs, plan.mEnd),
        ))
        .orderBy(asc(candlesTable.openTs))
        .limit(batchSize)
        .offset(batchOffset);

      if (batch.length === 0) break;

      for (const row of batch) {
        const ts = row.openTs;

        if (prevTs !== null) {
          if (ts <= prevTs) {
            strictlyAscending = false;
            if (ts === prevTs) duplicateCount++;
          } else {
            const gap = ts - prevTs;
            if (gap > tfSecs * 1.5) {
              missingCount += Math.round(gap / tfSecs) - 1;
            }
          }
        }
        prevTs = ts;
        if (firstTs === null) firstTs = ts;
        lastTs = ts;

        const isInterp = row.isInterpolated ?? false;
        if (isInterp) interpolatedCount++;

        candles.push({
          timestamp:      ts,
          open:           row.open,
          high:           row.high,
          low:            row.low,
          close:          row.close,
          tickCount:      row.tickCount,
          isInterpolated: isInterp,
          source:         row.source ?? "historical",
        });
      }

      batchOffset += batch.length;
      remaining -= batch.length;
      if (batch.length < batchSize) break;
    }

    totalExported += candles.length;
    const chunkFirst = candles.length > 0 ? candles[0].timestamp : 0;
    const chunkLast = candles.length > 0 ? candles[candles.length - 1].timestamp : 0;

    const chunkJson = JSON.stringify({
      symbol,
      timeframe,
      exportDate,
      chunkIndex: plan.chunkIndex,
      totalChunks: plan.totalChunks,
      candleCount: candles.length,
      firstTimestamp: chunkFirst,
      lastTimestamp: chunkLast,
      candles,
    });
    archive.append(Buffer.from(chunkJson, "utf8"), { name: plan.fileName });

    // Optional CSV chunk file
    if (includeCsv) {
      const csvLines = ["timestamp,open,high,low,close,tickCount"];
      for (const c of candles) {
        csvLines.push(`${c.timestamp},${c.open},${c.high},${c.low},${c.close},${c.tickCount}`);
      }
      archive.append(Buffer.from(csvLines.join("\n"), "utf8"), {
        name: plan.fileName.replace(".json", ".csv"),
      });
    }

    chunkMetas.push({
      fileName: plan.fileName,
      candleCount: candles.length,
      firstTimestamp: chunkFirst,
      lastTimestamp: chunkLast,
    });
  }

  const manifest = {
    symbol,
    timeframe,
    exportCreatedAt: exportDate,
    sourceStartTimestamp: startTs,
    sourceEndTimestamp: endTs - 1,
    totalCandles: totalExported,
    totalChunks,
    chunkFiles: chunkMetas,
  };
  archive.append(Buffer.from(JSON.stringify(manifest, null, 2), "utf8"), {
    name: "manifest.json",
  });

  const notes: string[] = [];
  if (missingCount > 0) {
    notes.push(`${missingCount} missing ${timeframe} interval(s) detected — reported only, not filled.`);
  }
  if (duplicateCount > 0) {
    notes.push(`${duplicateCount} duplicate timestamp(s) detected — reported only, not removed.`);
  }
  if (!strictlyAscending) {
    notes.push("WARNING: Timestamps are not strictly ascending — data integrity issue.");
  }
  if (totalExported !== totalExpected) {
    notes.push(`Candle count mismatch: COUNT query returned ${totalExpected}, actual export produced ${totalExported}.`);
  }
  if (interpolatedCount > 0) {
    notes.push(`${interpolatedCount} interpolated (carry-forward) candle(s) included — marked isInterpolated=true. Exclude from signal generation.`);
  }

  const validationPassed = strictlyAscending && duplicateCount === 0 && totalExported === totalExpected;

  const validation = {
    symbol,
    timeframe,
    totalCandlesExpected:        totalExpected,
    totalCandlesExported:        totalExported,
    duplicateTimestampCount:     duplicateCount,
    missingIntervalCount:        missingCount,
    interpolatedCandleCount:     interpolatedCount,
    timestampsStrictlyAscending: strictlyAscending,
    firstTimestamp:              firstTs,
    lastTimestamp:               lastTs,
    validationPassed,
    notes: notes.length > 0 ? notes.join(" ") : "All validation checks passed.",
  };
  archive.append(Buffer.from(JSON.stringify(validation, null, 2), "utf8"), {
    name: "validation.json",
  });

  archive.finalize();
  await finalizePromise;
}
