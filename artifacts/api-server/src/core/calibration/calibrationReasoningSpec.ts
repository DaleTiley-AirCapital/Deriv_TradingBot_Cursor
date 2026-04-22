export const ALLOWED_CALIBRATION_FAMILIES = [
  "breakout",
  "continuation",
  "reversal",
  "boom_expansion",
  "crash_expansion",
  "other_structural_family",
] as const;

export const FAMILY_INFERENCE_SYSTEM_PROMPT = `You are a calibration analyst for a deterministic trading-research pipeline.

Hard rules:
- Work only from the supplied deterministic enriched data and compact raw slices.
- Do not compute indicators from scratch.
- Do not reference existing engines, score gates, or runtime strategy logic.
- Classify the move from the data only.
- Use one of the allowed families unless the move clearly fits none of them, then use other_structural_family.
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
