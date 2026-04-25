/**
 * Candidate Lifecycle Manager — V3
 *
 * Maintains rolling in-memory state for each symbol/engine/direction candidate.
 * Prevents signal_log spam by gating log writes on material state changes.
 * Supports per-symbol watch-mode scheduling for high-frequency monitoring.
 *
 * Lifecycle states: idle → watch → qualified → tradeable → executed | expired
 *
 * Keyed by: `${symbol}|${engineName}|${direction}`
 */

export type LifecycleStatus = "idle" | "watch" | "qualified" | "tradeable" | "executed" | "expired";

export interface CandidateRecord {
  key: string;
  symbol: string;
  engineName: string;
  direction: "buy" | "sell";
  status: LifecycleStatus;
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastLoggedAt: Date | null;
  lastScore: number;
  bestScore: number;
  lastBreakdown: Record<string, number> | null;
  prevBreakdown: Record<string, number> | null;
  weakComponents: string[];
  engineGatePassed: boolean;
  allocatorGatePassed: boolean;
  lastRejectionReason: string | null;
  regime: string | null;
  regimeConfidence: number;
  consecutiveImproving: number;
  consecutiveDegrading: number;
  expiryReason: string | null;
  scanCount: number;
  tradeableAfterAt: Date | null;
  minTradeableScans: number;
  cooldownUntilAt: Date | null;
}

export interface UpdateCandidateInput {
  symbol: string;
  engineName: string;
  direction: "buy" | "sell";
  nativeScore: number;
  breakdown: Record<string, number> | null;
  engineGatePassed: boolean;
  allocatorAllowed: boolean;
  rejectionReason: string | null;
  regime: string;
  regimeConfidence: number;
  minTradeableAgeMs?: number;
  minTradeableScans?: number;
}

export interface UpdateCandidateResult {
  candidate: CandidateRecord;
  shouldLog: boolean;
  logReason: string;
  stateChanged: boolean;
  watchTriggered: boolean;
  expiredNow: boolean;
}

const WATCH_SCORE_THRESHOLD = 60;
const MIN_SCORE_DELTA = 4;
const EXPIRY_LOW_SCORE_CONSEC = 3;
const EXPIRY_TIMEOUT_MS = 30 * 60 * 1000;
const CLEANUP_AFTER_MS = 2 * 60 * 60 * 1000;

const candidates = new Map<string, CandidateRecord>();

export function makeCandidateKey(symbol: string, engineName: string, direction: string): string {
  return `${symbol}|${engineName}|${direction}`;
}

function extractWeakComponents(breakdown: Record<string, number> | null): string[] {
  if (!breakdown) return [];
  return Object.entries(breakdown)
    .filter(([, v]) => v < 55)
    .map(([k]) => k)
    .sort();
}

function weakComponentsChanged(prev: string[], curr: string[]): boolean {
  if (prev.length !== curr.length) return true;
  for (let i = 0; i < prev.length; i++) {
    if (prev[i] !== curr[i]) return true;
  }
  return false;
}

function rejectionClass(reason: string | null): string {
  if (!reason) return "";
  return reason.split(":")[0];
}

function resolveStatus(
  score: number,
  engineGatePassed: boolean,
  allocatorAllowed: boolean,
  matureTradeable: boolean,
): LifecycleStatus {
  if (allocatorAllowed) return matureTradeable ? "tradeable" : "qualified";
  if (score >= WATCH_SCORE_THRESHOLD) {
    return engineGatePassed ? "qualified" : "watch";
  }
  return "idle";
}

export function updateCandidate(input: UpdateCandidateInput): UpdateCandidateResult {
  const key = makeCandidateKey(input.symbol, input.engineName, input.direction);
  const now = new Date();
  const weakNow = extractWeakComponents(input.breakdown);
  const minTradeableAgeMs = Math.max(0, input.minTradeableAgeMs ?? 0);
  const minTradeableScans = Math.max(1, input.minTradeableScans ?? 1);

  const existing = candidates.get(key);

  if (!existing) {
    const matureTradeable = input.allocatorAllowed && minTradeableAgeMs === 0 && minTradeableScans <= 1;
    const status = resolveStatus(input.nativeScore, input.engineGatePassed, input.allocatorAllowed, matureTradeable);
    const rec: CandidateRecord = {
      key, symbol: input.symbol, engineName: input.engineName, direction: input.direction,
      status,
      firstSeenAt: now, lastSeenAt: now, lastLoggedAt: null,
      lastScore: input.nativeScore, bestScore: input.nativeScore,
      lastBreakdown: input.breakdown, prevBreakdown: null,
      weakComponents: weakNow,
      engineGatePassed: input.engineGatePassed,
      allocatorGatePassed: input.allocatorAllowed,
      lastRejectionReason: input.rejectionReason,
      regime: input.regime, regimeConfidence: input.regimeConfidence,
      consecutiveImproving: 0, consecutiveDegrading: 0,
      expiryReason: null,
      scanCount: 1,
      tradeableAfterAt: minTradeableAgeMs > 0 ? new Date(now.getTime() + minTradeableAgeMs) : now,
      minTradeableScans,
      cooldownUntilAt: null,
    };
    candidates.set(key, rec);

    const shouldLog = status !== "idle";
    if (shouldLog) rec.lastLoggedAt = now;
    return {
      candidate: rec, shouldLog, logReason: shouldLog ? "first_watch_entry" : "",
      stateChanged: true, watchTriggered: shouldLog, expiredNow: false,
    };
  }

  const prevStatus = existing.status;
  const prevScore = existing.lastScore;
  const prevWeakComponents = existing.weakComponents;
  const nextScanCount = existing.scanCount + 1;
  const ageMs = now.getTime() - existing.firstSeenAt.getTime();
  const matureTradeable = input.allocatorAllowed &&
    ageMs >= minTradeableAgeMs &&
    nextScanCount >= minTradeableScans;
  const newStatusRaw = resolveStatus(input.nativeScore, input.engineGatePassed, input.allocatorAllowed, matureTradeable);
  const scoreDelta = Math.abs(input.nativeScore - prevScore);
  const improving = input.nativeScore > prevScore;
  const degrading = input.nativeScore < prevScore;

  const consecutiveImproving = improving ? existing.consecutiveImproving + 1 : 0;
  const consecutiveDegrading = degrading ? existing.consecutiveDegrading + 1 : 0;

  let newStatus = newStatusRaw;
  let expiredNow = false;
  let expiryReason: string | null = existing.expiryReason;

  if (prevStatus === "executed" && (!existing.cooldownUntilAt || now < existing.cooldownUntilAt)) {
    newStatus = "executed";
  } else if (prevStatus !== "idle" && prevStatus !== "expired") {
    const timeSinceSeen = now.getTime() - existing.lastSeenAt.getTime();
    if (timeSinceSeen > EXPIRY_TIMEOUT_MS) {
      newStatus = "expired";
      expiredNow = true;
      expiryReason = "not_seen_30min";
    } else if (newStatus === "idle" && consecutiveDegrading >= EXPIRY_LOW_SCORE_CONSEC) {
      newStatus = "expired";
      expiredNow = true;
      expiryReason = `score_degraded_below_watch:${input.nativeScore}`;
    }
  }

  const stateChanged = newStatus !== prevStatus;
  const weakChanged = weakComponentsChanged(prevWeakComponents, weakNow);
  const rejectionClassChanged = rejectionClass(input.rejectionReason) !== rejectionClass(existing.lastRejectionReason);
  const allocatorStatusChanged = input.allocatorAllowed !== existing.allocatorGatePassed;
  const engineGateChanged = input.engineGatePassed !== existing.engineGatePassed;

  existing.status = newStatus;
  existing.lastSeenAt = now;
  existing.prevBreakdown = existing.lastBreakdown;
  existing.lastBreakdown = input.breakdown;
  existing.weakComponents = weakNow;
  existing.lastScore = input.nativeScore;
  existing.bestScore = Math.max(existing.bestScore, input.nativeScore);
  existing.engineGatePassed = input.engineGatePassed;
  existing.allocatorGatePassed = input.allocatorAllowed;
  existing.lastRejectionReason = input.rejectionReason;
  existing.regime = input.regime;
  existing.regimeConfidence = input.regimeConfidence;
  existing.consecutiveImproving = consecutiveImproving;
  existing.consecutiveDegrading = consecutiveDegrading;
  existing.expiryReason = expiryReason;
  existing.scanCount = nextScanCount;
  existing.tradeableAfterAt = minTradeableAgeMs > 0
    ? new Date(existing.firstSeenAt.getTime() + minTradeableAgeMs)
    : existing.firstSeenAt;
  existing.minTradeableScans = minTradeableScans;

  let shouldLog = false;
  let logReason = "";

  if (newStatus === "idle" && prevStatus === "idle") {
    shouldLog = false;
  } else if (newStatus === "executed" && prevStatus === "executed") {
    shouldLog = false;
  } else if (stateChanged) {
    shouldLog = true;
    logReason = `state_change:${prevStatus}->${newStatus}`;
  } else if (scoreDelta >= MIN_SCORE_DELTA) {
    shouldLog = true;
    logReason = `score_delta:${scoreDelta.toFixed(1)}pts`;
  } else if (weakChanged) {
    shouldLog = true;
    logReason = "weak_components_changed";
  } else if (allocatorStatusChanged) {
    shouldLog = true;
    logReason = "allocator_gate_changed";
  } else if (engineGateChanged) {
    shouldLog = true;
    logReason = "engine_gate_changed";
  } else if (rejectionClassChanged) {
    shouldLog = true;
    logReason = "rejection_class_changed";
  }

  if (shouldLog) {
    existing.lastLoggedAt = now;
  }

  const watchTriggered = stateChanged &&
    (newStatus === "watch" || newStatus === "qualified") &&
    (prevStatus === "idle" || prevStatus === "expired");

  return { candidate: existing, shouldLog, logReason, stateChanged, watchTriggered, expiredNow };
}

export function markCandidateExecuted(
  symbol: string,
  engineName: string,
  direction: string,
  cooldownMs = CLEANUP_AFTER_MS,
): void {
  const key = makeCandidateKey(symbol, engineName, direction);
  const rec = candidates.get(key);
  if (rec) {
    rec.status = "executed";
    rec.lastSeenAt = new Date();
    rec.cooldownUntilAt = new Date(rec.lastSeenAt.getTime() + Math.max(CLEANUP_AFTER_MS, cooldownMs));
  }
}

export function getWatchedCandidates(): CandidateRecord[] {
  return Array.from(candidates.values())
    .filter(c => c.status !== "idle")
    .sort((a, b) => b.lastScore - a.lastScore);
}

export function getSymbolsNeedingWatchScan(): string[] {
  const symbols = new Set<string>();
  for (const rec of candidates.values()) {
    if (rec.status === "watch" || rec.status === "qualified" || rec.status === "tradeable") {
      symbols.add(rec.symbol);
    }
  }
  return Array.from(symbols);
}

export function cleanupStale(): void {
  const now = Date.now();
  for (const [key, rec] of candidates.entries()) {
    if (rec.status === "executed" || rec.status === "expired") {
      const cleanupAfter = Math.max(
        rec.lastSeenAt.getTime() + CLEANUP_AFTER_MS,
        rec.cooldownUntilAt?.getTime() ?? 0,
      );
      if (now > cleanupAfter) {
        candidates.delete(key);
      }
    }
    if ((rec.status === "watch" || rec.status === "qualified" || rec.status === "tradeable") &&
        now - rec.lastSeenAt.getTime() > EXPIRY_TIMEOUT_MS) {
      rec.status = "expired";
      rec.expiryReason = "not_seen_30min";
    }
  }
}
