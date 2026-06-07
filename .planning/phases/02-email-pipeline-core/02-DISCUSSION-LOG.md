# Phase 2: Email Pipeline Core - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-13
**Phase:** 02-email-pipeline-core
**Areas discussed:** Routing policy, Persona extraction, Onboarding flow shape, Approval queue record shape

---

## Routing Policy

### Primary routing rule

| Option | Description | Selected |
|--------|-------------|----------|
| Category + confidence | Categories map to default destination with a confidence threshold override when classification is uncertain. Best balance of cost and quality. | ✓ |
| Category only | Fixed map: reorder/scheduling/follow-up/internal → local; inquiry/escalate/unknown → cloud. Simpler, predictable cost. | |
| Always local, cloud on retry | Every email gets a Qwen3 draft first; cloud on low confidence or quality-gate failure. Minimizes cloud cost, adds retry latency. | |

**User's choice:** Category + confidence (recommended)

### Confidence threshold

| Option | Description | Selected |
|--------|-------------|----------|
| Balanced ≥0.75 | Most high-confidence classifications stay local. Tunable via config. | ✓ |
| Strict ≥0.85 | Only very confident classifications local. More cloud, higher quality. | |
| Permissive ≥0.65 | Almost everything local. Minimal cloud spend, more operator editing. | |

**User's choice:** Balanced ≥0.75 (recommended)

### Cloud-down behavior

| Option | Description | Selected |
|--------|-------------|----------|
| Queue awaiting cloud | Status='awaiting_cloud', null draft, background retry. Matches MAIL-12 literally. | ✓ |
| Fall back to local with warning tag | Generate Qwen3 draft anyway, tag 'cloud-fallback' so operator knows. | |
| Queue with placeholder draft | System message instead of model draft; operator hand-drafts. | |

**User's choice:** Queue awaiting cloud (recommended)

### Escalate category handling

| Option | Description | Selected |
|--------|-------------|----------|
| Cloud draft, never auto-send | Haiku drafts it, 'escalate' flag blocks auto-send permanently. | ✓ |
| No draft, human-only | Queue with red flag and no draft. Safest for sensitive comms. | |
| Local draft, escalate tag | Qwen3 drafts tagged 'escalate'. Cheapest. | |

**User's choice:** Cloud draft, never auto-send (recommended)

---

## Persona Extraction

### Voice extraction method

| Option | Description | Selected |
|--------|-------------|----------|
| Hybrid: stats + few-shot | Statistical markers AND per-category few-shot exemplars from sent history. | ✓ |
| LLM-summarized voice profile | One-shot Haiku call over ~100 sent emails → natural-language voice paragraph. | |
| Few-shot only | 3–5 exemplars per category, no explicit profile. Simplest, fully local. | |

**User's choice:** Hybrid: stats + few-shot (recommended)

### Sample corpus size

| Option | Description | Selected |
|--------|-------------|----------|
| Last 6 months, all | Matches RAG-01 / ONBR-03. Same corpus already ingested for RAG. | ✓ |
| Last 200 sent emails | Bounded, faster regardless of inbox size. May miss seasonality. | |
| Last 30 days | Most recent voice only. Thin sample. | |

**User's choice:** Last 6 months, all (recommended)

### Per-category vs global granularity

| Option | Description | Selected |
|--------|-------------|----------|
| Per-category few-shot | 3–5 exemplars per classification category. Matches PERS-03. | ✓ |
| Global profile + category tags | One voice profile for all drafts; category only drives content. | |
| Per-category profile + exemplars | Distinct voice profile paragraph per category + exemplars. Richest. | |

**User's choice:** Per-category few-shot (recommended)

### Refresh cadence

| Option | Description | Selected |
|--------|-------------|----------|
| Monthly refresh from edits log | Background job reads approved edits monthly, recomputes stats + re-curates exemplars. Matches PERS-05. | ✓ |
| On-demand only | Operator clicks 'refresh persona' in settings. No automatic drift. | |
| Rolling window | After every 50 approved sends, re-curate. More responsive, more compute. | |

**User's choice:** Monthly refresh from edits log (recommended)

---

## Onboarding Flow Shape

### Flow structure

| Option | Description | Selected |
|--------|-------------|----------|
| Staged async | Admin + email connect sync, then dashboard. Ingest runs background with progress. Persona tuning banner-prompted. Live email gated on tuning. | ✓ |
| Blocking wizard | Each step gates the next. Clean mental model, slower first experience. | |
| Fully async, live immediately | Admin + email only. Everything else async. Live email from minute zero with generic persona. | |

**User's choice:** Staged async (recommended)

### Backfill scope

| Option | Description | Selected |
|--------|-------------|----------|
| 6 months sent only | Matches RAG-01 / ONBR-03 literal spec. Sent folder only. | ✓ |
| 6 months sent + received threads | Sent + inbound in replied threads. 3–5x volume. | |
| 12 months sent only | Doubles corpus for voice signal and annual-cycle RAG recall. | |

**User's choice:** 6 months sent only (recommended)

### Live processing gate

| Option | Description | Selected |
|--------|-------------|----------|
| Wait for tuning complete | Operator never sees a generic-voice draft. Matches white-glove positioning. | ✓ |
| Start after ingest, before tuning | Live drafts begin after RAG index populated, with stats-only persona. | |
| Start immediately, improve in place | Queue fills from minute zero; tuning upgrades retroactively. | |

**User's choice:** Wait for tuning complete (recommended)

### Persona tuning sample set

| Option | Description | Selected |
|--------|-------------|----------|
| 20 synthetic drafts over real past emails | System generates 20 drafts over real inbound emails from ingested history. Matches PERS-02 + ONBR-05. | ✓ |
| 20 synthetic drafts over canned scenarios | Curated CPG scenarios, not personal to inbox. Faster. | |
| 10 drafts, then live | Shorter loop. Less signal. | |

**User's choice:** 20 synthetic drafts over real past emails (recommended)

---

## Approval Queue Record Shape

### Field set

| Option | Description | Selected |
|--------|-------------|----------|
| Standard | Original email + draft + category + confidence + source + RAG refs + status + timestamps. Covers MAIL-11, APPR-01, Phase 4 dashboard. | ✓ |
| Minimal | Email + draft + status + timestamp only. Joins needed for metadata. | |
| Rich | Standard + thread history + sender priors + sentiment + edit diffs. More signal, more storage. | |

**User's choice:** Standard (recommended)

### Storage layer

| Option | Description | Selected |
|--------|-------------|----------|
| Postgres mailbox schema | New tables in the `mailbox` schema. n8n writes via Postgres node, dashboard reads via drizzle-orm. Single source of truth. | ✓ |
| n8n execution data only | Use n8n's built-in storage, expose via n8n REST API. Couples to n8n internals. | |
| Postgres + Redis pending cache | Durable Postgres + Redis hot cache for realtime push. Adds a service. | |

**User's choice:** Postgres mailbox schema (recommended)

### Retention policy

| Option | Description | Selected |
|--------|-------------|----------|
| Indefinite, archived | Approved → sent_history, rejected → rejected_history. Keeps queue small. NVMe headroom available. | ✓ |
| 90-day rolling delete | Auto-purge records >90 days. Tighter privacy, loses persona signal. | |
| Indefinite, no archival split | Everything in draft_queue with status filters. Slower queries as table grows. | |

**User's choice:** Indefinite, archived (recommended)

### Edit diff capture

| Option | Description | Selected |
|--------|-------------|----------|
| Store original + final | `draft_original` and `draft_sent` columns. Diff on demand. Feeds PERS-05. | ✓ |
| Store full edit history | Every revision logged. Richer audit, much more data. | |
| Store final only | No original retained after approval. Smallest. Loses drift signal. | |

**User's choice:** Store original + final (recommended)

---

## Claude's Discretion

Items explicitly deferred to the researcher / planner to decide without further user input:
- RAG chunking strategy (per-email vs per-paragraph based on nomic-embed-text context limits)
- n8n workflow partitioning (one main + side workflows; exact boundaries)
- Classification prompt structure and exact system prompt wording
- Qdrant collection topology (single collection likely fine for single-operator appliance)
- Healthcheck intervals and timeout values for new backend API routes
- Exact Postgres DDL: column types, indexes, FK constraints (drizzle-orm schema in planning)
- Retry policies for transient failures at each pipeline stage
- Exact JSON schema for classification output structure

## Deferred Ideas

- Full edit keystroke history (replaced with original+final columns)
- Rich queue records with thread + sender priors + sentiment (deferred to Phase 3 auto-send)
- Global voice profile without per-category exemplars (rejected, per-category is in spec)
- 12-month history backfill (spec says 6, respect scope)
- Redis hot cache for pending queue (unnecessary for v1 single-operator)
- Real-time WebSocket fan-out (Phase 2 delivers webhook path; Phase 4 builds UI side)
