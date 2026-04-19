type CalibrationPassName = "precursor" | "trigger" | "behavior" | "extraction" | string;

export interface CalibrationAiUsageEvent {
  runId: number;
  passName: CalibrationPassName;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
}

type PassUsageAggregate = {
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
};

type RunUsageAggregate = {
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedUsd: number;
  byPass: Record<string, PassUsageAggregate>;
};

const telemetryByRun = new Map<number, RunUsageAggregate>();

function estimateUsd(tokens: number): number {
  // Conservative placeholder estimate used for operator telemetry only.
  // ~ $5 per 1M tokens blended input/output across deployed models.
  return Number(((tokens / 1_000_000) * 5).toFixed(6));
}

export function recordCalibrationAiUsage(event: CalibrationAiUsageEvent): void {
  const current = telemetryByRun.get(event.runId) ?? {
    requestCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedUsd: 0,
    byPass: {},
  };

  current.requestCount += 1;
  current.promptTokens += event.promptTokens;
  current.completionTokens += event.completionTokens;
  current.totalTokens += event.totalTokens;
  current.estimatedUsd = estimateUsd(current.totalTokens);

  const pass = event.passName || "unknown";
  const passAgg = current.byPass[pass] ?? {
    requestCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    durationMs: 0,
  };
  passAgg.requestCount += 1;
  passAgg.promptTokens += event.promptTokens;
  passAgg.completionTokens += event.completionTokens;
  passAgg.totalTokens += event.totalTokens;
  passAgg.durationMs += event.durationMs;
  current.byPass[pass] = passAgg;

  telemetryByRun.set(event.runId, current);
}

export function getCalibrationAiTelemetry(runId: number): RunUsageAggregate {
  return telemetryByRun.get(runId) ?? {
    requestCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedUsd: 0,
    byPass: {},
  };
}

export function clearCalibrationAiTelemetry(runId: number): void {
  telemetryByRun.delete(runId);
}
