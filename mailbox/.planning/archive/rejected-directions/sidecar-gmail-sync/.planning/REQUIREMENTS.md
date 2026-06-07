# Requirements: Gmail Sync Sidecar (mailbox-gmail-sync)

**Defined:** 2026-04-25
**Core Value:** n8n can classify and draft email without ever touching the Gmail API — all email I/O flows through the sync service's narrow HTTP contract.

## v1 Requirements

### Infrastructure

- [ ] **INFRA-01**: Postgres schema and idempotent UP/DOWN migrations for `oauth_tokens`, `gmail_messages`, `sync_state` tables with specified indexes
- [ ] **INFRA-02**: FastAPI service (`services/gmail-sync/`) scaffolded in Docker Compose with `/health` returning 200 within 30s of container start
- [ ] **INFRA-03**: Service runs as non-root user (`appuser` uid 1001), image ≤ 250MB compressed, ≤ 200MB RAM at sustained load
- [ ] **INFRA-04**: Token encryption module (Fernet) with `generate-key` and `bootstrap-oauth` CLI commands

### OAuth

- [ ] **AUTH-01**: `POST /oauth/start` returns Google consent URL for a given account email
- [ ] **AUTH-02**: `POST /oauth/callback` exchanges auth code, encrypts tokens, writes to `oauth_tokens`; tampered state returns 400
- [ ] **AUTH-03**: `python -m app.cli bootstrap-oauth` connects to appliance Postgres and stores tokens via same code path as HTTP endpoint
- [ ] **AUTH-04**: `/health` reports `oauth_status` as `ok | expired | missing` based on `oauth_tokens` state

### Polling

- [ ] **POLL-01**: Background asyncio task polls Gmail History API every 30s per account; seeds `last_history_id` from most-recent message on first run
- [ ] **POLL-02**: New messages written to `gmail_messages` (idempotent on `gmail_message_id` UNIQUE); `sync_state.last_history_id` updated to max seen
- [ ] **POLL-03**: Each new message triggers `POST http://n8n:5678/webhook/gmail-new-message`; `notified_at` set on 200; unnotified messages retried next cycle
- [ ] **POLL-04**: Poller handles token refresh failure, 429, 5xx, and network unreachable without crash-looping; exposes failure state via `/health`
- [ ] **POLL-05**: `POST /sync/now` triggers immediate single-account poll cycle (for smoke test and dashboard)

### Send

- [ ] **SEND-01**: `POST /send` assembles RFC 5322 MIME with correct `In-Reply-To` and `References` headers; sends via Gmail API with `threadId`
- [ ] **SEND-02**: Threading: if `in_reply_to` set, fetches original message headers from `gmail_messages`; `References` chain capped at 10
- [ ] **SEND-03**: Validation rejects empty `to`, empty `subject`, empty `body_text` with 422
- [ ] **SEND-04**: Gmail API error returns 502 with error message; no retry (n8n owns retry policy)

### n8n Integration

- [ ] **N8N-01**: n8n workflow `workflows/gmail-inbound-pipeline.json` reacts to `/webhook/gmail-new-message`, classifies via Ollama, drafts, inserts to `approval_queue`; ≤ 20 nodes; webhook authenticated with shared secret
- [ ] **N8N-02**: n8n workflow `workflows/approval-to-send.json` polls `approval_queue` for `customer_action='approve' AND sent_at IS NULL`, POSTs to `/send`, updates `sent_at` on success or `customer_action='send_failed'` on error

### Validation

- [ ] **VAL-01**: E2E test harness (`tests/e2e/test_full_loop.py`) covers: send test email → ingested in `gmail_messages` → `approval_queue` row created → programmatic approve → `sent_at` populated → reply verified in sender inbox with correct `In-Reply-To`; cleans up after itself
- [ ] **VAL-02**: `scripts/smoke-test.sh` extended to verify gmail-sync container health, `oauth_status: ok`, and recent `last_successful_poll_at`

## v2 Requirements

### Provider Portability

- **PROV-01**: `mailbox-outlook-sync` sidecar implements identical HTTP contract via Microsoft Graph API
- **PROV-02**: `mailbox-imap-sync` sidecar implements identical HTTP contract for generic IMAP/SMTP
- **PROV-03**: n8n send routing resolves which sync service to target based on per-account config

### Enhanced Send

- **SEND-05**: `POST /send` supports file attachments
- **SEND-06**: `POST /drafts` creates Gmail draft without sending (Phase 1.5+)

### Label Management

- **LABL-01**: `POST /labels/apply` applies Gmail labels to message IDs (Phase 1.5+)

### Token Security

- **SEC-01**: Customer-specific OAuth key derived from dashboard admin password (v1 uses appliance-wide key)

### Maintenance

- **MAINT-01**: `raw_payload` pruned after 90 days via scheduled job

## Out of Scope

| Feature | Reason |
|---------|--------|
| Gmail Pub/Sub push notifications | Requires public endpoint — incompatible with on-prem appliance |
| Adaptive polling cadence | Adds complexity; DR-7 requires deterministic behavior |
| n8n AI Agent node | Non-deterministic; DR-1 < 20-node guideline; explicit HTTP to Ollama only |
| Langchain / LlamaIndex in n8n | Duplicates n8n native capabilities; adds Python runtime dependency |
| Retry logic in send endpoint | n8n owns workflow-level retry; sync service returns error on first failure |
| Session/cookie layer on sync service | No UI, no logged-in users; dashboard handles auth |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| INFRA-01 | Phase 1 — Foundation | Pending |
| INFRA-02 | Phase 1 — Foundation | Pending |
| INFRA-03 | Phase 1 — Foundation | Pending |
| INFRA-04 | Phase 1 — Foundation | Pending |
| AUTH-01 | Phase 2 — Core Sync Service | Pending |
| AUTH-02 | Phase 2 — Core Sync Service | Pending |
| AUTH-03 | Phase 2 — Core Sync Service | Pending |
| AUTH-04 | Phase 2 — Core Sync Service | Pending |
| POLL-01 | Phase 2 — Core Sync Service | Pending |
| POLL-02 | Phase 2 — Core Sync Service | Pending |
| POLL-03 | Phase 2 — Core Sync Service | Pending |
| POLL-04 | Phase 2 — Core Sync Service | Pending |
| POLL-05 | Phase 2 — Core Sync Service | Pending |
| SEND-01 | Phase 2 — Core Sync Service | Pending |
| SEND-02 | Phase 2 — Core Sync Service | Pending |
| SEND-03 | Phase 2 — Core Sync Service | Pending |
| SEND-04 | Phase 2 — Core Sync Service | Pending |
| N8N-01 | Phase 3 — n8n Integration | Pending |
| N8N-02 | Phase 3 — n8n Integration | Pending |
| VAL-01 | Phase 4 — Validation | Pending |
| VAL-02 | Phase 4 — Validation | Pending |

**Coverage:**
- v1 requirements: 21 total
- Mapped to phases: 21
- Unmapped: 0 ✓

---
*Requirements defined: 2026-04-25*
*Last updated: 2026-04-25 after initialization from build-plan-gmail-sync-sidecar-v1.0.md*
