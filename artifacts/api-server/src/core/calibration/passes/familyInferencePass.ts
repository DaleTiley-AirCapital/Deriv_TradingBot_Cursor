import { db } from "@workspace/db";
import {
  calibrationMoveWindowSummariesTable,
  moveFamilyInferencesTable,
  type DetectedMoveRow,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { chatCompleteJsonPrefer } from "../../../infrastructure/openai.js";
import { CALIBRATION_MODEL } from "../../ai/aiConfig.js";
import {
  ALLOWED_CALIBRATION_FAMILIES,
  FAMILY_INFERENCE_RESPONSE_SHAPE,
  FAMILY_INFERENCE_SYSTEM_PROMPT,
} from "../calibrationReasoningSpec.js";
import { parseAiJsonObject } from "../parseAiJson.js";
import { repairCalibrationJson } from "../jsonRepairAssistant.js";
import { upsertMoveWindowSummaries } from "../windowSummaryDataset.js";

type FamilyInferencePayload = {
  strategyFamily?: string;
  developmentBars?: number;
  precursorBars?: number;
  triggerBars?: number;
  behaviorBars?: number;
  confidenceScore?: number;
  reasoningSummary?: string;
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function parseWithRepair(raw: string, label: string): Promise<FamilyInferencePayload> {
  try {
    return parseAiJsonObject<FamilyInferencePayload>(raw);
  } catch {
    const repaired = await repairCalibrationJson(raw, label);
    return parseAiJsonObject<FamilyInferencePayload>(repaired);
  }
}

export async function runFamilyInferencePass(move: DetectedMoveRow, runId: number): Promise<void> {
  const existing = await db
    .select()
    .from(moveFamilyInferencesTable)
    .where(eq(moveFamilyInferencesTable.moveId, move.id))
    .limit(1);
  const summaries = await db
    .select()
    .from(calibrationMoveWindowSummariesTable)
    .where(and(
      eq(calibrationMoveWindowSummariesTable.moveId, move.id),
      eq(calibrationMoveWindowSummariesTable.symbol, move.symbol),
    ));

  const windowSummaryPayload = summaries.map((summary) => ({
    windowKind: summary.windowKind,
    windowBars: summary.windowBars,
    featureSummary: summary.featureSummary,
    compactRawSlice: summary.compactRawSlice,
  }));

  const prompt = `Move metadata:
${JSON.stringify({
    moveId: move.id,
    symbol: move.symbol,
    direction: move.direction,
    movePct: Number((move.movePct * 100).toFixed(4)),
    holdingHours: Number((move.holdingMinutes / 60).toFixed(4)),
    moveTypeCandidate: move.strategyFamilyCandidate ?? move.moveType,
    qualityTier: move.qualityTier,
    qualityScore: move.qualityScore,
  })}

Deterministic move window summaries:
${JSON.stringify(windowSummaryPayload)}

Allowed family labels:
${JSON.stringify(ALLOWED_CALIBRATION_FAMILIES)}

Return JSON matching this shape:
${JSON.stringify(FAMILY_INFERENCE_RESPONSE_SHAPE)}`;

  const response = await chatCompleteJsonPrefer({
    model: CALIBRATION_MODEL,
    logLabel: `familyInference move=${move.id}`,
    telemetry: { runId, passName: "family_inference" },
    messages: [
      { role: "system", content: FAMILY_INFERENCE_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    max_completion_tokens: 1200,
    temperature: 0.1,
  });

  const raw = response.choices[0]?.message?.content?.trim() ?? "";
  const parsed = await parseWithRepair(raw, `familyInference move=${move.id}`);
  const strategyFamily = ALLOWED_CALIBRATION_FAMILIES.includes((parsed.strategyFamily ?? "") as typeof ALLOWED_CALIBRATION_FAMILIES[number])
    ? parsed.strategyFamily!
    : "other_structural_family";

  await db
    .insert(moveFamilyInferencesTable)
    .values({
      moveId: move.id,
      symbol: move.symbol,
      strategyFamily,
      confidenceScore: Number(parsed.confidenceScore ?? 0),
      developmentBars: Math.max(30, Number(parsed.developmentBars ?? 120)),
      precursorBars: Math.max(15, Number(parsed.precursorBars ?? 60)),
      triggerBars: Math.max(3, Number(parsed.triggerBars ?? 24)),
      behaviorBars: Math.max(15, Number(parsed.behaviorBars ?? Math.round(move.holdingMinutes))),
      reasoningSummary: String(parsed.reasoningSummary ?? ""),
      rawAiResponse: asObject({ raw, parsed }),
      passRunId: runId,
    })
    .onConflictDoUpdate({
      target: [moveFamilyInferencesTable.moveId],
      set: {
        strategyFamily,
        confidenceScore: Number(parsed.confidenceScore ?? 0),
        developmentBars: Math.max(30, Number(parsed.developmentBars ?? 120)),
        precursorBars: Math.max(15, Number(parsed.precursorBars ?? 60)),
        triggerBars: Math.max(3, Number(parsed.triggerBars ?? 24)),
        behaviorBars: Math.max(15, Number(parsed.behaviorBars ?? Math.round(move.holdingMinutes))),
        reasoningSummary: String(parsed.reasoningSummary ?? ""),
        rawAiResponse: asObject({ raw, parsed }),
        passRunId: runId,
      },
    });

  await upsertMoveWindowSummaries(move, runId, {
    strategyFamily,
    developmentBars: Math.max(30, Number(parsed.developmentBars ?? 120)),
    precursorBars: Math.max(15, Number(parsed.precursorBars ?? 60)),
    triggerBars: Math.max(3, Number(parsed.triggerBars ?? 24)),
    behaviorBars: Math.max(15, Number(parsed.behaviorBars ?? Math.round(move.holdingMinutes))),
  });

  if (existing.length > 0) {
    return;
  }
}
