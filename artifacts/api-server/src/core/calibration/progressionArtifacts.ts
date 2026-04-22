import { db } from "@workspace/db";
import {
  calibrationEntryIdealsTable,
  calibrationExitRiskProfilesTable,
  calibrationFeatureRelevanceTable,
  moveFamilyInferencesTable,
  moveProgressionArtifactsTable,
  type DetectedMoveRow,
  type MoveFamilyInferenceRow,
} from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";
import { chatCompleteJsonPrefer } from "../../infrastructure/openai.js";
import { parseAiJsonObject } from "./parseAiJson.js";
import { repairCalibrationJson } from "./jsonRepairAssistant.js";
import { computeMoveProgressionArtifact } from "./progressionFeatures.js";

type EntryAnalysisPayload = {
  featureRelevance?: Array<{
    featureName: string;
    relevanceScore: number;
    precursorUsefulness: number;
    triggerUsefulness: number;
    behaviorUsefulness: number;
    notes: string;
  }>;
  idealPrecursorProfile?: Record<string, unknown>;
  idealTriggerProfile?: Record<string, unknown>;
  featureBands?: Record<string, unknown>;
  entryQualityNarrative?: string;
  progressionSummary?: Record<string, unknown>;
};

type ExitAnalysisPayload = {
  regressionFingerprints?: unknown[];
  moveBreakWarningPatterns?: unknown[];
  closureSignals?: unknown[];
  trailingInterpretationNotes?: string;
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function parseWithRepair<T extends object>(raw: string, label: string): Promise<T> {
  try {
    return parseAiJsonObject<T>(raw);
  } catch {
    const repaired = await repairCalibrationJson(raw, label);
    return parseAiJsonObject<T>(repaired);
  }
}

export async function upsertMoveProgressionArtifact(
  move: DetectedMoveRow,
  inference: MoveFamilyInferenceRow,
  runId: number,
): Promise<void> {
  const computed = await computeMoveProgressionArtifact(move, inference);
  await db
    .insert(moveProgressionArtifactsTable)
    .values({
      moveId: move.id,
      symbol: move.symbol,
      strategyFamily: computed.strategyFamily,
      windowModel: computed.windowModel,
      progressionSummary: computed.progressionSummary,
      featureStats: computed.featureStats,
      compactRawSlices: computed.compactRawSlices,
      passRunId: runId,
    })
    .onConflictDoUpdate({
      target: [moveProgressionArtifactsTable.moveId],
      set: {
        strategyFamily: computed.strategyFamily,
        windowModel: computed.windowModel,
        progressionSummary: computed.progressionSummary,
        featureStats: computed.featureStats,
        compactRawSlices: computed.compactRawSlices,
        passRunId: runId,
      },
    });
}

type FamilyDataset = {
  strategyFamily: string;
  moveCount: number;
  averageWindowModel: Record<string, number>;
  featureAggregates: Record<string, Record<string, Record<string, number>>>;
  exampleRawSlices: unknown[];
  moveSummaries: unknown[];
};

async function buildFamilyDataset(symbol: string, strategyFamily: string): Promise<FamilyDataset | null> {
  const [artifacts, inferences] = await Promise.all([
    db
      .select()
      .from(moveProgressionArtifactsTable)
      .where(and(
        eq(moveProgressionArtifactsTable.symbol, symbol),
        eq(moveProgressionArtifactsTable.strategyFamily, strategyFamily),
      ))
      .orderBy(asc(moveProgressionArtifactsTable.moveId)),
    db
      .select()
      .from(moveFamilyInferencesTable)
      .where(and(
        eq(moveFamilyInferencesTable.symbol, symbol),
        eq(moveFamilyInferencesTable.strategyFamily, strategyFamily),
      )),
  ]);
  if (artifacts.length === 0) return null;

  const featureAggregates: Record<string, Record<string, Record<string, number[]>>> = {};
  for (const artifact of artifacts) {
    const featureStats = asObject(artifact.featureStats) as Record<string, Record<string, Record<string, number>>>;
    for (const [featureName, windowStats] of Object.entries(featureStats)) {
      featureAggregates[featureName] ??= {};
      for (const [windowName, metrics] of Object.entries(windowStats ?? {})) {
        featureAggregates[featureName]![windowName] ??= {};
        for (const [metricName, metricValue] of Object.entries(metrics ?? {})) {
          if (typeof metricValue !== "number" || !Number.isFinite(metricValue)) continue;
          featureAggregates[featureName]![windowName]![metricName] ??= [];
          featureAggregates[featureName]![windowName]![metricName]!.push(metricValue);
        }
      }
    }
  }

  const collapsedFeatureAggregates = Object.fromEntries(
    Object.entries(featureAggregates).map(([featureName, windows]) => [
      featureName,
      Object.fromEntries(
        Object.entries(windows).map(([windowName, metrics]) => [
          windowName,
          Object.fromEntries(
            Object.entries(metrics).map(([metricName, values]) => [
              metricName,
              Number((values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1)).toFixed(6)),
            ]),
          ),
        ]),
      ),
    ]),
  );

  const averageWindowModel = (() => {
    const sums: Record<string, number> = {};
    let count = 0;
    for (const inference of inferences) {
      sums.developmentBars = (sums.developmentBars ?? 0) + Number(inference.developmentBars ?? 0);
      sums.precursorBars = (sums.precursorBars ?? 0) + Number(inference.precursorBars ?? 0);
      sums.triggerBars = (sums.triggerBars ?? 0) + Number(inference.triggerBars ?? 0);
      sums.behaviorBars = (sums.behaviorBars ?? 0) + Number(inference.behaviorBars ?? 0);
      count++;
    }
    return Object.fromEntries(
      Object.entries(sums).map(([k, v]) => [k, Number((v / Math.max(count, 1)).toFixed(2))]),
    );
  })();

  return {
    strategyFamily,
    moveCount: artifacts.length,
    averageWindowModel,
    featureAggregates: collapsedFeatureAggregates,
    exampleRawSlices: artifacts.slice(0, 8).map((artifact) => artifact.compactRawSlices),
    moveSummaries: artifacts.slice(0, 12).map((artifact) => artifact.progressionSummary),
  };
}

export async function runEntryProgressionAnalysis(symbol: string, strategyFamily: string, runId: number): Promise<EntryAnalysisPayload | null> {
  const dataset = await buildFamilyDataset(symbol, strategyFamily);
  if (!dataset) return null;
  const prompt = `You are performing Phase 3 entry progression analysis for a symbol-family calibration dataset.

Symbol: ${symbol}
Strategy family: ${strategyFamily}
Move count: ${dataset.moveCount}
Average window model: ${JSON.stringify(dataset.averageWindowModel)}
Feature aggregates: ${JSON.stringify(dataset.featureAggregates)}
Example raw slices: ${JSON.stringify(dataset.exampleRawSlices)}
Move summaries: ${JSON.stringify(dataset.moveSummaries)}

Task:
1. Rank the most relevant features for entry quality
2. Describe the ideal precursor profile
3. Describe the ideal trigger profile
4. Provide feature bands / directional expectations
5. Summarize how the move typically develops into a high-quality entry

Respond with ONLY valid JSON:
{
  "featureRelevance": [
    {
      "featureName": "<name>",
      "relevanceScore": <0.0-1.0>,
      "precursorUsefulness": <0.0-1.0>,
      "triggerUsefulness": <0.0-1.0>,
      "behaviorUsefulness": <0.0-1.0>,
      "notes": "<1 sentence>"
    }
  ],
  "idealPrecursorProfile": {},
  "idealTriggerProfile": {},
  "featureBands": {},
  "entryQualityNarrative": "<2-3 sentences>",
  "progressionSummary": {}
}`;

  const response = await chatCompleteJsonPrefer({
    logLabel: `entryProgressionAnalysis ${symbol}/${strategyFamily}`,
    telemetry: { runId, passName: "entry_progression_analysis" },
    messages: [{ role: "user", content: prompt }],
    max_completion_tokens: 2200,
    temperature: 0.2,
  });
  const raw = response.choices[0]?.message?.content?.trim() ?? "";
  const parsed = await parseWithRepair<EntryAnalysisPayload>(raw, `entryProgressionAnalysis ${symbol}/${strategyFamily}`);

  const featureRelevance = Array.isArray(parsed.featureRelevance) ? parsed.featureRelevance : [];
  for (const feature of featureRelevance) {
    if (!feature?.featureName) continue;
    await db
      .insert(calibrationFeatureRelevanceTable)
      .values({
        symbol,
        strategyFamily,
        featureName: String(feature.featureName),
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
      strategyFamily,
      idealPrecursorProfile: parsed.idealPrecursorProfile ?? {},
      idealTriggerProfile: parsed.idealTriggerProfile ?? {},
      featureBands: parsed.featureBands ?? {},
      entryQualityNarrative: String(parsed.entryQualityNarrative ?? ""),
      progressionSummary: parsed.progressionSummary ?? {},
      sourceRunId: runId,
    })
    .onConflictDoUpdate({
      target: [calibrationEntryIdealsTable.symbol, calibrationEntryIdealsTable.strategyFamily],
      set: {
        idealPrecursorProfile: parsed.idealPrecursorProfile ?? {},
        idealTriggerProfile: parsed.idealTriggerProfile ?? {},
        featureBands: parsed.featureBands ?? {},
        entryQualityNarrative: String(parsed.entryQualityNarrative ?? ""),
        progressionSummary: parsed.progressionSummary ?? {},
        sourceRunId: runId,
        updatedAt: new Date(),
      },
    });

  return parsed;
}

export async function runExitRiskAnalysis(symbol: string, strategyFamily: string, runId: number): Promise<ExitAnalysisPayload | null> {
  const dataset = await buildFamilyDataset(symbol, strategyFamily);
  if (!dataset) return null;
  const prompt = `You are performing Phase 3 in-move regression and exit-risk analysis for a symbol-family calibration dataset.

Symbol: ${symbol}
Strategy family: ${strategyFamily}
Move count: ${dataset.moveCount}
Average window model: ${JSON.stringify(dataset.averageWindowModel)}
Feature aggregates: ${JSON.stringify(dataset.featureAggregates)}
Example raw slices: ${JSON.stringify(dataset.exampleRawSlices)}
Move summaries: ${JSON.stringify(dataset.moveSummaries)}

Task:
1. Identify regression fingerprints that appear during healthy moves
2. Identify warning patterns that precede major move break or failure
3. Suggest closure signals
4. Describe how a dynamic trailing monitor should interpret these signals

Respond with ONLY valid JSON:
{
  "regressionFingerprints": [],
  "moveBreakWarningPatterns": [],
  "closureSignals": [],
  "trailingInterpretationNotes": "<2-3 sentences>"
}`;

  const response = await chatCompleteJsonPrefer({
    logLabel: `exitRiskAnalysis ${symbol}/${strategyFamily}`,
    telemetry: { runId, passName: "exit_risk_analysis" },
    messages: [{ role: "user", content: prompt }],
    max_completion_tokens: 1800,
    temperature: 0.2,
  });
  const raw = response.choices[0]?.message?.content?.trim() ?? "";
  const parsed = await parseWithRepair<ExitAnalysisPayload>(raw, `exitRiskAnalysis ${symbol}/${strategyFamily}`);

  await db
    .insert(calibrationExitRiskProfilesTable)
    .values({
      symbol,
      strategyFamily,
      regressionFingerprints: parsed.regressionFingerprints ?? [],
      moveBreakWarningPatterns: parsed.moveBreakWarningPatterns ?? [],
      closureSignals: parsed.closureSignals ?? [],
      trailingInterpretationNotes: String(parsed.trailingInterpretationNotes ?? ""),
      sourceRunId: runId,
    })
    .onConflictDoUpdate({
      target: [calibrationExitRiskProfilesTable.symbol, calibrationExitRiskProfilesTable.strategyFamily],
      set: {
        regressionFingerprints: parsed.regressionFingerprints ?? [],
        moveBreakWarningPatterns: parsed.moveBreakWarningPatterns ?? [],
        closureSignals: parsed.closureSignals ?? [],
        trailingInterpretationNotes: String(parsed.trailingInterpretationNotes ?? ""),
        sourceRunId: runId,
        updatedAt: new Date(),
      },
    });

  return parsed;
}
