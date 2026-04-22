import { db } from "@workspace/db";
import {
  calibrationMoveWindowSummariesTable,
  moveProgressionArtifactsTable,
  type DetectedMoveRow,
  type MoveFamilyInferenceRow,
} from "@workspace/db";
import { getMovePctBucket } from "./calibrationBuckets.js";
import {
  buildWindowStats,
  computeMoveProgressionArtifact,
  computeMoveFeatureFrameDataset,
  type FeatureFramePoint,
  type MoveFeatureFrameDataset,
} from "./progressionFeatures.js";

type WindowKind = "development" | "precursor" | "trigger" | "behavior";

function summarizeWindow(frames: FeatureFramePoint[], triggerValues: Record<string, number>): Record<string, unknown> {
  const featureNames = Object.keys(frames[frames.length - 1]?.featureValues ?? {});
  return Object.fromEntries(
    featureNames.map((featureName) => {
      const values = frames.map((frame) => Number(frame.featureValues[featureName] ?? 0));
      return [featureName, buildWindowStats(values, triggerValues[featureName] ?? 0)];
    }),
  );
}

function selectFrames(dataset: MoveFeatureFrameDataset, move: DetectedMoveRow, windowKind: WindowKind): FeatureFramePoint[] {
  switch (windowKind) {
    case "development":
      return dataset.frames.filter((frame) => frame.openTs >= dataset.windowModel.developmentStartTs && frame.openTs < move.startTs);
    case "precursor":
      return dataset.frames.filter((frame) => frame.openTs >= dataset.windowModel.precursorStartTs && frame.openTs < move.startTs);
    case "trigger":
      return dataset.frames.filter((frame) => frame.openTs >= dataset.windowModel.triggerStartTs && frame.openTs <= dataset.windowModel.triggerStartTs + dataset.windowModel.triggerBars * 60);
    case "behavior":
      return dataset.frames.filter((frame) => frame.openTs >= dataset.windowModel.behaviorStartTs && frame.openTs <= dataset.windowModel.behaviorEndTs);
  }
}

function getWindowBounds(dataset: MoveFeatureFrameDataset, move: DetectedMoveRow, windowKind: WindowKind): { startTs: number; endTs: number; bars: number; rawSlice: unknown } {
  switch (windowKind) {
    case "development":
      return {
        startTs: dataset.windowModel.developmentStartTs,
        endTs: move.startTs - 60,
        bars: dataset.windowModel.developmentBars,
        rawSlice: dataset.compactRawSlices.developmentWindow,
      };
    case "precursor":
      return {
        startTs: dataset.windowModel.precursorStartTs,
        endTs: move.startTs - 60,
        bars: dataset.windowModel.precursorBars,
        rawSlice: dataset.compactRawSlices.precursorWindow,
      };
    case "trigger":
      return {
        startTs: dataset.windowModel.triggerStartTs,
        endTs: dataset.windowModel.triggerStartTs + dataset.windowModel.triggerBars * 60,
        bars: dataset.windowModel.triggerBars,
        rawSlice: dataset.compactRawSlices.triggerWindow,
      };
    case "behavior":
      return {
        startTs: dataset.windowModel.behaviorStartTs,
        endTs: dataset.windowModel.behaviorEndTs,
        bars: dataset.windowModel.behaviorBars,
        rawSlice: dataset.compactRawSlices.behaviorWindow,
      };
  }
}

export async function upsertMoveWindowSummaries(
  move: DetectedMoveRow,
  runId: number,
  inferenceLike?: Pick<MoveFamilyInferenceRow, "strategyFamily" | "developmentBars" | "precursorBars" | "triggerBars" | "behaviorBars">,
): Promise<MoveFeatureFrameDataset> {
  const dataset = await computeMoveFeatureFrameDataset(move, inferenceLike);
  const bucket = getMovePctBucket(move.movePct);
  const triggerFrames = selectFrames(dataset, move, "trigger");
  const triggerValues = triggerFrames[0]?.featureValues ?? {};

  for (const windowKind of ["development", "precursor", "trigger", "behavior"] as WindowKind[]) {
    const frames = selectFrames(dataset, move, windowKind);
    const bounds = getWindowBounds(dataset, move, windowKind);
    await db
      .insert(calibrationMoveWindowSummariesTable)
      .values({
        moveId: move.id,
        symbol: move.symbol,
        windowKind,
        windowStartTs: bounds.startTs,
        windowEndTs: bounds.endTs,
        windowBars: bounds.bars,
        movePctBucket: bucket,
        featureSummary: summarizeWindow(frames, triggerValues),
        compactRawSlice: bounds.rawSlice,
        sourceRunId: runId,
      })
      .onConflictDoUpdate({
        target: [calibrationMoveWindowSummariesTable.moveId, calibrationMoveWindowSummariesTable.windowKind],
        set: {
          windowStartTs: bounds.startTs,
          windowEndTs: bounds.endTs,
          windowBars: bounds.bars,
          movePctBucket: bucket,
          featureSummary: summarizeWindow(frames, triggerValues),
          compactRawSlice: bounds.rawSlice,
          sourceRunId: runId,
        },
      });
  }

  if (inferenceLike) {
    const artifact = await computeMoveProgressionArtifact(move, inferenceLike as MoveFamilyInferenceRow);
    await db
      .insert(moveProgressionArtifactsTable)
      .values({
        moveId: move.id,
        symbol: move.symbol,
        strategyFamily: artifact.strategyFamily,
        windowModel: artifact.windowModel,
        progressionSummary: artifact.progressionSummary,
        featureStats: artifact.featureStats,
        compactRawSlices: artifact.compactRawSlices,
        passRunId: runId,
      })
      .onConflictDoUpdate({
        target: [moveProgressionArtifactsTable.moveId],
        set: {
          strategyFamily: artifact.strategyFamily,
          windowModel: artifact.windowModel,
          progressionSummary: artifact.progressionSummary,
          featureStats: artifact.featureStats,
          compactRawSlices: artifact.compactRawSlices,
          passRunId: runId,
        },
      });
  }

  return dataset;
}
