-- Migration 036 — MBOX-352 (MBOX-162 V2): per-account isolation, SQL layer.
-- WHAT: (1) Adds account_id to mailbox.persona — the one account-scoped table
--       migration 033 skipped (persona predates multi-account and was keyed on
--       customer_key alone). Backfilled to the seeded default account with the
--       same DEFAULT / NOT NULL / FK shape every other scoped table got in 033.
--       Replaces the global UNIQUE(customer_key) with UNIQUE(account_id,
--       customer_key) so each connected mailbox carries its own persona row.
--       (2) Reshapes kb_documents global UNIQUE(sha256) → UNIQUE(account_id,
--       sha256) so two accounts can independently upload the same document
--       (account_id was already added to kb_documents by migration 033; only
--       the dedup key changes here).
-- WHY:  MBOX-162 V2 makes account_id a first-class scoping key at draft time —
--       each inbox drafts in its own voice (persona) against its own corpus
--       (KB). V1 (033) laid the column substrate; this narrows the two dedup
--       keys that were still global. Behaviour is unchanged while the appliance
--       has a single account (every existing row already belongs to the default
--       account, and a single-account filter matches everything).
-- BACKFILL DETERMINISM: one default account today (033 seed) → persona's lone
--       'default' row backfills to it with no ambiguity.
-- NON-BREAKING: persona.account_id gets a DEFAULT = the default account, so the
--       existing single-row upsert path (app/api/persona/*) keeps working
--       untouched until callers pass account_id explicitly (draft-time path
--       does, via the default-account fallback in queries-persona.ts).
-- OUT OF BAND (not SQL): existing Qdrant points need account-aware ids/payload
--       for true per-account RAG isolation. Email points were already payload-
--       tagged with account_id by V1's retag-qdrant-account-id.ts, so the email
--       account_id search FILTER is safe to enable now. kb_documents points are
--       NOT yet tagged, so KB retrieval-side account filtering stays gated until
--       a retag runs. scripts/rekey-qdrant-account-point-ids.ts handles both
--       (email: re-point to sha256(account_id:message_id); kb: add payload
--       account_id). NOT auto-run — moot while accounts=1; run it at the deploy
--       that connects a 2nd inbox.
-- ROLLBACK: restore persona UNIQUE(customer_key) + drop persona.account_id
--       (column / default / fk); restore kb_documents UNIQUE(sha256). The
--       backfill is non-destructive (original rows intact).

-- 1. persona — add the account_id dimension migration 033 skipped.
DO $$
DECLARE
  default_acct integer;
BEGIN
  SELECT id INTO default_acct FROM mailbox.accounts WHERE is_default;
  IF default_acct IS NULL THEN
    RAISE EXCEPTION 'no default account — migration 033 must run before 035';
  END IF;

  ALTER TABLE mailbox.persona ADD COLUMN IF NOT EXISTS account_id integer;
  UPDATE mailbox.persona SET account_id = default_acct WHERE account_id IS NULL;
  EXECUTE format('ALTER TABLE mailbox.persona ALTER COLUMN account_id SET DEFAULT %s', default_acct);
  ALTER TABLE mailbox.persona ALTER COLUMN account_id SET NOT NULL;
  ALTER TABLE mailbox.persona
    ADD CONSTRAINT persona_account_fk FOREIGN KEY (account_id) REFERENCES mailbox.accounts(id);
END $$;

-- Per-account persona uniqueness: each account keeps its own persona row(s),
-- still discriminated by customer_key (always 'default' today). Replaces the
-- global UNIQUE(customer_key) so a 2nd account can hold its own 'default' row.
DROP INDEX mailbox.persona_customer_key_uq;
CREATE UNIQUE INDEX persona_account_customer_key_uq
  ON mailbox.persona (account_id, customer_key);

-- 2. kb_documents — per-account dedup. account_id was added by migration 033;
--    only the global sha256 unique becomes composite so two accounts can upload
--    the same file independently without colliding on the global hash.
ALTER TABLE mailbox.kb_documents DROP CONSTRAINT kb_documents_sha256_unique;
ALTER TABLE mailbox.kb_documents
  ADD CONSTRAINT kb_documents_account_sha256_unique UNIQUE (account_id, sha256);
