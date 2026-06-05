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


def build_brief() -> Dict[str, Any]:
    """Assemble the full Google portion of the brief (Gmail + Calendar)."""
    connected = google_connected()
    if not connected:
        return {
            "connected": False,
            "gmail": {"messages": [], "error": None},
            "calendar": {"events": [], "error": None},
        }
    return {
        "connected": True,
        "gmail": fetch_top_of_mind(),
        "calendar": fetch_today_events(),
    }
