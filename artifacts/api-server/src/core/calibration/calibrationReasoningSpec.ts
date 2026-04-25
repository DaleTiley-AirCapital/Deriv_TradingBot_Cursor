export const ALLOWED_CALIBRATION_FAMILIES = [
  "breakout",
  "continuation",
  "reversal",
  "boom_expansion",
  "crash_expansion",
  "other_structural_family",
] as const;

export type CalibrationFamily = typeof ALLOWED_CALIBRATION_FAMILIES[number];

export function getAllowedCalibrationFamiliesForSymbol(symbol: string): CalibrationFamily[] {
  const upper = symbol.toUpperCase();
  if (upper.startsWith("CRASH")) return ["crash_expansion"];
  if (upper.startsWith("BOOM")) return ["boom_expansion"];
  if (upper.startsWith("R_") || upper.startsWith("RDBULL") || upper.startsWith("RDBEAR")) {
    return ["breakout", "continuation", "reversal"];
  }
  return ["breakout", "continuation", "reversal", "other_structural_family"];
}

export function normalizeCalibrationFamilyForSymbol(
  symbol: string,
  family: string | null | undefined,
  fallbackFamily?: string | null,
): CalibrationFamily {
  const allowed = getAllowedCalibrationFamiliesForSymbol(symbol);
  const requested = family as CalibrationFamily;
  if (allowed.includes(requested)) return requested;

  const fallback = fallbackFamily as CalibrationFamily;
  if (allowed.includes(fallback)) return fallback;

  return allowed[0] ?? "other_structural_family";
}

export const FAMILY_INFERENCE_SYSTEM_PROMPT = `You are a calibration analyst for a deterministic trading-research pipeline.

Hard rules:
- Work only from the supplied deterministic enriched data and compact raw slices.
- Do not compute indicators from scratch.
- Do not reference existing engines, score gates, or runtime strategy logic.
- Classify the move from the data only.
- Use only one of the symbol-compatible allowed family labels supplied in the user prompt.
- Output findings only. Do not recommend runtime code changes.
`;

export const BUCKET_MODEL_SYSTEM_PROMPT = `You are a calibration synthesis analyst for a deterministic trading-research pipeline.

Hard rules:
- Work only from deterministic family-plus-bucket aggregates and representative raw slices.
- Do not compute indicators from scratch.
- Do not reference existing engines, live score thresholds, or runtime trade manager rules.
- Describe the calibrated model for entry, target, protection, anomaly handling, and regression risk.
- Output calibration findings only. Do not recommend runtime code changes directly.
`;

export const FAMILY_INFERENCE_RESPONSE_SHAPE = {
  strategyFamily: "breakout|continuation|reversal|boom_expansion|crash_expansion|other_structural_family",
  developmentBars: 120,
  precursorBars: 60,
  triggerBars: 24,
  behaviorBars: 180,
  confidenceScore: 0.82,
  reasoningSummary: "Short explanation grounded in the supplied data only.",
};

export const BUCKET_MODEL_RESPONSE_SHAPE = {
  featureSetToKeep: ["emaSlope", "atr14"],
  featureSetDiagnosticOnly: ["rollingSkew"],
  idealEntryProfile: {},
  tpModel: {},
  slModel: {},
  killSwitchModel: {},
  regressionWarningPatterns: [],
  closureSignals: [],
  progressionSummary: {},
  reasoningNarrative: "Short explanation grounded in the supplied family and bucket aggregates only.",
  featureRelevance: [
    {
      featureName: "emaSlope",
      relevanceScore: 0.9,
      precursorUsefulness: 0.8,
      triggerUsefulness: 0.9,
      behaviorUsefulness: 0.5,
      notes: "One sentence.",
    },
  ],
};
