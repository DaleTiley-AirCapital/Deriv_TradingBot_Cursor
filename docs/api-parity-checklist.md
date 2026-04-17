# API Parity Checklist

This checklist compares implemented backend routes against `lib/api-spec/openapi.yaml`.

## Covered In OpenAPI

The following implemented route families are represented in OpenAPI:

- Health: `/healthz`
- Data: `/data/*` (except `/data/backfill` appears in spec but not implemented route)
- Backtest core: `/backtest/run`, `/backtest/results`, `/backtest/{id}`, `/backtest/{id}/analyse`, `/backtest/{id}/trades`, `/backtest/{id}/candles`
- Signals core: `/signals/latest`, `/signals/pending`
- Trade core: `/trade/*` mode/start/stop/open/positions/history
- Portfolio/risk core: `/portfolio/status`, `/portfolio/mode`, `/overview`, `/risk/status`, `/risk/kill-switch`
- Settings/account core: `/settings`, `/settings/api-key-status`, `/settings/ai-status`, `/settings/ai-optimise`, `/settings/ai-override`, `/account/*`

## Implemented But Missing From OpenAPI

### Backtest

- `POST /backtest/portfolio`
- `POST /backtest/v3/run`

### Signals

- `GET /signals/features/:symbol`
- `GET /signals/export`

### Settings

- `GET /settings/openai-health`
- `POST /settings/ai-apply-suggestion`
- `POST /settings/paper-reset`

### AI

- `POST /ai/chat`
- `POST /ai/index-context`
- `GET /ai/index-status`

### Setup

- `POST /setup/preflight`
- `GET /setup/status`
- `GET /setup/progress`
- `POST /setup/initialise`
- `POST /setup/reset`

### Research

- `GET /research/data-status`
- `POST /research/download-simulate`
- `POST /research/rerun-backtest`
- `POST /research/ai-chat`
- `GET /research/backtest-history`
- `POST /research/prune-data`
- `POST /research/ai-analyze`
- `POST /research/ai-analyze/background`
- `GET /research/ai-analyze/status`
- `POST /research/data-top-up`
- `POST /research/enrich`
- `POST /research/reconcile`
- `POST /research/strategy-ranking`
- `POST /research/clean-canonical`
- `GET /research/coverage-all`
- `POST /research/repair-interpolated`

### Calibration

- `POST /calibration/detect-moves/:symbol`
- `GET /calibration/moves/:symbol`
- `POST /calibration/run-passes/:symbol`
- `GET /calibration/run-status/:runId`
- `GET /calibration/runs/:symbol`
- `GET /calibration/aggregate/:symbol`
- `GET /calibration/profile/:symbol/:strategy`
- `GET /calibration/profile/:symbol/:moveType`
- `GET /calibration/profiles/:symbol`
- `GET /calibration/engine/:symbol`
- `GET /calibration/scoring/:symbol`
- `GET /calibration/health/:symbol`
- `GET /calibration/export/:symbol`
- `GET /calibration/latest-run/:symbol`

### Diagnostics and Version

- `GET /diagnostics/symbols`
- `POST /diagnostics/symbols/revalidate`
- `POST /diagnostics/symbols/:symbol/streaming`
- `GET /diagnostics/symbols/streaming-config`
- `GET /diagnostics/data-integrity`
- `GET /diagnostics/data-integrity/:symbol`
- `GET /diagnostics/data-integrity/:symbol/full`
- `GET /diagnostics/lifecycle`
- `POST /calibration/run` (diagnostics alias)
- `GET /calibration/report` (diagnostics alias)
- `GET /version`

### Behavior and Export

- `POST /behavior/profile`
- `POST /behavior/profile/:symbol`
- `POST /behavior/build/:symbol`
- `POST /behavior/profile/:symbol/:engine`
- `GET /behavior/profile/:symbol`
- `GET /behavior/profile/:symbol/:engine`
- `GET /behavior/export/:symbol`
- `GET /behavior/export/:symbol/:engine`
- `GET /behavior/events/:symbol`
- `GET /behavior/events/:symbol/:engine`
- `POST /behavior/persist/:symbol`
- `GET /export/range`
- `GET /export/precheck`
- `POST /export/research`

## In OpenAPI But Not Found In Current Route Definitions

- `POST /data/backfill`
- Models family:
  - `POST /models/features/build`
  - `POST /models/train`
  - `GET /models/latest`
  - `POST /models/score`

## Recommended Parity Actions

1. Add missing active endpoints to OpenAPI first (setup/research/calibration/diagnostics).
2. Mark deprecated or removed spec endpoints (`/data/backfill`, `/models/*`) with explicit status.
3. Regenerate typed client from updated OpenAPI.
4. Add a CI parity check that flags route additions not reflected in OpenAPI.
