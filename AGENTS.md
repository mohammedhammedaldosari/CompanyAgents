# AGENTS.md — Base44 Development Notes

## Project Overview

شركة الوكلاء — AI agent platform managing Amazon Saudi Arabia trade. Monorepo with pnpm 10 / Node 22.

## Architecture

- `packages/domain` — shared TypeScript types, reference data, business rules. **Must be built before server and web can start** (both import `@agents/domain` which resolves to `dist/index.js` via the `exports` field).
- `apps/server` — Fastify + TypeScript + PostgreSQL + pg-boss. Runs on port 8080. Uses `tsx watch` for dev (live reload). Auto-runs SQL migrations on startup.
- `apps/web` — Vite + three.js. Runs on port 5173 (mapped to 3000 in Base44). Proxies `/api` to the server via `VITE_PROXY_TARGET` env var.

## Setup Order

1. PostgreSQL must be healthy
2. `setup` one-shot service: `pnpm install` → `pnpm --filter @agents/domain build` → `pnpm --filter @agents/server cli migrate` → `pnpm --filter @agents/server cli seed-demo`
3. `server` and `web` start after `setup` completes

## Required Environment Variables

- `DATABASE_URL` — wired inline in compose (local infra, not a secret)
- `MASTER_KEY` — min 16 chars, encrypts connector secrets at rest. Generated placeholder in `.env.base44-defaults`, overridden by `/run/base44/app.env`.
- `OWNER_PASSWORD` — optional but sets the owner login on first boot. Requirements: 12+ chars with 3+ character types (lowercase, uppercase, digits, symbols), or 20+ chars. Placeholder: `DevOwner2024!`
- `ANTHROPIC_API_KEY` — optional; server warns but runs without it. Agents fail without it; chat works from cached data only.

## Verification

- Health endpoint: `GET /api/health` → `{ ok: true, version, uptime, model }`
- Web entry: `http://localhost:3000` (Vite dev server)
- API proxied at `/api/*` through Vite

## Useful Commands

```bash
pnpm typecheck && pnpm lint && pnpm test      # tests need PostgreSQL (TEST_DATABASE_URL)
pnpm --filter @agents/server cli set-password  # change owner password
pnpm --filter @agents/server cli seed-demo     # add demo products + metrics
```

## Quirks

- The server's `dev` script uses `tsx watch --env-file-if-exists=.env` — the `.env` file is optional; compose env vars work without it.
- Vite config uses `allowedHosts: true` and `host: true` for Docker compatibility.
- The web app uses relative URLs (`/api/...`) with `credentials: 'same-origin'` — single-origin via Vite proxy.
- Cookie is `SameSite=Strict` (not `None`), which works because the web proxies API calls same-origin.
