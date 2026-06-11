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
