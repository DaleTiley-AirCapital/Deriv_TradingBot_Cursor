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
import { chatCompletePrecursorPassPrefer } from "../../../infrastructure/openai.js";
import { retrieveContext } from "../../ai/contextRetriever.js";
import { parseAiJsonObject } from "../parseAiJson.js";
import { repairCalibrationJson } from "../jsonRepairAssistant.js";

const PRECURSOR_LOOKBACK_BARS = 96;

/** RAG snippets sometimes contain `"` that confuse the model into emitting invalid JSON. */
function sanitizeEmbeddingContext(s: string): string {
  if (!s) return "";
  return s
    .replace(/[\u201c\u201d\u2018\u2019]/g, "'")
    .replace(/"/g, "'")
    .slice(0, 4_000);
}

// Engine coverage rules (deterministic, not AI)
const ENGINE_MAP: Record<string, { symbols: string[]; direction: string; leadInShapes: string[] }> = {
  "boom_expansion_engine":        { symbols: ["BOOM300"], direction: "down", leadInShapes: ["trending", "expanding"] },
  "boom_expansion_long_engine":   { symbols: ["BOOM300"], direction: "up", leadInShapes: ["compressing", "expanding", "trending"] },
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

type PrecursorPayload = {
  precursorConditions?: unknown;
  missedReason?: string | null;
  leadInSummary?: string;
  confidenceScore?: number;
};

function normalizePrecursorPayload(p: PrecursorPayload): PrecursorPayload {
  if (!Array.isArray(p.precursorConditions)) {
    p.precursorConditions = [];
  }
  return p;
}

/**
 * Never throws: tries direct JSON.parse, parseAiJsonObject, repair + parse, then a safe fallback row.
 */
async function parsePrecursorPayloadFromRaw(
  raw: string,
  moveId: number,
): Promise<{ payload: PrecursorPayload; usedParseFallback: boolean }> {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const o = JSON.parse(trimmed) as Record<string, unknown>;
      if (o !== null && typeof o === "object" && !Array.isArray(o)) {
        const p: PrecursorPayload = {
          precursorConditions: o.precursorConditions,
          missedReason: o.missedReason as string | null | undefined,
          leadInSummary: typeof o.leadInSummary === "string" ? o.leadInSummary : "",
          confidenceScore: typeof o.confidenceScore === "number" ? o.confidenceScore : 0,
        };
        normalizePrecursorPayload(p);
        return { payload: p, usedParseFallback: false };
      }
    } catch {
      /* fall through */
    }
  }

  try {
    const p = normalizePrecursorPayload(parseAiJsonObject(raw) as PrecursorPayload);
    return { payload: p, usedParseFallback: false };
  } catch (e1) {
    if (process.env.CALIBRATION_AI_DEBUG === "1") {
      console.error(
        `[precursorPass] DEBUG moveId=${moveId} parse failed; raw (up to 12k)=\n${raw.slice(0, 12_000)}`,
      );
    }
    try {
      const repaired = await repairCalibrationJson(raw, `precursor moveId=${moveId}`);
      const p = normalizePrecursorPayload(parseAiJsonObject(repaired) as PrecursorPayload);
      console.warn(`[precursorPass] moveId=${moveId} JSON recovered via repair pass`);
      return { payload: p, usedParseFallback: false };
    } catch {
      const message = e1 instanceof Error ? e1.message : String(e1);
      console.warn(`[precursorPass] moveId=${moveId} using safe parse fallback: ${message.slice(0, 300)}`);
      return {
        payload: {
          precursorConditions: [],
          missedReason: `ai_json_parse_failed:${message.slice(0, 500)}`,
          leadInSummary: "AI response could not be parsed; fallback row persisted for calibration continuity.",
          confidenceScore: 0,
        },
        usedParseFallback: true,
      };
    }
  }
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

  const retrievedCtxRaw = await retrieveContext(
    `${move.symbol} ${move.moveType} ${move.direction} precursor conditions lead-in ${move.leadInShape}`,
    6,
  ).catch(() => "");
  const retrievedCtx = sanitizeEmbeddingContext(retrievedCtxRaw);

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
System engines: boom_expansion_engine (BOOM300 down), boom_expansion_long_engine (BOOM300 up), crash_expansion_engine (CRASH300 up),
  r75_reversal_engine, r75_continuation_engine, r75_breakout_engine (R_75),
  r100_reversal_engine, r100_continuation_engine, r100_breakout_engine (R_100)

TASK: Identify the top 3-5 structural precursor conditions that existed BEFORE this move.
These should be observable market conditions, not engine internals.

STRICT JSON RULES:
- Output must match the requested schema exactly (no markdown, no extra keys).
- In "condition" and "detail", avoid double-quote characters; use plain words or apostrophes.
- "missedReason": use an empty string "" if engine coverage explains the move; otherwise a short explanation.

Respond with ONLY valid JSON:
{
  "precursorConditions": [
    {"condition": "<descriptive name>", "strength": "strong|moderate|weak", "detail": "<1 sentence, no double quotes>"}
  ],
  "missedReason": "<string; empty if engines cover it>",
  "leadInSummary": "<1-2 sentences, no double quotes inside strings>",
  "confidenceScore": <0.0-1.0>
}`;

  let raw = "";
  try {
    const response = await chatCompletePrecursorPassPrefer({
      logLabel: `precursorPass moveId=${move.id}`,
      telemetry: { runId, passName: "precursor" },
      messages: [{ role: "user", content: prompt }],
      max_completion_tokens: 2_048,
      temperature: 0.25,
    });
    raw = response.choices[0]?.message?.content?.trim() ?? "";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[precursorPass] moveId=${move.id} OpenAI request failed; inserting fallback row: ${msg.slice(0, 300)}`);
    await db.insert(movePrecursorPassesTable).values({
      moveId:              move.id,
      symbol:              move.symbol,
      direction:           move.direction,
      moveType:            move.moveType,
      engineMatched,
      engineWouldFire,
      precursorConditions: [],
      missedReason:        `openai_request_failed:${msg.slice(0, 500)}`,
      leadInSummary:       "OpenAI request failed or timed out; fallback row persisted for calibration continuity.",
      confidenceScore:     0,
      rawAiResponse:       { openaiRequestFailed: true, message: msg },
      passRunId:           runId > 0 ? runId : undefined,
    });
    return;
  }

  if (process.env.CALIBRATION_AI_DEBUG === "1") {
    console.warn(
      `[precursorPass] DEBUG moveId=${move.id} symbol=${move.symbol} rawLen=${raw.length} head=${JSON.stringify(raw.slice(0, 500))}`,
    );
  }

  const { payload: parsed, usedParseFallback } = await parsePrecursorPayloadFromRaw(raw, move.id);
  const rawAiStored =
    usedParseFallback
      ? { parseFallback: true, ...parsed }
      : parsed;

  const missed =
    parsed.missedReason == null || parsed.missedReason === ""
      ? null
      : String(parsed.missedReason);

  await db.insert(movePrecursorPassesTable).values({
    moveId:              move.id,
    symbol:              move.symbol,
    direction:           move.direction,
    moveType:            move.moveType,
    engineMatched,
    engineWouldFire,
    precursorConditions: parsed.precursorConditions ?? [],
    missedReason:        missed,
    leadInSummary:       parsed.leadInSummary ?? "",
    confidenceScore:     Math.max(0, Math.min(1, Number(parsed.confidenceScore) || 0)),
    rawAiResponse:       rawAiStored,
    passRunId:           runId > 0 ? runId : undefined,
  });
}
