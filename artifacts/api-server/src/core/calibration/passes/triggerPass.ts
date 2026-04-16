/**
 * triggerPass.ts — AI Pass 2: Earliest Entry Trigger Identification
 *
 * For each detected move, analyzes the first 24–48 bars OF the move to find
 * the earliest structurally valid entry signal. Reports slippage from move
 * start and what fraction of the move would have been captured.
 *
 * Output stored to move_behavior_passes (pass_name="trigger").
 */

import { db, backgroundDb } from "@workspace/db";
import {
  candlesTable,
  moveBehaviorPassesTable,
  type DetectedMoveRow,
} from "@workspace/db";
import { eq, and, gte, lte, asc } from "drizzle-orm";
import { getOpenAIClient } from "../../../infrastructure/openai.js";

const TRIGGER_SCAN_BARS = 48;

export async function runTriggerPass(
  move: DetectedMoveRow,
  runId: number,
): Promise<void> {
  const triggerEnd = move.startTs + TRIGGER_SCAN_BARS * 60;

  const candles = await backgroundDb
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
        eq(candlesTable.symbol, move.symbol),
        eq(candlesTable.timeframe, "1m"),
        gte(candlesTable.openTs, move.startTs),
        lte(candlesTable.openTs, Math.min(triggerEnd, move.endTs)),
        eq(candlesTable.isInterpolated, false),
      ),
    )
    .orderBy(asc(candlesTable.openTs));

  if (candles.length < 5) {
    await db.insert(moveBehaviorPassesTable).values({
      moveId:       move.id,
      symbol:       move.symbol,
      direction:    move.direction,
      passName:     "trigger",
      passRunId:    runId,
      exitNarrative: "Insufficient candle data for trigger analysis",
    });
    return;
  }

  const ohlcSummary = candles
    .slice(0, Math.min(32, candles.length))
    .map((c, i) => `[${i}] o=${c.open.toFixed(4)} h=${c.high.toFixed(4)} l=${c.low.toFixed(4)} c=${c.close.toFixed(4)}`)
    .join("\n");

  const totalMoveRange = Math.abs(move.endPrice - move.startPrice);

  const prompt = `You are analyzing the opening bars of a confirmed structural market move.

Symbol: ${move.symbol} | Direction: ${move.direction.toUpperCase()}
Total move: ${(move.movePct * 100).toFixed(1)}% from ${move.startPrice.toFixed(4)} to ${move.endPrice.toFixed(4)}
Move type: ${move.moveType} | Duration: ${(move.holdingMinutes / 60).toFixed(1)}h

First ${candles.length} 1m bars of the move (bar index from move start):
${ohlcSummary}

TASK: Identify the EARLIEST bar where a structurally valid entry existed.
A valid entry requires: momentum confirmation + directional continuation signal
(e.g. body breakout, first higher low for up, first lower high for down, momentum bar).

Rules:
- Bar 0 is move start (NEVER a valid entry — no confirmation yet)
- For REVERSAL moves: look for first confirmed reversal candle (body > 50% of range, direction aligned)
- For BREAKOUT moves: look for first bar that closes beyond the pre-move range
- For CONTINUATION moves: look for first pullback-and-continuation pattern

Respond with ONLY valid JSON:
{
  "earliestEntryBar": <integer 1-${candles.length - 1}>,
  "earliestEntryPrice": <close price at that bar>,
  "entrySlippagePct": <pct above/below start price — negative means favorable slip for direction>,
  "captureablePct": <fraction 0.0-1.0 of the total ${(move.movePct * 100).toFixed(1)}% move capturable from earliest entry>,
  "triggerConditions": [
    {"condition": "<name>", "barIndex": <int>, "detail": "<1 sentence>"}
  ],
  "exitNarrative": "<1 sentence on how the entry bar signals the move is underway>",
  "confidenceScore": <0.0-1.0>
}`;

  const client = await getOpenAIClient();
  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 400,
    temperature: 0.2,
  });

  const raw = response.choices[0]?.message?.content?.trim() ?? "";
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON in trigger pass response");
  const parsed = JSON.parse(match[0]);

  const entryBarIdx = Math.max(1, Math.min(Number(parsed.earliestEntryBar) || 1, candles.length - 1));
  const entryCandle = candles[entryBarIdx];
  const entryPrice  = entryCandle?.close ?? move.startPrice;
  const slippage    = (entryPrice - move.startPrice) / move.startPrice;
  const captureable = Math.max(0, Math.min(1, Number(parsed.captureablePct) || 0));

  const dir = move.direction as "up" | "down";
  const mfePct = direction_mfe(candles, entryBarIdx, dir);
  const maePct = direction_mae(candles, entryBarIdx, dir);
  const barsToMfePeak = direction_bars_to_mfe(candles, entryBarIdx, dir);

  await db.insert(moveBehaviorPassesTable).values({
    moveId:             move.id,
    symbol:             move.symbol,
    direction:          move.direction,
    passName:           "trigger",
    earliestEntryTs:    entryCandle?.openTs ?? move.startTs,
    earliestEntryPrice: entryPrice,
    entrySlippage:      slippage,
    captureablePct:     captureable,
    maxFavorablePct:    mfePct,
    maxAdversePct:      maePct,
    barsToMfePeak,
    triggerConditions:  parsed.triggerConditions ?? [],
    exitNarrative:      parsed.exitNarrative ?? "",
    holdabilityScore:   Math.max(0, Math.min(1, Number(parsed.confidenceScore) || 0)),
    rawAiResponse:      parsed,
    passRunId:          runId,
  });
}

function direction_mfe(
  candles: { close: number; high: number; low: number }[],
  entryIdx: number,
  dir: "up" | "down",
): number {
  const entry = candles[entryIdx]?.close ?? 0;
  if (entry === 0) return 0;
  let best = entry;
  for (let i = entryIdx; i < candles.length; i++) {
    if (dir === "up" && candles[i].high > best) best = candles[i].high;
    if (dir === "down" && candles[i].low < best) best = candles[i].low;
  }
  return Math.abs((best - entry) / entry);
}

function direction_mae(
  candles: { close: number; high: number; low: number }[],
  entryIdx: number,
  dir: "up" | "down",
): number {
  const entry = candles[entryIdx]?.close ?? 0;
  if (entry === 0) return 0;
  let worst = entry;
  for (let i = entryIdx; i < candles.length; i++) {
    if (dir === "up" && candles[i].low < worst) worst = candles[i].low;
    if (dir === "down" && candles[i].high > worst) worst = candles[i].high;
  }
  return Math.abs((worst - entry) / entry);
}

function direction_bars_to_mfe(
  candles: { close: number; high: number; low: number }[],
  entryIdx: number,
  dir: "up" | "down",
): number {
  const entry = candles[entryIdx]?.close ?? 0;
  if (entry === 0) return 0;
  let best = entry;
  let bestIdx = entryIdx;
  for (let i = entryIdx; i < candles.length; i++) {
    if (dir === "up" && candles[i].high > best) { best = candles[i].high; bestIdx = i; }
    if (dir === "down" && candles[i].low < best) { best = candles[i].low; bestIdx = i; }
  }
  return bestIdx - entryIdx;
}
