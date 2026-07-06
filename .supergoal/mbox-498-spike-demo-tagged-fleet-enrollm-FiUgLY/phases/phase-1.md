SUPERGOAL_PHASE_START
Phase: 1 of 4 — Enroll box as tagged fleet device
Task: Add tag:box + additive grants to the tail377a9a policy via API, re-enroll agentbox2 tagged, prove vendor SSH survives
Type: brownfield, infra, spike
Mandatory commands: [ -n "$TS_API_KEY" ] && echo TS_API_KEY-present, ssh -o BatchMode=yes agentbox2 'tailscale status --json | head -40', ssh -o BatchMode=yes agentbox2 true; echo exit=$?
Acceptance criteria: 6
Evidence required: Tags line showing tag:box, fresh SSH exit 0 post-re-tag, 200 from :9120 healthz post-re-tag
Depends on phases: none

## Why

Proves the tagged-device fleet model ($1/device/mo, no user seat) with vendor OTA/SSH access surviving — the half of the recommendation that ships now regardless of the app.

## Work

- Read the research brief section on isolation/grants: ~/vault/Research/Tailscale Invisible Phone-Box Transport (MBOX-498).md
- **Capture prior state** (save to <run-root>/../..//infra/relay-poc/notes/phase1-tailscale.md — create dirs): current policy file (GET https://api.tailscale.com/api/v2/tailnet/-/acl with Bearer $TS_API_KEY — use ctx_execute javascript fetch, NOT curl), box `tailscale status --json` prefs, `tailscale serve status` output.
- **Policy update (ADDITIVE — do not touch existing rules, do not set default-deny):** add `tag:box` to tagOwners (owner autogroup:admin); add an ssh rule allowing autogroup:admin (or Eric's user) → tag:box as users UMB+root (check mode: check or accept per existing style); add/keep an ACL/grant so admin devices reach tag:box on *:*. POST the updated policy; on validation error, fix and retry (API validates).
- **Create scoped auth key** via API: capabilities.devices.create {reusable:false, ephemeral:false, preauthorized:true, tags:["tag:box"]}, 1-day expiry. Keep the key in memory/env only — never in a committed file.
- **Re-tag agentbox2 with lockout protection:** open a persistent safety SSH session FIRST (e.g., run the re-tag from inside it): `sudo tailscale up --authkey=<key> --advertise-tags=tag:box --ssh` plus whatever flags the prior prefs show as non-default (capture `tailscale debug prefs` first; preserve existing settings — Serve/Funnel state persists on its own but up-flags reset unlisted booleans; use `tailscale up --reset` semantics knowingly).
- **Verify from a NEW connection:** fresh `ssh agentbox2 true`; `tailscale status --json` Tags contains tag:box; https://agentbox2.tail377a9a.ts.net:9120/healthz returns 200 (ctx_execute fetch); `tailscale serve status` matches pre-capture.
- **Rollback documented** in the notes file: how to restore prior policy JSON and re-auth untagged.

## Acceptance criteria (all must pass — verify each in transcript)

- Prior policy + prefs + serve status captured to notes file before any change
- Policy contains tag:box tagOwner + ssh/grant rules scoped to it; existing rules untouched (diff shown)
- Scoped auth key created (tagged, expiring, non-reusable); value absent from all committed files
- Box Tags shows "tag:box" in tailscale status --json
- Fresh ssh agentbox2 true → exit 0 AFTER re-tag
- :9120 healthz 200 AND serve status unchanged vs capture (Funnel :443 untouched)

## Mandatory commands (run each, surface last ~10 lines + exit code)

- [ -n "$TS_API_KEY" ] && echo TS_API_KEY-present
- ssh -o BatchMode=yes agentbox2 'tailscale status --json | head -40'
- ssh -o BatchMode=yes agentbox2 true; echo exit=$?

## Evidence required in transcript

- Policy diff summary (added lines only)
- Tags line from status json
- Fresh SSH exit code + :9120 healthz code post-re-tag

## Notes

curl/wget are BLOCKED in Bash by context-mode — do all Tailscale API calls with ctx_execute (javascript fetch) reading TS_API_KEY from env via process.env passed in code, or `ssh agentbox2` + a python3 urllib one-liner ON THE BOX if env passing is awkward. If TS_API_KEY is missing, STOP with FAILURE_HANDOFF instructing: login.tailscale.com → Settings → Keys → Generate API access token, then `export TS_API_KEY=...` and re-dispatch. Do NOT attempt Playwright console driving in this phase.

---

The agent will print SUPERGOAL_PHASE_VERIFY, MEMORY_SAVED, and SUPERGOAL_PHASE_DONE per PROTOCOL.md.
