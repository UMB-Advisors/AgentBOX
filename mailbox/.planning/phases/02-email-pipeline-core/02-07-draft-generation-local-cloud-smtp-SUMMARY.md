---
phase: 02-email-pipeline-core
plan: 02-07
status: shipped — local + cloud paths live, Gmail Reply send path live, telemetry + few-shot exemplars + Gmail cooldown + StuckApproved retry all shipped
date: 2026-05-07
mode: retroactive (the PLAN was promoted on 2026-04-30; this SUMMARY closes the post-promotion shipping wave through 2026-05-07)
sources: Linear STAQPRO-156, 178, 179, 202, 206, 226, 227, 228, 233, 234, 235, plus PLAN-promotion commits 001a6bd → d448972
supersedes: none — closes 02-07-draft-generation-local-cloud-smtp-PLAN.md (status promoted 2026-04-30, executed iteratively through 2026-05-07)
---

# 02-07: Draft Generation (Local + Cloud + Send) — SUMMARY (retroactive)

The 02-07 PLAN was promoted on 2026-04-30 (commit `2eed824`); the local
drafting path shipped end-to-end (`001a6bd → d448972`) before STATE.md was
last updated. Everything since has been Linear-tracked production-shaping.
This SUMMARY closes the audit trail through 2026-05-07. CLAUDE.md's "Models
(live)" + "Pipeline flow" + "Routing rules" sections are the canonical
live-shape reference.

## What shipped

### Local path (Qwen3-4B `qwen3:4b-ctx4k`)
- Custom Modelfile caps context at 4096 (DR-18) — `~2.7 GB` resident.
- Routes via `LOCAL_CATEGORIES`: `reorder`, `scheduling`, `follow_up`, `internal`, `inquiry`.
- `/no_think` directive applied on the classify path; thinking mode left intact for drafting.
- End-to-end smoke (synthetic `reorder`): p95 3.57s. Well under the 30s MAIL-06 local SLA.

### Cloud path — D-52 resolved: Ollama Cloud `gpt-oss:120b` is the live default
- **D-52 resolution (supersedes DR-23)**: Ollama Cloud `gpt-oss:120b` chosen as default cloud drafter, with Anthropic Haiku 4.5 wired as a config-ready alt-cloud (commit `964c781` — both `OLLAMA_CLOUD_API_KEY` and `ANTHROPIC_API_KEY` baked into `mailbox-dashboard` service).
- Same `/api/chat` shape as local Ollama → swap `baseUrl` + key only. Zero code branching for the model swap.
- Routes via `CLOUD_CATEGORIES`: `escalate`, `unknown`, plus `confidence < 0.75` safety net.
- Anthropic Haiku 4.5 alt-cloud commented out in `.env.example`; flip by populating `ANTHROPIC_API_KEY` and pointing the draft route at the Anthropic provider.

### Send path — Gmail Reply (n8n) with idempotency + outbound RAG ingest hook
- MailBOX-Send sub-workflow uses Gmail Reply node (OAuth credential — STAQPRO-191's auth token-store) for the actual send. No SMTP / nodemailer.
- **Idempotency (STAQPRO-202 / migration 015)**: `sent_gmail_message_id` persisted on `Mark Sent` so re-fires can detect "already sent" instead of double-sending.
- **Outbound RAG hook**: after `Mark Sent`, the workflow POSTs to `/api/internal/embed` to ingest the sent message into the `email_messages` Qdrant collection (STAQPRO-190 outbound path).
- Send-side failures **do NOT flip status** (STAQPRO-202): Gmail Reply errors leave the row at `approved`; the StuckApproved UI surfaces it for operator-driven retry. This was a deliberate state-machine simplification to drop the `failed` status entirely.

### STAQPRO-156 — cloud-vendor decision (D-52)
Closed the Anthropic Haiku 4.5 vs Ollama Cloud `gpt-oss:120b` question.
Both are wired. Default flipped to Ollama Cloud per the 2026-04-30 pivot;
Haiku stays config-ready as fallback. The legacy NIM-based `MailBOX-Drafts`
workflow was archived to `n8n/workflows/legacy/MailBOX-Drafts-NIM.json`
(commit `bf288b0` on origin).

### STAQPRO-202 — drop `failed` status (drafts state machine narrowed)
- Migration 016 narrowed the `mailbox.drafts.status` CHECK constraint: `failed` removed.
- Live machine: `pending` → `awaiting_cloud` (cloud route, in-flight) → (`approved` | `rejected` | `edited`) → `sent`.
- Backend paths and `FailedSends` UI surface dropped (`8de5f54`, `b801b9f`). Test schema realigned (`0b8a4c1`). MailBOX-Send workflow synced to live activeVersion (`a881a11`). Gmail Get limit bumped to 1000 (`3fb5ef0`).
- Documented in CLAUDE.md "Draft status state machine" — single source of truth for the enum is the Postgres CHECK in migration 003 (last narrowed by 016).

### STAQPRO-227 / 228 — Gmail cooldown system (rate-limit safety)
- **227**: server-side cooldown for the StuckApproved retry path; sweeper-driven retries respect the same cooldown.
- **228**: read-side cooldown gate (`mailbox.system_state.gmail_cooldown_until` per migration 018) — when Gmail returns 429, the cooldown timestamp is set; subsequent reads / retries short-circuit until the timestamp passes. Added 20-min then 60-min buffer on top of the Retry-After hint to break observed ratchet loops (`68d85ef`, `643469d`).
- StuckApproved UI: 5s arm window + "may have already sent — verify in Gmail Sent" warning before re-fire.

### STAQPRO-233 — drafting telemetry (status card + DB views)
- Migration 019: drafting metrics views in `mailbox` schema (drafts/hour, draft latency p50/p95, route mix local vs cloud, approve/reject/edit ratios).
- `/status` page surfaces a Drafting Telemetry card. Always-on operator visibility on the drafting health.

### STAQPRO-234 — few-shot exemplars from `sent_history`
- Migration 020: `drafts.exemplar_refs` jsonb (point UUIDs of selected exemplars, parallel to `rag_context_refs`).
- Drafting prompt now includes 1–3 prior-thread exemplars selected by counterparty + classification-category match. Improves voice fidelity beyond what the persona resolver alone gives.
- Synergy with STAQPRO-191 RAG retrieval: same Qdrant collection, different selection rule.

### STAQPRO-235 — post-onboarding KB nudge UI
- After the first successful send, `/settings/kb` surfaces a nudge to upload knowledge-base documents. Closes the loop on KB adoption (also referenced in 02-05 SUMMARY).

### Retry path — StuckApproved
- `/api/drafts/[id]/retry` accepts `'approved'` only (the approve route accepts `'pending'` and `'edited'` only — strict input validation).
- Migration 017: `last_retry_at` column for cooldown enforcement.
- 5s arm window in the UI to prevent fat-finger re-fires.

### Classify-sweeper (in-process auto-recovery)
- `dashboard/scripts/classify-backfill.ts` (committed `e3b7254`) — one-shot for unclassified inbox rows.
- In-process classify sweeper (`ad43b8d`) auto-recovers from sub-workflow outages. Imports scoped inside `NEXT_RUNTIME` check (`76086ec`) so the sweeper doesn't load in build-time / edge contexts.
- Exposed in CLAUDE.md "Classify lag" stat on the dashboard `/status` page — green when caught up, red when oldest unclassified row is older than 15 min.

### STAQPRO-178 / 179 — customer-#2 day-1 monitoring + success criteria runbooks
- Operational docs that codify what "drafting is healthy" means on a fresh appliance. Live at `docs/runbook/onboarding-backfill.v0.1.0.md`, `docs/runbook/customer-2-success-criteria.v0.1.0.md`.

### STAQPRO-206 — Ollama tuning (KEEP_ALIVE + NUM_PARALLEL)
- `KEEP_ALIVE=24h` and `NUM_PARALLEL` tuned for burst safety on the 8GB unified-RAM Jetson. Prevents the model from being unloaded between schedule fires (which was costing ~5s per cold-load on the local path).

### STAQPRO-226 — Gmail rate-limit bootstrap mode
- First-boot ingestion respects a slower poll cadence to avoid tripping Gmail's per-account rate limits during the initial 6-month backfill. Tied into the cooldown system (227/228).

## Files of record

### Library
- `dashboard/lib/drafting/persona.ts` — persona resolver (see 02-06 SUMMARY)
- `dashboard/lib/drafting/prompt.ts` — prompt assembly (persona + RAG refs + few-shot exemplars)
- `dashboard/lib/drafting/local.ts` — local Qwen3 path
- `dashboard/lib/drafting/cloud.ts` — cloud path (Ollama Cloud or Anthropic, switchable)
- `dashboard/lib/drafting/exemplars.ts` — few-shot exemplar selector (STAQPRO-234)
- `dashboard/lib/drafting/cooldown.ts` — Gmail cooldown read/write
- `dashboard/lib/transitions.ts` — `transitionToApprovedAndSend` (sets actor + reason GUCs for state_transitions audit)

### API routes
- `dashboard/app/api/internal/draft-prompt/route.ts` — assembles the prompt (persona + RAG + exemplars)
- `dashboard/app/api/internal/draft-finalize/route.ts` — persists the draft (status `pending_approval`)
- `dashboard/app/api/drafts/route.ts` — queue list/get
- `dashboard/app/api/drafts/[id]/approve/route.ts` — approve + invoke send sub-workflow
- `dashboard/app/api/drafts/[id]/retry/route.ts` — StuckApproved retry (cooldown-gated)
- `dashboard/app/api/drafts/[id]/{reject,edit}/route.ts`

### n8n workflows
- `n8n/workflows/04-draft-local-sub.json` — MailBOX-Draft local route
- `n8n/workflows/05-draft-cloud-sub.json` — MailBOX-Draft cloud route
- `n8n/workflows/06-mailbox-send.json` — MailBOX-Send (Gmail Reply + outbound embed hook)
- `n8n/workflows/legacy/MailBOX-Drafts-NIM.json` — archived legacy NIM workflow (STAQPRO-156)

### Migrations
- `dashboard/migrations/011-add-backfill-source-to-sent-history-v1-2026-05-02.sql`
- `dashboard/migrations/012-add-original-draft-body-for-edit-deltas-v1-2026-05-02.sql`
- `dashboard/migrations/015-add-sent-gmail-message-id-v1-2026-05-03.sql`
- `dashboard/migrations/016-drop-failed-from-drafts-status-v1-2026-05-03.sql`
- `dashboard/migrations/017-add-last-retry-at-to-drafts-v1-2026-05-04.sql`
- `dashboard/migrations/018-add-system-state-gmail-cooldown-v1-2026-05-04.sql`
- `dashboard/migrations/019-drafting-metrics-views-v1-2026-05-05.sql`
- `dashboard/migrations/020-drafts-exemplar-refs-v1-2026-05-05.sql`

### Docs / runbooks
- `docs/runbook/onboarding-backfill.v0.1.0.md` (STAQPRO-178)
- `docs/runbook/customer-2-success-criteria.v0.1.0.md` (STAQPRO-179)

### Scripts
- `dashboard/scripts/classify-backfill.ts`

## Deviations from PLAN

- **Cloud vendor**: PLAN locked Anthropic Haiku 4.5 (D-41..D-45). Resolved as **D-52: Ollama Cloud `gpt-oss:120b`** with Haiku as alt. PLAN's prompt-shape was provider-agnostic enough that no rewrite was needed — only `baseUrl` + auth swap.
- **No SMTP**: PLAN section "draft + SMTP send" was implemented as Gmail Reply (n8n) per DR-22 KILL of Pub/Sub and the broader "no IMAP / no SMTP" stance. Authoritative path uses OAuth refresh tokens in n8n's encrypted credential store.
- **Status enum narrowed**: PLAN modeled `failed` status; STAQPRO-202 dropped it (migration 016) once the StuckApproved retry path absorbed the recovery use case.
- **Few-shot exemplars added beyond PLAN scope**: STAQPRO-234 wasn't in the original PLAN. Added because the persona resolver alone wasn't carrying enough voice fidelity on certain reply categories — a few-shot prior-thread excerpt closed the gap.
- **Telemetry surface added**: STAQPRO-233 wasn't in the PLAN. Added because the appliance was running blind to drafting health post-deploy.

## Deferred / not in scope

- **Cloud-route RAG**: gated by `RAG_CLOUD_ROUTE_ENABLED` and currently off in production (privacy gate per project Constraints — see 02-05 SUMMARY).
- **Auto-send (no-approval-needed)**: out of scope for 02-07. Tracked for Phase 3 (graduated auto-send per category).
- **Cost meter on the dashboard**: cloud-route token spend is logged but not surfaced in `/status` yet. Tracked separately.

## Linear ticket trail

| Ticket | Scope | Status |
|--------|-------|--------|
| STAQPRO-156 | Cloud-vendor decision (D-52: Ollama Cloud default) | Done |
| STAQPRO-178 | Customer-#2 day-1 monitoring runbook | Done |
| STAQPRO-179 | Customer-#2 success criteria runbook | Done |
| STAQPRO-202 | Drop `failed` draft status + migration 016 + UI/test cleanup | Done |
| STAQPRO-206 | Ollama KEEP_ALIVE + NUM_PARALLEL tuning | Done |
| STAQPRO-226 | Gmail rate-limit bootstrap mode | Done |
| STAQPRO-227 | Server-side cooldown for StuckApproved retry | Done |
| STAQPRO-228 | Gmail cooldown read-side gate (migration 018) | Done |
| STAQPRO-233 | Drafting telemetry views + /status card (migration 019) | Done |
| STAQPRO-234 | Few-shot exemplars from sent_history (migration 020) | Done |
| STAQPRO-235 | Post-onboarding KB nudge UI | Done (also in 02-05) |

## Requirements covered

MAIL-06 (draft latency: p95 3.57s local, well under 30s SLA), MAIL-07 (cloud route on `escalate`/`unknown`/low-confidence), MAIL-09 (drafts reflect operator voice — via persona resolver + few-shot exemplars), MAIL-10 (approve / reject / edit through the queue), MAIL-11 (send via the customer's identity — Gmail OAuth), MAIL-12 (idempotent send via `sent_gmail_message_id`), MAIL-13 (operator visibility into drafting state — telemetry card + StuckApproved UI), MAIL-14 (graceful degradation on cloud outage — `awaiting_cloud` status + cooldown).

## Next: 02-08 onboarding wizard

Drafting is live and producing approved sends in production on both
customer #1 (mailbox.heronlabsinc.com) and customer #2 (mailbox.staqs.io).
The onboarding wizard (02-08) is the remaining Phase 2 work — it stitches
together the live-gate, persona settings UI, KB upload, and the first-send
acceptance gate documented in `docs/runbook/customer-2-success-criteria.v0.1.0.md`.
