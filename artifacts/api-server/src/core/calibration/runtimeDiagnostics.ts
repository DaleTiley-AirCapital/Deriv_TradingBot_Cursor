import { getSymbolService } from "../../symbol-services/shared/SymbolServiceRegistry.js";
import { runCrash300RuntimeTriggerValidation } from "../../symbol-services/CRASH300/calibration.js";

export async function buildCalibrationParityReport(params: {
  symbol: string;
  startTs: number;
  endTs: number;
}) {
  const service = getSymbolService(params.symbol);
  if (!service) {
    throw new Error(`No symbol service registered for ${params.symbol}`);
  }
  const parity = await service.runCalibrationParity({
    symbol: params.symbol,
    startTs: params.startTs,
    endTs: params.endTs,
    mode: "parity",
  });
  const parityRecord = parity as Record<string, unknown>;
  const runtimeModel = (parityRecord.runtimeModel ?? null) as Record<string, unknown> | null;
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    promotedModelRunId: runtimeModel?.promotedModelRunId ?? null,
    stagedModelRunId: runtimeModel?.stagedModelRunId ?? null,
    totals: parityRecord.totals ?? {},
    verdicts: Array.isArray(parityRecord.verdicts) ? parityRecord.verdicts : [],
    diagnostics: parityRecord.diagnostics ?? {},
    report: parityRecord,
  };
}

export async function buildRuntimeTriggerValidationReport(params: {
  symbol: string;
  startTs: number;
  endTs: number;
}) {
  if (params.symbol !== "CRASH300") {
    throw new Error("Runtime trigger validation is currently available for CRASH300 only.");
  }
  const report = await runCrash300RuntimeTriggerValidation({
    startTs: params.startTs,
    endTs: params.endTs,
  });
  return {
    ok: true,
    ...report,
  };
}

