# Gmail Sync Sidecar (mailbox-gmail-sync)

## What This Is

A dedicated Python/FastAPI sidecar container (`mailbox-gmail-sync`) that owns all Gmail API interactions for the MailBox One appliance — OAuth token management, History API polling, and RFC 5322 send semantics. This directory is the staging build for that sidecar, intended to merge into the parent `mailbox` repo as Phase 1 deliverable 2. n8n's role narrows to: receive webhook → classify → draft → queue → POST /send.

## Core Value

n8n can classify and draft email without ever touching the Gmail API — all email I/O flows through the sync service's narrow HTTP contract, keeping the riskiest component isolated and restartable.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Postgres schema + idempotent migrations for `oauth_tokens`, `gmail_messages`, `sync_state`
- [ ] FastAPI service scaffolding with `/health` endpoint running in Docker Compose
- [ ] Token encryption module (Fernet) + `generate-key` CLI for appliance provisioning
- [ ] OAuth2 authorization-code flow (`/oauth/start`, `/oauth/callback`) + headless CLI bootstrap
- [ ] Gmail History API poller (background asyncio task, 30s cadence, incremental sync)
- [ ] `POST /send` with RFC 5322 assembly and correct `In-Reply-To` / `References` threading
- [ ] n8n consumer workflow (webhook → Postgres → classify → draft → approval queue)
- [ ] Approval-to-send wiring (n8n polls approval queue → POST /send → update sent_at)
- [ ] E2E validation harness against Heron Labs inbox + smoke test additions

### Out of Scope

- Attachment support — Phase 1.5 scope
- `/drafts` and `/labels/apply` endpoints — Phase 1.5+
- Outlook OAuth / Microsoft Graph variant — future `mailbox-outlook-sync` sidecar
- Generic IMAP/SMTP variant — future `mailbox-imap-sync` sidecar
- Adaptive polling cadence — fixed 30s for v1; adaptive adds complexity without proven benefit
- Gmail Pub/Sub push notifications — requires public endpoint, incompatible with on-prem appliance
- Customer-specific OAuth key derivation — appliance-wide key for v1; hardening pass is Phase 2
- raw_payload pruning — retain 90 days, scheduled cleanup job is out of scope for v1.0
- n8n AI Agent node — explicit HTTP to Ollama only (debuggability per DR-1)

## Context

- **Parent project:** MailBox One appliance (`mailbox` repo, Jetson Orin Nano Super, 8GB unified VRAM)
- **Upstream state:** Phase 1 deliverables 3 (Ollama), 6 (Postgres + n8n) already operational on dev Jetson at `192.168.1.45`
- **Blocker being resolved:** Phase 1 deliverable 2 was blocked on n8n's Gmail node — flaky token refresh, opaque failure modes on long-running self-hosted instances
- **Architecture decision:** ADR-008 (proposed, pending Dustin review) — move Gmail integration out of n8n into this sidecar
- **Validation target:** Heron Labs inbox (`ops@heronlabs.com`); test account `umb-tester@gmail.com`
- **Open questions before Batch 2:**
  - OQ-1: OAuth client credentials file path on dev Jetson (`/etc/mailbox/keys/google_oauth_client.json`?)
  - OQ-2: Existing n8n classification/drafting prompts to reuse in Task 3.1?
  - OQ-3: Does `approval_queue` table already exist from Phase 1 deliverable 6?

## Constraints

- **Memory:** 200MB sustained container ceiling — leaves headroom for Qwen3-4B (2.7GB) and nomic-embed (350MB) on 8GB budget
- **Image size:** 250MB compressed — use `python:3.12-slim-bookworm` + multi-stage build
- **Runtime:** Python 3.12, FastAPI, asyncpg, `google-api-python-client` — no heavier frameworks
- **Database:** Postgres 16-alpine (existing `mailbox` Compose stack; `n8n` database)
- **Build discipline:** Single `docker build` from repo root; no host-side compilation on Jetson
- **Non-root:** Container runs as `appuser` (uid 1001), never root
- **NFR-7 (data residency):** Email content written only to local Postgres; sync service never sends content to third parties except Gmail itself
- **NFR-8 (graceful degradation):** `/health` exposes degraded state; no crash-loops when Gmail unreachable
- **DR-7 (deterministic):** No agentic behavior — all branching explicit, fixed poll cadence, no self-modification
- **NFR-5 (boot time):** `/health` returns 200 within 30s of container start

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Dedicated sidecar owns all Gmail API interaction (ADR-008) | Unblocks Phase 1 deliverable 2; isolates failure surface; enables provider portability (Outlook, IMAP) without n8n changes | — Pending (Heron Labs validation) |
| Fernet symmetric encryption for OAuth tokens | Handles IV generation + authentication; simpler than raw AES-GCM; throughput irrelevant at OAuth-token scale | — Pending |
| Appliance-wide key (`/etc/mailbox/keys/oauth.key`) for v1 | Customer-key derivation adds key-recovery complexity; v1 hardening pass is Phase 2 | — Pending |
| Fixed 30s polling cadence (no adaptive intervals) | DR-7 compliance; adaptive adds complexity without proven benefit for CPG inbox volumes | — Pending |
| Gmail History API (incremental) over full-scan polling | Dramatically more efficient; avoids quota issues at scale; requires seeding `last_history_id` on first run | — Pending |
| n8n uses explicit HTTP Request nodes to Ollama (no AI Agent node) | Debuggability; DR-1 < 20-node guideline; AI Agent adds non-determinism | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-25 after initialization from ADR-008 and build-plan-gmail-sync-sidecar-v1.0.md*
