"""Sales Persona Job 2.3 — Speed-to-Lead.

Instant response to inbound wholesale inquiries / DMs: qualify, draft a reply,
and either book the call or hand off to a human — fast. Speed is the whole value,
so this runs on a 5-minute backstop cron over a decoupled **inquiry queue**.

Design choice (see build-plan §6.4 + the gateway scout): rather than patch the
live gateway ``_handle_message`` (invasive on a heavily-customized prod box), an
**inbound source adapter** writes inquiries into a queue
(``$HERMES_HOME/speed_to_lead/inbox/<inquiry_id>.json``) via ``record_inquiry``,
and the cron agent drains it. Any source — a future gateway hook, a Gmail
poller, or a manual drop — can fill the queue; the source adapter is deliberately
pluggable and not yet wired (it needs a verified inbound API + the operator's OK
to touch the live gateway).

Everything stays L0 draft-and-approve: the agent drafts the reply; a human
approves before anything sends. Verdicts feed the shared Job 2.3 trust counter
(category "sends": N=20, L2 gated behind explicit authorization).

Idempotency: an inquiry is keyed by its source-provided ``inquiry_id``
(e.g. a Gmail message id or ``platform:chat_id:message_id``) so it is never
handled twice. Reuses ``blog_learning.gbrain_capture`` + the ``sales_trust``
counter. Pure stdlib; paths resolve from ``HERMES_HOME`` per call.
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

JOB_ID = "2.3"
GBRAIN_TAG = "speed-to-lead-feedback"
ACTIONS = ["book_call", "handoff", "reply", "disqualify"]
STATUSES = ["new", "drafted", "handled", "rejected"]


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------


def _hermes_home() -> Path:
    return Path(os.getenv("HERMES_HOME") or (Path.home() / ".hermes"))


def base_dir() -> Path:
    return _hermes_home() / "speed_to_lead"


def inbox_dir() -> Path:
    return base_dir() / "inbox"


def review_dir() -> Path:
    return base_dir() / "review"


def lessons_index() -> Path:
    return base_dir() / "lessons.jsonl"


def playbook_path() -> Path:
    return base_dir() / "playbook.md"


def learned_path() -> Path:
    return base_dir() / "playbook-learned.md"


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(value).lower()).strip("-") or "inquiry"


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat()


# ---------------------------------------------------------------------------
# Reused helpers
# ---------------------------------------------------------------------------


def _gbrain_capture(path: Path) -> Dict[str, Any]:
    from tools.blog_learning import gbrain_capture
    return gbrain_capture(path)


def _trust_header() -> str:
    try:
        from tools import sales_trust
        return sales_trust.trust_header(JOB_ID)
    except Exception:  # noqa: BLE001
        return "Trust: (unavailable)"


# ---------------------------------------------------------------------------
# Inquiry queue (idempotent by inquiry_id)
# ---------------------------------------------------------------------------


def _inquiry_path(inquiry_id: str) -> Path:
    return inbox_dir() / f"{_slug(inquiry_id)}.json"


def record_inquiry(
    inquiry_id: str,
    *,
    source: str = "",
    sender: str = "",
    subject: str = "",
    body: str = "",
) -> Dict[str, Any]:
    """Source-adapter entry point: enqueue an inbound inquiry. Idempotent — a
    second call with the same ``inquiry_id`` is a no-op (returns already_seen)."""
    inbox_dir().mkdir(parents=True, exist_ok=True)
    p = _inquiry_path(inquiry_id)
    if p.exists():
        return {"inquiry_id": _slug(inquiry_id), "already_seen": True}
    record = {
        "inquiry_id": _slug(inquiry_id),
        "raw_id": inquiry_id,
        "source": source,
        "sender": sender,
        "subject": subject,
        "body": body,
        "status": "new",
        "received_at": _now_iso(),
    }
    p.write_text(json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8")
    return {"inquiry_id": record["inquiry_id"], "already_seen": False}


def load_inquiry(inquiry_id: str) -> Optional[Dict[str, Any]]:
    p = _inquiry_path(inquiry_id)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _save_inquiry(rec: Dict[str, Any]) -> None:
    inbox_dir().mkdir(parents=True, exist_ok=True)
    _inquiry_path(rec["inquiry_id"]).write_text(
        json.dumps(rec, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def list_pending() -> List[Dict[str, Any]]:
    d = inbox_dir()
    if not d.exists():
        return []
    out = []
    for p in sorted(d.glob("*.json")):
        try:
            rec = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if rec.get("status") in ("new", "drafted"):
            out.append(rec)
    return out


# ---------------------------------------------------------------------------
# Playbook (qualification rubric)
# ---------------------------------------------------------------------------


def get_playbook() -> str:
    parts = []
    for p in (playbook_path(), learned_path()):
        if p.exists():
            try:
                parts.append(p.read_text(encoding="utf-8").strip())
            except OSError:
                pass
    return "\n\n".join(x for x in parts if x)


# ---------------------------------------------------------------------------
# Draft + outcome
# ---------------------------------------------------------------------------


def draft_response(
    inquiry_id: str,
    reply_draft: str,
    *,
    qualification: str = "",
    recommended_action: str = "reply",
) -> Dict[str, Any]:
    """Store a drafted reply + qualification for an inquiry (L0 — unsent). Writes
    a review file the operator approves before anything is sent."""
    rec = load_inquiry(inquiry_id)
    if rec is None:
        raise ValueError(f"No inquiry {inquiry_id!r}")
    if recommended_action not in ACTIONS:
        raise ValueError(f"recommended_action must be one of {ACTIONS}")
    rec["status"] = "drafted"
    rec["reply_draft"] = reply_draft
    rec["qualification"] = qualification
    rec["recommended_action"] = recommended_action
    rec["drafted_at"] = _now_iso()
    _save_inquiry(rec)
    review_dir().mkdir(parents=True, exist_ok=True)
    review_file = review_dir() / f"{rec['inquiry_id']}.md"
    review_file.write_text(
        f"# Speed-to-Lead draft — {rec.get('subject') or rec['inquiry_id']}\n\n"
        f"_From: {rec.get('sender')} | source: {rec.get('source')} | "
        f"action: {recommended_action}_\n\n"
        f"## Inbound\n{rec.get('body', '')}\n\n"
        f"## Qualification\n{qualification}\n\n"
        f"## Drafted reply (unsent — approve before sending)\n{reply_draft}\n",
        encoding="utf-8",
    )
    return {
        "inquiry_id": rec["inquiry_id"],
        "status": "drafted",
        "recommended_action": recommended_action,
        "review_path": str(review_file),
        "trust_header": _trust_header(),
    }


def record_outcome(
    inquiry_id: str,
    *,
    ai_draft: str = "",
    human_final: str = "",
    rejected: bool = False,
    structural_change: bool = False,
    lessons: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Record the human verdict on a drafted lead reply. Feeds the Job 2.3 trust
    counter and captures any qualification/voice lessons to gbrain. If ``ai_draft``
    is omitted, the stored draft is used."""
    rec = load_inquiry(inquiry_id)
    if rec is None:
        raise ValueError(f"No inquiry {inquiry_id!r}")
    ai_draft = ai_draft or rec.get("reply_draft", "")

    magnitude = None
    if not rejected:
        from tools.blog_learning import edit_magnitude
        magnitude = edit_magnitude(ai_draft, human_final or ai_draft)
    clean = (not rejected) and (magnitude is not None) and (magnitude <= 0.02) and not structural_change

    written = 0
    gbrain_ok = 0
    base_dir().mkdir(parents=True, exist_ok=True)
    for lesson in (lessons or []):
        if not isinstance(lesson, dict):
            continue
        date = datetime.now().astimezone().strftime("%Y-%m-%d")
        cat = _slug(lesson.get("category", "qualification"))
        lf = base_dir() / f"lesson-{date}-{cat}-{written}.md"
        body = (
            f"---\ntype: {GBRAIN_TAG}\ndate: {date}\n"
            f"category: {json.dumps(lesson.get('category', 'qualification'))}\n"
            f"tags: {json.dumps([GBRAIN_TAG, cat])}\n---\n\n"
            f"# Speed-to-lead lesson — {lesson.get('category', 'qualification')}\n\n"
            f"**Rule:** {lesson.get('rule', '')}\n"
        )
        try:
            lf.write_text(body, encoding="utf-8")
        except OSError:
            continue
        written += 1
        with lessons_index().open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({"date": date, "category": lesson.get("category", "qualification"),
                                 "rule": lesson.get("rule", ""), "file": lf.name}, ensure_ascii=False) + "\n")
        if _gbrain_capture(lf).get("ok"):
            gbrain_ok += 1

    rec["status"] = "rejected" if rejected else "handled"
    rec["resolved_at"] = _now_iso()
    rec["clean"] = clean
    _save_inquiry(rec)

    trust = None
    try:
        from tools import sales_trust
        trust = sales_trust.record_outcome(
            JOB_ID, magnitude=(magnitude if magnitude is not None else 0.0),
            structural_change=structural_change, rejected=rejected,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("speed_to_lead sales_trust update skipped: %s", e)

    return {
        "inquiry_id": rec["inquiry_id"],
        "status": rec["status"],
        "clean": clean,
        "lessons_recorded": written,
        "gbrain_ok": gbrain_ok,
        "trust_header": _trust_header(),
        "trust_level": (trust or {}).get("level"),
    }


# ---------------------------------------------------------------------------
# Tool handlers
# ---------------------------------------------------------------------------


def _handle_record_inquiry(args: dict, **kw) -> str:
    iid = (args.get("inquiry_id") or "").strip()
    if not iid:
        return tool_error("Missing required parameter: inquiry_id")
    return tool_result(record_inquiry(
        iid, source=args.get("source") or "", sender=args.get("sender") or "",
        subject=args.get("subject") or "", body=args.get("body") or "",
    ))


def _handle_list_pending(args: dict, **kw) -> str:
    rows = list_pending()
    return tool_result({"count": len(rows), "pending": rows})


def _handle_get_playbook(args: dict, **kw) -> str:
    return tool_result({"playbook": get_playbook()})


def _handle_draft(args: dict, **kw) -> str:
    iid = (args.get("inquiry_id") or "").strip()
    if not iid:
        return tool_error("Missing required parameter: inquiry_id")
    if not (args.get("reply_draft") or "").strip():
        return tool_error("Missing required parameter: reply_draft")
    if load_inquiry(iid) is None:
        return tool_error(f"No inquiry {iid!r}")
    try:
        return tool_result(draft_response(
            iid, args.get("reply_draft"),
            qualification=args.get("qualification") or "",
            recommended_action=args.get("recommended_action") or "reply",
        ))
    except Exception as e:  # noqa: BLE001
        return tool_error(f"Failed to draft response: {e}")


def _handle_record_outcome(args: dict, **kw) -> str:
    iid = (args.get("inquiry_id") or "").strip()
    if not iid:
        return tool_error("Missing required parameter: inquiry_id")
    if load_inquiry(iid) is None:
        return tool_error(f"No inquiry {iid!r}")
    try:
        return tool_result(record_outcome(
            iid, ai_draft=args.get("ai_draft") or "",
            human_final=args.get("human_final") or "",
            rejected=bool(args.get("rejected", False)),
            structural_change=bool(args.get("structural_change", False)),
            lessons=args.get("lessons") or [],
        ))
    except Exception as e:  # noqa: BLE001
        return tool_error(f"Failed to record outcome: {e}")


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

RECORD_INQUIRY_SCHEMA = {
    "name": "record_inquiry",
    "description": (
        "Enqueue an inbound wholesale inquiry / DM for Speed-to-Lead handling. "
        "Idempotent by inquiry_id (a second call with the same id is a no-op). "
        "Called by an inbound source adapter (gateway hook / mail poller / manual)."
    ),
    "parameters": {"type": "object", "properties": {
        "inquiry_id": {"type": "string", "description": "Stable unique id, e.g. a mail message id or platform:chat:message."},
        "source": {"type": "string", "description": "e.g. email, instagram_dm, x_dm, web_form."},
        "sender": {"type": "string"},
        "subject": {"type": "string"},
        "body": {"type": "string"},
    }, "required": ["inquiry_id"]},
}

LIST_PENDING_SCHEMA = {
    "name": "list_pending_inquiries",
    "description": "List inbound inquiries awaiting a Speed-to-Lead response (status new or drafted).",
    "parameters": {"type": "object", "properties": {}},
}

GET_PLAYBOOK_SCHEMA = {
    "name": "get_qualification_playbook",
    "description": "Read the Speed-to-Lead qualification playbook (rubric + learned refinements) to apply when qualifying an inquiry.",
    "parameters": {"type": "object", "properties": {}},
}

DRAFT_SCHEMA = {
    "name": "draft_lead_response",
    "description": (
        "Store a DRAFT reply + qualification for an inbound inquiry (unsent — a "
        "human approves before sending). recommended_action is one of: book_call, "
        "handoff, reply, disqualify."
    ),
    "parameters": {"type": "object", "properties": {
        "inquiry_id": {"type": "string"},
        "reply_draft": {"type": "string", "description": "The drafted reply text (unsent)."},
        "qualification": {"type": "string", "description": "Fit assessment against the playbook."},
        "recommended_action": {"type": "string", "enum": ACTIONS},
    }, "required": ["inquiry_id", "reply_draft"]},
}

RECORD_OUTCOME_SCHEMA = {
    "name": "record_lead_outcome",
    "description": (
        "Record the human verdict on a drafted lead reply (approved/edited/"
        "rejected). Feeds the Job 2.3 trust counter and captures qualification/"
        "voice lessons to gbrain. Pass the human-final text if edited."
    ),
    "parameters": {"type": "object", "properties": {
        "inquiry_id": {"type": "string"},
        "ai_draft": {"type": "string", "description": "AI's drafted reply (defaults to the stored draft)."},
        "human_final": {"type": "string", "description": "Human-approved final text (omit if rejected)."},
        "rejected": {"type": "boolean"},
        "structural_change": {"type": "boolean", "description": "True for a qualification/strategy change (material regardless of wording)."},
        "lessons": {"type": "array", "items": {"type": "object", "properties": {
            "category": {"type": "string", "description": "e.g. qualification, voice, booking, disqualifier"},
            "rule": {"type": "string"},
        }, "required": ["category", "rule"]}},
    }, "required": ["inquiry_id"]},
}


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------

from tools.registry import registry, tool_error, tool_result  # noqa: E402

for _name, _schema, _handler, _emoji in [
    ("record_inquiry", RECORD_INQUIRY_SCHEMA, _handle_record_inquiry, "📨"),
    ("list_pending_inquiries", LIST_PENDING_SCHEMA, _handle_list_pending, "📋"),
    ("get_qualification_playbook", GET_PLAYBOOK_SCHEMA, _handle_get_playbook, "🧭"),
    ("draft_lead_response", DRAFT_SCHEMA, _handle_draft, "✍️"),
    ("record_lead_outcome", RECORD_OUTCOME_SCHEMA, _handle_record_outcome, "🎓"),
]:
    registry.register(name=_name, toolset="speed_to_lead", schema=_schema, handler=_handler, emoji=_emoji)
