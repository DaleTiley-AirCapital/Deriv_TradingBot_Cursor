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
  ON move_family_inferences(move_id);
CREATE INDEX IF NOT EXISTS idx_move_family_inferences_symbol_family
  ON move_family_inferences(symbol, strategy_family);

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
  ON move_progression_artifacts(move_id);
CREATE INDEX IF NOT EXISTS idx_move_progression_artifacts_symbol_family
  ON move_progression_artifacts(symbol, strategy_family);

CREATE TABLE IF NOT EXISTS calibration_feature_relevance (
  id SERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  strategy_family TEXT NOT NULL,
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_calibration_feature_relevance_symbol_family_feature
  ON calibration_feature_relevance(symbol, strategy_family, feature_name);

CREATE TABLE IF NOT EXISTS calibration_entry_ideals (
  id SERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  strategy_family TEXT NOT NULL,
  ideal_precursor_profile JSONB NOT NULL,
  ideal_trigger_profile JSONB NOT NULL,
  feature_bands JSONB NOT NULL,
  entry_quality_narrative TEXT,
  progression_summary JSONB,
  source_run_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_calibration_entry_ideals_symbol_family
  ON calibration_entry_ideals(symbol, strategy_family);

CREATE TABLE IF NOT EXISTS calibration_exit_risk_profiles (
  id SERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  strategy_family TEXT NOT NULL,
  regression_fingerprints JSONB NOT NULL,
  move_break_warning_patterns JSONB NOT NULL,
  closure_signals JSONB NOT NULL,
  trailing_interpretation_notes TEXT,
  source_run_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_calibration_exit_risk_profiles_symbol_family
  ON calibration_exit_risk_profiles(symbol, strategy_family);
