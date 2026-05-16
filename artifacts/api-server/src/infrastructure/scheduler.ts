import { manageOpenPositions, openPositionV3 } from "../core/tradeEngine.js";
import { db, platformStateTable, tradesTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { isAnyModeActive } from "./deriv.js";
import { ACTIVE_TRADING_SYMBOLS } from "./deriv.js";
import { syncLatestCanonical1mForSymbol } from "./deriv.js";
import { scanSymbolV3 } from "../core/engineRouterV3.js";
import { allocateV3Signal } from "../core/portfolioAllocatorV3.js";
import type { LiveCalibrationProfile } from "../core/calibration/liveCalibrationProfile.js";
import {
  getSymbolsNeedingWatchScan,
  getWatchedCandidates,
  cleanupStale,
} from "../core/candidateLifecycle.js";
import { buildSymbolTradeCandidate } from "../core/symbolModels/candidateBuilder.js";
import type { BehaviorProfileSummary } from "../core/backtest/behaviorProfiler.js";
import { isSymbolStreamingDisabled } from "./symbolValidator.js";
import { getEnabledRegisteredSymbols, getSymbolService } from "../symbol-services/shared/SymbolServiceRegistry.js";
import { createAllocatorDecisionRecord, createServiceCandidateRecord, attachTradeToExecutionRecords } from "../core/serviceExecutionRecords.js";
import { resolvePromotedServiceRuntimeAdapter, resolveServiceExecutionGate } from "../core/serviceExecutionGate.js";

const DEFAULT_SYMBOLS = ACTIVE_TRADING_SYMBOLS;
const DEFAULT_SCAN_INTERVAL_MS = 300_000;
const WATCH_SCAN_INTERVAL_MS = 60_000;
const DEFAULT_STAGGER_SECONDS = 10;
let scanCycleRunning = false;
let positionCycleRunning = false;
let watchCycleRunning = false;

function formatDbErr(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: unknown })?.cause;
  if (!cause) return base;
  const causeMsg = cause instanceof Error ? cause.message : String(cause);
  return `${base} | cause: ${causeMsg}`;
}

async function dbWithRetry<T>(fn: () => Promise<T>, label: string, maxAttempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = formatDbErr(err);
      // Avoid log storms under persistent DB failures.
      if (attempt === maxAttempts) {
        console.warn(`[Scheduler] DB retry ${attempt}/${maxAttempts} for "${label}": ${msg}`);
      }
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  throw lastErr;
}

const POSITION_MGMT_INTERVAL_MS = 10_000;

let schedulerHandle: ReturnType<typeof setInterval> | null = null;
let positionMgmtHandle: ReturnType<typeof setInterval> | null = null;
let watchCycleHandle: ReturnType<typeof setInterval> | null = null;

function parseRuntimeWindowMs(raw: string | undefined, fallbackMs: number): number {
  if (!raw) return fallbackMs;
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(m|min|mins|h|hr|hrs|hour|hours)?$/i);
  if (!match) return fallbackMs;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return fallbackMs;
  const unit = (match[2] ?? "m").toLowerCase();
  const minutes = unit.startsWith("h") ? value * 60 : value;
  return Math.max(30, Math.round(minutes)) * 60_000;
}

function runtimeCandidateAgeMs(runtimeCalibration: LiveCalibrationProfile | null): number {
  if (!runtimeCalibration) return 0;
  return parseRuntimeWindowMs(runtimeCalibration.confirmationWindow, 2 * 60 * 60_000);
}

function runtimeCandidateCooldownMs(runtimeCalibration: LiveCalibrationProfile | null): number {
  if (!runtimeCalibration) return 2 * 60 * 60_000;
  const confirmationMs = runtimeCandidateAgeMs(runtimeCalibration);
  const minHoldMinutes = Number(runtimeCalibration.trailingModel?.["minHoldMinutesBeforeTrail"] ?? 0);
  const minHoldMs = Number.isFinite(minHoldMinutes) && minHoldMinutes > 0
    ? minHoldMinutes * 60_000
    : 0;
  return Math.max(confirmationMs * 2, minHoldMs, 4 * 60 * 60_000);
}
let currentIntervalMs = DEFAULT_SCAN_INTERVAL_MS;

let staggeredScanActive = false;
let staggerSymbolIndex = 0;
let staggerTimerHandle: ReturnType<typeof setTimeout> | null = null;

let lastScanTime: Date | null = null;
let lastScanSymbol: string | null = null;
let totalScansRun = 0;
let totalDecisionsLogged = 0;
const calibratedLastScanMs: Record<string, number> = {};

function resolveSchedulerSymbols(stateMap: Record<string, string>): string[] {
  const registryEnabled = getEnabledRegisteredSymbols(stateMap);
  if (registryEnabled.length > 0) return registryEnabled;

  const enabledSymbolsRaw = stateMap["enabled_symbols"] || "";
  if (!enabledSymbolsRaw) return DEFAULT_SYMBOLS;
  return enabledSymbolsRaw.split(",").map((s: string) => s.trim()).filter(Boolean);
}

export function getSchedulerStatus() {
  return {
    running: schedulerHandle !== null,
    lastScanTime: lastScanTime?.toISOString() ?? null,
    lastScanSymbol,
    totalScansRun,
    totalDecisionsLogged,
    scanIntervalMs: currentIntervalMs,
  };
}

async function recordServiceScanStatus(params: {
  serviceId: string;
  symbol: string;
  status: "blocked" | "skipped" | "candidate_emitted" | "allocator_rejected" | "executed";
  reason: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  const now = new Date();
  const prefix = `${params.serviceId.toUpperCase()}_last_service_scan`;
  const entries = [
    { key: `${prefix}_at`, value: now.toISOString() },
    { key: `${prefix}_status`, value: params.status },
    { key: `${prefix}_reason`, value: params.reason },
    { key: `${prefix}_symbol`, value: params.symbol },
    { key: `${prefix}_detail`, value: JSON.stringify(params.detail ?? {}) },
  ];
  await Promise.all(entries.map((entry) =>
    db.insert(platformStateTable)
      .values(entry)
      .onConflictDoUpdate({
        target: platformStateTable.key,
        set: { value: entry.value, updatedAt: now },
      }),
  ));
}

/**
 * V3 live scanner — replaces the V2 family-based scanSingleSymbol.
 *
 * Flow: scanSymbolV3 → coordinatorOutput → allocateV3Signal → [AI verify] → openPositionV3
 * V2 strategies.ts / signalRouter.ts are NOT used here (backtest only).
 */
async function scanSingleSymbolV3(symbol: string, stateMap: Record<string, string>): Promise<void> {
  lastScanTime = new Date();
  lastScanSymbol = symbol;
  totalScansRun++;

  try {
    await syncLatestCanonical1mForSymbol(symbol);
  } catch (err) {
    console.warn(
      `[V3Scan] ${symbol} | canonical_1m_sync_failed | ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const serviceId = getSymbolService(symbol)?.symbol?.toUpperCase() ?? symbol.toUpperCase();
  const gate = await resolveServiceExecutionGate(serviceId, symbol);

  if (!gate.candidateEmissionAllowed) {
    console.log(
      `[V3Scan] ${symbol} | GATE_BLOCKED | reason=${gate.blockedReason ?? "unknown"}${gate.warnings.length ? ` | warnings=${gate.warnings.join(",")}` : ""}`,
    );
    await recordServiceScanStatus({ serviceId, symbol, status: "blocked", reason: gate.blockedReason ?? "unknown", detail: { warnings: gate.warnings } });
    return;
  }

  const activeMode = gate.activeMode;
  if (activeMode !== "paper" && activeMode !== "demo" && activeMode !== "real") {
    console.log(`[V3Scan] ${symbol} | GATE_BLOCKED | reason=active_mode_not_executable(${activeMode})`);
    await recordServiceScanStatus({ serviceId, symbol, status: "blocked", reason: `active_mode_not_executable(${activeMode})` });
    return;
  }

  const runtimeResolution = await resolvePromotedServiceRuntimeAdapter(serviceId, activeMode);
  const runtimeArtifact = runtimeResolution.artifact;
  if (!runtimeArtifact || runtimeResolution.blockedReason) {
    console.log(
      `[V3Scan] ${symbol} | GATE_BLOCKED | reason=${runtimeResolution.blockedReason ?? "promoted_service_runtime_missing"}`,
    );
    await recordServiceScanStatus({ serviceId, symbol, status: "blocked", reason: runtimeResolution.blockedReason ?? "promoted_service_runtime_missing" });
    return;
  }

  const runtimeCalibration = runtimeArtifact.runtimeModelAdapter;
  if (!runtimeCalibration) {
    console.log(`[V3Scan] ${symbol} | GATE_BLOCKED | reason=promoted_service_runtime_missing_runtime_adapter`);
    await recordServiceScanStatus({ serviceId, symbol, status: "blocked", reason: "promoted_service_runtime_missing_runtime_adapter" });
    return;
  }

  const cadenceMs = Math.max(30_000, Math.min(15 * 60_000, runtimeCalibration.recommendedScanIntervalSeconds * 1000));
  const nowMs = Date.now();
  const lastMs = calibratedLastScanMs[symbol] ?? 0;
  if ((nowMs - lastMs) < cadenceMs) {
    console.log(
      `[V3Scan] ${symbol} | SKIP | reason=calibrated_scan_cadence_guard(${Math.round((cadenceMs - (nowMs - lastMs)) / 1000)}s_remaining)`,
    );
    await recordServiceScanStatus({
      serviceId,
      symbol,
      status: "skipped",
      reason: "calibrated_scan_cadence_guard",
      detail: { secondsRemaining: Math.round((cadenceMs - (nowMs - lastMs)) / 1000) },
    });
    return;
  }
  calibratedLastScanMs[symbol] = nowMs;

  const result = await scanSymbolV3(symbol, runtimeCalibration);
  if (result.skipped) {
    console.log(`[V3Scan] ${symbol} | SKIP | reason=${result.skipReason ?? "unknown"}`);
    await recordServiceScanStatus({ serviceId, symbol, status: "skipped", reason: result.skipReason ?? "unknown" });
    return;
  }

  const { coordinatorOutput, features, operationalRegime, regimeConfidence, engineResults } = result;
  if (!coordinatorOutput || !features) {
    const engineCount = engineResults.length;
    console.log(`[V3Scan] ${symbol} | regime=${operationalRegime} | engines=${engineCount} | SKIP=no_coordinator_output`);
    await recordServiceScanStatus({
      serviceId,
      symbol,
      status: "skipped",
      reason: "no_coordinator_output",
      detail: { operationalRegime, regimeConfidence, engineCount },
    });
    return;
  }

  const latestCandleCloseTs = Number(features.latestCandleCloseTs || 0);
  const staleCutoffMs = Number(stateMap["max_candle_stale_ms"] || 180_000);
  if (Number.isFinite(latestCandleCloseTs) && latestCandleCloseTs > 0) {
    const ageMs = Date.now() - latestCandleCloseTs;
    if (ageMs > staleCutoffMs) {
      console.log(
        `[V3Scan] ${symbol} | SKIP | reason=stale_candle_data(age=${Math.round(ageMs / 1000)}s,cutoff=${Math.round(staleCutoffMs / 1000)}s)`,
      );
      await recordServiceScanStatus({
        serviceId,
        symbol,
        status: "skipped",
        reason: "stale_candle_data",
        detail: { ageSeconds: Math.round(ageMs / 1000), cutoffSeconds: Math.round(staleCutoffMs / 1000) },
      });
      return;
    }
  }

  const { winner } = coordinatorOutput;
  console.log(
    `[V3Scan] ${symbol} | service=${serviceId} | mode=${activeMode} | regime=${operationalRegime}(${regimeConfidence.toFixed(2)}) | engine=${winner.engineName} | dir=${coordinatorOutput.resolvedDirection} | conf=${coordinatorOutput.coordinatorConfidence.toFixed(3)} | move=${(winner.projectedMovePct * 100).toFixed(1)}%`,
  );

  const emaKey = `${symbol}_scan_ema_slope`;
  const spikeKey = `${symbol}_scan_spike_count_4h`;
  const trailActivationKey = `${symbol}_scan_trail_activation_pct`;
  const trailDistanceKey = `${symbol}_scan_trail_distance_pct`;
  const trailMinHoldBarsKey = `${symbol}_scan_trail_min_hold_bars`;
  const calibCadenceKey = `${symbol}_scan_calibrated_interval_seconds`;
  const emaVal = String(features.emaSlope ?? 0);
  const spikeVal = String(features.spikeCount4h ?? 0);
  const trailActivationVal = String(Number(runtimeCalibration.trailingModel?.["activationProfitPct"] ?? 0) || 0);
  const trailDistanceVal = String(Number(runtimeCalibration.trailingModel?.["trailingDistancePct"] ?? 0) || 0);
  const trailMinHoldBarsVal = String(Number(runtimeCalibration.trailingModel?.["minHoldMinutesBeforeTrail"] ?? 0) || 0);
  const calibCadenceVal = String(Number(runtimeCalibration.recommendedScanIntervalSeconds ?? 0) || 0);
  Promise.all([
    db.insert(platformStateTable).values({ key: emaKey, value: emaVal })
      .onConflictDoUpdate({ target: platformStateTable.key, set: { value: emaVal, updatedAt: new Date() } }),
    db.insert(platformStateTable).values({ key: spikeKey, value: spikeVal })
      .onConflictDoUpdate({ target: platformStateTable.key, set: { value: spikeVal, updatedAt: new Date() } }),
    db.insert(platformStateTable).values({ key: trailActivationKey, value: trailActivationVal })
      .onConflictDoUpdate({ target: platformStateTable.key, set: { value: trailActivationVal, updatedAt: new Date() } }),
    db.insert(platformStateTable).values({ key: trailDistanceKey, value: trailDistanceVal })
      .onConflictDoUpdate({ target: platformStateTable.key, set: { value: trailDistanceVal, updatedAt: new Date() } }),
    db.insert(platformStateTable).values({ key: trailMinHoldBarsKey, value: trailMinHoldBarsVal })
      .onConflictDoUpdate({ target: platformStateTable.key, set: { value: trailMinHoldBarsVal, updatedAt: new Date() } }),
    db.insert(platformStateTable).values({ key: calibCadenceKey, value: calibCadenceVal })
      .onConflictDoUpdate({ target: platformStateTable.key, set: { value: calibCadenceVal, updatedAt: new Date() } }),
  ]).catch(() => { /* non-fatal */ });

  const builtCandidate = buildSymbolTradeCandidate({
    symbol,
    mode: activeMode,
    coordinatorOutput,
    winner,
    features,
    spotPrice: features.latestClose,
    runtimeCalibration,
  });
  if (!builtCandidate) {
    console.log(`[V3Scan] ${symbol} | NO_SERVICE_CANDIDATE | reason=candidate_builder_returned_null`);
    await recordServiceScanStatus({ serviceId, symbol, status: "skipped", reason: "candidate_builder_returned_null" });
    return;
  }

  if (!builtCandidate.candidate.runtimeSetup.allowed) {
    console.log(
      `[V3Scan] ${symbol} | CANDIDATE_BLOCKED | reason=runtime_setup:${builtCandidate.candidate.runtimeSetup.reason}`,
    );
    await recordServiceScanStatus({ serviceId, symbol, status: "blocked", reason: `runtime_setup:${builtCandidate.candidate.runtimeSetup.reason}` });
    return;
  }

  const lifecyclePlanId = `${serviceId.toLowerCase()}-lifecycle-${runtimeArtifact.artifactId}`;
  const candidateId = await createServiceCandidateRecord({
    serviceId,
    symbol,
    mode: activeMode,
    gate,
    runtimeArtifact,
    coordinatorOutput,
    builtCandidate,
    sourcePolicyId: runtimeArtifact.sourcePolicyId ?? null,
    sourceSynthesisJobId: runtimeArtifact.sourceSynthesisJobId ?? null,
    lifecyclePlanId,
  });

  console.log(`[V3Scan] ${symbol} | SERVICE_CANDIDATE_EMITTED | candidateId=${candidateId}`);
  await recordServiceScanStatus({
    serviceId,
    symbol,
    status: "candidate_emitted",
    reason: "service_candidate_emitted",
    detail: { candidateId },
  });

  const allocatorDecision = await allocateV3Signal(
    coordinatorOutput,
    activeMode,
    stateMap,
    runtimeCalibration,
    runtimeArtifact,
  );
  const decisionId = await createAllocatorDecisionRecord({
    candidateId,
    serviceId,
    symbol,
    mode: activeMode,
    allocationDecision: allocatorDecision,
    builtCandidate,
    lifecyclePlanId,
  });
  totalDecisionsLogged++;

  if (!allocatorDecision.allowed) {
    console.log(
      `[V3Scan] ${symbol} | ALLOCATOR_REJECTED | candidateId=${candidateId} | decisionId=${decisionId} | reason=${allocatorDecision.rejectionReason ?? "unknown"}`,
    );
    await recordServiceScanStatus({
      serviceId,
      symbol,
      status: "allocator_rejected",
      reason: allocatorDecision.rejectionReason ?? "unknown",
      detail: { candidateId, decisionId },
    });
    return;
  }

  const tradeId = await openPositionV3({
    symbol,
    engineName: `${serviceId} Service Runtime`,
    direction: coordinatorOutput.resolvedDirection,
    confidence: coordinatorOutput.coordinatorConfidence,
    capitalAmount: allocatorDecision.capitalAmount,
    features,
    mode: activeMode,
    runtimeCalibration,
    exitPolicy: builtCandidate.candidate.exitPolicy,
    serviceId,
    serviceCandidateId: candidateId,
    allocatorDecisionId: decisionId,
    runtimeArtifactId: runtimeArtifact.artifactId,
    lifecyclePlanId,
    sourcePolicyId: runtimeArtifact.sourcePolicyId ?? null,
    attributionPath: "v3_service_runtime_allocator_execution",
  });

  if (!tradeId) {
    throw new Error(`Allocator-approved trade did not open for ${symbol} (candidateId=${candidateId}, decisionId=${decisionId})`);
  }

  await attachTradeToExecutionRecords({
    tradeId,
    candidateId,
    decisionId,
  });

  console.log(
    `[V3Exec] ${symbol} | ${activeMode} | service=${serviceId} | candidateId=${candidateId} | decisionId=${decisionId} | tradeId=${tradeId} | alloc=$${allocatorDecision.capitalAmount.toFixed(2)} | EXECUTED`,
  );
  await recordServiceScanStatus({
    serviceId,
    symbol,
    status: "executed",
    reason: "trade_opened",
    detail: { candidateId, decisionId, tradeId, allocation: allocatorDecision.capitalAmount, leverage: allocatorDecision.approvedLeverage },
  });
}

async function scheduleStaggeredScan(symbols: string[], staggerMs: number): Promise<void> {
  if (staggerSymbolIndex >= symbols.length) {
    staggerSymbolIndex = 0;
  }

  const symbol = symbols[staggerSymbolIndex];
  staggerSymbolIndex++;

  try {
    const freshStates = await dbWithRetry(
      () => db.select().from(platformStateTable),
      `platform_state read (stagger scan ${symbol})`,
    );
    const freshMap: Record<string, string> = {};
    for (const s of freshStates) freshMap[s.key] = s.value;
    if (isSymbolStreamingDisabled(symbol)) {
      return;
    }
    await scanSingleSymbolV3(symbol, freshMap);
  } catch (err) {
    console.error(`[Scheduler] Stagger scan error for ${symbol}:`, err instanceof Error ? err.message : err);
  }

  if (staggeredScanActive) {
    staggerTimerHandle = setTimeout(() => scheduleStaggeredScan(symbols, staggerMs), staggerMs);
  }
}

async function scanCycle(): Promise<void> {
  if (scanCycleRunning) return;
  scanCycleRunning = true;
  try {
    const states = await dbWithRetry(
      () => db.select().from(platformStateTable),
      "platform_state read (scan cycle)",
    );
    const stateMap: Record<string, string> = {};
    for (const s of states) stateMap[s.key] = s.value;

    const configuredInterval = parseInt(stateMap["scan_interval_seconds"] || "300") * 1000;
    if (configuredInterval !== currentIntervalMs && configuredInterval >= 5000) {
      currentIntervalMs = configuredInterval;
      if (schedulerHandle) {
        clearInterval(schedulerHandle);
        schedulerHandle = setInterval(scanCycle, currentIntervalMs);
        console.log(`[Scheduler] Scan interval updated to ${currentIntervalMs / 1000}s`);
      }
    }

    const killSwitch = stateMap["kill_switch"] === "true";
    const streamingActive = stateMap["streaming"] === "true";

    if (killSwitch || !streamingActive) {
      if (staggeredScanActive) {
        staggeredScanActive = false;
        if (staggerTimerHandle) { clearTimeout(staggerTimerHandle); staggerTimerHandle = null; }
      }
      return;
    }

    const symbolsRaw = resolveSchedulerSymbols(stateMap);
    const symbols = symbolsRaw.filter((s) => !isSymbolStreamingDisabled(s));
    if (symbols.length === 0) {
      if (staggeredScanActive) {
        staggeredScanActive = false;
        if (staggerTimerHandle) {
          clearTimeout(staggerTimerHandle);
          staggerTimerHandle = null;
        }
      }
      return;
    }

    const staggerSeconds = parseInt(stateMap["scan_stagger_seconds"] || String(DEFAULT_STAGGER_SECONDS));
    const staggerMs = Math.max(staggerSeconds * 1000, 1000);

    if (!staggeredScanActive) {
      staggeredScanActive = true;
      staggerSymbolIndex = 0;
      console.log(`[Scheduler] Starting staggered scan: ${symbols.length} symbols, ${staggerSeconds}s apart`);
      scheduleStaggeredScan(symbols, staggerMs).catch(console.error);
    } else {
      const newStaggerMs = Math.max(parseInt(stateMap["scan_stagger_seconds"] || String(DEFAULT_STAGGER_SECONDS)) * 1000, 1000);
      if (newStaggerMs !== staggerMs) {
        console.log(`[Scheduler] Stagger interval updated to ${newStaggerMs / 1000}s`);
      }
    }
  } catch (err) {
    console.error("[Scheduler] Scan error:", formatDbErr(err));
  } finally {
    scanCycleRunning = false;
  }
}

async function positionManagementCycle(): Promise<void> {
  if (positionCycleRunning) return;
  positionCycleRunning = true;
  try {
    const states = await dbWithRetry(
      () => db.select().from(platformStateTable),
      "platform_state read (position management)",
    );
    const stateMap: Record<string, string> = {};
    for (const s of states) stateMap[s.key] = s.value;

    const anyActive = isAnyModeActive(stateMap);
    const legacyMode = stateMap["mode"] || "idle";
    if (!anyActive && legacyMode === "idle") return;

    // Unified lifecycle state machine: manageOpenPositions handles all stages
    // (BE promotion 1→2, trailing activation 2→3, exits) via applyBarStateTransitions.
    // promoteBreakevenSls is superseded — breakeven is now embedded in the shared state machine.
    await manageOpenPositions();
  } catch (err) {
    console.error("[Scheduler] Position management error:", formatDbErr(err));
  } finally {
    positionCycleRunning = false;
  }
}

const WEEKLY_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const AI_LOCKABLE_KEYS = [
  "equity_pct_per_trade", "paper_equity_pct_per_trade", "demo_equity_pct_per_trade", "real_equity_pct_per_trade",
  "max_open_trades", "paper_max_open_trades", "demo_max_open_trades", "real_max_open_trades",
  "min_composite_score", "paper_min_composite_score", "demo_min_composite_score", "real_min_composite_score",
  "min_ev_threshold", "min_rr_ratio",
  "max_daily_loss_pct", "max_weekly_loss_pct", "max_drawdown_pct",
  "correlated_family_cap", "extraction_target_pct",
  "allocation_mode", "paper_allocation_mode", "demo_allocation_mode", "real_allocation_mode",
];
let weeklyHandle: ReturnType<typeof setInterval> | null = null;

const JOB_CONFIG = {
  signalScan:         { enabled: true },
  positionManagement: { enabled: true },
  weeklyAnalysis:     { enabled: true },
} as const;

async function runWeeklyAnalysis(stateMap: Record<string, string>): Promise<void> {
  const closedTrades = await db.select().from(tradesTable).where(eq(tradesTable.status, "closed"));
  if (closedTrades.length < 5) {
    console.log(`[Scheduler] Weekly analysis skipped — only ${closedTrades.length} closed trades (need 5+)`);
    return;
  }

  const modes = ["paper", "demo", "real"] as const;
  const nowIso = new Date().toISOString();
  const suggestions: Record<string, string> = {};

  for (const mode of modes) {
    const modeTrades = closedTrades.filter(t => t.mode === mode);
    if (modeTrades.length < 3) continue;

    const wins = modeTrades.filter(t => (t.pnl ?? 0) > 0);
    const losses = modeTrades.filter(t => (t.pnl ?? 0) <= 0);
    const winRate = wins.length / modeTrades.length;
    const avgPnl = modeTrades.reduce((s, t) => s + (t.pnl ?? 0), 0) / modeTrades.length;

    const avgWinPnl = wins.length > 0 ? wins.reduce((s, t) => s + (t.pnl ?? 0), 0) / wins.length : 0;
    const avgLossPnl = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0) / losses.length) : 1;
    const actualRR = avgLossPnl > 0 ? avgWinPnl / avgLossPnl : 1;

    const tpHits = modeTrades.filter(t => t.exitReason?.includes("tp")).length;
    const slHits = modeTrades.filter(t => t.exitReason?.includes("sl")).length;
    const tpHitRate = modeTrades.length > 0 ? tpHits / modeTrades.length : 0;
    const slHitRate = modeTrades.length > 0 ? slHits / modeTrades.length : 0;

    const currentEquityPct = parseFloat(stateMap[`${mode}_equity_pct_per_trade`] || "15");
    const currentMaxTrades = parseInt(stateMap[`${mode}_max_open_trades`] || "3");
    const currentMaxDaily = parseFloat(stateMap[`${mode}_max_daily_loss_pct`] || "5");
    const currentMaxWeekly = parseFloat(stateMap[`${mode}_max_weekly_loss_pct`] || "10");
    const currentMaxDD = parseFloat(stateMap[`${mode}_max_drawdown_pct`] || "15");

    const conservatism = mode === "real" ? 0.85 : mode === "demo" ? 0.95 : 1.05;

    if (winRate > 0.6 && avgPnl > 0) {
      suggestions[`${mode}_equity_pct_per_trade`] = String(Math.min(currentEquityPct * 1.05 * conservatism, mode === "real" ? 25 : mode === "demo" ? 30 : 40).toFixed(1));
    } else if (winRate < 0.4) {
      suggestions[`${mode}_equity_pct_per_trade`] = String(Math.max(currentEquityPct * 0.9, mode === "real" ? 10 : 8).toFixed(1));
    }

    if (winRate > 0.55 && currentMaxTrades < (mode === "real" ? 4 : 6)) {
      suggestions[`${mode}_max_open_trades`] = String(Math.min(currentMaxTrades + 1, mode === "real" ? 4 : 6));
    } else if (winRate < 0.35 && currentMaxTrades > 2) {
      suggestions[`${mode}_max_open_trades`] = String(Math.max(currentMaxTrades - 1, 2));
    }

    if (winRate < 0.4) {
      suggestions[`${mode}_max_daily_loss_pct`] = String(Math.max(currentMaxDaily * 0.85, 2).toFixed(1));
      suggestions[`${mode}_max_weekly_loss_pct`] = String(Math.max(currentMaxWeekly * 0.85, 4).toFixed(1));
      suggestions[`${mode}_max_drawdown_pct`] = String(Math.max(currentMaxDD * 0.85, 8).toFixed(1));
    } else if (winRate > 0.6 && avgPnl > 0) {
      suggestions[`${mode}_max_daily_loss_pct`] = String(Math.min(currentMaxDaily * 1.1, mode === "real" ? 5 : 10).toFixed(1));
      suggestions[`${mode}_max_weekly_loss_pct`] = String(Math.min(currentMaxWeekly * 1.1, mode === "real" ? 10 : 20).toFixed(1));
    }

    const currentAllocMode = stateMap[`${mode}_allocation_mode`] || "balanced";
    if (winRate > 0.6 && avgPnl > 0 && mode !== "real") {
      if (currentAllocMode === "conservative") suggestions[`${mode}_allocation_mode`] = "balanced";
      if (currentAllocMode === "balanced" && mode === "paper") suggestions[`${mode}_allocation_mode`] = "aggressive";
    } else if (winRate < 0.35) {
      if (currentAllocMode === "aggressive") suggestions[`${mode}_allocation_mode`] = "balanced";
      if (currentAllocMode === "balanced") suggestions[`${mode}_allocation_mode`] = "conservative";
    }

    const currentCorrelatedCap = parseInt(stateMap[`${mode}_correlated_family_cap`] || "3");
    if (winRate > 0.6 && avgPnl > 0 && mode !== "real") {
      suggestions[`${mode}_correlated_family_cap`] = String(Math.min(currentCorrelatedCap + 1, 6));
    } else if (winRate < 0.35) {
      suggestions[`${mode}_correlated_family_cap`] = String(Math.max(currentCorrelatedCap - 1, 1));
    }

    const currentExtractionTarget = parseFloat(stateMap[`${mode}_extraction_target_pct`] || "50");
    if (winRate > 0.6 && avgPnl > 0) {
      suggestions[`${mode}_extraction_target_pct`] = String(Math.max(currentExtractionTarget * 0.9, 20).toFixed(0));
    } else if (winRate < 0.35) {
      suggestions[`${mode}_extraction_target_pct`] = String(Math.min(currentExtractionTarget * 1.1, 200).toFixed(0));
    }

  }

  const currentMinScore = parseFloat(stateMap["min_composite_score"] || "80");
  const currentMinEV = parseFloat(stateMap["min_ev_threshold"] || "0.001");
  const currentMinRR = parseFloat(stateMap["min_rr_ratio"] || "1.5");

  const allWinRate = closedTrades.length > 0
    ? closedTrades.filter(t => (t.pnl ?? 0) > 0).length / closedTrades.length : 0.5;

  if (allWinRate < 0.35) {
    suggestions["min_composite_score"] = String(Math.min(currentMinScore + 2, 95).toFixed(0));
    suggestions["min_ev_threshold"] = String(Math.min(currentMinEV * 1.2, 0.01).toFixed(4));
    suggestions["min_rr_ratio"] = String(Math.min(currentMinRR * 1.1, 4.0).toFixed(2));
  } else if (allWinRate > 0.6 && closedTrades.length > 20) {
    suggestions["min_composite_score"] = String(Math.max(currentMinScore - 1, 80).toFixed(0));
  }

  const filteredSuggestions: Record<string, string> = {};
  for (const [key, value] of Object.entries(suggestions)) {
    const current = stateMap[key];
    if (current !== undefined && current !== value) {
      filteredSuggestions[key] = value;
    }
  }

  for (const [key, value] of Object.entries(filteredSuggestions)) {
    const suggestKey = `ai_suggest_${key}`;
    await db.insert(platformStateTable).values({ key: suggestKey, value })
      .onConflictDoUpdate({ target: platformStateTable.key, set: { value, updatedAt: new Date() } });
  }

  await db.insert(platformStateTable).values({ key: "ai_weekly_analysis_at", value: nowIso })
    .onConflictDoUpdate({ target: platformStateTable.key, set: { value: nowIso, updatedAt: new Date() } });

  const tradeCount = closedTrades.length;
  const overallWinRate = allWinRate;
  const increaseSuggestions = Object.values(filteredSuggestions).filter((v, i) => {
    const k = Object.keys(filteredSuggestions)[i];
    return parseFloat(v) > parseFloat(stateMap[k] || "0");
  }).length;
  const decreaseSuggestions = Object.keys(filteredSuggestions).length - increaseSuggestions;
  const trend = increaseSuggestions > decreaseSuggestions ? "more_aggressive" : increaseSuggestions < decreaseSuggestions ? "more_conservative" : "neutral";

  await db.insert(platformStateTable).values({ key: "ai_suggestion_trend", value: trend })
    .onConflictDoUpdate({ target: platformStateTable.key, set: { value: trend, updatedAt: new Date() } });
  await db.insert(platformStateTable).values({ key: "ai_trades_analyzed", value: String(tradeCount) })
    .onConflictDoUpdate({ target: platformStateTable.key, set: { value: String(tradeCount), updatedAt: new Date() } });
  await db.insert(platformStateTable).values({ key: "ai_win_rate_observed", value: String(overallWinRate.toFixed(3)) })
    .onConflictDoUpdate({ target: platformStateTable.key, set: { value: String(overallWinRate.toFixed(3)), updatedAt: new Date() } });

  console.log(`[Scheduler] Weekly analysis complete — ${tradeCount} trades analyzed, ${Object.keys(filteredSuggestions).length} suggestions generated (trend: ${trend}).`);
}

async function weeklyAnalysisCycle(): Promise<void> {
  try {
    const states = await db.select().from(platformStateTable);
    const stateMap: Record<string, string> = {};
    for (const s of states) stateMap[s.key] = s.value;

    if (stateMap["initial_setup_complete"] !== "true") return;

    const now = new Date();
    if (now.getDay() !== 0) return;

    const lastAnalysis = stateMap["ai_weekly_analysis_at"];
    if (lastAnalysis) {
      const lastDate = new Date(lastAnalysis);
      const hoursSince = (now.getTime() - lastDate.getTime()) / 3600000;
      if (hoursSince < 20) return;
    }

    console.log(`[Scheduler] Sunday detected — starting weekly AI analysis...`);
    await runWeeklyAnalysis(stateMap);
  } catch (err) {
    console.error("[Scheduler] Weekly analysis error:", err instanceof Error ? err.message : err);
  }
}

/**
 * Per-symbol last-watch-scan timestamps.
 * Used by the behavior-guided cadence to throttle rescans per symbol independently.
 * Populated by watchScanCycle; reset on scheduler restart.
 */
const watchLastScanMs: Record<string, number> = {};

/**
 * Watch-mode cycle — runs every 60s.
 * Re-scans only symbols that have at least one watch/qualified/tradeable candidate.
 * Per-symbol, not per-candidate, so all engines for that symbol re-evaluate.
 * Also runs stale-candidate cleanup.
 *
 * Behavior-guided cadence discipline:
 *   If `behavior_watch_cadence_${sym}` is set in platformState (written by the
 *   POST /api/behavior/persist/:symbol endpoint from the behavior profiler), that
 *   cadence overrides the baseline 60s interval for that specific symbol.
 *   This ties live watch-mode execution discipline to empirically derived behavior profiles.
 */
async function watchScanCycle(): Promise<void> {
  if (watchCycleRunning) return;
  watchCycleRunning = true;
  cleanupStale();

  const watchSymbols = getSymbolsNeedingWatchScan().filter((symbol) => symbol !== "CRASH300");
  if (watchSymbols.length === 0) {
    watchCycleRunning = false;
    return;
  }

  try {
    const states = await dbWithRetry(
      () => db.select().from(platformStateTable),
      "platform_state read (watch scan)",
    );
    const stateMap: Record<string, string> = {};
    for (const s of states) stateMap[s.key] = s.value;

    const killSwitch = stateMap["kill_switch"] === "true";
    const streamingActive = stateMap["streaming"] === "true";
    if (killSwitch || !streamingActive) return;

    const nowMs = Date.now();
    // Pre-load watched candidates once for the full cycle
    const allWatchedCandidates = getWatchedCandidates();

    for (const sym of watchSymbols) {
      if (isSymbolStreamingDisabled(sym)) continue;
      // ── Gate 1: Behavior-guided cadence throttle ──────────────────────────
      // Only re-scan once the behavior-recommended interval has elapsed.
      const behaviorCadenceMs = stateMap[`behavior_watch_cadence_${sym}`]
        ? parseInt(stateMap[`behavior_watch_cadence_${sym}`], 10)
        : WATCH_SCAN_INTERVAL_MS;
      const lastScan = watchLastScanMs[sym] ?? 0;
      if (nowMs - lastScan < behaviorCadenceMs) continue;

      // ── Gate 2: Trigger-state maturity check (behavior profile) ──────────
      // Uses per-engine `recommendedMemoryWindowBars` from the derived behavior
      // profile (1 bar = 1 min). For each "watch" candidate whose engine has a
      // profile, require the candidate to have been observed for at least that
      // many minutes before allowing the execution scan to proceed.
      // "qualified" or "tradeable" candidates have already cleared the engine
      // gate and are NOT deferred — the maturity window only guards "watch" state
      // signals that are still developing.
      // Conservative fallback minimum watch duration when no behavior profile
      // is persisted — prevents execution scans on brand-new watch candidates
      // before any historical data is available to calibrate the maturity window.
      // Once a real profile is derived and persisted, its per-engine values take over.
      const FALLBACK_WATCH_MIN_MINS = 30;

      const profileRaw = stateMap[`behavior_profile_${sym}`];
      if (profileRaw) {
        try {
          const profile = JSON.parse(profileRaw) as BehaviorProfileSummary;
          const watchOnlyCandidates = allWatchedCandidates.filter(
            c => c.symbol === sym && c.status === "watch",
          );

          if (watchOnlyCandidates.length > 0) {
            let shouldDefer = false;
            let deferReason = "";

            for (const cand of watchOnlyCandidates) {
              const engineProf = profile.engineProfiles.find(
                ep => ep.engineName === cand.engineName,
              );
              // Use per-engine memory window if available; fall back to symbol cadence × 2
              const memWindowMins = engineProf?.recommendedMemoryWindowBars
                ?? (profile.recommendedScanCadenceMins * 2);

              if (memWindowMins > 0) {
                const watchDurationMins = (nowMs - cand.firstSeenAt.getTime()) / 60_000;
                if (watchDurationMins < memWindowMins) {
                  shouldDefer = true;
                  deferReason = `engine=${cand.engineName} watchDuration=${watchDurationMins.toFixed(1)}min < memoryWindow=${memWindowMins}min`;
                  break;
                }
              }
            }

            if (shouldDefer) {
              console.log(
                `[WatchScan] ${sym} | TRIGGER_MATURITY_GATE | ${deferReason} | deferring execution scan`,
              );
              continue;
            }
          }
        } catch {
          // Profile parse error — allow scan to proceed (corrupt profile is better
          // than indefinitely blocking watch candidates)
        }
      } else {
        // No behavior profile persisted yet — apply conservative fallback gate:
        // require any "watch" state candidate to have been observed for at least
        // FALLBACK_WATCH_MIN_MINS minutes before allowing the execution scan.
        const watchOnlyCandidates = allWatchedCandidates.filter(
          c => c.symbol === sym && c.status === "watch",
        );
        if (watchOnlyCandidates.length > 0) {
          const immature = watchOnlyCandidates.find(
            c => (nowMs - c.firstSeenAt.getTime()) / 60_000 < FALLBACK_WATCH_MIN_MINS,
          );
          if (immature) {
            const watchDurationMins = ((nowMs - immature.firstSeenAt.getTime()) / 60_000).toFixed(1);
            console.log(
              `[WatchScan] ${sym} | FALLBACK_MATURITY_GATE | engine=${immature.engineName} ` +
              `watchDuration=${watchDurationMins}min < fallback=${FALLBACK_WATCH_MIN_MINS}min | deferring`,
            );
            continue;
          }
        }
      }

      try {
        await scanSingleSymbolV3(sym, stateMap);
        watchLastScanMs[sym] = Date.now();
      } catch (err) {
        console.error(`[WatchScan] Error for ${sym}:`, err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    console.error("[WatchScan] Cycle error:", formatDbErr(err));
  } finally {
    watchCycleRunning = false;
  }
}

export function startScheduler(): void {
  if (schedulerHandle) return;

  if (JOB_CONFIG.signalScan.enabled) {
    console.log(`[Scheduler] Starting baseline signal scan every ${currentIntervalMs / 1000}s`);
    schedulerHandle = setInterval(scanCycle, currentIntervalMs);
    setTimeout(scanCycle, 5000);

    console.log(`[Scheduler] Starting watch-mode scan every ${WATCH_SCAN_INTERVAL_MS / 1000}s (candidate-scoped)`);
    watchCycleHandle = setInterval(watchScanCycle, WATCH_SCAN_INTERVAL_MS);
  }

  if (JOB_CONFIG.positionManagement.enabled) {
    console.log(`[Scheduler] Starting position management every ${POSITION_MGMT_INTERVAL_MS / 1000}s`);
    positionMgmtHandle = setInterval(positionManagementCycle, POSITION_MGMT_INTERVAL_MS);
    setTimeout(positionManagementCycle, 8000);
  }

  if (JOB_CONFIG.weeklyAnalysis.enabled) {
    console.log(`[Scheduler] Starting weekly AI analysis check (hourly)`);
    weeklyHandle = setInterval(weeklyAnalysisCycle, WEEKLY_CHECK_INTERVAL_MS);
    setTimeout(weeklyAnalysisCycle, 20000);
  }
}

export function stopScheduler(): void {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
    console.log("[Scheduler] Signal scanner stopped.");
  }
  if (watchCycleHandle) {
    clearInterval(watchCycleHandle);
    watchCycleHandle = null;
    console.log("[Scheduler] Watch-mode scanner stopped.");
  }
  if (positionMgmtHandle) {
    clearInterval(positionMgmtHandle);
    positionMgmtHandle = null;
    console.log("[Scheduler] Position manager stopped.");
  }
  if (weeklyHandle) {
    clearInterval(weeklyHandle);
    weeklyHandle = null;
    console.log("[Scheduler] Weekly analyser stopped.");
  }
  staggeredScanActive = false;
  if (staggerTimerHandle) {
    clearTimeout(staggerTimerHandle);
    staggerTimerHandle = null;
  }
}

