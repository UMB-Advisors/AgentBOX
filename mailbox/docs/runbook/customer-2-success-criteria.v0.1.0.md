# Customer #2 Success Criteria Runbook v0.1.0

**Status:** v0.1.0 — first version, tracks STAQPRO-179.

**Audience:** Product (Dustin / Eric) deciding whether M3 ("Customer #2 onboarded") moves to Delivered. Without an objective bar this becomes a vibe call; this runbook is the gate.

**Tracks:** STAQPRO-179. Parent: STAQPRO-164 (M3 customer-#2 onboarding).

**Companion docs:**
- `customer-2-day-1-monitoring.v0.1.0.md` (STAQPRO-178) — first-72h watchlist; this gate is what runs after that 72h closes.
- `provisioning.v0.1.0.md` — initial appliance provisioning.
- `onboarding-backfill.v0.1.0.md` — Gmail Sent backfill during install.

---

## When to use this runbook

Window: starts at T+72h (i.e., after the day-1 monitoring runbook closes successfully) and runs for 7 calendar days. At T+10 days from go-live, evaluate every criterion below. If all pass, mark M3 as Delivered. If any fail, the gate stays closed and a follow-up issue is opened to address the gap.

This runbook is **not** for daily monitoring — it's the once-only Delivered/not-Delivered decision. Daily watch is the day-1 runbook. Long-term continuous tracking is the post-M3 SM dashboards (out of scope here).

---

## Criteria — all must pass

Each criterion has a measurement command, a target, and a pass/fail evaluation.

### 1. Drafts approved — usage threshold

**Why**: proves the operator is actually using the queue, not just letting it run unattended. Without this, "live" means nothing.

**Target**: ≥ 10 drafts in `status='approved'` or `status='sent'` over the 7-day evaluation window (T+72h to T+10 days).

```sh
ssh mailbox2 'docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -c "
  SELECT
    COUNT(*) FILTER (WHERE status = '\''approved'\'') AS approved,
    COUNT(*) FILTER (WHERE status = '\''sent'\'') AS sent,
    COUNT(*) FILTER (WHERE status = '\''rejected'\'') AS rejected,
    COUNT(*) FILTER (WHERE status = '\''edited'\'') AS edited
  FROM mailbox.drafts
  WHERE created_at BETWEEN NOW() - INTERVAL '\''7 days'\'' AND NOW();"'
```

| Result | Verdict |
|---|---|
| `approved + sent ≥ 10` | PASS |
| `approved + sent < 10`, drafts created < 10 (no inbound) | INDETERMINATE — extend window |
| `approved + sent < 10`, drafts created ≥ 20 (operator ignoring queue) | FAIL — talk to customer about adoption |

### 2. Latency p95 within SLA

**Why**: Project Constraints lock <30s local / <60s cloud. Sustained breach means the appliance is under-provisioned for this customer's volume.

**Target**: classify p95 < 30s, draft p95 (local) < 30s, draft p95 (cloud) < 60s — measured over the 7-day evaluation window.

```sh
ssh mailbox2 'docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -c "
  SELECT
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (classified_at - received_at))) AS classify_p95_s,
    COUNT(*) AS classifications
  FROM mailbox.inbox_messages
  WHERE classified_at BETWEEN NOW() - INTERVAL '\''7 days'\'' AND NOW();"'
```

```sh
ssh mailbox2 'docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -c "
  SELECT
    draft_source,
    PERCENTILE_CONT(0.95) WITHIN GROUP (
      ORDER BY EXTRACT(EPOCH FROM (d.created_at - im.received_at))
    ) AS draft_p95_s,
    COUNT(*) AS n
  FROM mailbox.drafts d
  JOIN mailbox.inbox_messages im ON im.id = d.inbox_message_id
  WHERE d.created_at BETWEEN NOW() - INTERVAL '\''7 days'\'' AND NOW()
  GROUP BY draft_source;"'
```

| Result | Verdict |
|---|---|
| All three p95s within SLA | PASS |
| Any p95 over SLA | FAIL — investigate Ollama / cloud-route saturation; do not Deliver M3 until resolved |

### 3. Zero OOMs in observation window

**Why**: T2 risk (OOM-killer activates Ollama) — on-host evidence that the 8GB unified VRAM budget holds for this customer's workload.

**Target**: zero OOM-killer hits in `dmesg` between T+72h and T+10 days.

```sh
ssh mailbox2 'sudo dmesg -T | grep -iE "oom|killed process" | grep -v "$(date -d '\''-7 days'\'' '\''+%b'\'')" | wc -l'
```

(Filter approximation — also eyeball the raw output for any hits dated within the window.)

```sh
ssh mailbox2 'sudo dmesg -T | grep -iE "oom|killed process" | tail -20'
```

| Result | Verdict |
|---|---|
| 0 OOM lines dated within window | PASS |
| ≥ 1 OOM line dated within window | FAIL — VRAM headroom insufficient; investigate model retention |

### 4. Zero errored 5-min cycles (post-STAQPRO-135)

**Why**: STAQPRO-135 added the IF gate that suppresses the documented benign empty-cycle `Load Inbox Row` 404. Any error in `execution_entity` after that landed is a real regression, not noise.

**Target**: zero `error` rows in `execution_entity` for `MailBOX*` workflows over the 7-day evaluation window.

```sh
ssh mailbox2 'docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -c "
  SELECT \"workflowId\", status, COUNT(*)
  FROM execution_entity
  WHERE \"startedAt\" BETWEEN NOW() - INTERVAL '\''7 days'\'' AND NOW()
    AND status = '\''error'\''
  GROUP BY \"workflowId\", status;"'
```

| Result | Verdict |
|---|---|
| Zero rows | PASS |
| Any rows | FAIL — file a follow-up issue with the error shape; do not Deliver until root cause documented |

### 5. Operator self-sufficiency

**Why**: a managed product fails if the operator can't operate without us. This criterion is qualitative but the measurement is concrete: hand the customer the runbook and ask them to do three things.

**Target**: customer can complete each task below without help, on their own machine, in a single session.

| Task | Pass means |
|---|---|
| Approve a draft | Customer logs into `https://mailbox.<their-domain>/dashboard/queue`, picks a pending draft, clicks Approve, sees status flip to `sent` within 60s |
| Reject + edit | Customer rejects one draft and edits another before approving |
| Reset basic_auth | Customer can find their basic_auth credentials in the docs we sent + use them in a fresh browser session |

```
Operator: hand the customer the post-install one-pager. Watch them do
the three tasks once. Note any friction. Verdict is binary per task.
```

| Result | Verdict |
|---|---|
| All 3 tasks completed without help | PASS |
| Any task required intervention | FAIL — note the gap, fix the docs, retest |

### 6. Cert renewal validated

**Why**: Caddy/Cloudflare DNS-01 first renewal won't fire during the eval window (~30 days post-issue). Goal here is to confirm the cert is live and a renewal is **scheduled**, not that it has run.

**Target**: cert validity confirmed via `openssl s_client`, AND Caddy logs show no error lines from the obtain/renew machinery.

```sh
echo | openssl s_client -servername mailbox.<customer-domain> -connect mailbox.<customer-domain>:443 2>/dev/null | openssl x509 -noout -dates
```

```sh
ssh mailbox2 'docker logs mailbox-caddy-1 2>&1 | grep -iE "obtain|renew|certificate|error" | tail -50'
```

| Result | Verdict |
|---|---|
| Cert valid, expires > 30d out, no `error` lines in last 7d of caddy logs | PASS |
| Cert valid but caddy logs show errors (DNS-01 misconfig, etc) | FAIL — fix before Deliver |
| Cert expired or missing | FAIL — also a STOP per day-1 runbook |

---

## Out of scope (Phase 2 / M4)

The following are intentionally NOT gating M3 — they belong to STAQPRO-170 / STAQPRO-171 in M4:

- **RAG-augmented draft quality** — STAQPRO-122 ships RAG; STAQPRO-170 evaluates whether draft quality measurably improves. M3 only requires drafts exist + are approvable, not "drafts are good enough."
- **Edit-to-skill loop** — STAQPRO-171 turns operator edits into prompt deltas. M3 only requires the edit path works mechanically (Criterion 5).
- **Persona accuracy targets** — separate eval-loop work post-STAQPRO-198.

---

## Decision protocol

When all 6 criteria are evaluated:

| Outcome | Action |
|---|---|
| 6 PASS | Mark M3 as Delivered. Move to M4 entrance criteria (STAQPRO-173). Post a Linear comment on STAQPRO-164 referencing the evaluation reading + this runbook version. |
| 1 FAIL | Open a follow-up issue under STAQPRO-164 with the failed criterion + evidence. Do NOT Deliver M3 until follow-up closes. Re-run the failed criterion only — no need to redo the others. |
| 2+ FAIL | Same protocol. If the failures look correlated (e.g., latency + n8n errors both hitting at the same hour), file a single root-cause issue rather than N follow-ups. |
| Indeterminate (criterion 1 only) | Extend the eval window by 7 days; re-run criterion 1. Do not extend any other criterion's window — they're already 7 days, which is enough signal for those metrics. |

---

## Versioning

This runbook is v0.1.0 — first version. Bump minor on added criteria, major on structural rewrites (e.g., if Phase-2 RAG criteria graduate into M3). Don't edit thresholds in place; bump the version and document the change in a changelog section.
