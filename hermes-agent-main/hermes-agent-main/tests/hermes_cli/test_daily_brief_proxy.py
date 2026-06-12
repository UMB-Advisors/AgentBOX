"""Tests for the MBOX-479 daily-brief proxy route (``/api/daily-brief``).

The brief's pending/urgent/oldest widgets read mailbox-pipeline data, which
hermes_cli has no Postgres driver to reach — so the route is a thin JSON proxy
to the on-box mailbox-dashboard (same model as the MBOX-472 classifications
proxy). These tests pin three behaviours without a live :3001 upstream:

  1. it forwards to ``<upstream>/dashboard/api/daily-brief``;
  2. it relays an upstream JSON payload + status verbatim;
  3. it degrades a non-JSON / unreachable upstream to a clean JSON error
     (so the SPA renders an empty brief, never a raw HTML 404 / a 500).
"""

from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

from hermes_cli import web_server


@pytest.fixture
def client_loopback():
    prev_host = getattr(web_server.app.state, "bound_host", None)
    prev_port = getattr(web_server.app.state, "bound_port", None)
    web_server.app.state.bound_host = "127.0.0.1"
    web_server.app.state.bound_port = 9119
    client = TestClient(web_server.app, base_url="http://127.0.0.1:9119")
    yield client
    web_server.app.state.bound_host = prev_host
    web_server.app.state.bound_port = prev_port


def _auth():
    return {"X-Hermes-Session-Token": web_server._SESSION_TOKEN}


class _FakeAsyncClient:
    """Minimal async-context httpx.AsyncClient stand-in returning a canned
    response (or raising) so the proxy is exercised without a live upstream."""

    def __init__(self, *, response=None, exc=None):
        self._response = response
        self._exc = exc
        self.requested_url: str | None = None
        self.requested_method: str | None = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def request(self, method, url, **kwargs):
        self.requested_method = method
        self.requested_url = url
        if self._exc is not None:
            raise self._exc
        return self._response


def test_route_exists_and_is_auth_gated(client_loopback, monkeypatch):
    """No token -> 401 (proves the route is mounted and behind the gate)."""
    r = client_loopback.get("/api/daily-brief")
    assert r.status_code == 401


def test_relays_upstream_payload(client_loopback, monkeypatch):
    payload = {
        "counts_by_category": [{"category": "sales", "count": 3}],
        "urgent_untouched": [],
        "oldest_pending": [],
    }
    fake = _FakeAsyncClient(
        response=httpx.Response(200, json=payload, request=httpx.Request("GET", "http://x"))
    )
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **k: fake)

    r = client_loopback.get("/api/daily-brief", headers=_auth())

    assert r.status_code == 200
    assert r.json() == payload
    # Forwarded to the mailbox-dashboard daily-brief JSON route.
    assert fake.requested_url == f"{web_server._DASHBOARD_UPSTREAM}/dashboard/api/daily-brief"
    assert fake.requested_method == "GET"


def test_non_json_upstream_degrades_to_clean_error(client_loopback, monkeypatch):
    """A Next.js HTML 404 (route not added yet) must surface as JSON, not HTML."""
    html_404 = httpx.Response(
        404, text="<html>not found</html>", request=httpx.Request("GET", "http://x")
    )
    fake = _FakeAsyncClient(response=html_404)
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **k: fake)

    r = client_loopback.get("/api/daily-brief", headers=_auth())

    assert r.status_code == 404
    assert "detail" in r.json()  # clean JSON, the SPA renders an empty brief


def test_unreachable_upstream_is_502(client_loopback, monkeypatch):
    fake = _FakeAsyncClient(exc=httpx.ConnectError("connection refused"))
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **k: fake)

    r = client_loopback.get("/api/daily-brief", headers=_auth())

    assert r.status_code == 502
    assert "unreachable" in r.json()["detail"]
