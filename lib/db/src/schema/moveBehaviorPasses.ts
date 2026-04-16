import { pgTable, serial, integer, text, doublePrecision, timestamp, jsonb, index } from "drizzle-orm/pg-core";

/**
 * move_behavior_passes — AI Pass 2+3 results for detected moves.
 *
 * Captures what actually happened DURING and AFTER each detected move:
 *   Pass 2 (trigger pass) — what was the earliest valid entry signal?
 *   Pass 3 (behavior pass) — how did the move progress bar by bar?
 *
 * Together these describe: HOW to enter, WHERE the move went, and WHEN
 * it was safest to capture profit. This is structural truth — not engine logic.
 *
 * Columns:
 *   moveId              — FK → detected_moves.id
 *   symbol              — denormalized
 *   direction           — "up" | "down"
 *   passName            — "trigger" | "behavior"
 *   earliestEntryTs     — epoch seconds, first bar where entry was valid
 *   earliestEntryPrice  — price at earliest entry bar
 *   entrySlippage       — pct difference between move start and earliest entry
 *   captureablePct      — pct of move that was capturable from earliest entry
 *   maxFavorablePct     — max favorable excursion from earliest entry (MFE)
 *   maxAdversePct       — max adverse excursion from earliest entry (MAE)
 *   barsToMfePeak       — bars from earliest entry to MFE peak
 *   exitNarrative       — AI description of how the move ended
 *   triggerConditions   — list of conditions that marked earliest safe entry
 *   behaviorPattern     — "smooth" | "choppy" | "gapped" | "spiked" | "compressing"
 *   holdabilityScore    — 0..1, how holdable was this move without being stopped out
 *   rawAiResponse       — full JSON response (audit)
 *   passRunId           — FK → calibration_pass_runs.id
 *   createdAt
 */
export const moveBehaviorPassesTable = pgTable("move_behavior_passes", {
  id:                  serial("id").primaryKey(),
  moveId:              integer("move_id").notNull(),
  symbol:              text("symbol").notNull(),
  direction:           text("direction").notNull(),
  passName:            text("pass_name").notNull(),
  earliestEntryTs:     doublePrecision("earliest_entry_ts"),
  earliestEntryPrice:  doublePrecision("earliest_entry_price"),
  entrySlippage:       doublePrecision("entry_slippage").notNull().default(0),
  captureablePct:      doublePrecision("captureable_pct").notNull().default(0),
  maxFavorablePct:     doublePrecision("max_favorable_pct").notNull().default(0),
  maxAdversePct:       doublePrecision("max_adverse_pct").notNull().default(0),
  barsToMfePeak:       integer("bars_to_mfe_peak").notNull().default(0),
  exitNarrative:       text("exit_narrative"),
  triggerConditions:   jsonb("trigger_conditions"),
  behaviorPattern:     text("behavior_pattern").notNull().default("unknown"),
  holdabilityScore:    doublePrecision("holdability_score").notNull().default(0),
  rawAiResponse:       jsonb("raw_ai_response"),
  passRunId:           integer("pass_run_id"),
  createdAt:           timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_behavior_passes_move_id").on(table.moveId),
  index("idx_behavior_passes_symbol_pass").on(table.symbol, table.passName),
]);

export type MoveBehaviorPassRow = typeof moveBehaviorPassesTable.$inferSelect;
export type InsertMoveBehaviorPassRow = typeof moveBehaviorPassesTable.$inferInsert;
