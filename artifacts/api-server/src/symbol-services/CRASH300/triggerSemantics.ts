import type { CandleRow } from "../../core/backtest/featureSlice.js";
import type {
  Crash300ContextSnapshot,
  Crash300SemanticTriggerSnapshot,
  Crash300SemanticsMode,
  Crash300TriggerSnapshot,
  Crash300TriggerTransition,
} from "./features.js";
import { buildCrash300TriggerSnapshot } from "./trigger.js";

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function atrPct(context: Crash300ContextSnapshot): number {
  return Math.max(context.atr14 / Math.max(context.latestClose, 1), 0.0005);
}

function isStrongDirectionalImpulse(
  snapshot: Crash300TriggerSnapshot,
  context: Crash300ContextSnapshot,
  direction: "up" | "down",
): boolean {
  const base = atrPct(context);
  if (direction === "down") {
    return (
      snapshot.oneBarReturnPct <= -Math.max(base * 0.7, 0.0015) ||
      snapshot.oneBarMomentum <= -0.9 ||
      (snapshot.microBreakDirection === "down" && snapshot.impulseScore >= 0.65)
    );
  }
  return (
    snapshot.oneBarReturnPct >= Math.max(base * 0.7, 0.0015) ||
    snapshot.oneBarMomentum >= 0.9 ||
    (snapshot.microBreakDirection === "up" && snapshot.impulseScore >= 0.65)
  );
}

function reclaimsAdverseBody(
  adverse: Crash300TriggerSnapshot,
  candidate: Crash300TriggerSnapshot,
  direction: "up" | "down",
): boolean {
  const body = Math.abs(adverse.candleOpen - adverse.candleClose);
  if (direction === "up") {
    const reclaimHalfBody = candidate.candleClose >= adverse.candleClose + body * 0.5;
    const reclaimOpen = candidate.candleClose >= adverse.candleOpen || candidate.candleHigh >= adverse.candleOpen;
    return reclaimHalfBody || reclaimOpen;
  }
  const reclaimHalfBody = candidate.candleClose <= adverse.candleClose - body * 0.5;
  const reclaimOpen = candidate.candleClose <= adverse.candleOpen || candidate.candleLow <= adverse.candleOpen;
  return reclaimHalfBody || reclaimOpen;
}

function momentumReclaims(
  adverse: Crash300TriggerSnapshot,
  candidate: Crash300TriggerSnapshot,
  direction: "up" | "down",
): boolean {
  if (direction === "up") {
    return (
      candidate.threeBarReturnPct > adverse.threeBarReturnPct ||
      candidate.oneBarMomentum > adverse.oneBarMomentum + 0.6 ||
      candidate.closeLocationInRangePct >= 0.55
    );
  }
  return (
    candidate.threeBarReturnPct < adverse.threeBarReturnPct ||
    candidate.oneBarMomentum < adverse.oneBarMomentum - 0.6 ||
    candidate.closeLocationInRangePct <= 0.45
  );
}

function applyTransition(
  base: Crash300SemanticTriggerSnapshot,
  transition: Crash300TriggerTransition,
  direction: "buy" | "sell",
  mode: Crash300SemanticsMode,
  confirmationOffsetBars: number | null,
  reclaimConfirmed = false,
): Crash300SemanticTriggerSnapshot {
  return {
    ...base,
    triggerTransition: transition,
    triggerDirection: direction,
    triggerDiagnosticOnly: mode === "diagnostic" && confirmationOffsetBars !== null && confirmationOffsetBars !== 0,
    liveEligibleTrigger: mode === "runtime",
    triggerConfirmationOffsetBars: confirmationOffsetBars,
    reclaimConfirmed,
  };
}

export function detectCrash300TriggerTransition(params: {
  context: Crash300ContextSnapshot;
  trigger: Crash300TriggerSnapshot;
  priorTriggers: Crash300TriggerSnapshot[];
  mode: Crash300SemanticsMode;
  offsetBars?: number;
}): Crash300SemanticTriggerSnapshot {
  const { context, trigger, priorTriggers, mode } = params;
  const base: Crash300SemanticTriggerSnapshot = {
    ...trigger,
    triggerDiagnosticOnly: false,
    liveEligibleTrigger: false,
    triggerConfirmationOffsetBars: params.offsetBars ?? 0,
    adverseImpulseBeforeTrigger: false,
    adverseImpulseDirection: "none",
    adverseImpulsePct: 0,
    reclaimConfirmed: false,
  };

  const recent = priorTriggers.slice(-3);
  const recentDownImpulse = [...recent].reverse().find((snapshot) =>
    isStrongDirectionalImpulse(snapshot, context, "down"),
  ) ?? null;
  const recentUpImpulse = [...recent].reverse().find((snapshot) =>
    isStrongDirectionalImpulse(snapshot, context, "up"),
  ) ?? null;

  if (recentDownImpulse) {
    base.adverseImpulseBeforeTrigger = true;
    base.adverseImpulseDirection = "down";
    base.adverseImpulsePct = Math.abs(recentDownImpulse.oneBarReturnPct);
  } else if (recentUpImpulse) {
    base.adverseImpulseBeforeTrigger = true;
    base.adverseImpulseDirection = "up";
    base.adverseImpulsePct = Math.abs(recentUpImpulse.oneBarReturnPct);
  }

  if (recentDownImpulse) {
    const reclaim = reclaimsAdverseBody(recentDownImpulse, trigger, "up");
    const momentum = momentumReclaims(recentDownImpulse, trigger, "up");
    const noFurtherDownImpulse =
      trigger.microBreakDirection !== "down" || trigger.oneBarReturnPct > recentDownImpulse.oneBarReturnPct;
    if (reclaim && momentum && noFurtherDownImpulse) {
      return applyTransition(
        {
          ...base,
          adverseImpulseBeforeTrigger: true,
          adverseImpulseDirection: "down",
          adverseImpulsePct: Math.abs(recentDownImpulse.oneBarReturnPct),
        },
        recentDownImpulse.microBreakDirection === "down" || recentDownImpulse.impulseScore >= 0.75
          ? "bear_trap_reversal_up"
          : "failed_down_impulse_reclaim_up",
        "buy",
        mode,
        params.offsetBars ?? 0,
        true,
      );
    }
  }

  if (recentUpImpulse) {
    const reclaim = reclaimsAdverseBody(recentUpImpulse, trigger, "down");
    const momentum = momentumReclaims(recentUpImpulse, trigger, "down");
    const noFurtherUpImpulse =
      trigger.microBreakDirection !== "up" || trigger.oneBarReturnPct < recentUpImpulse.oneBarReturnPct;
    if (reclaim && momentum && noFurtherUpImpulse) {
      return applyTransition(
        {
          ...base,
          adverseImpulseBeforeTrigger: true,
          adverseImpulseDirection: "up",
          adverseImpulsePct: Math.abs(recentUpImpulse.oneBarReturnPct),
        },
        recentUpImpulse.microBreakDirection === "up" || recentUpImpulse.impulseScore >= 0.75
          ? "bull_trap_reversal_down"
          : "failed_up_impulse_break_down",
        "sell",
        mode,
        params.offsetBars ?? 0,
        true,
      );
    }
  }

  const contextHasRecovery =
    context.crashRecencyScore > 0.2 &&
    ((context.recoveryFromLastCrashPct ?? 0) > 0 || context.recoveryQualityScore >= context.trendPersistenceScore);
  const reclaimsEmaZone = context.priceVsEma20Pct >= -0.002 || context.priceVsEma50Pct >= -0.004;
  if (
    contextHasRecovery &&
    context.recoveryQualityScore >= Math.max(0.35, context.trendPersistenceScore - 0.1) &&
    (trigger.candleDirection === "up" || reclaimsEmaZone || trigger.closeLocationInRangePct >= 0.6)
  ) {
    return applyTransition(base, "post_crash_recovery_reclaim_up", "buy", mode, params.offsetBars ?? 0, reclaimsEmaZone);
  }

  if (
    context.crashRecencyScore > 0.45 &&
    trigger.oneBarReturnPct < 0 &&
    trigger.fiveBarReturnPct < 0 &&
    (trigger.microBreakDirection === "down" || trigger.impulseScore >= 0.7)
  ) {
    return applyTransition(base, "crash_continuation_down", "sell", mode, params.offsetBars ?? 0);
  }

  if (trigger.triggerDirection !== "none") {
    return {
      ...base,
      liveEligibleTrigger: mode === "runtime",
      triggerDiagnosticOnly: mode === "diagnostic" && (params.offsetBars ?? 0) !== 0,
      triggerConfirmationOffsetBars: params.offsetBars ?? 0,
    };
  }

  return base;
}

export function buildCrash300TriggerHistory(params: {
  symbol: string;
  candles: CandleRow[];
  contextByTs: Map<number, Crash300ContextSnapshot>;
  mode: Crash300SemanticsMode;
  offsets: number[];
  baseIndex: number;
}): Crash300SemanticTriggerSnapshot[] {
  const snapshots: Crash300SemanticTriggerSnapshot[] = [];
  for (const offset of params.offsets) {
    const index = Math.max(0, Math.min(params.candles.length - 1, params.baseIndex + offset));
    const slice = params.candles.slice(0, index + 1);
    const candle = params.candles[index];
    if (!candle) continue;
    const context = params.contextByTs.get(candle.closeTs);
    if (!context) continue;
    const raw = buildCrash300TriggerSnapshot({
      symbol: params.symbol,
      ts: candle.closeTs,
      candles: slice,
      context,
    });
    const semantic = detectCrash300TriggerTransition({
      context,
      trigger: raw,
      priorTriggers: snapshots,
      mode: params.mode,
      offsetBars: offset,
    });
    snapshots.push(semantic);
  }
  return snapshots;
}
