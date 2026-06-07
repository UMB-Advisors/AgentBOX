# MailBOX One — T2 Build Log

**Version:** v0.9
**Date:** 2026-04-25 (continuing from v0.8, evening session)
**Hardware:** NVIDIA Jetson Orin Nano 8GB Developer Kit Super
**JetPack:** 6.2 (L4T R36.5)
**n8n version:** 1.123.35
**Operator:** Dustin
**Supersedes:** v0.8 (same date)

---

## Headline

**Phase 1 deliverable #4 functionally complete.** Cloud-API draft generation workflow live and autonomous. `action_required` classified emails get LLM-generated reply drafts persisted to Postgres with full token-cost-attribution audit trail. Provider: NVIDIA NIM (Llama 3.3-70B Instruct, free developer tier). Architecture is provider-portable — swapping to OpenAI, Anthropic, or self-hosted is one credential change.

This closes the autonomous "ingest → classify → draft" arc. What's left for Phase 1 is the human-in-the-loop layer: dashboard approval queue (deliverable #6) plus optional RAG enhancement (deliverable #5).

---

## Status at a glance

| Component | State |
|---|---|
| MailBOX (workflow #1: ingest + classify) | ✅ Active, 5-min cadence, qwen3:4b-ctx4k |
| MailBOX-Drafts (workflow #2: draft gen) | ✅ **New this session — Active, 5-min cadence** |
| `mailbox.drafts` table | ✅ Created with full lifecycle status enum |
| `inbox_messages.draft_id` FK | ✅ Linked correctly |
| NVIDIA NIM credential | ✅ Wired via Header Auth + HTTP Request |
| End-to-end test | ✅ id=1 inbox message → draft id=1 in drafts table |
| OOM stability | ✅ Held throughout session |
| Schedule polling cadence | ✅ Both workflows on 5-min |

---

## Changes since v0.8

| Area | v0.8 → v0.9 |
|---|---|
| Phase 1 deliverable #2 | Functionally complete (classify) | Same |
| Phase 1 deliverable #4 | Not started | ✅ **Functionally complete** |
| Phase 1 deliverable #5 | Not started | Same |
| Phase 1 deliverable #6 | Not started | Same |
| Postgres schema | inbox_messages only | + `mailbox.drafts` + `inbox_messages.draft_id` FK |
| Cloud LLM provider | None | **NVIDIA NIM (developer free tier)** |
| Active n8n workflows | 1 (MailBOX) | 2 (+ MailBOX-Drafts) |
| Daily LLM API cost | $0 | $0 (NIM free tier) |
| New BL items | — | BL-20, BL-21, BL-22, BL-23 |

---

## Decisions this session

| ID | Decision | Type | Rationale |
|---|---|---|---|
| BL-D19 | Use NVIDIA NIM (free dev tier) over OpenAI for draft generation | **Strategic** | (1) Zero billing friction — OpenAI quota error blocked us; NIM works in 5 min with no card. (2) Strategic alignment: thUMBox is in NVIDIA ecosystem, using NIM during dev is on-narrative. (3) Models are open-weight (Llama 3.3-70B), we keep optionality. **Caveat:** 1000 req/month + 40 RPM cap means production use needs paid tier or self-hosting. |
| BL-D20 | Default model: `meta/llama-3.3-70b-instruct` | Tactical | Strong writer, follows system prompts well, well-tested. Kimi-K2.5 / GLM-5 / Nemotron remain options for later evaluation. |
| BL-D21 | HTTP Request node + Header Auth credential over OpenAI node with base URL override | Tactical | n8n 1.123.35 OpenAI credential type doesn't support Base URL field; HTTP Request + Header Auth is the clean, maintainable path. Same pattern as Classify node in workflow #1. |
| BL-D22 | Split Postgres write into Insert + Update nodes, not single Execute Query CTE | Tactical | n8n 1.123.35 Execute Query node uses comma-separated parameter list which breaks when any parameter contains commas (e.g. an email body). Insert + Update operations use field-mapped UI which handles arbitrary content cleanly. |
| BL-D23 | Defer confidence-routing for draft generation | Tactical | Initial pick was "All GPT-4o for safety, downgrade later." After provider switch to NIM, deferred entirely. Phase 1 ships single-model. Routing logic added in Phase 2 when we have evaluation data. |

---

## Architecture: workflow #2 (MailBOX-Drafts)

```
Schedule Trigger (every 5 min)
  ↓
Postgres SELECT (Find Pending Drafts)
  WHERE classification = 'action_required' AND draft_id IS NULL
  LIMIT 5
  ↓
HTTP Request → NVIDIA NIM (Generate Draft)
  POST integrate.api.nvidia.com/v1/chat/completions
  Model: meta/llama-3.3-70b-instruct
  System prompt: persona + behavioral rules
  User prompt: From / Subject / Received / Body
  max_tokens: 500, temperature: 0.7, timeout: 60s
  ↓
Set node (Merge Draft)
  Extract draft_body, model, token counts, status='pending'
  ↓
Postgres Insert (Insert Draft)
  → mailbox.drafts (returns new id)
  ↓
Postgres Update (Link Draft to Message)
  mailbox.inbox_messages SET draft_id = new draft id
  WHERE id = inbox_message_id
```

**Idempotency:** `WHERE draft_id IS NULL` ensures already-drafted messages never re-process. Failed runs leave `draft_id = NULL` so the next cycle retries cleanly.

**Throttling:** 5 emails per cycle, 1 cycle per 5 minutes = 60 drafts/hr theoretical max. NIM rate limit is 40 RPM (~2400 req/hr). Comfortable headroom.

**Cost-tracking-ready:** `cost_usd` column populated as `0.000000` literal for NIM. When/if we move to paid models, change Merge Draft's `cost_usd` field expression to compute `(input_tokens × input_rate + output_tokens × output_rate) / 1000000`.

---

## Schema: `mailbox.drafts` (new this session)

```sql
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

CREATE INDEX idx_drafts_status ON mailbox.drafts(status);
CREATE INDEX idx_drafts_message ON mailbox.drafts(inbox_message_id);

ALTER TABLE mailbox.inbox_messages 
  ADD COLUMN draft_id INTEGER REFERENCES mailbox.drafts(id);
```

**Status lifecycle:**
- `pending` — generated, awaiting human review (current end state for v0.9 pipeline)
- `approved` — human approved, queued for send (deliverable #6)
- `rejected` — human rejected
- `edited` — human modified before approving (useful for future fine-tuning data)
- `sent` — SMTP delivery succeeded
- `failed` — SMTP delivery failed; see error_message

**Capture for future analytics:**
- Per-draft token counts (input/output) for cost forecasting
- Per-draft model attribution for evaluation comparisons
- `cost_usd` to 6 decimals for sub-cent tracking
- `created_at` + `updated_at` for latency analysis

---

## End-to-end verification (this session)

`mailbox.inbox_messages` → 6 rows from prior sessions (5 test + 1 ingestion proof). Manually set id=1 to `action_required` to seed the workflow.

Workflow run: id=1 picked up, sent to NIM, draft generated:

> "I've received your test email, and everything appears to be working as expected. If you have any further tests you'd like to run or need assistance with anything else, please let me know. \nDustin"

Stats:
- Input: 236 tokens
- Output: 43 tokens
- Latency: ~1-2s end-to-end
- Cost: $0.000000

Persisted to `mailbox.drafts` (row id=1), linked back to `inbox_messages.id=1` via `draft_id=1`. Status `pending`.

The autonomous loop now runs every 5 minutes. Will pick up new `action_required` emails as they arrive.

---

## New open items going forward

| ID | Item | Priority | Notes |
|---|---|---|---|
| **BL-20** | Email signature stripping before classification + drafting | **Medium** | Body field includes full email signatures (Heron Labs branding, phone, etc.). LLMs handle gracefully but this wastes prompt tokens and leaks personal/branding into prompts. Add regex stripping in Extract Fields node — common patterns: `\n-- \n`, `\nSent from`, etc. |
| **BL-21** | LLM-output `\n` literal escapes in draft body | Low | Llama 3.3 emitted `\nDustin` as literal characters (not newline). Fix via prompt revision: explicitly instruct "use real newlines, not escape sequences." Or post-process via Set node `.replace(/\\n/g, '\n')`. |
| **BL-22** | NIM free tier rate limit / monthly cap risk for production | Medium | 40 RPM, ~1000 req/month. Acceptable for 1-user dev appliance. Hard limit at production scale. Plan: (a) shift to paid OpenAI/Anthropic in production builds, OR (b) self-host NIM container if T3 hardware allows. Track NIM credit consumption monthly. |
| **BL-23** | Dangling-pointer cleanup pattern | Low | Found `drafts.id=0` and `inbox_messages.draft_id=0` rows from earlier debugging. Cleaned up this session. Worth adding a periodic Postgres job to detect orphaned/dangling FK refs. Or just trust the FK + ON DELETE CASCADE going forward. |
| BL-15 | Document n8n version pin in T2 production spec | Medium | Carryover. Pin `n8nio/n8n:1.123.35`; document Schedule Trigger UI quirks; document Postgres node quirks (Execute Query comma-split bug — use Insert/Update operations instead). |
| BL-17 | Gmail push notifications via Pub/Sub | Low | Production hardening; defer until polling proves insufficient |
| BL-19 | Schedule Trigger config persistence quirk | Watch | Currently working at 5-min on both workflows. Reopen if regression. |
| BL-7 | Custom jetson-containers Ollama build | Low | Optimization for later |
| BL-6 | nano/vim in T2 base image provisioning | Low | Documentation-only |
| BL-16 | `N8N_PROXY_HOPS=1` to silence X-Forwarded-For warnings | Low | Cosmetic |

**Closed previously:** BL-13, BL-18.

---

## Phase 1 deliverable status

| # | PRD Phase 1 Deliverable | Status |
|---|---|---|
| 1 | Assembled appliance running full stack | ✅ Done |
| 2 | End-to-end IMAP→classify→draft→queue pipeline | ✅ **Classify done, draft done.** Queue (approval UI) pending in #6. |
| 3 | Local model classification > 80% accuracy | 🟡 5/5 test emails classified correctly, but evaluation set is too small for a credible accuracy claim. Need 50+ representative emails. **Add to Phase 2 evaluation work.** |
| 4 | Cloud API draft generation (7/10 complex emails sendable) | ✅ **Functionally complete (this session).** Quality assessment requires real-email testing. |
| 5 | RAG pipeline with email history | ❌ Not started |
| 6 | Dashboard approval queue | ❌ Not started |

**3 of 6 deliverables now substantively done. 1 partial (eval). 2 remaining (RAG, approval UI).**

---

## What works at end of v0.9

Two autonomous workflows, both running on 5-min cadences:

**Workflow #1 (MailBOX):**
- Polls Gmail label `MailBOX-Test`
- Classifies new email via local Qwen3-4B-ctx4k
- Persists to `mailbox.inbox_messages` with classification + confidence
- Idempotent via `ON CONFLICT message_id DO NOTHING`

**Workflow #2 (MailBOX-Drafts) — NEW:**
- Polls `mailbox.inbox_messages` for `action_required + draft_id IS NULL`
- Generates reply draft via NVIDIA NIM Llama 3.3-70B
- Persists to `mailbox.drafts` with full token attribution
- Links draft back to inbox message
- Idempotent via `WHERE draft_id IS NULL` filter

Combined: a real, working, end-to-end MailBOX One pipeline. Email arrives → classified → if action required, drafted → ready for human review.

**Performance:**
- Classify: ~5-9s for 5 emails (local inference, T2 hardware)
- Draft: ~1-2s per email (cloud inference via NIM, Llama 3.3-70B)
- Combined latency from email arrival to draft ready: typically under 5 minutes (worst case 10 min — one classify cycle + one draft cycle)

**Costs (current):**
- Classify: $0 (local)
- Draft: $0 (NIM free tier)
- Total per-email: $0.00 — for now

---

## Next session — clear options

**Three productive directions, ordered by user-impact:**

### Option 1: Phase 1 deliverable #6 (Dashboard approval queue) ← recommended

Build a UI surface for human review of pending drafts. Without this, drafts sit in Postgres with no way to review/approve/send. This is the highest-impact remaining work.

Architecture sketch:
- New page in `optimus-bu` dashboard (`/mailbox/queue`)
- Lists `mailbox.drafts WHERE status = 'pending'` with email context
- Three actions per draft: Approve, Edit, Reject
- Approve → status='approved' triggers send workflow (TBD design)
- Edit → status='edited', draft_body updated
- Reject → status='rejected'
- Send workflow (workflow #3): polls `status='approved'` rows, sends via Gmail API, marks `sent`

Estimated time: 2-3 hours. Front-end work + workflow #3 + Gmail send action.

### Option 2: Phase 1 deliverable #5 (RAG with email history)

Add Qdrant-backed semantic memory to the draft prompt context. Lookup: similar past emails + sender history before generating draft. Uses the already-running Qdrant container + nomic-embed-text:v1.5 model that's been sitting idle.

Architecture sketch:
- New workflow #2.5 (or extend workflow #1): on classify, embed body + store in Qdrant
- Modify workflow #2: before NIM call, query Qdrant for similar past emails, prepend top-3 to prompt as context
- New table: `mailbox.embeddings` linking message_id → vector_id

Estimated time: 3-4 hours. New embedding pipeline + Qdrant integration + prompt restructuring.

**Why option 1 over option 2:** Without an approval queue, draft quality improvements from RAG don't matter — there's no way to actually use the drafts. Build the UI surface first, then iterate on quality.

### Option 3: Move to PRD updates + technical hardening

Not new features, but: amend technical PRD with T2 operational envelope, document Schedule Trigger / Postgres node quirks, document NIM provider strategy + production migration path. Closes BL-15 and the stack of "carryover documentation" items.

Estimated time: 60-90 min. Pure writing, no code.

**Recommendation: Option 1 next session.** Get to a "user can review and approve drafts" state. That's a complete useful product slice. Documentation (Option 3) can happen anytime.

---

## Reflections on this session

The provider switch (OpenAI → NIM) was the right call when the OpenAI billing wall hit. Two payoffs:

1. **Strategic alignment.** Using NVIDIA's stack on NVIDIA hardware is on-narrative for thUMBox. The dev experience also de-risks our future story about "you can run the whole stack on your own NVIDIA infra later."

2. **Architecture portability got tested.** The fact that we could swap providers mid-build by changing only the credential and one URL is a feature, not an accident. The MailBOX One value proposition includes "use whatever LLM you want" — and we've now demonstrated that pattern in practice.

The HTTP Request + Header Auth pattern (over OpenAI node) is cleaner anyway. It's what we should use as the default for any LLM API node going forward — keeps providers swappable without n8n integration version differences.

The Postgres node Execute Query comma-split bug is a real production gotcha. Two workflows now use Insert/Update operations as the established pattern. **Add to technical PRD: "use Insert/Update Postgres operations, not Execute Query, when any parameter could contain commas."**

We went from "no Ollama" three days ago to "two autonomous workflows: local classify + cloud draft" tonight. That's a real product slice. The remaining work — approval queue + RAG — is well-scoped and architecturally clear.

Tomorrow's session has obvious starting point: dashboard approval queue.

---

## Related artifacts

- Build log v0.8: `mailbox-one-t2-build-log-v0_8-2026-04-25.md`
- Build log v0.7 and earlier: prior infrastructure work
- Technical PRD: `thumbox-technical-prd-v2_1-2026-04-16.md` — **needs amendments** with NIM provider strategy, Postgres node guidance, draft schema
- Compose: `/home/bob/mailbox/docker-compose.yml` (unchanged from v0.8)
- Secrets file: `/home/bob/mailbox/secrets-2026-04-23.md` (now includes NVIDIA NIM key)
- Active workflows: MailBOX, MailBOX-Drafts (both 5-min cadence)
- New table: `mailbox.drafts`
- New schema column: `mailbox.inbox_messages.draft_id`
