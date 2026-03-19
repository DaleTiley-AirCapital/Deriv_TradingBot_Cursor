import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import app from "./app.js";

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

    CREATE TABLE IF NOT EXISTS trades (
      id              SERIAL PRIMARY KEY,
      broker_trade_id TEXT,
      symbol          TEXT NOT NULL,
      strategy_name   TEXT NOT NULL,
      side            TEXT NOT NULL,
      entry_ts        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      exit_ts         TIMESTAMPTZ,
      entry_price     DOUBLE PRECISION NOT NULL,
      exit_price      DOUBLE PRECISION,
      sl              DOUBLE PRECISION NOT NULL,
      tp              DOUBLE PRECISION NOT NULL,
      size            DOUBLE PRECISION NOT NULL,
      pnl             DOUBLE PRECISION,
      status          TEXT NOT NULL DEFAULT 'open',
      mode            TEXT NOT NULL DEFAULT 'paper',
      notes           TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_trades_status ON trades (status);

    CREATE TABLE IF NOT EXISTS signal_log (
      id               SERIAL PRIMARY KEY,
      ts               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      symbol           TEXT NOT NULL,
      strategy_name    TEXT NOT NULL,
      score            DOUBLE PRECISION NOT NULL,
      expected_value   DOUBLE PRECISION NOT NULL,
      allowed_flag     BOOLEAN NOT NULL DEFAULT FALSE,
      rejection_reason TEXT,
      direction        TEXT,
      suggested_sl     DOUBLE PRECISION,
      suggested_tp     DOUBLE PRECISION,
      ai_verdict       TEXT,
      ai_reasoning     TEXT,
      ai_confidence_adj DOUBLE PRECISION,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_signals_ts ON signal_log (ts DESC);

    ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS ai_verdict TEXT;
    ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS ai_reasoning TEXT;
    ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS ai_confidence_adj DOUBLE PRECISION;

    CREATE TABLE IF NOT EXISTS platform_state (
      id         SERIAL PRIMARY KEY,
      key        TEXT NOT NULL UNIQUE,
      value      TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Seed default platform configuration (only if table is empty)
    INSERT INTO platform_state (key, value)
    SELECT * FROM (VALUES
      ('mode',                'idle'),
      ('kill_switch',         'false'),
      ('allocation_mode',     'balanced'),
      ('total_capital',       '10000'),
      ('max_daily_loss_pct',  '3'),
      ('max_weekly_loss_pct', '8'),
      ('max_drawdown_pct',    '15'),
      ('max_open_trades',     '4'),
      ('streaming',           'false'),
      ('disabled_strategies', '')
    ) AS defaults(key, value)
    WHERE NOT EXISTS (SELECT 1 FROM platform_state LIMIT 1);
  `);
  console.log("[DB] Schema ready.");
}

initDb()
  .then(() => {
    app.listen(port, () => {
      console.log(`Server listening on port ${port}`);
    });
  })
  .catch((err) => {
    console.error("[DB] Initialisation failed:", err);
    process.exit(1);
  });
