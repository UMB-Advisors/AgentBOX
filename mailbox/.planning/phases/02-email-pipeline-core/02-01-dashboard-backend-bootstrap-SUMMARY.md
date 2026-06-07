---
status: superseded
plan: 02-01
superseded_by: 02-02-schema-foundation-PLAN-v2-2026-04-27.md
supersession_date: 2026-04-27
---

# 02-01 — SUPERSEDED

Architectural pivot from a separate Express backend (Drizzle ORM, ws server, Anthropic SDK in a Node 22 ESM app) to a single Next.js 14 full-stack dashboard on 2026-04-27.

The dashboard backend bootstrap that 02-01 scoped was absorbed into the existing Next.js dashboard already deployed and serving traffic on the Jetson:
- API surface lives at `dashboard/app/api/...` route handlers (not `dashboard/backend/src/`)
- DB access uses `pg` driver inside Next.js API routes (not a long-lived Express process)
- WebSocket / real-time push is deferred — the queue UI polls via `react-query` for v1
- Anthropic / Qdrant clients move into `dashboard/lib/` and are imported directly by API routes

Schema work that 02-01 was meant to scaffold for moved to **02-02 v2**, which shipped 6 forward-only SQL migrations on 2026-04-27.

No code from this plan was executed. See the architectural decision record in `.planning/STATE.md` ("Architectural Decision Record: Dashboard Stack Pivot") for the full rationale.
