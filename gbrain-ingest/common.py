"""Shared I/O helpers for gbrain ingestion scripts (runs on agentbox2).

Box constraints honored here:
  - mailbox postgres has no published port and the box python has no
    psycopg2: all DB access is read-only SELECTs via
    `docker exec mailbox-postgres-1 psql` returning json_agg rows.
  - gbrain writes go through the local wrapper CLI
    (`gbrain capture --stdin --source <slug> --slug <slug>`), which routes
    to put_page and therefore upserts by slug (idempotent re-runs).
  - LLM calls are serial, one at a time, against the local ollama
    (qwen3:4b-instruct on 127.0.0.1:11435) with a hard timeout and a
    graceful degrade path. Never run concurrent LLM calls.
  - subprocess is argv-only; shell=True is never used.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Optional

import yaml

HERE = Path(__file__).resolve().parent

DEFAULT_ENTITY_MAP = HERE / "entity_map.yaml"
GBRAIN_BIN = os.environ.get("GBRAIN_BIN", str(Path.home() / ".local/bin/gbrain"))
MAILBOX_CONTAINER = os.environ.get("MAILBOX_CONTAINER", "mailbox-postgres-1")
STATE_DIR = Path(os.environ.get("GBRAIN_INGEST_STATE", str(Path.home() / ".hermes/gbrain-ingest")))


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- entity map

def load_entity_map(path: Optional[str] = None) -> dict:
    p = Path(path) if path else DEFAULT_ENTITY_MAP
    with open(p, "r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh)
    for key in ("entities", "accounts", "account_defaults", "companies", "domains"):
        if key not in data:
            raise ValueError(f"entity_map missing required key: {key}")
    return data


def ladder_kwargs(emap: dict) -> dict:
    """entity_map.yaml -> keyword args for attribution.attribute()."""
    classifier = emap.get("classifier", {})
    return {
        "account_map": emap["accounts"],
        "account_defaults": emap["account_defaults"],
        "domain_map": emap["domains"],
        "company_map": emap["companies"],
        "generic_domains": emap.get("generic_domains", []),
        "valid_entities": list(emap["entities"].keys()),
        "classifier_threshold": float(classifier.get("confidence_threshold", 0.6)),
    }


# ------------------------------------------------------------------ mailbox

def psql_json(sql: str) -> list[dict]:
    """Run a read-only SELECT inside the mailbox postgres container.

    The query must produce a single json_agg value; returns [] for NULL.
    Caller is responsible for SQL-literal escaping (sql_quote below).
    """
    argv = [
        "docker", "exec", MAILBOX_CONTAINER,
        "psql", "-U", "mailbox", "-d", "mailbox",
        "-v", "ON_ERROR_STOP=1", "-qtA", "-c", sql,
    ]
    out = subprocess.run(argv, capture_output=True, text=True, timeout=120)
    if out.returncode != 0:
        raise RuntimeError(f"psql failed: {out.stderr.strip()[:500]}")
    body = out.stdout.strip()
    if not body:
        return []
    rows = json.loads(body)
    return rows or []


def sql_quote(value: str) -> str:
    """Escape a string as a SQL literal (single quotes doubled)."""
    return "'" + value.replace("'", "''") + "'"


# ---------------------------------------------------------------- redaction

REDACTED = "[REDACTED]"

# Pages built here land in a shared brain that ANY registered HTTP/MCP
# caller can semantically query (gbrain's `query` op has no world/private
# filter), and mailboxes routinely carry OTPs, password-reset links, API
# keys and bearer tokens. Scrub credential-shaped strings BEFORE text is
# summarized or captured. Over-redaction is acceptable; a leaked secret
# is not.
_SECRET_FULL_RES = [
    re.compile(r"\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}\b"),    # stripe
    re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),                          # openai-style
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),                     # github
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b"),                   # github fine-grained
    re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b"),                   # slack
    re.compile(r"\bshp(?:at|ca|pa|ss)_[A-Za-z0-9]{16,}\b"),            # shopify
    re.compile(r"\bAIza[0-9A-Za-z_-]{30,}\b"),                         # google api key
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),                               # aws access key id
    re.compile(                                                        # JWT
        r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b"),
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{16,}"),             # bearer creds
    # 40+ char high-entropy blobs (must mix letters and digits inside the run)
    re.compile(r"\b(?=[A-Za-z0-9+/_=-]*\d)(?=[A-Za-z0-9+/_=-]*[A-Za-z])"
               r"[A-Za-z0-9+/_=-]{40,}\b"),
]
_SECRET_LABELED_RES = [
    # key: value / key=value assignments — keep the label, drop the value
    (re.compile(r"(?i)\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|"
                r"refresh[_-]?token|client[_-]?secret|secret|token|"
                r"password|passwd|pwd)\s*[:=]\s*)(\S{6,})"),
     r"\1" + REDACTED),
    # OTP / verification codes near their trigger words
    (re.compile(r"(?i)\b((?:verification|security|one[-\s]?time|2fa|login|"
                r"auth|confirmation)\s+code(?:\s+is)?\s*[:\-]?\s*)(\d{4,8})\b"),
     r"\1" + REDACTED),
]
_URL_RE = re.compile(r"https?://[^\s\"'<>)\]]+")
_URL_CRED_QS_RE = re.compile(
    r"(?i)[?&#][^\s]*?(token|otp|key|sig|signature|secret|code|reset|verify|"
    r"auth|tkn)")


def _redact_url(m: "re.Match[str]") -> str:
    url = m.group(0)
    if _URL_CRED_QS_RE.search(url):
        return url.split("?", 1)[0].split("#", 1)[0] + "?" + REDACTED
    return url


def redact_secrets(text: Optional[str]) -> str:
    """Scrub credential-shaped strings (API keys, tokens, JWTs, OTP codes,
    reset/credentialed links) from free text. Idempotent; returns "" for
    falsy input."""
    if not text:
        return ""
    out = _URL_RE.sub(_redact_url, text)
    for pat in _SECRET_FULL_RES:
        out = pat.sub(REDACTED, out)
    for pat, repl in _SECRET_LABELED_RES:
        out = pat.sub(repl, out)
    return out


# ------------------------------------------------------------------- gbrain

def gbrain_capture(source: str, slug: str, content: str, page_type: str = "note") -> str:
    """Upsert a page via the local gbrain wrapper. Returns the page slug."""
    argv = [
        GBRAIN_BIN, "capture", "--stdin",
        "--source", source,
        "--slug", slug,
        "--type", page_type,
        "--quiet",
    ]
    out = subprocess.run(argv, input=content, capture_output=True, text=True, timeout=120)
    if out.returncode != 0:
        raise RuntimeError(
            f"gbrain capture failed for {source}/{slug}: {out.stderr.strip()[:500]}"
        )
    return out.stdout.strip() or slug


def gbrain_delete(source: str, slug: str) -> None:
    """Soft-delete a page in a specific source via the local wrapper CLI.

    ``gbrain delete`` has no --source flag; CLI source resolution honors the
    GBRAIN_SOURCE env var (explicit flag > env > dotfile > path-match >
    brain default), so the env var is the supported way to scope the
    delete. Soft-deletes are recoverable for 72h via restore_page.
    """
    argv = [GBRAIN_BIN, "delete", slug]
    env = {**os.environ, "GBRAIN_SOURCE": source}
    out = subprocess.run(argv, env=env, capture_output=True, text=True, timeout=120)
    if out.returncode != 0:
        raise RuntimeError(
            f"gbrain delete failed for {source}/{slug}: {out.stderr.strip()[:500]}"
        )


def render_page(frontmatter: dict, body: str) -> str:
    """Render YAML frontmatter + markdown body for gbrain capture --stdin."""
    fm = yaml.safe_dump(frontmatter, default_flow_style=False, sort_keys=False,
                        allow_unicode=True).strip()
    return f"---\n{fm}\n---\n\n{body.strip()}\n"


_SLUG_RE = re.compile(r"[^a-z0-9]+")


def slugify(text: str, max_len: int = 48) -> str:
    s = _SLUG_RE.sub("-", (text or "").lower()).strip("-")
    return s[:max_len].rstrip("-") or "untitled"


# ------------------------------------------------------------------- ollama

def ollama_generate(prompt: str, *, url: str, model: str, timeout: int = 20) -> Optional[str]:
    """Single serial non-streaming ollama call. Returns None on any failure
    (caller degrades gracefully — e.g. falls back to snippets)."""
    import urllib.error
    import urllib.request

    payload = json.dumps({
        "model": model,
        "prompt": prompt,
        "stream": False,
        "options": {"temperature": 0, "num_predict": 400},
    }).encode("utf-8")
    req = urllib.request.Request(
        url.rstrip("/") + "/api/generate",
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        text = (data.get("response") or "").strip()
        return text or None
    except Exception as exc:  # timeout, conn refused, bad json — all degrade
        log(f"ollama call failed ({type(exc).__name__}): {exc}")
        return None


def make_llm_classifier(emap: dict):
    """Build llm_classify_fn(subject, snippet) -> (slug, confidence) | None."""
    cfg = emap.get("classifier", {})
    url = cfg.get("ollama_url", "http://127.0.0.1:11435")
    model = cfg.get("model", "qwen3:4b-instruct")
    timeout = int(cfg.get("timeout_seconds", 20))
    template = cfg.get("prompt", "")
    entities_block = "\n".join(
        f"- {slug}: {meta.get('name', slug)} - {meta.get('description', '')}"
        for slug, meta in emap["entities"].items()
    )

    def classify(subject: str, snippet: str):
        prompt = template.format(
            entities=entities_block,
            subject=(subject or "")[:300],
            snippet=(snippet or "")[:800],
        )
        raw = ollama_generate(prompt, url=url, model=model, timeout=timeout)
        if not raw:
            return None
        m = re.search(r"\{[^{}]*\}", raw)
        if not m:
            return None
        try:
            obj = json.loads(m.group(0))
            return str(obj.get("entity", "")).strip(), float(obj.get("confidence", 0.0))
        except (ValueError, TypeError):
            return None

    return classify


# ---------------------------------------------------------------- watermark

def read_watermark(name: str) -> Optional[str]:
    p = STATE_DIR / name
    if p.exists():
        v = p.read_text(encoding="utf-8").strip()
        return v or None
    return None


def write_watermark(name: str, value: str) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STATE_DIR / (name + ".tmp")
    tmp.write_text(value + "\n", encoding="utf-8")
    tmp.replace(STATE_DIR / name)
