import { pgTable, serial, text, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";

/**
 * calibration_pass_runs — Tracks async AI pass pipeline runs.
 *
 * One row per invocation of the full calibration pipeline for a symbol+window.
 * The pass runner updates status as it works through detected moves.
 *
 * Columns:
 *   symbol          — CRASH300 | BOOM300 | R_75 | R_100
 *   windowDays      — analysis window that was used
 *   status          — "running" | "completed" | "failed" | "partial"
 *   passName        — "precursor" | "trigger" | "behavior" | "extraction" | "all"
 *   totalMoves      — total detected moves queued for this run
 *   processedMoves  — moves processed so far
 *   failedMoves     — moves that errored during AI call
 *   startedAt       — when the run was initiated
 *   completedAt     — when all passes finished (null if still running)
 *   errorSummary    — JSONB: [{moveId, error}] for failed moves
 *   metaJson        — run parameters, model version, etc.
 */
export const calibrationPassRunsTable = pgTable("calibration_pass_runs", {
  id:             serial("id").primaryKey(),
  symbol:         text("symbol").notNull(),
  windowDays:     integer("window_days").notNull().default(90),
  status:         text("status").notNull().default("running"),
  passName:       text("pass_name").notNull().default("all"),
  totalMoves:     integer("total_moves").notNull().default(0),
  processedMoves: integer("processed_moves").notNull().default(0),
  failedMoves:    integer("failed_moves").notNull().default(0),
  startedAt:      timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt:    timestamp("completed_at", { withTimezone: true }),
  errorSummary:   jsonb("error_summary"),
  metaJson:       jsonb("meta_json"),
}, (table) => [
  index("idx_pass_runs_symbol_status").on(table.symbol, table.status),
  index("idx_pass_runs_started_at").on(table.startedAt),
]);

export type CalibrationPassRunRow = typeof calibrationPassRunsTable.$inferSelect;
export type InsertCalibrationPassRunRow = typeof calibrationPassRunsTable.$inferInsert;
