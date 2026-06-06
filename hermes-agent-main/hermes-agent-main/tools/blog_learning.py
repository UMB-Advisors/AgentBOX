"""Blog learning loop — provenance capture + editorial-feedback learning.

The pipeline learns YES!'s house voice from how a human editor turns AI blog
drafts into published posts.

**Phase 1 — provenance.** Every AgentBOX Shopify draft created via
``create_shopify_blog_post`` is tagged ``agentbox`` and gets a provenance record
written to ``$HERMES_HOME/blog_learning/drafts/<article_id>.json`` capturing the
AI's *original* draft. This makes every AgentBOX post learnable later, with no
log-parsing.

**Phase 2 — learn-from-published.** A daily 08:00 cron agent calls the tools
registered here:

* ``list_pending_blog_drafts`` — drafts awaiting a terminal human action.
* ``get_blog_post_feedback`` — diffs the AI's original draft against the
  human-published article (publish = approved), or detects deletion
  (delete = rejected).
* ``record_blog_lesson`` — persists distilled editorial lessons into gbrain
  (``gbrain capture``) and refreshes the always-injected house-style digest.

The diff between the AI's original draft and the human-published version is the
training signal. Mean ``edit_magnitude`` falling over time = the AI converging
on YES!'s voice.

Pure stdlib (difflib / subprocess) — no third-party deps. Paths are resolved
from ``HERMES_HOME`` on every call so the runtime and tests stay in sync.
"""

from __future__ import annotations

import difflib
import html as _html
import json
import logging
import os
import re
import shutil
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

AGENTBOX_TAG = "agentbox"
GBRAIN_TAG = "blog-editorial-feedback"
# Below this normalized-text edit magnitude (and identical title) a publish is
# treated as a "clean approval" rather than an edited one — no lessons to mine.
CLEAN_APPROVAL_MAX_MAGNITUDE = 0.02
# Cap text sent back through tool results so a single article can't blow up the
# learner agent's context.
_MAX_TEXT_CHARS = 8000
_MAX_DIFF_CHARS = 12000
# How many recent lessons the digest scans / shows.
DIGEST_MAX_LESSONS = 60
DIGEST_RECENT_SHOWN = 12
LESSON_CATEGORIES = [
    "naming", "voice", "length", "claims/compliance",
    "structure/AEO", "title", "cta", "links/sources", "image",
]


# ---------------------------------------------------------------------------
# Path helpers — resolved from HERMES_HOME each call (test-overridable)
# ---------------------------------------------------------------------------


def hermes_home() -> Path:
    return Path(os.getenv("HERMES_HOME") or (Path.home() / ".hermes"))


def learn_dir() -> Path:
    return hermes_home() / "blog_learning"


def drafts_dir() -> Path:
    return learn_dir() / "drafts"


def lessons_dir() -> Path:
    return learn_dir() / "lessons"


def digest_path() -> Path:
    return learn_dir() / "house-style.md"


def index_path() -> Path:
    return lessons_dir() / "index.jsonl"


def _gbrain_bin() -> str:
    """Resolve the gbrain executable. Honors ``GBRAIN_BIN``, else PATH, else the
    default bun install dir (``~/.bun/bin``) used on the agent box."""
    explicit = os.getenv("GBRAIN_BIN")
    if explicit:
        return explicit
    found = shutil.which("gbrain")
    if found:
        return found
    cand = Path.home() / ".bun" / "bin" / "gbrain"
    if cand.exists():
        return str(cand)
    return "gbrain"


def _gbrain_env() -> Dict[str, str]:
    """Subprocess env with the bun bin dir prepended to PATH so gbrain's
    ``#!/usr/bin/env bun`` shebang resolves under a non-login PATH (the cron /
    agent context, where ``~/.bun/bin`` is not on PATH by default)."""
    env = os.environ.copy()
    bun_bin = str(Path.home() / ".bun" / "bin")
    if os.path.isdir(bun_bin) and bun_bin not in env.get("PATH", "").split(os.pathsep):
        env["PATH"] = bun_bin + os.pathsep + env.get("PATH", "")
    return env


def _ensure_dirs() -> None:
    drafts_dir().mkdir(parents=True, exist_ok=True)
    lessons_dir().mkdir(parents=True, exist_ok=True)


def _draft_path(article_id: Any) -> Path:
    return drafts_dir() / f"{article_id}.json"


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat()


def _today() -> str:
    return datetime.now().astimezone().strftime("%Y-%m-%d")


# ---------------------------------------------------------------------------
# Text / diff utilities
# ---------------------------------------------------------------------------


def strip_html(value: Optional[str]) -> str:
    """Collapse HTML to normalized plain text for diffing/magnitude."""
    if not value:
        return ""
    text = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", value)
    text = re.sub(r"<[^>]+>", " ", text)
    text = _html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def _sentences(text: str) -> List[str]:
    """Split normalized text into sentence-ish lines for a readable diff."""
    if not text:
        return []
    return [s for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]


def edit_magnitude(original_html: Optional[str], published_html: Optional[str]) -> float:
    """0.0 (identical) .. 1.0 (fully rewritten) on normalized plain text."""
    a = strip_html(original_html)
    b = strip_html(published_html)
    if not a and not b:
        return 0.0
    ratio = difflib.SequenceMatcher(None, a, b).ratio()
    return round(1.0 - ratio, 4)


def unified_diff(
    original_title: str,
    original_html: Optional[str],
    published_title: str,
    published_html: Optional[str],
) -> str:
    """Readable unified diff of title + sentence-split body (AI -> human)."""
    a = [f"TITLE: {original_title or ''}", ""] + _sentences(strip_html(original_html))
    b = [f"TITLE: {published_title or ''}", ""] + _sentences(strip_html(published_html))
    diff = difflib.unified_diff(
        a, b, fromfile="ai_original", tofile="human_published", lineterm=""
    )
    out = "\n".join(diff)
    if len(out) > _MAX_DIFF_CHARS:
        out = out[:_MAX_DIFF_CHARS] + "\n... [diff truncated]"
    return out


def _truncate(text: str, limit: int = _MAX_TEXT_CHARS) -> str:
    if text and len(text) > limit:
        return text[:limit] + " … [truncated]"
    return text


# ---------------------------------------------------------------------------
# Tag handling
# ---------------------------------------------------------------------------


def ensure_agentbox_tag(tags: Optional[str]) -> str:
    """Return *tags* (comma-separated) guaranteed to include ``agentbox``."""
    parts = [t.strip() for t in (tags or "").split(",") if t.strip()]
    if not any(t.lower() == AGENTBOX_TAG for t in parts):
        parts.append(AGENTBOX_TAG)
    return ", ".join(parts)


# ---------------------------------------------------------------------------
# Provenance store
# ---------------------------------------------------------------------------


def record_provenance(
    *,
    article_id: Any,
    blog_handle: str,
    title: str,
    body_html: str,
    summary_html: Optional[str] = None,
    image_alt: Optional[str] = None,
    image_path: Optional[str] = None,
    tags: Optional[str] = None,
    topic: Optional[str] = None,
    theme: Optional[str] = None,
    model: Optional[str] = None,
    created_at: Optional[str] = None,
) -> Path:
    """Write a provenance record for a freshly-created AI draft (status=pending)."""
    _ensure_dirs()
    record = {
        "article_id": article_id,
        "blog_handle": blog_handle,
        "created_at": created_at or _now_iso(),
        "topic": topic,
        "theme": theme,
        "model": model,
        "original_title": title,
        "original_body_html": body_html,
        "original_summary_html": summary_html,
        "original_image_alt": image_alt,
        "original_image_path": image_path,
        "tags": tags,
        "status": "pending",  # pending | processed | rejected
    }
    path = _draft_path(article_id)
    path.write_text(json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8")
    return path


def load_record(article_id: Any) -> Optional[Dict[str, Any]]:
    path = _draft_path(article_id)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        logger.warning("blog_learning: bad provenance record %s: %s", path, e)
        return None


def set_status(article_id: Any, status: str, **extra: Any) -> Optional[Dict[str, Any]]:
    record = load_record(article_id)
    if record is None:
        return None
    record["status"] = status
    record.update(extra)
    _draft_path(article_id).write_text(
        json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    return record


def list_pending() -> List[Dict[str, Any]]:
    d = drafts_dir()
    if not d.exists():
        return []
    out: List[Dict[str, Any]] = []
    for p in sorted(d.glob("*.json")):
        try:
            rec = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if rec.get("status") == "pending":
            out.append(rec)
    return out


# ---------------------------------------------------------------------------
# gbrain ingest  (CLI verb is ``gbrain capture``, not ``ingest``)
# ---------------------------------------------------------------------------


def gbrain_capture(file_path: Path) -> Dict[str, Any]:
    """Ingest a lesson markdown file into gbrain. Best-effort; never raises."""
    binname = _gbrain_bin()
    try:
        proc = subprocess.run(
            [binname, "capture", "--file", str(file_path), "--quiet"],
            capture_output=True,
            text=True,
            timeout=120,
            env=_gbrain_env(),
        )
    except FileNotFoundError:
        return {"ok": False, "error": f"gbrain binary {binname!r} not found"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "gbrain capture timed out"}
    except Exception as e:  # noqa: BLE001 - ingest is best-effort
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    if proc.returncode != 0:
        return {"ok": False, "error": (proc.stderr or proc.stdout or "").strip()[:300]}
    return {"ok": True, "slug": (proc.stdout or "").strip()}


# ---------------------------------------------------------------------------
# Lessons + house-style digest
# ---------------------------------------------------------------------------


def _safe_category(category: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (category or "general").lower()).strip("-") or "general"


def _render_lesson_md(lesson: Dict[str, Any], *, source_article_id: Any, date: str) -> str:
    category = lesson.get("category") or "general"
    fm = {
        "type": GBRAIN_TAG,
        "source_article_id": source_article_id,
        "date": date,
        "category": category,
        "confidence": lesson.get("confidence"),
        "edit_magnitude": lesson.get("edit_magnitude"),
        "tags": [GBRAIN_TAG, _safe_category(category)],
    }
    lines = ["---"]
    for k, v in fm.items():
        lines.append(f"{k}: {json.dumps(v, ensure_ascii=False)}")
    lines.append("---")
    lines.append("")
    lines.append(f"# Editorial lesson — {category}")
    lines.append("")
    if lesson.get("rule"):
        lines.append(f"**Rule:** {lesson['rule']}")
        lines.append("")
    if lesson.get("observation"):
        lines.append(f"**Observation:** {lesson['observation']}")
        lines.append("")
    if lesson.get("before"):
        lines.append(f"**Before (AI):** {lesson['before']}")
        lines.append("")
    if lesson.get("after"):
        lines.append(f"**After (human):** {lesson['after']}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def write_lesson(lesson: Dict[str, Any], *, source_article_id: Any, date: Optional[str] = None) -> Path:
    """Write one lesson to a markdown file and append it to the JSONL index."""
    _ensure_dirs()
    date = date or _today()
    safe_cat = _safe_category(lesson.get("category", "general"))
    base = f"{date}-{source_article_id}-{safe_cat}"
    path = lessons_dir() / f"{base}.md"
    i = 2
    while path.exists():
        path = lessons_dir() / f"{base}-{i}.md"
        i += 1
    path.write_text(
        _render_lesson_md(lesson, source_article_id=source_article_id, date=date),
        encoding="utf-8",
    )
    _append_index(
        {
            "date": date,
            "source_article_id": source_article_id,
            "category": lesson.get("category", "general"),
            "rule": lesson.get("rule", ""),
            "observation": lesson.get("observation", ""),
            "confidence": lesson.get("confidence"),
            "edit_magnitude": lesson.get("edit_magnitude"),
            "file": path.name,
        }
    )
    return path


def _append_index(entry: Dict[str, Any]) -> None:
    with index_path().open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")


def _read_index() -> List[Dict[str, Any]]:
    p = index_path()
    if not p.exists():
        return []
    out: List[Dict[str, Any]] = []
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def refresh_digest(max_lessons: int = DIGEST_MAX_LESSONS) -> Path:
    """Regenerate the always-injected house-style digest from recent lessons."""
    _ensure_dirs()
    lessons = _read_index()[-max_lessons:]
    # Count recurrence by (category, normalized rule).
    counts: Dict[tuple, Dict[str, Any]] = {}
    for ls in lessons:
        rule = (ls.get("rule") or "").strip()
        if not rule:
            continue
        key = (ls.get("category", "general"), rule.lower())
        slot = counts.setdefault(
            key, {"category": ls.get("category", "general"), "rule": rule, "n": 0}
        )
        slot["n"] += 1
    recurring = sorted(counts.values(), key=lambda s: s["n"], reverse=True)

    out: List[str] = []
    out.append("# YES! Blog House-Style Digest")
    out.append("")
    out.append(
        f"_Auto-generated from {len(lessons)} recent editorial lesson(s) on "
        f"{_today()}. Source: human edits to AI blog drafts._"
    )
    out.append("")
    out.append("## Recurring rules (apply these every time)")
    out.append("")
    top = [r for r in recurring if r["n"] >= 2] or recurring[:8]
    if top:
        for r in top[:15]:
            tag = f" ×{r['n']}" if r["n"] > 1 else ""
            out.append(f"- [{r['category']}{tag}] {r['rule']}")
    else:
        out.append("- _(no recurring rules yet — learning in progress)_")
    out.append("")
    out.append("## Recent lessons")
    out.append("")
    recent = list(reversed(lessons))[:DIGEST_RECENT_SHOWN]
    if recent:
        for ls in recent:
            mag = ls.get("edit_magnitude")
            mag_s = f", mag {mag}" if mag is not None else ""
            rule = ls.get("rule") or ls.get("observation") or ""
            out.append(f"- ({ls.get('date')}, {ls.get('category')}{mag_s}) {rule}")
    else:
        out.append("- _(none yet)_")
    out.append("")
    text = "\n".join(out)
    digest_path().write_text(text, encoding="utf-8")
    return digest_path()


def read_digest() -> str:
    p = digest_path()
    return p.read_text(encoding="utf-8") if p.exists() else ""


# ---------------------------------------------------------------------------
# Shopify article fetch (for feedback) — lazy import to avoid import cycle
# ---------------------------------------------------------------------------


def fetch_article(blog_handle: str, article_id: Any) -> Optional[Dict[str, Any]]:
    """Fetch a Shopify article by id. Returns the article dict, or None if it
    no longer exists (deleted = rejected). Raises on other API errors."""
    from tools import shopify_tools  # lazy: shopify_tools imports this module

    blog_id = shopify_tools.resolve_blog_id(blog_handle)
    try:
        res = shopify_tools._req(
            "GET", f"blogs/{blog_id}/articles/{article_id}.json"
        )
    except RuntimeError as e:
        if "HTTP 404" in str(e):
            return None
        raise
    return res.get("article")


def compute_feedback(record: Dict[str, Any]) -> Dict[str, Any]:
    """Compare a provenance record's original draft to the live Shopify article.

    Returns a dict with ``status`` in
    {pending, rejected, published_clean, published_edited} plus the data the
    learner needs to distill lessons. Read-only — does not mutate the record.
    """
    article_id = record.get("article_id")
    blog_handle = record.get("blog_handle")
    article = fetch_article(blog_handle, article_id)
    if article is None:
        return {"article_id": article_id, "status": "rejected"}

    if not article.get("published_at"):
        return {"article_id": article_id, "status": "pending"}

    orig_title = record.get("original_title") or ""
    orig_body = record.get("original_body_html") or ""
    pub_title = article.get("title") or ""
    pub_body = article.get("body_html") or ""
    mag = edit_magnitude(orig_body, pub_body)
    title_changed = orig_title.strip() != pub_title.strip()
    status = (
        "published_clean"
        if (mag <= CLEAN_APPROVAL_MAX_MAGNITUDE and not title_changed)
        else "published_edited"
    )
    return {
        "article_id": article_id,
        "status": status,
        "edit_magnitude": mag,
        "title_changed": title_changed,
        "original": {
            "title": orig_title,
            "body_text": _truncate(strip_html(orig_body)),
        },
        "published": {
            "title": pub_title,
            "body_text": _truncate(strip_html(pub_body)),
        },
        "unified_diff": unified_diff(orig_title, orig_body, pub_title, pub_body),
    }


# ---------------------------------------------------------------------------
# Tool handlers  (signature: (args, **kw) -> JSON string)
# ---------------------------------------------------------------------------


def _handle_list_pending(args: dict, **kw) -> str:
    pending = list_pending()
    items = [
        {
            "article_id": r.get("article_id"),
            "blog_handle": r.get("blog_handle"),
            "topic": r.get("topic"),
            "theme": r.get("theme"),
            "original_title": r.get("original_title"),
            "created_at": r.get("created_at"),
        }
        for r in pending
    ]
    return tool_result({"count": len(items), "pending": items})


def _handle_get_feedback(args: dict, **kw) -> str:
    article_id = args.get("article_id")
    if article_id is None:
        return tool_error("Missing required parameter: article_id")
    record = load_record(article_id)
    if record is None:
        return tool_error(f"No provenance record for article_id {article_id}")
    try:
        return tool_result(compute_feedback(record))
    except Exception as e:  # noqa: BLE001
        logger.error("get_blog_post_feedback error: %s", e)
        return tool_error(f"Failed to fetch feedback: {e}")


def _handle_record_lesson(args: dict, **kw) -> str:
    article_id = args.get("article_id")
    status = (args.get("status") or "").strip()
    lessons = args.get("lessons") or []
    edit_mag = args.get("edit_magnitude")
    if article_id is None:
        return tool_error("Missing required parameter: article_id")
    if status not in ("processed", "rejected"):
        return tool_error("status must be 'processed' or 'rejected'")
    if load_record(article_id) is None:
        return tool_error(f"No provenance record for article_id {article_id}")
    if not isinstance(lessons, list):
        return tool_error("lessons must be a list")

    written: List[str] = []
    gbrain_ok = 0
    for lesson in lessons:
        if not isinstance(lesson, dict):
            continue
        if edit_mag is not None and lesson.get("edit_magnitude") is None:
            lesson["edit_magnitude"] = edit_mag
        try:
            path = write_lesson(lesson, source_article_id=article_id)
        except Exception as e:  # noqa: BLE001
            logger.error("write_lesson failed: %s", e)
            continue
        written.append(path.name)
        if gbrain_capture(path).get("ok"):
            gbrain_ok += 1

    try:
        refresh_digest()
    except Exception as e:  # noqa: BLE001
        logger.error("refresh_digest failed: %s", e)

    outcome = args.get("outcome") or status
    set_status(
        article_id,
        status,
        processed_at=_now_iso(),
        outcome=outcome,
        edit_magnitude=edit_mag,
        lessons_count=len(written),
    )

    # Blog is the reference channel of the Content Engine (Job 1.3): feed the
    # shared sales trust counter so the loop graduates L0 -> L1 -> L2 as the
    # editor stops materially changing drafts. Best-effort.
    trust_header = None
    try:
        from tools import sales_trust
        trust = sales_trust.record_outcome(
            "1.3",
            magnitude=(edit_mag if edit_mag is not None else 0.0),
            rejected=(status == "rejected"),
        )
        trust_header = sales_trust.trust_header("1.3")
        logger.info("blog_learning: Job 1.3 trust -> L%s (%s clean)",
                    trust.get("level"), trust.get("consecutive_clean"))
    except Exception as e:  # noqa: BLE001
        logger.warning("blog_learning sales_trust update skipped: %s", e)

    return tool_result(
        {
            "recorded": len(written),
            "gbrain_ok": gbrain_ok,
            "lesson_files": written,
            "status": status,
            "digest": str(digest_path()),
            "trust_header": trust_header,
        }
    )


# ---------------------------------------------------------------------------
# Tool schemas
# ---------------------------------------------------------------------------

LIST_PENDING_SCHEMA = {
    "name": "list_pending_blog_drafts",
    "description": (
        "List AgentBOX-created Shopify blog drafts that are awaiting a terminal "
        "human action (publish or delete). Each has a provenance record of the "
        "AI's original draft. Call this first in the learn-from-published flow."
    ),
    "parameters": {"type": "object", "properties": {}},
}

GET_FEEDBACK_SCHEMA = {
    "name": "get_blog_post_feedback",
    "description": (
        "Fetch the live Shopify article for a provenance record and compare it "
        "to the AI's original draft. Returns status: 'pending' (not yet acted "
        "on), 'rejected' (the human deleted it), 'published_clean' (published "
        "with no meaningful edits), or 'published_edited' (published after "
        "edits — includes a unified_diff + original/published text to distill)."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "article_id": {
                "type": "integer",
                "description": "The Shopify article id from list_pending_blog_drafts.",
            },
        },
        "required": ["article_id"],
    },
}

RECORD_LESSON_SCHEMA = {
    "name": "record_blog_lesson",
    "description": (
        "Persist distilled editorial lessons for a blog post into gbrain and "
        "refresh the house-style digest, then mark the provenance record done. "
        "Call once per article after reviewing its feedback. For "
        "'published_clean' pass an empty lessons list. Never call for 'pending'."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "article_id": {
                "type": "integer",
                "description": "The Shopify article id.",
            },
            "status": {
                "type": "string",
                "enum": ["processed", "rejected"],
                "description": (
                    "'processed' for a published post (clean or edited); "
                    "'rejected' for a deleted draft."
                ),
            },
            "edit_magnitude": {
                "type": "number",
                "description": (
                    "0.0 (no edits) .. 1.0 (full rewrite), from get_blog_post_feedback."
                ),
            },
            "outcome": {
                "type": "string",
                "enum": ["published_edited", "published_clean", "rejected"],
                "description": "Fine-grained outcome for metrics (optional).",
            },
            "lessons": {
                "type": "array",
                "description": (
                    "Generalizable editorial lessons distilled from the edits. "
                    "Empty for clean approvals. Avoid one-off typo fixes."
                ),
                "items": {
                    "type": "object",
                    "properties": {
                        "category": {
                            "type": "string",
                            "description": (
                                "One of: " + ", ".join(LESSON_CATEGORIES) + "."
                            ),
                        },
                        "observation": {
                            "type": "string",
                            "description": "What the editor changed (specific).",
                        },
                        "rule": {
                            "type": "string",
                            "description": (
                                "Reusable guidance for future drafts, phrased "
                                "generally (not a one-off)."
                            ),
                        },
                        "confidence": {
                            "type": "number",
                            "description": "0-1 confidence this is a real pattern.",
                        },
                        "before": {"type": "string", "description": "AI text snippet."},
                        "after": {"type": "string", "description": "Human text snippet."},
                    },
                    "required": ["category", "rule"],
                },
            },
        },
        "required": ["article_id", "status"],
    },
}


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------

from tools.registry import registry, tool_error, tool_result

registry.register(
    name="list_pending_blog_drafts",
    toolset="blog_learning",
    schema=LIST_PENDING_SCHEMA,
    handler=_handle_list_pending,
    emoji="📝",
)

registry.register(
    name="get_blog_post_feedback",
    toolset="blog_learning",
    schema=GET_FEEDBACK_SCHEMA,
    handler=_handle_get_feedback,
    emoji="🔍",
)

registry.register(
    name="record_blog_lesson",
    toolset="blog_learning",
    schema=RECORD_LESSON_SCHEMA,
    handler=_handle_record_lesson,
    emoji="🎓",
)
