<!-- GSD:project-start source:PROJECT.md -->
## Project

> **⚠️ Status (2026-06-12, MBOX-469): the operator UI is the AgentBOX dashboard served by agentbox-sidecar, not `mailbox-dashboard`.** The operator UI = the AgentBOX dashboard served by **agentbox-sidecar** (`:9200`, tunnel `:9120`; repo `UMB-Advisors/agentbox-sidecar` — UI in `web/`, backend routes in the sidecar FastAPI app). `hermes-agent-main/.../web` is a **stale duplicate — never build there**. `mailbox-dashboard` (Next.js, `:3001`) is the **headless pipeline backend** behind the hermes reverse-proxy (`/dashboard/*` → `:3001`, the single agentbox2-v3 hermes patch — dies with the retirement endgame) — it serves n8n's `/api/internal/*` routes + proxied JSON; its operator-facing pages are retired. Don't rename the `mailbox-dashboard` docker service (load-bearing DNS in 8 n8n workflows). See `mailbox/dashboard/CLAUDE.md` and the `[STATE]` on MBOX-469.

**MailBox One — Email Agent Appliance**

Hardware appliance (Jetson Orin Nano Super 8 GB) that runs an AI email agent for small-business operators. Customer plugs in a box, connects Gmail, completes onboarding (industry / persona captured for classifier + drafter context), and gets an always-on assistant that triages, drafts, and (with approval) sends email responses. Sold as a managed product with white-glove onboarding.

**Active fleet:** M1 (Heron Labs) at `mailbox.heronlabsinc.com` is the **only live MailBOX appliance**. M2 (`mailbox.staqs.io`) was wiped 2026-05-22 for the MBOX-290 OpenClaw spike and is no longer a MailBOX target — see sibling repo `UMB-Advisors/thumbox-appliance` (locally: `~/thumbox-appliance`). Pending customer-#2 reinstatement on different hardware.

**Core value:** inbound operational email triaged + drafted + (with human approval) sent — without the operator spending 1–3 hrs/day on email. Tuned per-customer via persona overrides (`dashboard/lib/drafting/persona.ts` `PersonaContext`); no vertical lock-in.

### Constraints

- **Hardware**: 8 GB unified VRAM — local models limited to ~4B params quantized. NVMe 500 GB.
- **Power**: < 25 W sustained.
- **Latency**: inbound → draft in queue < 30 s local path, < 60 s cloud path.
- **Privacy**: all email content + KB stored on-appliance only. No bulk corpus to cloud.
- **API provider**: Anthropic Claude (pooled Glue Co key, billed cost + 20%) — plus Ollama Cloud `gpt-oss:120b` for default cloud draft.
- **Updates**: OTA via GHCR, customer-initiated only.
<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->
## Technology Stack (live)

| Tech | Version | Notes |
|---|---|---|
| Ollama | `ollama/ollama@sha256:<per-appliance digest>` | **Pin by digest in `.env`**, never `:latest` — `:latest` silently bumped M2 0.20.5 → 0.23.0 and triggered the Qwen3 thinking-mode regression (STAQPRO-240, `n8n/workflows/MailBOX-Classify.json` `think: false`). M1 digest live: `sha256:662109db...` (0.20.5). |
| Qdrant | 1.17.1 | Vector store. Collection `email_messages` (768d/Cosine). `MALLOC_CONF=narenas:1` workaround for ARM64 jemalloc issue #4298. |
| n8n | **2.14.2** | Workflow runtime. Upgraded from 1.123.35 (STAQPRO-181, supersedes DR-17). All 4 workflows must be `active=true` (gate: `mailbox-n8n-verify` profile). |
| Postgres | 17-alpine | Schema `mailbox`; also hosts n8n's `workflow_entity`. |
| Next.js 14 dashboard | App Router + Kysely | DR-24. Internal routes under `/api/internal/*`; CRUD under `/api/drafts/*`. ORM = **Kysely** (2026-05-01 ADR, supersedes Drizzle-as-MVP). |
| Caddy | 2.x | Cloudflare DNS-01 cert. `basic_auth` on **all paths** including `/webhook/*` per STAQPRO-161 (Pub/Sub push DR-22 KILLED 2026-04-30). |

### Models (live)

| Model | Tag | Purpose | Notes |
|---|---|---|---|
| Qwen3-4B (custom ctx) | `qwen3:4b-ctx4k` | Classifier + local drafter | Custom Modelfile `FROM qwen3:4b-instruct` + `num_ctx 4096` per DR-18. **Never `FROM qwen3:4b`** — that bare alias shifted to a thinking-trained variant 2026-05-05 and breaks LOCAL drafts (STAQPRO-330). |
| nomic-embed-text | `:v1.5` | RAG embeddings | 274 MB. |
| gpt-oss:120b | Ollama Cloud | Default cloud drafter | Per 2026-04-30 pivot superseding DR-23. Same `/api/chat` shape as local Ollama. |
| claude-haiku-4-5-20251001 | Anthropic | Alt-cloud fallback (config-ready) | Wired via `ANTHROPIC_API_KEY`; commented in `.env.example`. |

### Supporting libraries (dashboard)

| Lib | Version | Notes |
|---|---|---|
| `next` | 14.2.x | App Router. |
| `pg` | ^8.13 | Pool in `dashboard/lib/db.ts`. `setTypeParser(1184/1114)` keeps TIMESTAMP/TIMESTAMPTZ as strings; codegen `--type-mapping` preserves it across Kysely. |
| `kysely` | ^0.28.16 | Typed query surface; `DB` from `kysely-codegen` → `dashboard/lib/db/schema.ts`. `sql.raw` escape hatch where needed. |
| `kysely-codegen` | ^0.20.0 | Bootstraps temp postgres:17-alpine + applies `dashboard/test/fixtures/schema.sql`. CI drift gate: `npm run db:codegen:verify`. |
| Migrations | plain `.sql` | `dashboard/migrations/NNN-*.sql`, runner is `dashboard/migrations/runner.ts`. Compose: `--profile migrate`. |
| `zod` | ^4.4.1 | Schemas in `dashboard/lib/schemas/`; `parseJson(req, schema)` via `dashboard/lib/middleware/validate.ts` (STAQPRO-138). |
| `tailwindcss` | 4.x | CSS-first `@theme` in `dashboard/app/globals.css`; no `tailwind.config.ts`. Upgraded 2026-05-15 (STAQPRO-382). |
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

### Draft status state machine
`mailbox.drafts.status` lifecycle (live CHECK): `pending` → `awaiting_cloud` → (`approved` | `rejected` | `edited`) → `sent`. SoT = CHECK constraint in `dashboard/migrations/003-evolve-drafts-to-queue-shape-v1-2026-04-27.sql` (last narrowed by migration 016 / STAQPRO-202, dropped `'failed'`). Enum const lives in `dashboard/lib/types.ts` — do not redeclare string literals (STAQPRO-137 consolidates).

Send-side failures no longer flip status — Gmail Reply errors leave the row at `approved`; the StuckApproved UI surfaces it for operator-driven retry (5s arm window + "may have already sent — verify in Gmail Sent" warning).

**Audit log (STAQPRO-185, migration 009)**: every status change captured in `mailbox.state_transitions` (append-only) by `AFTER UPDATE OF status` trigger. Caller-supplied actor + reason via session GUCs `mailbox.actor` and `mailbox.transition_reason` — `dashboard/lib/transitions.ts:transitionToApprovedAndSend` sets `actor='operator'` + `reason=approve|retry`. Trigger is the SoT — do NOT add ad-hoc audit writes from app code.

**Persona resolver (STAQPRO-195)**: every draft reads `PersonaContext` from `mailbox.persona` via `dashboard/lib/drafting/persona.ts:getPersonaContext`. Three-layer fallback per field: operator override → extraction-derived → hardcoded Heron default.

**Idempotency lock (migration 025, 2026-05-22)**: `drafts.send_attempt_at` is CAS-acquired by `MailBOX-Send` pre-Gmail-Reply (`UPDATE … WHERE send_attempt_at IS NULL RETURNING id`); Lock-not-acquired branch returns HTTP 409 ("verify in Gmail Sent, clear `send_attempt_at` to retry"). Mark Sent clears it on success. Smoke: `scripts/smoke-send-lock.sh`.

### `inbox_messages` denormalization
`mailbox.inbox_messages.{classification, confidence, classified_at, model, draft_id}` are kept in sync by two `AFTER INSERT` triggers (migration 021, STAQPRO-244):
- `trg_sync_inbox_from_classification_log` — latest log row wins
- `trg_sync_inbox_draft_id` — most recent draft id wins

`mailbox.classification_log` remains source of truth; `Classify lag` health stat reads from there via LEFT JOIN, so it's drift-immune.

### `rag_context_refs` semantics (STAQPRO-191/192)
Both `drafts.rag_context_refs` and `sent_history.rag_context_refs` are `jsonb DEFAULT '[]'`. Store Qdrant point UUIDs (RFC 4122 v4, deterministic from `sha256(message_id)` per `dashboard/lib/rag/qdrant.ts:pointIdFromMessageId`). Empty array → one of: `cloud_gated`, `embed_unavailable`, `qdrant_unavailable`, `no_hits`. Reason persists alongside refs in `drafts.rag_retrieval_reason`. **Do NOT mutate after the trigger fires** — these are point-in-time snapshots.

### Route handler pattern
App Router contract: export named `GET`/`POST`/`PATCH` accepting `(request, { params })`. Internal routes (`/api/internal/*`) are not basic_auth gated — they're called from n8n inside the docker network. Validate via `parseJson(req, schema)` per STAQPRO-138.

### SQL convention
Hand-rolled SQL via Kysely (`getKysely()`) or `pg.Pool` (`getPool()`). Named helpers in `dashboard/lib/queries*.ts` preferred over inline; promote to a helper when used by 2+ routes. Always parameterize.

### Urgency engine + VIP senders (MBOX-134, migration 028)
Rule SoT = `dashboard/lib/urgency.ts:evaluateUrgency`. Signals: **escalate**, **vip** (matches `mailbox.vip_senders`), **aged** (per-category threshold), **low_conf** (`< 0.75` or NULL). Display order: `URGENCY_SIGNALS` in `dashboard/lib/types.ts`.

- Thresholds in ENV (`URGENCY_AGE_HOURS_<CATEGORY>`) — bad value falls back to default; defaults: 4h inquiry/reorder, 24h follow_up, 1h escalate.
- No N+1: `getQueueWithUrgency()` computes all signals set-wise in SQL; `countUrgentDrafts()` is one COUNT.
- `mailbox.vip_senders` — exact-email or domain-suffix match, **no regex**. Stored lowercased; unique on `(email_or_domain, kind)` (idempotent upsert).

### Comment standard (migrations)
Every migration opens with a 2–3 line block comment: (i) what it changes, (ii) why (link Linear / DR), (iii) reversal note. Schema only — no DML unless explicitly a backfill (per migration 007 standard).

### `.env` escaping
Bcrypt `$` → `$$` in `.env` (Docker Compose treats `$` as variable expansion and silently truncates).

### Caddy basic_auth rotation (canonical)
Use `bin/rotate-basic-auth`. Handles two footguns: (1) `caddy hash-password` needs `--plaintext` for non-interactive use; (2) `docker compose restart caddy` does NOT pick up `.env` changes — script uses `up -d` and verifies the live container env post-rotation.

```bash
./bin/rotate-basic-auth mailbox1                               # generate + apply
./bin/rotate-basic-auth --dry-run mailbox1                     # preview
./bin/rotate-basic-auth --update-1password 'mailbox.heronlabsinc.com' mailbox1
```

### Gmail rate-limit cooldown (STAQPRO-271 + MBOX-107)
**Don't retry until well past stated `Retry-After`.** Each retry during cooldown extends the deadline (2026-05-08: 4 retries pushed cooldown +1h44m past the 15-min stated retry-after). Read and send quotas are independent buckets. SLO: don't fire `MailBOX-Send` again until `now > stated_retry_after + 1h`, doubling on subsequent failures.

**Circuit breaker (live).** `mailbox.system_state.gmail_rate_limit_until` is the single source of truth ("Gmail is angry at us right now"). Written by `dashboard/lib/jobs/gmail-ratelimit-sweeper.ts` which parses 429 `Retry-After` from n8n's `execution_entity`. Three consumers gate on it:
- `GET /api/internal/gmail-cooldown` — n8n's `MailBOX` parent calls this from the `Cooldown Check` HTTP node; the `Cooldown Active?` IF short-circuits the schedule before any Gmail call. Returns `{ in_cooldown, until }` with a +60-min safety BUFFER past Google's hint (STAQPRO-228 — Google's hint is a minimum, not a guarantee).
- `dashboard/lib/transitions.ts` (STAQPRO-231) — approve + retry both refuse to fire `MailBOX-Send` while the cooldown is live.
- `GET /api/system/gmail-cooldown` — operator-facing read for the `GmailCooldownBanner` (full shape: `is_active`, `until`, `set_at`, `recommended_safe_at`).

**Force-resume escape hatch (MBOX-107).** `DELETE /api/system/gmail-cooldown` clears the row via `clearGmailCooldown()`. Surfaced as the "Force resume" button in `GmailCooldownBanner` behind a 5s arm-then-confirm window (matches StuckApproved.tsx). Idempotent: returns 200 with `cleared:false` when nothing was set. Use only after independently verifying Google's stated retry-after has elapsed — clearing during a still-active probation re-triggers the 429 and extends the penalty +15 min.

n8n's webhook returns an empty body when `Gmail Reply` throws — `JSON.parse('')` → 502 "Unexpected end of JSON input." Treat any 502 with that string as a Gmail send failure; fetch the real cause from `execution_data.data` of the latest errored `MailBOX-Send` execution.

### Backfill memory pre-flight (MBOX-166 / MBOX-109)
**The two GGUF-loading backfills self-guard against concurrent large loads.** `dashboard/scripts/classify-backfill.ts` and `dashboard/scripts/rag-backfill.ts` call `checkMemoryPressure()` (`dashboard/lib/preflight/memory.ts`) at the top of `main()` and `process.exit(1)` when `/proc/meminfo`'s `MemAvailable` is below **1.5 GiB** (override `MAILBOX_PREFLIGHT_MIN_MEM_GIB`). Closes the DR-25 soak-window failure mode where loading `qwen3:4b-ctx4k` into Ollama alongside a resident llama-cpp on the 8 GiB Jetson logged 138 container restarts via CUDA-side alloc failures (never tripped kernel OOM).

Escape hatch: `MAILBOX_PREFLIGHT_SKIP=1` forces through (logs the warning and continues). Jetson uses unified memory so `MemAvailable` is the authoritative combined CPU+GPU proxy — no nvidia-smi/tegrastats needed. The same helper feeds `/api/system/status` → `memory_pressure` (and a `MEMORY_PRESSURE` alert, warn at amber / alarm at red) so the operator sees pressure before the next backfill aborts. Retires the soak-window-era "don't run two backfills concurrently" verbal rule — it now lives in code, with operator-visible status.

### Swap + orphan containers stat (MBOX-168)
Two companion fields to `memory_pressure`, both born from the same DR-25 misdiagnosis class (~4 agent runs spent on "hardware too small" when the real cause was a 3.86 GiB orphan llama-cpp container hoarding RAM).

- **`swap_in_use`** (`dashboard/lib/preflight/swap.ts`) — parses `SwapTotal:`/`SwapFree:` out of `/proc/meminfo`. Green = 0 in use; yellow = > 0 and ≤ threshold (zram cycling noise); red = > threshold OR meminfo unreadable. Threshold = `MAILBOX_SWAP_THRESHOLD_MIB` (default 100 MiB). Synchronous; total-failure-safe (never throws).
- **`orphan_containers`** (`dashboard/lib/queries-orphans.ts` + `dashboard/lib/queries-docker.ts`) — set difference of (running on host) − (declared in `docker-compose.yml`). Reads compose off the existing MBOX-163 read-only repo bind, hits Docker via raw `http.request` on `/var/run/docker.sock` (no `dockerode`, no `docker` CLI binary in the image). Capped at 800ms via `Promise.race` in the route. Renders the actual container names on `/status` — knowing "ghost-llama-cpp" lets the operator `docker stop` immediately.

**Security caveat — docker.sock bind**: `mailbox-dashboard` mounts `/var/run/docker.sock:/var/run/docker.sock:ro`. The `:ro` is **operator intent only** — the docker engine treats it as advisory at the protocol level. Acceptable here because (a) the appliance is single-tenant trusted, and (b) `lib/queries-docker.ts` only calls `GET /containers/json`. Do NOT replicate this bind into any future multi-tenant or customer-side dashboard without re-evaluating the trust boundary.

Intentionally NOT flagged by the orphan check: expected services that aren't running (that's a different problem class — service down, not orphan). Track separately if it ever opens an issue.

### n8n workflow editing (2.x)
- **All four MailBOX workflows must be `active=true` on n8n 2.x.** Pre-2.x guidance (sub-workflows `active=false`) was retracted — 2.x throws *"Workflow is not active and cannot be executed"* and dark-classifies the inbox until caught (STAQPRO-181 hit this for ~12h on M2 post-2.14.2). Gate: `mailbox-n8n-verify` profile.
- `n8n update:workflow --active=...` is a no-op at runtime without a container restart.
- **n8n 2.x publish/draft duality (2026-05-21 lesson)**: for webhook-triggered workflows, runtime reads from `workflow_published_version`, NOT `workflow_entity`. SQL UPDATEs to `workflow_entity.nodes` never reach runtime. Always edit-then-Publish via the editor UI (CLI `publish:workflow` unreliable in 2.14.2).
- **Repo↔live drift is invisible without MCP** — `n8n/workflows/*.json` in git is NOT enforced as source of truth; n8n runs from its DB. Use `mcp__n8n-mcp__get_workflow_details` to compare canonical / activeVersion / repo.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

### Service topology (Docker Compose on Jetson)

| Service | Image | Role |
|---|---|---|
| `postgres` | `postgres:17-alpine` | Operational DB + n8n's `workflow_entity` |
| `qdrant` | `qdrant/qdrant:v1.17.1` | Vector store. Bootstrap via `--profile qdrant-bootstrap` (idempotent) |
| `ollama` | `ollama/ollama@sha256:<digest>` | Local LLM (Qwen3-4B + nomic-embed-text) |
| `n8n` | `n8nio/n8n:2.14.2` | Workflows: `MailBOX`, `MailBOX-Classify`, `MailBOX-Draft`, `MailBOX-Send`, `MailBOX-Digest` |
| `caddy` | `caddy:2` | Public HTTPS + basic_auth on all paths |
| `mailbox-dashboard` | Next.js 14 build | Approval queue UI + internal API routes (DR-24) |
| `mailbox-migrate` | tsx runner | `--profile migrate run mailbox-migrate` |
| `mailbox-qdrant-bootstrap` | tsx one-shot | `--profile qdrant-bootstrap` |

**Operator shell access**: Tailscale SSH only — `ttyd` removed 2026-05-01 per STAQPRO-126.

### Pipeline flow

```
Schedule (5 min)
  └─> Gmail Get  ──> Insert Inbox (skip dupes)
                         └─> Run Classify Sub  (MailBOX-Classify)
                                  └─> qwen3:4b-ctx4k classify (/no_think)
                                  └─> live-gate check
                                  └─> Insert Draft Stub
                                       └─> Run Draft Sub  (MailBOX-Draft)
                                              ├─ LOCAL → qwen3:4b-ctx4k → /api/internal/draft-finalize
                                              └─ CLOUD → Ollama Cloud (gpt-oss:120b) → /api/internal/draft-finalize
                                                    └─> drafts.status = pending
                                                          └─> Dashboard approval queue
                                                                 └─> approve → MailBOX-Send → Gmail Reply → status=sent
```

### Daily digest worker (MBOX-132)

Separate schedule chain `MailBOX-Digest` — once-per-day rollup, read-only against drafts.

```
Schedule (DIGEST_SEND_HOUR_LOCAL, GENERIC_TIMEZONE)
  └─> GET /api/internal/digest   (render + send-decision in one call)
        • getDigestPayload() reuses MBOX-134 urgency engine — no second rule set
        • should_send = recipient resolved AND DIGEST_SEND_FROM_GMAIL on AND not already sent today
  └─> IF should_send
        └─> Gmail send (appliance OAuth) → MAILBOX_OPERATOR_EMAIL (→ onboarding.email_address fallback)
              └─> POST /api/internal/digest/record → INSERT digest_sends (UNIQUE(sent_on) — once-per-day)
```

De-dupe lives in the DB constraint (UNIQUE on `sent_on`, migration 029), not app logic. Claim happens AFTER successful send so a send failure doesn't burn the day. Must be imported + activated on each appliance (re-link Gmail OAuth; set `DIGEST_*` env).

### Routing rules (`dashboard/lib/classification/prompt.ts:routeFor`)

- `spam_marketing` → drop (no draft)
- `confidence < 0.75` → cloud (safety net)
- `LOCAL_CATEGORIES` (`reorder`, `scheduling`, `follow_up`, `internal`, `inquiry`) → local Qwen3
- `CLOUD_CATEGORIES` (`escalate`, `unknown`) → Ollama Cloud (`gpt-oss:120b`; `OLLAMA_CLOUD_MODEL` env override)

### Operator never-spam allowlist / "reclassify automatically" (MBOX-370, migrations 041→043)

`mailbox.sender_never_spam` (one row per sender email) is the operator's "this sender isn't spam" allowlist, set from `/dashboard/classifications` ("↻ reclassify" action). It is NOT a force-to-category rule — MBOX-368 shipped that (migration 041) and it was reverted by migration 043 after operator feedback: a sender wrongly dropped as spam can send any non-spam type later, so the classifier must decide per email. Two halves:

- **Future** — guard in `app/api/internal/classification-normalize/route.ts` (`lib/classification/sender-allowlist.ts`). When a verdict would be a heuristic `spam_marketing` drop (from the MODEL or the noreply preclass — NOT self-loop / owns-thread) AND the sender is allowlisted, it's surfaced to `unknown`→cloud (`preclass_source='sender-never-spam'`) instead of dropped. DB lookup runs only on the spam path; fail-open; kill switch `SENDER_NEVER_SPAM_DISABLE=1`. **No n8n change** — the Normalize node already sends `from`. Non-spam verdicts pass through to their real category and draft normally.
- **Past** — `POST /api/classifications/reclassify-sender { email, reason? }` (`lib/queries-sender-allowlist.ts:reclassifyBySender`) upserts the allowlist row + re-runs the REAL classifier (`classifyOne`) on the sender's existing emails (cap 50 newest), writing one `classification_log` row per message (the migration-021 trigger syncs `inbox_messages`). The same never-spam guard surfaces any spam verdict to `unknown`. **Relabel only — NO drafts generated for historical dropped mail** (operator decision 2026-05-30; future inbound drafts normally via the live pipeline).

### RAG retrieval (STAQPRO-191)

`POST /api/internal/draft-prompt` embeds inbound, queries Qdrant `email_messages` with hard sender filter (`payload.sender == inbound.from_addr`) for counterparty-scoped recall. Top-k snippets land in `lib/drafting/prompt.ts` `rag_refs`; point IDs persist to `drafts.rag_context_refs`.

**Privacy gate (cloud route)**: LOCAL → retrieval always runs. CLOUD → only when `RAG_CLOUD_ROUTE_ENABLED=1`; otherwise `retrieveForDraft` returns `{ refs: [], reason: 'cloud_gated' }`. RAG is augmentation, not gate — drafting falls back to persona-stub on any non-`ok` reason.

Tunables: `RAG_RETRIEVE_TOP_K` (default 3), `RAG_RETRIEVE_EXCERPT_CHARS` (default 600). Eval-only short-circuit: `RAG_DISABLED=1` (STAQPRO-198).

### RAG ingestion (STAQPRO-190)

- **Inbound — automatic.** `/api/internal/inbox-messages` POST fires fire-and-forget `embedText() → upsertEmailPoint()` after a successful insert (only on `created=true`).
- **Outbound — explicit.** `POST /api/internal/embed`. The `MailBOX-Send` workflow adds an HTTP node after `Mark Sent` that POSTs `{ message_id, sender, recipient, subject, body, sent_at, direction: 'outbound', classification_category }`. Idempotent on deterministic point UUID.
- **Backfill — one-shot.** `docker exec mailbox-dashboard npx tsx scripts/rag-backfill.ts`. Env `BACKFILL_LOOKBACK_HOURS`; default 90 days.

Runtime image must contain `/app/lib` (commit `7c655e6`) — pre-`7c655e6` images shipped scripts but not lib, so `tsx` import resolution failed. Verify: `docker exec mailbox-dashboard ls /app/lib/rag/embed.ts`.

### Active decision records

| DR | Decision | Status |
|---|---|---|
| DR-17 | Pin n8n to 1.123.35 | **Superseded 2026-05-01 (STAQPRO-181)** — at 2.14.2 |
| DR-18 | `qwen3:4b-ctx4k` @ 4096 ctx as T2 default | Active |
| DR-22 | Pub/Sub push as Phase 1 ingress | **KILLED 2026-04-30** — stay polling |
| DR-23 | Anthropic Haiku 4.5 as primary cloud draft | **Superseded 2026-04-30** — Ollama Cloud `gpt-oss:120b` is default; Haiku is config-ready alt |
| DR-24 | Dedicated Next.js 14 dashboard service | Active |
| DR-25 | llama.cpp as T2 local inference (behind `LOCAL_INFERENCE_RUNTIME=llama-cpp`) | **Proposed 2026-05-13** — SDK abstraction landed; on-device build pending (STAQPRO-338) |
| DR-50 | Deterministic operator-domain preclass for `internal` | Active |
| 2026-05-01 ADR | Dashboard ORM = Kysely (over Prisma + Drizzle) | Active — closes STAQPRO-136. ADR in `.planning/STATE.md`. |

### Public surface

**M1 (`192.168.50.179`)** — Caddy basic_auth on all paths:
- Dashboard: `https://mailbox.heronlabsinc.com/dashboard/queue`
- n8n editor: `https://mailbox.heronlabsinc.com/` (LAN-only path: `http://192.168.50.179:5678`)
- Webhook: `https://mailbox.heronlabsinc.com/webhook/*` (basic_auth gated per STAQPRO-161)

The dashboard's approve→send loop calls n8n via internal docker DNS (`http://n8n:5678/webhook/mailbox-send`) and never traverses Caddy.

### Test coverage

**STAQPRO-133 (open)** — Vitest scaffold + schema invariants + per-route + pipeline smoke landed (44 cases run in CI). `scripts/smoke-test.sh` is **infra** smoke (GPU/Qdrant/Postgres), not pipeline.
<!-- GSD:architecture-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Start work through a GSD entry point so planning artifacts + execution context stay in sync:
- `/gsd:quick` — small fixes, doc updates, ad-hoc
- `/gsd:debug` — investigation + bug fixing
- `/gsd:execute-phase` — planned phase work

Do not make direct repo edits outside a GSD workflow unless explicitly asked to bypass.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd:profile-user` to generate.
> Managed by `generate-claude-profile` — do not edit manually.
<!-- GSD:profile-end -->

## Related repositories

- **`~/thumbox-appliance/`** — separate product: OpenClaw / NemoClaw assistant appliance, lives on the ex-M2 hardware (`mailbox2`). Different stack (no Postgres / n8n / Qdrant; NemoClaw sandbox + NIM cloud inference). Do not cross-reference code or share deployment scripts.
- **`~/mailbox-queue-sandbox/`** — UI/UX sandbox for the dashboard (Vite + React 19 + Tailwind v4, `pnpm dev` → :5173). Fixtures from real M1 data; local-only, not pushed.

<!-- GSD:deployment-start -->
## Deployment Target

The M1 appliance is reachable via SSH alias `mailbox1` (tailnet `mailbox1.tail377a9a.ts.net`, user `bob`). Direct-LAN alias `mailbox1-lan` → `192.168.50.179`. Repo path: `/home/bob/mailbox/`.

A legacy `10.42.0.0/24` direct-ethernet path (workstation `.1` / Jetson `.2`, ~0.5ms RTT) remains configured in NetworkManager but is currently inactive — appliance is on the router LAN.

### Reading appliance state

```bash
ssh mailbox1 'cd ~/mailbox && docker compose ps'
ssh mailbox1 'docker logs <service> --tail 50'
ssh mailbox1 'docker compose -f ~/mailbox/docker-compose.yml exec <svc> <cmd>'
```

### Cross-session deploy check (MBOX-163)

Before issuing `git pull` / `docker compose up` against the appliance, verify what branch + commit it's actually on — STAQPRO-336 burned a 36-hour rebuild because M1 was on `worktree-staqpro-360` while local `master` was 19 commits behind origin, invisible from off the box. The dashboard exposes live appliance git state on `/api/system/status` so any session/agent can check without SSH:

```bash
curl -su admin:$PW https://mailbox.heronlabsinc.com/dashboard/api/system/status | jq .git_state
```

Returns `{ available, git_branch, git_short_sha, commits_behind_master, commits_ahead_master, fetch_age_seconds, dirty, reason }`. The `/dashboard/status` page surfaces the same data as tiles with red/orange tone rules. The dashboard reads the host repo via a read-only bind mount (`HOST_REPO_DIR` on the host → `/app/repo:ro` in the container — see `.env.example`). `:ro` is non-negotiable — never write from the container.

### Deploy flow

Edit + commit + push here, then on the Jetson pull + reload:

```bash
git add . && git commit -m "..." && git push origin master
ssh mailbox1 'cd ~/mailbox && git pull && git submodule update --init && docker compose up -d --build --remove-orphans'
```

**Always pass `--remove-orphans`** on full-stack `up`. Removed services keep their host port binding without it.

**Submodule note (MBOX-324, 2026-05-23)**: `vendor/thumbox-common` holds shared appliance ops (canonical `bin/rotate-basic-auth`, generic `scripts/first-boot-jetson.sh`) from `UMB-Advisors/thumbox-appliance-common`, pinned to a tag. `git submodule update --init` is now part of every deploy and every fresh workstation clone. If `./bin/rotate-basic-auth` exits with "canonical not found" the submodule wasn't initialized — fix with `git submodule update --init`.

For **Caddyfile** changes (bind-mounted, no rebuild): `docker compose restart caddy`.
For **`.env` Caddy var changes** (basic_auth, etc.): `docker compose up -d caddy` (restart keeps stale env).
**Do not** use `docker compose exec caddy caddy reload` — STAQPRO-161 deploy hit a case where it reported "config unchanged" while the bind-mounted file was new.

### Credentials — 1Password (MailBOX vault)

Operator-side credentials live in 1Password under `dustin@umbadvisors.com`'s account.

| Item | Purpose |
|---|---|
| `mailbox.heronlabsinc.com` | M1 Caddy basic_auth (`admin` / URL `https://mailbox.heronlabsinc.com/dashboard/queue`) |
| `mailbox1` | M1 SSH user + Postgres password |

Retrieve via `op item get '<title>' --vault MailBOX --reveal`. After rotation, `op item edit '<title>' --vault MailBOX password='<new>'` — don't create a new item. Customer-side: share the relevant 1P item to their account rather than emailing.

### Post-n8n-upgrade verification

After any n8n bump or workflow re-import, all four `MailBOX*` workflows must be `active=true` or the polling chain silently breaks at `Run Classify Sub` ("Workflow is not active and cannot be executed"). `n8n import:workflow` defaults to `active=false`.

**Canonical guardrail** — `mailbox-n8n-verify` compose profile (`dashboard/scripts/n8n-verify.ts`). Exit 0 = all four active; 1 = any missing/inactive; 2 = connection error.

```bash
ssh mailbox1 "cd ~/mailbox && docker compose --profile n8n-verify run --rm mailbox-n8n-verify"
```

Use this in install runbooks + OTA scripts — the non-zero exit is the gate. The dashboard `/status` page also surfaces this via the **Classify lag** Stat (green when no unclassified inbox_messages in last 24h, red when oldest > 15 min).

Activation runbook (post-import): toggle Active in the n8n editor, or:

```bash
ssh mailbox1 "docker exec mailbox-n8n-1 n8n update:workflow --active=true --id=<id>"
ssh mailbox1 "cd ~/mailbox && docker compose restart n8n"
```

CLI flag is a no-op at runtime without the restart.

### Tailscale / SSH aliases

| Alias | Tailnet host | LAN IP | User | Path |
|---|---|---|---|---|
| `mailbox1` | `mailbox1.tail377a9a.ts.net` | `192.168.50.179` | `bob` | `/home/bob/mailbox/` |

`mailbox1-lan` → `192.168.50.179` direct.

> **`mailbox2` is NOT a MailBOX target.** As of 2026-05-22 that hardware runs the OpenClaw / NemoClaw stack — see `~/thumbox-appliance` (repo `UMB-Advisors/thumbox-appliance`). The `mailbox2` SSH alias still resolves but should never appear in MailBOX fleet rollouts or OTA pushes until customer #2 is reinstated on different hardware.
<!-- GSD:deployment-end -->
