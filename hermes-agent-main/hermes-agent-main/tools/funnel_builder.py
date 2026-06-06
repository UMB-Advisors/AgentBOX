"""Sales Persona Job 1.2 — Funnel & Landing Page Building.

Triggered by a new product / campaign / promotion, this job drafts the
top-of-funnel conversion assets — landing pages, offers, lead magnets (sampler
offer, gifting guide, subscription teaser), email-capture copy, and A/B
variants — for YES! Celebrational Cacao.

Same loop shape as the content / enrichment engines: the agent does the
copywriting, this module stores each funnel page as a draft, writes a
human-reviewable artifact, learns from how the operator edits it, and feeds the
shared Job 1.2 trust counter so funnel drafting graduates L0 -> L1 -> L2 as the
operator stops materially editing pages.

**Degrade note (documented TODO).** Publishing a Shopify *page* or *discount*
needs the ``write_content`` / ``write_price_rules`` scopes the operator has not
granted, so this job NEVER calls live Shopify objects. Every page is written as
an UNSENT review artifact under ``$HERMES_HOME/funnel/review/`` (HTML page body +
an ``offer.json`` sidecar). Live publish is a deferred wire-up (see SKILL.md
"Live publish (TODO)"): once scopes land, a publisher reads the approved review
folder and POSTs the page/discount.

Brand rules baked into copy guidance: always ``YES!`` (with the exclamation),
the product line is ``Celebrational Cacao``, and any health / functional claim is
human-gated (never auto-asserted in a draft).

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

JOB_ID = "1.2"
GBRAIN_TAG = "funnel-feedback"
CLEAN_MAX_MAGNITUDE = 0.02
_HISTORY_CAP = 20
DIGEST_MAX_LESSONS = 60
DIGEST_RECENT_SHOWN = 12

# Funnel page archetypes the job drafts. ``offer_kind`` documents the lead-magnet
# flavor each archetype typically carries.
PAGE_TYPES: Dict[str, Dict[str, str]] = {
    "landing": {"label": "Campaign landing page", "offer_kind": "primary offer"},
    "sampler_offer": {"label": "Sampler offer", "offer_kind": "try-before-you-buy sampler"},
    "gifting_guide": {"label": "Gifting guide", "offer_kind": "gift lead magnet"},
    "subscription_teaser": {"label": "Subscription teaser", "offer_kind": "subscribe-and-save teaser"},
    "lead_magnet": {"label": "Lead magnet", "offer_kind": "email-gated download"},
}

LESSON_CATEGORIES = [
    "headline", "offer", "cta", "voice", "layout/structure",
    "claims/compliance", "email-capture", "ab-variant", "pricing", "imagery",
]


# ---------------------------------------------------------------------------
# Paths (HERMES_HOME-resolved per call; test-overridable)
# ---------------------------------------------------------------------------


def _hermes_home() -> Path:
    return Path(os.getenv("HERMES_HOME") or (Path.home() / ".hermes"))


def base_dir() -> Path:
    return _hermes_home() / "funnel"


def pages_dir() -> Path:
    return base_dir() / "pages"


def review_dir() -> Path:
    return base_dir() / "review"


def lessons_dir() -> Path:
    return base_dir() / "lessons"


def digest_path() -> Path:
    return base_dir() / "house-style.md"


def index_path() -> Path:
    return lessons_dir() / "index.jsonl"


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(value).lower()).strip("-") or "page"


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat()


def _today() -> str:
    return datetime.now().astimezone().strftime("%Y-%m-%d")


def validate_page_type(page_type: str) -> Optional[str]:
    if page_type not in PAGE_TYPES:
        return f"Unknown page_type {page_type!r}. Valid: {', '.join(PAGE_TYPES)}"
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


def _trust_header() -> str:
    try:
        from tools import sales_trust
        return sales_trust.trust_header(JOB_ID)
    except Exception:  # noqa: BLE001
        return "Trust: (unavailable)"


# ---------------------------------------------------------------------------
# Review-artifact rendering (DEGRADE: never publishes to Shopify)
# ---------------------------------------------------------------------------


def _render_review_md(record: Dict[str, Any]) -> str:
    """Human-reviewable markdown wrapper around the page HTML + offer + variants."""
    lines = [
        f"# [{record['page_type']}] {record.get('title') or record['page_id']}",
        "",
        "_Draft for human review — NOT published. Live Shopify page/discount "
        "publish needs write scopes the operator has not granted (see SKILL.md)._",
        "",
        f"- **Campaign:** {record.get('campaign') or '-'}",
        f"- **Product:** {record.get('product') or 'Celebrational Cacao'}",
        f"- **Headline:** {record.get('headline') or '-'}",
        f"- **CTA:** {record.get('cta') or '-'}",
    ]
    offer = record.get("offer") or {}
    if offer:
        lines += ["", "## Offer", "", "```json",
                  json.dumps(offer, indent=2, ensure_ascii=False), "```"]
    if record.get("email_capture"):
        lines += ["", "## Email-capture copy", "", record["email_capture"]]
    lines += ["", "## Page body (HTML)", "", "```html", record.get("body_html") or "", "```"]
    variants = record.get("ab_variants") or []
    if variants:
        lines += ["", "## A/B variants", ""]
        for i, v in enumerate(variants, 1):
            lines.append(f"### Variant {i}: {v.get('label') or chr(64 + i)}")
            if v.get("headline"):
                lines.append(f"- **Headline:** {v['headline']}")
            if v.get("cta"):
                lines.append(f"- **CTA:** {v['cta']}")
            if v.get("notes"):
                lines.append(f"- **Notes:** {v['notes']}")
            lines.append("")
    return "\n".join(lines).rstrip() + "\n"


# ---------------------------------------------------------------------------
# Pages store
# ---------------------------------------------------------------------------


def draft_page(
    page_type: str,
    page_id: str,
    body_html: str,
    *,
    title: str = "",
    headline: str = "",
    cta: str = "",
    campaign: Optional[str] = None,
    product: str = "Celebrational Cacao",
    offer: Optional[Dict[str, Any]] = None,
    email_capture: str = "",
    ab_variants: Optional[List[Dict[str, Any]]] = None,
    model: Optional[str] = None,
) -> Dict[str, Any]:
    """Persist one AI-drafted funnel page (status=pending) and write its review
    artifacts. DEGRADE: writes HTML + offer.json to the review folder; never
    publishes to Shopify."""
    err = validate_page_type(page_type)
    if err:
        raise ValueError(err)
    pid = _slug(page_id)
    pages_dir().mkdir(parents=True, exist_ok=True)
    review_dir().mkdir(parents=True, exist_ok=True)
    record = {
        "page_id": pid,
        "page_type": page_type,
        "created_at": _now_iso(),
        "title": title,
        "headline": headline,
        "cta": cta,
        "campaign": campaign,
        "product": product or "Celebrational Cacao",
        "offer": offer or {},
        "email_capture": email_capture,
        "ab_variants": ab_variants or [],
        "body_html": body_html,
        "model": model,
        "status": "pending",  # pending | approved | rejected
    }
    (pages_dir() / f"{pid}.json").write_text(
        json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    # DEGRADE review artifacts: a readable .md wrapper, the raw page .html, and an
    # offer.json sidecar the future publisher will read once scopes land.
    review_md = review_dir() / f"{pid}.md"
    review_html = review_dir() / f"{pid}.html"
    review_offer = review_dir() / f"{pid}.offer.json"
    review_md.write_text(_render_review_md(record), encoding="utf-8")
    review_html.write_text(body_html or "", encoding="utf-8")
    review_offer.write_text(
        json.dumps(record.get("offer") or {}, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    return {
        "page_id": pid,
        "page_type": page_type,
        "review_path": str(review_md),
        "review_html_path": str(review_html),
        "offer_path": str(review_offer),
        "published": False,
        "publish_todo": (
            "Live Shopify page/discount publish deferred — needs write scopes "
            "the operator has not granted."
        ),
        "trust_header": _trust_header(),
    }


def load_page(page_id: str) -> Optional[Dict[str, Any]]:
    p = pages_dir() / f"{_slug(page_id)}.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _set_status(page_id: str, status: str, **extra: Any) -> None:
    rec = load_page(page_id)
    if rec is None:
        return
    rec["status"] = status
    rec.update(extra)
    (pages_dir() / f"{_slug(page_id)}.json").write_text(
        json.dumps(rec, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def list_pending(limit: int = 100) -> List[Dict[str, Any]]:
    d = pages_dir()
    if not d.exists():
        return []
    out: List[Dict[str, Any]] = []
    for p in sorted(d.glob("*.json")):
        try:
            rec = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if rec.get("status") == "pending":
            out.append({
                "page_id": rec.get("page_id"),
                "page_type": rec.get("page_type"),
                "title": rec.get("title"),
                "campaign": rec.get("campaign"),
                "created_at": rec.get("created_at"),
                "review_path": str(review_dir() / f"{rec.get('page_id')}.md"),
            })
    return out[:limit]


# ---------------------------------------------------------------------------
# Lessons + house-style digest
# ---------------------------------------------------------------------------


def _write_lesson(lesson: Dict[str, Any]) -> Path:
    lessons_dir().mkdir(parents=True, exist_ok=True)
    date = _today()
    cat = _slug(lesson.get("category", "general"))
    base = f"{date}-{cat}"
    p = lessons_dir() / f"{base}.md"
    i = 2
    while p.exists():
        p = lessons_dir() / f"{base}-{i}.md"
        i += 1
    fm = {
        "type": GBRAIN_TAG,
        "date": date,
        "category": lesson.get("category", "general"),
        "tags": [GBRAIN_TAG, cat],
    }
    lines = ["---"]
    lines += [f"{k}: {json.dumps(v, ensure_ascii=False)}" for k, v in fm.items()]
    lines += ["---", "", f"# Funnel lesson — {lesson.get('category', 'general')}", ""]
    for label, key in (("Rule", "rule"), ("Observation", "observation"),
                       ("Before (AI)", "before"), ("After (human)", "after")):
        if lesson.get(key):
            lines += [f"**{label}:** {lesson[key]}", ""]
    p.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    with index_path().open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({
            "date": date,
            "category": lesson.get("category", "general"),
            "rule": lesson.get("rule", ""),
            "edit_magnitude": lesson.get("edit_magnitude"),
            "file": p.name,
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
        key = (ls.get("category", "general"), rule.lower())
        slot = counts.setdefault(key, {"category": ls.get("category", "general"), "rule": rule, "n": 0})
        slot["n"] += 1
    recurring = sorted(counts.values(), key=lambda s: s["n"], reverse=True)
    out = [
        "# YES! Funnel & Landing-Page House-Style",
        "",
        f"_Auto-generated from {len(lessons)} recent funnel lesson(s) on {_today()}._",
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
    base_dir().mkdir(parents=True, exist_ok=True)
    digest_path().write_text("\n".join(out) + "\n", encoding="utf-8")
    return digest_path()


def house_style() -> str:
    p = digest_path()
    return p.read_text(encoding="utf-8") if p.exists() else ""


# ---------------------------------------------------------------------------
# Outcome — the L0-gate verdict; feeds lessons + the Job 1.2 trust counter
# ---------------------------------------------------------------------------


def record_outcome(
    page_id: str,
    ai_draft: str,
    human_final: str = "",
    *,
    rejected: bool = False,
    structural_change: bool = False,
    lessons: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Record the human verdict on a drafted funnel page. Writes funnel lessons to
    gbrain + the house-style digest, marks the page done, and feeds the shared
    Job 1.2 trust counter. Clean = approved AND edit magnitude <= threshold AND
    not a structural change (offer/pricing/positioning changes are structural)."""
    rec = load_page(page_id)
    if rec is None:
        raise ValueError(f"No page {page_id!r}")
    magnitude = None if rejected else edit_magnitude(ai_draft, human_final)
    clean = (
        (not rejected)
        and (magnitude is not None)
        and (magnitude <= CLEAN_MAX_MAGNITUDE)
        and not structural_change
    )

    written: List[str] = []
    gbrain_ok = 0
    for lesson in (lessons or []):
        if not isinstance(lesson, dict):
            continue
        if lesson.get("edit_magnitude") is None and magnitude is not None:
            lesson["edit_magnitude"] = magnitude
        try:
            p = _write_lesson(lesson)
        except Exception as e:  # noqa: BLE001
            logger.error("funnel_builder _write_lesson failed: %s", e)
            continue
        written.append(p.name)
        if gbrain_capture(p).get("ok"):
            gbrain_ok += 1
    if written:
        try:
            refresh_digest()
        except Exception as e:  # noqa: BLE001
            logger.error("funnel_builder refresh_digest failed: %s", e)

    status = "rejected" if rejected else "approved"
    _set_status(page_id, status, reviewed_at=_now_iso(),
                edit_magnitude=magnitude, clean=clean, lessons_count=len(written))

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
        logger.warning("funnel_builder sales_trust update skipped: %s", e)

    return {
        "page_id": _slug(page_id),
        "status": status,
        "clean": clean,
        "edit_magnitude": magnitude,
        "lessons_recorded": len(written),
        "gbrain_ok": gbrain_ok,
        "trust_header": _trust_header(),
        "trust_level": (trust or {}).get("level"),
    }


# ---------------------------------------------------------------------------
# Tool handlers  (signature: (args, **kw) -> JSON string)
# ---------------------------------------------------------------------------


def _handle_draft_landing_page(args: dict, **kw) -> str:
    page_type = (args.get("page_type") or "landing").strip()
    page_id = (args.get("page_id") or "").strip()
    body_html = args.get("body_html") or ""
    err = validate_page_type(page_type)
    if err:
        return tool_error(err)
    if not page_id:
        return tool_error("Missing required parameter: page_id")
    if not body_html:
        return tool_error("Missing required parameter: body_html")
    try:
        return tool_result(draft_page(
            page_type, page_id, body_html,
            title=args.get("title") or "",
            headline=args.get("headline") or "",
            cta=args.get("cta") or "",
            campaign=args.get("campaign") or None,
            product=args.get("product") or "Celebrational Cacao",
            offer=args.get("offer") or {},
            email_capture=args.get("email_capture") or "",
            ab_variants=args.get("ab_variants") or [],
            model=os.getenv("HERMES_BLOG_MODEL"),
        ))
    except Exception as e:  # noqa: BLE001
        return tool_error(f"Failed to draft page: {e}")


def _handle_list_pending_pages(args: dict, **kw) -> str:
    rows = list_pending(int(args.get("limit") or 100))
    return tool_result({"count": len(rows), "pending": rows})


def _handle_get_funnel_house_style(args: dict, **kw) -> str:
    return tool_result({"house_style": house_style()})


def _handle_record_page_outcome(args: dict, **kw) -> str:
    page_id = (args.get("page_id") or "").strip()
    if not page_id:
        return tool_error("Missing required parameter: page_id")
    if load_page(page_id) is None:
        return tool_error(f"No page {page_id!r}")
    try:
        return tool_result(record_outcome(
            page_id,
            ai_draft=args.get("ai_draft") or "",
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

_PAGE_TYPE_ENUM = list(PAGE_TYPES)

DRAFT_LANDING_PAGE_SCHEMA = {
    "name": "draft_landing_page",
    "description": (
        "Draft a YES! Celebrational Cacao funnel page (landing page, sampler "
        "offer, gifting guide, subscription teaser, or lead magnet) as an UNSENT "
        "review artifact. Writes the page HTML, an offer.json sidecar, and a "
        "readable .md to $HERMES_HOME/funnel/review/ — it does NOT publish to "
        "Shopify (write scopes not granted; live publish is a documented TODO). "
        "Always use 'YES!' (with the exclamation) and the product line "
        "'Celebrational Cacao'. Do NOT auto-assert health/functional claims — "
        "leave those for human review. Returns the review paths and trust header."
    ),
    "parameters": {"type": "object", "properties": {
        "page_type": {"type": "string", "enum": _PAGE_TYPE_ENUM},
        "page_id": {"type": "string", "description": "Stable id/slug for this page (e.g. campaign-date key)."},
        "body_html": {"type": "string", "description": "The drafted page body as HTML."},
        "title": {"type": "string"},
        "headline": {"type": "string", "description": "Primary hero headline."},
        "cta": {"type": "string", "description": "Primary call-to-action copy."},
        "campaign": {"type": "string", "description": "Campaign / product / promotion that triggered this."},
        "product": {"type": "string", "description": "Defaults to 'Celebrational Cacao'."},
        "offer": {"type": "object", "description": "Structured offer (e.g. type, discount, sampler SKUs, terms). Pricing/discounts are draft-only."},
        "email_capture": {"type": "string", "description": "Email-capture / opt-in copy for the lead magnet."},
        "ab_variants": {"type": "array", "description": "A/B headline/CTA variants to test.", "items": {"type": "object", "properties": {
            "label": {"type": "string"},
            "headline": {"type": "string"},
            "cta": {"type": "string"},
            "notes": {"type": "string"},
        }}},
    }, "required": ["page_id", "body_html"]},
}

LIST_PENDING_PAGES_SCHEMA = {
    "name": "list_pending_pages",
    "description": "List funnel pages awaiting a human verdict (status=pending), with their review-folder paths.",
    "parameters": {"type": "object", "properties": {"limit": {"type": "integer"}}},
}

GET_FUNNEL_HOUSE_STYLE_SCHEMA = {
    "name": "get_funnel_house_style",
    "description": "Read the learned funnel/landing-page house-style digest (recurring headline/offer/CTA/compliance rules) to apply when drafting.",
    "parameters": {"type": "object", "properties": {}},
}

RECORD_PAGE_OUTCOME_SCHEMA = {
    "name": "record_page_outcome",
    "description": (
        "Record the human verdict on a drafted funnel page (approved/edited/"
        "rejected). Writes funnel lessons to gbrain + the house-style digest and "
        "feeds the shared Funnel (Job 1.2) trust counter. Pass the AI's original "
        "HTML and the human-final HTML so the edit magnitude is scored. An "
        "offer/pricing/positioning change is structural (material regardless of "
        "text magnitude)."
    ),
    "parameters": {"type": "object", "properties": {
        "page_id": {"type": "string"},
        "ai_draft": {"type": "string", "description": "The AI's original drafted page HTML/text."},
        "human_final": {"type": "string", "description": "The human-approved final HTML/text (omit if rejected)."},
        "rejected": {"type": "boolean", "description": "True if the human rejected the draft outright."},
        "structural_change": {"type": "boolean", "description": "True for an offer/pricing/positioning change (material regardless of text magnitude)."},
        "lessons": {"type": "array", "description": "Generalizable funnel lessons from the edits (empty for clean approvals).", "items": {"type": "object", "properties": {
            "category": {"type": "string", "description": "One of: " + ", ".join(LESSON_CATEGORIES)},
            "observation": {"type": "string"},
            "rule": {"type": "string"},
            "before": {"type": "string"},
            "after": {"type": "string"},
        }, "required": ["category", "rule"]}},
    }, "required": ["page_id"]},
}


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------

from tools.registry import registry, tool_error, tool_result  # noqa: E402

for _name, _schema, _handler, _emoji in [
    ("draft_landing_page", DRAFT_LANDING_PAGE_SCHEMA, _handle_draft_landing_page, "🛬"),
    ("list_pending_pages", LIST_PENDING_PAGES_SCHEMA, _handle_list_pending_pages, "📋"),
    ("get_funnel_house_style", GET_FUNNEL_HOUSE_STYLE_SCHEMA, _handle_get_funnel_house_style, "🎨"),
    ("record_page_outcome", RECORD_PAGE_OUTCOME_SCHEMA, _handle_record_page_outcome, "🎓"),
]:
    registry.register(name=_name, toolset="funnel", schema=_schema, handler=_handler, emoji=_emoji)
