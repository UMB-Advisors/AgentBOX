# Context — Phase 0: Channel-agnostic schema
Source PRD section: PRD §Phases ▸ Phase 0; §Data model (channel-agnostic); §Decisions D1/D2/D5
Source PRD file: unified-inbox-prd.v0.1.0.md (v0.2.0)
Roadmap: ROADMAP-v1.0.0.md (Phase 0)

This is the ship-it **discuss step** for Phase 0. It captures the concrete schema decisions
so the migration executors need nothing beyond **this file + the PRD**. All migrations in this
phase are **ADDITIVE and backward-compatible** — the existing Gmail/email pipeline keeps working
unchanged. Scope is the Postgres **`mailbox` schema only**.

---

## CRITICAL: ground-truth drift the executor MUST honor

The live mailbox schema is **ahead of the PRD's "current state" description**. The PRD (written
against the email-only mental model) assumes `accounts` is net-new and that `inbox_messages`/`drafts`
have no `account_id`. **This is wrong against the live DB.** Ground truth, read from
`/home/bob/mailbox/dashboard/test/fixtures/schema.sql` (a `pg_dump -s` of customer #1 prod, refreshed
2026-05-01 + hand-applied migrations through 035) and `dashboard/migrations/*.sql`:

1. **`mailbox.accounts` ALREADY EXISTS** (migration 033 / MBOX-348, 2026-05-28). Current shape:
   ```
   accounts(id int GENERATED ALWAYS AS IDENTITY PK,
            email_address text NOT NULL UNIQUE,
            display_label text,
            is_default boolean NOT NULL DEFAULT false,
            created_at timestamptz NOT NULL DEFAULT now())
   partial unique index accounts_one_default ON (is_default) WHERE is_default
   ```
   It is **email-shaped**, not channel-shaped. The PRD's proposed `accounts(channel, display_name,
   identity, credential_ref, enabled, ...)` is a **generalization of this existing table**, not a new
   table. The executor must **ALTER the existing table**, never `CREATE TABLE accounts` (it will
   collide).

2. **`account_id integer NOT NULL` ALREADY EXISTS** on every scoped table (migration 033 backfilled
   it + added FKs to `mailbox.accounts`): `inbox_messages, drafts, classification_log, sent_history,
   kb_documents, vip_senders, auto_send_rules, auto_send_audit, chat_conversations, chat_messages,
   oauth_tokens, draft_feedback, rejected_history`. **Do NOT re-add `account_id`** to these (the PRD
   lists `account_id` under "add to inbox_messages/drafts" — that ask is already satisfied; treat it
   as a no-op / verify-only).

3. **`mailbox.oauth_tokens` ALREADY EXISTS** (migration 031 / MBOX-130+129): one row per Google
   provider, `refresh_token_enc` (AES-256-GCM), `scope`, `account_email`, PK now `(provider,
   account_id)`. This is the **existing credential store for OAuth**. The PRD's new `credentials`
   table is **broader** (oauth | api_key | app_password across all providers). Phase 0 creates
   `credentials` as the **new unified table**; it does NOT migrate or drop `oauth_tokens` (that
   reconciliation is Phase 3 / D4 work). They coexist after Phase 0.

4. **`inbox_messages` uniqueness** is now `UNIQUE(account_id, message_id)` (migration 033 dropped the
   old `inbox_messages_message_id_key`). The new `external_id` column (below) is a **channel-agnostic
   alias/superset of `message_id`**; do not duplicate the unique constraint semantics — see the
   `external_id` decision.

5. **The n8n email pipeline does NOT write `account_id`.** The "Store in DB" node
   (`/home/bob/mailbox/mailbox/n8n/workflows/01-email-pipeline-main.json`) uses n8n column-mapping
   mode and writes exactly: `message_id, thread_id, from_addr, to_addr, subject, received_at, snippet,
   body, classification, classified_at, model, in_reply_to, references`. It relies on the **column
   DEFAULT** for `account_id` (migration 033 set `ALTER COLUMN account_id SET DEFAULT <default_acct>`).
   **Therefore every new NOT NULL column Phase 0 adds MUST carry a DEFAULT** (or be nullable),
   or the n8n INSERT — which never names those columns — will break. This is the load-bearing
   backward-compat constraint for the whole phase.

**Decision (records the reconciliation):** Phase 0 is **additive-over-the-current-live-schema**, not
additive-over-the-PRD's-described-schema. Where the PRD and live DB disagree, the **live DB wins for
what already exists**; the PRD wins for what's genuinely new (`channel`, `external_id`, `sender`,
`recipient`, `thread_ref`, `classification` generalization, `metadata`, nullable `subject`,
`credentials` table). Rationale: Operating Rule 1 (PRD canonical) yields to ground truth on
factual current-state claims — diverging silently would generate colliding `CREATE TABLE`s and a
broken pipeline. **This divergence is logged to STATE Drift watch.**

---

## Decisions captured (the discuss step)

### Migration mechanics & numbering
- **Migration runner:** `dashboard/migrations/runner.ts` against `mailbox.migrations(version text PK)`.
  Files are `NNN-<slug>-v1-YYYY-MM-DD.sql`. Highest live number is **035** (hand-applied to fixture).
  Phase 0 migrations start at **036** and run in order. Rationale: continue the existing sequential
  convention; never renumber prior migrations.
- **Idempotency:** every statement uses `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` /
  `DROP CONSTRAINT IF EXISTS` then `ADD CONSTRAINT`. Re-running a migration is a no-op. Rationale:
  matches the existing migration style (001–035 all do this) and survives partial application.
- **Transaction boundary:** one migration file = one logical change = wrapped so the runner applies it
  atomically. No cross-file dependencies beyond ordering.
- **Reserved word:** `references` is a SQL reserved word and is already a column on `inbox_messages`
  and `drafts`. Any DDL/DML touching it MUST quote it: `"references"`. (Pre-existing; not changed here.)

### `inbox_messages` generalization (PRD §Data model)
Add the following columns. **All NOT NULL additions carry a DEFAULT** so the n8n column-mapped INSERT
(which never names them) keeps working.

| Column | Type | Null? | Default | Notes |
|--------|------|-------|---------|-------|
| `channel` | `text` | NOT NULL | `'email'` | CHECK against the channel enum (below). Default + backfill = `'email'` satisfies "backfill existing rows channel='email'". |
| `external_id` | `text` | NULL | — | Channel-agnostic native message id (Telegram update id, Discord message id, …). For email, **backfill = `message_id`**. Kept nullable so the n8n INSERT (writes `message_id`, not `external_id`) is unaffected; a later migration/pipeline change can populate it. See uniqueness note below. |
| `sender` | `text` | NULL | — | Channel-agnostic sender identity. For email, the semantic equal of `from_addr`; **do not drop `from_addr`** (n8n writes it, queries read it). Backfill `sender = from_addr`. |
| `recipient` | `text` | NULL | — | Channel-agnostic recipient/destination identity. For email, equal of `to_addr`; keep `to_addr`. Backfill `recipient = to_addr`. |
| `thread_ref` | `text` | NULL | — | Channel-agnostic thread/conversation key. For email, equal of `thread_id`; keep `thread_id`. Backfill `thread_ref = thread_id`. |
| `received_at` | — | — | — | **Already exists** (`timestamptz`, nullable). No-op / verify-only. Do NOT re-add. |
| `classification` | — | — | — | **Already exists** (`text`, nullable, indexed). Stays as the channel-agnostic class label. No-op. Do not add a redundant column. |
| `metadata` | `jsonb` | NOT NULL | `'{}'::jsonb` | Channel-specific blob (raw headers, platform payload, attachments refs). Email legacy columns are **kept** (not folded) for back-compat; new channels put their extras here. |
| `subject` | `text` | NULL | — | **Already nullable** in live schema. PRD asks "subject becomes nullable" — already satisfied. No-op / verify-only. Do not add NOT NULL. |
| `account_id` | — | — | — | **Already exists** NOT NULL with DEFAULT + FK (migration 033). No-op. |

- **Decision — keep legacy email columns, don't fold into metadata.** The PRD offers "kept OR folded
  into metadata"; choose **kept**. Rationale: D5 reuse-first + backward-compat — n8n writes
  `from_addr/to_addr/subject/thread_id` by name and `dashboard/lib/queries.ts` reads them. Folding
  would break both. The channel-agnostic columns (`sender/recipient/thread_ref`) are **additive
  aliases** backfilled from the email columns; new channels write the agnostic columns + `metadata`.
- **Decision — `external_id` uniqueness.** Do NOT add a global unique on `external_id` in Phase 0.
  The existing idempotency key is `UNIQUE(account_id, message_id)` and the email pipeline depends on
  it. Channel idempotency (e.g. `UNIQUE(account_id, channel, external_id)`) is **deferred to Phase 2**
  when the ingest webhook actually populates `external_id`. Phase 0 only adds the nullable column +
  backfills it from `message_id` for email rows. Rationale: avoid a unique constraint that would be
  violated by NULLs-from-n8n or by the email pipeline's continued use of `message_id`.

### `channel` enum (CHECK constraint, shared across tables)
- **Decision — use a `text` column + `CHECK` constraint, NOT a Postgres `ENUM` type.** Rationale:
  every existing categorical column in this schema (`status`, `classification`, `draft_source`,
  `kind`, `result`, …) is `text + CHECK`. Adding channels later = `DROP CONSTRAINT … / ADD CONSTRAINT`
  (additive, cheap). A pg `ENUM` would require `ALTER TYPE … ADD VALUE` (can't run in a txn pre-PG12
  patterns, harder to reorder) and breaks the established pattern (Operating Rule: match the codebase).
- **Allowed values (D1 — all channels):**
  ```
  'email','telegram','discord','slack','whatsapp','signal','sms','teams','matrix',
  'mattermost','irc','line','googlechat','ntfy','simplex'
  ```
  This mirrors the Hermes `platforms` plugin adapter set named in the PRD §Current state, plus
  `email`. Constraint name: `inbox_messages_channel_check` (and the parallel `drafts_channel_check`).
  Rationale: enumerate exactly the adapters that exist so a typo'd channel is rejected at write time;
  expanding is a one-line additive migration.

### `drafts` generalization (PRD §Data model)
| Column | Type | Null? | Default | Notes |
|--------|------|-------|---------|-------|
| `channel` | `text` | NOT NULL | `'email'` | CHECK = channel enum. Backfill `'email'`. |
| `account_id` | — | — | — | **Already exists** NOT NULL+DEFAULT+FK (migration 033). No-op. |
| `inbox_message_id` | — | — | — | **Already exists** NOT NULL FK → `inbox_messages(id)`. No-op. |
| `status` | — | — | — | **Already exists** `text NOT NULL DEFAULT 'pending'` with CHECK. See status decision below. |
| `body` | — | — | — | **Already covered.** Live `drafts` has `draft_body text NOT NULL` (the canonical body) plus `body_text text`. **Do NOT add a new `body` column** — it would duplicate `draft_body` and break the `archive_draft_to_sent_history` trigger. Treat the PRD's "`body`" as satisfied by `draft_body`. |

- **Decision — status enum: do NOT widen in Phase 0.** Live `drafts_status_check` already allows
  `pending, awaiting_cloud, approved, rejected, edited, sent` (migration 001; `failed` appears in the
  001 migration source but the live fixture CHECK omits it — see drift note). The PRD's draft status
  set is `pending/approved/sent/rejected` — a **subset** of what exists. No change needed in Phase 0.
  Rationale: additive-only; the channel-agnostic queue reuses the existing state machine, including the
  `state_transitions` audit trigger and `archive_draft_to_sent_history` trigger. Touching the CHECK
  risks the triggers. If a future channel needs a new status, that's a Phase 2/4 additive migration.
- **Decision — `channel` on drafts is denormalized for query convenience**, backfilled to `'email'`
  and (for new rows) copied from the parent `inbox_messages.channel`. Rationale: the native inbox
  filters drafts by channel without a join; mirrors how migration 003 already denormalized email
  fields onto drafts.

### `accounts` generalization (RECONCILE existing table — see drift section)
ALTER the **existing** `mailbox.accounts`; do not create. Add the channel-agnostic columns the PRD
specifies, made compatible with the live email-shaped table:

| Column | Type | Null? | Default | Notes |
|--------|------|-------|---------|-------|
| `channel` | `text` | NOT NULL | `'email'` | CHECK = channel enum. Existing rows backfill to `'email'`. |
| `display_name` | — | — | — | **Map to existing `display_label`.** Do NOT add `display_name`; the live column is `display_label` and migration 033 + dashboard read it. Treat PRD `display_name` ≡ `display_label`. (No-op / alias in docs.) |
| `identity` | `text` | NULL | — | Channel-agnostic account identity (e.g. `@bot`, workspace id). For email rows backfill `identity = email_address`. `email_address` stays (NOT NULL UNIQUE) for email; non-email channels will need that constraint relaxed — **deferred to Phase 2** (Phase 0 only adds `identity` nullable + backfills email rows). |
| `credential_ref` | `text` | NULL | — | FK-ish soft reference to `credentials.account_ref` (text, not a hard FK in Phase 0 to avoid ordering coupling). Nullable; populated in Phase 3. |
| `enabled` | `boolean` | NOT NULL | `true` | PRD's `enabled`. Existing rows default `true`. (Distinct from `is_default`, which stays.) |
| `created_at` | — | — | — | **Already exists.** No-op. |

- **Decision — keep `email_address NOT NULL UNIQUE` and `is_default` as-is in Phase 0.** The
  multi-account email feature (migration 033) depends on them. Generalizing `email_address` to allow
  non-email accounts is **deferred to Phase 2** (when non-email accounts are actually inserted).
  Phase 0 makes `accounts` channel-aware without breaking the email-only invariants. Rationale:
  backward-compat + smallest correct change.

### `credentials` table (NEW — PRD §Data model)
Genuinely new. Create it. Coexists with `oauth_tokens` (which Phase 0 leaves untouched).

```sql
CREATE TABLE IF NOT EXISTS mailbox.credentials (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind             text        NOT NULL,           -- oauth | api_key | app_password
  provider         text        NOT NULL,           -- e.g. 'google','telegram','slack','twilio'
  account_ref      text,                            -- soft link to accounts.credential_ref / identity
  secret_enc       text,                            -- AES-256-GCM ciphertext; NEVER returned to client
  scopes           text,                            -- space- or comma-delimited (mirrors oauth_tokens.scope)
  status           text        NOT NULL DEFAULT 'missing',  -- connected | expired | missing
  last_verified_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credentials_kind_check
    CHECK (kind = ANY (ARRAY['oauth','api_key','app_password'])),
  CONSTRAINT credentials_status_check
    CHECK (status = ANY (ARRAY['connected','expired','missing'])),
  CONSTRAINT credentials_provider_not_blank
    CHECK (length(trim(provider)) > 0)
);
CREATE INDEX IF NOT EXISTS credentials_provider_idx ON mailbox.credentials (provider);
CREATE INDEX IF NOT EXISTS credentials_status_idx   ON mailbox.credentials (status);
CREATE UNIQUE INDEX IF NOT EXISTS credentials_provider_account_ref_uq
  ON mailbox.credentials (provider, account_ref) WHERE account_ref IS NOT NULL;
```

- **Decision — `kind`/`status` as `text + CHECK`** (same rationale as the channel enum: match the
  codebase; additive expansion).
- **Decision — `secret_enc` nullable, AES-256-GCM at rest, never readback.** Matches the existing
  `oauth_tokens.refresh_token_enc` convention (AES-256-GCM per migration 031 comment). Phase 0 only
  creates the column + the security contract; the encryption helper + write-through is **Phase 3**.
  The PRD flags credential write-through as security-critical and requires a threat model before
  Phase 3 — Phase 0 must not expose any read path that returns `secret_enc`.
- **Decision — no hard FK from `credentials` to `accounts` in Phase 0.** Use the soft `account_ref`
  text link. Rationale: avoids insert-ordering coupling and lets credentials exist before an account
  row (and vice-versa); a hard FK can be added in Phase 3 once the write-through owns both sides.
- **Decision — `account_id` on `credentials`?** Add `account_id integer NULL` (no FK enforced in
  Phase 0) for parity with the multi-account model, but **nullable** because a credential may be
  provider-global (one OAuth app) rather than per-account. Rationale: mirrors `oauth_tokens`' move to
  `(provider, account_id)` PK without forcing it before the data exists.

### Backfill (the Phase 0 exit-critical step)
One data migration after the column adds, all guarded so re-runs are safe:
```sql
UPDATE mailbox.inbox_messages
   SET channel     = COALESCE(channel, 'email'),
       sender      = COALESCE(sender, from_addr),
       recipient   = COALESCE(recipient, to_addr),
       thread_ref  = COALESCE(thread_ref, thread_id),
       external_id = COALESCE(external_id, message_id)
 WHERE channel IS NULL OR sender IS NULL OR recipient IS NULL
    OR thread_ref IS NULL OR external_id IS NULL;

UPDATE mailbox.drafts   SET channel = COALESCE(channel, 'email') WHERE channel IS NULL;
UPDATE mailbox.accounts SET channel = COALESCE(channel, 'email'),
                            identity = COALESCE(identity, email_address),
                            enabled  = COALESCE(enabled, true)
 WHERE channel IS NULL OR identity IS NULL;
```
Because `channel`/`enabled` are added with DEFAULT, existing rows already get `'email'`/`true` at
`ADD COLUMN` time; the UPDATE is belt-and-suspenders for the nullable agnostic-alias columns.

### Error handling / edge cases
- **n8n INSERT compat (load-bearing):** verified the email pipeline writes via column-mapping and
  never names new columns ⇒ every new NOT NULL column has a DEFAULT; agnostic alias columns are
  nullable. No n8n workflow change is required in Phase 0.
- **Triggers untouched:** `drafts_log_state_transition` and `archive_draft_to_sent_history` fire on
  `status` change and read `draft_body/from_addr/to_addr/subject/thread_id/account_id` — all
  preserved. Adding `channel` to `drafts` does not affect them (the v030 trigger already carries
  `account_id`; it does not reference `channel`). Do not modify the triggers in Phase 0.
- **`sent_history`/`rejected_history`:** out of Phase 0's "generalize" scope per PRD (PRD names only
  `inbox_messages`, `drafts`, `accounts`, `credentials`). They already carry `account_id`. Leave them;
  channel propagation into history is a later phase if needed.
- **Reserved word `references`:** any new DML touching it must quote it. Phase 0 adds no new use.
- **Default-account collision:** `accounts_one_default` partial unique (one `is_default=true`) is
  preserved; Phase 0 does not insert accounts, so it can't violate it.

---

## Scope boundary
Files / modules this phase may touch:
- `/home/bob/code/tbox/HermesBOX/docs/unified-inbox/migrations/036-*.sql … 0NN-*.sql`
  (NEW migration files authored into the **staging** migrations dir — reviewable only).
- The target of those migrations is the Postgres **`mailbox` schema only** (tables `inbox_messages`,
  `drafts`, `accounts`, new `credentials`). **No other schema.**

Explicitly OUT of scope / DO NOT TOUCH this phase:
- `mailbox2` (anything), live appliance DB, applying migrations, deploying.
- n8n workflows (no edits — compat is achieved via DEFAULTs).
- Hermes dashboard / `hermes_cli/web_server.py` / React (those are Phase 1+).
- `oauth_tokens`, `sent_history`, `rejected_history` table shapes.
- `git`, Linear.

---

## Hand-off to executor
Acceptance criteria (mirrored from ROADMAP Phase 0 / PRD §Phase 0 — every criterion measurable):
- [ ] Migration files exist in the staging `migrations/` dir, numbered from `036`, each idempotent
      (`IF NOT EXISTS` / `DROP…IF EXISTS`+`ADD`), applying cleanly in order against a copy of
      `dashboard/test/fixtures/schema.sql`.
- [ ] `mailbox.inbox_messages` gains `channel` (NOT NULL DEFAULT `'email'`, CHECK enum), `external_id`,
      `sender`, `recipient`, `thread_ref` (nullable), `metadata jsonb NOT NULL DEFAULT '{}'`; existing
      `received_at`/`classification`/`subject`(nullable)/`account_id` left intact.
- [ ] `mailbox.drafts` gains `channel` (NOT NULL DEFAULT `'email'`, CHECK enum); no new `body` column
      (uses `draft_body`); status CHECK unchanged; triggers unchanged.
- [ ] `mailbox.accounts` ALTERed (not re-created) to add `channel`, `identity`, `credential_ref`,
      `enabled`; `email_address`/`is_default`/`display_label` preserved; `display_name`≡`display_label`.
- [ ] `mailbox.credentials` created with `kind`/`provider`/`account_ref`/`secret_enc`/`scopes`/`status`
      /`last_verified_at` (+ `account_id` nullable), CHECK on `kind` (oauth|api_key|app_password) and
      `status` (connected|expired|missing). No read path returns `secret_enc`.
- [ ] **Backfill:** all pre-existing `inbox_messages`/`drafts`/`accounts` rows have `channel='email'`;
      agnostic alias columns backfilled from email columns. `SELECT count(*) FROM mailbox.inbox_messages
      WHERE channel <> 'email'` = 0 on the existing data.
- [ ] **Backward-compat proof (PRD exit):** the existing email pipeline still works on the new schema —
      demonstrated by replaying the n8n "Store in DB" column set (`message_id, thread_id, from_addr,
      to_addr, subject, received_at, snippet, body, classification, classified_at, model, in_reply_to,
      "references"`) as an INSERT against the migrated schema and having it succeed (DEFAULTs supply
      `channel`, `account_id`, `metadata`).
- [ ] Migrations are ADDITIVE only: no `DROP COLUMN`, no `DROP TABLE`, no narrowing of an existing
      CHECK, no new NOT NULL on an existing column without a backfilled DEFAULT.
- [ ] `oauth_tokens`, `sent_history`, `rejected_history` shapes and all triggers are unchanged.

### Notes for the executor
- You need **nothing beyond this file + the PRD**. The exact current shapes are reproduced above from
  `/home/bob/mailbox/dashboard/test/fixtures/schema.sql` and `dashboard/migrations/*.sql`.
- The single biggest trap: **`accounts` and `account_id` already exist** (migration 033). `CREATE
  TABLE accounts` or re-adding `account_id` will collide. ALTER / verify-only, per the drift section.
- The single biggest compat constraint: **every new NOT NULL column needs a DEFAULT** because the n8n
  email INSERT never names new columns.
