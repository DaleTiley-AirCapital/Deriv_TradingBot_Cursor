import type { CandleRow } from "../../core/backtest/featureSlice.js";
import type { Crash300ContextSnapshot, Crash300TriggerSnapshot, Crash300TriggerTransition } from "./features.js";

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function pctChange(current: number, base: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(base) || base === 0) return 0;
  return (current - base) / Math.abs(base);
}

function range(candle: CandleRow): number {
  return Math.max(0, candle.high - candle.low);
}

export function buildCrash300TriggerSnapshot(params: {
  symbol: string;
  ts: number;
  candles: CandleRow[];
  context: Crash300ContextSnapshot;
}): Crash300TriggerSnapshot {
  const last = params.candles[params.candles.length - 1];
  if (!last) {
    throw new Error("CRASH300 runtime trigger missing: no current 1m candle.");
  }
  const prev1 = params.candles[params.candles.length - 2] ?? last;
  const prev3 = params.candles[Math.max(0, params.candles.length - 4)] ?? prev1;
  const prev5 = params.candles[Math.max(0, params.candles.length - 6)] ?? prev3;
  const last15 = params.candles.slice(-15);
  const windowHigh15 = Math.max(...last15.map((c) => c.high));
  const windowLow15 = Math.min(...last15.map((c) => c.low));
  const body = Math.abs(last.close - last.open);
  const candleRange = range(last);
  const candleBodyPct = candleRange > 0 ? body / candleRange : 0;
  const upperWickPct = candleRange > 0 ? (last.high - Math.max(last.close, last.open)) / candleRange : 0;
  const lowerWickPct = candleRange > 0 ? (Math.min(last.close, last.open) - last.low) / candleRange : 0;
  const closeLocationInRangePct = candleRange > 0 ? (last.close - last.low) / candleRange : 0.5;
  const oneBarReturnPct = pctChange(last.close, prev1.close);
  const threeBarReturnPct = pctChange(last.close, prev3.close);
  const fiveBarReturnPct = pctChange(last.close, prev5.close);
  const impulseBase = Math.max(params.context.atr14 / Math.max(last.close, 1), 0.001);
  const oneBarMomentum = oneBarReturnPct / impulseBase;
  const threeBarMomentum = threeBarReturnPct / Math.max(impulseBase * 2.5, 1e-9);
  const fiveBarMomentum = fiveBarReturnPct / Math.max(impulseBase * 4, 1e-9);
  const breakoutUp = last.close > windowHigh15 * (1 - 0.0005);
  const breakoutDown = last.close < windowLow15 * (1 + 0.0005);
  const microBreakDirection = breakoutUp ? "up" : breakoutDown ? "down" : "none";
  const microBreakStrengthPct = breakoutUp
    ? pctChange(last.close, windowHigh15)
    : breakoutDown
      ? pctChange(windowLow15, last.close)
      : 0;
  const reversalWickDirection = lowerWickPct > 0.45 && closeLocationInRangePct > 0.65
    ? "up"
    : upperWickPct > 0.45 && closeLocationInRangePct < 0.35
      ? "down"
      : "none";
  const rejectionScore = clamp01(
    Math.max(lowerWickPct, upperWickPct) * 0.5 +
      Math.abs(closeLocationInRangePct - 0.5) * 0.5,
  );
  const impulseScore = clamp01(
    candleBodyPct * 0.4 +
      clamp01(Math.abs(oneBarMomentum) / 2.5) * 0.25 +
      clamp01(Math.abs(threeBarMomentum) / 2.2) * 0.2 +
      clamp01(Math.abs(fiveBarMomentum) / 2) * 0.15,
  );

  let triggerTransition: Crash300TriggerTransition = "none";
  let triggerDirection: "buy" | "sell" | "none" = "none";
  let confirmationBars = 0;
  if (
    params.context.compressionToExpansionScore > 0.55 &&
    params.context.trendPersistenceScore > 0.55 &&
    breakoutUp &&
    oneBarReturnPct > 0
  ) {
    triggerTransition = "compression_break_up";
    triggerDirection = "buy";
    confirmationBars = threeBarReturnPct > 0 ? 2 : 1;
  } else if (
    params.context.compressionToExpansionScore > 0.55 &&
    breakoutDown &&
    oneBarReturnPct < 0
  ) {
    triggerTransition = "compression_break_down";
    triggerDirection = "sell";
    confirmationBars = threeBarReturnPct < 0 ? 2 : 1;
  } else if (
    params.context.crashRecencyScore > 0.2 &&
    params.context.recoveryQualityScore > 0.55 &&
    (reversalWickDirection === "up" || (oneBarReturnPct > 0 && threeBarReturnPct > 0))
  ) {
    triggerTransition = "recovery_continuation_up";
    triggerDirection = "buy";
    confirmationBars = threeBarReturnPct > 0 ? 2 : 1;
  } else if (
    params.context.crashRecencyScore > 0.2 &&
    params.context.recoveryQualityScore < 0.55 &&
    (reversalWickDirection === "down" || breakoutDown)
  ) {
    triggerTransition = "failed_recovery_break_down";
    triggerDirection = "sell";
    confirmationBars = threeBarReturnPct < 0 ? 2 : 1;
  } else if (
    params.context.crashRecencyScore > 0.45 &&
    oneBarReturnPct < 0 &&
    fiveBarReturnPct < 0 &&
    breakoutDown
  ) {
    triggerTransition = "crash_continuation_down";
    triggerDirection = "sell";
    confirmationBars = 1;
  }

  const triggerStrengthScore = clamp01(
    impulseScore * 0.45 +
      rejectionScore * 0.15 +
      clamp01(Math.abs(microBreakStrengthPct) / 0.01) * 0.2 +
      clamp01(Math.abs(oneBarReturnPct) / 0.008) * 0.1 +
      clamp01(Math.abs(threeBarReturnPct) / 0.015) * 0.1,
  );

  return {
    ts: params.ts,
    symbol: params.symbol,
    candleOpen: last.open,
    candleHigh: last.high,
    candleLow: last.low,
    candleClose: last.close,
    candleDirection: last.close > last.open ? "up" : last.close < last.open ? "down" : "flat",
    candleBodyPct,
    upperWickPct,
    lowerWickPct,
    closeLocationInRangePct,
    oneBarReturnPct,
    threeBarReturnPct,
    fiveBarReturnPct,
    oneBarMomentum,
    threeBarMomentum,
    fiveBarMomentum,
    microBreakDirection,
    microBreakStrengthPct,
    reversalWickDirection,
    rejectionScore,
    impulseScore,
    triggerTransition,
    confirmationBars,
    triggerDirection,
    triggerStrengthScore,
  };
}

