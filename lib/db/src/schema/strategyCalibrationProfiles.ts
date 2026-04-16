import { pgTable, serial, text, doublePrecision, integer, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * strategy_calibration_profiles — Aggregated calibration results per symbol+moveType.
 *
 * After AI passes complete for all detected moves in a window, the aggregator
 * rolls up the results into a single calibration profile per (symbol, moveType).
 * This is the "feeddown schema" consumed by the frontend and research tab.
 *
 * Honest fit reporting is mandatory:
 *   - targetMoves: total detected moves in window
 *   - capturedMoves: moves where AI passes produced usable output
 *   - missedMoves: targetMoves - capturedMoves
 *   - missReasons: JSONB array of categorized miss reasons
 *   - fitScore: capturedMoves / targetMoves (never inflated to 1.0)
 *
 * Columns:
 *   symbol              — CRASH300 | BOOM300 | R_75 | R_100
 *   moveType            — "breakout" | "continuation" | "reversal" | "unknown" | "all"
 *   windowDays          — analysis window used
 *   targetMoves         — total qualifying moves detected
 *   capturedMoves       — moves with complete AI passes
 *   missedMoves         — moves that could not be analyzed (data gap, AI error, etc.)
 *   fitScore            — 0..1, honest coverage ratio
 *   missReasons         — JSONB: [{reason, count}]
 *   avgMovePct          — mean move size across captured moves
 *   medianMovePct       — median move size
 *   avgHoldingHours     — mean hold duration
 *   avgCaptureablePct   — mean capturable fraction from earliest entry
 *   avgHoldabilityScore — mean holdability score from behavior passes
 *   engineCoverage      — JSONB: {engineName: {matched, fired, missedReason}}
 *   precursorSummary    — JSONB: top precursor conditions across all moves
 *   triggerSummary      — JSONB: top trigger conditions across all moves
 *   feeddownSchema      — JSONB: full structured feeddown for engine tuning
 *   lastRunId           — FK → calibration_pass_runs.id (most recent run)
 *   generatedAt         — when this profile was last rebuilt
 */
export const strategyCalibrationProfilesTable = pgTable("strategy_calibration_profiles", {
  id:                   serial("id").primaryKey(),
  symbol:               text("symbol").notNull(),
  moveType:             text("move_type").notNull(),
  windowDays:           integer("window_days").notNull().default(90),
  targetMoves:          integer("target_moves").notNull().default(0),
  capturedMoves:        integer("captured_moves").notNull().default(0),
  missedMoves:          integer("missed_moves").notNull().default(0),
  fitScore:             doublePrecision("fit_score").notNull().default(0),
  missReasons:          jsonb("miss_reasons"),
  avgMovePct:           doublePrecision("avg_move_pct").notNull().default(0),
  medianMovePct:        doublePrecision("median_move_pct").notNull().default(0),
  avgHoldingHours:      doublePrecision("avg_holding_hours").notNull().default(0),
  avgCaptureablePct:    doublePrecision("avg_captureable_pct").notNull().default(0),
  avgHoldabilityScore:  doublePrecision("avg_holdability_score").notNull().default(0),
  engineCoverage:       jsonb("engine_coverage"),
  precursorSummary:     jsonb("precursor_summary"),
  triggerSummary:       jsonb("trigger_summary"),
  feeddownSchema:       jsonb("feeddown_schema"),
  // Profitability summary: simulated-return estimates ranked by extraction path.
  // Populated by the extraction pass after all AI passes complete.
  // Schema: { paths: [{ name, estimatedMonthlyReturnPct, captureablePct, holdDays, confidence }],
  //           topPath: string, estimatedFitAdjustedReturn: number }
  profitabilitySummary: jsonb("profitability_summary"),
  lastRunId:            integer("last_run_id"),
  generatedAt:          timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_calibration_profiles_symbol_type").on(table.symbol, table.moveType),
]);

export type StrategyCalibrationProfileRow = typeof strategyCalibrationProfilesTable.$inferSelect;
export type InsertStrategyCalibrationProfileRow = typeof strategyCalibrationProfilesTable.$inferInsert;
