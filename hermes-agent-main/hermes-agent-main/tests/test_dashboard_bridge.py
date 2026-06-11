"""Tests for hermes_cli.dashboard_bridge (MBOX-482 registration bridge).

Covers: fail-closed when HERMES_INTERNAL_TOKEN is unset, gmail rejected from the
bridge, the register/deregister POST shape (path, header, body) via a fake httpx,
and best-effort non-raising on a transport/HTTP error. No real network.
"""
import sys
import types

import pytest

from hermes_cli import dashboard_bridge


class _FakeResp:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload if payload is not None else {}

    def json(self):
        return self._payload


class _FakeHTTPError(Exception):
    pass


def _install_fake_httpx(monkeypatch, *, calls, resp=None, raise_exc=None):
    """Inject a fake httpx module so _post() exercises real code without a socket."""
    mod = types.ModuleType("httpx")
    mod.HTTPError = _FakeHTTPError

    def _post(url, json=None, headers=None, timeout=None):
        calls.append({"url": url, "json": json, "headers": headers, "timeout": timeout})
        if raise_exc is not None:
            raise raise_exc
        return resp if resp is not None else _FakeResp()

    mod.post = _post
    monkeypatch.setitem(sys.modules, "httpx", mod)


def test_register_skips_when_internal_token_unset(monkeypatch):
    monkeypatch.delenv("HERMES_INTERNAL_TOKEN", raising=False)
    calls: list = []
    _install_fake_httpx(monkeypatch, calls=calls)
    ok = dashboard_bridge.register_account(
        provider="imap",
        email="ops@acme.com",
        display_label="Ops",
        provider_config={"imap_host": "imap.acme.com"},
        secret_plaintext="app-pw",
    )
    assert ok is False
    assert calls == []  # fail-closed: no request made without the shared secret


def test_register_rejects_gmail(monkeypatch):
    monkeypatch.setenv("HERMES_INTERNAL_TOKEN", "t0ken")
    calls: list = []
    _install_fake_httpx(monkeypatch, calls=calls)
    ok = dashboard_bridge.register_account(
        provider="gmail",
        email="ops@acme.com",
        display_label=None,
        provider_config={},
        secret_plaintext="x",
    )
    assert ok is False
    assert calls == []  # gmail never flows through the bridge


def test_register_posts_expected_shape(monkeypatch):
    monkeypatch.setenv("HERMES_INTERNAL_TOKEN", "t0ken")
    monkeypatch.setenv("MAILBOX_DASHBOARD_URL", "http://mailbox-dashboard:3001")
    calls: list = []
    _install_fake_httpx(
        monkeypatch, calls=calls, resp=_FakeResp(200, {"ok": True, "account_id": 5, "adopted": True})
    )
    ok = dashboard_bridge.register_account(
        provider="microsoft",
        email="ops@acme.com",
        display_label="Ops",
        provider_config={"tenant_id": "t", "client_id": "c"},
        secret_plaintext="client-secret",
    )
    assert ok is True
    assert len(calls) == 1
    c = calls[0]
    assert c["url"] == "http://mailbox-dashboard:3001/dashboard/api/internal/accounts/register"
    assert c["headers"]["X-Hermes-Internal-Token"] == "t0ken"
    assert c["json"]["provider"] == "microsoft"
    assert c["json"]["email"] == "ops@acme.com"
    assert c["json"]["secret"] == "client-secret"
    assert c["json"]["provider_config"] == {"tenant_id": "t", "client_id": "c"}


def test_deregister_posts_email_only(monkeypatch):
    monkeypatch.setenv("HERMES_INTERNAL_TOKEN", "t0ken")
    monkeypatch.delenv("MAILBOX_DASHBOARD_URL", raising=False)
    calls: list = []
    _install_fake_httpx(monkeypatch, calls=calls, resp=_FakeResp(200, {"ok": False, "reason": "not_found"}))
    ok = dashboard_bridge.deregister_account(email="ops@acme.com")
    assert ok is True  # 200 (even ok:false not_found) is a successful bridge call
    assert len(calls) == 1
    c = calls[0]
    assert c["url"] == "http://127.0.0.1:3001/dashboard/api/internal/accounts/deregister"
    assert c["json"] == {"email": "ops@acme.com"}


def test_register_non_fatal_on_transport_error(monkeypatch):
    monkeypatch.setenv("HERMES_INTERNAL_TOKEN", "t0ken")
    calls: list = []
    _install_fake_httpx(monkeypatch, calls=calls, raise_exc=_FakeHTTPError("conn refused"))
    # Must NOT raise — best-effort. Returns False so the caller logs but the
    # connect still succeeds.
    ok = dashboard_bridge.register_account(
        provider="imap",
        email="ops@acme.com",
        display_label=None,
        provider_config={},
        secret_plaintext="x",
    )
    assert ok is False


def test_register_non_fatal_on_http_4xx(monkeypatch):
    monkeypatch.setenv("HERMES_INTERNAL_TOKEN", "t0ken")
    calls: list = []
    _install_fake_httpx(monkeypatch, calls=calls, resp=_FakeResp(401, {"error": "unauthorized"}))
    ok = dashboard_bridge.register_account(
        provider="imap",
        email="ops@acme.com",
        display_label=None,
        provider_config={},
        secret_plaintext="x",
    )
    assert ok is False
