import { pgTable, serial, integer, text, timestamp, jsonb, boolean, bigint, uniqueIndex, index } from "drizzle-orm/pg-core";

/**
 * calibration_feature_frames - deterministic per-timestamp feature rows for calibration windows.
 */
export const calibrationFeatureFramesTable = pgTable("calibration_feature_frames", {
  id: serial("id").primaryKey(),
  moveId: integer("move_id").notNull(),
  symbol: text("symbol").notNull(),
  openTs: bigint("open_ts", { mode: "number" }).notNull(),
  relativeBarFromMoveStart: integer("relative_bar_from_move_start").notNull(),
  relativeBarToMoveEnd: integer("relative_bar_to_move_end").notNull(),
  inDevelopment: boolean("in_development").notNull().default(false),
  inPrecursor: boolean("in_precursor").notNull().default(false),
  inTriggerZone: boolean("in_trigger_zone").notNull().default(false),
  inBehavior: boolean("in_behavior").notNull().default(false),
  movePctBucket: text("move_pct_bucket").notNull(),
  direction: text("direction").notNull(),
  featureValues: jsonb("feature_values").notNull(),
  normalizedFeatureValues: jsonb("normalized_feature_values").notNull(),
  sourceRunId: integer("source_run_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_calibration_feature_frames_move_ts").on(table.moveId, table.openTs),
  index("idx_calibration_feature_frames_symbol_bucket").on(table.symbol, table.movePctBucket),
  index("idx_calibration_feature_frames_symbol_ts").on(table.symbol, table.openTs),
]);

export type CalibrationFeatureFrameRow = typeof calibrationFeatureFramesTable.$inferSelect;
export type InsertCalibrationFeatureFrameRow = typeof calibrationFeatureFramesTable.$inferInsert;
