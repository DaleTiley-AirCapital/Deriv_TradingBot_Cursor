import { pgTable, serial, integer, text, timestamp, jsonb, bigint, uniqueIndex, index } from "drizzle-orm/pg-core";

/**
 * calibration_move_window_summaries - deterministic feature summaries for logical move windows.
 */
export const calibrationMoveWindowSummariesTable = pgTable("calibration_move_window_summaries", {
  id: serial("id").primaryKey(),
  moveId: integer("move_id").notNull(),
  symbol: text("symbol").notNull(),
  windowKind: text("window_kind").notNull(),
  windowStartTs: bigint("window_start_ts", { mode: "number" }).notNull(),
  windowEndTs: bigint("window_end_ts", { mode: "number" }).notNull(),
  windowBars: integer("window_bars").notNull(),
  movePctBucket: text("move_pct_bucket").notNull(),
  featureSummary: jsonb("feature_summary").notNull(),
  compactRawSlice: jsonb("compact_raw_slice").notNull(),
  sourceRunId: integer("source_run_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_calibration_move_window_summaries_move_kind").on(table.moveId, table.windowKind),
  index("idx_calibration_move_window_summaries_symbol_kind").on(table.symbol, table.windowKind),
]);

export type CalibrationMoveWindowSummaryRow = typeof calibrationMoveWindowSummariesTable.$inferSelect;
export type InsertCalibrationMoveWindowSummaryRow = typeof calibrationMoveWindowSummariesTable.$inferInsert;
