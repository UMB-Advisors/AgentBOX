# MBOX-498 — Off-LAN box reachability spike: tagged fleet plane + cloud relay (Go/No-Go)

**Status:** spike complete (2026-07-10). **Box:** agentboxhonduras. **Author:** relay-poc run (supergoal MBOX-498).
**Verdict up front:** **GO to productize the reachability model**, with the caveats below. Both planes are
proven on real hardware over the real internet. Neither is production-ready as-built (see NOT-PRODUCTION).

MBOX-498 asked: can a **client/customer phone with no Tailscale** reach a freshly-provisioned AgentBOX's
web UI when the box is behind an arbitrary home router (no port-forward, mDNS blocked)? The research brief
proposed two planes; this spike built and exercised both end-to-end.

---

## The two planes

### Plane A — Tagged fleet (vendor/operator path) — **PROVEN**
The box is enrolled on the `tail377a9a` tailnet as a **`tag:box`** device (Phase 1). An operator who is a
tailnet member reaches it directly (SSH, `:9200`) with no per-box config. Critical property demonstrated:
**re-tagging a user-owned box to `tag:box` does NOT sever vendor SSH**, because an anti-lockout SSH rule
(`src:autogroup:member → dst:tag:box`, users `carlos`+`autogroup:nonroot`) was added to the production ACL
**before** the re-tag. The change was **additive** — the live mailbox fleet policy (`tag:mailbox`,
`tag:fleet-worker`, both fail-closed test validators, kill switches) was preserved verbatim; the Tailscale
API rejects any ACL POST that fails those tests, so a bad edit cannot apply.

- Enrollment done via the **admin device/tags API** (`POST /device/1195297404771952/tags`) rather than
  `sudo tailscale up --advertise-tags`, because the box's SSH user has **no passwordless sudo**. Cleaner,
  in-band, no console needed.
- Verified: `Self.Tags=['tag:box']`; fresh SSH exit 0 after re-tag (no lockout); `:9200/healthz` 200;
  no Serve/Funnel change. Rollback documented in `infra/relay-poc/notes/phase1-tailscale.md`.

### Plane B — Cloud relay (consumer/no-Tailscale path) — **PROVEN**
A tiny authenticated WSS relay on Railway. The **box dials OUT** to the relay and holds a persistent tunnel;
the relay exposes a public, token-gated `GET /b/<boxid>/*` that forwards to the box's sidecar
(`127.0.0.1:9200`). The phone speaks plain public HTTPS — **no Tailscale anywhere near the end user.**

```
  phone / browser                         Railway edge (TLS)                 the box (Honduras, home NAT)
  ───────────────                         ──────────────────                 ───────────────────────────
  GET https://relay-…up.railway.app          ┌───────────────┐                 ┌──────────────────────┐
      /b/agentboxhonduras/?key=<tok>  ─────►  │   relay        │◄═══ WSS /tunnel ═══│ box-client.js        │
                                              │  server.js     │  (Bearer +      │ (systemd --user)     │
   302 → HttpOnly cookie (key stripped)  ◄──  │  token gate    │   X-Box-Id,     │        │             │
   GET /b/agentboxhonduras/ (cookie)     ─────►  one tunnel/box │   25s ping)     │        ▼             │
   200  <title>AgentBOX — Dashboard</title>◄──  │  JSON+b64 frame │◄════ res frame ═══│ fetch 127.0.0.1:9200 │
                                              └───────────────┘                 │ (Hermes sidecar)     │
                                                                                └──────────────────────┘
   box dials out only → no inbound port on the home router; no public IP; no port-forward.
```

**End-to-end evidence (public internet, Phase 3):**
- `?key=<valid>` → **302** → sets `relay_agentboxhonduras` cookie (HttpOnly, SameSite=Lax, Path-scoped),
  strips token from URL → **200** `<title>AgentBOX — Dashboard</title>`. Cookie-only reuse → **200**.
- No token / wrong token → **401**. Unknown boxid → **404**. `>10MB` body → **413**. `http://` → **301→https**.
- Kill/restart the box client → clean **503** during downtime (relay stays 200), **auto-reconnect → 200 in ~1s**.
- Box client stable (systemd `--user relay-poc`, `NRestarts=0`) across many 25s heartbeat cycles.

**Observed latency (warm, small page):** relay path **~0.29–0.39s** total; box-local sidecar **~0.005s**.
The tunnel + public round-trip (client ↔ Railway ↔ Honduras box) adds **~0.3s**. Fine for a control UI.

---

## Go/No-Go verdict per plane

| Plane | Proven? | Verdict | Gate before production |
|---|---|---|---|
| **A — Tagged fleet** | Yes, on hardware | **GO** (vendor/operator use) | Lateral-movement audit of `tag:box` reachability (see next steps); confirm `tag:box` only grants what an operator needs, not tailnet-wide. |
| **B — Cloud relay** | Yes, end-to-end | **GO as the consumer fallback**, **NO-GO as-is for GA** | Branded domain + per-phone rotating tokens + rate-limit + the data-path-privacy decision below. |

**Recommendation:** ship Plane A now for vendor/operator support; treat Plane B as the customer
"reach my box from my phone" feature but **only after** the NOT-PRODUCTION list is burned down.

---

## NOT-PRODUCTION posture (must-fix before customer GA of Plane B)
1. **Single shared per-box bearer token.** One 256-bit token grants full UI access to that box. A leaked
   token = full access until rotated. No per-user/per-phone identity, no expiry, no revocation list.
2. **The relay is in the data path, unencrypted at the hop.** TLS/WSS terminate at the Railway edge; the
   relay app then speaks plain HTTP/WS to the box tunnel. Railway (and the relay process) can see all
   traffic in cleartext. This is fine for a dev PoC, **not** for customer mail content.
3. **No rate limiting, no audit log, no per-path authz.** A stolen token can be brute-force-replayed and
   nothing records access.
4. **Path hardening is incomplete.** The relay rejects only *literal* `..` segments (`server.js:146`);
   a **URL-encoded `..%2f` bypasses that check** and is forwarded to the box. Severity is **LOW** as-built
   (auth is enforced first — no/wrong token → 401; the boxid is a pinned route segment so traversal
   **cannot cross to another box** — `/b/nosuchbox/..` → 404; the only effect is the *same* box serving its
   own already-authorized content). Fix for production: decode-then-normalize the subpath before the check.
5. **Deliberately exposes the box UI to the public internet.** Dev box only until 1–4 are addressed.

## Next steps (productization)
- **DNS/branding:** `relay.thumbbox.io` (or similar) in front of the Railway service; ties to MBOX-451.
- **Per-phone tokens:** short-lived, rotating, revocable tokens minted at onboarding per device (not one
  shared box token). Consider signed cookies / an auth proxy.
- **Privacy of the data path:** either (a) end-to-end encryption so the relay can't read traffic, or
  (b) migrate the consumer plane to **libtailscale**-embedded userspace Tailscale on the phone (no separate
  app install) so it rejoins Plane A and the relay is dropped entirely. (b) is the cleaner long-term answer.
- **Ops:** rate limiting, structured access log, health/uptime alerting, token-rotation runbook.
- **Fleet audit:** confirm `tag:box` grants exactly operator-needed reachability and no more (lateral movement).

## Leave-up / teardown decision
**Default: LEAVE the PoC running** on agentboxhonduras + Railway so Carlos/Dustin can click the URL and see it.
- **Cost:** Railway Hobby/usage — a single always-on ~1 vCPU / small-memory Node service is well within the
  low single-digit-USD/month range; the tunnel is idle-cheap. Monitor the project's usage meter.
- **Security while left up:** it's a **dev box** exposing only the sidecar UI behind a 256-bit token; no
  customer data of value on it. Rotate/kill the moment it's no longer needed.
- **Teardown (one shot):**
  ```bash
  railway down --project mbox-498-relay-poc            # stop/remove the deployment (or `railway delete`)
  ssh agentboxhonduras 'systemctl --user disable --now relay-poc'   # stop the box client
  # then rotate the token (Railway env + ~/.config/relay-poc/*), and if desired roll back the ACL:
  #   re-POST infra/relay-poc/notes/prior-acl.hujson to …/tailnet/-/acl  (removes tag:box tagOwner + ssh rule)
  #   un-tag the device: POST /device/1195297404771952/tags {"tags":[]}
  ```

## Known caveat carried from Phase 3 (not a relay defect)
`/b/agentboxhonduras/hermes/` returns **502** because the **hermes upstream (`:9119`) is not running** on this
bench box (no binary/unit/container; the sidecar's `HERMES_UPSTREAM` has nothing to reach). The relay is proven
**transparent** — it serves the sidecar's dashboard (200) and honestly passes through the sidecar's own 502.
`/hermes/` will return 200 through the identical path the moment the upstream is up. Starting hermes here needs
box admin (no passwordless sudo) and touches hermes internals — out of scope for this spike and fenced by
project rules. Detail: `infra/relay-poc/notes/phase3-box-client.md`.

## Artifacts
- Code: `infra/relay-poc/` (`server.js`, `box-client.js`, `test/relay.test.js`, `README.md`) — `node --test` 7/7.
- Phase notes / rollback: `infra/relay-poc/notes/phase{1,2,3}-*.md`, `prior-acl.hujson`.
- Relay live: `https://relay-production-13f6.up.railway.app` (Railway project `mbox-498-relay-poc`, service `relay`).
- Token: Railway env + `~/.config/relay-poc/relay-token.env` (mode 600) — **never** in git.
