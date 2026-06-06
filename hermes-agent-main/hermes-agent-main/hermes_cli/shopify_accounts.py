"""Multi-store Shopify connection for the dashboard.

This module owns the *dashboard's* Shopify OAuth — a full server-side
authorization-code flow that lets the operator connect one or more Shopify
stores from the dashboard UI, no CLI / token pasting. It mirrors
``google_accounts.py``: plain HTTPS (no Shopify SDK), CSRF-protected by a
signed ``state`` cookie set on ``start`` (see web_server.py endpoints), and
tokens written ``chmod 600``.

Storage layout under ``$HERMES_HOME``::

    shopify_accounts.json            # one record per connected store

Each record has the shape
``{shop_domain, access_token, scope, connected_at}``.

Shopify *app* credentials (the OAuth client) come from the environment:

    SHOPIFY_APP_CLIENT_ID
    SHOPIFY_APP_CLIENT_SECRET

These are NEVER hardcoded. If unset, ``client_configured()`` returns False and
the start route surfaces a precise "app not set up" hint.

Security:
  * The flow is CSRF-protected by a signed ``state`` matched against an
    HttpOnly cookie (see web_server.py endpoints) — the token-exchange itself
    never trusts a bare ``code``.
  * The ``shop`` param is user input here (unlike the env case), so it is
    strictly validated against ``^[a-zA-Z0-9][a-zA-Z0-9-]*\\.myshopify\\.com$``
    before being placed in any URL — prevents open-redirect / SSRF.
  * Access tokens are NEVER logged, and the store-list endpoint omits them.
  * Token files are written ``chmod 600``; the box is single-tenant.

The OAuth token requested is OFFLINE (non-expiring): ``grant_options[]`` is
absent (NOT ``per-user``), so the saved token keeps working for the agent.
"""

from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from hermes_constants import get_hermes_home

_log = logging.getLogger(__name__)

# Scopes for the blog/article tooling: read + write the store's online content
# (blogs, articles, pages). Mirrors the shopify toolset's needs.
SCOPE = "write_content,read_content"

# Shopify's per-store OAuth endpoints are built from the shop domain:
#   https://{shop}/admin/oauth/authorize
#   https://{shop}/admin/oauth/access_token
_AUTHORIZE_PATH = "/admin/oauth/authorize"
_TOKEN_PATH = "/admin/oauth/access_token"

# A *.myshopify.com store domain. The shop comes from user input, so this gate
# is the single source of truth before the value is ever placed in a URL.
_SHOP_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$")


# ---------------------------------------------------------------------------
# Shop-domain validation
# ---------------------------------------------------------------------------
def valid_shop(shop: str) -> bool:
    """True iff ``shop`` is a syntactically valid ``*.myshopify.com`` domain."""
    return bool(_SHOP_RE.match(shop or ""))


def normalize_shop(shop: str) -> str:
    """Lower-case + strip a shop domain and validate it. Raises ``ValueError``
    on anything that isn't a ``*.myshopify.com`` host so no untrusted value
    ever reaches a URL."""
    s = (shop or "").strip().lower()
    if not valid_shop(s):
        raise ValueError(f"invalid shop domain: {shop!r}")
    return s


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
def _home() -> Path:
    return get_hermes_home()


def accounts_path() -> Path:
    return _home() / "shopify_accounts.json"


# ---------------------------------------------------------------------------
# App (OAuth client) credentials — from env, never hardcoded
# ---------------------------------------------------------------------------
def load_app_config() -> Dict[str, str]:
    """Return ``{client_id, client_secret}`` from the environment. Raises
    ``ValueError`` so callers can surface a precise "app not set up" hint."""
    client_id = os.getenv("SHOPIFY_APP_CLIENT_ID", "").strip()
    client_secret = os.getenv("SHOPIFY_APP_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        raise ValueError(
            "Shopify app not configured: set SHOPIFY_APP_CLIENT_ID and "
            "SHOPIFY_APP_CLIENT_SECRET in the environment."
        )
    return {"client_id": client_id, "client_secret": client_secret}


def client_configured() -> bool:
    try:
        load_app_config()
        return True
    except ValueError:
        return False


# ---------------------------------------------------------------------------
# Auth URL + token exchange (plain HTTPS, no Shopify SDK)
# ---------------------------------------------------------------------------
def build_auth_url(shop: str, redirect_uri: str, state: str) -> str:
    """Construct the Shopify consent URL for ``shop``.

    ``grant_options[]`` is intentionally ABSENT so Shopify issues an OFFLINE
    (non-expiring) token — the agent needs to act without the operator present.
    """
    from urllib.parse import urlencode

    shop = normalize_shop(shop)
    cfg = load_app_config()
    params = {
        "client_id": cfg["client_id"],
        "scope": SCOPE,
        "redirect_uri": redirect_uri,
        "state": state,
        # NOTE: no "grant_options[]" — that keyword would request a per-user
        # (online, expiring) token. Omitting it yields an offline token.
    }
    return f"https://{shop}{_AUTHORIZE_PATH}?{urlencode(params)}"


def exchange_code(shop: str, code: str) -> Dict[str, Any]:
    """Exchange an authorization ``code`` for an access token at
    ``https://{shop}/admin/oauth/access_token``. Returns Shopify's raw token
    response (``access_token``, ``scope``). Raises on a non-2xx so the caller
    redirects with an error."""
    import httpx

    shop = normalize_shop(shop)
    cfg = load_app_config()
    resp = httpx.post(
        f"https://{shop}{_TOKEN_PATH}",
        json={
            "client_id": cfg["client_id"],
            "client_secret": cfg["client_secret"],
            "code": code,
        },
        headers={"Accept": "application/json"},
        timeout=20.0,
    )
    if resp.status_code != 200:
        # Do NOT include the token in any log/message; body here is an error.
        raise RuntimeError(
            f"shopify token exchange failed ({resp.status_code}): {resp.text[:200]}"
        )
    return resp.json()


# ---------------------------------------------------------------------------
# Store records + storage
# ---------------------------------------------------------------------------
def _store_record(shop: str, token_resp: Dict[str, Any]) -> Dict[str, Any]:
    """Shape Shopify's token response into the on-disk record."""
    return {
        "shop_domain": shop,
        "access_token": token_resp.get("access_token"),
        "scope": token_resp.get("scope") or SCOPE,
        "connected_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
    }


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


def _read_all() -> List[Dict[str, Any]]:
    p = accounts_path()
    if not p.is_file():
        return []
    try:
        data = json.loads(p.read_text())
    except Exception:  # noqa: BLE001
        return []
    if isinstance(data, list):
        return [r for r in data if isinstance(r, dict)]
    return []


def save_store(shop: str, token_resp: Dict[str, Any]) -> Dict[str, Any]:
    """Persist a newly-connected store, replacing any existing record for the
    same ``shop_domain``. Returns the stored record."""
    shop = normalize_shop(shop)
    record = _store_record(shop, token_resp)
    stores = [r for r in _read_all() if r.get("shop_domain") != shop]
    stores.append(record)
    stores.sort(key=lambda r: r.get("connected_at") or "")
    _write_json_600(accounts_path(), stores)
    return record


def list_stores() -> List[Dict[str, Any]]:
    """Connected stores, oldest first, WITHOUT token values."""
    out: List[Dict[str, Any]] = []
    for r in sorted(_read_all(), key=lambda r: r.get("connected_at") or ""):
        shop = r.get("shop_domain")
        if not shop:
            continue
        out.append(
            {
                "shop_domain": shop,
                "scope": r.get("scope") or "",
                "connected_at": r.get("connected_at"),
            }
        )
    return out


def get_store(shop: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Return the full record (INCLUDING access_token) for ``shop``, or — when
    ``shop`` is omitted — the single connected store if exactly one exists.
    Returns None when there is no unambiguous match. For internal/tool use
    only; never return this shape to the dashboard."""
    stores = sorted(_read_all(), key=lambda r: r.get("connected_at") or "")
    if shop:
        shop = (shop or "").strip().lower()
        for r in stores:
            if r.get("shop_domain") == shop:
                return r
        return None
    if len(stores) == 1:
        return stores[0]
    return None


def resolve_credentials(shop: Optional[str] = None):
    """Resolve ``(shop_domain, access_token)`` for the shopify toolset.

    Resolution order (so the existing yes-cacao env path keeps working):
      1. A store connected via the dashboard. If ``shop`` is given, that exact
         store; otherwise the single connected store when exactly one exists.
      2. Fall back to the ``SHOPIFY_SHOP`` + ``SHOPIFY_ACCESS_TOKEN`` env vars.

    Returns ``None`` when neither source yields a usable pair (the tool should
    then raise its own "not configured" error). Never logs the token.

    This is the single integration point for ``tools/shopify_tools.py`` —
    its ``_get_config()`` should try this first and fall back to its existing
    env-only behaviour.
    """
    rec = get_store(shop)
    if rec and rec.get("shop_domain") and rec.get("access_token"):
        return rec["shop_domain"], rec["access_token"]
    env_shop = os.getenv("SHOPIFY_SHOP", "").strip()
    env_token = os.getenv("SHOPIFY_ACCESS_TOKEN", "").strip()
    if env_shop and env_token:
        return env_shop, env_token
    return None


def configured(shop: Optional[str] = None) -> bool:
    """True iff a usable store exists — either a connected store OR the env
    vars are set. Intended for the toolset's ``check_fn`` gate."""
    return resolve_credentials(shop) is not None


def delete_store(shop: str) -> bool:
    """Remove a connected store by domain. Returns True if a record was removed.
    Shopify offers no token-revoke endpoint for offline tokens, so this only
    forgets the token locally (the operator can uninstall the app in Shopify
    admin to fully revoke)."""
    try:
        shop = normalize_shop(shop)
    except ValueError:
        return False
    stores = _read_all()
    remaining = [r for r in stores if r.get("shop_domain") != shop]
    removed = len(remaining) != len(stores)
    if removed:
        _write_json_600(accounts_path(), remaining)
    return removed
