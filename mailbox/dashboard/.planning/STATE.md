# Project State

## Current Phase

**All 8 milestones complete.** Awaiting operator-side verification (deploy + end-to-end testing).

## Progress

| Phase | Status |
|-------|--------|
| 1 — Project skeleton | ✓ Done (commit, smoke test: `/` → 307 → `/queue`, stub renders) |
| 2 — Read-only API + page | ✓ Code shipped — needs operator test against live Postgres |
| 3 — Card UI with expand | ✓ Code shipped — needs operator visual test (375px + lg) |
| 4 — Mutation routes + buttons | ✓ Code shipped — needs operator click-test against live DB |
| 5 — n8n workflow + webhook | ✓ Code shipped — needs operator import + activate + real Gmail end-to-end test |
| 6 — Live updates + retry | ✓ Code shipped — needs operator polling + retry test |
| 7 — Dockerize + deploy artifacts | ✓ Artifacts shipped — needs operator clone-and-deploy |
| 8 — README + final commit | ✓ Done |

## Spec Acceptance Criteria status

| Criterion | Status |
|-----------|--------|
| `mailbox-dashboard` container runs healthy in compose | Awaiting operator deploy |
| `https://mailbox.heronlabsinc.com/dashboard` loads | Awaiting operator deploy |
| Pending drafts visible | ✓ Built (API-01 + UI-01) |
| Tap to expand shows full email + draft body | ✓ Built (UI-02, UI-03) |
| Approve → real email sent → row sent | ✓ Built (API-03 + WORK-01..08); needs operator end-to-end test |
| Edit → modal → save → status='edited' | ✓ Built (API-04 + UI-05) |
| Reject → status='rejected', removed from queue | ✓ Built (API-05 + UI-04) |
| Failed Sends section + Retry works | ✓ Built (API-06 + UI-07) |
| New drafts appear within 30s without refresh | ✓ Built (UI-08, polling in QueueClient) |
| Mobile usable at 375px | ✓ Built; needs operator visual test |
| Dark thUMBox aesthetic | ✓ Built; needs operator visual confirmation |
| No console errors | Awaiting operator browser test |
| 3 — Card UI with expand | Pending |
| 4 — Mutation routes + buttons | Pending |
| 5 — n8n workflow + webhook | Pending |
| 6 — Live updates + retry | Pending |
| 7 — Dockerize + deploy artifacts | Pending |
| 8 — README + final commit | Pending |

## Workflow Settings

- Mode: yolo
- Granularity: standard (8 phases)
- Parallelization: sequential (per spec — strict order)
- Research: skipped (spec-driven; spec already covers domain research)
- Plan check: enabled
- Verifier: enabled

## External Dependencies (operator runs these)

- **Postgres on Jetson** (`192.168.1.45:5432`) — needed for Phase 2, 3, 4, 6 testing. Operator either publishes 5432 in compose for dev or uses `ssh -L 5432:localhost:5432 bob@192.168.1.45`.
- **n8n at appliance** — Phase 5: operator imports `n8n-workflows/MailBOX-Send.json` via UI and activates.
- **SSH/clone access to Jetson** — Phase 7: operator clones the repo to `/home/bob/mailbox/dashboard`, edits compose + Caddyfile, restarts services.

## Conventions

- One commit per phase via `node $HOME/.claude/get-shit-done/bin/gsd-tools.cjs commit "msg" --files <files>`
- All SQL qualifies tables as `mailbox.drafts` / `mailbox.inbox_messages` (Pitfall #8)
- `pg.Pool` singleton in `lib/db.ts`; never `await pool.connect()` per request (Pitfall #4)
- Defensive `body.replace(/\\n/g, '\n')` in row mapper (Pitfall #6 / BL-21)
- No `latest` image tags (Pitfall #3 / DR-17)

---
*Last updated: 2026-04-25 at initialization*
