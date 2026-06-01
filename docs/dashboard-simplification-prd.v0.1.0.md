# Dashboard Simplification PRD

**Version:** 0.3.0
**Date:** 2026-06-01
**Target:** `hermes-agent/web` (React 19 + Vite + react-router 7 + Tailwind 4)
**Status:** Draft — awaiting go-ahead to implement Phase 1

---

## TL;DR

Collapse the dashboard's 12-item built-in nav (+ plugin tabs) down to **5 primary
items + a Settings hub**. Make **Chat a persistent, collapsible right panel** instead
of a routed tab. Replace the `/sessions` landing with a new **gbrain-backed Digest
("most important info") pane** as the center default. Calendar and Achievements round
out the nav; Calendar is a placeholder this pass, Achievements and Kanban already exist
as plugins. No routes are deleted — demoted views keep their paths and move under
Settings, so deep-links and plugin tabs keep working.

---

## Current state (as built)

- **App:** `web/src/App.tsx` builds the sidebar from `CHAT_NAV_ITEM` + `BUILTIN_NAV_REST`
  (Sessions, Analytics, Models, Logs, Cron, Skills, Plugins, Profiles, Config, Keys,
  Documentation) merged with plugin tabs via `buildNavItems()` / `partitionSidebarNav()`.
- **Landing:** `RootRedirect` → `/sessions`.
- **Chat:** already supports a "persistent chat host" rendered **outside `<Routes>`** when
  `embeddedChat` is on (PTY/WebSocket/xterm survive tab switches; `display:none` toggle).
  `/chat` route is a `ChatRouteSink` placeholder so the catch-all redirect doesn't fire.
- **Plugins providing tabs:** `kanban` → `/kanban`, `hermes-achievements` → `/achievements`,
  `example-dashboard` → `/example`, plus others. Tabs self-position via manifest
  `tab.position` (`after:`/`before:`/`end`).

## Target nav

| Primary nav item | Route | Source | Change |
|---|---|---|---|
| **Home** | `/` (or `/home`) | net-new Digest page | NEW — gbrain "most important info" |
| **Incoming Messages** | `/inbox` | local embed of `mailbox-dashboard` `/dashboard/queue` | NEW local plugin (replaces tailnet `mailbox1`); Inbox icon |
| **Calendar** | `/calendar` | net-new | NEW — placeholder shell |
| **Tasks** | `/kanban` | existing `kanban` plugin | reuse as-is (Linear swap = later phase) |
| **Scheduled Actions** | `/cron` | existing `CronPage` | relabel only |
| **Achievements** | `/achievements` | existing `hermes-achievements` plugin | reuse as-is |
| **⚙ Settings** | `/settings` | net-new hub | NEW — hosts demoted items |

**Right panel:** persistent collapsible **Chat** (reuse the existing embedded-chat host).
No "Chat" nav item.

**Demoted under Settings** (routes preserved, removed from primary sidebar):
Sessions, Analytics, Models, Logs, Skills, Plugins, Profiles, Config, Keys, Documentation,
and any non-primary plugin tabs (example, observability, etc.).

## Layout

```
┌──────────┬───────────────────────────┬──────────────┐
│ LEFT NAV │ CENTER (active route)     │ RIGHT: CHAT  │
│ Home     │  landing = Daily Digest   │ persistent,  │
│ Inbox    │  → Incoming Messages /    │ collapsible  │
│ Calendar │    Calendar / Tasks /     │ (embedded    │
│ Tasks    │    Scheduled Actions /    │  chat host)  │
│ Sched.Act│    Achievements /         │              │
│ Achievmts│    Settings/*             │              │
│ ⚙ Settings│                          │              │
└──────────┴───────────────────────────┴──────────────┘
```

## Incoming Messages wiring (single-box, no tailnet)

AgentBOX is **one box** — MailBOX stack + Hermes are co-resident — so the original
two-appliance tailnet embed is retired. Data path, all local:

```
Gmail → n8n "MailBOX" workflow (every-minute poll + ollama classify)
      → postgres mailbox.inbox_messages / mailbox.drafts
      → mailbox-dashboard:3001  /dashboard/queue  (Next.js, reads mailbox.drafts status=pending)
      → iframe in Hermes /inbox tab  (http://127.0.0.1:3001/dashboard/queue)
```

- **Retire:** `provisioning/mailbox1-embed` entirely — the `mailbox-kiosk-proxy` Caddy,
  `Caddyfile.kiosk`, the `100.65.9.2:8090` Tailscale bind, and the `mailbox1` plugin.
- **Replace with:** a local `inbox` dashboard plugin whose iframe `src` is the localhost
  dashboard (`http://127.0.0.1:3001/dashboard/queue`). `mailbox-dashboard`'s `next.config.js`
  sets no `X-Frame-Options`/CSP, so no header-stripping proxy is needed.
- **Requires:** `mailbox-dashboard` published on `127.0.0.1:3001` (localhost-only, matching the
  Hermes dashboard's own `--insecure` localhost posture). Verify/add in MailBOX compose.
- Same security posture as the existing 9119 kiosk: localhost-only, single operator.

---

## Phases

### Phase 1 — Nav restructure + Settings hub (no new data)
- Introduce `PRIMARY_NAV` allowlist: Home, Incoming Messages(`/inbox`), Calendar,
  Tasks(`/kanban`), Scheduled Actions(`/cron`), Achievements.
- Replace the tailnet `mailbox1` plugin with a local `inbox` plugin (Inbox icon) that
  iframes `http://127.0.0.1:3001/dashboard/queue`; retire `provisioning/mailbox1-embed`.
- Ensure `mailbox-dashboard` is published on `127.0.0.1:3001`.
- Move all other built-in + plugin tabs into a **Settings hub** page (`/settings`)
  that links to their preserved routes (grouped list).
- Drop `CHAT_NAV_ITEM` from the sidebar; keep the persistent chat host.
- Relabel Cron → "Scheduled Actions" (nav + page title; keep `/cron`).
- Add `/calendar` placeholder page and a Home page (temporary placeholder until Phase 3).
- Repoint `RootRedirect` / landing from `/sessions` → Home.
- **Exit criteria:** sidebar shows exactly 6 items (Home, Incoming Messages, Calendar,
  Tasks, Scheduled Actions, Achievements) + Settings; every demoted view
  reachable via Settings; chat panel persistent + collapsible; no dead routes.

### Phase 2 — Persistent right-panel chat polish
- Ensure embedded-chat host renders as a right-docked, resizable, collapsible panel
  across all routes (not just `/chat`). Persist collapsed/width state.
- **Exit criteria:** chat visible and usable on every primary view; toggle hides/shows
  without losing the session.

### Phase 3 — Digest landing (gbrain)
- Define the digest contract from gbrain (most-recent daily digest / most-important info).
- Backend: dashboard API endpoint that reads the latest digest from gbrain.
- Frontend: Home page renders the digest (loading/empty/error states).
- **Exit criteria:** landing shows the real most-recent digest from gbrain.

### Phase 4 (later) — Calendar data + Kanban→Linear
- Calendar: wire to a real source (TBD).
- Tasks: swap local `kanban.db` for Linear (token + sync/query layer).

---

## Open items / assumptions

- **Home route:** use `/` for Home (digest) and retire the `/sessions` redirect; Sessions
  remains reachable at `/sessions` via Settings. (Assumption — easy to change.)
- **Settings hub vs. sub-nav:** Phase 1 ships a simple grouped link hub at `/settings`;
  a nested left sub-nav can come later if desired.
- **gbrain digest contract** (Phase 3): exact shape/endpoint TBD — needs how MailBOX
  writes digests into gbrain.
- Plugin tabs that should stay primary vs. demoted: currently only `kanban` +
  `achievements` are primary; all other plugin tabs demote to Settings.
