import { candlesTable, db, platformStateTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { computeFeaturesFromSlice, type CandleRow } from "./backtest/featureSlice.js";
import { classifyRegimeFromHTF } from "./regimeEngine.js";
import { runEnginesAndCoordinate } from "./signalPipeline.js";
import { buildSymbolTradeCandidate } from "./symbolModels/candidateBuilder.js";
import {
  buildRuntimeModelAdapterForService,
  readPromotedServiceRuntimeArtifact,
  type ServicePromotedRuntimeArtifact,
} from "./serviceRuntimeLifecycle.js";
import { evaluateCrash300Runtime, coordinatorFromCrash300Decision } from "../symbol-services/CRASH300/engine.js";

export type RuntimeReplayValidationResult = {
  status: "passed" | "blocked" | "not_run";
  serviceId: string;
  artifactId: string | null;
  replayWindow: {
    requestedPoints: number;
    evaluatedPoints: number;
    lookbackBars: number;
  };
  counts: Record<string, number>;
  topFailReasons: Array<{ reason: string; count: number }>;
  topRuntimeSetupBlockers: Array<{ reason: string; count: number }>;
  topValidEngines: Array<{ engine: string; count: number }>;
  emittedExamples: Array<Record<string, unknown>>;
  duplicateExamples: Array<Record<string, unknown>>;
  blockedExamples: Array<Record<string, unknown>>;
  minimumRequiredEmissions: number;
  notes: string[];
};

function increment(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function topEntries(map: Record<string, number>, label: "reason" | "engine", limit = 12) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({ [label]: key, count })) as Array<{ reason: string; count: number }> & Array<{ engine: string; count: number }>;
}

function candidateCooldownBars(adapter: Record<string, unknown>): number {
  const trailingModel = asRuntimeRecord(adapter["trailingModel"]);
  const holdProfile = asRuntimeRecord(adapter["holdProfile"]);
  const maturityRules = asRuntimeRecord(holdProfile["maturityRules"]);
  const minHoldBars = Number(asRuntimeRecord(maturityRules["minHoldBars"])["p50"]);
  if (Number.isFinite(minHoldBars) && minHoldBars > 0) return Math.max(60, Math.round(minHoldBars));
  const minHoldMinutes = Number(trailingModel["minHoldMinutesBeforeTrail"]);
  if (Number.isFinite(minHoldMinutes) && minHoldMinutes > 0) return Math.max(60, Math.round(minHoldMinutes));
  return 60;
}

function asRuntimeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function loadStateMap(): Promise<Record<string, string>> {
  const rows = await db.select().from(platformStateTable);
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

async function loadCandles(symbol: string, requestedPoints: number, lookbackBars: number): Promise<CandleRow[]> {
  const rows = await db.select({
    open: candlesTable.open,
    high: candlesTable.high,
    low: candlesTable.low,
    close: candlesTable.close,
    openTs: candlesTable.openTs,
    closeTs: candlesTable.closeTs,
  })
    .from(candlesTable)
    .where(and(
      eq(candlesTable.symbol, symbol),
      eq(candlesTable.timeframe, "1m"),
      eq(candlesTable.isInterpolated, false),
    ))
    .orderBy(desc(candlesTable.openTs))
    .limit(requestedPoints + lookbackBars + 5);
  return (rows as CandleRow[]).reverse();
}

export async function validateRuntimeReplay(params: {
  serviceId: string;
  candidateArtifact?: Record<string, unknown> | null;
  promotedRuntime?: ServicePromotedRuntimeArtifact | null;
  requestedPoints?: number;
  lookbackBars?: number;
  minimumRequiredEmissions?: number;
}): Promise<RuntimeReplayValidationResult> {
  const serviceId = params.serviceId.toUpperCase();
  const requestedPoints = Math.max(250, Math.min(20_000, Math.round(params.requestedPoints ?? 5_000)));
  const lookbackBars = Math.max(200, Math.min(2_000, Math.round(params.lookbackBars ?? 1_600)));
  const minimumRequiredEmissions = Math.max(1, Math.round(params.minimumRequiredEmissions ?? 1));
  const stateMap = await loadStateMap();
  const promoted = params.promotedRuntime ?? await readPromotedServiceRuntimeArtifact(serviceId).catch(() => null);
  const runtimeArtifact = params.candidateArtifact
    ? {
        artifactId: String(params.candidateArtifact.artifactId ?? "review_candidate"),
        runtimeModelAdapter: buildRuntimeModelAdapterForService(serviceId, params.candidateArtifact),
      }
    : promoted
      ? {
          artifactId: promoted.artifactId,
          runtimeModelAdapter: promoted.runtimeModelAdapter,
        }
      : (() => null)();
  const resolvedRuntime = runtimeArtifact?.runtimeModelAdapter
    ? runtimeArtifact
    : (() => null)();
  const adapter = resolvedRuntime?.runtimeModelAdapter ?? null;
  const artifactId = resolvedRuntime?.artifactId ?? null;
  if (!adapter) {
    return {
      status: "not_run",
      serviceId,
      artifactId,
      replayWindow: { requestedPoints, evaluatedPoints: 0, lookbackBars },
      counts: { missing_runtime_adapter: 1 },
      topFailReasons: [],
      topRuntimeSetupBlockers: [],
      topValidEngines: [],
      emittedExamples: [],
      duplicateExamples: [],
      blockedExamples: [],
      minimumRequiredEmissions,
      notes: ["Runtime replay could not run because no runtime adapter was available."],
    };
  }

  const candles = await loadCandles(serviceId, requestedPoints, lookbackBars);
  const start = Math.max(lookbackBars, candles.length - requestedPoints);
  const counts: Record<string, number> = { evaluated: 0 };
  const failReasons: Record<string, number> = {};
  const setupBlockers: Record<string, number> = {};
  const validEngines: Record<string, number> = {};
  const emittedExamples: Array<Record<string, unknown>> = [];
  const duplicateExamples: Array<Record<string, unknown>> = [];
  const blockedExamples: Array<Record<string, unknown>> = [];
  const cooldownBars = candidateCooldownBars(adapter as unknown as Record<string, unknown>);
  const lastAcceptedBySetup = new Map<string, number>();

  for (let i = start; i < candles.length; i += 1) {
    const slice = candles.slice(Math.max(0, i - lookbackBars + 1), i + 1);
    const features = computeFeaturesFromSlice(serviceId, slice);
    if (!features) {
      increment(counts, "insufficient_features");
      continue;
    }
    counts.evaluated += 1;
    const regime = classifyRegimeFromHTF(features);
    let engineResults: Array<Record<string, unknown>> = [];
    let coordinatorOutput: ReturnType<typeof runEnginesAndCoordinate>["coordinatorOutput"] = null;
    let crashDecision: Awaited<ReturnType<typeof evaluateCrash300Runtime>> | null = null;
    if (serviceId === "CRASH300") {
      crashDecision = await evaluateCrash300Runtime({
        symbol: serviceId,
        mode: "paper",
        ts: Number(candles[i]?.closeTs ?? candles[i]?.openTs ?? 0),
        marketState: {
          features,
          candles: slice,
          featureHistory: [],
          operationalRegime: regime.regime,
          regimeConfidence: regime.confidence,
        },
        runtimeModel: adapter as unknown as Record<string, unknown>,
        stateMap,
      });
      const evidence = crashDecision.evidence && typeof crashDecision.evidence === "object"
        ? crashDecision.evidence as Record<string, unknown>
        : {};
      const serviceResult = coordinatorFromCrash300Decision(
        crashDecision,
        adapter,
        Number(evidence.expectedMovePct ?? 0),
        evidence.componentScores && typeof evidence.componentScores === "object"
          ? evidence.componentScores as Record<string, number>
          : {},
      );
      engineResults = serviceResult.engineResults as unknown as Array<Record<string, unknown>>;
      coordinatorOutput = serviceResult.coordinatorOutput;
      for (const reason of crashDecision.failReasons ?? []) increment(failReasons, String(reason));
    } else {
      const pipeline = runEnginesAndCoordinate({
        symbol: serviceId,
        features,
        operationalRegime: regime.regime,
        regimeConfidence: regime.confidence,
        runtimeCalibration: adapter,
      });
      engineResults = pipeline.engineResults as unknown as Array<Record<string, unknown>>;
      coordinatorOutput = pipeline.coordinatorOutput;
    }

    for (const result of engineResults) {
      if (result.valid) increment(validEngines, String(result.engineName ?? "unknown"));
    }
    if (!coordinatorOutput) {
      increment(counts, "no_coordinator_output");
      continue;
    }
    increment(counts, "coordinator_output");
    const winner = coordinatorOutput.winner;
    const built = buildSymbolTradeCandidate({
      symbol: serviceId,
      mode: "paper",
      coordinatorOutput,
      winner,
      features,
      spotPrice: features.latestClose,
      runtimeCalibration: adapter,
    });
    if (!built) {
      increment(counts, "candidate_builder_null");
      continue;
    }
    const setup = built.candidate.runtimeSetup;
    if (!setup.allowed) {
      increment(counts, "runtime_setup_blocked");
      increment(setupBlockers, setup.reason);
      if (blockedExamples.length < 8) {
        blockedExamples.push({
          ts: new Date(Number(candles[i]?.closeTs ?? 0) * 1000).toISOString(),
          engine: winner.engineName,
          direction: winner.direction,
          confidence: Number(winner.confidence.toFixed(3)),
          reason: setup.reason,
          weakComponents: setup.weakComponents,
        });
      }
      continue;
    }
    increment(counts, "raw_candidate_bars");
    const setupKey = `${serviceId}|${winner.engineName}|${winner.direction}|${built.setupSignature}`;
    const lastAcceptedIndex = lastAcceptedBySetup.get(setupKey);
    if (lastAcceptedIndex != null && (i - lastAcceptedIndex) < cooldownBars) {
      increment(counts, "duplicate_candidate_bar");
      if (duplicateExamples.length < 8) {
        duplicateExamples.push({
          ts: new Date(Number(candles[i]?.closeTs ?? 0) * 1000).toISOString(),
          engine: winner.engineName,
          direction: winner.direction,
          setupSignature: built.setupSignature,
          barsSinceAccepted: i - lastAcceptedIndex,
          cooldownBars,
        });
      }
      continue;
    }
    lastAcceptedBySetup.set(setupKey, i);
    increment(counts, "candidate_would_emit");
    increment(validEngines, `emit:${winner.engineName}`);
    if (emittedExamples.length < 8) {
      emittedExamples.push({
        ts: new Date(Number(candles[i]?.closeTs ?? 0) * 1000).toISOString(),
        engine: winner.engineName,
        direction: winner.direction,
        confidence: Number(winner.confidence.toFixed(3)),
        expectedMovePct: Number(winner.projectedMovePct.toFixed(4)),
        setupReason: setup.reason,
        setupSignature: built.setupSignature,
        cooldownBars,
      });
    }
  }

  const emitted = counts.candidate_would_emit ?? 0;
  return {
    status: emitted >= minimumRequiredEmissions ? "passed" : "blocked",
    serviceId,
    artifactId,
    replayWindow: {
      requestedPoints,
      evaluatedPoints: counts.evaluated,
      lookbackBars,
    },
    counts,
    topFailReasons: topEntries(failReasons, "reason"),
    topRuntimeSetupBlockers: topEntries(setupBlockers, "reason"),
    topValidEngines: topEntries(validEngines, "engine"),
    emittedExamples,
    duplicateExamples,
    blockedExamples,
    minimumRequiredEmissions,
    notes: [
      "Replay is read-only and does not stage, promote, allocate, or open trades.",
      "Raw candidate bars are de-duplicated by setup and runtime hold/cascade window before they count as trade-equivalent candidate emissions.",
      "Validate Runtime requires at least one recent historical trade-equivalent runtime candidate emission to prove the live scanner can use the promoted rules.",
    ],
  };
}
