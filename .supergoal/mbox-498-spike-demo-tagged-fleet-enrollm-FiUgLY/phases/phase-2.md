SUPERGOAL_PHASE_START
Phase: 2 of 4 — Build and deploy relay
Task: Minimal authenticated WSS relay in infra/relay-poc/, tested locally, deployed on Railway with healthz + auth proofs
Type: brownfield, infra, spike
Mandatory commands: node --check infra/relay-poc/server.js, node --test infra/relay-poc/, railway status
Acceptance criteria: 6
Evidence required: test pass summary, public healthz 200 + URL, 401 probe output
Depends on phases: none

## Why

The consumer-plane fallback the research brief recommends shipping first: client talks plain HTTPS, box dials out — no Tailscale anywhere near the end user.

## Work

- Create `infra/relay-poc/` (new dir, node >=20, deps: `ws` only).
- **server.js** (single file, ~200 lines):
  - HTTP server: `GET /healthz` → 200 `{ok:true, boxes:[connected ids]}`.
  - `GET|POST /b/:boxid/*` → require token: `?key=` query (sets HttpOnly cookie, redirects to clean path) or `Cookie`/`Authorization: Bearer`; constant-time compare vs `BOX_TOKENS` env (`boxid:token` comma list). Valid → forward request over the box's WSS tunnel (simple request/response frames: JSON header + base64 body; correlation ids; 30s timeout → 504). No tunnel → 503. Bad/missing token → 401. Reject bodies >10MB → 413. Normalize paths (no `..`).
  - `WS /tunnel` upgrade: require `Authorization: Bearer <token>` + `X-Box-Id`; single active tunnel per boxid (new replaces old); server-side ping every 25s.
  - Strip hop-by-hop headers; rewrite nothing else (Hermes UI is same-origin under /b/agentboxhonduras/ — if absolute-path assets break, mount at ROOT per-box instead: one Railway service per box is acceptable for PoC; document whichever holds).
- **box-client.js** stub compiled in this phase but exercised in Phase 3 (keep in same dir; write it now so tests cover both ends).
- **test/relay.test.js** (node:test): spin server on ephemeral port + fake origin http server + real box-client → assert: roundtrip 200 w/ body integrity, 401 on bad token, 503 when tunnel absent, 413 oversize.
- **README.md**: run, deploy (`railway up`), env vars, threat notes (PoC, not production).
- **Deploy:** `railway init`/link a new service (project name mbox-498-relay-poc), set `BOX_TOKENS=agentboxhonduras:<openssl rand -hex 32>`, `railway up`, get public URL (`railway domain`). Store the token ONLY in Railway env + a local scratch env file outside the repo (scratchpad), path noted in transcript.
- Probe from public side via ctx_execute fetch: healthz 200; /b/agentboxhonduras/ with no key → 401; with key but no tunnel yet → 503 (expected until Phase 3).

## Acceptance criteria (all must pass — verify each in transcript)

- node --check clean on server.js, box-client.js, test file
- node --test passes: roundtrip, bad-token 401, no-tunnel 503, oversize 413 (≥4 passing tests)
- Railway deploy live; public /healthz → 200
- /b/agentboxhonduras/ without token → 401; with token (no tunnel) → 503
- WSS /tunnel with bad token rejected (covered by test)
- git diff contains no token values (grep the diff for the token/hex64 patterns → 0 hits)

## Mandatory commands (run each, surface last ~10 lines + exit code)

- node --check infra/relay-poc/server.js
- node --test infra/relay-poc/
- railway status

## Evidence required in transcript

- Test summary line (N pass / 0 fail)
- Public URL + healthz 200 output
- 401 and 503 probe outputs

## Notes

curl is blocked — public probes via ctx_execute javascript fetch. Railway CLI is authenticated (ecgang). Keep dependencies to `ws` only; no framework. Commit at end of phase on branch feat/mbox-498-relay-poc (create from main; do not push).

---

The agent will print SUPERGOAL_PHASE_VERIFY, MEMORY_SAVED, and SUPERGOAL_PHASE_DONE per PROTOCOL.md.
