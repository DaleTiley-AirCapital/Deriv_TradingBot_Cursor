import { Crash300SynthesisAdapter, buildUnifiedCrash300Dataset } from "../crash300Adapter.js";
import type { SymbolSynthesisAdapter, UnifiedSynthesisDataset } from "../adapter.js";
import type { EliteSynthesisStage } from "../types.js";

export const CRASH300_RUNTIME_BUILD_SERVICE_ID = "CRASH300";

export function createCrash300SynthesisAdapter(): SymbolSynthesisAdapter {
  return new Crash300SynthesisAdapter();
}

export async function buildCrash300RuntimeBuildDataset(params: {
  calibrationRunId: number | null;
  backtestRunId: number | null;
  startTs: number;
  endTs: number;
  windowDays: number;
  onProgress?: (update: { stage: EliteSynthesisStage; progressPct: number; message: string }) => Promise<void> | void;
  assertNotCancelled?: () => Promise<void> | void;
}): Promise<UnifiedSynthesisDataset> {
  return buildUnifiedCrash300Dataset(params);
}

