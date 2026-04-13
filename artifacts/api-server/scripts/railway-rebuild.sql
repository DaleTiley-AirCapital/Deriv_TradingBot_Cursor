-- ============================================================
-- RAILWAY REBUILD SCRIPT (V3)
-- Run after a fresh Railway PostgreSQL deploy.
-- Safe to re-run against an existing schema.
-- Purpose: Seed all required platform_state keys to known-good
-- defaults. Does NOT touch candles, ticks, or spike_events.
-- ============================================================

-- 1. SEED PLATFORM_STATE DEFAULTS (INSERT if missing, no overwrite)
INSERT INTO platform_state (key, value)
SELECT defaults.key, defaults.value
FROM (VALUES
  -- General gates
  ('kill_switch',                    'false'),
  ('trading_active',                 'false'),
  ('paper_active',                   'false'),
  ('demo_active',                    'false'),
  ('real_active',                    'false'),
  ('ai_verification_enabled',        'false'),

  -- Capital
  ('paper_capital',                  '600'),
  ('paper_current_equity',           '600'),
  ('demo_capital',                   '600'),
  ('real_capital',                   '600'),

  -- Score thresholds (safe-mode — production targets 85/90/92 enforced after calibration)
  ('min_composite_score',            '80'),
  ('paper_min_composite_score',      '60'),
  ('demo_min_composite_score',       '65'),
  ('real_min_composite_score',       '70'),

  -- Signal visibility (lower = more signals visible in Engine Decisions)
  ('signal_visibility_threshold',    '50'),

  -- Position sizing
  ('paper_equity_pct_per_trade',     '5'),
  ('demo_equity_pct_per_trade',      '5'),
  ('real_equity_pct_per_trade',      '2'),

  -- Risk limits
  ('paper_max_concurrent_trades',    '3'),
  ('demo_max_concurrent_trades',     '2'),
  ('real_max_concurrent_trades',     '1'),
  ('paper_max_daily_loss_pct',       '5'),
  ('paper_max_weekly_loss_pct',      '10'),
  ('paper_max_drawdown_pct',         '20'),
  ('paper_extraction_target_pct',    '50'),
  ('paper_correlated_family_cap',    '3'),
  ('demo_max_daily_loss_pct',        '4'),
  ('demo_max_weekly_loss_pct',       '8'),
  ('demo_max_drawdown_pct',          '15'),
  ('demo_extraction_target_pct',     '50'),
  ('demo_correlated_family_cap',     '3'),
  ('real_max_daily_loss_pct',        '3'),
  ('real_max_weekly_loss_pct',       '6'),
  ('real_max_drawdown_pct',          '12'),
  ('real_extraction_target_pct',     '50'),
  ('real_correlated_family_cap',     '3')
) AS defaults(key, value)
WHERE NOT EXISTS (
  SELECT 1 FROM platform_state ps WHERE ps.key = defaults.key
);

-- 2. FORCE SAFE-MODE THRESHOLDS (always enforce these on rebuild)
INSERT INTO platform_state (key, value) VALUES ('paper_min_composite_score', '60')
  ON CONFLICT (key) DO UPDATE SET value = '60', updated_at = NOW();
INSERT INTO platform_state (key, value) VALUES ('demo_min_composite_score',  '65')
  ON CONFLICT (key) DO UPDATE SET value = '65', updated_at = NOW();
INSERT INTO platform_state (key, value) VALUES ('real_min_composite_score',  '70')
  ON CONFLICT (key) DO UPDATE SET value = '70', updated_at = NOW();
INSERT INTO platform_state (key, value) VALUES ('signal_visibility_threshold', '50')
  ON CONFLICT (key) DO UPDATE SET value = LEAST(platform_state.value::numeric, 50)::text, updated_at = NOW();

-- 3. VERIFY key platform_state rows
SELECT key, value FROM platform_state
WHERE key IN (
  'kill_switch', 'paper_active', 'demo_active', 'real_active',
  'paper_min_composite_score', 'demo_min_composite_score', 'real_min_composite_score',
  'signal_visibility_threshold', 'paper_capital', 'paper_current_equity'
)
ORDER BY key;

-- 4. VERIFY market history is intact (returns counts; must be > 0 for live trading)
SELECT 'candles' AS tbl, COUNT(*) AS cnt FROM candles
UNION ALL SELECT 'ticks', COUNT(*) FROM ticks
UNION ALL SELECT 'spike_events', COUNT(*) FROM spike_events;

-- 5. VERIFY runtime tables (these should be empty on a fresh rebuild)
SELECT 'signal_log' AS tbl, COUNT(*) AS cnt FROM signal_log
UNION ALL SELECT 'trades', COUNT(*) FROM trades
UNION ALL SELECT 'backtest_runs', COUNT(*) FROM backtest_runs
UNION ALL SELECT 'backtest_trades', COUNT(*) FROM backtest_trades;
