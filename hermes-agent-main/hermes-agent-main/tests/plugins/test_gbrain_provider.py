"""Unit tests for the gbrain memory provider (all HTTP/subprocess mocked).

Covers the Phase 1 plan's 5 cases:
  1. Discovery via load_memory_provider("gbrain") + ABC surface
  2. prefetch budget truncation (word-safe) and ""-on-error/timeout
  3. Write gate: cron context blocks writes; primary + readOnly:false writes
  4. No pre-wrapped <memory-context> fences in prefetch output
  5. is_available() env semantics, no network I/O

Phase 2 additions:
  6. Snippet prefetch: content snippets with [source/slug] page refs
     (query-op hits carry chunk_text — never bare paths again)
  7. Entity-source scoping via memory.gbrain.source (query source_id,
     capture routing; unset = combined / no filter)
  8. World-visible writes (visibility: world frontmatter on every capture)
  9. Per-context credential env-name selection (cron/dashboard prefixes)
"""

import json
import socket
import time

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

    def __init__(self, recall_payload="", recall_exc=None, recall_delay=0.0):
        self.recall_payload = recall_payload
        self.recall_exc = recall_exc
        self.recall_delay = recall_delay
        self.recall_calls = []
        self.capture_calls = []
        self.forget_calls = []

    def recall(self, query, *, limit=5, source=None, timeout=None,
               cli_fallback=None):
        self.recall_calls.append(
            {"query": query, "limit": limit, "source": source,
             "cli_fallback": cli_fallback}
        )
        if self.recall_exc:
            raise self.recall_exc
        if self.recall_delay:
            time.sleep(self.recall_delay)
        return self.recall_payload

    def capture(self, text, *, tags=None, slug=None, source=None,
                visibility=None, timeout=None):
        self.capture_calls.append({"text": text, "tags": tags, "slug": slug,
                                   "source": source, "visibility": visibility})
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


def test_prefetch_wall_clock_bounded(monkeypatch, tmp_path):
    """A slow recall (token mint, slow daemon) can't hold the turn past
    PREFETCH_TIMEOUT — prefetch returns "" and the late result is cached
    for the next turn."""
    monkeypatch.setattr(gbrain_mod, "PREFETCH_TIMEOUT", 0.2)
    client = FakeClient(recall_payload="slow result", recall_delay=0.8)
    p = _make_provider(monkeypatch, tmp_path, client=client)
    start = time.monotonic()
    assert p.prefetch("needs recall", session_id="s1") == ""
    assert time.monotonic() - start < 0.6
    # the worker finishes off-path and deposits into the cache
    p._prefetch_thread.join(timeout=5.0)
    assert p.prefetch("next turn", session_id="s1") == "slow result"
    assert len(client.recall_calls) == 1  # second prefetch was a cache hit


def test_prefetch_never_spawns_cli(monkeypatch, tmp_path):
    """A server refusal on the prefetch path must NOT fall back to the
    bun CLI subprocess (kept only for explicit tool calls)."""
    import plugins.memory.gbrain.client as client_mod

    def fake_request(self, url, *, data=None, headers=None, method="POST",
                     timeout=None):
        return 200, {"Content-Type": "application/json"}, json.dumps({
            "jsonrpc": "2.0", "id": 1,
            "error": {"code": -32601, "message": "unknown_operation: query"},
        }).encode()

    cli_calls = []

    class FakeProc:
        returncode = 0
        stdout = json.dumps({"results": [{"text": "cli result"}]})
        stderr = ""

    def fake_run(cmd, **kwargs):
        cli_calls.append(cmd)
        return FakeProc()

    monkeypatch.setattr(GbrainClient, "_request", fake_request)
    monkeypatch.setattr(client_mod.subprocess, "run", fake_run)
    real_client = GbrainClient("http://127.0.0.1:3131", static_token="t")
    p = _make_provider(monkeypatch, tmp_path, client=real_client)
    assert p.prefetch("query about things") == ""
    if p._prefetch_thread:
        p._prefetch_thread.join(timeout=5.0)
    p.queue_prefetch("warm me up")
    if p._prefetch_thread:
        p._prefetch_thread.join(timeout=5.0)
    assert cli_calls == []  # no subprocess on either recall path


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


# ---------------------------------------------------------------------------
# 6. Phase 2 — snippet prefetch: content + page refs, never bare paths
# ---------------------------------------------------------------------------

def test_format_recall_results_reads_chunk_text():
    """The gbrain query op returns SearchResult dicts whose content lives
    in chunk_text (no text/content/snippet key) — pre-fix these degraded
    to a bare slug like 'inbox/2026-06-11-...'."""
    payload = [{"slug": "inbox/2026-06-11-abcd1234",
                "title": "note", "chunk_text": "the actual page content",
                "score": 0.83, "page_id": 7}]
    out = _format_recall_results(payload)
    assert out == "[inbox/2026-06-11-abcd1234] the actual page content"


def test_format_recall_results_ref_includes_source():
    payload = [{"slug": "notes/deploy", "source_id": "umb",
                "chunk_text": "deploy runbook"}]
    assert _format_recall_results(payload) == "[umb/notes/deploy] deploy runbook"


def test_format_recall_results_snippet_budget_split():
    """With a snippet budget every hit contributes a word-safe snippet —
    the first hit must not swallow the whole window."""
    items = [
        {"slug": f"p/{i}", "chunk_text": " ".join(f"w{i}x{j}" for j in range(80))}
        for i in range(4)
    ]
    out = _format_recall_results(items, snippet_budget=400)
    parts = out.split("\n\n")
    assert len(parts) == 4
    for i, part in enumerate(parts):
        ref = f"[p/{i}] "
        assert part.startswith(ref)
        # per-item snippet is word-safe truncated to budget // n_items
        assert len(part) <= len(ref) + 100
        assert part.endswith("…")


def test_prefetch_returns_budgeted_snippets_with_refs(monkeypatch, tmp_path):
    payload = [
        {"slug": "notes/deploy", "source_id": "umb", "score": 0.9,
         "chunk_text": "deploy facts " * 40},
        {"slug": "inbox/2026-06-11-abcd1234", "source_id": "umb", "score": 0.5,
         "chunk_text": "inbox content body " * 40},
    ]
    p = _make_provider(
        monkeypatch, tmp_path,
        config={"contextChars": 300},
        client=FakeClient(recall_payload=payload),
    )
    out = p.prefetch("deploys?")
    assert out.startswith("[umb/notes/deploy] deploy facts")
    assert "[umb/inbox/2026-06-11-abcd1234] inbox content body" in out
    assert len(out) <= 300  # still truncated to contextChars total


# ---------------------------------------------------------------------------
# 7. Phase 2 — entity-source scoping (memory.gbrain.source)
# ---------------------------------------------------------------------------

def test_source_config_scopes_recall_and_captures(monkeypatch, tmp_path):
    client = FakeClient(recall_payload="hit")
    p = _make_provider(
        monkeypatch, tmp_path,
        config={"readOnly": False, "source": "umb"},
        client=client,
    )
    assert p.prefetch("anything relevant?") == "hit"
    json.loads(p.handle_tool_call("gbrain_recall", {"query": "q"}))
    assert [c["source"] for c in client.recall_calls] == ["umb", "umb"]

    p.handle_tool_call("gbrain_capture", {"text": "note"})
    p.on_session_end([{"role": "user", "content": "hi"}])
    p.on_pre_compress([{"role": "user", "content": "hi"}])
    assert len(client.capture_calls) == 3
    assert all(c["source"] == "umb" for c in client.capture_calls)


def test_source_unset_means_combined_no_filter(monkeypatch, tmp_path):
    client = FakeClient(recall_payload="hit")
    p = _make_provider(monkeypatch, tmp_path,
                       config={"readOnly": False}, client=client)
    p.prefetch("anything relevant?")
    p.handle_tool_call("gbrain_capture", {"text": "note"})
    assert client.recall_calls[0]["source"] is None
    assert client.capture_calls[0]["source"] is None


def test_client_recall_passes_source_id_arg(monkeypatch):
    sent = []

    def fake_request(self, url, *, data=None, headers=None, method="POST",
                     timeout=None):
        body = json.loads(data.decode()) if data else {}
        if body.get("method") == "tools/call":
            sent.append(body["params"])
        return 200, {"Content-Type": "application/json"}, _mcp_envelope(
            [{"slug": "a", "chunk_text": "x"}])

    monkeypatch.setattr(GbrainClient, "_request", fake_request)
    c = GbrainClient("http://127.0.0.1:3131", static_token="t")
    c.recall("q", source="umb")
    assert sent[-1]["name"] == "query"
    assert sent[-1]["arguments"]["source_id"] == "umb"
    c.recall("q")  # unset → no per-call source filter on the wire
    assert "source_id" not in sent[-1]["arguments"]


def test_client_cli_capture_fallback_passes_source(monkeypatch):
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
    c.capture("note body", slug="inbox/hermes/s1", source="umb",
              visibility="world")
    cmd = cli_calls["cmd"]
    assert cmd[cmd.index("--source") + 1] == "umb"
    assert "visibility: world" in cli_calls["kwargs"]["input"]


# ---------------------------------------------------------------------------
# 8. Phase 2 — world-visible writes
# ---------------------------------------------------------------------------

def test_all_write_paths_are_world_visible(monkeypatch, tmp_path):
    client = FakeClient()
    p = _make_provider(monkeypatch, tmp_path, agent_context="primary",
                       config={"readOnly": False}, client=client)
    p.handle_tool_call("gbrain_capture", {"text": "note"})
    p.on_session_end([{"role": "user", "content": "hi"}])
    p.on_pre_compress([{"role": "user", "content": "hi"}])
    assert len(client.capture_calls) == 3
    assert all(c["visibility"] == "world" for c in client.capture_calls)


def test_client_capture_writes_world_visibility_frontmatter(monkeypatch):
    sent = []

    def fake_request(self, url, *, data=None, headers=None, method="POST",
                     timeout=None):
        body = json.loads(data.decode()) if data else {}
        if body.get("method") == "tools/call":
            sent.append(body["params"])
        return 200, {"Content-Type": "application/json"}, _mcp_envelope(
            {"ok": True})

    monkeypatch.setattr(GbrainClient, "_request", fake_request)
    c = GbrainClient("http://127.0.0.1:3131", static_token="t")
    slug = c.capture("remember this", tags=["a"],
                     slug="hermes/sessions/2026-06-10-zz",
                     source="umb", visibility="world")
    assert slug == "hermes/sessions/2026-06-10-zz"
    assert sent[-1]["name"] == "put_page"
    args = sent[-1]["arguments"]
    assert args["slug"] == slug
    content = args["content"]
    assert content.startswith("---\n")
    assert "\nvisibility: world\n" in content
    # put_page has no per-call source param — the entity is recorded as a
    # source:<slug> tag so attribution survives on broader-scoped tokens.
    assert '"source:umb"' in content
    assert "remember this" in content


# ---------------------------------------------------------------------------
# 9. Phase 2 — per-context credential env-name selection
# ---------------------------------------------------------------------------

_CRED_VARS = [
    "GBRAIN_CLIENT_ID", "GBRAIN_CLIENT_SECRET", "GBRAIN_API_TOKEN",
    "GBRAIN_CRON_CLIENT_ID", "GBRAIN_CRON_CLIENT_SECRET",
    "GBRAIN_CRON_API_TOKEN",
    "GBRAIN_DASHBOARD_CLIENT_ID", "GBRAIN_DASHBOARD_CLIENT_SECRET",
    "GBRAIN_DASHBOARD_API_TOKEN",
]


def _init_real_client_provider(monkeypatch, *, agent_context="primary",
                               platform="cli", env=None):
    for var in _CRED_VARS:
        monkeypatch.delenv(var, raising=False)
    for var, value in (env or {}).items():
        monkeypatch.setenv(var, value)
    monkeypatch.setenv("GBRAIN_SERVE_URL", "http://127.0.0.1:3131")
    monkeypatch.setattr(gbrain_mod, "_read_provider_config", lambda: {})
    p = GbrainMemoryProvider()
    p.initialize("session-1", hermes_home="/tmp", platform=platform,
                 agent_context=agent_context)
    assert isinstance(p._client, GbrainClient)
    return p


def test_creds_cron_context_prefers_cron_env(monkeypatch):
    p = _init_real_client_provider(
        monkeypatch, agent_context="cron", platform="cron",
        env={"GBRAIN_CLIENT_ID": "canon-id",
             "GBRAIN_CLIENT_SECRET": "canon-sec",
             "GBRAIN_CRON_CLIENT_ID": "cron-id",
             "GBRAIN_CRON_CLIENT_SECRET": "cron-sec"},
    )
    assert p._client._client_id == "cron-id"
    assert p._client._client_secret == "cron-sec"


def test_creds_dashboard_selected_via_platform(monkeypatch):
    p = _init_real_client_provider(
        monkeypatch, agent_context="primary", platform="dashboard",
        env={"GBRAIN_CLIENT_ID": "canon-id",
             "GBRAIN_CLIENT_SECRET": "canon-sec",
             "GBRAIN_DASHBOARD_CLIENT_ID": "dash-id",
             "GBRAIN_DASHBOARD_CLIENT_SECRET": "dash-sec"},
    )
    assert p._client._client_id == "dash-id"
    assert p._client._client_secret == "dash-sec"


def test_creds_primary_uses_canonical_even_with_overrides_set(monkeypatch):
    p = _init_real_client_provider(
        monkeypatch, agent_context="primary", platform="cli",
        env={"GBRAIN_CLIENT_ID": "canon-id",
             "GBRAIN_CLIENT_SECRET": "canon-sec",
             "GBRAIN_CRON_CLIENT_ID": "cron-id",
             "GBRAIN_CRON_CLIENT_SECRET": "cron-sec"},
    )
    assert p._client._client_id == "canon-id"
    assert p._client._client_secret == "canon-sec"


def test_creds_incomplete_override_falls_back_to_canonical(monkeypatch):
    # cron id without a secret is incomplete — canonical pair wins
    p = _init_real_client_provider(
        monkeypatch, agent_context="cron", platform="cron",
        env={"GBRAIN_CLIENT_ID": "canon-id",
             "GBRAIN_CLIENT_SECRET": "canon-sec",
             "GBRAIN_CRON_CLIENT_ID": "cron-id"},
    )
    assert p._client._client_id == "canon-id"
    assert p._client._client_secret == "canon-sec"


def test_creds_context_static_token_override(monkeypatch):
    p = _init_real_client_provider(
        monkeypatch, agent_context="cron", platform="cron",
        env={"GBRAIN_CLIENT_ID": "canon-id",
             "GBRAIN_CLIENT_SECRET": "canon-sec",
             "GBRAIN_CRON_API_TOKEN": "cron-token"},
    )
    assert p._client._static_token == "cron-token"
