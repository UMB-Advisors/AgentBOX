# MailBox One Dashboard — Roadmap

> 8 phases — derived directly from the spec's 8 build milestones (`.planning/spec/mailbox-dashboard-build-spec-v0_1-2026-04-25.md` §Build Order). Phases run **strictly sequential** per spec ("Strict order — don't skip ahead. Test at each milestone.").

## Milestone: Phase 1 Approval Queue (v1)

| # | Phase | Goal | Requirements | Success Criteria | UI hint |
|---|-------|------|--------------|------------------|---------|
| 1 | Project skeleton | Next.js + deps + structure + dark theme + helpers in place; `npm run dev` renders. | DASH-01..10 | 4 | yes |
| 2 | Read-only API + page | `GET /api/drafts` returns DB rows; `/queue` lists them as basic cards. | API-01, UI-01 (basic) | 3 | yes |
| 3 | Card UI with expand | Cards render in dark Swiss-Modernism aesthetic, expand to show full context, mobile responsive at 375px. | UI-02, UI-03, UI-06, UI-09, UI-10, UI-11 | 4 | yes |
| 4 | Mutation routes + buttons | reject/edit/approve (no webhook) routes work; ActionButtons + EditModal wired with optimistic updates. | API-02, API-03 (DB only), API-04, API-05, UI-04, UI-05 | 4 | yes |
| 5 | n8n workflow + webhook | MailBOX-Send.json built; approve route fires webhook; real Gmail reply lands in test inbox. | WORK-01..08, API-03 (webhook fire), UI-03 (real send) | 3 | no |
| 6 | Live updates + retry | 30s polling refreshes queue with toast; Failed Sends section + Retry route work. | API-06, UI-07, UI-08, UI-12 | 3 | yes |
| 7 | Dockerize + deploy artifacts | Multi-stage Dockerfile builds on ARM64; compose entry + Caddy snippet ready; clone-to-deploy runbook produced. | DEPLOY-01..06 | 4 | no |
| 8 | README + final commit | README per spec template; final commit; spec acceptance criteria walked end-to-end. | DOC-01, DOC-02 | 2 | no |

---

## Phase Details

### Phase 1: Project skeleton

**Goal:** Next.js 14 (App Router, TS strict) + Tailwind + `pg` + `lucide-react` installed at repo root. Directory tree per spec. `lib/db.ts`, `lib/types.ts`, `lib/n8n.ts` written. Dark theme tokens in `globals.css` and `tailwind.config.ts`. `.env.example` populated. `/` redirects to `/queue` (stub OK).

**Requirements:** DASH-01, DASH-02, DASH-03, DASH-04, DASH-05, DASH-06, DASH-07, DASH-08, DASH-09, DASH-10

**Success Criteria:**
1. `npm run dev` starts without errors on port 3001
2. Browser shows the page (or `/queue` stub) at http://localhost:3001
3. `import { getPool } from '@/lib/db'` and types from `@/lib/types` typecheck
4. Dark theme tokens applied (background `#0a0a0a`, fonts loaded)

**UI hint:** yes

---

### Phase 2: First read-only API + page

**Goal:** End-to-end DB → API → page render. Visiting `/api/drafts` returns JSON with at least one row from live `mailbox.drafts`. `/queue` server-component-fetches and renders a basic list.

**Requirements:** API-01, UI-01 (basic version — no expand/style yet)

**Success Criteria:**
1. `GET /api/drafts` returns `{drafts: [...], total: N}` with at least one pending draft from live Postgres
2. `/queue` renders a list of cards with sender / subject / first line of draft body
3. No console errors

**UI hint:** yes

**External test required:** Operator runs `npm run dev` against Jetson Postgres and confirms data renders.

---

### Phase 3: Card UI with expand

**Goal:** `DraftCard` + `EmailContext` components built. Tap to expand. Empty state. Mobile responsive.

**Requirements:** UI-02, UI-03, UI-06, UI-09, UI-10, UI-11

**Success Criteria:**
1. Card collapsed shows sender (truncated), subject, time-ago, classification chip color-coded by confidence, draft preview
2. Tap → expands to full email context + full draft body
3. Mobile layout works at 375px (test in browser dev tools); desktop two-column at ≥1024px
4. Empty state appears when no pending drafts

**UI hint:** yes

---

### Phase 4: Mutation routes + buttons

**Goal:** Reject, edit, approve (without webhook trigger yet) all work. Buttons wired with optimistic updates.

**Requirements:** API-02, API-03 (status update only — no webhook fire yet), API-04, API-05, UI-04, UI-05

**Success Criteria:**
1. Reject button → `mailbox.drafts.status='rejected'` in DB, card removed from queue
2. Edit modal → save updates `draft_body` + `status='edited'` in DB
3. Approve button → `status='approved'` in DB (no email yet)
4. Buttons disabled during in-flight; errors surface as toast/inline message

**UI hint:** yes

**External test required:** Operator clicks buttons, verifies DB rows update.

---

### Phase 5: n8n workflow + webhook trigger

**Goal:** `MailBOX-Send.json` built and ready to import. Approve route now POSTs to `${N8N_WEBHOOK_URL}` with `{draft_id}`. End-to-end: approve a real draft → Gmail reply lands in inbox.

**Requirements:** WORK-01..08, API-03 (webhook fire), UI-03 (real send)

**Success Criteria:**
1. `MailBOX-Send.json` imports cleanly to n8n 1.123.35; webhook reachable via `curl http://localhost:5678/webhook/mailbox-send`
2. Approving a real pending draft results in real Gmail reply arriving (threaded correctly via `thread_id`)
3. `mailbox.drafts.status` transitions through `approved` → `sent`; if Gmail fails, `failed` with `error_message`

**UI hint:** no (workflow file + wiring)

**External test required:** Operator imports JSON into n8n UI, activates workflow, then approves a real draft from the dashboard.

---

### Phase 6: Live updates + failed retry

**Goal:** 30s polling brings new drafts in with a toast. Failed sends section + retry work.

**Requirements:** API-06, UI-07, UI-08, UI-12

**Success Criteria:**
1. New pending drafts appear within 30s without manual refresh; "X new drafts" toast shows
2. Failed Sends collapsible section appears when `status='failed'` rows exist; error message + Retry button visible
3. Retry button → status returns to `approved` → webhook fires → email sends (or refails cleanly)

**UI hint:** yes

---

### Phase 7: Dockerize + deploy artifacts

**Goal:** ARM64-friendly multi-stage Dockerfile. Compose service entry. Caddy snippet. Clone-to-Jetson runbook.

**Requirements:** DEPLOY-01..06

**Success Criteria:**
1. `docker build -t mailbox-dashboard .` succeeds locally (linux/arm64 if testable)
2. Compose entry + Caddy snippet supplied as ready-to-paste blocks in DEPLOY.md
3. DEPLOY.md walks through: clone the repo to `/home/bob/mailbox/dashboard`, edit compose, restart caddy, verify healthcheck
4. Dashboard reachable at `https://mailbox.heronlabsinc.com/dashboard` once operator runs runbook

**UI hint:** no

**External test required:** Operator clones the dir to the Jetson and follows DEPLOY.md.

---

### Phase 8: README + final commit

**Goal:** README finalized. Spec acceptance criteria walked end-to-end. Final commit.

**Requirements:** DOC-01, DOC-02

**Success Criteria:**
1. README sections (Architecture / Local Development / Production Deployment / Environment / Scripts) all present
2. All Acceptance Criteria checkboxes from spec confirmed (or noted with what blocked them)

**UI hint:** no

---

## Pitfalls Bound to Phases

From spec §Pitfalls (learned from build logs v0.1–v0.9):

| # | Pitfall | Bound to phase |
|---|---------|----------------|
| 1 | n8n Postgres Execute Query comma-split bug | Phase 5 (use Insert/Update operations) |
| 2 | n8n native LLM nodes lack base URL | N/A (no LLM calls from dashboard or workflow #3) |
| 3 | No `latest` image tags | Phase 7 (pin `node:20-alpine`) |
| 4 | Don't `await pool.connect()` per request | Phase 1 (`lib/db.ts` design) |
| 5 | n8n Schedule Trigger persistence quirk | N/A (workflow #3 is webhook-triggered) |
| 6 | LLM `\n` literal escape — defensive replace in `lib/db.ts` row mapper | Phase 1 |
| 7 | Don't catch Gmail Send errors silently — surface to UI | Phase 5 (workflow design) + Phase 6 (Failed Sends UI) |
| 8 | `mailbox.` schema prefix on all SQL | Every phase touching DB |
| 9 | Don't permanently publish Postgres 5432 in production | Phase 7 (deploy runbook clarifies dev-only) |
| 10 | Don't skip mobile testing at 375px | Phases 3, 6 |

---

*Last updated: 2026-04-25 at initialization*
