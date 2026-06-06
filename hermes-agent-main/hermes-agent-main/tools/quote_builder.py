"""Sales Persona Job 3.1 — Quote & Line-Sheet Generation.

Draft wholesale quotes, line-sheets, and order forms from an inbound inquiry
context plus a price book — the first Conversion-stage job that turns a qualified
account into a priced offer. Same loop shape as the other Sales-Persona jobs: the
agent assembles the quote, this module stores it as an UNSENT review artifact, and
the human verdict feeds the shared Job 3.1 trust counter so quoting graduates
L0 -> L1 -> L2 as the operator stops correcting it.

**Pricing is always human-approved.** Unlike the other jobs, this one carries a
hard floor guard: a quote whose effective unit price falls below the price book's
``floor_price`` for a line is *always* held for human approval regardless of trust
level (``below_floor=True`` on the line). The trust counter governs how much
review the *wording/structure* of a quote needs; it can never authorize shipping a
below-floor price autonomously.

Price book source: ``$HERMES_HOME/quotes/price_book.yaml`` (a small default is
written if absent). Parsed WITHOUT pyyaml — a tiny ``key: value`` / nested-list
reader, with a ``price_book.json`` fallback for anyone who prefers JSON.

Shopify ``draft_order`` would let us push the quote as a live draft order, but
that scope isn't granted — so this DEGRADES to rendering the quote/line-sheet as a
review-folder markdown artifact and marks the live ``draft_order`` push as a
documented TODO. Nothing is sent or published.

Reuses ``blog_learning``'s gbrain + edit-magnitude helpers and the ``sales_trust``
counter. Pure stdlib; paths resolve from ``HERMES_HOME`` per call.
"""

from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

JOB_ID = "3.1"
GBRAIN_TAG = "quote-feedback"
DOC_TYPES = ["quote", "line_sheet", "order_form"]
STATUSES = ["draft", "approved", "rejected"]

# Brand constants — any rendered copy uses these exactly.
BRAND = "YES!"
PRODUCT_LINE = "Celebrational Cacao"

# DEGRADE marker surfaced on every artifact: live Shopify draft_order push needs
# scope we don't have yet.
DRAFT_ORDER_TODO = (
    "TODO(live-wiring): push as a Shopify draft_order once write_draft_orders "
    "scope is granted. Until then this is a review-folder artifact only — nothing "
    "is sent or created in Shopify."
)


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------


def _hermes_home() -> Path:
    return Path(os.getenv("HERMES_HOME") or (Path.home() / ".hermes"))


def base_dir() -> Path:
    return _hermes_home() / "quotes"


def quotes_dir() -> Path:
    return base_dir() / "quotes"


def review_dir() -> Path:
    return base_dir() / "review"


def lessons_index() -> Path:
    return base_dir() / "lessons.jsonl"


def price_book_yaml_path() -> Path:
    return base_dir() / "price_book.yaml"


def price_book_json_path() -> Path:
    return base_dir() / "price_book.json"


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(value).lower()).strip("-") or "quote"


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


# ---------------------------------------------------------------------------
# Price book — default seed + stdlib YAML/JSON reader (no pyyaml)
# ---------------------------------------------------------------------------

DEFAULT_PRICE_BOOK: Dict[str, Any] = {
    "currency": "USD",
    "terms": "Net 30, FOB origin. Wholesale MOQ applies. Prices valid 30 days.",
    "min_order_value": 250.0,
    "products": [
        {
            "sku": "YES-CEL-ORIG-12",
            "name": "YES! Celebrational Cacao — Original (12ct case)",
            "wholesale_price": 42.0,
            "msrp": 84.0,
            "floor_price": 36.0,
            "moq": 6,
            "unit": "case",
        },
        {
            "sku": "YES-CEL-MINT-12",
            "name": "YES! Celebrational Cacao — Mint (12ct case)",
            "wholesale_price": 42.0,
            "msrp": 84.0,
            "floor_price": 36.0,
            "moq": 6,
            "unit": "case",
        },
        {
            "sku": "YES-CEL-GIFT-06",
            "name": "YES! Celebrational Cacao — Gift Box (6ct)",
            "wholesale_price": 30.0,
            "msrp": 60.0,
            "floor_price": 26.0,
            "moq": 4,
            "unit": "box",
        },
    ],
    "volume_breaks": [
        {"min_qty": 24, "discount_pct": 5},
        {"min_qty": 48, "discount_pct": 10},
    ],
}


def _write_default_price_book() -> Path:
    """Write a minimal default price book (YAML) if none exists. Returns its path."""
    base_dir().mkdir(parents=True, exist_ok=True)
    p = price_book_yaml_path()
    p.write_text(_to_yaml(DEFAULT_PRICE_BOOK), encoding="utf-8")
    return p


def _to_yaml(data: Dict[str, Any]) -> str:
    """Render the (shallow) price-book structure as YAML our reader round-trips.

    Deliberately tiny — supports scalars, a top-level list of flat mappings, and
    flat mappings. Not a general YAML emitter."""
    lines: List[str] = ["# YES! Celebrational Cacao wholesale price book", ""]
    for key, val in data.items():
        if isinstance(val, list):
            lines.append(f"{key}:")
            for item in val:
                if isinstance(item, dict):
                    first = True
                    for ik, iv in item.items():
                        prefix = "  - " if first else "    "
                        lines.append(f"{prefix}{ik}: {_scalar(iv)}")
                        first = False
                else:
                    lines.append(f"  - {_scalar(item)}")
        elif isinstance(val, dict):
            lines.append(f"{key}:")
            for ik, iv in val.items():
                lines.append(f"  {ik}: {_scalar(iv)}")
        else:
            lines.append(f"{key}: {_scalar(val)}")
    return "\n".join(lines) + "\n"


def _scalar(v: Any) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    s = str(v)
    # Quote anything with a colon or leading/trailing space to keep parsing simple.
    if ":" in s or s != s.strip() or s == "":
        return json.dumps(s, ensure_ascii=False)
    return s


def _coerce(token: str) -> Any:
    token = token.strip()
    if token == "":
        return ""
    if token[:1] in ("\"", "'"):
        try:
            return json.loads(token) if token[:1] == "\"" else token[1:-1]
        except (json.JSONDecodeError, ValueError):
            return token.strip("\"'")
    low = token.lower()
    if low in ("true", "false"):
        return low == "true"
    if low in ("null", "~", "none"):
        return None
    try:
        if re.fullmatch(r"-?\d+", token):
            return int(token)
        return float(token)
    except ValueError:
        return token


def _parse_simple_yaml(text: str) -> Dict[str, Any]:
    """Parse the small subset of YAML the price book uses (no pyyaml).

    Supports: ``key: value`` scalars, ``key:`` followed by an indented list of
    ``- k: v`` mapping items or ``- scalar`` items, and ``key:`` followed by an
    indented flat mapping. Comments (``#``) and blank lines are ignored."""
    result: Dict[str, Any] = {}
    cur_key: Optional[str] = None
    cur_list: Optional[List[Any]] = None
    cur_map: Optional[Dict[str, Any]] = None

    def _flush() -> None:
        nonlocal cur_key, cur_list, cur_map
        if cur_key is not None:
            if cur_list is not None:
                result[cur_key] = cur_list
            elif cur_map is not None:
                result[cur_key] = cur_map
        cur_key = cur_list = cur_map = None

    for raw in text.splitlines():
        # Strip full-line comments; leave inline values alone (we quote risky ones).
        if raw.strip().startswith("#") or not raw.strip():
            continue
        line = raw.rstrip()
        stripped = line.strip()
        indent = len(line) - len(line.lstrip())

        if indent == 0 and not stripped.startswith("- "):
            _flush()
            if ":" not in stripped:
                continue
            k, _, v = stripped.partition(":")
            k = k.strip()
            if v.strip() == "":
                cur_key = k  # block follows
            else:
                result[k] = _coerce(v)
            continue

        # Indented content belongs to cur_key.
        if cur_key is None:
            continue
        if stripped.startswith("- "):
            item_body = stripped[2:].strip()
            if cur_list is None:
                cur_list = []
            if ":" in item_body:
                k, _, v = item_body.partition(":")
                cur_list.append({k.strip(): _coerce(v)})
            else:
                cur_list.append(_coerce(item_body))
        elif ":" in stripped:
            k, _, v = stripped.partition(":")
            if cur_list is not None and cur_list and isinstance(cur_list[-1], dict):
                # Continuation of the last list item's mapping.
                cur_list[-1][k.strip()] = _coerce(v)
            else:
                if cur_map is None:
                    cur_map = {}
                cur_map[k.strip()] = _coerce(v)
    _flush()
    return result


def load_price_book() -> Dict[str, Any]:
    """Load the price book, preferring YAML, then JSON, writing a default if none.

    Always returns a dict with a ``products`` list (possibly empty)."""
    yp, jp = price_book_yaml_path(), price_book_json_path()
    if not yp.exists() and not jp.exists():
        _write_default_price_book()
    book: Dict[str, Any] = {}
    if yp.exists():
        try:
            book = _parse_simple_yaml(yp.read_text(encoding="utf-8"))
        except Exception as e:  # noqa: BLE001
            logger.error("quote_builder: bad price_book.yaml (%s); trying JSON", e)
            book = {}
    if not book and jp.exists():
        try:
            book = json.loads(jp.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            logger.error("quote_builder: bad price_book.json (%s)", e)
            book = {}
    book.setdefault("products", [])
    book.setdefault("currency", "USD")
    return book


def _find_product(book: Dict[str, Any], key: str) -> Optional[Dict[str, Any]]:
    """Match a line's sku/name (case-insensitive) against the price book."""
    key_l = str(key).strip().lower()
    for prod in book.get("products", []):
        if not isinstance(prod, dict):
            continue
        if str(prod.get("sku", "")).lower() == key_l:
            return prod
        if str(prod.get("name", "")).lower() == key_l:
            return prod
    return None


# ---------------------------------------------------------------------------
# Quote assembly + the hard floor guard
# ---------------------------------------------------------------------------


def _price_lines(
    book: Dict[str, Any], line_items: List[Dict[str, Any]]
) -> Tuple[List[Dict[str, Any]], bool]:
    """Resolve each requested line against the price book.

    Each input item: ``{sku|name, qty, unit_price?}``. ``unit_price`` overrides
    the book's wholesale price (an operator/agent-proposed deal price). Returns
    the priced lines and whether ANY line is below its floor."""
    priced: List[Dict[str, Any]] = []
    any_below_floor = False
    for item in line_items or []:
        if not isinstance(item, dict):
            continue
        key = item.get("sku") or item.get("name") or ""
        prod = _find_product(book, key)
        try:
            qty = float(item.get("qty", 0) or 0)
        except (TypeError, ValueError):
            qty = 0.0
        if prod is None:
            priced.append({
                "sku": item.get("sku", ""),
                "name": item.get("name", key),
                "qty": qty,
                "unit_price": item.get("unit_price"),
                "line_total": None,
                "unknown_sku": True,
                "below_floor": False,
                "note": "Not in price book — pricing requires human entry.",
            })
            continue
        book_price = float(prod.get("wholesale_price", 0) or 0)
        override = item.get("unit_price")
        try:
            unit_price = float(override) if override is not None else book_price
        except (TypeError, ValueError):
            unit_price = book_price
        floor = float(prod.get("floor_price", 0) or 0)
        below_floor = floor > 0 and unit_price < floor
        if below_floor:
            any_below_floor = True
        priced.append({
            "sku": prod.get("sku", ""),
            "name": prod.get("name", key),
            "qty": qty,
            "unit": prod.get("unit", "unit"),
            "unit_price": round(unit_price, 2),
            "book_price": round(book_price, 2),
            "floor_price": round(floor, 2),
            "moq": prod.get("moq"),
            "below_moq": bool(prod.get("moq")) and qty < float(prod.get("moq") or 0),
            "line_total": round(unit_price * qty, 2),
            "below_floor": below_floor,
            "unknown_sku": False,
        })
    return priced, any_below_floor


def draft_quote(
    account: str,
    line_items: List[Dict[str, Any]],
    *,
    quote_id: Optional[str] = None,
    doc_type: str = "quote",
    inquiry_context: str = "",
    notes: str = "",
) -> Dict[str, Any]:
    """Assemble + store an UNSENT quote/line-sheet/order-form review artifact.

    Resolves each line against the price book, applies the hard floor guard
    (any below-floor line flags the whole quote ``requires_human_approval``
    regardless of trust level), renders a review-folder markdown artifact, and
    records the quote as ``status=draft``. Never sends or pushes to Shopify."""
    if doc_type not in DOC_TYPES:
        raise ValueError(f"doc_type must be one of {DOC_TYPES}")
    if not account or not str(account).strip():
        raise ValueError("account is required")

    book = load_price_book()
    priced, any_below_floor = _price_lines(book, line_items)
    subtotal = round(sum((ln.get("line_total") or 0) for ln in priced), 2)
    has_unknown = any(ln.get("unknown_sku") for ln in priced)
    # Hard floor guard: below-floor OR unknown-SKU pricing is ALWAYS human-gated.
    requires_human_approval = True  # L0 baseline; below-floor never overridable.

    qid = _slug(quote_id or f"{account}-{_today()}")
    record = {
        "quote_id": qid,
        "account": account,
        "doc_type": doc_type,
        "currency": book.get("currency", "USD"),
        "terms": book.get("terms", ""),
        "min_order_value": book.get("min_order_value"),
        "inquiry_context": inquiry_context,
        "notes": notes,
        "lines": priced,
        "subtotal": subtotal,
        "below_min_order": (
            book.get("min_order_value") is not None
            and subtotal < float(book.get("min_order_value") or 0)
        ),
        "any_below_floor": any_below_floor,
        "has_unknown_sku": has_unknown,
        "requires_human_approval": requires_human_approval,
        "pricing_human_approved": False,
        "status": "draft",
        "draft_order_todo": DRAFT_ORDER_TODO,
        "created_at": _now_iso(),
    }
    _save_quote(record)
    review_path = _render_review(record)
    record["review_path"] = str(review_path)
    _save_quote(record)
    return {
        "quote_id": qid,
        "doc_type": doc_type,
        "subtotal": subtotal,
        "any_below_floor": any_below_floor,
        "has_unknown_sku": has_unknown,
        "requires_human_approval": requires_human_approval,
        "review_path": str(review_path),
        "draft_order_todo": DRAFT_ORDER_TODO,
        "trust_header": _trust_header(),
    }


def _quote_path(quote_id: str) -> Path:
    return quotes_dir() / f"{_slug(quote_id)}.json"


def _save_quote(record: Dict[str, Any]) -> None:
    quotes_dir().mkdir(parents=True, exist_ok=True)
    _quote_path(record["quote_id"]).write_text(
        json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def load_quote(quote_id: str) -> Optional[Dict[str, Any]]:
    p = _quote_path(quote_id)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def list_pending(limit: int = 100) -> List[Dict[str, Any]]:
    d = quotes_dir()
    if not d.exists():
        return []
    out = []
    for p in sorted(d.glob("*.json")):
        try:
            rec = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if rec.get("status") == "draft":
            out.append(rec)
    return out[:limit]


def _render_review(rec: Dict[str, Any]) -> Path:
    """Render the human-facing review artifact (markdown). Unsent."""
    review_dir().mkdir(parents=True, exist_ok=True)
    p = review_dir() / f"{rec['quote_id']}.md"
    cur = rec.get("currency", "USD")
    title = {
        "quote": "Wholesale Quote",
        "line_sheet": "Wholesale Line-Sheet",
        "order_form": "Wholesale Order Form",
    }.get(rec["doc_type"], "Wholesale Quote")

    lines = [
        f"# {BRAND} {PRODUCT_LINE} — {title}",
        "",
        f"_Account: {rec.get('account')} | {rec.get('created_at')}_",
        "",
        "> PRICING IS HUMAN-APPROVED. This is an UNSENT draft — review every line "
        "before sending or creating any order.",
        "",
        f"> {rec.get('draft_order_todo')}",
        "",
    ]
    if rec.get("inquiry_context"):
        lines += ["## Inquiry context", rec["inquiry_context"], ""]
    lines += ["## Lines", "", "| SKU | Item | Qty | Unit | Unit price | Line total | Flags |",
              "|---|---|---|---|---|---|---|"]
    for ln in rec.get("lines", []):
        flags = []
        if ln.get("below_floor"):
            flags.append("BELOW FLOOR — human approval required")
        if ln.get("unknown_sku"):
            flags.append("UNKNOWN SKU — price manually")
        if ln.get("below_moq"):
            flags.append(f"below MOQ ({ln.get('moq')})")
        up = ln.get("unit_price")
        lt = ln.get("line_total")
        lines.append(
            f"| {ln.get('sku', '')} | {ln.get('name', '')} | {ln.get('qty')} | "
            f"{ln.get('unit', '')} | {('%s %.2f' % (cur, up)) if up is not None else 'TBD'} | "
            f"{('%s %.2f' % (cur, lt)) if lt is not None else 'TBD'} | "
            f"{'; '.join(flags) if flags else 'ok'} |"
        )
    lines += ["", f"**Subtotal:** {cur} {rec.get('subtotal'):.2f}"]
    if rec.get("below_min_order"):
        lines.append(
            f"\n> Below minimum order value ({cur} {rec.get('min_order_value')}). "
            "Confirm before sending."
        )
    if rec.get("terms"):
        lines += ["", "## Terms", rec["terms"]]
    if rec.get("notes"):
        lines += ["", "## Notes", rec["notes"]]
    lines += [
        "",
        "## Approval",
        "Pricing on this document must be approved by a human before it leaves the "
        "building — the trust counter never overrides the pricing floor.",
        "",
        f"_{_trust_header()}_",
        "",
    ]
    p.write_text("\n".join(lines), encoding="utf-8")
    return p


# ---------------------------------------------------------------------------
# Lessons (pricing/positioning) + gbrain
# ---------------------------------------------------------------------------


def _write_lessons(lessons: List[Dict[str, Any]]) -> Tuple[int, int]:
    written = 0
    gbrain_ok = 0
    base_dir().mkdir(parents=True, exist_ok=True)
    for lesson in (lessons or []):
        if not isinstance(lesson, dict):
            continue
        date = _today()
        cat = _slug(lesson.get("category", "pricing"))
        lf = base_dir() / f"lesson-{date}-{cat}-{written}.md"
        body = (
            f"---\ntype: {GBRAIN_TAG}\ndate: {date}\n"
            f"category: {json.dumps(lesson.get('category', 'pricing'))}\n"
            f"tags: {json.dumps([GBRAIN_TAG, cat])}\n---\n\n"
            f"# Quote lesson — {lesson.get('category', 'pricing')}\n\n"
            f"**Rule:** {lesson.get('rule', '')}\n"
        )
        if lesson.get("observation"):
            body += f"\n**Observation:** {lesson['observation']}\n"
        try:
            lf.write_text(body, encoding="utf-8")
        except OSError:
            continue
        written += 1
        try:
            with lessons_index().open("a", encoding="utf-8") as fh:
                fh.write(json.dumps({
                    "date": date, "category": lesson.get("category", "pricing"),
                    "rule": lesson.get("rule", ""), "file": lf.name,
                }, ensure_ascii=False) + "\n")
        except OSError:
            pass
        if _gbrain_capture(lf).get("ok"):
            gbrain_ok += 1
    return written, gbrain_ok


# ---------------------------------------------------------------------------
# Outcome — human verdict on a drafted quote; feeds the Job 3.1 counter
# ---------------------------------------------------------------------------


def record_outcome(
    quote_id: str,
    *,
    ai_draft: str = "",
    human_final: str = "",
    rejected: bool = False,
    structural_change: bool = False,
    pricing_changed: bool = False,
    lessons: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Record the human verdict on a drafted quote and advance the Job 3.1 counter.

    Clean = approved AND wording edit <= threshold AND no structural change AND no
    pricing change. ANY pricing change is material (``pricing_changed`` is folded
    into ``structural_change``) — pricing is the judgment-heavy part of this job.
    Captures pricing/positioning lessons to gbrain."""
    rec = load_quote(quote_id)
    if rec is None:
        raise ValueError(f"No quote {quote_id!r}")

    structural = bool(structural_change or pricing_changed)
    magnitude = None
    if not rejected:
        magnitude = _edit_magnitude(ai_draft or "", human_final or ai_draft or "")
    clean = (
        (not rejected)
        and (magnitude is not None)
        and (magnitude <= 0.02)
        and not structural
    )

    written, gbrain_ok = _write_lessons(lessons or [])

    rec["status"] = "rejected" if rejected else "approved"
    rec["resolved_at"] = _now_iso()
    rec["clean"] = clean
    rec["pricing_changed"] = pricing_changed
    # An approved (not rejected) quote means a human signed off the pricing.
    rec["pricing_human_approved"] = not rejected
    _save_quote(rec)

    trust = None
    try:
        from tools import sales_trust
        trust = sales_trust.record_outcome(
            JOB_ID,
            magnitude=(magnitude if magnitude is not None else 0.0),
            structural_change=structural,
            rejected=rejected,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("quote_builder sales_trust update skipped: %s", e)

    return {
        "quote_id": rec["quote_id"],
        "status": rec["status"],
        "clean": clean,
        "pricing_changed": pricing_changed,
        "lessons_recorded": written,
        "gbrain_ok": gbrain_ok,
        "trust_header": _trust_header(),
        "trust_level": (trust or {}).get("level"),
    }


# ---------------------------------------------------------------------------
# Tool handlers
# ---------------------------------------------------------------------------


def _handle_get_price_book(args: dict, **kw) -> str:
    return tool_result({"price_book": load_price_book(), "path": str(price_book_yaml_path())})


def _handle_draft_quote(args: dict, **kw) -> str:
    account = (args.get("account") or "").strip()
    if not account:
        return tool_error("Missing required parameter: account")
    line_items = args.get("line_items")
    if not isinstance(line_items, list) or not line_items:
        return tool_error("Missing required parameter: line_items (non-empty array)")
    doc_type = args.get("doc_type") or "quote"
    if doc_type not in DOC_TYPES:
        return tool_error(f"doc_type must be one of {DOC_TYPES}")
    try:
        return tool_result(draft_quote(
            account, line_items,
            quote_id=args.get("quote_id") or None,
            doc_type=doc_type,
            inquiry_context=args.get("inquiry_context") or "",
            notes=args.get("notes") or "",
        ))
    except Exception as e:  # noqa: BLE001
        return tool_error(f"Failed to draft quote: {e}")


def _handle_list_pending(args: dict, **kw) -> str:
    rows = list_pending(int(args.get("limit") or 100))
    return tool_result({"count": len(rows), "pending": rows})


def _handle_record_outcome(args: dict, **kw) -> str:
    qid = (args.get("quote_id") or "").strip()
    if not qid:
        return tool_error("Missing required parameter: quote_id")
    if load_quote(qid) is None:
        return tool_error(f"No quote {qid!r}")
    try:
        return tool_result(record_outcome(
            qid,
            ai_draft=args.get("ai_draft") or "",
            human_final=args.get("human_final") or "",
            rejected=bool(args.get("rejected", False)),
            structural_change=bool(args.get("structural_change", False)),
            pricing_changed=bool(args.get("pricing_changed", False)),
            lessons=args.get("lessons") or [],
        ))
    except Exception as e:  # noqa: BLE001
        return tool_error(f"Failed to record outcome: {e}")


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

GET_PRICE_BOOK_SCHEMA = {
    "name": "get_price_book",
    "description": (
        "Read the YES! Celebrational Cacao wholesale price book ($HERMES_HOME/"
        "quotes/price_book.yaml; a default is written if absent). Returns products "
        "with wholesale_price, msrp, floor_price, moq, plus terms and volume "
        "breaks. Use these prices when assembling a quote — the floor_price is the "
        "hard floor below which any line is always held for human approval."
    ),
    "parameters": {"type": "object", "properties": {}},
}

DRAFT_QUOTE_SCHEMA = {
    "name": "draft_quote",
    "description": (
        "Assemble an UNSENT wholesale quote / line-sheet / order-form from line "
        "items priced against the price book, and render it as a review-folder "
        "artifact for human approval. Pricing is ALWAYS human-approved: any line "
        "below its floor_price (or an unknown SKU) is flagged and the whole "
        "document requires human sign-off regardless of trust level. Does NOT send "
        "or create a Shopify draft_order (scope not granted — that wiring is a "
        "documented TODO)."
    ),
    "parameters": {"type": "object", "properties": {
        "account": {"type": "string", "description": "Buyer / account name."},
        "doc_type": {"type": "string", "enum": DOC_TYPES, "description": "quote (default), line_sheet, or order_form."},
        "line_items": {"type": "array", "description": "Requested lines.", "items": {"type": "object", "properties": {
            "sku": {"type": "string", "description": "Price-book SKU (preferred match key)."},
            "name": {"type": "string", "description": "Product name (fallback match key)."},
            "qty": {"type": "number"},
            "unit_price": {"type": "number", "description": "Optional proposed unit price; below floor_price it is flagged and gated."},
        }, "required": ["qty"]}},
        "inquiry_context": {"type": "string", "description": "What the buyer asked for (from the inquiry)."},
        "notes": {"type": "string", "description": "Extra terms / context for the document."},
        "quote_id": {"type": "string", "description": "Optional stable id; defaults to account+date slug."},
    }, "required": ["account", "line_items"]},
}

LIST_PENDING_SCHEMA = {
    "name": "list_pending_quotes",
    "description": "List drafted quotes/line-sheets awaiting a human verdict (status=draft).",
    "parameters": {"type": "object", "properties": {"limit": {"type": "integer"}}},
}

RECORD_OUTCOME_SCHEMA = {
    "name": "record_quote_outcome",
    "description": (
        "Record the human verdict on a drafted quote (approved/edited/rejected). "
        "Feeds the Job 3.1 trust counter and captures pricing/positioning lessons "
        "to gbrain. ANY pricing change is material (pricing_changed) and resets the "
        "streak — pricing is the judgment-heavy part of this job. Clean = approved "
        "with no structural/pricing change and only trivial wording edits."
    ),
    "parameters": {"type": "object", "properties": {
        "quote_id": {"type": "string"},
        "ai_draft": {"type": "string", "description": "AI's drafted document text."},
        "human_final": {"type": "string", "description": "Human-approved final text (omit if rejected)."},
        "rejected": {"type": "boolean"},
        "structural_change": {"type": "boolean", "description": "True for a structural/positioning change (material regardless of wording)."},
        "pricing_changed": {"type": "boolean", "description": "True if the human changed any price — always material."},
        "lessons": {"type": "array", "items": {"type": "object", "properties": {
            "category": {"type": "string", "description": "e.g. pricing, discount, terms, positioning, moq"},
            "observation": {"type": "string"},
            "rule": {"type": "string"},
        }, "required": ["category", "rule"]}},
    }, "required": ["quote_id"]},
}


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------

from tools.registry import registry, tool_error, tool_result  # noqa: E402

for _name, _schema, _handler, _emoji in [
    ("get_price_book", GET_PRICE_BOOK_SCHEMA, _handle_get_price_book, "📒"),
    ("draft_quote", DRAFT_QUOTE_SCHEMA, _handle_draft_quote, "🧾"),
    ("list_pending_quotes", LIST_PENDING_SCHEMA, _handle_list_pending, "📋"),
    ("record_quote_outcome", RECORD_OUTCOME_SCHEMA, _handle_record_outcome, "🎓"),
]:
    registry.register(name=_name, toolset="quotes", schema=_schema, handler=_handler, emoji=_emoji)
