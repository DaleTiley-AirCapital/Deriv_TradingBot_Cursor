import { pgTable, serial, integer, text, doublePrecision, boolean, timestamp, jsonb, index } from "drizzle-orm/pg-core";

/**
 * move_precursor_passes — AI Pass 1 results for detected moves.
 *
 * For each detected move, the precursor pass asks: "What conditions existed
 * in the 48–96 bars BEFORE this move started that consistently appear as
 * precursors?" It captures the lead-in structure, confluences, and whether
 * the engine's existing entry rules would have fired.
 *
 * Columns:
 *   moveId          — FK → detected_moves.id
 *   symbol          — denormalized for easier querying
 *   direction       — "up" | "down"
 *   moveType        — "breakout" | "continuation" | "reversal" | "unknown"
 *   engineMatched   — engine name that would have covered this move, or null
 *   engineWouldFire — did existing engine rules match the precursor?
 *   precursorConditions — AI-identified list of conditions present before move
 *   missedReason    — if engineWouldFire=false, why the engine would miss it
 *   leadInSummary   — brief narrative from AI about the setup context
 *   confidenceScore — 0..1, AI confidence in precursor identification
 *   rawAiResponse   — full JSON response from OpenAI (for audit)
 *   passRunId       — FK → calibration_pass_runs.id
 *   createdAt
 */
export const movePrecursorPassesTable = pgTable("move_precursor_passes", {
  id:                   serial("id").primaryKey(),
  moveId:               integer("move_id").notNull(),
  symbol:               text("symbol").notNull(),
  direction:            text("direction").notNull(),
  moveType:             text("move_type").notNull(),
  engineMatched:        text("engine_matched"),
  engineWouldFire:      boolean("engine_would_fire").notNull().default(false),
  precursorConditions:  jsonb("precursor_conditions"),
  missedReason:         text("missed_reason"),
  leadInSummary:        text("lead_in_summary"),
  confidenceScore:      doublePrecision("confidence_score").notNull().default(0),
  rawAiResponse:        jsonb("raw_ai_response"),
  passRunId:            integer("pass_run_id"),
  createdAt:            timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_precursor_passes_move_id").on(table.moveId),
  index("idx_precursor_passes_symbol").on(table.symbol),
]);

export type MovePrecursorPassRow = typeof movePrecursorPassesTable.$inferSelect;
export type InsertMovePrecursorPassRow = typeof movePrecursorPassesTable.$inferInsert;
