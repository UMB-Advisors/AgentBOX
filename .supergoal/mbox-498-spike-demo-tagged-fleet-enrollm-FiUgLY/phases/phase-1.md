SUPERGOAL_PHASE_START
Phase: 1 of 4 — Enroll box as tagged fleet device
Task: Add tag:box + additive grants to the tail377a9a policy via API, re-enroll agentboxhonduras tagged, prove vendor SSH survives
Type: brownfield, infra, spike
Mandatory commands: set -a; . ~/.config/relay-poc/secrets.env 2>/dev/null; set +a; [ -n "$TS_API_KEY" ] && echo TS_API_KEY-present, ssh -o BatchMode=yes agentboxhonduras 'tailscale status --json | head -40', ssh -o BatchMode=yes agentboxhonduras true; echo exit=$?
Acceptance criteria: 6
Evidence required: Tags line showing tag:box, fresh SSH exit 0 post-re-tag, serve-status before/after diff (unchanged) + sidecar :9200/healthz 200 post-re-tag (:9120 healthz 200 only if Serve was live pre-capture)
Depends on phases: none

## Why

Proves the tagged-device fleet model ($1/device/mo, no user seat) with vendor OTA/SSH access surviving — the half of the recommendation that ships now regardless of the app.

## Work

- Read the research brief section on isolation/grants: ~/vault/Research/Tailscale Invisible Phone-Box Transport (MBOX-498).md
- **Capture prior state** (save to <run-root>/../..//infra/relay-poc/notes/phase1-tailscale.md — create dirs): current policy file (`curl -s -H "Authorization: Bearer $TS_API_KEY" https://api.tailscale.com/api/v2/tailnet/-/acl` — Bash curl works here; source the key first per the HOST NOTE below), box `tailscale status --json` prefs, `tailscale serve status` output.
- **Policy update (ADDITIVE — do not touch existing rules, do not set default-deny):** add `tag:box` to tagOwners (owner autogroup:admin); add an ssh rule allowing autogroup:admin (or Eric's user) → tag:box as users carlos+root (check mode: check or accept per existing style); add/keep an ACL/grant so admin devices reach tag:box on *:*. POST the updated policy; on validation error, fix and retry (API validates).
- **Create scoped auth key** via API: capabilities.devices.create {reusable:false, ephemeral:false, preauthorized:true, tags:["tag:box"]}, 1-day expiry. Keep the key in memory/env only — never in a committed file.
- **Re-tag agentboxhonduras with lockout protection:** open a persistent safety SSH session FIRST (e.g., run the re-tag from inside it): `sudo tailscale up --authkey=<key> --advertise-tags=tag:box --ssh` plus whatever flags the prior prefs show as non-default (capture `tailscale debug prefs` first; preserve existing settings — Serve/Funnel state persists on its own but up-flags reset unlisted booleans; use `tailscale up --reset` semantics knowingly). **agentboxhonduras has a physical keyboard+monitor available** as the ultimate lockout recovery — the reason this box was chosen over the remote agentbox2 — but STILL open the safety SSH session first; the console is the backstop, not the plan.
- **Verify from a NEW connection:** fresh `ssh agentboxhonduras true`; `tailscale status --json` Tags contains tag:box; `tailscale serve status` matches the pre-capture byte-for-byte — if Serve on :9120 was live pre-capture it still returns 200 (ctx_execute fetch), and if agentboxhonduras had no Serve/Funnel then none appeared; sidecar `:9200/healthz` still 200.
- **Rollback documented** in the notes file: how to restore prior policy JSON and re-auth untagged.

## Acceptance criteria (all must pass — verify each in transcript)

- Prior policy + prefs + serve status captured to notes file before any change
- Policy contains tag:box tagOwner + ssh/grant rules scoped to it; existing rules untouched (diff shown)
- Scoped auth key created (tagged, expiring, non-reusable); value absent from all committed files
- Box Tags shows "tag:box" in tailscale status --json
- Fresh ssh agentboxhonduras true → exit 0 AFTER re-tag
- Serve/Funnel unchanged vs capture (if :9120 Serve was live, still 200; if agentboxhonduras had none, none appeared); sidecar :9200/healthz still 200

## Mandatory commands (run each, surface last ~10 lines + exit code)

- set -a; . ~/.config/relay-poc/secrets.env 2>/dev/null; set +a; [ -n "$TS_API_KEY" ] && echo TS_API_KEY-present
- ssh -o BatchMode=yes agentboxhonduras 'tailscale status --json | head -40'
- ssh -o BatchMode=yes agentboxhonduras true; echo exit=$?

## Evidence required in transcript

- Policy diff summary (added lines only)
- Tags line from status json
- Fresh SSH exit code + :9120 healthz code post-re-tag

## Notes

HOST NOTE (Claude Code — supersedes the original Codex-harness note): `curl` WORKS here and `ctx_execute` does NOT exist. Do all Tailscale API calls with Bash `curl -H "Authorization: Bearer $TS_API_KEY" https://api.tailscale.com/api/v2/tailnet/-/acl` (GET to capture; `-X POST -H 'Content-Type: application/hujson' --data @file` to update). **Source the key first every command:** `set -a; . ~/.config/relay-poc/secrets.env 2>/dev/null; set +a`. If that file is missing or TS_API_KEY is empty, STOP with FAILURE_HANDOFF instructing: login.tailscale.com → Settings → Keys → Generate API access token, then write it to `~/.config/relay-poc/secrets.env` (per PROTOCOL HOST ADAPTATION), and re-dispatch. Do NOT attempt Playwright console driving in this phase.

---

The agent will print SUPERGOAL_PHASE_VERIFY, MEMORY_SAVED, and SUPERGOAL_PHASE_DONE per PROTOCOL.md.
