"""Multi-account Google Workspace connection for the dashboard.

This module owns the *dashboard's* Google OAuth — a full server-side
authorization-code (Web client) flow that lets the operator connect **several**
Google accounts from the dashboard UI, no CLI / code pasting.

Storage layout under ``$HERMES_HOME``::

    google_client_secret.json        # the GCP OAuth *Web* client (operator-supplied)
    google_accounts/<email>.json     # one token per connected account
    google_token.json                # mirror of the PRIMARY account, for back-compat
                                     # with google_brief.py's single-token reader

Each ``<email>.json`` is written in the shape
``google.oauth2.credentials.Credentials.from_authorized_user_file`` expects, so
the existing brief code can load any account without changes.

Security:
  * The flow is CSRF-protected by a signed ``state`` matched against an
    HttpOnly cookie (see web_server.py endpoints) — the token-exchange itself
    never trusts a bare ``code``.
  * Token files are written ``chmod 600``; the box is single-tenant.
  * Only the token endpoints (start/callback) are public; account list/delete
    stay behind the dashboard session gate.

No Google client libraries are required here — the authorization-code exchange,
userinfo lookup and revoke are plain HTTPS calls via ``httpx`` (already a
dashboard dependency). google-auth is only needed later, by the brief, to
*use* the saved tokens.
"""

from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from hermes_constants import get_hermes_home

_log = logging.getLogger(__name__)

# Scopes mirror the google-workspace skill (gmail/calendar/drive/contacts/sheets/
# docs) so one consent lights up the brief AND the skill, plus the OpenID claims
# we need to identify which account just authorized.
SCOPES: List[str] = [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/contacts.readonly",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/documents",
]

_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
_USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo"
_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke"

_EMAIL_RE = re.compile(r"^[^@\s/]+@[^@\s/]+\.[^@\s/]+$")


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
def _home() -> Path:
    return get_hermes_home()


def client_secret_path() -> Path:
    return _home() / "google_client_secret.json"


def accounts_dir() -> Path:
    return _home() / "google_accounts"


def legacy_token_path() -> Path:
    """The single-token file google_brief.py reads — kept as a mirror of the
    primary account so the brief keeps working through the multi-account
    migration."""
    return _home() / "google_token.json"


def client_configured() -> bool:
    return client_secret_path().is_file()


def load_client_config() -> Dict[str, str]:
    """Return ``{client_id, client_secret, token_uri, auth_uri}`` from the
    operator-supplied Web OAuth client. Raises ``FileNotFoundError`` /
    ``ValueError`` so callers can surface a precise "client not set up" hint."""
    p = client_secret_path()
    if not p.is_file():
        raise FileNotFoundError("google_client_secret.json not present on the box")
    raw = json.loads(p.read_text())
    block = raw.get("web") or raw.get("installed")
    if not block or not block.get("client_id") or not block.get("client_secret"):
        raise ValueError("client secret is not a valid OAuth client (no web/client_id)")
    return {
        "client_id": block["client_id"],
        "client_secret": block["client_secret"],
        "token_uri": block.get("token_uri", _TOKEN_ENDPOINT),
        "auth_uri": block.get("auth_uri", _AUTH_ENDPOINT),
    }


# ---------------------------------------------------------------------------
# Auth URL + token exchange (plain HTTPS, no google client libs)
# ---------------------------------------------------------------------------
def build_auth_url(redirect_uri: str, state: str) -> str:
    """Construct the Google consent URL.

    ``access_type=offline`` + ``prompt=consent select_account`` guarantee a
    refresh token (the brief needs it to refresh without the user) and let the
    operator pick which Google account to add — that's how multi-account works.
    """
    from urllib.parse import urlencode

    cfg = load_client_config()
    params = {
        "client_id": cfg["client_id"],
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": " ".join(SCOPES),
        "access_type": "offline",
        "include_granted_scopes": "true",
        "prompt": "consent select_account",
        "state": state,
    }
    return f"{cfg['auth_uri']}?{urlencode(params)}"


def exchange_code(code: str, redirect_uri: str) -> Dict[str, Any]:
    """Exchange an authorization code for tokens. Returns Google's raw token
    response (``access_token``, ``refresh_token``, ``expires_in``, ``scope``,
    ``id_token``). Raises on a non-2xx so the caller redirects with an error."""
    import httpx

    cfg = load_client_config()
    resp = httpx.post(
        cfg["token_uri"],
        data={
            "code": code,
            "client_id": cfg["client_id"],
            "client_secret": cfg["client_secret"],
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
        },
        timeout=20.0,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"token exchange failed ({resp.status_code}): {resp.text[:200]}")
    return resp.json()


def userinfo_email(access_token: str) -> str:
    """Resolve the connected account's email from the access token."""
    import httpx

    resp = httpx.get(
        _USERINFO_ENDPOINT,
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=15.0,
    )
    resp.raise_for_status()
    email = (resp.json() or {}).get("email", "").strip().lower()
    if not _EMAIL_RE.match(email):
        raise RuntimeError("could not determine account email from Google userinfo")
    return email


# ---------------------------------------------------------------------------
# Token records + storage
# ---------------------------------------------------------------------------
def _token_record(token_resp: Dict[str, Any], email: str) -> Dict[str, Any]:
    """Shape Google's token response into the on-disk record that
    ``Credentials.from_authorized_user_file`` accepts (+ our own metadata)."""
    cfg = load_client_config()
    expiry = None
    if token_resp.get("expires_in"):
        # google-auth's from_authorized_user_info parses expiry with a strict
        # ``strptime(expiry.rstrip("Z").split(".")[0], "%Y-%m-%dT%H:%M:%S")`` — it
        # wants a NAIVE UTC stamp; a ``+00:00`` offset makes it raise
        # "unconverted data remains". So write naive-UTC + trailing Z.
        expiry = (
            datetime.now(timezone.utc).replace(tzinfo=None, microsecond=0)
            + timedelta(seconds=int(token_resp["expires_in"]))
        ).strftime("%Y-%m-%dT%H:%M:%SZ")
    scopes = (token_resp.get("scope") or " ".join(SCOPES)).split()
    return {
        "account": email,
        "token": token_resp.get("access_token"),
        "refresh_token": token_resp.get("refresh_token"),
        "token_uri": cfg["token_uri"],
        "client_id": cfg["client_id"],
        "client_secret": cfg["client_secret"],
        "scopes": scopes,
        "expiry": expiry,
        "connected_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
    }


def _write_json_600(path: Path, data: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".tmp.{os.getpid()}")
    tmp.write_text(json.dumps(data, indent=2))
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def _account_file(email: str) -> Path:
    if not _EMAIL_RE.match(email):
        raise ValueError(f"invalid account email: {email!r}")
    return accounts_dir() / f"{email}.json"


def save_account(token_resp: Dict[str, Any], email: str) -> Dict[str, Any]:
    """Persist a newly-connected account. If a previous record exists without a
    fresh refresh_token (Google omits it on re-auth without consent), keep the
    old one. Mirrors the primary account to the legacy single-token path."""
    record = _token_record(token_resp, email)
    existing = _read_account(email)
    if not record.get("refresh_token") and existing and existing.get("refresh_token"):
        record["refresh_token"] = existing["refresh_token"]
        record["connected_at"] = existing.get("connected_at", record["connected_at"])
    _write_json_600(_account_file(email), record)
    _sync_legacy_mirror()
    return record


def _read_account(email: str) -> Optional[Dict[str, Any]]:
    p = _account_file(email)
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text())
    except Exception:  # noqa: BLE001
        return None


def list_accounts() -> List[Dict[str, Any]]:
    """Connected accounts, oldest first (the oldest is the primary mirror)."""
    d = accounts_dir()
    if not d.is_dir():
        return []
    out: List[Dict[str, Any]] = []
    for f in d.glob("*.json"):
        try:
            rec = json.loads(f.read_text())
        except Exception:  # noqa: BLE001
            continue
        out.append(rec)
    out.sort(key=lambda r: r.get("connected_at") or "")
    primary = _current_primary()
    return [
        {
            "email": r.get("account") or r.get("email"),
            "scopes": r.get("scopes", []),
            "connected_at": r.get("connected_at"),
            "primary": (r.get("account") or r.get("email")) == primary,
        }
        for r in out
        if (r.get("account") or r.get("email"))
    ]


def _current_primary() -> Optional[str]:
    accs = _all_records()
    return accs[0].get("account") if accs else None


def _all_records() -> List[Dict[str, Any]]:
    d = accounts_dir()
    if not d.is_dir():
        return []
    recs = []
    for f in d.glob("*.json"):
        try:
            recs.append(json.loads(f.read_text()))
        except Exception:  # noqa: BLE001
            continue
    recs.sort(key=lambda r: r.get("connected_at") or "")
    return recs


def _sync_legacy_mirror() -> None:
    """Point google_token.json at the primary (oldest) account so the existing
    single-account brief keeps working. Remove it if no accounts remain."""
    recs = _all_records()
    legacy = legacy_token_path()
    if not recs:
        try:
            legacy.unlink()
        except FileNotFoundError:
            pass
        return
    _write_json_600(legacy, recs[0])


def delete_account(email: str) -> bool:
    """Revoke the token at Google (best-effort) and remove its file. Returns
    True if a file was removed."""
    rec = _read_account(email)
    if rec:
        _revoke(rec.get("refresh_token") or rec.get("token"))
    try:
        _account_file(email).unlink()
        removed = True
    except FileNotFoundError:
        removed = False
    _sync_legacy_mirror()
    return removed


def _revoke(token: Optional[str]) -> None:
    if not token:
        return
    try:
        import httpx

        httpx.post(_REVOKE_ENDPOINT, data={"token": token}, timeout=10.0)
    except Exception:  # noqa: BLE001 — revoke is best-effort
        _log.warning("google revoke failed", exc_info=True)


def all_credentials():
    """Yield google-auth Credentials for every connected account (Phase 4 brief
    aggregation). Skips accounts whose creds won't load. Returns a list of
    ``(email, creds)``; empty if google-auth isn't installed."""
    out = []
    for rec in _all_records():
        email = rec.get("account") or rec.get("email")
        if not email:
            continue
        try:
            from google.auth.transport.requests import Request
            from google.oauth2.credentials import Credentials

            creds = Credentials.from_authorized_user_info(rec)
            if creds and creds.expired and creds.refresh_token:
                creds.refresh(Request())
            out.append((email, creds))
        except Exception:  # noqa: BLE001
            _log.warning("google_accounts: creds load failed for %s", email, exc_info=True)
    return out
