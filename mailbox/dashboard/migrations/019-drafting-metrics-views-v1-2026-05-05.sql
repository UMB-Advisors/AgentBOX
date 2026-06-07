-- Migration 019 — STAQPRO-233 (KB Phase 0): drafting telemetry views.
-- WHAT: Two read-only views in the mailbox schema —
--         (1) mailbox.v_drafting_metrics: day × draft_source × classification_category
--             × status rollup of mailbox.drafts. Daily count grain. Powers the
--             "Drafting routes" card on /status (local% vs cloud%).
--         (2) mailbox.v_override_rate: (category × draft_source) rollup of
--             (edited + rejected) / (approved + edited + rejected) over the
--             last 14 days, parameterized via a calendar bound. Powers the
--             "edit rate per category" surface and STAQPRO-235's metric-driven
--             KB nudges.
-- WHY:  Phase 0 of the KB-population streamlining plan
--       (~/.claude/plans/what-do-you-neo-neo-architect-typed-fountain.md).
--       Liotta's blocker: every downstream KB-strategy decision is vibes
--       without a cloud-vs-local-rate metric. Convergent recommendation
--       (Liotta + Linus + Neo Architect) is a Postgres view, not a new
--       event log — the data already exists in mailbox.drafts. Read-only
--       so this lands without touching any write paths.
-- REVERSAL: DROP VIEW mailbox.v_override_rate, mailbox.v_drafting_metrics.
--           Both views are derived; no data loss.
--
-- Note on numbering: STAQPRO-233's spec called this "017" but that slot is
-- taken by STAQPRO-227's last_retry_at column (2026-05-04). Bumped to 019 to
-- preserve the chronological migrations log.

CREATE OR REPLACE VIEW mailbox.v_drafting_metrics AS
SELECT
  date_trunc('day', d.created_at)::date AS day,
  d.draft_source,
  d.classification_category,
  d.status,
  COUNT(*)::bigint AS n
FROM mailbox.drafts d
WHERE d.created_at IS NOT NULL
GROUP BY 1, 2, 3, 4;

-- v_override_rate: per (category × source) edit/reject rate over a 14-day
-- rolling window. Denominator = (approved + edited + rejected) — drafts the
-- operator actually disposed of. Excludes 'pending' / 'awaiting_cloud' so a
-- backlog of unattended drafts doesn't suppress the rate. 'sent' rolls into
-- 'approved' for this view since archival flips status approved → sent in
-- the trigger and we want the original disposition.
--
-- Window is hardcoded at 14 days here. The `getDraftingMetrics(days)` helper
-- in lib/queries-status.ts uses v_drafting_metrics directly with a parametric
-- WHERE on day; v_override_rate is fixed 14d to give STAQPRO-235's nudge UI
-- a stable "what's been bleeding edits this fortnight" surface.
CREATE OR REPLACE VIEW mailbox.v_override_rate AS
SELECT
  d.classification_category,
  d.draft_source,
  COUNT(*) FILTER (WHERE d.status = 'edited')::bigint                                  AS edited,
  COUNT(*) FILTER (WHERE d.status = 'rejected')::bigint                                AS rejected,
  COUNT(*) FILTER (WHERE d.status IN ('approved','edited','sent'))::bigint             AS approved_like,
  COUNT(*) FILTER (WHERE d.status IN ('approved','edited','sent','rejected'))::bigint  AS disposed,
  CASE
    WHEN COUNT(*) FILTER (WHERE d.status IN ('approved','edited','sent','rejected')) = 0 THEN NULL
    ELSE (
      COUNT(*) FILTER (WHERE d.status IN ('edited','rejected'))::numeric
      / NULLIF(COUNT(*) FILTER (WHERE d.status IN ('approved','edited','sent','rejected')), 0)
    )
  END AS edit_reject_rate
FROM mailbox.drafts d
WHERE d.created_at > NOW() - INTERVAL '14 days'
  AND d.classification_category IS NOT NULL
GROUP BY 1, 2;
