# Roadmap: MBOX-498 spike demo — tagged fleet enrollment + cloud relay PoC

**Task:** Prove the recommended phone↔box architecture: enroll agentbox2 as a tagged fleet device with vendor access surviving, and demo a phone/browser with no Tailscale reaching Hermes off-LAN via a minimal authenticated cloud relay; report go/no-go on MBOX-498.
**Type:** brownfield, infra, spike
**Created:** 2026-07-03
**Total phases:** 4

## Context summary

- **Stack:** bash appliance monorepo (no package manager at root); relay PoC = Node 20+ with `ws` in `infra/relay-poc/`
- **Package manager:** npm (relay dir only)
- **Build / test / lint commands:** `bash -n install/agentbox-install.sh`; `node --check` on relay files; `node --test infra/relay-poc/`
- **Risky areas:** re-tagging agentbox2 (lockout risk), public exposure of Hermes UI via relay

## Assumptions

Non-blocking decisions recorded here so we can proceed without round-trips. If any are wrong, stop the run and tell us:

- **TS admin access = API access token** in env `TS_API_KEY` at dispatch (create at login.tailscale.com → Settings → Keys → API access token). Pre-flight checks for it.
- **Relay URL = Railway default `*.up.railway.app`** for the PoC; `relay.thumbbox.io` DNS is a documented 5-minute follow-up (DNS host for thumbbox.io not confirmed).
- **Additive grants only** on the personal tailnet; full default-deny is documented for the future staqs org tailnet, not applied here.
- Tag name `tag:box`, ownable by `autogroup:admin`; agentbox2 stays on tail377a9a for the spike.
- Relay code committed to branch `feat/mbox-498-relay-poc`; **not pushed** to origin.
- Phone-on-cellular check is manual (Eric); the automated proof is a public-internet fetch of the relay URL with relay logs showing tunnel forwarding.

## Risk top 3

1. **Tailscale SSH lockout on re-tag** — likelihood: medium, mitigation: policy rules for `tag:box` written+verified BEFORE re-tag; live safety session held open; prior prefs captured for rollback.
2. **Railway kills idle WSS** — likelihood: medium, mitigation: 25s heartbeats + auto-reconnect; post-idle e2e re-check in Phase 4.
3. **Relay exposes Hermes publicly** — likelihood: certain (by design), mitigation: 256-bit per-box token gate, dev box only, teardown/leave-up decision + "not production posture" in the go/no-go note.

## Phase map

| # | Phase | Depends on | Deliverable |
|---|-------|------------|-------------|
| 1 | Enroll box as tagged fleet device | — | agentbox2 shows `tag:box`; vendor SSH survives; grants in policy |
| 2 | Build and deploy relay | — | `infra/relay-poc/server.js` live on Railway, healthz 200, auth enforced |
| 3 | Box tunnel client + end-to-end | 2 | Hermes UI served through relay URL over public internet |
| 4 | Polish, Harden & Go/No-Go | 1,2,3 | Security sweep, evidence pack, MBOX-498 comment, committed branch |

---

## Phase 1 — Enroll box as tagged fleet device

**Why:** Proves the $1/device tagged-fleet model and that vendor OTA/SSH access survives tag-based enrollment — independent of the app/relay work.

**Deliverables:**
- Tailnet policy updated: `tag:box` tagOwner, ssh rule + grant giving vendor devices access to `tag:box` (additive)
- agentbox2 re-enrolled with `tag:box` via scoped auth key
- `infra/relay-poc/notes/phase1-tailscale.md` — what changed in policy, rollback procedure, prior state capture

**Acceptance criteria:**
- [ ] Policy file (via API) contains `tag:box` in tagOwners and an ssh/grant rule scoped to it; prior policy saved to notes dir
- [ ] Scoped auth key created (tag:box, expiring, non-reusable); key value NOT written to any committed file
- [ ] `tailscale status --json` on box shows `"tag:box"` in Tags
- [ ] Fresh `ssh agentbox2 true` exits 0 AFTER re-tag (new connection, not the safety session)
- [ ] Tailnet-only Serve still works: `https://agentbox2.tail377a9a.ts.net:9120/healthz` returns 200
- [ ] Funnel :443 config untouched (serve status unchanged vs pre-capture)

**Mandatory commands:**
- `[ -n "$TS_API_KEY" ] && echo TS_API_KEY-present`
- `ssh -o BatchMode=yes agentbox2 'tailscale status --json | head -40'` (surface Tags line)
- `ssh -o BatchMode=yes agentbox2 true; echo exit=$?`

**Evidence required:**
- Tags line from `tailscale status --json` showing tag:box
- Fresh SSH exit code 0 post-re-tag
- 200 from :9120 healthz post-re-tag

**Dependencies:** none

---

## Phase 2 — Build and deploy relay

**Why:** The consumer-plane fallback: a public HTTPS endpoint that bridges to the box's outbound WSS tunnel — no Tailscale on the client.

**Deliverables:**
- `infra/relay-poc/server.js` — WSS `/tunnel` (box side, Bearer token auth) + public HTTP `/b/<boxid>/*` proxying through the tunnel; `/healthz`
- `infra/relay-poc/package.json`, `infra/relay-poc/README.md` (run + deploy instructions, threat notes)
- `infra/relay-poc/test/relay.test.js` — local integration test (fake box client + fake origin)
- Deployed Railway service with `BOX_TOKENS` env set (generated 256-bit token)

**Acceptance criteria:**
- [ ] `node --check` passes on server.js and test files
- [ ] `node --test infra/relay-poc/` passes locally (tunnel roundtrip, bad-token rejected, unknown box 502/404)
- [ ] Railway deploy succeeds; `GET /healthz` on the public URL returns 200
- [ ] `GET /b/agentbox2/...` without valid token returns 401/403
- [ ] WSS `/tunnel` connection without valid token is rejected (shown in test or live probe)
- [ ] No secrets in the repo diff (token only in Railway env + box-side env file)

**Mandatory commands:**
- `node --check infra/relay-poc/server.js`
- `node --test infra/relay-poc/`
- `railway status` (or deploy log tail) + public-URL healthz probe via ctx_execute fetch

**Evidence required:**
- Test run summary (pass count)
- Public healthz 200 + the Railway URL
- 401 probe output

**Dependencies:** none

---

## Phase 3 — Box tunnel client + end-to-end

**Why:** Completes the demo path: box dials out, a plain browser reaches Hermes from the public internet.

**Deliverables:**
- `infra/relay-poc/box-client.js` — outbound WSS to relay, Bearer token, forwards to `127.0.0.1:9200`, 25s heartbeat, reconnect w/ backoff
- Client deployed on agentbox2 (systemd user unit `relay-poc.service` or documented nohup), token in `~/.config/relay-poc/env` (mode 600)
- e2e proof: Hermes UI fetched through the relay public URL

**Acceptance criteria:**
- [ ] Client connects and stays connected ≥2 min (relay logs show single stable tunnel + heartbeats)
- [ ] `GET <relay>/b/agentbox2/?key=<token>` over public internet returns 200 with `<title>AgentBOX — Dashboard</title>`
- [ ] `<relay>/b/agentbox2/hermes/` returns 200 `Hermes Agent - Dashboard`
- [ ] Wrong/missing token on the same paths → 401/403
- [ ] Kill client → requests fail cleanly (502/503) → client auto-reconnects within 30s and requests succeed again
- [ ] Box services undisturbed: local `:9200/healthz` still 200

**Mandatory commands:**
- `ssh agentbox2 'systemctl --user status relay-poc --no-pager | head -5'` (or process check)
- ctx_execute fetch of the two relay URLs (200 + titles) and the 401 probe

**Evidence required:**
- Fetch outputs with HTTP codes + page titles
- Reconnect sequence (timestamps) from relay/client logs

**Dependencies:** 2

---

## Phase 4 — Polish, Harden & Go/No-Go

**Why:** Catch what shipping-focused phases missed, and produce the spike's actual deliverable: the written verdict on MBOX-498.

**Sub-passes (each must produce evidence):**
- [ ] **Security** — grep repo diff for tokens/secrets (none committed); confirm relay rejects: bad token, oversized body (>10MB), non-agentbox2 boxid; HTTPS/WSS only (no ws:// or http:// endpoints served)
- [ ] **States** — relay behavior with box offline (clean 502/503 + no crash); healthz still 200 during box-offline
- [ ] **Edges** — path traversal attempt `/b/agentbox2/../` handled; websocket reconnect storm capped by backoff
- [ ] **Diff review** — `git diff --stat` + added-lines scan for debug prints/TODOs (repo-state.sh)
- [ ] **Regression sweep** — `bash -n install/agentbox-install.sh` still passes; box's :9120 Serve and :443 Funnel unchanged; fresh `ssh agentbox2 true` exit 0
- [ ] **Idle survival** — after ≥10 min idle, relay URL still serves (Railway WSS lifecycle check)

**Deliverables:**
- `docs/spikes/mbox-498-relay-poc.md` — go/no-go note: what was proven (both planes), costs observed, NOT-production caveats, branded-DNS + libtailscale next steps, leave-up/teardown decision
- Linear comment on MBOX-498 summarizing the demo results with the relay URL redacted-or-included per token posture
- All work committed atomically on `feat/mbox-498-relay-poc` (not pushed)
- Memory writeback: project memory for the relay PoC location/state

**Mandatory commands:**
- All phase 1–3 mandatory commands re-run (aggregated)
- `git diff --stat main...feat/mbox-498-relay-poc` (or staged equivalent)
- `bash -n install/agentbox-install.sh`

**Evidence required:**
- One paragraph per sub-pass with findings/fixes
- Final e2e fetch (200 + title) timestamped after the idle window
- Linear comment confirmation (comment id)
- Final `git log --oneline` of the branch

**Dependencies:** 1, 2, 3
