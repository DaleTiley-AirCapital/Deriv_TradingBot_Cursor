import { pgTable, serial, text, doublePrecision, integer, boolean, timestamp, jsonb, index } from "drizzle-orm/pg-core";

/**
 * detected_moves — Structural moves detected from raw candle data.
 *
 * The primary unit of calibration. Each row is a confirmed price swing with
 * enough structural context to support 4-pass AI analysis.
 *
 * Columns:
 *   symbol          — CRASH300 | BOOM300 | R_75 | R_100
 *   direction       — "up" | "down"
 *   moveType        — R_*: "breakout" | "continuation" | "reversal" | "unknown" · BOOM300: "boom_expansion" · CRASH300: "crash_expansion"
 *   startTs         — epoch seconds, candle open_ts of move start
 *   endTs           — epoch seconds, candle open_ts of move peak/trough
 *   startPrice      — close price at move start
 *   endPrice        — close price at move end (peak/trough)
 *   movePct         — abs((endPrice - startPrice) / startPrice)
 *   holdingMinutes  — duration from startTs to endTs
 *   leadInShape     — "trending" | "ranging" | "compressing" | "expanding"
 *   leadInBars      — number of bars used for lead-in classification
 *   directionalPersistence — 0..1, fraction of bars in move direction
 *   rangeExpansion  — ATR at peak / ATR at start (expansion ratio)
 *   spikeCount4h    — for BOOM/CRASH: number of spikes in 4h window at move start
 *   qualityScore    — 0..100 deterministic quality score
 *   qualityTier     — "A" | "B" | "C" | "D" (A = best)
 *   windowDays      — analysis window used when detecting this move
 *   isInterpolatedExcluded — true means interpolated candles were excluded
 *   contextJson     — full structural context snapshot (JSONB)
 *   detectedAt      — when this record was created
 */
export const detectedMovesTable = pgTable("detected_moves", {
  id:                      serial("id").primaryKey(),
  symbol:                  text("symbol").notNull(),
  direction:               text("direction").notNull(),
  moveType:                text("move_type").notNull().default("unknown"),
  startTs:                 doublePrecision("start_ts").notNull(),
  endTs:                   doublePrecision("end_ts").notNull(),
  startPrice:              doublePrecision("start_price").notNull(),
  endPrice:                doublePrecision("end_price").notNull(),
  movePct:                 doublePrecision("move_pct").notNull(),
  holdingMinutes:          doublePrecision("holding_minutes").notNull(),
  leadInShape:             text("lead_in_shape").notNull().default("unknown"),
  leadInBars:              integer("lead_in_bars").notNull().default(0),
  directionalPersistence:  doublePrecision("directional_persistence").notNull().default(0),
  rangeExpansion:          doublePrecision("range_expansion").notNull().default(1),
  spikeCount4h:            integer("spike_count_4h").notNull().default(0),
  qualityScore:            doublePrecision("quality_score").notNull().default(0),
  qualityTier:             text("quality_tier").notNull().default("D"),
  windowDays:              integer("window_days").notNull().default(90),
  isInterpolatedExcluded:  boolean("is_interpolated_excluded").notNull().default(true),
  // Deterministic move family label from moveLabeler.ts — computed at detection time
  // and stored separately from any future AI refinement.
  // Values: "breakout" | "continuation" | "reversal" | "unknown"
  strategyFamilyCandidate: text("strategy_family_candidate").notNull().default("unknown"),
  contextJson:             jsonb("context_json"),
  // Candle-level characteristics around the trigger zone (first bar of the move).
  // Captures body size, wick ratios, momentum confirmation candles, and BB position
  // at the exact trigger point — used for future pass-level correlation.
  // Schema: { bodyPct, upperWickPct, lowerWickPct, isBullishClose, bbPosition,
  //           confirmationBars: number, momentumAtStart: number }
  triggerZoneJson:         jsonb("trigger_zone_json"),
  detectedAt:              timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_detected_moves_symbol_ts").on(table.symbol, table.startTs),
  index("idx_detected_moves_symbol_type").on(table.symbol, table.moveType),
  index("idx_detected_moves_quality").on(table.symbol, table.qualityTier),
]);

export type DetectedMoveRow = typeof detectedMovesTable.$inferSelect;
export type InsertDetectedMoveRow = typeof detectedMovesTable.$inferInsert;
