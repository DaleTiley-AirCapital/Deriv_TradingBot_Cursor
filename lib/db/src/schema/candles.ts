import { pgTable, serial, text, doublePrecision, integer, boolean, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Canonical candle store — the SINGLE source of truth for all OHLCV data.
 *
 * All pipelines write here:
 *   source='historical'   — initial API backfill (deriv.ts backfill())
 *   source='live'         — completed live candles from tick stream (deriv.ts updateOpenCandles())
 *   source='topup'        — gap-fill from API (dataIntegrity.ts repairGapFromApi())
 *   source='enriched'     — derived from 1m aggregation (candleEnrichment.ts)
 *   source='interpolated' — carry-forward fill when API returns no data (dataIntegrity.ts interpolateGap())
 *
 * isInterpolated=true marks synthetic candles (carry-forward) inserted when the API
 * could not provide real price data for a gap period (e.g. market closures, API outage).
 * These candles MUST NOT be used in strategy signal generation.
 *
 * Unique constraint (symbol, timeframe, open_ts) prevents any duplicate candles.
 */
export const candlesTable = pgTable("candles", {
  id:             serial("id").primaryKey(),
  symbol:         text("symbol").notNull(),
  timeframe:      text("timeframe").notNull(),
  openTs:         doublePrecision("open_ts").notNull(),
  closeTs:        doublePrecision("close_ts").notNull(),
  open:           doublePrecision("open").notNull(),
  high:           doublePrecision("high").notNull(),
  low:            doublePrecision("low").notNull(),
  close:          doublePrecision("close").notNull(),
  tickCount:      integer("tick_count").notNull().default(0),
  source:         text("source").notNull().default("historical"),
  isInterpolated: boolean("is_interpolated").notNull().default(false),
  createdAt:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_candles_symbol_tf_ts_unique").on(table.symbol, table.timeframe, table.openTs),
]);

export const insertCandleSchema = createInsertSchema(candlesTable).omit({ id: true, createdAt: true });
export type InsertCandle = z.infer<typeof insertCandleSchema>;
export type Candle = typeof candlesTable.$inferSelect;
