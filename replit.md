# Deriv Capital Extraction App

## Overview

The Deriv Capital Extraction App is a quantitative trading research and execution platform designed for Deriv synthetic indices, specifically focusing on Boom and Crash markets. Its primary purpose is to automate and optimize trading strategies through a comprehensive system that includes data collection, backtesting, probability modeling, strategy execution, and sophisticated risk and capital management. The platform aims to identify profitable trading opportunities, manage risk effectively, and automate capital extraction.

## User Preferences

I want iterative development. Ask before making major changes. I prefer detailed explanations.

## System Architecture

The platform is built as a pnpm workspace monorepo using TypeScript, featuring a React frontend and an Express backend.

**Core Layers:**
1.  **Data Collector:** Handles tick ingestion, candle building, and spike event detection.
2.  **Backtesting Engine:** A production-grade simulator for strategies, including trailing stops, multi-layer time exits, confidence-scaled position sizing, and portfolio-level equity management. Supports walk-forward testing and provides comprehensive metrics.
3.  **Probability Model:** Focuses on feature engineering and gradient boost scoring.
4.  **Strategy Engine:** Incorporates four families of strategies (6 sub-strategies): trend pullback, exhaustion rebound, liquidity sweep, volatility breakout, volatility expansion, and spike hazard.
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
    -   **Probability Model:** Uses per-family models and scoring.
    -   **Strategy Engine:** Implements the four strategy families, gated by market regimes.
    -   **Composite Scoring:** A six-dimension scoring system (Regime Fit, Setup Quality, Trend Alignment, Volatility Condition, Reward/Risk, Probability of Success).
    -   **Signal Router:** Manages conflict resolution, multi-asset ranking, and tiered allocation.
    -   **AI Signal Verification:** GPT-4o powered verification of signals.
    -   **Signal Scheduler:** Manages staggered symbol scanning and position management.
    -   **Trade Engine:** Implements a 3-stage position building, dynamic TP, trailing stop, profit harvesting, and a 3-layer time exit mechanism.
    -   **Extraction Engine:** Manages capital cycles, targeting profit percentages for auto-extraction. All harvesting thresholds (peak drawdown exit, min peak profit, large peak threshold) are configurable per-mode via settings UI.
    -   **Symbol Diagnostics:** `/api/diagnostics/symbols` endpoint and Settings > Diagnostics tab show per-symbol stream health, validation status, tick counts, and errors.
-   **Database Schema:** Key tables include `ticks`, `candles`, `spike_events`, `features`, `model_runs`, `backtest_trades`, `backtest_runs`, `trades`, `signal_log`, and `platform_state`.

**Deployment:**
-   Recommended deployment via Railway, using `railway.toml` and a multi-stage `Dockerfile`.
-   Legacy Docker Compose deployments are supported for Docker and Synology NAS environments.

## External Dependencies

-   **Deriv:** For synthetic indices trading, market data, and account management via WebSocket API.
-   **PostgreSQL:** Primary database for persistent storage.
-   **OpenAI GPT-4o:** Used for AI-powered backtest analysis and signal verification.