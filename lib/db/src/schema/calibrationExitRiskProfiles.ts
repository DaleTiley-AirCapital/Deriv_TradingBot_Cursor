import { pgTable, serial, integer, text, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * calibration_exit_risk_profiles - AI regression and closure-risk output.
 */
export const calibrationExitRiskProfilesTable = pgTable("calibration_exit_risk_profiles", {
  id:                      serial("id").primaryKey(),
  symbol:                  text("symbol").notNull(),
  strategyFamily:          text("strategy_family").notNull(),
  regressionFingerprints:  jsonb("regression_fingerprints").notNull(),
  moveBreakWarningPatterns: jsonb("move_break_warning_patterns").notNull(),
  closureSignals:          jsonb("closure_signals").notNull(),
  trailingInterpretationNotes: text("trailing_interpretation_notes"),
  sourceRunId:             integer("source_run_id"),
  createdAt:               timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:               timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_calibration_exit_risk_profiles_symbol_family").on(table.symbol, table.strategyFamily),
]);

export type CalibrationExitRiskProfileRow = typeof calibrationExitRiskProfilesTable.$inferSelect;
export type InsertCalibrationExitRiskProfileRow = typeof calibrationExitRiskProfilesTable.$inferInsert;
