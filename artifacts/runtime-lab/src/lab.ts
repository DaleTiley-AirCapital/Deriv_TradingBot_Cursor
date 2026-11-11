import { loadCandles, loadDetectedMoves, normalizeRequest } from "./data.js";
import { computePointInTimeFeatures, featureKeys, featureValueRange } from "./features.js";
import { median, pctChange, summarize } from "./math.js";
import type {
  CandidateRule,
  Candle,
  ControlFingerprint,
  DetectedMove,
  Direction,
  FeatureSeparation,
  Fingerprint,
  LabRequest,
  WalkForwardSummary,
  WalkForwardTrade,
} from "./types.js";

export async function runFingerprints(request: LabRequest): Promise<{ fingerprints: Fingerprint[]; skippedMoves: number }> {
  const normalized = normalizeRequest(request);
  const candles = await loadCandles(normalized);
  const moves = await loadDetectedMoves(normalized);
  const fingerprints: Fingerprint[] = [];
  let skippedMoves = 0;
  for (const move of moves) {
    const index = findCandleIndexAtOrBefore(candles, move.startTs);
    const features = index == null ? null : computePointInTimeFeatures(candles, index);
    if (!features) {
      skippedMoves += 1;
      continue;
    }
    fingerprints.push({
      moveId: move.id,
      serviceId: move.symbol,
      family: move.strategyFamilyCandidate !== "unknown" ? move.strategyFamilyCandidate : move.moveType,
      direction: move.direction,
      moveStart: move.startTs,
      moveEnd: move.endTs,
      movePct: move.movePct,
      holdingMinutes: move.holdingMinutes,
      features,
    });
  }
  return { fingerprints, skippedMoves };
}

export async function runControlComparison(request: LabRequest): Promise<{
  targetCount: number;
  controlCount: number;
  separations: FeatureSeparation[];
}> {
  const normalized = normalizeRequest(request);
  const candles = await loadCandles(normalized);
  const moves = await loadDetectedMoves(normalized);
  const { fingerprints } = await runFingerprints(normalized);
  const controls = buildControls(candles, moves);
  const separations = featureKeys()
    .map((feature) => compareFeature(feature, fingerprints, controls))
    .filter((item) => item.target.count > 0 && item.control.count > 0)
    .sort((a, b) => b.separationScore - a.separationScore);
  return {
    targetCount: fingerprints.length,
    controlCount: controls.length,
    separations,
  };
}

export async function generateRule(request: LabRequest): Promise<CandidateRule> {
  const normalized = normalizeRequest(request);
  const { fingerprints } = await runFingerprints(normalized);
  const comparison = await runControlComparison(normalized);
  const selectedFeatures = comparison.separations
    .filter((item) => item.separationScore >= 0.25)
    .slice(0, 5);
  const conditions = selectedFeatures.map((item) => {
    const targetValues = fingerprints
      .map((fingerprint) => fingerprint.features[item.feature])
      .filter((value): value is number => Number.isFinite(value));
    return {
      feature: item.feature,
      ...featureValueRange(targetValues),
    };
  });
  const medianHoldMinutes = Math.max(60, median(fingerprints.map((fingerprint) => fingerprint.holdingMinutes)));
  const family = normalized.family === "all" ? "mined_all_families" : normalized.family;
  const direction = inferRuleDirection(normalized.direction, fingerprints);
  return {
    ruleId: `${normalized.serviceId.toLowerCase()}_${family}_${direction}_${normalized.targetPct}pct_lab_rule`,
    serviceId: normalized.serviceId,
    family,
    direction,
    targetPct: normalized.targetPct,
    stopLossPct: normalized.serviceId === "R_75" || normalized.serviceId === "R_100" ? 2 : 3,
    maxHoldBars: Math.ceil(medianHoldMinutes),
    entryConditions: conditions,
  };
}

export async function runWalkForward(request: LabRequest, candidateRule?: CandidateRule): Promise<{
  rule: CandidateRule;
  summary: WalkForwardSummary;
  trades: WalkForwardTrade[];
}> {
  const normalized = normalizeRequest(request);
  const candles = await loadCandles(normalized);
  const moves = await loadDetectedMoves(normalized);
  const rule = candidateRule ?? await generateRule(normalized);
  const trades: WalkForwardTrade[] = [];
  let nextAllowedIndex = 0;
  for (let i = 1440; i < candles.length - 1; i += 1) {
    if (i < nextAllowedIndex) continue;
    const features = computePointInTimeFeatures(candles, i);
    if (!features || !matchesRule(rule, features)) continue;
    const trade = simulateTrade(candles, i + 1, rule, moves);
    if (!trade) continue;
    trades.push(trade);
    const exitIndex = findCandleIndexAtOrBefore(candles, trade.exitTs);
    nextAllowedIndex = exitIndex == null ? i + 1 : exitIndex + 1;
  }
  return {
    rule,
    summary: summarizeWalkForward(rule.ruleId, trades),
    trades,
  };
}

function buildControls(candles: Candle[], moves: DetectedMove[]): ControlFingerprint[] {
  const moveWindows = moves.map((move) => ({ start: move.startTs, end: move.endTs }));
  const controls: ControlFingerprint[] = [];
  const step = Math.max(60, Math.floor(candles.length / 1000));
  for (let i = 1440; i < candles.length; i += step) {
    const candle = candles[i];
    if (!candle || isInsideMove(candle.openTs, moveWindows)) continue;
    const features = computePointInTimeFeatures(candles, i);
    if (!features) continue;
    controls.push({
      candleTs: candle.openTs,
      serviceId: "",
      features,
    });
  }
  return controls;
}

function compareFeature(feature: string, fingerprints: Fingerprint[], controls: ControlFingerprint[]): FeatureSeparation {
  const targetValues = fingerprints
    .map((fingerprint) => fingerprint.features[feature])
    .filter((value): value is number => Number.isFinite(value));
  const controlValues = controls
    .map((control) => control.features[feature])
    .filter((value): value is number => Number.isFinite(value));
  const target = summarize(targetValues);
  const control = summarize(controlValues);
  const targetMedian = target.median ?? 0;
  const controlMedian = control.median ?? 0;
  const targetIqr = Math.abs((target.p75 ?? targetMedian) - (target.p25 ?? targetMedian));
  const controlIqr = Math.abs((control.p75 ?? controlMedian) - (control.p25 ?? controlMedian));
  const pooledSpread = Math.max(0.000001, targetIqr + controlIqr);
  return {
    feature,
    target,
    control,
    separationScore: Math.abs(targetMedian - controlMedian) / pooledSpread,
    targetPresenceRate: fingerprints.length > 0 ? targetValues.length / fingerprints.length : 0,
    controlPresenceRate: controls.length > 0 ? controlValues.length / controls.length : 0,
  };
}

function findCandleIndexAtOrBefore(candles: Candle[], ts: number): number | null {
  let low = 0;
  let high = candles.length - 1;
  let found: number | null = null;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candle = candles[mid];
    if (!candle) break;
    if (candle.openTs <= ts) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

function isInsideMove(ts: number, windows: Array<{ start: number; end: number }>): boolean {
  return windows.some((window) => ts >= window.start && ts <= window.end);
}

function inferRuleDirection(direction: string, fingerprints: Fingerprint[]): Direction {
  if (direction === "buy" || direction === "sell") return direction;
  const up = fingerprints.filter((fingerprint) => fingerprint.direction === "up").length;
  const down = fingerprints.length - up;
  return up >= down ? "buy" : "sell";
}

function matchesRule(rule: CandidateRule, features: Record<string, number>): boolean {
  for (const condition of rule.entryConditions) {
    const value = features[condition.feature];
    if (!Number.isFinite(value)) return false;
    if (condition.min != null && value < condition.min) return false;
    if (condition.max != null && value > condition.max) return false;
  }
  return rule.entryConditions.length > 0;
}

function simulateTrade(candles: Candle[], entryIndex: number, rule: CandidateRule, moves: DetectedMove[]): WalkForwardTrade | null {
  const entry = candles[entryIndex];
  if (!entry) return null;
  const entryPrice = entry.open;
  const tpFraction = rule.targetPct / 100;
  const slFraction = rule.stopLossPct / 100;
  const maxHoldBars = Math.min(rule.maxHoldBars, candles.length - entryIndex - 1);
  let maxFavorablePct = 0;
  let maxAdversePct = 0;
  for (let offset = 0; offset <= maxHoldBars; offset += 1) {
    const candle = candles[entryIndex + offset];
    if (!candle) break;
    const favorable = rule.direction === "buy"
      ? pctChange(entryPrice, candle.high)
      : pctChange(candle.low, entryPrice);
    const adverse = rule.direction === "buy"
      ? pctChange(entryPrice, candle.low)
      : pctChange(candle.high, entryPrice);
    maxFavorablePct = Math.max(maxFavorablePct, favorable);
    maxAdversePct = Math.min(maxAdversePct, adverse);
    const tpHit = favorable >= tpFraction;
    const slHit = Math.abs(adverse) >= slFraction;
    if (tpHit || slHit) {
      const exitPrice = tpHit
        ? rule.direction === "buy" ? entryPrice * (1 + tpFraction) : entryPrice * (1 - tpFraction)
        : rule.direction === "buy" ? entryPrice * (1 - slFraction) : entryPrice * (1 + slFraction);
      return {
        entryTs: entry.openTs,
        exitTs: candle.openTs,
        direction: rule.direction,
        entryPrice,
        exitPrice,
        pnlPct: rule.direction === "buy" ? pctChange(entryPrice, exitPrice) : pctChange(exitPrice, entryPrice),
        exitReason: tpHit ? "tp_hit" : "sl_hit",
        maxFavorablePct,
        maxAdversePct,
        matchedMoveId: matchMove(entry.openTs, moves),
      };
    }
  }
  const final = candles[entryIndex + maxHoldBars];
  if (!final) return null;
  return {
    entryTs: entry.openTs,
    exitTs: final.openTs,
    direction: rule.direction,
    entryPrice,
    exitPrice: final.close,
    pnlPct: rule.direction === "buy" ? pctChange(entryPrice, final.close) : pctChange(final.close, entryPrice),
    exitReason: "maturity_exit",
    maxFavorablePct,
    maxAdversePct,
    matchedMoveId: matchMove(entry.openTs, moves),
  };
}

function matchMove(entryTs: number, moves: DetectedMove[]): number | null {
  const match = moves.find((move) => entryTs >= move.startTs - 3600 && entryTs <= move.endTs);
  return match?.id ?? null;
}

function summarizeWalkForward(ruleId: string, trades: WalkForwardTrade[]): WalkForwardSummary {
  const pnl = trades.map((trade) => trade.pnlPct * 100);
  const wins = trades.filter((trade) => trade.pnlPct > 0).length;
  const losses = trades.filter((trade) => trade.pnlPct <= 0).length;
  const grossProfitPct = pnl.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const grossLossPct = Math.abs(pnl.filter((value) => value <= 0).reduce((sum, value) => sum + value, 0));
  return {
    ruleId,
    trades: trades.length,
    wins,
    losses,
    winRate: trades.length > 0 ? wins / trades.length : 0,
    grossProfitPct,
    grossLossPct,
    profitFactor: grossLossPct > 0 ? grossProfitPct / grossLossPct : grossProfitPct > 0 ? null : 0,
    averagePnlPct: pnl.length > 0 ? pnl.reduce((sum, value) => sum + value, 0) / pnl.length : 0,
    medianPnlPct: median(pnl),
    maxDrawdownPct: maxDrawdown(pnl),
    matchedMoveTrades: trades.filter((trade) => trade.matchedMoveId != null).length,
    falsePositiveTrades: trades.filter((trade) => trade.matchedMoveId == null).length,
  };
}

function maxDrawdown(pnlPct: number[]): number {
  let equity = 0;
  let peak = 0;
  let drawdown = 0;
  for (const pnl of pnlPct) {
    equity += pnl;
    peak = Math.max(peak, equity);
    drawdown = Math.min(drawdown, equity - peak);
  }
  return Math.abs(drawdown);
}
