import { db, tradesTable, platformStateTable, behaviorEventsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { getDerivClientForMode, getDerivClientWithDbToken, getModeCapitalKey, getModeCapitalDefault } from "../infrastructure/deriv.js";
import type { TradingMode } from "../infrastructure/deriv.js";
import type { AllocationDecision } from "./signalRouter.js";
import { checkAndAutoExtract } from "./extractionEngine.js";
import { recordBehaviorEvent } from "./backtest/behaviorCapture.js";
import { evaluateBarExits, MAX_HOLD_MINS, applyBarStateTransitions } from "./tradeManagement.js";
import type { LiveCalibrationProfile } from "./calibration/liveCalibrationProfile.js";
import type { FeatureVector, SpikeMagnitudeStats } from "./features.js";
import { selectRuntimeTpTargetPct } from "./calibration/runtimeProfileUtils.js";

const MAX_OPEN_TRADES = 6;
const MAX_EQUITY_DEPLOYED_PCT = 0.80;
const PROFIT_TRAILING_DRAWDOWN_PCT = 0.30;

// Per-trade adverse-tick counter: incremented on each tick where price moved
// against the position direction, reset on a favorable tick.
// Mirrors the per-bar adverseCandleCount used in backtestRunner so the adaptive
// trailing stop receives equivalent context in both live and replay paths.
const liveAdverseCount = new Map<number, number>();

// Last-seen price per trade: used to determine tick direction for adverse count.
const livePrevPrice = new Map<number, number>();

function classifyInstrumentFamily(symbol: string): "crash" | "boom" | "volatility" {
  if (symbol.startsWith("BOOM")) return "boom";
  if (symbol.startsWith("CRASH")) return "crash";
  return "volatility";
}

function getDefaultAtr14Pct(symbol: string): number {
  if (symbol.startsWith("BOOM") || symbol.startsWith("CRASH")) return 0.008;
  return 0.005;
}

interface PositionSizing {
  size: number;
  allowed: boolean;
  reason: string;
}

export function calculatePositionSize(
  equity: number,
  openTradesCount: number,
  totalDeployedCapital: number,
  confidence: number,
  maxOpenTrades: number = MAX_OPEN_TRADES,
  equityPctPerTrade: number = 22,
): PositionSizing {
  if (openTradesCount >= maxOpenTrades) {
    return { size: 0, allowed: false, reason: `Max ${maxOpenTrades} simultaneous trades reached` };
  }

  const maxDeployable = equity * MAX_EQUITY_DEPLOYED_PCT;
  const remainingCapacity = maxDeployable - totalDeployedCapital;

  if (remainingCapacity <= 0) {
    return { size: 0, allowed: false, reason: "80% equity cap reached" };
  }

  const pctDecimal = equityPctPerTrade / 100;
  const confidenceScale = Math.max(0.5, Math.min(1.0, confidence));
  let size = equity * pctDecimal * confidenceScale;

  size = Math.min(size, remainingCapacity);
  size = Math.max(size, equity * 0.05);

  if (size > remainingCapacity) {
    return { size: 0, allowed: false, reason: "Insufficient remaining capacity" };
  }

  return { size, allowed: true, reason: "ok" };
}

export function applyRuntimeCalibrationExitModel(params: {
  spotPrice: number;
  direction: "buy" | "sell";
  tp: number;
  sl: number;
  trailingStopPct: number;
  mode: TradingMode;
  runtimeCalibration?: LiveCalibrationProfile | null;
  nativeScore?: number | null;
  leadInShape?: string | null;
  features?: FeatureVector | null;
}): { tp: number; sl: number; trailingStopPct: number } {
  const { spotPrice, direction, mode, runtimeCalibration } = params;
  let tp = params.tp;
  let sl = params.sl;
  let trailingStopPct = params.trailingStopPct;

  if (runtimeCalibration && mode === "paper") {
    const targetPctRaw = Number(runtimeCalibration.tpModel?.["targetPct"] ?? 0);
    const selectedTargetPct = Number.isFinite(targetPctRaw)
      ? selectRuntimeTpTargetPct({
          runtimeCalibration,
          direction,
          fallbackTargetPct: Math.max(0, targetPctRaw),
          nativeScore: params.nativeScore,
          leadInShape: params.leadInShape,
          features: params.features,
        })
      : 0;
    const targetPct = Math.max(0, selectedTargetPct / 100);
    if (targetPct > 0) {
      // The promoted research model owns paper calibration exits. Do not blend
      // it back toward legacy SR/Fib targets or the backtest no longer tests it.
      tp = direction === "buy"
        ? spotPrice * (1 + targetPct)
        : spotPrice * (1 - targetPct);
    }

    const maxInitialRiskPctRaw = Number(runtimeCalibration.slModel?.["maxInitialRiskPct"] ?? 0);
    const maxInitialRiskPct = Number.isFinite(maxInitialRiskPctRaw) ? Math.max(0, maxInitialRiskPctRaw / 100) : 0;
    if (maxInitialRiskPct > 0) {
      // Use the calibrated structural risk budget directly for paper/replay.
      // The previous clamp kept legacy 1:5 stops around 1%, which strangled
      // CRASH300 moves before their calibrated 7h behavior window developed.
      sl = direction === "buy"
        ? spotPrice * (1 - maxInitialRiskPct)
        : spotPrice * (1 + maxInitialRiskPct);
    }

    const trailingDistancePctRaw = Number(runtimeCalibration.trailingModel?.["trailingDistancePct"] ?? 0);
    if (Number.isFinite(trailingDistancePctRaw) && trailingDistancePctRaw > 0) {
      trailingStopPct = Math.max(0.002, Math.min(0.8, trailingDistancePctRaw / 100));
    }
  }

  return { tp, sl, trailingStopPct };
}

export function calculateSRFibTP(params: {
  entryPrice: number;
  direction: "buy" | "sell";
  swingHigh: number;
  swingLow: number;
  majorSwingHigh?: number;
  majorSwingLow?: number;
  fibExtensionLevels: number[];
  fibExtensionLevelsDown?: number[];
  bbUpper: number;
  bbLower: number;
  atrPct: number;
  pivotLevels?: number[];
  vwap?: number;
  psychRound?: number;
  prevSessionHigh?: number;
  prevSessionLow?: number;
  spikeMagnitude?: SpikeMagnitudeStats | null;
}): number {
  const {
    entryPrice, direction, majorSwingHigh, majorSwingLow,
    swingHigh, swingLow,
    spikeMagnitude,
  } = params;

  const isBoomCrash = spikeMagnitude &&
    (spikeMagnitude.instrumentFamily === "boom" || spikeMagnitude.instrumentFamily === "crash");

  if (isBoomCrash && spikeMagnitude) {
    const longTermRangePct = spikeMagnitude.longTermRangePct || 0;
    const targetPct = Math.max(longTermRangePct * 0.50, 0.10);

    if (direction === "buy") {
      return entryPrice * (1 + targetPct);
    } else {
      const tp = entryPrice * (1 - targetPct);
      return tp > 0 ? tp : entryPrice * 0.90;
    }
  }

  const msh = majorSwingHigh ?? swingHigh;
  const msl = majorSwingLow ?? swingLow;
  const majorSwingRange = Math.abs(msh - msl);
  const minRange = entryPrice * 0.02;
  const effectiveRange = Math.max(majorSwingRange, minRange);

  if (direction === "buy") {
    const tp = entryPrice + effectiveRange * 0.70;
    return tp > entryPrice ? tp : entryPrice + minRange;
  } else {
    const tp = entryPrice - effectiveRange * 0.70;
    return tp > 0 && tp < entryPrice ? tp : entryPrice - minRange;
  }
}

export const RR_RATIO = 5;

export function calculateSRFibSL(params: {
  entryPrice: number;
  direction: "buy" | "sell";
  tp: number;
  positionSize: number;
  equity: number;
}): number {
  const { entryPrice, direction, tp, positionSize, equity } = params;

  const tpDist = Math.abs(tp - entryPrice);
  if (tpDist <= 0 || !isFinite(tpDist)) {
    const fallbackDist = entryPrice * 0.02;
    return direction === "buy" ? entryPrice - fallbackDist / RR_RATIO : entryPrice + fallbackDist / RR_RATIO;
  }
  const slDist = tpDist / RR_RATIO;

  let sl: number;
  if (direction === "buy") {
    sl = entryPrice - slDist;
  } else {
    sl = entryPrice + slDist;
  }

  const safePositionSize = Math.max(positionSize, 1);
  const maxSlDistanceRatio = (equity * 0.10) / safePositionSize;
  if (direction === "buy") {
    const safetyFloor = entryPrice * (1 - maxSlDistanceRatio);
    sl = Math.max(sl, safetyFloor);
    if (sl >= entryPrice) sl = entryPrice - slDist;
  } else {
    const safetyCeiling = entryPrice * (1 + maxSlDistanceRatio);
    sl = Math.min(sl, safetyCeiling);
    if (sl <= entryPrice) sl = entryPrice + slDist;
  }

  return sl;
}


export function calculateProfitTrailingStop(params: {
  entryPrice: number;
  currentPrice: number;
  peakPrice: number;
  direction: "buy" | "sell";
  currentSl: number;
  tpPrice?: number;
}): { newSl: number; updated: boolean } {
  const { entryPrice, currentPrice, peakPrice, direction, currentSl, tpPrice } = params;

  const currentPnlPct = direction === "buy"
    ? (currentPrice - entryPrice) / entryPrice
    : (entryPrice - currentPrice) / entryPrice;

  if (currentPnlPct <= 0) {
    return { newSl: currentSl, updated: false };
  }

  if (tpPrice && tpPrice > 0) {
    const tpPct = direction === "buy"
      ? (tpPrice - entryPrice) / entryPrice
      : (entryPrice - tpPrice) / entryPrice;
    const activationThreshold = tpPct * 0.30;
    if (currentPnlPct < activationThreshold) {
      return { newSl: currentSl, updated: false };
    }
  }

  const peakPnlPct = direction === "buy"
    ? (peakPrice - entryPrice) / entryPrice
    : (entryPrice - peakPrice) / entryPrice;

  if (peakPnlPct <= 0) {
    return { newSl: currentSl, updated: false };
  }

  const trailPnlPct = peakPnlPct * (1 - PROFIT_TRAILING_DRAWDOWN_PCT);

  let trailingSl: number;
  if (direction === "buy") {
    trailingSl = entryPrice * (1 + trailPnlPct);
    if (trailingSl > currentSl) {
      return { newSl: trailingSl, updated: true };
    }
  } else {
    trailingSl = entryPrice * (1 - trailPnlPct);
    if (trailingSl < currentSl) {
      return { newSl: trailingSl, updated: true };
    }
  }

  return { newSl: currentSl, updated: false };
}


export async function openPosition(decision: AllocationDecision, atrPct: number, mode: TradingMode): Promise<number | null> {
  const { signal } = decision;

  const states = await db.select().from(platformStateTable);
  const stateMap: Record<string, string> = {};
  for (const s of states) stateMap[s.key] = s.value;

  const capitalKey = getModeCapitalKey(mode);
  const capitalDefault = getModeCapitalDefault(mode);
  let equity = parseFloat(stateMap[capitalKey] || stateMap["total_capital"] || capitalDefault);

  const client = await getDerivClientForMode(mode);

  if ((mode === "demo" || mode === "real") && client) {
    try {
      if (!client.isStreaming()) {
        await client.connect();
      }
      const balanceData = await client.getAccountBalance();
      if (balanceData) {
        equity = balanceData.balance;
      }
    } catch (err) {
      console.warn(`[TradeEngine] Could not fetch ${mode} balance, using configured capital:`, err instanceof Error ? err.message : err);
    }
  }

  const prefix = mode === "paper" ? "paper" : mode === "demo" ? "demo" : "real";
  const modeMaxTrades = parseInt(
    stateMap[`${prefix}_max_open_trades`] || String(MAX_OPEN_TRADES)
  );
  const modeEquityPct = parseFloat(
    stateMap[`${prefix}_equity_pct_per_trade`] || "22"
  );

  const openTrades = await db.select().from(tradesTable).where(
    and(eq(tradesTable.status, "open"), eq(tradesTable.mode, mode))
  );
  const totalDeployed = openTrades.reduce((sum, t) => sum + t.size, 0);

  const sizing = calculatePositionSize(equity, openTrades.length, totalDeployed, signal.confidence, modeMaxTrades, modeEquityPct);
  if (!sizing.allowed) {
    console.log(`[TradeEngine] [${mode.toUpperCase()}] Position sizing rejected: ${sizing.reason}`);
    return null;
  }

  if (decision.capitalAmount > 0 && decision.capitalAmount < sizing.size) {
    sizing.size = decision.capitalAmount;
  }

  let spotPrice = 0;
  if (client) {
    spotPrice = client.getLatestQuote(signal.symbol) ?? 0;
    if (spotPrice <= 0) {
      try {
        spotPrice = (await client.getSpotPrice(signal.symbol)) ?? 0;
      } catch {
        spotPrice = 0;
      }
    }
  }

  if (spotPrice <= 0) {
    try {
      const fallbackClient = await getDerivClientWithDbToken();
      spotPrice = fallbackClient.getLatestQuote(signal.symbol) ?? 0;
      if (spotPrice <= 0) {
        spotPrice = (await fallbackClient.getSpotPrice(signal.symbol)) ?? 0;
      }
    } catch {
      spotPrice = 0;
    }
  }

  if (spotPrice <= 0) {
    console.log(`[TradeEngine] [${mode.toUpperCase()}] No spot price available for ${signal.symbol}`);
    return null;
  }

  const swingHigh = signal.swingHigh ?? spotPrice * 1.01;
  const swingLow = signal.swingLow ?? spotPrice * 0.99;
  const fibRetraceLevels = signal.fibRetraceLevels ?? [];
  const fibExtensionLevels = signal.fibExtensionLevels ?? [];
  const fibExtensionLevelsDown = signal.fibExtensionLevelsDown ?? [];
  const bbUpper = signal.bbUpper ?? spotPrice * 1.01;
  const bbLower = signal.bbLower ?? spotPrice * 0.99;

  const pivotLevels: number[] = [];
  if (signal.pivotR1) pivotLevels.push(signal.pivotR1);
  if (signal.pivotR2) pivotLevels.push(signal.pivotR2);
  if (signal.pivotR3) pivotLevels.push(signal.pivotR3);
  if (signal.pivotS1) pivotLevels.push(signal.pivotS1);
  if (signal.pivotS2) pivotLevels.push(signal.pivotS2);
  if (signal.pivotS3) pivotLevels.push(signal.pivotS3);
  if (signal.camarillaH3) pivotLevels.push(signal.camarillaH3);
  if (signal.camarillaH4) pivotLevels.push(signal.camarillaH4);
  if (signal.camarillaL3) pivotLevels.push(signal.camarillaL3);
  if (signal.camarillaL4) pivotLevels.push(signal.camarillaL4);
  if (signal.pivotPoint) pivotLevels.push(signal.pivotPoint);

  const tp = calculateSRFibTP({
    entryPrice: spotPrice,
    direction: signal.direction,
    swingHigh,
    swingLow,
    majorSwingHigh: signal.majorSwingHigh,
    majorSwingLow: signal.majorSwingLow,
    fibExtensionLevels,
    fibExtensionLevelsDown,
    bbUpper,
    bbLower,
    atrPct,
    pivotLevels,
    vwap: signal.vwap,
    psychRound: signal.psychRound,
    prevSessionHigh: signal.prevSessionHigh,
    prevSessionLow: signal.prevSessionLow,
    spikeMagnitude: signal.spikeMagnitude,
  });

  const sl = calculateSRFibSL({
    entryPrice: spotPrice,
    direction: signal.direction,
    tp,
    positionSize: sizing.size,
    equity,
  });

  const entryTs = new Date();

  if ((mode === "demo" || mode === "real") && client) {
    try {
      if (!client.isStreaming()) {
        await client.connect();
      }
    } catch {
      console.log(`[TradeEngine] [${mode.toUpperCase()}] Could not connect Deriv client for trading`);
      return null;
    }

    const contractType = signal.direction === "buy" ? "CALL" as const : "PUT" as const;
    const result = await client.buyContract({
      symbol: signal.symbol,
      contractType,
      amount: sizing.size,
      duration: 5,
      durationUnit: "d",
      limitOrder: {
        stopLoss: Math.abs(spotPrice - sl),
        takeProfit: Math.abs(tp - spotPrice),
      },
    });

    if (!result) {
      console.log(`[TradeEngine] [${mode.toUpperCase()}] Failed to open position on ${signal.symbol}`);
      return null;
    }

    const [inserted] = await db.insert(tradesTable).values({
      brokerTradeId: String(result.contractId),
      symbol: signal.symbol,
      strategyName: signal.strategyName,
      side: signal.direction,
      entryPrice: result.entrySpot,
      sl,
      tp,
      size: sizing.size,
      status: "open",
      mode,
      confidence: signal.confidence,
      trailingStopPct: PROFIT_TRAILING_DRAWDOWN_PCT,
      peakPrice: result.entrySpot,
      maxExitTs: null,
      currentPrice: result.entrySpot,
      notes: `V3 SRFib 1:5RR | Strategy: ${signal.strategyName} | Reason: ${signal.reason}`,
    }).returning();

    const tpDistPct = Math.abs(tp - result.entrySpot) / result.entrySpot * 100;
    const slDistPct = Math.abs(sl - result.entrySpot) / result.entrySpot * 100;
    console.log(`[TradeEngine] Opened ${mode.toUpperCase()} ${signal.direction} on ${signal.symbol} @ ${result.entrySpot} | Size: $${sizing.size.toFixed(2)} | TP: ${tp.toFixed(4)} (${tpDistPct.toFixed(4)}%) | SL: ${sl.toFixed(4)} (${slDistPct.toFixed(4)}%)`);
    return inserted.id;
  } else {
    const [inserted] = await db.insert(tradesTable).values({
      symbol: signal.symbol,
      strategyName: signal.strategyName,
      side: signal.direction,
      entryPrice: spotPrice,
      sl,
      tp,
      size: sizing.size,
      status: "open",
      mode: "paper",
      confidence: signal.confidence,
      trailingStopPct: PROFIT_TRAILING_DRAWDOWN_PCT,
      peakPrice: spotPrice,
      maxExitTs: null,
      currentPrice: spotPrice,
      notes: `V3 SRFib 1:5RR | Strategy: ${signal.strategyName} | Reason: ${signal.reason}`,
    }).returning();

    const tpDistPctPaper = Math.abs(tp - spotPrice) / spotPrice * 100;
    const slDistPctPaper = Math.abs(sl - spotPrice) / spotPrice * 100;
    console.log(`[TradeEngine] Opened PAPER ${signal.direction} on ${signal.symbol} @ ${spotPrice} | Size: $${sizing.size.toFixed(2)} | TP: ${tp.toFixed(4)} (${tpDistPctPaper.toFixed(4)}%) | SL: ${sl.toFixed(4)} (${slDistPctPaper.toFixed(4)}%)`);
    return inserted.id;
  }
}

export async function manageOpenPositions(): Promise<void> {
  const openTrades = await db.select().from(tradesTable).where(eq(tradesTable.status, "open"));
  if (openTrades.length === 0) return;

  // Read platformState once per cycle to get last-scan EMA slope and spike counts
  // stored by the signal scanner. These give the adaptive trailing stop the same
  // market context as the backtestRunner bar-level state machine.
  let scanContextMap: Record<string, string> = {};
  try {
    const stateRows = await db.select().from(platformStateTable);
    for (const r of stateRows) scanContextMap[r.key] = r.value;
  } catch {
    // Non-fatal — fall back to symbol defaults if platformState unavailable
  }

  let fallbackClient;
  try {
    fallbackClient = await getDerivClientWithDbToken();
  } catch {
  }

  for (const trade of openTrades) {
    try {
      const tradeMode = trade.mode as TradingMode;
      const modeClient = await getDerivClientForMode(tradeMode);
      const activeClient = modeClient || fallbackClient;

      if (!activeClient) continue;

      const currentPrice = activeClient.getLatestQuote(trade.symbol);
      if (!currentPrice) continue;

      await db.update(tradesTable)
        .set({ currentPrice })
        .where(eq(tradesTable.id, trade.id));

      const direction = trade.side as "buy" | "sell";
      const floatingPnl = direction === "buy"
        ? ((currentPrice - trade.entryPrice) / trade.entryPrice)
        : ((trade.entryPrice - currentPrice) / trade.entryPrice);

      // ── Per-trade adverse tick tracking ──────────────────────────────────
      // Mirrors backtestRunner's adverseCandleCount: count consecutive ticks
      // where price moved against the position direction.
      const prevPrice = livePrevPrice.get(trade.id) ?? currentPrice;
      const priceMove = currentPrice - prevPrice;
      const isFavorableTick = direction === "buy" ? priceMove >= 0 : priceMove <= 0;
      const adverseCount = isFavorableTick
        ? 0
        : (liveAdverseCount.get(trade.id) ?? 0) + 1;
      liveAdverseCount.set(trade.id, adverseCount);
      livePrevPrice.set(trade.id, currentPrice);

      // ── Last-scan EMA slope and spike count per symbol ────────────────────
      // Stored by the signal scanner under ${symbol}_scan_ema_slope and
      // ${symbol}_scan_spike_count_4h. Neutral defaults if not yet stored.
      const emaSlope = parseFloat(scanContextMap[`${trade.symbol}_scan_ema_slope`] || "0");
      const spikeCount4h = parseInt(scanContextMap[`${trade.symbol}_scan_spike_count_4h`] || "0", 10);
      const trailActivationPct = parseFloat(scanContextMap[`${trade.symbol}_scan_trail_activation_pct`] || "0");
      const trailDistancePct = parseFloat(scanContextMap[`${trade.symbol}_scan_trail_distance_pct`] || "0");
      const trailMinHoldBarsRaw = parseFloat(scanContextMap[`${trade.symbol}_scan_trail_min_hold_bars`] || "0");
      const trailingActivationThresholdPct =
        Number.isFinite(trailActivationPct) && trailActivationPct > 0
          ? trailActivationPct / 100
          : undefined;
      const calibratedTrailingDistancePct =
        Number.isFinite(trailDistancePct) && trailDistancePct > 0
          ? trailDistancePct / 100
          : undefined;
      const trailingMinHoldBars =
        Number.isFinite(trailMinHoldBarsRaw) && trailMinHoldBarsRaw > 0
          ? Math.max(1, Math.round(trailMinHoldBarsRaw))
          : undefined;
      const holdMins = trade.createdAt
        ? Math.floor((Date.now() - trade.createdAt.getTime()) / 60_000)
        : 0;

      const instrumentFamily = classifyInstrumentFamily(trade.symbol);
      const atr14Pct = getDefaultAtr14Pct(trade.symbol);

      // ── Unified lifecycle state machine ───────────────────────────────────
      // applyBarStateTransitions owns: peak tracking, MFE/MAE, BE promotion
      // (stage 1→2), trailing activation (stage 2→3), and adaptive SL update.
      // Same pure function used in backtestRunner per-bar loop — single truth.
      //
      // Tick approximation: currentPrice acts as the degenerate bar where
      // barOpen = barHigh = barLow = barClose = currentPrice.
      // This preserves stage-machine fidelity across both paths.
      const barState = applyBarStateTransitions({
        direction,
        entryPrice: trade.entryPrice,
        tp: trade.tp,
        holdBars: holdMins,
        barHigh: currentPrice,
        barLow: currentPrice,
        barClose: currentPrice,
        barOpen: currentPrice,
        stage: ((trade.tradeStage ?? 1) as 1 | 2 | 3),
        sl: trade.sl,
        peakPrice: trade.peakPrice ?? trade.entryPrice,
        mfePct: trade.mfePct ?? 0,
        maePct: trade.maePct ?? 0,
        adverseCandleCount: adverseCount,
        atr14AtEntry: atr14Pct,
        instrumentFamily,
        emaSlope,
        spikeCount4h,
        trailingActivationThresholdPct,
        trailingMinHoldBars,
        trailingDistancePct: calibratedTrailingDistancePct,
      });

      const slChanged = barState.sl !== trade.sl;

      // Persist full lifecycle state on every tick so DB is authoritative
      await db.update(tradesTable)
        .set({
          sl: barState.sl,
          peakPrice: barState.peakPrice,
          tradeStage: barState.stage,
          mfePct: barState.mfePct,
          maePct: barState.maePct,
        })
        .where(eq(tradesTable.id, trade.id));

      if (slChanged) {
        if ((tradeMode === "demo" || tradeMode === "real") && trade.brokerTradeId && modeClient) {
          await modeClient.updateStopLoss(parseInt(trade.brokerTradeId), Math.abs(barState.sl - trade.entryPrice));
        }
        console.log(`[TradeEngine] Updated SL for trade #${trade.id} → ${barState.sl.toFixed(4)} (stage=${barState.stage})`);
      }
      if (barState.bePromoted) {
        console.log(`[TradeEngine] Trade #${trade.id} ${trade.symbol} breakeven promoted (stage 1→2, MFE=${(barState.mfePctAtPromotion * 100).toFixed(2)}%)`);
      }
      if (barState.trailingActivated) {
        console.log(`[TradeEngine] Trade #${trade.id} ${trade.symbol} trailing activated (stage 2→3)`);
      }

      const activeSl = barState.sl;

      // evaluateBarExits (SL before TP) — same shared evaluator as backtestRunner.
      // For live tick management, currentPrice is treated as a degenerate bar
      // (high=low=close=currentPrice). SL-first priority is preserved.
      const tickExit = evaluateBarExits({
        direction,
        barHigh: currentPrice,
        barLow: currentPrice,
        barClose: currentPrice,
        tp: trade.tp,
        sl: activeSl,
      });

      if (tickExit.exitReason === "sl_hit") {
        await closePosition(
          trade.id,
          tickExit.exitPrice,
          barState.stage === 3 ? "trailing_stop" : "stop_loss_hit",
        );
        continue;
      }

      if (tickExit.exitReason === "tp_hit") {
        await closePosition(trade.id, tickExit.exitPrice, "take_profit_hit");
        continue;
      }

      // ── Max-duration expiry (shared constant from tradeManagement.ts) ─────
      // Mirrors the MAX_HOLD_BARS check in backtestRunner so both paths
      // have the same hard expiry ceiling.
      if (holdMins >= MAX_HOLD_MINS) {
        console.log(`[TradeEngine] Trade #${trade.id} ${trade.symbol} expired after ${holdMins}m (MAX_HOLD_MINS=${MAX_HOLD_MINS})`);
        await closePosition(trade.id, currentPrice, "max_duration");
        continue;
      }

    } catch (err) {
      console.error(`[TradeEngine] Error managing trade #${trade.id}:`, err instanceof Error ? err.message : err);
    }
  }

  const modes: TradingMode[] = ["paper", "demo", "real"];
  for (const m of modes) {
    try {
      await checkAndAutoExtract(m);
    } catch (err) {
      console.error(`[TradeEngine] Extraction check error for ${m}:`, err instanceof Error ? err.message : err);
    }
  }
}

/**
 * V3 position opener — takes engine result inputs directly.
 * Used by the V3 scheduler scan path. Reuses TP/SL calculation
 * and broker execution infrastructure from openPosition.
 */
export async function openPositionV3(params: {
  symbol: string;
  engineName: string;
  direction: "buy" | "sell";
  confidence: number;
  capitalAmount: number;
  features: import("./features.js").FeatureVector;
  mode: TradingMode;
  runtimeCalibration?: LiveCalibrationProfile | null;
  exitPolicy?: {
    takeProfitPrice?: number;
    stopLossPrice?: number;
    trailingDistancePct?: number;
  } | null;
}): Promise<number | null> {
  const { symbol, engineName, direction, confidence, capitalAmount, features, mode, runtimeCalibration } = params;

  const client = await getDerivClientForMode(mode);
  const states = await db.select().from(platformStateTable);
  const stateMap: Record<string, string> = {};
  for (const s of states) stateMap[s.key] = s.value;

  const capitalKey = getModeCapitalKey(mode);
  const capitalDefault = getModeCapitalDefault(mode);
  let equity = parseFloat(stateMap[capitalKey] || stateMap["total_capital"] || capitalDefault);

  if ((mode === "demo" || mode === "real") && client) {
    try {
      if (!client.isStreaming()) await client.connect();
      const balanceData = await client.getAccountBalance();
      if (balanceData) equity = balanceData.balance;
    } catch { /* use configured capital */ }
  }

  let spotPrice = features.latestClose;
  if (client) {
    const livePrice = client.getLatestQuote(symbol);
    if (livePrice && livePrice > 0) spotPrice = livePrice;
  }

  if (spotPrice <= 0) {
    console.log(`[TradeEngine/V3] No spot price for ${symbol}`);
    return null;
  }

  const atrPct = features.atr14 > 0 ? features.atr14 / spotPrice : getDefaultAtr14Pct(symbol);

  let tp = calculateSRFibTP({
    entryPrice: spotPrice,
    direction,
    swingHigh: features.swingHigh,
    swingLow: features.swingLow,
    fibExtensionLevels: features.fibExtensionLevels,
    fibExtensionLevelsDown: features.fibExtensionLevelsDown,
    bbUpper: features.bbUpper,
    bbLower: features.bbLower,
    atrPct,
    pivotLevels: [
      features.pivotR1, features.pivotR2, features.pivotR3,
      features.pivotS1, features.pivotS2, features.pivotS3,
    ].filter(v => v > 0),
    vwap: features.vwap,
    psychRound: features.psychRound,
    prevSessionHigh: features.prevSessionHigh,
    prevSessionLow: features.prevSessionLow,
  });

  let sl = calculateSRFibSL({ entryPrice: spotPrice, direction, tp, positionSize: capitalAmount, equity });
  let trailingStopPct = PROFIT_TRAILING_DRAWDOWN_PCT;

  ({ tp, sl, trailingStopPct } = applyRuntimeCalibrationExitModel({
    spotPrice,
    direction,
    tp,
    sl,
    trailingStopPct,
    mode,
    runtimeCalibration,
    nativeScore: confidence * 100,
    features,
  }));

  if (params.exitPolicy?.takeProfitPrice && params.exitPolicy.takeProfitPrice > 0) {
    tp = params.exitPolicy.takeProfitPrice;
  }
  if (params.exitPolicy?.stopLossPrice && params.exitPolicy.stopLossPrice > 0) {
    sl = params.exitPolicy.stopLossPrice;
  }
  if (params.exitPolicy?.trailingDistancePct && params.exitPolicy.trailingDistancePct > 0) {
    trailingStopPct = params.exitPolicy.trailingDistancePct;
  }

  const notes = `V3 HybridStaged | engine=${engineName} | conf=${confidence.toFixed(3)}` +
    (runtimeCalibration ? ` | calib_run=${runtimeCalibration.sourceRunId}` : "");

  if ((mode === "demo" || mode === "real") && client) {
    try {
      if (!client.isStreaming()) await client.connect();
      const contractType = direction === "buy" ? "CALL" as const : "PUT" as const;
      const result = await client.buyContract({
        symbol,
        contractType,
        amount: capitalAmount,
        duration: 5,
        durationUnit: "d",
        limitOrder: { stopLoss: Math.abs(spotPrice - sl), takeProfit: Math.abs(tp - spotPrice) },
      });
      if (!result) return null;
      const [inserted] = await db.insert(tradesTable).values({
        brokerTradeId: String(result.contractId),
        symbol,
        strategyName: engineName,
        side: direction,
        entryPrice: result.entrySpot,
        sl, tp,
        size: capitalAmount,
        status: "open",
        mode,
        confidence,
        trailingStopPct,
        peakPrice: result.entrySpot,
        currentPrice: result.entrySpot,
        notes,
      }).returning();
      console.log(`[TradeEngine/V3] Opened ${mode.toUpperCase()} ${direction} ${symbol} @ ${result.entrySpot} | engine=${engineName} | size=$${capitalAmount.toFixed(2)}`);
      return inserted.id;
    } catch (err) {
      console.error(`[TradeEngine/V3] Failed to open ${mode} position:`, err instanceof Error ? err.message : err);
      return null;
    }
  }

  // Paper mode
  const [inserted] = await db.insert(tradesTable).values({
    symbol,
    strategyName: engineName,
    side: direction,
    entryPrice: spotPrice,
    sl, tp,
    size: capitalAmount,
    status: "open",
    mode: "paper",
    confidence,
    trailingStopPct,
    peakPrice: spotPrice,
    currentPrice: spotPrice,
    notes,
  }).returning();

  const tpDistPct = Math.abs(tp - spotPrice) / spotPrice * 100;
  const slDistPct = Math.abs(sl - spotPrice) / spotPrice * 100;
  console.log(`[TradeEngine/V3] Opened PAPER ${direction} ${symbol} @ ${spotPrice} | engine=${engineName} | size=$${capitalAmount.toFixed(2)} | TP=${tp.toFixed(4)} (${tpDistPct.toFixed(2)}%) | SL=${sl.toFixed(4)} (${slDistPct.toFixed(2)}%)`);
  return inserted.id;
}

async function closePosition(tradeId: number, exitPrice: number, exitReason: string): Promise<void> {
  // Clean up per-trade context state
  liveAdverseCount.delete(tradeId);
  livePrevPrice.delete(tradeId);

  const [trade] = await db.select().from(tradesTable).where(eq(tradesTable.id, tradeId));
  if (!trade) return;

  const direction = trade.side as "buy" | "sell";
  const pnl = direction === "buy"
    ? ((exitPrice - trade.entryPrice) / trade.entryPrice) * trade.size
    : ((trade.entryPrice - exitPrice) / trade.entryPrice) * trade.size;

  const tradeMode = trade.mode as TradingMode;
  if ((tradeMode === "demo" || tradeMode === "real") && trade.brokerTradeId) {
    try {
      const client = await getDerivClientForMode(tradeMode);
      if (client) {
        await client.sellContract(parseInt(trade.brokerTradeId));
      }
    } catch (err) {
      console.error(`[TradeEngine] Failed to sell contract on Deriv:`, err instanceof Error ? err.message : err);
    }
  }

  await db.update(tradesTable)
    .set({
      status: "closed",
      exitTs: new Date(),
      exitPrice,
      pnl,
      exitReason,
      currentPrice: exitPrice,
    })
    .where(eq(tradesTable.id, tradeId));

  const capitalKey = getModeCapitalKey(tradeMode);
  const capitalDefault = getModeCapitalDefault(tradeMode);
  const currentCapitalRows = await db.select().from(platformStateTable).where(eq(platformStateTable.key, capitalKey));
  const currentCapital = parseFloat(currentCapitalRows[0]?.value || capitalDefault);
  const newCapital = currentCapital + pnl;
  await db.insert(platformStateTable).values({ key: capitalKey, value: String(newCapital) })
    .onConflictDoUpdate({ target: platformStateTable.key, set: { value: String(newCapital), updatedAt: new Date() } });

  console.log(`[TradeEngine] Closed trade #${tradeId} (${trade.symbol} ${trade.side} [${tradeMode}]) | Exit: ${exitPrice.toFixed(4)} | P&L: $${pnl.toFixed(2)} | Capital: $${currentCapital.toFixed(2)} → $${newCapital.toFixed(2)} | Reason: ${exitReason}`);

  // ── Live outcome scaffold: record closed event for behavior profiling ──────
  // Durable storage: behavior events are persisted to the behavior_events table
  // AND recorded in the in-memory store so the profiler can read them immediately.
  // Uses peakPrice as MFE approximation (live tracking field already maintained).
  try {
    const pnlPct = direction === "buy"
      ? (exitPrice - trade.entryPrice) / trade.entryPrice
      : (trade.entryPrice - exitPrice) / trade.entryPrice;
    const mfePctLive = direction === "buy"
      ? Math.max(0, ((trade.peakPrice ?? trade.entryPrice) - trade.entryPrice) / trade.entryPrice)
      : Math.max(0, (trade.entryPrice - (trade.peakPrice ?? trade.entryPrice)) / trade.entryPrice);
    const exitReasonNorm: "tp_hit" | "sl_hit" | "trailing_stop" | "max_duration" =
      exitReason === "take_profit_hit" ? "tp_hit"
      : exitReason === "stop_loss_hit" ? "sl_hit"
      : exitReason === "trailing_stop" ? "trailing_stop"
      : "max_duration";

    const entryTsMs = trade.entryTs
      ? new Date(trade.entryTs).getTime()
      : (trade.createdAt ? new Date(trade.createdAt).getTime() : Date.now());
    const exitTsMs = Date.now();
    const holdBarsLive = Math.max(1, Math.round((exitTsMs - entryTsMs) / 60_000));

    const projectedMovePct = (trade.tp && trade.entryPrice)
      ? Math.abs(trade.tp - trade.entryPrice) / trade.entryPrice
      : 0;

    const maePctLive = (trade.sl && trade.entryPrice)
      ? (direction === "buy"
          ? -(trade.entryPrice - trade.sl) / trade.entryPrice
          : -(trade.sl - trade.entryPrice) / trade.entryPrice)
      : 0;

    const liveClosedEvent = {
      eventType: "closed" as const,
      symbol: trade.symbol,
      engineName: trade.strategyName,
      entryType: "live",
      direction,
      regimeAtEntry: "live_unknown",
      regimeConfidence: 0,
      nativeScore: Math.round((trade.confidence ?? 0) * 100),
      projectedMovePct,
      entryTs: Math.floor(entryTsMs / 1000),
      exitTs: Math.floor(exitTsMs / 1000),
      holdBars: holdBarsLive,
      pnlPct,
      mfePct: mfePctLive,
      maePct: maePctLive,
      mfePctAtBreakeven: 0,
      barsToMfe: holdBarsLive,
      barsToBreakeven: 0,
      exitReason: exitReasonNorm,
      slStage: (trade.tradeStage ?? 1) as 1 | 2 | 3,
      conflictResolution: "live",
      source: "live" as const,
    };

    // 1. In-memory record (immediate access for profiler)
    recordBehaviorEvent(liveClosedEvent);

    // 2. Durable DB persistence (survives restarts — used to build profiles
    //    from historical live trades without needing a backtest replay)
    db.insert(behaviorEventsTable).values({
      symbol: trade.symbol,
      engineName: trade.strategyName,
      eventType: "closed",
      source: "live",
      eventData: liveClosedEvent as Record<string, unknown>,
    }).catch(err => {
      console.warn("[TradeEngine] Behavior event persist failed (non-fatal):", err instanceof Error ? err.message : err);
    });
  } catch {
    // Non-fatal — behavior capture must never block trade execution
  }
}
