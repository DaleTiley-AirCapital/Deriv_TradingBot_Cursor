import {
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const symbolResearchProfilesTable = pgTable("symbol_research_profiles", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  symbolDomain: text("symbol_domain").notNull(),
  windowDays: integer("window_days").notNull().default(90),
  dataHealthSummary: jsonb("data_health_summary"),
  moveCount: integer("move_count").notNull().default(0),
  moveFamilyDistribution: jsonb("move_family_distribution"),
  engineTypeRecommendation: text("engine_type_recommendation"),
  buildPriority: text("build_priority"),
  estimatedTradesPerMonth: doublePrecision("estimated_trades_per_month").notNull().default(0),
  estimatedCapitalUtilizationPct: doublePrecision("estimated_capital_utilization_pct").notNull().default(0),
  estimatedFitAdjustedMonthlyReturnPct: doublePrecision("estimated_fit_adjusted_monthly_return_pct").notNull().default(0),
  recommendedScanIntervalSeconds: integer("recommended_scan_interval_seconds"),
  recommendedConfirmationWindow: text("recommended_confirmation_window"),
  recommendedEntryModel: text("recommended_entry_model"),
  recommendedHoldProfile: jsonb("recommended_hold_profile"),
  recommendedTpModel: jsonb("recommended_tp_model"),
  recommendedSlModel: jsonb("recommended_sl_model"),
  recommendedTrailingModel: jsonb("recommended_trailing_model"),
  recommendedScoreGates: jsonb("recommended_score_gates"),
  researchStatus: text("research_status").notNull().default("research_complete"),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  lastRunId: integer("last_run_id").notNull(),
  rawJson: jsonb("raw_json"),
}, (table) => [
  uniqueIndex("idx_symbol_research_profiles_symbol_window").on(table.symbol, table.windowDays),
]);

export type SymbolResearchProfileRow = typeof symbolResearchProfilesTable.$inferSelect;
export type InsertSymbolResearchProfileRow = typeof symbolResearchProfilesTable.$inferInsert;
