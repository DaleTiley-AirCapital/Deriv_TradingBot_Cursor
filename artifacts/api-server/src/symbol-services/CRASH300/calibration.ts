import { db, detectedMovesTable } from "@workspace/db";
import { and, eq, gte, lte } from "drizzle-orm";
import { runV3Backtest } from "../../core/backtest/backtestRunner.js";

const SYMBOL = "CRASH300";

export async function runCrash300CalibrationParity(params: {
  startTs?: number;
  endTs?: number;
  mode?: "parity" | "trading_sim";
}) {
  const endTs = params.endTs ?? Math.floor(Date.now() / 1000);
  const startTs = params.startTs ?? (endTs - 365 * 86400);
  const tradingMode = params.mode === "trading_sim" ? "paper" : "paper";

  const backtest = await runV3Backtest({
    symbol: SYMBOL,
    startTs,
    endTs,
    mode: tradingMode,
    tierMode: "ALL",
  });

  const whereClause = and(
    eq(detectedMovesTable.symbol, SYMBOL),
    gte(detectedMovesTable.startTs, startTs),
    lte(detectedMovesTable.startTs, endTs),
  );
  const moves = await db
    .select({
      id: detectedMovesTable.id,
      startTs: detectedMovesTable.startTs,
      endTs: detectedMovesTable.endTs,
      direction: detectedMovesTable.direction,
      movePct: detectedMovesTable.movePct,
      moveType: detectedMovesTable.moveType,
    })
    .from(detectedMovesTable)
    .where(whereClause);

  return {
    symbol: SYMBOL,
    mode: params.mode ?? "parity",
    runtimeModel: backtest.runtimeModel,
    totals: {
      totalMoves: moves.length,
      matchedMoves: backtest.moveOverlap.capturedMoves,
      missedMoves: backtest.moveOverlap.missedMoves,
      ghostTrades: backtest.moveOverlap.ghostTrades,
      captureRate: backtest.moveOverlap.captureRate,
    },
    summary: backtest.summary,
  };
}
