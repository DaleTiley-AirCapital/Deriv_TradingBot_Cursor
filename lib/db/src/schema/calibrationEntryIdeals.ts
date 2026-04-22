import { pgTable, serial, integer, text, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * calibration_entry_ideals - AI entry fingerprint output per symbol/family.
 */
export const calibrationEntryIdealsTable = pgTable("calibration_entry_ideals", {
  id:                   serial("id").primaryKey(),
  symbol:               text("symbol").notNull(),
  strategyFamily:       text("strategy_family").notNull(),
  movePctBucket:        text("move_pct_bucket").notNull().default("all"),
  idealPrecursorProfile: jsonb("ideal_precursor_profile").notNull(),
  idealTriggerProfile:   jsonb("ideal_trigger_profile").notNull(),
  featureBands:         jsonb("feature_bands").notNull(),
  entryQualityNarrative: text("entry_quality_narrative"),
  progressionSummary:   jsonb("progression_summary"),
  sourceRunId:          integer("source_run_id"),
  createdAt:            timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:            timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_calibration_entry_ideals_symbol_family").on(table.symbol, table.strategyFamily, table.movePctBucket),
]);

export type CalibrationEntryIdealRow = typeof calibrationEntryIdealsTable.$inferSelect;
export type InsertCalibrationEntryIdealRow = typeof calibrationEntryIdealsTable.$inferInsert;
