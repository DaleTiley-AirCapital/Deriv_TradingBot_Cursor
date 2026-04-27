import { runV3Backtest } from "../../core/backtest/backtestRunner.js";

const SYMBOL = "CRASH300";

export async function runCrash300Backtest(params: {
  startTs: number;
  endTs: number;
  mode: "paper" | "demo" | "real";
}) {
  return runV3Backtest({
    symbol: SYMBOL,
    startTs: params.startTs,
    endTs: params.endTs,
    mode: params.mode,
    tierMode: "ALL",
  });
}
