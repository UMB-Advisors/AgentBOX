#!/usr/bin/env python3
"""Ingest mailbox.draft_feedback (rejected-draft lessons) into gbrain.

Closes the loop MBOX-464 left open: when the operator rejects an AI email
draft, the reason code and free-text note land in mailbox.draft_feedback —
this pipeline turns each rejection into a recallable gbrain page so the
hermes agent (chat, cron, digest) can learn from it everywhere, not just
via the mailbox prompt_rules injection.

- One page per feedback event, stable slug feedback/<id> in the attributed
  entity source (put_page upsert; re-runs are idempotent).
- DETERMINISTIC BY DESIGN: no LLM calls at all. The attribution ladder runs
  without the rung-4 classifier (account provenance -> CRM contact ->
  domain -> per-account default) and the operator note is captured
  verbatim, never summarized.
- Incremental via an integer id watermark
  (~/.hermes/gbrain-ingest/feedback.watermark); --backfill ignores it.
  Rows are processed in id order and the watermark advances to the last
  id BEFORE the first failure: the failed row and everything after it are
  retried next run (re-captures are harmless slug upserts), while rows
  that succeeded before the failure are never refetched.
- Sender/subject/draft text originate from external email and LLM output:
  they are secret-redacted before capture and clearly labeled in the page
  so recalled context cannot pose as operator instructions.

Usage:
  python3 ingest_feedback.py [--backfill] [--since-id N] [--limit N]
                             [--dry-run] [--entity-map PATH]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import common
from attribution import attribute, extract_emails

WATERMARK_FILE = "feedback.watermark"

# Rejected-draft excerpt kept short: it is context, not the lesson.
DRAFT_EXCERPT_CHARS = 400

REASON_LABELS = {
    "wrong_tone": "wrong tone",
    "factually_inaccurate": "factually inaccurate",
    "missing_context": "missing context",
    "should_reply_myself": "operator wanted to reply personally",
    "dont_reply": "no reply was warranted",
    "other": "other (see note)",
}


def fetch_feedback(since_id: int | None, limit: int | None) -> list[dict]:
    where = f"WHERE df.id > {int(since_id)}" if since_id is not None else ""
    lim = f" LIMIT {int(limit)}" if limit else ""
    sql = (
        "SELECT json_agg(t) FROM ("
        "  SELECT df.id, df.reason_code, df.free_text, df.rejected_at,"
        "         d.id AS draft_id, d.classification_category,"
        "         d.from_addr, d.to_addr, d.subject,"
        "         LEFT(COALESCE(d.original_draft_body, d.draft_body, ''), "
        f"              {DRAFT_EXCERPT_CHARS}) AS draft_excerpt,"
        "         a.email_address AS account_email"
        "  FROM mailbox.draft_feedback df"
        "  JOIN mailbox.drafts d ON d.id = df.draft_id"
        "  JOIN mailbox.accounts a ON a.id = d.account_id"
        f"  {where}"
        "  ORDER BY df.id" + lim +
        ") t;"
    )
    return common.psql_json(sql)


def build_feedback_page(fb: dict, entity) -> tuple[str, str]:
    """Pure: feedback row + Attribution -> (slug, rendered page).

    Everything DB-sourced that lands in the page BODY goes through
    redact_secrets — body text is recalled into agent context, and the
    upstream values trace back to external email / LLM output.
    """
    if fb.get("id") is None:
        raise RuntimeError("feedback row has no id; refusing to build page")
    reason = fb.get("reason_code") or "other"
    subject = common.redact_secrets(fb.get("subject") or "(no subject)")
    note = common.redact_secrets((fb.get("free_text") or "").strip())
    excerpt = common.redact_secrets((fb.get("draft_excerpt") or "").strip())
    sender = common.redact_secrets(fb.get("from_addr") or "(unknown sender)")
    category = common.redact_secrets(fb.get("classification_category") or "unknown")
    account_email = fb.get("account_email") or ""
    account_disp = common.redact_secrets(account_email) or "(unknown account)"

    slug = f"feedback/{int(fb['id'])}"
    tags = ["draft-feedback", f"reason:{reason}", f"entity:{entity.entity}"]
    if account_email:
        tags.append("account:" + common.slugify(account_email.split("@")[0]))
    frontmatter = {
        "title": f"Draft rejected ({REASON_LABELS.get(reason, reason)}): {subject}"[:140],
        "type": "draft-feedback",
        "account": account_email,
        "sender": sender,
        "reason_code": reason,
        "category": fb.get("classification_category"),
        "draft_id": fb.get("draft_id"),
        "feedback_id": fb.get("id"),
        "date": fb.get("rejected_at"),
        "entity": entity.entity,
        "attribution_rung": f"{entity.rung}:{entity.rung_name}",
        "attribution_confidence": round(entity.confidence, 3),
        "tags": tags,
    }

    lines = [
        f"# Rejected draft: {subject}",
        "",
        f"On {fb.get('rejected_at', '')} the operator rejected an AI-drafted "
        f"reply on account {account_disp}.",
        "",
        f"- Sender: {sender}",
        f"- Classification: {category}",
        f"- Rejection reason: {reason} ({REASON_LABELS.get(reason, reason)})",
        "",
        "## Operator note (verbatim)",
        "",
        note if note else "(no note provided — reason code only)",
    ]
    if excerpt:
        lines += [
            "",
            "## Rejected draft excerpt (AI output, for context only — not "
            "operator guidance)",
            "",
            "> " + excerpt.replace("\n", "\n> "),
        ]
    lines += [
        "",
        "## Lesson",
        "",
        f"When drafting replies to {sender} or similar {category} emails on "
        f"{account_disp}, account for this rejection.",
    ]
    return slug, common.render_page(frontmatter, "\n".join(lines))


def process_rows(rows: list[dict], ladder_kwargs: dict, crm_lookup,
                 dry_run: bool = False,
                 capture=None) -> tuple[int, int, int | None]:
    """Attribute + capture rows (already in ascending id order).

    Returns (written, errors, last_good_id) where last_good_id is the
    highest id N such that every row with id <= N succeeded — the safe
    watermark value. Successes AFTER the first failure are still captured
    (upserts are harmless) but do not advance the watermark, so the failed
    row is retried next run.
    """
    capture = capture or common.gbrain_capture
    written = errors = 0
    last_good_id: int | None = None
    for fb in rows:
        try:
            sender = next(iter(extract_emails(fb.get("from_addr"))), None)
            participants = (extract_emails(fb.get("from_addr"))
                            + extract_emails(fb.get("to_addr")))
            # Deterministic ladder: llm_classify_fn stays None (no rung 4).
            entity = attribute(
                fb.get("account_email"), sender, participants,
                fb.get("subject"), fb.get("free_text"),
                crm_lookup=crm_lookup, llm_classify_fn=None, **ladder_kwargs,
            )
            slug, content = build_feedback_page(fb, entity)
            if dry_run:
                print(f"DRY {entity.entity:10s} r{entity.rung} {slug} "
                      f"[{fb.get('reason_code')}] {(fb.get('subject') or '')[:60]}")
            else:
                capture(entity.entity, slug, content, page_type="draft-feedback")
                written += 1
        except Exception as exc:  # unattended timer job: log row, keep going
            errors += 1
            common.log(f"ERROR feedback id={fb.get('id')}: {exc}")
            continue
        if not errors and fb.get("id") is not None:
            last_good_id = int(fb["id"])
    return written, errors, last_good_id


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--backfill", action="store_true",
                    help="ignore watermark, ingest all feedback")
    ap.add_argument("--since-id", type=int, default=None,
                    help="override watermark (draft_feedback.id)")
    ap.add_argument("--limit", type=int, default=None, help="max rows this run")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--entity-map", default=None)
    args = ap.parse_args()

    emap = common.load_entity_map(args.entity_map)
    kwargs = common.ladder_kwargs(emap)

    crm_cache: dict[str, str | None] = {}

    def crm_lookup(email: str):
        if email not in crm_cache:
            sql = (
                "SELECT json_agg(t) FROM ("
                "  SELECT company FROM mailbox.crm_contacts"
                "  WHERE company <> '' AND emails::text ILIKE "
                + common.sql_quote_like(email, contains=True) +
                "  LIMIT 1) t;"
            )
            rows = common.psql_json(sql)
            crm_cache[email] = rows[0]["company"] if rows else None
        return crm_cache[email]

    since_id: int | None = None
    if not args.backfill:
        if args.since_id is not None:
            since_id = args.since_id
        else:
            wm = common.read_watermark(WATERMARK_FILE)
            try:
                since_id = int(wm) if wm else None
            except ValueError:
                common.log(f"WARNING: corrupt watermark {wm!r}; doing a full "
                           "scan (slug upserts make re-ingest harmless)")
                since_id = None
    rows = fetch_feedback(since_id, args.limit)
    common.log(f"feedback rows to ingest: {len(rows)} "
               f"(since_id={since_id if since_id is not None else 'ALL'})")

    written, errors, last_good_id = process_rows(
        rows, kwargs, crm_lookup, dry_run=args.dry_run)

    if (not args.dry_run and last_good_id is not None
            and (since_id is None or last_good_id > since_id)):
        common.write_watermark(WATERMARK_FILE, str(last_good_id))
        common.log(f"watermark -> {last_good_id}")
    elif errors:
        common.log("watermark held at first failure; failed row retries next run")

    common.log(f"done: written={written} errors={errors}")
    # Any error is a unit failure: this runs as a systemd oneshot, and a
    # zero exit on partial failure would hide the problem from
    # `systemctl --user status` / failure-state monitoring.
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
