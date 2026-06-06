"""Sales Persona Job 3.3 — Reorder & Expansion Triggers.

Detect reorder timing for wholesale accounts and surface upsell / expansion
signals, then prompt outreach — **draft only**. The same loop shape as the other
Sales-Persona jobs: order history flows in, a simple cadence model flags accounts
that are *overdue* for a reorder, the agent drafts an outreach prompt for each, a
human approves/edits it, and that verdict feeds the shared Job 3.3 trust counter
so the job graduates L0 -> L1 -> L2 as the operator stops correcting it.

**Order-history source (DEGRADED).** Pulling live wholesale orders needs the
Shopify ``read_orders`` scope, which the operator has not granted. So v1 ingests
order history from CSV/JSON stub files dropped under
``$HERMES_HOME/reorder/orders/`` (one file per account, or a combined file).
Live Shopify order pull is a documented TODO (see ``ingest_order_history``); when
the scope lands, that function gains a real Shopify code path and the rest of the
job is unchanged.

**Cadence model.** For each account we compute the average interval between its
historical orders. An account is *overdue* when ``days_since_last_order`` exceeds
``avg_interval_days * (1 + grace)`` (grace defaults to 0.25). The lead time
(how overdue) and any expansion signals become a drafted reorder prompt — an
UNSENT review-folder artifact under ``$HERMES_HOME/reorder/prompts/``.

Reuses ``blog_learning``'s gbrain helper and the ``sales_trust`` counter. Pure
stdlib; paths resolve from ``HERMES_HOME`` per call so tests stay isolated.

Brand rules in any copy: always "YES!" (with the exclamation), product line
"Celebrational Cacao". Functional/health claims are always human-gated.
"""

from __future__ import annotations

import csv
import io
import json
import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

JOB_ID = "3.3"
GBRAIN_TAG = "reorder-outreach-feedback"
# Account is overdue once it passes avg_interval * (1 + DEFAULT_GRACE).
DEFAULT_GRACE = 0.25
# An account needs at least this many orders to have a meaningful cadence.
MIN_ORDERS_FOR_CADENCE = 2


# ---------------------------------------------------------------------------
# Paths (HERMES_HOME-resolved per call; test-overridable)
# ---------------------------------------------------------------------------


def _hermes_home() -> Path:
    return Path(os.getenv("HERMES_HOME") or (Path.home() / ".hermes"))


def base_dir() -> Path:
    return _hermes_home() / "reorder"


def orders_dir() -> Path:
    # Operator/Shopify-export drop zone for raw order history (stub source).
    return base_dir() / "orders"


def accounts_dir() -> Path:
    # Normalized per-account order history + detected reorder state.
    return base_dir() / "accounts"


def prompts_dir() -> Path:
    # Drafted reorder/expansion outreach prompts (UNSENT review artifacts).
    return base_dir() / "prompts"


def lessons_dir() -> Path:
    return base_dir() / "lessons"


def index_path() -> Path:
    return lessons_dir() / "index.jsonl"


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(value).lower()).strip("-") or "account"


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat()


def _today() -> str:
    return datetime.now().astimezone().strftime("%Y-%m-%d")


# ---------------------------------------------------------------------------
# Reused helpers (lazy imports — a missing gbrain must never break the tool)
# ---------------------------------------------------------------------------


def _gbrain_capture(path: Path) -> Dict[str, Any]:
    try:
        from tools.blog_learning import gbrain_capture
        return gbrain_capture(path)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def _trust_header() -> str:
    try:
        from tools import sales_trust
        return sales_trust.trust_header(JOB_ID)
    except Exception:  # noqa: BLE001
        return "Trust: (unavailable)"


# ---------------------------------------------------------------------------
# Date parsing
# ---------------------------------------------------------------------------


def _parse_date(value: Any) -> Optional[datetime]:
    """Parse a YYYY-MM-DD or ISO-8601 order date into a tz-aware datetime."""
    if not value:
        return None
    s = str(value).strip()
    if not s:
        return None
    # Normalize a trailing Z (Shopify-style) to +00:00 for fromisoformat.
    candidate = s.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(candidate)
    except ValueError:
        for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%m/%d/%Y"):
            try:
                dt = datetime.strptime(s, fmt)
                break
            except ValueError:
                continue
        else:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _norm_orders(raw_orders: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Normalize + sort raw order dicts to ``{date, amount}`` (oldest first)."""
    out: List[Dict[str, Any]] = []
    for o in raw_orders or []:
        if not isinstance(o, dict):
            continue
        dt = _parse_date(o.get("date") or o.get("created_at") or o.get("ordered_at"))
        if dt is None:
            continue
        try:
            amount = float(o.get("amount") or o.get("total") or o.get("total_price") or 0)
        except (TypeError, ValueError):
            amount = 0.0
        out.append({"date": dt.date().isoformat(), "amount": round(amount, 2), "_dt": dt})
    out.sort(key=lambda r: r["_dt"])
    for r in out:
        r.pop("_dt", None)
    return out


# ---------------------------------------------------------------------------
# Order-history ingestion (DEGRADED stub source)
# ---------------------------------------------------------------------------


def _parse_csv(text: str) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    reader = csv.DictReader(io.StringIO(text))
    for row in reader:
        rows.append({(k or "").strip(): (v or "").strip() for k, v in row.items()})
    return rows


def _ingest_rows_to_accounts(rows: List[Dict[str, Any]]) -> List[str]:
    """Group flat order rows by account and persist normalized account history.

    Each row needs an account name (``account`` / ``account_name`` / ``customer``)
    and a date; amount is optional. Returns the account_ids touched.
    """
    grouped: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        name = (row.get("account") or row.get("account_name")
                or row.get("customer") or row.get("company") or "").strip()
        if not name:
            continue
        acct_id = _slug(row.get("account_id") or name)
        slot = grouped.setdefault(acct_id, {"name": name, "orders": []})
        slot["orders"].append(row)
    touched: List[str] = []
    for acct_id, data in grouped.items():
        save_account_history(acct_id, data["name"], data["orders"])
        touched.append(acct_id)
    return touched


def save_account_history(
    account_id: str, name: str, raw_orders: List[Dict[str, Any]]
) -> Dict[str, Any]:
    """Persist (merge) normalized order history for one account."""
    acct_id = _slug(account_id or name)
    existing = load_account(acct_id)
    orders = list((existing or {}).get("orders") or [])
    orders.extend(_norm_orders(raw_orders))
    # De-duplicate on (date, amount); keep oldest-first order.
    seen = set()
    deduped: List[Dict[str, Any]] = []
    for o in sorted(orders, key=lambda r: r["date"]):
        key = (o["date"], o["amount"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(o)
    record = {
        "account_id": acct_id,
        "name": name or (existing or {}).get("name") or acct_id,
        "orders": deduped,
        "updated_at": _now_iso(),
    }
    accounts_dir().mkdir(parents=True, exist_ok=True)
    (accounts_dir() / f"{acct_id}.json").write_text(
        json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    return record


def ingest_order_history(path: Optional[str] = None) -> Dict[str, Any]:
    """Ingest wholesale order history from CSV/JSON stub files under
    ``$HERMES_HOME/reorder/orders/`` (or a single ``path``).

    Supported shapes:
    - CSV with columns: account[,account_id],date[,amount]
    - JSON list of order rows (same fields)
    - JSON object {account_id|name, orders:[{date, amount}, ...]} (per-account)
    - JSON object {accounts:[{...}, ...]} (combined)

    DEGRADED: the live Shopify ``read_orders`` pull is a documented TODO — the
    operator has not granted that scope, so this reads operator-dropped exports
    only. When the scope lands, add a real Shopify branch here.
    """
    targets: List[Path] = []
    if path:
        p = Path(path)
        if p.is_dir():
            targets = sorted(p.glob("*.csv")) + sorted(p.glob("*.json"))
        elif p.exists():
            targets = [p]
    else:
        d = orders_dir()
        if d.exists():
            targets = sorted(d.glob("*.csv")) + sorted(d.glob("*.json"))

    touched: set = set()
    files_read = 0
    errors: List[str] = []
    for fp in targets:
        try:
            text = fp.read_text(encoding="utf-8")
        except OSError as e:
            errors.append(f"{fp.name}: {e}")
            continue
        files_read += 1
        try:
            if fp.suffix.lower() == ".csv":
                touched.update(_ingest_rows_to_accounts(_parse_csv(text)))
            else:
                data = json.loads(text)
                if isinstance(data, list):
                    touched.update(_ingest_rows_to_accounts(data))
                elif isinstance(data, dict) and isinstance(data.get("accounts"), list):
                    for acct in data["accounts"]:
                        if not isinstance(acct, dict):
                            continue
                        nm = acct.get("name") or acct.get("account") or ""
                        save_account_history(
                            acct.get("account_id") or nm, nm, acct.get("orders") or []
                        )
                        touched.add(_slug(acct.get("account_id") or nm))
                elif isinstance(data, dict) and isinstance(data.get("orders"), list):
                    nm = data.get("name") or data.get("account") or fp.stem
                    save_account_history(
                        data.get("account_id") or nm, nm, data["orders"]
                    )
                    touched.add(_slug(data.get("account_id") or nm))
                else:
                    errors.append(f"{fp.name}: unrecognized JSON shape")
        except (json.JSONDecodeError, ValueError) as e:
            errors.append(f"{fp.name}: {e}")
            continue

    return {
        "files_read": files_read,
        "accounts_ingested": sorted(touched),
        "count": len(touched),
        "errors": errors,
        "source": "stub (Shopify read_orders TODO)",
    }


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
    out: List[Dict[str, Any]] = []
    for p in sorted(d.glob("*.json")):
        try:
            out.append(json.loads(p.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            continue
    return out


# ---------------------------------------------------------------------------
# Cadence model
# ---------------------------------------------------------------------------


def cadence(orders: List[Dict[str, Any]], *, as_of: Optional[datetime] = None) -> Dict[str, Any]:
    """Compute the reorder cadence for one account's order history.

    Returns avg interval between orders, days since the last order, the predicted
    next-order date, an ``overdue`` flag, and ``days_overdue`` (how far past the
    grace-adjusted cadence). Insufficient history -> ``enough_history=False``.
    """
    dts = sorted(d for d in (_parse_date(o.get("date")) for o in (orders or [])) if d)
    n = len(dts)
    now = as_of or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    if n == 0:
        return {"enough_history": False, "order_count": 0}
    last = dts[-1]
    days_since_last = (now - last).days
    if n < MIN_ORDERS_FOR_CADENCE:
        return {
            "enough_history": False,
            "order_count": n,
            "last_order_date": last.date().isoformat(),
            "days_since_last_order": days_since_last,
        }
    intervals = [(dts[i] - dts[i - 1]).days for i in range(1, n)]
    intervals = [iv for iv in intervals if iv > 0]
    avg = round(sum(intervals) / len(intervals), 1) if intervals else 0.0
    threshold = avg * (1 + DEFAULT_GRACE)
    overdue = bool(avg > 0 and days_since_last > threshold)
    days_overdue = int(round(days_since_last - avg)) if overdue else 0
    return {
        "enough_history": True,
        "order_count": n,
        "avg_interval_days": avg,
        "last_order_date": last.date().isoformat(),
        "days_since_last_order": days_since_last,
        "next_expected_date": (last.date().isoformat() if avg == 0 else
                               (last + _days(avg)).date().isoformat()),
        "overdue": overdue,
        "days_overdue": days_overdue,
    }


def _days(n: float):
    from datetime import timedelta
    return timedelta(days=float(n))


def detect_reorders(*, as_of: Optional[datetime] = None) -> List[Dict[str, Any]]:
    """Score every ingested account and persist its cadence; return overdue ones.

    Updates each account record with its latest cadence + a ``reorder`` flag so
    ``list_reorder_prompts`` / the injector can read the due set cheaply. The
    returned list (most overdue first) is the set that warrants outreach.
    """
    due: List[Dict[str, Any]] = []
    for acct in _all_accounts():
        cad = cadence(acct.get("orders") or [], as_of=as_of)
        acct["cadence"] = cad
        acct["reorder_due"] = bool(cad.get("overdue"))
        acct["scanned_at"] = _now_iso()
        _save_account(acct)
        if cad.get("overdue"):
            due.append({
                "account_id": acct["account_id"],
                "name": acct.get("name"),
                "avg_interval_days": cad.get("avg_interval_days"),
                "days_since_last_order": cad.get("days_since_last_order"),
                "days_overdue": cad.get("days_overdue"),
                "last_order_date": cad.get("last_order_date"),
                "next_expected_date": cad.get("next_expected_date"),
                "order_count": cad.get("order_count"),
            })
    due.sort(key=lambda r: r.get("days_overdue") or 0, reverse=True)
    return due


# ---------------------------------------------------------------------------
# Reorder / expansion prompts (UNSENT review artifacts)
# ---------------------------------------------------------------------------


def draft_reorder_prompt(
    account_id: str,
    *,
    expansion_signals: Optional[List[str]] = None,
    draft_message: str = "",
    note: str = "",
) -> Dict[str, Any]:
    """Create a drafted reorder/expansion outreach prompt for one account (L0 —
    UNSENT). Writes a review markdown file the operator approves/edits before
    anything is sent. Never sends. Returns the prompt record."""
    acct = load_account(account_id)
    if acct is None:
        raise ValueError(f"No account {account_id!r}")
    cad = acct.get("cadence") or cadence(acct.get("orders") or [])
    signals = [s for s in (expansion_signals or []) if str(s).strip()]
    acct_id = acct["account_id"]
    record = {
        "account_id": acct_id,
        "name": acct.get("name"),
        "cadence": cad,
        "expansion_signals": signals,
        "draft_message": draft_message,
        "note": note,
        "status": "drafted",  # drafted | approved | rejected
        "created_at": _now_iso(),
    }
    prompts_dir().mkdir(parents=True, exist_ok=True)
    (prompts_dir() / f"{acct_id}.json").write_text(
        json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    review_md = (
        f"# Reorder & expansion prompt — {acct.get('name') or acct_id}\n\n"
        f"_YES! Celebrational Cacao wholesale reorder. "
        f"avg cadence: {cad.get('avg_interval_days')}d | "
        f"days since last: {cad.get('days_since_last_order')} | "
        f"days overdue: {cad.get('days_overdue')} | "
        f"last order: {cad.get('last_order_date')}_\n\n"
        f"## Expansion signals\n"
        + ("\n".join(f"- {s}" for s in signals) if signals else "- (none surfaced)")
        + "\n\n"
        f"## Notes\n{note or '(none)'}\n\n"
        f"## Drafted outreach (UNSENT — approve before sending)\n"
        f"{draft_message or '(draft the reorder nudge here)'}\n\n"
        f"> Any functional/health benefit claims must be human-approved before sending.\n"
    )
    (prompts_dir() / f"{acct_id}.md").write_text(review_md, encoding="utf-8")
    return {
        "account_id": acct_id,
        "status": "drafted",
        "review_path": str(prompts_dir() / f"{acct_id}.md"),
        "trust_header": _trust_header(),
    }


def load_prompt(account_id: str) -> Optional[Dict[str, Any]]:
    p = prompts_dir() / f"{_slug(account_id)}.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _save_prompt(record: Dict[str, Any]) -> None:
    prompts_dir().mkdir(parents=True, exist_ok=True)
    (prompts_dir() / f"{record['account_id']}.json").write_text(
        json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def list_reorder_prompts(status: Optional[str] = None, limit: int = 100) -> List[Dict[str, Any]]:
    """List drafted reorder prompts (most overdue first). Filter by status."""
    d = prompts_dir()
    if not d.exists():
        return []
    rows: List[Dict[str, Any]] = []
    for p in sorted(d.glob("*.json")):
        try:
            rows.append(json.loads(p.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            continue
    if status:
        rows = [r for r in rows if r.get("status") == status]
    rows.sort(key=lambda r: (r.get("cadence") or {}).get("days_overdue") or 0, reverse=True)
    return rows[:limit]


# ---------------------------------------------------------------------------
# Outcome — human verdict on a drafted prompt; feeds the Job 3.3 counter
# ---------------------------------------------------------------------------


def _write_lesson(lesson: Dict[str, Any]) -> Path:
    lessons_dir().mkdir(parents=True, exist_ok=True)
    date = _today()
    cat = _slug(lesson.get("category", "reorder"))
    base = f"{date}-{cat}"
    p = lessons_dir() / f"{base}.md"
    i = 2
    while p.exists():
        p = lessons_dir() / f"{base}-{i}.md"
        i += 1
    body = (
        f"---\ntype: {GBRAIN_TAG}\ndate: {date}\n"
        f"category: {json.dumps(lesson.get('category', 'reorder'))}\n"
        f"tags: {json.dumps([GBRAIN_TAG, cat])}\n---\n\n"
        f"# Reorder/expansion lesson — {lesson.get('category', 'reorder')}\n\n"
    )
    if lesson.get("observation"):
        body += f"**Observation:** {lesson['observation']}\n\n"
    if lesson.get("rule"):
        body += f"**Rule:** {lesson['rule']}\n"
    p.write_text(body, encoding="utf-8")
    with index_path().open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({
            "date": date, "category": lesson.get("category", "reorder"),
            "rule": lesson.get("rule", ""), "file": p.name,
        }, ensure_ascii=False) + "\n")
    return p


def record_reorder_outcome(
    account_id: str,
    *,
    ai_draft: str = "",
    human_final: str = "",
    rejected: bool = False,
    structural_change: bool = False,
    lessons: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Record the human verdict on a drafted reorder/expansion prompt. Clean =
    approved with a near-identical message and no structural change. Writes any
    outreach lessons to gbrain and advances the Job 3.3 trust counter. If
    ``ai_draft`` is omitted the stored draft is used."""
    rec = load_prompt(account_id)
    if rec is None:
        raise ValueError(f"No reorder prompt {account_id!r}")
    ai_draft = ai_draft or rec.get("draft_message", "")

    magnitude = None
    if not rejected:
        try:
            from tools.blog_learning import edit_magnitude
            magnitude = edit_magnitude(ai_draft, human_final or ai_draft)
        except Exception:  # noqa: BLE001
            magnitude = 0.0
    clean = (not rejected) and (magnitude is not None) and (magnitude <= 0.02) and not structural_change

    written: List[str] = []
    gbrain_ok = 0
    for lesson in (lessons or []):
        if not isinstance(lesson, dict):
            continue
        try:
            p = _write_lesson(lesson)
        except Exception as e:  # noqa: BLE001
            logger.error("reorder _write_lesson failed: %s", e)
            continue
        written.append(p.name)
        if _gbrain_capture(p).get("ok"):
            gbrain_ok += 1

    rec["status"] = "rejected" if rejected else "approved"
    rec["reviewed_at"] = _now_iso()
    rec["clean"] = clean
    rec["structural_change"] = structural_change
    _save_prompt(rec)

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
        logger.warning("reorder sales_trust update skipped: %s", e)

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
# Tool handlers  (signature: (args, **kw) -> JSON string)
# ---------------------------------------------------------------------------


def _handle_ingest_order_history(args: dict, **kw) -> str:
    try:
        res = ingest_order_history(path=args.get("path") or None)
        res["trust_header"] = _trust_header()
        return tool_result(res)
    except Exception as e:  # noqa: BLE001
        return tool_error(f"Failed to ingest order history: {e}")


def _handle_detect_reorders(args: dict, **kw) -> str:
    try:
        due = detect_reorders()
        return tool_result({
            "count": len(due),
            "overdue": due,
            "source": "stub (Shopify read_orders TODO)",
            "trust_header": _trust_header(),
        })
    except Exception as e:  # noqa: BLE001
        return tool_error(f"Failed to detect reorders: {e}")


def _handle_list_reorder_prompts(args: dict, **kw) -> str:
    rows = list_reorder_prompts(
        status=args.get("status") or None,
        limit=int(args.get("limit") or 100),
    )
    return tool_result({"count": len(rows), "prompts": rows})


def _handle_draft_reorder_prompt(args: dict, **kw) -> str:
    account_id = (args.get("account_id") or "").strip()
    if not account_id:
        return tool_error("Missing required parameter: account_id")
    if load_account(account_id) is None:
        return tool_error(f"No account {account_id!r} (ingest order history first)")
    try:
        return tool_result(draft_reorder_prompt(
            account_id,
            expansion_signals=args.get("expansion_signals") or [],
            draft_message=args.get("draft_message") or "",
            note=args.get("note") or "",
        ))
    except Exception as e:  # noqa: BLE001
        return tool_error(f"Failed to draft reorder prompt: {e}")


def _handle_record_reorder_outcome(args: dict, **kw) -> str:
    account_id = (args.get("account_id") or "").strip()
    if not account_id:
        return tool_error("Missing required parameter: account_id")
    if load_prompt(account_id) is None:
        return tool_error(f"No reorder prompt {account_id!r}")
    try:
        return tool_result(record_reorder_outcome(
            account_id,
            ai_draft=args.get("ai_draft") or "",
            human_final=args.get("human_final") or "",
            rejected=bool(args.get("rejected", False)),
            structural_change=bool(args.get("structural_change", False)),
            lessons=args.get("lessons") or [],
        ))
    except Exception as e:  # noqa: BLE001
        return tool_error(f"Failed to record reorder outcome: {e}")


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

INGEST_SCHEMA = {
    "name": "ingest_order_history",
    "description": (
        "Ingest wholesale order history from operator-dropped CSV/JSON stub files "
        "under $HERMES_HOME/reorder/orders/ (or a given path) and normalize it "
        "per account for cadence analysis. DEGRADED: the live Shopify read_orders "
        "pull is a documented TODO (scope not yet granted), so this reads exports "
        "only. CSV columns: account[,account_id],date[,amount]."
    ),
    "parameters": {"type": "object", "properties": {
        "path": {"type": "string", "description": "Optional file or directory; defaults to the orders drop dir."},
    }},
}

DETECT_SCHEMA = {
    "name": "detect_reorders",
    "description": (
        "Run the cadence model over all ingested wholesale accounts: compute the "
        "average interval between orders and flag accounts that are OVERDUE for a "
        "reorder (days since last order beyond the grace-adjusted cadence). "
        "Returns the overdue set (most overdue first) — the accounts that warrant "
        "a reorder/expansion outreach prompt."
    ),
    "parameters": {"type": "object", "properties": {}},
}

LIST_PROMPTS_SCHEMA = {
    "name": "list_reorder_prompts",
    "description": (
        "List drafted reorder/expansion outreach prompts (most overdue first). "
        "Filter by status (drafted/approved/rejected). These are UNSENT review "
        "artifacts — outreach is human-approved before sending."
    ),
    "parameters": {"type": "object", "properties": {
        "status": {"type": "string", "enum": ["drafted", "approved", "rejected"]},
        "limit": {"type": "integer"},
    }},
}

DRAFT_PROMPT_SCHEMA = {
    "name": "draft_reorder_prompt",
    "description": (
        "Draft a reorder/expansion outreach prompt for one overdue wholesale "
        "account (L0 — UNSENT). Writes a review file the operator approves before "
        "anything is sent. Copy uses YES! Celebrational Cacao; functional/health "
        "claims must be human-approved. Never sends."
    ),
    "parameters": {"type": "object", "properties": {
        "account_id": {"type": "string", "description": "Account id from detect_reorders."},
        "expansion_signals": {"type": "array", "items": {"type": "string"},
                              "description": "Upsell/expansion signals (e.g. seasonal SKU fit, growing order size)."},
        "draft_message": {"type": "string", "description": "The drafted reorder nudge (unsent)."},
        "note": {"type": "string", "description": "Internal note for the reviewer."},
    }, "required": ["account_id"]},
}

RECORD_OUTCOME_SCHEMA = {
    "name": "record_reorder_outcome",
    "description": (
        "Record the human verdict on a drafted reorder/expansion prompt "
        "(approved/edited/rejected). Captures generalizable outreach lessons to "
        "gbrain and advances the Job 3.3 trust counter. Clean = approved with a "
        "near-identical message and no structural change."
    ),
    "parameters": {"type": "object", "properties": {
        "account_id": {"type": "string"},
        "ai_draft": {"type": "string", "description": "AI's draft; defaults to the stored draft."},
        "human_final": {"type": "string", "description": "The human-approved final message."},
        "rejected": {"type": "boolean"},
        "structural_change": {"type": "boolean", "description": "True if the human changed strategy/targeting (material)."},
        "lessons": {"type": "array", "description": "Generalizable reorder/expansion lessons (empty for clean approvals).", "items": {"type": "object", "properties": {
            "category": {"type": "string", "description": "e.g. cadence, expansion, timing, voice"},
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
    ("ingest_order_history", INGEST_SCHEMA, _handle_ingest_order_history, "📦"),
    ("detect_reorders", DETECT_SCHEMA, _handle_detect_reorders, "🔁"),
    ("list_reorder_prompts", LIST_PROMPTS_SCHEMA, _handle_list_reorder_prompts, "📋"),
    ("draft_reorder_prompt", DRAFT_PROMPT_SCHEMA, _handle_draft_reorder_prompt, "✍️"),
    ("record_reorder_outcome", RECORD_OUTCOME_SCHEMA, _handle_record_reorder_outcome, "🎓"),
]:
    registry.register(name=_name, toolset="reorder", schema=_schema, handler=_handler, emoji=_emoji)
