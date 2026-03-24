import { db, tradesTable, platformStateTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { getDerivClientForMode, getDerivClientWithDbToken, getModeCapitalKey, getModeCapitalDefault } from "./deriv.js";
import type { TradingMode } from "./deriv.js";
import type { AllocationDecision } from "./signalRouter.js";
import { evaluateProfitHarvest, determineEntryStage, getEntrySizeMultiplier, checkAndAutoExtract, getHarvestSettings } from "./extractionEngine.js";

const MAX_OPEN_TRADES = 3;
const MAX_EQUITY_DEPLOYED_PCT = 0.80;
const POSITION_SIZE_MIN_PCT = 0.05;
const POSITION_SIZE_MAX_PCT = 0.25;
const DEFAULT_TRAILING_STOP_PCT = 0.25;
const INITIAL_EXIT_HOURS = 168;
const EXTENSION_HOURS = 48;
const MAX_EXIT_HOURS = 336;

export type StrategyFamily = "trend_continuation" | "mean_reversion" | "breakout_expansion" | "spike_event";

export const FAMILY_HOLD_PROFILE: Record<StrategyFamily, {
  tpAtrMultiplier: number;
  slAtrMultiplier: number;
  initialExitHours: number;
  extensionHours: number;
  maxExitHours: number;
  harvestSensitivity: number;
}> = {
  trend_continuation: {
    tpAtrMultiplier: 6.0,
    slAtrMultiplier: 2.5,
    initialExitHours: 168,
    extensionHours: 48,
    maxExitHours: 336,
    harvestSensitivity: 0.8,
  },
  mean_reversion: {
    tpAtrMultiplier: 4.0,
    slAtrMultiplier: 3.0,
    initialExitHours: 120,
    extensionHours: 36,
    maxExitHours: 240,
    harvestSensitivity: 1.0,
  },
  breakout_expansion: {
    tpAtrMultiplier: 8.0,
    slAtrMultiplier: 2.0,
    initialExitHours: 168,
    extensionHours: 48,
    maxExitHours: 336,
    harvestSensitivity: 0.7,
  },
  spike_event: {
    tpAtrMultiplier: 4.0,
    slAtrMultiplier: 1.5,
    initialExitHours: 72,
    extensionHours: 24,
    maxExitHours: 168,
    harvestSensitivity: 1.2,
  },
};

function resolveFamilyFromStrategy(strategyName: string): StrategyFamily {
  if (strategyName in FAMILY_HOLD_PROFILE) return strategyName as StrategyFamily;
  if (strategyName.includes("trend")) return "trend_continuation";
  if (strategyName.includes("mean") || strategyName.includes("reversion")) return "mean_reversion";
  if (strategyName.includes("breakout")) return "breakout_expansion";
  if (strategyName.includes("spike")) return "spike_event";
  return "trend_continuation";
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
  equityPctPerTrade: number = (POSITION_SIZE_MIN_PCT + POSITION_SIZE_MAX_PCT) / 2 * 100,
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
  const basePct = pctDecimal * (0.8 + 0.4 * confidence);
  let size = equity * basePct;

  size = Math.min(size, remainingCapacity);
  size = Math.max(size, equity * 0.05);

  if (size > remainingCapacity) {
    return { size: 0, allowed: false, reason: "Insufficient remaining capacity" };
  }

  return { size, allowed: true, reason: "ok" };
}

export function calculateDynamicTP(params: {
  entryPrice: number;
  direction: "buy" | "sell";
  confidence: number;
  atrPct: number;
  historicalAvgMovePct?: number;
  tpMultiplier?: number;
  family?: StrategyFamily;
  tpCaptureRatio?: number;
  familyProfileOverride?: { tpAtrMultiplier: number };
}): number {
  const { entryPrice, direction, confidence, atrPct, historicalAvgMovePct = 0, tpMultiplier = 2.0, family, tpCaptureRatio = 0.70, familyProfileOverride } = params;

  const familyProfile = familyProfileOverride || (family ? FAMILY_HOLD_PROFILE[family] : null);
  const effectiveMultiplier = familyProfile ? familyProfile.tpAtrMultiplier : tpMultiplier;

  let predictedMovePct = atrPct * effectiveMultiplier * confidence;

  if (historicalAvgMovePct > 0) {
    const historicalEstimate = historicalAvgMovePct * confidence;
    predictedMovePct = Math.max(predictedMovePct, historicalEstimate);
  }

  const tpPct = predictedMovePct * tpCaptureRatio;
  const minTPPct = atrPct * 2.5;
  const maxTPPct = atrPct * 15.0;
  const clampedPct = Math.max(minTPPct, Math.min(maxTPPct, tpPct));

  if (direction === "buy") {
    return entryPrice * (1 + clampedPct);
  } else {
    return entryPrice * (1 - clampedPct);
  }
}

export function calculateInitialSL(params: {
  entryPrice: number;
  direction: "buy" | "sell";
  atrPct: number;
  slRatio?: number;
  family?: StrategyFamily;
  minSlAtrMultiplier?: number;
  familyProfileOverride?: { slAtrMultiplier: number };
}): number {
  const { entryPrice, direction, atrPct, slRatio = 1.0, family, minSlAtrMultiplier = 3.0, familyProfileOverride } = params;
  const familyProfile = familyProfileOverride || (family ? FAMILY_HOLD_PROFILE[family] : null);
  const baseMultiplier = familyProfile ? familyProfile.slAtrMultiplier : 2.5;
  const effectiveMultiplier = Math.max(baseMultiplier, minSlAtrMultiplier);
  const slPct = atrPct * effectiveMultiplier * slRatio;
  if (direction === "buy") {
    return entryPrice * (1 - slPct);
  } else {
    return entryPrice * (1 + slPct);
  }
}

export function calculateTrailingStop(params: {
  entryPrice: number;
  currentPrice: number;
  peakPrice: number;
  direction: "buy" | "sell";
  currentSl: number;
  trailPct?: number;
}): { newSl: number; updated: boolean } {
  const { currentPrice, peakPrice, direction, currentSl, trailPct = DEFAULT_TRAILING_STOP_PCT } = params;

  let newPeak = peakPrice;
  if (direction === "buy") {
    newPeak = Math.max(peakPrice, currentPrice);
  } else {
    newPeak = Math.min(peakPrice, currentPrice);
  }

  if (direction === "buy") {
    if (newPeak <= 0) return { newSl: currentSl, updated: false };
    const trailingSl = newPeak * (1 - trailPct);
    if (trailingSl > currentSl) {
      return { newSl: trailingSl, updated: true };
    }
  } else {
    if (newPeak <= 0) return { newSl: currentSl, updated: false };
    const trailingSl = newPeak * (1 + trailPct);
    if (trailingSl < currentSl) {
      return { newSl: trailingSl, updated: true };
    }
  }

  return { newSl: currentSl, updated: false };
}

export function checkTimeExit(params: {
  entryTs: Date;
  maxExitTs: Date;
  currentPnl: number;
  initialExitHours?: number;
  extensionHours?: number;
  maxExitHours?: number;
}): { shouldExit: boolean; shouldExtend: boolean; newMaxExitTs: Date | null; exitReason: string | null } {
  const {
    entryTs, maxExitTs, currentPnl,
    initialExitHours = INITIAL_EXIT_HOURS,
    extensionHours = EXTENSION_HOURS,
    maxExitHours = MAX_EXIT_HOURS,
  } = params;
  const now = new Date();
  const hoursOpen = (now.getTime() - entryTs.getTime()) / (1000 * 60 * 60);
  const hardMax = new Date(entryTs.getTime() + maxExitHours * 60 * 60 * 1000);

  if (now >= hardMax) {
    return { shouldExit: true, shouldExtend: false, newMaxExitTs: null, exitReason: "hard_time_limit" };
  }

  if (hoursOpen >= initialExitHours && now >= maxExitTs) {
    if (currentPnl > 0) {
      return { shouldExit: true, shouldExtend: false, newMaxExitTs: null, exitReason: "profitable_at_time_exit" };
    }

    const smallLossThreshold = -0.02;
    if (currentPnl < 0 && currentPnl > smallLossThreshold) {
      const extensionEnd = new Date(maxExitTs.getTime() + extensionHours * 60 * 60 * 1000);
      const cappedEnd = extensionEnd > hardMax ? hardMax : extensionEnd;
      if (cappedEnd > maxExitTs) {
        return { shouldExit: false, shouldExtend: true, newMaxExitTs: cappedEnd, exitReason: null };
      }
      return { shouldExit: true, shouldExtend: false, newMaxExitTs: null, exitReason: "max_extensions_reached" };
    }

    return { shouldExit: true, shouldExtend: false, newMaxExitTs: null, exitReason: "loss_at_time_exit" };
  }

  return { shouldExit: false, shouldExtend: false, newMaxExitTs: null, exitReason: null };
}

export async function getHistoricalAvgMove(symbol: string, strategyName: string): Promise<number> {
  const closedTrades = await db.select().from(tradesTable)
    .where(and(
      eq(tradesTable.symbol, symbol),
      eq(tradesTable.strategyName, strategyName),
      eq(tradesTable.status, "closed"),
    ))
    .orderBy(desc(tradesTable.exitTs))
    .limit(50);

  if (closedTrades.length < 5) return 0;

  const moves = closedTrades
    .filter(t => t.entryPrice > 0 && t.exitPrice !== null)
    .map(t => Math.abs((t.exitPrice! - t.entryPrice) / t.entryPrice));

  if (moves.length === 0) return 0;
  return moves.reduce((a, b) => a + b, 0) / moves.length;
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
    stateMap[`${prefix}_max_open_trades`] ||
    (mode === "paper" ? stateMap["paper_max_open_trades"] : stateMap["live_max_open_trades"]) ||
    String(MAX_OPEN_TRADES)
  );
  const modeEquityPct = parseFloat(
    stateMap[`${prefix}_equity_pct_per_trade`] ||
    (mode === "paper" ? stateMap["paper_equity_pct_per_trade"] : stateMap["live_equity_pct_per_trade"]) ||
    "22"
  );

  const openTrades = await db.select().from(tradesTable).where(
    and(eq(tradesTable.status, "open"), eq(tradesTable.mode, mode))
  );
  const totalDeployed = openTrades.reduce((sum, t) => sum + t.size, 0);

  const probeThreshold = parseFloat(stateMap[`${prefix}_probe_threshold`] || (mode === "paper" ? "75" : mode === "demo" ? "82" : "88"));
  const confirmationThreshold = parseFloat(stateMap[`${prefix}_confirmation_threshold`] || (mode === "paper" ? "80" : mode === "demo" ? "86" : "91"));
  const momentumThreshold = parseFloat(stateMap[`${prefix}_momentum_threshold`] || (mode === "paper" ? "85" : mode === "demo" ? "90" : "94"));

  const tradesOnSymbol = openTrades.filter(t => t.symbol === signal.symbol).length;
  const entryStage = determineEntryStage(tradesOnSymbol, signal.compositeScore ?? 85, {
    probe: probeThreshold, confirmation: confirmationThreshold, momentum: momentumThreshold,
  });
  if (!entryStage) {
    console.log(`[TradeEngine] [${mode.toUpperCase()}] Position building rejected: ${tradesOnSymbol} existing on ${signal.symbol}, score=${signal.compositeScore}`);
    return null;
  }

  const sizing = calculatePositionSize(equity, openTrades.length, totalDeployed, signal.confidence, modeMaxTrades, modeEquityPct);
  if (!sizing.allowed) {
    console.log(`[TradeEngine] [${mode.toUpperCase()}] Position sizing rejected: ${sizing.reason}`);
    return null;
  }

  const stageMultProbe = parseFloat(stateMap[`${prefix}_stage_multiplier_probe`] || (mode === "paper" ? "1.0" : mode === "demo" ? "0.85" : "0.70"));
  const stageMultConfirmation = parseFloat(stateMap[`${prefix}_stage_multiplier_confirmation`] || (mode === "paper" ? "0.90" : mode === "demo" ? "0.75" : "0.60"));
  const stageMultMomentum = parseFloat(stateMap[`${prefix}_stage_multiplier_momentum`] || (mode === "paper" ? "0.80" : mode === "demo" ? "0.65" : "0.50"));

  const stageMultiplier = getEntrySizeMultiplier(entryStage, {
    probe: stageMultProbe, confirmation: stageMultConfirmation, momentum: stageMultMomentum,
  });
  sizing.size = sizing.size * stageMultiplier;
  sizing.size = Math.max(sizing.size, equity * 0.05);

  if (decision.capitalAmount > 0 && decision.capitalAmount < sizing.size) {
    console.log(`[TradeEngine] [${mode.toUpperCase()}] AI-adjusted size cap: ${sizing.size.toFixed(2)} → ${decision.capitalAmount.toFixed(2)}`);
    sizing.size = decision.capitalAmount;
  }

  console.log(`[TradeEngine] [${mode.toUpperCase()}] Entry stage: ${entryStage} (${tradesOnSymbol} existing) | Size multiplier: ${stageMultiplier}`);

  const historicalAvgMovePct = await getHistoricalAvgMove(signal.symbol, signal.strategyName);

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

  const tpMultiplierStrong = parseFloat(stateMap[`${prefix}_tp_multiplier_strong`] || stateMap["tp_multiplier_strong"] || "2.5");
  const tpMultiplierMedium = parseFloat(stateMap[`${prefix}_tp_multiplier_medium`] || stateMap["tp_multiplier_medium"] || "2.0");
  const tpMultiplierWeak = parseFloat(stateMap[`${prefix}_tp_multiplier_weak`] || stateMap["tp_multiplier_weak"] || "1.5");
  const slRatio = parseFloat(stateMap[`${prefix}_sl_ratio`] || stateMap["sl_ratio"] || "1.0");
  const trailingStopPct = parseFloat(stateMap[`${prefix}_trailing_stop_pct`] || stateMap["trailing_stop_pct"] || "25") / 100;
  const timeExitHours = parseFloat(stateMap[`${prefix}_time_exit_window_hours`] || stateMap["time_exit_window_hours"] || String(INITIAL_EXIT_HOURS));

  const family: StrategyFamily = signal.strategyFamily || resolveFamilyFromStrategy(signal.strategyName);
  const familyDefaults = FAMILY_HOLD_PROFILE[family];

  const modeFamilyProfile = {
    tpAtrMultiplier: parseFloat(stateMap[`${prefix}_${family}_tp_atr_multiplier`] || String(familyDefaults.tpAtrMultiplier)),
    slAtrMultiplier: parseFloat(stateMap[`${prefix}_${family}_sl_atr_multiplier`] || String(familyDefaults.slAtrMultiplier)),
    initialExitHours: parseFloat(stateMap[`${prefix}_${family}_initial_exit_hours`] || String(familyDefaults.initialExitHours)),
    extensionHours: parseFloat(stateMap[`${prefix}_${family}_extension_hours`] || String(familyDefaults.extensionHours)),
    maxExitHours: parseFloat(stateMap[`${prefix}_${family}_max_exit_hours`] || String(familyDefaults.maxExitHours)),
    harvestSensitivity: parseFloat(stateMap[`${prefix}_${family}_harvest_sensitivity`] || String(familyDefaults.harvestSensitivity)),
  };

  const tpCaptureRatio = parseFloat(stateMap[`${prefix}_tp_capture_ratio`] || (mode === "paper" ? "0.80" : mode === "demo" ? "0.70" : "0.60"));
  const minSlAtrMultiplier = parseFloat(stateMap[`${prefix}_min_sl_atr_multiplier`] || (mode === "paper" ? "3.0" : mode === "demo" ? "3.5" : "4.0"));

  const tpMultiplier = signal.confidence >= 0.75 ? tpMultiplierStrong
    : signal.confidence >= 0.65 ? tpMultiplierMedium
    : tpMultiplierWeak;

  const tp = calculateDynamicTP({
    entryPrice: spotPrice,
    direction: signal.direction,
    confidence: signal.confidence,
    atrPct,
    historicalAvgMovePct,
    tpMultiplier,
    family,
    tpCaptureRatio,
    familyProfileOverride: { tpAtrMultiplier: modeFamilyProfile.tpAtrMultiplier },
  });

  const sl = calculateInitialSL({
    entryPrice: spotPrice,
    direction: signal.direction,
    atrPct,
    slRatio,
    family,
    minSlAtrMultiplier,
    familyProfileOverride: { slAtrMultiplier: modeFamilyProfile.slAtrMultiplier },
  });

  const entryTs = new Date();
  const effectiveTimeExit = Math.max(modeFamilyProfile.initialExitHours, timeExitHours);
  const maxExitTs = new Date(entryTs.getTime() + effectiveTimeExit * 60 * 60 * 1000);

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
      trailingStopPct: trailingStopPct,
      peakPrice: result.entrySpot,
      maxExitTs,
      currentPrice: result.entrySpot,
      notes: `Strategy: ${signal.strategyName}, Reason: ${signal.reason}`,
    }).returning();

    console.log(`[TradeEngine] Opened ${mode.toUpperCase()} ${signal.direction} on ${signal.symbol} @ ${result.entrySpot} | Size: $${sizing.size.toFixed(2)} | TP: ${tp.toFixed(4)} | SL: ${sl.toFixed(4)}`);
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
      trailingStopPct: trailingStopPct,
      peakPrice: spotPrice,
      maxExitTs,
      currentPrice: spotPrice,
      notes: `Strategy: ${signal.strategyName}, Reason: ${signal.reason}`,
    }).returning();

    console.log(`[TradeEngine] Opened PAPER ${signal.direction} on ${signal.symbol} @ ${spotPrice} | Size: $${sizing.size.toFixed(2)} | TP: ${tp.toFixed(4)} | SL: ${sl.toFixed(4)}`);
    return inserted.id;
  }
}

export async function manageOpenPositions(): Promise<void> {
  const openTrades = await db.select().from(tradesTable).where(eq(tradesTable.status, "open"));
  if (openTrades.length === 0) return;

  let fallbackClient;
  try {
    fallbackClient = await getDerivClientWithDbToken();
  } catch {
    // no fallback client available
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

      const trailingResult = calculateTrailingStop({
        entryPrice: trade.entryPrice,
        currentPrice,
        peakPrice: trade.peakPrice ?? trade.entryPrice,
        direction,
        currentSl: trade.sl,
        trailPct: trade.trailingStopPct ?? DEFAULT_TRAILING_STOP_PCT,
      });

      const newPeak = direction === "buy"
        ? Math.max(trade.peakPrice ?? trade.entryPrice, currentPrice)
        : Math.min(trade.peakPrice ?? trade.entryPrice, currentPrice);

      let activeSl = trade.sl;

      if (trailingResult.updated) {
        activeSl = trailingResult.newSl;
        await db.update(tradesTable)
          .set({ sl: trailingResult.newSl, peakPrice: newPeak })
          .where(eq(tradesTable.id, trade.id));

        if ((tradeMode === "demo" || tradeMode === "real") && trade.brokerTradeId && modeClient) {
          await modeClient.updateStopLoss(parseInt(trade.brokerTradeId), Math.abs(trailingResult.newSl - trade.entryPrice));
        }
        console.log(`[TradeEngine] Updated trailing SL for trade #${trade.id}: ${trailingResult.newSl.toFixed(4)}`);
      } else {
        await db.update(tradesTable)
          .set({ peakPrice: newPeak })
          .where(eq(tradesTable.id, trade.id));
      }

      const harvestSettings = await getHarvestSettings(tradeMode);
      const harvestFamily = resolveFamilyFromStrategy(trade.strategyName);
      const harvestPrefix = tradeMode === "paper" ? "paper" : tradeMode === "demo" ? "demo" : "real";
      const statesForHarvest = await db.select().from(platformStateTable);
      const stateMapForHarvest: Record<string, string> = {};
      for (const s of statesForHarvest) stateMapForHarvest[s.key] = s.value;
      const harvestSensitivity = parseFloat(stateMapForHarvest[`${harvestPrefix}_${harvestFamily}_harvest_sensitivity`] || String(FAMILY_HOLD_PROFILE[harvestFamily].harvestSensitivity));
      const harvestCheck = evaluateProfitHarvest({
        entryPrice: trade.entryPrice,
        currentPrice,
        peakPrice: newPeak,
        direction,
        tradeId: trade.id,
        peakDrawdownExitPct: harvestSettings.peakDrawdownExitPct / harvestSensitivity,
        minPeakProfitPct: harvestSettings.minPeakProfitPct / harvestSensitivity,
        largePeakThresholdPct: harvestSettings.largePeakThresholdPct / harvestSensitivity,
      });

      if (harvestCheck.shouldHarvest) {
        await closePosition(trade.id, currentPrice, `profit_harvest: ${harvestCheck.harvestReason}`);
        continue;
      }

      const slHit = direction === "buy"
        ? currentPrice <= activeSl
        : currentPrice >= activeSl;

      if (slHit) {
        await closePosition(trade.id, currentPrice, "trailing_stop_hit");
        continue;
      }

      const tpHit = direction === "buy"
        ? currentPrice >= trade.tp
        : currentPrice <= trade.tp;

      if (tpHit) {
        await closePosition(trade.id, currentPrice, "take_profit_hit");
        continue;
      }

      if (trade.maxExitTs) {
        const tradeFamily = resolveFamilyFromStrategy(trade.strategyName);
        const tradeFamilyDefaults = FAMILY_HOLD_PROFILE[tradeFamily];
        const tfInitialExitHours = parseFloat(stateMapForHarvest[`${harvestPrefix}_${tradeFamily}_initial_exit_hours`] || String(tradeFamilyDefaults.initialExitHours));
        const tfExtensionHours = parseFloat(stateMapForHarvest[`${harvestPrefix}_${tradeFamily}_extension_hours`] || String(tradeFamilyDefaults.extensionHours));
        const tfMaxExitHours = parseFloat(stateMapForHarvest[`${harvestPrefix}_${tradeFamily}_max_exit_hours`] || String(tradeFamilyDefaults.maxExitHours));

        const timeCheck = checkTimeExit({
          entryTs: trade.entryTs,
          maxExitTs: trade.maxExitTs,
          currentPnl: floatingPnl,
          initialExitHours: tfInitialExitHours,
          extensionHours: tfExtensionHours,
          maxExitHours: tfMaxExitHours,
        });

        if (timeCheck.shouldExit) {
          await closePosition(trade.id, currentPrice, timeCheck.exitReason ?? "time_exit");
          continue;
        }

        if (timeCheck.shouldExtend && timeCheck.newMaxExitTs) {
          await db.update(tradesTable)
            .set({ maxExitTs: timeCheck.newMaxExitTs })
            .where(eq(tradesTable.id, trade.id));
          console.log(`[TradeEngine] Extended trade #${trade.id} exit to ${timeCheck.newMaxExitTs.toISOString()}`);
        }
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

async function closePosition(tradeId: number, exitPrice: number, exitReason: string): Promise<void> {
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
}
