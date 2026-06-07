# v1 Requirements — MailBox One Dashboard

> Source: `.planning/spec/mailbox-dashboard-build-spec-v0_1-2026-04-25.md`
> A requirement is "done" when its phase verifies it AND the matching spec Acceptance Criteria item passes.

---

## v1 Requirements

### Dashboard Foundation

- [ ] **DASH-01**: Next.js 14 (App Router, TypeScript strict) project scaffolded at repo root
- [ ] **DASH-02**: `pg`, `@types/pg`, `lucide-react`, Tailwind CSS installed and configured
- [ ] **DASH-03**: `lib/db.ts` exports a singleton `pg.Pool` (max 10, 30s idle, 5s connect timeout); never `await pool.connect()` per request (Pitfall #4)
- [ ] **DASH-04**: `lib/types.ts` exports `DraftStatus`, `Draft`, `InboxMessage`, `DraftWithMessage`
- [ ] **DASH-05**: `lib/n8n.ts` exports `triggerSendWebhook(draftId)` with 15s `AbortSignal.timeout`
- [ ] **DASH-06**: Defensive `body.replace(/\\n/g, '\n')` applied in row mapper before returning to UI (Pitfall #6 / BL-21 mitigation)
- [ ] **DASH-07**: Dark theme (`#0a0a0a` bg, `#171717` surface, `#262626` borders, `#e5e5e5` text; orange `#ff7a00`, green `#10b981`, red `#ef4444`, blue `#3b82f6` accents) configured globally; no light mode toggle
- [ ] **DASH-08**: IBM Plex Mono / Outfit / Source Serif 4 fonts loaded
- [ ] **DASH-09**: `/` server component redirects to `/queue`
- [ ] **DASH-10**: All SQL qualifies tables as `mailbox.drafts` / `mailbox.inbox_messages` (Pitfall #8)

### API Routes

- [ ] **API-01**: `GET /api/drafts?status=&limit=` returns `{drafts: DraftWithMessage[], total}` joined `mailbox.drafts` ⨝ `mailbox.inbox_messages`, ordered `created_at DESC`
- [ ] **API-02**: `GET /api/drafts/[id]` returns single `DraftWithMessage` or 404
- [ ] **API-03**: `POST /api/drafts/[id]/approve` updates status to `approved` (only from pending/edited/failed), POSTs to `N8N_WEBHOOK_URL` with `{draft_id}`. Returns 409 if already terminal. Does NOT roll back status on webhook failure (returns 502 with details for retry)
- [ ] **API-04**: `POST /api/drafts/[id]/edit` accepts `{draft_body, draft_subject?}`, validates body non-empty < 10000 chars, sets status `edited`, no webhook fire
- [ ] **API-05**: `POST /api/drafts/[id]/reject` accepts optional `{reason?}`, sets status `rejected` (terminal), stores reason in `error_message`
- [ ] **API-06**: `POST /api/drafts/[id]/retry` for failed drafts: resets status to `approved`, clears `error_message`, re-fires webhook

### UI

- [ ] **UI-01**: `/queue` lists pending drafts as cards in reverse-chronological order
- [ ] **UI-02**: Card collapsed view shows: sender (truncated), subject, time-ago, classification chip color-coded by confidence, first line of draft body
- [ ] **UI-03**: Tap to expand shows full email context (from/to/subject/received timestamp/body) and full draft body
- [ ] **UI-04**: Action buttons — Approve (orange primary, prominent), Edit (blue secondary), Reject (red destructive, lighter weight). Disabled during in-flight requests. Optimistic state updates.
- [ ] **UI-05**: Edit modal — full-screen takeover on mobile, modal on desktop; textarea pre-filled with current body; Save/Cancel
- [ ] **UI-06**: Empty state ("All caught up — no drafts waiting") with last-checked timestamp
- [ ] **UI-07**: Failed Sends collapsible section appears above queue when `status='failed'` rows exist; each shows error message + Retry button
- [ ] **UI-08**: 30-second polling refreshes list; new drafts fade in at top; toast/banner shows "X new drafts"
- [ ] **UI-09**: Mobile usable at 375px width (primary review surface — Pitfall #10)
- [ ] **UI-10**: Two-column layout at ≥1024px (cards left, expanded detail right)
- [ ] **UI-11**: Aesthetic matches thUMBox cut sheet: dark only, IBM Plex Mono + Outfit + Source Serif 4, lucide icons used functionally only, no decorative animations
- [ ] **UI-12**: No console errors in browser dev tools

### n8n Workflow #3 (MailBOX-Send)

- [ ] **WORK-01**: `MailBOX-Send.json` workflow file in repo at `n8n-workflows/`
- [ ] **WORK-02**: Webhook trigger at POST `/webhook/mailbox-send` accepts `{draft_id}`, response mode "Respond When Last Node Finishes"
- [ ] **WORK-03**: Postgres SELECT loads draft + email by id, validates `status IN ('approved', 'edited')`; IF node halts on 0 rows
- [ ] **WORK-04**: Gmail Reply node sends via existing OAuth credential, threading on `thread_id` + `message_id`, plain text, no attribution footer
- [ ] **WORK-05**: Postgres UPDATE marks status `sent`, clears `error_message`, sets `updated_at`. Uses Update operation, not Execute Query (Pitfalls #1 / DR-20)
- [ ] **WORK-06**: On Gmail Send error: per-node "Continue (using error output)" → Postgres Update sets status `failed`, populates `error_message`, sets `updated_at`
- [ ] **WORK-07**: Webhook returns `{success, draft_id, sent_at?}` or `{success: false, draft_id, error}`
- [ ] **WORK-08**: README documents how to import workflow into n8n

### Deployment

- [ ] **DEPLOY-01**: Multi-stage Dockerfile (deps → builder → runner) using `node:20-alpine` (no `latest` — Pitfall #3), `output: 'standalone'`, runs as non-root `nextjs:1001`
- [ ] **DEPLOY-02**: docker-compose service entry: `mailbox-dashboard`, build context, environment vars, depends_on postgres+n8n, healthcheck on `/queue`, `restart: unless-stopped`
- [ ] **DEPLOY-03**: Caddy `/dashboard/*` `reverse_proxy` to `mailbox-dashboard:3001`
- [ ] **DEPLOY-04**: Container builds and runs on ARM64 (Jetson) under existing compose network
- [ ] **DEPLOY-05**: Reachable at `https://mailbox.heronlabsinc.com/dashboard`
- [ ] **DEPLOY-06**: `DEPLOY.md` runbook covers clone-to-Jetson, build, start, healthcheck verification

### Documentation

- [ ] **DOC-01**: `README.md` per spec template (Architecture / Local Development / Production Deployment / Environment / Scripts)
- [ ] **DOC-02**: `.env.example` lists `POSTGRES_URL`, `N8N_WEBHOOK_URL`, `PORT`, `NODE_ENV`

---

## v2 / Phase 2 (Deferred)

- Sent history view
- Classification log view
- Persona/skill management UI
- RAG context display (deliverable #5)
- Multi-account support
- Auth / user accounts (Phase 1.5)
- Subdomain (`dashboard.mailbox.heronlabsinc.com`) Caddy entry instead of `/dashboard` path

## Out of Scope (Never v1)

- Light mode toggle — dark by design
- Plugin manifest / optimus-bu integration — deferred refactor
- WebSocket / SSE — polling sufficient
- Optimistic concurrency control — low contention
- Drag-and-drop reordering
- Custom keyboard shortcuts beyond browser defaults

## Traceability

| REQ-ID | Phase |
|--------|-------|
| DASH-01..10 | Phase 1 |
| API-01 | Phase 2 |
| UI-01 (basic) | Phase 2 |
| UI-02, UI-03, UI-06, UI-09, UI-10, UI-11 | Phase 3 |
| API-02, API-03 (DB only), API-04, API-05 | Phase 4 |
| UI-04, UI-05 | Phase 4 |
| WORK-01..08 | Phase 5 |
| API-03 (webhook fire), UI-03 (real send) | Phase 5 |
| API-06 | Phase 6 |
| UI-07, UI-08, UI-12 | Phase 6 |
| DEPLOY-01..06 | Phase 7 |
| DOC-01, DOC-02 | Phase 8 |
