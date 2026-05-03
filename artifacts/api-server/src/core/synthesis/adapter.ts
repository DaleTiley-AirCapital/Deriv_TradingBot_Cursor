import type {
  EliteSynthesisExitRules,
  EliteSynthesisFeatureSummary,
  EliteSynthesisParams,
  EliteSynthesisPolicyArtifact,
  EliteSynthesisPolicySummary,
} from "./types.js";

export type SynthesisMoveRecord = {
  kind: "calibrated_move";
  moveId: number;
  startTs: number;
  endTs: number;
  direction: "up" | "down";
  movePct: number;
  qualityTier: string;
  calibratedBaseFamily: string;
  calibratedMoveSizeBucket: string;
  phaseDerivedFamily?: string | null;
  phaseDerivedBucket?: string | null;
  earliestValidLiveSafeTriggerOffset?: string | null;
  bestTheoreticalLiveSafeTriggerOffset?: string | null;
  normalMaeBeforeSuccess?: number | null;
  realisticMfeAfterEntry?: number | null;
  barsToMfe?: number | null;
  pullbackAfterMfe?: number | null;
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
  slPct: number | null;
  trailingActivationPct: number | null;
  trailingDistancePct: number | null;
  pnlPct: number;
  mfePct: number | null;
  maePct: number | null;
  exitReason: string | null;
  matchedMoveIdStrict: number | null;
  strictRelationshipLabel: string | null;
  phantomNoiseLabel: string | null;
  enteredTooEarly: boolean;
  enteredTooLate: boolean;
  targetUnrealisticForBucket: boolean;
  trailingTooEarly: boolean;
  slTooTight: boolean;
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
  generateTriggerCandidatesFromMoveOffsets(dataset: UnifiedSynthesisDataset): Promise<Array<Record<string, unknown>>>;
  evaluatePolicyOnHistoricalData(dataset: UnifiedSynthesisDataset, policy: EliteSynthesisPolicyArtifact): Promise<PolicyEvaluationResult>;
  deriveExitPolicyFromSubset(dataset: UnifiedSynthesisDataset, subset: SynthesisTradeRecord[]): EliteSynthesisExitRules;
  validateNoFutureLeakage(policy: EliteSynthesisPolicyArtifact): { passed: boolean; notes: string[] };
}
