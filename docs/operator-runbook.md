# Operator Runbook (Local Docker)

This runbook is for local operation of the full app stack.

## Prerequisites

- Docker Desktop running
- Ports available:
  - `8080` for app
  - `5432` for Postgres
- Repo root terminal at `Forex-Bot-Deriv`

## Build And Run

1. Create network:
   - `docker network create forex-bot-net`
2. Start Postgres:
   - `docker run -d --name forex-bot-postgres --network forex-bot-net -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres -e POSTGRES_DB=forexbot -p 5432:5432 postgres:16`
3. Build app image:
   - `docker build -t forex-bot-deriv-local .`
4. Start app:
   - `docker run -d --name forex-bot-deriv-local --network forex-bot-net -e PORT=8080 -e DATABASE_URL=postgresql://postgres:postgres@forex-bot-postgres:5432/forexbot -p 8080:8080 forex-bot-deriv-local`

## Dev Hot Reload (Option A)

Use the development compose stack for automatic refresh on code edits (API + frontend).

1. Start dev stack:
   - `docker compose -f docker-compose.dev.yml up -d`
2. Open app:
   - `http://localhost:5173/`
3. Stream logs (optional):
   - `docker compose -f docker-compose.dev.yml logs -f api web`

Notes:
- Backend runs `tsx` watch mode via `pnpm --filter @workspace/api-server run dev`
- Frontend runs Vite dev server via `pnpm --filter @workspace/deriv-quant run dev`
- Source code is bind-mounted, so edits trigger live reload automatically
- Dev stack ports: frontend `5173`, API `8081`, Postgres `5433`

## Health Checks

- App health:
  - `http://localhost:8080/api/healthz`
- Frontend:
  - `http://localhost:8080/`
- Container status:
  - `docker ps`

## Key Environment Variables

- `PORT` (required by API server)
- `DATABASE_URL` (required)
- Optional for AI features:
  - `openai_api_key` is usually stored in platform settings (not process env in normal flow)

## Common Issues

### App exits with DATABASE_URL error

- Ensure app container has `DATABASE_URL`.
- Ensure app and db are on same Docker network.

### OpenAI response limit errors

- Confirm server includes retry logic for output limit bumps in `artifacts/api-server/src/infrastructure/openai.ts`.
- If still frequent, tune request sizes and `max_completion_tokens` at route level.

### Port already in use

- Change host port mapping (for example `-p 8081:8080`) and use `http://localhost:8081`.

## Stop And Clean Up

- Stop/remove app and DB:
  - `docker rm -f forex-bot-deriv-local forex-bot-postgres`
- Remove network:
  - `docker network rm forex-bot-net`

For the dev stack:
- `docker compose -f docker-compose.dev.yml down`
