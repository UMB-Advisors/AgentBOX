# Customer #2 Day-1 Monitoring Runbook v0.1.0

**Status:** v0.1.0 — first version, tracks STAQPRO-178.

**Audience:** On-call operator (Dustin) during the first 72h after the customer #2 appliance goes live. Aim is a deterministic checklist that distinguishes "fine, keep watching" from "intervene now" without subjective judgment.

**Tracks:** STAQPRO-178. Parent: STAQPRO-164 (M3 customer-#2 onboarding).

**Companion docs:**
- `provisioning.v0.1.0.md` — initial appliance provisioning, run before this.
- `onboarding-backfill.v0.1.0.md` — Gmail Sent backfill, run during install session.
- `customer-2-success-criteria.v0.1.0.md` (STAQPRO-179) — "is M3 done" gate, run after this 72h window closes.

---

## When to use this runbook

Start at T+0 = the moment the appliance flips from `MAILBOX_LIVE_GATE_BYPASS=1` (dogfood) to `MAILBOX_LIVE_GATE_BYPASS=0` and the operator approves their first real draft. Run for 72h. After 72h, switch to the lower-cadence cadence in the success-criteria runbook.

A single reading outside threshold is a yellow flag, not red. Three consecutive readings outside threshold, or any one reading in the **STOP** column, escalate to incident.

---

## Daily cadence

Three checks per day, spaced ~8h apart (e.g., 09:00 / 17:00 / 01:00 PT). Each check is < 10 minutes if everything is green. Total commitment: 30 min/day for 3 days = 90 min over the first 72h.

Check from your workstation over Tailscale or direct ethernet. Most commands assume the SSH alias `jetson-customer2` resolves to the customer's appliance — set this in `~/.ssh/config` during install.

---

## The watchlist — per-check items

Each row: what to check, the SSH command, the green/yellow/red bands.

### 1. Latency (SLA: <30s local / <60s cloud per project Constraints)

```sh
ssh jetson-customer2 'docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -c "
  SELECT
    AVG(EXTRACT(EPOCH FROM (classified_at - received_at))) AS classify_avg_s,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (classified_at - received_at))) AS classify_p95_s,
    COUNT(*) AS n
  FROM mailbox.inbox_messages
  WHERE received_at > NOW() - INTERVAL '\''8 hours'\'' AND classified_at IS NOT NULL;"'
```

Then for draft latency:

```sh
ssh jetson-customer2 'docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -c "
  SELECT
    draft_source,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (created_at - (SELECT received_at FROM mailbox.inbox_messages im WHERE im.id = d.inbox_message_id)))) AS draft_p95_s,
    COUNT(*) AS n
  FROM mailbox.drafts d
  WHERE created_at > NOW() - INTERVAL '\''8 hours'\''
  GROUP BY draft_source;"'
```

| Band | classify_p95 | draft_p95 (local) | draft_p95 (cloud) | Action |
|---|---|---|---|---|
| Green | < 15s | < 30s | < 60s | Continue |
| Yellow | 15-30s | 30-45s | 60-90s | Note in incident log; reread next cycle |
| **STOP** | > 30s | > 45s sustained | > 90s sustained | Escalate. Likely Ollama OOM-thrash or n8n queue backup |

Reference: SLA in root `CLAUDE.md` Constraints. The classify path runs `qwen3:4b-ctx4k` with `/no_think` so 15s is generous.

### 2. Memory + OOM-killer (Risk T2)

```sh
ssh jetson-customer2 'docker stats --no-stream --format "table {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}" | head -20'
ssh jetson-customer2 'sudo dmesg -T | grep -iE "oom|killed process" | tail -20'
```

| Band | Ollama mem | dmesg OOM hits last 8h | Action |
|---|---|---|---|
| Green | < 4 GB | 0 | Continue |
| Yellow | 4-5.5 GB | 0 | Note; verify no second model loaded |
| **STOP** | > 5.5 GB OR any OOM-killer hit | ≥ 1 | Escalate. Likely `nomic-embed-text` + `qwen3` both pinned in VRAM. Restart `ollama` container; force LRU unload via `ollama ps` then `ollama stop nomic-embed-text:v1.5` |

Reference: 8GB unified VRAM budget in root `CLAUDE.md` (typical ~5.7 GB total, 2.3 GB headroom).

### 3. Draft success rate

```sh
ssh jetson-customer2 'docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -c "
  SELECT status, COUNT(*) FROM mailbox.drafts
  WHERE created_at > NOW() - INTERVAL '\''8 hours'\''
  GROUP BY status ORDER BY COUNT(*) DESC;"'
```

Healthy distribution per the live state machine in root `CLAUDE.md`:
- Most rows: `pending` (newly created) or `approved` → `sent` (operator triaged + n8n shipped)
- Acceptable trickle: `rejected`, `edited`
- Anomaly: `failed`, stuck `awaiting_cloud`

| Band | failed % last 8h | stuck `awaiting_cloud` (>30 min old) | Action |
|---|---|---|---|
| Green | 0% | 0 | Continue |
| Yellow | 1-5% | 1-2 | Note; check `state_transitions` for the last failed draft |
| **STOP** | > 5% OR ≥ 1 stuck > 1h | ≥ 3 | Escalate. Likely Anthropic / Ollama Cloud auth or n8n send webhook broken |

Replay path on stuck `awaiting_cloud`: hit the dashboard `/api/drafts/[id]/retry` endpoint (logged-in operator) — does NOT roll back state on transport failure per REQUIREMENTS API-03.

### 4. Classification accuracy (spot check — Risk: <85% on the customer's industry vocabulary; tuned via persona `business_description` per the 2026-05-08 CPG-scrub)

```sh
ssh jetson-customer2 'docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -c "
  SELECT id, classification, confidence, LEFT(subject, 60) AS subj
  FROM mailbox.inbox_messages
  WHERE classified_at > NOW() - INTERVAL '\''8 hours'\''
  ORDER BY received_at DESC LIMIT 15;"'
```

Read each row. For each: does the `classification` match what you would have routed it as? Tally agreement out of 15.

| Band | Agreement | Action |
|---|---|---|
| Green | 13-15 / 15 (≥ 85%) | Continue |
| Yellow | 11-12 / 15 | Note categories where it disagreed; check if same category recurs |
| **STOP** | ≤ 10 / 15 | Escalate. Either operator-domain preclass (DR-50) is misfiring or vocab needs persona update. Open follow-up issue with the disagreement set. |

Spot-check is intentionally manual for the first 72h. Automated eval (STAQPRO-198) handles the long-term tracking.

### 5. n8n execution errors

```sh
ssh jetson-customer2 'docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -c "
  SELECT \"workflowId\", status, COUNT(*)
  FROM execution_entity
  WHERE \"startedAt\" > NOW() - INTERVAL '\''8 hours'\''
  GROUP BY \"workflowId\", status ORDER BY status;"'
```

| Band | error rows last 8h | Action |
|---|---|---|
| Green | 0 errors | Continue |
| Yellow | 1-2 errors | Read the error from the n8n UI; document |
| **STOP** | ≥ 3 errors of the same shape | Escalate. Same root-cause repeating |

Note: the documented benign empty-cycle `Load Inbox Row` 404 should NOT appear here post-STAQPRO-135 (the IF gate). If it does, that's a real regression — STAQPRO-135 may have been deployed cleanly to customer #1 but missed here.

### 6. Cert renewal (Risk: Caddy/Cloudflare DNS-01 failure)

Cloudflare DNS-01 certs renew ~30 days before expiry. The first renewal at customer #2 won't happen during the 72h window unless we explicitly force one — but the LOG should still be checked for setup-time errors.

```sh
ssh jetson-customer2 'docker logs mailbox-caddy-1 2>&1 | grep -iE "obtain|renew|certificate|error" | tail -30'
```

| Band | Output | Action |
|---|---|---|
| Green | "certificate obtained successfully" + no `error` | Continue |
| Yellow | "obtain" present but stale (> 24h ago) | Verify cert is still valid via `openssl s_client`; not an active failure |
| **STOP** | Any line containing `error` related to obtain/renew | Escalate. Likely `CLOUDFLARE_API_TOKEN` env wrong or DNS record not delegated |

Verify cert validity manually:
```sh
echo | openssl s_client -servername mailbox.<customer-domain> -connect mailbox.<customer-domain>:443 2>/dev/null | openssl x509 -noout -dates
```

### 7. Tailscale online

```sh
tailscale ping mailbox-customer2-jetson-01 2>&1 | head -3
tailscale status | grep customer2
```

| Band | Output | Action |
|---|---|---|
| Green | `pong` returned, status = `idle` or active connection | Continue |
| Yellow | First ping `direct connection not established` then second ping is `pong` | Normal NAT traversal warmup; not a problem |
| **STOP** | No pong in 30s, or status shows `offline` | Escalate. Customer's router may have Tailscale blocked; we lose remote ops access |

---

## Anomaly handling

Any **STOP** reading triggers:

1. Open a Linear issue immediately under STAQPRO-164 (parent). Title: `[INCIDENT] customer-2 day-1: <one-line>`.
2. Capture the reading + raw command output in the issue body.
3. If the appliance is degraded but not down, leave it running. If down, reach out to the customer-side operator before any compose-level intervention.
4. Re-run the same check 5 minutes later. If green now, mark the incident as transient and continue. If still **STOP**, escalate to a fix branch.

---

## What the 72h window proves

If all 9 check rows stay green-or-yellow across 9 reads (3 reads/day × 3 days), the appliance is stable enough to hand off to the success-criteria phase (STAQPRO-179). The success-criteria gate then validates the 7-day output side (drafts approved, etc.).

If any row hit **STOP**, the 72h window does NOT count toward M3 completion. Re-deploy the fix, then restart the 72h clock.

---

## Out of scope (future work)

- Dashboard-side `/api/system/status` health endpoint exposing all 7 metrics as JSON (would replace 6 of these manual SSH commands). Tracked in STAQPRO-187 follow-up post customer #2.
- Automated alert delivery (Slack / email digest). Tracked in STAQPRO-151.
- Long-term metric trend storage (currently we just sample; SM-60/61 dashboards would aggregate).
