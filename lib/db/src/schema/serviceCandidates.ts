import { pgTable, serial, text, doublePrecision, timestamp, jsonb, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const serviceCandidatesTable = pgTable("service_candidates", {
  id: serial("id").primaryKey(),
  candidateId: text("candidate_id").notNull().unique(),
  serviceId: text("service_id").notNull(),
  symbol: text("symbol").notNull(),
  activeMode: text("active_mode").notNull(),
  runtimeArtifactId: text("runtime_artifact_id"),
  sourcePolicyId: text("source_policy_id"),
  sourceSynthesisJobId: integer("source_synthesis_job_id"),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  candleTs: timestamp("candle_ts", { withTimezone: true }),
  direction: text("direction").notNull(),
  runtimeFamily: text("runtime_family"),
  triggerTransition: text("trigger_transition"),
  predictedMoveSizeBucket: text("predicted_move_size_bucket"),
  expectedMovePct: doublePrecision("expected_move_pct"),
  confidence: doublePrecision("confidence"),
  setupMatch: doublePrecision("setup_match"),
  triggerStrengthScore: doublePrecision("trigger_strength_score"),
  winRateEstimate: doublePrecision("win_rate_estimate"),
  slHitRateEstimate: doublePrecision("sl_hit_rate_estimate"),
  profitFactorEstimate: doublePrecision("profit_factor_estimate"),
  expectedMonthlyContributionPct: doublePrecision("expected_monthly_contribution_pct"),
  tp1Pct: doublePrecision("tp1_pct"),
  tp2Pct: doublePrecision("tp2_pct"),
  hardSlPct: doublePrecision("hard_sl_pct"),
  lifecyclePlanId: text("lifecycle_plan_id"),
  requestedAllocationPct: doublePrecision("requested_allocation_pct"),
  requestedLeverage: doublePrecision("requested_leverage"),
  liveSafeFeatures: jsonb("live_safe_features"),
  warnings: jsonb("warnings"),
  blockers: jsonb("blockers"),
  emissionGate: jsonb("emission_gate"),
  executionStatus: text("execution_status").notNull().default("emitted"),
  openedTradeId: integer("opened_trade_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertServiceCandidateSchema = createInsertSchema(serviceCandidatesTable).omit({ id: true, createdAt: true });
export type InsertServiceCandidate = z.infer<typeof insertServiceCandidateSchema>;
export type ServiceCandidate = typeof serviceCandidatesTable.$inferSelect;
