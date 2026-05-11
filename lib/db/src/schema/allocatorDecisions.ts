import { pgTable, serial, text, doublePrecision, timestamp, boolean, jsonb, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const allocatorDecisionsTable = pgTable("allocator_decisions", {
  id: serial("id").primaryKey(),
  decisionId: text("decision_id").notNull().unique(),
  candidateId: text("candidate_id").notNull(),
  serviceId: text("service_id").notNull(),
  symbol: text("symbol").notNull(),
  approved: boolean("approved").notNull().default(false),
  rejectionReason: text("rejection_reason"),
  requestedAllocationPct: doublePrecision("requested_allocation_pct"),
  approvedAllocationPct: doublePrecision("approved_allocation_pct"),
  approvedCapitalAmount: doublePrecision("approved_capital_amount"),
  requestedLeverage: doublePrecision("requested_leverage"),
  approvedLeverage: doublePrecision("approved_leverage"),
  finalTp1Pct: doublePrecision("final_tp1_pct"),
  finalTp2Pct: doublePrecision("final_tp2_pct"),
  finalHardSlPct: doublePrecision("final_hard_sl_pct"),
  lifecyclePlanId: text("lifecycle_plan_id"),
  executionAllowed: boolean("execution_allowed").notNull().default(false),
  activeMode: text("active_mode").notNull(),
  portfolioExposureBefore: doublePrecision("portfolio_exposure_before"),
  portfolioExposureAfter: doublePrecision("portfolio_exposure_after"),
  warnings: jsonb("warnings"),
  openedTradeId: integer("opened_trade_id"),
  tradeId: integer("trade_id"),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertAllocatorDecisionSchema = createInsertSchema(allocatorDecisionsTable).omit({ id: true, createdAt: true });
export type InsertAllocatorDecision = z.infer<typeof insertAllocatorDecisionSchema>;
export type AllocatorDecisionRecord = typeof allocatorDecisionsTable.$inferSelect;
