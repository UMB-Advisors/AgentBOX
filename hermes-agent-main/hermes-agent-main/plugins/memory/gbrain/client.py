"""Thin HTTP client for a running ``gbrain serve --http`` daemon.

Transport: MCP Streamable HTTP — ``POST {base}/mcp`` with a JSON-RPC 2.0
``tools/call`` body. Responses may come back as plain JSON or as a
``text/event-stream`` body; both are handled.

Auth: OAuth 2.1 client_credentials (``gbrain auth register-client``) with
short-lived bearer tokens (~1h). Tokens are fetched from the daemon's
token endpoint (discovered via ``/.well-known/oauth-authorization-server``),
cached with expiry, and refreshed once on 401. A static legacy token
(``gbrain auth create``) can be supplied instead and is used as-is.

Env:
  GBRAIN_SERVE_URL      base URL of the daemon (e.g. http://127.0.0.1:3131)
  GBRAIN_CLIENT_ID      OAuth client id     (client_credentials flow)
  GBRAIN_CLIENT_SECRET  OAuth client secret (client_credentials flow)
  GBRAIN_API_TOKEN      static bearer token (takes precedence when set)

CLI fallback: ops the server refuses (``unknown_operation`` — e.g. a
localOnly op on an older daemon) fall back to the gbrain CLI via
subprocess (argument-list only, never shell=True), honoring
GBRAIN_BUN / GBRAIN_DIR / GBRAIN_HOME from the environment.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 3.0
TOKEN_REFRESH_SLACK = 60.0  # refresh this many seconds before expiry
CLI_TIMEOUT = 15.0


class GbrainClientError(Exception):
    """Base error for gbrain client failures."""


class GbrainAuthError(GbrainClientError):
    """Token acquisition / authorization failed."""


class GbrainRefusedError(GbrainClientError):
    """The server refused the operation (unknown / local-only op)."""


def _build_capture_markdown(text: str, tags: Optional[List[str]] = None) -> str:
    """Full markdown page (YAML frontmatter + body) for put_page/capture."""
    lines = ["---"]
    if tags:
        rendered = ", ".join(json.dumps(str(t)) for t in tags)
        lines.append(f"tags: [{rendered}]")
    lines.append(f"created: {date.today().isoformat()}")
    lines.append("---")
    lines.append("")
    lines.append(text.rstrip())
    lines.append("")
    return "\n".join(lines)


def default_capture_slug(text: str, prefix: str = "inbox/hermes") -> str:
    digest = hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()[:8]
    return f"{prefix}/{date.today().isoformat()}-{digest}"


class GbrainClient:
    """Synchronous client for gbrain serve (MCP Streamable HTTP)."""

    def __init__(
        self,
        base_url: str,
        *,
        client_id: Optional[str] = None,
        client_secret: Optional[str] = None,
        static_token: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT,
        cli_fallback: bool = True,
    ):
        self.base_url = (base_url or "").rstrip("/")
        self._client_id = client_id
        self._client_secret = client_secret
        self._static_token = static_token
        self._timeout = timeout
        self._cli_fallback = cli_fallback

        self._token: Optional[str] = None
        self._token_expiry: float = 0.0  # time.monotonic deadline
        self._token_endpoint: Optional[str] = None
        self._token_lock = threading.Lock()
        self._rpc_id = 0
        self._rpc_id_lock = threading.Lock()

    @classmethod
    def from_env(cls, base_url: Optional[str] = None, *,
                 timeout: float = DEFAULT_TIMEOUT) -> "GbrainClient":
        return cls(
            base_url or os.environ.get("GBRAIN_SERVE_URL", ""),
            client_id=os.environ.get("GBRAIN_CLIENT_ID") or None,
            client_secret=os.environ.get("GBRAIN_CLIENT_SECRET") or None,
            static_token=os.environ.get("GBRAIN_API_TOKEN") or None,
            timeout=timeout,
        )

    # ------------------------------------------------------------------
    # Low-level transport (single seam — tests monkeypatch _request)
    # ------------------------------------------------------------------

    def _request(
        self,
        url: str,
        *,
        data: Optional[bytes] = None,
        headers: Optional[Dict[str, str]] = None,
        method: str = "POST",
        timeout: Optional[float] = None,
    ) -> Tuple[int, Dict[str, str], bytes]:
        """Issue one HTTP request. Returns (status, headers, body)."""
        req = urllib.request.Request(
            url, data=data, headers=headers or {}, method=method
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout or self._timeout) as resp:
                return resp.status, dict(resp.headers), resp.read()
        except urllib.error.HTTPError as e:
            try:
                body = e.read() or b""
            except Exception:
                body = b""
            return e.code, dict(e.headers or {}), body

    # ------------------------------------------------------------------
    # OAuth 2.1 client_credentials token handling
    # ------------------------------------------------------------------

    def _discover_token_endpoint(self) -> str:
        if self._token_endpoint:
            return self._token_endpoint
        url = f"{self.base_url}/.well-known/oauth-authorization-server"
        status, _, body = self._request(url, method="GET")
        if status != 200:
            raise GbrainAuthError(f"OAuth metadata discovery failed (HTTP {status})")
        try:
            meta = json.loads(body.decode("utf-8", errors="replace"))
            endpoint = meta["token_endpoint"]
        except Exception as e:
            raise GbrainAuthError(f"Bad OAuth metadata: {e}") from e
        self._token_endpoint = endpoint
        return endpoint

    def _get_token(self, *, force: bool = False) -> str:
        if self._static_token:
            return self._static_token
        if not (self._client_id and self._client_secret):
            raise GbrainAuthError(
                "No gbrain credentials: set GBRAIN_API_TOKEN or "
                "GBRAIN_CLIENT_ID + GBRAIN_CLIENT_SECRET"
            )
        with self._token_lock:
            if (
                not force
                and self._token
                and time.monotonic() < self._token_expiry - TOKEN_REFRESH_SLACK
            ):
                return self._token
            endpoint = self._discover_token_endpoint()
            form = urllib.parse.urlencode({
                "grant_type": "client_credentials",
                "client_id": self._client_id,
                "client_secret": self._client_secret,
            }).encode("ascii")
            status, _, body = self._request(
                endpoint,
                data=form,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            if status != 200:
                raise GbrainAuthError(f"Token request failed (HTTP {status})")
            try:
                payload = json.loads(body.decode("utf-8", errors="replace"))
                token = payload["access_token"]
                expires_in = float(payload.get("expires_in", 3600))
            except Exception as e:
                raise GbrainAuthError(f"Bad token response: {e}") from e
            self._token = token
            self._token_expiry = time.monotonic() + expires_in
            return token

    # ------------------------------------------------------------------
    # MCP tools/call
    # ------------------------------------------------------------------

    @staticmethod
    def _parse_sse(text: str) -> Optional[dict]:
        """Extract the final JSON-RPC envelope from an SSE body."""
        last = None
        for line in text.splitlines():
            if not line.startswith("data:"):
                continue
            chunk = line[len("data:"):].strip()
            if not chunk:
                continue
            try:
                obj = json.loads(chunk)
            except ValueError:
                continue
            if isinstance(obj, dict) and ("result" in obj or "error" in obj):
                last = obj
        return last

    @staticmethod
    def _looks_refused(message: str) -> bool:
        msg = (message or "").lower()
        return (
            "unknown_operation" in msg
            or "unknown tool" in msg
            or "tool not found" in msg
            or "method not found" in msg
        )

    def call_tool(self, name: str, arguments: Dict[str, Any],
                  *, timeout: Optional[float] = None) -> Any:
        """POST /mcp tools/call. Returns the decoded tool payload.

        The MCP ToolResult text content is JSON-decoded when possible,
        otherwise returned as a raw string.
        """
        if not self.base_url:
            raise GbrainClientError("gbrain base URL is not configured")
        with self._rpc_id_lock:
            self._rpc_id += 1
            rpc_id = self._rpc_id
        body = json.dumps({
            "jsonrpc": "2.0",
            "id": rpc_id,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        }).encode("utf-8")

        token = self._get_token()
        for attempt in (0, 1):
            headers = {
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                "Authorization": f"Bearer {token}",
            }
            status, resp_headers, raw = self._request(
                f"{self.base_url}/mcp", data=body, headers=headers,
                timeout=timeout,
            )
            if status == 401 and attempt == 0 and not self._static_token:
                token = self._get_token(force=True)
                continue
            break

        if status == 401:
            raise GbrainAuthError("gbrain serve rejected the bearer token (401)")
        if status >= 500:
            raise GbrainClientError(f"gbrain serve error (HTTP {status})")

        text = raw.decode("utf-8", errors="replace")
        content_type = ""
        for key, value in (resp_headers or {}).items():
            if key.lower() == "content-type":
                content_type = (value or "").lower()
                break

        envelope: Optional[dict] = None
        if "text/event-stream" in content_type:
            envelope = self._parse_sse(text)
        else:
            try:
                envelope = json.loads(text)
            except ValueError:
                envelope = self._parse_sse(text)
        if not isinstance(envelope, dict):
            raise GbrainClientError(
                f"Unparseable gbrain response (HTTP {status})"
            )

        if "error" in envelope:
            message = str((envelope.get("error") or {}).get("message", envelope["error"]))
            if self._looks_refused(message):
                raise GbrainRefusedError(message)
            raise GbrainClientError(f"gbrain RPC error: {message}")

        result = envelope.get("result") or {}
        content = result.get("content") or []
        text_payload = ""
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                text_payload = item.get("text", "")
                break
        if result.get("isError"):
            if self._looks_refused(text_payload):
                raise GbrainRefusedError(text_payload or "operation refused")
            raise GbrainClientError(text_payload or "gbrain tool call failed")
        try:
            return json.loads(text_payload)
        except (ValueError, TypeError):
            return text_payload

    # ------------------------------------------------------------------
    # CLI fallback (host-side gbrain CLI; argument lists only)
    # ------------------------------------------------------------------

    def _run_cli(self, args: List[str], *, input_text: Optional[str] = None) -> str:
        bun = os.environ.get("GBRAIN_BUN") or os.path.expanduser("~/.bun/bin/bun")
        gbrain_dir = os.environ.get("GBRAIN_DIR") or os.path.expanduser("~/gbrain-src")
        env = dict(os.environ)  # GBRAIN_HOME flows through when set
        cmd = [bun, "run", "src/cli.ts", *args]
        try:
            proc = subprocess.run(  # noqa: S603 — fixed argv, no shell
                cmd,
                cwd=gbrain_dir,
                input=input_text,
                capture_output=True,
                text=True,
                timeout=CLI_TIMEOUT,
                env=env,
            )
        except (OSError, subprocess.SubprocessError) as e:
            raise GbrainClientError(f"gbrain CLI fallback failed: {e}") from e
        if proc.returncode != 0:
            raise GbrainClientError(
                f"gbrain CLI exited {proc.returncode}: {(proc.stderr or '').strip()[:200]}"
            )
        return proc.stdout or ""

    # ------------------------------------------------------------------
    # High-level ops
    # ------------------------------------------------------------------

    def recall(self, query: str, *, limit: int = 5,
               timeout: Optional[float] = None,
               cli_fallback: Optional[bool] = None) -> Any:
        """Semantic recall via the server-exposed ``query`` op.

        ``cli_fallback=False`` disables the subprocess fallback for this
        call — hot-path callers (prefetch) must never spawn the CLI;
        explicit tool calls keep the client-level default.
        """
        allow_cli = self._cli_fallback if cli_fallback is None else cli_fallback
        try:
            return self.call_tool(
                "query", {"query": query, "limit": int(limit)}, timeout=timeout
            )
        except GbrainRefusedError:
            if not allow_cli:
                raise
            logger.debug("gbrain server refused 'query' — CLI fallback")
            return self._run_cli(["query", query, "--json"])

    def capture(self, text: str, *, tags: Optional[List[str]] = None,
                slug: Optional[str] = None,
                timeout: Optional[float] = None) -> str:
        """Write a page. Remote path uses ``put_page`` (there is no server
        'capture' op — the gbrain thin client itself routes capture through
        put_page); falls back to ``gbrain capture --stdin`` when refused.
        """
        slug = slug or default_capture_slug(text)
        content = _build_capture_markdown(text, tags)
        try:
            self.call_tool(
                "put_page", {"slug": slug, "content": content}, timeout=timeout
            )
            return slug
        except GbrainRefusedError:
            if not self._cli_fallback:
                raise
            logger.debug("gbrain server refused 'put_page' — CLI capture fallback")
            self._run_cli(
                ["capture", "--stdin", "--slug", slug, "--quiet"],
                input_text=content,
            )
            return slug

    def forget(self, fact_id: int, *, reason: Optional[str] = None,
               timeout: Optional[float] = None) -> Any:
        """Expire a hot-memory fact via ``forget_fact``."""
        args: Dict[str, Any] = {"id": int(fact_id)}
        if reason:
            args["reason"] = reason
        try:
            return self.call_tool("forget_fact", args, timeout=timeout)
        except GbrainRefusedError:
            if not self._cli_fallback:
                raise
            logger.debug("gbrain server refused 'forget_fact' — CLI fallback")
            cli_args = ["forget", str(int(fact_id))]
            if reason:
                cli_args += ["--reason", reason]
            return self._run_cli(cli_args)

    def close(self) -> None:
        """No persistent connections — kept for symmetry with shutdown()."""
        self._token = None
        self._token_expiry = 0.0
