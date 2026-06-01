# Verify — Phase 0: Channel-agnostic schema
Source PRD: unified-inbox-prd.v0.1.0.md (v0.2.0, 2026-06-01)
Roadmap: ROADMAP-v1.0.0.md (Phase 0)
Context: CONTEXT-phase-0-v1.0.0.md
Verified: 2026-06-01
Method: empirical — fixture loaded + all four migrations applied/exercised on a throwaway
        **PostgreSQL 17.9** container (matches prod `pg_dump` version), not a paper read.

---

## Verdict: **PASS** (with one non-blocking promotion-time fix — file numbering)

The four migrations under review are **additive, backward-compatible, compose cleanly in their
intended order (036 → 008 → 009 → 010), are idempotent, and are reversible.** Every Phase 0
acceptance criterion from the ROADMAP/PRD passes when exercised against a real copy of the live
`mailbox` schema (`dashboard/test/fixtures/schema.sql`). The running Gmail/n8n pipeline's exact
INSERT column set succeeds unchanged on the migrated schema.

The single issue is **cosmetic/operational, not correctness**: three of the four files are numbered
`008/009/010` (staging-local slugs) which **collide in lexical sort order with the live
`dashboard/migrations/008/009/010` files** and would, if dropped into the runner dir as-is, sort to
run *before* migration 033 (which they depend on). They are in the **reviewable staging dir only**, so
this does not affect Phase 0 correctness — but it **must be renumbered to ≥037 before promotion**. The
`009` file already flags this in its header; `008`, `010` do not. Details in §Issues.

---

## How this was verified (evidence trail)

1. Started `postgres:17-alpine` (prod dump is "database version 17.9"; PG16 rejects the fixture's
   `transaction_timeout` GUC — confirms version sensitivity).
2. Loaded `/home/bob/mailbox/dashboard/test/fixtures/schema.sql` — **exit 0**. (Note the correct
   dashboard path is `/home/bob/mailbox/dashboard/...`, single `mailbox`, not the double-`mailbox`
   path in the task brief; the n8n path *is* the double `/home/bob/mailbox/mailbox/n8n/...`.)
3. Confirmed baseline: the fixture is a pre-033 `pg_dump` **plus** hand-applied migration blocks
   031–035 appended as `DO $$` blocks (lines ~1202–1317). The 033 block adds `account_id` to
   `inbox_messages`/`drafts`/etc. via `EXECUTE format('ALTER TABLE … ADD COLUMN account_id …')`, so
   `account_id` **does** exist post-load — the CONTEXT's ground-truth-drift claims are accurate.
4. Applied `036, 008, 009, 010` each in its own transaction (`psql -1`) — **all exit 0**.
5. Exercised behavior (results below), then idempotent re-run (all exit 0) and full rollback (clean).
6. Tore down the container.

---

## Acceptance criteria — pass/fail per criterion

### AC-1 — "Migrations apply cleanly to a copy of the mailbox Postgres with zero errors and are reversible (down migration restores prior schema)." → **PASS**
- Apply in order 036→008→009→010: every file exit 0, zero errors.
- Idempotent re-run of all four: exit 0, no-ops (`ADD COLUMN IF NOT EXISTS` / `DROP CONSTRAINT IF
  EXISTS`+`ADD` / `CREATE TABLE IF NOT EXISTS`). The expected `NOTICE: constraint … does not exist,
  skipping` on first run is benign.
- Reversibility: ran the documented down-DDL (drop the 4 new accounts cols + their CHECK, the 6 new
  inbox cols + CHECK, the drafts `channel` col + CHECK, and `DROP TABLE credentials`). Result: 0
  leftover new columns, `credentials` gone, **all 6 pre-existing inbox columns incl. `account_id`
  preserved**. Reversible confirmed.
- Caveat (doc-only, non-blocking): the **008 file has no ROLLBACK comment** in its header, while 036,
  009, 010 do. The reverse DDL is trivially derivable and proven to work, but the header should carry
  it for parity with the sibling files. See ISSUE-2.

### AC-2 — "After backfill, every pre-existing inbox_messages and drafts row has channel='email' and a non-null account_id; row counts unchanged." → **PASS**
- `channel` added `NOT NULL DEFAULT 'email'` ⇒ every existing row gets `'email'` at ADD-COLUMN time;
  the belt-and-suspenders `UPDATE … COALESCE(channel,'email')` confirms it. `SELECT count(*) …
  WHERE channel <> 'email'` = **0**.
- `account_id` is pre-existing `NOT NULL DEFAULT <default_acct>` (migration 033) — untouched, stays
  non-null. The migrations correctly do **not** re-add it.
- No row is deleted/duplicated; only `ADD COLUMN` + guarded `UPDATE` ⇒ counts unchanged.
- Alias backfill also verified: a seeded pre-existing-style row got
  `sender=from_addr, recipient=to_addr, thread_ref=thread_id, external_id=message_id`.

### AC-3 — "The existing email pipeline (n8n MailBOX poll/classify → inbox_messages → drafts) runs end-to-end on the new schema and writes a new email message + draft without error." (PRD Phase 0 Exit) → **PASS**
- Pulled the **exact** column set the n8n "Store in DB" node writes (verified from
  `n8n/workflows/01-email-pipeline-main.json`, `mappingMode: defineBelow`): `confidence, message_id,
  thread_id, from_addr, to_addr, subject, received_at, snippet, body, classification, classified_at,
  model, in_reply_to, "references"`. The node names **none** of the new columns and **not**
  `account_id`.
- Replayed that literal INSERT (incl. the reserved word `"references"`) against the migrated schema:
  **exit 0**, row landed with `channel='email'`, `account_id=1`, `metadata={}` — all from DEFAULTs.
  This is the load-bearing backward-compat proof.
- Draft side: an INSERT into `mailbox.drafts` omitting `channel` succeeds and defaults `channel='email'`.
- No n8n workflow edit is required by Phase 0 — confirmed (only one postgres write node exists across
  all workflows, and it is satisfied by the DEFAULTs).

### AC-4 — "drafts.status still transitions pending→approved→sent and pending→rejected on the new schema." → **PASS**
- `drafts_status_check` is **unchanged** by these migrations (verified `pg_get_constraintdef`): it
  still allows the superset `pending, awaiting_cloud, approved, rejected, edited, sent`. The PRD's
  set is a subset — already satisfied, correctly not widened/narrowed.
- Ran `pending → approved → sent`: the `drafts_log_state_transition` trigger fired (2
  `state_transitions` rows) **and** the `archive_draft_to_sent_history` trigger fired on `→sent` (1
  `sent_history` row written). Both triggers read only pre-existing columns
  (`draft_body/from_addr/to_addr/subject/thread_id/account_id/…`), none of which the migrations touch.
- `pending → rejected` is within the unchanged CHECK and exercises the same trigger path.

---

## Rigorous checks requested in the task

### (a) ADDITIVE — nothing dropped/renamed the Gmail n8n flow or dashboard queries depend on → **PASS**
- No `DROP COLUMN`, no `DROP TABLE`, no column rename, no CHECK narrowing anywhere in the four files.
- Legacy email columns (`from_addr, to_addr, subject, thread_id, message_id, body, snippet,
  "references", in_reply_to, confidence`) are **kept**, not folded into `metadata` — n8n writes them
  and `dashboard/lib/queries.ts` reads them.
- `inbox_messages_account_message_uq UNIQUE(account_id, message_id)` (the email idempotency key)
  is untouched; no global unique on `external_id` is added (correctly deferred to Phase 2).
- `oauth_tokens`, `sent_history`, `rejected_history` shapes and both triggers: untouched/intact.

### (b) The four migrations COMPOSE cleanly in order (no conflicting/duplicate columns, FK targets exist) → **PASS**
- Each file targets a distinct table (036=accounts, 008=inbox_messages, 009=drafts, 010=credentials).
  The only repeated column name is `channel`, added once per table — no duplication within a table.
- The two channel CHECK value-lists (`inbox_messages_channel_check`, `drafts_channel_check`,
  `accounts_channel_check`) are **byte-identical** in their 15 allowed values, so a row and its parent
  can never disagree on an allowed channel.
- **FK targets:** `credentials` defines **no hard FKs** by design (soft `account_ref` text +
  nullable `account_id` with no FK) — so there is no FK-target-missing risk. The migrations correctly
  do not add a hard FK before both sides' write-through exists (Phase 3). `accounts.credential_ref`
  is likewise a soft text link, no FK. ✔
- Dependency ordering within the set: 008/009 read no cross-file objects; 010 creates a standalone
  table; 036 alters an existing table. They are order-independent among themselves **given** the live
  033 baseline. The hard dependency is **on migration 033 existing first** (for `account_id`), which
  the 009 file even asserts via a `DO $$ … RAISE EXCEPTION` guard — verified that guard passes on the
  033-applied fixture.

### (c) Backfills set channel='email' so existing rows stay valid → **PASS**
- DEFAULT `'email'` on `ADD COLUMN` + the COALESCE `UPDATE`s give every pre-existing
  `inbox_messages`/`drafts`/`accounts` row `channel='email'`. `accounts` rows also get
  `identity = email_address`, `enabled = true`. Verified `WHERE channel<>'email'` = 0.

### (d) Types/enums are sane → **PASS**
- `channel`, `kind`, `status` are `text + CHECK` (not pg `ENUM`) — matches every existing categorical
  column in the schema (Operating Rule: match the codebase) and makes future widening an additive
  `DROP/ADD CONSTRAINT`.
- Enforcement proven: `channel='myspace'` rejected; `credentials.kind='password'` rejected;
  `credentials.status='revoked'` rejected; blank provider rejected; `(provider, account_ref)` partial
  unique enforced.
- `metadata jsonb NOT NULL DEFAULT '{}'::jsonb`, `credentials.id integer GENERATED ALWAYS AS
  IDENTITY` (mirrors `accounts`), timestamptz defaults `now()` — all sane and consistent.

### (e) ROADMAP Phase 0 acceptance criteria met → **PASS** (see AC-1…AC-4 above; all PASS).

---

## Issues found (file:concern)

### ISSUE-1 — **Promotion-time file numbering collision** (non-blocking for Phase-0 correctness; **blocking before promotion into the runner dir**)
- **Files:** `008-generalize-inbox-messages-v1.sql`, `009-generalize-drafts-v1.sql`,
  `010-create-credentials-v1.sql`.
- **Concern:** The live runner (`dashboard/migrations/runner.ts`) discovers files via
  `readdir(...).sort()` (lexical) and tracks applied versions by **full filename**. The live dir
  already contains `008-broaden-draft-source-…`, `009-add-state-transitions-log-…`,
  `010-fix-sent-history-…`. If these staging files were copied into `dashboard/migrations/` as-is,
  they would sort as `008-broaden… < 008-generalize…`, i.e. **`008-generalize-inbox-messages` would
  run at sort position ~008 — *before* `033-add-account-id-multi-account`** that creates the
  `account_id` they assume. On a *fresh* DB rebuilt from migrations (not the hand-patched fixture),
  that ordering would fail (008-generalize is fine without account_id, but 009's `DO $$` guard would
  `RAISE EXCEPTION` "apply the account_id migration before this one").
- **Why it didn't surface here:** the fixture already has 033 applied, and I applied the staging files
  by explicit name in intended order. The runner's *sort* order is the trap.
- **Status:** These live in the **reviewable staging dir** (`docs/unified-inbox/migrations/`), not the
  runner dir — so Phase 0 *as a schema design* is correct. The `009` header explicitly flags "renumber
  to the next free live number (≥036) at promotion." The CONTEXT reserves 036+. But `036` is already
  taken by the accounts file, so the actual free range is **037+**.
- **Fix (at promotion, not now — review-only phase):** rename the three files to the next free live
  numbers in dependency order, e.g.
  `037-generalize-inbox-messages-v1-2026-06-01.sql`,
  `038-generalize-drafts-v1-2026-06-01.sql`,
  `039-create-credentials-v1-2026-06-01.sql`,
  and keep `036-generalize-accounts-…` as-is (or renumber the whole set 036–039 consistently). Ensure
  `accounts` (036) applies before `credentials`'s soft `account_ref` semantics matter (no hard
  ordering needed, but keep accounts first for readability). Add the same "renumber at promotion"
  header note to the `008` and `010` files for parity with `009`.

### ISSUE-2 — **Missing ROLLBACK header note in 008** (cosmetic, non-blocking)
- **File:** `008-generalize-inbox-messages-v1.sql`.
- **Concern:** 036, 009, 010 each document their reverse DDL in the header; 008 only states
  "ADDITIVE … no DROP". For consistency and operator safety, add the explicit down-DDL:
  `ALTER TABLE mailbox.inbox_messages DROP CONSTRAINT IF EXISTS inbox_messages_channel_check;`
  `ALTER TABLE mailbox.inbox_messages DROP COLUMN IF EXISTS channel, … external_id, … sender, …
  recipient, … thread_ref, … metadata;` (proven clean in this verify).

### ISSUE-3 — **Task-brief path discrepancy** (informational; not a migration defect)
- The task brief referenced `/home/bob/mailbox/mailbox/dashboard/migrations/*.sql` and
  `…/mailbox/dashboard/test/fixtures/schema.sql` (double `mailbox`). The actual dashboard tree is at
  **`/home/bob/mailbox/dashboard/...`** (single). The n8n tree *is* at
  **`/home/bob/mailbox/mailbox/n8n/...`** (double). The migrations' own comments reference the correct
  single-`mailbox` dashboard path, so no migration content is wrong — flagging only so the next
  executor uses the right paths.

---

## Non-issues (checked and cleared)

- **`subject` nullability** — already nullable in the live schema; migrations correctly treat it as a
  no-op (do not add a redundant NOT NULL). ✔
- **`body`/`draft_body`** — 009 correctly does **not** add a `body` column; the `DO $$` guard asserts
  `draft_body` exists. No duplicate body, triggers safe. ✔
- **`received_at`, `classification`** on inbox_messages — pre-existing; correctly not re-added. ✔
- **`oauth_tokens` coexistence** — `credentials` is genuinely new and does not touch/migrate
  `oauth_tokens`; the Phase 3 reconciliation is correctly deferred. ✔
- **Reserved word `"references"`** — untouched by all four files; the n8n INSERT carrying it succeeds. ✔
- **`accounts_one_default` partial unique** — preserved; Phase 0 inserts no account rows, so it can't
  be violated. ✔

---

## PRD-vs-reality note (per ship-it Operating Rule 1)
The PRD §Data model describes `accounts`, `account_id`, and `inbox_messages`/`drafts` generalization as
if net-new. The **live DB is ahead of the PRD** (migrations 031/033 already added `accounts`,
`account_id`, `oauth_tokens`). The migrations correctly follow the **CONTEXT's documented
reconciliation** (live DB wins on current-state facts; PRD wins on genuinely-new objects) rather than
the PRD's stale current-state text. This divergence is already logged to STATE Drift watch per the
CONTEXT. **No silent divergence from the PRD's *intent*** — the channel-agnostic target shape is fully
realized. This is the correct handling, not a defect.

---

## Fix list (only ISSUE-1 is required, and only at promotion — review-only phase, do not edit now)
1. **(Required, at promotion)** Renumber `008/009/010` staging files to free live numbers **≥037** in
   dependency order before copying into `dashboard/migrations/`; verify `readdir().sort()` order runs
   them after `033`. (ISSUE-1)
2. **(Recommended)** Add the explicit down-DDL header note to `008`; add the "renumber at promotion"
   note to `008` and `010` for parity with `009`. (ISSUE-2)
3. **(Informational)** Use the correct paths (`/home/bob/mailbox/dashboard/...` for dashboard,
   `/home/bob/mailbox/mailbox/n8n/...` for n8n) in downstream phases. (ISSUE-3)

**Gate to Phase 1:** Phase 0 schema design **PASSES** verification and may proceed to Phase 1 planning.
The renumber (ISSUE-1) is a promotion/apply-time action gated before these migrations are run against
the live `mailbox` DB — it does not block Phase 1 design work, which reads the target shape, not the
file numbers.
