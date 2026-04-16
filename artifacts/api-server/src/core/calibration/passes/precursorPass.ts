/**
 * precursorPass.ts — AI Pass 1: Precursor Identification
 *
 * For each detected move, analyzes the 48–96 bars BEFORE the move started
 * to identify consistent precursor conditions. Determines whether the
 * existing engine set would have fired on this move (engine coverage).
 *
 * Output stored to move_precursor_passes.
 */

import { db, backgroundDb } from "@workspace/db";
import {
  candlesTable,
  movePrecursorPassesTable,
  type DetectedMoveRow,
} from "@workspace/db";
import { eq, and, gte, lte, asc } from "drizzle-orm";
import { chatComplete } from "../../../infrastructure/openai.js";
import { retrieveContext } from "../../ai/contextRetriever.js";

const PRECURSOR_LOOKBACK_BARS = 96;

// Engine coverage rules (deterministic, not AI)
const ENGINE_MAP: Record<string, { symbols: string[]; direction: string; leadInShapes: string[] }> = {
  "boom_expansion_engine":        { symbols: ["BOOM300"], direction: "down", leadInShapes: ["trending", "expanding"] },
  "crash_expansion_engine":       { symbols: ["CRASH300"], direction: "up", leadInShapes: ["trending", "expanding"] },
  "r75_reversal_engine":          { symbols: ["R_75"], direction: "both", leadInShapes: ["ranging", "trending"] },
  "r75_continuation_engine":      { symbols: ["R_75"], direction: "both", leadInShapes: ["trending"] },
  "r75_breakout_engine":          { symbols: ["R_75"], direction: "both", leadInShapes: ["compressing"] },
  "r100_reversal_engine":         { symbols: ["R_100"], direction: "both", leadInShapes: ["ranging", "trending"] },
  "r100_continuation_engine":     { symbols: ["R_100"], direction: "both", leadInShapes: ["trending"] },
  "r100_breakout_engine":         { symbols: ["R_100"], direction: "both", leadInShapes: ["compressing"] },
};

function findMatchingEngine(move: DetectedMoveRow): string | null {
  for (const [engineName, rule] of Object.entries(ENGINE_MAP)) {
    if (!rule.symbols.includes(move.symbol)) continue;
    if (rule.direction !== "both" && rule.direction !== move.direction) continue;
    if (rule.leadInShapes.includes(move.leadInShape)) return engineName;
  }
  return null;
}

function wouldEngineFire(move: DetectedMoveRow, engineMatched: string | null): boolean {
  if (!engineMatched) return false;
  // Heuristic: engine fires if quality tier is A or B (move was strong/clear enough)
  return move.qualityTier === "A" || move.qualityTier === "B";
}

export async function runPrecursorPass(
  move: DetectedMoveRow,
  runId: number,
): Promise<void> {
  const precursorFrom = move.startTs - PRECURSOR_LOOKBACK_BARS * 60;

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
        gte(candlesTable.openTs, precursorFrom),
        lte(candlesTable.openTs, move.startTs),
        eq(candlesTable.isInterpolated, false),
      ),
    )
    .orderBy(asc(candlesTable.openTs));

  if (candles.length < 10) {
    await db.insert(movePrecursorPassesTable).values({
      moveId:       move.id,
      symbol:       move.symbol,
      direction:    move.direction,
      moveType:     move.moveType,
      missedReason: "Insufficient precursor candle data",
      leadInSummary: "No data",
      passRunId:    runId,
    });
    return;
  }

  const engineMatched = findMatchingEngine(move);
  const engineWouldFire = wouldEngineFire(move, engineMatched);

  const ohlcSummary = candles
    .filter((_, i) => i % 6 === 0)
    .slice(-16)
    .map(c => `o=${c.open.toFixed(4)} h=${c.high.toFixed(4)} l=${c.low.toFixed(4)} c=${c.close.toFixed(4)}`)
    .join(" | ");

  const startPrice = candles[0]?.close ?? move.startPrice;
  const endPrice   = candles[candles.length - 1]?.close ?? move.startPrice;
  const preMovePct = ((endPrice - startPrice) / startPrice * 100).toFixed(2);

  const context = move.contextJson as Record<string, unknown>;

  const retrievedCtx = await retrieveContext(
    `${move.symbol} ${move.moveType} ${move.direction} precursor conditions lead-in ${move.leadInShape}`,
    6,
  ).catch(() => "");

  const prompt = `${retrievedCtx ? `=== RETRIEVED SYSTEM CONTEXT ===\n${retrievedCtx}\n\n` : ""}You are analyzing market data for a Deriv synthetic index calibration system.
Symbol: ${move.symbol} | Move: ${move.direction.toUpperCase()} ${(move.movePct * 100).toFixed(1)}% over ${(move.holdingMinutes / 60).toFixed(1)}h
Move type: ${move.moveType} | Quality: ${move.qualityTier} (score ${move.qualityScore.toFixed(0)}/100)
Lead-in shape: ${move.leadInShape} | EMA slope at start: ${context?.emaSlope ?? "N/A"}
Spike count 4h: ${move.spikeCount4h} | Directional persistence: ${(move.directionalPersistence * 100).toFixed(0)}%
Range expansion: ${typeof move.rangeExpansion === "number" ? move.rangeExpansion.toFixed(2) : "N/A"}x ATR

Pre-move price action (${candles.length} bars, sampled every 6):
${ohlcSummary}
Pre-move price drift: ${preMovePct}% (positive = up before the main move)

ENGINE COVERAGE CHECK:
Matched engine: ${engineMatched ?? "none"}
Engine would fire: ${engineWouldFire}
System engines: boom_expansion_engine (BOOM300 down), crash_expansion_engine (CRASH300 up),
  r75_reversal_engine, r75_continuation_engine, r75_breakout_engine (R_75),
  r100_reversal_engine, r100_continuation_engine, r100_breakout_engine (R_100)

TASK: Identify the top 3-5 structural precursor conditions that existed BEFORE this move.
These should be observable market conditions, not engine internals.

Respond with ONLY valid JSON:
{
  "precursorConditions": [
    {"condition": "<descriptive name>", "strength": "strong|moderate|weak", "detail": "<1 sentence>"}
  ],
  "missedReason": "<if engine_would_fire=false, why would current engines miss this? null if engines cover it>",
  "leadInSummary": "<1-2 sentence narrative of the pre-move market state>",
  "confidenceScore": <0.0-1.0>
}`;

  const response = await chatComplete({
    messages: [{ role: "user", content: prompt }],
    max_tokens: 500,
    temperature: 0.25,
  });

  const raw = response.choices[0]?.message?.content?.trim() ?? "";
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON in precursor pass response");
  const parsed = JSON.parse(match[0]);

  await db.insert(movePrecursorPassesTable).values({
    moveId:              move.id,
    symbol:              move.symbol,
    direction:           move.direction,
    moveType:            move.moveType,
    engineMatched,
    engineWouldFire,
    precursorConditions: parsed.precursorConditions ?? [],
    missedReason:        parsed.missedReason ?? null,
    leadInSummary:       parsed.leadInSummary ?? "",
    confidenceScore:     Math.max(0, Math.min(1, Number(parsed.confidenceScore) || 0)),
    rawAiResponse:       parsed,
    passRunId:           runId,
  });
}
