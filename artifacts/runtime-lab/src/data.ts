import pg from "pg";
import type { Candle, DetectedMove, LabRequest, ServiceId } from "./types.js";

export const DEFAULT_SYMBOLS: ServiceId[] = ["CRASH300", "R_75", "BOOM300", "R_100"];

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set for Runtime Lab.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  max: 4,
});

pool.on("error", (error) => {
  console.error("[RuntimeLab] DB pool error:", error.message);
});

export function normalizeRequest(request: LabRequest): Required<Pick<LabRequest, "serviceId" | "family" | "direction" | "targetPct">> & LabRequest {
  return {
    serviceId: request.serviceId ?? "R_75",
    family: request.family ?? "all",
    direction: request.direction ?? "all",
    targetPct: Number.isFinite(request.targetPct) ? Number(request.targetPct) : 5,
    fromTs: request.fromTs,
    toTs: request.toTs,
    maxCandles: request.maxCandles,
  };
}

export async function loadCandles(request: LabRequest): Promise<Candle[]> {
  const normalized = normalizeRequest(request);
  const params: unknown[] = [normalized.serviceId, "1m"];
  const filters: string[] = ["symbol = $1", "timeframe = $2"];
  if (normalized.fromTs != null) {
    params.push(normalized.fromTs);
    filters.push(`open_ts >= $${params.length}`);
  }
  if (normalized.toTs != null) {
    params.push(normalized.toTs);
    filters.push(`open_ts <= $${params.length}`);
  }
  const limit = normalized.maxCandles && normalized.maxCandles > 0
    ? Math.floor(normalized.maxCandles)
    : 250_000;
  params.push(limit);
  const result = await pool.query(
    `select *
       from (
        select open_ts, close_ts, open, high, low, close, tick_count, is_interpolated
          from candles
         where ${filters.join(" and ")}
         order by open_ts desc
         limit $${params.length}
       ) latest_window
      order by open_ts asc`,
    params,
  );
  return result.rows.map((row) => ({
    openTs: Number(row.open_ts),
    closeTs: Number(row.close_ts),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    tickCount: Number(row.tick_count ?? 0),
    isInterpolated: Boolean(row.is_interpolated),
  }));
}

export async function loadDetectedMoves(request: LabRequest): Promise<DetectedMove[]> {
  const normalized = normalizeRequest(request);
  const params: unknown[] = [normalized.serviceId, normalized.targetPct / 100];
  const filters: string[] = ["symbol = $1", "abs(move_pct) >= $2"];
  const inferredBounds = await inferLatestCandleBounds(normalized);
  if (normalized.family !== "all") {
    params.push(normalized.family);
    filters.push(`coalesce(nullif(strategy_family_candidate, 'unknown'), move_type) = $${params.length}`);
  }
  if (normalized.direction !== "all") {
    const moveDirection = normalized.direction === "buy" ? "up" : normalized.direction === "sell" ? "down" : normalized.direction;
    params.push(moveDirection);
    filters.push(`direction = $${params.length}`);
  }
  const fromTs = normalized.fromTs ?? inferredBounds?.fromTs;
  const toTs = normalized.toTs ?? inferredBounds?.toTs;
  if (fromTs != null) {
    params.push(fromTs);
    filters.push(`start_ts >= $${params.length}`);
  }
  if (toTs != null) {
    params.push(toTs);
    filters.push(`start_ts <= $${params.length}`);
  }
  const result = await pool.query(
    `select id, symbol, direction, move_type, strategy_family_candidate, start_ts, end_ts,
            start_price, end_price, move_pct, holding_minutes, quality_score, quality_tier
       from detected_moves
      where ${filters.join(" and ")}
      order by start_ts asc`,
    params,
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    symbol: String(row.symbol),
    direction: row.direction === "down" ? "down" : "up",
    moveType: String(row.move_type ?? "unknown"),
    strategyFamilyCandidate: String(row.strategy_family_candidate ?? "unknown"),
    startTs: Number(row.start_ts),
    endTs: Number(row.end_ts),
    startPrice: Number(row.start_price),
    endPrice: Number(row.end_price),
    movePct: Number(row.move_pct),
    holdingMinutes: Number(row.holding_minutes),
    qualityScore: Number(row.quality_score ?? 0),
    qualityTier: String(row.quality_tier ?? "D"),
  }));
}

async function inferLatestCandleBounds(request: ReturnType<typeof normalizeRequest>): Promise<{ fromTs: number; toTs: number } | null> {
  if (!request.maxCandles || request.maxCandles <= 0 || request.fromTs != null || request.toTs != null) return null;
  const result = await pool.query(
    `select min(open_ts) as from_ts, max(open_ts) as to_ts
       from (
        select open_ts
          from candles
         where symbol = $1 and timeframe = '1m'
         order by open_ts desc
         limit $2
       ) latest_window`,
    [request.serviceId, Math.floor(request.maxCandles)],
  );
  const row = result.rows[0];
  if (!row || row.from_ts == null || row.to_ts == null) return null;
  return {
    fromTs: Number(row.from_ts),
    toTs: Number(row.to_ts),
  };
}

export async function dataAudit(request: LabRequest): Promise<unknown> {
  const normalized = normalizeRequest(request);
  const candles = await loadCandles(normalized);
  const moves = await loadDetectedMoves(normalized);
  const duplicateCount = countDuplicateTimestamps(candles);
  const gaps = countGaps(candles);
  return {
    serviceId: normalized.serviceId,
    family: normalized.family,
    direction: normalized.direction,
    targetPct: normalized.targetPct,
    candles: {
      count: candles.length,
      firstTs: candles[0]?.openTs ?? null,
      lastTs: candles.at(-1)?.openTs ?? null,
      interpolated: candles.filter((candle) => candle.isInterpolated).length,
      duplicateTimestamps: duplicateCount,
      missingOneMinuteGaps: gaps,
      usable: candles.length > 1000 && duplicateCount === 0,
    },
    detectedMoves: {
      count: moves.length,
      firstStartTs: moves[0]?.startTs ?? null,
      lastStartTs: moves.at(-1)?.startTs ?? null,
      averageMovePct: moves.length > 0 ? moves.reduce((sum, move) => sum + Math.abs(move.movePct), 0) / moves.length : 0,
      usableAsLabels: moves.length > 0,
    },
    blockers: candles.length === 0 ? ["no_candles_loaded"] : [],
    warnings: gaps > 0 ? [`missing_1m_gaps:${gaps}`] : [],
  };
}

function countDuplicateTimestamps(candles: Candle[]): number {
  const seen = new Set<number>();
  let duplicates = 0;
  for (const candle of candles) {
    if (seen.has(candle.openTs)) duplicates += 1;
    seen.add(candle.openTs);
  }
  return duplicates;
}

function countGaps(candles: Candle[]): number {
  let gaps = 0;
  for (let i = 1; i < candles.length; i += 1) {
    const previous = candles[i - 1];
    const current = candles[i];
    if (!previous || !current) continue;
    if (Math.round(current.openTs - previous.openTs) > 60) gaps += 1;
  }
  return gaps;
}
