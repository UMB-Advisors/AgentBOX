# MailBox One Dashboard

## What This Is

Standalone Next.js 14 dashboard for the MailBox One T2 appliance. Exposes a human-in-the-loop approval queue for LLM-generated email drafts; on approve, triggers a real Gmail send via an n8n webhook.

This closes Phase 1 deliverable #6 (dashboard approval queue) and ships workflow #3 (send pipeline) of the MailBox One product roadmap.

## Core Value

The operator can review, edit, approve, or reject LLM-drafted email replies on their phone in under 30 seconds, and approval results in a real Gmail reply going out. Without the dashboard, drafts sit in `mailbox.drafts` with no path to send.

## Context

- **Hardware:** NVIDIA Jetson Orin Nano 8GB Developer Kit Super (T2 tier). Dashboard runs as a 7th container alongside Postgres 17, Ollama (qwen3:4b-ctx4k), n8n 1.123.35, Qdrant 1.17, Caddy.
- **Existing pipeline:** Two autonomous n8n workflows already running on 5-min cadence: `MailBOX` (Gmail poll → classify → persist to `mailbox.inbox_messages`) and `MailBOX-Drafts` (poll for `action_required + draft_id IS NULL` → generate via NVIDIA NIM Llama 3.3-70B → persist to `mailbox.drafts`).
- **Schema:** `mailbox.inbox_messages` and `mailbox.drafts` already exist (DO NOT recreate). Bidirectional FK: `drafts.inbox_message_id` → `inbox_messages.id` and `inbox_messages.draft_id` → `drafts.id`.
- **Deployment target:** Lives in `/home/bob/mailbox/docker-compose.yml` on the Jetson at `192.168.1.45`. Caddy reverse-proxies at `https://mailbox.heronlabsinc.com/dashboard`.
- **User:** Single operator (Dustin). LAN-only. No auth in v1 — auth comes Phase 1.5.
- **Spec source:** `.planning/spec/mailbox-dashboard-build-spec-v0_1-2026-04-25.md` (with build log v0.9 and T2 build validation addendum as references).

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Dashboard scaffold runs locally and in Docker on ARM64
- [ ] /queue surface lists pending drafts joined with email context
- [ ] Operator can approve, edit, or reject each draft from a mobile browser at 375px
- [ ] Approve triggers n8n MailBOX-Send → real Gmail reply leaves the inbox
- [ ] Failed sends surface with error message and retryable
- [ ] New drafts appear within 30s without manual refresh
- [ ] Container deployed to Jetson via compose, reachable at `mailbox.heronlabsinc.com/dashboard`

### Out of Scope (v1)

- Authentication / user accounts — Phase 1.5 (single user + LAN trust now)
- Sent history view — Phase 2
- Classification log view — Phase 2
- Persona/skill management UI — Phase 2
- RAG context display — Phase 2 (deliverable #5)
- Multi-account support — Phase 2
- Light mode toggle — never (dark only by design)
- Plugin manifest / optimus-bu integration — deferred refactor
- WebSocket / SSE — polling sufficient for single user
- Optimistic concurrency control — single user, low contention
- Drag-and-drop reordering / custom keyboard shortcuts
- Subdomain (`dashboard.mailbox.heronlabsinc.com`) — `/dashboard` path prefix avoids DNS changes in v1

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Spec's 8 milestones used as GSD phases verbatim | Spec is comprehensive, well-scoped, and ordered. Re-deriving wastes effort. | — Pending |
| Next.js app at working dir root (not subdir) | Working dir `mailboxdashboard` only contains this app. Cleaner. | — Pending |
| `pg` library, no ORM | Spec mandates. Single user, low contention, simple queries. | — Pending |
| No auth, LAN-only | Operator's own appliance; trust model is "I trust everyone on my Wi-Fi." Auth → Phase 1.5. | — Pending |
| HTTP webhook to n8n on approve (not direct Gmail call from dashboard) | Keeps Gmail credential in n8n; consistent with workflows #1/#2; survives provider swap. | — Pending |
| Defensive `\n` literal escape replace in `lib/db.ts` row mapper | Existing rows in `mailbox.drafts` may contain literal `\nDustin` from Llama 3.3 (BL-21). Apply on read; don't trust upstream sanitization. | — Pending |
| Polling at 30s, not WebSocket/SSE | Spec accepts; simplicity over feature creep for v1. | — Pending |
| `/dashboard` path prefix on Caddy, not subdomain | No DNS changes needed for v1. Subdomain is a Phase 1.5 cleanup. | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition:**
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone:**
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-25 after initialization*
