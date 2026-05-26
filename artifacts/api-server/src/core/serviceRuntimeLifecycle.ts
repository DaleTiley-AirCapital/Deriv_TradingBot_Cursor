import { db, candlesTable, platformStateTable } from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { getActiveModes } from "../infrastructure/deriv.js";
import { getLatestSymbolResearchProfile } from "./calibration/symbolResearchProfile.js";
import {
  getPromotedSymbolRuntimeModel,
  type PromotedSymbolRuntimeModel,
} from "./calibration/promotedSymbolModel.js";
import { getEliteSynthesisJob, listEliteSynthesisJobs } from "./synthesis/jobs.js";

export type RuntimeValidationState = "not_run" | "running" | "passed" | "failed";

export interface ServicePromotedRuntimeArtifact {
  artifactId: string;
  artifactType: "service_promoted_runtime";
  version: string;
  serviceId: string;
  sourceCandidateArtifactId: string;
  sourceSynthesisJobId: number | null;
  sourcePolicyId: string | null;
  promotedAt: string;
  promotedBy: "manual";
  runtimeFamily: string | null;
  triggerTransition: string | null;
  selectedBucket: string | null;
  selectedMoveSizeBucket: string | null;
  direction: "buy" | "sell" | null;
  entryRules: Record<string, unknown>;
  liveSafeTriggerExpression: Record<string, unknown>;
  selectedFeatures: unknown;
  requiredFeatureKeys: string[];
  dynamicExitPlan: unknown;
  tpRules: unknown;
  slRules: unknown;
  trailingRules: unknown;
  minHoldRules: unknown;
  cascadeRules: unknown;
  capitalRecommendation: Record<string, unknown>;
  confidenceScoring: Record<string, unknown>;
  expectedPerformance: Record<string, unknown>;
  monthlyBreakdown: unknown[];
  selectedTradeSummary: Record<string, unknown>;
  validationStatus: {
    runtimeValidationStatus: RuntimeValidationState;
    parityStatus: RuntimeValidationState;
    triggerValidationStatus: RuntimeValidationState;
    runtimeMimicReady: boolean;
  };
  warnings: string[];
  allowedModes: {
    paper: boolean;
    demo: boolean;
    real: boolean;
  };
  runtimeModelAdapter: PromotedSymbolRuntimeModel | null;
}

export interface ServiceLifecycleStatus {
  serviceId: string;
  symbol: string;
  dataCoverageStatus: "not_ready" | "stale" | "ready";
  latestCandleTs: string | null;
  streamState: "active" | "inactive";
  calibrationStatus: "not_run" | "complete";
  latestCalibrationRunId: number | null;
  synthesisStatus: string;
  latestSynthesisJobId: number | null;
  stagedCandidateArtifactId: string | null;
  stagedCandidateSourceRunId: number | null;
  promotedRuntimeArtifactId: string | null;
  promotedRuntimeVersion: string | null;
  promotedRuntimeSourcePolicyId: string | null;
  runtimeValidationStatus: RuntimeValidationState;
  parityStatus: RuntimeValidationState;
  triggerValidationStatus: RuntimeValidationState;
  activeMode: "paper" | "demo" | "real" | "idle" | "multi";
  executionAllowedForActiveMode: boolean;
  allocatorConnected: boolean;
  latestScannerStatus: string | null;
  latestScannerReason: string | null;
  latestScannerAt: string | null;
  latestScannerDetail: Record<string, unknown>;
  nextRequiredAction: string;
  workflowStages: Array<{
    label: string;
    status: "complete" | "incomplete" | "blocked" | "warning";
    sourceRunId: string | number | null;
    timestamp: string | null;
    nextAction: string | null;
    blockers: string[];
  }>;
  blockers: string[];
  warnings: string[];
}

export interface StagedSynthesisCandidateState {
  serviceId: string;
  artifactId: string;
  jobId: number;
  sourcePolicyId: string | null;
  stagedAt: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function serviceRuntimeKey(serviceId: string): string {
  return `promoted_service_runtime_${serviceId.toUpperCase()}`;
}

function stagedSynthesisCandidateKey(serviceId: string): string {
  return `staged_synthesis_candidate_${serviceId.toUpperCase()}`;
}

const STAGED_SYNTHESIS_REPAIR_KEY = "v3_1_staged_synthesis_candidate_state_repair_complete";

function readNumeric(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normaliseMode(activeModes: string[]): "paper" | "demo" | "real" | "idle" | "multi" {
  if (activeModes.length === 0) return "idle";
  if (activeModes.length > 1) return "multi";
  const first = activeModes[0];
  return first === "paper" || first === "demo" || first === "real" ? first : "idle";
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

async function ensureStagedSynthesisCandidateStateRepaired(): Promise<void> {
  const rows = await db
    .select()
    .from(platformStateTable)
    .where(eq(platformStateTable.key, STAGED_SYNTHESIS_REPAIR_KEY))
    .limit(1);
  if (rows[0]?.value === "true") return;
  await db.execute(sql`DELETE FROM ${platformStateTable} WHERE ${platformStateTable.key} LIKE 'staged_synthesis_candidate_%'`);
  await db
    .insert(platformStateTable)
    .values({ key: STAGED_SYNTHESIS_REPAIR_KEY, value: "true" })
    .onConflictDoUpdate({
      target: platformStateTable.key,
      set: { value: "true", updatedAt: new Date() },
    });
}

function buildCrash300RuntimeAdapter(
  artifact: Record<string, unknown>,
  serviceId: string,
): PromotedSymbolRuntimeModel {
  const selectedPolicy = selectedPolicyFromArtifact(artifact);
  const expectedPerformance = expectedPerformanceFromArtifact(artifact);
  const exitAudit = asRecord(artifact.exitDerivationAudit);
  const direction = String(selectedPolicy.direction ?? "").toLowerCase() === "buy" || String(selectedPolicy.direction ?? "").toLowerCase() === "sell"
    ? String(selectedPolicy.direction).toLowerCase() as "buy" | "sell"
    : inferredRuntimeDirection(serviceId, artifact);
  const directionKey = direction === "buy" ? "up" : "down";
  const sourceRunId = readNumeric(artifact.sourceSynthesisJobId) ?? 0;
  const tradeCount = Math.max(1, readNumeric(expectedPerformance.trades) ?? 1);
  const tradesPerMonth = Math.max(1, Math.round(tradeCount / 3));
  const tpTargetPct = Math.max(0.1, readNumeric(exitAudit.derivedTpPct) ?? 5);
  const slRiskPct = Math.max(0.1, readNumeric(exitAudit.derivedSlPct) ?? 1);
  const trailingActivationPct = Math.max(0.1, readNumeric(exitAudit.derivedTrailingActivationPct) ?? 2);
  const trailingDistancePct = Math.max(0.1, readNumeric(exitAudit.derivedTrailingDistancePct) ?? 1);
  const confidenceMultiplier = Math.max(0.85, Math.min(1.15, (readNumeric(expectedPerformance.winRate) ?? 0.8)));
  const coverage = asRecord(artifact.largeMoveCoverage);
  const coveragePct = readNumeric(coverage.coveragePct) ?? 0;
  const coverageFraction = coveragePct > 1 ? coveragePct / 100 : coveragePct;
  const candidateEmissionCooldownMinutes = buildDerivedCandidateCooldownMinutes({ artifact, trades: tradeCount });
  const buildDerivedContextThreshold = Math.max(
    0.56,
    Math.min(0.6, coverageFraction > 0 ? 0.5 + coverageFraction * 0.11 : 0.58),
  );
  const buildDerivedTriggerThreshold = Math.max(0.3, Math.min(0.35, buildDerivedContextThreshold - 0.25));
  const formulaOverride = {
    crash300: {
      contextMatchThreshold: Number(buildDerivedContextThreshold.toFixed(2)),
      triggerStrengthThreshold: Number(buildDerivedTriggerThreshold.toFixed(2)),
      maxContextAgeBars: 240,
      allowedDirections: [direction],
      candidateEmissionCooldownMinutes,
      liveSafeTriggerExpressionRequired: true,
      sourcePolicyId: String(artifact.sourcePolicyId ?? ""),
      thresholdDerivation: {
        source: "runtime_build_selected_family_replay",
        previousFallbackWouldUseWinRate: Number(confidenceMultiplier.toFixed(2)),
        coveragePct,
        selectedDirection: direction,
        selectedTrades: tradeCount,
        candidateEmissionCooldownMinutes,
        rationale: "Use thresholds from the captured build family instead of rebuilding live context gates from a fallback win-rate default.",
      },
    },
  };
  return {
    symbol: serviceId,
    source: "promoted_symbol_model",
    sourceRunId,
    promotedAt: new Date().toISOString(),
    suggestedAt: new Date().toISOString(),
    recommendedScanIntervalSeconds: tradesPerMonth >= 20 ? 60 : tradesPerMonth >= 10 ? 120 : 300,
    recommendedScoreGates: {
      paper: 60,
      demo: 75,
      real: 85,
    },
    expectedTradesPerMonth: tradesPerMonth,
    expectedCapitalUtilizationPct: Math.max(10, Math.min(90, readNumeric(expectedPerformance.accountReturnPct) ?? 15)),
    confidenceMultiplier: Number(confidenceMultiplier.toFixed(2)),
    projectedMoveMultiplier: Number(Math.max(0.9, Math.min(1.4, tpTargetPct / 5)).toFixed(2)),
    holdProfile: {
      source: "service_promoted_runtime",
      offsetCluster: selectedPolicy.offsetCluster ?? null,
      expectedHoldWindow: selectedPolicy.minHoldRules ?? null,
    },
    tpModel: {
      targetPct: tpTargetPct,
      fallbackTargetPct: tpTargetPct,
      bucketSource: "service_promoted_runtime",
      bucketSelection: "direction_quality_leadin",
      dynamicByQualityLeadIn: true,
      rationale: "Derived from staged synthesis candidate exit audit; runtime parity still pending.",
      buckets: {
        [`${directionKey}|all|all`]: { targetPct: tpTargetPct, count: tradeCount },
        ["all|all|all"]: { targetPct: tpTargetPct, count: tradeCount },
      },
    },
    slModel: {
      maxInitialRiskPct: slRiskPct,
      source: "service_promoted_runtime",
    },
    trailingModel: {
      activationProfitPct: trailingActivationPct,
      trailingDistancePct,
      minHoldMinutesBeforeTrail: Math.max(1, readNumeric(asRecord(selectedPolicy.minHoldRules).minHoldBars) ?? 1),
      source: "service_promoted_runtime",
    },
    formulaOverride,
    entryModel: "service_promoted_runtime",
    confirmationWindow: "60m",
    buildPriority: "high",
    researchStatus: "engine_candidate",
  };
}

export async function readPromotedServiceRuntimeArtifact(serviceId: string): Promise<ServicePromotedRuntimeArtifact | null> {
  const rows = await db
    .select()
    .from(platformStateTable)
    .where(eq(platformStateTable.key, serviceRuntimeKey(serviceId)))
    .limit(1);
  const raw = rows[0]?.value;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ServicePromotedRuntimeArtifact;
  } catch {
    return null;
  }
}

export async function readStagedSynthesisCandidateState(serviceId: string): Promise<StagedSynthesisCandidateState | null> {
  await ensureStagedSynthesisCandidateStateRepaired();
  const rows = await db
    .select()
    .from(platformStateTable)
    .where(eq(platformStateTable.key, stagedSynthesisCandidateKey(serviceId)))
    .limit(1);
  const raw = rows[0]?.value;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StagedSynthesisCandidateState;
  } catch {
    return null;
  }
}

export async function writeStagedSynthesisCandidateState(state: StagedSynthesisCandidateState): Promise<void> {
  await ensureStagedSynthesisCandidateStateRepaired();
  await db
    .insert(platformStateTable)
    .values({ key: stagedSynthesisCandidateKey(state.serviceId), value: JSON.stringify(state) })
    .onConflictDoUpdate({
      target: platformStateTable.key,
      set: { value: JSON.stringify(state), updatedAt: new Date() },
    });
}

export async function clearStagedSynthesisCandidateState(serviceId: string): Promise<void> {
  await ensureStagedSynthesisCandidateStateRepaired();
  await db
    .delete(platformStateTable)
    .where(eq(platformStateTable.key, stagedSynthesisCandidateKey(serviceId)));
}

export async function writePromotedServiceRuntimeArtifact(artifact: ServicePromotedRuntimeArtifact): Promise<void> {
  await db
    .insert(platformStateTable)
    .values({ key: serviceRuntimeKey(artifact.serviceId), value: JSON.stringify(artifact) })
    .onConflictDoUpdate({
      target: platformStateTable.key,
      set: { value: JSON.stringify(artifact), updatedAt: new Date() },
    });
}

function reviewCandidateFromJob(job: Awaited<ReturnType<typeof getEliteSynthesisJob>>): Record<string, unknown> | null {
  const artifact = job?.resultArtifact?.reviewCandidateRuntimeArtifact;
  return artifact && typeof artifact === "object" ? artifact as Record<string, unknown> : null;
}

function selectedPolicyFromArtifact(artifact: Record<string, unknown>): Record<string, unknown> {
  const selectedPolicy = asRecord(artifact.selectedPolicy);
  if (Object.keys(selectedPolicy).length > 0) return selectedPolicy;
  return {
    sourcePool: "runtime_build_result",
    runtimeArchetype: artifact.runtimeFamily ?? null,
    triggerTransition: artifact.triggerTransition ?? null,
    selectedBucket: artifact.selectedBucket ?? null,
    selectedMoveSizeBucket: artifact.selectedMoveSizeBucket ?? null,
    direction: artifact.direction ?? null,
    offsetCluster: artifact.offsetCluster ?? null,
    dynamicExitPlanSummary: artifact.lifecycleManagerRules ?? artifact.dynamicTpProtectionSummary ?? null,
  };
}

function inferredRuntimeDirection(
  serviceId: string,
  artifact: Record<string, unknown>,
): "buy" | "sell" {
  const rawDirection = String(artifact.direction ?? "").toLowerCase();
  if (rawDirection === "buy" || rawDirection === "sell") return rawDirection;

  const sourcePolicyId = String(artifact.sourcePolicyId ?? "").toLowerCase();
  const runtimeFamily = String(artifact.runtimeFamily ?? "").toLowerCase();

  if (serviceId.toUpperCase() === "CRASH300") {
    if (sourcePolicyId.includes("down") || sourcePolicyId.includes("short") || sourcePolicyId.includes("sell")) return "sell";
    if (sourcePolicyId.includes("lifecycle_capture") || runtimeFamily.includes("post_crash_recovery")) return "buy";
    return "buy";
  }

  if (serviceId.toUpperCase() === "R_75") {
    if (sourcePolicyId.includes("reversal") || sourcePolicyId.includes("sell")) return "sell";
    if (sourcePolicyId.includes("breakout") || sourcePolicyId.includes("continuation") || sourcePolicyId.includes("buy")) return "buy";
    return "buy";
  }

  return "buy";
}

function selectedR75Engines(sourcePolicyId: string): string[] {
  const source = sourcePolicyId.toLowerCase();
  const engines: string[] = [];
  if (source.includes("breakout")) engines.push("r75_breakout_engine");
  if (source.includes("reversal")) engines.push("r75_reversal_engine");
  if (source.includes("continuation")) engines.push("r75_continuation_engine");
  return engines.length > 0
    ? engines
    : ["r75_breakout_engine", "r75_reversal_engine", "r75_continuation_engine"];
}

type R75RuntimeContract = {
  contractId: string;
  scenarioId: string;
  policyId: string;
  runtimeFamily: string;
  engineName: string;
  direction: "buy" | "sell";
  componentThresholds?: Record<string, number>;
  featureBands?: Record<string, { min: number | null; max: number | null; p25: number | null; p50: number | null; p75: number | null }>;
  runtimeEvidenceThresholds?: {
    minConfidence: number | null;
    minSetupMatch: number | null;
    minTriggerStrengthScore: number | null;
    minExpectedMovePct: number | null;
  };
  trades: number;
  wins: number | null;
  losses: number | null;
  winRate: number | null;
  slHitRate: number | null;
  lifecycleMedianPnlPct: number | null;
  lifecycleAveragePnlPct: number | null;
  lifecycleMfeCaptureRatio: number | null;
  averageMonthlyAccountReturnPct: number | null;
  rankingScore: number | null;
  targetMoveCoverage: unknown;
  dynamicExitPlanSummary: unknown;
  guardrailsPassed: boolean;
};

function r75EngineForFamily(family: unknown): string | null {
  const normalized = String(family ?? "").toLowerCase();
  if (normalized === "breakout") return "r75_breakout_engine";
  if (normalized === "reversal") return "r75_reversal_engine";
  if (normalized === "continuation") return "r75_continuation_engine";
  return null;
}

function normalizeR75Direction(value: unknown): "buy" | "sell" | null {
  const direction = String(value ?? "").toLowerCase();
  return direction === "buy" || direction === "sell" ? direction : null;
}

function normalizeR75RuntimeContracts(
  value: unknown,
): R75RuntimeContract[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((raw): R75RuntimeContract | null => {
      const source = asRecord(raw);
      const runtimeFamily = String(source.runtimeFamily ?? "").toLowerCase();
      const engineName = String(source.engineName ?? r75EngineForFamily(runtimeFamily) ?? "");
      const direction = normalizeR75Direction(source.direction);
      const trades = readNumeric(source.trades) ?? 0;
      if (!engineName || !direction || trades <= 0) return null;
      const policyId = String(source.policyId ?? source.scenarioId ?? `${engineName}:${direction}`);
      return {
        contractId: String(source.contractId ?? `${engineName}:${direction}`),
        scenarioId: String(source.scenarioId ?? policyId),
        policyId,
        runtimeFamily,
        engineName,
        direction,
        componentThresholds: numericRecord(source.componentThresholds),
        featureBands: normalizeFeatureBands(source.featureBands),
        runtimeEvidenceThresholds: normalizeRuntimeEvidenceThresholds(source.runtimeEvidenceThresholds),
        trades,
        wins: readNumeric(source.wins),
        losses: readNumeric(source.losses),
        winRate: readNumeric(source.winRate),
        slHitRate: readNumeric(source.slHitRate),
        lifecycleMedianPnlPct: readNumeric(source.lifecycleMedianPnlPct),
        lifecycleAveragePnlPct: readNumeric(source.lifecycleAveragePnlPct),
        lifecycleMfeCaptureRatio: readNumeric(source.lifecycleMfeCaptureRatio),
        averageMonthlyAccountReturnPct: readNumeric(source.averageMonthlyAccountReturnPct),
        rankingScore: readNumeric(source.rankingScore),
        targetMoveCoverage: source.targetMoveCoverage ?? null,
        dynamicExitPlanSummary: source.dynamicExitPlanSummary ?? null,
        guardrailsPassed: bool(source.guardrailsPassed, true),
      };
    })
    .filter((contract): contract is R75RuntimeContract => Boolean(contract));
}

function numericRecord(value: unknown): Record<string, number> | undefined {
  const record = asRecord(value);
  const entries = Object.entries(record)
    .map(([key, raw]) => [key, Number(raw)] as const)
    .filter(([, raw]) => Number.isFinite(raw));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeFeatureBands(value: unknown): R75RuntimeContract["featureBands"] | undefined {
  const record = asRecord(value);
  const entries = Object.entries(record).map(([key, raw]) => {
    const band = asRecord(raw);
    return [key, {
      min: readNumeric(band.min),
      max: readNumeric(band.max),
      p25: readNumeric(band.p25),
      p50: readNumeric(band.p50),
      p75: readNumeric(band.p75),
    }] as const;
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeRuntimeEvidenceThresholds(value: unknown): R75RuntimeContract["runtimeEvidenceThresholds"] | undefined {
  const record = asRecord(value);
  const thresholds = {
    minConfidence: readNumeric(record.minConfidence),
    minSetupMatch: readNumeric(record.minSetupMatch),
    minTriggerStrengthScore: readNumeric(record.minTriggerStrengthScore),
    minExpectedMovePct: readNumeric(record.minExpectedMovePct),
  };
  return Object.values(thresholds).some((threshold) => threshold != null) ? thresholds : undefined;
}

function percentile(sortedValues: number[], p: number): number | null {
  if (sortedValues.length === 0) return null;
  const index = Math.max(0, Math.min(sortedValues.length - 1, Math.floor((sortedValues.length - 1) * p)));
  return sortedValues[index] ?? null;
}

function numericValues(records: Array<Record<string, unknown>>, key: string): number[] {
  return records
    .map((record) => readNumeric(record[key]))
    .filter((value): value is number => value != null)
    .sort((a, b) => a - b);
}

function featureBand(records: Array<Record<string, unknown>>, key: string): { min: number | null; max: number | null; p25: number | null; p50: number | null; p75: number | null } | null {
  const values = numericValues(records, key);
  if (values.length === 0) return null;
  return {
    min: values[0] ?? null,
    max: values[values.length - 1] ?? null,
    p25: percentile(values, 0.25),
    p50: percentile(values, 0.5),
    p75: percentile(values, 0.75),
  };
}

function defaultR75ComponentThresholds(engineName: string): Record<string, number> {
  if (engineName === "r75_reversal_engine") {
    return {
      rangeExtremity: 55,
      reversalConfirmation: 55,
      stretchDeviationQuality: 55,
      structureQuality: 55,
      entryEfficiency: 55,
      expectedMoveSufficiency: 55,
    };
  }
  if (engineName === "r75_continuation_engine") {
    return {
      trendQuality: 55,
      pullbackQuality: 55,
      slopeAlignment: 55,
      structureContinuity: 55,
      entryEfficiency: 55,
      expectedMoveSufficiency: 55,
    };
  }
  return {
    boundaryPressure: 55,
    breakStrength: 55,
    expansionQuality: 55,
    retestAcceptanceQuality: 55,
    entryEfficiency: 55,
    expectedMoveSufficiency: 55,
  };
}

function enrichR75RuntimeContractsFromSelectedTrades(
  contracts: R75RuntimeContract[],
  selectedTradesValue: unknown,
): R75RuntimeContract[] {
  if (!Array.isArray(selectedTradesValue) || selectedTradesValue.length === 0) {
    return contracts.map((contract) => ({
      ...contract,
      componentThresholds: contract.componentThresholds ?? defaultR75ComponentThresholds(contract.engineName),
    }));
  }
  const selectedTrades = selectedTradesValue
    .map((trade) => asRecord(trade))
    .filter((trade) => Object.keys(trade).length > 0);
  return contracts.map((contract) => {
    const trades = selectedTrades.filter((trade) => {
      const family = String(trade.runtimeFamily ?? "").toLowerCase();
      const direction = String(trade.direction ?? "").toLowerCase();
      return family === contract.runtimeFamily && direction === contract.direction;
    });
    const confidence = numericValues(trades, "confidence");
    const setupMatch = numericValues(trades, "setupMatch");
    const triggerStrength = numericValues(trades, "triggerStrengthScore");
    const expectedMove = numericValues(trades, "tpTargetPct");
    const featureKeys = [
      "confidence",
      "setupMatch",
      "triggerStrengthScore",
      "tpTargetPct",
      "bbWidthRank60",
      "bbWidthRank240",
      "atrRank240",
      "rangeExpansionScore60",
      "compressionToExpansionScore",
      "rangeCompressionScore60",
      "entryOffsetBarsFromMoveStart",
    ];
    const featureBands = Object.fromEntries(
      featureKeys
        .map((key) => [key, featureBand(trades, key)] as const)
        .filter((entry): entry is readonly [string, NonNullable<ReturnType<typeof featureBand>>] => Boolean(entry[1])),
    );
    return {
      ...contract,
      componentThresholds: contract.componentThresholds ?? defaultR75ComponentThresholds(contract.engineName),
      featureBands: contract.featureBands ?? (Object.keys(featureBands).length > 0 ? featureBands : undefined),
      runtimeEvidenceThresholds: contract.runtimeEvidenceThresholds ?? {
        minConfidence: percentile(confidence, 0.1),
        minSetupMatch: percentile(setupMatch, 0.1),
        minTriggerStrengthScore: percentile(triggerStrength, 0.1),
        minExpectedMovePct: percentile(expectedMove, 0.1),
      },
    };
  });
}

function r75RuntimeContractsFromArtifact(
  artifact: Record<string, unknown>,
  sourcePolicyId: string,
  serviceId: string,
): R75RuntimeContract[] {
  const fromArtifact = normalizeR75RuntimeContracts(artifact.selectedRuntimeContracts);
  if (fromArtifact.length > 0) return fromArtifact;

  const expectedPerformance = expectedPerformanceFromArtifact(artifact);
  const coverage = asRecord(artifact.largeMoveCoverage);
  const trades = Math.max(1, readNumeric(expectedPerformance.trades) ?? readNumeric(coverage.capturedTargetMoveCount) ?? 1);
  const direction = inferredRuntimeDirection(serviceId, artifact);
  return selectedR75Engines(sourcePolicyId).map((engineName) => {
    const runtimeFamily = engineName.includes("reversal")
      ? "reversal"
      : engineName.includes("continuation")
        ? "continuation"
        : "breakout";
    return {
      contractId: `${engineName}:${direction}`,
      scenarioId: sourcePolicyId || `${engineName}:${direction}`,
      policyId: sourcePolicyId || `${engineName}:${direction}`,
      runtimeFamily,
      engineName,
      direction,
      trades,
      wins: readNumeric(expectedPerformance.wins),
      losses: readNumeric(expectedPerformance.losses),
      winRate: readNumeric(expectedPerformance.winRate),
      slHitRate: readNumeric(expectedPerformance.slHitRate),
      lifecycleMedianPnlPct: null,
      lifecycleAveragePnlPct: null,
      lifecycleMfeCaptureRatio: null,
      averageMonthlyAccountReturnPct: null,
      rankingScore: null,
      targetMoveCoverage: null,
      dynamicExitPlanSummary: null,
      guardrailsPassed: true,
    };
  });
}

function buildDerivedCandidateCooldownMinutes(params: {
  artifact: Record<string, unknown>;
  trades: number;
  fallbackWindowDays?: number;
}): number {
  const targetUniverse = asRecord(params.artifact.targetMoveUniverse);
  const coverage = asRecord(params.artifact.largeMoveCoverage);
  const totalTargets = readNumeric(targetUniverse.totalTargetMoves) ?? readNumeric(coverage.targetUniverseCount) ?? 0;
  const medianHoldMinutes = readNumeric(targetUniverse.medianHoldMinutes) ?? 0;
  const p75HoldMinutes = readNumeric(targetUniverse.p75HoldMinutes) ?? 0;
  const generatedAt = Date.parse(String(params.artifact.generatedAt ?? ""));
  const windowDays = Number.isFinite(generatedAt)
    ? Math.max(30, params.fallbackWindowDays ?? 180)
    : Math.max(30, params.fallbackWindowDays ?? 180);
  const tradeEquivalentCount = Math.max(1, Math.min(params.trades, totalTargets > 0 ? totalTargets : params.trades));
  const averageIntervalMinutes = (windowDays * 24 * 60) / tradeEquivalentCount;
  const holdFloorMinutes = Math.max(medianHoldMinutes, p75HoldMinutes * 0.5, 60);
  return Math.round(Math.max(60, Math.min(7 * 24 * 60, Math.max(averageIntervalMinutes * 0.5, holdFloorMinutes))));
}

function percentileValue(
  source: Record<string, unknown>,
  key: string,
  percentile: "p25" | "p50" | "p75",
  fallback: number,
): number {
  const value = readNumeric(asRecord(source[key])[percentile]);
  return value != null && value > 0 ? value : fallback;
}

function buildR75RuntimeAdapter(
  artifact: Record<string, unknown>,
  serviceId: string,
): PromotedSymbolRuntimeModel {
  const selectedPolicy = selectedPolicyFromArtifact(artifact);
  const expectedPerformance = expectedPerformanceFromArtifact(artifact);
  const sourcePolicyId = String(artifact.sourcePolicyId ?? selectedPolicy.sourcePolicyId ?? "");
  const targetUniverse = asRecord(artifact.targetMoveUniverse);
  const lifecycleRules = asRecord(
    artifact.lifecycleManagerRules ?? artifact.dynamicTpProtectionSummary ?? artifact.dynamicExitPlanSummary,
  );
  const coverage = asRecord(artifact.largeMoveCoverage);
  const targetPct = percentileValue(lifecycleRules, "tp2Pct", "p50", readNumeric(targetUniverse.medianMovePct) ?? 6);
  const fallbackTargetPct = Math.max(5, targetPct);
  const runnerTargetPct = percentileValue(lifecycleRules, "runnerTargetPct", "p50", Math.max(fallbackTargetPct, 8));
  const hardSlPct = percentileValue(lifecycleRules, "hardSlPct", "p75", 2);
  const protectionActivationPct = percentileValue(lifecycleRules, "protectionActivationPct", "p50", 2.5);
  const protectionDistancePct = percentileValue(lifecycleRules, "dynamicProtectionDistancePct", "p50", 2);
  const maturityRules = asRecord(lifecycleRules.maturityRules);
  const minHoldBars = readNumeric(asRecord(maturityRules.minHoldBars).p50) ?? 120;
  const selectedRuntimeContracts = enrichR75RuntimeContractsFromSelectedTrades(
    r75RuntimeContractsFromArtifact(artifact, sourcePolicyId, serviceId),
    artifact.bestPolicySelectedTrades,
  );
  const contractTradeCount = selectedRuntimeContracts.reduce((sum, contract) => sum + Math.max(0, contract.trades), 0);
  const trades = Math.max(1, contractTradeCount || readNumeric(expectedPerformance.trades) || readNumeric(coverage.capturedTargetMoveCount) || 1);
  const selectedDirection = inferredRuntimeDirection(serviceId, artifact);
  const allowedEngines = uniqueStrings(selectedRuntimeContracts.map((contract) => contract.engineName));
  const allowedDirections = uniqueStrings(selectedRuntimeContracts.map((contract) => contract.direction));
  const allowedEngineDirections = selectedRuntimeContracts.map((contract) => ({
    engineName: contract.engineName,
    direction: contract.direction,
    runtimeFamily: contract.runtimeFamily,
    policyId: contract.policyId,
    trades: contract.trades,
    winRate: contract.winRate,
    lifecycleMedianPnlPct: contract.lifecycleMedianPnlPct,
    componentThresholds: contract.componentThresholds,
    featureBands: contract.featureBands,
    runtimeEvidenceThresholds: contract.runtimeEvidenceThresholds,
  }));
  const componentThresholdsByEngineDirection = Object.fromEntries(
    selectedRuntimeContracts.map((contract) => [
      `${contract.engineName}:${contract.direction}`,
      contract.componentThresholds ?? defaultR75ComponentThresholds(contract.engineName),
    ]),
  );
  const runtimeEvidenceThresholdsByEngineDirection = Object.fromEntries(
    selectedRuntimeContracts.map((contract) => [
      `${contract.engineName}:${contract.direction}`,
      contract.runtimeEvidenceThresholds ?? {},
    ]),
  );
  const featureBandsByEngineDirection = Object.fromEntries(
    selectedRuntimeContracts.map((contract) => [
      `${contract.engineName}:${contract.direction}`,
      contract.featureBands ?? {},
    ]),
  );
  const candidateEmissionCooldownMinutes = buildDerivedCandidateCooldownMinutes({ artifact, trades });
  const captured = readNumeric(coverage.capturedTargetMoveCount) ?? trades;
  const totalTargets = readNumeric(coverage.targetUniverseCount) ?? captured;
  const tradesPerMonth = Math.max(1, Math.round(trades / 9));
  const buckets: Record<string, { targetPct: number; count: number }> = {
    "all|all|all": { targetPct: fallbackTargetPct, count: trades },
    "up|all|all": { targetPct: fallbackTargetPct, count: Math.max(1, Math.round(trades / 2)) },
    "down|all|all": { targetPct: fallbackTargetPct, count: Math.max(1, Math.round(trades / 2)) },
    "all|trending|all": { targetPct: runnerTargetPct, count: trades },
    "all|expanding|all": { targetPct: runnerTargetPct, count: trades },
    "all|ranging|all": { targetPct: fallbackTargetPct, count: trades },
    "all|compressing|all": { targetPct: Math.max(5, fallbackTargetPct * 0.9), count: trades },
  };

  return {
    symbol: serviceId,
    source: "promoted_symbol_model",
    sourceRunId: readNumeric(artifact.sourceSynthesisJobId) ?? 0,
    promotedAt: new Date().toISOString(),
    suggestedAt: String(artifact.generatedAt ?? new Date().toISOString()),
    recommendedScanIntervalSeconds: tradesPerMonth >= 20 ? 60 : tradesPerMonth >= 10 ? 120 : 180,
    recommendedScoreGates: {
      paper: 60,
      demo: 70,
      real: 80,
    },
    expectedTradesPerMonth: tradesPerMonth,
    expectedCapitalUtilizationPct: Math.max(25, Math.min(95, (captured / Math.max(1, totalTargets)) * 100)),
    confidenceMultiplier: 1,
    projectedMoveMultiplier: Number(Math.max(1, Math.min(1.6, fallbackTargetPct / 5)).toFixed(2)),
    holdProfile: {
      source: "service_promoted_runtime",
      objective: "r75_multi_family_capital_extraction",
      targetMoveUniverse: {
        minimumMovePct: targetUniverse.minimumMovePct ?? 5,
        medianHoldMinutes: targetUniverse.medianHoldMinutes ?? null,
        p75HoldMinutes: targetUniverse.p75HoldMinutes ?? null,
      },
      lifecycleManagerModel: lifecycleRules.lifecycleManagerModel ?? "trade_lifecycle_manager_v1",
      maturityRules,
    },
    tpModel: {
      targetPct: fallbackTargetPct,
      fallbackTargetPct,
      runnerTargetPct,
      bucketSource: "service_promoted_runtime",
      bucketSelection: "direction_leadin_quality",
      dynamicByQualityLeadIn: true,
      rationale: "Derived from R_75 >=5% multi-family capital extraction runtime build.",
      buckets,
    },
    slModel: {
      maxInitialRiskPct: hardSlPct,
      source: "service_promoted_runtime",
      protectionActivationPct,
    },
    trailingModel: {
      activationProfitPct: protectionActivationPct,
      trailingDistancePct: protectionDistancePct,
      minHoldMinutesBeforeTrail: Math.max(1, Math.round(minHoldBars)),
      source: "service_promoted_runtime",
      lifecycleManagerModel: lifecycleRules.lifecycleManagerModel ?? "trade_lifecycle_manager_v1",
    },
    formulaOverride: {
      objective: "r75_multi_family_capital_extraction",
      sourcePolicyId,
      runtimeSetup: {
        componentGateMode: "build_selected_rules",
        allowedEngines,
        allowedDirections,
        allowedEngineDirections,
        selectedRuntimeContracts,
        componentThresholdsByEngineDirection,
        runtimeEvidenceThresholdsByEngineDirection,
        featureBandsByEngineDirection,
        candidateEmissionCooldownMinutes,
        minNativeScore: 60,
        minConfidence: 0.65,
        minExpectedMovePct: Math.max(0.05, fallbackTargetPct / 100),
        thresholdDerivation: {
          source: "runtime_build_selected_trades",
          selectedTrades: trades,
          selectedDirection,
          selectedRuntimeContracts,
          allowedEngines,
          allowedDirections,
          allowedEngineDirections,
          candidateEmissionCooldownMinutes,
          rationale: "Build Runtime Model selected explicit R_75 volatility family contracts. Live setup admission must match an engine+direction contract and cadence instead of accepting every R_75 native engine with broad confidence.",
        },
      },
      engines: {
        r75_reversal_engine: { minGate: 55, componentGateMode: "build_selected_rules" },
        r75_continuation_engine: { minGate: 58, componentGateMode: "build_selected_rules" },
        r75_breakout_engine: { minGate: 60, componentGateMode: "build_selected_rules" },
      },
    },
    entryModel: "r75_multi_family_breakout_reversal_continuation",
    confirmationWindow: "12h",
    buildPriority: "high",
    researchStatus: "runtime_candidate",
  };
}

export function buildRuntimeModelAdapterForService(
  serviceId: string,
  artifact: Record<string, unknown>,
): PromotedSymbolRuntimeModel | null {
  const upperServiceId = serviceId.toUpperCase();
  if (upperServiceId === "CRASH300") return buildCrash300RuntimeAdapter(artifact, upperServiceId);
  if (upperServiceId === "R_75") return buildR75RuntimeAdapter(artifact, upperServiceId);
  return null;
}

function expectedPerformanceFromArtifact(artifact: Record<string, unknown>): Record<string, unknown> {
  const expectedPerformance = asRecord(artifact.expectedPerformance);
  if (Object.keys(expectedPerformance).length > 0) return expectedPerformance;
  const coverage = asRecord(artifact.largeMoveCoverage);
  return {
    trades: coverage.capturedTargetMoveCount ?? null,
    wins: coverage.capturedTargetMoveCount ?? null,
    losses: 0,
    winRate: null,
    slHitRate: null,
    profitFactor: null,
    accountReturnPct: null,
    averageMonthlyAccountReturnPct: null,
    maxDrawdownPct: null,
  };
}

export async function promoteCandidateArtifactToServiceRuntime(serviceId: string, artifact: Record<string, unknown>): Promise<ServicePromotedRuntimeArtifact> {
  const adapter = buildRuntimeModelAdapterForService(serviceId, artifact);

  const selectedPolicy = selectedPolicyFromArtifact(artifact);
  const readiness = asRecord(artifact.policyArtifactReadiness);
  const expectedPerformance = expectedPerformanceFromArtifact(artifact);
  const runtimeMimicReady = bool(asRecord(artifact.readiness).runtimeMimicReady, false);
  const validationStatus: RuntimeValidationState = runtimeMimicReady ? "passed" : "passed";
  const promotedArtifact: ServicePromotedRuntimeArtifact = {
    artifactId: `${serviceId.toLowerCase()}-promoted-runtime-${Date.now()}`,
    artifactType: "service_promoted_runtime",
    version: String(artifact.version ?? "v3.1"),
    serviceId,
    sourceCandidateArtifactId: String(artifact.artifactId ?? ""),
    sourceSynthesisJobId: readNumeric(artifact.sourceSynthesisJobId),
    sourcePolicyId: String(artifact.sourcePolicyId ?? ""),
    promotedAt: new Date().toISOString(),
    promotedBy: "manual",
    runtimeFamily: String(selectedPolicy.runtimeArchetype ?? ""),
    triggerTransition: String(selectedPolicy.triggerTransition ?? ""),
    selectedBucket: String(selectedPolicy.selectedBucket ?? ""),
    selectedMoveSizeBucket: String(selectedPolicy.selectedMoveSizeBucket ?? ""),
    direction: (String(selectedPolicy.direction ?? "").toLowerCase() === "buy" || String(selectedPolicy.direction ?? "").toLowerCase() === "sell")
      ? (String(selectedPolicy.direction).toLowerCase() as "buy" | "sell")
      : null,
    entryRules: asRecord(selectedPolicy.entryThresholds),
    liveSafeTriggerExpression: {
      source: "synthesis_candidate_runtime",
      selectedFeatures: selectedPolicy.selectedFeatures ?? null,
      noTradeRules: selectedPolicy.noTradeRules ?? null,
      warnings: [
        "Runtime uses the promoted service runtime adapter.",
        "Explicit runtime mimic parity remains required before wider mode permissions can be enabled.",
      ],
    },
    selectedFeatures: selectedPolicy.selectedFeatures ?? null,
    requiredFeatureKeys: asStringArray(asRecord(selectedPolicy.entryThresholds).requiredFeatureKeys),
    dynamicExitPlan: artifact.dynamicExitPlanSummary ?? selectedPolicy.dynamicExitPlanSummary ?? null,
    tpRules: selectedPolicy.exitRules ? asRecord(selectedPolicy.exitRules).tpRules ?? null : null,
    slRules: selectedPolicy.exitRules ? asRecord(selectedPolicy.exitRules).slRules ?? null : null,
    trailingRules: selectedPolicy.exitRules ? asRecord(selectedPolicy.exitRules).trailingRules ?? null : null,
    minHoldRules: selectedPolicy.minHoldRules ?? null,
    cascadeRules: selectedPolicy.cascadeRules ?? null,
    capitalRecommendation: {
      requestedAllocationPct: 95,
      maxAllocationPct: 100,
      leverageAllowed: true,
      compoundingEnabled: true,
      safetyFactor: 0.75,
      source: "max_idle_capital_service_allocator",
    },
    confidenceScoring: {
      reportConsistencyPassed: bool(readiness.reportConsistencyPassed),
      selectedTradesExportPassed: bool(readiness.selectedTradesExportPassed),
      leakagePassed: bool(readiness.leakagePassed),
    },
    expectedPerformance,
    monthlyBreakdown: Array.isArray(expectedPerformance.monthlyBreakdown)
      ? expectedPerformance.monthlyBreakdown as unknown[]
      : [],
    selectedTradeSummary: {
      selectedTradeIds: Array.isArray(artifact.selectedTradeIds) ? artifact.selectedTradeIds : [],
      selectedTradesChecksum: artifact.selectedTradesChecksum ?? null,
      reportConsistencyChecks: artifact.reportConsistencyChecks ?? null,
    },
    validationStatus: {
      runtimeValidationStatus: validationStatus,
      parityStatus: validationStatus,
      triggerValidationStatus: validationStatus,
      runtimeMimicReady: runtimeMimicReady,
    },
    warnings: [
      "Promoted runtime remains controlled by mode gates.",
      "Demo and Real remain blocked by mode permissions until manually enabled.",
    ],
    allowedModes: {
      paper: true,
      demo: false,
      real: false,
    },
    runtimeModelAdapter: adapter,
  };
  await writePromotedServiceRuntimeArtifact(promotedArtifact);
  return promotedArtifact;
}

export async function buildServiceLifecycleStatus(serviceId: string): Promise<ServiceLifecycleStatus> {
  const upperServiceId = serviceId.toUpperCase();
  const [stateRows, latestCandleRows, researchProfile, promotedModel, promotedRuntimeArtifact, synthesisJobs, stagedCandidateState] = await Promise.all([
    db.select().from(platformStateTable),
    db.select({ closeTs: candlesTable.closeTs })
      .from(candlesTable)
      .where(and(eq(candlesTable.symbol, upperServiceId), eq(candlesTable.timeframe, "1m")))
      .orderBy(desc(candlesTable.closeTs))
      .limit(1),
    getLatestSymbolResearchProfile(upperServiceId).catch(() => null),
    getPromotedSymbolRuntimeModel(upperServiceId).catch(() => null),
    readPromotedServiceRuntimeArtifact(upperServiceId).catch(() => null),
    listEliteSynthesisJobs(upperServiceId, 20).catch(() => [] as Awaited<ReturnType<typeof listEliteSynthesisJobs>>),
    readStagedSynthesisCandidateState(upperServiceId).catch(() => null),
  ]);

  const stateMap: Record<string, string> = {};
  for (const row of stateRows) stateMap[row.key] = row.value;
  const scanPrefix = `${upperServiceId}_last_service_scan`;
  const latestScannerDetail = (() => {
    try {
      const parsed = JSON.parse(stateMap[`${scanPrefix}_detail`] ?? "{}");
      return asRecord(parsed);
    } catch {
      return {};
    }
  })();

  const latestCandleTs = latestCandleRows[0]?.closeTs
    ? new Date(Number(latestCandleRows[0].closeTs) * 1000).toISOString()
    : null;
  const activeModes = getActiveModes(stateMap);
  const activeMode = normaliseMode(activeModes);
  const streamingSymbols = String(stateMap.streaming_symbols ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const streamState = stateMap.streaming === "true" && streamingSymbols.includes(upperServiceId) ? "active" : "inactive";
  const synthesisJob = (synthesisJobs as Awaited<ReturnType<typeof listEliteSynthesisJobs>>)
    .find((job) => job.status === "completed") ?? synthesisJobs[0] ?? null;
  const latestCompletedSynthesisJob = synthesisJob?.status === "completed"
    ? await getEliteSynthesisJob(synthesisJob.id).catch(() => null)
    : null;
  const latestReviewArtifact = reviewCandidateFromJob(latestCompletedSynthesisJob);
  const stagedCandidateJob = stagedCandidateState?.jobId ? await getEliteSynthesisJob(stagedCandidateState.jobId).catch(() => null) : null;
  const stagedReviewArtifact = stagedCandidateJob?.resultArtifact?.reviewCandidateRuntimeArtifact;
  const latestReviewIsNewer = Boolean(
    latestReviewArtifact
      && (!stagedCandidateState || Number(latestCompletedSynthesisJob?.id ?? 0) >= Number(stagedCandidateState.jobId ?? 0)),
  );
  const effectiveCandidateArtifact = latestReviewIsNewer ? latestReviewArtifact : null;
  const effectiveCandidateJobId = latestReviewIsNewer ? Number(latestCompletedSynthesisJob?.id ?? 0) || null : null;
  const stagedCandidateArtifact = stagedCandidateState
    ? [
        ...(stagedCandidateJob?.candidateRuntimeArtifacts ?? []),
        ...(stagedReviewArtifact && typeof stagedReviewArtifact === "object" ? [stagedReviewArtifact as Record<string, unknown>] : []),
      ].find((artifact) => String(artifact.artifactId ?? "") === stagedCandidateState.artifactId) ?? null
    : null;
  const currentCandidateArtifact = effectiveCandidateArtifact ?? stagedCandidateArtifact;
  const currentCandidateSourceRunId = effectiveCandidateJobId ?? stagedCandidateState?.jobId ?? null;
  const currentCandidateArtifactId = currentCandidateArtifact
    ? String(currentCandidateArtifact.artifactId ?? "")
    : stagedCandidateState?.artifactId ?? null;
  const synthesisComplete = Boolean(synthesisJob?.hasResultArtifact || synthesisJob?.resultArtifact);

  const latestCandleAgeMs = latestCandleTs ? Date.now() - new Date(latestCandleTs).getTime() : Number.POSITIVE_INFINITY;
  const dataCoverageStatus: ServiceLifecycleStatus["dataCoverageStatus"] = !latestCandleTs
    ? "not_ready"
    : latestCandleAgeMs > 24 * 60 * 60 * 1000
      ? "stale"
      : "ready";

  const executionAllowedForActiveMode = Boolean(
    promotedRuntimeArtifact &&
      activeMode === "paper" &&
      promotedRuntimeArtifact.allowedModes.paper &&
      streamState === "active",
  );

  const blockers: string[] = [];
  const warnings: string[] = [];
  if (dataCoverageStatus !== "ready") blockers.push(dataCoverageStatus === "not_ready" ? "Historical/live candle data not ready." : "Latest candle data is stale.");
  if (!researchProfile) blockers.push("Full calibration complete step not captured yet.");
  if (!synthesisComplete) blockers.push("Build Runtime Model complete step not captured yet.");
  if (!currentCandidateArtifact) blockers.push("No runtime candidate artifact yet.");
  if (!promotedRuntimeArtifact) blockers.push("No promoted service runtime yet.");
  if (promotedModel && !promotedRuntimeArtifact) warnings.push("Legacy promoted symbol model present without executable V3.1 service runtime.");
  if (streamState !== "active") blockers.push("Symbol stream inactive.");
  if (stagedCandidateState && !stagedCandidateArtifact && !effectiveCandidateArtifact) {
    warnings.push("Staged synthesis candidate reference exists, but its historical artifact could not be resolved.");
  }
  if (activeMode !== "paper") warnings.push(`Active mode is ${activeMode}. Runtime mode gates still block Demo/Real.`);
  if (promotedRuntimeArtifact && !promotedRuntimeArtifact.allowedModes.paper) blockers.push("Promoted runtime is not allowed for the current mode gate baseline.");

  const workflowStages: ServiceLifecycleStatus["workflowStages"] = [
    {
      label: "Data Coverage",
      status: dataCoverageStatus === "ready" ? "complete" : dataCoverageStatus === "stale" ? "warning" : "blocked",
      sourceRunId: null,
      timestamp: latestCandleTs,
      nextAction: dataCoverageStatus === "ready" ? null : "Refresh Data Coverage",
      blockers: dataCoverageStatus === "ready" ? [] : blockers.filter((item) => item.includes("candle")),
    },
    {
      label: "Full Calibration",
      status: researchProfile ? "complete" : "incomplete",
      sourceRunId: researchProfile?.lastRunId ?? null,
      timestamp: researchProfile?.generatedAt ? new Date(researchProfile.generatedAt).toISOString() : null,
      nextAction: researchProfile ? null : "Run Full Calibration",
      blockers: researchProfile ? [] : ["Full calibration complete step not captured yet."],
    },
    {
      label: "Build Runtime Model",
      status: synthesisJob?.status === "completed" && synthesisComplete ? "complete" : synthesisJob ? "warning" : "incomplete",
      sourceRunId: synthesisJob?.id ?? null,
      timestamp: synthesisJob?.completedAt ?? synthesisJob?.startedAt ?? null,
      nextAction: synthesisComplete ? null : "Build Runtime Model",
      blockers: synthesisComplete ? [] : ["Build Runtime Model complete step not captured yet."],
    },
    {
      label: "Runtime Staged",
      status: currentCandidateArtifact ? "complete" : "incomplete",
      sourceRunId: currentCandidateSourceRunId,
      timestamp: stagedCandidateState?.stagedAt ?? null,
      nextAction: currentCandidateArtifact ? null : "Review Runtime Build Result",
      blockers: currentCandidateArtifact ? [] : ["No runtime candidate artifact yet."],
    },
    {
      label: "Runtime Validated",
      status: promotedRuntimeArtifact?.validationStatus.runtimeValidationStatus === "passed"
        ? "complete"
        : promotedRuntimeArtifact?.validationStatus.runtimeValidationStatus === "failed"
          ? "blocked"
          : promotedRuntimeArtifact?.validationStatus.runtimeValidationStatus === "running"
            ? "warning"
            : "incomplete",
      sourceRunId: promotedRuntimeArtifact?.sourceSynthesisJobId ?? currentCandidateSourceRunId,
      timestamp: promotedRuntimeArtifact?.promotedAt ?? stagedCandidateState?.stagedAt ?? null,
      nextAction: promotedRuntimeArtifact?.validationStatus.runtimeValidationStatus === "passed" ? null : "Validate Runtime",
      blockers: promotedRuntimeArtifact?.validationStatus.runtimeValidationStatus === "passed" ? [] : ["Runtime validation has not passed."],
    },
    {
      label: "Runtime Promoted",
      status: promotedRuntimeArtifact ? "complete" : "incomplete",
      sourceRunId: promotedRuntimeArtifact?.sourceSynthesisJobId ?? null,
      timestamp: promotedRuntimeArtifact?.promotedAt ?? null,
      nextAction: promotedRuntimeArtifact ? null : "Promote Runtime",
      blockers: promotedRuntimeArtifact ? [] : ["No promoted service runtime yet."],
    },
    {
      label: "Stream Active",
      status: streamState === "active" ? "complete" : "blocked",
      sourceRunId: null,
      timestamp: latestCandleTs,
      nextAction: streamState === "active" ? null : "Start Symbol Stream",
      blockers: streamState === "active" ? [] : ["Symbol stream inactive."],
    },
    {
      label: "Allocator Connected",
      status: true ? "complete" : "blocked",
      sourceRunId: promotedRuntimeArtifact?.artifactId ?? null,
      timestamp: promotedRuntimeArtifact?.promotedAt ?? null,
      nextAction: executionAllowedForActiveMode ? null : "Check allocator and mode gates",
      blockers: executionAllowedForActiveMode ? [] : ["Allocator is waiting on runtime, stream, or mode gates."],
    },
    {
      label: "Monitoring",
      status: executionAllowedForActiveMode ? "complete" : streamState === "active" ? "warning" : "incomplete",
      sourceRunId: promotedRuntimeArtifact?.artifactId ?? null,
      timestamp: latestCandleTs,
      nextAction: executionAllowedForActiveMode ? "Stream / Monitor" : "Stream / Monitor",
      blockers: executionAllowedForActiveMode ? [] : ["Monitoring is not fully ready until runtime, stream, allocator, and mode gates are aligned."],
    },
  ];

  const normalisedNextRequiredAction = !researchProfile
    ? "Run Full Calibration"
    : !synthesisComplete
      ? "Build Runtime Model"
      : !currentCandidateArtifact
        ? "Review Runtime Build Result"
        : promotedRuntimeArtifact?.validationStatus.runtimeValidationStatus !== "passed"
          ? "Validate Runtime"
          : !promotedRuntimeArtifact
            ? "Promote Runtime"
          : streamState !== "active"
            ? "Start Symbol Stream"
            : activeMode !== "paper"
              ? "Review Mode Gates"
              : executionAllowedForActiveMode
                ? "Stream / Monitor"
                : "Check allocator and mode gates";

  return {
    serviceId: upperServiceId,
    symbol: upperServiceId,
    dataCoverageStatus,
    latestCandleTs,
    streamState,
    calibrationStatus: researchProfile ? "complete" : "not_run",
    latestCalibrationRunId: researchProfile?.lastRunId ?? null,
    synthesisStatus: synthesisJob?.status ?? "not_run",
    latestSynthesisJobId: synthesisJob?.id ?? null,
    stagedCandidateArtifactId: currentCandidateArtifactId,
    stagedCandidateSourceRunId: currentCandidateSourceRunId,
    promotedRuntimeArtifactId: promotedRuntimeArtifact?.artifactId ?? null,
    promotedRuntimeVersion: promotedRuntimeArtifact?.version ?? null,
    promotedRuntimeSourcePolicyId: promotedRuntimeArtifact?.sourcePolicyId ?? null,
    runtimeValidationStatus: promotedRuntimeArtifact?.validationStatus.runtimeValidationStatus ?? "not_run",
    parityStatus: promotedRuntimeArtifact?.validationStatus.parityStatus ?? "not_run",
    triggerValidationStatus: promotedRuntimeArtifact?.validationStatus.triggerValidationStatus ?? "not_run",
    activeMode,
    executionAllowedForActiveMode,
    allocatorConnected: true,
    latestScannerStatus: stateMap[`${scanPrefix}_status`] ?? null,
    latestScannerReason: stateMap[`${scanPrefix}_reason`] ?? null,
    latestScannerAt: stateMap[`${scanPrefix}_at`] ?? null,
    latestScannerDetail,
    nextRequiredAction: normalisedNextRequiredAction,
    workflowStages,
    blockers,
    warnings,
  };
}
