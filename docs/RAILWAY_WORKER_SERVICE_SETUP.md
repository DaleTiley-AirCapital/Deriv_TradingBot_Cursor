# Railway Worker Service Setup

## Goal

Run heavy research jobs in a separate Railway service so the main API app remains responsive for:

- UI requests
- market/tick processing
- light status/result reads

## Worker-ready task types

- `calibration_passes`
- `full_calibration`
- `elite_synthesis`
- `runtime_backtest`
- `parity_run`
- `runtime_trigger_validation`

## Main split

### API service

- service: `@workspace/api-server`
- responsibility:
  - enqueue worker jobs
  - read worker job status/results
  - serve UI/API traffic
  - never run long calibration, parity, validation, runtime-backtest, or elite-synthesis work in-process

### Worker service

- suggested service name: `worker-jobs`
- responsibility:
  - poll `worker_jobs`
  - atomically claim queued jobs
  - execute supported task handlers
  - persist heartbeat/progress/results

## Worker start command

```powershell
node ./artifacts/api-server/dist/worker.cjs
```

Why:
- the final Docker runtime image intentionally excludes `pnpm`
- the worker must start from the compiled server bundle, not the dev-time `tsx` entrypoint

## Required environment

Use the same shared database/application environment as the API service for:

- `DATABASE_URL`
- any shared app secrets required by the heavy task implementation

The worker service does not need a public URL.

## Recommended Railway service settings

- public networking: disabled
- instances: `1`
- restart policy: `on failure`
- healthcheck: optional for worker

## Verification steps

1. Deploy the API service with the worker-job routes enabled.
2. Create the new `worker-jobs` service from the same repo.
3. Set the worker start command.
4. Copy the same shared env vars used by the API service.
5. Start one worker-owned heavy task, for example:
   - `30-day fast` elite synthesis
   - `Run Full Calibration`
   - `Validate Runtime`
6. Confirm:
   - the API returns `202 queued`
   - `worker_jobs` row changes from `queued` to `running`
   - the Research page shows the active task card below service status
   - the main app remains responsive while the worker runs

## Railway agent task

Use this exact prompt with the Railway agent:

```text
Configure a new private worker service in the existing Railway project for the Forex-Bot-Deriv repo.

Requirements:
- Service name: worker-jobs
- Source: same repo and production environment as the API service
- No public URL
- Start command: node ./artifacts/api-server/dist/worker.cjs
- Use the same shared environment variables as the main API service, especially DATABASE_URL and any app secrets required by the API server heavy-task code
- Keep instance count at 1
- Restart on failure

After configuration, verify that:
- the service starts successfully
- it can connect to Postgres
- it stays running without requiring a PORT listener
- the main API service remains unchanged

Do not modify live trading settings or allocation.
Only configure the worker service.
```
