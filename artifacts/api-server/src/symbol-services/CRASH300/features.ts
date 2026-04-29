export type Crash300RuntimeFamily =
  | "drift_continuation_up"
  | "post_crash_recovery_up"
  | "failed_recovery_short"
  | "crash_event_down";

export type Crash300TriggerTransition =
  | "none"
  | "compression_break_up"
  | "compression_break_down"
  | "recovery_continuation_up"
  | "failed_recovery_break_down"
  | "crash_continuation_down";

export interface Crash300CrashEvent {
  eventStartTs: number;
  eventEndTs: number;
  direction: "down";
  depthPct: number;
  durationBars: number;
  velocityPctPerBar: number;
  preCrashHigh: number;
  crashLow: number;
  recoveryPctAfter15Bars: number;
  recoveryPctAfter60Bars: number;
  recoveryPctAfter240Bars: number;
}

export interface Crash300ContextSnapshot {
  ts: number;
  symbol: string;
  lookbackBarsAvailable: number;
  ema20: number;
  ema50: number;
  ema200: number;
  ema20Slope60: number;
  ema50Slope240: number;
  priceVsEma20Pct: number;
  priceVsEma50Pct: number;
  priceVsEma200Pct: number;
  positiveCloseRatio60: number;
  positiveCloseRatio240: number;
  higherHighCount60: number;
  higherLowCount60: number;
  lowerHighCount60: number;
  lowerLowCount60: number;
  driftPersistence60: number;
  driftPersistence240: number;
  trendPersistenceScore: number;
  lastCrashTs: number | null;
  barsSinceLastCrash: number | null;
  lastCrashDepthPct: number | null;
  lastCrashDurationBars: number | null;
  lastCrashVelocityPctPerBar: number | null;
  lastCrashLow: number | null;
  lastCrashHighBeforeDrop: number | null;
  priceDistanceFromLastCrashLowPct: number | null;
  recoveryFromLastCrashPct: number | null;
  crashRecencyScore: number;
  recoveryBars: number | null;
  recoverySlope60: number;
  recoverySlope240: number;
  recoveryPersistence60: number;
  recoveryPullbackDepthPct: number;
  recoveryHigherLowCount60: number;
  recoveryFailedBreakCount60: number;
  recoveryQualityScore: number;
  atr14: number;
  atr60: number;
  atr240: number;
  atrRank60: number;
  atrRank240: number;
  bbWidth20: number;
  bbWidthRank60: number;
  bbWidthRank240: number;
  rangeCompressionScore60: number;
  rangeCompressionScore240: number;
  rangeExpansionScore15: number;
  rangeExpansionScore60: number;
  compressionToExpansionScore: number;
  barsSinceLastDetectedMoveStart: number | null;
  barsSinceLastDetectedMoveEnd: number | null;
  distanceFromLastMoveStartPricePct: number | null;
  distanceFromLastMoveEndPricePct: number | null;
  barsUntilNearestFutureCalibratedMoveStart: number | null;
  barsFromPreviousCalibratedMoveEnd: number | null;
  currentMoveOverlapId: number | null;
  latestClose: number;
}

export interface Crash300TriggerSnapshot {
  ts: number;
  symbol: string;
  candleOpen: number;
  candleHigh: number;
  candleLow: number;
  candleClose: number;
  candleDirection: "up" | "down" | "flat";
  candleBodyPct: number;
  upperWickPct: number;
  lowerWickPct: number;
  closeLocationInRangePct: number;
  oneBarReturnPct: number;
  threeBarReturnPct: number;
  fiveBarReturnPct: number;
  oneBarMomentum: number;
  threeBarMomentum: number;
  fiveBarMomentum: number;
  microBreakDirection: "up" | "down" | "none";
  microBreakStrengthPct: number;
  reversalWickDirection: "up" | "down" | "none";
  rejectionScore: number;
  impulseScore: number;
  triggerTransition: Crash300TriggerTransition;
  confirmationBars: number;
  triggerDirection: "buy" | "sell" | "none";
  triggerStrengthScore: number;
}

export interface Crash300FamilyCandidate {
  family: Crash300RuntimeFamily;
  direction: "buy" | "sell";
  score: number;
  components: Record<string, number>;
  leadInShape: "expanding" | "compressing" | "ranging" | "trending" | "all";
}

export interface Crash300EpochState {
  epochId: string;
  family: Crash300RuntimeFamily;
  bucket: string;
  direction: "buy" | "sell";
  startTs: number;
  lastSeenTs: number;
  lastTriggerTs: number | null;
  candidateProducedTs: number | null;
}

export interface Crash300RuntimeState {
  currentEpoch: Crash300EpochState | null;
  previousEpochId: string | null;
  lastValidTriggerTs: number | null;
  lastValidTriggerDirection: "buy" | "sell" | null;
  lastValidTriggerStrength: number | null;
}

