/**
 * moveDetector.ts — Structural Move Detector (Move-First Calibration)
 *
 * Scans historical 1m candles for qualifying structural moves and stores them
 * in the detected_moves table with full structural context:
 *   - lead-in shape (trending/ranging/compressing/expanding)
 *   - directional persistence (fraction of bars moving in swing direction)
 *   - range/expansion context at move start (ATR ratio)
 *   - candle body characteristics around trigger zone
 *   - spike count (for BOOM/CRASH instruments)
 *   - quality score & tier (A/B/C/D)
 *
 * NEVER uses isInterpolated=true candles (carry-forward rows are excluded).
 * The detected moves are the primary unit of analysis — engine signal-first
 * logic (behaviorCapture/behaviorProfiler) remains a separate comparison layer.
 */

import { db, backgroundDb } from "@workspace/db";
import {
  candlesTable,
  detectedMovesTable,
  type InsertDetectedMoveRow,
} from "@workspace/db";
import { eq, and, gte, lte, asc, inArray } from "drizzle-orm";

// ── Constants ──────────────────────────────────────────────────────────────────

const MIN_MOVE_PCT = 0.05;          // 5% minimum structural move
const MIN_MOVE_BARS = 20;           // at least 20 bars
const LEAD_IN_BARS = 60;            // bars before move start for context
const ATR_PERIOD = 14;              // bars for ATR calculation
const BOOM_CRASH_SYMBOLS = ["BOOM300", "CRASH300"];

// ── Types ──────────────────────────────────────────────────────────────────────

export interface DetectedMove {
  symbol: string;
  direction: "up" | "down";
  moveType: "breakout" | "continuation" | "reversal" | "unknown";
  startTs: number;
  endTs: number;
  startPrice: number;
  endPrice: number;
  movePct: number;
  holdingMinutes: number;
  leadInShape: "trending" | "ranging" | "compressing" | "expanding" | "unknown";
  leadInBars: number;
  directionalPersistence: number;
  rangeExpansion: number;
  spikeCount4h: number;
  qualityScore: number;
  qualityTier: "A" | "B" | "C" | "D";
  contextJson: object;
}

export interface MoveDetectionResult {
  symbol: string;
  windowDays: number;
  totalCandlesScanned: number;
  interpolatedExcluded: number;
  movesDetected: number;
  movesByType: Record<string, number>;
  movesByTier: Record<string, number>;
  savedToDb: number;
}

// ── ATR helpers ────────────────────────────────────────────────────────────────

interface CandleSlim {
  openTs: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

function calcAtr(candles: CandleSlim[], endIdx: number, period = ATR_PERIOD): number {
  const start = Math.max(1, endIdx - period + 1);
  let sum = 0;
  let count = 0;
  for (let i = start; i <= endIdx && i < candles.length; i++) {
    const prev = candles[i - 1].close;
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - prev),
      Math.abs(candles[i].low - prev),
    );
    sum += tr;
    count++;
  }
  return count > 0 ? sum / count : 0;
}

function calcEmaSlope(candles: CandleSlim[], endIdx: number, period = 20): number {
  if (endIdx < period + 1) return 0;
  const k = 2 / (period + 1);
  let ema = candles[endIdx - period].close;
  for (let i = endIdx - period + 1; i <= endIdx; i++) {
    ema = candles[i].close * k + ema * (1 - k);
  }
  const prevEma = candles[endIdx - 1].close * k + ema * (1 - k);
  return (ema - prevEma) / prevEma;
}

function calcBbWidth(candles: CandleSlim[], endIdx: number, period = 20): number {
  if (endIdx < period) return 0;
  const slice = candles.slice(endIdx - period, endIdx + 1).map(c => c.close);
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length;
  const std = Math.sqrt(variance);
  return mean > 0 ? (std * 4) / mean : 0;
}

// ── Lead-in shape classifier ───────────────────────────────────────────────────

function classifyLeadInShape(
  candles: CandleSlim[],
  moveStartIdx: number,
): { shape: "trending" | "ranging" | "compressing" | "expanding" | "unknown"; leadInBars: number } {
  const lookback = Math.min(LEAD_IN_BARS, moveStartIdx);
  if (lookback < 10) return { shape: "unknown", leadInBars: lookback };

  const startIdx = moveStartIdx - lookback;
  const slice = candles.slice(startIdx, moveStartIdx);

  const bbWidthStart = calcBbWidth(candles, startIdx + 10);
  const bbWidthEnd   = calcBbWidth(candles, moveStartIdx - 1);

  const emaSlope = calcEmaSlope(candles, moveStartIdx - 1, 20);
  const absSlope = Math.abs(emaSlope);

  const high = Math.max(...slice.map(c => c.high));
  const low  = Math.min(...slice.map(c => c.low));
  const rangeRatio = high > 0 ? (high - low) / low : 0;

  if (bbWidthEnd < bbWidthStart * 0.75) {
    return { shape: "compressing", leadInBars: lookback };
  }
  if (bbWidthEnd > bbWidthStart * 1.3) {
    return { shape: "expanding", leadInBars: lookback };
  }
  if (absSlope > 0.0003 && rangeRatio > 0.03) {
    return { shape: "trending", leadInBars: lookback };
  }
  return { shape: "ranging", leadInBars: lookback };
}

// ── Directional persistence ────────────────────────────────────────────────────

function calcDirectionalPersistence(
  candles: CandleSlim[],
  startIdx: number,
  endIdx: number,
  direction: "up" | "down",
): number {
  let aligned = 0;
  const total = endIdx - startIdx;
  if (total <= 0) return 0;
  for (let i = startIdx + 1; i <= endIdx && i < candles.length; i++) {
    const delta = candles[i].close - candles[i - 1].close;
    if (direction === "up" && delta > 0) aligned++;
    if (direction === "down" && delta < 0) aligned++;
  }
  return aligned / total;
}

// ── Move type classifier (deterministic) ──────────────────────────────────────

function classifyMoveType(
  shape: string,
  direction: "up" | "down",
  emaSlope: number,
): "breakout" | "continuation" | "reversal" | "unknown" {
  const isTrendingWithMove =
    (shape === "trending" && direction === "up" && emaSlope > 0.0002) ||
    (shape === "trending" && direction === "down" && emaSlope < -0.0002);

  if (shape === "compressing") return "breakout";
  if (isTrendingWithMove) return "continuation";
  if (shape === "ranging" || (shape === "trending" && !isTrendingWithMove)) return "reversal";
  return "unknown";
}

// ── Quality scoring ────────────────────────────────────────────────────────────

function scoreAndTier(move: {
  movePct: number;
  directionalPersistence: number;
  rangeExpansion: number;
  leadInShape: string;
  holdingMinutes: number;
}): { qualityScore: number; qualityTier: "A" | "B" | "C" | "D" } {
  let score = 0;

  // Move size score (0-35): 5%=10pts, 10%=20pts, 20%=30pts, 50%+=35pts
  score += Math.min(35, Math.floor((move.movePct / 0.5) * 35));

  // Directional persistence (0-25): higher = cleaner move
  score += Math.round(move.directionalPersistence * 25);

  // Range expansion (0-20): >1.5 = good, >2.0 = excellent
  const expScore = Math.min(20, Math.round((Math.min(move.rangeExpansion, 3) / 3) * 20));
  score += expScore;

  // Lead-in shape bonus (0-10)
  if (move.leadInShape === "compressing") score += 10;
  else if (move.leadInShape === "ranging") score += 7;
  else if (move.leadInShape === "trending") score += 5;
  else if (move.leadInShape === "expanding") score += 3;

  // Hold duration bonus (0-10): longer = better for long-hold system
  const holdHours = move.holdingMinutes / 60;
  if (holdHours >= 48) score += 10;
  else if (holdHours >= 24) score += 7;
  else if (holdHours >= 8) score += 4;
  else if (holdHours >= 2) score += 2;

  score = Math.min(100, Math.max(0, score));

  const qualityTier: "A" | "B" | "C" | "D" =
    score >= 75 ? "A" :
    score >= 55 ? "B" :
    score >= 35 ? "C" : "D";

  return { qualityScore: score, qualityTier };
}

// ── Spike count for BOOM/CRASH ─────────────────────────────────────────────────

function countSpikes(
  candles: CandleSlim[],
  moveStartIdx: number,
  symbol: string,
  windowBars = 240,
): number {
  if (!BOOM_CRASH_SYMBOLS.includes(symbol)) return 0;
  const start = Math.max(0, moveStartIdx - windowBars);
  let spikes = 0;
  for (let i = start + 1; i < moveStartIdx && i < candles.length; i++) {
    const bodyPct = Math.abs(candles[i].close - candles[i].open) / candles[i].open;
    const wickRatio = (candles[i].high - candles[i].low) > 0
      ? Math.abs(candles[i].close - candles[i].open) / (candles[i].high - candles[i].low)
      : 1;
    if (bodyPct > 0.005 && wickRatio < 0.3) spikes++;
  }
  return spikes;
}

// ── Core swing extraction — threshold-based zigzag ────────────────────────────
//
// Only reverses direction when price retraces >= reversalPct from the current
// extreme. This prevents fragmenting major structural moves on every noise bar.
// reversalPct = 40% of minMovePct (e.g. 2% reversal to flip a 5% move search).

function extractStructuralMoves(
  candles: CandleSlim[],
  symbol: string,
  minMovePct = MIN_MOVE_PCT,
  minMoveBars = MIN_MOVE_BARS,
): DetectedMove[] {
  const moves: DetectedMove[] = [];
  if (candles.length < LEAD_IN_BARS + minMoveBars + 10) return moves;

  // reversalPct: minimum retracement to flip swing direction
  const reversalPct = Math.max(0.01, minMovePct * 0.4);

  let direction: "up" | "down" = "up";
  let swingStartIdx = LEAD_IN_BARS;
  let extremeIdx    = LEAD_IN_BARS;
  let extremePrice  = candles[LEAD_IN_BARS].close;

  // Determine initial direction from first meaningful movement
  for (let i = LEAD_IN_BARS + 1; i < Math.min(LEAD_IN_BARS + 30, candles.length); i++) {
    const delta = (candles[i].close - extremePrice) / extremePrice;
    if (Math.abs(delta) >= reversalPct) {
      direction = delta > 0 ? "up" : "down";
      break;
    }
  }

  for (let i = LEAD_IN_BARS + 1; i < candles.length; i++) {
    const curr = candles[i].close;

    if (direction === "up") {
      if (curr >= extremePrice) {
        // Extend the upswing
        extremePrice = curr;
        extremeIdx   = i;
      } else {
        // Check if reversal threshold met
        const retracement = (extremePrice - curr) / extremePrice;
        if (retracement >= reversalPct) {
          // Record the completed upswing
          recordMove(candles, symbol, swingStartIdx, extremeIdx, direction,
            minMovePct, minMoveBars, moves);
          // Start new downswing from the previous extreme
          swingStartIdx = extremeIdx;
          direction     = "down";
          extremePrice  = curr;
          extremeIdx    = i;
        }
        // else: just a noise bar, extend extreme tracking (don't update extremeIdx since curr < extremePrice)
      }
    } else {
      if (curr <= extremePrice) {
        // Extend the downswing
        extremePrice = curr;
        extremeIdx   = i;
      } else {
        // Check if reversal threshold met
        const retracement = (curr - extremePrice) / extremePrice;
        if (retracement >= reversalPct) {
          // Record the completed downswing
          recordMove(candles, symbol, swingStartIdx, extremeIdx, direction,
            minMovePct, minMoveBars, moves);
          // Start new upswing from the previous extreme
          swingStartIdx = extremeIdx;
          direction     = "up";
          extremePrice  = curr;
          extremeIdx    = i;
        }
      }
    }
  }

  // Capture final open swing if it qualifies
  recordMove(candles, symbol, swingStartIdx, extremeIdx, direction,
    minMovePct, minMoveBars, moves);

  return moves;
}

function recordMove(
  candles: CandleSlim[],
  symbol: string,
  startIdx: number,
  endIdx: number,
  direction: "up" | "down",
  minMovePct: number,
  minMoveBars: number,
  moves: DetectedMove[],
): void {
  if (startIdx >= endIdx) return;
  if (startIdx < LEAD_IN_BARS) return;

  const startPrice = candles[startIdx].close;
  const endPrice   = candles[endIdx].close;
  const movePct    = Math.abs((endPrice - startPrice) / startPrice);
  const swingBars  = endIdx - startIdx;

  if (movePct < minMovePct || swingBars < minMoveBars) return;

  const emaSlope             = calcEmaSlope(candles, startIdx - 1);
  const { shape, leadInBars } = classifyLeadInShape(candles, startIdx);
  const directionalPersistence = calcDirectionalPersistence(candles, startIdx, endIdx, direction);
  const atrStart             = calcAtr(candles, startIdx);
  const atrEnd               = calcAtr(candles, endIdx);
  const rangeExpansion        = atrStart > 0 ? atrEnd / atrStart : 1;
  const spikeCount4h          = countSpikes(candles, startIdx, symbol);
  const moveType              = classifyMoveType(shape, direction, emaSlope);
  const holdingMinutes        = (candles[endIdx].openTs - candles[startIdx].openTs) / 60;

  const { qualityScore, qualityTier } = scoreAndTier({
    movePct,
    directionalPersistence,
    rangeExpansion,
    leadInShape: shape,
    holdingMinutes,
  });

  moves.push({
    symbol,
    direction,
    moveType,
    startTs:    candles[startIdx].openTs,
    endTs:      candles[endIdx].openTs,
    startPrice,
    endPrice,
    movePct,
    holdingMinutes,
    leadInShape:             shape,
    leadInBars,
    directionalPersistence,
    rangeExpansion,
    spikeCount4h,
    qualityScore,
    qualityTier,
    contextJson: {
      emaSlope,
      bbWidthAtStart: calcBbWidth(candles, startIdx),
      atrAtStart: atrStart,
      atrAtEnd:   atrEnd,
      swingBars,
      approxMonthFromTs: new Date(candles[startIdx].openTs * 1000).toISOString().slice(0, 7),
    },
  });
}

// ── Public: detectAndStoreMoves ────────────────────────────────────────────────

export async function detectAndStoreMoves(
  symbol: string,
  windowDays = 90,
  minMovePct = MIN_MOVE_PCT,
  clearExisting = true,
): Promise<MoveDetectionResult> {
  const now  = Math.floor(Date.now() / 1000);
  const from = now - windowDays * 86400;

  const rawCandles = await backgroundDb
    .select({
      openTs: candlesTable.openTs,
      open:   candlesTable.open,
      high:   candlesTable.high,
      low:    candlesTable.low,
      close:  candlesTable.close,
    })
    .from(candlesTable)
    .where(
      and(
        eq(candlesTable.symbol, symbol),
        eq(candlesTable.timeframe, "1m"),
        gte(candlesTable.openTs, from - LEAD_IN_BARS * 60 * 2),
        lte(candlesTable.openTs, now),
        eq(candlesTable.isInterpolated, false),
      ),
    )
    .orderBy(asc(candlesTable.openTs));

  const totalCandlesScanned = rawCandles.length;

  // Count interpolated (already excluded by the where clause — count separately for reporting)
  const allCandles = await backgroundDb
    .select({ openTs: candlesTable.openTs })
    .from(candlesTable)
    .where(
      and(
        eq(candlesTable.symbol, symbol),
        eq(candlesTable.timeframe, "1m"),
        gte(candlesTable.openTs, from - LEAD_IN_BARS * 60 * 2),
        eq(candlesTable.isInterpolated, true),
      ),
    );
  const interpolatedExcluded = allCandles.length;

  const candles = rawCandles as CandleSlim[];
  const moves = extractStructuralMoves(candles, symbol, minMovePct);

  if (clearExisting) {
    await db.delete(detectedMovesTable)
      .where(eq(detectedMovesTable.symbol, symbol));
  }

  let savedToDb = 0;
  if (moves.length > 0) {
    const rows: InsertDetectedMoveRow[] = moves.map(m => ({
      symbol:                 m.symbol,
      direction:              m.direction,
      moveType:               m.moveType,
      startTs:                m.startTs,
      endTs:                  m.endTs,
      startPrice:             m.startPrice,
      endPrice:               m.endPrice,
      movePct:                m.movePct,
      holdingMinutes:         m.holdingMinutes,
      leadInShape:            m.leadInShape,
      leadInBars:             m.leadInBars,
      directionalPersistence: m.directionalPersistence,
      rangeExpansion:         m.rangeExpansion,
      spikeCount4h:           m.spikeCount4h,
      qualityScore:           m.qualityScore,
      qualityTier:            m.qualityTier,
      windowDays,
      isInterpolatedExcluded: true,
      contextJson:            m.contextJson,
    }));

    const BATCH = 100;
    for (let i = 0; i < rows.length; i += BATCH) {
      await db.insert(detectedMovesTable).values(rows.slice(i, i + BATCH));
      savedToDb += Math.min(BATCH, rows.length - i);
    }
  }

  const movesByType: Record<string, number> = {};
  const movesByTier: Record<string, number> = {};
  for (const m of moves) {
    movesByType[m.moveType] = (movesByType[m.moveType] ?? 0) + 1;
    movesByTier[m.qualityTier] = (movesByTier[m.qualityTier] ?? 0) + 1;
  }

  return {
    symbol,
    windowDays,
    totalCandlesScanned,
    interpolatedExcluded,
    movesDetected: moves.length,
    movesByType,
    movesByTier,
    savedToDb,
  };
}

// ── Public: getDetectedMoves ───────────────────────────────────────────────────

export async function getDetectedMoves(
  symbol: string,
  moveType?: string,
  minTier?: "A" | "B" | "C" | "D",
): Promise<typeof detectedMovesTable.$inferSelect[]> {
  const tierOrder: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 };
  const tierThreshold = minTier ? (tierOrder[minTier] ?? 3) : 3;
  const validTiers = (["A", "B", "C", "D"] as const).filter(t => (tierOrder[t] ?? 3) <= tierThreshold);

  type WhereCondition = ReturnType<typeof eq>;
  const conditions: WhereCondition[] = [eq(detectedMovesTable.symbol, symbol)];
  if (moveType) conditions.push(eq(detectedMovesTable.moveType, moveType));
  if (validTiers.length < 4) {
    conditions.push(inArray(detectedMovesTable.qualityTier, [...validTiers]));
  }

  return db.select()
    .from(detectedMovesTable)
    .where(conditions.length === 1 ? conditions[0] : and(...conditions))
    .orderBy(detectedMovesTable.startTs);
}
