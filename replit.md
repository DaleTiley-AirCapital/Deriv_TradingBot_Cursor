# Deriv Quant Research & Execution Platform

## Overview

A quantitative trading research and execution platform for Deriv synthetic indices (Boom/Crash markets). Built as a pnpm workspace monorepo using TypeScript with a React frontend and Express backend.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **Frontend**: React + Vite + Tailwind CSS v4 + shadcn/ui + Recharts

## Platform Architecture

Five core layers:
1. **Data Collector** — tick ingestion, candle building, spike event detection
2. **Backtesting Engine** (`lib/backtestEngine.ts`) — production-grade candle-by-candle simulation using real strategy code (computeFeatures + runAllStrategies), trailing stop (50% lock-in), 3-layer time exit (72h/+24h/120h), confidence-scaled position sizing, concurrent position limits, portfolio-level shared equity, walk-forward testing, IS/OOS split, comprehensive metrics (gross P&L, drawdown duration, monthly returns, return by symbol/regime)
3. **Probability Model** — feature engineering + gradient boost scoring
4. **Strategy Engine** — 4 strategy families (trend pullback, exhaustion rebound, volatility breakout, spike hazard)
5. **Risk & Capital Manager** — portfolio allocation, daily/weekly limits, kill switch

## Structure

```text
artifacts-monorepo/
├── artifacts/
│   ├── api-server/         # Express API server
│   └── deriv-quant/        # React dashboard (preview path: /)
├── lib/
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   └── db/                 # Drizzle ORM schema + DB connection
└── scripts/                # Utility scripts
```

## Database Schema

- `ticks` — raw price ticks per symbol
- `candles` — OHLC candles at multiple timeframes
- `spike_events` — detected boom/crash spike events
- `features` — engineered feature vectors with regime labels
- `model_runs` — ML model training results and metrics
- `backtest_trades` — individual trade records per backtest run (entry/exit timestamps, prices, direction, P&L, exit reason)
- `backtest_runs` — backtesting results per strategy/symbol
- `trades` — paper and live trade records
- `signal_log` — all generated signals with allowed/rejected flags, AI verdict/reasoning/confidence adjustment
- `platform_state` — key-value store for platform configuration

## API Endpoints

- `GET /api/overview` — platform KPI summary
- `POST /api/data/backfill` — historical data collection (5000 ticks + 1000 candles per symbol)
- `POST /api/data/stream/start|stop` — live tick streaming with real-time spike detection
- `GET /api/data/status|ticks|candles|spikes` — market data
- `POST /api/models/features/build` — run feature engineering on stored candle data
- `POST /api/models/train` — train logistic regression on feature vectors
- `GET /api/models/latest` — model run history with accuracy/F1
- `POST /api/models/score` — score current features for a symbol
- `POST /api/backtest/run` — single-strategy backtest on full candle history with walk-forward support
- `POST /api/backtest/portfolio` — portfolio-level multi-symbol/multi-strategy backtest with shared equity
- `GET /api/backtest/results` — backtest result list with full metrics
- `GET /api/backtest/:id` — specific backtest detail (includes expanded metricsJson)
- `GET /api/backtest/:id/candles` — all candles for a backtest's symbol (no 600 limit)
- `POST /api/backtest/:id/analyse` — AI-powered backtest analysis (OpenAI GPT-4o)
- `GET /api/signals/latest` — logged signal history (allowed + rejected)
- `POST /api/signals/scan` — immediately run all 4 strategies on all symbols
- `GET /api/signals/features/:symbol` — live feature vector for a symbol
- `GET /api/signals/strategies/:symbol` — which strategies fire on a symbol right now
- `POST /api/trade/mode/toggle` — toggle trading mode (paper/demo/real) on/off independently
- `POST /api/trade/paper/start|live/start|stop` — legacy trading mode control (backward compat)
- `GET /api/trade/open|history` — trade management
- `GET /api/trade/positions` — live positions with floating P&L, time remaining, mode tag
- `GET /api/portfolio/status` — portfolio state
- `POST /api/portfolio/mode` — set allocation mode (conservative/balanced/aggressive)
- `GET /api/risk/status` — risk manager state
- `POST /api/risk/kill-switch` — emergency halt
- `GET /api/settings` — all configurable platform settings with defaults (includes masked API keys, trading mode, paper/live specific params)
- `POST /api/settings` — update one or more settings (validated, persisted to platform_state, supports API keys)
- `GET /api/settings/api-key-status` — check which API keys are configured
- `GET /api/account/info` — live Deriv account balance and connection status (auto-refreshes every 30s)
- `POST /api/account/set-mode` — switch trading mode (paper/live/idle) with confirmation for live (legacy)

## Trading Modes

Three independent trading modes that can run simultaneously:
- **Paper** — Simulated trades with virtual capital (default $10,000)
- **Demo** — Trades on Deriv demo account (requires demo API token)
- **Real** — Trades on Deriv real account (requires real API token, confirmation needed)

Each mode has independent:
- Capital allocation (`paper_capital`, `demo_capital`, `real_capital`)
- Risk limits (daily/weekly loss, max drawdown per mode)
- Position sizing (equity %, max open trades per mode)
- Deriv API tokens (`deriv_api_token_demo`, `deriv_api_token_real`)
- State flags (`paper_mode_active`, `demo_mode_active`, `real_mode_active`)

Signals are generated once; positions are opened independently per active mode. All trades are tagged with their mode.

## Signal & ML Pipeline

1. **Feature Engineering** (`lib/features.ts`): computes RSI(14), EMA slope/distance, ATR(14), Bollinger Band width/%B, candle body/wick ratios, z-score, rolling skew, consecutive candle count, spike hazard score, regime label from real candle data stored in PostgreSQL
2. **Probability Model** (`lib/model.ts`): logistic regression via SGD with 100 epochs, gradient-boost-style rule ensemble, per-symbol weight store, expected value estimation
3. **Strategy Engine** (`lib/strategies.ts`): seven strategies each with their own entry/exit conditions, SL/TP computation (ATR multiples), min score and min EV thresholds
4. **Composite Scoring** (`lib/scoring.ts`): six-dimension scoring system (0–100 each): Regime Fit, Setup Quality, Trend Alignment, Volatility Condition, Reward/Risk, Probability of Success. Combined into a weighted composite score (0–100). Configurable weights via Settings.
5. **Portfolio Signal Router** (`lib/signalRouter.ts`): composite score >= 85 threshold (configurable), EV > min threshold, R:R >= min ratio, kill-switch check, daily/weekly loss limit enforcement, 80% open risk cap, per-strategy disable, capital allocation (20-25% per trade), configurable equity % per trade, TP multipliers by composite score band (92+/85-92/<85), SL ratio
6. **AI Signal Verification** (`lib/openai.ts`): GPT-4o based signal pre-trade verification (agree/disagree/uncertain verdicts), backtest analysis with structured output; uses user's own OpenAI key from encrypted DB settings
7. **Signal Scheduler** (`lib/scheduler.ts`): configurable scan interval (default 30s, live-updates from settings), position management every 10s (trailing stop updates, time exits), opens positions on approved signals, optional AI verification gate (blocks on disagree, 50% size on uncertain)
8. **Trade Engine** (`lib/tradeEngine.ts`): position sizing, dynamic TP, trailing stop manager, 3-layer exit logic, Deriv execution integration

## Deployment

### Railway (recommended)
- `railway.toml` — build config (Dockerfile builder, health check, restart policy)
- `Dockerfile` — multi-stage build (Node 24, pnpm, builds frontend + API)
- `RAILWAY_DEPLOY.md` — step-by-step setup guide
- Railway provides PostgreSQL + auto-deploy from GitHub pushes
- PORT is provided dynamically by Railway at runtime

### Docker / Synology NAS (legacy)
- `docker-compose.nas.yml` — two services: `db` (Postgres 16), `app` (Express + built React SPA)
- `docker-compose.yml` — three services: `db`, `api`, `nginx`
- `SERVE_FRONTEND=true` makes Express serve the React SPA directly (no nginx needed)

## Symbols Supported

- BOOM1000, CRASH1000, BOOM500, CRASH500
- R_75 (Volatility 75), R_100 (Volatility 100), JD75 (Jump 75), STPIDX (Step Index), RDBEAR (Range Break 200)

## Trade Execution Engine

The platform includes a full swing trade execution engine (`lib/tradeEngine.ts`):

- **Position Sizing** — 20-25% of equity per trade, max 3 simultaneous trades, 80% equity cap
- **Dynamic TP** — calculated at entry using: confidence × ATR × historical average move
- **Trailing Stop** — SL trails 25% behind the highest point reached (configurable per mode, AI-optimized: Real=20%, Demo=25%)
- **3-Layer Exit** — TP hit (Deriv handles), trailing stop triggered, time-based exit (72h with 24h extensions up to 5 days)
- **Deriv Execution** — buy/sell/close via WebSocket API, SL/TP placement, contract updates

## Strategies

- `trend-pullback` — trend continuation after mean reversion
- `exhaustion-rebound` — mean reversion after overstretched move
- `volatility-breakout` — expansion after Bollinger compression
- `spike-hazard` — elevated spike probability detection

## Dashboard Pages

- **Overview** — live Deriv account balance panel, KPI cards, live positions table with floating P&L, portfolio status, Deriv API connection status, mode banner (PAPER TRADING / LIVE TRADING)
- **Research** — backtest runner, results table with full metrics, AI-powered backtest analysis (summary, what worked/didn't, suggestions)
- **Signals** — live signal feed, score/EV/regime flags, model scoring panel, AI verdict badges (agree/disagree/uncertain) with expandable reasoning
- **Trades** — live positions panel (entry/current price, floating P&L, SL, TP, time remaining), open/closed trades, P&L chart, paper/live controls
- **Risk** — risk limits, cooldowns, disabled strategies, kill switch
- **Data** — backfill, streaming, tick/candle/spike viewer
- **Settings** — 4-tab settings (General/Paper/Demo/Real), General tab: trading mode toggles, API keys, signal scoring thresholds (global), scan timing (global), kill switch. Mode tabs: per-mode TP/SL, trailing stop %, time exit, position sizing, risk controls, instruments, strategies. AI chat popup (floating GPT-4o assistant)

## Configuration

Set environment variables in `.env`:
- `DATABASE_URL` — PostgreSQL connection string (auto-provisioned by Replit)
- `LIVE_TRADING_ENABLED=true` — enable live trading mode (default: off)
- `PORT` — server port (auto-assigned)
- `Deriv_Api_Token` — Deriv API token (can also be set via Settings page, DB value takes priority)

API keys can be managed through the Settings page UI (stored encrypted in platform_state table) or via environment variables. DB-stored keys override env vars.

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`. The root `tsconfig.json` lists all packages as project references.

- **Always typecheck from the root**: `pnpm run typecheck`
- **Run codegen after spec changes**: `pnpm --filter @workspace/api-spec run codegen`
- **Push DB schema**: `pnpm --filter @workspace/db run push`
