# Phase 2 — relay deployed on Railway (MBOX-498)

**Applied:** 2026-07-10 (UTC build stamp). **Consumer-plane PoC** — public HTTPS ↔ box
outbound tunnel, no Tailscale near the end user.

## Deploy facts
- **Workspace:** Staqs (`a3868405-0bd6-4db1-abfe-910dd57d5511`)
- **Project:** `mbox-498-relay-poc` (`b9747503-a991-419a-bf2c-36a055b59541`), env `production`
- **Service:** `relay` (Nixpacks/railpack auto-build from `package.json` `start` = `node server.js`)
- **Public URL:** `https://relay-production-13f6.up.railway.app` (domain id `a55d57c8-e6d5-48cf-bff5-af5618854a52`)
- **Runtime env:** `BOX_TOKENS=agentboxhonduras:<64hex>` — set in Railway service env ONLY.
  Same token mirrored at `~/.config/relay-poc/relay-token.env` (mode 600, OUTSIDE the repo)
  as `RELAY_BOX_TOKEN`/`BOX_TOKENS`, plus `RELAY_URL`, for the Phase-3 box client.
  **No token value is in the repo, git diff, or this file.**

## Probe evidence (public side, curl)
| Probe | Expect | Got |
|---|---|---|
| `GET /healthz` | 200 `{ok:true,boxes:[]}` | **200** (`boxes:[]` — no tunnel yet) |
| `GET /b/agentboxhonduras/` (no key) | 401 | **401** |
| `?key=<valid>` (no cookie) | 302 → set HttpOnly cookie, strip key | **302**, `set-cookie: relay_agentboxhonduras=…; HttpOnly; SameSite=Lax; Path=/b/agentboxhonduras` |
| `?key=<valid>` followed (cookie, no tunnel) | 503 | **503** |
| `Authorization: Bearer <valid>` (no tunnel) | 503 | **503** |
| `?key=WRONG` | 401 | **401** |

Local gates: `node --check` clean (server/client/test); `node --test` = **7 pass / 0 fail**.

## Teardown / rollback (Phase 4 or end of spike)
```bash
railway down --service relay -y            # remove the running deployment
# or delete the whole project:
railway delete --project mbox-498-relay-poc   # (confirm interactively) — nukes service+domain+env
```
Then revoke/rotate the token (it's only in Railway env + the local 600 file) and, if the
box client was installed in Phase 3, stop+disable its systemd user unit.

## Threat posture (unchanged from README)
Public HTTPS gated ONLY by a 256-bit per-box bearer token; dev box only; TLS terminates at
Railway edge (plain HTTP/WS behind it); no rate-limit / audit-log / per-path authz. A leaked
token = full Hermes UI access until rotated. This is the no-Tailscale consumer fallback, NOT
the vendor path (that's the tag:box Tailscale plane from Phase 1).
