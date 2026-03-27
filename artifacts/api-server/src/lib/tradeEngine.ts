import { db, tradesTable, platformStateTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { getDerivClientForMode, getDerivClientWithDbToken, getModeCapitalKey, getModeCapitalDefault } from "./deriv.js";
import type { TradingMode } from "./deriv.js";
import type { AllocationDecision } from "./signalRouter.js";
import { checkAndAutoExtract } from "./extractionEngine.js";

const MAX_OPEN_TRADES = 3;
const MAX_EQUITY_DEPLOYED_PCT = 0.80;
const PROFIT_TRAILING_DRAWDOWN_PCT = 0.30;
const TIME_EXIT_PROFIT_HOURS = 72;
const TIME_EXIT_HARD_CAP_HOURS = 168;

export type StrategyFamily = "trend_continuation" | "mean_reversion" | "breakout_expansion" | "spike_event";

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
  const basePct = pctDecimal * (0.8 + 0.4 * confidence);
  let size = equity * basePct;

  size = Math.min(size, remainingCapacity);
  size = Math.max(size, equity * 0.05);

  if (size > remainingCapacity) {
    return { size: 0, allowed: false, reason: "Insufficient remaining capacity" };
  }

  return { size, allowed: true, reason: "ok" };
}

export function calculateSRFibTP(params: {
  entryPrice: number;
  direction: "buy" | "sell";
  swingHigh: number;
  swingLow: number;
  fibExtensionLevels: number[];
  fibExtensionLevelsDown?: number[];
  bbUpper: number;
  bbLower: number;
  atrPct: number;
}): number {
  const { entryPrice, direction, swingHigh, swingLow, fibExtensionLevels, fibExtensionLevelsDown, bbUpper, bbLower, atrPct } = params;

  if (direction === "buy") {
    const resistanceLevels = [
      swingHigh,
      ...fibExtensionLevels.filter(l => l > entryPrice),
      bbUpper,
    ].filter(l => l > entryPrice).sort((a, b) => a - b);

    if (resistanceLevels.length === 0) {
      return entryPrice * (1 + atrPct * 6);
    }

    let bestTp = resistanceLevels[0];
    for (const level of resistanceLevels) {
      const nearby = resistanceLevels.filter(l => Math.abs(l - level) / level < 0.005);
      if (nearby.length >= 2) {
        bestTp = Math.min(...nearby);
        break;
      }
    }

    const minTp = entryPrice * (1 + atrPct * 3);
    bestTp = Math.max(bestTp, minTp);

    let tp = bestTp * 0.998;
    if (tp <= entryPrice) tp = entryPrice * (1 + atrPct * 3);
    return tp;
  } else {
    const downExtensions = fibExtensionLevelsDown ?? [];
    const supportLevels = [
      swingLow,
      ...downExtensions.filter(l => l < entryPrice && l > 0),
      bbLower,
    ].filter(l => l < entryPrice && l > 0).sort((a, b) => b - a);

    if (supportLevels.length === 0) {
      return entryPrice * (1 - atrPct * 6);
    }

    let bestTp = supportLevels[0];
    for (const level of supportLevels) {
      const nearby = supportLevels.filter(l => Math.abs(l - level) / level < 0.005);
      if (nearby.length >= 2) {
        bestTp = Math.max(...nearby);
        break;
      }
    }

    const minTp = entryPrice * (1 - atrPct * 3);
    bestTp = Math.min(bestTp, minTp);

    let tp = bestTp * 1.002;
    if (tp >= entryPrice) tp = entryPrice * (1 - atrPct * 3);
    return tp;
  }
}

export function calculateSRFibSL(params: {
  entryPrice: number;
  direction: "buy" | "sell";
  swingHigh: number;
  swingLow: number;
  fibRetraceLevels: number[];
  bbUpper: number;
  bbLower: number;
  atrPct: number;
  positionSize: number;
  equity: number;
}): number {
  const { entryPrice, direction, swingHigh, swingLow, fibRetraceLevels, bbUpper, bbLower, atrPct, positionSize, equity } = params;

  if (direction === "buy") {
    const supportLevels = [
      swingLow,
      ...fibRetraceLevels.filter(l => l < entryPrice && l > 0),
      bbLower,
    ].filter(l => l < entryPrice && l > 0).sort((a, b) => b - a);

    let sl: number;
    if (supportLevels.length === 0) {
      sl = entryPrice * (1 - atrPct * 2.5);
    } else {
      let bestSl = supportLevels[0];
      for (const level of supportLevels) {
        const nearby = supportLevels.filter(l => Math.abs(l - level) / level < 0.005);
        if (nearby.length >= 2) {
          bestSl = Math.max(...nearby);
          break;
        }
      }
      sl = bestSl * 0.998;
    }

    const maxSlDistance = (equity * 0.10) / positionSize;
    const safetyFloor = entryPrice * (1 - maxSlDistance);
    sl = Math.max(sl, safetyFloor);

    if (sl >= entryPrice) sl = entryPrice * (1 - atrPct * 2.5);
    return sl;
  } else {
    const resistanceLevels = [
      swingHigh,
      ...fibRetraceLevels.filter(l => l > entryPrice),
      bbUpper,
    ].filter(l => l > entryPrice).sort((a, b) => a - b);

    let sl: number;
    if (resistanceLevels.length === 0) {
      sl = entryPrice * (1 + atrPct * 2.5);
    } else {
      let bestSl = resistanceLevels[0];
      for (const level of resistanceLevels) {
        const nearby = resistanceLevels.filter(l => Math.abs(l - level) / level < 0.005);
        if (nearby.length >= 2) {
          bestSl = Math.min(...nearby);
          break;
        }
      }
      sl = bestSl * 1.002;
    }

    const maxSlDistance = (equity * 0.10) / positionSize;
    const safetyCeiling = entryPrice * (1 + maxSlDistance);
    sl = Math.min(sl, safetyCeiling);

    if (sl <= entryPrice) sl = entryPrice * (1 + atrPct * 2.5);
    return sl;
  }
}

export function calculateProfitTrailingStop(params: {
  entryPrice: number;
  currentPrice: number;
  peakPrice: number;
  direction: "buy" | "sell";
  currentSl: number;
}): { newSl: number; updated: boolean } {
  const { entryPrice, currentPrice, peakPrice, direction, currentSl } = params;

  const currentPnlPct = direction === "buy"
    ? (currentPrice - entryPrice) / entryPrice
    : (entryPrice - currentPrice) / entryPrice;

  if (currentPnlPct <= 0) {
    return { newSl: currentSl, updated: false };
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

export function checkTimeExit(params: {
  entryTs: Date;
  currentPnl: number;
}): { shouldExit: boolean; exitReason: string | null } {
  const { entryTs, currentPnl } = params;
  const now = new Date();
  const hoursOpen = (now.getTime() - entryTs.getTime()) / (1000 * 60 * 60);

  if (hoursOpen >= TIME_EXIT_HARD_CAP_HOURS) {
    return { shouldExit: true, exitReason: "hard_time_limit_168h" };
  }

  if (hoursOpen >= TIME_EXIT_PROFIT_HOURS) {
    if (currentPnl > 0) {
      return { shouldExit: true, exitReason: "profitable_at_72h" };
    }
  }

  return { shouldExit: false, exitReason: null };
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

  const tp = calculateSRFibTP({
    entryPrice: spotPrice,
    direction: signal.direction,
    swingHigh,
    swingLow,
    fibExtensionLevels,
    fibExtensionLevelsDown,
    bbUpper,
    bbLower,
    atrPct,
  });

  const sl = calculateSRFibSL({
    entryPrice: spotPrice,
    direction: signal.direction,
    swingHigh,
    swingLow,
    fibRetraceLevels,
    bbUpper,
    bbLower,
    atrPct,
    positionSize: sizing.size,
    equity,
  });

  const entryTs = new Date();
  const maxExitTs = new Date(entryTs.getTime() + TIME_EXIT_HARD_CAP_HOURS * 60 * 60 * 1000);

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
      maxExitTs,
      currentPrice: result.entrySpot,
      notes: `V2 S/R+Fib | Strategy: ${signal.strategyName} | Reason: ${signal.reason}`,
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
      trailingStopPct: PROFIT_TRAILING_DRAWDOWN_PCT,
      peakPrice: spotPrice,
      maxExitTs,
      currentPrice: spotPrice,
      notes: `V2 S/R+Fib | Strategy: ${signal.strategyName} | Reason: ${signal.reason}`,
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

      const newPeak = direction === "buy"
        ? Math.max(trade.peakPrice ?? trade.entryPrice, currentPrice)
        : Math.min(trade.peakPrice ?? trade.entryPrice, currentPrice);

      const trailingResult = calculateProfitTrailingStop({
        entryPrice: trade.entryPrice,
        currentPrice,
        peakPrice: newPeak,
        direction,
        currentSl: trade.sl,
      });

      let activeSl = trade.sl;

      if (trailingResult.updated) {
        activeSl = trailingResult.newSl;
        await db.update(tradesTable)
          .set({ sl: trailingResult.newSl, peakPrice: newPeak })
          .where(eq(tradesTable.id, trade.id));

        if ((tradeMode === "demo" || tradeMode === "real") && trade.brokerTradeId && modeClient) {
          await modeClient.updateStopLoss(parseInt(trade.brokerTradeId), Math.abs(trailingResult.newSl - trade.entryPrice));
        }
        console.log(`[TradeEngine] Updated profit-trailing SL for trade #${trade.id}: ${trailingResult.newSl.toFixed(4)} (peak profit trail)`);
      } else {
        await db.update(tradesTable)
          .set({ peakPrice: newPeak })
          .where(eq(tradesTable.id, trade.id));
      }

      const slHit = direction === "buy"
        ? currentPrice <= activeSl
        : currentPrice >= activeSl;

      if (slHit) {
        await closePosition(trade.id, currentPrice, "stop_loss_hit");
        continue;
      }

      const tpHit = direction === "buy"
        ? currentPrice >= trade.tp
        : currentPrice <= trade.tp;

      if (tpHit) {
        await closePosition(trade.id, currentPrice, "take_profit_hit");
        continue;
      }

      const timeCheck = checkTimeExit({
        entryTs: trade.entryTs,
        currentPnl: floatingPnl,
      });

      if (timeCheck.shouldExit) {
        await closePosition(trade.id, currentPrice, timeCheck.exitReason ?? "time_exit");
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
