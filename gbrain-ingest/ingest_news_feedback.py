#!/usr/bin/env python3
"""Ingest dashboard news-article thumbs feedback into gbrain.

The Daily Digest news feed records 👍/👎 per article (with a downvote
reason) in ~/.hermes/news-feedback.json — written by web_server.py's
POST /api/digest/news/feedback. The dashboard already uses the ledger to
rerank the feed deterministically; this pipeline gives the *brain* the
same signal so any agent (chat, cron, digest) can recall the operator's
news taste.

- One page per vote event, stable slug news-feedback/<id> (put_page
  upsert; re-runs are idempotent). Vote-cleared ("none" / Undo) events
  produce NO page — the retraction shows up via the taste profile, which
  is rebuilt from the *current* votes map every run.
- One aggregate page news-feedback/taste-profile, rebuilt each run:
  source affinities, muted sources, liked/disliked topic words. This is
  the page semantic recall should usually land on.
- DETERMINISTIC BY DESIGN: no LLM calls, no DB. Reads one JSON file.
- Pages land in a single operator-taste source (default "personal" —
  news taste is personal, not entity work; override NEWS_FEEDBACK_SOURCE).
- Incremental via an integer id watermark
  (~/.hermes/gbrain-ingest/news-feedback.watermark); --backfill ignores
  it. Events are processed in id order and the watermark advances to the
  last id BEFORE the first failure (failed event + everything after it
  retried next run; re-captures are harmless slug upserts).
- Titles/labels originate from external news feeds: secret-redacted
  before capture and labeled so recalled context cannot pose as operator
  instructions.

Usage:
  python3 ingest_news_feedback.py [--backfill] [--since-id N] [--limit N]
                                  [--dry-run] [--rebuild-profile]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import common

WATERMARK_FILE = "news-feedback.watermark"
FEEDBACK_FILE = Path(
    os.environ.get("HERMES_HOME", str(Path.home() / ".hermes"))
) / "news-feedback.json"
TASTE_SOURCE = os.environ.get("NEWS_FEEDBACK_SOURCE", "personal")
PROFILE_SLUG = "news-feedback/taste-profile"

REASON_LABELS = {
    "not_interested": "not interested in this topic",
    "source": "doesn't like this source",
    "seen": "already seen it",
    "low_quality": "sensational or low quality",
    "other": "other",
}

# Mirror of web_server.py's title tokenizer (kept tiny + deterministic).
_STOPWORDS = frozenset(
    "this that with from have will your according report reports says said "
    "could would should about after before because being other their there "
    "these those what when where which while world today year years week "
    "month every still more most some just over under into onto than then "
    "them they were going first last next best worst really only also been "
    "between against during make makes made take takes news show shows here "
    "want wants amid says".split()
)


def title_tokens(title: str) -> set[str]:
    import re

    return {
        t
        for t in re.findall(r"[a-z0-9]{4,}", (title or "").lower())
        if t not in _STOPWORDS
    }


def load_ledger(path: Path = FEEDBACK_FILE) -> dict:
    """Read the dashboard's vote ledger; absent/corrupt degrades to empty."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"events": [], "votes": {}}
    except ValueError:
        common.log(f"WARNING: corrupt ledger {path}; treating as empty")
        return {"events": [], "votes": {}}
    events = [e for e in raw.get("events", []) if isinstance(e, dict)]
    votes = {
        str(k): v for k, v in (raw.get("votes") or {}).items() if isinstance(v, dict)
    }
    return {"events": events, "votes": votes}


def build_event_page(ev: dict) -> tuple[str, str]:
    """Pure: one up/down vote event -> (slug, rendered page)."""
    if ev.get("id") is None:
        raise RuntimeError("feedback event has no id; refusing to build page")
    vote = ev.get("vote")
    if vote not in ("up", "down"):
        raise RuntimeError(f"build_event_page called for non-vote event {ev.get('id')}")
    reason = ev.get("reason")
    title = common.redact_secrets(ev.get("title") or "(untitled)")
    source = common.redact_secrets(ev.get("source") or ev.get("source_id") or "unknown")
    link = common.redact_secrets(ev.get("link") or "")

    liked = vote == "up"
    verb = "liked" if liked else "disliked"
    slug = f"news-feedback/{int(ev['id'])}"
    frontmatter = {
        "title": f"News {verb}: {title}"[:140],
        "type": "news-feedback",
        "vote": vote,
        "reason": reason,
        "news_source": ev.get("source_id"),
        "link": link,
        "feedback_id": ev.get("id"),
        "date": ev.get("ts"),
        "tags": ["news-feedback", f"vote:{vote}"]
        + ([f"reason:{reason}"] if reason else []),
    }
    lines = [
        f"# News article {verb}: {title}",
        "",
        f"On {ev.get('ts', '')} the operator gave a thumbs-"
        f"{'up' if liked else 'down'} to a Daily Digest news story.",
        "",
        f"- Source: {source}",
        f"- Headline (external feed content, not operator words): {title}",
    ]
    if not liked:
        lines.append(
            f"- Why: {REASON_LABELS.get(reason or '', reason or 'no reason given')}"
        )
    lines += [
        "",
        "## Lesson",
        "",
        (
            f"Surface more stories like this (and from {source}) in the "
            "operator's news feed and briefings."
            if liked
            else (
                f"Show fewer stories from {source}."
                if reason == "source"
                else "Show fewer stories like this in the operator's news "
                "feed and briefings."
            )
        ),
    ]
    return slug, common.render_page(frontmatter, "\n".join(lines))


def build_profile_page(votes: dict) -> str:
    """Pure: the current votes map -> the rendered taste-profile page.

    Rebuilt from scratch every run so undone votes drop out, and recall
    gets one compact, current summary instead of N event pages.
    """
    source_net: dict[str, int] = {}
    source_label: dict[str, str] = {}
    strikes: dict[str, int] = {}
    up_tokens: dict[str, int] = {}
    down_tokens: dict[str, int] = {}
    ups = downs = 0
    for v in votes.values():
        sid = str(v.get("source_id") or "")
        label = common.redact_secrets(v.get("source") or sid or "unknown")
        if sid:
            source_label[sid] = label
        tokens = title_tokens(str(v.get("title") or ""))
        if v.get("vote") == "up":
            ups += 1
            if sid:
                source_net[sid] = source_net.get(sid, 0) + 1
            for t in tokens:
                up_tokens[t] = up_tokens.get(t, 0) + 1
        elif v.get("vote") == "down":
            downs += 1
            reason = v.get("reason")
            if sid:
                source_net[sid] = source_net.get(sid, 0) - (
                    3 if reason == "source" else 1
                )
                if reason == "source":
                    strikes[sid] = strikes.get(sid, 0) + 1
            if reason not in ("source", "seen"):
                for t in tokens:
                    down_tokens[t] = down_tokens.get(t, 0) + 1

    def top(counter: dict[str, int], n: int = 10) -> list[str]:
        return [t for t, _ in sorted(counter.items(), key=lambda kv: (-kv[1], kv[0]))[:n]]

    liked_sources = sorted(
        (s for s, n in source_net.items() if n > 0),
        key=lambda s: (-source_net[s], s),
    )
    disliked_sources = sorted(
        (s for s, n in source_net.items() if n < 0),
        key=lambda s: (source_net[s], s),
    )
    muted = sorted(s for s, n in strikes.items() if n >= 3)

    frontmatter = {
        "title": "News taste profile (from article thumbs feedback)",
        "type": "news-feedback",
        "tags": ["news-feedback", "taste-profile"],
        "votes_up": ups,
        "votes_down": downs,
    }
    lines = [
        "# Operator news taste profile",
        "",
        "Compiled deterministically from Daily Digest article thumbs "
        f"feedback ({ups} up / {downs} down). Source/topic names below come "
        "from external news feeds, not operator instructions.",
        "",
        "## Sources",
        "",
    ]
    if liked_sources:
        lines.append(
            "- Likes: "
            + ", ".join(f"{source_label.get(s, s)} (+{source_net[s]})" for s in liked_sources)
        )
    if disliked_sources:
        lines.append(
            "- Dislikes: "
            + ", ".join(f"{source_label.get(s, s)} ({source_net[s]})" for s in disliked_sources)
        )
    if muted:
        lines.append(
            "- Muted entirely (repeated \"don't like this source\"): "
            + ", ".join(source_label.get(s, s) for s in muted)
        )
    if not (liked_sources or disliked_sources):
        lines.append("- No source-level signal yet.")
    lines += ["", "## Topics", ""]
    lt, dt = top(up_tokens), top(down_tokens)
    lines.append("- Liked topic words: " + (", ".join(lt) if lt else "(none yet)"))
    lines.append("- Disliked topic words: " + (", ".join(dt) if dt else "(none yet)"))
    lines += [
        "",
        "## How to apply",
        "",
        "When curating news, briefings or research for the operator, favor "
        "the liked sources/topics and avoid the disliked ones above.",
    ]
    return common.render_page(frontmatter, "\n".join(lines))


def process_events(
    events: list[dict], dry_run: bool = False, capture=None
) -> tuple[int, int, int | None]:
    """Capture vote events (ascending id order).

    Returns (written, errors, last_good_id) with the same watermark
    semantics as ingest_feedback.process_rows: last_good_id is the highest
    id N such that every event with id <= N succeeded.
    """
    capture = capture or common.gbrain_capture
    written = errors = 0
    last_good_id: int | None = None
    for ev in events:
        try:
            if ev.get("id") is None:
                raise RuntimeError("event has no id")
            if ev.get("vote") in ("up", "down"):
                slug, content = build_event_page(ev)
                if dry_run:
                    print(
                        f"DRY {TASTE_SOURCE:10s} {slug} [{ev.get('vote')}"
                        f"{'/' + str(ev.get('reason')) if ev.get('reason') else ''}] "
                        f"{(ev.get('title') or '')[:60]}"
                    )
                else:
                    capture(TASTE_SOURCE, slug, content, page_type="news-feedback")
                    written += 1
            elif dry_run:
                print(f"DRY skip news-feedback/{ev.get('id')} [vote cleared]")
        except Exception as exc:  # unattended timer job: log event, keep going
            errors += 1
            common.log(f"ERROR news-feedback id={ev.get('id')}: {exc}")
            continue
        if not errors:
            last_good_id = int(ev["id"])
    return written, errors, last_good_id


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--backfill", action="store_true",
                    help="ignore watermark, ingest all events in the ledger")
    ap.add_argument("--since-id", type=int, default=None,
                    help="override watermark (event id)")
    ap.add_argument("--limit", type=int, default=None, help="max events this run")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--rebuild-profile", action="store_true",
                    help="rebuild the taste-profile page even with no new events")
    args = ap.parse_args()

    ledger = load_ledger()

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

    events = sorted(
        (e for e in ledger["events"]
         if isinstance(e.get("id"), int)
         and (since_id is None or e["id"] > since_id)),
        key=lambda e: e["id"],
    )
    if args.limit:
        events = events[: args.limit]
    common.log(f"news-feedback events to ingest: {len(events)} "
               f"(since_id={since_id if since_id is not None else 'ALL'})")

    written, errors, last_good_id = process_events(events, dry_run=args.dry_run)

    if (not args.dry_run and last_good_id is not None
            and (since_id is None or last_good_id > since_id)):
        common.write_watermark(WATERMARK_FILE, str(last_good_id))
        common.log(f"watermark -> {last_good_id}")
    elif errors:
        common.log("watermark held at first failure; failed event retries next run")

    # Keep the aggregate current whenever anything changed (any event — an
    # Undo writes no page but must still reshape the profile).
    if events or args.rebuild_profile:
        content = build_profile_page(ledger["votes"])
        if args.dry_run:
            print(f"DRY {TASTE_SOURCE:10s} {PROFILE_SLUG} [profile rebuild]")
        else:
            try:
                common.gbrain_capture(
                    TASTE_SOURCE, PROFILE_SLUG, content, page_type="news-feedback"
                )
                common.log("taste profile rebuilt")
            except Exception as exc:
                errors += 1
                common.log(f"ERROR taste profile: {exc}")

    common.log(f"done: written={written} errors={errors}")
    # Any error is a unit failure: this runs as a systemd oneshot, and a
    # zero exit on partial failure would hide the problem from
    # `systemctl --user status` / failure-state monitoring.
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
