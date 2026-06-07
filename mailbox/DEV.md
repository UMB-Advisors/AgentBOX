# Local Development

How to run the MailBOX appliance locally on a laptop without the Jetson hardware (STAQPRO-155).

The dev stack is a slimmed-down docker-compose that runs Postgres + n8n + Ollama (CPU-only) + Qdrant in containers. The Next.js dashboard runs from your host via `npm run dev` for hot-reload + better stack traces. Caddy / TLS are skipped — they're prod-only surface.

## One-time setup

```bash
# 1. Bring up the dev stack
cp .env.dev.example .env.dev
docker compose -f docker-compose.dev.yml --env-file .env.dev up -d

# 2. Apply schema migrations (one-shot)
docker compose -f docker-compose.dev.yml --env-file .env.dev \
  --profile migrate run --rm mailbox-migrate

# 3. (Optional) Seed sample drafts so the dashboard queue isn't empty
psql postgresql://mailbox:mailbox@localhost:5432/mailbox \
  -f scripts/seed-dev-data.sql

# 4. (Optional) Pull a small model for local Qwen3 testing.
#    The CPU image is slow — only pull if you actually need to exercise
#    the classify or draft paths locally. For most dashboard work, skip.
#    Use the non-thinking instruct variant: `qwen3:4b` (the bare tag) is a
#    moving alias that may point to a thinking-trained variant which emits
#    CoT scratchwork instead of clean drafts. See STAQPRO-330.
docker compose -f docker-compose.dev.yml --env-file .env.dev \
  exec ollama ollama pull qwen3:4b-instruct
```

## Running the dashboard

```bash
cd dashboard
cp .env.example .env.local
# Edit .env.local: POSTGRES_URL=postgresql://mailbox:mailbox@localhost:5432/mailbox
npm install
npm run dev
# → http://localhost:3001/dashboard/queue
```

Hot-reload works for both routes and components. The seed data shows up immediately.

## Common ports (host)

| Service | Port | URL |
|---------|------|-----|
| Postgres | 5432 | `postgresql://mailbox:mailbox@localhost:5432/mailbox` |
| n8n editor | 5678 | http://localhost:5678 (no basic_auth; dev only) |
| Ollama API | 11434 | http://localhost:11434 |
| Qdrant | 6333 | http://localhost:6333 |
| Dashboard | 3001 | http://localhost:3001/dashboard/queue (via `npm run dev`) |

## Importing the canonical n8n workflows

The n8n container starts empty. To load the production-canonical workflows:

```bash
SSH_HOST=local ./scripts/n8n-import-workflows.sh
```

After import, open the n8n editor at http://localhost:5678 and re-link credentials per `n8n/workflows/README.md`. Note: dev n8n won't have real Gmail OAuth credentials wired — use a test Gmail or accept that the Gmail nodes will fail in dev.

## Tear down

```bash
docker compose -f docker-compose.dev.yml --env-file .env.dev down            # stop, keep data
docker compose -f docker-compose.dev.yml --env-file .env.dev down -v         # stop + wipe volumes
```

## Dev vs prod compose

| Concern | Prod (`docker-compose.yml`) | Dev (`docker-compose.dev.yml`) |
|---------|----------------------------|-------------------------------|
| Stack name | `mailbox` | `mailbox-dev` (separate volumes) |
| Ollama image | `dustynv/ollama:0.18.4-r36.4-cu126-22.04` (Jetson GPU) | `ollama/ollama:latest` (CPU) |
| Postgres port | LAN-only (5432 via tailnet) | `localhost:5432` |
| n8n protocol | https via Caddy + Cloudflare DNS-01 | http on `localhost:5678` |
| Caddy / mailbox-dashboard | Yes | **No** — run dashboard from host |
| Encryption key | strict env requirement | dev fallback constant (insecure) |

Two separate compose stacks (different `name:` in each file) means dev and prod can coexist on the same machine without volume collisions, though you wouldn't usually run both.
