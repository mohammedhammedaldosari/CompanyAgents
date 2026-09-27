# Base44 Dev Environment

## Stack
pnpm monorepo (Node 22, pnpm 10): `packages/domain` (shared TS), `apps/server` (Fastify + PostgreSQL + pg-boss), `apps/web` (Vite + three.js).

## Running
```bash
docker compose -f docker-compose.base44.yml up -d
```
- **db** — postgres:16-alpine (user `agents`, pw `agents_dev_pw`, db `agents`)
- **setup** — one-shot: `pnpm install` + builds `@agents/domain` (server/web import its `dist/`)
- **server** — `tsx watch` on :8080 (internal), runs migrations on boot
- **web** — `vite dev` on :5173, mapped to host **:3000**; proxies `/api` → `http://server:8080`

Single-origin wiring: the browser only talks to :3000; Vite proxies API calls to the server container. No CORS needed.

## Required env vars
- `DATABASE_URL` — set inline in compose (local postgres). Do not override.
- `MASTER_KEY` — required at boot (≥16 chars). A dev placeholder is auto-generated; replace via dashboard for real use.
- `OWNER_PASSWORD` — dev default `OwnerDevPass2026!` in `.env.base44-defaults` (set on first boot only; change via `pnpm --filter @agents/server cli set-password`).
- `ANTHROPIC_API_KEY` — optional at boot; without it the app runs but AI agent tasks fail with a clear message.

## Secrets
`.env.base44-defaults` holds dev placeholders (loaded first). `/run/base44/app.env` holds real secrets (loaded last, always wins). Never put user-supplied keys under compose `environment:`.

## Vite config
`apps/web/vite.config.js` reads `VITE_PROXY_TARGET` (defaults to `http://127.0.0.1:8080` for local dev). The compose file sets it to `http://server:8080`. `host: '0.0.0.0'` is set in the config for container binding. `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` is passed bare by the platform for Vite ≥6.1 host allowlisting.

## Verifying
```bash
curl -s http://localhost:3000/api/health   # through vite proxy → server
docker compose -f docker-compose.base44.yml logs server web
```
The preview shows the login screen; log in with the dev owner password.

## Notes
- The repo's own `docker-compose.yml` builds a production image (bakes source) — not used for dev.
- `packages/domain` must be built before server/web start (the `setup` service does this).
- The server's `dev` script uses `tsx watch` with `--env-file-if-exists=.env`; compose env vars are used when no `.env` exists.
