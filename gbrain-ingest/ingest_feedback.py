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
    """Pure: feedback row + Attribution -> (slug, rendered page)."""
    reason = fb.get("reason_code") or "other"
    subject = common.redact_secrets(fb.get("subject") or "(no subject)")
    note = common.redact_secrets((fb.get("free_text") or "").strip())
    excerpt = common.redact_secrets((fb.get("draft_excerpt") or "").strip())
    sender = common.redact_secrets(fb.get("from_addr") or "(unknown sender)")
    account_email = fb.get("account_email") or ""

    slug = f"feedback/{int(fb['id'])}"
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
        "tags": ["draft-feedback", f"reason:{reason}",
                 f"entity:{entity.entity}",
                 "account:" + common.slugify(account_email.split("@")[0])],
    }

    lines = [
        f"# Rejected draft: {subject}",
        "",
        f"On {fb.get('rejected_at', '')} the operator rejected an AI-drafted "
        f"reply on account {account_email}.",
        "",
        f"- Sender: {sender}",
        f"- Classification: {fb.get('classification_category') or 'unknown'}",
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
        f"When drafting replies to {sender} or similar "
        f"{fb.get('classification_category') or ''} emails on "
        f"{account_email}, account for this rejection.",
    ]
    return slug, common.render_page(frontmatter, "\n".join(lines))


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
            since_id = int(wm) if wm else None
    rows = fetch_feedback(since_id, args.limit)
    common.log(f"feedback rows to ingest: {len(rows)} "
               f"(since_id={since_id if since_id is not None else 'ALL'})")

    written = errors = 0
    max_id = since_id
    for fb in rows:
        sender = next(iter(extract_emails(fb.get("from_addr"))), None)
        participants = extract_emails(fb.get("from_addr")) + extract_emails(fb.get("to_addr"))
        # Deterministic ladder: llm_classify_fn stays None (no rung 4).
        entity = attribute(
            fb.get("account_email"), sender, participants,
            fb.get("subject"), fb.get("free_text"),
            crm_lookup=crm_lookup, llm_classify_fn=None, **kwargs,
        )
        slug, content = build_feedback_page(fb, entity)
        if args.dry_run:
            print(f"DRY {entity.entity:10s} r{entity.rung} {slug} "
                  f"[{fb.get('reason_code')}] {(fb.get('subject') or '')[:60]}")
        else:
            try:
                common.gbrain_capture(entity.entity, slug, content,
                                      page_type="draft-feedback")
                written += 1
            except RuntimeError as exc:
                errors += 1
                common.log(f"ERROR {slug}: {exc}")
                continue
        if max_id is None or int(fb["id"]) > max_id:
            max_id = int(fb["id"])

    if not args.dry_run and max_id is not None and not errors:
        common.write_watermark(WATERMARK_FILE, str(max_id))
        common.log(f"watermark -> {max_id}")
    elif errors:
        common.log("errors occurred; watermark NOT advanced (will retry next run)")

    common.log(f"done: written={written} errors={errors}")
    return 1 if errors and not written else 0


if __name__ == "__main__":
    sys.exit(main())
