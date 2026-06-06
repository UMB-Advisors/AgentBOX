"""Sales Persona Job 1.3 — Content Engine (channel-namespaced).

Generalizes the blog learning loop (``tools/blog_learning.py``) across the CPG
content channels — blog, X, email, Instagram, TikTok — so brand/product
storytelling is drafted, reviewed, and *learned from* the same way on every
channel. The blog channel remains the done reference (it has its own
auto-publish-detecting loop in ``blog_learning``); this module covers the
channels that have no publish-state API, where the human verdict is recorded
explicitly through the L0 draft-and-approve gate.

What it adds over ``blog_learning``:
- **Channel dimension.** Drafts/lessons/digests live under
  ``$HERMES_HOME/content_engine/<channel>/``.
- **Review folders for non-publishable channels.** Instagram/TikTok drafts are
  written to a ``review/`` folder for the operator (the box cannot post to them).
- **Trust integration.** Every recorded human verdict feeds the shared Job 1.3
  trust counter (``sales_trust.record_outcome("1.3", ...)``), so the Content
  Engine graduates L0 -> L1 -> L2 as the operator stops editing drafts.

Reuses ``blog_learning``'s verified text/gbrain helpers (``edit_magnitude``,
``strip_html``, ``gbrain_capture``) rather than reimplementing them. Pure stdlib;
paths resolve from ``HERMES_HOME`` per call.
"""

from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

JOB_ID = "1.3"
GBRAIN_TAG = "content-editorial-feedback"
CLEAN_MAX_MAGNITUDE = 0.02
_HISTORY_CAP = 20
DIGEST_MAX_LESSONS = 60
DIGEST_RECENT_SHOWN = 12

# channel -> can the box publish it directly? If not, drafts go to a review
# folder for the operator. ``via`` documents the intended publish path.
CHANNELS: Dict[str, Dict[str, Any]] = {
    "blog": {"auto_publish": True, "via": "shopify (handled by blog_learning)"},
    "x": {"auto_publish": True, "via": "xurl / x post"},
    "email": {"auto_publish": False, "via": "send_message draft"},
    "instagram": {"auto_publish": False, "via": "review folder (no API)"},
    "tiktok": {"auto_publish": False, "via": "review folder (no API)"},
}

LESSON_CATEGORIES = [
    "naming", "voice", "hook", "length", "claims/compliance",
    "format", "cta", "hashtags", "visual", "timing",
]


# ---------------------------------------------------------------------------
# Paths (HERMES_HOME-resolved per call; test-overridable)
# ---------------------------------------------------------------------------


def _hermes_home() -> Path:
    return Path(os.getenv("HERMES_HOME") or (Path.home() / ".hermes"))


def base_dir() -> Path:
    return _hermes_home() / "content_engine"


def channel_dir(channel: str) -> Path:
    return base_dir() / _safe(channel)


def drafts_dir(channel: str) -> Path:
    return channel_dir(channel) / "drafts"


def lessons_dir(channel: str) -> Path:
    return channel_dir(channel) / "lessons"


def review_dir(channel: str) -> Path:
    return channel_dir(channel) / "review"


def digest_path(channel: str) -> Path:
    return channel_dir(channel) / "house-style.md"


def index_path(channel: str) -> Path:
    return lessons_dir(channel) / "index.jsonl"


def _safe(value: str) -> str:
    return re.sub(r"[^a-z0-9_-]+", "-", str(value).lower()).strip("-") or "unknown"


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat()


def _today() -> str:
    return datetime.now().astimezone().strftime("%Y-%m-%d")


def validate_channel(channel: str) -> Optional[str]:
    if channel not in CHANNELS:
        return f"Unknown channel {channel!r}. Valid: {', '.join(CHANNELS)}"
    return None


# ---------------------------------------------------------------------------
# Reused blog-loop helpers (single source of truth)
# ---------------------------------------------------------------------------


def _blog():
    from tools import blog_learning
    return blog_learning


def edit_magnitude(a: str, b: str) -> float:
    return _blog().edit_magnitude(a, b)


def strip_text(value: Optional[str]) -> str:
    return _blog().strip_html(value)


def gbrain_capture(path: Path) -> Dict[str, Any]:
    return _blog().gbrain_capture(path)


# ---------------------------------------------------------------------------
# Drafts
# ---------------------------------------------------------------------------


def save_draft(
    channel: str,
    content_id: str,
    body: str,
    *,
    title: str = "",
    topic: Optional[str] = None,
    theme: Optional[str] = None,
    model: Optional[str] = None,
) -> Dict[str, Any]:
    """Persist an AI content draft (status=pending). For channels the box cannot
    publish, also writes the draft to a ``review/`` file for the operator."""
    err = validate_channel(channel)
    if err:
        raise ValueError(err)
    drafts_dir(channel).mkdir(parents=True, exist_ok=True)
    cid = _safe(content_id)
    record = {
        "content_id": cid,
        "channel": channel,
        "created_at": _now_iso(),
        "title": title,
        "topic": topic,
        "theme": theme,
        "model": model,
        "original_body": body,
        "status": "pending",  # pending | processed | rejected
    }
    (drafts_dir(channel) / f"{cid}.json").write_text(
        json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    review_file = None
    if not CHANNELS[channel]["auto_publish"]:
        review_dir(channel).mkdir(parents=True, exist_ok=True)
        review_file = review_dir(channel) / f"{cid}.md"
        header = f"# [{channel}] {title or topic or cid}\n\n_Draft for human review — not auto-published._\n\n"
        review_file.write_text(header + body + "\n", encoding="utf-8")
    return {
        "content_id": cid,
        "channel": channel,
        "review_path": str(review_file) if review_file else None,
        "trust_header": _trust_header(),
    }


def load_draft(channel: str, content_id: str) -> Optional[Dict[str, Any]]:
    p = drafts_dir(channel) / f"{_safe(content_id)}.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _set_status(channel: str, content_id: str, status: str, **extra: Any) -> None:
    rec = load_draft(channel, content_id)
    if rec is None:
        return
    rec["status"] = status
    rec.update(extra)
    (drafts_dir(channel) / f"{_safe(content_id)}.json").write_text(
        json.dumps(rec, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def list_pending(channel: Optional[str] = None) -> List[Dict[str, Any]]:
    channels = [channel] if channel else list(CHANNELS)
    out: List[Dict[str, Any]] = []
    for ch in channels:
        d = drafts_dir(ch)
        if not d.exists():
            continue
        for p in sorted(d.glob("*.json")):
            try:
                rec = json.loads(p.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if rec.get("status") == "pending":
                out.append({
                    "content_id": rec.get("content_id"),
                    "channel": rec.get("channel"),
                    "title": rec.get("title"),
                    "topic": rec.get("topic"),
                    "created_at": rec.get("created_at"),
                })
    return out


# ---------------------------------------------------------------------------
# Lessons + per-channel digest
# ---------------------------------------------------------------------------


def _write_lesson(channel: str, lesson: Dict[str, Any]) -> Path:
    lessons_dir(channel).mkdir(parents=True, exist_ok=True)
    date = _today()
    cat = _safe(lesson.get("category", "general"))
    base = f"{date}-{cat}"
    p = lessons_dir(channel) / f"{base}.md"
    i = 2
    while p.exists():
        p = lessons_dir(channel) / f"{base}-{i}.md"
        i += 1
    fm = {
        "type": GBRAIN_TAG,
        "channel": channel,
        "date": date,
        "category": lesson.get("category", "general"),
        "tags": [GBRAIN_TAG, f"channel-{channel}", cat],
    }
    lines = ["---"]
    lines += [f"{k}: {json.dumps(v, ensure_ascii=False)}" for k, v in fm.items()]
    lines += ["---", "", f"# {channel} content lesson — {lesson.get('category', 'general')}", ""]
    for label, key in (("Rule", "rule"), ("Observation", "observation"),
                       ("Before (AI)", "before"), ("After (human)", "after")):
        if lesson.get(key):
            lines += [f"**{label}:** {lesson[key]}", ""]
    p.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    with index_path(channel).open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({
            "date": date,
            "channel": channel,
            "category": lesson.get("category", "general"),
            "rule": lesson.get("rule", ""),
            "edit_magnitude": lesson.get("edit_magnitude"),
            "file": p.name,
        }, ensure_ascii=False) + "\n")
    return p


def _read_index(channel: str) -> List[Dict[str, Any]]:
    p = index_path(channel)
    if not p.exists():
        return []
    out = []
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


def refresh_digest(channel: str) -> Path:
    lessons = _read_index(channel)[-DIGEST_MAX_LESSONS:]
    counts: Dict[tuple, Dict[str, Any]] = {}
    for ls in lessons:
        rule = (ls.get("rule") or "").strip()
        if not rule:
            continue
        key = (ls.get("category", "general"), rule.lower())
        slot = counts.setdefault(key, {"category": ls.get("category", "general"), "rule": rule, "n": 0})
        slot["n"] += 1
    recurring = sorted(counts.values(), key=lambda s: s["n"], reverse=True)
    out = [
        f"# YES! {channel.title()} Content House-Style",
        "",
        f"_Auto-generated from {len(lessons)} recent {channel} lesson(s) on {_today()}._",
        "",
        "## Recurring rules (apply every time)",
        "",
    ]
    top = [r for r in recurring if r["n"] >= 2] or recurring[:8]
    if top:
        out += [f"- [{r['category']}{(' x' + str(r['n'])) if r['n'] > 1 else ''}] {r['rule']}" for r in top[:15]]
    else:
        out.append("- _(no recurring rules yet — learning in progress)_")
    out += ["", "## Recent lessons", ""]
    recent = list(reversed(lessons))[:DIGEST_RECENT_SHOWN]
    out += [f"- ({ls.get('date')}, {ls.get('category')}) {ls.get('rule')}" for ls in recent] or ["- _(none yet)_"]
    channel_dir(channel).mkdir(parents=True, exist_ok=True)
    digest_path(channel).write_text("\n".join(out) + "\n", encoding="utf-8")
    return digest_path(channel)


def house_style(channel: str) -> str:
    p = digest_path(channel)
    return p.read_text(encoding="utf-8") if p.exists() else ""


# ---------------------------------------------------------------------------
# Outcome — the L0-gate verdict; feeds lessons + the Job 1.3 trust counter
# ---------------------------------------------------------------------------


def _trust_header() -> str:
    try:
        from tools import sales_trust
        return sales_trust.trust_header(JOB_ID)
    except Exception:  # noqa: BLE001
        return "Trust: (unavailable)"


def record_outcome(
    channel: str,
    content_id: str,
    ai_draft: str,
    human_final: str = "",
    *,
    rejected: bool = False,
    structural_change: bool = False,
    lessons: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Record the human verdict on a drafted piece. Writes channel lessons to
    gbrain + the per-channel digest, marks the draft done, and feeds the shared
    Job 1.3 trust counter."""
    err = validate_channel(channel)
    if err:
        raise ValueError(err)
    magnitude = None if rejected else edit_magnitude(ai_draft, human_final)
    clean = (not rejected) and (magnitude is not None) and (magnitude <= CLEAN_MAX_MAGNITUDE) and not structural_change

    written: List[str] = []
    gbrain_ok = 0
    for lesson in (lessons or []):
        if not isinstance(lesson, dict):
            continue
        if lesson.get("edit_magnitude") is None and magnitude is not None:
            lesson["edit_magnitude"] = magnitude
        try:
            p = _write_lesson(channel, lesson)
        except Exception as e:  # noqa: BLE001
            logger.error("content_engine _write_lesson failed: %s", e)
            continue
        written.append(p.name)
        if gbrain_capture(p).get("ok"):
            gbrain_ok += 1
    if written:
        try:
            refresh_digest(channel)
        except Exception as e:  # noqa: BLE001
            logger.error("content_engine refresh_digest failed: %s", e)

    status = "rejected" if rejected else "processed"
    _set_status(channel, content_id, status, processed_at=_now_iso(),
                edit_magnitude=magnitude, clean=clean, lessons_count=len(written))

    trust = None
    try:
        from tools import sales_trust
        trust = sales_trust.record_outcome(
            JOB_ID, magnitude=(magnitude if magnitude is not None else 0.0),
            structural_change=structural_change, rejected=rejected,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("content_engine sales_trust update skipped: %s", e)

    return {
        "channel": channel,
        "content_id": _safe(content_id),
        "status": status,
        "clean": clean,
        "edit_magnitude": magnitude,
        "lessons_recorded": len(written),
        "gbrain_ok": gbrain_ok,
        "trust_header": _trust_header(),
        "trust_level": (trust or {}).get("level"),
    }


# ---------------------------------------------------------------------------
# Tool handlers
# ---------------------------------------------------------------------------


def _handle_save_draft(args: dict, **kw) -> str:
    channel = (args.get("channel") or "").strip()
    content_id = (args.get("content_id") or "").strip()
    body = args.get("body") or ""
    if validate_channel(channel):
        return tool_error(validate_channel(channel))
    if not content_id:
        return tool_error("Missing required parameter: content_id")
    if not body:
        return tool_error("Missing required parameter: body")
    try:
        return tool_result(save_draft(
            channel, content_id, body,
            title=args.get("title") or "", topic=args.get("topic") or None,
            theme=args.get("theme") or None, model=os.getenv("HERMES_BLOG_MODEL"),
        ))
    except Exception as e:  # noqa: BLE001
        return tool_error(f"Failed to save draft: {e}")


def _handle_list_pending(args: dict, **kw) -> str:
    channel = args.get("channel") or None
    if channel and validate_channel(channel):
        return tool_error(validate_channel(channel))
    items = list_pending(channel)
    return tool_result({"count": len(items), "pending": items})


def _handle_record_outcome(args: dict, **kw) -> str:
    channel = (args.get("channel") or "").strip()
    content_id = (args.get("content_id") or "").strip()
    if validate_channel(channel):
        return tool_error(validate_channel(channel))
    if not content_id:
        return tool_error("Missing required parameter: content_id")
    if load_draft(channel, content_id) is None:
        return tool_error(f"No draft for {channel}/{content_id}")
    try:
        return tool_result(record_outcome(
            channel, content_id,
            ai_draft=args.get("ai_draft") or "",
            human_final=args.get("human_final") or "",
            rejected=bool(args.get("rejected", False)),
            structural_change=bool(args.get("structural_change", False)),
            lessons=args.get("lessons") or [],
        ))
    except Exception as e:  # noqa: BLE001
        return tool_error(f"Failed to record outcome: {e}")


def _handle_house_style(args: dict, **kw) -> str:
    channel = (args.get("channel") or "").strip()
    if validate_channel(channel):
        return tool_error(validate_channel(channel))
    return tool_result({"channel": channel, "house_style": house_style(channel)})


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

_CHANNEL_ENUM = list(CHANNELS)

SAVE_DRAFT_SCHEMA = {
    "name": "save_content_draft",
    "description": (
        "Persist an AI-written content draft for a channel (blog, x, email, "
        "instagram, tiktok) as an unsent artifact for human review. For channels "
        "the box cannot publish (instagram/tiktok/email) the draft is also "
        "written to a review folder. Returns the trust header."
    ),
    "parameters": {"type": "object", "properties": {
        "channel": {"type": "string", "enum": _CHANNEL_ENUM},
        "content_id": {"type": "string", "description": "Stable id for this piece (e.g. a slug or campaign-date key)."},
        "body": {"type": "string", "description": "The drafted content (caption/post/email body)."},
        "title": {"type": "string"},
        "topic": {"type": "string"},
        "theme": {"type": "string"},
    }, "required": ["channel", "content_id", "body"]},
}

LIST_PENDING_SCHEMA = {
    "name": "list_pending_content",
    "description": "List content drafts awaiting a human verdict, optionally filtered to one channel.",
    "parameters": {"type": "object", "properties": {
        "channel": {"type": "string", "enum": _CHANNEL_ENUM},
    }},
}

RECORD_OUTCOME_SCHEMA = {
    "name": "record_content_outcome",
    "description": (
        "Record the human verdict on a content draft (approved/edited/rejected). "
        "Writes channel editorial lessons to gbrain + the house-style digest and "
        "feeds the shared Content Engine (Job 1.3) trust counter. Pass the AI's "
        "original text and the human-final text so the edit magnitude is scored."
    ),
    "parameters": {"type": "object", "properties": {
        "channel": {"type": "string", "enum": _CHANNEL_ENUM},
        "content_id": {"type": "string"},
        "ai_draft": {"type": "string", "description": "The AI's original drafted text."},
        "human_final": {"type": "string", "description": "The human-approved final text (omit if rejected)."},
        "rejected": {"type": "boolean", "description": "True if the human rejected the draft outright."},
        "structural_change": {"type": "boolean", "description": "True for a strategy/positioning/claim change (material regardless of text magnitude)."},
        "lessons": {"type": "array", "description": "Generalizable editorial lessons from the edits (empty for clean approvals).", "items": {"type": "object", "properties": {
            "category": {"type": "string", "description": "One of: " + ", ".join(LESSON_CATEGORIES)},
            "observation": {"type": "string"},
            "rule": {"type": "string"},
            "before": {"type": "string"},
            "after": {"type": "string"},
        }, "required": ["category", "rule"]}},
    }, "required": ["channel", "content_id"]},
}

HOUSE_STYLE_SCHEMA = {
    "name": "content_house_style",
    "description": "Read a channel's learned house-style digest (recurring editorial rules) to apply when drafting.",
    "parameters": {"type": "object", "properties": {
        "channel": {"type": "string", "enum": _CHANNEL_ENUM},
    }, "required": ["channel"]},
}


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------

from tools.registry import registry, tool_error, tool_result  # noqa: E402

for _name, _schema, _handler, _emoji in [
    ("save_content_draft", SAVE_DRAFT_SCHEMA, _handle_save_draft, "✍️"),
    ("list_pending_content", LIST_PENDING_SCHEMA, _handle_list_pending, "📋"),
    ("record_content_outcome", RECORD_OUTCOME_SCHEMA, _handle_record_outcome, "🎓"),
    ("content_house_style", HOUSE_STYLE_SCHEMA, _handle_house_style, "🎨"),
]:
    registry.register(name=_name, toolset="content", schema=_schema, handler=_handler, emoji=_emoji)
