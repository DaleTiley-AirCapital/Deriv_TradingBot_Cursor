import { sql } from "drizzle-orm";
import { db, platformStateTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import app from "./app.js";
import { getDerivClientWithDbToken, getEnabledSymbols, ACTIVE_TRADING_SYMBOLS } from "./infrastructure/deriv.js";
import { startScheduler } from "./infrastructure/scheduler.js";
import { validateActiveSymbols } from "./infrastructure/symbolValidator.js";
import { loadLiveBehaviorEvents } from "./core/backtest/behaviorDb.js";

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
      id              SERIAL PRIMARY KEY,
      symbol          TEXT NOT NULL,
      timeframe       TEXT NOT NULL,
      open_ts         DOUBLE PRECISION NOT NULL,
      close_ts        DOUBLE PRECISION NOT NULL,
      open            DOUBLE PRECISION NOT NULL,
      high            DOUBLE PRECISION NOT NULL,
      low             DOUBLE PRECISION NOT NULL,
      close           DOUBLE PRECISION NOT NULL,
      tick_count      INTEGER NOT NULL DEFAULT 0,
      source          TEXT NOT NULL DEFAULT 'historical',
      is_interpolated BOOLEAN NOT NULL DEFAULT FALSE,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
      service_id        TEXT,
      service_candidate_id TEXT,
      allocator_decision_id TEXT,
      runtime_artifact_id TEXT,
      lifecycle_plan_id TEXT,
      source_policy_id  TEXT,
      attribution_path  TEXT,
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
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS service_id TEXT;
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS service_candidate_id TEXT;
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS allocator_decision_id TEXT;
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS runtime_artifact_id TEXT;
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS lifecycle_plan_id TEXT;
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS source_policy_id TEXT;
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS attribution_path TEXT;

    CREATE TABLE IF NOT EXISTS service_candidates (
      id SERIAL PRIMARY KEY,
      candidate_id TEXT NOT NULL UNIQUE,
      service_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      active_mode TEXT NOT NULL,
      runtime_artifact_id TEXT,
      source_policy_id TEXT,
      source_synthesis_job_id INTEGER,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      candle_ts TIMESTAMPTZ,
      direction TEXT NOT NULL,
      runtime_family TEXT,
      trigger_transition TEXT,
      predicted_move_size_bucket TEXT,
      expected_move_pct DOUBLE PRECISION,
      confidence DOUBLE PRECISION,
      setup_match DOUBLE PRECISION,
      trigger_strength_score DOUBLE PRECISION,
      win_rate_estimate DOUBLE PRECISION,
      sl_hit_rate_estimate DOUBLE PRECISION,
      profit_factor_estimate DOUBLE PRECISION,
      expected_monthly_contribution_pct DOUBLE PRECISION,
      tp1_pct DOUBLE PRECISION,
      tp2_pct DOUBLE PRECISION,
      hard_sl_pct DOUBLE PRECISION,
      lifecycle_plan_id TEXT,
      requested_allocation_pct DOUBLE PRECISION,
      requested_leverage DOUBLE PRECISION,
      live_safe_features JSONB,
      warnings JSONB,
      blockers JSONB,
      emission_gate JSONB,
      execution_status TEXT NOT NULL DEFAULT 'emitted',
      opened_trade_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_service_candidates_service_generated_at ON service_candidates (service_id, generated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_service_candidates_symbol_generated_at ON service_candidates (symbol, generated_at DESC);

    CREATE TABLE IF NOT EXISTS allocator_decisions (
      id SERIAL PRIMARY KEY,
      decision_id TEXT NOT NULL UNIQUE,
      candidate_id TEXT NOT NULL,
      service_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      approved BOOLEAN NOT NULL DEFAULT FALSE,
      rejection_reason TEXT,
      requested_allocation_pct DOUBLE PRECISION,
      approved_allocation_pct DOUBLE PRECISION,
      approved_capital_amount DOUBLE PRECISION,
      requested_leverage DOUBLE PRECISION,
      approved_leverage DOUBLE PRECISION,
      final_tp1_pct DOUBLE PRECISION,
      final_tp2_pct DOUBLE PRECISION,
      final_hard_sl_pct DOUBLE PRECISION,
      lifecycle_plan_id TEXT,
      execution_allowed BOOLEAN NOT NULL DEFAULT FALSE,
      active_mode TEXT NOT NULL,
      portfolio_exposure_before DOUBLE PRECISION,
      portfolio_exposure_after DOUBLE PRECISION,
      warnings JSONB,
      opened_trade_id INTEGER,
      trade_id INTEGER,
      decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_allocator_decisions_service_decided_at ON allocator_decisions (service_id, decided_at DESC);
    CREATE INDEX IF NOT EXISTS idx_allocator_decisions_candidate_id ON allocator_decisions (candidate_id);

    CREATE TABLE IF NOT EXISTS signal_log (
      id                 SERIAL PRIMARY KEY,
      ts                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      symbol             TEXT NOT NULL,
      strategy_name      TEXT NOT NULL,
      legacy_diagnostic_score DOUBLE PRECISION,
      runtime_evidence   DOUBLE PRECISION NOT NULL,
      expected_value     DOUBLE PRECISION NOT NULL,
      allowed_flag       BOOLEAN NOT NULL DEFAULT FALSE,
      admission_reason   TEXT,
      direction          TEXT,
      suggested_sl       DOUBLE PRECISION,
      suggested_tp       DOUBLE PRECISION,
      ai_verdict         TEXT,
      ai_reasoning       TEXT,
      ai_confidence_adj  DOUBLE PRECISION,
      runtime_evidence_dimensions JSONB,
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
    ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS legacy_diagnostic_score DOUBLE PRECISION;
    ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS runtime_evidence DOUBLE PRECISION;
    ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS admission_reason TEXT;
    ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS runtime_evidence_dimensions JSONB;
    UPDATE signal_log
    SET
      runtime_evidence = COALESCE(runtime_evidence, composite_score, score),
      legacy_diagnostic_score = COALESCE(legacy_diagnostic_score, score),
      admission_reason = COALESCE(admission_reason, rejection_reason),
      runtime_evidence_dimensions = COALESCE(runtime_evidence_dimensions, scoring_dimensions)
    WHERE runtime_evidence IS NULL
       OR legacy_diagnostic_score IS NULL
       OR admission_reason IS NULL
       OR runtime_evidence_dimensions IS NULL;
    ALTER TABLE signal_log ALTER COLUMN runtime_evidence SET NOT NULL;

    CREATE TABLE IF NOT EXISTS ai_context_embeddings (
      id SERIAL PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL UNIQUE,
      content_text TEXT NOT NULL,
      embedding_vector JSONB NOT NULL,
      metadata_json JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS platform_state (
      id         SERIAL PRIMARY KEY,
      key        TEXT NOT NULL UNIQUE,
      value      TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS behavior_events (
      id          SERIAL PRIMARY KEY,
      symbol      TEXT NOT NULL,
      engine_name TEXT NOT NULL,
      event_type  TEXT NOT NULL,
      source      TEXT NOT NULL DEFAULT 'live',
      event_data  JSONB NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_behavior_events_symbol ON behavior_events (symbol);
    CREATE INDEX IF NOT EXISTS idx_behavior_events_source ON behavior_events (source);

    CREATE TABLE IF NOT EXISTS detected_moves (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      move_type TEXT NOT NULL DEFAULT 'unknown',
      start_ts DOUBLE PRECISION NOT NULL,
      end_ts DOUBLE PRECISION NOT NULL,
      start_price DOUBLE PRECISION NOT NULL,
      end_price DOUBLE PRECISION NOT NULL,
      move_pct DOUBLE PRECISION NOT NULL,
      holding_minutes DOUBLE PRECISION NOT NULL,
      lead_in_shape TEXT NOT NULL DEFAULT 'unknown',
      lead_in_bars INTEGER NOT NULL DEFAULT 0,
      directional_persistence DOUBLE PRECISION NOT NULL DEFAULT 0,
      range_expansion DOUBLE PRECISION NOT NULL DEFAULT 1,
      spike_count_4h INTEGER NOT NULL DEFAULT 0,
      quality_score DOUBLE PRECISION NOT NULL DEFAULT 0,
      quality_tier TEXT NOT NULL DEFAULT 'D',
      window_days INTEGER NOT NULL DEFAULT 90,
      is_interpolated_excluded BOOLEAN NOT NULL DEFAULT TRUE,
      strategy_family_candidate TEXT NOT NULL DEFAULT 'unknown',
      context_json JSONB,
      trigger_zone_json JSONB,
      detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_detected_moves_symbol_ts ON detected_moves (symbol, start_ts);
    CREATE INDEX IF NOT EXISTS idx_detected_moves_symbol_type ON detected_moves (symbol, move_type);
    CREATE INDEX IF NOT EXISTS idx_detected_moves_quality ON detected_moves (symbol, quality_tier);

    CREATE TABLE IF NOT EXISTS calibration_pass_runs (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      window_days INTEGER NOT NULL DEFAULT 90,
      status TEXT NOT NULL DEFAULT 'running',
      pass_name TEXT NOT NULL DEFAULT 'all',
      total_moves INTEGER NOT NULL DEFAULT 0,
      processed_moves INTEGER NOT NULL DEFAULT 0,
      failed_moves INTEGER NOT NULL DEFAULT 0,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      error_summary JSONB,
      meta_json JSONB
    );
    CREATE INDEX IF NOT EXISTS idx_pass_runs_symbol_status ON calibration_pass_runs (symbol, status);
    CREATE INDEX IF NOT EXISTS idx_pass_runs_started_at ON calibration_pass_runs (started_at);

    CREATE TABLE IF NOT EXISTS move_precursor_passes (
      id SERIAL PRIMARY KEY,
      move_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      move_type TEXT NOT NULL,
      engine_matched TEXT,
      engine_would_fire BOOLEAN NOT NULL DEFAULT FALSE,
      precursor_conditions JSONB,
      missed_reason TEXT,
      lead_in_summary TEXT,
      confidence_score DOUBLE PRECISION NOT NULL DEFAULT 0,
      raw_ai_response JSONB,
      pass_run_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_precursor_passes_move_id ON move_precursor_passes (move_id);
    CREATE INDEX IF NOT EXISTS idx_precursor_passes_symbol ON move_precursor_passes (symbol);

    CREATE TABLE IF NOT EXISTS move_behavior_passes (
      id SERIAL PRIMARY KEY,
      move_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      pass_name TEXT NOT NULL,
      earliest_entry_ts DOUBLE PRECISION,
      earliest_entry_price DOUBLE PRECISION,
      entry_slippage DOUBLE PRECISION NOT NULL DEFAULT 0,
      captureable_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
      max_favorable_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
      max_adverse_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
      bars_to_mfe_peak INTEGER NOT NULL DEFAULT 0,
      exit_narrative TEXT,
      trigger_conditions JSONB,
      behavior_pattern TEXT NOT NULL DEFAULT 'unknown',
      holdability_score DOUBLE PRECISION NOT NULL DEFAULT 0,
      raw_ai_response JSONB,
      pass_run_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_behavior_passes_move_id ON move_behavior_passes (move_id);
    CREATE INDEX IF NOT EXISTS idx_behavior_passes_symbol_pass ON move_behavior_passes (symbol, pass_name);

    CREATE TABLE IF NOT EXISTS strategy_calibration_profiles (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      move_type TEXT NOT NULL,
      window_days INTEGER NOT NULL DEFAULT 90,
      target_moves INTEGER NOT NULL DEFAULT 0,
      captured_moves INTEGER NOT NULL DEFAULT 0,
      missed_moves INTEGER NOT NULL DEFAULT 0,
      fit_score DOUBLE PRECISION NOT NULL DEFAULT 0,
      miss_reasons JSONB,
      avg_move_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
      median_move_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
      avg_holding_hours DOUBLE PRECISION NOT NULL DEFAULT 0,
      avg_captureable_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
      avg_holdability_score DOUBLE PRECISION NOT NULL DEFAULT 0,
      engine_coverage JSONB,
      precursor_summary JSONB,
      trigger_summary JSONB,
      feeddown_schema JSONB,
      profitability_summary JSONB,
      last_run_id INTEGER,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_calibration_profiles_symbol_type ON strategy_calibration_profiles (symbol, move_type);

    CREATE TABLE IF NOT EXISTS symbol_research_profiles (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      symbol_domain TEXT NOT NULL,
      window_days INTEGER NOT NULL DEFAULT 90,
      data_health_summary JSONB,
      move_count INTEGER NOT NULL DEFAULT 0,
      move_family_distribution JSONB,
      engine_type_recommendation TEXT,
      build_priority TEXT,
      estimated_trades_per_month DOUBLE PRECISION NOT NULL DEFAULT 0,
      estimated_capital_utilization_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
      estimated_fit_adjusted_monthly_return_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
      recommended_scan_interval_seconds INTEGER,
      recommended_confirmation_window TEXT,
      recommended_entry_model TEXT,
      recommended_hold_profile JSONB,
      recommended_tp_model JSONB,
      recommended_sl_model JSONB,
      recommended_trailing_model JSONB,
      recommended_score_gates JSONB,
      research_status TEXT NOT NULL DEFAULT 'research_complete',
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_run_id INTEGER NOT NULL,
      raw_json JSONB
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_symbol_research_profiles_symbol_window
      ON symbol_research_profiles (symbol, window_days);

    CREATE TABLE IF NOT EXISTS move_family_inferences (
      id SERIAL PRIMARY KEY,
      move_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      strategy_family TEXT NOT NULL,
      confidence_score DOUBLE PRECISION NOT NULL DEFAULT 0,
      development_bars INTEGER NOT NULL DEFAULT 0,
      precursor_bars INTEGER NOT NULL DEFAULT 0,
      trigger_bars INTEGER NOT NULL DEFAULT 0,
      behavior_bars INTEGER NOT NULL DEFAULT 0,
      reasoning_summary TEXT,
      raw_ai_response JSONB,
      pass_run_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_move_family_inferences_move_id
      ON move_family_inferences (move_id);
    CREATE INDEX IF NOT EXISTS idx_move_family_inferences_symbol_family
      ON move_family_inferences (symbol, strategy_family);

    CREATE TABLE IF NOT EXISTS move_progression_artifacts (
      id SERIAL PRIMARY KEY,
      move_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      strategy_family TEXT NOT NULL,
      window_model JSONB NOT NULL,
      progression_summary JSONB NOT NULL,
      feature_stats JSONB NOT NULL,
      compact_raw_slices JSONB NOT NULL,
      pass_run_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_move_progression_artifacts_move_id
      ON move_progression_artifacts (move_id);
    CREATE INDEX IF NOT EXISTS idx_move_progression_artifacts_symbol_family
      ON move_progression_artifacts (symbol, strategy_family);

    CREATE TABLE IF NOT EXISTS calibration_feature_relevance (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      strategy_family TEXT NOT NULL,
      move_pct_bucket TEXT NOT NULL DEFAULT 'all',
      feature_name TEXT NOT NULL,
      relevance_score DOUBLE PRECISION NOT NULL DEFAULT 0,
      precursor_usefulness DOUBLE PRECISION NOT NULL DEFAULT 0,
      trigger_usefulness DOUBLE PRECISION NOT NULL DEFAULT 0,
      behavior_usefulness DOUBLE PRECISION NOT NULL DEFAULT 0,
      notes TEXT,
      source_run_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE calibration_feature_relevance
      ADD COLUMN IF NOT EXISTS move_pct_bucket TEXT NOT NULL DEFAULT 'all';
    DROP INDEX IF EXISTS idx_calibration_feature_relevance_symbol_family_feature;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_calibration_feature_relevance_symbol_family_feature
      ON calibration_feature_relevance (symbol, strategy_family, move_pct_bucket, feature_name);

    CREATE TABLE IF NOT EXISTS calibration_entry_ideals (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      strategy_family TEXT NOT NULL,
      move_pct_bucket TEXT NOT NULL DEFAULT 'all',
      ideal_precursor_profile JSONB NOT NULL,
      ideal_trigger_profile JSONB NOT NULL,
      feature_bands JSONB NOT NULL,
      entry_quality_narrative TEXT,
      progression_summary JSONB,
      source_run_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE calibration_entry_ideals
      ADD COLUMN IF NOT EXISTS move_pct_bucket TEXT NOT NULL DEFAULT 'all';
    DROP INDEX IF EXISTS idx_calibration_entry_ideals_symbol_family;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_calibration_entry_ideals_symbol_family
      ON calibration_entry_ideals (symbol, strategy_family, move_pct_bucket);

    CREATE TABLE IF NOT EXISTS calibration_exit_risk_profiles (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      strategy_family TEXT NOT NULL,
      move_pct_bucket TEXT NOT NULL DEFAULT 'all',
      regression_fingerprints JSONB NOT NULL,
      move_break_warning_patterns JSONB NOT NULL,
      closure_signals JSONB NOT NULL,
      trailing_interpretation_notes TEXT,
      source_run_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE calibration_exit_risk_profiles
      ADD COLUMN IF NOT EXISTS move_pct_bucket TEXT NOT NULL DEFAULT 'all';
    DROP INDEX IF EXISTS idx_calibration_exit_risk_profiles_symbol_family;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_calibration_exit_risk_profiles_symbol_family
      ON calibration_exit_risk_profiles (symbol, strategy_family, move_pct_bucket);

    CREATE TABLE IF NOT EXISTS calibration_feature_frames (
      id SERIAL PRIMARY KEY,
      move_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      open_ts BIGINT NOT NULL,
      relative_bar_from_move_start INTEGER NOT NULL,
      relative_bar_to_move_end INTEGER NOT NULL,
      in_development BOOLEAN NOT NULL DEFAULT FALSE,
      in_precursor BOOLEAN NOT NULL DEFAULT FALSE,
      in_trigger_zone BOOLEAN NOT NULL DEFAULT FALSE,
      in_behavior BOOLEAN NOT NULL DEFAULT FALSE,
      move_pct_bucket TEXT NOT NULL,
      direction TEXT NOT NULL,
      feature_values JSONB NOT NULL,
      normalized_feature_values JSONB NOT NULL,
      source_run_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_calibration_feature_frames_move_ts
      ON calibration_feature_frames (move_id, open_ts);
    CREATE INDEX IF NOT EXISTS idx_calibration_feature_frames_symbol_bucket
      ON calibration_feature_frames (symbol, move_pct_bucket);
    CREATE INDEX IF NOT EXISTS idx_calibration_feature_frames_symbol_ts
      ON calibration_feature_frames (symbol, open_ts);

    CREATE TABLE IF NOT EXISTS calibration_move_window_summaries (
      id SERIAL PRIMARY KEY,
      move_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      window_kind TEXT NOT NULL,
      window_start_ts BIGINT NOT NULL,
      window_end_ts BIGINT NOT NULL,
      window_bars INTEGER NOT NULL,
      move_pct_bucket TEXT NOT NULL,
      feature_summary JSONB NOT NULL,
      compact_raw_slice JSONB NOT NULL,
      source_run_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_calibration_move_window_summaries_move_kind
      ON calibration_move_window_summaries (move_id, window_kind);
    CREATE INDEX IF NOT EXISTS idx_calibration_move_window_summaries_symbol_kind
      ON calibration_move_window_summaries (symbol, window_kind);

    CREATE TABLE IF NOT EXISTS calibration_family_bucket_profiles (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      strategy_family TEXT NOT NULL,
      move_pct_bucket TEXT NOT NULL,
      move_count INTEGER NOT NULL DEFAULT 0,
      window_model JSONB NOT NULL,
      feature_progression_averages JSONB NOT NULL,
      feature_progression_bounds JSONB NOT NULL,
      representative_examples JSONB NOT NULL,
      source_run_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_calibration_family_bucket_profiles_symbol_family_bucket
      ON calibration_family_bucket_profiles (symbol, strategy_family, move_pct_bucket);
  `);

  // Any in-flight calibration pass runs are process-bound and cannot survive a restart.
  // On boot, mark orphaned "running" rows as failed so the UI never stays stuck forever.
  await db.execute(sql`
    UPDATE calibration_pass_runs
    SET
      status = 'failed',
      completed_at = COALESCE(completed_at, NOW()),
      failed_moves = GREATEST(failed_moves, 1),
      error_summary = COALESCE(error_summary, '[]'::jsonb) || jsonb_build_array(
        jsonb_build_object(
          'moveId', -1,
          'pass', 'runner',
          'error', 'Calibration run canceled on server restart before completion'
        )
      ),
      meta_json = COALESCE(meta_json, '{}'::jsonb) || jsonb_build_object(
        'stage', 'Failed',
        'failure', jsonb_build_object(
          'kind', 'server_restart_canceled_run',
          'message', 'Run was marked failed at startup because the previous process exited during execution'
        )
      )
    WHERE status = 'running'
  `);

  const migrations = [
    "ALTER TABLE candles ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'historical'",
    "ALTER TABLE candles ADD COLUMN IF NOT EXISTS is_interpolated BOOLEAN NOT NULL DEFAULT FALSE",
    "ALTER TABLE trades ADD COLUMN IF NOT EXISTS confidence DOUBLE PRECISION",
    "ALTER TABLE trades ADD COLUMN IF NOT EXISTS trailing_stop_pct DOUBLE PRECISION",
    "ALTER TABLE trades ADD COLUMN IF NOT EXISTS peak_price DOUBLE PRECISION",
    "ALTER TABLE trades ADD COLUMN IF NOT EXISTS max_exit_ts TIMESTAMPTZ",
    "ALTER TABLE trades ADD COLUMN IF NOT EXISTS exit_reason TEXT",
    "ALTER TABLE trades ADD COLUMN IF NOT EXISTS current_price DOUBLE PRECISION",
    "ALTER TABLE trades ADD COLUMN IF NOT EXISTS trade_stage INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE trades ADD COLUMN IF NOT EXISTS mfe_pct DOUBLE PRECISION NOT NULL DEFAULT 0",
    "ALTER TABLE trades ADD COLUMN IF NOT EXISTS mae_pct DOUBLE PRECISION NOT NULL DEFAULT 0",
    "ALTER TABLE trades ADD COLUMN IF NOT EXISTS calibration_move_id INTEGER",
    "ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS calibration_move_id INTEGER",
    "CREATE TABLE IF NOT EXISTS detected_moves (id SERIAL PRIMARY KEY, symbol TEXT NOT NULL, direction TEXT NOT NULL, move_type TEXT NOT NULL DEFAULT 'unknown', start_ts DOUBLE PRECISION NOT NULL, end_ts DOUBLE PRECISION NOT NULL, start_price DOUBLE PRECISION NOT NULL, end_price DOUBLE PRECISION NOT NULL, move_pct DOUBLE PRECISION NOT NULL, holding_minutes DOUBLE PRECISION NOT NULL, lead_in_shape TEXT NOT NULL DEFAULT 'unknown', lead_in_bars INTEGER NOT NULL DEFAULT 0, directional_persistence DOUBLE PRECISION NOT NULL DEFAULT 0, range_expansion DOUBLE PRECISION NOT NULL DEFAULT 1, spike_count_4h INTEGER NOT NULL DEFAULT 0, quality_score DOUBLE PRECISION NOT NULL DEFAULT 0, quality_tier TEXT NOT NULL DEFAULT 'D', window_days INTEGER NOT NULL DEFAULT 90, is_interpolated_excluded BOOLEAN NOT NULL DEFAULT TRUE, strategy_family_candidate TEXT NOT NULL DEFAULT 'unknown', context_json JSONB, trigger_zone_json JSONB, detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE TABLE IF NOT EXISTS calibration_pass_runs (id SERIAL PRIMARY KEY, symbol TEXT NOT NULL, window_days INTEGER NOT NULL DEFAULT 90, status TEXT NOT NULL DEFAULT 'running', pass_name TEXT NOT NULL DEFAULT 'all', total_moves INTEGER NOT NULL DEFAULT 0, processed_moves INTEGER NOT NULL DEFAULT 0, failed_moves INTEGER NOT NULL DEFAULT 0, started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ, error_summary JSONB, meta_json JSONB)",
    "CREATE TABLE IF NOT EXISTS move_precursor_passes (id SERIAL PRIMARY KEY, move_id INTEGER NOT NULL, symbol TEXT NOT NULL, direction TEXT NOT NULL, move_type TEXT NOT NULL, engine_matched TEXT, engine_would_fire BOOLEAN NOT NULL DEFAULT FALSE, precursor_conditions JSONB, missed_reason TEXT, lead_in_summary TEXT, confidence_score DOUBLE PRECISION NOT NULL DEFAULT 0, raw_ai_response JSONB, pass_run_id INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE TABLE IF NOT EXISTS move_behavior_passes (id SERIAL PRIMARY KEY, move_id INTEGER NOT NULL, symbol TEXT NOT NULL, direction TEXT NOT NULL, pass_name TEXT NOT NULL, earliest_entry_ts DOUBLE PRECISION, earliest_entry_price DOUBLE PRECISION, entry_slippage DOUBLE PRECISION NOT NULL DEFAULT 0, captureable_pct DOUBLE PRECISION NOT NULL DEFAULT 0, max_favorable_pct DOUBLE PRECISION NOT NULL DEFAULT 0, max_adverse_pct DOUBLE PRECISION NOT NULL DEFAULT 0, bars_to_mfe_peak INTEGER NOT NULL DEFAULT 0, exit_narrative TEXT, trigger_conditions JSONB, behavior_pattern TEXT NOT NULL DEFAULT 'unknown', holdability_score DOUBLE PRECISION NOT NULL DEFAULT 0, raw_ai_response JSONB, pass_run_id INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE TABLE IF NOT EXISTS strategy_calibration_profiles (id SERIAL PRIMARY KEY, symbol TEXT NOT NULL, move_type TEXT NOT NULL, window_days INTEGER NOT NULL DEFAULT 90, target_moves INTEGER NOT NULL DEFAULT 0, captured_moves INTEGER NOT NULL DEFAULT 0, missed_moves INTEGER NOT NULL DEFAULT 0, fit_score DOUBLE PRECISION NOT NULL DEFAULT 0, miss_reasons JSONB, avg_move_pct DOUBLE PRECISION NOT NULL DEFAULT 0, median_move_pct DOUBLE PRECISION NOT NULL DEFAULT 0, avg_holding_hours DOUBLE PRECISION NOT NULL DEFAULT 0, avg_captureable_pct DOUBLE PRECISION NOT NULL DEFAULT 0, avg_holdability_score DOUBLE PRECISION NOT NULL DEFAULT 0, engine_coverage JSONB, precursor_summary JSONB, trigger_summary JSONB, feeddown_schema JSONB, profitability_summary JSONB, last_run_id INTEGER, generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE TABLE IF NOT EXISTS symbol_research_profiles (id SERIAL PRIMARY KEY, symbol TEXT NOT NULL, symbol_domain TEXT NOT NULL, window_days INTEGER NOT NULL DEFAULT 90, data_health_summary JSONB, move_count INTEGER NOT NULL DEFAULT 0, move_family_distribution JSONB, engine_type_recommendation TEXT, build_priority TEXT, estimated_trades_per_month DOUBLE PRECISION NOT NULL DEFAULT 0, estimated_capital_utilization_pct DOUBLE PRECISION NOT NULL DEFAULT 0, estimated_fit_adjusted_monthly_return_pct DOUBLE PRECISION NOT NULL DEFAULT 0, recommended_scan_interval_seconds INTEGER, recommended_confirmation_window TEXT, recommended_entry_model TEXT, recommended_hold_profile JSONB, recommended_tp_model JSONB, recommended_sl_model JSONB, recommended_trailing_model JSONB, recommended_score_gates JSONB, research_status TEXT NOT NULL DEFAULT 'research_complete', generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_run_id INTEGER NOT NULL, raw_json JSONB)",
    "CREATE INDEX IF NOT EXISTS idx_detected_moves_symbol_ts ON detected_moves (symbol, start_ts)",
    "CREATE INDEX IF NOT EXISTS idx_detected_moves_symbol_type ON detected_moves (symbol, move_type)",
    "CREATE INDEX IF NOT EXISTS idx_detected_moves_quality ON detected_moves (symbol, quality_tier)",
    "CREATE INDEX IF NOT EXISTS idx_pass_runs_symbol_status ON calibration_pass_runs (symbol, status)",
    "CREATE INDEX IF NOT EXISTS idx_pass_runs_started_at ON calibration_pass_runs (started_at)",
    "CREATE INDEX IF NOT EXISTS idx_precursor_passes_move_id ON move_precursor_passes (move_id)",
    "CREATE INDEX IF NOT EXISTS idx_precursor_passes_symbol ON move_precursor_passes (symbol)",
    "CREATE INDEX IF NOT EXISTS idx_behavior_passes_move_id ON move_behavior_passes (move_id)",
    "CREATE INDEX IF NOT EXISTS idx_behavior_passes_symbol_pass ON move_behavior_passes (symbol, pass_name)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_calibration_profiles_symbol_type ON strategy_calibration_profiles (symbol, move_type)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_symbol_research_profiles_symbol_window ON symbol_research_profiles (symbol, window_days)",
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

  // ── Explicit candles schema verification (fail-loud before scheduler starts) ──
  const candlesColCheck = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'candles' AND column_name IN ('source', 'is_interpolated')
  `);
  const presentCols = (candlesColCheck.rows as Array<{ column_name: string }>).map(r => r.column_name);
  const missingCols = ["source", "is_interpolated"].filter(c => !presentCols.includes(c));
  if (missingCols.length > 0) {
    throw new Error(
      `[DB] FATAL: candles table is missing required columns after migration: ${missingCols.join(", ")}. ` +
      "Cannot proceed — fix schema before restarting."
    );
  }
  console.log("[DB] Candles schema verified: source and is_interpolated present.");

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
      ('paper_min_composite_score', '60'),
      ('demo_min_composite_score',  '65'),
      ('real_min_composite_score',  '70'),
      ('use_calibrated_runtime_profiles', 'false'),
      ('min_ev_threshold',    '0.001'),
      ('min_rr_ratio',        '1.5'),

      ('paper_capital',               '600'),
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
      ('real_correlated_family_cap','3'),
      ('signal_visibility_threshold','50')
    ) AS defaults(key, value)
    WHERE NOT EXISTS (SELECT 1 FROM platform_state ps WHERE ps.key = defaults.key);
  `);

  await db.execute(sql`
    INSERT INTO platform_state (key, value) VALUES ('min_composite_score', '80') ON CONFLICT (key) DO UPDATE SET value = '80';
    INSERT INTO platform_state (key, value) VALUES ('paper_min_composite_score', '60') ON CONFLICT (key) DO UPDATE SET value = '60';
    INSERT INTO platform_state (key, value) VALUES ('demo_min_composite_score',  '65') ON CONFLICT (key) DO UPDATE SET value = '65';
    INSERT INTO platform_state (key, value) VALUES ('real_min_composite_score',  '70') ON CONFLICT (key) DO UPDATE SET value = '70';
    INSERT INTO platform_state (key, value) VALUES ('use_calibrated_runtime_profiles', 'false') ON CONFLICT (key) DO NOTHING;
    INSERT INTO platform_state (key, value) VALUES ('signal_visibility_threshold', '50') ON CONFLICT (key) DO UPDATE SET value = LEAST(platform_state.value::numeric, 50)::text;
    UPDATE platform_state SET value = '600' WHERE key = 'paper_capital' AND value = '10000';
    UPDATE platform_state SET value = '60' WHERE key = 'ai_suggest_paper_min_composite_score' AND CAST(value AS INTEGER) < 60;
    UPDATE platform_state SET value = '65' WHERE key = 'ai_suggest_demo_min_composite_score' AND CAST(value AS INTEGER) < 65;
    UPDATE platform_state SET value = '70' WHERE key = 'ai_suggest_real_min_composite_score' AND CAST(value AS INTEGER) < 70;
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
    const validSymbols = enabledSymbols.filter(s => ACTIVE_TRADING_SYMBOLS.includes(s));
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
      console.log(`  Deriv Trading - Long Hold V3`);
      console.log(`  Port: ${port} | ENV: ${process.env.NODE_ENV || "development"}`);
      console.log(`  Health: /api/healthz`);
      console.log(`  Active trading symbols: ${ACTIVE_TRADING_SYMBOLS.length} (CRASH300, BOOM300, R_75, R_100)`);
      console.log(`  V3 engines: 8 (boom_expansion, crash_expansion, r75×3, r100×3) | coordinator + hybrid staged manager`);
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      startScheduler();
      autoStartStreaming();
      loadLiveBehaviorEvents().catch(() => {});
    });
  })
  .catch((err) => {
    console.error("[DB] Initialisation failed:", err);
    process.exit(1);
  });
