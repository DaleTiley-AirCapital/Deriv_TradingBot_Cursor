import type { SignalCandidate } from "./strategies.js";

export interface PendingSignal {
  key: string;
  symbol: string;
  strategyName: string;
  strategyFamily: string;
  direction: "buy" | "sell";
  confirmCount: number;
  requiredConfirmations: number;
  firstDetectedAt: number;
  lastConfirmedAt: number;
  lastCompositeScore: number;
  lastExpectedValue: number;
  lastScore: number;
  windowTimestamps: number[];
  priceAtFirst: number;
  priceAtLast: number;
  promoted: boolean;
  pyramidLevel: number;
}

const REQUIRED_CONFIRMATIONS = 3;
const MAX_GAP_MS = 90 * 60 * 1000;
const STALE_EXPIRY_MS = 90 * 60 * 1000;
const PYRAMID_PRICE_MOVE_PCT = 0.01;
const PYRAMID_EXTRA_CONFIRMATIONS = 3;

const pendingSignals = new Map<string, PendingSignal>();

function makeKey(symbol: string, strategyName: string, direction: string): string {
  return `${symbol}|${strategyName}|${direction}`;
}

export function confirmSignal(
  candidate: SignalCandidate,
  windowTs: number,
  currentPrice: number,
  existingPositionCount: number = 0,
): { promoted: boolean; pending: PendingSignal } {
  const key = makeKey(candidate.symbol, candidate.strategyName, candidate.direction);
  const now = Date.now();

  let entry = pendingSignals.get(key);

  if (entry) {
    const gap = now - entry.lastConfirmedAt;
    if (gap > MAX_GAP_MS) {
      pendingSignals.delete(key);
      entry = undefined;
    }
  }

  if (entry && entry.windowTimestamps.includes(windowTs)) {
    return { promoted: false, pending: entry };
  }

  if (!entry) {
    const requiredForPyramid = existingPositionCount > 0
      ? PYRAMID_EXTRA_CONFIRMATIONS
      : REQUIRED_CONFIRMATIONS;

    entry = {
      key,
      symbol: candidate.symbol,
      strategyName: candidate.strategyName,
      strategyFamily: candidate.strategyFamily || candidate.strategyName,
      direction: candidate.direction,
      confirmCount: 1,
      requiredConfirmations: requiredForPyramid,
      firstDetectedAt: now,
      lastConfirmedAt: now,
      lastCompositeScore: candidate.compositeScore,
      lastExpectedValue: candidate.expectedValue,
      lastScore: candidate.score,
      windowTimestamps: [windowTs],
      priceAtFirst: currentPrice,
      priceAtLast: currentPrice,
      promoted: false,
      pyramidLevel: existingPositionCount,
    };
    pendingSignals.set(key, entry);
    return { promoted: false, pending: entry };
  }

  entry.confirmCount++;
  entry.lastConfirmedAt = now;
  entry.lastCompositeScore = candidate.compositeScore;
  entry.lastExpectedValue = candidate.expectedValue;
  entry.lastScore = candidate.score;
  entry.priceAtLast = currentPrice;
  entry.windowTimestamps.push(windowTs);

  if (existingPositionCount > 0) {
    const priceMoveDir = entry.direction === "buy"
      ? (currentPrice - entry.priceAtFirst) / entry.priceAtFirst
      : (entry.priceAtFirst - currentPrice) / entry.priceAtFirst;
    if (priceMoveDir < PYRAMID_PRICE_MOVE_PCT) {
      return { promoted: false, pending: entry };
    }
  }

  if (entry.confirmCount >= entry.requiredConfirmations) {
    entry.promoted = true;
    return { promoted: true, pending: entry };
  }

  return { promoted: false, pending: entry };
}

export function removePendingSignal(symbol: string, strategyName: string, direction: string): void {
  const key = makeKey(symbol, strategyName, direction);
  pendingSignals.delete(key);
}

export function expireStaleSignals(): void {
  const now = Date.now();
  for (const [key, entry] of pendingSignals) {
    if (now - entry.lastConfirmedAt > STALE_EXPIRY_MS) {
      pendingSignals.delete(key);
    }
  }
}

export function getPendingSignals(): PendingSignal[] {
  return Array.from(pendingSignals.values()).filter(p => !p.promoted);
}

export function getAllPendingSignals(): PendingSignal[] {
  return Array.from(pendingSignals.values());
}

export function get30MinWindowTs(): number {
  const now = Date.now();
  return Math.floor(now / (30 * 60 * 1000)) * (30 * 60 * 1000);
}

const lastWindowEvaluated = new Map<string, number>();

export function shouldEvaluateWindow(symbol: string, latestCandleCloseMs?: number): boolean {
  const currentWindow = get30MinWindowTs();
  const lastWindow = lastWindowEvaluated.get(symbol);

  if (lastWindow === currentWindow) {
    return false;
  }

  if (latestCandleCloseMs !== undefined && latestCandleCloseMs < currentWindow) {
    return false;
  }

  lastWindowEvaluated.set(symbol, currentWindow);
  return true;
}

export function invalidateUnconfirmedPending(symbol: string, confirmedKeys: Set<string>): void {
  for (const [key, entry] of pendingSignals) {
    if (entry.symbol === symbol && !entry.promoted && !confirmedKeys.has(key)) {
      console.log(`[Confirm] ${symbol} | ${entry.strategyName} | dir=${entry.direction} | INVALIDATED — not re-confirmed in current window (${entry.confirmCount}/${entry.requiredConfirmations})`);
      pendingSignals.delete(key);
    }
  }
}

export function getPendingSignalStatus() {
  const pending = getPendingSignals();
  return {
    count: pending.length,
    signals: pending.map(p => ({
      symbol: p.symbol,
      strategyName: p.strategyName,
      strategyFamily: p.strategyFamily,
      direction: p.direction,
      confirmCount: p.confirmCount,
      requiredConfirmations: p.requiredConfirmations,
      firstDetectedAt: new Date(p.firstDetectedAt).toISOString(),
      lastConfirmedAt: new Date(p.lastConfirmedAt).toISOString(),
      lastCompositeScore: p.lastCompositeScore,
      lastExpectedValue: p.lastExpectedValue,
      priceAtFirst: p.priceAtFirst,
      priceAtLast: p.priceAtLast,
      pyramidLevel: p.pyramidLevel,
      progressPct: Math.round((p.confirmCount / p.requiredConfirmations) * 100),
    })),
  };
}
