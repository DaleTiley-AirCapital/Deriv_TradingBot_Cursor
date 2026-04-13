/**
 * backtestRunner.ts — V3 Isolated Backtest Simulation Engine
 *
 * Replays historical candles bar-by-bar, applying V3 engines (via engineRegistry)
 * and a hybrid exit model calibrated for 50-200%+ long-hold swings.
 *
 * Exit model (per signal):
 *   Leg 1 partial TP:  entry × (1 ± projectedMovePct × 0.30)   — take 30% of projected
 *   Hard SL:           entry × (1 ∓ projectedMovePct × 0.40)   — lose 40% of projected
 *   MFE regression:    2×ATR14 adverse reversal from MFE peak
 *   Max duration:      30 calendar days (43,200 1m bars)
 *
 * HTF steps for feature slicing:
 *   CRASH300 → 720m  |  BOOM300 → 480m  |  R_75 / R_100 → 240m
 * These determine how far back to slide the window before aggregation.
 *
 * Design constraints:
 *   - No DB calls inside the hot loop (candles pre-loaded at startup)
 *   - classifyRegime (pure function) called per bar — no hourly accumulator
 *   - featureSlice window: STRUCTURAL_LOOKBACK = 1500 bars (most recent)
 *   - One open trade per symbol at a time (no pyramiding in backtest)
 */

import { db, candlesTable } from "@workspace/db";
import { eq, and, gte, lte, asc } from "drizzle-orm";
import { computeFeaturesFromSlice, type CandleRow } from "./featureSlice.js";
import { classifyRegime } from "../regimeEngine.js";
import { getEnginesForSymbol } from "../engineRegistry.js";
import { getSymbolIndicatorTimeframeMins } from "../features.js";
import type { EngineResult } from "../engineTypes.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const STRUCTURAL_LOOKBACK = 1500;
const MAX_HOLD_BARS = 43_200;       // 30 days in 1m bars
const LEG1_PROJ_RATIO = 0.30;       // partial TP at 30% of projected move
const HARD_SL_PROJ_RATIO = 0.40;    // hard SL at 40% of projected move (loss)
const MFE_REVERSAL_ATR_MULT = 2.0;  // exit on 2×ATR14 pullback from MFE

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
  exitReason: "leg1_tp" | "hard_sl" | "mfe_reversal" | "max_duration";
  projectedMovePct: number;
  nativeScore: number;
  regimeAtEntry: string;
  regimeConfidence: number;
  holdBars: number;
  pnlPct: number;
  leg1Hit: boolean;
  mfePct: number;
  maePct: number;
}

export interface V3BacktestResult {
  symbol: string;
  startTs: number;
  endTs: number;
  totalBars: number;
  trades: V3BacktestTrade[];
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
    leg1HitRate: number;
    byEngine: Record<string, { count: number; wins: number; avgPnlPct: number }>;
    byExitReason: Record<string, number>;
  };
}

export interface V3BacktestRequest {
  symbol: string;
  startTs?: number;       // unix seconds; defaults to 90 days ago
  endTs?: number;         // unix seconds; defaults to now
  minScore?: number;      // override engine gate minimum (0-100); default = engine native gates
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function computeSummary(trades: V3BacktestTrade[]): V3BacktestResult["summary"] {
  if (trades.length === 0) {
    return {
      tradeCount: 0, winCount: 0, lossCount: 0, winRate: 0,
      avgPnlPct: 0, avgWinPct: 0, avgLossPct: 0, totalPnlPct: 0,
      profitFactor: 0, maxDrawdownPct: 0, avgHoldBars: 0, leg1HitRate: 0,
      byEngine: {}, byExitReason: {},
    };
  }

  const wins = trades.filter(t => t.pnlPct > 0);
  const losses = trades.filter(t => t.pnlPct <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnlPct, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0));

  // Equity curve for max drawdown
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of trades) {
    equity += t.pnlPct;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }

  const byEngine: Record<string, { count: number; wins: number; avgPnlPct: number }> = {};
  for (const t of trades) {
    if (!byEngine[t.engineName]) byEngine[t.engineName] = { count: 0, wins: 0, avgPnlPct: 0 };
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
    leg1HitRate: trades.filter(t => t.leg1Hit).length / trades.length,
    byEngine,
    byExitReason,
  };
}

// ── Core simulation loop ──────────────────────────────────────────────────────

/**
 * Run the V3 backtest for a single symbol.
 * Loads candles from DB, slides a feature window bar-by-bar,
 * runs engines at each bar, simulates the hybrid exit model.
 */
export async function runV3Backtest(req: V3BacktestRequest): Promise<V3BacktestResult> {
  const now = Math.floor(Date.now() / 1000);
  const startTs = req.startTs ?? (now - 90 * 86400);
  const endTs = req.endTs ?? now;
  const symbol = req.symbol;

  // Load all candles for the range plus the lookback buffer
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
      symbol,
      startTs,
      endTs,
      totalBars: 0,
      trades: [],
      summary: computeSummary([]),
    };
  }

  const candles = rawCandles as CandleRow[];

  // Find the index where the simulation window begins (>= startTs)
  let simStart = candles.findIndex(c => c.openTs >= startTs);
  if (simStart < 0) simStart = candles.length - 1;

  // We need at least STRUCTURAL_LOOKBACK bars before the sim start
  if (simStart < STRUCTURAL_LOOKBACK) simStart = STRUCTURAL_LOOKBACK;

  const engines = getEnginesForSymbol(symbol);
  const minScore = req.minScore;

  const trades: V3BacktestTrade[] = [];
  let openTrade: {
    engine: EngineResult;
    entryBar: number;
    entryPrice: number;
    entryTs: number;
    regimeAtEntry: string;
    regimeConfidence: number;
    nativeScore: number;
    mfePct: number;
    maePct: number;
    leg1Pct: number;
    hardSlPct: number;
    leg1Hit: boolean;
    atr14AtEntry: number;
  } | null = null;

  const htfMins = getSymbolIndicatorTimeframeMins(symbol);
  const indicatorLookback = 55 * htfMins;   // 55 HTF bars in 1m bars

  for (let i = simStart; i < candles.length; i++) {
    const sliceStart = Math.max(0, i - STRUCTURAL_LOOKBACK + 1);
    const slice = candles.slice(sliceStart, i + 1);

    // ── Exit check for open trade ────────────────────────────────────────────
    if (openTrade !== null) {
      const bar = candles[i];
      const dir = openTrade.engine.direction;
      const ep = openTrade.entryPrice;

      // Raw P&L at current bar
      const rawPnl = dir === "buy"
        ? (bar.close - ep) / ep
        : (ep - bar.close) / ep;

      // MFE / MAE tracking
      const barHigh = dir === "buy"
        ? (bar.high - ep) / ep
        : (ep - bar.low) / ep;
      const barLow = dir === "buy"
        ? (bar.low - ep) / ep
        : (ep - bar.high) / ep;

      if (barHigh > openTrade.mfePct) openTrade.mfePct = barHigh;
      if (barLow < openTrade.maePct) openTrade.maePct = barLow;

      const holdBars = i - openTrade.entryBar;
      let exitReason: V3BacktestTrade["exitReason"] | null = null;
      let exitPrice = bar.close;

      // Hard SL check (worst-case for bar)
      const adverseMove = dir === "buy"
        ? (ep - bar.low) / ep
        : (bar.high - ep) / ep;

      if (adverseMove >= Math.abs(openTrade.hardSlPct)) {
        exitReason = "hard_sl";
        exitPrice = dir === "buy"
          ? ep * (1 - Math.abs(openTrade.hardSlPct))
          : ep * (1 + Math.abs(openTrade.hardSlPct));
      }

      // Leg 1 TP check
      if (!exitReason && !openTrade.leg1Hit) {
        const favorableMove = dir === "buy"
          ? (bar.high - ep) / ep
          : (ep - bar.low) / ep;
        if (favorableMove >= Math.abs(openTrade.leg1Pct)) {
          openTrade.leg1Hit = true;
          exitPrice = dir === "buy"
            ? ep * (1 + Math.abs(openTrade.leg1Pct))
            : ep * (1 - Math.abs(openTrade.leg1Pct));
          exitReason = "leg1_tp";
        }
      }

      // MFE regression: 2×ATR14 pullback from peak
      if (!exitReason && openTrade.mfePct > 0) {
        const atrBuffer = openTrade.atr14AtEntry * MFE_REVERSAL_ATR_MULT;
        const pullbackFromMfe = openTrade.mfePct - rawPnl;
        if (pullbackFromMfe >= atrBuffer && openTrade.mfePct > atrBuffer) {
          exitReason = "mfe_reversal";
        }
      }

      // Max duration
      if (!exitReason && holdBars >= MAX_HOLD_BARS) {
        exitReason = "max_duration";
      }

      if (exitReason) {
        const finalPnl = dir === "buy"
          ? (exitPrice - ep) / ep
          : (ep - exitPrice) / ep;

        trades.push({
          entryTs: openTrade.entryTs,
          exitTs: bar.closeTs,
          symbol,
          direction: dir,
          engineName: openTrade.engine.engineName,
          entryType: openTrade.engine.entryType,
          entryPrice: ep,
          exitPrice,
          exitReason,
          projectedMovePct: openTrade.engine.projectedMovePct,
          nativeScore: openTrade.nativeScore,
          regimeAtEntry: openTrade.regimeAtEntry,
          regimeConfidence: openTrade.regimeConfidence,
          holdBars,
          pnlPct: finalPnl,
          leg1Hit: openTrade.leg1Hit,
          mfePct: openTrade.mfePct,
          maePct: openTrade.maePct,
        });
        openTrade = null;
      }

      // While trade is open, don't evaluate new signals
      if (openTrade !== null) continue;
    }

    // ── Signal scan (only when no open trade) ────────────────────────────────
    // Require enough data for HTF indicators
    if (slice.length < Math.max(60, indicatorLookback / 60)) continue;

    const features = computeFeaturesFromSlice(symbol, slice);
    if (!features) continue;

    const regimeResult = classifyRegime(features);

    const ctx = {
      features,
      operationalRegime: regimeResult.regime,
      regimeConfidence: regimeResult.confidence,
    };

    let winner: EngineResult | null = null;
    let winnerScore = -1;

    for (const engine of engines) {
      const result = engine(ctx);
      if (!result || !result.valid) continue;

      const score = Math.round(result.confidence * 100);
      if (minScore !== undefined && score < minScore) continue;

      if (score > winnerScore) {
        winnerScore = score;
        winner = result;
      }
    }

    if (!winner) continue;

    const entryPrice = candles[i].close;
    const proj = winner.projectedMovePct;
    const leg1Pct = proj * LEG1_PROJ_RATIO;
    const hardSlPct = proj * HARD_SL_PROJ_RATIO;
    const atr14AtEntry = features.atr14;

    openTrade = {
      engine: winner,
      entryBar: i,
      entryPrice,
      entryTs: candles[i].closeTs,
      regimeAtEntry: regimeResult.regime,
      regimeConfidence: regimeResult.confidence,
      nativeScore: winnerScore,
      mfePct: 0,
      maePct: 0,
      leg1Pct: winner.direction === "buy" ? leg1Pct : -leg1Pct,
      hardSlPct: winner.direction === "buy" ? -hardSlPct : hardSlPct,
      leg1Hit: false,
      atr14AtEntry: Math.max(atr14AtEntry, 0.001),
    };
  }

  const barsInRange = clamp(candles.length - simStart, 0, candles.length);

  return {
    symbol,
    startTs,
    endTs,
    totalBars: barsInRange,
    trades,
    summary: computeSummary(trades),
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
): Promise<Record<string, V3BacktestResult>> {
  const results = await Promise.all(
    symbols.map(sym => runV3Backtest({ symbol: sym, startTs, endTs, minScore }))
  );

  const out: Record<string, V3BacktestResult> = {};
  for (let i = 0; i < symbols.length; i++) {
    out[symbols[i]] = results[i];
  }
  return out;
}
