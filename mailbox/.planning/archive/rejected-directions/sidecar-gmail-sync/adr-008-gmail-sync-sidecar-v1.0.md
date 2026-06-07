# ADR-008: Gmail Sync as a Dedicated Sidecar Service (v1.0)

> **Created:** 2026-04-24
> **Last updated:** 2026-04-24
> **Version:** 1.0
> **Status:** Proposed
> **Supersedes:** None
> **Related decisions:** DR-1 (n8n as orchestrator), DR-7 (deterministic, human-supervised pipeline)

---

## Decision: Move Gmail integration out of n8n into a dedicated `mailbox-gmail-sync` sidecar container that owns OAuth, polling, persistence, and send semantics; n8n consumes from Postgres and posts back via HTTP.

**Type:** Strategic
**Date:** 2026-04-24
**Decided by:** Pending review (Dustin)
**Status:** Proposed
**Spec sections affected:** §4.7 (FR-31), §7.2 (service topology), §7.3 (ingest pipeline), §7.4 (classification routing entry point), §14 (Phase 1 deliverable 2), NFR-7, NFR-8

---

## Context

The Phase 1 deliverable 2 (IMAP → classify → draft → queue pipeline against the Heron Labs inbox) is currently blocked on n8n's Gmail node behavior. The native node abstracts OAuth refresh and the Gmail API in ways that obscure the failure mode and make debugging difficult on a long-running self-hosted appliance. The same provider integration also has to support Outlook and generic IMAP/SMTP per FR-31, which means the integration boundary will get touched repeatedly.

Two adjacent problems compound this:

1. **Provider portability.** FR-31 requires Gmail OAuth, Outlook OAuth, and manual IMAP/SMTP. Encoding three providers as three separate n8n branches multiplies workflow complexity (already a flagged risk in §13).
2. **Appliance trust model.** Per DR-7 and NFR-7, the appliance sends business email on behalf of the customer. Any component that *touches the wire* needs to be auditable, restartable, and observable in isolation. n8n's Gmail node is not.

This ADR proposes pulling Gmail (and, by extension, the future Outlook/IMAP) integration into a small Python sidecar with a narrow contract to n8n.

---

## Evaluation

**Opportunity (4/5):** Unblocks Phase 1 deliverable 2 immediately. Establishes a clean provider-abstraction seam that Outlook and generic IMAP/SMTP plug into without changing n8n. Reduces n8n workflow node count and cognitive load (consistent with DR-1's < 20-node guideline and the §13 maintainability risk). Improves observability of the email I/O boundary — the riskiest part of the appliance from a customer-trust standpoint.

**Risk (2/5):** UMB Corp now owns a Google API integration end-to-end (token refresh, version drift, quota management). Counterfactual: this code has to exist somewhere — owning it on UMB's terms is preferable to fighting an n8n abstraction at customer sites. Failure mode is bounded: the sync service is the only component that talks to Gmail, so failures are isolated and can be restarted independently of the rest of the stack.

**Feasibility (4/5):** Python + FastAPI + `google-api-python-client` is mature, well-documented, and runs in a ~150MB image with ~50MB RAM at idle (negligible against the 8GB budget). The Heron Labs inbox is available for end-to-end validation. Estimated build effort: 8–14 hours including tests and the OAuth bootstrap CLI.

---

## Alternatives Considered

| Option | Pros | Cons | Why Not |
|--------|------|------|---------|
| **A. Keep n8n Gmail node** | Zero new infrastructure; visual workflow stays unified | Token refresh is flaky on long-running self-hosted instances; abstracts Gmail API in ways that block debugging; doesn't generalize to Outlook | The thing that's blocking Phase 1 |
| **B. Keep n8n, replace Gmail node with HTTP Request + custom OAuth** | Keeps single orchestrator; minimal new container surface area | OAuth refresh logic embedded in n8n Code Nodes is hard to test; n8n still owns Gmail-specific concerns (threading headers, label sync, history API); doesn't generalize | Same provider-coupling problem, just one layer down |
| **C. Switch Gmail to plain IMAP via n8n IMAP node** | Reuses Phase 1 IMAP path; matches the "Heron Labs inbox" framing in PRD | Loses Gmail History API (full-scan polling instead of incremental); no label management; no proper threading metadata; XOAUTH2 still required for Workspace customers | Works for the Heron Labs validation case but ships a known-degraded experience to real Gmail customers |
| **D. Dedicated Gmail sync sidecar (this ADR)** | Provider-agnostic seam; isolated failure surface; testable in CI without n8n; debuggable independently; generalizes to Outlook | UMB now owns Gmail API integration; one new container in the Compose stack | **Recommended** |
| **E. Replace n8n entirely (Windmill or code-first)** | Solves the abstraction problem at the root | Re-litigates DR-1; throws away Phase 1 work; out of scope for the immediate blocker | Wrong scope of change for the actual problem |

---

## Recommendation

**PROCEED** with Option D.

Build `mailbox-gmail-sync` as a Python/FastAPI container in the existing Compose stack. n8n's role narrows to: "react to webhook → fetch new message from Postgres → classify → draft → write back to approval queue → on approve, POST to sync service `/send`." The sync service owns everything Gmail-specific.

This is the right boundary because the riskiest, most failure-prone, most provider-specific code in the system gets isolated into a single container with a small public contract.

---

## Architectural Detail

### Service Boundary

```
┌─────────────────────────┐         ┌─────────────────────────┐
│   Gmail (cloud)         │◄────────┤  mailbox-gmail-sync     │
│                         │  HTTPS  │  (Python/FastAPI)       │
└─────────────────────────┘         │                         │
                                    │  • OAuth refresh        │
                                    │  • History API polling  │
                                    │  • RFC 5322 assembly    │
                                    │  • Label management     │
                                    └────┬────────────────┬───┘
                                         │                │
                              writes new │                │ POST /send
                              messages   │                │ (body, thread_id)
                                         ▼                │
                              ┌──────────────────┐        │
                              │  Postgres        │◄───────┤ reads to confirm
                              │  gmail_messages  │        │
                              │  oauth_tokens    │        │
                              └──────────────────┘        │
                                         ▲                │
                              POST       │                │
                              /webhook   │                │
                              (msg_id)   │                │
                                         │                │
                              ┌──────────┴────────────────┴───┐
                              │  n8n                          │
                              │  (orchestrator only —          │
                              │   no Gmail API calls)         │
                              └───────────────────────────────┘
```

### What `mailbox-gmail-sync` Owns

- OAuth2 flow (consent + token persistence + refresh, encrypted at rest in Postgres)
- History API polling (every 30s configurable) — incremental, not full-scan
- Writing new messages to `gmail_messages` table (raw payload + parsed fields)
- Notifying n8n of new messages via webhook (`POST /webhook/new-message` with `{message_id}`)
- Accepting send requests (`POST /send` with `{to, subject, body, thread_id, in_reply_to}`)
- Assembling RFC 5322 messages with correct `References` and `In-Reply-To` headers
- Creating Gmail drafts (`POST /drafts`)
- Label management (apply/remove labels on message IDs)
- Health endpoint for smoke test (`GET /health`)

### What n8n Owns (Unchanged from PRD)

- Classification routing (§7.4)
- RAG pipeline orchestration (§7.5, §7.5.1)
- Draft generation prompt assembly
- Approval queue management
- All non-email workflows (knowledge base ingestion, dashboard backend, etc.)

### What n8n No Longer Owns

- Anything Gmail-specific. n8n never imports the Gmail node, never holds OAuth tokens, never assembles MIME, never knows about labels.

### Postgres Schema (Owned by Sync Service)

```sql
-- Owned by mailbox-gmail-sync; n8n reads from gmail_messages but does not write.

CREATE TABLE oauth_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider        TEXT NOT NULL CHECK (provider IN ('gmail', 'outlook')),
    account_email   TEXT NOT NULL,
    access_token    BYTEA NOT NULL,           -- encrypted
    refresh_token   BYTEA NOT NULL,           -- encrypted
    token_expiry    TIMESTAMPTZ NOT NULL,
    scopes          TEXT[] NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, account_email)
);

CREATE TABLE gmail_messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    gmail_message_id TEXT NOT NULL UNIQUE,    -- Gmail's immutable ID
    gmail_thread_id  TEXT NOT NULL,
    history_id       BIGINT NOT NULL,         -- for incremental sync
    account_email    TEXT NOT NULL,
    from_email       TEXT NOT NULL,
    from_name        TEXT,
    to_emails        TEXT[] NOT NULL,
    cc_emails        TEXT[],
    subject          TEXT,
    body_text        TEXT,
    body_html        TEXT,
    internal_date    TIMESTAMPTZ NOT NULL,
    raw_payload      JSONB NOT NULL,          -- full Gmail API response
    labels           TEXT[],
    ingested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    notified_at      TIMESTAMPTZ              -- when n8n webhook fired
);

CREATE INDEX idx_gmail_messages_thread ON gmail_messages (gmail_thread_id);
CREATE INDEX idx_gmail_messages_unnotified ON gmail_messages (ingested_at) WHERE notified_at IS NULL;

CREATE TABLE sync_state (
    account_email           TEXT PRIMARY KEY,
    last_history_id         BIGINT NOT NULL,
    last_poll_at            TIMESTAMPTZ NOT NULL,
    last_successful_poll_at TIMESTAMPTZ,
    consecutive_failures    INT NOT NULL DEFAULT 0
);
```

### HTTP Contract

| Method | Path | Caller | Purpose |
|--------|------|--------|---------|
| `GET` | `/health` | smoke-test, dashboard | Liveness + last-successful-poll timestamp |
| `POST` | `/oauth/start` | onboarding wizard (FR-30, FR-31) | Returns Google consent URL |
| `POST` | `/oauth/callback` | Google redirect | Exchange code → store tokens |
| `POST` | `/send` | n8n (on approve) | Send a reply; returns `{gmail_message_id, thread_id}` |
| `POST` | `/drafts` | n8n (Phase 1.5+) | Create a Gmail draft instead of sending |
| `POST` | `/labels/apply` | n8n (Phase 1.5+) | Apply labels to a message |
| `POST` | `/sync/now` | dashboard, smoke-test | Force an immediate History API poll |

n8n is the *receiver* of one endpoint owned by it: `POST /webhook/new-message` (called by the sync service when a new message lands). This is the only inbound edge n8n exposes for the email pipeline.

---

## Decision Implications

### NFR Compliance

| NFR | Impact | Notes |
|-----|--------|-------|
| NFR-2 (latency) | Neutral to positive | Polling cadence (30s) is the dominant factor; webhook hop is < 50ms |
| NFR-5 (3-min boot) | Neutral | One additional small container (~150MB image, fast cold start) |
| NFR-7 (data residency) | Improved | Email content never enters n8n's persistence; sync service is the only writer to `gmail_messages` |
| NFR-8 (graceful degradation) | Improved | Sync service can fail independently — n8n keeps working on already-ingested messages; drafts queue as "awaiting send" until sync recovers |

### DR-7 Compliance (Deterministic Pipeline)

The sync service is fully deterministic: poll cadence, webhook semantics, send semantics are all explicit. No agentic behavior. Adopts the appliance's existing safety model.

### Provider Portability

A future `mailbox-outlook-sync` container implements the same HTTP contract (modulo OAuth scopes and Microsoft Graph instead of Gmail API). n8n's workflow does not change to support Outlook — the routing of "which sync service to POST to on send" becomes a per-account config lookup.

For generic IMAP/SMTP customers (FR-31), a `mailbox-imap-sync` variant covers the same contract. Same n8n workflow, three sync containers.

---

## Kill Criteria

Reverse this decision if any of the following are observed during Phase 1 build or Heron Labs validation:

- **KC-1:** Sync service end-to-end latency (Gmail → n8n webhook fired) exceeds 60s p95 — indicates polling architecture is wrong (would force a Pub/Sub-push redesign incompatible with on-prem appliance)
- **KC-2:** OAuth refresh failures exceed 1 per 1000 polls in 7-day Heron Labs run — indicates token-refresh logic is not robust enough for the appliance trust model
- **KC-3:** Sync service container memory exceeds 200MB sustained — indicates implementation drift (would compete with the 8GB inference budget)
- **KC-4:** n8n still requires Gmail-specific code paths after sync service is in place — indicates the boundary is wrong and needs redrawing

---

## Cost Impact

- **Build cost:** 8–14 hours (Claude Code + GSD does most of it). Single developer.
- **Monthly operating impact:** $0. No new external services. Negligible additional power draw on the appliance.
- **Budget requirement:** $0. Uses existing infrastructure.
- **Opportunity cost:** Phase 1 deliverable 2 unblocked; Outlook support (Phase 1.5) becomes additive rather than another integration-from-scratch.

---

## Dependencies

- **Depends on:** Phase 1 deliverables 3 (Ollama running), 6 (Postgres + n8n running). Both already operational on the dev Jetson.
- **Blocks:** Phase 1 deliverable 2 (the IMAP→classify→draft→queue pipeline against Heron Labs inbox).
- **Enables:** FR-31 Outlook OAuth support (Phase 1.5+) via parallel sidecar; future Microsoft Graph and IMAP/SMTP variants.

---

## Confidence

**4/5.** The architectural pattern (sidecar with narrow HTTP contract) is well-understood. The Gmail API and `google-api-python-client` are mature. The main residual uncertainty is OAuth token-refresh edge cases under sustained operation, which is exactly what the Heron Labs 7-day validation run will surface.

---

## Open Questions

- **OQ-1:** Should the sync service's OAuth tokens be encrypted with a customer-specific key derived from the dashboard admin password, or with an appliance-wide key in `/etc/mailbox/keys/`? Affects: NFR-7 interpretation, key recovery flow during golden image restore. **Tentative answer:** Appliance-wide key for v1, customer-key derivation in a later hardening pass. Document explicitly.
- **OQ-2:** Polling cadence — fixed 30s, or adaptive (faster during business hours, slower overnight)? **Tentative answer:** Fixed 30s for v1. Adaptive adds complexity without proven benefit.
- **OQ-3:** Should `gmail_messages.raw_payload` be retained indefinitely or pruned after ingestion is confirmed? **Tentative answer:** Retain for 90 days (debugging value), prune via scheduled job after that. Out of scope for v1.0 build.

---

## Spec Section Updates Required (post-approval)

Apply via addendum entry once approved:

- **§4.7 FR-31** — amend to clarify that Gmail OAuth is handled by the sync service, not n8n directly
- **§7.2** — add `mailbox-gmail-sync` to service topology table
- **§7.3** — replace "n8n IMAP node" with "sync service → Postgres → n8n webhook" in the ingest pipeline diagram
- **§14 Phase 1, deliverable 2** — replace "n8n Gmail integration" with "Gmail sync service + n8n consumer workflow"
- **§16 (decision records)** — promote this ADR to DR-8 in the merged spec
