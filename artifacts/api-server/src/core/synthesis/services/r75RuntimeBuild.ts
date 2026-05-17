import { R75SynthesisAdapter, buildUnifiedR75Dataset } from "../r75Adapter.js";
import type { SymbolSynthesisAdapter, UnifiedSynthesisDataset } from "../adapter.js";
import type { EliteSynthesisStage } from "../types.js";

export const R75_RUNTIME_BUILD_SERVICE_ID = "R_75";

export function createR75SynthesisAdapter(): SymbolSynthesisAdapter {
  return new R75SynthesisAdapter();
}

export async function buildR75RuntimeBuildDataset(params: {
  calibrationRunId: number | null;
  backtestRunId: number | null;
  startTs: number;
  endTs: number;
  windowDays: number;
  onProgress?: (update: { stage: EliteSynthesisStage; progressPct: number; message: string }) => Promise<void> | void;
  assertNotCancelled?: () => Promise<void> | void;
}): Promise<UnifiedSynthesisDataset> {
  return buildUnifiedR75Dataset(params);
}

