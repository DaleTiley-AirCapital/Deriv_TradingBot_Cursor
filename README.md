# Forex-Bot-Deriv

Deriv synthetic-indices symbol-service trading platform focused on promoted-runtime execution and portfolio-level capital allocation.

## Documentation Index

Start here for the current operating state and source-of-truth ownership:

- [Current Operating Policy](docs/current-operating-policy.md)
- [Operator Runbook](docs/operator-runbook.md)
- [API Parity Checklist](docs/api-parity-checklist.md)
- [Source Of Truth Ownership](docs/source-of-truth.md)
- [Documentation Guardrails](docs/docs-guardrails.md)

## Quick Architecture Summary

- Monorepo: pnpm workspace
- Frontend: React + Vite
- Backend: Express + TypeScript
- DB: PostgreSQL + Drizzle
- Current app line: V3.2 service-runtime workflow
- Live trading path: promoted symbol-service runtimes emit complete service candidates
- Allocator role: capital, exposure, drawdown, cascade timing, and mode gates only
- Active promoted/scanning services on codex-dev: `CRASH300`, `R_75`
- Registered service roadmap: `CRASH300`, `BOOM300`, `R_75`, `R_100`

## Fast Start (Local Docker)

1. Build image:
   - `docker build -t forex-bot-deriv-local .`
2. Run Postgres:
   - `docker run -d --name forex-bot-postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres -e POSTGRES_DB=forexbot -p 5432:5432 postgres:16`
3. Run app:
   - `docker run -d --name forex-bot-deriv-local -e PORT=8080 -e DATABASE_URL=postgresql://postgres:postgres@host.docker.internal:5432/forexbot -p 8080:8080 forex-bot-deriv-local`
4. Verify:
   - `http://localhost:8080/api/healthz`

See [Operator Runbook](docs/operator-runbook.md) for full details and troubleshooting.
