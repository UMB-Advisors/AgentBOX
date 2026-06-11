"""gBrain memory plugin — MemoryProvider backed by a local gbrain daemon.

Recall-first integration: every interactive turn gets semantic recall from
the gbrain knowledge graph (``gbrain serve --http``, MCP Streamable HTTP),
budgeted for small local models. Ships read-only by default; the write path
(explicit ``gbrain_capture`` tool + distilled session-end / pre-compress
summaries) is config-gated via ``memory.gbrain.readOnly``.

Write gate (PRD D5): writes are only ever issued when
``agent_context == "primary"`` AND ``readOnly`` is false. ``cron``,
``subagent`` and ``flush`` contexts are read-only regardless of config.

Config (config.yaml):
    memory:
      provider: gbrain
      gbrain:
        baseUrl: http://127.0.0.1:3131   # or env GBRAIN_SERVE_URL
        readOnly: true                   # v1 default
        contextChars: 1200               # ~300 tokens; ~4000 for cloud models
        recallLimit: 5
        entityTag: ""
        source: ""                       # entity source slug; "" = combined

Source scoping: when ``memory.gbrain.source`` is set, recall/prefetch pass
it as the query op's per-call ``source_id`` and captures are routed to it
(CLI fallback ``--source``; remote put_page writes land in the OAuth
token's registered source — register the client with ``--source`` to
match). Unset means no per-call filter (combined view).

Writes are world-visible: every capture (session-end, pre-compress,
gbrain_capture) carries ``visibility: world`` frontmatter so pages and
the facts derived from them stay recallable over HTTP (gbrain filters
remote recall to ``visibility='world'``).

Secrets (.env): GBRAIN_API_TOKEN (static) or GBRAIN_CLIENT_ID +
GBRAIN_CLIENT_SECRET (OAuth client_credentials, ~1h TTL, auto-refreshed).
Per-context overrides: ``cron`` contexts prefer GBRAIN_CRON_CLIENT_ID/
SECRET (or GBRAIN_CRON_API_TOKEN) and ``dashboard`` contexts prefer
GBRAIN_DASHBOARD_* when present; anything else — or an incomplete
override set — falls back to the canonical names above.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from typing import Any, Dict, List, Optional

from agent.memory_manager import sanitize_context
from agent.memory_provider import MemoryProvider
from tools.registry import tool_error

from plugins.memory.gbrain.client import (
    DEFAULT_TIMEOUT,
    GbrainClient,
    default_capture_slug,
)

logger = logging.getLogger(__name__)

DEFAULT_CONTEXT_CHARS = 1200
DEFAULT_RECALL_LIMIT = 5
PREFETCH_TIMEOUT = 3.0          # recall must never block a turn longer
PREFETCH_CACHE_TTL = 600.0      # seconds a queued prefetch result stays fresh
SESSION_SUMMARY_CHARS = 500
MIN_SNIPPET_CHARS = 80          # per-result floor when splitting the budget
CAPTURE_VISIBILITY = "world"    # provider writes must stay HTTP-recallable

# Per-context credential env prefixes (PRD D7): selected by agent_context
# (or platform) at initialize time. Pure env-NAME selection — an absent or
# incomplete override set falls back to the canonical GBRAIN_* names.
CONTEXT_ENV_PREFIXES = {
    "cron": "GBRAIN_CRON",
    "dashboard": "GBRAIN_DASHBOARD",
}

READ_ONLY_MESSAGE = (
    "memory is read-only in this context — nothing was written. "
    "Recall (gbrain_recall) remains available."
)

# Strip any fence markup a backend page might contain — providers must
# return RAW text; the MemoryManager adds the <memory-context> fences.
_FENCE_RE = re.compile(r"</?memory-context>", re.IGNORECASE)

RECALL_SCHEMA = {
    "name": "gbrain_recall",
    "description": (
        "Semantic recall from the gbrain knowledge graph. Returns the most "
        "relevant stored pages/facts for a natural-language query. Use when "
        "you need background knowledge, prior decisions, or saved context "
        "beyond the auto-injected memory block."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Natural-language query to recall against.",
            },
            "limit": {
                "type": "integer",
                "description": "Max results to return (default 5, max 20).",
            },
        },
        "required": ["query"],
    },
}

CAPTURE_SCHEMA = {
    "name": "gbrain_capture",
    "description": (
        "Save a short, durable note into the gbrain knowledge graph. Only "
        "use for information worth remembering across sessions (decisions, "
        "facts, preferences). May be unavailable in read-only contexts."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "text": {
                "type": "string",
                "description": "The note to capture (concise markdown).",
            },
            "tags": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Optional tags for the captured page.",
            },
        },
        "required": ["text"],
    },
}

FORGET_SCHEMA = {
    "name": "gbrain_forget",
    "description": (
        "Expire a gbrain hot-memory fact by its numeric id (as returned in "
        "recall results). Use only when a remembered fact is wrong or the "
        "user asks to forget it. May be unavailable in read-only contexts."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "ref": {
                "type": "string",
                "description": "Numeric fact id to forget.",
            },
            "reason": {
                "type": "string",
                "description": "Optional reason, recorded in the audit log.",
            },
        },
        "required": ["ref"],
    },
}

ALL_TOOL_SCHEMAS = [RECALL_SCHEMA, CAPTURE_SCHEMA, FORGET_SCHEMA]


# ---------------------------------------------------------------------------
# Config helpers
# ---------------------------------------------------------------------------

def _read_provider_config() -> Dict[str, Any]:
    """Return the ``memory.gbrain`` section of config.yaml ({} on any miss)."""
    try:
        from hermes_cli.config import cfg_get, load_config
        cfg = load_config()
        section = cfg_get(cfg, "memory", "gbrain", default={}) or {}
        return section if isinstance(section, dict) else {}
    except Exception:
        return {}


def _resolve_base_url(section: Optional[Dict[str, Any]] = None) -> str:
    env_url = os.environ.get("GBRAIN_SERVE_URL", "").strip()
    if env_url:
        return env_url
    section = section if section is not None else _read_provider_config()
    return str(section.get("baseUrl") or "").strip()


def _select_credentials(agent_context: str = "",
                        platform: str = "") -> Dict[str, Optional[str]]:
    """Pick gbrain credential env NAMES for this execution context.

    ``cron`` → GBRAIN_CRON_*, ``dashboard`` → GBRAIN_DASHBOARD_* (matched
    against agent_context first, then platform). An override is only used
    when complete (CLIENT_ID + CLIENT_SECRET, or API_TOKEN); otherwise the
    canonical GBRAIN_CLIENT_ID / GBRAIN_CLIENT_SECRET / GBRAIN_API_TOKEN
    apply. Pure name selection — no other behavior change.
    """
    prefix = None
    for key in (agent_context, platform):
        prefix = CONTEXT_ENV_PREFIXES.get(str(key or "").strip().lower())
        if prefix:
            break
    if prefix:
        client_id = os.environ.get(f"{prefix}_CLIENT_ID") or None
        client_secret = os.environ.get(f"{prefix}_CLIENT_SECRET") or None
        static_token = os.environ.get(f"{prefix}_API_TOKEN") or None
        if (client_id and client_secret) or static_token:
            return {
                "client_id": client_id,
                "client_secret": client_secret,
                "static_token": static_token,
            }
    return {
        "client_id": os.environ.get("GBRAIN_CLIENT_ID") or None,
        "client_secret": os.environ.get("GBRAIN_CLIENT_SECRET") or None,
        "static_token": os.environ.get("GBRAIN_API_TOKEN") or None,
    }


def _as_bool(value: Any, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _truncate_word_safe(text: str, limit: int) -> str:
    """Truncate to <= limit chars, cutting at a word boundary when possible."""
    if limit <= 0 or len(text) <= limit:
        return text
    ellipsis = " …"
    cut = text[: max(1, limit - len(ellipsis))]
    last_space = cut.rfind(" ")
    if last_space > len(cut) * 0.6:
        cut = cut[:last_space]
    return cut.rstrip() + ellipsis


# Per-item content keys, in preference order. ``chunk_text`` is what the
# gbrain ``query`` op actually returns per hit (SearchResult.chunk_text) —
# without it a hit degraded to its bare slug.
_CONTENT_KEYS = ("text", "content", "chunk_text", "snippet", "summary",
                 "body", "fact")


def _item_ref(item: Dict[str, Any]) -> str:
    """Page reference for a recall hit: ``source/slug`` when both known."""
    slug = str(item.get("slug") or item.get("title") or "").strip()
    source = str(item.get("source_id") or item.get("source") or "").strip()
    if slug and source:
        return f"{source}/{slug}"
    return slug


def _format_recall_results(payload: Any, *, snippet_budget: int = 0) -> str:
    """Flatten a gbrain query/recall payload into plain joined text.

    Each hit renders as ``[source/slug] content`` — content snippets with
    their page refs, never bare paths (unless the daemon returned no
    content at all). With ``snippet_budget`` > 0 the budget is split
    across hits so every result contributes a word-safe snippet instead
    of the first hit swallowing the whole window.
    """
    if payload is None:
        return ""
    if isinstance(payload, str):
        return payload.strip()
    items: List[Any]
    if isinstance(payload, dict):
        items = None
        for key in ("results", "hits", "pages", "facts", "items"):
            value = payload.get(key)
            if isinstance(value, list):
                items = value
                break
        if items is None:
            text = payload.get("text") or payload.get("content") or ""
            return str(text).strip()
    elif isinstance(payload, list):
        items = payload
    else:
        return str(payload).strip()

    per_item = 0
    if snippet_budget > 0 and items:
        per_item = max(MIN_SNIPPET_CHARS, snippet_budget // len(items))

    parts: List[str] = []
    for item in items:
        if isinstance(item, str):
            chunk = item
        elif isinstance(item, dict):
            content = ""
            for key in _CONTENT_KEYS:
                value = item.get(key)
                if isinstance(value, str) and value.strip():
                    content = value.strip()
                    break
            ref = _item_ref(item)
            if per_item and content:
                content = _truncate_word_safe(content, per_item)
            if ref and content:
                chunk = f"[{ref}] {content}"
            elif content:
                chunk = content
            else:
                chunk = ref
        else:
            chunk = str(item)
        chunk = chunk.strip()
        if chunk:
            parts.append(chunk)
    return "\n\n".join(parts)


def _distill_messages(messages: List[Dict[str, Any]],
                      limit: int = SESSION_SUMMARY_CHARS) -> str:
    """Cheap, deterministic distillation of a conversation into <= limit chars."""
    parts: List[str] = []
    for msg in messages or []:
        role = msg.get("role")
        content = msg.get("content")
        if role not in ("user", "assistant") or not isinstance(content, str):
            continue
        clean = sanitize_context(content).strip()
        if clean:
            parts.append(f"{role}: {clean}")
    return _truncate_word_safe("\n".join(parts), limit)


# ---------------------------------------------------------------------------
# MemoryProvider implementation
# ---------------------------------------------------------------------------

class GbrainMemoryProvider(MemoryProvider):
    """Recall-first gbrain memory provider (read-only by default)."""

    def __init__(self):
        self._client: Optional[GbrainClient] = None
        self._session_id = ""
        self._agent_context = "primary"
        self._writes_enabled = False
        self._read_only = True
        self._context_chars = DEFAULT_CONTEXT_CHARS
        self._recall_limit = DEFAULT_RECALL_LIMIT
        self._entity_tag = ""
        self._source = ""
        self._initialized = False

        # queue_prefetch warmup cache: session_id -> (result, monotonic_ts)
        self._prefetch_cache: Dict[str, tuple] = {}
        self._prefetch_lock = threading.Lock()
        self._prefetch_thread: Optional[threading.Thread] = None

    @property
    def name(self) -> str:
        return "gbrain"

    # -- availability / config ------------------------------------------------

    def is_available(self) -> bool:
        """True iff a serve URL is configured. No network I/O."""
        try:
            return bool(_resolve_base_url())
        except Exception:
            return False

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return [
            {
                "key": "baseUrl",
                "description": "gbrain serve --http base URL",
                "default": "http://127.0.0.1:3131",
                "env_var": "GBRAIN_SERVE_URL",
            },
            {
                "key": "client_id",
                "description": "OAuth client id (gbrain auth register-client)",
                "secret": True,
                "env_var": "GBRAIN_CLIENT_ID",
            },
            {
                "key": "client_secret",
                "description": "OAuth client secret (gbrain auth register-client)",
                "secret": True,
                "env_var": "GBRAIN_CLIENT_SECRET",
            },
            {
                "key": "api_token",
                "description": "Static bearer token (gbrain auth create) — "
                               "alternative to client_id/client_secret",
                "secret": True,
                "env_var": "GBRAIN_API_TOKEN",
            },
            {
                "key": "readOnly",
                "description": "Gate all writes (capture/forget/session summaries)",
                "default": "true",
                "choices": ["true", "false"],
            },
            {
                "key": "contextChars",
                "description": "Prefetch recall budget in characters "
                               "(1200 ≈ 300 tokens for local models; ~4000 for cloud)",
                "default": "1200",
            },
            {
                "key": "recallLimit",
                "description": "Max recall results per prefetch",
                "default": "5",
            },
            {
                "key": "entityTag",
                "description": "Optional tag added to captured pages",
                "default": "",
            },
            {
                "key": "source",
                "description": "gbrain source slug (entity) to scope recall "
                               "and route captures to; empty = combined "
                               "(no per-call source filter)",
                "default": "",
            },
        ]

    # save_config: non-secret fields are persisted by the setup wizard into
    # config.yaml under memory.gbrain (the provider's native config home);
    # secrets go to $HERMES_HOME/.env via env_var. Nothing else to write.

    # -- lifecycle ------------------------------------------------------------

    def initialize(self, session_id: str, **kwargs) -> None:
        """Resolve config and arm the write gate. No network calls here."""
        try:
            self._session_id = session_id or ""
            # agent_context may be absent — absent means 'primary'.
            self._agent_context = kwargs.get("agent_context") or "primary"
            platform = kwargs.get("platform", "cli")

            section = _read_provider_config()
            self._read_only = _as_bool(section.get("readOnly"), True)
            try:
                self._context_chars = int(
                    section.get("contextChars", DEFAULT_CONTEXT_CHARS)
                )
            except (TypeError, ValueError):
                self._context_chars = DEFAULT_CONTEXT_CHARS
            try:
                self._recall_limit = int(
                    section.get("recallLimit", DEFAULT_RECALL_LIMIT)
                )
            except (TypeError, ValueError):
                self._recall_limit = DEFAULT_RECALL_LIMIT
            self._entity_tag = str(section.get("entityTag") or "").strip()
            self._source = str(section.get("source") or "").strip()

            # Write gate (D5): primary context only, and readOnly must be
            # explicitly false. cron/subagent/flush are read-only always.
            non_primary = (
                self._agent_context != "primary" or platform == "cron"
            )
            self._writes_enabled = (not non_primary) and (not self._read_only)

            base_url = _resolve_base_url(section)
            if base_url:
                # Per-context credential selection (env names only): cron
                # contexts prefer GBRAIN_CRON_*, dashboard GBRAIN_DASHBOARD_*,
                # everything else (or an incomplete override) the canonical
                # GBRAIN_* names — same semantics as GbrainClient.from_env.
                creds = _select_credentials(self._agent_context, platform)
                self._client = GbrainClient(
                    base_url, timeout=PREFETCH_TIMEOUT, **creds
                )
            self._initialized = True
            logger.debug(
                "gbrain provider initialized (mode=%s, agent_context=%s, "
                "contextChars=%d)",
                "read-write" if self._writes_enabled else "read-only",
                self._agent_context, self._context_chars,
            )
        except Exception as e:
            logger.warning("gbrain provider init failed: %s", e)
            self._client = None
            self._writes_enabled = False

    def system_prompt_block(self) -> str:
        if not self._client:
            return ""
        mode = "read-write" if self._writes_enabled else "read-only"
        return f"memory: gbrain (mode={mode})"

    def shutdown(self) -> None:
        thread = self._prefetch_thread
        if thread and thread.is_alive():
            thread.join(timeout=3.0)
        if self._client:
            try:
                self._client.close()
            except Exception:
                pass

    # -- recall (prefetch) ----------------------------------------------------

    def _recall_text(self, query: str) -> str:
        """One recall round-trip, formatted, sanitized, budget-truncated.

        CLI fallback is disabled: this runs on (or just off) the turn's
        hot path, where spawning the bun CLI is never acceptable.
        """
        payload = self._client.recall(
            query, limit=self._recall_limit, source=self._source or None,
            timeout=PREFETCH_TIMEOUT, cli_fallback=False,
        )
        text = _format_recall_results(
            payload, snippet_budget=self._context_chars
        )
        text = _FENCE_RE.sub("", text).strip()
        return _truncate_word_safe(text, self._context_chars)

    def _warm_cache(self, query: str, key: str) -> None:
        """Worker-thread body: recall and deposit into the prefetch cache."""
        try:
            result = self._recall_text(query)
        except Exception as e:
            logger.debug("gbrain recall warmup failed: %s", e)
            return
        if result:
            with self._prefetch_lock:
                self._prefetch_cache[key] = (result, time.monotonic())

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        """Recall context for the upcoming turn.

        Serves a queued warmup result when fresh. On a cache miss the
        recall runs in a worker thread joined with a hard wall-clock
        deadline (PREFETCH_TIMEOUT): token minting (OAuth discovery +
        mint + 401 re-mint) or a slow daemon can never hold the turn,
        and a late result is cached for the next turn instead. Returns
        plain text — the MemoryManager adds the <memory-context> fences.
        Any error or timeout returns "" — recall must never break a turn.
        """
        if not self._client:
            return ""
        if not query or not query.strip() or query.strip().startswith("/"):
            return ""
        key = session_id or self._session_id or ""
        try:
            with self._prefetch_lock:
                cached = self._prefetch_cache.pop(key, None)
            if cached is not None:
                result, ts = cached
                if result and (time.monotonic() - ts) < PREFETCH_CACHE_TTL:
                    return result
            # Cache miss: never recall inline — the client's socket-level
            # timeout bounds individual ops, not wall clock.
            worker = threading.Thread(
                target=self._warm_cache, args=(query, key),
                daemon=True, name="gbrain-prefetch",
            )
            self._prefetch_thread = worker
            worker.start()
            worker.join(timeout=PREFETCH_TIMEOUT)
            if worker.is_alive():
                logger.debug(
                    "gbrain prefetch exceeded %.1fs; deferring result to "
                    "next turn", PREFETCH_TIMEOUT,
                )
                return ""
            with self._prefetch_lock:
                cached = self._prefetch_cache.pop(key, None)
            return cached[0] if cached else ""
        except Exception as e:
            logger.debug("gbrain prefetch failed: %s", e)
            return ""

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        """Fire-and-forget warmup for the next turn's prefetch."""
        if not self._client or not query or not query.strip():
            return
        if self._prefetch_thread and self._prefetch_thread.is_alive():
            return
        key = session_id or self._session_id or ""
        self._prefetch_thread = threading.Thread(
            target=self._warm_cache, args=(query, key),
            daemon=True, name="gbrain-prefetch",
        )
        self._prefetch_thread.start()

    # -- writes (gated) ---------------------------------------------------

    def sync_turn(self, user_content: str, assistant_content: str, *,
                  session_id: str = "", **kwargs) -> None:
        """No per-turn writes in v1 (PRD D2) — keep the graph low-noise."""

    def _capture_tags(self, extra: Optional[List[str]] = None) -> List[str]:
        tags = ["source:hermes-session"]
        if self._entity_tag:
            tags.append(self._entity_tag)
        for t in extra or []:
            t = str(t).strip()
            if t and t not in tags:
                tags.append(t)
        return tags

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        """One distilled summary capture per session (when writes enabled)."""
        if not self._writes_enabled or not self._client:
            return
        try:
            summary = _distill_messages(messages, SESSION_SUMMARY_CHARS)
            if not summary:
                return
            slug = default_capture_slug(
                summary, prefix="hermes/sessions"
            )
            self._client.capture(
                summary, tags=self._capture_tags(), slug=slug,
                source=self._source or None,
                visibility=CAPTURE_VISIBILITY, timeout=10.0,
            )
        except Exception as e:
            logger.debug("gbrain session-end capture failed: %s", e)

    def on_pre_compress(self, messages: List[Dict[str, Any]]) -> str:
        """Distill what's about to be compressed away (same write gate)."""
        if not self._writes_enabled or not self._client:
            return ""
        try:
            summary = _distill_messages(messages, SESSION_SUMMARY_CHARS)
            if summary:
                self._client.capture(
                    summary,
                    tags=self._capture_tags(["hermes-pre-compress"]),
                    source=self._source or None,
                    visibility=CAPTURE_VISIBILITY,
                    timeout=10.0,
                )
        except Exception as e:
            logger.debug("gbrain pre-compress capture failed: %s", e)
        return ""

    # -- tools ------------------------------------------------------------

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return list(ALL_TOOL_SCHEMAS)

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any],
                         **kwargs) -> str:
        if not self._client:
            return tool_error("gbrain is not configured (no serve URL).")
        try:
            if tool_name == "gbrain_recall":
                query = (args.get("query") or "").strip()
                if not query:
                    return tool_error("Missing required parameter: query")
                limit = min(int(args.get("limit") or self._recall_limit), 20)
                payload = self._client.recall(
                    query, limit=limit, source=self._source or None,
                    timeout=10.0,
                )
                text = _FENCE_RE.sub("", _format_recall_results(payload)).strip()
                if not text:
                    return json.dumps({"result": "No relevant memories found."})
                return json.dumps({"result": text})

            if tool_name == "gbrain_capture":
                if not self._writes_enabled:
                    return json.dumps({"result": READ_ONLY_MESSAGE})
                text = (args.get("text") or "").strip()
                if not text:
                    return tool_error("Missing required parameter: text")
                slug = self._client.capture(
                    text, tags=self._capture_tags(args.get("tags")),
                    source=self._source or None,
                    visibility=CAPTURE_VISIBILITY,
                    timeout=10.0,
                )
                return json.dumps({"result": "Captured to gbrain.", "slug": slug})

            if tool_name == "gbrain_forget":
                if not self._writes_enabled:
                    return json.dumps({"result": READ_ONLY_MESSAGE})
                ref = str(args.get("ref") or "").strip()
                try:
                    fact_id = int(ref)
                except ValueError:
                    return tool_error(
                        f"gbrain_forget needs a numeric fact id, got: {ref!r}"
                    )
                self._client.forget(
                    fact_id, reason=args.get("reason"), timeout=10.0
                )
                return json.dumps({"result": f"Fact {fact_id} forgotten."})

            return tool_error(f"Unknown tool: {tool_name}")
        except Exception as e:
            logger.error("gbrain tool %s failed: %s", tool_name, e)
            return tool_error(f"gbrain {tool_name} failed: {e}")


# ---------------------------------------------------------------------------
# Plugin entry point
# ---------------------------------------------------------------------------

def register(ctx) -> None:
    """Register gbrain as a memory provider plugin."""
    ctx.register_memory_provider(GbrainMemoryProvider())
