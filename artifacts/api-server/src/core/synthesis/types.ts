export type EliteSynthesisJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type EliteSynthesisResultState =
  | "completed_target_achieved"
  | "completed_exhausted_no_target"
  | "completed_foundation_incomplete"
  | "rebuilt_policy_evaluation_failed"
  | "failed_validation"
  | "failed_error"
  | "cancelled";

export type EliteSynthesisStage =
  | "queued"
  | "loading_data"
  | "building_dataset"
  | "evaluating_current_pool"
  | "rebuilding_trigger_candidates"
  | "feature_elimination"
  | "generating_policies"
  | "evaluating_policies"
  | "optimising_entry_timing"
  | "optimising_exits"
  | "refining_candidates"
  | "selecting_best"
  | "writing_result"
  | "completed"
  | "failed"
  | "cancelled";

export type EliteSynthesisSearchProfile = "fast" | "balanced" | "deep";

export type EliteSynthesisTargetProfile = "default" | "return_amplification" | "return_first";

export type EliteSynthesisBottleneck =
  | "none"
  | "current_runtime_pool_insufficient"
  | "rebuilt_trigger_pool_still_insufficient"
  | "rebuilt_trigger_execution_failed"
  | "rebuilt_policy_evaluation_failed"
  | "live_safe_features_do_not_separate_winners_from_sl_noise"
  | "exit_policy_cannot_rescue_entries"
  | "calibrated_bucket_archetype_mapping_too_noisy"
  | "insufficient_data_quality"
  | "search_exhausted";

export type EliteSynthesisLeakageRule =
  | "no_future_pnl"
  | "no_future_mfe_mae"
  | "no_actual_exit_reason"
  | "no_realised_win_loss"
  | "no_strict_oracle_relationship_label"
  | "no_calibrated_move_outcome_label"
  | "no_post_entry_candle_data"
  | "no_legacy_diagnostic_score";

export type EliteSynthesisValidationError =
  | "missing_reconciliation_moves"
  | "missing_runtime_family"
  | "missing_selected_bucket"
  | "missing_trigger_transition"
  | "missing_trigger_direction"
  | "missing_quality_tier"
  | "missing_regime"
  | "missing_mfe_mae"
  | "missing_runtime_or_rebuilt_candidates"
  | "missing_calibrated_moves"
  | "missing_phase_snapshots"
  | "unit_validation_failed";

export type EliteSynthesisObjectiveWeights = {
  winRate?: number;
  slHitRate?: number;
  profitFactor?: number;
  tradeCount?: number;
  drawdown?: number;
  moveCapture?: number;
  phantomTrades?: number;
  stability?: number;
};

export type EliteSynthesisParams = {
  calibrationRunId?: number | null;
  backtestRunId?: number | null;
  windowDays?: number | null;
  startTs?: number | null;
  endTs?: number | null;
  searchProfile?: EliteSynthesisSearchProfile;
  targetProfile?: EliteSynthesisTargetProfile | null;
  maxPasses?: number | null;
  patiencePasses?: number | null;
  targetTradeCountMin?: number | null;
  targetTradeCountMax?: number | null;
  preferredTradeCount?: number | null;
  maxTradesPerDay?: number | null;
  allowCascade?: boolean | null;
  objectiveWeights?: EliteSynthesisObjectiveWeights | null;
};

export type EliteSynthesisFeatureSummary = {
  key: string;
  positiveP50?: number | null;
  negativeP50?: number | null;
  overlapScore: number;
  separationScore: number;
  missingRate: number;
  monthlyStabilityScore: number;
  kept: boolean;
  reasons: string[];
};

export type EliteSynthesisDataAvailabilityMetric = {
  total: number;
  present: number;
  missing: number;
  missingRate: number;
  nullableAllowed: boolean;
  notes: string[];
};

export type EliteSynthesisDataAvailability = {
  counts: Record<string, number>;
  metrics: Record<string, EliteSynthesisDataAvailabilityMetric>;
};

export type EliteSynthesisPercentUnit = "percentage_points" | "fraction";

export type EliteSynthesisPercentFieldUnit = {
  inferredSourceUnit: EliteSynthesisPercentUnit;
  canonicalUnit: "percentage_points";
  confidence: "field_default" | "source_metadata";
  reason: string;
};

export type EliteSynthesisUnitValidation = {
  passed: boolean;
  unit: "percentage_points" | "fraction" | "mixed";
  canonicalUnit: "percentage_points";
  notes: string[];
  fieldUnits: Record<string, EliteSynthesisPercentFieldUnit>;
  fieldWarnings: string[];
  fieldErrors: string[];
  sampledRanges: Record<string, { min: number | null; max: number | null }>;
  rawRuntimeTradeExamples?: Record<string, number[]>;
  canonicalRuntimeTradeExamples?: Record<string, number[]>;
  normalisationNotes: string[];
};

export type EliteSynthesisEntryTimingRule = {
  preferredOffset: string;
  earliestSafeOffset: string | null;
  rejectEarlierThan?: string | null;
  rejectLaterThan?: string | null;
  offsetClusters?: string[];
};

export type EliteSynthesisExitRules = {
  tpTargetPct: number;
  slRiskPct: number;
  protectionActivationPct: number;
  dynamicProtectionDistancePct: number;
  trailingActivationPct: number;
  trailingDistancePct: number;
  minHoldBars: number;
  unit: "percentage_points";
  exitUnitValidation: {
    selectedSubsetMfeRange: { min: number | null; max: number | null };
    selectedSubsetMaeAbsRange: { min: number | null; max: number | null };
    selectedSubsetMfeRangePctPoints?: { min: number | null; max: number | null };
    selectedSubsetMaeAbsRangePctPoints?: { min: number | null; max: number | null };
    derivedTpPctPoints: number;
    derivedSlPctPoints: number;
    derivedProtectionActivationPctPoints: number;
    derivedDynamicProtectionDistancePctPoints: number;
    derivedTrailingActivationPctPoints: number;
    derivedTrailingDistancePctPoints: number;
    sourceValueExamples?: Record<string, number[]>;
    canonicalValueExamples?: Record<string, number[]>;
    impossibleExitRejected: boolean;
    warnings: string[];
  };
};

export type EliteSynthesisPolicySummary = {
  policyId: string;
  passNumber: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  slHits: number;
  slHitRate: number;
  profitFactor: number;
  accountReturnPct: number;
  maxDrawdownPct: number;
  phantomCount: number;
  objectiveScore: number;
  selectedFeaturesSummary: string[];
  tpSlLifecycleSummary?: string[];
  tpSlTrailingSummary?: string[];
  targetAchieved: boolean;
  [key: string]: unknown;
};

export type EliteSynthesisPolicyArtifact = {
  policyId: string;
  version: string;
  generatedAt: string;
  sourceCalibrationRunId: number | null;
  sourceBacktestRunId: number | null;
  calibratedBaseFamily: string;
  selectedMoveSizeBuckets: string[];
  selectedRuntimeArchetypes: string[];
  selectedBuckets: string[];
  selectedTriggerTransitions: string[];
  selectedCoreFeatures: EliteSynthesisFeatureSummary[];
  entryThresholds: Record<string, unknown>;
  entryTimingRules: EliteSynthesisEntryTimingRule[];
  noTradeRules: string[];
  tpRules: Record<string, unknown>;
  slRules: Record<string, unknown>;
  lifecycleManagerRules: Record<string, unknown>;
  trailingRules: Record<string, unknown>;
  minHoldRules: Record<string, unknown>;
  dailyTradeLimit: number;
  cascadeRules: { enabled: boolean; notes: string[] };
  liveSafeEliteScoreFormula: string;
  expectedThreeMonthPerformance: Record<string, unknown>;
  monthlyBreakdown: Array<Record<string, unknown>>;
  passNumberSelected: number;
  objectiveScore: number;
  leakageAudit: EliteSynthesisLeakageAudit;
  bottleneckAnalysis: EliteSynthesisBottleneckAnalysis;
  implementationNotes: string[];
  [key: string]: unknown;
};

export type EliteSynthesisPassLog = {
  passNumber: number;
  stage: EliteSynthesisStage;
  candidateCount: number;
  evaluatedCount: number;
  searchSpaceRemaining: number;
  bestPolicyId: string | null;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  slHits: number;
  slHitRate: number;
  profitFactor: number;
  accountReturnPct: number;
  maxDrawdownPct: number;
  phantomCount: number;
  selectedFeatures: string[];
  mutationSummary: string;
  changedParameters: string[];
  reasonBestImproved: string;
  bestSoFar: boolean;
  reasonStopped?: string | null;
};

export type EliteSynthesisLeakageAudit = {
  passed: boolean;
  checkedRules: Array<{
    rule: EliteSynthesisLeakageRule;
    passed: boolean;
    notes: string[];
  }>;
};

export type EliteSynthesisBottleneckAnalysis = {
  targetAchieved: boolean;
  triggerRebuildAttempted: boolean;
  classification: EliteSynthesisBottleneck;
  reasons: string[];
  futureImplementationRecommendation: string;
  topRawFamilyReject?: { rawValue: string; count: number } | null;
  topRawTransitionReject?: { rawValue: string; count: number } | null;
  topRawDirectionReject?: { rawValue: string; count: number } | null;
  topInvalidArchetypeExamplesCount?: number;
  validationHardeningFailed?: boolean;
  failedInvariant?: string | null;
};

export type EliteSynthesisResult = {
  jobId: number;
  serviceId: string;
  status: EliteSynthesisJobStatus;
  resultState: EliteSynthesisResultState;
  targetAchieved: boolean;
  bestPolicySummary: EliteSynthesisPolicySummary | null;
  topPolicySummaries: EliteSynthesisPolicySummary[];
  rejectedPolicySummaries?: Array<Record<string, unknown>>;
  bestPolicyArtifact: EliteSynthesisPolicyArtifact | null;
  passLogSummary: EliteSynthesisPassLog[];
  fullPassLog: EliteSynthesisPassLog[];
  featureDistributions: EliteSynthesisFeatureSummary[];
  exitOptimisationTable: Array<Record<string, unknown>>;
  triggerRebuildSummary: Record<string, unknown>;
  rebuiltTriggerDiagnostics: Record<string, unknown>;
  bottleneckSummary: EliteSynthesisBottleneckAnalysis;
  leakageAuditSummary: EliteSynthesisLeakageAudit;
  validationErrors: EliteSynthesisValidationError[];
  dataAvailability: EliteSynthesisDataAvailability;
  unitValidation: EliteSynthesisUnitValidation;
  missingFeatureImplementations: string[];
  windowSummary: Record<string, unknown>;
  sourceRunIds: Record<string, number | null>;
  datasetSummary: Record<string, unknown>;
  [key: string]: unknown;
};

export type LifecycleState =
  | "initial_risk"
  | "protected"
  | "tp1_reached"
  | "runner_active"
  | "momentum_watch"
  | "tighten_protection"
  | "exit_pending"
  | "exited";

export type LifecycleDecision =
  | "hold"
  | "protect_to_breakeven"
  | "protect_to_profit"
  | "partial_take_profit"
  | "continue_runner"
  | "tighten_dynamic_stop"
  | "cascade_allowed"
  | "exit_momentum_failure"
  | "exit_reversal_signal"
  | "exit_tp2"
  | "exit_time_failure"
  | "exit_hard_sl";

export type TradeLifecycleSnapshot = {
  currentPnlPct: number;
  currentMfePct: number;
  currentMaePct: number;
  progressToExpectedMovePct: number;
  progressToTp1Pct: number;
  progressToTp2Pct: number;
  timeInTradeBars: number;
  timeInTradeMinutes: number;
  expectedMaturityBars: number;
  expectedMaturityMinutes: number;
  barsSinceEntry: number;
  oneBarReturnPct: number;
  threeBarReturnPct: number;
  fiveBarReturnPct: number;
  pullbackFromLocalExtremePct: number;
  atrNormalisedPullback: number;
  candleBodyDirection: "up" | "down" | "flat";
  upperWickRejection: number;
  lowerWickRejection: number;
  microBreakDirection: "up" | "down" | "flat";
  microBreakStrengthPct: number;
  reclaimConfirmed: boolean;
  rangeExpansionScore: number;
  rangeCompressionScore: number;
  compressionToExpansionScore: number;
  atrRank: number;
  bbWidthRank: number;
  momentumDecayScore: number;
  reversalPressureScore: number;
  continuationScore: number;
  normalPullbackScore: number;
};

export type LifecycleExitPlan = {
  initialHardSlPct: number;
  tp1Pct: number;
  tp2Pct: number;
  runnerTargetPct: number;
  protectionActivationPct: number;
  minimumNoTrailBars: number;
  minimumNoTrailMinutes: number;
  minimumProtectionBars: number;
  minimumProtectionMinutes: number;
  expectedMaturityBars: number;
  expectedMaturityMinutes: number;
  maxHoldBars: number;
  maxHoldMinutes: number;
  partialTakeProfitPct: number;
  runnerRemainderPct: number;
  dynamicProtectionDistancePct: number;
  trailingDistancePct?: number;
  lifecycleManagerModel: string;
  protectionRules: Record<string, unknown>;
  exitDecisionRules: Record<string, unknown>;
  maturityRules: Record<string, unknown>;
};

export type LifecycleReplayTraceEntry = {
  candleTs: number;
  state: LifecycleState;
  decision: LifecycleDecision;
  snapshot: TradeLifecycleSnapshot;
  notes: string[];
  protectedStopPct: number | null;
};

export type TradeLifecycleReplayTradeResult = {
  tradeId: string;
  serviceId: string;
  sourceJobId: number | null;
  sourcePolicyId: string | null;
  entryTs: number;
  oldExitTs: number | null;
  lifecycleExitTs: number | null;
  oldPnlPct: number;
  lifecyclePnlPct: number;
  oldExitReason: string | null;
  lifecycleExitReason: string | null;
  maxMfeSeenBeforeExit: number;
  maxMaeSeenBeforeExit: number;
  oldMfeCaptureRatio: number;
  lifecycleMfeCaptureRatio: number;
  timeInTradeOld: number;
  timeInTradeLifecycle: number;
  tp1Reached: boolean;
  tp2Reached: boolean;
  protectedAt: number | null;
  partialTakenAt: number | null;
  runnerActivatedAt: number | null;
  exitDecisionTrace: LifecycleReplayTraceEntry[];
  oldExitWasTooEarly: boolean;
  lifecycleCapturedMoreMove: boolean;
};

export type TradeLifecycleReplayReport = {
  serviceId: string;
  sourceJobId: number | null;
  sourcePolicyId: string | null;
  tradeCount: number;
  oldMedianPnlPct: number;
  lifecycleMedianPnlPct: number;
  oldAveragePnlPct: number;
  lifecycleAveragePnlPct: number;
  oldMfeCaptureRatio: number;
  lifecycleMfeCaptureRatio: number;
  oldTotalAccountReturnPct: number;
  lifecycleTotalAccountReturnPct: number;
  oldAverageMonthlyReturnPct: number;
  lifecycleAverageMonthlyReturnPct: number;
  improvedTradeCount: number;
  exitReasonDistribution: Record<string, number>;
  examples: {
    protectedExitExamples: TradeLifecycleReplayTradeResult[];
    lifecycleHoldImprovedResult: TradeLifecycleReplayTradeResult[];
    lifecycleProtectedProfit: TradeLifecycleReplayTradeResult[];
    lifecycleExitedCorrectly: TradeLifecycleReplayTradeResult[];
  };
  trades: TradeLifecycleReplayTradeResult[];
};

export type EliteSynthesisProgressSnapshot = {
  jobId: number;
  serviceId: string;
  symbol: string;
  status: EliteSynthesisJobStatus;
  stage: EliteSynthesisStage;
  progressPct: number;
  currentPass: number;
  maxPasses: number;
  currentPolicyCount: number;
  evaluatedPolicyCount: number;
  bestWinRate: number | null;
  bestSlRate: number | null;
  bestProfitFactor: number | null;
  bestTradeCount: number | null;
  bestObjectiveScore: number | null;
  bestPolicyId: string | null;
  heartbeatAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  errorSummary: Record<string, unknown> | null;
  message: string;
};

export const ELITE_SYNTHESIS_STORAGE_KEY = "deriv_elite_synthesis_active_job";

export function profileDefaults(profile: EliteSynthesisSearchProfile): Required<Pick<
  EliteSynthesisParams,
  "maxPasses" | "patiencePasses" | "targetTradeCountMin" | "targetTradeCountMax" | "preferredTradeCount" | "maxTradesPerDay" | "allowCascade"
>> {
  if (profile === "fast") {
    return {
      maxPasses: 6,
      patiencePasses: 2,
      targetTradeCountMin: 45,
      targetTradeCountMax: 75,
      preferredTradeCount: 60,
      maxTradesPerDay: 1,
      allowCascade: false,
    };
  }
  if (profile === "deep") {
    return {
      maxPasses: 24,
      patiencePasses: 6,
      targetTradeCountMin: 45,
      targetTradeCountMax: 75,
      preferredTradeCount: 60,
      maxTradesPerDay: 1,
      allowCascade: false,
    };
  }
  return {
    maxPasses: 12,
    patiencePasses: 4,
    targetTradeCountMin: 45,
    targetTradeCountMax: 75,
    preferredTradeCount: 60,
    maxTradesPerDay: 1,
    allowCascade: false,
  };
}
