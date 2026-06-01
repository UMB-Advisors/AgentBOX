# State — Unified Inbox
Source PRD: unified-inbox-prd.v0.1.0.md (v0.2.0)
Roadmap: ROADMAP-v1.0.0.md
Last updated: 2026-06-01T00:00:00Z

## Active phase
Phase 0: Channel-agnostic schema — executing

## Phase status
| Phase | Status | Linear milestone | Notes |
|-------|--------|------------------|-------|
| 0 | executing | — | Channel-agnostic schema: `accounts`, generalized `inbox_messages`/`drafts`, `credentials`; backfill email rows (channel='email'). First unblocked phase. Exit: existing email pipeline still works on new schema. |
| 1 | pending | — | Native inbox (email-only): dashboard API over mailbox DB + native React Inbox/Draft pages; retire `/dashboard` iframe. Depends on Phase 0. |
| 2 | pending | — | Channels via hybrid pipeline (D3): n8n ingest webhook + generalized normalize→classify→draft built once, then onboard channels in waves (email multi-account → Telegram/Discord/Slack → WhatsApp/Signal/SMS → Teams/Matrix). Depends on Phase 0, 1. |
| 3 | pending | — | Extend Keys/Env page (D4) for all creds: channel accounts + app-passwords, rotate + test connection; write-through to env/OAuth backends + `credentials` table + n8n credential API. Depends on Phase 0. |
| 4 | pending | — | Per-channel send path: approve→send routes back to originating channel via n8n send flows. Depends on Phase 0, 1, 2. |

## Linear
- Project: — (populated in Track)
- Team: — (populated in Track)

## Open decisions
- **Native UI needs DB access** (PRD §Key risks; §Target architecture / Components 3; Phase 1). "Native-merge" requires the Hermes dashboard server to reach the mailbox Postgres. Decision needed: extend `hermes_cli/web_server.py` (Python → mailbox PG) vs. keep the Next API and consume it via fetch. PRD recommends extending `web_server.py`. Blocks Phase 1 detail.
- **Credential write-through is security-critical** (PRD §Key risks; §Components 5; Phase 3). Rotating OAuth tokens + app passwords + n8n stored credentials from the UI is the riskiest surface: encryption at rest, no secret readback, audit trail. Threat-model required before building Phase 3.
- **Per-channel auth/setup is uneven** (PRD §Key risks; Phase 2 waves c/d). WhatsApp Business API, Signal, and SMS (Twilio) are heavier to provision than bot-token channels (Telegram/Discord/Slack). Affects Phase 2 wave sequencing and effort estimates.

## Drift watch
- (empty)
