# Phase 2: Email Pipeline Core - Context

**Gathered:** 2026-04-13
**Status:** Ready for planning

<domain>
## Phase Boundary

The complete inbound-to-sent email loop: an email arriving in the connected Gmail inbox is ingested via IMAP, classified by local Qwen3-4B into one of 8 CPG categories, drafted (locally for confident simple categories, via cloud Claude Haiku for complex/low-confidence cases), enriched with RAG context from sent-history and uploaded documents, enters the approval queue with full provenance, and on approval sends via the customer's SMTP. First-boot onboarding runs admin-setup → email-connect synchronously, then stages sent-history ingestion and persona tuning asynchronously; live email processing is gated on persona tuning completion.

Phase 2 delivers the pipeline and the approval-queue API contract. The user-facing dashboard UI for the queue is Phase 4's job — Phase 2 exposes the data and REST/WebSocket endpoints that Phase 4 will consume. The Phase 1 placeholder dashboard container remains in place.

Covers requirements: MAIL-01 through MAIL-14, RAG-01 through RAG-06, PERS-01 through PERS-05, ONBR-01 through ONBR-06, APPR-01, APPR-02.

</domain>

<decisions>
## Implementation Decisions

### Classification & Routing
- **D-01:** Primary routing rule is category + confidence. Categories map to a default destination (local: reorder, scheduling, follow-up, internal; cloud: inquiry, escalate, unknown; spam/marketing: dropped), and a confidence threshold overrides the category mapping when classification is uncertain.
- **D-02:** Confidence threshold is 0.75 (balanced). Classifications below 0.75 route to cloud Claude Haiku regardless of category. Value must be a single config knob (`routing.local_confidence_floor`) so it can be tuned without a redeploy.
- **D-03:** When the cloud API is unreachable and a complex email needs drafting, the email enters the approval queue with `status = 'awaiting_cloud'` and `draft = NULL`. A background retry worker re-drives these rows. Matches MAIL-12 literally. Local fallback is NOT used for cloud-routed items — quality divergence from the stated source label would confuse the operator.
- **D-04:** Emails classified `escalate` always route through cloud Claude Haiku for drafting AND receive a permanent `auto_send_blocked = true` flag in the queue record. No future auto-send rule (Phase 3) can fire on these emails regardless of confidence. The operator must approve manually for the lifetime of the record.
- **D-05:** Classification prompt uses Qwen3 `/no_think` directive for latency (p95 < 5s per MAIL-06). Draft generation prompts may use thinking mode since cloud path has a 60s SLA headroom.
- **D-06:** Qwen3 `<think>` tokens MUST be stripped before JSON parse of classification output (MAIL-07). Invalid JSON falls back to `category: "unknown"` with `confidence: 0.0` — never crashes the pipeline.

### Persona Extraction
- **D-07:** Voice extraction is hybrid: statistical markers (sentence length distribution, formality score, greeting/closing pattern frequencies) AND per-category few-shot exemplars (3-5 approved sent emails per category injected into the draft prompt). Stats are deterministic and cheap; exemplars carry the rich signal.
- **D-08:** Sample corpus is the last 6 months of sent emails — the same corpus ingested for RAG (RAG-01). Single fetch serves both RAG indexing and persona extraction at onboarding. Typical volume: 500–2000 sent emails.
- **D-09:** Exemplars are curated per classification category (PERS-03): the persona extractor picks 3–5 representative sent emails in each of the 8 categories from the onboarding corpus. If a category has fewer than 3 examples in the sent history, use whatever exists and note the gap in the persona record.
- **D-10:** Persona refreshes monthly via a background job that reads approved edits from the sent history (PERS-05). The job recomputes statistical markers and re-curates exemplars from the latest approved sends. No operator action required; refresh timestamps logged for debugging drift.
- **D-11:** Persona profile is stored in `mailbox.persona` as a single row per customer containing: statistical markers (JSONB), per-category exemplar arrays (JSONB), last_refreshed_at, source_email_count.

### Onboarding Flow
- **D-12:** Onboarding is staged async. Admin account creation and email connect are synchronous blocking steps (operator can't skip them). Sent-history ingestion then runs in background with live progress on the dashboard; persona tuning surfaces as a banner-prompted step once the ingest + stats extraction have produced 20 sample drafts.
- **D-13:** Live email processing is gated on persona tuning completion. No drafts flow to the production approval queue until the operator has confirmed the voice on 20 sample drafts. This aligns with the white-glove onboarding product positioning — the operator never sees a generic-voice draft.
- **D-14:** History ingest scope is 6 months of the SENT folder only (not inbox, not received threads). Matches ONBR-03 and RAG-01 literally. A typical CPG sent folder at 500–2000 emails fits the Qdrant 10K-vector budget comfortably.
- **D-15:** Persona tuning sample set is 20 synthetic drafts generated over real inbound emails pulled from the ingested corpus. For each sample: a real inbound email from the customer's history + a draft generated using the stats-only persona. Operator rates each as `good tone / wrong tone / edit` (PERS-02). Results become the seed for persona refinement before live processing starts.
- **D-16:** Onboarding state is tracked in `mailbox.onboarding` with enum stages: `pending_admin`, `pending_email`, `ingesting`, `pending_tuning`, `tuning_in_progress`, `live`. The pipeline's live gate checks this single field.

### Approval Queue Shape
- **D-17:** Queue record schema is "standard": each row carries original email (from, to, subject, body_text, body_html, received_at, message_id, thread_id), draft_original (model output), draft_sent (post-edit final, NULL until approved), classification_category, classification_confidence, draft_source (`local_qwen3` | `cloud_haiku`), rag_context_refs (JSONB array of top-3 chunk IDs with scores), status, auto_send_blocked, created_at, approved_at, sent_at.
- **D-18:** Queue lives in the Postgres `mailbox` schema — new tables `mailbox.draft_queue`, `mailbox.email_raw`, `mailbox.classification_log`, `mailbox.sent_history`, `mailbox.rejected_history`. n8n writes via Postgres node. The Phase 2 deliverable includes an Express API route on the dashboard backend (using drizzle-orm over `mailbox`) even though the dashboard UI itself remains a placeholder — Phase 4 will consume this API.
- **D-19:** Retention is indefinite with archival split. On approval, rows move from `mailbox.draft_queue` to `mailbox.sent_history`. On rejection, rows move to `mailbox.rejected_history`. Keeps `draft_queue` small (fast dashboard queries) while preserving the corpus for persona refresh and auditability. NVMe 500GB has comfortable headroom.
- **D-20:** Edit diffs are captured by storing both `draft_original` and `draft_sent`. No full keystroke history. PERS-05 monthly refresh reads these two columns to compute drift signal. Diff computation is on-demand if ever needed in the UI.
- **D-21:** Spam/marketing classification does NOT enter the queue. These emails are logged to `mailbox.classification_log` for audit but dropped before draft generation. Reduces noise in the operator's primary surface.

### IMAP & SMTP Plumbing
- **D-22:** n8n IMAP trigger is the primary ingestion path. The watchdog workflow (MAIL-03, locked in Phase 1 decisions) runs every 5 minutes, checks the IMAP trigger's last execution timestamp, and restarts the trigger if stale. If the watchdog itself fails twice consecutively, an email notification fires to the operator.
- **D-23:** SMTP send uses the customer's own SMTP credentials (Gmail/Outlook OAuth2 or manual). Replies appear from the customer's address (MAIL-13). n8n Send Email node is the primary path; imapflow/nodemailer stay as fallbacks per CLAUDE.md tech stack.
- **D-24:** Email thread/reference handling (MAIL-04): extract In-Reply-To and References headers from inbound, carry them through to the draft record, apply them on SMTP send so replies thread correctly in the customer's client.

### Claude's Discretion
- **RAG chunking strategy** — probable default: per-email chunking for sent history (whole email = 1 chunk), paragraph-level chunking for uploaded PDF/DOCX. Researcher can validate against nomic-embed-text's 2K context window.
- **n8n workflow partitioning** — one main pipeline workflow (IMAP trigger → classify → route → draft → queue insert) plus side workflows (watchdog, persona refresh, cloud retry worker, onboarding ingest). Exact boundaries determined in planning.
- **Classification prompt structure** — system prompt + few-shot examples + JSON schema enforcement via Qwen3 structured output. Specific wording in planning.
- **Qdrant collection topology** — single collection vs per-customer collection. Given single-operator appliance, single collection with no payload filter is likely fine.
- **Healthcheck tuning** — per-service intervals and timeouts, same approach as Phase 1.
- **Exact Postgres DDL** — column types, indexes, constraints, FK relationships. Drizzle-orm schema file in planning.
- **Error handling specifics** — retry policies for transient failures at each pipeline stage.
- **JSON schema for classification output** — exact field names and enum values, conformant to strict JSON parser.

### Folded Todos
No todos matched Phase 2 scope — backlog was empty at phase start.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Product Requirements
- `prd-email-agent-appliance.md` — Comprehensive PRD with functional requirements FR-1 through FR-36, onboarding protocol, classification categories, approval workflow spec. Phase 2 maps to MAIL, RAG, PERS, ONBR, APPR-01, APPR-02 requirements.

### Phase Requirements
- `.planning/REQUIREMENTS.md` §Email Pipeline — MAIL-01 through MAIL-14. Acceptance criteria for IMAP, classification, routing, SMTP.
- `.planning/REQUIREMENTS.md` §RAG & Knowledge Base — RAG-01 through RAG-06. Ingest scope, retrieval thresholds, document upload.
- `.planning/REQUIREMENTS.md` §Persona — PERS-01 through PERS-05. Voice extraction, tuning interface, exemplar curation, monthly refresh.
- `.planning/REQUIREMENTS.md` §Onboarding — ONBR-01 through ONBR-06. First-boot wizard, history ingest, persona tuning session.
- `.planning/REQUIREMENTS.md` §Approval Workflow — APPR-01, APPR-02 (Phase 2 scope). APPR-03 through APPR-06 are Phase 3.

### Stack Decisions & Compatibility
- `CLAUDE.md` §Technology Stack — Version pins, memory budget. Relevant to Phase 2: Ollama 0.18.4, Qwen3-4B Q4_K_M, nomic-embed-text v1.5, Qdrant 1.17.1, n8n 2.14.2, `@anthropic-ai/sdk` latest.
- `CLAUDE.md` §Stack Patterns by Variant — Qwen3 `/no_think` directive for classification latency; n8n Anthropic Chat Model node accepts custom `claude-haiku-4-5-20251001` string.
- `CLAUDE.md` §Memory Budget — 8GB VRAM allocation. Constrains simultaneous model loading and vector index size.
- `CLAUDE.md` §What NOT to Use — Do not use Langchain/LlamaIndex inside n8n; use n8n built-in AI Agent + Ollama Model nodes.

### Prior Phase Context
- `.planning/phases/01-infrastructure-foundation/01-CONTEXT.md` §decisions — Phase 1 decisions carried forward: `mailbox` Postgres schema for app data, `.env` at repo root, Ollama no `mem_limit`, named Docker volumes, strict `depends_on` healthchecks.
- `.planning/phases/01-infrastructure-foundation/01-CONTEXT.md` §code_context — Reusable assets: `docker-compose.yml`, `scripts/init-db/00-schemas.sql`, dashboard placeholder container.

### Project State
- `.planning/STATE.md` §Accumulated Context > Decisions — Gmail OAuth Testing mode for dogfood; n8n IMAP trigger death bug requires watchdog (not optional); smoke test sources `.env` from repo root.
- `.planning/STATE.md` §Blockers/Concerns — n8n IMAP trigger death bug status on v2.14.2 needs verification before watchdog design is finalized. Researcher should check n8n issue tracker.

### Dashboard Architecture (Phase 4 input; relevant for queue API contract)
- `dashboard/prd-board-workstation-plugin-rebuild-v1.0.0-2026-04-05.md` — Board Workstation plugin-host workspace architecture. Phase 2 queue API should align with this so the Phase 4 dashboard can consume without a second rewrite.
- `dashboard/addendum-optimus-brain-plugin-dashboard-v0.2-2026-04-06.md` — Addendum clarifying that the thUMBox dashboard is a Next.js plugin-shell deployment context. Queue API should be REST + WebSocket-friendly.

### External References (researcher to fetch)
- [n8n IMAP trigger issues](https://github.com/n8n-io/n8n/issues) — Verify IMAP trigger death bug status on v2.14.2 (open blocker from STATE.md).
- [Qwen3 structured output guide](https://qwen.readthedocs.io/) — Confirm `/no_think` directive and JSON schema enforcement patterns.
- [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages) — `claude-haiku-4-5-20251001` model ID, prompt caching support for persona profile + few-shot exemplars (cost optimization).
- [nomic-embed-text v1.5 context window](https://ollama.com/library/nomic-embed-text:v1.5) — Confirm 2K token chunk ceiling for RAG chunking strategy.
- [Qdrant payload filtering](https://qdrant.tech/documentation/concepts/filtering/) — Relevant for per-category RAG retrieval if researcher determines single-collection topology.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets (from Phase 1)
- `docker-compose.yml` — All five services already running. Phase 2 adds no new services; it adds n8n workflows, Postgres schema migrations, and dashboard backend routes inside the existing dashboard container.
- `scripts/init-db/00-schemas.sql` — Creates the `mailbox` schema. Phase 2 migrations add tables inside it (via drizzle-kit, per CLAUDE.md stack).
- `dashboard/` — Placeholder container. Phase 2 replaces the nginx-only stub with an Express API backend (same container) while keeping the UI a placeholder for Phase 4.
- `.env.example` — Phase 2 adds new vars: `ANTHROPIC_API_KEY` (already scaffolded), `IMAP_*`, `SMTP_*`, `ROUTING_LOCAL_CONFIDENCE_FLOOR=0.75`.

### Established Patterns
- Checkpoint-based scripts (Phase 1) — Pattern extends to the first-boot onboarding wizard: discrete stages, each independently recoverable.
- `mailbox` schema isolation — All Phase 2 application tables go here, keeping n8n's `public` schema untouched.
- `.env` at repo root, gitignored, sourced by compose and scripts — extend for Phase 2 secrets.

### Integration Points
- **n8n → Postgres** — n8n Postgres node writes to `mailbox.draft_queue` and reads from `mailbox.persona`. Single connection pool (n8n already has Postgres config from Phase 1).
- **n8n → Ollama** — n8n Ollama Model node for classification and local drafting. Endpoint: `http://ollama:11434`.
- **n8n → Anthropic** — n8n Anthropic Chat Model node with custom `claude-haiku-4-5-20251001` model ID for cloud drafts.
- **n8n → Qdrant** — n8n HTTP Request node hitting `http://qdrant:6333` for vector search (n8n lacks a first-class Qdrant node, so HTTP is the path).
- **Dashboard Express ↔ Postgres** — New routes in `dashboard/backend/` using drizzle-orm over the `mailbox` schema. WebSocket push for queue state changes.
- **Dashboard Express ↔ n8n** — Webhook call from n8n to dashboard backend on new queue item (lets backend push realtime to Phase 4 UI).

### Known Risks / Open Questions for Research
- n8n IMAP trigger stability on v2.14.2 (Phase 1 STATE.md flagged this as a blocker). Researcher must verify before watchdog design is finalized.
- Whether nomic-embed-text v1.5 handles per-email chunking cleanly at 2K context for multi-paragraph emails, or whether per-paragraph chunking is needed.
- Whether Anthropic prompt caching is available on `claude-haiku-4-5-20251001` for persona profile + few-shot exemplars (significant cost optimization if yes).
- Gmail OAuth 2.0 Testing mode token lifetime — confirm dogfood tokens don't expire mid-Phase-2 execution.

</code_context>

<specifics>
## Specific Ideas

- Dogfood target is Dustin's Heron Labs Gmail inbox. Classification accuracy target (MAIL-08, >80% on 100-email Heron Labs corpus) is measured against hand-labeled emails from this specific inbox.
- User consistently selected recommended defaults across all four gray areas — indicates trust in conventional approaches and bias toward balanced, tunable configurations over extremes.
- The "standard" queue record shape is deliberately Phase-4-aware: every field the Phase 4 dashboard needs is present from day one, so the Phase 2 API contract doesn't need a v2 when the UI arrives.

</specifics>

<deferred>
## Deferred Ideas

- **Full edit keystroke history** — Considered for PERS-05 drift signal but rejected in favor of original+final columns. Revisit if monthly refresh proves too coarse for voice tuning.
- **Rich queue records with thread history + sentiment + sender priors** — Deferred to Phase 3 auto-send work, which actually needs these signals. Phase 2 stays with "standard" shape.
- **Global voice profile without per-category exemplars** — Rejected; per-category is in PERS-03 and the quality upside is clear.
- **12-month history backfill** — Deferred; 6 months is spec (RAG-01) and Phase 2 should not expand scope. Future consideration for operators with seasonal business cycles.
- **Redis hot cache for pending queue** — Unnecessary for v1 single-operator appliance; revisit if Phase 4 dashboard latency becomes a real issue.
- **Real-time WebSocket push from n8n → dashboard** — Dashboard subscribes to backend; n8n webhooks the backend on new queue items. Phase 2 delivers the webhook path; Phase 4 builds the WebSocket fan-out.

### Reviewed Todos (not folded)
None — todo backlog empty at phase start.

</deferred>

---

*Phase: 02-email-pipeline-core*
*Context gathered: 2026-04-13*
