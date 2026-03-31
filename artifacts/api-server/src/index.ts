import { sql } from "drizzle-orm";
import { db, platformStateTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import app from "./app.js";
import { getDerivClientWithDbToken, getEnabledSymbols, V1_DEFAULT_SYMBOLS } from "./lib/deriv.js";
import { startScheduler } from "./lib/scheduler.js";
import { validateActiveSymbols } from "./lib/symbolValidator.js";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

/**
 * Ensure all database tables exist before the server starts.
 * Uses CREATE TABLE IF NOT EXISTS so it is safe to run on every boot —
 * existing data is never touched.
 */
async function initDb(): Promise<void> {
  console.log("[DB] Running schema initialisation...");
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ticks (
      id         SERIAL PRIMARY KEY,
      symbol     TEXT NOT NULL,
      epoch_ts   DOUBLE PRECISION NOT NULL,
      quote      DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ticks_symbol_ts ON ticks (symbol, epoch_ts DESC);

    CREATE TABLE IF NOT EXISTS candles (
      id         SERIAL PRIMARY KEY,
      symbol     TEXT NOT NULL,
      timeframe  TEXT NOT NULL,
      open_ts    DOUBLE PRECISION NOT NULL,
      close_ts   DOUBLE PRECISION NOT NULL,
      open       DOUBLE PRECISION NOT NULL,
      high       DOUBLE PRECISION NOT NULL,
      low        DOUBLE PRECISION NOT NULL,
      close      DOUBLE PRECISION NOT NULL,
      tick_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_candles_symbol_tf_ts ON candles (symbol, timeframe, open_ts DESC);

    DELETE FROM candles a USING candles b
      WHERE a.id > b.id
        AND a.symbol    = b.symbol
        AND a.timeframe = b.timeframe
        AND a.open_ts   = b.open_ts;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_candles_symbol_tf_ts_unique ON candles (symbol, timeframe, open_ts);

    CREATE TABLE IF NOT EXISTS spike_events (
      id                         SERIAL PRIMARY KEY,
      symbol                     TEXT NOT NULL,
      event_ts                   DOUBLE PRECISION NOT NULL,
      direction                  TEXT NOT NULL,
      spike_size                 DOUBLE PRECISION NOT NULL,
      ticks_since_previous_spike INTEGER,
      created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_spikes_symbol_ts ON spike_events (symbol, event_ts DESC);

    CREATE TABLE IF NOT EXISTS features (
      id           SERIAL PRIMARY KEY,
      symbol       TEXT NOT NULL,
      ts           DOUBLE PRECISION NOT NULL,
      feature_json JSONB NOT NULL,
      regime_label TEXT,
      target_label TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_features_symbol_ts ON features (symbol, ts DESC);

    CREATE TABLE IF NOT EXISTS model_runs (
      id              SERIAL PRIMARY KEY,
      model_name      TEXT NOT NULL,
      symbol          TEXT NOT NULL,
      training_window INTEGER NOT NULL,
      accuracy        DOUBLE PRECISION,
      precision       DOUBLE PRECISION,
      recall          DOUBLE PRECISION,
      f1_score        DOUBLE PRECISION,
      metrics_json    JSONB,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS backtest_runs (
      id                SERIAL PRIMARY KEY,
      strategy_name     TEXT NOT NULL,
      symbol            TEXT NOT NULL,
      initial_capital   DOUBLE PRECISION NOT NULL DEFAULT 10000,
      total_return      DOUBLE PRECISION,
      net_profit        DOUBLE PRECISION,
      win_rate          DOUBLE PRECISION,
      profit_factor     DOUBLE PRECISION,
      max_drawdown      DOUBLE PRECISION,
      trade_count       INTEGER,
      avg_holding_hours DOUBLE PRECISION,
      expectancy        DOUBLE PRECISION,
      sharpe_ratio      DOUBLE PRECISION,
      config_json       JSONB,
      metrics_json      JSONB,
      status            TEXT NOT NULL DEFAULT 'pending',
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS backtest_trades (
      id               SERIAL PRIMARY KEY,
      backtest_run_id  INTEGER NOT NULL REFERENCES backtest_runs(id),
      entry_ts         TIMESTAMPTZ NOT NULL,
      exit_ts          TIMESTAMPTZ,
      direction        TEXT NOT NULL,
      entry_price      DOUBLE PRECISION NOT NULL,
      exit_price       DOUBLE PRECISION,
      pnl              DOUBLE PRECISION,
      exit_reason      TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS trades (
      id                SERIAL PRIMARY KEY,
      broker_trade_id   TEXT,
      symbol            TEXT NOT NULL,
      strategy_name     TEXT NOT NULL,
      side              TEXT NOT NULL,
      entry_ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      exit_ts           TIMESTAMPTZ,
      entry_price       DOUBLE PRECISION NOT NULL,
      exit_price        DOUBLE PRECISION,
      sl                DOUBLE PRECISION NOT NULL,
      tp                DOUBLE PRECISION NOT NULL,
      size              DOUBLE PRECISION NOT NULL,
      pnl               DOUBLE PRECISION,
      status            TEXT NOT NULL DEFAULT 'open',
      mode              TEXT NOT NULL DEFAULT 'paper',
      notes             TEXT,
      confidence        DOUBLE PRECISION,
      trailing_stop_pct DOUBLE PRECISION,
      peak_price        DOUBLE PRECISION,
      max_exit_ts       TIMESTAMPTZ,
      exit_reason       TEXT,
      current_price     DOUBLE PRECISION,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_trades_status ON trades (status);

    CREATE TABLE IF NOT EXISTS signal_log (
      id                 SERIAL PRIMARY KEY,
      ts                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      symbol             TEXT NOT NULL,
      strategy_name      TEXT NOT NULL,
      score              DOUBLE PRECISION NOT NULL,
      expected_value     DOUBLE PRECISION NOT NULL,
      allowed_flag       BOOLEAN NOT NULL DEFAULT FALSE,
      rejection_reason   TEXT,
      direction          TEXT,
      suggested_sl       DOUBLE PRECISION,
      suggested_tp       DOUBLE PRECISION,
      ai_verdict         TEXT,
      ai_reasoning       TEXT,
      ai_confidence_adj  DOUBLE PRECISION,
      composite_score    DOUBLE PRECISION,
      scoring_dimensions JSONB,
      mode               TEXT,
      regime             TEXT,
      regime_confidence  DOUBLE PRECISION,
      strategy_family    TEXT,
      sub_strategy       TEXT,
      allocation_pct     DOUBLE PRECISION,
      execution_status   TEXT,
      expected_move_pct  DOUBLE PRECISION,
      expected_hold_days DOUBLE PRECISION,
      capture_rate       DOUBLE PRECISION,
      empirical_win_rate DOUBLE PRECISION,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_signals_ts ON signal_log (ts DESC);

    CREATE TABLE IF NOT EXISTS platform_state (
      id         SERIAL PRIMARY KEY,
      key        TEXT NOT NULL UNIQUE,
      value      TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const migrations = [
    "ALTER TABLE trades ADD COLUMN IF NOT EXISTS confidence DOUBLE PRECISION",
    "ALTER TABLE trades ADD COLUMN IF NOT EXISTS trailing_stop_pct DOUBLE PRECISION",
    "ALTER TABLE trades ADD COLUMN IF NOT EXISTS peak_price DOUBLE PRECISION",
    "ALTER TABLE trades ADD COLUMN IF NOT EXISTS max_exit_ts TIMESTAMPTZ",
    "ALTER TABLE trades ADD COLUMN IF NOT EXISTS exit_reason TEXT",
    "ALTER TABLE trades ADD COLUMN IF NOT EXISTS current_price DOUBLE PRECISION",
    "ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS composite_score DOUBLE PRECISION",
    "ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS scoring_dimensions JSONB",
    "ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS mode TEXT",
    "ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS regime TEXT",
    "ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS regime_confidence DOUBLE PRECISION",
    "ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS strategy_family TEXT",
    "ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS sub_strategy TEXT",
    "ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS allocation_pct DOUBLE PRECISION",
    "ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS execution_status TEXT",
    "ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS expected_move_pct DOUBLE PRECISION",
    "ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS expected_hold_days DOUBLE PRECISION",
    "ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS capture_rate DOUBLE PRECISION",
    "ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS empirical_win_rate DOUBLE PRECISION",
  ];
  for (const stmt of migrations) {
    try {
      await db.execute(sql.raw(stmt));
    } catch (err) {
      console.error(`[DB] Migration failed: ${stmt}`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`[DB] Ran ${migrations.length} column migrations.`);

  const setupCheckRow = await db.select().from(platformStateTable).where(eq(platformStateTable.key, "initial_setup_complete")).limit(1);
  const alreadySetUp = setupCheckRow.length > 0 && setupCheckRow[0].value === "true";

  if (alreadySetUp) {
    console.log("[DB] Setup already complete — preserving existing data.");
  } else {
    console.log("[DB] Initial setup not yet complete — clearing derived data only (preserving candles & API keys)...");
    await db.execute(sql`TRUNCATE TABLE backtest_trades CASCADE`);
    await db.execute(sql`TRUNCATE TABLE backtest_runs CASCADE`);
    await db.execute(sql`TRUNCATE TABLE trades CASCADE`);
    await db.execute(sql`TRUNCATE TABLE signal_log CASCADE`);
    await db.execute(sql`TRUNCATE TABLE features CASCADE`);
    await db.execute(sql`TRUNCATE TABLE model_runs CASCADE`);
    await db.execute(sql`TRUNCATE TABLE spike_events CASCADE`);
    await db.execute(sql`TRUNCATE TABLE ticks CASCADE`);
  }

  await db.execute(sql`
    INSERT INTO platform_state (key, value)
    SELECT key, value FROM (VALUES
      ('mode',                'idle'),
      ('kill_switch',         'false'),
      ('streaming',           'false'),
      ('disabled_strategies', ''),
      ('min_composite_score', '80'),
      ('paper_min_composite_score', '80'),
      ('demo_min_composite_score',  '85'),
      ('real_min_composite_score',  '90'),
      ('min_ev_threshold',    '0.001'),
      ('min_rr_ratio',        '1.5'),

      ('paper_capital',               '10000'),
      ('paper_equity_pct_per_trade',  '30'),
      ('paper_max_open_trades',       '4'),
      ('paper_allocation_mode',       'aggressive'),
      ('paper_max_daily_loss_pct',   '8'),
      ('paper_max_weekly_loss_pct',  '15'),
      ('paper_max_drawdown_pct',     '25'),
      ('paper_extraction_target_pct','50'),
      ('paper_correlated_family_cap','4'),

      ('demo_capital',               '600'),
      ('demo_equity_pct_per_trade',  '20'),
      ('demo_max_open_trades',       '3'),
      ('demo_allocation_mode',       'balanced'),
      ('demo_max_daily_loss_pct',   '5'),
      ('demo_max_weekly_loss_pct',  '10'),
      ('demo_max_drawdown_pct',     '18'),
      ('demo_extraction_target_pct','50'),
      ('demo_correlated_family_cap','3'),

      ('real_capital',               '600'),
      ('real_equity_pct_per_trade',  '15'),
      ('real_max_open_trades',       '3'),
      ('real_allocation_mode',       'balanced'),
      ('real_max_daily_loss_pct',   '3'),
      ('real_max_weekly_loss_pct',  '6'),
      ('real_max_drawdown_pct',     '12'),
      ('real_extraction_target_pct','50'),
      ('real_correlated_family_cap','3')
    ) AS defaults(key, value)
    WHERE NOT EXISTS (SELECT 1 FROM platform_state ps WHERE ps.key = defaults.key);
  `);

  await db.execute(sql`
    INSERT INTO platform_state (key, value) VALUES ('min_composite_score', '80') ON CONFLICT (key) DO UPDATE SET value = '80';
    UPDATE platform_state SET value = '80' WHERE key = 'paper_min_composite_score' AND CAST(value AS INTEGER) < 80;
    UPDATE platform_state SET value = '85' WHERE key = 'demo_min_composite_score' AND CAST(value AS INTEGER) < 85;
    UPDATE platform_state SET value = '90' WHERE key = 'real_min_composite_score' AND CAST(value AS INTEGER) < 90;
    UPDATE platform_state SET value = '80' WHERE key = 'ai_suggest_paper_min_composite_score' AND CAST(value AS INTEGER) < 80;
    UPDATE platform_state SET value = '85' WHERE key = 'ai_suggest_demo_min_composite_score' AND CAST(value AS INTEGER) < 85;
    UPDATE platform_state SET value = '90' WHERE key = 'ai_suggest_real_min_composite_score' AND CAST(value AS INTEGER) < 90;
  `);

  console.log("[DB] Schema ready.");
}

async function autoConfigureAI(): Promise<void> {
  try {
    const aiRows = await db.select().from(platformStateTable).where(eq(platformStateTable.key, "ai_verification_enabled"));
    if (aiRows.length > 0) return;

    const keyRows = await db.select().from(platformStateTable).where(eq(platformStateTable.key, "openai_api_key"));
    const hasKey = keyRows.length > 0 && keyRows[0].value && keyRows[0].value.length > 10;
    const defaultValue = hasKey ? "true" : "false";

    await db.insert(platformStateTable).values({ key: "ai_verification_enabled", value: defaultValue })
      .onConflictDoNothing();
    console.log(`[AutoConfig] AI verification default: ${defaultValue} (OpenAI key ${hasKey ? "present" : "absent"})`);
  } catch (err) {
    console.warn("[AutoConfig] Could not configure AI default:", err instanceof Error ? err.message : err);
  }
}

async function autoStartStreaming(): Promise<void> {
  try {
    await autoConfigureAI();

    const setupRow = await db.select().from(platformStateTable).where(eq(platformStateTable.key, "initial_setup_complete")).limit(1);
    const setupDone = setupRow.length > 0 && setupRow[0].value === "true";
    if (!setupDone) {
      console.log("[AutoStart] Initial setup not complete — skipping auto-start. Run setup wizard first.");
      return;
    }

    const rows = await db.select().from(platformStateTable).where(eq(platformStateTable.key, "streaming"));
    const explicitlyStopped = rows.length > 0 && rows[0].value === "false";
    if (explicitlyStopped) {
      console.log("[AutoStart] Streaming explicitly stopped — skipping auto-start. Use UI to start.");
      return;
    }
    const enabledSymbols = await getEnabledSymbols();
    const validSymbols = enabledSymbols.filter(s => V1_DEFAULT_SYMBOLS.includes(s));
    if (validSymbols.length === 0) {
      console.log("[AutoStart] No valid symbols to stream");
      return;
    }
    const client = await getDerivClientWithDbToken();
    await client.startStreaming(validSymbols);
    console.log(`[AutoStart] Streaming started for ${validSymbols.length} symbols`);
  } catch (err) {
    console.warn("[AutoStart] Could not auto-start streaming:", err instanceof Error ? err.message : err);
  }
}

initDb()
  .then(() => {
    app.listen(port, () => {
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      console.log(`  Deriv Trading - Long Hold v2`);
      console.log(`  Port: ${port} | ENV: ${process.env.NODE_ENV || "development"}`);
      console.log(`  Health: /api/healthz`);
      console.log(`  Deployable symbols: 12 (Boom/Crash + R_75/R_100)`);
      console.log(`  Strategy families: 5 (trend_continuation, mean_reversion, spike_cluster_recovery, swing_exhaustion, trendline_breakout)`);
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      startScheduler();
      autoStartStreaming();
    });
  })
  .catch((err) => {
    console.error("[DB] Initialisation failed:", err);
    process.exit(1);
  });
