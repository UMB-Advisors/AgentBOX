# Thinking — MBOX-498 spike demo (fleet plane + relay PoC)

## Goals
1. Prove the **vendor fleet plane**: agentboxhonduras enrolled as a *tagged* device (`tag:box`) via scoped auth key, vendor SSH/OTA access surviving, isolation expressed via grants — the $1/device/mo model from the research brief.
2. Prove the **consumer plane fallback**: phone/browser with NO Tailscale reaches the box's Hermes web UI from off-LAN through a minimal cloud relay (box → outbound WSS → relay; client → plain HTTPS).
3. Produce the spike's written deliverable: go/no-go note on MBOX-498 with evidence.

## Constraints
- **Additive grants only** on the shared personal tailnet `tail377a9a` — never flip default-deny there (Eric's Macs, other boxes live on it). Full default-deny is documented as the pattern for a future dedicated staqs org tailnet.
- Relay is PoC-grade but not naked: per-box bearer token, HTTPS/WSS only, reject unknown boxes/tokens.
- libtailscale / loopback-proxy work explicitly OUT of scope.
- Repo conventions: bash appliance repo; `bash -n` is the test floor; commit atomically to a feature branch; NO push unless asked.
- agentboxhonduras's existing services must survive: sidecar :9200 (verify it's serving the dashboard — this was the OOBE bench box). Tailscale Serve :9120 / Funnel :443 are NOT assumed present on honduras (they were agentbox2's setup) — Phase 1 captures whatever exists and asserts unchanged after re-tag; don't touch, don't require :9120==200.

## Risks (top 3)
1. **Re-tagging locks us out of the box.** Tags change device ownership; Tailscale SSH rules may not cover `tag:box`. Mitigation: write the ssh + grants policy rules for `tag:box` BEFORE `tailscale up --advertise-tags`; keep a live SSH session open through the change; capture prior `tailscale status/prefs` for rollback; verify fresh SSH before closing the safety session.
2. **Railway WSS idle/lifecycle kills the tunnel.** Mitigation: 25s heartbeat pings + auto-reconnect with backoff in the box client; e2e re-check after idle period.
3. **Relay exposes a privacy-sensitive UI to the public internet.** Hermes dashboard can reveal config/keys. Mitigation: 32-byte random per-box token required (query→cookie), dev box only, "NOT production posture" stated in the go/no-go, explicit leave-up/teardown decision in Phase 4.

## Dependencies / ordering
- TS_API_KEY (Tailscale API access token) must exist in env at dispatch — pre-flight checks it; Phase 1 is the only phase needing it.
- Phase 3 (box client) needs Phase 2's deployed relay URL + token.
- Phase 4 needs everything live for the final evidence run.
- Railway CLI: logged in as ecgang ✓. fly: absent. Node on box: v22 ✓.

## Memory hits applied
- agentboxhonduras-access: exact endpoints (ssh carlos@agentboxhonduras, :9200 sidecar, :9120 Serve, Funnel :443 hands-off).
- agentbox1-access: agentbox1 repurposed — not a target.

## Tools relied on
Bash+ssh, Railway CLI, Tailscale API (curl-equivalent via ctx_execute — Bash curl is blocked by context-mode), Linear MCP (comment on MBOX-498), ctx_execute javascript fetch for HTTP probes.

## Best practices applied
- Research brief (~/vault/Research/Tailscale Invisible Phone-Box Transport (MBOX-498).md) is the architecture source: tagged-device pricing model, default-deny grants pattern, relay-first consumer plane.
- Grants over legacy ACLs syntax where possible; scoped (tag-limited, expiring, reusable=false) auth key.
- Relay kept dependency-light: node + `ws` only, single file server, single file box client.
