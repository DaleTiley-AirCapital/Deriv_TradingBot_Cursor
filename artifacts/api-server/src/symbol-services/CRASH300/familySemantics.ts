import type {
  Crash300ContextSnapshot,
  Crash300PhaseDerivedFamily,
  Crash300SemanticTriggerSnapshot,
} from "./features.js";

export type Crash300FamilyTradeDirection = "buy" | "sell" | "unknown";
export type Crash300FamilyMoveDirection = "up" | "down" | "unknown";

export type Crash300FamilyDerivation = {
  familyRaw: Crash300PhaseDerivedFamily;
  familyDirection: Crash300FamilyTradeDirection;
  familyMoveDirection: Crash300FamilyMoveDirection;
  directionCompatible: boolean;
  familyFinal: Crash300PhaseDerivedFamily;
  semanticConflictReasons: string[];
};

export function directionFromCrash300Family(family: Crash300PhaseDerivedFamily): Crash300FamilyTradeDirection {
  if (
    family === "drift_continuation_up" ||
    family === "post_crash_recovery_up" ||
    family === "bear_trap_reversal_up"
  ) {
    return "buy";
  }
  if (
    family === "failed_recovery_short" ||
    family === "crash_event_down" ||
    family === "bull_trap_reversal_down"
  ) {
    return "sell";
  }
  return "unknown";
}

export function moveDirectionFromCrash300Family(family: Crash300PhaseDerivedFamily): Crash300FamilyMoveDirection {
  const tradeDirection = directionFromCrash300Family(family);
  if (tradeDirection === "buy") return "up";
  if (tradeDirection === "sell") return "down";
  return "unknown";
}

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

export function deriveCrash300RuntimeFamilyWithSemantics(params: {
  context: Crash300ContextSnapshot;
  trigger: Crash300SemanticTriggerSnapshot;
  moveDirection?: "up" | "down" | "unknown";
}): Crash300FamilyDerivation {
  const familyRaw = deriveCrash300RuntimeFamily(params);
  const familyDirection = directionFromCrash300Family(familyRaw);
  const familyMoveDirection = moveDirectionFromCrash300Family(familyRaw);
  const moveDirection = params.moveDirection ?? "unknown";
  const semanticConflictReasons: string[] = [];
  const directionCompatible =
    moveDirection === "unknown" ||
    familyMoveDirection === "unknown" ||
    familyMoveDirection === moveDirection;

  if (!directionCompatible && moveDirection === "up" && familyMoveDirection === "down") {
    semanticConflictReasons.push("diagnostic_conflict:down_family_on_up_move");
  }
  if (!directionCompatible && moveDirection === "down" && familyMoveDirection === "up") {
    semanticConflictReasons.push("diagnostic_conflict:up_family_on_down_move");
  }

  return {
    familyRaw,
    familyDirection,
    familyMoveDirection,
    directionCompatible,
    familyFinal: directionCompatible ? familyRaw : "unknown",
    semanticConflictReasons,
  };
}
