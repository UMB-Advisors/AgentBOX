# State: MBOX-498 spike demo — tagged fleet enrollment + cloud relay PoC

**Status:** CONVERGED
**Current phase:** 4 (complete — independent Verifier CONVERGED)
**Started:** 2026-07-03
**Last update:** 2026-07-10

> **ON RESUME (wake-driven):** Phase 4 sub-passes 1,2,3,5,6 + both atomic commits are DONE.
> Only sub-pass 4 (idle survival) remains: run the post-idle e2e probe
> `curl -H "Authorization: Bearer $RELAY_BOX_TOKEN" https://relay-production-13f6.up.railway.app/b/agentboxhonduras/`
> (token from `~/.config/relay-poc/relay-token.env`) → expect **200 + `<title>AgentBOX — Dashboard</title>`**.
> If 200: print Phase-4 SUPERGOAL_PHASE_VERIFY + DONE, run the FINAL AUDIT (re-run aggregated mandatory
> commands + spot-check ROADMAP criteria), print AUDIT_COMPLETE, commit the .supergoal run-dir bookkeeping,
> then SUPERGOAL_RUN_COMPLETE. If not 200: investigate (Railway may have reaped the idle WSS — a real finding
> for the go/no-go doc), then decide.
**Run root:** .supergoal/mbox-498-spike-demo-tagged-fleet-enrollm-FiUgLY
**Baseline ref:** 45667138c8bfeb46d9cd366a61bf836018285224
**Target box:** agentboxhonduras (RETARGETED from agentbox2, 2026-07-07 — developer has physical keyboard/monitor access here; agentbox2 was remote/unrecoverable for this developer, defeating the Risk-#1 lockout mitigation). SSH user `carlos`.

## Phase progress

| # | Phase | Status | Started | Completed | Notes |
|---|-------|--------|---------|-----------|-------|
| 1 | Enroll box as tagged fleet device | ✅ done | 2026-07-09 | 2026-07-09 | tag:box added to prod ACL (additive, tests passed); honduras re-tagged via admin API (device 1195297404771952); fresh SSH survives (no lockout); :9200 200; serve unchanged; key revoked. Notes: notes/phase1-tailscale.md |
| 2 | Build and deploy relay | ✅ done | 2026-07-10 | 2026-07-10 | Railway Staqs ws, project mbox-498-relay-poc, service relay → https://relay-production-13f6.up.railway.app. node --test 7/7; healthz 200; 401 no/bad token; 503 no-tunnel (Bearer + followed ?key= cookie). No token in repo. Notes: notes/phase2-railway.md |
| 3 | Box tunnel client + end-to-end | ✅ done (1 caveat) | 2026-07-10 | 2026-07-10 | box-client on honduras as systemd --user relay-poc (NRestarts=0). E2E over public internet: AgentBOX Dashboard 200+title with valid token; cookie reuse 200; no/bad token 401; restart→503→200 in ~1s. CAVEAT: /hermes/ 502 = box precondition (hermes upstream :9119 not running on this bench box), NOT a relay defect — relay proven transparent (200 + honest 502 passthrough). :9200 undisturbed. Notes: notes/phase3-box-client.md |
| 4 | Polish, Harden & Go/No-Go | ✅ done | 2026-07-10 | 2026-07-10 | 6 sub-passes + post-idle 200 (11min idle, WSS survived); go/no-go doc + paste-ready Linear comment; 2 atomic commits (not pushed). FINAL AUDIT + independent adversarial Verifier both CONVERGED (Verifier diffed LIVE ACL = byte-identical; no cross-box/traversal escape). |

## Engineering check status

- Build: —
- Typecheck: —
- Lint: —
- Tests: —

## Notable events
- 2026-07-10 — PHASE 4 sub-passes 1-6 + post-idle probe (200 + AgentBOX title after ~11min idle; Railway WSS not reaped) all PASS. FINAL AUDIT re-verified fresh: node --test 7/7, bash -n exit 0, 2 atomic spike commits (4e15f7c,3fceb6b) ahead_of_origin=2 (NOT pushed; 0 relay files on origin), 0 secret VALUES in committed diff, Self.Tags['tag:box'], relay healthz 200, e2e 200/401/401, all deliverables present. No gaps → no audit-fix round.
- 2026-07-10 — INDEPENDENT VERIFIER (general-purpose, opposing goal, security-weighted) returned **CONVERGED** — all 7 criteria confirmed with its OWN evidence. Went beyond maker's audit: fetched LIVE tailnet ACL and diffed vs new-acl.hujson = byte-identical (prod fleet policy verbatim-preserved on the live tailnet, kill switch #2 + fail-closed tests intact); threw extra traversal vectors (…%2fetc%2fpasswd, cross-box) → all contained to same-box dashboard, structurally no escape. Non-blocking: traversal guard bypassable-but-contained (documented in go/no-go). → AUDIT_COMPLETE + SUPERGOAL_RUN_COMPLETE. Irreversible push remains human-gated (per safety.md): NOT pushed.


- 2026-07-03 — Plan locked pending user review, 4 phases.

## Failure log

(empty)

- 2026-07-05 — Stage 7 complete: PROTOCOL.md generated, repo-state.sh copied, baseline captured; READY_TO_DISPATCH for Carlos handoff.
- 2026-07-07 — RETARGET agentbox2 → agentboxhonduras across ROADMAP/THINKING/tools/applied-memories/phases (Carlos is the developer; has physical console only on honduras). SSH user UMB→carlos. Serve/Funnel checks reframed to capture-then-compare (honduras may have no :9120 Serve/:443 Funnel — don't assume). Added: verify sidecar is serving :9200 before Phase 3 (honduras was the OOBE bench box).
- 2026-07-09 — PROTOCOL.md HOST ADAPTATION added (this run executes on Claude Code, not Codex): use Bash `curl`/WebFetch (curl works; `ctx_execute` absent); TS_API_KEY sourced from `~/.config/relay-poc/secrets.env` (verified valid — ACL GET 200); Linear-absent → paste-ready file fallback. honduras verified reachable (ssh ok, sidecar :9200/healthz 200, no Serve config, untagged).
- 2026-07-09 — Phase-2 code PRE-BUILT ahead of dispatch (un-gated half): infra/relay-poc/{server.js,box-client.js,test/relay.test.js,package.json,README.md,.gitignore}. `node --check` clean on all; `node --test` = 7 pass / 0 fail (roundtrip+integrity, 401, 503, 404, 413, healthz, WSS-bad-token-rejected). NOT committed; node_modules gitignored; no secrets in source. Remaining for Phase 2: `railway login` + `railway up` deploy + public probes only.
- 2026-07-09 — PHASE 1 DONE. Human-gated + confirmed ("apply Phase 1"). Additive ACL POST (tag:box tagOwner + anti-lockout ssh rule) HTTP 200, fail-closed tests passed, prod fleet policy verbatim-preserved. Re-tag via admin API POST /device/1195297404771952/tags (carlos lacks passwordless sudo → API cleaner than `tailscale up`). Verified: Self.Tags ['tag:box'], fresh SSH exit 0 (NO lockout), :9200/healthz 200, serve unchanged (none). Auth key minted+revoked; staged key files removed. → Phase 2.
- 2026-07-10 — PHASE 2 DONE. Human-gated deploy (asked → "Yes, deploy now"; auto-mode classifier had correctly blocked the outward deploy first). Railway CLI 5.26: init (--workspace Staqs required non-interactive) → add service `relay` + BOX_TOKENS in one shot → `railway up --ci` (railpack/Nixpacks, npm start) → `railway domain`. Public URL https://relay-production-13f6.up.railway.app. Probes: healthz 200 {boxes:[]}, no/wrong key 401, valid ?key= 302→HttpOnly cookie→503, Bearer 503 (no tunnel yet — expected pre-Phase-3). node --test 7/7. Zero token hits in repo/diff. Token only in Railway env + ~/.config/relay-poc/relay-token.env (600). Notes: notes/phase2-railway.md. → Phase 3.
- 2026-07-10 — PHASE 3 DONE (1 caveat). box-client deployed on honduras as systemd --user relay-poc (Node 22; ws installed; env 600 via SSH stdin; NoNewPrivileges; linger yes; NRestarts=0). E2E over public internet: `?key=` → 302→HttpOnly cookie → 200 `<title>AgentBOX — Dashboard</title>`; cookie-only reuse 200; no/bad token 401; kill/restart → clean 503 downtime → 200 recovered ~1s; heartbeat proven (survived 4+ 25s ping cycles; server terminates missed-pong tunnels). :9200 undisturbed; :9120 never live. CAVEAT (documented, not a relay defect): `/hermes/` → 502 because hermes upstream :9119 is NOT running on this bench box (no binary/unit/container; sudo+hermes-internals out of scope). Relay proven transparent via 200 dashboard + honest 502 passthrough. Thesis (no-Tailscale device reaches box UI over public internet, token-gated) PROVEN. Notes: notes/phase3-box-client.md. → Phase 4.
