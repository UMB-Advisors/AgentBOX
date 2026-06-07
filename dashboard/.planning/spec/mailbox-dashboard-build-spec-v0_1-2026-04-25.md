# MailBox One Dashboard — Build Specification

> **For:** Claude Code (GSD mode)
> **Author:** Dustin (UMB Group)
> **Date:** 2026-04-25
> **Estimated effort:** 4–6 hours focused work
> **Dependencies:** A working MailBox One T2 appliance (see "Existing State" below)

---

## Mission

Build a **standalone Next.js dashboard** for the MailBox One T2 appliance. The dashboard exposes a human-in-the-loop approval queue for LLM-generated email drafts and triggers a real Gmail send when drafts are approved. This closes Phase 1 of the MailBox One product roadmap (deliverable #6: dashboard approval queue + workflow #3: send pipeline).

**Single user, LAN-only, no auth.** This is the operator's own appliance; the threat model is "I trust everyone on my Wi-Fi." Auth comes in Phase 1.5.

---

## Existing State (don't re-build this)

The Jetson appliance at `192.168.1.45` already runs:

| Service | State | Notes |
|---------|-------|-------|
| Postgres 17-alpine | ✅ Healthy | Schema `mailbox` with two tables (see schema below) |
| Ollama + Qwen3-4B-ctx4k | ✅ Healthy | Local classification model |
| n8n 1.123.35 | ✅ Healthy + 2 workflows running | `MailBOX` (classify), `MailBOX-Drafts` (draft gen) |
| Qdrant 1.17 | ✅ Idle | Reserved for future RAG, not used in this build |
| Caddy + Cloudflare DNS | ✅ Healthy | TLS at `mailbox.heronlabsinc.com` |
| Gmail OAuth2 credential in n8n | ✅ Connected | Used by workflows #1 and #2 |

**You are adding two pieces:**

1. **`mailbox-dashboard`** — new Next.js app, runs as a 7th container in the existing Docker compose stack
2. **`MailBOX-Send`** — new n8n workflow #3, triggered via webhook from the dashboard

**Do not modify** the existing workflows, schema (additive only), or compose service definitions for any other container.

---

## Schema (already exists — DO NOT recreate)

```sql
-- Schema: mailbox
-- Already provisioned. Reference only.

CREATE TABLE mailbox.inbox_messages (
    id SERIAL PRIMARY KEY,
    message_id TEXT UNIQUE NOT NULL,
    thread_id TEXT,
    from_addr TEXT,
    to_addr TEXT,
    subject TEXT,
    received_at TIMESTAMPTZ,
    snippet TEXT,
    body TEXT,
    classification TEXT,
    confidence NUMERIC(4,3),
    classified_at TIMESTAMPTZ,
    model TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    draft_id INTEGER REFERENCES mailbox.drafts(id)
);

CREATE TABLE mailbox.drafts (
    id SERIAL PRIMARY KEY,
    inbox_message_id INTEGER NOT NULL 
      REFERENCES mailbox.inbox_messages(id) ON DELETE CASCADE,
    draft_subject TEXT,
    draft_body TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost_usd NUMERIC(10,6),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'approved', 'rejected', 'edited', 'sent', 'failed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    error_message TEXT
);
```

**Status lifecycle for drafts:**
- `pending` → human review needed (initial state)
- `approved` → user approved; webhook fires to send pipeline
- `edited` → user modified body before approval; same as `approved` for send purposes
- `rejected` → user said no; terminal state
- `sent` → Gmail delivery succeeded; terminal state
- `failed` → Gmail delivery failed; `error_message` populated; retry-able from UI

---

## Part 1: The Dashboard (Next.js app)

### Stack

- Next.js 14 (App Router)
- TypeScript (strict mode)
- Tailwind CSS for styling
- `pg` library for Postgres (no ORM)
- No auth, no client-side state library (React state is enough)
- `lucide-react` for icons (matches existing thUMBox aesthetic)

### Project name

`mailbox-dashboard`

### File structure

```
mailbox-dashboard/
├── package.json
├── next.config.js
├── tsconfig.json
├── tailwind.config.ts
├── postcss.config.js
├── Dockerfile
├── .env.local              # gitignored
├── .env.example
├── .gitignore
├── README.md
├── app/
│   ├── layout.tsx
│   ├── page.tsx            # redirect to /queue
│   ├── globals.css
│   ├── queue/
│   │   └── page.tsx        # main approval queue
│   └── api/
│       └── drafts/
│           ├── route.ts                       # GET list of pending drafts
│           ├── [id]/
│           │   ├── route.ts                   # GET single draft
│           │   ├── approve/route.ts           # POST approve + trigger send
│           │   ├── edit/route.ts              # POST edit body
│           │   ├── reject/route.ts            # POST reject
│           │   └── retry/route.ts             # POST retry on failed status
├── lib/
│   ├── db.ts               # pg.Pool singleton
│   ├── types.ts            # shared TypeScript types
│   └── n8n.ts              # webhook trigger helper
└── components/
    ├── DraftCard.tsx
    ├── EmailContext.tsx
    ├── ActionButtons.tsx
    ├── EditModal.tsx
    └── EmptyState.tsx
```

### Design aesthetic

Match the **thUMBox cut sheet** aesthetic — Swiss Modernism 2.0:

- **Dark mode by default.** No light mode toggle in v1.
- **Fonts:** IBM Plex Mono for code/data fields, Outfit for headings, Source Serif 4 for prose where appropriate.
- **Color palette:** Background `#0a0a0a` to `#111`, surface `#171717`, borders `#262626`, text `#e5e5e5`. Accents:
  - Orange `#ff7a00` for primary actions (Approve)
  - Green `#10b981` for success states
  - Red `#ef4444` for destructive actions (Reject)
  - Blue `#3b82f6` for informational/Edit
- **Density:** Information-dense but uncluttered. Generous line-height (1.5+), small but readable type (14px base).
- **Iconography:** Lucide-react. Use icons sparingly — never decorative, only functional.
- **No animations** beyond subtle hover states and fade-in for newly arrived drafts.
- **Mobile first.** Phone browser is primary review surface. Test at 375px width.

### Pages

#### `/` (root)

Server component. Redirects to `/queue` immediately.

#### `/queue`

The single primary surface. Shows all `status='pending'` drafts in reverse chronological order.

**Layout (mobile):**
- Header: "MailBox One" left, draft count chip right ("3 pending"), refresh button
- One draft per "card" stacked vertically
- Each card: collapsed by default showing summary (sender, subject, classification, confidence, draft preview), tap to expand
- Expanded card: full email body, full draft body, action buttons
- Bottom: "No more drafts" empty state when queue is empty

**Layout (desktop):**
- Same as mobile but two-column at ≥1024px: cards in left column, expanded detail in right column. Tapping a card opens detail without losing list context.

**Live updates:**
- Polls `/api/drafts` every 30 seconds for new pending drafts
- New drafts fade in at the top
- Show a small toast/banner when new drafts arrive ("2 new drafts")

**Failed drafts:**
- Drafts with `status='failed'` show in a separate collapsible "Failed sends" section above the queue
- Each shows the error message and a Retry button
- Retry resets status to `approved`, re-triggers the send webhook

### API Routes

All API routes are server-side and connect to Postgres via `lib/db.ts`'s pool.

#### `GET /api/drafts`

Lists drafts for the queue UI.

**Query params:**
- `status` (optional, default `pending`) — filter by status
- `limit` (optional, default 50)

**Returns:**
```typescript
{
  drafts: DraftWithMessage[];
  total: number;
}
```

**SQL (joined query):**
```sql
SELECT 
  d.*,
  json_build_object(
    'id', m.id,
    'message_id', m.message_id,
    'thread_id', m.thread_id,
    'from_addr', m.from_addr,
    'to_addr', m.to_addr,
    'subject', m.subject,
    'received_at', m.received_at,
    'snippet', m.snippet,
    'body', m.body,
    'classification', m.classification,
    'confidence', m.confidence,
    'classified_at', m.classified_at,
    'model', m.model,
    'created_at', m.created_at,
    'draft_id', m.draft_id
  ) AS message
FROM mailbox.drafts d
JOIN mailbox.inbox_messages m ON d.inbox_message_id = m.id
WHERE d.status = $1
ORDER BY d.created_at DESC
LIMIT $2;
```

#### `GET /api/drafts/[id]`

Single draft with its email context.

**Returns:** `DraftWithMessage` or 404.

#### `POST /api/drafts/[id]/approve`

Marks draft `status='approved'`, then triggers the n8n send webhook.

**Body:** none

**Logic:**
1. Update `mailbox.drafts SET status='approved', updated_at=now() WHERE id=$1 AND status IN ('pending', 'edited', 'failed')`
2. If 0 rows affected, return 409 (already in terminal state)
3. POST to `${N8N_WEBHOOK_URL}` with `{ draft_id }`
4. If webhook fails, do NOT roll back the status — log error and return 502 with details. The user can retry; status remains `approved` and webhook can be re-triggered.

**Returns:**
```typescript
{ success: boolean; draft_id: number; webhook_response?: any; error?: string }
```

#### `POST /api/drafts/[id]/edit`

Updates the draft body (and optionally subject), marks `status='edited'`. Does NOT trigger send — user must explicitly approve afterward.

**Body:**
```typescript
{ draft_body: string; draft_subject?: string }
```

**Logic:**
1. Validate `draft_body` is non-empty and < 10,000 chars
2. Update `mailbox.drafts SET draft_body=$1, draft_subject=$2, status='edited', updated_at=now() WHERE id=$3 AND status IN ('pending', 'edited')`
3. Return updated draft

**Returns:** `Draft` (updated)

#### `POST /api/drafts/[id]/reject`

Terminal state. Draft will not send.

**Body:** optional `{ reason?: string }` (stored in `error_message` for analytics later, even though not technically an error)

**Logic:**
1. Update `mailbox.drafts SET status='rejected', updated_at=now(), error_message=$2 WHERE id=$1 AND status IN ('pending', 'edited')`

**Returns:** `Draft` (updated)

#### `POST /api/drafts/[id]/retry`

For drafts in `failed` status. Resets to `approved` and re-triggers webhook.

**Logic:**
1. Update `mailbox.drafts SET status='approved', error_message=NULL, updated_at=now() WHERE id=$1 AND status='failed'`
2. POST to webhook same as approve

**Returns:** same as approve

### TypeScript types

```typescript
// lib/types.ts

export type DraftStatus = 
  | 'pending' 
  | 'approved' 
  | 'rejected' 
  | 'edited' 
  | 'sent' 
  | 'failed';

export interface Draft {
  id: number;
  inbox_message_id: number;
  draft_subject: string | null;
  draft_body: string;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: string | null;  // pg returns numeric as string
  status: DraftStatus;
  created_at: string;
  updated_at: string;
  error_message: string | null;
}

export interface InboxMessage {
  id: number;
  message_id: string;
  thread_id: string | null;
  from_addr: string | null;
  to_addr: string | null;
  subject: string | null;
  received_at: string | null;
  snippet: string | null;
  body: string | null;
  classification: string | null;
  confidence: string | null;  // pg returns numeric as string
  classified_at: string | null;
  model: string | null;
  created_at: string;
  draft_id: number | null;
}

export interface DraftWithMessage extends Draft {
  message: InboxMessage;
}
```

### Database connection helper

```typescript
// lib/db.ts
import { Pool } from 'pg';

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.POSTGRES_URL,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    
    pool.on('error', (err) => {
      console.error('Postgres pool error:', err);
    });
  }
  return pool;
}
```

### n8n webhook helper

```typescript
// lib/n8n.ts

export async function triggerSendWebhook(draftId: number): Promise<{
  success: boolean;
  response?: any;
  error?: string;
}> {
  const url = process.env.N8N_WEBHOOK_URL;
  if (!url) {
    return { success: false, error: 'N8N_WEBHOOK_URL not configured' };
  }
  
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft_id: draftId }),
      signal: AbortSignal.timeout(15000),
    });
    
    if (!res.ok) {
      return { 
        success: false, 
        error: `Webhook returned ${res.status}: ${await res.text()}` 
      };
    }
    
    return { success: true, response: await res.json() };
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Webhook call failed' 
    };
  }
}
```

### Component sketches

#### `DraftCard.tsx`

Props: `draft: DraftWithMessage`, `expanded: boolean`, `onToggle: () => void`, `onAction: (action: string, payload?: any) => Promise<void>`

Collapsed view:
- Sender (from_addr, truncated)
- Subject
- Time ago since received_at
- Classification chip (color-coded by confidence)
- First line of draft body

Expanded view:
- Full email context (EmailContext component)
- Full draft body (read-only or editable)
- Action buttons (ActionButtons component)

#### `EmailContext.tsx`

Props: `message: InboxMessage`

Shows the original email cleanly:
- From, To, Subject
- Received timestamp (relative + absolute)
- Body (rendered as plain text, preserving line breaks but not HTML)
- Classification with confidence percentage

#### `ActionButtons.tsx`

Props: `draft: Draft`, `onApprove: () => void`, `onEdit: () => void`, `onReject: () => void`

Three buttons. Approve is primary (orange, prominent). Edit is secondary (blue). Reject is destructive (red, lighter weight).

Disable all buttons during in-flight requests. Show optimistic state changes.

#### `EditModal.tsx`

Modal dialog. Textarea pre-filled with current draft body. Save / Cancel buttons.

Mobile: full screen takeover, not floating modal.

#### `EmptyState.tsx`

When queue is empty: friendly message + small illustration ("All caught up — no drafts waiting"). Show last-checked timestamp.

### Environment variables

```bash
# .env.example

# Postgres connection
POSTGRES_URL=postgresql://mailbox:mailbox@postgres:5432/mailbox

# n8n webhook URL for triggering MailBOX-Send workflow
# In dev, this points at the appliance directly
# In prod (containerized on appliance), points at internal n8n
N8N_WEBHOOK_URL=http://n8n:5678/webhook/mailbox-send

# App configuration  
PORT=3001
NODE_ENV=production
```

### Dockerfile

Multi-stage build, optimized for ARM64 (Jetson):

```dockerfile
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3001
ENV HOSTNAME="0.0.0.0"
CMD ["node", "server.js"]
```

In `next.config.js`, set `output: 'standalone'` to enable the standalone build.

### Compose integration

Add to `~/mailbox/docker-compose.yml`:

```yaml
  mailbox-dashboard:
    build: ./dashboard
    container_name: mailbox-dashboard
    restart: unless-stopped
    environment:
      POSTGRES_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
      N8N_WEBHOOK_URL: http://n8n:5678/webhook/mailbox-send
      NODE_ENV: production
    depends_on:
      postgres:
        condition: service_healthy
      n8n:
        condition: service_started
    networks:
      - default
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:3001/queue"]
      interval: 30s
      timeout: 10s
      retries: 3
```

### Caddy config update

Add to existing Caddyfile:

```
mailbox.heronlabsinc.com {
    # ... existing n8n routing ...
    
    # Dashboard at /dashboard prefix
    handle /dashboard/* {
        reverse_proxy mailbox-dashboard:3001
    }
    
    # Or as subdomain — recommended:
    # dashboard.mailbox.heronlabsinc.com {
    #     reverse_proxy mailbox-dashboard:3001
    # }
}
```

Use the prefix path for now since it requires no DNS changes. Subdomain is a Phase 1.5 cleanup.

### README requirements

```markdown
# MailBox One Dashboard

Standalone Next.js dashboard for the MailBox One T2 appliance. 
Provides human-in-the-loop approval queue for LLM-generated email drafts.

## Architecture

- Single-page approval queue at `/queue`
- Reads from existing `mailbox.drafts` Postgres table
- Triggers n8n `MailBOX-Send` workflow via webhook on approve

## Local Development

Requires Postgres reachable from dev machine. Either:
- Publish 5432 in the Jetson's compose (LAN-trusted networks only)
- Or use SSH port forwarding: `ssh -L 5432:localhost:5432 bob@192.168.1.45`

## Production Deployment

Lives in `~/mailbox/docker-compose.yml` as the `mailbox-dashboard` service.
Built via Caddy reverse proxy at `https://mailbox.heronlabsinc.com/dashboard`.

## Environment

See `.env.example`.

## Scripts

- `npm run dev` — local dev on port 3001
- `npm run build` — production build (used by Dockerfile)
- `npm start` — production server (used by Dockerfile)
```

---

## Part 2: n8n Workflow #3 (MailBOX-Send)

This is the workflow that takes an approved draft and actually sends it via Gmail.

### Trigger: Webhook

- **Type:** Webhook Trigger node
- **HTTP Method:** POST
- **Path:** `mailbox-send`  (full URL: `http://n8n:5678/webhook/mailbox-send` internal, `https://mailbox.heronlabsinc.com/webhook/mailbox-send` external)
- **Response Mode:** Respond When Last Node Finishes
- **Response Data:** First Entry JSON

Expected payload:
```json
{ "draft_id": 1 }
```

### Node 2: Postgres SELECT (Load Draft + Email)

Operation: Execute Query (no user content in params, so this is fine)

```sql
SELECT 
  d.id AS draft_id,
  d.draft_subject,
  d.draft_body,
  d.status,
  d.inbox_message_id,
  m.message_id,
  m.thread_id,
  m.from_addr,
  m.to_addr,
  m.subject AS original_subject
FROM mailbox.drafts d
JOIN mailbox.inbox_messages m ON d.inbox_message_id = m.id
WHERE d.id = $1
  AND d.status IN ('approved', 'edited');
```

Parameters:
```
={{ $json.body.draft_id }}
```

### Node 3: IF (Validate Loaded)

If 0 rows returned, draft was rejected, sent, or already in terminal state. Stop processing.

Condition: `{{ $('Load Draft').item.json.draft_id }}` exists

Continue branch only if validated.

### Node 4: Gmail Send Reply

Use Gmail node (action, not trigger):

- **Credential:** existing Gmail OAuth2
- **Resource:** Message
- **Operation:** Reply
- **Message ID:** `{{ $json.message_id }}` (the original email's Gmail message ID — Gmail's send-reply uses this to thread)
- **Email Type:** Text (plain text, not HTML)
- **Message:** `{{ $json.draft_body }}`
- **Options:**
  - Send Reply To: leave default (replies go to the sender of original)
  - Append Attribution: off (don't add "Sent via n8n" footer)
  - Thread ID: `{{ $json.thread_id }}` if available, else leave blank

### Node 5: Postgres UPDATE (Mark Sent)

Operation: Update

- Schema: `mailbox`
- Table: `drafts`
- Columns to Match On: `id`
- Match value: `{{ $('Load Draft').item.json.draft_id }}`
- Columns to Update:
  - `status`: `sent`
  - `updated_at`: `{{ $now.toISO() }}`
  - `error_message`: NULL (clear any prior error)

### Node 6: Error Handling Branch

Workflow Settings:
- Error Workflow: this same workflow's error branch

If Gmail Send fails (any non-2xx response or thrown error), the workflow needs to:

1. Update draft status to `failed`
2. Capture error message in `error_message`
3. Return error response to dashboard webhook

**Implementation:** Use n8n's per-node error handling. On the Gmail Send node, set "On Error" to "Continue (using error output)". Connect the error output to a Postgres Update node:

- Match On: `id` = `{{ $('Load Draft').item.json.draft_id }}`
- Update: `status='failed'`, `error_message={{ $json.error.message }}`, `updated_at={{ $now.toISO() }}`

### Node 7: Webhook Response

Returns to the dashboard:

```json
{
  "success": true,
  "draft_id": 1,
  "sent_at": "2026-04-25T..."
}
```

Or on error:
```json
{
  "success": false,
  "draft_id": 1,
  "error": "Gmail API rejected: ..."
}
```

### Workflow JSON

Save the final workflow as `MailBOX-Send.json` in the dashboard repo's `n8n-workflows/` directory for version control. Include in README how to import to n8n.

### Activation

Import to n8n via UI. Activate. Verify webhook is reachable:

```bash
curl -X POST http://localhost:5678/webhook/mailbox-send \
  -H "Content-Type: application/json" \
  -d '{"draft_id": 999999}'
```

Expected response (since draft 999999 doesn't exist): clean error response, no 500.

---

## Build Order

Strict order — don't skip ahead. Test at each milestone.

### Milestone 1: Project skeleton (~30 min)

1. `npx create-next-app@14 mailbox-dashboard` with TypeScript, Tailwind, App Router
2. `npm install pg @types/pg lucide-react`
3. Create directory structure (folders only, empty files)
4. Set up `lib/db.ts`, `lib/types.ts`, `lib/n8n.ts`
5. Configure `.env.local` with Postgres connection
6. Build dark theme in `globals.css` and `tailwind.config.ts`
7. Verify `npm run dev` works and renders the default Next.js page

**Test:** `npm run dev`, browser shows page, no errors.

### Milestone 2: First read-only API + page (~45 min)

1. Build `GET /api/drafts` route
2. Test in browser: visit `http://localhost:3001/api/drafts`, see JSON with one existing draft
3. Build `/queue/page.tsx` as a server component that fetches drafts and renders a basic list
4. Render minimal cards (no expand yet) showing sender, subject, draft preview

**Test:** `/queue` shows the existing draft from Postgres.

### Milestone 3: Card UI with expand (~60 min)

1. Build `DraftCard.tsx`, `EmailContext.tsx` components
2. Add expand/collapse state (client component, useState)
3. Style cards in Swiss Modernism dark aesthetic
4. Mobile responsive (test at 375px)
5. Add empty state when no drafts

**Test:** All UI states render cleanly. Tap to expand works on mobile.

### Milestone 4: Mutation routes + buttons (~90 min)

1. Build `POST /api/drafts/[id]/reject` first (simplest mutation)
2. Build `POST /api/drafts/[id]/edit`
3. Build `POST /api/drafts/[id]/approve` (without webhook trigger yet)
4. Build `ActionButtons.tsx` and `EditModal.tsx` components
5. Wire up button → API call → optimistic UI update
6. Handle errors gracefully (toast or inline message)

**Test:** Can reject a draft (status updates in DB). Can edit body (DB shows updated body, status='edited'). Can approve (status='approved' but no email sent yet).

### Milestone 5: n8n Workflow #3 + webhook trigger (~90 min)

1. Build `MailBOX-Send` workflow in n8n following spec above
2. Test webhook manually with curl
3. Add webhook trigger to `/api/drafts/[id]/approve` route via `lib/n8n.ts`
4. End-to-end test: send a fresh email to your own address with the `MailBOX-Test` label, wait for classify (5 min), manually update classification to `action_required` if needed, wait for draft generation (5 min), then approve via dashboard. **Real email should send.**

**Test:** Approving a draft results in an actual reply email arriving in your inbox.

### Milestone 6: Live updates + failed retry (~45 min)

1. Add 30-second polling in `/queue` page to refresh drafts list
2. Show "X new drafts" toast when new pending drafts arrive
3. Add `POST /api/drafts/[id]/retry` route for failed drafts
4. Add Failed Sends section above queue
5. Wire retry button

**Test:** New drafts appear automatically. If a send fails, retry works.

### Milestone 7: Dockerize + deploy to appliance (~60 min)

1. Configure `next.config.js` with `output: 'standalone'`
2. Write Dockerfile (multi-stage, optimized for ARM64)
3. Build locally first: `docker build -t mailbox-dashboard .`
4. Test the built image on dev box pointing at Jetson Postgres
5. Add service to Jetson's compose
6. Update Caddyfile with `/dashboard` reverse proxy
7. Deploy: `docker compose up -d mailbox-dashboard`
8. Test via `https://mailbox.heronlabsinc.com/dashboard`

**Test:** Dashboard accessible at production URL. Approve a real draft, real email sends.

### Milestone 8: README + commit (~15 min)

1. Write README following template above
2. Commit final state to git
3. Optional: push to GitHub under `consultingfuture4200`

---

## Acceptance Criteria

This build is complete when:

- [ ] `mailbox-dashboard` container runs healthy in compose
- [ ] `https://mailbox.heronlabsinc.com/dashboard` (or `/queue`) loads in browser
- [ ] Pending drafts from `mailbox.drafts` are visible
- [ ] Tapping a draft expands to show full email context + draft body
- [ ] Approve button → real email sent via Gmail → inbox_messages.draft_id set, drafts.status='sent'
- [ ] Edit button → modal opens with editable body → save updates DB with status='edited'
- [ ] Reject button → status='rejected', draft removed from queue
- [ ] Failed Sends section shows drafts with status='failed' and Retry works
- [ ] New pending drafts appear within 30 seconds without manual refresh
- [ ] Mobile UX is usable on phone browser at 375px width
- [ ] Dark mode aesthetic matches thUMBox cut sheet style
- [ ] No console errors in browser dev tools

## Out of Scope (do not build)

- Authentication / user accounts
- Sent history view (Phase 2)
- Classification log view (Phase 2)
- Persona/skill management UI (Phase 2)
- RAG context display (Phase 2)
- Multi-account support (Phase 2)
- Light mode toggle
- Plugin manifest / optimus-bu integration (deferred refactor)
- WebSocket / Server-Sent Events (polling is fine)
- Optimistic concurrency control (single user, low contention)
- Drag-and-drop reordering
- Keyboard shortcuts beyond browser defaults

---

## Pitfalls to Avoid (learned from build logs v0.1–v0.9)

1. **Don't use n8n's Postgres Execute Query for any text payload with commas.** Use Insert/Update operations. The Execute Query node parameter list is comma-split and breaks on email-body-style content.

2. **Don't use n8n's native LLM nodes for cloud APIs.** They lack base URL overrides. Use HTTP Request + Header Auth.

3. **Don't `latest` tag any image.** Pin every container to specific versions. Current pins: `n8nio/n8n:1.123.35`, `postgres:17-alpine`, `qdrant/qdrant:v1.17.1`.

4. **Don't `await pool.connect()` per-request.** The pool handles this. Just `pool.query(...)` directly.

5. **Don't trust n8n's UI Save for Schedule Trigger configs.** Verify the persisted JSON matches expectation. The `minutesInterval` field strips on save in 1.123.35.

6. **Don't store the raw `\n` as text.** When the LLM outputs `"\nDustin"` as a literal escape sequence (build log v0.9 BL-21), parse it as actual newline before storing. Use `body.replace(/\\n/g, '\n')` once on receipt.

7. **Don't catch all errors silently.** If Gmail Send fails, surface the error message both to logs and to the dashboard's Retry UI. Customer wants to know why an email didn't send.

8. **Don't forget the `mailbox.` schema prefix.** Tables live in `mailbox.drafts` and `mailbox.inbox_messages`, not `public.drafts`. n8n's Postgres node has a Schema field; for raw SQL queries, qualify the table name.

9. **Don't add `ports: ["5432:5432"]` permanently to Postgres.** It's fine for dev, but remove before customer ship. Postgres should be Docker-network-only in production.

10. **Don't skip mobile testing.** The phone browser is the primary review surface (FR-28). If it's awkward at 375px, it's broken.

---

## File Locations Reference

On the Jetson appliance:
- Compose file: `/home/bob/mailbox/docker-compose.yml`
- Env: `/home/bob/mailbox/.env`
- Caddy config: `/home/bob/mailbox/caddy/Caddyfile`
- Caddy Dockerfile: `/home/bob/mailbox/caddy/Dockerfile`
- Secrets file: `/home/bob/mailbox/secrets-2026-04-23.md`
- Backups: `/home/bob/mailbox/backups/`

The dashboard's repo location is the dev's choice (recommend `/home/bob/mailbox/dashboard/` on Jetson, or wherever the dev keeps code on their main box).

## Existing n8n Workflows (don't break these)

- **MailBOX** (id: ?): Schedule Trigger every 5 min → Gmail Get Many → Extract Fields → Classify (qwen3:4b-ctx4k) → Merge Classification → Postgres Insert with ON CONFLICT
- **MailBOX-Drafts** (id: ?): Schedule Trigger every 5 min → Postgres SELECT (action_required, draft_id IS NULL) → HTTP Request to NIM → Merge Draft → Postgres Insert → Postgres Update

Both are active and running on 5-minute cadences. The new MailBOX-Send workflow is webhook-triggered, not scheduled.

## Test Data Setup

To create a `pending` draft for dashboard testing, after deploying:

```bash
# 1. Send yourself a test email
# To: dustin@heronlabsinc.com
# Subject: [mailbox-test] dashboard test
# Body: Hey, can you confirm the meeting tomorrow at 2pm?

# 2. Apply MailBOX-Test label in Gmail manually

# 3. Wait 5-10 minutes for both workflows to fire

# 4. The classify workflow may classify as 'test' since it's labeled mailbox-test
#    Manually update to action_required to test the full flow:
sudo docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -c \
  "UPDATE mailbox.inbox_messages SET classification = 'action_required' WHERE subject LIKE '%dashboard test%';"

# 5. Wait another 5 min for MailBOX-Drafts to generate the draft

# 6. Now the dashboard's queue should show one pending draft

# 7. Approve via dashboard, watch real email arrive in your inbox
```

---

## Resources

- Build log v0.9: `mailbox-one-t2-build-log-v0_9-2026-04-25.md`
- Technical PRD: `thumbox-technical-prd-v2_1-2026-04-16.md`
- T2 Build Validation Addendum: `addendum-t2-build-validation-v0_1-2026-04-25.md`
- Cut sheet (for design aesthetic reference): deployed at `consultingfutures.com`

## Notes for the AI Builder

- **Read all referenced docs before starting.** The build log series and addendum capture hard-won lessons. Don't recreate solved problems.
- **Match the thUMBox cut sheet aesthetic.** Dark mode, IBM Plex Mono + Outfit + Source Serif 4. The dashboard should look like it's part of the same product line.
- **Default to simple.** No state libraries, no ORM, no auth. Single user, LAN, no premature optimization.
- **Test mobile at 375px width.** The phone is the primary surface.
- **Real email goes out on approve.** Be careful with the send button — confirmation modal is reasonable, but don't over-engineer. The user knows what Approve does.
- **If something seems weirdly hard, check the operational quirks register in the addendum (§8.6).** Half the friction in this build comes from known n8n/Postgres/etc. quirks.
- **Commit incrementally.** One commit per milestone. Makes rollback cheap.
