-- 009-add-state-transitions-log-v1-2026-05-01.sql
--
-- STAQPRO-185: append-only mailbox.state_transitions log capturing every
-- mailbox.drafts.status change with from/to + actor + timestamp + (optional)
-- reason + (optional) hash_chain. Mirrors the existing classification_log
-- pattern. Outcome of the 2026-05-01 architecture audit (Liotta + Linus +
-- Neo Architect): keep n8n, but borrow this one pattern from autobot-inbox.
--
-- Implemented as a Postgres BEFORE-style AFTER UPDATE trigger so EVERY status
-- change is captured regardless of who initiates it (dashboard route handlers,
-- n8n Postgres nodes inside MailBOX-Send, manual psql, future poll-loop in
-- STAQPRO-187). Caller-supplied actor is read from the session-local GUC
-- `mailbox.actor`; null/unset → 'system'. Caller-supplied reason from
-- `mailbox.transition_reason` (optional).
--
-- Reversal: DROP TRIGGER + DROP FUNCTION + DROP TABLE in reverse order. The
-- log is append-only (no UPDATE/DELETE policy) but losing it on rollback is
-- acceptable for a Phase 2 audit foundation that hasn't yet been used by any
-- read path.

CREATE TABLE mailbox.state_transitions (
    id          bigserial PRIMARY KEY,
    draft_id    integer NOT NULL REFERENCES mailbox.drafts(id) ON DELETE CASCADE,
    from_status text NOT NULL,
    to_status   text NOT NULL,
    transitioned_at timestamptz NOT NULL DEFAULT NOW(),
    actor       text NOT NULL DEFAULT 'system',
    reason      text,
    hash_chain  text  -- nullable until backfill lands; sha256(prev_hash || row_payload) per Optimus P3
);

CREATE INDEX state_transitions_draft_id_idx
    ON mailbox.state_transitions (draft_id, transitioned_at DESC);

CREATE INDEX state_transitions_transitioned_at_idx
    ON mailbox.state_transitions (transitioned_at DESC);

-- Trigger function: fires on every UPDATE of mailbox.drafts where status
-- actually changed. Reads optional session-local context vars set by callers.
CREATE OR REPLACE FUNCTION mailbox.log_draft_state_transition()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        INSERT INTO mailbox.state_transitions (draft_id, from_status, to_status, actor, reason)
        VALUES (
            NEW.id,
            OLD.status,
            NEW.status,
            COALESCE(NULLIF(current_setting('mailbox.actor', true), ''), 'system'),
            NULLIF(current_setting('mailbox.transition_reason', true), '')
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER drafts_log_state_transition
    AFTER UPDATE OF status ON mailbox.drafts
    FOR EACH ROW
    EXECUTE FUNCTION mailbox.log_draft_state_transition();
