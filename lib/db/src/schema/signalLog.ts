import { pgTable, serial, text, doublePrecision, boolean, timestamp, jsonb, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const signalLogTable = pgTable("signal_log", {
  id: serial("id").primaryKey(),
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  symbol: text("symbol").notNull(),
  strategyName: text("strategy_name").notNull(),
  legacyDiagnosticScore: doublePrecision("legacy_diagnostic_score"),
  runtimeEvidence: doublePrecision("runtime_evidence").notNull(),
  expectedValue: doublePrecision("expected_value").notNull(),
  allowedFlag: boolean("allowed_flag").notNull().default(false),
  admissionReason: text("admission_reason"),
  direction: text("direction"),
  suggestedSl: doublePrecision("suggested_sl"),
  suggestedTp: doublePrecision("suggested_tp"),
  aiVerdict: text("ai_verdict"),
  aiReasoning: text("ai_reasoning"),
  aiConfidenceAdj: doublePrecision("ai_confidence_adj"),
  runtimeEvidenceDimensions: jsonb("runtime_evidence_dimensions"),
  mode: text("mode"),
  regime: text("regime"),
  regimeConfidence: doublePrecision("regime_confidence"),
  strategyFamily: text("strategy_family"),
  subStrategy: text("sub_strategy"),
  allocationPct: doublePrecision("allocation_pct"),
  executionStatus: text("execution_status"),
  expectedMovePct: doublePrecision("expected_move_pct"),
  expectedHoldDays: doublePrecision("expected_hold_days"),
  captureRate: doublePrecision("capture_rate"),
  empiricalWinRate: doublePrecision("empirical_win_rate"),
  // Optional linkage to a detected calibration move (research scaffold — no live behavior).
  // Allows future correlation between live signals and historically detected moves.
  calibrationMoveId: integer("calibration_move_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertSignalLogSchema = createInsertSchema(signalLogTable).omit({ id: true, createdAt: true });
export type InsertSignalLog = z.infer<typeof insertSignalLogSchema>;
export type SignalLog = typeof signalLogTable.$inferSelect;
