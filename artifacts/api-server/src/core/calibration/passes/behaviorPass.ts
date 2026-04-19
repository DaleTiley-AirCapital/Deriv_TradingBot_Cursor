/**
 * behaviorPass.ts — AI Pass 3: Move Behavior Profiling
 *
 * Analyzes HOW a move progressed: smooth vs choppy, gaps, spikes, compressions.
 * Computes holdability score — how survivable the move was for a long-hold system
 * that uses ATR trailing stop activated at 30% of TP (not a scalp stop).
 *
 * Output stored to move_behavior_passes (pass_name="behavior").
 */

import { db, backgroundDb } from "@workspace/db";
import {
  candlesTable,
  moveBehaviorPassesTable,
  type DetectedMoveRow,
} from "@workspace/db";
import { eq, and, gte, lte, asc } from "drizzle-orm";
import { chatComplete } from "../../../infrastructure/openai.js";
import { retrieveContext } from "../../ai/contextRetriever.js";
import { parseAiJsonObject } from "../parseAiJson.js";

const MAX_BEHAVIOR_BARS = 200;

export async function runBehaviorPass(
  move: DetectedMoveRow,
  runId: number,
): Promise<void> {
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
        lte(candlesTable.openTs, move.endTs),
        eq(candlesTable.isInterpolated, false),
      ),
    )
    .orderBy(asc(candlesTable.openTs));

  if (candles.length < 10) {
    await db.insert(moveBehaviorPassesTable).values({
      moveId:       move.id,
      symbol:       move.symbol,
      direction:    move.direction,
      passName:     "behavior",
      passRunId:    runId,
      exitNarrative: "Insufficient candle data for behavior analysis",
    });
    return;
  }

  // Compute MFE/MAE at every 10% interval of the move for progress profiling
  const entry = move.startPrice;
  const totalRange = Math.abs(move.endPrice - entry);

  // Sample bars for prompt (max 30 bars sampled evenly)
  const step = Math.max(1, Math.floor(candles.length / 30));
  const sampled = candles
    .filter((_, i) => i % step === 0)
    .map((c, i) => {
      const pnl = ((move.direction === "up" ? c.close - entry : entry - c.close) / entry * 100).toFixed(1);
      return `[bar≈${Math.round(i * step)}] c=${c.close.toFixed(4)} pnl=${pnl}%`;
    })
    .join(" | ");

  // Count drawdown events (adverse moves > 10% of total range)
  let drawdownEvents = 0;
  let prevClose = entry;
  for (const c of candles) {
    const adverse = move.direction === "up" ? prevClose - c.close : c.close - prevClose;
    if (adverse > 0 && totalRange > 0 && adverse / totalRange > 0.1) drawdownEvents++;
    prevClose = c.close;
  }

  const retrievedCtx = await retrieveContext(
    `${move.symbol} ${move.moveType} ${move.direction} behavior holdability long-hold`,
    6,
  ).catch(() => "");

  const prompt = `${retrievedCtx ? `=== RETRIEVED SYSTEM CONTEXT ===\n${retrievedCtx}\n\n` : ""}You are profiling the internal behavior of a confirmed market move for a long-hold trading system.

Symbol: ${move.symbol} | Direction: ${move.direction.toUpperCase()}
Total move: ${(move.movePct * 100).toFixed(1)}% | Duration: ${(move.holdingMinutes / 60).toFixed(1)}h (${candles.length} bars captured)
Entry price: ${move.startPrice.toFixed(4)} | Exit price: ${move.endPrice.toFixed(4)}
Drawdown events (>10% of total range adverse): ${drawdownEvents}

Move price progress (sampled):
${sampled}

SYSTEM CONTEXT:
- Trailing stop activates at 30% of TP target (not immediately). It is a safety net.
- Trades are long-hold (3–44 days). The system can withstand intra-move drawdowns.
- Holdability measures: would a patient long-hold trader survive this move without being stopped?
- Behavior pattern: smooth (trending), choppy (oscillating), gapped (large jumps), spiked (spike-driven), compressing (narrowing range)

TASK: Profile this move's internal behavior.

Respond with ONLY valid JSON:
{
  "behaviorPattern": "smooth|choppy|gapped|spiked|compressing",
  "holdabilityScore": <0.0-1.0 — 1.0 = perfect for long hold, never threatened by trailing stop>,
  "maxIntradrawdownPct": <max % pullback during the move relative to entry>,
  "smoothnessRating": "very_smooth|mostly_smooth|mixed|mostly_choppy|very_choppy",
  "exitNarrative": "<1-2 sentences: how did the move end — exhaustion, spike reversal, gradual fade?>",
  "keyBehaviorInsights": [
    "<insight 1: e.g. move made immediate progress, no false starts>",
    "<insight 2: e.g. two major pullbacks each recovered within 10 bars>"
  ]
}`;

  const response = await chatComplete({
    messages: [{ role: "user", content: prompt }],
    max_completion_tokens: 1_200,
    temperature: 0.2,
  });

  const raw = response.choices[0]?.message?.content?.trim() ?? "";
  const parsed = parseAiJsonObject<Record<string, unknown>>(raw);

  const holdabilityScore = Math.max(0, Math.min(1, Number(parsed.holdabilityScore) || 0));
  const maxIntradrawdown = Math.max(0, Number(parsed.maxIntradrawdownPct) || 0);
  const mfePct = Math.abs(move.movePct);

  await db.insert(moveBehaviorPassesTable).values({
    moveId:             move.id,
    symbol:             move.symbol,
    direction:          move.direction,
    passName:           "behavior",
    captureablePct:     Math.max(0, Math.min(1, (mfePct - maxIntradrawdown / 100) / mfePct)),
    maxFavorablePct:    mfePct,
    maxAdversePct:      maxIntradrawdown / 100,
    barsToMfePeak:      candles.length,
    behaviorPattern:    parsed.behaviorPattern ?? "unknown",
    exitNarrative:      parsed.exitNarrative ?? "",
    holdabilityScore,
    triggerConditions:  parsed.keyBehaviorInsights
      ? parsed.keyBehaviorInsights.map((s: string, i: number) => ({ condition: `insight_${i + 1}`, detail: s }))
      : [],
    rawAiResponse:      parsed,
    passRunId:          runId,
  });
}
