import type {
  Crash300ContextSnapshot,
  Crash300PhaseDerivedFamily,
  Crash300SemanticTriggerSnapshot,
} from "./features.js";

export function deriveCrash300RuntimeFamily(params: {
  context: Crash300ContextSnapshot;
  trigger: Crash300SemanticTriggerSnapshot;
  moveDirection?: "up" | "down" | "unknown";
}): Crash300PhaseDerivedFamily {
  const direction = params.moveDirection ?? "unknown";
  const transition = params.trigger.triggerTransition;

  if (transition === "bear_trap_reversal_up" || transition === "failed_down_impulse_reclaim_up") {
    return "bear_trap_reversal_up";
  }
  if (transition === "bull_trap_reversal_down" || transition === "failed_up_impulse_break_down") {
    return "bull_trap_reversal_down";
  }
  if (transition === "post_crash_recovery_reclaim_up" || transition === "recovery_continuation_up") {
    return "post_crash_recovery_up";
  }
  if (transition === "crash_continuation_down") {
    return "crash_event_down";
  }
  if (transition === "failed_recovery_break_down") {
    return "failed_recovery_short";
  }
  if (transition === "compression_break_up" && params.trigger.triggerDirection === "buy") {
    return "drift_continuation_up";
  }
  if (transition === "compression_break_down" && params.trigger.triggerDirection === "sell") {
    return params.context.crashRecencyScore > 0.35 ? "crash_event_down" : "failed_recovery_short";
  }

  if (direction === "up") {
    if (
      params.context.crashRecencyScore > 0.2 &&
      ((params.context.recoveryFromLastCrashPct ?? 0) > 0 || params.context.recoveryQualityScore >= params.context.trendPersistenceScore)
    ) {
      return "post_crash_recovery_up";
    }
    if (params.context.trendPersistenceScore > 0.45) {
      return "drift_continuation_up";
    }
  }

  if (direction === "down") {
    if (
      params.context.crashRecencyScore > 0.4 &&
      params.context.compressionToExpansionScore > 0.45
    ) {
      return "crash_event_down";
    }
    if (params.context.recoveryQualityScore < Math.max(0.35, params.context.trendPersistenceScore - 0.05)) {
      return "failed_recovery_short";
    }
  }

  return "unknown";
}
