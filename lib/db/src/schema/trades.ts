import { pgTable, serial, text, doublePrecision, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tradesTable = pgTable("trades", {
  id: serial("id").primaryKey(),
  brokerTradeId: text("broker_trade_id"),
  symbol: text("symbol").notNull(),
  serviceId: text("service_id"),
  serviceCandidateId: text("service_candidate_id"),
  allocatorDecisionId: text("allocator_decision_id"),
  runtimeArtifactId: text("runtime_artifact_id"),
  lifecyclePlanId: text("lifecycle_plan_id"),
  sourcePolicyId: text("source_policy_id"),
  attributionPath: text("attribution_path"),
  strategyName: text("strategy_name").notNull(),
  side: text("side").notNull(),
  entryTs: timestamp("entry_ts", { withTimezone: true }).notNull().defaultNow(),
  exitTs: timestamp("exit_ts", { withTimezone: true }),
  entryPrice: doublePrecision("entry_price").notNull(),
  exitPrice: doublePrecision("exit_price"),
  sl: doublePrecision("sl").notNull(),
  tp: doublePrecision("tp").notNull(),
  size: doublePrecision("size").notNull(),
  pnl: doublePrecision("pnl"),
  status: text("status").notNull().default("open"),
  mode: text("mode").notNull().default("paper"),
  notes: text("notes"),
  confidence: doublePrecision("confidence"),
  trailingStopPct: doublePrecision("trailing_stop_pct"),
  peakPrice: doublePrecision("peak_price"),
  maxExitTs: timestamp("max_exit_ts", { withTimezone: true }),
  exitReason: text("exit_reason"),
  currentPrice: doublePrecision("current_price"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Unified lifecycle state machine fields (set by applyBarStateTransitions in both live + backtest)
  tradeStage: integer("trade_stage").notNull().default(1),   // 1=initial, 2=breakeven, 3=trailing
  mfePct: doublePrecision("mfe_pct").notNull().default(0),   // max favourable excursion %
  maePct: doublePrecision("mae_pct").notNull().default(0),   // max adverse excursion %
  // Optional linkage to a detected calibration move (research scaffold — no live behavior).
  // Populated only after manual or automated correlation; null by default.
  calibrationMoveId: integer("calibration_move_id"),
});

export const insertTradeSchema = createInsertSchema(tradesTable).omit({ id: true, createdAt: true });
export type InsertTrade = z.infer<typeof insertTradeSchema>;
export type Trade = typeof tradesTable.$inferSelect;
