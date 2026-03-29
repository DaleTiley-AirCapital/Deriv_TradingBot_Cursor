# Deriv Capital Extraction App

## Overview

The Deriv Capital Extraction App is a quantitative trading research and execution platform designed for Deriv synthetic indices, specifically focusing on Boom and Crash markets. Its primary purpose is to automate and optimize trading strategies through a comprehensive system that includes data collection, backtesting, probability modeling, strategy execution, and sophisticated risk and capital management. The platform aims to identify profitable trading opportunities, manage risk effectively, and automate capital extraction.

## User Preferences

I want iterative development. Ask before making major changes. I prefer detailed explanations.

## System Architecture

The platform is built as a pnpm workspace monorepo using TypeScript, featuring a React frontend and an Express backend.

**Core Layers:**
1.  **Data Collector:** Handles tick ingestion, candle building, and spike event detection.
2.  **Backtesting Engine (V2):** A production-grade simulator mirroring live V2 logic — S/R + Fibonacci TP/SL, 30% profit-based trailing stop (safety net only), 72h profitable exit (capital efficiency), confidence-scaled position sizing, and portfolio-level equity management. Supports walk-forward testing and provides comprehensive metrics.
3.  **Probability Model:** Focuses on feature engineering and gradient boost scoring.
4.  **Strategy Engine (V2):** Five strategy families: trend_continuation (drift riding after confirmed reversal), mean_reversion (multi-day range extreme entries), spike_cluster_recovery (counter-trend after 3+ spike clusters in 4h), swing_exhaustion (multi-day rally/decline exhaustion at range extremes), trendline_breakout (dynamic trendline breaks with VWAP/pivot confluence).
5.  **Risk & Capital Manager:** Manages portfolio allocation, daily/weekly/max-drawdown limits, correlated family caps, and includes a kill switch mechanism.
6.  **Symbol Validator:** Validates configured symbols against Deriv active_symbols API at startup, refuses invalid subscriptions, and runs a stale-stream watchdog with auto-resubscription.

**UI/UX and Technical Implementations:**
-   **Frontend:** Developed with React, Vite, Tailwind CSS v4, shadcn/ui, and Recharts, providing a modern and responsive user interface.
-   **Backend:** Utilizes Express 5 for API services.
-   **Database:** PostgreSQL with Drizzle ORM for efficient data management.
-   **Validation:** Employs Zod (`zod/v4`) and `drizzle-zod`.
-   **API Codegen:** Uses Orval for generating API code from an OpenAPI specification.
-   **Build System:** esbuild is used for CJS bundle creation.
-   **Trading Modes:** Supports three independent trading modes (Paper, Demo, Real) which can run simultaneously, each with independent capital allocation, risk limits, position sizing, and Deriv API tokens.
-   **Signal & ML Pipeline (Regime-First Architecture):** A sophisticated pipeline that includes:
    -   **Feature Engineering:** Computes various technical indicators and regime labels.
    -   **Regime Engine:** Classifies market regimes and defines strategy permissions.
    -   **Scoring System (Empirical Big Move Readiness v2):** 5-dimension empirical readiness score (0-100): Range Position (25%), MA Deviation (20%), Volatility Profile (20%), Range Expansion (15%), Directional Confirmation (20%). Replaced logistic regression with rule-based scoring from observed preconditions of actual 50-200%+ moves.
    -   **Strategy Engine:** Implements five strategy families, gated by market regimes.
    -   **Signal Router:** Manages conflict resolution, multi-asset ranking, and tiered allocation.
    -   **AI Signal Verification:** GPT-4o powered verification of signals.
    -   **Signal Scheduler:** Manages staggered symbol scanning and position management.
    -   **Multi-Window Signal Confirmation:** Signals must be confirmed across 3 consecutive 30-minute windows before being promoted to execution. In-memory pending signal store (`pendingSignals.ts`) tracks confirmation progress per symbol/strategy/direction. Signals expire if gap > 90 minutes between confirmations. Pyramiding requires 3 additional windows + 1% price move in expected direction. Frontend shows pending signals with progress bars on the Decision Review page.
    -   **Pyramiding:** Up to 3 positions per symbol (up from 2). After Trade 1 confirmed, continue monitoring; if 3+ more windows confirm with price moved 1%+ in expected direction, open Trade 2/3. MAX_OPEN_TRADES raised to 6 (up from 3). Trades page groups pyramided positions by symbol with combined P&L.
    -   **Trade Engine (V2):** Full market move TP/SL. Boom/Crash: TP = 50% of 90-day longTermRangePct (min 10% of entry), targeting 50-200%+ full moves. Volatility: TP = 70% of major swing range from 1500+ candle window (min 2% of entry). SL = TP distance / 5 (fixed 1:5 R:R ratio) with 10% equity safety cap. No structural S/R-based SL, no ATR fallbacks ever. TP is PRIMARY exit; 30% trailing stop is SAFETY NET ONLY — activates only after trade reaches 30% of TP target (before that, only fixed SL protects). 72h profitable exit for capital efficiency — trades at a loss hold until TP, SL, or trailing stop. Composite thresholds: 85 (paper), 90 (demo), 92 (real). Strategy entry thresholds tightened per V2 Blueprint Section 3. Up to 3 positions per symbol (pyramided). See `V2_SPECIFICATION.md`.
    -   **Extraction Engine:** Manages capital cycles, targeting profit percentages for auto-extraction.
    -   **Symbol Diagnostics:** `/api/diagnostics/symbols` endpoint and Settings > Diagnostics tab show per-symbol stream health, validation status, tick counts, and errors.
-   **Database Schema:** Key tables include `ticks`, `candles`, `spike_events`, `features`, `model_runs`, `backtest_trades`, `backtest_runs`, `trades`, `signal_log`, and `platform_state`.

### CRITICAL DESIGN MANDATES — DO NOT VIOLATE
1. **TP is PRIMARY exit** targeting full spike magnitude (50-200%+). Trailing stop is SAFETY NET ONLY. NEVER dilute this to 0.01-0.3% targets.
2. **Never use ATR-based TP/SL exits.** All exits from market structure and spike magnitude analysis.
3. **72h profitable exit for capital efficiency** — close in-profit trades after 72 hours to redeploy capital. No forced closure of losing trades.
4. **Never compute structural indicators from only 100 one-minute candles.** Use 1500+ candles for structure, 100 for fast indicators.
5. **Use rolling 60-90 day windows** (not static all-time levels) for spike magnitude analysis.
6. **Boom/Crash and Volatility treated differently** — 50% of 90-day range TP for Boom/Crash, 70% major swing range TP for Volatility.

**Deployment:**
-   Recommended deployment via Railway, using `railway.toml` and a multi-stage `Dockerfile`.
-   Legacy Docker Compose deployments are supported for Docker and Synology NAS environments.

**Instrument Catalog (29 total, 12 data-download, 4 active-trading):**
- Active Trading (4): CRASH300, BOOM300, R_75, R_100
- Data Download (12): BOOM1000, CRASH1000, BOOM900, CRASH900, BOOM600, CRASH600, BOOM500, CRASH500, BOOM300, CRASH300, R_75, R_100
- Future catalog: R_10, R_25, R_50, RDBULL, RDBEAR, JD10-JD100, stpRNG, STP2-5, RDBR100, RDBR200

**API Keys:** deriv_api_token_demo, deriv_api_token_real, openai_api_key (legacy single deriv_api_token removed)

**Two-Layer Architecture:**
1. **Market Intelligence Layer** (always-on with stream): Scanner runs whenever streaming is active, producing signal decisions regardless of execution mode state. When no modes are active, decisions are logged with `executionStatus: "blocked"` and `rejectionReason: "No execution mode active — intelligence only"`.
2. **Execution Layer** (only with active modes): Trades are only placed when Paper, Demo, or Real mode is explicitly enabled.

**Symbol Mapping:** Some Deriv symbols use different API names (e.g., BOOM300 → BOOM300N). The `apiToConfiguredMap` on `DerivClient` handles bidirectional mapping. Collision detection prevents two configured symbols from mapping to the same API symbol.

**Auto-streaming:** Server auto-starts tick streaming on boot unless user explicitly stopped it. Paper mode is NOT auto-enabled on boot.

**System Modes:** `idle` (no stream), `scanning` (stream on, no execution modes), `paper`/`demo`/`live` (execution modes active).

**Startup Order (Railway/production):** DB init → Listen on PORT → Start scheduler → AI auto-config → Symbol validation → 12-month candle backfill (paginated, partial success ≥8/12) → Tick streaming → Health at /api/healthz

**Data Backfill:** On startup, auto-backfills 12 months of 1m and 5m candle history for all 12 symbols via paginated Deriv API calls (5,000 candles per page). Uses `onConflictDoNothing` so re-runs fill gaps without duplicating. Partial success model: proceeds if ≥8/12 symbols succeed; failed symbols shown with "Re-download from Research > Data Status". Data older than 12 months is automatically pruned.

**Research Page:** Overhauled with Data Status section (per-symbol health cards), Download & Simulate (SSE per-symbol), Re-run Backtest, grouped backtest results by symbol (only profitable strategies), and AI Chat per backtest. Routes in `artifacts/api-server/src/routes/research.ts`. Backtests now run 1 pass per symbol with all 5 strategies, storing strategyBreakdown in metricsJson.

**New FeatureVector Fields (V2):** `spikeCount4h`, `spikeCount24h`, `spikeCount7d` (rolling spike cluster counts), `priceChange24hPct`, `priceChange7dPct` (multi-day momentum), `distFromRange30dHighPct`, `distFromRange30dLowPct` (range position). Computed in both live features.ts (DB query) and backtestEngine.ts (candle approximation).

## External Dependencies

-   **Deriv:** For synthetic indices trading, market data, and account management via WebSocket API.
-   **PostgreSQL:** Primary database for persistent storage.
-   **OpenAI GPT-4o:** Used for AI-powered backtest analysis, signal verification, and the AI chatbot advisor.

## AI Chatbot System
The AI chatbot (`/api/ai/chat`) is a comprehensive trading advisor with:
- **Full system knowledge**: 12-section knowledge base covering all platform concepts, strategy families, signal pipeline, position sizing formulas, trade lifecycle, capital extraction, settings glossary, regime definitions, and technical glossary
- **Dynamic context injection**: Each conversation includes live system state (active modes, capital, recent performance, pending AI suggestions)
- **Trade analysis tool** (`analyze_trades`): Queries recent trades with 7 focus modes (overview, by_strategy, by_symbol, durations, tp_sl_effectiveness, recent_closed, open_positions)
- **Signal analysis tool** (`analyze_signals`): Queries signal logs with 5 focus modes (hit_rates, rejection_reasons, regime_distribution, score_distribution, by_symbol)
- **Suggestion writing** (`write_suggestions`): Writes ai_suggest_ keys only — never changes actual settings
- **Changelog section**: Tracks recent system changes so the AI stays current