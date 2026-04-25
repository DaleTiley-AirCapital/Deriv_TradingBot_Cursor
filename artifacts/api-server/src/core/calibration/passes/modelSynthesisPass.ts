import { db } from "@workspace/db";
import {
  calibrationEntryIdealsTable,
  calibrationExitRiskProfilesTable,
  calibrationFeatureRelevanceTable,
  calibrationFamilyBucketProfilesTable,
  detectedMovesTable,
  strategyCalibrationProfilesTable,
} from "@workspace/db";
import { and, eq, notInArray } from "drizzle-orm";
import { chatCompleteJsonPrefer } from "../../../infrastructure/openai.js";
import { CALIBRATION_REASONING_MODEL } from "../../ai/aiConfig.js";
import {
  BUCKET_MODEL_RESPONSE_SHAPE,
  BUCKET_MODEL_SYSTEM_PROMPT,
  getAllowedCalibrationFamiliesForSymbol,
} from "../calibrationReasoningSpec.js";
import { rebuildFamilyBucketProfiles } from "../familyBucketAggregation.js";
import { parseAiJsonObject } from "../parseAiJson.js";
import { repairCalibrationJson } from "../jsonRepairAssistant.js";
import { upsertSymbolResearchProfile } from "../symbolResearchProfile.js";

type BucketModelPayload = {
  featureSetToKeep?: string[];
  featureSetDiagnosticOnly?: string[];
  idealEntryProfile?: Record<string, unknown>;
  tpModel?: Record<string, unknown>;
  slModel?: Record<string, unknown>;
  killSwitchModel?: Record<string, unknown>;
  regressionWarningPatterns?: unknown[];
  closureSignals?: unknown[];
  progressionSummary?: Record<string, unknown>;
  reasoningNarrative?: string;
  featureRelevance?: Array<{
    featureName: string;
    relevanceScore: number;
    precursorUsefulness: number;
    triggerUsefulness: number;
    behaviorUsefulness: number;
    notes: string;
  }>;
};

async function parseWithRepair(raw: string, label: string): Promise<BucketModelPayload> {
  try {
    return parseAiJsonObject<BucketModelPayload>(raw);
  } catch {
    const repaired = await repairCalibrationJson(raw, label);
    return parseAiJsonObject<BucketModelPayload>(repaired);
  }
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export async function runModelSynthesisPass(
  symbol: string,
  moves: typeof detectedMovesTable.$inferSelect[],
  runId: number,
  windowDays = 90,
): Promise<void> {
  const allowedFamilies = getAllowedCalibrationFamiliesForSymbol(symbol);

  await rebuildFamilyBucketProfiles(symbol, runId);

  await Promise.all([
    db
      .delete(calibrationFeatureRelevanceTable)
      .where(and(
        eq(calibrationFeatureRelevanceTable.symbol, symbol),
        notInArray(calibrationFeatureRelevanceTable.strategyFamily, allowedFamilies),
      )),
    db
      .delete(calibrationEntryIdealsTable)
      .where(and(
        eq(calibrationEntryIdealsTable.symbol, symbol),
        notInArray(calibrationEntryIdealsTable.strategyFamily, allowedFamilies),
      )),
    db
      .delete(calibrationExitRiskProfilesTable)
      .where(and(
        eq(calibrationExitRiskProfilesTable.symbol, symbol),
        notInArray(calibrationExitRiskProfilesTable.strategyFamily, allowedFamilies),
      )),
  ]);

  const bucketProfiles = await db
    .select()
    .from(calibrationFamilyBucketProfilesTable)
    .where(eq(calibrationFamilyBucketProfilesTable.symbol, symbol));

  for (const profile of bucketProfiles) {
    const prompt = `Symbol: ${symbol}
Strategy family: ${profile.strategyFamily}
Move size bucket: ${profile.movePctBucket}
Move count: ${profile.moveCount}
Window model: ${JSON.stringify(profile.windowModel)}
Deterministic feature progression averages: ${JSON.stringify(profile.featureProgressionAverages)}
Deterministic feature progression bounds: ${JSON.stringify(profile.featureProgressionBounds)}
Representative examples: ${JSON.stringify(profile.representativeExamples)}

Return JSON matching this shape:
${JSON.stringify(BUCKET_MODEL_RESPONSE_SHAPE)}`;

    const response = await chatCompleteJsonPrefer({
      model: CALIBRATION_REASONING_MODEL,
      logLabel: `bucketModel ${symbol}/${profile.strategyFamily}/${profile.movePctBucket}`,
      telemetry: { runId, passName: "model_synthesis" },
      messages: [
        { role: "system", content: BUCKET_MODEL_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      max_completion_tokens: 2200,
      temperature: 0.15,
    });

    const raw = response.choices[0]?.message?.content?.trim() ?? "";
    const parsed = await parseWithRepair(raw, `bucketModel ${symbol}/${profile.strategyFamily}/${profile.movePctBucket}`);

    for (const feature of parsed.featureRelevance ?? []) {
      await db
        .insert(calibrationFeatureRelevanceTable)
        .values({
          symbol,
          strategyFamily: profile.strategyFamily,
          movePctBucket: profile.movePctBucket,
          featureName: String(feature.featureName ?? ""),
          relevanceScore: Number(feature.relevanceScore ?? 0),
          precursorUsefulness: Number(feature.precursorUsefulness ?? 0),
          triggerUsefulness: Number(feature.triggerUsefulness ?? 0),
          behaviorUsefulness: Number(feature.behaviorUsefulness ?? 0),
          notes: String(feature.notes ?? ""),
          sourceRunId: runId,
        })
        .onConflictDoUpdate({
          target: [
            calibrationFeatureRelevanceTable.symbol,
            calibrationFeatureRelevanceTable.strategyFamily,
            calibrationFeatureRelevanceTable.movePctBucket,
            calibrationFeatureRelevanceTable.featureName,
          ],
          set: {
            relevanceScore: Number(feature.relevanceScore ?? 0),
            precursorUsefulness: Number(feature.precursorUsefulness ?? 0),
            triggerUsefulness: Number(feature.triggerUsefulness ?? 0),
            behaviorUsefulness: Number(feature.behaviorUsefulness ?? 0),
            notes: String(feature.notes ?? ""),
            sourceRunId: runId,
            updatedAt: new Date(),
          },
        });
    }

    await db
      .insert(calibrationEntryIdealsTable)
      .values({
        symbol,
        strategyFamily: profile.strategyFamily,
        movePctBucket: profile.movePctBucket,
        idealPrecursorProfile: {
          featureSetToKeep: parsed.featureSetToKeep ?? [],
          featureSetDiagnosticOnly: parsed.featureSetDiagnosticOnly ?? [],
          ...parsed.idealEntryProfile,
        },
        idealTriggerProfile: parsed.progressionSummary ?? {},
        featureBands: {
          windowModel: profile.windowModel,
          deterministicAverages: profile.featureProgressionAverages,
          deterministicBounds: profile.featureProgressionBounds,
        },
        entryQualityNarrative: String(parsed.reasoningNarrative ?? ""),
        progressionSummary: parsed.progressionSummary ?? {},
        sourceRunId: runId,
      })
      .onConflictDoUpdate({
        target: [
          calibrationEntryIdealsTable.symbol,
          calibrationEntryIdealsTable.strategyFamily,
          calibrationEntryIdealsTable.movePctBucket,
        ],
        set: {
          idealPrecursorProfile: {
            featureSetToKeep: parsed.featureSetToKeep ?? [],
            featureSetDiagnosticOnly: parsed.featureSetDiagnosticOnly ?? [],
            ...parsed.idealEntryProfile,
          },
          idealTriggerProfile: parsed.progressionSummary ?? {},
          featureBands: {
            windowModel: profile.windowModel,
            deterministicAverages: profile.featureProgressionAverages,
            deterministicBounds: profile.featureProgressionBounds,
          },
          entryQualityNarrative: String(parsed.reasoningNarrative ?? ""),
          progressionSummary: parsed.progressionSummary ?? {},
          sourceRunId: runId,
          updatedAt: new Date(),
        },
      });

    await db
      .insert(calibrationExitRiskProfilesTable)
      .values({
        symbol,
        strategyFamily: profile.strategyFamily,
        movePctBucket: profile.movePctBucket,
        regressionFingerprints: parsed.regressionWarningPatterns ?? [],
        moveBreakWarningPatterns: parsed.regressionWarningPatterns ?? [],
        closureSignals: parsed.closureSignals ?? [],
        trailingInterpretationNotes: JSON.stringify({
          tpModel: parsed.tpModel ?? {},
          slModel: parsed.slModel ?? {},
          killSwitchModel: parsed.killSwitchModel ?? {},
          reasoningNarrative: parsed.reasoningNarrative ?? "",
        }),
        sourceRunId: runId,
      })
      .onConflictDoUpdate({
        target: [
          calibrationExitRiskProfilesTable.symbol,
          calibrationExitRiskProfilesTable.strategyFamily,
          calibrationExitRiskProfilesTable.movePctBucket,
        ],
        set: {
          regressionFingerprints: parsed.regressionWarningPatterns ?? [],
          moveBreakWarningPatterns: parsed.regressionWarningPatterns ?? [],
          closureSignals: parsed.closureSignals ?? [],
          trailingInterpretationNotes: JSON.stringify({
            tpModel: parsed.tpModel ?? {},
            slModel: parsed.slModel ?? {},
            killSwitchModel: parsed.killSwitchModel ?? {},
            reasoningNarrative: parsed.reasoningNarrative ?? "",
          }),
          sourceRunId: runId,
          updatedAt: new Date(),
        },
      });
  }

  const movePcts = moves.map((move) => move.movePct * 100);
  const holdHours = moves.map((move) => move.holdingMinutes / 60);
  const fitScore = bucketProfiles.length > 0 ? 1 : 0;
  const feeddownSchema = {
    familiesDiscovered: [...new Set(bucketProfiles.map((profile) => profile.strategyFamily))],
    bucketModels: bucketProfiles.map((profile) => ({
      strategyFamily: profile.strategyFamily,
      movePctBucket: profile.movePctBucket,
      moveCount: profile.moveCount,
      windowModel: profile.windowModel,
      progressionSummary: profile.featureProgressionAverages,
    })),
    featureRelevanceByBucket: await db.select().from(calibrationFeatureRelevanceTable).where(eq(calibrationFeatureRelevanceTable.symbol, symbol)),
    entryIdealByBucket: await db.select().from(calibrationEntryIdealsTable).where(eq(calibrationEntryIdealsTable.symbol, symbol)),
    tradeManagementByBucket: await db.select().from(calibrationExitRiskProfilesTable).where(eq(calibrationExitRiskProfilesTable.symbol, symbol)),
    progressionSummaryByBucket: bucketProfiles.map((profile) => ({
      strategyFamily: profile.strategyFamily,
      movePctBucket: profile.movePctBucket,
      moveCount: profile.moveCount,
      windowModel: profile.windowModel,
    })),
  };

  await db
    .insert(strategyCalibrationProfilesTable)
    .values({
      symbol,
      moveType: "all",
      windowDays,
      targetMoves: moves.length,
      capturedMoves: moves.length,
      missedMoves: 0,
      fitScore,
      missReasons: [],
      avgMovePct: average(movePcts),
      medianMovePct: movePcts.sort((a, b) => a - b)[Math.floor(movePcts.length / 2)] ?? 0,
      avgHoldingHours: average(holdHours),
      avgCaptureablePct: 1,
      avgHoldabilityScore: 1,
      engineCoverage: { calibrationOnly: true },
      precursorSummary: [],
      triggerSummary: [],
      feeddownSchema,
      profitabilitySummary: {
        familyBuckets: bucketProfiles.map((profile) => ({
          strategyFamily: profile.strategyFamily,
          movePctBucket: profile.movePctBucket,
          moveCount: profile.moveCount,
        })),
      },
      lastRunId: runId,
    })
    .onConflictDoUpdate({
      target: [strategyCalibrationProfilesTable.symbol, strategyCalibrationProfilesTable.moveType],
      set: {
        windowDays,
        targetMoves: moves.length,
        capturedMoves: moves.length,
        missedMoves: 0,
        fitScore,
        missReasons: [],
        avgMovePct: average(movePcts),
        medianMovePct: movePcts.sort((a, b) => a - b)[Math.floor(movePcts.length / 2)] ?? 0,
        avgHoldingHours: average(holdHours),
        avgCaptureablePct: 1,
        avgHoldabilityScore: 1,
        engineCoverage: { calibrationOnly: true },
        precursorSummary: [],
        triggerSummary: [],
        feeddownSchema,
        profitabilitySummary: {
          familyBuckets: bucketProfiles.map((profile) => ({
            strategyFamily: profile.strategyFamily,
            movePctBucket: profile.movePctBucket,
            moveCount: profile.moveCount,
          })),
        },
        lastRunId: runId,
        generatedAt: new Date(),
      },
    });

  await upsertSymbolResearchProfile(symbol, runId);
}
