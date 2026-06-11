"""Tests for the dashboard's gbrain data-access layer (Home digest).

The digest path reads from the long-running ``gbrain serve`` daemon over
MCP Streamable HTTP (dashboard OAuth client_credentials); only the
graph-export adapter still shells out, and every shell-out must carry
GBRAIN_HOME so the CLI opens the same brain as the daemon (the historical
"digest always empty" bug). HTTP and subprocess are mocked throughout —
no daemon, no bun.
"""

from __future__ import annotations

import json

import pytest

from hermes_cli import web_server


GBRAIN_ENV_KEYS = (
    "GBRAIN_SERVE_URL",
    "GBRAIN_DASHBOARD_CLIENT_ID",
    "GBRAIN_DASHBOARD_CLIENT_SECRET",
    "GBRAIN_HOME",
    "GBRAIN_DATABASE_URL",
    "GBRAIN_DIGEST_QUERY",
    "GBRAIN_BUN",
    "GBRAIN_DIR",
)


@pytest.fixture(autouse=True)
def _isolate_gbrain_state(monkeypatch):
    """Strip host GBRAIN_* env / .env and reset module-level caches."""
    for key in GBRAIN_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    # Don't let the developer's real ~/.hermes/.env leak into assertions.
    monkeypatch.setattr(web_server, "load_env", lambda: {})
    monkeypatch.setattr(
        web_server, "_GBRAIN_CLIENT", {"key": None, "client": None}
    )
    monkeypatch.setattr(
        web_server, "_DIGEST_CACHE", {"ts": 0.0, "data": None}
    )
    yield


# ---------------------------------------------------------------------------
# _gbrain_env_value — process env first, hermes .env fallback
# ---------------------------------------------------------------------------


class TestGbrainEnvValue:
    def test_process_env_wins(self, monkeypatch):
        monkeypatch.setenv("GBRAIN_SERVE_URL", "http://127.0.0.1:9999")
        monkeypatch.setattr(
            web_server, "load_env", lambda: {"GBRAIN_SERVE_URL": "http://env-file"}
        )
        assert web_server._gbrain_env_value("GBRAIN_SERVE_URL") == "http://127.0.0.1:9999"

    def test_env_file_fallback(self, monkeypatch):
        monkeypatch.setattr(
            web_server, "load_env", lambda: {"GBRAIN_DASHBOARD_CLIENT_ID": "dash-id"}
        )
        assert web_server._gbrain_env_value("GBRAIN_DASHBOARD_CLIENT_ID") == "dash-id"

    def test_default_when_unset(self):
        assert web_server._gbrain_env_value("GBRAIN_SERVE_URL", "dflt") == "dflt"

    def test_load_env_failure_is_swallowed(self, monkeypatch):
        def boom():
            raise RuntimeError("corrupt .env")

        monkeypatch.setattr(web_server, "load_env", boom)
        assert web_server._gbrain_env_value("GBRAIN_HOME", "d") == "d"


# ---------------------------------------------------------------------------
# _gbrain_subprocess_env — the GBRAIN_HOME bug fix for CLI shell-outs
# ---------------------------------------------------------------------------


class TestGbrainSubprocessEnv:
    def test_passes_gbrain_home_and_db_url_through(self, monkeypatch):
        monkeypatch.setenv("GBRAIN_HOME", "/srv/brainhome")
        monkeypatch.setattr(
            web_server, "load_env",
            lambda: {"GBRAIN_DATABASE_URL": "postgres://u:p@h/db"},
        )
        env = web_server._gbrain_subprocess_env()
        assert env["GBRAIN_HOME"] == "/srv/brainhome"
        assert env["GBRAIN_DATABASE_URL"] == "postgres://u:p@h/db"

    def test_hermesbox_appliance_default(self, monkeypatch, tmp_path):
        (tmp_path / ".hermesbox" / ".gbrain").mkdir(parents=True)
        monkeypatch.setattr(web_server.Path, "home", classmethod(lambda cls: tmp_path))
        env = web_server._gbrain_subprocess_env()
        assert env["GBRAIN_HOME"] == str(tmp_path / ".hermesbox")

    def test_no_default_without_appliance_layout(self, monkeypatch, tmp_path):
        monkeypatch.setattr(web_server.Path, "home", classmethod(lambda cls: tmp_path))
        env = web_server._gbrain_subprocess_env()
        assert "GBRAIN_HOME" not in env

    def test_explicit_home_beats_appliance_default(self, monkeypatch, tmp_path):
        (tmp_path / ".hermesbox" / ".gbrain").mkdir(parents=True)
        monkeypatch.setattr(web_server.Path, "home", classmethod(lambda cls: tmp_path))
        monkeypatch.setenv("GBRAIN_HOME", "/explicit")
        env = web_server._gbrain_subprocess_env()
        assert env["GBRAIN_HOME"] == "/explicit"


# ---------------------------------------------------------------------------
# _GbrainDaemonClient — fallback MCP-over-HTTP client (transport mocked)
# ---------------------------------------------------------------------------


def _envelope(payload, *, is_error=False):
    return json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "result": {
            "isError": is_error,
            "content": [{"type": "text", "text": json.dumps(payload)}],
        },
    }).encode()


def _make_client(responses):
    """Client whose _request pops canned (status, headers, body) tuples."""
    client = web_server._GbrainDaemonClient(
        "http://127.0.0.1:3131", client_id="cid", client_secret="sec"
    )
    calls = []

    def fake_request(url, *, data=None, headers=None, method="POST", timeout=None):
        calls.append({"url": url, "data": data, "headers": headers or {},
                      "method": method})
        return responses.pop(0)

    client._request = fake_request
    return client, calls


DISCOVERY = (200, {}, json.dumps(
    {"token_endpoint": "http://127.0.0.1:3131/token"}).encode())
TOKEN = (200, {}, json.dumps(
    {"access_token": "tok-1", "expires_in": 3600}).encode())


class TestGbrainDaemonClient:
    def test_oauth_then_tools_call(self):
        client, calls = _make_client([
            DISCOVERY, TOKEN,
            (200, {"Content-Type": "application/json"}, _envelope([{"slug": "a"}])),
        ])
        out = client.call_tool("get_recent_salience", {"days": 14, "limit": 10})
        assert out == [{"slug": "a"}]
        assert calls[0]["url"].endswith("/.well-known/oauth-authorization-server")
        assert calls[1]["url"] == "http://127.0.0.1:3131/token"
        assert calls[2]["url"] == "http://127.0.0.1:3131/mcp"
        assert calls[2]["headers"]["Authorization"] == "Bearer tok-1"
        rpc = json.loads(calls[2]["data"].decode())
        assert rpc["method"] == "tools/call"
        assert rpc["params"] == {
            "name": "get_recent_salience",
            "arguments": {"days": 14, "limit": 10},
        }

    def test_refreshes_token_once_on_401(self):
        token2 = (200, {}, json.dumps(
            {"access_token": "tok-2", "expires_in": 3600}).encode())
        client, calls = _make_client([
            DISCOVERY, TOKEN,
            (401, {}, b""),
            token2,
            (200, {"Content-Type": "application/json"}, _envelope({"ok": True})),
        ])
        assert client.call_tool("query", {"query": "x"}) == {"ok": True}
        assert calls[-1]["headers"]["Authorization"] == "Bearer tok-2"

    def test_parses_sse_body(self):
        sse = (
            b"event: message\n"
            b"data: " + _envelope([{"slug": "s", "chunk_text": "t"}]) + b"\n\n"
        )
        client, _ = _make_client([
            DISCOVERY, TOKEN,
            (200, {"Content-Type": "text/event-stream"}, sse),
        ])
        assert client.call_tool("query", {"query": "x"}) == [
            {"slug": "s", "chunk_text": "t"}
        ]

    def test_tool_error_raises(self):
        client, _ = _make_client([
            DISCOVERY, TOKEN,
            (200, {"Content-Type": "application/json"},
             _envelope("boom", is_error=True)),
        ])
        with pytest.raises(RuntimeError):
            client.call_tool("find_anomalies", {})

    def test_missing_creds_raise(self):
        client = web_server._GbrainDaemonClient("http://127.0.0.1:3131")
        with pytest.raises(RuntimeError):
            client.call_tool("query", {"query": "x"})


# ---------------------------------------------------------------------------
# _get_gbrain_client / _gbrain_op
# ---------------------------------------------------------------------------


class TestGetGbrainClient:
    def test_none_without_dashboard_creds(self):
        assert web_server._get_gbrain_client() is None

    def test_builds_and_caches_with_creds(self, monkeypatch):
        monkeypatch.setenv("GBRAIN_DASHBOARD_CLIENT_ID", "cid")
        monkeypatch.setenv("GBRAIN_DASHBOARD_CLIENT_SECRET", "sec")
        c1 = web_server._get_gbrain_client()
        assert c1 is not None
        assert c1.base_url == "http://127.0.0.1:3131"  # default serve URL
        assert web_server._get_gbrain_client() is c1  # cached

    def test_rebuilds_when_settings_change(self, monkeypatch):
        monkeypatch.setenv("GBRAIN_DASHBOARD_CLIENT_ID", "cid")
        monkeypatch.setenv("GBRAIN_DASHBOARD_CLIENT_SECRET", "sec")
        c1 = web_server._get_gbrain_client()
        monkeypatch.setenv("GBRAIN_SERVE_URL", "http://127.0.0.1:4444")
        c2 = web_server._get_gbrain_client()
        assert c2 is not c1
        assert c2.base_url == "http://127.0.0.1:4444"


class TestGbrainOp:
    def test_none_when_unconfigured(self):
        assert web_server._gbrain_op("query", {"query": "x"}) is None

    def test_returns_payload(self, monkeypatch):
        class Stub:
            def call_tool(self, name, arguments, *, timeout=None):
                assert name == "find_anomalies"
                assert arguments == {}
                return [{"cohort": "daily"}]

        monkeypatch.setattr(web_server, "_get_gbrain_client", lambda: Stub())
        assert web_server._gbrain_op("find_anomalies", {}) == [{"cohort": "daily"}]

    def test_swallows_client_errors(self, monkeypatch):
        class Stub:
            def call_tool(self, name, arguments, *, timeout=None):
                raise RuntimeError("daemon down")

        monkeypatch.setattr(web_server, "_get_gbrain_client", lambda: Stub())
        assert web_server._gbrain_op("query", {"query": "x"}) is None


# ---------------------------------------------------------------------------
# _gbrain_highlights_from_query — structured results, no text scraping
# ---------------------------------------------------------------------------


class TestHighlightsFromQuery:
    def test_builds_bullets_from_search_results(self):
        payload = [
            {"slug": "meetings/2026-06-01-zephyr-kickoff",
             "chunk_text": "Kickoff agreed on Q3 scope.", "score": 0.36},
            {"slug": "ops/risks", "chunk_text": "  Two   open risks. "},
        ]
        bullets = web_server._gbrain_highlights_from_query(payload)
        assert bullets == [
            "  • 2026-06-01-zephyr-kickoff: Kickoff agreed on Q3 scope.",
            "  • risks: Two open risks.",
        ]

    def test_truncates_long_snippets(self):
        payload = [{"slug": "a/b", "chunk_text": "x" * 400}]
        (bullet,) = web_server._gbrain_highlights_from_query(payload)
        assert bullet.endswith("…")
        assert len(bullet) <= len("  • b: ") + 160

    def test_accepts_dict_results_wrapper_and_limit(self):
        payload = {"results": [{"slug": f"p/{i}", "chunk_text": "t"} for i in range(9)]}
        assert len(web_server._gbrain_highlights_from_query(payload, limit=3)) == 3

    def test_garbage_payloads_yield_empty(self):
        assert web_server._gbrain_highlights_from_query(None) == []
        assert web_server._gbrain_highlights_from_query("No results.") == []
        assert web_server._gbrain_highlights_from_query({"text": "x"}) == []
        assert web_server._gbrain_highlights_from_query([42, {"score": 1}]) == []


# ---------------------------------------------------------------------------
# _read_latest_digest — assembly, degradation, cache
# ---------------------------------------------------------------------------


def _fake_ops(monkeypatch, table):
    calls = []

    def fake_op(name, arguments):
        calls.append((name, arguments))
        return table.get(name)

    monkeypatch.setattr(web_server, "_gbrain_op", fake_op)
    return calls


class TestReadLatestDigest:
    def test_assembles_all_sections_from_daemon_ops(self, monkeypatch):
        calls = _fake_ops(monkeypatch, {
            "get_recent_salience": [
                {"title": "Zephyr kickoff", "type": "meeting",
                 "updated_at": "2026-06-08T10:00:00Z"},
            ],
            "find_anomalies": [{"explanation": "capture volume spiked 4x"}],
            "query": [{"slug": "ops/follow-ups", "chunk_text": "Ping vendor."}],
        })
        digest = web_server._read_latest_digest()
        assert digest["source"] == "gbrain"
        md = digest["markdown"]
        assert "RECENT & NOTABLE" in md
        assert "Zephyr kickoff" in md
        assert "HIGHLIGHTS" in md
        assert "follow-ups: Ping vendor." in md
        assert "WHAT STOOD OUT" in md
        assert "capture volume spiked 4x" in md
        assert ("get_recent_salience", {"days": 14, "limit": 10}) in calls
        assert ("find_anomalies", {}) in calls
        query_calls = [a for n, a in calls if n == "query"]
        assert query_calls == [{
            "query": "most important open items, decisions, risks, and follow-ups",
            "limit": 5,
            "detail": "low",
        }]

    def test_digest_query_env_override(self, monkeypatch):
        monkeypatch.setenv("GBRAIN_DIGEST_QUERY", "what changed today")
        calls = _fake_ops(monkeypatch, {})
        web_server._read_latest_digest()
        assert ("query", {"query": "what changed today", "limit": 5,
                          "detail": "low"}) in calls

    def test_total_failure_yields_empty_shape(self, monkeypatch):
        _fake_ops(monkeypatch, {})  # every op -> None
        digest = web_server._read_latest_digest()
        assert digest["markdown"] is None
        assert digest["generated_at"] is None
        assert digest["source"] == "gbrain"

    def test_partial_failure_contributes_remaining_sections(self, monkeypatch):
        _fake_ops(monkeypatch, {
            "get_recent_salience": [{"title": "Only salience"}],
        })
        md = web_server._read_latest_digest()["markdown"]
        assert "Only salience" in md
        assert "WHAT STOOD OUT" not in md
        assert "HIGHLIGHTS" not in md

    def test_cache_hit_skips_daemon(self, monkeypatch):
        calls = _fake_ops(monkeypatch, {
            "get_recent_salience": [{"title": "t"}],
        })
        first = web_server._read_latest_digest()
        n = len(calls)
        assert web_server._read_latest_digest() is first
        assert len(calls) == n  # no further daemon calls within TTL

    def test_cache_expires_after_ttl(self, monkeypatch):
        calls = _fake_ops(monkeypatch, {})
        web_server._read_latest_digest()
        n = len(calls)
        web_server._DIGEST_CACHE["ts"] -= web_server._DIGEST_TTL_SECONDS + 1
        web_server._read_latest_digest()
        assert len(calls) > n
