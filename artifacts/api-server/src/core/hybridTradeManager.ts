/**
 * V3 Hybrid Trade Manager
 *
 * Implements staged trade management layered on top of the existing trade engine.
 *
 * Stage model:
 *   Stage 1 — entry: SL at original position (below/above entry)
 *   Stage 2 — protection: SL moved to breakeven after 20% of TP distance reached
 *   Stage 3 — runner: adaptive trailing stop from 30% of TP (handled by tradeEngine)
 *
 * This module handles ONLY Stage 1→2 SL promotion.
 * Stage 2→3 trailing stop activation is handled by the existing tradeEngine.
 * Trade closes are handled by manageOpenPositions in tradeEngine.
 *
 * Call order in positionManagementCycle:
 *   1. promoteBreakevenSls()  ← this module (stage 2 promotion)
 *   2. manageOpenPositions()  ← tradeEngine (trailing stop + closes)
 *
 * No DB schema changes required.
 */
import { db, tradesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import type { TradingMode } from "../infrastructure/deriv.js";

// Stage 2 activates when trade profit reaches 20% of the TP distance
const STAGE2_BREAKEVEN_THRESHOLD_PCT = 0.20;

function inferHybridStage(
  entryPrice: number,
  currentSl: number,
  direction: "buy" | "sell",
): 1 | 2 | 3 {
  if (direction === "buy") {
    if (currentSl < entryPrice * 0.9998) return 1;
    if (currentSl >= entryPrice * 0.9998 && currentSl <= entryPrice * 1.002) return 2;
    return 3;
  } else {
    if (currentSl > entryPrice * 1.0002) return 1;
    if (currentSl <= entryPrice * 1.0002 && currentSl >= entryPrice * 0.998) return 2;
    return 3;
  }
}

function calcBreakevenSl(entryPrice: number, direction: "buy" | "sell"): number {
  // Small buffer above/below entry to avoid immediate stop-out due to spread
  const buffer = entryPrice * 0.0005;
  return direction === "buy" ? entryPrice + buffer : entryPrice - buffer;
}

/**
 * Promotes stage-1 trades to stage-2 (breakeven SL) when price has moved
 * 20%+ of the TP distance in favor.
 *
 * Only updates SL. Does not close trades. Closes are handled by manageOpenPositions.
 */
export async function promoteBreakevenSls(): Promise<void> {
  const openTrades = await db.select().from(tradesTable)
    .where(eq(tradesTable.status, "open"));

  if (openTrades.length === 0) return;

  for (const trade of openTrades) {
    try {
      const direction = trade.side as "buy" | "sell";
      const entryPrice = trade.entryPrice;
      const tp = trade.tp;
      const currentSl = trade.sl;
      const currentPrice = trade.currentPrice ?? entryPrice;

      // Only promote stage-1 trades
      const stage = inferHybridStage(entryPrice, currentSl, direction);
      if (stage !== 1) continue;

      // Calculate progress toward TP
      const tpDist = Math.abs(tp - entryPrice);
      if (tpDist <= 0) continue;

      const currentDist = direction === "buy"
        ? Math.max(0, currentPrice - entryPrice)
        : Math.max(0, entryPrice - currentPrice);

      const progress = currentDist / tpDist;

      if (progress < STAGE2_BREAKEVEN_THRESHOLD_PCT) continue;

      const beSl = calcBreakevenSl(entryPrice, direction);

      // Only update if the breakeven SL is better than the current SL
      const slImproved = direction === "buy"
        ? beSl > currentSl
        : beSl < currentSl;

      if (!slImproved) continue;

      await db.update(tradesTable)
        .set({ sl: beSl })
        .where(eq(tradesTable.id, trade.id));

      console.log(
        `[HybridMgr] Trade ${trade.id} ${trade.symbol} | Stage 1→2 | ` +
        `SL promoted to breakeven ${beSl.toFixed(4)} | ` +
        `progress=${(progress * 100).toFixed(1)}% of TP | mode=${trade.mode}`
      );
    } catch (err) {
      console.error(`[HybridMgr] Error promoting trade ${trade.id}:`, err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Returns the hybrid stage for a given trade (for diagnostics/logging).
 */
export function getTradeHybridStage(
  entryPrice: number,
  currentSl: number,
  direction: "buy" | "sell",
): 1 | 2 | 3 {
  return inferHybridStage(entryPrice, currentSl, direction);
}
