"""Dashboard-side mail-account store + connect orchestration (MBOX-468).

Brings the mailbox dashboard's Microsoft 365 + IMAP provider onboarding
(MBOX-465) to the Hermes dashboard. Ports the probe -> 422-on-fail ->
(test|connect) -> persist sequence from ``dashboard/lib/mail/connect-graph.ts``
+ ``connect-imap.ts``, implemented the HERMES way: a chmod-0600 JSON file store
under ``$HERMES_HOME`` (mirrors ``shopify_accounts.py`` / ``google_accounts.py``),
NOT Postgres. The mailbox stack has no Postgres driver in hermes_cli's core deps
and every existing connector here is a file store -- we follow that.

Storage layout under ``$HERMES_HOME``::

    mail_accounts/<email>.json        # one record per connected mailbox, 0600

Each record::

    {
      id, provider ('microsoft'|'imap'), email, display_label, mailbox,
      provider_config: {...},          # NON-secret connection params
      secret_enc,                      # AES-256-GCM packed (token_crypto)
      connected_at
    }

SECURITY REVIEW NEEDED -- credential handling:
  * The provider secret (M365 client_secret / IMAP app_password) is encrypted
    at rest via ``token_crypto.encrypt_secret`` (AES-256-GCM). It is NEVER
    written in plaintext and NEVER returned by ``list_accounts``.
  * LOAD-BEARING INVARIANT: a FAILED probe returns 422 and persists NOTHING.
    Persist happens ONLY after a green probe on ``mode:'connect'``. If the
    crypto key is unset on a ``connect`` we hard-fail (500) rather than store a
    plaintext or un-encrypted secret -- see connect_graph / connect_imap.

SCOPE (v1, MBOX-468): records here are dashboard-side source-of-truth only.
'connected' does NOT mean 'the agent can send/receive on this mailbox' -- the
n8n credential push that makes a mailbox operational is a deferred follow-up
(same boundary as the existing Gmail STAQPRO-152 handoff). Deliberately dropped
from the TS source: advanceOnboarding / setEmail (no onboarding state machine in
hermes) and the is_default/adopted migration-033 sentinel (no host-side schema).
"""
from __future__ import annotations

import json
import logging
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from hermes_constants import get_hermes_home

from hermes_cli import mail_probe, token_crypto

_log = logging.getLogger(__name__)

# Providers this store understands. Kept narrow on purpose.
_PROVIDERS = ("microsoft", "imap")

# A conservative email sanity check for filename derivation. The pydantic body
# models already validate shape; this is defence-in-depth before a value becomes
# a filesystem path.
_EMAIL_RE = re.compile(r"^[^@/\\\s]+@[^@/\\\s]+$")


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
def _home() -> Path:
    return get_hermes_home()


def accounts_dir() -> Path:
    return _home() / "mail_accounts"


def _safe_email(email: str) -> str:
    """Lower-case + validate an email so it can derive a filename. Raises
    ``ValueError`` on anything that could escape the directory (``/``, ``\\``,
    whitespace, ``..``). Defence-in-depth: never let an untrusted value become a
    path component."""
    e = (email or "").strip().lower()
    if not _EMAIL_RE.match(e) or ".." in e:
        raise ValueError(f"invalid account email: {email!r}")
    return e


def _record_path(email: str) -> Path:
    return accounts_dir() / f"{_safe_email(email)}.json"


# ---------------------------------------------------------------------------
# Atomic 0600 write (verified idiom from shopify_accounts.py:185)
# ---------------------------------------------------------------------------
def _write_json_600(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".tmp.{os.getpid()}")
    # Create the temp file 0600 from the outset so there is no world-readable
    # window between write and chmod (matters on multi-user hosts).
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w") as fh:
            fh.write(json.dumps(data, indent=2))
    finally:
        os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def _read_record(email: str) -> Optional[Dict[str, Any]]:
    try:
        p = _record_path(email)
    except ValueError:
        return None
    if not p.is_file():
        return None
    try:
        data = json.loads(p.read_text())
    except Exception:  # noqa: BLE001
        return None
    return data if isinstance(data, dict) else None


def _read_all() -> List[Dict[str, Any]]:
    d = accounts_dir()
    if not d.is_dir():
        return []
    out: List[Dict[str, Any]] = []
    for p in sorted(d.glob("*.json")):
        try:
            data = json.loads(p.read_text())
        except Exception:  # noqa: BLE001
            continue
        if isinstance(data, dict):
            out.append(data)
    return out


# ---------------------------------------------------------------------------
# Public read surface (NEVER returns the secret)
# ---------------------------------------------------------------------------
def list_accounts() -> List[Dict[str, Any]]:
    """Connected mailboxes, oldest first, WITHOUT ``secret_enc`` /
    ``provider_config`` internals -- only the operator-facing summary."""
    rows = sorted(_read_all(), key=lambda r: r.get("connected_at") or "")
    out: List[Dict[str, Any]] = []
    for r in rows:
        email = r.get("email")
        if not email:
            continue
        out.append(
            {
                "id": r.get("id"),
                "provider": r.get("provider"),
                "email": email,
                "display_label": r.get("display_label"),
                "mailbox": (r.get("provider_config") or {}).get("mailbox") or email,
                "connected_at": r.get("connected_at"),
            }
        )
    return out


def delete_account(account_id: str) -> bool:
    """Remove a connected mailbox by its record ``id``. Returns True iff a
    record was removed. Forgets the local (encrypted) secret only -- there is no
    remote revoke for app passwords / client secrets."""
    d = accounts_dir()
    if not d.is_dir():
        return False
    for p in sorted(d.glob("*.json")):
        try:
            data = json.loads(p.read_text())
        except Exception:  # noqa: BLE001
            continue
        if isinstance(data, dict) and data.get("id") == account_id:
            try:
                p.unlink()
                return True
            except Exception:  # noqa: BLE001
                _log.warning("mail account delete failed", exc_info=True)
                return False
    return False


# ---------------------------------------------------------------------------
# Persist (only ever called after a green probe on mode:'connect')
# ---------------------------------------------------------------------------
def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _persist(
    *,
    provider: str,
    email: str,
    display_label: Optional[str],
    provider_config: Dict[str, Any],
    secret_plaintext: str,
) -> str:
    """Encrypt the secret and write the 0600 record, replacing any existing
    record for the same email. Returns the new account id.

    Raises ``token_crypto.CryptoConfigError`` BEFORE touching disk when the key
    is unset/malformed -- so a connect with no key stores NOTHING."""
    # Encrypt FIRST. If this raises (no/bad key) we never write a record, so an
    # un-encryptable secret can never land on disk in any form.
    secret_enc = token_crypto.encrypt_secret(secret_plaintext)
    account_id = uuid.uuid4().hex
    record = {
        "id": account_id,
        "provider": provider,
        "email": _safe_email(email),
        "display_label": display_label,
        "provider_config": provider_config,
        "secret_enc": secret_enc,
        "connected_at": _now_iso(),
    }
    _write_json_600(_record_path(email), record)
    return account_id


# ---------------------------------------------------------------------------
# Connect orchestration -- Microsoft 365 / Graph
# Ports dashboard/lib/mail/connect-graph.ts. Returns (status_code, body) so the
# route layer can JSONResponse(body, status_code=status).
# ---------------------------------------------------------------------------
async def connect_graph(d: Dict[str, Any]) -> tuple[int, Dict[str, Any]]:
    """probe -> 422-on-fail -> (test|connect) -> persist for a M365 mailbox.

    ``d`` is the validated GraphConnectBody as a dict. Probe failures NEVER
    persist (422). On ``mode:'connect'`` + green probe, persists the account
    with the client secret encrypted; a missing crypto key is a 500 and stores
    nothing."""
    import asyncio

    email = str(d["email"]).strip().lower()
    mailbox = str(d.get("mailbox") or d["email"]).strip().lower()
    mode = d.get("mode") or "test"

    # Probe is blocking httpx -> run in executor (route is async).
    loop = asyncio.get_running_loop()
    probe = await loop.run_in_executor(
        None,
        mail_probe.probe_graph,
        str(d["tenant_id"]),
        str(d["client_id"]),
        str(d["client_secret"]),
        mailbox,
    )

    if not probe["ok"]:
        # Probe failed -- never persist unvalidated credentials.
        return 422, {"ok": False, "token": probe["token"], "mailbox": probe["mailbox"]}

    if mode == "test":
        return 200, {
            "ok": True,
            "tested": True,
            "token": probe["token"],
            "mailbox": probe["mailbox"],
        }

    # mode == 'connect' -- probe passed; persist with the client secret encrypted.
    try:
        provider_config = {
            "tenant_id": str(d["tenant_id"]),
            "client_id": str(d["client_id"]),
            "mailbox": mailbox,
            "auth": "client_credentials",
        }
        account_id = await loop.run_in_executor(
            None,
            lambda: _persist(
                provider="microsoft",
                email=email,
                display_label=d.get("display_label"),
                provider_config=provider_config,
                secret_plaintext=str(d["client_secret"]),
            ),
        )
        return 200, {"ok": True, "account_id": account_id, "provider": "microsoft"}
    except Exception as exc:  # noqa: BLE001
        # Scrub: log without the body; the message here is our own (no secret).
        _log.warning("connect_graph persist failed: %s", _scrub(exc))
        return 500, {"ok": False, "error": _scrub(exc)}


# ---------------------------------------------------------------------------
# Connect orchestration -- IMAP / SMTP
# Ports dashboard/lib/mail/connect-imap.ts.
# ---------------------------------------------------------------------------
async def connect_imap(d: Dict[str, Any]) -> tuple[int, Dict[str, Any]]:
    """probe -> 422-on-fail -> (test|connect) -> persist for an IMAP mailbox.

    ``d`` is the validated ImapConnectBody as a dict. Probe failures NEVER
    persist (422). On ``mode:'connect'`` + green probe, persists the account
    with the app password encrypted; a missing crypto key is a 500 and stores
    nothing."""
    import asyncio

    email = str(d["email"]).strip().lower()
    mode = d.get("mode") or "test"

    probe = await mail_probe.probe_imap_smtp(
        imap_host=str(d["imap_host"]),
        imap_port=int(d["imap_port"]),
        smtp_host=str(d["smtp_host"]),
        smtp_port=int(d["smtp_port"]),
        username=str(d["username"]),
        password=str(d["app_password"]),
    )

    if not probe["ok"]:
        # Probe failed -- never persist unvalidated credentials.
        return 422, {"ok": False, "imap": probe["imap"], "smtp": probe["smtp"]}

    if mode == "test":
        return 200, {"ok": True, "tested": True, "imap": probe["imap"], "smtp": probe["smtp"]}

    # mode == 'connect' -- probe passed; persist with the app password encrypted.
    try:
        provider_config = {
            "imap_host": str(d["imap_host"]),
            "imap_port": int(d["imap_port"]),
            "smtp_host": str(d["smtp_host"]),
            "smtp_port": int(d["smtp_port"]),
            "username": str(d["username"]),
            "mailbox": email,
            "tls": True,
        }
        loop = asyncio.get_running_loop()
        account_id = await loop.run_in_executor(
            None,
            lambda: _persist(
                provider="imap",
                email=email,
                display_label=d.get("display_label"),
                provider_config=provider_config,
                secret_plaintext=str(d["app_password"]),
            ),
        )
        return 200, {"ok": True, "account_id": account_id, "provider": "imap"}
    except Exception as exc:  # noqa: BLE001
        _log.warning("connect_imap persist failed: %s", _scrub(exc))
        return 500, {"ok": False, "error": _scrub(exc)}


def _scrub(exc: Exception) -> str:
    """A short, secret-free error string for the 500 body / logs. Our own
    _persist raises CryptoConfigError (no secret) or filesystem errors (path,
    not secret); we still cap length and never include the request body."""
    msg = str(exc).strip()
    return (msg or exc.__class__.__name__)[:200]
