/**
 * behaviorProfiler.ts — Strategy Behavior Profile Derivation
 *
 * Derives per-symbol, per-engine behavior profiles from behavior events
 * captured during backtest replay (and optionally live trade outcomes).
 *
 * Profiles answer:
 *   - How often does this engine signal? (signalFrequencyPerDay)
 *   - How often are signals blocked by the mode gate? (blockedRate)
 *   - What % of trades extend 50%+ of the projected move? (extensionProbability)
 *   - What are the MFE/MAE distributions? (P25/P50/P75/P90)
 *   - How long until peak MFE? (barsToMfeP50)
 *   - What scan cadence is appropriate? (recommendedScanCadenceMins)
 *   - What memory window is appropriate? (recommendedMemoryWindowBars)
 */

import {
  getBehaviorEvents,
  getClosedEvents,
  getBlockedEvents,
  getAllBehaviorKeys,
  type BehaviorEvent,
  type ClosedEvent,
} from "./behaviorCapture.js";

export interface EngineProfile {
  symbol: string;
  engineName: string;
  // Trade quality
  tradeCount: number;
  winRate: number;
  avgHoldBars: number;
  avgHoldHours: number;
  avgPnlPct: number;
  avgNativeScore: number;
  avgProjectedMovePct: number;
  profitFactor: number;
  // MFE distribution
  avgMfePct: number;
  mfePctP25: number;
  mfePctP50: number;
  mfePctP75: number;
  mfePctP90: number;
  // MAE distribution
  avgMaePct: number;
  maePctP25: number;
  maePctP50: number;
  maePctP75: number;
  maePctP90: number;
  // Timing
  barsToMfeP50: number;
  bePromotionRate: number;
  trailingActivationRate: number;
  extensionProbability: number;
  // Exit distribution
  byExitReason: Record<"tp_hit" | "sl_hit" | "max_duration", number>;
  bySlStage: Record<"stage_1" | "stage_2" | "stage_3", number>;
  // Signal quality
  signalsFired: number;
  blockedByGateCount: number;
  blockedRate: number;
  // Regime breakdown
  byRegime: Record<string, { count: number; wins: number; winRate: number }>;
  dominantRegime: string;
  dominantEntryType: string;
  // Derived runtime guidance
  signalFrequencyPerDay: number;
  recommendedMemoryWindowBars: number;
  recommendedScanCadenceMins: number;
  // Score distribution
  scoreP25: number;
  scoreP50: number;
  scoreP75: number;
  // Sample info
  sampleStartTs: number;
  sampleEndTs: number;
  sampleDays: number;
  sources: string[];
}

export interface BehaviorProfileSummary {
  symbol: string;
  engineProfiles: EngineProfile[];
  totalTrades: number;
  totalSignalsFired: number;
  totalBlocked: number;
  overallWinRate: number;
  overallBlockedRate: number;
  recommendedScanCadenceMins: number;
  lastUpdated: string;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * p)));
  return sorted[idx];
}

function deriveScanCadence(signalFreqPerDay: number): number {
  if (signalFreqPerDay >= 4) return 5;
  if (signalFreqPerDay >= 2) return 10;
  if (signalFreqPerDay >= 1) return 15;
  if (signalFreqPerDay >= 0.5) return 30;
  if (signalFreqPerDay >= 0.2) return 60;
  return 120;
}

function deriveMemoryWindow(avgHoldBars: number, signalFreqPerDay: number): number {
  const minWindow = 60;
  const holdBasedWindow = Math.ceil(avgHoldBars * 0.5);
  const freqBasedWindow = signalFreqPerDay > 0
    ? Math.ceil((1 / signalFreqPerDay) * 24 * 60 * 0.25)
    : holdBasedWindow;
  return Math.max(minWindow, Math.min(holdBasedWindow, freqBasedWindow, 1440));
}

export function deriveEngineProfile(
  symbol: string,
  engineName: string,
): EngineProfile | null {
  const allEvents = getBehaviorEvents(symbol, engineName);
  if (allEvents.length === 0) return null;

  const closed = getClosedEvents(symbol, engineName);
  const blocked = getBlockedEvents(symbol, engineName);
  const signalFired = allEvents.filter(e => e.eventType === "signal_fired");
  const entered = allEvents.filter(e => e.eventType === "entered");
  const bePromoted = allEvents.filter(e => e.eventType === "breakeven_promoted");
  const trailingActivated = allEvents.filter(e => e.eventType === "trailing_activated");

  const wins = closed.filter(e => e.pnlPct > 0);
  const losses = closed.filter(e => e.pnlPct <= 0);
  const grossProfit = wins.reduce((s, e) => s + e.pnlPct, 0);
  const grossLoss = Math.abs(losses.reduce((s, e) => s + e.pnlPct, 0));

  const avgHoldBars = closed.length > 0
    ? closed.reduce((s, e) => s + e.holdBars, 0) / closed.length
    : 0;

  const mfePcts = closed.map(e => e.mfePct).sort((a, b) => a - b);
  const maePcts = closed.map(e => Math.abs(e.maePct)).sort((a, b) => a - b);
  const barsToMfe = closed.map(e => e.barsToMfe).sort((a, b) => a - b);
  const scores = allEvents
    .filter((e): e is (typeof e & { nativeScore: number }) => "nativeScore" in e)
    .map(e => (e as { nativeScore: number }).nativeScore)
    .sort((a, b) => a - b);

  const extended = closed.filter(e => {
    const proj = e.projectedMovePct;
    return proj > 0 && e.mfePct >= proj * 0.50;
  });
  const extensionProbability = closed.length > 0 ? extended.length / closed.length : 0;

  const bePromotionRate = entered.length > 0 ? bePromoted.length / entered.length : 0;
  const trailingActivationRate = entered.length > 0 ? trailingActivated.length / entered.length : 0;

  const byExitReason: Record<"tp_hit" | "sl_hit" | "max_duration", number> = {
    tp_hit: 0, sl_hit: 0, max_duration: 0,
  };
  const bySlStage: Record<"stage_1" | "stage_2" | "stage_3", number> = {
    stage_1: 0, stage_2: 0, stage_3: 0,
  };
  const byRegimeRaw: Record<string, { count: number; wins: number }> = {};
  const entryTypeCounts: Record<string, number> = {};
  const sources = new Set<string>();

  for (const e of closed) {
    byExitReason[e.exitReason] = (byExitReason[e.exitReason] ?? 0) + 1;
    const stageKey = `stage_${e.slStage}` as "stage_1" | "stage_2" | "stage_3";
    bySlStage[stageKey] = (bySlStage[stageKey] ?? 0) + 1;
    if (!byRegimeRaw[e.regimeAtEntry]) byRegimeRaw[e.regimeAtEntry] = { count: 0, wins: 0 };
    byRegimeRaw[e.regimeAtEntry].count++;
    if (e.pnlPct > 0) byRegimeRaw[e.regimeAtEntry].wins++;
    entryTypeCounts[e.entryType] = (entryTypeCounts[e.entryType] ?? 0) + 1;
    sources.add(e.source);
  }

  const byRegime: Record<string, { count: number; wins: number; winRate: number }> = {};
  for (const [regime, data] of Object.entries(byRegimeRaw)) {
    byRegime[regime] = { ...data, winRate: data.count > 0 ? data.wins / data.count : 0 };
  }

  const dominantRegime = Object.entries(byRegimeRaw)
    .sort((a, b) => b[1].count - a[1].count)[0]?.[0] ?? "unknown";
  const dominantEntryType = Object.entries(entryTypeCounts)
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";

  // Signal frequency from fired events
  const firedTs = signalFired
    .filter((e): e is typeof e & { ts: number } => "ts" in e)
    .map(e => (e as { ts: number }).ts)
    .sort((a, b) => a - b);

  const closedTs = closed.map(e => e.entryTs).sort((a, b) => a - b);
  const allTs = [...firedTs, ...closedTs].sort((a, b) => a - b);

  const sampleStartTs = allTs[0] ?? 0;
  const sampleEndTs = allTs[allTs.length - 1] ?? 0;
  const sampleDays = Math.max(1, (sampleEndTs - sampleStartTs) / 86400);
  const signalFrequencyPerDay = signalFired.length > 0
    ? signalFired.length / sampleDays
    : (closed.length / sampleDays);

  const recommendedMemoryWindowBars = deriveMemoryWindow(avgHoldBars, signalFrequencyPerDay);
  const recommendedScanCadenceMins = deriveScanCadence(signalFrequencyPerDay);

  return {
    symbol,
    engineName,
    tradeCount: closed.length,
    winRate: closed.length > 0 ? wins.length / closed.length : 0,
    avgHoldBars,
    avgHoldHours: avgHoldBars / 60,
    avgPnlPct: closed.length > 0
      ? closed.reduce((s, e) => s + e.pnlPct, 0) / closed.length
      : 0,
    avgNativeScore: scores.length > 0
      ? scores.reduce((a, b) => a + b, 0) / scores.length
      : 0,
    avgProjectedMovePct: closed.length > 0
      ? closed.reduce((s, e) => s + e.projectedMovePct, 0) / closed.length
      : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    avgMfePct: mfePcts.length > 0 ? mfePcts.reduce((a, b) => a + b, 0) / mfePcts.length : 0,
    mfePctP25: percentile(mfePcts, 0.25),
    mfePctP50: percentile(mfePcts, 0.50),
    mfePctP75: percentile(mfePcts, 0.75),
    mfePctP90: percentile(mfePcts, 0.90),
    avgMaePct: maePcts.length > 0 ? maePcts.reduce((a, b) => a + b, 0) / maePcts.length : 0,
    maePctP25: percentile(maePcts, 0.25),
    maePctP50: percentile(maePcts, 0.50),
    maePctP75: percentile(maePcts, 0.75),
    maePctP90: percentile(maePcts, 0.90),
    barsToMfeP50: percentile(barsToMfe, 0.50),
    bePromotionRate,
    trailingActivationRate,
    extensionProbability,
    byExitReason,
    bySlStage,
    signalsFired: signalFired.length,
    blockedByGateCount: blocked.length,
    blockedRate: signalFired.length > 0 ? blocked.length / signalFired.length : 0,
    byRegime,
    dominantRegime,
    dominantEntryType,
    signalFrequencyPerDay,
    recommendedMemoryWindowBars,
    recommendedScanCadenceMins,
    scoreP25: percentile(scores, 0.25),
    scoreP50: percentile(scores, 0.50),
    scoreP75: percentile(scores, 0.75),
    sampleStartTs,
    sampleEndTs,
    sampleDays,
    sources: [...sources],
  };
}

export function deriveSymbolBehaviorProfile(symbol: string): BehaviorProfileSummary | null {
  const keys: string[] = getAllBehaviorKeys();
  const engineNames = keys
    .filter(k => k.startsWith(`${symbol}|`))
    .map(k => k.split("|")[1])
    .filter((v, i, arr) => arr.indexOf(v) === i);

  if (engineNames.length === 0) return null;

  const engineProfiles: EngineProfile[] = [];
  for (const engineName of engineNames) {
    const profile = deriveEngineProfile(symbol, engineName);
    if (profile) engineProfiles.push(profile);
  }

  if (engineProfiles.length === 0) return null;

  const totalTrades = engineProfiles.reduce((s, p) => s + p.tradeCount, 0);
  const totalWins = engineProfiles.reduce((s, p) => s + Math.round(p.winRate * p.tradeCount), 0);
  const totalFired = engineProfiles.reduce((s, p) => s + p.signalsFired, 0);
  const totalBlocked = engineProfiles.reduce((s, p) => s + p.blockedByGateCount, 0);

  // Recommend the fastest cadence across all engines for the symbol
  const recommendedScanCadenceMins = Math.min(
    ...engineProfiles.map(p => p.recommendedScanCadenceMins)
  );

  return {
    symbol,
    engineProfiles,
    totalTrades,
    totalSignalsFired: totalFired,
    totalBlocked,
    overallWinRate: totalTrades > 0 ? totalWins / totalTrades : 0,
    overallBlockedRate: totalFired > 0 ? totalBlocked / totalFired : 0,
    recommendedScanCadenceMins,
    lastUpdated: new Date().toISOString(),
  };
}
