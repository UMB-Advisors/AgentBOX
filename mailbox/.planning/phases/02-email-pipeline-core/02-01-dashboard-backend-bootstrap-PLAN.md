---
status: SUPERSEDED
superseded_by: 02-02-schema-foundation-PLAN-v2-2026-04-27.md (architectural pivot — see ADR in .planning/STATE.md)
supersession_date: 2026-04-27
plan_number: 02-01
slug: dashboard-backend-bootstrap
wave: 1
depends_on: []
autonomous: true
requirements: [APPR-01]
files_modified:
  - dashboard/Dockerfile
  - dashboard/.dockerignore
  - dashboard/package.json
  - dashboard/tsconfig.json
  - dashboard/drizzle.config.ts
  - dashboard/backend/src/index.ts
  - dashboard/backend/src/config.ts
  - dashboard/backend/src/db/client.ts
  - dashboard/backend/src/ws.ts
  - dashboard/backend/src/routes/health.ts
  - dashboard/public/index.html
  - docker-compose.yml
  - .env.example
---

<rescope_note>
**THIS PLAN IS SUPERSEDED. DO NOT EXECUTE.**

Plan 02-01 was originally scoped to bootstrap a separate Express + drizzle-orm
backend service alongside the dashboard UI. On 2026-04-27, after three-way
reconciliation of the Jetson appliance, the Ubuntu workstation, and the GitHub
repo, the project adopted Next.js 14 full-stack as the canonical dashboard
architecture (see ADR in .planning/STATE.md, "Architectural Decision Record:
Dashboard Stack Pivot").

The Phase 1 dashboard sub-project (`dashboard/.planning/`, completed 2026-04-25)
already shipped the API surface this plan was meant to scaffold — `app/api/drafts/*`
routes serving the live approval queue at
`https://mailbox.heronlabsinc.com/dashboard/queue`.

Schema foundation, types, and shared query helpers landed in plan 02-02-v2
(2026-04-27). See `02-02-schema-foundation-PLAN-v2-2026-04-27.md` and
`02-02-schema-foundation-SUMMARY.md` for what actually shipped.

This file is preserved as historical context for the rejected architectural
direction. Future re-scopes of plans 02-03..08 should reference 02-02-v2
patterns, not the Express patterns documented below.
</rescope_note>


<objective>
Replace the dashboard container's nginx-only placeholder with an Express 4 + drizzle-orm + ws backend running on Node 22 LTS, exposing an `/api/health` route and a WebSocket endpoint. This unblocks every subsequent Phase 2 plan that writes to or reads from Postgres or streams state to the dashboard. The Phase 2 UI stays a placeholder — Express also serves the minimal static HTML until Phase 4 swaps in React.
</objective>

<must_haves>
- `docker compose up -d dashboard` reaches `healthy` state within 30s
- `curl http://localhost:3000/api/health` returns HTTP 200 with JSON `{"status":"ok","db":"ok"}`
- WebSocket upgrade succeeds at `ws://localhost:3000/api/ws`
- Drizzle client can connect to `mailbox` schema from inside the dashboard container
- `drizzle-kit` CLI is installed and `npx drizzle-kit --version` exits 0 from inside the container
</must_haves>

<threat_model>
**ASVS L1, block on HIGH.**

| Surface | Threat | Mitigation | Severity |
|---------|--------|------------|----------|
| `.env` at repo root | Secrets checked into git | `.env` already in `.gitignore` from Phase 1; `.env.example` contains only keys not values | Medium → mitigated |
| DATABASE_URL in container env | Credential leak via `docker inspect` | Acceptable for single-tenant appliance; documented in SECURITY.md of container | Low |
| WebSocket endpoint | Unauthenticated LAN access | Phase 2 inherits Phase 1 LAN-only trust boundary (no auth); Phase 4 adds admin login (DASH-02) | Medium, deferred to Phase 4 |
| Health route leakage | Info disclosure via verbose errors | `/api/health` returns only `{status, db}` — no stack traces, no version strings | Low |
| Express body parser | DoS via large POST | `express.json({ limit: '1mb' })`; document upload route in later plan uses streaming | Low |

No HIGH-severity threats for this plan.
</threat_model>

<tasks>

<task id="1">
<action>
Create `dashboard/package.json` at the dashboard container root with Node 22 LTS engines field and the following dependencies pinned to the CLAUDE.md stack:

```json
{
  "name": "mailbox-dashboard",
  "version": "0.2.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/backend/src/index.js",
    "dev": "tsx watch backend/src/index.ts",
    "db:push": "drizzle-kit push",
    "db:generate": "drizzle-kit generate",
    "db:studio": "drizzle-kit studio"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.30.0",
    "@qdrant/js-client-rest": "^1.11.0",
    "dotenv": "^16.4.5",
    "drizzle-orm": "^0.31.0",
    "express": "^4.19.2",
    "pg": "^8.11.5",
    "ws": "^8.17.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^22.0.0",
    "@types/pg": "^8.11.5",
    "@types/ws": "^8.5.10",
    "drizzle-kit": "^0.22.0",
    "tsx": "^4.19.0",
    "typescript": "^5.5.4"
  }
}
```
</action>
<read_first>
  - dashboard/Dockerfile  (current: nginx-only, will be replaced)
  - CLAUDE.md  (stack pins)
  - .planning/phases/02-email-pipeline-core/02-CONTEXT.md  (integration points §code_context)
</read_first>
<acceptance_criteria>
- `dashboard/package.json` exists
- `grep '"express": "^4' dashboard/package.json` matches
- `grep '"drizzle-orm": "^0.31' dashboard/package.json` matches
- `grep '"drizzle-kit": "^0.22' dashboard/package.json` matches
- `grep '"ws": "^8' dashboard/package.json` matches
- `grep '"@qdrant/js-client-rest": "^1.11' dashboard/package.json` matches
- `grep '"node": ">=22"' dashboard/package.json` matches
</acceptance_criteria>
</task>

<task id="2">
<action>
Create `dashboard/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["backend/src/**/*.ts", "drizzle.config.ts"],
  "exclude": ["node_modules", "dist"]
}
```
</action>
<read_first>
  - dashboard/package.json  (just created — verify "type": "module" matches NodeNext)
</read_first>
<acceptance_criteria>
- `dashboard/tsconfig.json` exists
- `grep '"target": "ES2022"' dashboard/tsconfig.json` matches
- `grep '"module": "NodeNext"' dashboard/tsconfig.json` matches
- `grep '"strict": true' dashboard/tsconfig.json` matches
</acceptance_criteria>
</task>

<task id="3">
<action>
Create `dashboard/backend/src/config.ts` — reads and validates environment variables with zod. This loads `.env` from the repo root (mounted into the container) and exposes a typed `config` object:

```ts
import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

loadEnv({ path: process.env.ENV_FILE ?? '/app/.env' });

const schema = z.object({
  DATABASE_URL: z.string().url().or(z.string().regex(/^postgres(ql)?:\/\//)),
  POSTGRES_USER: z.string().min(1),
  POSTGRES_PASSWORD: z.string().min(1),
  POSTGRES_DB: z.string().min(1),
  DASHBOARD_PORT: z.coerce.number().int().positive().default(3000),
  ANTHROPIC_API_KEY: z.string().optional(),
  OLLAMA_URL: z.string().url().default('http://ollama:11434'),
  QDRANT_URL: z.string().url().default('http://qdrant:6333'),
  N8N_URL: z.string().url().default('http://n8n:5678'),
  ROUTING_LOCAL_CONFIDENCE_FLOOR: z.coerce.number().min(0).max(1).default(0.75),
  NODE_ENV: z.enum(['development', 'production']).default('production'),
});

export const config = schema.parse(process.env);
```
</action>
<read_first>
  - dashboard/tsconfig.json
  - .env.example  (current Phase 1 vars to preserve)
  - .planning/phases/02-email-pipeline-core/02-CONTEXT.md  (D-02 — ROUTING_LOCAL_CONFIDENCE_FLOOR=0.75)
</read_first>
<acceptance_criteria>
- `dashboard/backend/src/config.ts` exists
- `grep 'DATABASE_URL' dashboard/backend/src/config.ts` matches
- `grep 'ROUTING_LOCAL_CONFIDENCE_FLOOR' dashboard/backend/src/config.ts` matches
- `grep '.default(0.75)' dashboard/backend/src/config.ts` matches
- `grep 'z.string()' dashboard/backend/src/config.ts` matches (zod used)
</acceptance_criteria>
</task>

<task id="4">
<action>
Create `dashboard/backend/src/db/client.ts` — drizzle client factory with a node-postgres pool, using the `mailbox` schema as the default search path:

```ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { config } from '../config.js';

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on('connect', (client) => {
  client.query('SET search_path TO mailbox, public;').catch(() => {});
});

export const db = drizzle(pool);

export async function pingDb(): Promise<boolean> {
  try {
    const res = await pool.query('SELECT 1 as ok');
    return res.rows[0]?.ok === 1;
  } catch {
    return false;
  }
}
```
</action>
<read_first>
  - dashboard/backend/src/config.ts
  - .planning/phases/02-email-pipeline-core/02-CONTEXT.md  (D-18 — mailbox schema)
  - scripts/init-db/00-schemas.sql  (mailbox schema is created here)
</read_first>
<acceptance_criteria>
- `dashboard/backend/src/db/client.ts` exists
- `grep "from 'drizzle-orm/node-postgres'" dashboard/backend/src/db/client.ts` matches
- `grep "SET search_path TO mailbox" dashboard/backend/src/db/client.ts` matches
- `grep 'export const db' dashboard/backend/src/db/client.ts` matches
- `grep 'export async function pingDb' dashboard/backend/src/db/client.ts` matches
</acceptance_criteria>
</task>

<task id="5">
<action>
Create `dashboard/backend/src/routes/health.ts`:

```ts
import { Router } from 'express';
import { pingDb } from '../db/client.js';

export const healthRouter = Router();

healthRouter.get('/health', async (_req, res) => {
  const dbOk = await pingDb();
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? 'ok' : 'degraded',
    db: dbOk ? 'ok' : 'down',
    ts: new Date().toISOString(),
  });
});
```
</action>
<read_first>
  - dashboard/backend/src/db/client.ts
</read_first>
<acceptance_criteria>
- `dashboard/backend/src/routes/health.ts` exists
- `grep "healthRouter.get('/health'" dashboard/backend/src/routes/health.ts` matches
- `grep 'pingDb' dashboard/backend/src/routes/health.ts` matches
</acceptance_criteria>
</task>

<task id="6">
<action>
Create `dashboard/backend/src/ws.ts` — WebSocketServer attached to the existing HTTP server so the dashboard can push queue state in later plans:

```ts
import type { Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

const clients = new Set<WebSocket>();

export function attachWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/api/ws' });
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.send(JSON.stringify({ type: 'hello', ts: Date.now() }));
  });
  return wss;
}

export function broadcast(event: string, payload: unknown): void {
  const msg = JSON.stringify({ type: event, payload, ts: Date.now() });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}
```
</action>
<read_first>
  - dashboard/package.json  (ws ^8 pinned)
</read_first>
<acceptance_criteria>
- `dashboard/backend/src/ws.ts` exists
- `grep "path: '/api/ws'" dashboard/backend/src/ws.ts` matches
- `grep 'export function attachWebSocket' dashboard/backend/src/ws.ts` matches
- `grep 'export function broadcast' dashboard/backend/src/ws.ts` matches
</acceptance_criteria>
</task>

<task id="7">
<action>
Create `dashboard/backend/src/index.ts` — Express app wiring everything together. Serves `/api/*` routes, static placeholder HTML at `/`, and attaches the WebSocket server:

```ts
import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { config } from './config.js';
import { healthRouter } from './routes/health.js';
import { attachWebSocket } from './ws.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

app.use('/api', healthRouter);

app.use(express.static(path.resolve(process.cwd(), 'public')));

app.get('*', (_req, res) => {
  res.sendFile(path.resolve(process.cwd(), 'public', 'index.html'));
});

const server = createServer(app);
attachWebSocket(server);

server.listen(config.DASHBOARD_PORT, () => {
  console.log(`[dashboard] listening on :${config.DASHBOARD_PORT}`);
});

function shutdown() {
  console.log('[dashboard] shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```
</action>
<read_first>
  - dashboard/backend/src/routes/health.ts
  - dashboard/backend/src/ws.ts
  - dashboard/backend/src/config.ts
</read_first>
<acceptance_criteria>
- `dashboard/backend/src/index.ts` exists
- `grep "app.use('/api'" dashboard/backend/src/index.ts` matches
- `grep 'attachWebSocket(server)' dashboard/backend/src/index.ts` matches
- `grep "config.DASHBOARD_PORT" dashboard/backend/src/index.ts` matches
</acceptance_criteria>
</task>

<task id="8">
<action>
Create `dashboard/drizzle.config.ts` — drizzle-kit config pointing at the `mailbox` schema. Schema file path is `dashboard/backend/src/db/schema.ts` which Plan 02 will create; drizzle-kit tolerates a missing schema file at config-parse time but fails at push time, so this ordering is intentional:

```ts
import type { Config } from 'drizzle-kit';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: process.env.ENV_FILE ?? '/app/.env' });

export default {
  schema: './backend/src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  schemaFilter: ['mailbox'],
  strict: true,
  verbose: true,
} satisfies Config;
```
</action>
<read_first>
  - dashboard/package.json  (drizzle-kit ^0.22 pinned)
</read_first>
<acceptance_criteria>
- `dashboard/drizzle.config.ts` exists
- `grep "schemaFilter: \['mailbox'\]" dashboard/drizzle.config.ts` matches
- `grep "schema: './backend/src/db/schema.ts'" dashboard/drizzle.config.ts` matches
- `grep "dialect: 'postgresql'" dashboard/drizzle.config.ts` matches
</acceptance_criteria>
</task>

<task id="9">
<action>
Replace the nginx-based Dockerfile with a Node 22 LTS build. Multi-stage: build installs deps and compiles TS; runtime copies dist and node_modules/.prod and runs `node dist/backend/src/index.js`.

Overwrite `dashboard/Dockerfile` with:

```dockerfile
# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json drizzle.config.ts ./
COPY backend ./backend
COPY public ./public
RUN npx tsc -p tsconfig.json

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV DASHBOARD_PORT=3000
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/node_modules/drizzle-kit ./node_modules/drizzle-kit
COPY drizzle.config.ts ./
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --retries=3 --start-period=10s \
  CMD wget -qO- http://localhost:3000/api/health || exit 1
CMD ["node", "dist/backend/src/index.js"]
```

Also create `dashboard/.dockerignore`:

```
node_modules
dist
*.log
.git
.planning
*.md
```
</action>
<read_first>
  - dashboard/Dockerfile  (current nginx-based)
  - dashboard/package.json
</read_first>
<acceptance_criteria>
- `grep 'FROM node:22-alpine' dashboard/Dockerfile` matches twice (builder + runtime)
- `grep 'CMD \["node", "dist/backend/src/index.js"\]' dashboard/Dockerfile` matches
- `grep 'EXPOSE 3000' dashboard/Dockerfile` matches
- `grep 'HEALTHCHECK' dashboard/Dockerfile` matches
- `grep '/api/health' dashboard/Dockerfile` matches
- `dashboard/.dockerignore` exists and contains `node_modules`
</acceptance_criteria>
</task>

<task id="10">
<action>
Replace `dashboard/index.html` (currently at `dashboard/index.html`) with `dashboard/public/index.html` — minimal Phase 2 placeholder served by Express static middleware. Delete `dashboard/index.html` since the new Dockerfile copies `public/` not the root file:

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>MailBox One</title>
    <style>
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        background: #f5f5f5;
        color: #111;
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
        margin: 0;
      }
      .card {
        background: #fff;
        padding: 48px;
        border-radius: 8px;
        max-width: 480px;
      }
      h1 { margin: 0 0 16px; font-size: 28px; }
      p { margin: 0 0 8px; color: #444; }
      code { background: #f5f5f5; padding: 2px 6px; border-radius: 4px; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>MailBox One</h1>
      <p>Dashboard backend is running.</p>
      <p>Health: <code>GET /api/health</code></p>
      <p>Full UI arrives in Phase 4.</p>
    </div>
  </body>
</html>
```
</action>
<read_first>
  - dashboard/index.html  (current placeholder)
  - .planning/phases/02-email-pipeline-core/02-UI-SPEC.md  (color + type tokens)
</read_first>
<acceptance_criteria>
- `dashboard/public/index.html` exists
- `grep 'MailBox One' dashboard/public/index.html` matches
- `grep '/api/health' dashboard/public/index.html` matches
- `test ! -f dashboard/index.html`  (old one deleted)
</acceptance_criteria>
</task>

<task id="11">
<action>
Update `docker-compose.yml` `dashboard` service to:
1. Bind the host `.env` into the container at `/app/.env` (the `ENV_FILE` path used by config.ts and drizzle.config.ts).
2. Change the port mapping from `3000:80` to `3000:3000` (Express listens on 3000 inside the container, Dockerfile exposes 3000).
3. Replace the compose-level healthcheck to target `/api/health` instead of `/`.
4. Add `postgres` as a dependency (`condition: service_healthy`) since the backend needs the DB at startup.

Find the `dashboard:` block and replace it with:

```yaml
  dashboard:
    build: ./dashboard
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: "postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}"
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
      ENV_FILE: /app/.env
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
      ROUTING_LOCAL_CONFIDENCE_FLOOR: ${ROUTING_LOCAL_CONFIDENCE_FLOOR:-0.75}
      OLLAMA_URL: http://ollama:11434
      QDRANT_URL: http://qdrant:6333
      N8N_URL: http://n8n:5678
    volumes:
      - ./.env:/app/.env:ro
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:3000/api/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 20s
    depends_on:
      postgres:
        condition: service_healthy
      n8n:
        condition: service_healthy
    restart: unless-stopped
```
</action>
<read_first>
  - docker-compose.yml  (current dashboard stanza)
  - .planning/phases/02-email-pipeline-core/02-CONTEXT.md  (integration points)
</read_first>
<acceptance_criteria>
- `grep -A 30 'dashboard:' docker-compose.yml | grep '3000:3000'` matches
- `grep -A 30 'dashboard:' docker-compose.yml | grep 'DATABASE_URL'` matches
- `grep -A 30 'dashboard:' docker-compose.yml | grep '/api/health'` matches
- `grep -A 30 'dashboard:' docker-compose.yml | grep -- '- ./.env:/app/.env:ro'` matches
- `grep -A 30 'dashboard:' docker-compose.yml | grep -c 'condition: service_healthy'` returns at least 2
</acceptance_criteria>
</task>

<task id="12">
<action>
Update `.env.example` to document the new Phase 2 variables. Append (preserving any existing Phase 1 entries):

```bash
# --- Dashboard backend (Phase 2) ---
DASHBOARD_PORT=3000
# Composed at runtime by docker-compose dashboard service environment block:
# DATABASE_URL=postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}

# --- Classification routing (Phase 2, D-02) ---
ROUTING_LOCAL_CONFIDENCE_FLOOR=0.75

# --- Anthropic (Phase 2) ---
# Pooled Glue Co key — customer is billed at cost + 20%
ANTHROPIC_API_KEY=
```
</action>
<read_first>
  - .env.example  (preserve Phase 1 entries)
</read_first>
<acceptance_criteria>
- `grep '^DASHBOARD_PORT=3000' .env.example` matches
- `grep '^ROUTING_LOCAL_CONFIDENCE_FLOOR=0.75' .env.example` matches
- `grep '^ANTHROPIC_API_KEY=' .env.example` matches
</acceptance_criteria>
</task>

<task id="13">
<action>
Build and start the dashboard container, then verify it reaches `healthy`. This is the integration gate for the plan.

Commands (run sequentially):
```bash
docker compose build dashboard
docker compose up -d dashboard
# Wait up to 60s for healthcheck
for i in $(seq 1 12); do
  state=$(docker compose ps --format json dashboard | grep -o '"Health":"[^"]*"' || true)
  echo "[$i] $state"
  if echo "$state" | grep -q 'healthy'; then break; fi
  sleep 5
done
curl -fsS http://localhost:3000/api/health
```

Expected terminal output on success:
- `curl` exits 0 with JSON body containing `"status":"ok"` and `"db":"ok"`
- `docker compose ps dashboard` shows health `healthy`
</action>
<read_first>
  - docker-compose.yml  (just updated)
  - dashboard/Dockerfile  (just written)
</read_first>
<acceptance_criteria>
- `docker compose ps --format '{{.Service}} {{.Health}}' | grep '^dashboard healthy'` matches
- `curl -fsS http://localhost:3000/api/health | grep '"status":"ok"'` matches
- `curl -fsS http://localhost:3000/api/health | grep '"db":"ok"'` matches
- `docker compose exec -T dashboard npx drizzle-kit --version` exits 0
</acceptance_criteria>
</task>

</tasks>

<verification>
Post-plan verification (goal-backward check the gsd-verifier will run):

```bash
# 1. Health route returns OK with DB connectivity
curl -fsS http://localhost:3000/api/health | grep -q '"status":"ok"'
curl -fsS http://localhost:3000/api/health | grep -q '"db":"ok"'

# 2. WebSocket upgrade works
# (Use a minimal ws client — if websocat is available on the host)
# Otherwise: check via node one-liner in dashboard container:
docker compose exec -T dashboard node -e "
  import('ws').then(({ default: WebSocket }) => {
    const ws = new WebSocket('ws://localhost:3000/api/ws');
    ws.on('open', () => { console.log('OPEN'); ws.close(); });
    ws.on('error', (e) => { console.error('ERR', e.message); process.exit(1); });
  });
" 2>&1 | grep -q OPEN

# 3. Drizzle-kit is callable from inside container
docker compose exec -T dashboard npx drizzle-kit --version

# 4. Express is NOT nginx
docker compose exec -T dashboard sh -c 'ls -la /app/dist/backend/src/index.js'

# 5. Compose healthcheck hits the new route
docker compose ps --format '{{.Service}} {{.Health}}' | grep -q '^dashboard healthy'
```
</verification>
