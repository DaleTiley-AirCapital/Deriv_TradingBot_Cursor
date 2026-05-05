import type {
  EliteSynthesisDataAvailability,
  EliteSynthesisExitRules,
  EliteSynthesisFeatureSummary,
  EliteSynthesisParams,
  EliteSynthesisPercentFieldUnit,
  EliteSynthesisPolicyArtifact,
  EliteSynthesisPolicySummary,
  EliteSynthesisUnitValidation,
  EliteSynthesisValidationError,
} from "./types.js";

export type SynthesisPercentFieldMeta = {
  raw: number | null;
  pctPoints: number | null;
  unit: EliteSynthesisPercentFieldUnit["inferredSourceUnit"];
  confidence: EliteSynthesisPercentFieldUnit["confidence"];
  reason: string;
};

export type SynthesisMoveRecord = {
  kind: "calibrated_move";
  moveId: number;
  startTs: number;
  endTs: number;
  direction: "up" | "down";
  movePct: number;
  movePctPoints: number;
  qualityTier: string;
  calibratedBaseFamily: string;
  calibratedMoveSizeBucket: string;
  phaseDerivedFamily?: string | null;
  phaseDerivedBucket?: string | null;
  earliestValidLiveSafeTriggerOffset?: string | null;
  bestTheoreticalLiveSafeTriggerOffset?: string | null;
  normalMaeBeforeSuccess?: number | null;
  normalMaeBeforeSuccessPctPoints?: number | null;
  realisticMfeAfterEntry?: number | null;
  realisticMfeAfterEntryPctPoints?: number | null;
  barsToMfe?: number | null;
  pullbackAfterMfe?: number | null;
  pullbackAfterMfePctPoints?: number | null;
  percentFields?: Record<string, SynthesisPercentFieldMeta>;
  liveSafeFeatures: Record<string, number | string | boolean | null>;
  triggerOffsets: Array<Record<string, unknown>>;
};

export type SynthesisTradeRecord = {
  kind: "runtime_trade";
  tradeId: string;
  entryTs: number;
  exitTs: number | null;
  direction: "buy" | "sell";
  runtimeFamily: string | null;
  selectedBucket: string | null;
  triggerTransition: string | null;
  setupMatch: number | null;
  confidence: number | null;
  triggerStrengthScore: number | null;
  qualityTier: string | null;
  regimeAtEntry: string | null;
  contextAgeBars: number | null;
  triggerAgeBars: number | null;
  epochAgeBars: number | null;
  projectedMovePct: number | null;
  projectedMovePctPoints: number | null;
  slPct: number | null;
  slPctPoints: number | null;
  trailingActivationPct: number | null;
  trailingActivationPctPoints: number | null;
  trailingDistancePct: number | null;
  trailingDistancePctPoints: number | null;
  pnlPct: number;
  pnlPctPoints: number;
  mfePct: number | null;
  mfePctPoints: number | null;
  maePct: number | null;
  maePctPoints: number | null;
  exitReason: string | null;
  modelSource: string | null;
  runtimeEvidence: number | null;
  matchedMoveIdStrict: number | null;
  strictRelationshipLabel: string | null;
  phantomNoiseLabel: string | null;
  enteredTooEarly: boolean;
  enteredTooLate: boolean;
  targetUnrealisticForBucket: boolean;
  trailingTooEarly: boolean;
  slTooTight: boolean;
  percentFields?: Record<string, SynthesisPercentFieldMeta>;
  liveSafeFeatures: Record<string, number | string | boolean | null>;
};

export type SynthesisRebuiltTriggerCandidateRecord = {
  kind: "rebuilt_trigger_candidate";
  candidateId: string;
  moveId: number;
  entryTs: number;
  exitTs: number | null;
  offsetLabel: string;
  offsetBars: number;
  direction: "buy" | "sell";
  runtimeFamily: string | null;
  selectedBucket: string | null;
  triggerTransition: string | null;
  triggerDirection: string | null;
  qualityTier: string | null;
  setupMatch: number | null;
  confidence: number | null;
  triggerStrengthScore: number | null;
  projectedMovePct: number | null;
  projectedMovePctPoints: number | null;
  slPct: number | null;
  slPctPoints: number | null;
  trailingActivationPct: number | null;
  trailingActivationPctPoints: number | null;
  trailingDistancePct: number | null;
  trailingDistancePctPoints: number | null;
  minHoldBars: number | null;
  pnlPct: number;
  pnlPctPoints: number;
  mfePct: number | null;
  mfePctPoints: number | null;
  maePct: number | null;
  maePctPoints: number | null;
  exitReason: string | null;
  eligible: boolean;
  rejectReason: string | null;
  percentFields?: Record<string, SynthesisPercentFieldMeta>;
  liveSafeFeatures: Record<string, number | string | boolean | null>;
};

export type SynthesisControlRecord = {
  kind: "non_move_control";
  controlId: string;
  ts: number;
  label: "non_move_control";
  liveSafeFeatures: Record<string, number | string | boolean | null>;
};

export type UnifiedSynthesisDataset = {
  serviceId: string;
  symbol: string;
  displayName: string;
  sourceRunIds: Record<string, number | null>;
  moves: SynthesisMoveRecord[];
  trades: SynthesisTradeRecord[];
  controls: SynthesisControlRecord[];
  rebuiltTriggerCandidates: SynthesisRebuiltTriggerCandidateRecord[];
  validationErrors: EliteSynthesisValidationError[];
  dataAvailability: EliteSynthesisDataAvailability;
  unitValidation: EliteSynthesisUnitValidation;
  missingFeatureImplementations: string[];
  reconciliation: Record<string, unknown> | null;
  summary: Record<string, unknown>;
};

export type PolicyEvaluationResult = EliteSynthesisPolicySummary & {
  selectedFeatures: EliteSynthesisFeatureSummary[];
  selectedMoveSizeBuckets: string[];
  selectedRuntimeArchetypes: string[];
  selectedBuckets: string[];
  selectedTriggerTransitions: string[];
  entryThresholds: Record<string, unknown>;
  entryTimingRules: Array<Record<string, unknown>>;
  noTradeRules: string[];
  exitRules: EliteSynthesisExitRules;
  leakagePassed: boolean;
  monthlyBreakdown: Array<Record<string, unknown>>;
  reasons: string[];
  sourcePool: "runtime_trades" | "rebuilt_trigger_candidates";
};

export interface SymbolSynthesisAdapter {
  readonly serviceId: string;
  readonly symbol: string;
  readonly displayName: string;
  loadCalibrationRuns(): Promise<Array<Record<string, unknown>>>;
  loadCalibratedMoves(params: { startTs: number; endTs: number }): Promise<SynthesisMoveRecord[]>;
  loadRuntimeModel(): Promise<Record<string, unknown>>;
  loadBacktestRuns(): Promise<Array<Record<string, unknown>>>;
  loadBacktestTrades(backtestRunId: number | null): Promise<SynthesisTradeRecord[]>;
  loadPhaseSnapshots(params: { windowDays: number }): Promise<Array<Record<string, unknown>>>;
  loadCalibrationReconciliation(backtestRunId: number | null): Promise<Record<string, unknown> | null>;
  buildLiveSafeFeatureVector(record: Record<string, unknown>): Record<string, number | string | boolean | null>;
  deriveMoveSizeBucket(movePct: number): string;
  deriveRuntimeArchetype(record: Record<string, unknown>): string;
  generateTriggerCandidatesFromMoveOffsets(dataset: UnifiedSynthesisDataset): Promise<SynthesisRebuiltTriggerCandidateRecord[]>;
  evaluatePolicyOnHistoricalData(dataset: UnifiedSynthesisDataset, policy: EliteSynthesisPolicyArtifact): Promise<PolicyEvaluationResult>;
  deriveExitPolicyFromSubset(dataset: UnifiedSynthesisDataset, subset: SynthesisTradeRecord[]): EliteSynthesisExitRules;
  validateNoFutureLeakage(policy: EliteSynthesisPolicyArtifact): { passed: boolean; notes: string[] };
}
