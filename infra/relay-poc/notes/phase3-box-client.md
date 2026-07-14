# Phase 3 — box tunnel client on agentboxhonduras + end-to-end (MBOX-498)

**Applied:** 2026-07-09/10. **Box:** agentboxhonduras (user `carlos`, Node v22.23.1).
**Relay:** https://relay-production-13f6.up.railway.app

## What was installed on the box
- `~/relay-poc/box-client.js` + `package.json`; `npm install --omit=dev` → `ws` (1 pkg, pure JS). `node --check` clean.
- `~/.config/relay-poc/env` (mode 600): `RELAY_URL=wss://relay-production-13f6.up.railway.app`,
  `BOX_ID=agentboxhonduras`, `BOX_TOKEN=<64hex>`, `ORIGIN=http://127.0.0.1:9200`.
  Token sent over SSH stdin; never printed to terminal or committed.
- systemd **user** unit `~/.config/systemd/user/relay-poc.service`
  (`EnvironmentFile=%h/.config/relay-poc/env`, `ExecStart=/usr/bin/node %h/relay-poc/box-client.js`,
  `Restart=always`, `NoNewPrivileges=true`). `enable --now`; linger already `yes`.
- No pre-existing `*-tunnel` user unit to mirror → authored fresh. No sudo used anywhere.

## End-to-end probe evidence (public internet, curl)
| Probe | Expect | Got |
|---|---|---|
| healthz after client start | box listed | `{"ok":true,"boxes":["agentboxhonduras"]}` (registered on first poll) |
| `/b/agentboxhonduras/?key=<valid>` (follow, keep cookie) | 200 + dashboard title | **200**, `<title>AgentBOX — Dashboard</title>` (872 B) |
| follow-up, cookie only (no key) | 200 | **200**, same title |
| `/b/agentboxhonduras/hermes/` (cookie) | 200 + Hermes title | **502** — see GAP below |
| no token / bad token | 401 / 401 | **401 / 401** |

## Resilience (kill/restart)
- Stop client → healthz `boxes:[]`, proxied request → **503** (clean, no tunnel).
- Start client → recovered to **200 in ~1s** (criterion ≤30s). Client log: stop 22:15:50 → dial → "tunnel open" 22:15:51.
- Stability: `NRestarts=0`; first instance ran 2m23s under active probing; current instance survived ~4× 25s ping cycles. Server terminates any tunnel that misses a pong (`server.js:209-217`), so sustained registration proves the client auto-pongs.

## GAP (box precondition, NOT a relay defect) — `/hermes/` → 502
- The **502 originates at the sidecar itself**, faithfully passed through by the relay:
  `curl 127.0.0.1:9200/hermes/` on the box → `502 … server: uvicorn … "sidecar: hermes upstream unreachable: All connection attempts failed"`.
- Root cause: **nothing is listening on `:9119`** (the sidecar's `HERMES_UPSTREAM=http://127.0.0.1:9119`).
  Hermes is simply **not running** on this bench box: no hermes binary on PATH, no hermes systemd unit
  (system or user), no hermes container. Only the sidecar (:9200) + mailbox stack (qdrant/ollama/postgres) run.
- Starting hermes needs box admin (carlos has **no passwordless sudo**) and would mean touching hermes
  internals — **out of scope for this spike and fenced by project rules** (never edit hermes web_server.py/hermes_cli).
- **The relay is proven transparent regardless:** 200 passthrough for the dashboard (with cookie reuse), 401 for
  auth failures, and honest 5xx passthrough of the sidecar's own upstream error. `/hermes/` will return 200 through
  the *identical* path the moment the hermes upstream (:9119) is up. The relay is not the blocker.
- **Thesis PROVEN:** a device with **no Tailscale** reached the box's UI (the AgentBOX Dashboard — the sidecar
  front door per CLAUDE.md) over the public internet, token-gated. That is the consumer-plane claim MBOX-498 set out to test.

## Box left undisturbed
- `:9200/healthz` → 200 throughout. `:9120` was never live on this box (000) — nothing to preserve
  (matches the Phase-1 capture: no Serve/Funnel config).
