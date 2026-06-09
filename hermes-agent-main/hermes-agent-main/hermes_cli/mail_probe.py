"""Pre-save connection probes for Microsoft 365 / Graph + IMAP/SMTP (MBOX-468).

Ported from the mailbox dashboard's dependency-light probes
(``dashboard/lib/mail/test-graph-connection.ts`` +
``dashboard/lib/mail/test-connection.ts``). DESIGN: these answer a single
question -- "do these operator-entered credentials authenticate?" -- and
nothing else. No Graph SDK, no imapflow/nodemailer equivalent; M365 uses
``httpx`` (already a core dep) and IMAP/SMTP use the stdlib (``imaplib`` /
``smtplib``).

INVARIANT: a probe NEVER raises. Every failure -- unreachable host, timeout,
auth rejection -- comes back as ``{ok: False, detail: <str>}`` where ``detail``
is safe to show the operator (no secret is ever echoed). The route layer relies
on this so a failed probe maps to 422 and 500 is reserved for persist failures.
"""
from __future__ import annotations

import asyncio
import imaplib
import ipaddress
import smtplib
import socket
import urllib.parse
from typing import Any, Dict, Tuple

# M365 / Graph endpoints + scope. Mirror the TS constants verbatim.
_TOKEN_HOST = "https://login.microsoftonline.com"
_GRAPH_BASE = "https://graph.microsoft.com/v1.0"
_GRAPH_SCOPE = "https://graph.microsoft.com/.default"

# 8s timeout on every leg, everywhere (matches the TS REQUEST_TIMEOUT_MS and the
# IMAP/SMTP CONNECT/READ timeouts).
_TIMEOUT_S = 8.0


def _result(ok: bool, detail: str) -> Dict[str, Any]:
    return {"ok": ok, "detail": detail}


# ---------------------------------------------------------------------------
# Microsoft 365 / Graph -- pure response classifiers (ported verbatim)
# ---------------------------------------------------------------------------
def graph_token_verdict(status: int, body: Any) -> Dict[str, Any]:
    """Classify the OAuth2 client-credentials token response. 200 +
    ``access_token`` = success; non-2xx + ``{error, error_description}`` =
    failure. Surfaces the AADSTS code (first line of error_description) when
    present -- the single most useful thing for an operator support search."""
    b = body if isinstance(body, dict) else {}
    access_token = b.get("access_token")
    if 200 <= status < 300 and isinstance(access_token, str) and access_token:
        return _result(True, "App-only token acquired")
    err = b.get("error") if isinstance(b.get("error"), str) else f"HTTP {status}"
    desc = b.get("error_description") if isinstance(b.get("error_description"), str) else ""
    # First line of error_description carries the AADSTSxxxxx code.
    first_line = (desc.splitlines()[0][:240] if desc else "")
    if err == "invalid_client":
        return _result(False, f"Bad client secret or app id ({first_line or 'invalid_client'})")
    if err in ("unauthorized_client", "invalid_request"):
        return _result(False, f"App registration / tenant problem ({first_line or err})")
    return _result(False, f"Token request failed: {first_line or err}")


def graph_mailbox_verdict(status: int, body: Any) -> Dict[str, Any]:
    """Classify the GET inbox/messages probe. 200 = the app token can read the
    mailbox. Failure codes map to actionable operator guidance -- distinguishing
    'wrong mailbox' from 'missing admin consent' saves a support round-trip."""
    if 200 <= status < 300:
        return _result(True, "Inbox read OK")
    b = body if isinstance(body, dict) else {}
    inner = b.get("error") if isinstance(b.get("error"), dict) else {}
    code = inner.get("code") if isinstance(inner.get("code"), str) else ""
    if status == 401:
        return _result(False, "Graph rejected the token (401) -- re-check app credentials")
    if status == 403:
        # Authenticated but lacks Mail.ReadWrite application permission, or admin
        # consent was never granted -- the most common Graph BYO snag.
        return _result(
            False,
            "Forbidden (403) -- grant the app the Mail.ReadWrite APPLICATION "
            "permission and admin consent",
        )
    if status == 404 or code in ("ErrorInvalidUser", "ResourceNotFound"):
        return _result(False, f"Mailbox not found ({code or 404}) -- check the email/UPN")
    if status == 429:
        return _result(False, "Graph throttled the probe (429) -- retry shortly")
    return _result(False, f"Inbox read failed ({status}{(' ' + code) if code else ''})")


# ---------------------------------------------------------------------------
# Microsoft 365 / Graph -- httpx plumbing (blocking; run via run_in_executor)
# ---------------------------------------------------------------------------
def _probe_graph_token(
    tenant_id: str, client_id: str, client_secret: str
) -> Tuple[Dict[str, Any], str | None]:
    """Mint an app-only token. Returns (verdict, access_token|None). Never
    raises -- a transport failure becomes ok:False."""
    import httpx

    try:
        # urllib.parse.quote the tenant_id before it enters the URL path.
        url = f"{_TOKEN_HOST}/{urllib.parse.quote(tenant_id)}/oauth2/v2.0/token"
        resp = httpx.post(
            url,
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "grant_type": "client_credentials",
                "scope": _GRAPH_SCOPE,
            },
            headers={"content-type": "application/x-www-form-urlencoded"},
            timeout=_TIMEOUT_S,
        )
        body = _json_or_empty(resp)
        verdict = graph_token_verdict(resp.status_code, body)
        token = body.get("access_token") if (verdict["ok"] and isinstance(body, dict)) else None
        token = token if isinstance(token, str) else None
        return verdict, token
    except Exception as exc:  # noqa: BLE001 -- probe must never raise
        return _result(False, f"Token endpoint unreachable: {_safe_err(exc)}"), None


def _probe_graph_mailbox(mailbox: str, token: str) -> Dict[str, Any]:
    """Read the target inbox with the app token. Never raises."""
    import httpx

    try:
        # urllib.parse.quote the mailbox (UPN) before it enters the URL path.
        url = (
            f"{_GRAPH_BASE}/users/{urllib.parse.quote(mailbox)}"
            "/mailFolders/inbox/messages?$top=1&$select=id"
        )
        resp = httpx.get(
            url,
            headers={"authorization": f"Bearer {token}", "accept": "application/json"},
            timeout=_TIMEOUT_S,
        )
        return graph_mailbox_verdict(resp.status_code, _json_or_empty(resp))
    except Exception as exc:  # noqa: BLE001 -- probe must never raise
        return _result(False, f"Graph unreachable: {_safe_err(exc)}")


def probe_graph(
    tenant_id: str, client_id: str, client_secret: str, mailbox: str
) -> Dict[str, Any]:
    """Validate BYO Azure app credentials end-to-end: mint an app-only token,
    then read the target inbox with it. Blocking (httpx sync) -- the route runs
    it via ``run_in_executor``. Returns
    ``{ok, token: {ok, detail}, mailbox: {ok, detail}}`` and never raises."""
    token_verdict, access_token = _probe_graph_token(tenant_id, client_id, client_secret)
    if not token_verdict["ok"] or not access_token:
        return {
            "ok": False,
            "token": token_verdict,
            "mailbox": _result(False, "Skipped -- token acquisition failed"),
        }
    mailbox_verdict = _probe_graph_mailbox(mailbox, access_token)
    return {
        "ok": token_verdict["ok"] and mailbox_verdict["ok"],
        "token": token_verdict,
        "mailbox": mailbox_verdict,
    }


def _json_or_empty(resp: Any) -> Any:
    try:
        return resp.json()
    except Exception:  # noqa: BLE001
        return {}


def _safe_err(exc: Exception) -> str:
    """A short, secret-free description of a transport exception. We use the
    exception class name plus its str(); httpx/imaplib/smtplib never put the
    credential in the message, but we keep it terse regardless. Capped so a
    long transport message can't bloat the operator-facing detail (covers the
    Graph token/mailbox call sites, which previously didn't cap)."""
    msg = str(exc).strip()
    return (msg or exc.__class__.__name__)[:200]


def _host_block_reason(host: str) -> str | None:
    """SSRF guard for operator-supplied IMAP/SMTP hosts. Resolve ``host`` and
    return a reason string if it must NOT be probed -- it resolves to a
    loopback / link-local (incl. 169.254.169.254 cloud metadata) / private /
    reserved / multicast / unspecified address -- else ``None``. Blocks if ANY
    resolved address is disallowed, so a dual-record host can't smuggle one
    public + one internal A record past the check.

    Residual: a TOCTOU window remains (imaplib/smtplib re-resolve at connect),
    so this is the standard, proportionate mitigation for a single-tenant
    appliance -- and the right gate to harden before any multi-tenant exposure.
    """
    h = (host or "").strip()
    if not h:
        return "is empty"
    try:
        infos = socket.getaddrinfo(h, None, proto=socket.IPPROTO_TCP)
    except OSError:
        return f"did not resolve ({h[:120]})"
    for info in infos:
        addr = info[4][0]
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            return f"resolved to an unparseable address ({h[:120]})"
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            return f"resolves to a non-public address ({h[:120]})"
    return None


# ---------------------------------------------------------------------------
# IMAP / SMTP -- stdlib probes (blocking; run via run_in_executor)
# ---------------------------------------------------------------------------
def _probe_imap(host: str, port: int, username: str, password: str) -> Dict[str, Any]:
    """IMAP implicit-TLS connect + LOGIN. Never raises."""
    blocked = _host_block_reason(host)
    if blocked is not None:
        return _result(False, f"IMAP host {blocked}")
    conn = None
    try:
        conn = imaplib.IMAP4_SSL(host, port, timeout=_TIMEOUT_S)
        # login() raises imaplib.error on a NO/BAD tagged response.
        conn.login(username, password)
        return _result(True, "IMAP login OK")
    except imaplib.IMAP4.error as exc:
        return _result(False, f"IMAP login rejected: {_safe_err(exc)[:200]}")
    except Exception as exc:  # noqa: BLE001 -- probe must never raise
        return _result(False, f"IMAP: {_safe_err(exc)}")
    finally:
        if conn is not None:
            try:
                conn.logout()
            except Exception:  # noqa: BLE001
                pass


def _probe_smtp(host: str, port: int, username: str, password: str) -> Dict[str, Any]:
    """SMTP login. Port 465 = implicit TLS (SMTP_SSL); otherwise plain connect
    then STARTTLS upgrade. Never raises."""
    blocked = _host_block_reason(host)
    if blocked is not None:
        return _result(False, f"SMTP host {blocked}")
    conn = None
    try:
        if port == 465:
            conn = smtplib.SMTP_SSL(host, port, timeout=_TIMEOUT_S)
        else:
            conn = smtplib.SMTP(host, port, timeout=_TIMEOUT_S)
            conn.ehlo()
            conn.starttls()
            conn.ehlo()
        conn.login(username, password)
        return _result(True, "SMTP login OK")
    except smtplib.SMTPAuthenticationError as exc:
        return _result(False, f"SMTP auth failed: bad username/password ({exc.smtp_code})")
    except smtplib.SMTPException as exc:
        return _result(False, f"SMTP: {_safe_err(exc)[:200]}")
    except Exception as exc:  # noqa: BLE001 -- probe must never raise
        return _result(False, f"SMTP: {_safe_err(exc)}")
    finally:
        if conn is not None:
            try:
                conn.quit()
            except Exception:  # noqa: BLE001
                pass


async def probe_imap_smtp(
    imap_host: str,
    imap_port: int,
    smtp_host: str,
    smtp_port: int,
    username: str,
    password: str,
) -> Dict[str, Any]:
    """Run the IMAP + SMTP legs concurrently; BOTH must pass. Each leg is a
    blocking stdlib call dispatched to the default executor so the two run in
    parallel. Returns ``{ok, imap: {ok, detail}, smtp: {ok, detail}}`` and never
    raises."""
    loop = asyncio.get_running_loop()
    imap_fut = loop.run_in_executor(
        None, _probe_imap, imap_host, imap_port, username, password
    )
    smtp_fut = loop.run_in_executor(
        None, _probe_smtp, smtp_host, smtp_port, username, password
    )
    imap_res, smtp_res = await asyncio.gather(imap_fut, smtp_fut)
    return {"ok": imap_res["ok"] and smtp_res["ok"], "imap": imap_res, "smtp": smtp_res}
