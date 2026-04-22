import type { DetectedMoveRow } from "@workspace/db";
import { upsertFeatureFrameDataset } from "../featureFrameDataset.js";
import { upsertMoveWindowSummaries } from "../windowSummaryDataset.js";

/**
 * Deterministic calibration enrichment.
 * Builds per-timestamp feature frames and heuristic window summaries before any AI runs.
 */
export async function runEnrichmentPass(move: DetectedMoveRow, runId: number): Promise<void> {
  await upsertFeatureFrameDataset(move, runId);
  await upsertMoveWindowSummaries(move, runId);
}
