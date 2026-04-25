import { db } from "@workspace/db";
import {
  calibrationFamilyBucketProfilesTable,
  calibrationMoveWindowSummariesTable,
  moveFamilyInferencesTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { normalizeCalibrationFamilyForSymbol } from "./calibrationReasoningSpec.js";

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function rebuildFamilyBucketProfiles(symbol: string, runId: number): Promise<void> {
  await db
    .delete(calibrationFamilyBucketProfilesTable)
    .where(eq(calibrationFamilyBucketProfilesTable.symbol, symbol));

  const [familyRows, summaryRows] = await Promise.all([
    db.select().from(moveFamilyInferencesTable).where(eq(moveFamilyInferencesTable.symbol, symbol)),
    db.select().from(calibrationMoveWindowSummariesTable).where(eq(calibrationMoveWindowSummariesTable.symbol, symbol)),
  ]);

  const summaryByMove = new Map<number, typeof summaryRows>();
  for (const row of summaryRows) {
    const existing = summaryByMove.get(row.moveId) ?? [];
    existing.push(row);
    summaryByMove.set(row.moveId, existing);
  }

  const grouped = new Map<string, Array<{ inference: typeof familyRows[number]; summaries: typeof summaryRows }>>();
  for (const inference of familyRows) {
    const summaries = summaryByMove.get(inference.moveId) ?? [];
    const movePctBucket = summaries[0]?.movePctBucket ?? "all";
    const strategyFamily = normalizeCalibrationFamilyForSymbol(symbol, inference.strategyFamily);
    const key = `${strategyFamily}__${movePctBucket}`;
    const list = grouped.get(key) ?? [];
    list.push({ inference, summaries });
    grouped.set(key, list);
  }

  for (const [key, records] of grouped.entries()) {
    const [strategyFamily, movePctBucket] = key.split("__");
    const windowModel = {
      developmentBars: mean(records.map((record) => Number(record.inference.developmentBars ?? 0))),
      precursorBars: mean(records.map((record) => Number(record.inference.precursorBars ?? 0))),
      triggerBars: mean(records.map((record) => Number(record.inference.triggerBars ?? 0))),
      behaviorBars: mean(records.map((record) => Number(record.inference.behaviorBars ?? 0))),
      confidenceScore: mean(records.map((record) => Number(record.inference.confidenceScore ?? 0))),
    };

    const collected: Record<string, Record<string, Record<string, number[]>>> = {};
    for (const record of records) {
      for (const summary of record.summaries) {
        const featureSummary = asObject(summary.featureSummary);
        for (const [featureName, metrics] of Object.entries(featureSummary)) {
          collected[summary.windowKind] ??= {};
          collected[summary.windowKind]![featureName] ??= {};
          for (const [metricName, metricValue] of Object.entries(asObject(metrics))) {
            if (typeof metricValue !== "number" || !Number.isFinite(metricValue)) continue;
            collected[summary.windowKind]![featureName]![metricName] ??= [];
            collected[summary.windowKind]![featureName]![metricName]!.push(metricValue);
          }
        }
      }
    }

    const averages = Object.fromEntries(
      Object.entries(collected).map(([windowKind, featureMap]) => [
        windowKind,
        Object.fromEntries(
          Object.entries(featureMap).map(([featureName, metrics]) => [
            featureName,
            Object.fromEntries(
              Object.entries(metrics).map(([metricName, values]) => [metricName, Number(mean(values).toFixed(6))]),
            ),
          ]),
        ),
      ]),
    );

    const bounds = Object.fromEntries(
      Object.entries(collected).map(([windowKind, featureMap]) => [
        windowKind,
        Object.fromEntries(
          Object.entries(featureMap).map(([featureName, metrics]) => [
            featureName,
            Object.fromEntries(
              Object.entries(metrics).map(([metricName, values]) => [
                metricName,
                { min: Number(Math.min(...values).toFixed(6)), max: Number(Math.max(...values).toFixed(6)) },
              ]),
            ),
          ]),
        ),
      ]),
    );

    const representativeExamples = records.slice(0, 6).map((record) => ({
      moveId: record.inference.moveId,
      reasoningSummary: record.inference.reasoningSummary,
      windows: record.summaries.map((summary) => ({
        windowKind: summary.windowKind,
        rawSlice: summary.compactRawSlice,
      })),
    }));

    await db
      .insert(calibrationFamilyBucketProfilesTable)
      .values({
        symbol,
        strategyFamily,
        movePctBucket,
        moveCount: records.length,
        windowModel,
        featureProgressionAverages: averages,
        featureProgressionBounds: bounds,
        representativeExamples,
        sourceRunId: runId,
      })
      .onConflictDoUpdate({
        target: [
          calibrationFamilyBucketProfilesTable.symbol,
          calibrationFamilyBucketProfilesTable.strategyFamily,
          calibrationFamilyBucketProfilesTable.movePctBucket,
        ],
        set: {
          moveCount: records.length,
          windowModel,
          featureProgressionAverages: averages,
          featureProgressionBounds: bounds,
          representativeExamples,
          sourceRunId: runId,
          updatedAt: new Date(),
        },
      });
  }
}
