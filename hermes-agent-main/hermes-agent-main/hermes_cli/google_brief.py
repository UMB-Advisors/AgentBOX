"""Google-backed data for the Home daily brief — Gmail + Google Calendar.

The brief's "Top of Mind" and "On Your Calendar" sections read the operator's
real Google account. We deliberately reuse the **google-workspace skill's**
existing credentials (``HERMES_HOME/google_token.json``) rather than the
dashboard's own Gemini OAuth — the latter only carries model-access scopes
(``cloud-platform`` / ``userinfo.*``), not ``gmail.readonly`` /
``calendar``. So the single consent the operator already grants for the
``/google-workspace`` skill lights this up too; no extra scope or re-consent.

Connect-ready by design: with no token (or a partial one) every function
degrades to an empty result with ``connected: False`` — the SPA renders a clean
"Connect Google" state instead of an error. Nothing here raises to the caller.

All calls are blocking (network + google-api-python-client); run them off the
event loop (``run_in_executor``).
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from hermes_constants import get_hermes_home

_log = logging.getLogger(__name__)

# Same token file the google-workspace skill writes (see
# skills/productivity/google-workspace/scripts/google_api.py). Sharing it means
# one OAuth consent covers both the skill and this brief.
def _token_path():
    return get_hermes_home() / "google_token.json"


def google_connected() -> bool:
    """True when a Google token file is present on the box.

    Presence-only — we don't validate scopes here (a refresh/API call will fail
    softly if a scope is missing, surfacing as an empty section rather than a
    crash). Cheap enough to call on every brief load.
    """
    return _token_path().is_file()


def _credentials():
    """Load Google credentials from the skill's token file, refreshing if stale.

    Returns ``None`` (never raises) when the token is absent or unusable so the
    brief degrades to its disconnected state. We intentionally do **not** pass an
    expected scope list to ``from_authorized_user_file``: the operator may have
    authorized a subset, and forcing a scope set makes google-auth reject the
    refresh with ``invalid_scope`` (the skill's setup.py hit the same trap).
    """
    path = _token_path()
    if not path.is_file():
        return None
    try:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials

        creds = Credentials.from_authorized_user_file(str(path))
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        return creds
    except Exception:  # noqa: BLE001 — any failure → disconnected, not a 500
        _log.warning("google brief: failed to load credentials", exc_info=True)
        return None


def _service(api: str, version: str):
    creds = _credentials()
    if creds is None:
        return None
    try:
        from googleapiclient.discovery import build

        # cache_discovery=False: the file cache is unwritable under some service
        # managers and only spews warnings.
        return build(api, version, credentials=creds, cache_discovery=False)
    except Exception:  # noqa: BLE001
        _log.warning("google brief: failed to build %s/%s service", api, version, exc_info=True)
        return None


# ---------------------------------------------------------------------------
# Top of Mind — Gmail
# ---------------------------------------------------------------------------

# Unread, in the inbox, primary category (skip promotions/social), newest first.
# "Top of mind" = what's actually waiting on you, not the whole firehose.
_GMAIL_QUERY = "in:inbox is:unread category:primary"


def _header(headers: List[Dict[str, str]], name: str) -> str:
    lname = name.lower()
    for h in headers or []:
        if (h.get("name") or "").lower() == lname:
            return h.get("value") or ""
    return ""


def _pretty_from(raw: str) -> str:
    """``"Jane Doe <jane@x.com>"`` → ``"Jane Doe"`` (fall back to the address)."""
    raw = (raw or "").strip()
    if "<" in raw:
        name = raw.split("<", 1)[0].strip().strip('"')
        if name:
            return name
        return raw.split("<", 1)[1].rstrip(">").strip()
    return raw


def fetch_top_of_mind(max_items: int = 6) -> Dict[str, Any]:
    """Unread primary-inbox messages for the brief's Top of Mind section.

    Returns ``{"messages": [...], "error": Optional[str]}``. ``error`` is set
    (and ``messages`` empty) when Gmail is unreachable or the scope is missing,
    so the UI can show a precise hint without treating it as a page failure.
    """
    service = _service("gmail", "v1")
    if service is None:
        return {"messages": [], "error": None}
    try:
        listing = (
            service.users()
            .messages()
            .list(userId="me", q=_GMAIL_QUERY, maxResults=max(1, min(max_items, 20)))
            .execute()
        )
        out: List[Dict[str, Any]] = []
        for ref in listing.get("messages", []):
            mid = ref.get("id")
            if not mid:
                continue
            msg = (
                service.users()
                .messages()
                .get(
                    userId="me",
                    id=mid,
                    format="metadata",
                    metadataHeaders=["Subject", "From", "Date"],
                )
                .execute()
            )
            headers = msg.get("payload", {}).get("headers", [])
            out.append(
                {
                    "id": mid,
                    "subject": _header(headers, "Subject") or "(no subject)",
                    "from": _pretty_from(_header(headers, "From")),
                    "snippet": (msg.get("snippet") or "").strip(),
                    "date": _header(headers, "Date"),
                    "unread": "UNREAD" in (msg.get("labelIds") or []),
                    "link": f"https://mail.google.com/mail/u/0/#inbox/{mid}",
                }
            )
        return {"messages": out, "error": None}
    except Exception as exc:  # noqa: BLE001
        _log.warning("google brief: gmail fetch failed", exc_info=True)
        return {"messages": [], "error": _api_error_hint(exc)}


# ---------------------------------------------------------------------------
# On Your Calendar — Google Calendar
# ---------------------------------------------------------------------------

def fetch_today_events(max_items: int = 8) -> Dict[str, Any]:
    """Today's events from the primary calendar for the brief.

    Returns ``{"events": [...], "error": Optional[str]}``. "Today" is the box's
    local day. All-day events carry ``all_day: True`` and a date-only ``start``.
    """
    service = _service("calendar", "v3")
    if service is None:
        return {"events": [], "error": None}
    try:
        now = datetime.now().astimezone()
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        end = start + timedelta(days=1)
        resp = (
            service.events()
            .list(
                calendarId="primary",
                timeMin=start.isoformat(),
                timeMax=end.isoformat(),
                singleEvents=True,
                orderBy="startTime",
                maxResults=max(1, min(max_items, 25)),
            )
            .execute()
        )
        out: List[Dict[str, Any]] = []
        for ev in resp.get("items", []):
            s = ev.get("start", {})
            e = ev.get("end", {})
            all_day = "date" in s and "dateTime" not in s
            out.append(
                {
                    "id": ev.get("id"),
                    "title": ev.get("summary") or "(untitled)",
                    "start": s.get("dateTime") or s.get("date") or "",
                    "end": e.get("dateTime") or e.get("date") or "",
                    "all_day": all_day,
                    "location": ev.get("location") or "",
                    "link": ev.get("htmlLink") or "",
                }
            )
        return {"events": out, "error": None}
    except Exception as exc:  # noqa: BLE001
        _log.warning("google brief: calendar fetch failed", exc_info=True)
        return {"events": [], "error": _api_error_hint(exc)}


def _api_error_hint(exc: Exception) -> str:
    """A short, operator-readable reason a Google call failed.

    Most common: the token lacks the gmail/calendar scope (the operator
    authorized the skill before this feature, or only a subset). Surface that
    explicitly so the fix ("re-run the google-workspace login") is obvious.
    """
    text = str(exc)
    if "insufficient" in text.lower() or "ACCESS_TOKEN_SCOPE_INSUFFICIENT" in text or "invalid_scope" in text:
        return "Google connected, but this scope isn't granted — re-run the google-workspace login."
    if "invalid_grant" in text.lower():
        return "Google token expired — re-run the google-workspace login."
    return "Couldn't reach Google."


# ---------------------------------------------------------------------------
# Multi-account aggregation
# ---------------------------------------------------------------------------
def _service_for(creds, api: str, version: str):
    """Build a Google API client from an explicit credentials object."""
    if creds is None:
        return None
    try:
        from googleapiclient.discovery import build

        return build(api, version, credentials=creds, cache_discovery=False)
    except Exception:  # noqa: BLE001
        _log.warning("google brief: failed to build %s/%s service", api, version, exc_info=True)
        return None


def _top_of_mind_for(creds, account: str, max_items: int) -> Dict[str, Any]:
    """Unread primary-inbox messages for ONE account, tagged with ``account``."""
    service = _service_for(creds, "gmail", "v1")
    if service is None:
        return {"messages": [], "error": None}
    try:
        listing = (
            service.users()
            .messages()
            .list(userId="me", q=_GMAIL_QUERY, maxResults=max(1, min(max_items, 20)))
            .execute()
        )
        out: List[Dict[str, Any]] = []
        for ref in listing.get("messages", []):
            mid = ref.get("id")
            if not mid:
                continue
            msg = (
                service.users()
                .messages()
                .get(
                    userId="me",
                    id=mid,
                    format="metadata",
                    metadataHeaders=["Subject", "From", "Date"],
                )
                .execute()
            )
            headers = msg.get("payload", {}).get("headers", [])
            try:
                internal = int(msg.get("internalDate") or 0)
            except (TypeError, ValueError):
                internal = 0
            out.append(
                {
                    "id": mid,
                    "account": account,
                    "subject": _header(headers, "Subject") or "(no subject)",
                    "from": _pretty_from(_header(headers, "From")),
                    "snippet": (msg.get("snippet") or "").strip(),
                    "date": _header(headers, "Date"),
                    "internalDate": internal,
                    "unread": "UNREAD" in (msg.get("labelIds") or []),
                    "link": f"https://mail.google.com/mail/u/0/#inbox/{mid}",
                }
            )
        return {"messages": out, "error": None}
    except Exception as exc:  # noqa: BLE001
        _log.warning("google brief: gmail fetch failed for %s", account, exc_info=True)
        return {"messages": [], "error": _api_error_hint(exc)}


def _today_events_for(creds, account: str, max_items: int) -> Dict[str, Any]:
    """Today's primary-calendar events for ONE account, tagged with ``account``."""
    service = _service_for(creds, "calendar", "v3")
    if service is None:
        return {"events": [], "error": None}
    try:
        now = datetime.now().astimezone()
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        end = start + timedelta(days=1)
        resp = (
            service.events()
            .list(
                calendarId="primary",
                timeMin=start.isoformat(),
                timeMax=end.isoformat(),
                singleEvents=True,
                orderBy="startTime",
                maxResults=max(1, min(max_items, 25)),
            )
            .execute()
        )
        out: List[Dict[str, Any]] = []
        for ev in resp.get("items", []):
            s = ev.get("start", {})
            e = ev.get("end", {})
            all_day = "date" in s and "dateTime" not in s
            out.append(
                {
                    "id": ev.get("id"),
                    "account": account,
                    "title": ev.get("summary") or "(untitled)",
                    "start": s.get("dateTime") or s.get("date") or "",
                    "end": e.get("dateTime") or e.get("date") or "",
                    "all_day": all_day,
                    "location": ev.get("location") or "",
                    "link": ev.get("htmlLink") or "",
                }
            )
        return {"events": out, "error": None}
    except Exception as exc:  # noqa: BLE001
        _log.warning("google brief: calendar fetch failed for %s", account, exc_info=True)
        return {"events": [], "error": _api_error_hint(exc)}


def _connected_pairs() -> List:
    """``[(email, creds)]`` for every connected account. Prefers the multi-account
    store; falls back to the legacy single token so nothing regresses."""
    try:
        from hermes_cli import google_accounts

        pairs = google_accounts.all_credentials()
        if pairs:
            return pairs
    except Exception:  # noqa: BLE001
        _log.warning("google brief: multi-account load failed; trying legacy", exc_info=True)
    creds = _credentials()
    if creds is not None:
        label = "primary"
        try:
            import json

            label = json.loads(_token_path().read_text()).get("account") or "primary"
        except Exception:  # noqa: BLE001
            pass
        return [(label, creds)]
    return []


def build_brief(account: Optional[str] = None) -> Dict[str, Any]:
    """Assemble the Google brief (Gmail + Calendar) across one or all accounts.

    ``account``: ``None`` / ``"combined"`` / ``"all"`` aggregate across every
    connected account; a specific email restricts to that one. The payload always
    carries ``accounts`` (every connected email) so the UI can render its account
    selector regardless of the active view, and every message / event is tagged
    with its source ``account``.
    """
    pairs = _connected_pairs()
    emails = [e for e, _ in pairs]
    if not pairs:
        return {
            "connected": False,
            "accounts": [],
            "selected": "combined",
            "gmail": {"messages": [], "error": None},
            "calendar": {"events": [], "error": None},
        }
    sel = (account or "").strip().lower()
    combined = sel in ("", "combined", "all")
    chosen = pairs if combined else [(e, c) for e, c in pairs if e.lower() == sel]
    if not combined and not chosen:
        return {
            "connected": True,
            "accounts": emails,
            "selected": account,
            "gmail": {"messages": [], "error": None},
            "calendar": {"events": [], "error": None},
        }
    # In combined view, cap each account's pull so the merged list stays tight.
    per_g = max(3, 8 // len(chosen)) if combined else 6
    per_c = max(4, 10 // len(chosen)) if combined else 8
    msgs: List[Dict[str, Any]] = []
    events: List[Dict[str, Any]] = []
    gmail_errs: List[str] = []
    cal_errs: List[str] = []
    for email, creds in chosen:
        g = _top_of_mind_for(creds, email, per_g)
        msgs += g["messages"]
        if g["error"]:
            gmail_errs.append(f"{email}: {g['error']}" if combined else g["error"])
        c = _today_events_for(creds, email, per_c)
        events += c["events"]
        if c["error"]:
            cal_errs.append(f"{email}: {c['error']}" if combined else c["error"])
    msgs.sort(key=lambda m: m.get("internalDate", 0), reverse=True)
    events.sort(key=lambda e: e.get("start", ""))
    cap_g = 8 if combined else 6
    cap_c = 10 if combined else 8
    return {
        "connected": True,
        "accounts": emails,
        "selected": "combined" if combined else account,
        "gmail": {"messages": msgs[:cap_g], "error": "; ".join(gmail_errs) or None},
        "calendar": {"events": events[:cap_c], "error": "; ".join(cal_errs) or None},
    }


# ---------------------------------------------------------------------------
# Calendar tab — events across a date window (Home brief = today only; the
# Calendar page wants an agenda spanning several days).
# ---------------------------------------------------------------------------
def _event_record(ev: Dict[str, Any], account: str) -> Dict[str, Any]:
    s = ev.get("start", {})
    e = ev.get("end", {})
    all_day = "date" in s and "dateTime" not in s
    return {
        "id": ev.get("id"),
        "account": account,
        "title": ev.get("summary") or "(untitled)",
        "start": s.get("dateTime") or s.get("date") or "",
        "end": e.get("dateTime") or e.get("date") or "",
        "all_day": all_day,
        "location": ev.get("location") or "",
        "description": ev.get("description") or "",
        "link": ev.get("htmlLink") or "",
    }


def _calendar_window_for(creds, account, time_min, time_max, max_items) -> Dict[str, Any]:
    service = _service_for(creds, "calendar", "v3")
    if service is None:
        return {"events": [], "error": None}
    try:
        resp = (
            service.events()
            .list(
                calendarId="primary",
                timeMin=time_min,
                timeMax=time_max,
                singleEvents=True,
                orderBy="startTime",
                maxResults=max(1, min(max_items, 250)),
            )
            .execute()
        )
        return {
            "events": [_event_record(ev, account) for ev in resp.get("items", [])],
            "error": None,
        }
    except Exception as exc:  # noqa: BLE001
        _log.warning("google calendar: fetch failed for %s", account, exc_info=True)
        return {"events": [], "error": _api_error_hint(exc)}


def build_calendar(
    account: Optional[str] = None,
    days: int = 7,
    time_min: Optional[str] = None,
    time_max: Optional[str] = None,
) -> Dict[str, Any]:
    """Events for the Calendar tab. By default spans the start of today through
    ``days`` ahead; pass ``time_min``/``time_max`` (RFC3339) for an explicit
    window so the month/week grids can page across arbitrary ranges. Same
    selector contract as ``build_brief`` (``accounts`` + per-item ``account`` tag)."""
    pairs = _connected_pairs()
    emails = [e for e, _ in pairs]
    if not pairs:
        return {"connected": False, "accounts": [], "selected": "combined", "events": [], "error": None}
    sel = (account or "").strip().lower()
    combined = sel in ("", "combined", "all")
    chosen = pairs if combined else [(e, c) for e, c in pairs if e.lower() == sel]
    if not combined and not chosen:
        return {"connected": True, "accounts": emails, "selected": account, "events": [], "error": None}
    if time_min and time_max:
        start_iso, end_iso = time_min, time_max
    else:
        now = datetime.now().astimezone()
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        end = start + timedelta(days=max(1, min(days, 31)))
        start_iso, end_iso = start.isoformat(), end.isoformat()
    per = max(50, 250 // len(chosen)) if combined else 250
    events: List[Dict[str, Any]] = []
    errs: List[str] = []
    for email, creds in chosen:
        r = _calendar_window_for(creds, email, start_iso, end_iso, per)
        events += r["events"]
        if r["error"]:
            errs.append(f"{email}: {r['error']}" if combined else r["error"])
    events.sort(key=lambda e: e.get("start", ""))
    return {
        "connected": True,
        "accounts": emails,
        "selected": "combined" if combined else account,
        "events": events,
        "error": "; ".join(errs) or None,
    }


# ---------------------------------------------------------------------------
# Calendar writes — create / update / delete on the primary calendar of a
# specific connected account (full ``auth/calendar`` scope is already granted).
# ---------------------------------------------------------------------------
def _creds_for_account(account: Optional[str]):
    """``(email, creds)`` for a specific account email, or the primary (first)
    connected account when ``account`` is blank/combined. ``(None, None)`` if
    nothing matches."""
    pairs = _connected_pairs()
    if not pairs:
        return None, None
    sel = (account or "").strip().lower()
    if sel in ("", "combined", "all"):
        return pairs[0]
    for email, creds in pairs:
        if email.lower() == sel:
            return email, creds
    return None, None


def _event_body(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Map the dashboard's flat event payload to a Google Calendar event body.
    All-day events carry ``date`` (end exclusive); timed events carry
    ``dateTime`` with the caller's RFC3339 offset preserved. ``location`` and
    ``description`` are always written (empty clears them on patch)."""
    all_day = bool(payload.get("all_day"))
    body: Dict[str, Any] = {
        "summary": (payload.get("title") or "").strip() or "(untitled)",
        "location": (payload.get("location") or "").strip(),
        "description": (payload.get("description") or "").strip(),
    }
    start = payload.get("start") or ""
    end = payload.get("end") or ""
    if all_day:
        body["start"] = {"date": start}
        body["end"] = {"date": end}
    else:
        body["start"] = {"dateTime": start}
        body["end"] = {"dateTime": end}
        tz = payload.get("timezone")
        if tz:
            body["start"]["timeZone"] = tz
            body["end"]["timeZone"] = tz
    return body


def create_event(account: Optional[str], payload: Dict[str, Any]) -> Dict[str, Any]:
    """Insert an event on one account's primary calendar. Returns
    ``{"event": <record>}`` or ``{"error": <hint>}``."""
    email, creds = _creds_for_account(account)
    if creds is None:
        return {"error": "No matching Google account is connected."}
    service = _service_for(creds, "calendar", "v3")
    if service is None:
        return {"error": "Couldn't reach Google."}
    try:
        ev = service.events().insert(calendarId="primary", body=_event_body(payload)).execute()
        return {"event": _event_record(ev, email), "error": None}
    except Exception as exc:  # noqa: BLE001
        _log.warning("google calendar: create failed for %s", email, exc_info=True)
        return {"error": _api_error_hint(exc)}


def update_event(account: Optional[str], event_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Patch an existing event on one account's primary calendar."""
    email, creds = _creds_for_account(account)
    if creds is None:
        return {"error": "No matching Google account is connected."}
    service = _service_for(creds, "calendar", "v3")
    if service is None:
        return {"error": "Couldn't reach Google."}
    try:
        ev = (
            service.events()
            .patch(calendarId="primary", eventId=event_id, body=_event_body(payload))
            .execute()
        )
        return {"event": _event_record(ev, email), "error": None}
    except Exception as exc:  # noqa: BLE001
        _log.warning("google calendar: update failed for %s", email, exc_info=True)
        return {"error": _api_error_hint(exc)}


def delete_event(account: Optional[str], event_id: str) -> Dict[str, Any]:
    """Delete an event from one account's primary calendar."""
    email, creds = _creds_for_account(account)
    if creds is None:
        return {"error": "No matching Google account is connected."}
    service = _service_for(creds, "calendar", "v3")
    if service is None:
        return {"error": "Couldn't reach Google."}
    try:
        service.events().delete(calendarId="primary", eventId=event_id).execute()
        return {"error": None}
    except Exception as exc:  # noqa: BLE001
        _log.warning("google calendar: delete failed for %s", email, exc_info=True)
        return {"error": _api_error_hint(exc)}


# ---------------------------------------------------------------------------
# Drive tab — recent / searched files across accounts.
# ---------------------------------------------------------------------------
def _drive_record(f: Dict[str, Any], account: str) -> Dict[str, Any]:
    return {
        "id": f.get("id"),
        "account": account,
        "name": f.get("name") or "(untitled)",
        "mimeType": f.get("mimeType") or "",
        "modifiedTime": f.get("modifiedTime") or "",
        "iconLink": f.get("iconLink") or "",
        "webViewLink": f.get("webViewLink") or "",
        "owners": [
            (o.get("displayName") or o.get("emailAddress") or "")
            for o in (f.get("owners") or [])
        ][:2],
        "folder": f.get("mimeType") == "application/vnd.google-apps.folder",
    }


def _drive_for(creds, account, query, max_items) -> Dict[str, Any]:
    service = _service_for(creds, "drive", "v3")
    if service is None:
        return {"files": [], "error": None}
    try:
        q = "trashed = false"
        if query:
            safe = query.replace("\\", "\\\\").replace("'", "\\'")
            q += f" and name contains '{safe}'"
        resp = (
            service.files()
            .list(
                q=q,
                orderBy="modifiedTime desc",
                pageSize=max(1, min(max_items, 50)),
                spaces="drive",
                corpora="user",
                fields=(
                    "files(id,name,mimeType,modifiedTime,iconLink,webViewLink,"
                    "owners(displayName,emailAddress))"
                ),
            )
            .execute()
        )
        return {
            "files": [_drive_record(f, account) for f in resp.get("files", [])],
            "error": None,
        }
    except Exception as exc:  # noqa: BLE001
        _log.warning("google drive: fetch failed for %s", account, exc_info=True)
        return {"files": [], "error": _api_error_hint(exc)}


def build_drive(account: Optional[str] = None, query: Optional[str] = None) -> Dict[str, Any]:
    """Recent (or name-searched) Drive files for the Drive tab, across one or all
    connected accounts, newest-modified first. Same selector contract as the brief."""
    pairs = _connected_pairs()
    emails = [e for e, _ in pairs]
    if not pairs:
        return {"connected": False, "accounts": [], "selected": "combined", "files": [], "error": None}
    sel = (account or "").strip().lower()
    combined = sel in ("", "combined", "all")
    chosen = pairs if combined else [(e, c) for e, c in pairs if e.lower() == sel]
    if not combined and not chosen:
        return {"connected": True, "accounts": emails, "selected": account, "files": [], "error": None}
    per = max(8, 30 // len(chosen)) if combined else 40
    files: List[Dict[str, Any]] = []
    errs: List[str] = []
    for email, creds in chosen:
        r = _drive_for(creds, email, query, per)
        files += r["files"]
        if r["error"]:
            errs.append(f"{email}: {r['error']}" if combined else r["error"])
    files.sort(key=lambda f: f.get("modifiedTime", ""), reverse=True)
    return {
        "connected": True,
        "accounts": emails,
        "selected": "combined" if combined else account,
        "files": files[:40],
        "error": "; ".join(errs) or None,
    }
