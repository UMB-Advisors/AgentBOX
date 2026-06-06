"""Sales Persona Job 3.2 — Pipeline & Forecasting.

A lightweight deal pipeline and weighted forecast for YES! Celebrational Cacao
wholesale/corporate-gifting opportunities. The agent maintains deals (stage,
amount, account, expected close, last touch), surfaces stalled deals, and
produces a stage-weighted weekly forecast — the conversion-stage readout that
sits downstream of Outbound (2.2/2.3) and Quote/Line-Sheet (3.1).

Two trust postures, matching the spec (build-plan):
- **Reporting is read-only and autonomous** — ``list_deals``, ``stalled_deals``
  and ``forecast`` never mutate state and can run on the weekly cron without a
  human in the loop.
- **Deal mutations are trust-gated** — ``upsert_deal`` produces/updates a stored
  deal record, and the human verdict on those mutations
  (``record_pipeline_outcome``) feeds the shared Job 3.2 trust counter so the
  pipeline graduates L0 -> L1 -> L2 as the operator stops correcting deal data.

v1 store is **JSON** under ``$HERMES_HOME/pipeline/deals/<id>.json`` (kanban /
JSON per build-plan OQ2 — explicitly NOT Postgres). Reuses ``blog_learning``'s
gbrain helper and the ``sales_trust`` counter. Pure stdlib; paths resolve from
``HERMES_HOME`` on every call so the runtime and tests stay in sync.
"""

from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

JOB_ID = "3.2"
GBRAIN_TAG = "pipeline-feedback"
_HISTORY_CAP = 20
DIGEST_MAX_LESSONS = 60

# Sales stages and their forecast probabilities (weighted-pipeline default).
# Closed-won/lost are terminal: won counts at full value, lost at zero, and
# neither is "open" pipeline.
STAGE_PROBABILITY: Dict[str, float] = {
    "lead": 0.10,
    "qualified": 0.25,
    "sample_sent": 0.40,
    "proposal": 0.60,
    "negotiation": 0.80,
    "closed_won": 1.00,
    "closed_lost": 0.00,
}
STAGES = list(STAGE_PROBABILITY.keys())
OPEN_STAGES = [s for s in STAGES if not s.startswith("closed_")]
DEFAULT_STALL_DAYS = 14


# ---------------------------------------------------------------------------
# Paths (HERMES_HOME-resolved per call; test-overridable)
# ---------------------------------------------------------------------------


def _hermes_home() -> Path:
    return Path(os.getenv("HERMES_HOME") or (Path.home() / ".hermes"))


def base_dir() -> Path:
    return _hermes_home() / "pipeline"


def deals_dir() -> Path:
    return base_dir() / "deals"


def lessons_dir() -> Path:
    return base_dir() / "lessons"


def index_path() -> Path:
    return lessons_dir() / "index.jsonl"


def digest_path() -> Path:
    return base_dir() / "pipeline-digest.md"


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(value).lower()).strip("-") or "deal"


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


def _trust_header() -> str:
    try:
        from tools import sales_trust
        return sales_trust.trust_header(JOB_ID)
    except Exception:  # noqa: BLE001
        return "Trust: (unavailable)"


# ---------------------------------------------------------------------------
# Date utilities
# ---------------------------------------------------------------------------


def _parse_dt(value: Optional[str]) -> Optional[datetime]:
    """Parse an ISO date/datetime, returning a tz-aware datetime (or None)."""
    if not value:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        # Fall back to a plain date.
        try:
            dt = datetime.strptime(raw[:10], "%Y-%m-%d")
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _days_since(value: Optional[str]) -> Optional[int]:
    dt = _parse_dt(value)
    if dt is None:
        return None
    now = datetime.now(timezone.utc)
    return (now - dt).days


# ---------------------------------------------------------------------------
# Deal store
# ---------------------------------------------------------------------------


def _deal_path(deal_id: str) -> Path:
    return deals_dir() / f"{_slug(deal_id)}.json"


def load_deal(deal_id: str) -> Optional[Dict[str, Any]]:
    p = _deal_path(deal_id)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        logger.warning("pipeline: bad deal record %s: %s", p, e)
        return None


def _save_deal(record: Dict[str, Any]) -> None:
    deals_dir().mkdir(parents=True, exist_ok=True)
    _deal_path(record["deal_id"]).write_text(
        json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def upsert_deal(
    account: str,
    stage: str,
    *,
    deal_id: Optional[str] = None,
    amount: float = 0.0,
    owner: str = "",
    expected_close: str = "",
    last_touch: str = "",
    notes: str = "",
) -> Dict[str, Any]:
    """Create or update one deal record (status awaiting human verdict on changes).

    A deal is keyed by ``deal_id`` (defaults to a slug of the account name). On
    update, only the fields that were explicitly provided are changed; everything
    else is preserved. ``last_touch`` defaults to today on first create.
    """
    account = (account or "").strip()
    if not account:
        raise ValueError("account is required")
    if stage not in STAGE_PROBABILITY:
        raise ValueError(f"stage must be one of {STAGES}")
    try:
        amt = float(amount)
    except (TypeError, ValueError):
        raise ValueError("amount must be a number")
    if amt < 0:
        raise ValueError("amount must be >= 0")

    did = _slug(deal_id or account)
    existing = load_deal(did)
    if existing is None:
        record = {
            "deal_id": did,
            "account": account,
            "stage": stage,
            "amount": amt,
            "owner": owner,
            "expected_close": expected_close,
            "last_touch": last_touch or _today(),
            "notes": notes,
            "review_status": "new",  # new | approved | rejected
            "created_at": _now_iso(),
            "updated_at": _now_iso(),
        }
    else:
        record = existing
        record["account"] = account
        record["stage"] = stage
        record["amount"] = amt
        if owner:
            record["owner"] = owner
        if expected_close:
            record["expected_close"] = expected_close
        record["last_touch"] = last_touch or record.get("last_touch") or _today()
        if notes:
            record["notes"] = notes
        record["review_status"] = "new"  # a change re-enters review
        record["updated_at"] = _now_iso()
    record["probability"] = STAGE_PROBABILITY[stage]
    record["weighted_amount"] = round(amt * STAGE_PROBABILITY[stage], 2)
    _save_deal(record)
    return record


def _all_deals() -> List[Dict[str, Any]]:
    d = deals_dir()
    if not d.exists():
        return []
    out: List[Dict[str, Any]] = []
    for p in sorted(d.glob("*.json")):
        try:
            out.append(json.loads(p.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            continue
    return out


def list_deals(
    stage: Optional[str] = None,
    owner: Optional[str] = None,
    *,
    open_only: bool = False,
    limit: int = 200,
) -> List[Dict[str, Any]]:
    """Read-only listing of deals, filtered by stage and/or owner."""
    rows = _all_deals()
    if stage:
        rows = [d for d in rows if d.get("stage") == stage]
    if owner:
        rows = [d for d in rows if (d.get("owner") or "") == owner]
    if open_only:
        rows = [d for d in rows if d.get("stage") in OPEN_STAGES]
    rows.sort(key=lambda d: d.get("weighted_amount") or 0, reverse=True)
    return rows[:limit]


def stalled_deals(days: int = DEFAULT_STALL_DAYS, *, limit: int = 200) -> List[Dict[str, Any]]:
    """Open deals with no ``last_touch`` in ``days`` days (read-only).

    Deals with no/unparseable ``last_touch`` are treated as stalled. Closed deals
    are never stalled. Sorted oldest-touch first.
    """
    out: List[Dict[str, Any]] = []
    for d in _all_deals():
        if d.get("stage") not in OPEN_STAGES:
            continue
        ds = _days_since(d.get("last_touch"))
        if ds is None or ds >= days:
            row = dict(d)
            row["days_since_touch"] = ds
            out.append(row)
    out.sort(key=lambda d: (d.get("days_since_touch") is not None, -(d.get("days_since_touch") or 10**6)))
    return out[:limit]


# ---------------------------------------------------------------------------
# Forecast (read-only) — weighted by stage probability, bucketed weekly
# ---------------------------------------------------------------------------


def _week_key(value: Optional[str]) -> str:
    """ISO-year-week label for an expected_close date, e.g. '2026-W23'."""
    dt = _parse_dt(value)
    if dt is None:
        return "unscheduled"
    iso = dt.isocalendar()
    return f"{iso[0]}-W{iso[1]:02d}"


def forecast() -> Dict[str, Any]:
    """Weighted weekly forecast over OPEN deals.

    Each open deal contributes ``amount * stage_probability`` to its
    ``expected_close`` week bucket. Returns totals plus per-week and per-stage
    breakdowns. Read-only.
    """
    weeks: Dict[str, Dict[str, Any]] = {}
    by_stage: Dict[str, Dict[str, Any]] = {}
    total_weighted = 0.0
    total_raw = 0.0
    open_count = 0
    for d in _all_deals():
        stage = d.get("stage")
        if stage not in OPEN_STAGES:
            continue
        open_count += 1
        amt = float(d.get("amount") or 0)
        prob = STAGE_PROBABILITY.get(stage, 0.0)
        w = round(amt * prob, 2)
        total_weighted += w
        total_raw += amt

        wk = _week_key(d.get("expected_close"))
        slot = weeks.setdefault(wk, {"week": wk, "count": 0, "raw": 0.0, "weighted": 0.0})
        slot["count"] += 1
        slot["raw"] = round(slot["raw"] + amt, 2)
        slot["weighted"] = round(slot["weighted"] + w, 2)

        st_slot = by_stage.setdefault(stage, {"stage": stage, "probability": prob, "count": 0, "raw": 0.0, "weighted": 0.0})
        st_slot["count"] += 1
        st_slot["raw"] = round(st_slot["raw"] + amt, 2)
        st_slot["weighted"] = round(st_slot["weighted"] + w, 2)

    week_rows = sorted(
        weeks.values(),
        key=lambda r: (r["week"] == "unscheduled", r["week"]),
    )
    stage_rows = sorted(by_stage.values(), key=lambda r: STAGES.index(r["stage"]))
    return {
        "generated_at": _now_iso(),
        "open_deals": open_count,
        "raw_pipeline": round(total_raw, 2),
        "weighted_forecast": round(total_weighted, 2),
        "by_week": week_rows,
        "by_stage": stage_rows,
    }


# ---------------------------------------------------------------------------
# Lessons + digest (pipeline-hygiene rules learned from human corrections)
# ---------------------------------------------------------------------------


def _write_lesson(lesson: Dict[str, Any]) -> Path:
    lessons_dir().mkdir(parents=True, exist_ok=True)
    date = _today()
    base = f"{date}-{_slug(lesson.get('category', 'pipeline'))}"
    p = lessons_dir() / f"{base}.md"
    i = 2
    while p.exists():
        p = lessons_dir() / f"{base}-{i}.md"
        i += 1
    fm = {
        "type": GBRAIN_TAG,
        "date": date,
        "category": lesson.get("category", "pipeline"),
        "tags": [GBRAIN_TAG, _slug(lesson.get("category", "pipeline"))],
    }
    lines = ["---"]
    lines += [f"{k}: {json.dumps(v, ensure_ascii=False)}" for k, v in fm.items()]
    lines += ["---", "", f"# Pipeline lesson — {lesson.get('category', 'pipeline')}", ""]
    for label, key in (("Rule", "rule"), ("Observation", "observation")):
        if lesson.get(key):
            lines += [f"**{label}:** {lesson[key]}", ""]
    p.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    with index_path().open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({
            "date": date, "category": lesson.get("category", "pipeline"),
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
        key = (ls.get("category", "pipeline"), rule.lower())
        slot = counts.setdefault(key, {"category": ls.get("category", "pipeline"), "rule": rule, "n": 0})
        slot["n"] += 1
    recurring = sorted(counts.values(), key=lambda s: s["n"], reverse=True)
    out = [
        "# YES! Pipeline Hygiene Rules (learned)",
        "",
        f"_Auto-generated from {len(lessons)} recent pipeline lesson(s) on {_today()}._",
        "",
        "## Recurring rules",
        "",
    ]
    top = [r for r in recurring if r["n"] >= 2] or recurring[:8]
    if top:
        out += [f"- [{r['category']}{(' x' + str(r['n'])) if r['n'] > 1 else ''}] {r['rule']}" for r in top[:15]]
    else:
        out.append("- _(no recurring rules yet — learning in progress)_")
    base_dir().mkdir(parents=True, exist_ok=True)
    digest_path().write_text("\n".join(out) + "\n", encoding="utf-8")
    return digest_path()


def get_digest() -> str:
    p = digest_path()
    return p.read_text(encoding="utf-8") if p.exists() else ""


# ---------------------------------------------------------------------------
# Outcome — human verdict on a deal mutation; feeds the Job 3.2 counter
# ---------------------------------------------------------------------------


def record_pipeline_outcome(
    deal_id: str,
    *,
    approved: bool = True,
    corrected: bool = False,
    lessons: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Record the human verdict on a deal mutation and advance the trust counter.

    For pipeline data, "material" is whether the human had to correct the deal
    (``corrected`` — stage/amount/close/account wrong), not text magnitude. Clean
    = approved AND not corrected. Writes pipeline-hygiene lessons (gbrain + digest)
    and advances the Job 3.2 counter. Best-effort trust wiring.
    """
    rec = load_deal(deal_id)
    if rec is None:
        raise ValueError(f"No deal {deal_id!r}")
    clean = approved and not corrected

    written: List[str] = []
    gbrain_ok = 0
    for lesson in (lessons or []):
        if not isinstance(lesson, dict):
            continue
        try:
            p = _write_lesson(lesson)
        except Exception as e:  # noqa: BLE001
            logger.error("pipeline _write_lesson failed: %s", e)
            continue
        written.append(p.name)
        if _gbrain_capture(p).get("ok"):
            gbrain_ok += 1
    if written:
        try:
            refresh_digest()
        except Exception as e:  # noqa: BLE001
            logger.error("pipeline refresh_digest failed: %s", e)

    rec["review_status"] = "approved" if approved else "rejected"
    rec["reviewed_at"] = _now_iso()
    rec["corrected"] = corrected
    _save_deal(rec)

    trust = None
    try:
        from tools import sales_trust
        trust = sales_trust.record_outcome(
            JOB_ID,
            magnitude=(0.0 if clean else 1.0),
            structural_change=corrected,
            rejected=not approved,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("pipeline sales_trust update skipped: %s", e)

    return {
        "deal_id": rec["deal_id"],
        "review_status": rec["review_status"],
        "clean": clean,
        "lessons_recorded": len(written),
        "gbrain_ok": gbrain_ok,
        "trust_header": _trust_header(),
        "trust_level": (trust or {}).get("level"),
    }


# ---------------------------------------------------------------------------
# Tool handlers  (signature: (args, **kw) -> JSON string)
# ---------------------------------------------------------------------------


def _handle_upsert_deal(args: dict, **kw) -> str:
    account = (args.get("account") or "").strip()
    stage = (args.get("stage") or "").strip()
    if not account:
        return tool_error("Missing required parameter: account")
    if stage not in STAGE_PROBABILITY:
        return tool_error(f"stage must be one of {STAGES}")
    try:
        rec = upsert_deal(
            account, stage,
            deal_id=args.get("deal_id") or None,
            amount=args.get("amount") or 0,
            owner=args.get("owner") or "",
            expected_close=args.get("expected_close") or "",
            last_touch=args.get("last_touch") or "",
            notes=args.get("notes") or "",
        )
        return tool_result({"deal": rec, "trust_header": _trust_header()})
    except Exception as e:  # noqa: BLE001
        return tool_error(f"Failed to upsert deal: {e}")


def _handle_list_deals(args: dict, **kw) -> str:
    rows = list_deals(
        stage=args.get("stage") or None,
        owner=args.get("owner") or None,
        open_only=bool(args.get("open_only", False)),
        limit=int(args.get("limit") or 200),
    )
    return tool_result({"count": len(rows), "deals": rows})


def _handle_stalled_deals(args: dict, **kw) -> str:
    rows = stalled_deals(int(args.get("days") or DEFAULT_STALL_DAYS))
    return tool_result({"count": len(rows), "days": int(args.get("days") or DEFAULT_STALL_DAYS), "stalled": rows})


def _handle_forecast(args: dict, **kw) -> str:
    return tool_result({"forecast": forecast(), "trust_header": _trust_header()})


def _handle_record_outcome(args: dict, **kw) -> str:
    deal_id = (args.get("deal_id") or "").strip()
    if not deal_id:
        return tool_error("Missing required parameter: deal_id")
    if load_deal(deal_id) is None:
        return tool_error(f"No deal {deal_id!r}")
    try:
        return tool_result(record_pipeline_outcome(
            deal_id,
            approved=bool(args.get("approved", True)),
            corrected=bool(args.get("corrected", False)),
            lessons=args.get("lessons") or [],
        ))
    except Exception as e:  # noqa: BLE001
        return tool_error(f"Failed to record outcome: {e}")


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

UPSERT_DEAL_SCHEMA = {
    "name": "upsert_deal",
    "description": (
        "Create or update one YES! wholesale/corporate-gifting deal (stage, "
        "amount, account, expected_close, last_touch). Keyed by deal_id (defaults "
        "to a slug of the account). A mutation re-enters human review and is "
        "trust-gated. Returns the stored deal with its stage probability, weighted "
        "amount, and the trust header."
    ),
    "parameters": {"type": "object", "properties": {
        "account": {"type": "string", "description": "Account / company name."},
        "stage": {"type": "string", "enum": STAGES, "description": "Sales stage."},
        "amount": {"type": "number", "description": "Deal value (>= 0)."},
        "owner": {"type": "string", "description": "Deal owner / rep."},
        "expected_close": {"type": "string", "description": "Expected close date (YYYY-MM-DD)."},
        "last_touch": {"type": "string", "description": "Date of last activity (YYYY-MM-DD); defaults to today on create."},
        "notes": {"type": "string"},
        "deal_id": {"type": "string", "description": "Optional stable id; defaults to a slug of the account."},
    }, "required": ["account", "stage"]},
}

LIST_DEALS_SCHEMA = {
    "name": "list_deals",
    "description": "Read-only listing of deals (highest weighted value first). Filter by stage and/or owner; open_only excludes closed deals.",
    "parameters": {"type": "object", "properties": {
        "stage": {"type": "string", "enum": STAGES},
        "owner": {"type": "string"},
        "open_only": {"type": "boolean"},
        "limit": {"type": "integer"},
    }},
}

STALLED_DEALS_SCHEMA = {
    "name": "stalled_deals",
    "description": "Read-only list of OPEN deals with no last_touch activity in N days (default 14), oldest first. Deals with no recorded touch are treated as stalled.",
    "parameters": {"type": "object", "properties": {
        "days": {"type": "integer", "description": "Stall threshold in days (default 14)."},
    }},
}

FORECAST_SCHEMA = {
    "name": "forecast",
    "description": (
        "Read-only weighted weekly forecast over OPEN deals: each deal contributes "
        "amount * stage_probability to its expected_close week. Returns raw and "
        "weighted pipeline totals plus per-week and per-stage breakdowns."
    ),
    "parameters": {"type": "object", "properties": {}},
}

RECORD_OUTCOME_SCHEMA = {
    "name": "record_pipeline_outcome",
    "description": (
        "Record the human verdict on a deal mutation (approved/rejected, and "
        "whether the human had to correct the deal data). Writes pipeline-hygiene "
        "lessons to gbrain and advances the Job 3.2 trust counter. Clean = approved "
        "and not corrected."
    ),
    "parameters": {"type": "object", "properties": {
        "deal_id": {"type": "string"},
        "approved": {"type": "boolean"},
        "corrected": {"type": "boolean", "description": "True if the human corrected stage/amount/close/account (material)."},
        "lessons": {"type": "array", "description": "Generalizable pipeline-hygiene lessons (empty for clean approvals).", "items": {"type": "object", "properties": {
            "category": {"type": "string", "description": "e.g. staging, sizing, close-date, hygiene"},
            "observation": {"type": "string"},
            "rule": {"type": "string"},
        }, "required": ["category", "rule"]}},
    }, "required": ["deal_id"]},
}


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------

from tools.registry import registry, tool_error, tool_result  # noqa: E402

for _name, _schema, _handler, _emoji in [
    ("upsert_deal", UPSERT_DEAL_SCHEMA, _handle_upsert_deal, "📇"),
    ("list_deals", LIST_DEALS_SCHEMA, _handle_list_deals, "📋"),
    ("stalled_deals", STALLED_DEALS_SCHEMA, _handle_stalled_deals, "🛑"),
    ("forecast", FORECAST_SCHEMA, _handle_forecast, "📈"),
    ("record_pipeline_outcome", RECORD_OUTCOME_SCHEMA, _handle_record_outcome, "🎓"),
]:
    registry.register(name=_name, toolset="pipeline", schema=_schema, handler=_handler, emoji=_emoji)
