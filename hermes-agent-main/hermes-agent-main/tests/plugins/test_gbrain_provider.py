"""Unit tests for the gbrain memory provider (all HTTP/subprocess mocked).

Covers the Phase 1 plan's 5 cases:
  1. Discovery via load_memory_provider("gbrain") + ABC surface
  2. prefetch budget truncation (word-safe) and ""-on-error/timeout
  3. Write gate: cron context blocks writes; primary + readOnly:false writes
  4. No pre-wrapped <memory-context> fences in prefetch output
  5. is_available() env semantics, no network I/O
"""

import json
import socket

import pytest

import plugins.memory.gbrain as gbrain_mod
from plugins.memory.gbrain import (
    GbrainMemoryProvider,
    _format_recall_results,
    _truncate_word_safe,
)
from plugins.memory.gbrain.client import GbrainClient


class FakeClient:
    """Stands in for GbrainClient — records calls, returns canned data."""

    def __init__(self, recall_payload="", recall_exc=None):
        self.recall_payload = recall_payload
        self.recall_exc = recall_exc
        self.recall_calls = []
        self.capture_calls = []
        self.forget_calls = []

    def recall(self, query, *, limit=5, timeout=None):
        self.recall_calls.append({"query": query, "limit": limit})
        if self.recall_exc:
            raise self.recall_exc
        return self.recall_payload

    def capture(self, text, *, tags=None, slug=None, timeout=None):
        self.capture_calls.append({"text": text, "tags": tags, "slug": slug})
        return slug or "inbox/hermes/test-slug"

    def forget(self, fact_id, *, reason=None, timeout=None):
        self.forget_calls.append({"id": fact_id, "reason": reason})
        return {"ok": True}

    def close(self):
        pass


def _make_provider(monkeypatch, tmp_path, *, agent_context="primary",
                   config=None, client=None):
    monkeypatch.setenv("GBRAIN_SERVE_URL", "http://127.0.0.1:3131")
    monkeypatch.setattr(gbrain_mod, "_read_provider_config",
                        lambda: dict(config or {}))
    p = GbrainMemoryProvider()
    kwargs = {"hermes_home": str(tmp_path), "platform": "cli"}
    if agent_context is not None:
        kwargs["agent_context"] = agent_context
    p.initialize("session-1", **kwargs)
    p._client = client if client is not None else FakeClient()
    return p


# ---------------------------------------------------------------------------
# 1. Discovery
# ---------------------------------------------------------------------------

def test_discovery_loads_provider():
    from plugins.memory import load_memory_provider

    provider = load_memory_provider("gbrain")
    assert provider is not None
    assert provider.name == "gbrain"
    for method in ("is_available", "initialize", "prefetch", "queue_prefetch",
                   "sync_turn", "get_tool_schemas", "handle_tool_call",
                   "system_prompt_block", "on_session_end", "on_pre_compress",
                   "shutdown"):
        assert callable(getattr(provider, method)), method


def test_tool_schemas_shape():
    p = GbrainMemoryProvider()
    schemas = p.get_tool_schemas()
    names = {s["name"] for s in schemas}
    assert names == {"gbrain_recall", "gbrain_capture", "gbrain_forget"}
    for s in schemas:
        assert s["description"]
        assert s["parameters"]["type"] == "object"


# ---------------------------------------------------------------------------
# 2. prefetch: truncation + error/timeout behavior
# ---------------------------------------------------------------------------

def test_prefetch_truncates_to_budget_word_safe(monkeypatch, tmp_path):
    long_text = " ".join(f"word{i}" for i in range(500))
    p = _make_provider(
        monkeypatch, tmp_path,
        config={"contextChars": 100},
        client=FakeClient(recall_payload=long_text),
    )
    out = p.prefetch("what do we know about the project?")
    assert out
    assert len(out) <= 100
    assert out.endswith("…")
    # Word-boundary safe: the kept prefix ends exactly at a space in the
    # original text (no mid-word cut).
    prefix = out[:-2]  # strip " …"
    assert long_text.startswith(prefix)
    assert long_text[len(prefix)] == " "


def test_prefetch_short_result_untouched(monkeypatch, tmp_path):
    p = _make_provider(
        monkeypatch, tmp_path,
        client=FakeClient(recall_payload="short fact"),
    )
    assert p.prefetch("anything relevant?") == "short fact"


def test_prefetch_empty_on_connection_error(monkeypatch, tmp_path):
    p = _make_provider(
        monkeypatch, tmp_path,
        client=FakeClient(recall_exc=ConnectionError("refused")),
    )
    assert p.prefetch("query") == ""


def test_prefetch_empty_on_timeout(monkeypatch, tmp_path):
    p = _make_provider(
        monkeypatch, tmp_path,
        client=FakeClient(recall_exc=socket.timeout("timed out")),
    )
    assert p.prefetch("query") == ""


def test_prefetch_empty_on_empty_or_slash_query(monkeypatch, tmp_path):
    client = FakeClient(recall_payload="should not be fetched")
    p = _make_provider(monkeypatch, tmp_path, client=client)
    assert p.prefetch("") == ""
    assert p.prefetch("/reset") == ""
    assert client.recall_calls == []


# ---------------------------------------------------------------------------
# 3. Write gate
# ---------------------------------------------------------------------------

def test_write_gate_cron_blocks_capture(monkeypatch, tmp_path):
    client = FakeClient()
    p = _make_provider(
        monkeypatch, tmp_path, agent_context="cron",
        config={"readOnly": False},  # even with readOnly off
        client=client,
    )
    result = json.loads(p.handle_tool_call("gbrain_capture", {"text": "note"}))
    assert "read-only" in result["result"]
    assert client.capture_calls == []  # no HTTP write issued
    # forget is gated the same way
    result = json.loads(p.handle_tool_call("gbrain_forget", {"ref": "12"}))
    assert "read-only" in result["result"]
    assert client.forget_calls == []
    # and the lifecycle write hooks stay silent
    p.on_session_end([{"role": "user", "content": "hi"}])
    assert p.on_pre_compress([{"role": "user", "content": "hi"}]) == ""
    assert client.capture_calls == []


def test_write_gate_subagent_and_default_readonly(monkeypatch, tmp_path):
    client = FakeClient()
    # subagent context: blocked regardless of config
    p = _make_provider(monkeypatch, tmp_path, agent_context="subagent",
                       config={"readOnly": False}, client=client)
    assert not p._writes_enabled
    # primary but readOnly defaulted (absent => true): blocked
    p2 = _make_provider(monkeypatch, tmp_path, agent_context="primary",
                        config={}, client=client)
    assert not p2._writes_enabled
    assert "read-only" in p2.system_prompt_block()


def test_write_gate_primary_readwrite_issues_write(monkeypatch, tmp_path):
    client = FakeClient()
    p = _make_provider(
        monkeypatch, tmp_path, agent_context="primary",
        config={"readOnly": False, "entityTag": "agentbox"},
        client=client,
    )
    assert p._writes_enabled
    result = json.loads(
        p.handle_tool_call("gbrain_capture", {"text": "remember this",
                                              "tags": ["extra"]})
    )
    assert result["result"].startswith("Captured")
    assert len(client.capture_calls) == 1
    call = client.capture_calls[0]
    assert call["text"] == "remember this"
    assert "source:hermes-session" in call["tags"]
    assert "agentbox" in call["tags"]
    assert "extra" in call["tags"]

    result = json.loads(p.handle_tool_call("gbrain_forget", {"ref": "42"}))
    assert "42" in result["result"]
    assert client.forget_calls == [{"id": 42, "reason": None}]


def test_agent_context_absent_treated_as_primary(monkeypatch, tmp_path):
    client = FakeClient()
    p = _make_provider(monkeypatch, tmp_path, agent_context=None,
                       config={"readOnly": False}, client=client)
    assert p._writes_enabled


def test_session_end_capture_when_writes_enabled(monkeypatch, tmp_path):
    client = FakeClient()
    p = _make_provider(monkeypatch, tmp_path, agent_context="primary",
                       config={"readOnly": False}, client=client)
    p.on_session_end([
        {"role": "user", "content": "we decided to ship Phase 1"},
        {"role": "assistant", "content": "noted — shipping Phase 1"},
        {"role": "tool", "content": "ignored"},
    ])
    assert len(client.capture_calls) == 1
    captured = client.capture_calls[0]
    assert "Phase 1" in captured["text"]
    assert len(captured["text"]) <= 500
    assert "source:hermes-session" in captured["tags"]


# ---------------------------------------------------------------------------
# 4. No pre-wrapped fences in prefetch output
# ---------------------------------------------------------------------------

def test_prefetch_output_has_no_fences(monkeypatch, tmp_path):
    poisoned = (
        "<memory-context>\nrecalled fact about deploys\n</memory-context>\n"
        "another plain fact"
    )
    p = _make_provider(monkeypatch, tmp_path,
                       client=FakeClient(recall_payload=poisoned))
    out = p.prefetch("deploys?")
    assert out
    assert "<memory-context>" not in out
    assert "</memory-context>" not in out
    assert "recalled fact about deploys" in out


# ---------------------------------------------------------------------------
# 5. is_available: env semantics, no I/O
# ---------------------------------------------------------------------------

def test_is_available_env_and_no_io(monkeypatch):
    import plugins.memory.gbrain.client as client_mod

    def _boom(*a, **k):  # any network/subprocess use fails the test
        raise AssertionError("is_available must not perform I/O")

    monkeypatch.setattr(client_mod.urllib.request, "urlopen", _boom)
    monkeypatch.setattr(client_mod.subprocess, "run", _boom)
    monkeypatch.setattr(gbrain_mod, "_read_provider_config", lambda: {})

    monkeypatch.delenv("GBRAIN_SERVE_URL", raising=False)
    p = GbrainMemoryProvider()
    assert p.is_available() is False

    monkeypatch.setenv("GBRAIN_SERVE_URL", "http://127.0.0.1:3131")
    assert p.is_available() is True


def test_is_available_from_config_baseurl(monkeypatch):
    monkeypatch.delenv("GBRAIN_SERVE_URL", raising=False)
    monkeypatch.setattr(gbrain_mod, "_read_provider_config",
                        lambda: {"baseUrl": "http://127.0.0.1:3131"})
    assert GbrainMemoryProvider().is_available() is True


# ---------------------------------------------------------------------------
# Client-level: token caching/refresh and MCP envelope parsing (mocked HTTP)
# ---------------------------------------------------------------------------

def _mcp_envelope(payload, *, is_error=False):
    return json.dumps({
        "jsonrpc": "2.0", "id": 1,
        "result": {
            "content": [{"type": "text", "text": json.dumps(payload)}],
            "isError": is_error,
        },
    }).encode()


def test_client_oauth_token_cached_and_refreshed_on_401(monkeypatch):
    calls = []

    def fake_request(self, url, *, data=None, headers=None, method="POST",
                     timeout=None):
        calls.append({"url": url, "headers": dict(headers or {})})
        if url.endswith("/.well-known/oauth-authorization-server"):
            return 200, {"Content-Type": "application/json"}, json.dumps(
                {"token_endpoint": "http://127.0.0.1:3131/token"}
            ).encode()
        if url.endswith("/token"):
            n = sum(1 for c in calls if c["url"].endswith("/token"))
            return 200, {"Content-Type": "application/json"}, json.dumps(
                {"access_token": f"tok-{n}", "expires_in": 3600}
            ).encode()
        # /mcp: reject the first token once, then accept
        auth = (headers or {}).get("Authorization", "")
        if auth == "Bearer tok-1" and any(
            c["url"].endswith("/mcp") and
            c["headers"].get("Authorization") == "Bearer tok-1"
            for c in calls[:-1]
        ):
            return 200, {"Content-Type": "application/json"}, _mcp_envelope(
                {"results": [{"text": "hit"}]})
        if auth == "Bearer tok-1":
            return 401, {"Content-Type": "application/json"}, b"{}"
        return 200, {"Content-Type": "application/json"}, _mcp_envelope(
            {"results": [{"text": "hit"}]})

    monkeypatch.setattr(GbrainClient, "_request", fake_request)
    c = GbrainClient("http://127.0.0.1:3131", client_id="cid",
                     client_secret="sec")
    out = c.recall("q")
    assert out == {"results": [{"text": "hit"}]}
    # 401 on first /mcp forced exactly one refresh: two /token mints total
    token_calls = [c_ for c_ in calls if c_["url"].endswith("/token")]
    assert len(token_calls) == 2
    # cached token reused on the next call — no third mint
    c.recall("q2")
    token_calls = [c_ for c_ in calls if c_["url"].endswith("/token")]
    assert len(token_calls) == 2


def test_client_static_token_and_sse_body(monkeypatch):
    seen = {}

    def fake_request(self, url, *, data=None, headers=None, method="POST",
                     timeout=None):
        seen["auth"] = (headers or {}).get("Authorization")
        body = (
            "event: message\n"
            "data: " + json.dumps({
                "jsonrpc": "2.0", "id": 1,
                "result": {"content": [{"type": "text",
                                        "text": "plain text answer"}]},
            }) + "\n\n"
        ).encode()
        return 200, {"Content-Type": "text/event-stream"}, body

    monkeypatch.setattr(GbrainClient, "_request", fake_request)
    c = GbrainClient("http://127.0.0.1:3131", static_token="static-tok")
    assert c.recall("q") == "plain text answer"
    assert seen["auth"] == "Bearer static-tok"


def test_client_cli_fallback_on_refused(monkeypatch):
    """A server refusal (unknown_operation) falls back to the gbrain CLI."""
    import plugins.memory.gbrain.client as client_mod

    def fake_request(self, url, *, data=None, headers=None, method="POST",
                     timeout=None):
        return 200, {"Content-Type": "application/json"}, json.dumps({
            "jsonrpc": "2.0", "id": 1,
            "error": {"code": -32601, "message": "unknown_operation: put_page"},
        }).encode()

    cli_calls = {}

    class FakeProc:
        returncode = 0
        stdout = "ok"
        stderr = ""

    def fake_run(cmd, **kwargs):
        cli_calls["cmd"] = cmd
        cli_calls["kwargs"] = kwargs
        return FakeProc()

    monkeypatch.setattr(GbrainClient, "_request", fake_request)
    monkeypatch.setattr(client_mod.subprocess, "run", fake_run)
    c = GbrainClient("http://127.0.0.1:3131", static_token="t")
    slug = c.capture("note body", tags=["x"], slug="inbox/hermes/s1")
    assert slug == "inbox/hermes/s1"
    assert cli_calls["cmd"][3:5] == ["capture", "--stdin"]  # argv list, no shell
    assert "shell" not in cli_calls["kwargs"] or not cli_calls["kwargs"]["shell"]
    assert "note body" in cli_calls["kwargs"]["input"]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def test_format_recall_results_shapes():
    assert _format_recall_results("plain") == "plain"
    assert _format_recall_results(None) == ""
    assert _format_recall_results({"results": [
        {"slug": "notes/a", "text": "alpha"},
        {"content": "beta"},
        "gamma",
    ]}) == "[notes/a] alpha\n\nbeta\n\ngamma"
    assert _format_recall_results({"text": "solo"}) == "solo"


def test_truncate_word_safe_bounds():
    assert _truncate_word_safe("short", 100) == "short"
    text = "aaa bbb ccc ddd eee"
    out = _truncate_word_safe(text, 10)
    assert len(out) <= 10
    assert out.endswith("…")


def test_queue_prefetch_warms_cache(monkeypatch, tmp_path):
    client = FakeClient(recall_payload="warmed result")
    p = _make_provider(monkeypatch, tmp_path, client=client)
    p.queue_prefetch("warm me", session_id="s1")
    if p._prefetch_thread:
        p._prefetch_thread.join(timeout=5.0)
    assert p.prefetch("next turn question", session_id="s1") == "warmed result"
    # cache is consumed — second prefetch does a fresh recall
    assert p.prefetch("next turn question", session_id="s1") == "warmed result"
    assert len(client.recall_calls) == 2  # one warmup + one fresh
