/**
 * behaviorCapture.ts — Behavior Event Capture Layer
 *
 * Records fine-grained behavior events from backtest replay AND live trade outcomes.
 * Events are stored in-memory, keyed by symbol+engine.
 *
 * Event taxonomy:
 *   "signal_fired"      — coordinator produced a winner candidate
 *   "blocked_by_gate"   — signal fired but did not pass mode score gate
 *   "entered"           — trade was opened (passed gate + one-per-symbol check)
 *   "breakeven_promoted"— SL moved to breakeven (stage 1→2)
 *   "trailing_activated"— adaptive trailing stop activated (stage 2→3)
 *   "closed"            — trade exited (tp_hit | sl_hit | trailing_stop | max_duration)
 *
 * The profiler reads these to derive:
 *   - Signal frequency and blocked rate
 *   - MFE/MAE distributions at every lifecycle stage
 *   - Time-to-MFE, time-to-breakeven, time-to-trailing distributions
 *   - Extension probability (% reaching 50%+ of projected move)
 */

export interface SignalFiredEvent {
  eventType: "signal_fired";
  symbol: string;
  engineName: string;
  entryType: string;
  direction: "buy" | "sell";
  regimeAtEntry: string;
  regimeConfidence: number;
  nativeScore: number;
  projectedMovePct: number;
  ts: number;
  conflictResolution: string;
}

export interface BlockedByGateEvent {
  eventType: "blocked_by_gate";
  symbol: string;
  engineName: string;
  direction: "buy" | "sell";
  regimeAtEntry: string;
  nativeScore: number;
  modeGate: number;
  mode: string;
  ts: number;
  /** Which allocator stage rejected the signal (1=kill_switch, 2=mode, 3=symbol, 4=score, 5=open, 6=daily_loss, 7=weekly_loss, ...) */
  rejectionStage?: number;
  /** Human-readable rejection reason(s) from allocator */
  rejectionReason?: string;
  /** True when stage 4 (score gate) — signal-quality block vs platform/risk gate */
  isSignalQualityBlock?: boolean;
}

export interface EnteredEvent {
  eventType: "entered";
  symbol: string;
  engineName: string;
  entryType: string;
  direction: "buy" | "sell";
  regimeAtEntry: string;
  regimeConfidence: number;
  nativeScore: number;
  projectedMovePct: number;
  entryTs: number;
  tpPct: number;
  slPct: number;
}

export interface BeBreakevenPromotedEvent {
  eventType: "breakeven_promoted";
  symbol: string;
  engineName: string;
  direction: "buy" | "sell";
  holdBarsAtPromotion: number;
  mfePctAtPromotion: number;
  tpProgressAtPromotion: number;
  ts: number;
}

export interface TrailingActivatedEvent {
  eventType: "trailing_activated";
  symbol: string;
  engineName: string;
  direction: "buy" | "sell";
  holdBarsAtActivation: number;
  mfePctAtActivation: number;
  tpProgressAtActivation: number;
  ts: number;
}

export interface ClosedEvent {
  eventType: "closed";
  symbol: string;
  engineName: string;
  entryType: string;
  direction: "buy" | "sell";
  regimeAtEntry: string;
  regimeConfidence: number;
  nativeScore: number;
  projectedMovePct: number;
  entryTs: number;
  exitTs: number;
  holdBars: number;
  pnlPct: number;
  mfePct: number;
  maePct: number;
  mfePctAtBreakeven: number;   // MFE when breakeven was triggered (0 if never triggered)
  barsToMfe: number;           // bars from entry to MFE peak
  barsToBreakeven: number;     // bars from entry to breakeven promotion (0 if never)
  exitReason: "tp_hit" | "sl_hit" | "trailing_stop" | "max_duration";
  slStage: 1 | 2 | 3;
  conflictResolution: string;
  source: "backtest" | "live";
}

export type BehaviorEvent =
  | SignalFiredEvent
  | BlockedByGateEvent
  | EnteredEvent
  | BeBreakevenPromotedEvent
  | TrailingActivatedEvent
  | ClosedEvent;

// Key: `${symbol}|${engineName}`
const eventStore = new Map<string, BehaviorEvent[]>();

export function clearBehaviorEvents(symbol: string, engineName?: string): void {
  if (engineName) {
    eventStore.delete(`${symbol}|${engineName}`);
  } else {
    for (const key of [...eventStore.keys()]) {
      if (key.startsWith(`${symbol}|`)) eventStore.delete(key);
    }
  }
}

export function recordBehaviorEvent(event: BehaviorEvent): void {
  const key = `${event.symbol}|${event.engineName}`;
  const existing = eventStore.get(key) ?? [];
  existing.push(event);
  eventStore.set(key, existing);
}

export function getBehaviorEvents(symbol: string, engineName?: string): BehaviorEvent[] {
  if (engineName) {
    return eventStore.get(`${symbol}|${engineName}`) ?? [];
  }
  const results: BehaviorEvent[] = [];
  for (const [key, events] of eventStore.entries()) {
    if (key.startsWith(`${symbol}|`)) results.push(...events);
  }
  return results;
}

export function getClosedEvents(symbol: string, engineName?: string): ClosedEvent[] {
  return getBehaviorEvents(symbol, engineName)
    .filter((e): e is ClosedEvent => e.eventType === "closed");
}

export function getBlockedEvents(symbol: string, engineName?: string): BlockedByGateEvent[] {
  return getBehaviorEvents(symbol, engineName)
    .filter((e): e is BlockedByGateEvent => e.eventType === "blocked_by_gate");
}

export function getAllBehaviorKeys(): string[] {
  return [...eventStore.keys()];
}

export function getBehaviorEventCount(): number {
  let total = 0;
  for (const events of eventStore.values()) total += events.length;
  return total;
}
