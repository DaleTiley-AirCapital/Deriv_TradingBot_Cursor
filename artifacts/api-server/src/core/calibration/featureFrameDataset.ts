import { db } from "@workspace/db";
import {
  calibrationFeatureFramesTable,
  type DetectedMoveRow,
  type MoveFamilyInferenceRow,
} from "@workspace/db";
import { computeMoveFeatureFrameDataset } from "./progressionFeatures.js";
import { getMovePctBucket } from "./calibrationBuckets.js";

export async function upsertFeatureFrameDataset(
  move: DetectedMoveRow,
  runId: number,
  inferenceLike?: Pick<MoveFamilyInferenceRow, "strategyFamily" | "developmentBars" | "precursorBars" | "triggerBars" | "behaviorBars">,
): Promise<Awaited<ReturnType<typeof computeMoveFeatureFrameDataset>>> {
  const dataset = await computeMoveFeatureFrameDataset(move, inferenceLike);
  const bucket = getMovePctBucket(move.movePct);
  for (const frame of dataset.frames) {
    await db
      .insert(calibrationFeatureFramesTable)
      .values({
        moveId: move.id,
        symbol: move.symbol,
        openTs: frame.openTs,
        relativeBarFromMoveStart: frame.relativeBarFromMoveStart,
        relativeBarToMoveEnd: frame.relativeBarToMoveEnd,
        inDevelopment: frame.openTs >= dataset.windowModel.developmentStartTs && frame.openTs < move.startTs,
        inPrecursor: frame.openTs >= dataset.windowModel.precursorStartTs && frame.openTs < move.startTs,
        inTriggerZone: frame.openTs >= dataset.windowModel.triggerStartTs && frame.openTs <= dataset.windowModel.triggerStartTs + dataset.windowModel.triggerBars * 60,
        inBehavior: frame.openTs >= dataset.windowModel.behaviorStartTs && frame.openTs <= dataset.windowModel.behaviorEndTs,
        movePctBucket: bucket,
        direction: move.direction,
        featureValues: frame.featureValues,
        normalizedFeatureValues: frame.normalizedFeatureValues,
        sourceRunId: runId,
      })
      .onConflictDoUpdate({
        target: [calibrationFeatureFramesTable.moveId, calibrationFeatureFramesTable.openTs],
        set: {
          relativeBarFromMoveStart: frame.relativeBarFromMoveStart,
          relativeBarToMoveEnd: frame.relativeBarToMoveEnd,
          inDevelopment: frame.openTs >= dataset.windowModel.developmentStartTs && frame.openTs < move.startTs,
          inPrecursor: frame.openTs >= dataset.windowModel.precursorStartTs && frame.openTs < move.startTs,
          inTriggerZone: frame.openTs >= dataset.windowModel.triggerStartTs && frame.openTs <= dataset.windowModel.triggerStartTs + dataset.windowModel.triggerBars * 60,
          inBehavior: frame.openTs >= dataset.windowModel.behaviorStartTs && frame.openTs <= dataset.windowModel.behaviorEndTs,
          movePctBucket: bucket,
          direction: move.direction,
          featureValues: frame.featureValues,
          normalizedFeatureValues: frame.normalizedFeatureValues,
          sourceRunId: runId,
        },
      });
  }
  return dataset;
}
