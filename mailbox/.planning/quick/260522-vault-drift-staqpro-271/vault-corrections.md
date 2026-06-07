# Vault corrections — apply these to ~/vault

## 1. `Memory/Projects/UMB Advisors MailBOX.md`

**Find** (in the 2026-05-21 current-state entry):

> Latent 2nd bug: `Mark Sent` had no creds in JSON, never observed because `Load Draft` failed first.
> ...
> 3 duplicate replies sent to Dustin during debugging (raw webhook bypasses STAQPRO-271
> "may have already sent" gate — Dustin's email was a test).

**Replace with:**

> **Correction (2026-05-22 investigation):** The "Mark Sent had no creds in JSON / Load Draft failed first" framing
> was wrong. Live `workflow_entity.nodes` on M1 confirms BOTH `Load Draft` and `Mark Sent` have Postgres
> credentials wired correctly (`id=JFX4tvrffvKnTouV`, name `MailBox Postgres`). Only the saved JSON
> at `n8n/workflows/MailBOX-Send.json` strips them — a STAQPRO-139 round-trip script bug, not a
> runtime bug. Runtime is fine.
>
> The "3 duplicate replies to Dustin" were on **2026-05-18 20:20 UTC** (not 2026-05-21), and were
> 3 DIFFERENT drafts (ids 62, 53, 13 with 3 different `inbox_message_id`s) hand-fired in 3 seconds
> during a debugging session. MailBOX-Send already has correct idempotency: `Load Draft` filters
> `WHERE status IN ('approved','edited')` + `Already Sent?` IF on `sent_gmail_message_id notEmpty`.
> No dedupe gate was bypassed. See `mailbox/.planning/quick/260522-vault-drift-staqpro-271/`.

## 2. `Memory/_index.md` — Active Decisions table row for MailBOX 2026-05-21

**Find** the cell ending:

> ...3 duplicate replies sent to Dustin during debugging (raw webhook bypasses STAQPRO-271
> "may have already sent" gate — Dustin's email was a test).

**Replace with:**

> ...First `sent_history` row on M2 (was 0 forever). Root cause: n8n 2.x publish/draft duality.
> Fix: bcrypt-reset Eric's n8n password, then editor-Publish via UI. Draft 212 → exec 5209 success
> → Gmail Sent verified. **Vault-correction 2026-05-22:** the "3 dupes to Dustin" line previously
> attributed to this session was actually a separate M1 incident on 2026-05-18 with 3 different
> draft_ids — not a dedupe failure. See `mailbox/.planning/quick/260522-vault-drift-staqpro-271/`.

## 3. `Daily Notes/2026-05-21 MailBOX — Send pipeline unblocked (STAQPRO-177) + n8n publish-draft duality + 29 stale branch cleanup.md`

Append a correction block at the end:

```markdown

## Correction — 2026-05-22

The "3 duplicate replies sent to Dustin during debugging" line in this note conflated two
separate incidents:

1. **2026-05-18 20:20 UTC on M1** — execs 9198/9199/9200, three different draft_ids
   (62, 53, 13) with three different `inbox_message_id`s. Three legitimate sends.
   No idempotency failure.
2. **2026-05-22 02:26 UTC on M2** — exec 5209, the actual first `sent_history` row
   on M2 (this session's win).

The "raw webhook bypasses STAQPRO-271 gate" framing in this note is wrong on every
clause: STAQPRO-271 is the Gmail cooldown gate (not a dedupe gate), no gate was
bypassed, and the M1 incident wasn't a dedupe failure. MailBOX-Send already enforces
idempotency via `Load Draft` status filter + `Already Sent?` IF on `sent_gmail_message_id`.

Investigation artifact: `~/mailbox/.planning/quick/260522-vault-drift-staqpro-271/`
```

## 4. New memory file — round-trip credential drift

Create `~/.claude/projects/-Users-ericgang/memory/project_n8n_jsonsync_creds_strip.md`:

```markdown
---
name: project-n8n-jsonsync-creds-strip
description: MailBOX n8n round-trip script (STAQPRO-139) strips Postgres credential refs from saved workflow JSONs
metadata:
  type: project
---

`n8n/workflows/MailBOX-Send.json` (and probably the other three) has empty `credentials` on
Postgres nodes, while live `workflow_entity.nodes` on M1 has them wired
(`{"postgres": {"id": "JFX4tvrffvKnTouV", "name": "MailBox Postgres"}}`).

Runtime is unaffected — the live n8n DB is the source of truth for activation. But re-importing
the saved JSON into a fresh n8n instance (e.g. customer #3 provisioning) would break Load Draft
and Mark Sent until creds are re-wired in the editor.

**Why:** The round-trip dump script in `scripts/n8n-sync-from-bob.sh` (or similar; STAQPRO-139)
appears to strip the `credentials` object on Postgres nodes when serializing. Gmail Reply node
retained its `gmailOAuth2` credential (`vEz5mz0uaAtlK8yz`), so the bug is Postgres-specific.

**How to apply:** Before customer #3 install, either (a) hand-patch all 4 workflow JSONs to
include the Postgres credential ref, or (b) fix the round-trip script. The shared
"MailBox Postgres" credential id is **`JFX4tvrffvKnTouV`** per `dashboard/CLAUDE.md` n8n
Boundary Contract.

[[feedback-vault-todo-drift]] — this finding came out of correcting a different vault drift,
which means the round-trip strip has been silent and harmless until now.
```

And append to `MEMORY.md`:
```
- [n8n JSON-sync strips Postgres creds](project_n8n_jsonsync_creds_strip.md) — round-trip leak, runtime fine, would break re-import on customer #3
```
