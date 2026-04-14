/**
 * backtestRunner.ts — V3 Unified Runtime Backtest Engine
 *
 * Replays historical candles bar-by-bar using the EXACT same decision path
 * as the live scanner, including mode score gates mirroring portfolioAllocatorV3:
 *
 *   features → HTF regime (averaged) → engines → symbolCoordinator
 *     → backtestAllocator (mode gate: paper≥60, demo≥65, real≥70)
 *     → staged exit model (SR/Fib TP, 1:5 SL, breakeven at 20%, ATR trail at 30%)
 *
 * ── Divergences from V2 runner (now eliminated) ──────────────────────────────
 *   OLD: bare classifyRegime per bar → NEW: HTF feature-averaged regime
 *   OLD: highest-score loop → NEW: runSymbolCoordinator (conflict resolution)
 *   OLD: no mode score gate → NEW: paper/demo/real gates matching live allocator
 *   OLD: Leg1/Hard-SL/MFE exits → NEW: SR/Fib TP + 1:5 SL + BE@20% + ATR trail
 *   OLD: blocked signals silently dropped → NEW: blocked events captured for profiling
 *
 * ── Behavior event capture ────────────────────────────────────────────────────
 *   Every lifecycle stage is recorded:
 *     signal_fired → blocked_by_gate | entered → breakeven_promoted
 *     → trailing_activated → closed
 *   The behavior profiler reads these to derive: win rate, hold time,
 *   MFE/MAE distributions, blocked rate, recommended scan cadence, memory window.
 *
 * ── Design constraints ────────────────────────────────────────────────────────
 *   - No DB calls inside the hot loop (candles pre-loaded at startup)
 *   - HTF regime averaged over last 60 1m feature samples (~1 hour)
 *   - One open trade per symbol at a time (matches live one-per-symbol enforcement)
 *   - Mode score gates: paper=60, demo=65, real=70 (matches portfolioAllocatorV3)
 *   - Backtest allocator is pure/stateless (no portfolio PnL risk limits — those
 *     are portfolio-state-dependent and inapplicable in isolated bar-by-bar replay)
 */

import { db, candlesTable, platformStateTable } from "@workspace/db";
import { eq, and, gte, lte, asc } from "drizzle-orm";
import { computeFeaturesFromSlice, type CandleRow } from "./featureSlice.js";
import { classifyRegimeFromSamples } from "../regimeEngine.js";
import {
  calculateSRFibTP,
  calculateSRFibSL,
} from "../tradeEngine.js";
import { getSymbolIndicatorTimeframeMins } from "../features.js";
import type { EngineResult } from "../engineTypes.js";
import type { FeatureVector } from "../features.js";
import {
  recordBehaviorEvent,
  type ClosedEvent,
} from "./behaviorCapture.js";
import {
  evaluateSignalAdmission,
  MODE_SCORE_GATES,
  extractNativeScore,
} from "../allocatorCore.js";
import { runEnginesAndCoordinate } from "../signalPipeline.js";
import {
  evaluateBarExits,
  MAX_HOLD_MINS,
  applyBarStateTransitions,
} from "../tradeManagement.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const STRUCTURAL_LOOKBACK = 1500;
// MAX_HOLD_MINS is shared from tradeManagement.ts (also used by live tradeEngine)
// For 1m bars: 1 bar = 1 minute, so MAX_HOLD_BARS === MAX_HOLD_MINS
const SYNTHETIC_EQUITY = 10_000;
const DEFAULT_ALLOCATION_PCT = 0.15;     // matches live portfolioAllocatorV3 default
const SYNTHETIC_SIZE = SYNTHETIC_EQUITY * DEFAULT_ALLOCATION_PCT; // = 1500
const HTF_AVERAGING_WINDOW = 60;         // 60 feature samples ≈ 1 hour (matches live)

// ── Types ─────────────────────────────────────────────────────────────────────

export interface V3BacktestTrade {
  entryTs: number;
  exitTs: number;
  symbol: string;
  direction: "buy" | "sell";
  engineName: string;
  entryType: string;
  entryPrice: number;
  exitPrice: number;
  exitReason: "tp_hit" | "sl_hit" | "max_duration";
  slStage: 1 | 2 | 3;
  projectedMovePct: number;
  nativeScore: number;
  regimeAtEntry: string;
  regimeConfidence: number;
  holdBars: number;
  barsToMfe: number;
  barsToBreakeven: number;
  pnlPct: number;
  mfePct: number;
  maePct: number;
  tpPct: number;
  slPct: number;
  conflictResolution: string;
  modeGateApplied: number;
}

export interface V3BacktestResult {
  symbol: string;
  mode: string;
  startTs: number;
  endTs: number;
  totalBars: number;
  modeScoreGate: number;
  signalsFired: number;
  signalsBlocked: number;
  blockedRate: number;
  trades: V3BacktestTrade[];
  /**
   * Allocator gates that could NOT be applied with full parity because they
   * require cross-symbol or live portfolio state unavailable in single-symbol
   * historical replay. Non-empty = backtest made assumptions for these gates.
   * Callers should surface these to the user as simulation caveats.
   */
  simulationGaps: string[];
  summary: {
    tradeCount: number;
    winCount: number;
    lossCount: number;
    winRate: number;
    avgPnlPct: number;
    avgWinPct: number;
    avgLossPct: number;
    totalPnlPct: number;
    profitFactor: number;
    maxDrawdownPct: number;
    avgHoldBars: number;
    avgMfePct: number;
    avgMaePct: number;
    extensionProbability: number;
    mfePctP25: number;
    mfePctP50: number;
    mfePctP75: number;
    mfePctP90: number;
    maePctP25: number;
    maePctP50: number;
    maePctP75: number;
    maePctP90: number;
    barsToMfeP50: number;
    byEngine: Record<string, { count: number; wins: number; avgPnlPct: number; blockedCount: number }>;
    byExitReason: Record<string, number>;
    bySlStage: Record<string, number>;
    byRegime: Record<string, { count: number; wins: number; winRate: number }>;
  };
}

export interface V3BacktestRequest {
  symbol: string;
  startTs?: number;
  endTs?: number;
  minScore?: number;
  mode?: "paper" | "demo" | "real";
}

// ── HTF regime averaging (local, isolated from live module cache) ──────────────

interface FeatureSample {
  emaSlope: number;
  rsi14: number;
  bbWidth: number;
  bbWidthRoc: number;
  atr14: number;
  atrRank: number;
  atrAccel: number;
  zScore: number;
  spikeHazardScore: number;
  bbPctB: number;
}

// ── Percentile helper ─────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * p)));
  return sorted[idx];
}

// ── Summary builder ───────────────────────────────────────────────────────────

function computeSummary(
  trades: V3BacktestTrade[],
  blockedByEngine: Record<string, number>,
): V3BacktestResult["summary"] {
  if (trades.length === 0) {
    return {
      tradeCount: 0, winCount: 0, lossCount: 0, winRate: 0,
      avgPnlPct: 0, avgWinPct: 0, avgLossPct: 0, totalPnlPct: 0,
      profitFactor: 0, maxDrawdownPct: 0, avgHoldBars: 0,
      avgMfePct: 0, avgMaePct: 0, extensionProbability: 0,
      mfePctP25: 0, mfePctP50: 0, mfePctP75: 0, mfePctP90: 0,
      maePctP25: 0, maePctP50: 0, maePctP75: 0, maePctP90: 0,
      barsToMfeP50: 0,
      byEngine: {}, byExitReason: {}, bySlStage: {}, byRegime: {},
    };
  }

  const wins = trades.filter(t => t.pnlPct > 0);
  const losses = trades.filter(t => t.pnlPct <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnlPct, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0));

  let equity = 0, peak = 0, maxDd = 0;
  for (const t of trades) {
    equity += t.pnlPct;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }

  const mfePcts = [...trades.map(t => t.mfePct)].sort((a, b) => a - b);
  const maePcts = [...trades.map(t => Math.abs(t.maePct))].sort((a, b) => a - b);
  const barsToMfe = [...trades.map(t => t.barsToMfe)].sort((a, b) => a - b);

  // Extension probability: % of trades that reached 50%+ of projected move
  const extended = trades.filter(t => {
    const proj = t.projectedMovePct;
    return proj > 0 && t.mfePct >= proj * 0.50;
  });
  const extensionProbability = trades.length > 0 ? extended.length / trades.length : 0;

  const byEngine: Record<string, { count: number; wins: number; avgPnlPct: number; blockedCount: number }> = {};
  for (const t of trades) {
    if (!byEngine[t.engineName]) {
      byEngine[t.engineName] = { count: 0, wins: 0, avgPnlPct: 0, blockedCount: blockedByEngine[t.engineName] ?? 0 };
    }
    byEngine[t.engineName].count++;
    if (t.pnlPct > 0) byEngine[t.engineName].wins++;
    byEngine[t.engineName].avgPnlPct += t.pnlPct;
  }
  for (const k of Object.keys(byEngine)) {
    byEngine[k].avgPnlPct /= byEngine[k].count;
  }

  const byExitReason: Record<string, number> = {};
  for (const t of trades) {
    byExitReason[t.exitReason] = (byExitReason[t.exitReason] ?? 0) + 1;
  }

  const bySlStage: Record<string, number> = {};
  for (const t of trades) {
    const key = `stage_${t.slStage}`;
    bySlStage[key] = (bySlStage[key] ?? 0) + 1;
  }

  const byRegime: Record<string, { count: number; wins: number; winRate: number }> = {};
  for (const t of trades) {
    if (!byRegime[t.regimeAtEntry]) byRegime[t.regimeAtEntry] = { count: 0, wins: 0, winRate: 0 };
    byRegime[t.regimeAtEntry].count++;
    if (t.pnlPct > 0) byRegime[t.regimeAtEntry].wins++;
  }
  for (const k of Object.keys(byRegime)) {
    byRegime[k].winRate = byRegime[k].count > 0 ? byRegime[k].wins / byRegime[k].count : 0;
  }

  return {
    tradeCount: trades.length,
    winCount: wins.length,
    lossCount: losses.length,
    winRate: trades.length > 0 ? wins.length / trades.length : 0,
    avgPnlPct: trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length,
    avgWinPct: wins.length > 0 ? grossProfit / wins.length : 0,
    avgLossPct: losses.length > 0 ? -grossLoss / losses.length : 0,
    totalPnlPct: trades.reduce((s, t) => s + t.pnlPct, 0),
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    maxDrawdownPct: maxDd,
    avgHoldBars: trades.reduce((s, t) => s + t.holdBars, 0) / trades.length,
    avgMfePct: trades.reduce((s, t) => s + t.mfePct, 0) / trades.length,
    avgMaePct: trades.reduce((s, t) => s + Math.abs(t.maePct), 0) / trades.length,
    extensionProbability,
    mfePctP25: percentile(mfePcts, 0.25),
    mfePctP50: percentile(mfePcts, 0.50),
    mfePctP75: percentile(mfePcts, 0.75),
    mfePctP90: percentile(mfePcts, 0.90),
    maePctP25: percentile(maePcts, 0.25),
    maePctP50: percentile(maePcts, 0.50),
    maePctP75: percentile(maePcts, 0.75),
    maePctP90: percentile(maePcts, 0.90),
    barsToMfeP50: percentile(barsToMfe, 0.50),
    byEngine,
    byExitReason,
    bySlStage,
    byRegime,
  };
}

// ── Instrument family helper ───────────────────────────────────────────────────

function getInstrumentFamily(symbol: string): "crash" | "boom" | "volatility" {
  if (symbol.startsWith("CRASH")) return "crash";
  if (symbol.startsWith("BOOM")) return "boom";
  return "volatility";
}

// ── Open trade state ──────────────────────────────────────────────────────────

interface OpenTradeState {
  winner: EngineResult;
  entryBar: number;
  entryPrice: number;
  entryTs: number;
  regimeAtEntry: string;
  regimeConfidence: number;
  nativeScore: number;
  conflictResolution: string;
  tp: number;
  sl: number;
  originalSl: number;
  stage: 1 | 2 | 3;
  peakPrice: number;
  mfePct: number;
  maePct: number;
  mfePeakBar: number;
  beTriggeredBar: number;
  mfePctAtBreakeven: number;
  atr14AtEntry: number;
  instrumentFamily: "crash" | "boom" | "volatility";
  emaSlope: number;
  spikeCount4h: number;
  adverseCandleCount: number;
  tpPct: number;
  slOriginalPct: number;
  tpProgressAtBe: number;
}

// ── Simulation gap documentation ──────────────────────────────────────────────
// Flags fetched from DB at run start (same source as live allocator):
//   - killSwitchActive: read from platformState["kill_switch"]
//   - modeEnabled:      read from platformState prefix (same logic as allocateV3Signal)
//   - symbolEnabled:    read from platformState prefix_enabled_symbols list
// Computed from simulation state per bar:
//   - dailyLossLimitBreached:  derived from simClosedPnls (within last 24h of replay ts)
//   - weeklyLossLimitBreached: derived from simClosedPnls (within last 7d of replay ts)
// Remaining true simulation gaps (require live cross-symbol PnL, unavailable here):
//   - maxDrawdownBreached:     assumed false (no cross-symbol equity curve)
//   - correlatedFamilyCapBreached: assumed false (no cross-symbol state)
//   - maxOpenTrades: set to 1 (single-symbol backtest; no cross-symbol tracking)
// Score gate (gate 4) and one-per-symbol (gate 5) are fully simulated.

// ── Core simulation loop ──────────────────────────────────────────────────────

export async function runV3Backtest(req: V3BacktestRequest): Promise<V3BacktestResult> {
  const now = Math.floor(Date.now() / 1000);
  const startTs = req.startTs ?? (now - 90 * 86400);
  const endTs = req.endTs ?? now;
  const symbol = req.symbol;
  const mode = req.mode ?? "paper";

  const bufferStartTs = startTs - STRUCTURAL_LOOKBACK * 60;

  const rawCandles = await db.select({
    open: candlesTable.open,
    high: candlesTable.high,
    low: candlesTable.low,
    close: candlesTable.close,
    openTs: candlesTable.openTs,
    closeTs: candlesTable.closeTs,
  }).from(candlesTable)
    .where(
      and(
        eq(candlesTable.symbol, symbol),
        eq(candlesTable.timeframe, "1m"),
        gte(candlesTable.openTs, bufferStartTs),
        lte(candlesTable.openTs, endTs)
      )
    )
    .orderBy(asc(candlesTable.openTs));

  if (rawCandles.length < 60) {
    return {
      symbol, mode, startTs, endTs, totalBars: 0,
      modeScoreGate: req.minScore ?? MODE_SCORE_GATES[mode] ?? 60,
      signalsFired: 0, signalsBlocked: 0, blockedRate: 0,
      trades: [], simulationGaps: [], summary: computeSummary([], {}),
    };
  }

  const candles = rawCandles as CandleRow[];

  let simStart = candles.findIndex(c => c.openTs >= startTs);
  if (simStart < 0) simStart = candles.length - 1;
  if (simStart < STRUCTURAL_LOOKBACK) simStart = STRUCTURAL_LOOKBACK;

  // ── Fetch platformState flags (same source as live allocator) ─────────────
  // Reads the exact same keys that portfolioAllocatorV3.allocateV3Signal reads.
  // Kill switch, mode-enabled, and symbol-enabled flags are NOT hardcoded.
  const platformRows = await db.select().from(platformStateTable);
  const stateMap: Record<string, string> = {};
  for (const r of platformRows) stateMap[r.key] = r.value;

  // ── Platform flag derivation — identical logic to portfolioAllocatorV3 ──────
  // Must use the same key names and same boolean evaluation so that backtest
  // and live can never diverge on mode/symbol/kill-switch admission.
  const modePrefix = { paper: "paper", demo: "demo", real: "real" }[mode] ?? "paper";

  // ── Min score gate — identical precedence to allocateV3Signal ────────────────
  // Live allocator reads: stateMap[`${prefix}_min_composite_score`] ??
  //                       stateMap["min_composite_score"] ?? MODE_SCORE_GATES[mode]
  // req.minScore acts as a caller override (used by tests/UI when specified).
  const modeDefaultGate = MODE_SCORE_GATES[mode] ?? 60;
  const gateFomState    = stateMap[`${modePrefix}_min_composite_score`] || stateMap["min_composite_score"];
  const modeGate        = req.minScore ?? (gateFomState ? parseFloat(gateFomState) : modeDefaultGate);

  const killSwitchActive = stateMap["kill_switch"] === "true";
  const modeEnabled =
    stateMap[`${modePrefix}_mode_active`] === "true" ||
    stateMap[`${modePrefix}_mode`] === "active" ||
    stateMap[`${modePrefix}_enabled`] === "true";
  const modeSymbolsRaw = stateMap[`${modePrefix}_enabled_symbols`] || stateMap["enabled_symbols"] || "";
  const modeSymbols = modeSymbolsRaw ? modeSymbolsRaw.split(",").map(s => s.trim()).filter(Boolean) : null;
  const symbolEnabled = !modeSymbols || modeSymbols.includes(symbol);

  const instrumentFamily = getInstrumentFamily(symbol);
  const htfMins = getSymbolIndicatorTimeframeMins(symbol);
  const indicatorLookback = 55 * htfMins;

  const trades: V3BacktestTrade[] = [];
  let openTrade: OpenTradeState | null = null;
  const featureHistory: FeatureSample[] = [];
  let signalsFired = 0;
  let signalsBlocked = 0;
  const blockedByEngine: Record<string, number> = {};

  // ── Simulation PnL state — used to evaluate daily/weekly risk gates ─────────
  // Tracks closed simulation trades with their close timestamp and $ PnL so
  // that dailyLossLimitBreached and weeklyLossLimitBreached are computed from
  // replay state rather than assumed false.
  const simClosedPnls: Array<{ closeTs: number; pnlUsd: number }> = [];
  const maxDailyLossPct  = parseFloat(stateMap[`${modePrefix}_max_daily_loss_pct`] || stateMap["max_daily_loss_pct"] || "5") / 100;
  const maxWeeklyLossPct = parseFloat(stateMap[`${modePrefix}_max_weekly_loss_pct`] || stateMap["max_weekly_loss_pct"] || "10") / 100;

  // ── Running equity curve — used to compute maxDrawdownBreached per bar ───────
  // Normalized to 1.0 start. Updated whenever a trade closes so each new entry
  // evaluation sees the current drawdown level (not assumed false).
  let simEquity     = 1.0;
  let simEquityPeak = 1.0;
  const maxDrawdownThresholdPct = parseFloat(
    stateMap[`${modePrefix}_max_drawdown_pct`] || stateMap["max_drawdown_pct"] || "20"
  ) / 100;

  if (mode === "real") {
    console.error(
      `[BacktestRunner] REAL-MODE PARITY WARNING: ${symbol} backtest cannot achieve full ` +
      `allocator parity — cross-symbol portfolio state (correlatedFamilyCapBreached, ` +
      `multi-symbol equity curve) is unavailable in single-symbol replay. ` +
      `Results are directionally valid but NOT safe for real-mode deployment decisions.`
    );
  }

  // ── Simulation parity gaps carried in the response ────────────────────────
  // maxDrawdownBreached: now computed from running single-symbol equity (not assumed false)
  // correlatedFamilyCapBreached: provably false in single-symbol replay (no other symbols)
  // maxOpenTrades: single-symbol sim always uses 1 — real setting may differ
  const runSimulationGaps: string[] = [
    "correlatedFamilyCapBreached=always_false(single_symbol_no_correlated_positions)",
    "maxOpenTrades=1(single_symbol_sim_not_actual_platform_limit)",
  ];
  console.warn(
    `[BacktestRunner] SIMULATION PARITY GAPS for ${symbol} (${mode}): ` +
    runSimulationGaps.join("; ")
  );

  for (let i = simStart; i < candles.length; i++) {
    const sliceStart = Math.max(0, i - STRUCTURAL_LOOKBACK + 1);
    const slice = candles.slice(sliceStart, i + 1);
    const bar = candles[i];

    // ── Manage open trade ─────────────────────────────────────────────────
    if (openTrade !== null) {
      const dir = openTrade.winner.direction;
      const ep = openTrade.entryPrice;
      const holdBars = i - openTrade.entryBar;

      // ── Shared bar-state transitions (peak tracking, MFE/MAE, BE, trailing) ──
      // Uses applyBarStateTransitions from tradeManagement.ts — identical logic
      // consumed by both live manageOpenPositions and historical replay.
      const prevPeakPrice = openTrade.peakPrice;
      const barState = applyBarStateTransitions({
        direction: dir,
        entryPrice: ep,
        tp: openTrade.tp,
        barHigh: bar.high,
        barLow: bar.low,
        barClose: bar.close,
        barOpen: bar.open,
        stage: openTrade.stage,
        sl: openTrade.sl,
        peakPrice: openTrade.peakPrice,
        mfePct: openTrade.mfePct,
        maePct: openTrade.maePct,
        adverseCandleCount: openTrade.adverseCandleCount,
        atr14AtEntry: openTrade.atr14AtEntry,
        instrumentFamily: openTrade.instrumentFamily,
        emaSlope: openTrade.emaSlope,
        spikeCount4h: openTrade.spikeCount4h,
      });

      openTrade.sl               = barState.sl;
      openTrade.stage            = barState.stage;
      openTrade.peakPrice        = barState.peakPrice;
      openTrade.mfePct           = barState.mfePct;
      openTrade.maePct           = barState.maePct;
      openTrade.adverseCandleCount = barState.adverseCandleCount;
      if (barState.peakPrice !== prevPeakPrice) openTrade.mfePeakBar = i;

      if (barState.bePromoted) {
        openTrade.mfePctAtBreakeven = barState.mfePctAtPromotion;
        openTrade.beTriggeredBar    = i;
        openTrade.tpProgressAtBe    = barState.tpProgressAtBe;
        recordBehaviorEvent({
          eventType: "breakeven_promoted",
          symbol,
          engineName: openTrade.winner.engineName,
          direction: dir,
          holdBarsAtPromotion: holdBars,
          mfePctAtPromotion: barState.mfePctAtPromotion,
          tpProgressAtPromotion: barState.tpProgressAtBe,
          ts: bar.closeTs,
        });
      }

      if (barState.trailingActivated) {
        recordBehaviorEvent({
          eventType: "trailing_activated",
          symbol,
          engineName: openTrade.winner.engineName,
          direction: dir,
          holdBarsAtActivation: holdBars,
          mfePctAtActivation: barState.mfePct,
          tpProgressAtActivation: barState.tpProgressAtTrailing,
          ts: bar.closeTs,
        });
      }

      // ── Exit checks — uses shared evaluateBarExits (SL checked BEFORE TP) ──
      // SL-first priority matches live manageOpenPositions (eliminates same-bar
      // divergence where backtest used TP-first, live uses SL-first).
      const barExit = evaluateBarExits({
        direction: dir,
        barHigh: bar.high,
        barLow: bar.low,
        barClose: bar.close,
        tp: openTrade.tp,
        sl: openTrade.sl,
      });

      let exitReason: V3BacktestTrade["exitReason"] | null = barExit.exitReason;
      let exitPrice = barExit.exitPrice;

      // Max duration — shared MAX_HOLD_MINS from tradeManagement.ts
      // For 1m bars holdBars === holdMins; MAX_HOLD_MINS applies directly
      if (!exitReason && holdBars >= MAX_HOLD_MINS) {
        exitReason = "max_duration";
        exitPrice = bar.close;
      }

      if (exitReason) {
        const finalPnl = dir === "buy"
          ? (exitPrice - ep) / ep
          : (ep - exitPrice) / ep;

        const barsToMfe = openTrade.mfePeakBar > openTrade.entryBar
          ? openTrade.mfePeakBar - openTrade.entryBar
          : holdBars;
        const barsToBreakeven = openTrade.beTriggeredBar > 0
          ? openTrade.beTriggeredBar - openTrade.entryBar
          : 0;

        const trade: V3BacktestTrade = {
          entryTs: openTrade.entryTs,
          exitTs: bar.closeTs,
          symbol,
          direction: dir,
          engineName: openTrade.winner.engineName,
          entryType: openTrade.winner.entryType,
          entryPrice: ep,
          exitPrice,
          exitReason,
          slStage: openTrade.stage,
          projectedMovePct: openTrade.winner.projectedMovePct,
          nativeScore: openTrade.nativeScore,
          regimeAtEntry: openTrade.regimeAtEntry,
          regimeConfidence: openTrade.regimeConfidence,
          holdBars,
          barsToMfe,
          barsToBreakeven,
          pnlPct: finalPnl,
          mfePct: openTrade.mfePct,
          maePct: openTrade.maePct,
          tpPct: openTrade.tpPct,
          slPct: openTrade.slOriginalPct,
          conflictResolution: openTrade.conflictResolution,
          modeGateApplied: modeGate,
        };

        trades.push(trade);

        // Track closed trade PnL for daily/weekly loss limit gates
        // bar.closeTs is unix epoch SECONDS — multiply by 1000 to store as ms
        simClosedPnls.push({
          closeTs: bar.closeTs * 1000,
          pnlUsd: finalPnl * SYNTHETIC_SIZE,
        });

        // Update running equity curve for maxDrawdownBreached gate
        simEquity *= (1 + finalPnl);
        if (simEquity > simEquityPeak) simEquityPeak = simEquity;

        // Closed event for behavior profiler
        const closedEvent: ClosedEvent = {
          eventType: "closed",
          symbol,
          engineName: openTrade.winner.engineName,
          entryType: openTrade.winner.entryType,
          direction: dir,
          regimeAtEntry: openTrade.regimeAtEntry,
          regimeConfidence: openTrade.regimeConfidence,
          nativeScore: openTrade.nativeScore,
          projectedMovePct: openTrade.winner.projectedMovePct,
          entryTs: openTrade.entryTs,
          exitTs: bar.closeTs,
          holdBars,
          pnlPct: finalPnl,
          mfePct: openTrade.mfePct,
          maePct: openTrade.maePct,
          mfePctAtBreakeven: openTrade.mfePctAtBreakeven,
          barsToMfe,
          barsToBreakeven,
          exitReason,
          slStage: openTrade.stage,
          conflictResolution: openTrade.conflictResolution,
          source: "backtest",
        };
        recordBehaviorEvent(closedEvent);

        openTrade = null;
      }

      if (openTrade !== null) continue;
    }

    // ── Signal scan (only when no open trade) ─────────────────────────────
    if (slice.length < Math.max(60, Math.ceil(indicatorLookback / 60))) continue;

    const features = computeFeaturesFromSlice(symbol, slice);
    if (!features) continue;

    // Accumulate feature sample for HTF regime averaging (matches live accumulateHourlyFeatures)
    featureHistory.push({
      emaSlope: features.emaSlope,
      rsi14: features.rsi14,
      bbWidth: features.bbWidth,
      bbWidthRoc: features.bbWidthRoc,
      atr14: features.atr14,
      atrRank: features.atrRank,
      atrAccel: features.atrAccel,
      zScore: features.zScore,
      spikeHazardScore: features.spikeHazardScore,
      bbPctB: features.bbPctB,
    });
    if (featureHistory.length > HTF_AVERAGING_WINDOW) featureHistory.shift();

    // HTF-averaged regime — uses shared classifyRegimeFromSamples from regimeEngine.ts
    // This is the SAME function classifyRegimeFromHTF uses internally (live path).
    // Both paths now share identical averaging logic over their respective sample buffers.
    const regimeResult = classifyRegimeFromSamples(features, featureHistory);

    // ── Engine evaluation + coordinator — shared pipeline ────────────────────
    // runEnginesAndCoordinate is the exact same function used by engineRouterV3
    // (live scanner). Both paths share identical engine logic and coordinator
    // conflict resolution from this point forward.
    let engineResults: EngineResult[];
    let coordinatorOutput: ReturnType<typeof runEnginesAndCoordinate>["coordinatorOutput"];
    try {
      const pipelineResult = runEnginesAndCoordinate({
        symbol,
        features,
        operationalRegime: regimeResult.regime,
        regimeConfidence: regimeResult.confidence,
      });
      engineResults = pipelineResult.engineResults;
      coordinatorOutput = pipelineResult.coordinatorOutput;
    } catch {
      continue;
    }

    if (engineResults.length === 0 || !coordinatorOutput) continue;

    const { winner, conflictResolution, coordinatorConfidence } = coordinatorOutput;
    const nativeScore = extractNativeScore(winner, coordinatorConfidence);

    // Record signal_fired event (all coordinator outputs, regardless of gate)
    signalsFired++;
    recordBehaviorEvent({
      eventType: "signal_fired",
      symbol,
      engineName: winner.engineName,
      entryType: winner.entryType,
      direction: winner.direction,
      regimeAtEntry: regimeResult.regime,
      regimeConfidence: regimeResult.confidence,
      nativeScore,
      projectedMovePct: winner.projectedMovePct,
      ts: bar.closeTs,
      conflictResolution,
    });

    // ── Shared admission evaluator (same logic as portfolioAllocatorV3) ─────
    // killSwitchActive, modeEnabled, symbolEnabled come from real platformState.
    // dailyLossLimitBreached and weeklyLossLimitBreached are computed from the
    // simulation's own accumulated closed-trade PnL so that risk gates fire
    // correctly during replay (no longer assumed false).
    // bar.closeTs is unix epoch SECONDS — convert to ms for window comparisons
    const nowTs        = bar.closeTs * 1000;
    const dayStartTs   = nowTs - 86_400_000;
    const weekStartTs  = nowTs - 7 * 86_400_000;
    const dailyLossUsd  = simClosedPnls.filter(p => p.closeTs >= dayStartTs).reduce((s, p) => s + p.pnlUsd, 0);
    const weeklyLossUsd = simClosedPnls.filter(p => p.closeTs >= weekStartTs).reduce((s, p) => s + p.pnlUsd, 0);
    const dailyLossLimitBreached  = dailyLossUsd  < -(maxDailyLossPct  * SYNTHETIC_SIZE);
    const weeklyLossLimitBreached = weeklyLossUsd < -(maxWeeklyLossPct * SYNTHETIC_SIZE);

    // Drawdown gate: derived from the running single-symbol normalized equity curve.
    // Computed fresh each bar from closed trades — same approach as dailyLossLimitBreached.
    const currentDrawdownPct = simEquityPeak > 0 ? (simEquityPeak - simEquity) / simEquityPeak : 0;
    const maxDrawdownBreached = currentDrawdownPct >= maxDrawdownThresholdPct;

    const simulationGaps = [
      "maxOpenTrades=1(single_symbol_sim)",
      "correlatedFamilyCapBreached=always_false(single_symbol_no_correlated_positions)",
    ];
    const allocResult = evaluateSignalAdmission({
      symbol,
      engineName: winner.engineName,
      direction: winner.direction,
      nativeScore,
      confidence: winner.confidence,
      mode,
      minScoreGate: modeGate,
      killSwitchActive,   // real: from platformState["kill_switch"]
      modeEnabled,        // real: from platformState prefix keys
      symbolEnabled,      // real: from platformState prefix_enabled_symbols
      openTradeForSymbol: openTrade !== null,
      currentOpenCount: openTrade !== null ? 1 : 0,
      maxOpenTrades: 1,                  // gap: single-symbol sim
      dailyLossLimitBreached,            // computed from simulation trades
      weeklyLossLimitBreached,           // computed from simulation trades
      maxDrawdownBreached,               // computed from running single-symbol equity curve
      correlatedFamilyCapBreached: false,// provably false: no correlated symbols in single-symbol sim
      simulationDefaults: simulationGaps,
    });

    if (!allocResult.allowed) {
      // Record blocked_by_gate event for ALL allocator rejection stages so the
      // behavior lifecycle profiler has complete signal-blocked coverage.
      // Stage 4 = score gate (signal quality gate, counted in signalsBlocked)
      // Stage 5 = symbol already open (trade management gate, not a signal block)
      // Other stages = platform / risk gates (kill switch, mode, daily/weekly loss, etc.)
      const isSignalQualityBlock = allocResult.rejectionStage === 4;
      const isTradeManagementBlock = allocResult.rejectionStage === 5;
      if (!isTradeManagementBlock) {
        // Count as "blocked" for all non-symbol-already-open rejections
        signalsBlocked++;
        blockedByEngine[winner.engineName] = (blockedByEngine[winner.engineName] ?? 0) + 1;
      }
      // Capture behavior event for ALL rejections (incl. platform gates and trade mgmt)
      // so profiler has full lifecycle visibility
      recordBehaviorEvent({
        eventType: "blocked_by_gate",
        symbol,
        engineName: winner.engineName,
        direction: winner.direction,
        regimeAtEntry: regimeResult.regime,
        nativeScore,
        modeGate,
        mode,
        ts: bar.closeTs,
        rejectionStage: allocResult.rejectionStage ?? undefined,
        rejectionReason: allocResult.rejectionReason ?? `stage${allocResult.rejectionStage ?? 0}`,
        isSignalQualityBlock,
      });
      continue;
    }

    // ── SR/Fib TP (exact live calculateSRFibTP) ──────────────────────────
    const tp = calculateSRFibTP({
      entryPrice: bar.close,
      direction: winner.direction,
      swingHigh: features.swingHigh,
      swingLow: features.swingLow,
      majorSwingHigh: features.majorSwingHigh,
      majorSwingLow: features.majorSwingLow,
      fibExtensionLevels: features.fibExtensionLevels ?? [],
      fibExtensionLevelsDown: features.fibExtensionLevelsDown ?? [],
      bbUpper: features.bbUpper,
      bbLower: features.bbLower,
      atrPct: features.atr14,
      pivotLevels: [
        features.pivotR1, features.pivotR2, features.pivotS1, features.pivotS2,
      ].filter((v): v is number => typeof v === "number"),
      vwap: features.vwap,
      psychRound: features.psychRound,
      prevSessionHigh: features.prevSessionHigh,
      prevSessionLow: features.prevSessionLow,
      spikeMagnitude: features.spikeMagnitude,
    });

    if (!isFinite(tp) || tp <= 0) continue;
    if (winner.direction === "buy" && tp <= bar.close) continue;
    if (winner.direction === "sell" && tp >= bar.close) continue;

    // ── SR/Fib SL at 1:5 RR (exact live calculateSRFibSL) ───────────────
    const sl = calculateSRFibSL({
      entryPrice: bar.close,
      direction: winner.direction,
      tp,
      positionSize: SYNTHETIC_SIZE,
      equity: SYNTHETIC_EQUITY,
    });

    if (!isFinite(sl) || sl <= 0) continue;

    const tpPct = Math.abs(tp - bar.close) / bar.close;
    const slOriginalPct = Math.abs(sl - bar.close) / bar.close;

    // Record entry event
    recordBehaviorEvent({
      eventType: "entered",
      symbol,
      engineName: winner.engineName,
      entryType: winner.entryType,
      direction: winner.direction,
      regimeAtEntry: regimeResult.regime,
      regimeConfidence: regimeResult.confidence,
      nativeScore,
      projectedMovePct: winner.projectedMovePct,
      entryTs: bar.closeTs,
      tpPct,
      slPct: slOriginalPct,
    });

    openTrade = {
      winner,
      entryBar: i,
      entryPrice: bar.close,
      entryTs: bar.closeTs,
      regimeAtEntry: regimeResult.regime,
      regimeConfidence: regimeResult.confidence,
      nativeScore,
      conflictResolution,
      tp,
      sl,
      originalSl: sl,
      stage: 1,
      peakPrice: bar.close,
      mfePct: 0,
      maePct: 0,
      mfePeakBar: i,
      beTriggeredBar: 0,
      mfePctAtBreakeven: 0,
      atr14AtEntry: Math.max(features.atr14, 0.001),
      instrumentFamily,
      emaSlope: features.emaSlope,
      spikeCount4h: features.spikeCount4h ?? 0,
      adverseCandleCount: 0,
      tpPct,
      slOriginalPct,
      tpProgressAtBe: 0,
    };
  }

  const barsInRange = Math.max(0, candles.length - simStart);
  const blockedRate = signalsFired > 0 ? signalsBlocked / signalsFired : 0;

  return {
    symbol,
    mode,
    startTs,
    endTs,
    totalBars: barsInRange,
    modeScoreGate: modeGate,
    signalsFired,
    signalsBlocked,
    blockedRate,
    trades,
    simulationGaps: runSimulationGaps,
    summary: computeSummary(trades, blockedByEngine),
  };
}

/**
 * Run V3 backtest across multiple symbols concurrently.
 */
export async function runV3BacktestMulti(
  symbols: string[],
  startTs?: number,
  endTs?: number,
  minScore?: number,
  mode?: "paper" | "demo" | "real",
): Promise<Record<string, V3BacktestResult>> {
  const results = await Promise.all(
    symbols.map(sym => runV3Backtest({ symbol: sym, startTs, endTs, minScore, mode }))
  );

  const out: Record<string, V3BacktestResult> = {};
  for (let i = 0; i < symbols.length; i++) {
    out[symbols[i]] = results[i];
  }
  return out;
}
