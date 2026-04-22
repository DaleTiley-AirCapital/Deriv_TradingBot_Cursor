import { pgTable, serial, integer, text, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * calibration_family_bucket_profiles - deterministic family and move bucket aggregates before AI synthesis.
 */
export const calibrationFamilyBucketProfilesTable = pgTable("calibration_family_bucket_profiles", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  strategyFamily: text("strategy_family").notNull(),
  movePctBucket: text("move_pct_bucket").notNull(),
  moveCount: integer("move_count").notNull().default(0),
  windowModel: jsonb("window_model").notNull(),
  featureProgressionAverages: jsonb("feature_progression_averages").notNull(),
  featureProgressionBounds: jsonb("feature_progression_bounds").notNull(),
  representativeExamples: jsonb("representative_examples").notNull(),
  sourceRunId: integer("source_run_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_calibration_family_bucket_profiles_symbol_family_bucket").on(
    table.symbol,
    table.strategyFamily,
    table.movePctBucket,
  ),
]);

export type CalibrationFamilyBucketProfileRow = typeof calibrationFamilyBucketProfilesTable.$inferSelect;
export type InsertCalibrationFamilyBucketProfileRow = typeof calibrationFamilyBucketProfilesTable.$inferInsert;
