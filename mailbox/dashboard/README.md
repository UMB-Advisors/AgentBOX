# MailBox One Dashboard

Standalone Next.js dashboard for the MailBox One T2 appliance. Provides a
human-in-the-loop approval queue for LLM-generated email drafts and triggers
real Gmail sends via an n8n webhook on approve. Closes Phase 1 deliverable #6
(approval queue) and ships workflow #3 (send pipeline).

**Single user. LAN-only. No auth in v1.** Phase 1.5 adds auth.

---

## Architecture

```
Browser ─► Caddy (Cloudflare TLS) ─► mailbox-dashboard (Next.js, port 3001)
                                          │
                                          ├─ pg.Pool ──► Postgres (mailbox.drafts ⨝ mailbox.inbox_messages)
                                          │
                                          └─ fetch ──► n8n webhook (MailBOX-Send)
                                                            │
                                                            └─ Gmail Reply (existing OAuth credential)
```

- **Single-page queue** at `/queue`. Cards collapsed by default; expand to see
  full email + draft body. Approve / Edit / Reject per card.
- **Reads** pending + edited drafts from `mailbox.drafts` (joined with the
  original email row). Edited drafts stay in the queue until approved.
- **30s polling** brings in new drafts with a green-banner "N new drafts
  arrived" indicator.
- **Failed sends** appear in a red collapsible section above the queue with
  the error message and a Retry button.
- **Approve** marks the row `approved` and POSTs `{draft_id}` to
  `${N8N_WEBHOOK_URL}`. The n8n workflow loads the draft, sends a threaded
  Gmail Reply, and updates the row to `sent` (or `failed` with
  `error_message` if Gmail errored).
- **Aesthetic** matches the thUMBox cut sheet — dark only, IBM Plex Mono +
  Outfit + Source Serif 4, lucide-react icons used functionally only.
  Mobile-first (375px target), two-column layout at ≥1024px.

---

## Local Development

Requires a reachable Postgres with the `mailbox` schema. Either:

- Publish 5432 in the Jetson's compose (LAN-trusted networks only — Pitfall #9
  in the spec; remove before customer ship)
- Or SSH tunnel: `ssh -L 5432:localhost:5432 bob@192.168.1.45`

```bash
cp .env.example .env.local
# edit .env.local with your POSTGRES_URL and N8N_WEBHOOK_URL
npm install
npm run dev      # http://localhost:3001/queue
```

For local dev the basePath is empty (root-served). The production Docker
build bakes `BASE_PATH=/dashboard` so it serves under Caddy's `/dashboard`
prefix without a `handle_path` strip.

---

## Production Deployment

Lives in `/home/bob/mailbox/docker-compose.yml` as the `mailbox-dashboard`
service. Reachable at `https://mailbox.heronlabsinc.com/dashboard` via Caddy.

Full runbook: **[DEPLOY.md](./DEPLOY.md)** — clone-to-Jetson, import workflow,
add to compose, add to Caddyfile, build, start, verify.

n8n companion workflow: **[n8n-workflows/README.md](./n8n-workflows/README.md)**.

---

## Environment

See [`.env.example`](./.env.example). Required:

| Variable | Purpose |
|----------|---------|
| `POSTGRES_URL` | `postgresql://user:pass@host:5432/db` connecting to `mailbox` schema |
| `N8N_WEBHOOK_URL` | Where to POST `{draft_id}` on approve. Internal: `http://n8n:5678/webhook/mailbox-send`. |
| `PORT` | Defaults to 3001 |
| `NODE_ENV` | `production` in containers; `development` for local dev |
| `BASE_PATH` | Build-time only (Dockerfile sets it). Empty for local dev = root-served. |

---

## Scripts

- `npm run dev` — local dev on port 3001 (basePath empty unless `BASE_PATH` is set)
- `npm run build` — production build (used by Dockerfile; reads `BASE_PATH` env)
- `npm start` — production server (port 3001)
- `npm run typecheck` — TypeScript check, no emit

---

## Repo layout

```
.
├── app/                      Next.js App Router pages + API routes
│   ├── api/drafts/           GET (list / single), POST approve/edit/reject/retry
│   ├── queue/page.tsx        server component: fetches initial active+failed
│   ├── layout.tsx            font loading (Outfit / IBM Plex Mono / Source Serif 4)
│   ├── page.tsx              redirect to /queue
│   └── icon.svg              orange 'M1' favicon (auto-served by Next.js)
├── components/               client components: QueueClient, DraftCard,
│                             DraftDetail, EmailContext, ActionButtons,
│                             EditModal, FailedSends, NewDraftsBanner,
│                             ClassificationChip, TimeAgo, Toast, EmptyState
├── lib/
│   ├── db.ts                 pg.Pool singleton + normalizeDraftBody (BL-21 fix)
│   ├── queries.ts            shared listDrafts / getDraft helpers
│   ├── types.ts              Draft / InboxMessage / DraftWithMessage / DraftStatus
│   └── n8n.ts                triggerSendWebhook with 15s timeout
├── n8n-workflows/
│   ├── MailBOX-Send.json     webhook → load draft → IF → Gmail → mark sent/failed
│   └── README.md             import + smoke-test instructions
├── deploy/
│   ├── docker-compose.snippet.yml
│   └── Caddyfile.snippet
├── public/                   static assets (favicon-only for now)
├── .planning/                project artifacts (PROJECT, REQUIREMENTS, ROADMAP,
│                             STATE, spec sources). Tracked in git per
│                             config.json's commit_docs=true.
├── Dockerfile                multi-stage; builds ARM64 native on the Jetson
├── DEPLOY.md                 deployment runbook
└── README.md                 this file
```

---

## Pitfalls baked in (from spec build logs v0.1–v0.9)

| # | Pitfall | Where it's handled |
|---|---------|--------------------|
| 1 | n8n Postgres Execute Query comma-split | Mark Sent / Mark Failed use the `Update` operation; Load Draft uses `executeQuery` with the integer `draft_id` inlined via `{{ Number(...) }}` so no comma-replacement happens |
| 3 | No `latest` image tags | `node:20-alpine` (multi-arch, pinned major+minor) |
| 4 | Don't `await pool.connect()` per request | `lib/db.ts` exposes `getPool()` and uses `pool.query()` directly |
| 6 | LLM emits literal `\n` instead of newlines (BL-21) | `normalizeDraftBody` in `lib/db.ts` runs `.replace(/\\n/g, '\n')` on every draft on read |
| 7 | Don't swallow Gmail Send errors | n8n Gmail node uses `onError: continueErrorOutput`; populates `error_message`; dashboard surfaces failed rows in the red collapsible section with Retry |
| 8 | `mailbox.` schema prefix on all SQL | Every query qualifies tables as `mailbox.drafts` / `mailbox.inbox_messages` |
| 9 | Don't permanently publish Postgres 5432 | DEPLOY.md includes a hardening checklist confirming `postgres` and `n8n` services don't publish ports |
| 10 | Don't skip mobile testing | Layout uses `lg:` breakpoint at 1024px; cards stack on mobile, two-column on desktop |

---

## Out of scope (explicit, per spec)

- Authentication / user accounts (Phase 1.5)
- Sent history view (Phase 2)
- Classification log view (Phase 2)
- Persona / skill management UI (Phase 2)
- RAG context display (Phase 2 — deliverable #5)
- Multi-account support (Phase 2)
- Light mode toggle (never)
- Plugin manifest / optimus-bu integration (deferred refactor)
- WebSocket / SSE (polling sufficient for single user)
- Optimistic concurrency control (single user, low contention)
- Drag-and-drop reordering, custom keyboard shortcuts
- Subdomain (`dashboard.mailbox.heronlabsinc.com`) — using `/dashboard` prefix
  to avoid DNS changes; subdomain is a Phase 1.5 cleanup
