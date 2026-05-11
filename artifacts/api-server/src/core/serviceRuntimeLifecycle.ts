import { db, candlesTable, platformStateTable } from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { getActiveModes } from "../infrastructure/deriv.js";
import { getLatestSymbolResearchProfile } from "./calibration/symbolResearchProfile.js";
import {
  getPromotedSymbolRuntimeModel,
  type PromotedSymbolRuntimeModel,
} from "./calibration/promotedSymbolModel.js";
import { listEliteSynthesisJobs } from "./synthesis/jobs.js";

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
  promotedRuntimeArtifactId: string | null;
  promotedRuntimeVersion: string | null;
  promotedRuntimeSourcePolicyId: string | null;
  runtimeValidationStatus: RuntimeValidationState;
  parityStatus: RuntimeValidationState;
  triggerValidationStatus: RuntimeValidationState;
  activeMode: "paper" | "demo" | "real" | "idle" | "multi";
  executionAllowedForActiveMode: boolean;
  allocatorConnected: boolean;
  nextRequiredAction: string;
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
  const selectedPolicy = asRecord(artifact.selectedPolicy);
  const expectedPerformance = asRecord(artifact.expectedPerformance);
  const exitAudit = asRecord(artifact.exitDerivationAudit);
  const direction = String(selectedPolicy.direction ?? "sell").toLowerCase() === "buy" ? "buy" : "sell";
  const directionKey = direction === "buy" ? "up" : "down";
  const sourceRunId = readNumeric(artifact.sourceSynthesisJobId) ?? 0;
  const tradeCount = Math.max(1, readNumeric(expectedPerformance.trades) ?? 1);
  const tradesPerMonth = Math.max(1, Math.round(tradeCount / 3));
  const tpTargetPct = Math.max(0.1, readNumeric(exitAudit.derivedTpPct) ?? 5);
  const slRiskPct = Math.max(0.1, readNumeric(exitAudit.derivedSlPct) ?? 1);
  const trailingActivationPct = Math.max(0.1, readNumeric(exitAudit.derivedTrailingActivationPct) ?? 2);
  const trailingDistancePct = Math.max(0.1, readNumeric(exitAudit.derivedTrailingDistancePct) ?? 1);
  const confidenceMultiplier = Math.max(0.85, Math.min(1.15, (readNumeric(expectedPerformance.winRate) ?? 0.8)));
  const formulaOverride = {
    crash300: {
      contextMatchThreshold: Math.max(0.55, Math.min(0.95, Number(confidenceMultiplier.toFixed(2)))),
      triggerStrengthThreshold: Math.max(0.55, Math.min(0.95, Number((confidenceMultiplier - 0.03).toFixed(2)))),
      liveSafeTriggerExpressionRequired: true,
      sourcePolicyId: String(artifact.sourcePolicyId ?? ""),
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

export async function promoteCandidateArtifactToServiceRuntime(serviceId: string, artifact: Record<string, unknown>): Promise<ServicePromotedRuntimeArtifact> {
  const adapter = serviceId === "CRASH300" ? buildCrash300RuntimeAdapter(artifact, serviceId) : null;

  const selectedPolicy = asRecord(artifact.selectedPolicy);
  const readiness = asRecord(artifact.policyArtifactReadiness);
  const expectedPerformance = asRecord(artifact.expectedPerformance);
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
        "Runtime uses promoted service runtime adapter in Paper mode.",
        "Explicit runtime mimic parity still pending before Demo or Real can be enabled.",
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
      requestedAllocationPct: 15,
      maxAllocationPct: 25,
      leverageAllowed: false,
      source: "paper_runtime_baseline",
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
      runtimeValidationStatus: "not_run",
      parityStatus: "not_run",
      triggerValidationStatus: "not_run",
      runtimeMimicReady: false,
    },
    warnings: [
      "Promoted runtime is approved for Paper observation only.",
      "Demo and Real remain blocked until runtime validation, parity, and trigger validation are explicitly passed.",
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
  const stagedCandidateArtifact = stagedCandidateState
    ? synthesisJobs
        .flatMap((job) => job.candidateRuntimeArtifacts)
        .find((artifact) => String(artifact.artifactId ?? "") === stagedCandidateState.artifactId)
      ?? null
    : null;

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
  if (!synthesisJob?.resultArtifact) blockers.push("Elite synthesis complete step not captured yet.");
  if (!stagedCandidateArtifact) blockers.push("No staged candidate artifact yet.");
  if (!promotedRuntimeArtifact) blockers.push("No promoted service runtime yet.");
  if (promotedModel && !promotedRuntimeArtifact) warnings.push("Legacy promoted symbol model present without executable V3.1 service runtime.");
  if (streamState !== "active") blockers.push("Symbol stream inactive.");
  if (stagedCandidateState && !stagedCandidateArtifact) {
    warnings.push("Staged synthesis candidate reference exists, but its historical artifact could not be resolved.");
  }
  if (activeMode !== "paper") warnings.push(`Active mode is ${activeMode}. Paper runtime is ready first; Demo/Real remain blocked.`);
  if (promotedRuntimeArtifact && !promotedRuntimeArtifact.allowedModes.paper) blockers.push("Promoted runtime is not allowed for Paper mode.");
  if (promotedRuntimeArtifact?.allowedModes.demo === false) warnings.push("Demo mode remains blocked pending runtime validation.");
  if (promotedRuntimeArtifact?.allowedModes.real === false) warnings.push("Real mode remains blocked pending stricter validation and manual unlock.");

  const nextRequiredAction = !researchProfile
    ? "Run Full Calibration"
    : !synthesisJob?.resultArtifact
      ? "Run Integrated Elite Synthesis"
      : !stagedCandidateArtifact
        ? "Stage Current Best Candidate"
        : !promotedRuntimeArtifact
          ? "Promote Candidate To Runtime"
          : streamState !== "active"
            ? "Start Symbol Stream"
            : activeMode !== "paper"
              ? "Activate Paper Mode"
              : executionAllowedForActiveMode
                ? "Paper Monitoring"
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
    stagedCandidateArtifactId: stagedCandidateState?.artifactId ?? null,
    promotedRuntimeArtifactId: promotedRuntimeArtifact?.artifactId ?? null,
    promotedRuntimeVersion: promotedRuntimeArtifact?.version ?? null,
    promotedRuntimeSourcePolicyId: promotedRuntimeArtifact?.sourcePolicyId ?? null,
    runtimeValidationStatus: promotedRuntimeArtifact?.validationStatus.runtimeValidationStatus ?? "not_run",
    parityStatus: promotedRuntimeArtifact?.validationStatus.parityStatus ?? "not_run",
    triggerValidationStatus: promotedRuntimeArtifact?.validationStatus.triggerValidationStatus ?? "not_run",
    activeMode,
    executionAllowedForActiveMode,
    allocatorConnected: true,
    nextRequiredAction,
    blockers,
    warnings,
  };
}
