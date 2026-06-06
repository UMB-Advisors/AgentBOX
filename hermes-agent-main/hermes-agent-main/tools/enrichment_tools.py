"""Sales Persona Job 2.1 — Lead Enrichment & Scoring.

Find and score retail buyers, specialty grocers, gift shops, and
corporate-gifting accounts against the YES! ICP, producing a scored, prioritized
account list — the spine that Outbound (2.2/2.3) and Conversion (3.x) consume.

Same loop shape as the blog/content learning engines: the agent does the
research (firmographic-only via web/x_search), this module stores the scored
accounts, learns from how the human re-scores them, and feeds the shared Job 2.1
trust counter so scoring graduates L0 -> L1 -> L2 as the human stops correcting it.

v1 is **firmographic-only** (company-level: type, location, size, fit signals).
Contact-level enrichment (names/emails/titles via Apollo/Clearbit) is deferred
behind the LinkedIn-compliance decision (build-plan OQ3). The CRM/kanban sink for
scored accounts is deferred behind OQ2 — the enrichment store here is the
authoritative output until that's resolved.

Reuses ``blog_learning``'s gbrain helpers and the ``sales_trust`` counter. Pure
stdlib; paths resolve from ``HERMES_HOME`` per call.
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

JOB_ID = "2.1"
GBRAIN_TAG = "lead-scoring-feedback"
_HISTORY_CAP = 20
DIGEST_MAX_LESSONS = 60
DIGEST_RECENT_SHOWN = 12

ACCOUNT_TYPES = [
    "retail", "specialty_grocer", "gift_shop", "corporate_gifting",
    "distributor", "other",
]
TIER_A_MIN = 70  # fit_score thresholds
TIER_B_MIN = 40


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------


def _hermes_home() -> Path:
    return Path(os.getenv("HERMES_HOME") or (Path.home() / ".hermes"))


def base_dir() -> Path:
    return _hermes_home() / "enrichment"


def accounts_dir() -> Path:
    return base_dir() / "accounts"


def lessons_dir() -> Path:
    return base_dir() / "lessons"


def index_path() -> Path:
    return lessons_dir() / "index.jsonl"


def rubric_path() -> Path:
    # Operator- or Job-1.1-provided ICP rubric (input).
    return base_dir() / "icp_rubric.md"


def rubric_digest_path() -> Path:
    # Learned scoring refinements (output of the loop).
    return base_dir() / "rubric-digest.md"


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(value).lower()).strip("-") or "account"


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat()


def _today() -> str:
    return datetime.now().astimezone().strftime("%Y-%m-%d")


def _tier_for(score: float) -> str:
    if score >= TIER_A_MIN:
        return "A"
    if score >= TIER_B_MIN:
        return "B"
    return "C"


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
# Accounts
# ---------------------------------------------------------------------------


def record_account(
    name: str,
    account_type: str,
    fit_score: float,
    *,
    account_id: Optional[str] = None,
    location: str = "",
    website: str = "",
    icp_segment: str = "",
    rationale: str = "",
    firmographics: Optional[Dict[str, Any]] = None,
    source: str = "",
) -> Dict[str, Any]:
    """Store one AI-scored account (status=new) and return its record."""
    if account_type not in ACCOUNT_TYPES:
        raise ValueError(f"account_type must be one of {ACCOUNT_TYPES}")
    try:
        score = float(fit_score)
    except (TypeError, ValueError):
        raise ValueError("fit_score must be a number 0-100")
    score = max(0.0, min(100.0, score))
    acct_id = _slug(account_id or name)
    accounts_dir().mkdir(parents=True, exist_ok=True)
    record = {
        "account_id": acct_id,
        "name": name,
        "account_type": account_type,
        "location": location,
        "website": website,
        "icp_segment": icp_segment,
        "fit_score": score,
        "tier": _tier_for(score),
        "rationale": rationale,
        "firmographics": firmographics or {},
        "source": source,
        "status": "new",  # new | approved | rejected
        "created_at": _now_iso(),
    }
    (accounts_dir() / f"{acct_id}.json").write_text(
        json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    return record


def load_account(account_id: str) -> Optional[Dict[str, Any]]:
    p = accounts_dir() / f"{_slug(account_id)}.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _save_account(record: Dict[str, Any]) -> None:
    accounts_dir().mkdir(parents=True, exist_ok=True)
    (accounts_dir() / f"{record['account_id']}.json").write_text(
        json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def _all_accounts() -> List[Dict[str, Any]]:
    d = accounts_dir()
    if not d.exists():
        return []
    out = []
    for p in sorted(d.glob("*.json")):
        try:
            out.append(json.loads(p.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            continue
    return out


def list_pending(limit: int = 100) -> List[Dict[str, Any]]:
    return [a for a in _all_accounts() if a.get("status") == "new"][:limit]


def list_scored(
    min_score: float = 0.0,
    tier: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = 100,
) -> List[Dict[str, Any]]:
    """The prioritized account list (highest fit first) — the job's output."""
    rows = _all_accounts()
    if status:
        rows = [a for a in rows if a.get("status") == status]
    if tier:
        rows = [a for a in rows if a.get("tier") == tier]
    rows = [a for a in rows if (a.get("fit_score") or 0) >= min_score]
    rows.sort(key=lambda a: a.get("fit_score") or 0, reverse=True)
    return rows[:limit]


# ---------------------------------------------------------------------------
# Scoring-rubric lessons + digest
# ---------------------------------------------------------------------------


def _write_lesson(lesson: Dict[str, Any]) -> Path:
    lessons_dir().mkdir(parents=True, exist_ok=True)
    date = _today()
    base = f"{date}-{_slug(lesson.get('category', 'rubric'))}"
    p = lessons_dir() / f"{base}.md"
    i = 2
    while p.exists():
        p = lessons_dir() / f"{base}-{i}.md"
        i += 1
    fm = {
        "type": GBRAIN_TAG,
        "date": date,
        "category": lesson.get("category", "rubric"),
        "tags": [GBRAIN_TAG, _slug(lesson.get("category", "rubric"))],
    }
    lines = ["---"]
    lines += [f"{k}: {json.dumps(v, ensure_ascii=False)}" for k, v in fm.items()]
    lines += ["---", "", f"# Lead-scoring lesson — {lesson.get('category', 'rubric')}", ""]
    for label, key in (("Rule", "rule"), ("Observation", "observation")):
        if lesson.get(key):
            lines += [f"**{label}:** {lesson[key]}", ""]
    p.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    with index_path().open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({
            "date": date, "category": lesson.get("category", "rubric"),
            "rule": lesson.get("rule", ""), "file": p.name,
        }, ensure_ascii=False) + "\n")
    return p


def _read_index() -> List[Dict[str, Any]]:
    p = index_path()
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


def refresh_digest() -> Path:
    lessons = _read_index()[-DIGEST_MAX_LESSONS:]
    counts: Dict[tuple, Dict[str, Any]] = {}
    for ls in lessons:
        rule = (ls.get("rule") or "").strip()
        if not rule:
            continue
        key = (ls.get("category", "rubric"), rule.lower())
        slot = counts.setdefault(key, {"category": ls.get("category", "rubric"), "rule": rule, "n": 0})
        slot["n"] += 1
    recurring = sorted(counts.values(), key=lambda s: s["n"], reverse=True)
    out = [
        "# YES! Lead-Scoring Rubric (learned)",
        "",
        f"_Auto-generated from {len(lessons)} recent scoring lesson(s) on {_today()}._",
        "",
        "## Recurring scoring rules",
        "",
    ]
    top = [r for r in recurring if r["n"] >= 2] or recurring[:8]
    if top:
        out += [f"- [{r['category']}{(' x' + str(r['n'])) if r['n'] > 1 else ''}] {r['rule']}" for r in top[:15]]
    else:
        out.append("- _(no recurring rules yet — learning in progress)_")
    base_dir().mkdir(parents=True, exist_ok=True)
    rubric_digest_path().write_text("\n".join(out) + "\n", encoding="utf-8")
    return rubric_digest_path()


def get_rubric() -> str:
    """ICP rubric (operator/Job-1.1 input) + learned scoring refinements."""
    parts = []
    if rubric_path().exists():
        parts.append(rubric_path().read_text(encoding="utf-8").strip())
    if rubric_digest_path().exists():
        parts.append(rubric_digest_path().read_text(encoding="utf-8").strip())
    return "\n\n".join(p for p in parts if p)


# ---------------------------------------------------------------------------
# Outcome — human verdict on a scored account; feeds the Job 2.1 counter
# ---------------------------------------------------------------------------


def record_outcome(
    account_id: str,
    *,
    approved: bool = True,
    score_changed: bool = False,
    lessons: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Record the human verdict on a scored account. For scoring, "material" is
    whether the human changed the score/tier (``score_changed``), not text edits.
    Clean = approved AND not score_changed. Writes rubric lessons + advances the
    Job 2.1 trust counter."""
    rec = load_account(account_id)
    if rec is None:
        raise ValueError(f"No account {account_id!r}")
    clean = approved and not score_changed

    written: List[str] = []
    gbrain_ok = 0
    for lesson in (lessons or []):
        if not isinstance(lesson, dict):
            continue
        try:
            p = _write_lesson(lesson)
        except Exception as e:  # noqa: BLE001
            logger.error("enrichment _write_lesson failed: %s", e)
            continue
        written.append(p.name)
        if _gbrain_capture(p).get("ok"):
            gbrain_ok += 1
    if written:
        try:
            refresh_digest()
        except Exception as e:  # noqa: BLE001
            logger.error("enrichment refresh_digest failed: %s", e)

    rec["status"] = "approved" if approved else "rejected"
    rec["reviewed_at"] = _now_iso()
    rec["score_changed"] = score_changed
    _save_account(rec)

    trust = None
    try:
        from tools import sales_trust
        trust = sales_trust.record_outcome(
            JOB_ID,
            magnitude=(0.0 if clean else 1.0),
            structural_change=score_changed,
            rejected=not approved,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("enrichment sales_trust update skipped: %s", e)

    return {
        "account_id": rec["account_id"],
        "status": rec["status"],
        "clean": clean,
        "lessons_recorded": len(written),
        "gbrain_ok": gbrain_ok,
        "trust_header": _trust_header(),
        "trust_level": (trust or {}).get("level"),
    }


# ---------------------------------------------------------------------------
# Tool handlers
# ---------------------------------------------------------------------------


def _handle_record_account(args: dict, **kw) -> str:
    name = (args.get("name") or "").strip()
    account_type = (args.get("account_type") or "").strip()
    if not name:
        return tool_error("Missing required parameter: name")
    if account_type not in ACCOUNT_TYPES:
        return tool_error(f"account_type must be one of {ACCOUNT_TYPES}")
    if args.get("fit_score") is None:
        return tool_error("Missing required parameter: fit_score (0-100)")
    try:
        rec = record_account(
            name, account_type, args.get("fit_score"),
            account_id=args.get("account_id") or None,
            location=args.get("location") or "",
            website=args.get("website") or "",
            icp_segment=args.get("icp_segment") or "",
            rationale=args.get("rationale") or "",
            firmographics=args.get("firmographics") or {},
            source=args.get("source") or "",
        )
        return tool_result({"account": rec, "trust_header": _trust_header()})
    except Exception as e:  # noqa: BLE001
        return tool_error(f"Failed to record account: {e}")


def _handle_list_pending(args: dict, **kw) -> str:
    rows = list_pending(int(args.get("limit") or 100))
    return tool_result({"count": len(rows), "pending": rows})


def _handle_list_scored(args: dict, **kw) -> str:
    rows = list_scored(
        min_score=float(args.get("min_score") or 0),
        tier=args.get("tier") or None,
        status=args.get("status") or None,
        limit=int(args.get("limit") or 100),
    )
    return tool_result({"count": len(rows), "accounts": rows})


def _handle_get_rubric(args: dict, **kw) -> str:
    return tool_result({"rubric": get_rubric()})


def _handle_record_outcome(args: dict, **kw) -> str:
    account_id = (args.get("account_id") or "").strip()
    if not account_id:
        return tool_error("Missing required parameter: account_id")
    if load_account(account_id) is None:
        return tool_error(f"No account {account_id!r}")
    try:
        return tool_result(record_outcome(
            account_id,
            approved=bool(args.get("approved", True)),
            score_changed=bool(args.get("score_changed", False)),
            lessons=args.get("lessons") or [],
        ))
    except Exception as e:  # noqa: BLE001
        return tool_error(f"Failed to record outcome: {e}")


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

RECORD_ACCOUNT_SCHEMA = {
    "name": "record_scored_account",
    "description": (
        "Store one firmographically-scored prospect account (retail buyer, "
        "specialty grocer, gift shop, corporate-gifting, distributor) against the "
        "YES! ICP. Company-level only — no contact PII. Returns the stored record "
        "with its tier and the trust header."
    ),
    "parameters": {"type": "object", "properties": {
        "name": {"type": "string", "description": "Account / company name."},
        "account_type": {"type": "string", "enum": ACCOUNT_TYPES},
        "fit_score": {"type": "number", "description": "0-100 fit vs ICP (>=70 A, 40-69 B, <40 C)."},
        "location": {"type": "string"},
        "website": {"type": "string"},
        "icp_segment": {"type": "string", "description": "DTC / wholesale / corporate-gifting segment."},
        "rationale": {"type": "string", "description": "Why this score — the firmographic signals."},
        "firmographics": {"type": "object", "description": "Structured signals (size, region, channels, etc.)."},
        "source": {"type": "string", "description": "Where it was found (web/x_search query, directory)."},
        "account_id": {"type": "string", "description": "Optional stable id; defaults to a slug of the name."},
    }, "required": ["name", "account_type", "fit_score"]},
}

LIST_PENDING_SCHEMA = {
    "name": "list_pending_accounts",
    "description": "List scored accounts awaiting a human verdict (status=new).",
    "parameters": {"type": "object", "properties": {"limit": {"type": "integer"}}},
}

LIST_SCORED_SCHEMA = {
    "name": "list_scored_accounts",
    "description": "The prioritized account list (highest fit first). Filter by min_score, tier (A/B/C), or status (new/approved/rejected).",
    "parameters": {"type": "object", "properties": {
        "min_score": {"type": "number"},
        "tier": {"type": "string", "enum": ["A", "B", "C"]},
        "status": {"type": "string", "enum": ["new", "approved", "rejected"]},
        "limit": {"type": "integer"},
    }},
}

GET_RUBRIC_SCHEMA = {
    "name": "get_icp_rubric",
    "description": "Read the ICP scoring rubric (operator/Job-1.1 input plus learned scoring refinements) to apply when scoring accounts.",
    "parameters": {"type": "object", "properties": {}},
}

RECORD_OUTCOME_SCHEMA = {
    "name": "record_account_outcome",
    "description": (
        "Record the human verdict on a scored account (approved/rejected, and "
        "whether the human changed the score/tier). Writes scoring-rubric lessons "
        "to gbrain and advances the Job 2.1 trust counter. Clean = approved and "
        "the score was not changed."
    ),
    "parameters": {"type": "object", "properties": {
        "account_id": {"type": "string"},
        "approved": {"type": "boolean"},
        "score_changed": {"type": "boolean", "description": "True if the human re-scored / re-tiered (material)."},
        "lessons": {"type": "array", "description": "Generalizable scoring-rubric lessons (empty for clean approvals).", "items": {"type": "object", "properties": {
            "category": {"type": "string", "description": "e.g. fit-signal, disqualifier, segment, sizing"},
            "observation": {"type": "string"},
            "rule": {"type": "string"},
        }, "required": ["category", "rule"]}},
    }, "required": ["account_id"]},
}


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------

from tools.registry import registry, tool_error, tool_result  # noqa: E402

for _name, _schema, _handler, _emoji in [
    ("record_scored_account", RECORD_ACCOUNT_SCHEMA, _handle_record_account, "🎯"),
    ("list_pending_accounts", LIST_PENDING_SCHEMA, _handle_list_pending, "📋"),
    ("list_scored_accounts", LIST_SCORED_SCHEMA, _handle_list_scored, "📊"),
    ("get_icp_rubric", GET_RUBRIC_SCHEMA, _handle_get_rubric, "🧭"),
    ("record_account_outcome", RECORD_OUTCOME_SCHEMA, _handle_record_outcome, "🎓"),
]:
    registry.register(name=_name, toolset="enrichment", schema=_schema, handler=_handler, emoji=_emoji)
