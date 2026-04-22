import { db, backgroundDb } from "@workspace/db";
import {
  candlesTable,
  moveFamilyInferencesTable,
  type DetectedMoveRow,
  type MoveFamilyInferenceRow,
} from "@workspace/db";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { chatCompleteJsonPrefer } from "../../../infrastructure/openai.js";
import { retrieveContext } from "../../ai/contextRetriever.js";
import { parseAiJsonObject } from "../parseAiJson.js";
import { repairCalibrationJson } from "../jsonRepairAssistant.js";

type FamilyWindowPayload = {
  strategyFamily?: string;
  developmentBars?: number;
  precursorBars?: number;
  triggerBars?: number;
  behaviorBars?: number;
  reasoningSummary?: string;
  confidenceScore?: number;
};

function sanitizeContext(s: string): string {
  return s
    .replace(/[\u201c\u201d\u2018\u2019]/g, "'")
    .replace(/"/g, "'")
    .slice(0, 4000);
}

function fallbackInference(move: DetectedMoveRow): FamilyWindowPayload {
  const moveBars = Math.max(10, Math.round(move.holdingMinutes));
  const family = move.strategyFamilyCandidate && move.strategyFamilyCandidate !== "unknown"
    ? move.strategyFamilyCandidate
    : move.moveType;
  return {
    strategyFamily: family || "unknown",
    developmentBars: Math.max(120, move.leadInBars * 2 || 120),
    precursorBars: Math.max(45, move.leadInBars || 60),
    triggerBars: Math.max(6, Math.min(48, Math.round(moveBars * 0.2))),
    behaviorBars: Math.max(30, Math.min(400, moveBars)),
    reasoningSummary: "Fallback family/window inference derived from deterministic move metadata.",
    confidenceScore: 0.25,
  };
}

async function parseFamilyWindowPayload(raw: string, moveId: number): Promise<FamilyWindowPayload> {
  try {
    return parseAiJsonObject<FamilyWindowPayload>(raw);
  } catch (e1) {
    try {
      const repaired = await repairCalibrationJson(raw, `familyWindowInference moveId=${moveId}`);
      return parseAiJsonObject<FamilyWindowPayload>(repaired);
    } catch {
      throw e1;
    }
  }
}

export async function runFamilyWindowInferencePass(
  move: DetectedMoveRow,
  runId: number,
): Promise<MoveFamilyInferenceRow> {
  const existing = await db
    .select()
    .from(moveFamilyInferencesTable)
    .where(eq(moveFamilyInferencesTable.moveId, move.id))
    .limit(1);
  if (existing[0]) return existing[0];

  const lookbackBars = Math.max(120, move.leadInBars * 2 || 120);
  const forwardBars = Math.max(60, Math.min(240, Math.round(move.holdingMinutes)));
  const candles = await backgroundDb
    .select({
      openTs: candlesTable.openTs,
      open: candlesTable.open,
      high: candlesTable.high,
      low: candlesTable.low,
      close: candlesTable.close,
    })
    .from(candlesTable)
    .where(and(
      eq(candlesTable.symbol, move.symbol),
      eq(candlesTable.timeframe, "1m"),
      gte(candlesTable.openTs, move.startTs - lookbackBars * 60),
      lte(candlesTable.openTs, Math.min(move.endTs, move.startTs + forwardBars * 60)),
      eq(candlesTable.isInterpolated, false),
    ))
    .orderBy(asc(candlesTable.openTs));

  const sampled = candles
    .filter((_, idx) => idx % Math.max(1, Math.floor(candles.length / 28)) === 0)
    .slice(0, 28)
    .map((c, idx) => `[${idx}] ts=${c.openTs} o=${c.open.toFixed(4)} h=${c.high.toFixed(4)} l=${c.low.toFixed(4)} c=${c.close.toFixed(4)}`)
    .join("\n");

  const retrievedCtxRaw = await retrieveContext(
    `${move.symbol} ${move.strategyFamilyCandidate} ${move.moveType} family window inference development precursor trigger behavior`,
    6,
  ).catch(() => "");
  const retrievedCtx = sanitizeContext(retrievedCtxRaw);

  const prompt = `${retrievedCtx ? `=== RETRIEVED SYSTEM CONTEXT ===\n${retrievedCtx}\n\n` : ""}You are performing Phase 3 calibration family and window inference for a tagged move.

Symbol: ${move.symbol}
Detected move type: ${move.moveType}
Strategy family candidate: ${move.strategyFamilyCandidate}
Direction: ${move.direction}
Move size: ${(move.movePct * 100).toFixed(2)}%
Hold duration: ${(move.holdingMinutes / 60).toFixed(2)}h
Lead-in shape: ${move.leadInShape}
Directional persistence: ${(move.directionalPersistence * 100).toFixed(1)}%
Range expansion: ${move.rangeExpansion.toFixed(2)}
Quality: ${move.qualityTier} / ${move.qualityScore.toFixed(0)}

Canonical candle slice around the move:
${sampled}

Task:
1. Confirm the best strategy family label for this move
2. Estimate how many 1m bars the move developed over before entry
3. Estimate the precursor window bars
4. Estimate the trigger zone bars
5. Estimate the behavior analysis bars

Use one of these strategy families:
- breakout
- continuation
- reversal
- boom_expansion
- crash_expansion
- unknown

Respond with ONLY valid JSON:
{
  "strategyFamily": "breakout|continuation|reversal|boom_expansion|crash_expansion|unknown",
  "developmentBars": <integer>,
  "precursorBars": <integer>,
  "triggerBars": <integer>,
  "behaviorBars": <integer>,
  "reasoningSummary": "<1-2 sentences>",
  "confidenceScore": <0.0-1.0>
}`;

  let payload: FamilyWindowPayload;
  try {
    const response = await chatCompleteJsonPrefer({
      logLabel: `familyWindowInference moveId=${move.id}`,
      telemetry: { runId, passName: "family_window_inference" },
      messages: [{ role: "user", content: prompt }],
      max_completion_tokens: 1200,
      temperature: 0.2,
    });
    const raw = response.choices[0]?.message?.content?.trim() ?? "";
    payload = await parseFamilyWindowPayload(raw, move.id);
  } catch {
    payload = fallbackInference(move);
  }

  const normalized = {
    strategyFamily: String(payload.strategyFamily ?? move.strategyFamilyCandidate ?? move.moveType ?? "unknown"),
    confidenceScore: Math.max(0, Math.min(1, Number(payload.confidenceScore ?? 0.25))),
    developmentBars: Math.max(30, Number(payload.developmentBars ?? Math.max(120, move.leadInBars * 2 || 120))),
    precursorBars: Math.max(15, Number(payload.precursorBars ?? Math.max(45, move.leadInBars || 60))),
    triggerBars: Math.max(3, Number(payload.triggerBars ?? 24)),
    behaviorBars: Math.max(15, Number(payload.behaviorBars ?? Math.max(30, Math.round(move.holdingMinutes)))),
    reasoningSummary: String(payload.reasoningSummary ?? "Fallback family/window inference."),
  };

  const [row] = await db
    .insert(moveFamilyInferencesTable)
    .values({
      moveId: move.id,
      symbol: move.symbol,
      strategyFamily: normalized.strategyFamily,
      confidenceScore: normalized.confidenceScore,
      developmentBars: normalized.developmentBars,
      precursorBars: normalized.precursorBars,
      triggerBars: normalized.triggerBars,
      behaviorBars: normalized.behaviorBars,
      reasoningSummary: normalized.reasoningSummary,
      rawAiResponse: normalized,
      passRunId: runId,
    })
    .onConflictDoUpdate({
      target: [moveFamilyInferencesTable.moveId],
      set: {
        strategyFamily: normalized.strategyFamily,
        confidenceScore: normalized.confidenceScore,
        developmentBars: normalized.developmentBars,
        precursorBars: normalized.precursorBars,
        triggerBars: normalized.triggerBars,
        behaviorBars: normalized.behaviorBars,
        reasoningSummary: normalized.reasoningSummary,
        rawAiResponse: normalized,
        passRunId: runId,
      },
    })
    .returning();

  return row!;
}
