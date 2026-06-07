# MailBOX One — T2 Build Log

**Version:** v0.7
**Date:** 2026-04-25 (early Saturday morning, continuing from v0.6)
**Hardware:** NVIDIA Jetson Orin Nano 8GB Developer Kit Super
**JetPack:** 6.2 (L4T R36.5)
**n8n version:** 1.123.35
**Operator:** Dustin
**Supersedes:** v0.6 (2026-04-24)

---

## Headline

**Phase 1 deliverable #2 functionally complete: end-to-end classification pipeline working autonomously.** Schedule Trigger + Gmail Get Many action pattern validated as workaround for the broken Gmail Trigger node. All 5 test emails in `MailBOX-Test` label classified by Qwen3-4B and persisted to Postgres without human intervention.

**Two new operational issues surfaced** that don't block functional completeness but block production hardening:
- Ollama OOM-kills under sustained polling load on Orin Nano 8GB (BL-18)
- n8n's Schedule Trigger config strips `minutesInterval` field on workflow load, defaulting to 1-minute polling (BL-19)

The architecture is proven. Tomorrow's work is operational tuning, not redesign.

---

## Status at a glance

| Component | State |
|---|---|
| Jetson + Ollama + Qwen3-4B | ✅ Inference working, 18 t/s |
| Postgres + `mailbox.inbox_messages` | ✅ Healthy, 5 classified rows |
| n8n 1.123.35 | ✅ Healthy, working, except Schedule Trigger config quirk |
| Gmail OAuth2 credential | ✅ Connected and working |
| Caddy + HTTPS | ✅ Unchanged, healthy |
| **Classification pipeline (autonomous)** | ✅ **Working** — Schedule Trigger fires, mail flows to Postgres |
| Polling cadence persistence | ⚠️ Stuck at 1-min default; UI/DB strips override on load |
| Ollama stability under load | ⚠️ OOM-killed mid-cycle when concurrent calls pile up |

---

## Changes since v0.6

| Area | v0.6 → v0.7 |
|---|---|
| Gmail Trigger | ❌ Confirmed broken across n8n 1.x and 2.x → ✅ **Replaced with Schedule Trigger + Gmail Get Many** |
| BL-13 (trigger not firing) | Open → **Closed via architectural workaround** |
| Test workflows from yesterday | Lingering → Cleaned up |
| Workflow `MailBOX` | Empty after deletion → **Built fresh, 6 nodes, working** |
| inbox_messages rows | 1 (yesterday's manual proof) → **5 (full label backfill)** |
| `OLLAMA_KEEP_ALIVE` env var | Default 5min → **`24h`** (model stays loaded) |
| Ollama image OOM-killed events | New finding | Repeated `signal: killed` from Linux OOM-killer |
| Schedule Trigger config | New finding | UI strips `minutesInterval` field on save and workflow load |

---

## Session arc

### 1. Validated state from v0.6 (5 min)

Pre-session sanity check: all 6 containers healthy, Postgres still has yesterday's manual test row, n8n on 1.123.35.

### 2. Diagnosed BL-13 — Gmail Trigger is the bug, not us (45 min)

Investigation flow:

- **Hypothesis 1 (workflow-state-specific):** built minimal Gmail-Trigger-only workflow. Same "No Gmail data found" symptom. Hypothesis ruled out.
- **Hypothesis 2 (credential broken):** built Gmail action node (not Trigger) test workflow. Successfully fetched all 4 labeled emails. Hypothesis ruled out — credential works perfectly.
- **Web research:** Found multiple n8n GitHub issues + community threads (#14322, #27867, others) reporting the identical pattern — workflow active, manual works, scheduled polling silently does nothing. Spans 1.x and 2.x.

**Conclusion:** Gmail Trigger node has a long-standing scheduling bug in n8n. Not a config error in our setup. Yesterday's downgrade to 1.x was wasted effort — same bug exists there. (Note: 1.x downgrade still useful for avoiding the 2.x publish bug, so net positive even though it didn't solve BL-13.)

**Decision (BL-D13):** Replace Gmail Trigger with Schedule Trigger + Gmail Get Many action node, leveraging Postgres `ON CONFLICT (message_id) DO NOTHING` for dedup.

### 3. Cleaned lingering workflows (10 min)

Yesterday's failed workflows (`gmail-trigger-test`, `gmail-action-test`, `My workflow`) were still active in DB and crash-looping. Initial DELETE failed silently — likely FK constraint to `execution_entity`. Fixed with cascade-style cleanup:

```sql
DELETE FROM execution_entity WHERE "workflowId" IN (...);
DELETE FROM workflow_entity WHERE id IN (...);
```

After cleanup: only `MailBOX` workflow remained.

### 4. Built MailBOX workflow with 6 nodes (60 min)

**Architecture:**

```
Schedule Trigger (every 1 min — see BL-19 for cadence issue)
  → Gmail (Get Many, label MailBOX-Test, limit 20, simplify off)
  → Set "Extract Fields" (8 fields)
  → HTTP Request "Classify" (POST to ollama:11434, JSON.stringify-wrapped prompt)
  → Set "Merge Classification" (12 fields)
  → Postgres "Store in DB" (Execute Query with ON CONFLICT DO NOTHING)
```

Issues hit during build:
- Label IDs filter rejected initial input ("value not supported"). Working format eventually found.
- Gmail action node hung once due to broken zombie workflow contention. Resolved by killing zombies + restart.
- DNS errors in n8n logs (`EAI_AGAIN`) were transient and unrelated.

**End-to-end success:**

| Execution ID | Trigger Mode | Result |
|---|---|---|
| 66 | manual | Classified 5 emails, all stored |
| 67–70 | trigger | Auto-fired every 60s, dedup correctly skipped existing rows |

`mailbox.inbox_messages` final state:

| id | subject | classification | confidence |
|---|---|---|---|
| 1 | [mailbox-test] post-activation | test | 0.950 |
| 2 | [mailbox-test] smoke test 004 | test | 0.950 |
| 3 | [mailbox-test] smoke test 003 | test | 0.950 |
| 4 | [mailbox-test] smoke test 002 | test | 0.950 |
| 5 | [mailbox-test] smoke test 001 | test | 1.000 |

All 5 classified correctly. Confidence 0.95–1.0. Model attribution captured.

### 5. Discovered Ollama OOM-kill under polling load (BL-18, ~30 min)

After ~5 successful trigger cycles, executions started erroring at the Classify node:

```
"model runner has unexpectedly stopped, this may be due to resource limitations 
or an internal error, check ollama server logs for details"
```

Ollama logs:
```
"llama runner process no longer running" sys=9 string="signal: killed"
```

`signal: killed` with `sys=9` = SIGKILL from Linux OOM-killer.

**Memory math (per Ollama startup logs):**

```
gpu memory available="3.8 GiB" free="4.2 GiB"
total memory size="3.9 GiB"  (model + KV cache)
```

**~300 MiB GPU headroom after model load.** Any temporary memory pressure from another container kicks the OOM-killer into action against Ollama.

Pattern observed: 4 near-simultaneous kill events at 06:45:26 (within 13ms). That's n8n firing 5 parallel HTTP requests to Ollama, each inflating KV cache, blowing through available VRAM.

**Mitigations attempted:**

- Set `OLLAMA_KEEP_ALIVE: "24h"` — ensures model stays loaded between polls. **Applied successfully** (verified: `ollama ps` shows `UNTIL: 24 hours from now`). Helped but didn't eliminate kills.
- Tried to slow polling to 5 minutes — ran into BL-19 (next item).
- Tried to set "Execute Once" on Classify node to serialize inference — not yet applied due to time/state.

**True fix not yet applied** (deferred to next session):
- Reduce model `num_ctx` from 8192 → 4096 (frees ~500 MiB KV cache)
- Or downgrade to Qwen3-1.7B (frees ~1.5 GiB)
- Or add explicit batching/serialization in n8n workflow
- Or move Ollama to host (out of Docker overhead)
- Or upgrade hardware to T3 Mac mini M4 24GB (per PRD)

### 6. Discovered Schedule Trigger config persistence bug (BL-19, ~45 min)

Attempted to slow polling cadence from 1 minute to 5 minutes. UI accepted the value, n8n persisted to DB, but **on workflow load (or at next save) n8n strips the `minutesInterval` field from `parameters.rule.interval[0]`**, leaving only `{"field":"minutes"}` — which defaults the trigger to 1-minute polling.

Sequence tested:
1. UI value entry as `5` (fixed mode) → DB shows `"minutesInterval":"={{ 5 }}"` (n8n auto-converted to expression mode)
2. Direct SQL `UPDATE` to set `"minutesInterval": 5` (plain number) → confirmed in DB → n8n restart → field stripped on load
3. Switched approach: SQL update to use `cronExpression` mode with `*/5 * * * *` → confirmed in DB → n8n restart → also stripped on load, reverted to `{"field":"minutes"}` default

**Conclusion:** something in n8n 1.123.35's Schedule Trigger node deserializer is normalizing the parameters and dropping non-default fields. Either a known bug, a typeVersion mismatch (current node typeVersion is 1.3 in our workflow), or a quirk specific to our setup.

Worth investigating fresh:
- Try changing the node's typeVersion (downgrade to 1.0 or upgrade to latest)
- Try recreating the node (delete and re-add) instead of editing
- Try a different node type (Wait node + loop, or external cron + webhook)
- Check n8n's GitHub for similar reports

**Workaround in the meantime:** the workflow runs every 1 minute (default). This is what was triggering OOM kills. If we can't slow polling at the node level, we either accept the higher cadence and fix OOM (BL-18 above) or use cron-from-the-host calling an n8n webhook trigger.

---

## Decisions this session

| ID | Decision | Type | Rationale |
|---|---|---|---|
| BL-D13 | Schedule Trigger + Gmail Get Many over Gmail Trigger | Strategic | Gmail Trigger has known scheduling bug in n8n; replacement pattern uses Postgres dedup for idempotency. Validated working. |
| BL-D14 | `OLLAMA_KEEP_ALIVE=24h` for production appliance | Tactical | Model reload between polls is wasted work and adds OOM risk. Single-tenant appliance has no reason to unload. Add to T2 production checklist. |
| BL-D15 | Defer Gmail push notifications via Pub/Sub (Option C from yesterday's discussion) | Tactical | Polling-based pattern works for current scope. Reserve push notifications for production hardening or higher-volume customers. Tracked as BL-17. |

---

## Open items going forward

| ID | Item | Priority | Notes |
|---|---|---|---|
| **BL-18** | **(new) Ollama OOM-killed under polling load** | **High** | 300 MiB GPU headroom on 8GB Orin Nano is too tight. Address via `num_ctx` reduction (8192→4096) AND/OR Execute Once on Classify node AND/OR smaller model. |
| **BL-19** | **(new) Schedule Trigger strips `minutesInterval` on load** | **High** | Workflow runs at 1-min default cadence regardless of intended setting. Investigate typeVersion change, node recreation, or alternate scheduling approach. |
| BL-17 | Gmail push notifications via Pub/Sub | Low | Production hardening; defer until polling proves insufficient |
| BL-15 | Document n8n version pin in T2 production spec | Medium | `n8nio/n8n:1.123.35` is the current pin; document why downgrade was needed and risks of upgrading |
| BL-16 | `N8N_PROXY_HOPS=1` env var to silence X-Forwarded-For warnings | Low | Cosmetic |
| BL-7 | Custom jetson-containers Ollama build | Low | Carryover; only worth if 18 t/s baseline becomes user-visible blocker |
| BL-6 | nano/vim in T2 base image provisioning | Low | Provisioning checklist; documentation-only |

**Closed this session:** BL-13 (Gmail Trigger not firing — solved via Schedule Trigger workaround).

**Carried from prior:** BL-3 deduped, infrastructure phase fully closed in v0.6.

---

## What works (status: production-ready or close)

- Jetson hardware + JetPack 6.2 + persistent clock pinning
- Ollama + Qwen3-4B Q4_K_M with `OLLAMA_KEEP_ALIVE=24h`
- Postgres with `mailbox.inbox_messages` schema
- Caddy + Let's Encrypt + Cloudflare DNS for HTTPS
- Gmail OAuth2 with `mail.google.com` scope
- n8n 1.123.35 Schedule Trigger + Gmail Get Many architecture
- Postgres dedup via `ON CONFLICT (message_id) DO NOTHING`
- Qwen3 classification with `/no_think` directive + JSON output format
- End-to-end ingestion flow (mail → classify → store)

## What needs work

- Polling cadence (BL-19): currently locked at 1 min, want 5
- OOM stability (BL-18): VRAM headroom too tight
- Concurrency (BL-18 sub-issue): Classify node fires N parallel calls per cycle when N emails fetched

## What's not built yet (Phase 1 remaining deliverables)

- Deliverable #4: Cloud API draft generation for `action_required` emails
- Deliverable #5: RAG pipeline with email history (Qdrant integration via nomic-embed-text)
- Deliverable #6: Dashboard approval queue UI

---

## T2 production baseline

| Spec | Value |
|---|---|
| Generation rate | 18.66 t/s (Qwen3-4B Q4_K_M) |
| GPU offload | 100% (37/37 layers) |
| Model size | 2.3 GiB weights + 1.1 GiB KV cache + 152 MiB compute graph = 3.9 GiB total |
| GPU memory headroom after model | ~300 MiB (the BL-18 problem) |
| Trigger architecture | Schedule Trigger (every 1 min) → Gmail Get Many (limit 20, label-filtered) |
| Classification latency | ~3 seconds per email at 100% GPU |
| Cycle latency | 13–17 seconds for 5 emails |
| Inference runtime | `ollama/ollama:latest` + `OLLAMA_KEEP_ALIVE=24h` |
| Public TLS | mailbox.heronlabsinc.com via Caddy + Let's Encrypt |
| DNS | Cloudflare-hosted |

---

## Next-session kickoff plan

**Priority 1: Resolve BL-18 (OOM kills) — blocking stable autonomy**

Try fixes in order, cheapest first:

1. **Apply Execute Once on Classify node** (5 min). Forces serial inference instead of parallel. Most likely to be the silver bullet given the 4-near-simultaneous-kill pattern. May need DB-level edit if UI doesn't persist (similar concern as BL-19).
2. **Reduce `num_ctx` to 4096** in the qwen3:4b Modelfile (15 min). Edit Modelfile, recreate model, verify. Frees ~500 MiB.
3. **Test combined effects.** If still OOM under load, escalate to model size reduction or move Ollama to host.

**Priority 2: Resolve BL-19 (Schedule Trigger config persistence)**

1. **Try recreating the Schedule Trigger node** (delete and re-add) instead of editing existing one. Some n8n bugs are about edit-vs-create flow.
2. **Try a higher node typeVersion.** Current node is `typeVersion: 1.3`. Check if 1.4 or higher exists in n8n 1.123.35; if so, recreate node with newer typeVersion.
3. **If neither works**, accept 1-minute cadence and rely on BL-18 fixes to handle the load. This is acceptable for Phase 1 — 1-min latency is fine for email triage.

**Priority 3: Production hardening checklist**

Once stability is good:
1. Document `OLLAMA_KEEP_ALIVE=24h`, `N8N_PROXY_HOPS=1`, n8n version pin in technical PRD
2. Add provisioning notes about Schedule Trigger DB management
3. Add monitoring: dashboard query for failed executions
4. Begin Phase 1 deliverable #4: draft generation workflow for `action_required` emails

---

## Reflections

The shape of this session: one big architectural win surrounded by tooling friction.

The win — Schedule Trigger + Gmail action pattern — is genuinely good engineering. We worked around a known broken n8n component without compromising the pipeline design. The Postgres dedup pattern is elegant: idempotent, safe across crashes, and lets us treat "did we see this email before" as a database concern instead of an in-memory state problem on the trigger.

The friction — three hours fighting Schedule Trigger UI/DB sync and Ollama memory headroom — was largely incidental to the architecture. Fixable, but not in this session.

Two observations worth carrying forward:

1. **n8n at the boundaries of its design is fragile.** When you do "the standard thing" (a single straightforward Gmail trigger), it has well-known bugs. When you customize (set a non-default polling interval, modify config via DB), the persistence layer fights you. For production MailBOX One, this argues for treating n8n's UI as advisory and managing critical workflow state via versioned JSON in git. Worth thinking about for the deployment story.

2. **Orin Nano 8GB is at its limit for this workload.** 300 MiB headroom after a 4B model + KV cache is not "production-comfortable." Once we're shipping appliances, the economics question is whether to: (a) use a smaller model (3B, 1.5B) and accept lower quality, (b) ship T3 from day one, or (c) optimize aggressively (smaller context, batch processing). PRD already identifies T3 as the right answer for full NemoClaw capability — this validates that direction.

Six build logs. Two production-grade days of progress. The pipeline classifies email autonomously. That's the milestone that matters.

---

## Related artifacts

- Build log v0.6: `mailbox-one-t2-build-log-v0_6-2026-04-24.md`
- Build log v0.5 and earlier: chronologically prior infrastructure work
- Technical PRD: `thumbox-technical-prd-v2_1-2026-04-16.md` — **needs amendment with v0.7 baselines**
- Business PRD: `thumbox-business-prd-v2_1-2026-04-16.md`
- Compose: `/home/bob/mailbox/docker-compose.yml` (with `OLLAMA_KEEP_ALIVE=24h`)
- Workflow JSON (current working version): export from n8n UI for backup before next session
