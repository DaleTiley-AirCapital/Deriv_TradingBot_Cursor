import { pgTable, serial, text, doublePrecision, integer, timestamp, jsonb, unique, boolean, foreignKey } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"



export const candles = pgTable("candles", {
        id: serial().primaryKey().notNull(),
        symbol: text().notNull(),
        timeframe: text().notNull(),
        openTs: doublePrecision("open_ts").notNull(),
        closeTs: doublePrecision("close_ts").notNull(),
        open: doublePrecision().notNull(),
        high: doublePrecision().notNull(),
        low: doublePrecision().notNull(),
        close: doublePrecision().notNull(),
        tickCount: integer("tick_count").default(0).notNull(),
        createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const spikeEvents = pgTable("spike_events", {
        id: serial().primaryKey().notNull(),
        symbol: text().notNull(),
        eventTs: doublePrecision("event_ts").notNull(),
        direction: text().notNull(),
        spikeSize: doublePrecision("spike_size").notNull(),
        ticksSincePreviousSpike: integer("ticks_since_previous_spike"),
        createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const features = pgTable("features", {
        id: serial().primaryKey().notNull(),
        symbol: text().notNull(),
        ts: doublePrecision().notNull(),
        featureJson: jsonb("feature_json").notNull(),
        regimeLabel: text("regime_label"),
        targetLabel: text("target_label"),
        createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const ticks = pgTable("ticks", {
        id: serial().primaryKey().notNull(),
        symbol: text().notNull(),
        epochTs: doublePrecision("epoch_ts").notNull(),
        quote: doublePrecision().notNull(),
        createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const trades = pgTable("trades", {
        id: serial().primaryKey().notNull(),
        brokerTradeId: text("broker_trade_id"),
        symbol: text().notNull(),
        strategyName: text("strategy_name").notNull(),
        side: text().notNull(),
        entryTs: timestamp("entry_ts", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
        exitTs: timestamp("exit_ts", { withTimezone: true, mode: 'string' }),
        entryPrice: doublePrecision("entry_price").notNull(),
        exitPrice: doublePrecision("exit_price"),
        sl: doublePrecision().notNull(),
        tp: doublePrecision().notNull(),
        size: doublePrecision().notNull(),
        pnl: doublePrecision(),
        status: text().default('open').notNull(),
        mode: text().default('paper').notNull(),
        notes: text(),
        createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
        confidence: doublePrecision(),
        trailingStopPct: doublePrecision("trailing_stop_pct"),
        peakPrice: doublePrecision("peak_price"),
        maxExitTs: timestamp("max_exit_ts", { withTimezone: true, mode: 'string' }),
        exitReason: text("exit_reason"),
        currentPrice: doublePrecision("current_price"),
});

export const platformState = pgTable("platform_state", {
        id: serial().primaryKey().notNull(),
        key: text().notNull(),
        value: text().notNull(),
        updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
        unique("platform_state_key_unique").on(table.key),
]);

export const backtestRuns = pgTable("backtest_runs", {
        id: serial().primaryKey().notNull(),
        strategyName: text("strategy_name").notNull(),
        symbol: text().notNull(),
        initialCapital: doublePrecision("initial_capital").default(10000).notNull(),
        totalReturn: doublePrecision("total_return"),
        netProfit: doublePrecision("net_profit"),
        winRate: doublePrecision("win_rate"),
        profitFactor: doublePrecision("profit_factor"),
        maxDrawdown: doublePrecision("max_drawdown"),
        tradeCount: integer("trade_count"),
        avgHoldingHours: doublePrecision("avg_holding_hours"),
        expectancy: doublePrecision(),
        sharpeRatio: doublePrecision("sharpe_ratio"),
        configJson: jsonb("config_json"),
        metricsJson: jsonb("metrics_json"),
        status: text().default('pending').notNull(),
        createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const modelRuns = pgTable("model_runs", {
        id: serial().primaryKey().notNull(),
        modelName: text("model_name").notNull(),
        symbol: text().notNull(),
        trainingWindow: integer("training_window").notNull(),
        accuracy: doublePrecision(),
        precision: doublePrecision(),
        recall: doublePrecision(),
        f1Score: doublePrecision("f1_score"),
        metricsJson: jsonb("metrics_json"),
        createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const signalLog = pgTable("signal_log", {
        id: serial().primaryKey().notNull(),
        ts: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
        symbol: text().notNull(),
        strategyName: text("strategy_name").notNull(),
        score: doublePrecision().notNull(),
        expectedValue: doublePrecision("expected_value").notNull(),
        allowedFlag: boolean("allowed_flag").default(false).notNull(),
        rejectionReason: text("rejection_reason"),
        direction: text(),
        suggestedSl: doublePrecision("suggested_sl"),
        suggestedTp: doublePrecision("suggested_tp"),
        createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
        aiVerdict: text("ai_verdict"),
        aiReasoning: text("ai_reasoning"),
        aiConfidenceAdj: doublePrecision("ai_confidence_adj"),
        compositeScore: doublePrecision("composite_score"),
        scoringDimensions: jsonb("scoring_dimensions"),
        mode: text(),
        regime: text(),
        regimeConfidence: doublePrecision("regime_confidence"),
        strategyFamily: text("strategy_family"),
        subStrategy: text("sub_strategy"),
        allocationPct: doublePrecision("allocation_pct"),
        executionStatus: text("execution_status"),
});

export const backtestTrades = pgTable("backtest_trades", {
        id: serial().primaryKey().notNull(),
        backtestRunId: integer("backtest_run_id").notNull(),
        entryTs: timestamp("entry_ts", { withTimezone: true, mode: 'string' }).notNull(),
        exitTs: timestamp("exit_ts", { withTimezone: true, mode: 'string' }),
        direction: text().notNull(),
        entryPrice: doublePrecision("entry_price").notNull(),
        exitPrice: doublePrecision("exit_price"),
        pnl: doublePrecision(),
        exitReason: text("exit_reason"),
        createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
        foreignKey({
                        columns: [table.backtestRunId],
                        foreignColumns: [backtestRuns.id],
                        name: "backtest_trades_backtest_run_id_backtest_runs_id_fk"
                }),
]);

/**
 * Behavior events — durable store for live trade outcomes captured by the
 * live outcome scaffold in tradeEngine.closePosition. Also stores backtest
 * events for sessions that explicitly persist (POST /api/behavior/persist/:symbol).
 * In-memory events are kept for fast profiler access; DB is the durable backup.
 */
export const behaviorEvents = pgTable("behavior_events", {
        id: serial().primaryKey().notNull(),
        symbol: text().notNull(),
        engineName: text("engine_name").notNull(),
        eventType: text("event_type").notNull(),
        source: text().notNull().default("live"),
        eventData: jsonb("event_data").notNull(),
        createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});
