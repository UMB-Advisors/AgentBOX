#!/usr/bin/env python3
"""Ingest mailbox.inbox_messages into gbrain — one page PER THREAD.

- Stable slug email/<thread_id> in the attributed entity source (5-rung
  ladder: account provenance -> CRM contact -> domain -> local qwen3
  classifier -> per-account default). Re-running rebuilds the same pages
  (put_page upsert), so incremental runs that touch an old thread refresh
  the whole thread page.
- Body = subject + sender + a local-qwen3 summary (single serial ollama
  call, 20s timeout, degrades to snippets on failure) + per-message log.
- Incremental via a received_at watermark file
  (~/.hermes/gbrain-ingest/email.watermark); --backfill ignores it.
- Strictly serial: max 1 concurrent LLM call (shared 8GB box).

Usage:
  python3 ingest_email.py [--backfill] [--since ISO8601] [--limit N]
                          [--dry-run] [--no-llm] [--entity-map PATH]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import common
from attribution import attribute, extract_emails

WATERMARK_FILE = "email.watermark"

MSG_COLS = (
    "m.id, m.message_id, m.thread_id, m.from_addr, m.to_addr, m.subject,"
    " m.received_at, m.snippet, m.body, a.email_address AS account_email"
)


def fetch_new_thread_ids(since: str | None, limit: int | None) -> list[dict]:
    where = f"WHERE m.received_at > {common.sql_quote(since)}" if since else ""
    lim = f" LIMIT {int(limit)}" if limit else ""
    sql = (
        "SELECT json_agg(t) FROM ("
        "  SELECT m.thread_id, m.account_id, MAX(m.received_at) AS max_received"
        f"  FROM mailbox.inbox_messages m {where}"
        "  GROUP BY m.thread_id, m.account_id"
        "  ORDER BY max_received" + lim +
        ") t;"
    )
    return common.psql_json(sql)


def fetch_thread_messages(thread_id: str, account_id: int) -> list[dict]:
    sql = (
        "SELECT json_agg(t) FROM ("
        f"  SELECT {MSG_COLS}"
        "  FROM mailbox.inbox_messages m"
        "  JOIN mailbox.accounts a ON a.id = m.account_id"
        f"  WHERE m.thread_id = {common.sql_quote(thread_id)}"
        f"    AND m.account_id = {int(account_id)}"
        "  ORDER BY m.received_at"
        ") t;"
    )
    return common.psql_json(sql)


def summarize_thread(msgs: list[dict], emap: dict, no_llm: bool) -> str:
    """One serial qwen3 call; degrade to snippet stitch on any failure."""
    snippets = "\n".join(
        f"- {m.get('received_at', '')} {m.get('from_addr', '')}: {(m.get('snippet') or '')[:300]}"
        for m in msgs
    )
    if no_llm:
        return snippets
    cfg = emap.get("summarizer", {})
    convo = "\n\n".join(
        f"From: {m.get('from_addr', '')}\nDate: {m.get('received_at', '')}\n"
        f"{(m.get('body') or m.get('snippet') or '')[:1500]}"
        for m in msgs[-6:]
    )
    prompt = (
        "Summarize this email thread in 2-4 plain sentences: who is involved, "
        "what it is about, and any action needed. No preamble.\n\n"
        f"Subject: {msgs[-1].get('subject') or '(no subject)'}\n\n{convo}"
    )
    summary = common.ollama_generate(
        prompt,
        url=cfg.get("ollama_url", "http://127.0.0.1:11435"),
        model=cfg.get("model", "qwen3:4b-instruct"),
        timeout=int(cfg.get("timeout_seconds", 20)),
    )
    return summary or snippets


def build_thread_page(msgs: list[dict], entity, emap: dict, no_llm: bool) -> tuple[str, str]:
    latest = msgs[-1]
    thread_id = latest.get("thread_id") or latest["message_id"]
    subject = next((m["subject"] for m in reversed(msgs) if m.get("subject")), "(no subject)")
    account_email = latest.get("account_email", "")

    participants: list[str] = []
    for m in msgs:
        for addr in extract_emails(m.get("from_addr")) + extract_emails(m.get("to_addr")):
            if addr not in participants:
                participants.append(addr)

    slug = "email/" + common.slugify(str(thread_id), max_len=64)
    summary = summarize_thread(msgs, emap, no_llm)

    frontmatter = {
        "title": subject[:140],
        "type": "email-thread",
        "account": account_email,
        "from": latest.get("from_addr"),
        "to": latest.get("to_addr"),
        "date": latest.get("received_at"),
        "thread_id": thread_id,
        "entity": entity.entity,
        "attribution_rung": f"{entity.rung}:{entity.rung_name}",
        "attribution_confidence": round(entity.confidence, 3),
        "tags": ["email", f"entity:{entity.entity}",
                 "account:" + common.slugify(account_email.split("@")[0])],
    }
    body = "\n".join([
        f"# {subject}",
        "",
        f"Thread of {len(msgs)} message(s) on account {account_email}.",
        f"Latest from: {latest.get('from_addr', '')}",
        "",
        "## Summary",
        "",
        summary,
        "",
        "## Messages",
        "",
        *(f"- {m.get('received_at', '')} | {m.get('from_addr', '')}: "
          f"{(m.get('snippet') or '')[:200]}" for m in msgs),
    ])
    return slug, common.render_page(frontmatter, body)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--backfill", action="store_true", help="ignore watermark, ingest all threads")
    ap.add_argument("--since", default=None, help="override watermark (ISO8601 timestamptz)")
    ap.add_argument("--limit", type=int, default=None, help="max threads this run")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-llm", action="store_true", help="skip summarizer and classifier")
    ap.add_argument("--entity-map", default=None)
    args = ap.parse_args()

    emap = common.load_entity_map(args.entity_map)
    kwargs = common.ladder_kwargs(emap)
    classify = None if args.no_llm else common.make_llm_classifier(emap)

    crm_cache: dict[str, str | None] = {}

    def crm_lookup(email: str):
        if email not in crm_cache:
            sql = (
                "SELECT json_agg(t) FROM ("
                "  SELECT company FROM mailbox.crm_contacts"
                "  WHERE company <> '' AND emails::text ILIKE "
                + common.sql_quote(f"%{email}%") +
                "  LIMIT 1) t;"
            )
            rows = common.psql_json(sql)
            crm_cache[email] = rows[0]["company"] if rows else None
        return crm_cache[email]

    since = None
    if not args.backfill:
        since = args.since or common.read_watermark(WATERMARK_FILE)
    threads = fetch_new_thread_ids(since, args.limit)
    common.log(f"threads to (re)build: {len(threads)} (since={since or 'ALL'})")

    written = errors = 0
    max_received = since
    for t in threads:
        if not t.get("thread_id"):
            continue
        msgs = fetch_thread_messages(t["thread_id"], t["account_id"])
        if not msgs:
            continue
        latest = msgs[-1]
        sender = next(iter(extract_emails(latest.get("from_addr"))), None)
        participants = []
        for m in msgs:
            participants += extract_emails(m.get("from_addr")) + extract_emails(m.get("to_addr"))
        entity = attribute(
            latest.get("account_email"), sender, participants,
            latest.get("subject"), latest.get("snippet"),
            crm_lookup=crm_lookup, llm_classify_fn=classify, **kwargs,
        )
        slug, content = build_thread_page(msgs, entity, emap, args.no_llm)
        if args.dry_run:
            print(f"DRY {entity.entity:10s} r{entity.rung} {slug} "
                  f"({len(msgs)} msgs) {latest.get('subject', '')[:60]}")
        else:
            try:
                common.gbrain_capture(entity.entity, slug, content, page_type="email-thread")
                written += 1
            except RuntimeError as exc:
                errors += 1
                common.log(f"ERROR {slug}: {exc}")
                continue
        if t.get("max_received") and (not max_received or t["max_received"] > max_received):
            max_received = t["max_received"]

    if not args.dry_run and max_received and not errors:
        common.write_watermark(WATERMARK_FILE, max_received)
        common.log(f"watermark -> {max_received}")
    elif errors:
        common.log("errors occurred; watermark NOT advanced (will retry next run)")

    common.log(f"done: written={written} errors={errors}")
    return 1 if errors and not written else 0


if __name__ == "__main__":
    sys.exit(main())
