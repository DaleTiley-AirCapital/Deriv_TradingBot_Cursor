/**
 * behaviorDb.ts — DB ↔ In-Memory Behavior Event Bridge
 *
 * Handles loading durable live behavior events from the behavior_events table
 * into the in-memory store on server startup. This ensures that profiles built
 * from historical live trades survive server restarts.
 *
 * Flow:
 *   Server start → loadLiveBehaviorEvents() → populates in-memory store
 *                  Profiler reads from in-memory store (fast, no DB query)
 *   Live trade closes → DB insert (durable) + in-memory recordBehaviorEvent()
 */

import { db, behaviorEventsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { recordBehaviorEvent, type BehaviorEvent } from "./behaviorCapture.js";

/**
 * Load persisted live behavior events from the DB into the in-memory store.
 * Called once during server startup. Non-fatal if the table doesn't exist yet.
 */
export async function loadLiveBehaviorEvents(): Promise<void> {
  try {
    const rows = await db.select().from(behaviorEventsTable)
      .where(eq(behaviorEventsTable.source, "live"));

    let loaded = 0;
    for (const row of rows) {
      try {
        const event = row.eventData as BehaviorEvent;
        if (event && event.eventType && event.symbol && event.engineName) {
          recordBehaviorEvent(event);
          loaded++;
        }
      } catch {
        // Skip malformed events
      }
    }

    if (loaded > 0) {
      console.log(`[BehaviorDb] Loaded ${loaded} live behavior events from DB into memory.`);
    }
  } catch (err) {
    // Non-fatal — in-memory store works fine without historical DB data
    console.warn("[BehaviorDb] Could not load live behavior events from DB (non-fatal):", err instanceof Error ? err.message : err);
  }
}

/**
 * Reload durable live behavior events for a specific symbol back into the
 * in-memory store.  Called after clearBehaviorEvents(symbol) during profile
 * rebuild so that existing live-trade history is NOT lost when a new backtest
 * replay populates the event store with historical events.
 */
export async function reloadLiveBehaviorEventsForSymbol(symbol: string): Promise<void> {
  try {
    const rows = await db.select().from(behaviorEventsTable)
      .where(and(
        eq(behaviorEventsTable.source, "live"),
        eq(behaviorEventsTable.symbol, symbol),
      ));
    for (const row of rows) {
      try {
        const event = row.eventData as BehaviorEvent;
        if (event && event.eventType && event.symbol && event.engineName) {
          recordBehaviorEvent(event);
        }
      } catch {
        // Skip malformed events
      }
    }
  } catch {
    // Non-fatal — profile rebuild proceeds with backtest events only
  }
}
