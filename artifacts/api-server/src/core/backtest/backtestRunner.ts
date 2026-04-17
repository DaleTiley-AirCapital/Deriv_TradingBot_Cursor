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
import { getModeCapitalKey, getModeCapitalDefault } from "../../infrastructure/deriv.js";

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

// ── Per-symbol context for synchronized multi-symbol replay ──────────────────

interface SymCtx {
  sym: string;
  instrumentFamily: "crash" | "boom" | "volatility";
  candles: CandleRow[];
  idxByTs: Map<number, number>;   // closeTs (epoch seconds) → array index
  simStart: number;               // first index inside sim range

  // Shared platform state (derived once for all symbols)
  mode: string;
  modeGate: number;
  killSwitchActive: boolean;
  modeEnabled: boolean;
  symbolEnabled: boolean;
  maxOpenTrades: number;
  totalCapital: number;
  maxDailyLossPct: number;
  maxWeeklyLossPct: number;
  maxDrawdownThresholdPct: number;

  // HTF regime sample buffer (per-symbol; must not be shared)
  featureHistory: FeatureSample[];

  // Runtime simulation state
  openTrade: OpenTradeState | null;
  simEquity: number;
  simEquityPeak: number;
  simClosedPnls: Array<{ closeTs: number; pnlUsd: number }>;
  trades: V3BacktestTrade[];
  signalsFired: number;
  signalsBlocked: number;
  blockedByEngine: Record<string, number>;
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

// ── Shared portfolio ledger for synchronized multi-symbol replay ─────────────
//
// Tracks ALL open positions across symbols in time order. Used by
// runV3BacktestMulti so gates 6 (maxOpenTrades) and 10 (correlatedFamilyCap)
// are evaluated with real cross-symbol portfolio state — the same semantics
// as the live portfolioAllocatorV3 path.
//
// Positions are recorded by the timestamp of the bar that opened/closed them,
// enabling correct portfolio-state queries at any bar time T regardless of
// the order in which symbols are replayed.

export class SharedPortfolioLedger {
  private history: Array<{
    symbol: string;
    family: string;
    openTs: number;    // bar closeTs (ms) when position was opened
    closeTs: number;   // bar closeTs (ms) when position was closed; Infinity = still open
  }> = [];
  private openBySymbol = new Map<string, string>(); // symbol → family, for open positions

  /** Record a new position opening. openTs is the bar closeTs in ms. */
  open(symbol: string, family: string, openTs: number): void {
    this.history.push({ symbol, family, openTs, closeTs: Infinity });
    this.openBySymbol.set(symbol, family);
  }

  /** Record a position closing. closeTs is the bar closeTs in ms. */
  close(symbol: string, closeTs: number): void {
    const pos = [...this.history].reverse().find(p => p.symbol === symbol && p.closeTs === Infinity);
    if (pos) pos.closeTs = closeTs;
    this.openBySymbol.delete(symbol);
  }

  /** Count of positions open at bar time T (inclusive). */
  getOpenCount(atTs: number): number {
    return this.history.filter(p => p.openTs <= atTs && p.closeTs > atTs).length;
  }

  /** Count of positions in a given instrument family that are open at bar time T. */
  getFamilyOpenCount(family: string, atTs: number): number {
    return this.history.filter(p => p.family === family && p.openTs <= atTs && p.closeTs > atTs).length;
  }

  /** True if the given symbol has an open position at bar time T. */
  isSymbolOpen(symbol: string, atTs: number): boolean {
    return this.history.some(p => p.symbol === symbol && p.openTs <= atTs && p.closeTs > atTs);
  }
}

// ── Core simulation loop ──────────────────────────────────────────────────────

export async function runV3Backtest(
  req: V3BacktestRequest,
  sharedLedger?: SharedPortfolioLedger,
): Promise<V3BacktestResult> {
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

  // ── Backtest isolation behavior ──────────────────────────────────────────────
  // Backtest should replay entry/exit quality logic without being blocked by
  // live runtime toggles (kill switch/mode active/symbol enabled), otherwise
  // it can return 0 trades simply because runtime mode is OFF.
  const modePrefix = { paper: "paper", demo: "demo", real: "real" }[mode] ?? "paper";

  // ── Min score gate — identical precedence to allocateV3Signal ────────────────
  // Live allocator reads: stateMap[`${prefix}_min_composite_score`] ??
  //                       stateMap["min_composite_score"] ?? MODE_SCORE_GATES[mode]
  // req.minScore acts as a caller override (used by tests/UI when specified).
  const modeDefaultGate = MODE_SCORE_GATES[mode] ?? 60;
  const gateFomState    = stateMap[`${modePrefix}_min_composite_score`] || stateMap["min_composite_score"];
  const modeGate        = req.minScore ?? (gateFomState ? parseFloat(gateFomState) : modeDefaultGate);

  const killSwitchActive = false;
  const modeEnabled = true;
  const symbolEnabled = true;

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

  // totalCapital: read from platformState using same key/default as live allocator
  // (portfolioAllocatorV3.ts getModeCapitalKey/getModeCapitalDefault).
  // Loss limits are expressed as a % of total capital — using SYNTHETIC_SIZE (~1500)
  // instead would cause gates to trigger at a completely different threshold.
  const capitalKey = getModeCapitalKey(mode as "paper" | "demo" | "real");
  const capitalDefault = getModeCapitalDefault(mode as "paper" | "demo" | "real");
  const totalCapital = Math.max(1, parseFloat(stateMap[capitalKey] || stateMap["total_capital"] || capitalDefault));

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

  // maxOpenTrades: read from platformState (same key/default as live portfolioAllocatorV3).
  // In a single-symbol replay, currentOpenCount is 0 or 1 — this gate only fires if the
  // platform is configured for maxOpenTrades=1, which is a deliberate operator choice.
  const maxOpenTrades = parseInt(
    stateMap[`${modePrefix}_max_open_trades`] || stateMap["max_open_trades"] || "3"
  );

  // ── Simulation parity gaps carried in the response ────────────────────────
  // - maxDrawdownBreached: computed from running single-symbol equity (not assumed false)
  // - dailyLossLimitBreached/weeklyLossLimitBreached: computed from sim PnLs w/ real totalCapital
  // - maxOpenTrades: read from platformState (same formula as live allocator)
  // - correlatedFamilyCapBreached: always false — IDENTICAL to live allocator (portfolioAllocatorV3.ts:119)
  //   The live path also hardcodes this to false; no gap exists between live and backtest here.
  // REMAINING TRUE GAP: single-symbol replay cannot model cross-symbol portfolio state.
  // (multi-symbol concurrent positions, correlated family exposure from other symbols)
  const runSimulationGaps: string[] = [
    "cross_symbol_portfolio_state_unavailable(single_symbol_replay_cannot_model_concurrent_positions_in_other_symbols)",
  ];

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

        // Update shared ledger so other symbols see this close in their replay
        if (sharedLedger) sharedLedger.close(symbol, bar.closeTs * 1000);
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
    // Mirror live portfolioAllocatorV3 formula: loss gates use totalCapital as denominator
    const dailyLossLimitBreached  = dailyLossUsd  < 0 && Math.abs(dailyLossUsd)  / totalCapital >= maxDailyLossPct;
    const weeklyLossLimitBreached = weeklyLossUsd < 0 && Math.abs(weeklyLossUsd) / totalCapital >= maxWeeklyLossPct;

    // Drawdown gate: derived from the running single-symbol normalized equity curve.
    // Computed fresh each bar from closed trades — same approach as dailyLossLimitBreached.
    const currentDrawdownPct = simEquityPeak > 0 ? (simEquityPeak - simEquity) / simEquityPeak : 0;
    const maxDrawdownBreached = currentDrawdownPct >= maxDrawdownThresholdPct;

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
      // When a shared ledger is provided (multi-symbol run), use it for cross-symbol
      // portfolio state — this gives gates 6 and 10 the same semantics as live.
      // Without a ledger (single-symbol run), fall back to local-only state.
      openTradeForSymbol: sharedLedger
        ? sharedLedger.isSymbolOpen(symbol, bar.closeTs * 1000)
        : openTrade !== null,
      currentOpenCount: sharedLedger
        ? sharedLedger.getOpenCount(bar.closeTs * 1000)
        : (openTrade !== null ? 1 : 0),
      maxOpenTrades,                     // from platformState — same formula as live allocator
      dailyLossLimitBreached,            // computed from simulation trades + real totalCapital
      weeklyLossLimitBreached,           // computed from simulation trades + real totalCapital
      maxDrawdownBreached,               // computed from running single-symbol equity curve
      // correlatedFamilyCapBreached: false — identical to live portfolioAllocatorV3 (line 119).
      // Live also hardcodes this to false, so backtest=false IS correct parity.
      // With a shared ledger, cross-symbol open count (gate 6) already enforces the
      // multi-symbol limit, so family-cap is an additive concern, not a parity gap.
      correlatedFamilyCapBreached: false,
      simulationDefaults: sharedLedger ? [] : runSimulationGaps,
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

    // Register opening in shared ledger so concurrent symbols see this position
    if (sharedLedger) sharedLedger.open(symbol, instrumentFamily, bar.closeTs * 1000);
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
 * Run V3 backtest across multiple symbols using a time-synchronized event loop.
 *
 * ── Synchronization guarantee ────────────────────────────────────────────────
 * All symbols share a single global bar clock (sorted union of all closeTs values).
 * At each timestamp T the loop processes two phases in strict order:
 *
 *   1. EXIT PHASE  — apply state transitions and check SL/TP/timeout for every
 *      symbol that has an open position at T.  Positions that close at T are
 *      removed from the shared ledger before the entry phase begins.
 *
 *   2. ENTRY PHASE — evaluate new entries for every symbol that has no open
 *      position at T.  Admission gates (maxOpenTrades, one-per-symbol) query
 *      the shared ledger which already reflects all exits at T, so the cross-
 *      symbol portfolio state is always correct at the moment of evaluation.
 *
 * This eliminates the order-bias of sequential-per-symbol replay, where symbol A
 * was simulated without any knowledge of symbol B's positions, and symbol B then
 * saw symbol A's complete future history.
 */
export async function runV3BacktestMulti(
  symbols: string[],
  startTs?: number,
  endTs?: number,
  minScore?: number,
  mode?: "paper" | "demo" | "real",
): Promise<Record<string, V3BacktestResult>> {
  if (symbols.length <= 1) {
    const result = await runV3Backtest({ symbol: symbols[0] ?? "", startTs, endTs, minScore, mode });
    return symbols[0] ? { [symbols[0]]: result } : {};
  }

  // ── Shared platform state (loaded once for all symbols) ──────────────────
  const now = Math.floor(Date.now() / 1000);
  const _startTs = startTs ?? (now - 90 * 86400);
  const _endTs   = endTs   ?? now;
  const _mode    = mode    ?? "paper";
  const modePrefix = { paper: "paper", demo: "demo", real: "real" }[_mode] ?? "paper";

  const platformRows = await db.select().from(platformStateTable);
  const stateMap: Record<string, string> = {};
  for (const r of platformRows) stateMap[r.key] = r.value;

  const gateFomState   = stateMap[`${modePrefix}_min_composite_score`] || stateMap["min_composite_score"];
  const sharedModeGate = minScore ?? (gateFomState ? parseFloat(gateFomState) : (MODE_SCORE_GATES[_mode] ?? 60));

  const sharedKillSwitch  = false;
  const sharedModeEnabled = true;

  const sharedMaxOpenTrades = parseInt(
    stateMap[`${modePrefix}_max_open_trades`] || stateMap["max_open_trades"] || "3", 10,
  );
  const capitalKey     = getModeCapitalKey(_mode as "paper" | "demo" | "real");
  const capitalDefault = getModeCapitalDefault(_mode as "paper" | "demo" | "real");
  const sharedCapital  = Math.max(1, parseFloat(stateMap[capitalKey] || stateMap["total_capital"] || capitalDefault));
  const sharedMaxDailyLoss   = parseFloat(stateMap[`${modePrefix}_max_daily_loss_pct`]   || stateMap["max_daily_loss_pct"]   || "5")  / 100;
  const sharedMaxWeeklyLoss  = parseFloat(stateMap[`${modePrefix}_max_weekly_loss_pct`]  || stateMap["max_weekly_loss_pct"]  || "10") / 100;
  const sharedMaxDrawdownPct = parseFloat(stateMap[`${modePrefix}_max_drawdown_pct`]     || stateMap["max_drawdown_pct"]     || "20") / 100;

  // ── Load candles for all symbols in parallel ─────────────────────────────
  const bufferStartTs = _startTs - STRUCTURAL_LOOKBACK * 60;
  const allCandleArrays = await Promise.all(
    symbols.map(sym =>
      db.select({
        open: candlesTable.open, high: candlesTable.high,
        low:  candlesTable.low,  close: candlesTable.close,
        openTs: candlesTable.openTs, closeTs: candlesTable.closeTs,
      }).from(candlesTable)
        .where(and(
          eq(candlesTable.symbol, sym),
          eq(candlesTable.timeframe, "1m"),
          gte(candlesTable.openTs, bufferStartTs),
          lte(candlesTable.openTs, _endTs),
        ))
        .orderBy(asc(candlesTable.openTs))
        .then(rows => rows as CandleRow[]),
    ),
  );

  // ── Build per-symbol contexts and global timestamp union ─────────────────
  const symCtxMap = new Map<string, SymCtx>();
  const allTs     = new Set<number>();

  for (let si = 0; si < symbols.length; si++) {
    const sym     = symbols[si]!;
    const candles = allCandleArrays[si]!;
    if (candles.length < 60) continue;

    let simStart = candles.findIndex(c => c.openTs >= _startTs);
    if (simStart < 0) simStart = candles.length - 1;
    if (simStart < STRUCTURAL_LOOKBACK) simStart = STRUCTURAL_LOOKBACK;

    const idxByTs = new Map<number, number>();
    for (let i = 0; i < candles.length; i++) {
      idxByTs.set(candles[i]!.closeTs, i);
      if (i >= simStart) allTs.add(candles[i]!.closeTs);
    }

    symCtxMap.set(sym, {
      sym,
      instrumentFamily:      getInstrumentFamily(sym),
      candles,
      idxByTs,
      simStart,
      mode:                   _mode,
      modeGate:               sharedModeGate,
      killSwitchActive:       sharedKillSwitch,
      modeEnabled:            sharedModeEnabled,
      symbolEnabled:          true,
      maxOpenTrades:          sharedMaxOpenTrades,
      totalCapital:           sharedCapital,
      maxDailyLossPct:        sharedMaxDailyLoss,
      maxWeeklyLossPct:       sharedMaxWeeklyLoss,
      maxDrawdownThresholdPct: sharedMaxDrawdownPct,
      featureHistory:         [],
      openTrade:              null,
      simEquity:              1.0,
      simEquityPeak:          1.0,
      simClosedPnls:          [],
      trades:                 [],
      signalsFired:           0,
      signalsBlocked:         0,
      blockedByEngine:        {},
    });
  }

  if (symCtxMap.size === 0) {
    const out: Record<string, V3BacktestResult> = {};
    for (const sym of symbols) {
      out[sym] = {
        symbol: sym, mode: _mode, startTs: _startTs, endTs: _endTs,
        totalBars: 0, modeScoreGate: sharedModeGate,
        signalsFired: 0, signalsBlocked: 0, blockedRate: 0,
        trades: [], simulationGaps: [], summary: computeSummary([], {}),
      };
    }
    return out;
  }

  // ── Shared portfolio ledger ───────────────────────────────────────────────
  const ledger = new SharedPortfolioLedger();

  // ── Global sorted timestamp list ─────────────────────────────────────────
  const globalTs = Array.from(allTs).sort((a, b) => a - b);

  // ── Time-synchronized event loop ─────────────────────────────────────────
  for (const ts of globalTs) {
    const tsMs = ts * 1000;

    // ════════════════════════════════════════════════════════════════════════
    // EXIT PHASE — apply state transitions + check SL/TP/timeout for all
    // open positions first.  Ledger updates (close) happen here so the entry
    // phase sees accurate open-count / symbol-open state.
    // ════════════════════════════════════════════════════════════════════════
    for (const ctx of symCtxMap.values()) {
      if (!ctx.openTrade) continue;
      const i = ctx.idxByTs.get(ts);
      if (i === undefined) continue;
      const bar = ctx.candles[i]!;
      const ot  = ctx.openTrade;
      const dir = ot.winner.direction;
      const ep  = ot.entryPrice;
      const holdBars    = i - ot.entryBar;
      const prevPeak    = ot.peakPrice;

      const barState = applyBarStateTransitions({
        direction: dir, entryPrice: ep, tp: ot.tp,
        barHigh: bar.high, barLow: bar.low, barClose: bar.close, barOpen: bar.open,
        stage: ot.stage, sl: ot.sl, peakPrice: ot.peakPrice,
        mfePct: ot.mfePct, maePct: ot.maePct, adverseCandleCount: ot.adverseCandleCount,
        atr14AtEntry: ot.atr14AtEntry, instrumentFamily: ot.instrumentFamily,
        emaSlope: ot.emaSlope, spikeCount4h: ot.spikeCount4h,
      });

      ot.sl                 = barState.sl;
      ot.stage              = barState.stage;
      ot.peakPrice          = barState.peakPrice;
      ot.mfePct             = barState.mfePct;
      ot.maePct             = barState.maePct;
      ot.adverseCandleCount = barState.adverseCandleCount;
      if (barState.peakPrice !== prevPeak) ot.mfePeakBar = i;

      if (barState.bePromoted) {
        ot.mfePctAtBreakeven = barState.mfePctAtPromotion;
        ot.beTriggeredBar    = i;
        ot.tpProgressAtBe    = barState.tpProgressAtBe;
        recordBehaviorEvent({
          eventType: "breakeven_promoted", symbol: ctx.sym,
          engineName: ot.winner.engineName, direction: dir,
          holdBarsAtPromotion: holdBars, mfePctAtPromotion: barState.mfePctAtPromotion,
          tpProgressAtPromotion: barState.tpProgressAtBe, ts: bar.closeTs,
        });
      }
      if (barState.trailingActivated) {
        recordBehaviorEvent({
          eventType: "trailing_activated", symbol: ctx.sym,
          engineName: ot.winner.engineName, direction: dir,
          holdBarsAtActivation: holdBars, mfePctAtActivation: barState.mfePct,
          tpProgressAtActivation: barState.tpProgressAtTrailing, ts: bar.closeTs,
        });
      }

      const barExit = evaluateBarExits({
        direction: dir, barHigh: bar.high, barLow: bar.low, barClose: bar.close,
        tp: ot.tp, sl: ot.sl,
      });
      let exitReason: V3BacktestTrade["exitReason"] | null = barExit.exitReason;
      let exitPrice = barExit.exitPrice;
      if (!exitReason && holdBars >= MAX_HOLD_MINS) {
        exitReason = "max_duration";
        exitPrice  = bar.close;
      }

      if (exitReason) {
        const finalPnl      = dir === "buy" ? (exitPrice - ep) / ep : (ep - exitPrice) / ep;
        const barsToMfe     = ot.mfePeakBar > ot.entryBar ? ot.mfePeakBar - ot.entryBar : holdBars;
        const barsToBreakeven = ot.beTriggeredBar > 0 ? ot.beTriggeredBar - ot.entryBar : 0;

        ctx.trades.push({
          entryTs: ot.entryTs, exitTs: bar.closeTs, symbol: ctx.sym,
          direction: dir, engineName: ot.winner.engineName, entryType: ot.winner.entryType,
          entryPrice: ep, exitPrice, exitReason, slStage: ot.stage,
          projectedMovePct: ot.winner.projectedMovePct, nativeScore: ot.nativeScore,
          regimeAtEntry: ot.regimeAtEntry, regimeConfidence: ot.regimeConfidence,
          holdBars, barsToMfe, barsToBreakeven, pnlPct: finalPnl,
          mfePct: ot.mfePct, maePct: ot.maePct, tpPct: ot.tpPct, slPct: ot.slOriginalPct,
          conflictResolution: ot.conflictResolution, modeGateApplied: ctx.modeGate,
        });
        ctx.simClosedPnls.push({ closeTs: tsMs, pnlUsd: finalPnl * SYNTHETIC_SIZE });
        ctx.simEquity *= (1 + finalPnl);
        if (ctx.simEquity > ctx.simEquityPeak) ctx.simEquityPeak = ctx.simEquity;

        recordBehaviorEvent({
          eventType: "closed", symbol: ctx.sym, engineName: ot.winner.engineName,
          entryType: ot.winner.entryType, direction: dir,
          regimeAtEntry: ot.regimeAtEntry, regimeConfidence: ot.regimeConfidence,
          nativeScore: ot.nativeScore, projectedMovePct: ot.winner.projectedMovePct,
          entryTs: ot.entryTs, exitTs: bar.closeTs, holdBars,
          pnlPct: finalPnl, mfePct: ot.mfePct, maePct: ot.maePct,
          mfePctAtBreakeven: ot.mfePctAtBreakeven,
          barsToMfe, barsToBreakeven, exitReason, slStage: ot.stage,
          conflictResolution: ot.conflictResolution, source: "backtest",
        } as ClosedEvent);

        // Ledger close BEFORE entry phase so the released slot is visible
        ledger.close(ctx.sym, tsMs);
        ctx.openTrade = null;
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // ENTRY PHASE — evaluate new entries now that all exits at T are settled.
    // The shared ledger reflects the true concurrent portfolio state at T.
    // ════════════════════════════════════════════════════════════════════════
    for (const ctx of symCtxMap.values()) {
      if (ctx.openTrade) continue;
      const i = ctx.idxByTs.get(ts);
      if (i === undefined || i < ctx.simStart) continue;
      const bar = ctx.candles[i]!;

      // Feature slice up to current bar
      const sliceStart = Math.max(0, i - STRUCTURAL_LOOKBACK + 1);
      const slice      = ctx.candles.slice(sliceStart, i + 1);
      const features   = computeFeaturesFromSlice(ctx.sym, slice);
      if (!features) continue;

      // HTF regime averaging
      ctx.featureHistory.push({
        emaSlope: features.emaSlope, rsi14: features.rsi14,
        bbWidth: features.bbWidth,   bbWidthRoc: features.bbWidthRoc,
        atr14: features.atr14,       atrRank: features.atrRank,
        atrAccel: features.atrAccel, zScore: features.zScore,
        spikeHazardScore: features.spikeHazardScore, bbPctB: features.bbPctB,
      });
      if (ctx.featureHistory.length > HTF_AVERAGING_WINDOW) ctx.featureHistory.shift();

      const regimeResult = classifyRegimeFromSamples(features, ctx.featureHistory);

      let engineResults: EngineResult[];
      let coordinatorOutput: ReturnType<typeof runEnginesAndCoordinate>["coordinatorOutput"];
      try {
        const p = runEnginesAndCoordinate({
          symbol: ctx.sym, features,
          operationalRegime: regimeResult.regime, regimeConfidence: regimeResult.confidence,
        });
        engineResults = p.engineResults;
        coordinatorOutput = p.coordinatorOutput;
      } catch { continue; }

      if (engineResults.length === 0 || !coordinatorOutput) continue;

      const { winner, conflictResolution, coordinatorConfidence } = coordinatorOutput;
      const nativeScore = extractNativeScore(winner, coordinatorConfidence);

      ctx.signalsFired++;
      recordBehaviorEvent({
        eventType: "signal_fired", symbol: ctx.sym, engineName: winner.engineName,
        entryType: winner.entryType, direction: winner.direction,
        regimeAtEntry: regimeResult.regime, regimeConfidence: regimeResult.confidence,
        nativeScore, projectedMovePct: winner.projectedMovePct,
        ts: bar.closeTs, conflictResolution,
      });

      // Admission — ledger provides true cross-symbol open count / symbol-open state
      const nowMs        = tsMs;
      const dayStartTs   = nowMs - 86_400_000;
      const weekStartTs  = nowMs - 7 * 86_400_000;
      const dailyLossUsd  = ctx.simClosedPnls.filter(p => p.closeTs >= dayStartTs) .reduce((s, p) => s + p.pnlUsd, 0);
      const weeklyLossUsd = ctx.simClosedPnls.filter(p => p.closeTs >= weekStartTs).reduce((s, p) => s + p.pnlUsd, 0);
      const dailyLossLimitBreached  = dailyLossUsd  < 0 && Math.abs(dailyLossUsd)  / ctx.totalCapital >= ctx.maxDailyLossPct;
      const weeklyLossLimitBreached = weeklyLossUsd < 0 && Math.abs(weeklyLossUsd) / ctx.totalCapital >= ctx.maxWeeklyLossPct;
      const currentDrawdownPct = ctx.simEquityPeak > 0 ? (ctx.simEquityPeak - ctx.simEquity) / ctx.simEquityPeak : 0;
      const maxDrawdownBreached = currentDrawdownPct >= ctx.maxDrawdownThresholdPct;

      const allocResult = evaluateSignalAdmission({
        symbol: ctx.sym, engineName: winner.engineName, direction: winner.direction,
        nativeScore, confidence: winner.confidence,
        mode: _mode, minScoreGate: ctx.modeGate,
        killSwitchActive: ctx.killSwitchActive,
        modeEnabled:      ctx.modeEnabled,
        symbolEnabled:    ctx.symbolEnabled,
        // Cross-symbol portfolio state from shared ledger — true concurrent state at T
        openTradeForSymbol: ledger.isSymbolOpen(ctx.sym, tsMs),
        currentOpenCount:   ledger.getOpenCount(tsMs),
        maxOpenTrades:      ctx.maxOpenTrades,
        dailyLossLimitBreached, weeklyLossLimitBreached, maxDrawdownBreached,
        correlatedFamilyCapBreached: false,
        simulationDefaults: [],   // no parity gaps — ledger covers all cross-symbol gates
      });

      if (!allocResult.allowed) {
        const isTradeManagementBlock = allocResult.rejectionStage === 5;
        if (!isTradeManagementBlock) {
          ctx.signalsBlocked++;
          ctx.blockedByEngine[winner.engineName] = (ctx.blockedByEngine[winner.engineName] ?? 0) + 1;
        }
        recordBehaviorEvent({
          eventType: "blocked_by_gate", symbol: ctx.sym, engineName: winner.engineName,
          direction: winner.direction, regimeAtEntry: regimeResult.regime,
          nativeScore, modeGate: ctx.modeGate, mode: _mode, ts: bar.closeTs,
          rejectionStage:   allocResult.rejectionStage   ?? undefined,
          rejectionReason:  allocResult.rejectionReason  ?? `stage${allocResult.rejectionStage ?? 0}`,
          isSignalQualityBlock: allocResult.rejectionStage === 4,
        });
        continue;
      }

      // SR/Fib TP — same as single-symbol path
      const tp = calculateSRFibTP({
        entryPrice: bar.close, direction: winner.direction,
        swingHigh: features.swingHigh, swingLow: features.swingLow,
        majorSwingHigh: features.majorSwingHigh, majorSwingLow: features.majorSwingLow,
        fibExtensionLevels:     features.fibExtensionLevels     ?? [],
        fibExtensionLevelsDown: features.fibExtensionLevelsDown ?? [],
        bbUpper: features.bbUpper, bbLower: features.bbLower, atrPct: features.atr14,
        pivotLevels: [features.pivotR1, features.pivotR2, features.pivotS1, features.pivotS2]
          .filter((v): v is number => typeof v === "number"),
        vwap: features.vwap, psychRound: features.psychRound,
        prevSessionHigh: features.prevSessionHigh, prevSessionLow: features.prevSessionLow,
        spikeMagnitude: features.spikeMagnitude,
      });
      if (!isFinite(tp) || tp <= 0) continue;
      if (winner.direction === "buy"  && tp <= bar.close) continue;
      if (winner.direction === "sell" && tp >= bar.close) continue;

      const sl = calculateSRFibSL({
        entryPrice: bar.close, direction: winner.direction, tp,
        positionSize: SYNTHETIC_SIZE, equity: SYNTHETIC_EQUITY,
      });
      if (!isFinite(sl) || sl <= 0) continue;

      const tpPct        = Math.abs(tp - bar.close) / bar.close;
      const slOriginalPct = Math.abs(sl - bar.close) / bar.close;

      recordBehaviorEvent({
        eventType: "entered", symbol: ctx.sym, engineName: winner.engineName,
        entryType: winner.entryType, direction: winner.direction,
        regimeAtEntry: regimeResult.regime, regimeConfidence: regimeResult.confidence,
        nativeScore, projectedMovePct: winner.projectedMovePct,
        entryTs: bar.closeTs, tpPct, slPct: slOriginalPct,
      });

      ctx.openTrade = {
        winner, entryBar: i, entryPrice: bar.close, entryTs: bar.closeTs,
        regimeAtEntry: regimeResult.regime, regimeConfidence: regimeResult.confidence,
        nativeScore, conflictResolution, tp, sl, originalSl: sl,
        stage: 1, peakPrice: bar.close, mfePct: 0, maePct: 0, mfePeakBar: i,
        beTriggeredBar: 0, mfePctAtBreakeven: 0,
        atr14AtEntry: Math.max(features.atr14, 0.001),
        instrumentFamily: ctx.instrumentFamily,
        emaSlope: features.emaSlope, spikeCount4h: features.spikeCount4h ?? 0,
        adverseCandleCount: 0, tpPct, slOriginalPct, tpProgressAtBe: 0,
      };
      ledger.open(ctx.sym, ctx.instrumentFamily, tsMs);
    }
  }

  // ── Collect results ───────────────────────────────────────────────────────
  const out: Record<string, V3BacktestResult> = {};
  for (const [sym, ctx] of symCtxMap.entries()) {
    const barsInRange = Math.max(0, ctx.candles.length - ctx.simStart);
    const blockedRate = ctx.signalsFired > 0 ? ctx.signalsBlocked / ctx.signalsFired : 0;
    out[sym] = {
      symbol: sym, mode: _mode, startTs: _startTs, endTs: _endTs,
      totalBars: barsInRange, modeScoreGate: ctx.modeGate,
      signalsFired: ctx.signalsFired, signalsBlocked: ctx.signalsBlocked, blockedRate,
      trades: ctx.trades,
      simulationGaps: [],   // no gaps — synchronized loop uses shared ledger for all gates
      summary: computeSummary(ctx.trades, ctx.blockedByEngine),
    };
  }

  // Fill missing symbols (insufficient candle data) with empty results
  for (const sym of symbols) {
    if (!out[sym]) {
      out[sym] = {
        symbol: sym, mode: _mode, startTs: _startTs, endTs: _endTs,
        totalBars: 0, modeScoreGate: sharedModeGate,
        signalsFired: 0, signalsBlocked: 0, blockedRate: 0,
        trades: [], simulationGaps: [], summary: computeSummary([], {}),
      };
    }
  }

  return out;
}
