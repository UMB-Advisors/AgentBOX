SUPERGOAL_PHASE_START
Phase: 3 of 4 — Box tunnel client + end-to-end
Task: Run box-client.js on agentboxhonduras as a service dialing the Railway relay; prove Hermes UI loads through the public relay URL with auth
Type: brownfield, infra, spike
Mandatory commands: ssh agentboxhonduras 'systemctl --user status relay-poc --no-pager | head -5', e2e fetch probes via ctx_execute
Acceptance criteria: 6
Evidence required: 200 + page titles via relay URL, 401 probe, reconnect log timestamps
Depends on phases: 2

## Why

Completes the demo path the spike must prove: a device with no Tailscale reaches the box's Hermes UI from the public internet.

## Work

- Copy `infra/relay-poc/box-client.js` to agentboxhonduras (scp to ~/relay-poc/). Client behavior (already written+tested in Phase 2): outbound WSS to relay `/tunnel` with Bearer token + X-Box-Id: agentboxhonduras; forwards framed requests to `http://127.0.0.1:9200`; 25s heartbeat; reconnect with exponential backoff (1s→30s cap).
- Token + relay URL in `~/.config/relay-poc/env` on the box, chmod 600.
- Install systemd **user** unit `relay-poc.service` (After=network-online, EnvironmentFile=~/.config/relay-poc/env, ExecStart=node ~/relay-poc/box-client.js, Restart=always) — mirror an existing user tunnel unit on the box if one is present (e.g. any `*-tunnel.service`), else author it fresh; `loginctl enable-linger carlos` if not already. Fall back to nohup+setsid only if user systemd unavailable; document which.
- **E2E probes** (ctx_execute fetch, public internet path):
  - `<relay>/b/agentboxhonduras/?key=<token>` → 200, body contains `<title>AgentBOX — Dashboard</title>`
  - follow-up request with returned cookie (no key param) → 200
  - `<relay>/b/agentboxhonduras/hermes/` (cookie) → 200, `Hermes Agent - Dashboard`
  - no/bad token → 401
- **Resilience check:** `ssh agentboxhonduras 'systemctl --user restart relay-poc'` (or kill process) → probe during downtime returns 502/503 cleanly → within 30s probe returns 200 again. Surface relay logs (`railway logs | tail`) showing disconnect + re-register timestamps.
- Confirm box undisturbed: local `127.0.0.1:9200/healthz` 200 via ssh; Serve/Funnel unchanged (:9120 still 200 if it was live).

## Acceptance criteria (all must pass — verify each in transcript)

- relay-poc service active (systemd status or process) and stable ≥2 min with heartbeats visible in relay logs
- Relay URL serves AgentBOX Dashboard (200 + title) over public internet with valid token
- /hermes/ path serves Hermes Agent - Dashboard (200 + title)
- Bad/missing token → 401 on same paths
- Kill/restart test: clean 5xx during downtime, auto-reconnect ≤30s, then 200
- Box-local :9200/healthz still 200 (tailnet :9120/healthz too, if Serve was live)

## Mandatory commands (run each, surface last ~10 lines + exit code)

- ssh -o BatchMode=yes agentboxhonduras 'systemctl --user status relay-poc --no-pager | head -5' (or pgrep fallback)
- ctx_execute fetch: the four probes above (surface status + title per probe)

## Evidence required in transcript

- All probe outputs (status code + extracted <title>)
- Reconnect timeline (timestamps from railway logs or client log)
- Local healthz confirmations

## Notes

If Hermes UI assets 404 under the /b/agentboxhonduras/ prefix (absolute paths), switch to root-mount mode per the Phase 2 note (single-box relay), re-probe, and record the finding — it's a real data point for the production relay design. Commit any client/unit changes to the branch.

---

The agent will print SUPERGOAL_PHASE_VERIFY, MEMORY_SAVED, and SUPERGOAL_PHASE_DONE per PROTOCOL.md.
