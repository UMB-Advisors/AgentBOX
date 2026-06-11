#!/usr/bin/env python3
"""Ingest Google Calendar events into gbrain, per connected account.

Same credential source as ingest_drive: for each token file in
$HERMES_HOME/google_accounts/<email>.json, mint an access token via the
OAuth refresh POST (calendar.readonly scope rides on the same consent the
dashboard's Calendar tab already uses), list events on the primary
calendar in a sliding window (default: 7 days back .. 30 days forward,
recurring events expanded via singleEvents), and upsert one page per
event occurrence.

- Stable slug calendar/<summary-slug>-<sha1(account+event_id)[:8]> —
  re-runs and reschedules upsert the same page (the event id is stable
  across edits), so moved meetings update in place.
- DETERMINISTIC: no LLM. Events are short and structured; the page body
  is the facts (time, attendees, organizer, location, description).
- Entity attribution runs the full 5-rung ladder with the ORGANIZER as
  sender and attendees as participants, so an external meeting on the
  personal account still lands in the right entity via domain heuristics
  (mirrors what ingest_email does for threads).
- Descriptions/titles come from external senders: secret-redacted before
  capture (meeting invites routinely embed dial-in codes and links).
- Sliding-window by design — no watermark. Each run re-upserts the window
  so RSVP/attendee/time changes are captured; pages for events that fall
  out of the window simply stop refreshing (history is retained).

Usage:
  python3 ingest_calendar.py [--days-back N] [--days-forward N]
                             [--account EMAIL] [--limit N]
                             [--dry-run] [--entity-map PATH]
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import sys
import urllib.error
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import common
from attribution import attribute
# Reuse drive's OAuth helpers verbatim rather than fork a third copy —
# both pipelines read the same token files (import is side-effect free).
from ingest_drive import GOOGLE_ACCOUNTS_DIR, http_json, mint_access_token

DESCRIPTION_CHARS = 1200
MAX_ATTENDEES_LISTED = 12


def list_events(token: str, days_back: int, days_forward: int,
                limit: int) -> list[dict]:
    now = dt.datetime.now(dt.timezone.utc)
    q = urllib.parse.urlencode({
        "timeMin": (now - dt.timedelta(days=days_back)).isoformat(),
        "timeMax": (now + dt.timedelta(days=days_forward)).isoformat(),
        "singleEvents": "true",
        "orderBy": "startTime",
        "maxResults": str(limit),
        "fields": ("items(id,status,summary,description,location,start,end,"
                   "organizer,attendees(email,responseStatus,self),"
                   "hangoutLink,htmlLink,updated)"),
    })
    data = http_json(
        f"https://www.googleapis.com/calendar/v3/calendars/primary/events?{q}",
        headers={"Authorization": f"Bearer {token}"},
    )
    return data.get("items", [])


def event_when(ev: dict) -> tuple[str, str]:
    """(start, end) as ISO strings; all-day events use the date form."""
    start = ev.get("start", {})
    end = ev.get("end", {})
    return (start.get("dateTime") or start.get("date") or "",
            end.get("dateTime") or end.get("date") or "")


def build_event_page(ev: dict, account_email: str, entity) -> tuple[str, str]:
    """Pure: Calendar API event + account + Attribution -> (slug, page)."""
    eid = ev.get("id")
    if not eid:
        raise RuntimeError("event has no id; refusing to build page")
    summary = common.redact_secrets(ev.get("summary") or "(no title)")
    description = common.redact_secrets(
        (ev.get("description") or "").strip()[:DESCRIPTION_CHARS])
    location = common.redact_secrets(ev.get("location") or "")
    organizer = (ev.get("organizer") or {}).get("email", "")
    start, end = event_when(ev)
    attendees = ev.get("attendees") or []
    my_rsvp = next((a.get("responseStatus") for a in attendees
                    if a.get("self")), None)

    slug = (f"calendar/{common.slugify(summary)}-"
            f"{hashlib.sha1((account_email + eid).encode()).hexdigest()[:8]}")
    frontmatter = {
        "title": f"Event: {summary}"[:140],
        "type": "calendar-event",
        "account": account_email,
        "entity": entity.entity,
        "event_id": eid,
        "start": start,
        "end": end,
        "organizer": organizer,
        "event_status": ev.get("status"),
        "my_rsvp": my_rsvp,
        "link": ev.get("htmlLink"),
        "tags": ["calendar", f"entity:{entity.entity}",
                 "account:" + common.slugify(account_email.split("@")[0])],
    }

    lines = [
        f"# {summary}",
        "",
        f"Calendar event on account {account_email}: {start} -> {end}.",
        "",
        f"- Organizer: {organizer or '(none)'}",
        f"- Status: {ev.get('status', 'confirmed')}"
        + (f", my RSVP: {my_rsvp}" if my_rsvp else ""),
    ]
    if location:
        lines.append(f"- Location: {location}")
    if ev.get("hangoutLink"):
        lines.append(f"- Meet: {ev['hangoutLink']}")
    if attendees:
        listed = [a.get("email", "?") for a in attendees[:MAX_ATTENDEES_LISTED]]
        more = len(attendees) - len(listed)
        lines.append("- Attendees: " + ", ".join(listed)
                     + (f" (+{more} more)" if more > 0 else ""))
    if description:
        lines += ["", "## Description (from the invite, redacted)", "",
                  description]
    return slug, common.render_page(frontmatter, "\n".join(lines))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days-back", type=int, default=7)
    ap.add_argument("--days-forward", type=int, default=30)
    ap.add_argument("--limit", type=int, default=250,
                    help="events per account (default 250)")
    ap.add_argument("--account", default=None, help="only this account email")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--entity-map", default=None)
    args = ap.parse_args()

    emap = common.load_entity_map(args.entity_map)
    kwargs = common.ladder_kwargs(emap)

    token_files = sorted(GOOGLE_ACCOUNTS_DIR.glob("*.json"))
    if args.account:
        token_files = [p for p in token_files if p.stem == args.account]
    if not token_files:
        common.log(f"no token files under {GOOGLE_ACCOUNTS_DIR}")
        return 1

    written = errors = 0
    for token_file in token_files:
        minted = mint_access_token(token_file)
        if not minted:
            errors += 1
            continue
        email, token = minted

        try:
            events = list_events(token, args.days_back, args.days_forward,
                                 args.limit)
        except (urllib.error.URLError, ValueError) as exc:
            common.log(f"{email}: calendar list failed: {exc}")
            errors += 1
            continue
        common.log(f"{email}: {len(events)} events in window")

        for ev in events:
            if ev.get("status") == "cancelled":
                continue
            try:
                organizer = (ev.get("organizer") or {}).get("email")
                participants = [a.get("email") for a in
                                (ev.get("attendees") or []) if a.get("email")]
                # Deterministic ladder (no rung-4 LLM): account provenance
                # first, then organizer/attendee domain heuristics.
                entity = attribute(
                    email, organizer, participants,
                    ev.get("summary"), ev.get("description"),
                    llm_classify_fn=None, **kwargs,
                )
                slug, content = build_event_page(ev, email, entity)
                if args.dry_run:
                    print(f"DRY {entity.entity:10s} {slug} "
                          f"({(ev.get('summary') or '')[:60]})")
                else:
                    common.gbrain_capture(entity.entity, slug, content,
                                          page_type="calendar-event")
                    written += 1
            except Exception as exc:  # unattended timer job: log, keep going
                errors += 1
                common.log(f"ERROR event {ev.get('id')}: {exc}")

    common.log(f"done: written={written} errors={errors}")
    return 1 if errors and not written else 0


if __name__ == "__main__":
    sys.exit(main())
