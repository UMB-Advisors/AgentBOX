"""Registration bridge: push Hermes mail-account connects into mailbox.accounts.

MBOX-482 — the live operator-facing mail-account connect UI is HERMES-side (the
0600 file store in ``mail_accounts.py``), but the n8n ingestion/send pipeline
keys everything on the mailbox dashboard's Postgres ``mailbox.accounts`` table
(+ ``provider_secret_enc``). MBOX-468/470 shipped the connect UX but explicitly
deferred this "credential push". This module IS the push.

Hermes has no Postgres driver in ``hermes_cli`` core deps (every connector here
is a file store), so we reach the dashboard the same way the n8n Gmail token
minter is reached: httpx over the on-box docker/loopback network to the
mailbox-dashboard internal API, gated by the shared ``HERMES_INTERNAL_TOKEN``
(the dashboard route constant-time-compares it, fail-closed).

Single source of truth: the Hermes file store is the operator master;
``mailbox.accounts`` is the projection. We send the transport secret as
PLAINTEXT (the connect request just validated it) over the trusted internal
network; the dashboard re-encrypts it under ITS key
(``MAILBOX_OAUTH_TOKEN_KEY``) — distinct from Hermes' ``HERMES_MAIL_SECRET_KEY``
— because the pipeline only ever reads ``provider_secret_enc``.

Best-effort + non-fatal: a bridge failure NEVER fails the operator's connect (the
Hermes file store already persisted, which is the master). It logs a warning;
the operator/orchestrator can re-run the projection (the dashboard upsert is
idempotent on email). Secrets are never logged.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Dict, Optional

_log = logging.getLogger(__name__)

# Same default + override the dashboard proxy uses (web_server._DASHBOARD_UPSTREAM).
# On-box this is the loopback dashboard; the docker-network name is injected via
# MAILBOX_DASHBOARD_URL when Hermes runs in a sibling container.
_DEFAULT_DASHBOARD_URL = "http://127.0.0.1:3001"

# Short timeout — the projection is a single small upsert. A slow/down dashboard
# must not stall the connect response (we're best-effort).
_TIMEOUT_SECONDS = 8.0


def _dashboard_url() -> str:
    return os.environ.get("MAILBOX_DASHBOARD_URL", _DEFAULT_DASHBOARD_URL).rstrip("/")


def _internal_token() -> Optional[str]:
    tok = (os.environ.get("HERMES_INTERNAL_TOKEN") or "").strip()
    return tok or None


def _post(path: str, body: Dict[str, Any]) -> tuple[bool, Optional[Dict[str, Any]]]:
    """POST to a dashboard internal route with the shared-secret header. Returns
    (ok, json|None). Never raises — a transport/auth failure logs + returns
    (False, None). Imports httpx lazily so the file store has no hard dep."""
    token = _internal_token()
    if token is None:
        _log.warning(
            "mail-account bridge skipped: HERMES_INTERNAL_TOKEN unset "
            "(dashboard projection not written for %s)",
            path,
        )
        return False, None

    import httpx

    url = f"{_dashboard_url()}/dashboard/api/internal/accounts/{path}"
    try:
        resp = httpx.post(
            url,
            json=body,
            headers={"X-Hermes-Internal-Token": token},
            timeout=_TIMEOUT_SECONDS,
        )
    except httpx.HTTPError as exc:
        _log.warning("mail-account bridge %s unreachable: %s", path, exc)
        return False, None

    if resp.status_code >= 400:
        # Don't log the request body (it may carry a secret on register); the
        # dashboard's error message is our own (no secret).
        detail = ""
        try:
            detail = str(resp.json().get("error", ""))[:200]
        except Exception:  # noqa: BLE001
            detail = ""
        _log.warning(
            "mail-account bridge %s returned %s: %s", path, resp.status_code, detail
        )
        return False, None

    try:
        return True, resp.json()
    except Exception:  # noqa: BLE001
        return True, None


def register_account(
    *,
    provider: str,
    email: str,
    display_label: Optional[str],
    provider_config: Dict[str, Any],
    secret_plaintext: str,
) -> bool:
    """Project a connected/re-authed IMAP or M365 mailbox into mailbox.accounts.

    Carries the plaintext transport secret (the dashboard re-encrypts under its
    own key). Best-effort: returns True on a 200 projection, False otherwise —
    the caller must NOT fail the connect on False (the Hermes file store is the
    master and already persisted)."""
    if provider not in ("imap", "microsoft"):
        # gmail never flows through this bridge (Google connect → oauth_tokens).
        return False
    ok, _ = _post(
        "register",
        {
            "provider": provider,
            "email": email,
            "display_label": display_label,
            "provider_config": provider_config,
            "secret": secret_plaintext,
        },
    )
    if ok:
        _log.info("mail-account bridge: projected %s (%s) into mailbox.accounts", email, provider)
    return ok


def deregister_account(*, email: str) -> bool:
    """Revoke a disconnected mailbox's pipeline projection (mailbox.accounts).

    Keyed by stable email. Best-effort + idempotent (the dashboard returns
    ok:false reason:not_found as a 200 when nothing matches)."""
    ok, _ = _post("deregister", {"email": email})
    if ok:
        _log.info("mail-account bridge: deregistered %s from mailbox.accounts", email)
    return ok
