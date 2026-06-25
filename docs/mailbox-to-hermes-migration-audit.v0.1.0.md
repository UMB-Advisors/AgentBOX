# MailBOX dashboard → Hermes agent dash — migration audit

**Version:** 0.1.0
**Date:** 2026-06-09
**Author:** Dustin (via Claude Code audit)
**Status:** Draft for review
**Tracking epic:** MBOX-469

## TL;DR

- Decision (2026-06-09): **stop deploying the standalone `mailbox-dashboard` (Next.js, proxied at `/dashboard`). Consolidate onto the Hermes agent dashboard (`hermes-agent-main/.../web`, Vite/React, served by `hermes dashboard` :9119).** Only the "Incoming Messages" surface continues, inside the Hermes dash.
- Therefore every substantive feature that today lives **only** in `mailbox/dashboard/` must be **ported** into `hermes/web` (+ `hermes_cli` backend) to survive.
- Two buckets: **(1) open features** = recently merged to mailbox/dashboard, not yet in Hermes (MBOX-465, MBOX-460, MBOX-462); **(2) missing legacy features** = older mailbox-only surfaces (classifications, KB/RAG, VIP, tuning, persona-voice, auto-send, account registry, status dashboard, daily-brief view, email chat).

## Deployment model (ground truth)

| Surface | Stack | Served | Deploy path |
|---|---|---|---|
| **hermes/web** (target) | Vite/React | `hermes dashboard` :9119 (loopback; tunnel :9120) | `bin/deploy-dashboard.sh` → web_dist + `hermes_cli` |
| **mailbox-dashboard** (retiring) | Next.js :3001 | reverse-proxied by hermes at `/dashboard/*` → `:3001` (`hermes_cli/web_server.py:1877–1928`) | container rebuild / `mailbox-dashboard:local` / GHCR `DASHBOARD_IMAGE` (`install/agentbox-install.sh:206–214`) |

The mailbox-dashboard was reachable (proxied), but it has **no `deploy-dashboard.sh` equivalent** and nothing tracks its live image digest vs `main` — which is why merged features silently fail to ship (the MBOX-465 discovery). The decision to retire it removes that whole class of drift.

## Port backlog

### Bucket 1 — Open features (merged to mailbox/dashboard, not yet in Hermes)

| Source | Linear | Feature | Port issue |
|---|---|---|---|
| `0a5b4a2` | MBOX-465 | Provider-aware **onboarding** (M365 + IMAP connect, Azure walkthrough, app-password steps, test-connection) | **MBOX-468** |
| `37e964c` | MBOX-460 v1 | **Scheduling + calendar availability** on the incoming/queue tab | (track on MBOX-460) |
| `26c2397` | MBOX-460 | `google_calendar` → `calendar.events` **scope upgrade** + re-consent | (verify parity) |
| `bdf220d` | MBOX-462 | **Daily-brief agent job outcomes** per company/department | MBOX-479 |

### Bucket 2 — Missing legacy features (mailbox-only; no Hermes counterpart)

Verified by diffing `mailbox/dashboard/app/**/page.tsx` against `hermes/web/src/pages/`:

| mailbox route | Feature | Hermes today | Port issue |
|---|---|---|---|
| `/onboarding/*` | First-run wizard (welcome, network-check, email-connect, password, profile, complete) | none | **MBOX-471** (wraps MBOX-468) |
| `/settings/accounts` | Inbox **account registry** (add/relabel/set-default/remove) | ConnectionsPage = OAuth providers only | **MBOX-470** |
| `/classifications` | Classification mgmt / reclassify-sender | none | MBOX-472 |
| `/knowledge-base` + `/settings/kb` | RAG document upload & reconciliation | none | MBOX-473 |
| `/settings/vip` | VIP senders (urgency signals) | none | MBOX-474 |
| `/settings/tuning` | Drafting style markers / tone / prompt rules | none | MBOX-475 |
| `/settings/persona` | Persona **voice** tuning | ProfilesPage = named profiles, not voice | MBOX-476 |
| `/settings/auto-send` | Auto-send rules | none | MBOX-477 |
| `/status` | Rich operator status (queue depth, spend, latency, disk, models, n8n) | LogsPage/Analytics only | MBOX-478 |
| `/daily-brief` | Digest **view** (counts, urgent, oldest waiting) | DigestSettings = settings only | MBOX-479 |
| `/chat` | Email-corpus chat (local model + retrieval) | ChatPage = terminal/PTY | MBOX-480 (decision) |
| `/settings/workspace` | Workspace/team settings | TeamPage (partial) | MBOX-481 (parity) |

### Incoming Messages — parity check (MBOX-481)

The core queue/inbox **is** in Hermes (`InboxPage`). Confirm these draft-detail sub-features survived: redraft-with-prompt, Gmail cooldown banner, stuck-approved detection, cross-account send, sender-history, action-items push, classification override, routing badge.

## Already covered in Hermes (no port needed)

Inbox/queue core, Calendar, Drive, Contacts, Businesses, Team (CRM), Google connect + Calendar/Drive/People import, Shopify connect, Digest *settings*, Profiles, Models/Logs/Env/Cron/Sessions/Skills/Plugins/Graph (Hermes-native).

## Recommended sequencing

1. **Bucket 1 first** (freshest, highest loss-risk): MBOX-468 onboarding port, MBOX-460 queue scheduling/availability, MBOX-462/MBOX-479 job outcomes. Verify MBOX-460 scope upgrade parity.
2. **Bucket 2 by operator value**: account registry (MBOX-470) + onboarding wizard (MBOX-471) → tuning/persona/VIP (MBOX-475/476/474) → classifications/KB (MBOX-472/473) → status/daily-brief view (MBOX-478/479) → chat (MBOX-480, descope candidate).
3. Each port = hermes/web UI + confirm/extend `hermes_cli` backend route parity. Reuse the merged mailbox/dashboard impl as the reference spec.

## Open questions

- `/chat` (email-corpus): port or drop? Hermes already has a terminal chat. (MBOX-480)
- `/status`: standalone page or fold into HomePage? (MBOX-478)
- Does retiring mailbox-dashboard also move the n8n `/api/internal/*` writer endpoints into `hermes_cli`? (n8n ingestion still POSTs there — see MBOX-464/466.)

## Addendum-01 (2026-06-12)

The "Deployment model (ground truth)" table is superseded by the sidecar
decoupling PRD (`/home/bob/code/tbox/AgentBOX/docs/agentbox-sidecar-decoupling.prd.v0.1.0.md`
+ addendum). Port target for all open MBOX-469 children = **agentbox-sidecar**
(UI in `web/`, routes in the sidecar FastAPI app). Deploy path = the sidecar
runbook (`agentbox-sidecar/docs/update-runbook.md`), not `bin/deploy-dashboard.sh`.
Cross-link added to the MBOX-469 `[STATE]` comment (see L1 in the post-sidecar audit).
