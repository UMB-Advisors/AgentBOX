"""Sales Persona Job 2.2 — Outbound Sequencing.

Email-first, multi-touch cadence that DRAFTS personalized outreach at scale for
the scored accounts produced by Job 2.1 (Lead Enrichment), maintains a reply
queue for humans, and feeds the shared Job 2.2 trust counter so sequencing
graduates L0 -> L1 -> L2 as the operator stops correcting it.

Same loop shape as the enrichment / speed-to-lead engines: the agent does the
personalization, this module stores the sequence + per-step drafts, learns from
how the human edits each step, and advances the trust counter (category "sends":
N=20, L2 gated behind explicit authorization — reputation/money-critical, so
graduation is deliberately slow).

**Sends are DISABLED.** The operator has not granted Gmail send consent, so every
step produces an UNSENT draft artifact under ``$HERMES_HOME/outbound/`` for human
approval. Live send-wiring (Gmail drafts/API) is a documented TODO — nothing here
sends, publishes, or spends.

**LinkedIn channel is OFF** behind an explicit ``allow_linkedin`` flag. Even when
flagged on, this module only stores a manual-task note for a human — there is no
browser-automation code and never will be in this module.

Consumes scored accounts via ``tools.enrichment_tools.list_scored`` (lazy import,
best-effort — a missing enrichment store must not break enrollment). Reuses
``blog_learning``'s gbrain + edit-magnitude helpers and the ``sales_trust``
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

JOB_ID = "2.2"
GBRAIN_TAG = "outbound-sequencing-feedback"

# Allowed outreach channels. email is the only live-drafting channel; linkedin is
# gated behind allow_linkedin and only ever produces a manual-task note.
CHANNELS = ["email", "linkedin"]
# Default email-first cadence (step number -> channel + intent). The agent fills
# the copy per-step; this is the spine.
DEFAULT_CADENCE = [
    {"step": 1, "channel": "email", "intent": "intro", "wait_days": 0},
    {"step": 2, "channel": "email", "intent": "value", "wait_days": 3},
    {"step": 3, "channel": "email", "intent": "case_study", "wait_days": 4},
    {"step": 4, "channel": "email", "intent": "breakup", "wait_days": 5},
]
SEQ_STATUSES = ["active", "replied", "completed", "stopped"]
STEP_STATUSES = ["pending", "drafted", "approved", "rejected"]
REPLY_DISPOSITIONS = ["interested", "not_now", "not_interested", "referral", "ooo"]


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------


def _hermes_home() -> Path:
    return Path(os.getenv("HERMES_HOME") or (Path.home() / ".hermes"))


def base_dir() -> Path:
    return _hermes_home() / "outbound"


def sequences_dir() -> Path:
    return base_dir() / "sequences"


def drafts_dir() -> Path:
    # Per-step UNSENT draft artifacts the operator reviews/approves.
    return base_dir() / "drafts"


def replies_dir() -> Path:
    return base_dir() / "replies"


def lessons_index() -> Path:
    return base_dir() / "lessons.jsonl"


def playbook_path() -> Path:
    return base_dir() / "playbook.md"


def learned_path() -> Path:
    return base_dir() / "playbook-learned.md"


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(value).lower()).strip("-") or "account"


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat()


def _today() -> str:
    return datetime.now().astimezone().strftime("%Y-%m-%d")


# ---------------------------------------------------------------------------
# Reused helpers
# ---------------------------------------------------------------------------


def _gbrain_capture(path: Path) -> Dict[str, Any]:
    from tools.blog_learning import gbrain_capture
    return gbrain_capture(path)


def _edit_magnitude(a: str, b: str) -> float:
    from tools.blog_learning import edit_magnitude
    return edit_magnitude(a, b)


def _trust_header() -> str:
    try:
        from tools import sales_trust
        return sales_trust.trust_header(JOB_ID)
    except Exception:  # noqa: BLE001
        return "Trust: (unavailable)"


def _lookup_scored_account(account_id: str) -> Optional[Dict[str, Any]]:
    """Best-effort pull of a scored account from Job 2.1's enrichment store.

    Lazy import + swallow everything: a missing/empty enrichment store must never
    break enrollment (the operator may enroll an account by hand).
    """
    try:
        from tools import enrichment_tools
    except Exception:  # noqa: BLE001
        return None
    try:
        for row in enrichment_tools.list_scored(limit=1000):
            if row.get("account_id") == _slug(account_id):
                return row
    except Exception as e:  # noqa: BLE001
        logger.debug("outbound enrichment lookup skipped: %s", e)
    return None


# ---------------------------------------------------------------------------
# Sequences (one per enrolled account)
# ---------------------------------------------------------------------------


def _sequence_path(account_id: str) -> Path:
    return sequences_dir() / f"{_slug(account_id)}.json"


def load_sequence(account_id: str) -> Optional[Dict[str, Any]]:
    p = _sequence_path(account_id)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _save_sequence(rec: Dict[str, Any]) -> None:
    sequences_dir().mkdir(parents=True, exist_ok=True)
    _sequence_path(rec["account_id"]).write_text(
        json.dumps(rec, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def enroll_account(
    account_id: str,
    *,
    name: str = "",
    contact_email: str = "",
    cadence: Optional[List[Dict[str, Any]]] = None,
    allow_linkedin: bool = False,
    notes: str = "",
) -> Dict[str, Any]:
    """Enroll a (scored) account into the email-first cadence. Idempotent — a
    second call for the same account is a no-op (returns already_enrolled).

    Pulls firmographics from the Job 2.1 enrichment store when available so the
    agent can personalize; falls back to whatever the caller passes. LinkedIn
    steps are stripped from the cadence unless ``allow_linkedin`` is True (and even
    then only ever produce a manual-task note — no automation)."""
    aid = _slug(account_id)
    p = _sequence_path(aid)
    if p.exists():
        return {"account_id": aid, "already_enrolled": True}

    scored = _lookup_scored_account(aid)
    steps_spec = cadence or DEFAULT_CADENCE
    steps: List[Dict[str, Any]] = []
    for spec in steps_spec:
        ch = spec.get("channel", "email")
        if ch not in CHANNELS:
            raise ValueError(f"channel must be one of {CHANNELS}")
        if ch == "linkedin" and not allow_linkedin:
            continue  # LinkedIn OFF by default — drop the step entirely.
        steps.append({
            "step": int(spec.get("step", len(steps) + 1)),
            "channel": ch,
            "intent": spec.get("intent", ""),
            "wait_days": int(spec.get("wait_days", 0)),
            "status": "pending",
        })

    record = {
        "account_id": aid,
        "name": name or (scored or {}).get("name", "") or aid,
        "contact_email": contact_email,  # email-first; no contact PII harvested here
        "allow_linkedin": bool(allow_linkedin),
        "firmographics": (scored or {}).get("firmographics", {}),
        "fit_score": (scored or {}).get("fit_score"),
        "tier": (scored or {}).get("tier"),
        "from_enrichment": scored is not None,
        "notes": notes,
        "status": "active",
        "steps": steps,
        "enrolled_at": _now_iso(),
    }
    _save_sequence(record)
    return {
        "account_id": aid,
        "already_enrolled": False,
        "from_enrichment": scored is not None,
        "steps": len(steps),
        "trust_header": _trust_header(),
    }


def list_sequences(status: Optional[str] = None, limit: int = 200) -> List[Dict[str, Any]]:
    d = sequences_dir()
    if not d.exists():
        return []
    out: List[Dict[str, Any]] = []
    for p in sorted(d.glob("*.json")):
        try:
            rec = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if status and rec.get("status") != status:
            continue
        out.append(rec)
    return out[:limit]


def _get_step(seq: Dict[str, Any], step: int) -> Optional[Dict[str, Any]]:
    for s in seq.get("steps", []):
        if int(s.get("step", -1)) == int(step):
            return s
    return None


# ---------------------------------------------------------------------------
# Per-step drafts (UNSENT — sends disabled until Gmail consent)
# ---------------------------------------------------------------------------


def draft_sequence_step(
    account_id: str,
    step: int,
    body: str,
    *,
    subject: str = "",
) -> Dict[str, Any]:
    """Store a personalized DRAFT for one cadence step (L0 — unsent). Writes a
    review artifact under ``$HERMES_HOME/outbound/drafts/`` the operator approves
    before anything is sent. Sends are disabled; live Gmail wiring is a TODO.

    LinkedIn steps are draftable as a manual-task note only (no automation)."""
    seq = load_sequence(account_id)
    if seq is None:
        raise ValueError(f"No enrolled sequence for account {account_id!r}")
    st = _get_step(seq, step)
    if st is None:
        raise ValueError(f"No step {step} in sequence {account_id!r}")
    if not str(body).strip():
        raise ValueError("body must not be empty")

    channel = st.get("channel", "email")
    st["status"] = "drafted"
    st["subject"] = subject
    st["body"] = body
    st["drafted_at"] = _now_iso()
    _save_sequence(seq)

    drafts_dir().mkdir(parents=True, exist_ok=True)
    artifact = drafts_dir() / f"{seq['account_id']}-step{int(step)}.md"
    if channel == "linkedin":
        header = (
            f"# Outbound LinkedIn step {step} (MANUAL TASK — not automated) — "
            f"{seq.get('name') or seq['account_id']}\n\n"
            "_LinkedIn automation is intentionally NOT implemented. This is a note "
            "for a human to action by hand if approved._\n\n"
        )
        delivery_line = f"_channel: linkedin | intent: {st.get('intent')}_\n\n"
    else:
        header = (
            f"# Outbound email step {step} (UNSENT DRAFT — approve before sending) "
            f"— {seq.get('name') or seq['account_id']}\n\n"
        )
        delivery_line = (
            f"_to: {seq.get('contact_email') or '(no email on file)'} | "
            f"intent: {st.get('intent')} | wait_days: {st.get('wait_days')}_\n\n"
        )
    artifact.write_text(
        header
        + delivery_line
        + (f"**Subject:** {subject}\n\n" if subject else "")
        + "## Draft\n"
        + body
        + "\n\n---\n_Sends are disabled until Gmail consent. Live send-wiring is a "
        "documented TODO; nothing is sent automatically._\n",
        encoding="utf-8",
    )
    return {
        "account_id": seq["account_id"],
        "step": int(step),
        "channel": channel,
        "status": "drafted",
        "draft_path": str(artifact),
        "sent": False,
        "trust_header": _trust_header(),
    }


# ---------------------------------------------------------------------------
# Reply queue (humans triage replies; may pause/advance the sequence)
# ---------------------------------------------------------------------------


def _reply_path(reply_id: str) -> Path:
    return replies_dir() / f"{_slug(reply_id)}.json"


def record_reply(
    account_id: str,
    *,
    reply_id: str = "",
    disposition: str = "interested",
    body: str = "",
    received_at: str = "",
) -> Dict[str, Any]:
    """Log a prospect reply into the human reply queue and pause the sequence
    (status=replied) so a human takes it from here. Idempotent by reply_id."""
    seq = load_sequence(account_id)
    if seq is None:
        raise ValueError(f"No enrolled sequence for account {account_id!r}")
    if disposition not in REPLY_DISPOSITIONS:
        raise ValueError(f"disposition must be one of {REPLY_DISPOSITIONS}")
    rid = _slug(reply_id or f"{seq['account_id']}-{_now_iso()}")
    p = _reply_path(rid)
    if p.exists():
        return {"reply_id": rid, "already_seen": True}

    replies_dir().mkdir(parents=True, exist_ok=True)
    record = {
        "reply_id": rid,
        "account_id": seq["account_id"],
        "disposition": disposition,
        "body": body,
        "received_at": received_at or _now_iso(),
        "status": "needs_human",  # reply queue: needs_human until a human handles it
        "logged_at": _now_iso(),
    }
    p.write_text(json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8")

    # A reply pauses the cadence — humans own the conversation from here.
    seq["status"] = "replied"
    seq["last_reply_at"] = record["received_at"]
    _save_sequence(seq)
    return {
        "reply_id": rid,
        "account_id": seq["account_id"],
        "already_seen": False,
        "disposition": disposition,
        "sequence_status": "replied",
        "trust_header": _trust_header(),
    }


def list_replies(status: str = "needs_human", limit: int = 200) -> List[Dict[str, Any]]:
    """The human reply queue (default: replies still needing a human)."""
    d = replies_dir()
    if not d.exists():
        return []
    out: List[Dict[str, Any]] = []
    for p in sorted(d.glob("*.json")):
        try:
            rec = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if status and rec.get("status") != status:
            continue
        out.append(rec)
    return out[:limit]


# ---------------------------------------------------------------------------
# Playbook (cadence + voice rubric)
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
# Outcome — human verdict on a drafted step; feeds the Job 2.2 counter
# ---------------------------------------------------------------------------


def record_sequence_outcome(
    account_id: str,
    step: int,
    *,
    ai_draft: str = "",
    human_final: str = "",
    rejected: bool = False,
    structural_change: bool = False,
    lessons: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Record the human verdict on a drafted cadence step (approved/edited/
    rejected) and advance the Job 2.2 trust counter. Clean = approved AND the edit
    magnitude is below threshold AND not a structural change. If ``ai_draft`` is
    omitted the stored step draft is used. Captures any cadence/voice lessons to
    gbrain (best-effort)."""
    seq = load_sequence(account_id)
    if seq is None:
        raise ValueError(f"No enrolled sequence for account {account_id!r}")
    st = _get_step(seq, step)
    if st is None:
        raise ValueError(f"No step {step} in sequence {account_id!r}")
    ai_draft = ai_draft or st.get("body", "")

    magnitude = None
    if not rejected:
        magnitude = _edit_magnitude(ai_draft, human_final or ai_draft)
    clean = (not rejected) and (magnitude is not None) and (magnitude <= 0.02) and not structural_change

    written = 0
    gbrain_ok = 0
    base_dir().mkdir(parents=True, exist_ok=True)
    for lesson in (lessons or []):
        if not isinstance(lesson, dict):
            continue
        date = _today()
        cat = _slug(lesson.get("category", "cadence"))
        lf = base_dir() / f"lesson-{date}-{cat}-{written}.md"
        body = (
            f"---\ntype: {GBRAIN_TAG}\ndate: {date}\n"
            f"category: {json.dumps(lesson.get('category', 'cadence'))}\n"
            f"tags: {json.dumps([GBRAIN_TAG, cat])}\n---\n\n"
            f"# Outbound-sequencing lesson — {lesson.get('category', 'cadence')}\n\n"
            f"**Rule:** {lesson.get('rule', '')}\n"
        )
        try:
            lf.write_text(body, encoding="utf-8")
        except OSError:
            continue
        written += 1
        try:
            with lessons_index().open("a", encoding="utf-8") as fh:
                fh.write(json.dumps({
                    "date": date, "category": lesson.get("category", "cadence"),
                    "rule": lesson.get("rule", ""), "file": lf.name,
                }, ensure_ascii=False) + "\n")
        except OSError:
            pass
        if _gbrain_capture(lf).get("ok"):
            gbrain_ok += 1

    st["status"] = "rejected" if rejected else "approved"
    st["reviewed_at"] = _now_iso()
    st["clean"] = clean
    # Mark the sequence completed when its last step is resolved (and not paused
    # by a reply or stopped).
    if seq.get("status") == "active":
        if all(s.get("status") in ("approved", "rejected") for s in seq.get("steps", [])):
            seq["status"] = "completed"
    _save_sequence(seq)

    trust = None
    try:
        from tools import sales_trust
        trust = sales_trust.record_outcome(
            JOB_ID,
            magnitude=(magnitude if magnitude is not None else 0.0),
            structural_change=structural_change,
            rejected=rejected,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("outbound sales_trust update skipped: %s", e)

    return {
        "account_id": seq["account_id"],
        "step": int(step),
        "status": st["status"],
        "clean": clean,
        "lessons_recorded": written,
        "gbrain_ok": gbrain_ok,
        "trust_header": _trust_header(),
        "trust_level": (trust or {}).get("level"),
    }


# ---------------------------------------------------------------------------
# Tool handlers
# ---------------------------------------------------------------------------


def _handle_enroll_account(args: dict, **kw) -> str:
    aid = (args.get("account_id") or "").strip()
    if not aid:
        return tool_error("Missing required parameter: account_id")
    try:
        return tool_result(enroll_account(
            aid,
            name=args.get("name") or "",
            contact_email=args.get("contact_email") or "",
            cadence=args.get("cadence") or None,
            allow_linkedin=bool(args.get("allow_linkedin", False)),
            notes=args.get("notes") or "",
        ))
    except Exception as e:  # noqa: BLE001
        return tool_error(f"Failed to enroll account: {e}")


def _handle_draft_sequence_step(args: dict, **kw) -> str:
    aid = (args.get("account_id") or "").strip()
    if not aid:
        return tool_error("Missing required parameter: account_id")
    if args.get("step") is None:
        return tool_error("Missing required parameter: step")
    if not (args.get("body") or "").strip():
        return tool_error("Missing required parameter: body")
    if load_sequence(aid) is None:
        return tool_error(f"No enrolled sequence for account {aid!r}")
    try:
        return tool_result(draft_sequence_step(
            aid, int(args.get("step")), args.get("body"),
            subject=args.get("subject") or "",
        ))
    except Exception as e:  # noqa: BLE001
        return tool_error(f"Failed to draft step: {e}")


def _handle_list_sequences(args: dict, **kw) -> str:
    rows = list_sequences(status=args.get("status") or None, limit=int(args.get("limit") or 200))
    return tool_result({"count": len(rows), "sequences": rows})


def _handle_record_reply(args: dict, **kw) -> str:
    aid = (args.get("account_id") or "").strip()
    if not aid:
        return tool_error("Missing required parameter: account_id")
    if load_sequence(aid) is None:
        return tool_error(f"No enrolled sequence for account {aid!r}")
    try:
        return tool_result(record_reply(
            aid,
            reply_id=args.get("reply_id") or "",
            disposition=args.get("disposition") or "interested",
            body=args.get("body") or "",
            received_at=args.get("received_at") or "",
        ))
    except Exception as e:  # noqa: BLE001
        return tool_error(f"Failed to record reply: {e}")


def _handle_record_sequence_outcome(args: dict, **kw) -> str:
    aid = (args.get("account_id") or "").strip()
    if not aid:
        return tool_error("Missing required parameter: account_id")
    if args.get("step") is None:
        return tool_error("Missing required parameter: step")
    if load_sequence(aid) is None:
        return tool_error(f"No enrolled sequence for account {aid!r}")
    try:
        return tool_result(record_sequence_outcome(
            aid, int(args.get("step")),
            ai_draft=args.get("ai_draft") or "",
            human_final=args.get("human_final") or "",
            rejected=bool(args.get("rejected", False)),
            structural_change=bool(args.get("structural_change", False)),
            lessons=args.get("lessons") or [],
        ))
    except Exception as e:  # noqa: BLE001
        return tool_error(f"Failed to record outcome: {e}")


def _handle_get_playbook(args: dict, **kw) -> str:
    return tool_result({"playbook": get_playbook()})


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

ENROLL_SCHEMA = {
    "name": "enroll_account",
    "description": (
        "Enroll a scored account (from Job 2.1 enrichment) into the email-first "
        "outbound cadence. Idempotent by account_id. Pulls firmographics from the "
        "enrichment store when available. LinkedIn steps are dropped unless "
        "allow_linkedin is set (and even then are manual-task notes only — no "
        "automation). No sends — this only sets up the cadence."
    ),
    "parameters": {"type": "object", "properties": {
        "account_id": {"type": "string", "description": "Scored-account id from Job 2.1 (slug of the company name)."},
        "name": {"type": "string", "description": "Account/company name (falls back to the enrichment record)."},
        "contact_email": {"type": "string", "description": "Optional buyer email for the (unsent) drafts."},
        "allow_linkedin": {"type": "boolean", "description": "Explicit opt-in to include LinkedIn steps (manual-task notes only)."},
        "notes": {"type": "string"},
        "cadence": {"type": "array", "description": "Optional custom cadence; defaults to the 4-touch email cadence.", "items": {"type": "object", "properties": {
            "step": {"type": "integer"},
            "channel": {"type": "string", "enum": CHANNELS},
            "intent": {"type": "string"},
            "wait_days": {"type": "integer"},
        }}},
    }, "required": ["account_id"]},
}

DRAFT_STEP_SCHEMA = {
    "name": "draft_sequence_step",
    "description": (
        "Store a personalized UNSENT draft for one cadence step. Writes a review "
        "artifact under $HERMES_HOME/outbound/drafts/ for human approval. Sends are "
        "DISABLED until Gmail consent — nothing is sent. LinkedIn steps are drafted "
        "as manual-task notes only. Brand: always 'YES!' and 'Celebrational Cacao'; "
        "health/functional claims are human-gated."
    ),
    "parameters": {"type": "object", "properties": {
        "account_id": {"type": "string"},
        "step": {"type": "integer", "description": "Cadence step number to draft."},
        "subject": {"type": "string", "description": "Email subject line (email steps)."},
        "body": {"type": "string", "description": "The drafted outreach copy (unsent)."},
    }, "required": ["account_id", "step", "body"]},
}

LIST_SEQUENCES_SCHEMA = {
    "name": "list_sequences",
    "description": "List enrolled outbound sequences. Filter by status (active/replied/completed/stopped).",
    "parameters": {"type": "object", "properties": {
        "status": {"type": "string", "enum": SEQ_STATUSES},
        "limit": {"type": "integer"},
    }},
}

RECORD_REPLY_SCHEMA = {
    "name": "record_reply",
    "description": (
        "Log a prospect reply into the human reply queue and pause the sequence "
        "(a human owns the conversation from here). Idempotent by reply_id."
    ),
    "parameters": {"type": "object", "properties": {
        "account_id": {"type": "string"},
        "reply_id": {"type": "string", "description": "Stable id (e.g. mail message id); auto-generated if omitted."},
        "disposition": {"type": "string", "enum": REPLY_DISPOSITIONS},
        "body": {"type": "string", "description": "The prospect's reply text."},
        "received_at": {"type": "string", "description": "ISO timestamp the reply arrived (optional)."},
    }, "required": ["account_id"]},
}

RECORD_OUTCOME_SCHEMA = {
    "name": "record_sequence_outcome",
    "description": (
        "Record the human verdict on a drafted cadence step (approved/edited/"
        "rejected) and advance the Job 2.2 trust counter. Clean = approved with the "
        "draft unchanged. Pass human_final if edited. Captures cadence/voice lessons "
        "to gbrain. Graduation is deliberately slow (reputation-critical sends)."
    ),
    "parameters": {"type": "object", "properties": {
        "account_id": {"type": "string"},
        "step": {"type": "integer"},
        "ai_draft": {"type": "string", "description": "AI's drafted copy (defaults to the stored step draft)."},
        "human_final": {"type": "string", "description": "Human-approved final text (omit if rejected)."},
        "rejected": {"type": "boolean"},
        "structural_change": {"type": "boolean", "description": "True for a strategy/positioning change (material regardless of wording)."},
        "lessons": {"type": "array", "items": {"type": "object", "properties": {
            "category": {"type": "string", "description": "e.g. cadence, voice, subject-line, timing, disqualifier"},
            "rule": {"type": "string"},
        }, "required": ["category", "rule"]}},
    }, "required": ["account_id", "step"]},
}

GET_PLAYBOOK_SCHEMA = {
    "name": "get_outbound_playbook",
    "description": "Read the outbound-sequencing playbook (cadence + voice rubric plus learned refinements) to apply when drafting steps.",
    "parameters": {"type": "object", "properties": {}},
}


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------

from tools.registry import registry, tool_error, tool_result  # noqa: E402

for _name, _schema, _handler, _emoji in [
    ("enroll_account", ENROLL_SCHEMA, _handle_enroll_account, "📥"),
    ("draft_sequence_step", DRAFT_STEP_SCHEMA, _handle_draft_sequence_step, "✍️"),
    ("list_sequences", LIST_SEQUENCES_SCHEMA, _handle_list_sequences, "📋"),
    ("record_reply", RECORD_REPLY_SCHEMA, _handle_record_reply, "📨"),
    ("record_sequence_outcome", RECORD_OUTCOME_SCHEMA, _handle_record_sequence_outcome, "🎓"),
    ("get_outbound_playbook", GET_PLAYBOOK_SCHEMA, _handle_get_playbook, "🧭"),
]:
    registry.register(name=_name, toolset="outbound", schema=_schema, handler=_handler, emoji=_emoji)
