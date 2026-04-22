import { pgTable, serial, integer, text, doublePrecision, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * move_family_inferences - AI family/window inference per detected move.
 *
 * Phase 3 calibration artifact. Stores the AI-inferred strategy family plus the
 * structural windows that should be used for progression analysis.
 */
export const moveFamilyInferencesTable = pgTable("move_family_inferences", {
  id:               serial("id").primaryKey(),
  moveId:           integer("move_id").notNull(),
  symbol:           text("symbol").notNull(),
  strategyFamily:   text("strategy_family").notNull(),
  confidenceScore:  doublePrecision("confidence_score").notNull().default(0),
  developmentBars:  integer("development_bars").notNull().default(0),
  precursorBars:    integer("precursor_bars").notNull().default(0),
  triggerBars:      integer("trigger_bars").notNull().default(0),
  behaviorBars:     integer("behavior_bars").notNull().default(0),
  reasoningSummary: text("reasoning_summary"),
  rawAiResponse:    jsonb("raw_ai_response"),
  passRunId:        integer("pass_run_id"),
  createdAt:        timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_move_family_inferences_move_id").on(table.moveId),
  index("idx_move_family_inferences_symbol_family").on(table.symbol, table.strategyFamily),
]);

export type MoveFamilyInferenceRow = typeof moveFamilyInferencesTable.$inferSelect;
export type InsertMoveFamilyInferenceRow = typeof moveFamilyInferencesTable.$inferInsert;
