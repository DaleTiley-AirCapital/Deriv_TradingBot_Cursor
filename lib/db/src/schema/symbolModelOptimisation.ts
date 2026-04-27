import { pgTable, serial, text, integer, timestamp, jsonb, boolean, index } from "drizzle-orm/pg-core";

export const symbolModelOptimisationRunsTable = pgTable("symbol_model_optimisation_runs", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  sourceRuntimeRunId: integer("source_runtime_run_id"),
  calibrationRunId: integer("calibration_run_id"),
  status: text("status").notNull().default("running"),
  objective: text("objective").notNull().default("profit_factor_total_pnl_guarded_drawdown"),
  windowDays: integer("window_days").notNull().default(365),
  maxIterations: integer("max_iterations").notNull().default(5),
  baselineMetrics: jsonb("baseline_metrics"),
  winnerMetrics: jsonb("winner_metrics"),
  aiReview: jsonb("ai_review"),
  errorSummary: jsonb("error_summary"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  stagedAt: timestamp("staged_at", { withTimezone: true }),
}, (table) => [
  index("idx_symbol_model_opt_runs_symbol_status").on(table.symbol, table.status),
  index("idx_symbol_model_opt_runs_started").on(table.startedAt),
]);

export const symbolModelOptimisationCandidatesTable = pgTable("symbol_model_optimisation_candidates", {
  id: serial("id").primaryKey(),
  runId: integer("run_id").notNull().references(() => symbolModelOptimisationRunsTable.id),
  symbol: text("symbol").notNull(),
  iteration: integer("iteration").notNull(),
  candidateKey: text("candidate_key").notNull(),
  parentCandidateKey: text("parent_candidate_key"),
  params: jsonb("params"),
  backtestMetrics: jsonb("backtest_metrics"),
  moveOverlapMetrics: jsonb("move_overlap_metrics"),
  exitBreakdown: jsonb("exit_breakdown"),
  tierPerformance: jsonb("tier_performance"),
  aiRationale: jsonb("ai_rationale"),
  selected: boolean("selected").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_symbol_model_opt_candidates_run").on(table.runId),
  index("idx_symbol_model_opt_candidates_symbol").on(table.symbol),
]);

export type SymbolModelOptimisationRunRow = typeof symbolModelOptimisationRunsTable.$inferSelect;
export type InsertSymbolModelOptimisationRunRow = typeof symbolModelOptimisationRunsTable.$inferInsert;
export type SymbolModelOptimisationCandidateRow = typeof symbolModelOptimisationCandidatesTable.$inferSelect;
export type InsertSymbolModelOptimisationCandidateRow = typeof symbolModelOptimisationCandidatesTable.$inferInsert;
