import { and, desc, eq } from "drizzle-orm";
import { candlesTable, db, platformStateTable } from "@workspace/db";
import { getActiveModes } from "../infrastructure/deriv.js";
import { getPromotedSymbolRuntimeModel } from "./calibration/promotedSymbolModel.js";
import { readPromotedServiceRuntimeArtifact, type ServicePromotedRuntimeArtifact } from "./serviceRuntimeLifecycle.js";

export interface ServiceExecutionGate {
  serviceId: string;
  symbol: string;
  activeMode: "paper" | "demo" | "real" | "idle" | "multi";
  streamState: "active" | "inactive";
  latestCandleTs: string | null;
  latestCandleAge: number | null;
  promotedRuntimePresent: boolean;
  promotedRuntimeArtifactId: string | null;
  promotedRuntimeVersion: string | null;
  allowedForActiveMode: boolean;
  candidateEmissionAllowed: boolean;
  executionAllowedBeforeAllocator: boolean;
  blockedReason: string | null;
  warnings: string[];
  legacySymbolModelPresent: boolean;
  serviceRuntimePresent: boolean;
}

function normaliseMode(activeModes: string[]): ServiceExecutionGate["activeMode"] {
  if (activeModes.length === 0) return "idle";
  if (activeModes.length > 1) return "multi";
  const first = activeModes[0];
  return first === "paper" || first === "demo" || first === "real" ? first : "idle";
}

export async function resolvePromotedServiceRuntimeAdapter(
  serviceId: string,
  activeMode: "paper" | "demo" | "real" | "idle" | "multi",
): Promise<{ artifact: ServicePromotedRuntimeArtifact | null; blockedReason: string | null }> {
  const artifact = await readPromotedServiceRuntimeArtifact(serviceId);
  if (!artifact) {
    return { artifact: null, blockedReason: "no_promoted_service_runtime" };
  }
  if (activeMode === "idle" || activeMode === "multi") {
    return { artifact, blockedReason: "active_mode_not_executable" };
  }
  if (!artifact.allowedModes[activeMode]) {
    return { artifact, blockedReason: `promoted_runtime_not_allowed_for_mode:${activeMode}` };
  }
  if (!artifact.runtimeModelAdapter) {
    return { artifact, blockedReason: "promoted_service_runtime_missing_runtime_adapter" };
  }
  return { artifact, blockedReason: null };
}

export async function resolveServiceExecutionGate(
  serviceId: string,
  symbol: string,
  explicitMode?: "paper" | "demo" | "real" | "idle" | "multi",
): Promise<ServiceExecutionGate> {
  const upperServiceId = serviceId.toUpperCase();
  const upperSymbol = symbol.toUpperCase();
  const [stateRows, latestCandleRows, promotedServiceRuntime, legacySymbolModel] = await Promise.all([
    db.select().from(platformStateTable),
    db.select({ closeTs: candlesTable.closeTs })
      .from(candlesTable)
      .where(and(eq(candlesTable.symbol, upperSymbol), eq(candlesTable.timeframe, "1m")))
      .orderBy(desc(candlesTable.closeTs))
      .limit(1),
    readPromotedServiceRuntimeArtifact(upperServiceId),
    getPromotedSymbolRuntimeModel(upperSymbol).catch(() => null),
  ]);

  const stateMap: Record<string, string> = {};
  for (const row of stateRows) stateMap[row.key] = row.value;

  const activeMode = explicitMode ?? normaliseMode(getActiveModes(stateMap));
  const streamingSymbols = String(stateMap.streaming_symbols ?? "")
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  const streamState = stateMap.streaming === "true" && streamingSymbols.includes(upperSymbol)
    ? "active"
    : "inactive";

  const latestCandleTs = latestCandleRows[0]?.closeTs
    ? new Date(Number(latestCandleRows[0].closeTs) * 1000).toISOString()
    : null;
  const latestCandleAge = latestCandleTs ? Date.now() - new Date(latestCandleTs).getTime() : null;
  const staleCutoffMs = Number(stateMap.max_candle_stale_ms || 180_000);
  const stale = latestCandleAge != null && Number.isFinite(latestCandleAge) && latestCandleAge > staleCutoffMs;
  const promotedRuntimePresent = Boolean(promotedServiceRuntime);
  let blockedReason: string | null = null;
  const warnings: string[] = [];

  if (streamState !== "active") {
    blockedReason = "stream_inactive";
  } else if (!latestCandleTs) {
    blockedReason = "latest_candle_missing";
  } else if (stale) {
    blockedReason = "stream_stale";
  } else if (!promotedServiceRuntime) {
    blockedReason = "no_promoted_service_runtime";
  } else if (activeMode === "idle" || activeMode === "multi") {
    blockedReason = "active_mode_not_executable";
  } else if (!promotedServiceRuntime.allowedModes[activeMode]) {
    blockedReason = `promoted_runtime_not_allowed_for_mode:${activeMode}`;
  } else if (!promotedServiceRuntime.runtimeModelAdapter) {
    blockedReason = "promoted_service_runtime_missing_runtime_adapter";
  }

  if (legacySymbolModel && !promotedServiceRuntime) {
    warnings.push("legacy_symbol_model_present_without_executable_service_runtime");
  }
  if (stale) {
    warnings.push(`latest_candle_age_exceeds_${Math.round(staleCutoffMs / 1000)}s`);
  }

  return {
    serviceId: upperServiceId,
    symbol: upperSymbol,
    activeMode,
    streamState,
    latestCandleTs,
    latestCandleAge,
    promotedRuntimePresent,
    promotedRuntimeArtifactId: promotedServiceRuntime?.artifactId ?? null,
    promotedRuntimeVersion: promotedServiceRuntime?.version ?? null,
    allowedForActiveMode: Boolean(
      promotedServiceRuntime &&
      activeMode !== "idle" &&
      activeMode !== "multi" &&
      promotedServiceRuntime.allowedModes[activeMode],
    ),
    candidateEmissionAllowed: blockedReason == null,
    executionAllowedBeforeAllocator: false,
    blockedReason,
    warnings,
    legacySymbolModelPresent: Boolean(legacySymbolModel),
    serviceRuntimePresent: Boolean(promotedServiceRuntime),
  };
}
