SUPERGOAL_PHASE_START
Phase: 4 of 4 — Polish, Harden & Go/No-Go
Task: Security/edge sweep on the live PoC, produce the go/no-go note, comment MBOX-498, commit the branch cleanly
Type: brownfield, infra, spike, polish
Mandatory commands: bash -n install/agentbox-install.sh, node --test infra/relay-poc/, git diff --stat, aggregated re-probes
Acceptance criteria: 8
Evidence required: per-sub-pass paragraphs, post-idle e2e 200, Linear comment id, git log of branch
Depends on phases: 1, 2, 3

## Why

Turns a working demo into the spike's deliverable: hardened enough to leave running, honestly documented, and reported where Carlos/Dustin will read it.

## Work

**Sub-passes (evidence per pass):**
1. **Security** — grep full branch diff for the token, any hex64, TS_API_KEY (0 hits); verify 401 on bad token, 413 on >10MB body, 404/401 on unknown boxid, path `/b/agentboxhonduras/../` cannot escape; confirm relay serves only https/wss (Railway edge).
2. **States** — stop box client: public URL → clean 502/503, healthz stays 200, relay doesn't crash; restart client.
3. **Edges** — reconnect backoff verified capped (no storm in logs); concurrent requests (5 parallel fetches) all 200.
4. **Idle survival** — wait ≥10 min (ScheduleWakeup if needed), then e2e probe → 200 (Railway WSS lifecycle proof).
5. **Diff review** — `bash <run-root>/repo-state.sh added-lines <baseline>` scanned for console.log debug leftovers (except intentional structured logs), TODO/FIXME from this run.
6. **Regression sweep** — `bash -n install/agentbox-install.sh`; fresh `ssh agentboxhonduras true`; `tailscale serve status` unchanged vs the Phase-1 capture (if :9120 Serve was live, still 200; if none, none appeared); sidecar `:9200/healthz` still 200.

**Deliverables:**
- `docs/spikes/mbox-498-relay-poc.md`: what was proven (fleet plane: tag:box + surviving vendor SSH; consumer plane: no-Tailscale phone→box over public internet), architecture diagram (ASCII ok), observed latency, Railway cost note, explicit **NOT production posture** list (single shared token, we're in the data path unencrypted at relay, no rate limiting), next steps (relay.thumbbox.io DNS, per-phone tokens, E2E encryption or libtailscale migration), and the leave-up/teardown decision (default: leave running with token, note monthly cost).
- Linear comment on MBOX-498 (use the Linear MCP save_comment tool): demo results summary, link/path to the spike doc + vault brief, go/no-go verdict per the two planes.
- Atomic commits on `feat/mbox-498-relay-poc` (logical units: relay server+tests, box client+unit, docs). DO NOT push.
- Memory writeback: project memory `mbox-498-relay-poc` (what's deployed where, token location, service names) + any API quirks learned.

## Acceptance criteria (all must pass — verify each in transcript)

- All 6 sub-passes have evidence paragraphs; failures found were fixed and re-verified
- Post-idle (≥10 min) e2e probe returns 200 with correct title
- Secret grep over branch diff: 0 hits
- docs/spikes/mbox-498-relay-poc.md exists and contains go/no-go verdicts for BOTH planes + NOT-production list
- Linear comment posted on MBOX-498 (comment id in transcript)
- Branch has ≥2 atomic commits, working tree clean, branch NOT pushed
- bash -n install/agentbox-install.sh exit 0
- Fresh ssh agentboxhonduras true exit 0 AND sidecar :9200/healthz 200; Serve/Funnel unchanged vs Phase-1 capture (fleet plane still healthy at run end)

## Mandatory commands (run each, surface last ~10 lines + exit code)

- bash -n install/agentbox-install.sh
- node --test infra/relay-poc/
- git -C /Users/ericgang/AgentBOX diff --stat main...feat/mbox-498-relay-poc && git log --oneline main..feat/mbox-498-relay-poc
- Re-run Phase 1 + 3 probe sets (aggregated)

## Evidence required in transcript

- Sub-pass paragraphs (1–6)
- Timestamped post-idle probe output
- Linear comment id
- git log --oneline of the branch

## Notes

The Linear MCP tool name is mcp__claude_ai_Linear__save_comment (issueId: MBOX-498). If the 10-min idle wait would stall the loop, use ScheduleWakeup(~660s) rather than sleeping in Bash. Teardown alternative if user objects later: `railway down` + `systemctl --user disable --now relay-poc` + policy rollback file from Phase 1 notes.

---

The agent will print SUPERGOAL_PHASE_VERIFY, MEMORY_SAVED, and SUPERGOAL_PHASE_DONE per PROTOCOL.md.
