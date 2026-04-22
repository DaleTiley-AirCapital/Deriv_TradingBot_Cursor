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

ALTER TABLE calibration_feature_relevance
  ADD COLUMN IF NOT EXISTS move_pct_bucket TEXT NOT NULL DEFAULT 'all';
DROP INDEX IF EXISTS idx_calibration_feature_relevance_symbol_family_feature;
CREATE UNIQUE INDEX IF NOT EXISTS idx_calibration_feature_relevance_symbol_family_feature
  ON calibration_feature_relevance (symbol, strategy_family, move_pct_bucket, feature_name);

ALTER TABLE calibration_entry_ideals
  ADD COLUMN IF NOT EXISTS move_pct_bucket TEXT NOT NULL DEFAULT 'all';
DROP INDEX IF EXISTS idx_calibration_entry_ideals_symbol_family;
CREATE UNIQUE INDEX IF NOT EXISTS idx_calibration_entry_ideals_symbol_family
  ON calibration_entry_ideals (symbol, strategy_family, move_pct_bucket);

ALTER TABLE calibration_exit_risk_profiles
  ADD COLUMN IF NOT EXISTS move_pct_bucket TEXT NOT NULL DEFAULT 'all';
DROP INDEX IF EXISTS idx_calibration_exit_risk_profiles_symbol_family;
CREATE UNIQUE INDEX IF NOT EXISTS idx_calibration_exit_risk_profiles_symbol_family
  ON calibration_exit_risk_profiles (symbol, strategy_family, move_pct_bucket);
