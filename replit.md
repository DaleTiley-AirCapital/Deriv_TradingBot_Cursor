# Deriv Trading - Long Hold V3

## Overview

Deriv Trading - Long Hold V3 is a quantitative trading research and execution platform for Deriv synthetic indices, focusing on Boom, Crash, and Volatility markets. Core mandate: **large capital, long hold, max profit** targeting 50-200%+ moves. The platform uses 8 symbol-native engines across 4 active symbols, a symbol coordinator, and a 3-stage hybrid trade manager. TP is the primary exit; ATR-proportional adaptive trailing stop is safety net ONLY. No time-based exits — trades hold 9-44 days.

## User Preferences

I want iterative development. Ask before making major changes. I prefer detailed explanations.

## System Architecture

The platform is built as a pnpm workspace monorepo using TypeScript, featuring a React frontend and an Express backend.

**Core Layers:**
1. **Data Collector:** Handles tick ingestion, candle building, and spike event detection.
2. **Backtesting Engine:** A production-grade simulator using S/R + Fibonacci TP/SL, 30% profit-based trailing stop (safety net only), no time-based exits, confidence-scaled position sizing, and portfolio-level equity management. Supports walk-forward testing.
3. **V3 Symbol-Native Engine System (LIVE):**
   - **8 engines**: `boom_expansion_engine` (BOOM300), `crash_expansion_engine` (CRASH300), `r75_continuation_engine`, `r75_reversal_engine`, `r75_breakout_engine` (R_75 × 3), `r100_continuation_engine`, `r100_reversal_engine`, `r100_breakout_engine` (R_100 × 3).
   - **Engine Registry** (`engineRegistry.ts`): maps each active symbol to its dedicated engine set. Loud failure on misconfiguration.
   - **Symbol Coordinator** (`symbolCoordinator.ts`): resolves conflicts when multiple R_75/R_100 engines fire simultaneously. Priority: breakout > continuation > reversal. Direction conflicts suppressed unless confidence gap ≥ 0.12.
   - **V3 Router** (`engineRouterV3.ts`): main live scan entry point. Calls engines, runs coordinator, returns `V3ScanResult` with features, regime, and `CoordinatorOutput`.
   - **Portfolio Allocator V3** (`portfolioAllocatorV3.ts`): engine-aware risk allocation (max open trades, daily loss, drawdown, position sizing).
   - **V3 Scheduler path**: `scanSingleSymbolV3()` in `scheduler.ts` calls `scanSymbolV3()` → `allocateV3Signal()` → AI verify (optional) → `openPositionV3()`.
   - **V3 Trade Engine** (`openPositionV3()` in `tradeEngine.ts`): opens positions using SR/Fib TP, adaptive SL, same broker execution infrastructure.
   - **3-Stage Hybrid Trade Manager** (`hybridTradeManager.ts`):
     - Stage 1 (entry): SL at original position.
     - Stage 2 (protection): SL promoted to breakeven at 20% of TP distance. Handled by `promoteBreakevenSls()` called before `manageOpenPositions()`.
     - Stage 3 (runner): adaptive trailing stop from 30% of TP. Handled by existing `manageOpenPositions()`.
4. **Risk & Capital Manager:** Manages portfolio allocation, daily/weekly/max-drawdown limits, correlated family caps, and includes a kill switch mechanism.
5. **Symbol Validator:** Validates configured symbols against Deriv active_symbols API at startup, refuses invalid subscriptions, and runs a stale-stream watchdog with auto-resubscription.

**Active Trading Symbols (4):**
- CRASH300 — `crash_expansion_engine` (PRIMARY)
- BOOM300 — `boom_expansion_engine` (PRIMARY)
- R_75 — `r75_reversal_engine`, `r75_continuation_engine`, `r75_breakout_engine` (coordinator resolves)
- R_100 — `r100_reversal_engine`, `r100_breakout_engine`, `r100_continuation_engine` (coordinator resolves)

**Mode Thresholds (current):**
- Paper: native score ≥ 60, Demo: native score ≥ 65, Real: native score ≥ 70
- Gates are enforced at startup via unconditional upsert and will be raised as engine calibration data accumulates.
- `signal_visibility_threshold`: 50 (startup upsert ensures existing environments are not locked at old 75 default)

**Native Scoring (all 4 symbols):**
Each engine computes a 6-component native score (0–100). `confidence = nativeScore / 100`. The mode threshold gates are enforced by `portfolioAllocatorV3.ts`. There is no shared V2 composite score path in the live system. `strategies.ts` / `signalRouter.ts` / `scoring.ts` are backtest-only.

**UI/UX and Technical Implementations:**
- **Frontend:** React, Vite, Tailwind CSS v4, shadcn/ui, Recharts. Active pages: Overview, Decisions, Trades, Research (AI Analysis + Backtest tabs), Data, Settings, Help, Diagnostics.
- **Backend:** Express 5 for API services.
- **Database:** PostgreSQL with Drizzle ORM.
- **Trading Modes:** Supports three independent trading modes (Paper, Demo, Real) which can run simultaneously, each with independent capital allocation, risk limits, position sizing, and Deriv API tokens.
- **Signal Pipeline:**
  - Feature Engineering: computes technical indicators and regime labels.
  - Regime Engine: classifies market regimes (informational — does not gate engine entry).
  - Native Engine Scoring: 6-component per-engine score replaces all generic composite scoring.
  - AI Signal Verification: GPT-4o powered verification of signals (optional).
  - Signal Scheduler: staggered symbol scanning and position management.
  - Multi-Window Signal Confirmation: signals must persist across 2 consecutive 60-minute evaluation windows before execution.
  - Pyramiding: up to 3 positions per symbol after multi-window confirmation.
- **Extraction Engine:** Manages capital cycles, targeting profit percentages for auto-extraction.
- **Symbol Diagnostics:** `/api/diagnostics/symbols` endpoint shows per-symbol stream health.

**Move-First Calibration System (Task #109A — completed):**
A move-first calibration pipeline that detects structural price moves from raw candle data (excluding interpolated rows), runs 4-pass AI analysis per move, and produces honest fit reports and feeddown schemas. Behavior model (signal-first) remains intact as secondary comparison layer.
- **Detected Moves** (`core/calibration/moveDetector.ts`): Threshold-based zigzag swing detector with structural context (lead-in shape, directional persistence, range expansion, spike count). Quality tiers A/B/C/D.
- **AI Passes** (`core/calibration/passes/`): 4 passes — precursor (pre-move conditions), trigger (earliest entry), behavior (move progression), extraction (cross-move rule distillation).
- **Pass Runner** (`core/calibration/calibrationPassRunner.ts`): Async, resumable, per-move error isolation, progress tracking.
- **Aggregator** (`core/calibration/calibrationAggregator.ts`): Honest fit reporting — targetMoves vs capturedMoves vs missedMoves, never inflated.
- **Feeddown Layer** (`core/calibration/feeddown.ts`): READ-ONLY accessors — getEngineCalibration, getScoringCalibration, getTradeHealthCalibration, getFullCalibrationExport. Not wired to live execution.
- **Routes** (`routes/calibration.ts`): 11 endpoints under `/api/calibration/*`.
- **DB Tables**: `detected_moves`, `move_precursor_passes`, `move_behavior_passes`, `strategy_calibration_profiles`, `calibration_pass_runs`.

**Database Schema:** Key tables: `ticks`, `candles`, `spike_events`, `features`, `model_runs`, `backtest_trades`, `backtest_runs`, `trades`, `signal_log`, `platform_state`, `behavior_events`, `detected_moves`, `move_precursor_passes`, `move_behavior_passes`, `strategy_calibration_profiles`, `calibration_pass_runs`.

### CRITICAL DESIGN MANDATES — DO NOT VIOLATE
1. **TP is PRIMARY exit** targeting full spike magnitude (50-200%+). Trailing stop is SAFETY NET ONLY. NEVER dilute this to 0.01-0.3% targets.
2. **Never use ATR-based TP/SL exits.** All exits from market structure and spike magnitude analysis.
3. **No time-based exits** — trades hold 9-44 days until TP, SL, or trailing stop.
4. **Never compute indicators on raw 1-minute candles.** Indicators use per-symbol HTF aggregation: CRASH300→12h, BOOM300→8h, R_75/R_100→4h via `aggregateCandles()`.
5. **Use rolling 60-90 day windows** for spike magnitude analysis.
6. **Boom/Crash and Volatility treated differently** — 50% of 90-day range TP for Boom/Crash, 70% major swing range TP for Volatility.
7. **Never introduce a shared generic scoring path** — all active engines use native 6-component scoring.

**Deployment:**
Deployed via Replit (current environment).

**Instrument Catalog (28 total, 3 tiers):**
- Active Trading (4): CRASH300, BOOM300, R_75, R_100 — scanned for signals, traded
- Data Streaming (12): BOOM1000, CRASH1000, BOOM900, CRASH900, BOOM600, CRASH600, BOOM500, CRASH500, BOOM300, CRASH300, R_75, R_100 — auto-streamed on startup
- Research Only (16): R_10, R_25, R_50, RDBULL, RDBEAR, JD10, JD25, JD50, JD75, JD100, stpRNG, stpRNG2, stpRNG3, stpRNG5, RB100, RB200 — manual download only

**API Keys:** deriv_api_token_demo, deriv_api_token_real, openai_api_key

**Two-Layer Architecture:**
1. **Market Intelligence Layer** (always-on with stream): Scanner runs whenever streaming is active, producing signal decisions regardless of execution mode state.
2. **Execution Layer** (only with active modes): Trades are only placed when Paper, Demo, or Real mode is explicitly enabled.

**Backtesting:** `strategies.ts`, `scoring.ts`, `signalRouter.ts` are BACKTEST-ONLY files used by `backtestEngine.ts` (runtimes/). They are not called in the live scan path. Do not add them to the live engine flow.
The Research → Backtest tab calls `POST /api/backtest/v3/run` and renders results in the frontend. Export to JSON is available for both summary and per-trade data.

**Scripts (`artifacts/api-server/scripts/`):**
- `v3-runtime-reset.sql` — purges runtime tables (signal_log, trades, backtest_*); safe to re-run
- `railway-rebuild.sql` — full platform_state seed for fresh Railway deploys; includes safe-mode threshold enforcement
