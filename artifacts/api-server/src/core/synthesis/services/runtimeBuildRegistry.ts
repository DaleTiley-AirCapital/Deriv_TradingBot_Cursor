import type { SymbolSynthesisAdapter, UnifiedSynthesisDataset } from "../adapter.js";
import type { EliteSynthesisStage } from "../types.js";
import {
  CRASH300_RUNTIME_BUILD_SERVICE_ID,
  buildCrash300RuntimeBuildDataset,
  createCrash300SynthesisAdapter,
} from "./crash300RuntimeBuild.js";
import {
  R75_RUNTIME_BUILD_SERVICE_ID,
  buildR75RuntimeBuildDataset,
  createR75SynthesisAdapter,
} from "./r75RuntimeBuild.js";

type RuntimeBuildDatasetParams = {
  calibrationRunId: number | null;
  backtestRunId: number | null;
  startTs: number;
  endTs: number;
  windowDays: number;
  onProgress?: (update: { stage: EliteSynthesisStage; progressPct: number; message: string }) => Promise<void> | void;
  assertNotCancelled?: () => Promise<void> | void;
};

export type RuntimeBuildService = {
  serviceId: string;
  createAdapter: () => SymbolSynthesisAdapter;
  buildDataset: (params: RuntimeBuildDatasetParams) => Promise<UnifiedSynthesisDataset>;
  targetMinimumMovePct: number;
  targetFamilyLabel: string;
};

const SERVICES: Record<string, RuntimeBuildService> = {
  [CRASH300_RUNTIME_BUILD_SERVICE_ID]: {
    serviceId: CRASH300_RUNTIME_BUILD_SERVICE_ID,
    createAdapter: createCrash300SynthesisAdapter,
    buildDataset: buildCrash300RuntimeBuildDataset,
    targetMinimumMovePct: 9,
    targetFamilyLabel: "crash_expansion",
  },
  [R75_RUNTIME_BUILD_SERVICE_ID]: {
    serviceId: R75_RUNTIME_BUILD_SERVICE_ID,
    createAdapter: createR75SynthesisAdapter,
    buildDataset: buildR75RuntimeBuildDataset,
    targetMinimumMovePct: 5,
    targetFamilyLabel: "all_r75_calibrated_families",
  },
};

export function getRuntimeBuildService(serviceId: string): RuntimeBuildService {
  const service = SERVICES[serviceId];
  if (!service) throw new Error(`Runtime build service missing for ${serviceId}.`);
  return service;
}

export function listRuntimeBuildServiceIds(): string[] {
  return Object.keys(SERVICES);
}

