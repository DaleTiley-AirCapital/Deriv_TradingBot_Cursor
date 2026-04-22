import { pgTable, serial, integer, text, doublePrecision, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * calibration_feature_relevance - per symbol/family feature ranking.
 */
export const calibrationFeatureRelevanceTable = pgTable("calibration_feature_relevance", {
  id:                 serial("id").primaryKey(),
  symbol:             text("symbol").notNull(),
  strategyFamily:     text("strategy_family").notNull(),
  featureName:        text("feature_name").notNull(),
  relevanceScore:     doublePrecision("relevance_score").notNull().default(0),
  precursorUsefulness: doublePrecision("precursor_usefulness").notNull().default(0),
  triggerUsefulness:   doublePrecision("trigger_usefulness").notNull().default(0),
  behaviorUsefulness:  doublePrecision("behavior_usefulness").notNull().default(0),
  notes:              text("notes"),
  sourceRunId:        integer("source_run_id"),
  createdAt:          timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:          timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_calibration_feature_relevance_symbol_family_feature").on(
    table.symbol,
    table.strategyFamily,
    table.featureName,
  ),
]);

export type CalibrationFeatureRelevanceRow = typeof calibrationFeatureRelevanceTable.$inferSelect;
export type InsertCalibrationFeatureRelevanceRow = typeof calibrationFeatureRelevanceTable.$inferInsert;
