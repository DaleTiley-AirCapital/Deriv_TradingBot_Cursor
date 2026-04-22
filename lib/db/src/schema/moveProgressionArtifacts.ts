import { pgTable, serial, integer, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * move_progression_artifacts - deterministic progression payload per move.
 *
 * Stores the code-computed feature progression, window boundaries, and compact
 * raw candle slices used by later AI aggregation passes.
 */
export const moveProgressionArtifactsTable = pgTable("move_progression_artifacts", {
  id:                 serial("id").primaryKey(),
  moveId:             integer("move_id").notNull(),
  symbol:             text("symbol").notNull(),
  strategyFamily:     text("strategy_family").notNull(),
  windowModel:        jsonb("window_model").notNull(),
  progressionSummary: jsonb("progression_summary").notNull(),
  featureStats:       jsonb("feature_stats").notNull(),
  compactRawSlices:   jsonb("compact_raw_slices").notNull(),
  passRunId:          integer("pass_run_id"),
  createdAt:          timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_move_progression_artifacts_move_id").on(table.moveId),
  index("idx_move_progression_artifacts_symbol_family").on(table.symbol, table.strategyFamily),
]);

export type MoveProgressionArtifactRow = typeof moveProgressionArtifactsTable.$inferSelect;
export type InsertMoveProgressionArtifactRow = typeof moveProgressionArtifactsTable.$inferInsert;
