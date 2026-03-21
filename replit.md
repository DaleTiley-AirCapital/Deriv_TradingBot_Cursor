# Deriv Capital Extraction App

## Overview

A quantitative trading research and execution platform for Deriv synthetic indices (Boom/Crash markets). Built as a pnpm workspace monorepo using TypeScript with a React frontend and Express backend. The app requires initial setup (data backfill + AI analysis) before use — gated by a setup wizard (`pages/setup.tsx`).

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
- `POST /api/setup/reset` — factory reset: clears all data (candles, backtests, trades, settings) except API keys, resets setup wizard

## Trading Modes

Three independent trading modes that can run simultaneously:
- **Paper** — Simulated trades with virtual capital (default $600, 16% equity/trade — highest risk for strategy testing)
- **Demo** — Trades on Deriv demo account (requires demo API token, 12% equity/trade — medium risk)
- **Real** — Trades on Deriv real account (requires real API token, confirmation needed, 8% equity/trade — most conservative)

Each mode has independent:
- Capital allocation (`paper_capital`, `demo_capital`, `real_capital`)
- Risk limits (daily/weekly loss, max drawdown per mode)
- Position sizing (equity %, max open trades per mode)
- Deriv API tokens (`deriv_api_token_demo`, `deriv_api_token_real`)
- State flags (`paper_mode_active`, `demo_mode_active`, `real_mode_active`)

Signals are generated once; positions are opened independently per active mode. All trades are tagged with their mode.

## Signal & ML Pipeline (Regime-First Architecture)

1. **Feature Engineering** (`lib/features.ts`): computes RSI(14), EMA slope/distance, ATR(14), Bollinger Band width/%B, candle body/wick ratios, z-score, rolling skew, consecutive candle count, spike hazard score, regime label from real candle data stored in PostgreSQL
2. **Regime Engine** (`lib/regimeEngine.ts`): 7 regime states (trend_up, trend_down, mean_reversion, compression, breakout_expansion, spike_zone, no_trade). Instrument family classification (boom, crash, volatility, other_synthetic). Strategy permission matrix: regime → allowed families. Macro bias computation (global score modifier).
3. **Probability Model** (`lib/model.ts`): per-family model routing with 4 weight sets (trend_continuation, mean_reversion, breakout_expansion, spike_event). Per-family rule configs. `scoreFeaturesForFamily()` for family-specific scoring.
4. **Strategy Engine** (`lib/strategies.ts`): 4 strategy families: Trend Continuation (trend-pullback), Mean Reversion (exhaustion-rebound, liquidity-sweep), Breakout/Expansion (volatility-breakout, volatility-expansion), Spike/Event (spike-hazard). Macro bias is a global score modifier (not a strategy). Regime gates which families run.
5. **Composite Scoring** (`lib/scoring.ts`): six-dimension scoring system (0–100 each): Regime Fit, Setup Quality, Trend Alignment, Volatility Condition, Reward/Risk, Probability of Success. Regime-aware with family-specific ideal regime/volatility lookup.
6. **Signal Router** (`lib/signalRouter.ts`): conflict resolution (no opposing trades, same-direction stacking only), multi-asset ranking by score/EV/regime confidence, tiered allocation (90+=25%, 85-89=20%, <85=reject), correlation limits (max 3 same-family), per-mode enabled strategy filtering.
7. **AI Signal Verification** (`lib/openai.ts`): GPT-4o strategy-family-aware verification (receives family, regime, entry stage, EV, macro bias context). Agree/disagree/uncertain verdicts. Disagree blocks trade, uncertain halves size.
8. **Signal Scheduler** (`lib/scheduler.ts`): regime-first scan flow: classifies regime → skips no_trade → runs allowed families only. Staggered symbol scanning. Position management every 10s. Monthly re-optimisation cycle (hourly check).
9. **Trade Engine** (`lib/tradeEngine.ts`): position building (probe→confirmation→momentum entries with escalating score thresholds: 85/88/92), profit harvesting (peak tracking, 30% drawdown-from-peak exit when peak≥3%, accelerated 60% threshold at peak≥8%), dynamic TP, trailing stop, 3-layer time exit, Deriv execution, capital tracking on close.
10. **Extraction Engine** (`lib/extractionEngine.ts`): capital cycle management (target→withdraw→reset), auto-extraction when target met, per-mode extraction cycles with configurable target %.

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

- **Position Building** — 3-stage entry: probe (0 existing, score≥85, 40% size), confirmation (1 existing, score≥88, 35% size), momentum (2 existing, score≥92, 25% size)
- **Position Sizing** — 8% of equity per trade (real, conservative), 12% (demo, medium), 16% (paper, aggressive testing). Max 3 simultaneous, 80% equity cap. Risk ladder: Paper=highest risk, Demo=medium, Real=most conservative
- **Dynamic TP** — calculated at entry using: confidence × ATR × historical average move
- **Trailing Stop** — SL trails 25% behind the highest point reached (configurable per mode)
- **Profit Harvesting** — peak tracking with drawdown-from-peak exit: 30% drawdown when peak≥3%, accelerated 60% threshold when peak≥8%
- **3-Layer Exit** — TP hit (Deriv handles), trailing stop triggered, time-based exit (72h with 24h extensions up to 5 days)
- **Capital Tracking** — realized PnL updates mode capital on close; feeds extraction cycle readiness
- **Deriv Execution** — buy/sell/close via WebSocket API, SL/TP placement, contract updates

## Capital Extraction Engine

- **Extraction Cycles** — target profit % (default 50%), auto-extract when reached, reset capital to cycle start
- **Per-mode Cycles** — each mode (paper/demo/real) has independent extraction cycle tracking
- **Auto-extraction** — configurable per mode, checks after every position management cycle

## Strategy Families (4)

- **Trend Continuation** (`trend-pullback`): trend continuation after mean reversion pullback
- **Mean Reversion** (`exhaustion-rebound`, `liquidity-sweep`): rebound after overstretched move, smart money sweep reversal
- **Breakout/Expansion** (`volatility-breakout`, `volatility-expansion`): expansion after Bollinger compression
- **Spike/Event** (`spike-hazard`): elevated spike probability detection for boom/crash instruments

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
