import { pgTable, serial, text, timestamp, jsonb } from "drizzle-orm/pg-core";

/**
 * Behavior events — durable storage for live trade lifecycle events.
 * Populated by the live outcome scaffold in tradeEngine.closePosition.
 * In-memory store handles fast profiler access; this table provides durability
 * so profiles can be built from historical live trades across restarts.
 *
 * Columns:
 *   symbol      — trading symbol (BOOM300, CRASH300, R_75, R_100)
 *   engineName  — engine that produced the signal
 *   eventType   — signal_fired | blocked_by_gate | entered | breakeven_promoted
 *                 | trailing_activated | closed
 *   source      — "live" | "backtest"
 *   eventData   — full typed BehaviorEvent as JSONB
 */
export const behaviorEventsTable = pgTable("behavior_events", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  engineName: text("engine_name").notNull(),
  eventType: text("event_type").notNull(),
  source: text("source").notNull().default("live"),
  eventData: jsonb("event_data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type BehaviorEventRow = typeof behaviorEventsTable.$inferSelect;
export type InsertBehaviorEventRow = typeof behaviorEventsTable.$inferInsert;
