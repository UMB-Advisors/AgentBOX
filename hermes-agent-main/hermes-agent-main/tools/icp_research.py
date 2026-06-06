"""Sales Persona Job 1.1 — Market & ICP Research.

The first link in the YES! Celebrational Cacao sales chain: define *who* we sell
to and *what we're up against* so every downstream job (enrichment 2.1, content
1.3, outbound 2.x) scores and writes against the same target.

The agent researches via ``web_search`` / ``x_search`` (and may read the live
Shopify catalog read-only via ``tools.shopify_tools._req``, best-effort) and
distils three artifacts, all stored here as JSON:

* **ICP definitions** — one per segment (DTC consumer, wholesale buyer, corporate
  gifting): the firmographic/psychographic profile, fit signals, and
  disqualifiers.
* **Competitive brief** — a craft-chocolate / premium-CPG teardown: one record
  per competitor (positioning, price tier, channels, strengths/gaps).
* **Seasonal demand calendar** — the gifting peaks (Valentine's, Mother's Day,
  holiday, corporate Q4, etc.) that pace outbound and content.

CRITICAL CROSS-WIRE: whenever an ICP segment is written, this module ALSO emits
a plain-text rubric to ``$HERMES_HOME/enrichment/icp_rubric.md`` (consumed by
Job 2.1's ``get_icp_rubric``) and ``$HERMES_HOME/content_engine/icp_digest.md``
(consumed by the content-brief injector). Those two files are the contract by
which Job 1.1's judgement flows into the rest of the persona.

Same loop shape as the other Sales jobs: the agent drafts research, the human
reviews it, and the verdict feeds the shared ``sales_trust`` counter so the job
graduates L0 -> L1 -> L2. Job 1.1 is **judgment-heavy** (graduation candidate
LOW): the trust category defaults to ``judgment`` in ``sales_trust``.

Reuses ``blog_learning``'s gbrain / text helpers (lazy import — a missing gbrain
must never break a tool). Pure stdlib; paths resolve from ``HERMES_HOME`` per
call so tests stay isolated.
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

JOB_ID = "1.1"
GBRAIN_TAG = "icp-research-feedback"
DIGEST_MAX_LESSONS = 60

# ICP segments this job defines. Free-form `other` allowed for edge segments.
ICP_SEGMENTS = ["dtc_consumer", "wholesale_buyer", "corporate_gifting", "other"]
# Competitor price tiers for the teardown.
PRICE_TIERS = ["value", "mainstream", "premium", "luxury", "unknown"]


# ---------------------------------------------------------------------------
# Paths (HERMES_HOME-resolved per call; test-overridable)
# ---------------------------------------------------------------------------


def _hermes_home() -> Path:
    return Path(os.getenv("HERMES_HOME") or (Path.home() / ".hermes"))


def base_dir() -> Path:
    return _hermes_home() / "icp_research"


def icp_dir() -> Path:
    return base_dir() / "icp"


def competitors_dir() -> Path:
    return base_dir() / "competitors"


def calendar_path() -> Path:
    return base_dir() / "demand_calendar.json"


def lessons_dir() -> Path:
    return base_dir() / "lessons"


def index_path() -> Path:
    return lessons_dir() / "index.jsonl"


def digest_path() -> Path:
    # Learned research refinements (output of the loop).
    return base_dir() / "research-digest.md"


# Cross-wired outputs consumed by other jobs ------------------------------


def enrichment_rubric_path() -> Path:
    # Consumed by Job 2.1 enrichment_tools.get_icp_rubric().
    return _hermes_home() / "enrichment" / "icp_rubric.md"


def content_digest_path() -> Path:
    # Consumed by the content-brief injector (Job 1.3 content engine).
    return _hermes_home() / "content_engine" / "icp_digest.md"


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(value).lower()).strip("-") or "item"


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat()


def _today() -> str:
    return datetime.now().astimezone().strftime("%Y-%m-%d")


# ---------------------------------------------------------------------------
# Reused helpers (lazy import — never let a missing gbrain break a tool)
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
# Optional read-only Shopify catalog peek (best-effort — never raises)
# ---------------------------------------------------------------------------


def peek_catalog(limit: int = 50) -> Dict[str, Any]:
    """Read a slice of the live Shopify product catalog, read-only.

    Best-effort context for the researcher (own pricing / line breadth). GET-only
    against ``products.json``; any failure (unscoped token, network, missing
    module) degrades to ``{"ok": False, ...}`` and never raises. Live wiring of
    richer catalog signals is a documented TODO pending expanded Shopify scopes.
    """
    try:
        from tools import shopify_tools
        res = shopify_tools._req("GET", f"products.json?limit={int(limit)}")
    except Exception as e:  # noqa: BLE001 - catalog peek is best-effort
        return {"ok": False, "error": f"{type(e).__name__}: {e}", "products": []}
    products = res.get("products", []) if isinstance(res, dict) else []
    slim = [
        {
            "id": p.get("id"),
            "title": p.get("title"),
            "product_type": p.get("product_type"),
            "tags": p.get("tags"),
        }
        for p in products
    ]
    return {"ok": True, "count": len(slim), "products": slim}


# ---------------------------------------------------------------------------
# ICP segments
# ---------------------------------------------------------------------------


def record_icp_segment(
    segment: str,
    *,
    title: str = "",
    description: str = "",
    fit_signals: Optional[List[str]] = None,
    disqualifiers: Optional[List[str]] = None,
    demographics: Optional[Dict[str, Any]] = None,
    channels: Optional[List[str]] = None,
    pain_points: Optional[List[str]] = None,
    sources: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Store / overwrite one ICP segment definition, then re-emit the cross-wired
    rubric + content digest so Jobs 2.1 / 1.3 pick it up."""
    if segment not in ICP_SEGMENTS:
        raise ValueError(f"segment must be one of {ICP_SEGMENTS}")
    icp_dir().mkdir(parents=True, exist_ok=True)
    record = {
        "segment": segment,
        "title": title or segment.replace("_", " ").title(),
        "description": description,
        "fit_signals": list(fit_signals or []),
        "disqualifiers": list(disqualifiers or []),
        "demographics": demographics or {},
        "channels": list(channels or []),
        "pain_points": list(pain_points or []),
        "sources": list(sources or []),
        "updated_at": _now_iso(),
    }
    (icp_dir() / f"{_slug(segment)}.json").write_text(
        json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    # Cross-wire: regenerate the downstream rubric + digest. Best-effort.
    try:
        export_icp_rubric()
    except Exception as e:  # noqa: BLE001
        logger.error("icp_research export_icp_rubric failed: %s", e)
    return record


def load_icp_segment(segment: str) -> Optional[Dict[str, Any]]:
    p = icp_dir() / f"{_slug(segment)}.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def list_icp_segments() -> List[Dict[str, Any]]:
    d = icp_dir()
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
# Cross-wired exports — the contract with Jobs 2.1 and 1.3
# ---------------------------------------------------------------------------


def _render_icp_rubric_md(segments: List[Dict[str, Any]]) -> str:
    out = [
        "# YES! Celebrational Cacao — ICP Rubric",
        "",
        f"_Source: Sales Persona Job 1.1 (Market & ICP Research). Updated {_today()}._",
        "",
        "Score prospect accounts against the fit signals below; subtract for "
        "disqualifiers. Segments: DTC consumer, wholesale buyer, corporate gifting.",
        "",
    ]
    if not segments:
        out.append("- _(No ICP segments defined yet — Job 1.1 pending.)_")
        return "\n".join(out) + "\n"
    for s in segments:
        out.append(f"## {s.get('title') or s.get('segment')}")
        out.append("")
        if s.get("description"):
            out.append(s["description"])
            out.append("")
        if s.get("fit_signals"):
            out.append("**Fit signals (score up):**")
            out += [f"- {sig}" for sig in s["fit_signals"]]
            out.append("")
        if s.get("disqualifiers"):
            out.append("**Disqualifiers (score down / drop):**")
            out += [f"- {d}" for d in s["disqualifiers"]]
            out.append("")
        if s.get("channels"):
            out.append("**Channels:** " + ", ".join(s["channels"]))
            out.append("")
    return "\n".join(out).rstrip() + "\n"


def _render_content_digest_md(
    segments: List[Dict[str, Any]], competitors: List[Dict[str, Any]]
) -> str:
    out = [
        "# YES! ICP & Positioning Digest (for content briefs)",
        "",
        f"_Source: Sales Persona Job 1.1. Updated {_today()}._",
        "",
        "## Who we write for",
        "",
    ]
    if segments:
        for s in segments:
            line = f"- **{s.get('title') or s.get('segment')}**"
            if s.get("description"):
                line += f": {s['description']}"
            out.append(line)
            for pp in (s.get("pain_points") or [])[:4]:
                out.append(f"    - pain: {pp}")
    else:
        out.append("- _(No ICP segments defined yet — Job 1.1 pending.)_")
    out.append("")
    out.append("## Competitive landscape (what to differentiate against)")
    out.append("")
    if competitors:
        for c in competitors[:12]:
            tier = c.get("price_tier") or "unknown"
            pos = c.get("positioning") or ""
            out.append(f"- **{c.get('name')}** [{tier}]: {pos}")
    else:
        out.append("- _(No competitors recorded yet.)_")
    out.append("")
    out.append(
        "Brand rules: always write the brand as \"YES!\" (with the exclamation); "
        "product line is \"Celebrational Cacao\". Health/functional claims are "
        "human-gated — never assert them in copy."
    )
    return "\n".join(out).rstrip() + "\n"


def export_icp_rubric() -> Dict[str, str]:
    """Regenerate both cross-wired artifacts from current ICP + competitor state.

    Returns the two paths written. Called automatically on every ICP write, and
    exposed as a tool so the operator can force a refresh."""
    segments = list_icp_segments()
    competitors = list_competitors()
    rubric = _render_icp_rubric_md(segments)
    digest = _render_content_digest_md(segments, competitors)

    rp = enrichment_rubric_path()
    rp.parent.mkdir(parents=True, exist_ok=True)
    rp.write_text(rubric, encoding="utf-8")

    cp = content_digest_path()
    cp.parent.mkdir(parents=True, exist_ok=True)
    cp.write_text(digest, encoding="utf-8")
    return {"icp_rubric": str(rp), "content_digest": str(cp)}


# ---------------------------------------------------------------------------
# Competitors
# ---------------------------------------------------------------------------


def record_competitor(
    name: str,
    *,
    competitor_id: Optional[str] = None,
    positioning: str = "",
    price_tier: str = "unknown",
    website: str = "",
    channels: Optional[List[str]] = None,
    strengths: Optional[List[str]] = None,
    gaps: Optional[List[str]] = None,
    notes: str = "",
    sources: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Store one competitor teardown (craft-chocolate / premium-CPG)."""
    if price_tier not in PRICE_TIERS:
        raise ValueError(f"price_tier must be one of {PRICE_TIERS}")
    comp_id = _slug(competitor_id or name)
    competitors_dir().mkdir(parents=True, exist_ok=True)
    record = {
        "competitor_id": comp_id,
        "name": name,
        "positioning": positioning,
        "price_tier": price_tier,
        "website": website,
        "channels": list(channels or []),
        "strengths": list(strengths or []),
        "gaps": list(gaps or []),
        "notes": notes,
        "sources": list(sources or []),
        "updated_at": _now_iso(),
    }
    (competitors_dir() / f"{comp_id}.json").write_text(
        json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    # Competitors feed the content digest; refresh it. Best-effort.
    try:
        export_icp_rubric()
    except Exception as e:  # noqa: BLE001
        logger.error("icp_research export after competitor write failed: %s", e)
    return record


def list_competitors() -> List[Dict[str, Any]]:
    d = competitors_dir()
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
# Seasonal demand calendar
# ---------------------------------------------------------------------------


def set_demand_calendar(peaks: List[Dict[str, Any]], *, notes: str = "") -> Dict[str, Any]:
    """Replace the seasonal gifting-demand calendar.

    Each peak: ``{month, occasion, segments, intensity, lead_time_weeks, notes}``.
    Intensity is a free 1-5 hint for outbound/content pacing."""
    if not isinstance(peaks, list):
        raise ValueError("peaks must be a list")
    cleaned: List[Dict[str, Any]] = []
    for p in peaks:
        if not isinstance(p, dict):
            continue
        cleaned.append({
            "month": p.get("month"),
            "occasion": p.get("occasion", ""),
            "segments": list(p.get("segments") or []),
            "intensity": p.get("intensity"),
            "lead_time_weeks": p.get("lead_time_weeks"),
            "notes": p.get("notes", ""),
        })
    record = {"peaks": cleaned, "notes": notes, "updated_at": _now_iso()}
    base_dir().mkdir(parents=True, exist_ok=True)
    calendar_path().write_text(
        json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    return record


def get_demand_calendar() -> Dict[str, Any]:
    p = calendar_path()
    if not p.exists():
        return {"peaks": [], "notes": "", "updated_at": None}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"peaks": [], "notes": "", "updated_at": None}


# ---------------------------------------------------------------------------
# Research-refinement lessons + digest
# ---------------------------------------------------------------------------


def _write_lesson(lesson: Dict[str, Any]) -> Path:
    lessons_dir().mkdir(parents=True, exist_ok=True)
    date = _today()
    base = f"{date}-{_slug(lesson.get('category', 'research'))}"
    p = lessons_dir() / f"{base}.md"
    i = 2
    while p.exists():
        p = lessons_dir() / f"{base}-{i}.md"
        i += 1
    fm = {
        "type": GBRAIN_TAG,
        "date": date,
        "category": lesson.get("category", "research"),
        "tags": [GBRAIN_TAG, _slug(lesson.get("category", "research"))],
    }
    lines = ["---"]
    lines += [f"{k}: {json.dumps(v, ensure_ascii=False)}" for k, v in fm.items()]
    lines += ["---", "", f"# ICP-research lesson — {lesson.get('category', 'research')}", ""]
    for label, key in (("Rule", "rule"), ("Observation", "observation")):
        if lesson.get(key):
            lines += [f"**{label}:** {lesson[key]}", ""]
    p.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    with index_path().open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({
            "date": date, "category": lesson.get("category", "research"),
            "rule": lesson.get("rule", ""), "file": p.name,
        }, ensure_ascii=False) + "\n")
    return p


def _read_index() -> List[Dict[str, Any]]:
    p = index_path()
    if not p.exists():
        return []
    out: List[Dict[str, Any]] = []
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
        key = (ls.get("category", "research"), rule.lower())
        slot = counts.setdefault(
            key, {"category": ls.get("category", "research"), "rule": rule, "n": 0}
        )
        slot["n"] += 1
    recurring = sorted(counts.values(), key=lambda s: s["n"], reverse=True)
    out = [
        "# YES! ICP-Research Refinements (learned)",
        "",
        f"_Auto-generated from {len(lessons)} recent research lesson(s) on {_today()}._",
        "",
        "## Recurring research rules",
        "",
    ]
    top = [r for r in recurring if r["n"] >= 2] or recurring[:8]
    if top:
        out += [
            f"- [{r['category']}{(' x' + str(r['n'])) if r['n'] > 1 else ''}] {r['rule']}"
            for r in top[:15]
        ]
    else:
        out.append("- _(no recurring rules yet — learning in progress)_")
    base_dir().mkdir(parents=True, exist_ok=True)
    digest_path().write_text("\n".join(out) + "\n", encoding="utf-8")
    return digest_path()


# ---------------------------------------------------------------------------
# Outcome — human verdict on a research deliverable; feeds the Job 1.1 counter
# ---------------------------------------------------------------------------


def record_research_outcome(
    *,
    approved: bool = True,
    structural_change: bool = False,
    lessons: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Record the human verdict on a research deliverable (ICP / competitive
    brief / demand calendar). Job 1.1 is judgment-heavy, so "material" is whether
    the human structurally revised the research (``structural_change``), not a
    text-magnitude heuristic. Clean = approved AND not structural_change. Writes
    research lessons + advances the Job 1.1 trust counter."""
    clean = approved and not structural_change

    written: List[str] = []
    gbrain_ok = 0
    for lesson in (lessons or []):
        if not isinstance(lesson, dict):
            continue
        try:
            p = _write_lesson(lesson)
        except Exception as e:  # noqa: BLE001
            logger.error("icp_research _write_lesson failed: %s", e)
            continue
        written.append(p.name)
        if _gbrain_capture(p).get("ok"):
            gbrain_ok += 1
    if written:
        try:
            refresh_digest()
        except Exception as e:  # noqa: BLE001
            logger.error("icp_research refresh_digest failed: %s", e)

    trust = None
    try:
        from tools import sales_trust
        trust = sales_trust.record_outcome(
            JOB_ID,
            magnitude=(0.0 if clean else 1.0),
            structural_change=structural_change,
            rejected=not approved,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("icp_research sales_trust update skipped: %s", e)

    return {
        "approved": approved,
        "clean": clean,
        "structural_change": structural_change,
        "lessons_recorded": len(written),
        "gbrain_ok": gbrain_ok,
        "trust_header": _trust_header(),
        "trust_level": (trust or {}).get("level"),
    }


# ---------------------------------------------------------------------------
# Tool handlers  (signature: (args, **kw) -> JSON string)
# ---------------------------------------------------------------------------


def _handle_record_icp_segment(args: dict, **kw) -> str:
    segment = (args.get("segment") or "").strip()
    if segment not in ICP_SEGMENTS:
        return tool_error(f"segment must be one of {ICP_SEGMENTS}")
    try:
        rec = record_icp_segment(
            segment,
            title=args.get("title") or "",
            description=args.get("description") or "",
            fit_signals=args.get("fit_signals") or [],
            disqualifiers=args.get("disqualifiers") or [],
            demographics=args.get("demographics") or {},
            channels=args.get("channels") or [],
            pain_points=args.get("pain_points") or [],
            sources=args.get("sources") or [],
        )
        return tool_result({
            "segment": rec,
            "cross_wired": export_icp_rubric(),
            "trust_header": _trust_header(),
        })
    except Exception as e:  # noqa: BLE001
        return tool_error(f"Failed to record ICP segment: {e}")


def _handle_get_icp(args: dict, **kw) -> str:
    segment = (args.get("segment") or "").strip()
    if segment:
        rec = load_icp_segment(segment)
        if rec is None:
            return tool_error(f"No ICP segment {segment!r}")
        return tool_result({"segment": rec})
    rows = list_icp_segments()
    return tool_result({"count": len(rows), "segments": rows})


def _handle_record_competitor(args: dict, **kw) -> str:
    name = (args.get("name") or "").strip()
    if not name:
        return tool_error("Missing required parameter: name")
    price_tier = (args.get("price_tier") or "unknown").strip()
    if price_tier not in PRICE_TIERS:
        return tool_error(f"price_tier must be one of {PRICE_TIERS}")
    try:
        rec = record_competitor(
            name,
            competitor_id=args.get("competitor_id") or None,
            positioning=args.get("positioning") or "",
            price_tier=price_tier,
            website=args.get("website") or "",
            channels=args.get("channels") or [],
            strengths=args.get("strengths") or [],
            gaps=args.get("gaps") or [],
            notes=args.get("notes") or "",
            sources=args.get("sources") or [],
        )
        return tool_result({"competitor": rec, "trust_header": _trust_header()})
    except Exception as e:  # noqa: BLE001
        return tool_error(f"Failed to record competitor: {e}")


def _handle_set_demand_calendar(args: dict, **kw) -> str:
    peaks = args.get("peaks")
    if not isinstance(peaks, list):
        return tool_error("Missing required parameter: peaks (a list)")
    try:
        rec = set_demand_calendar(peaks, notes=args.get("notes") or "")
        return tool_result({"calendar": rec, "trust_header": _trust_header()})
    except Exception as e:  # noqa: BLE001
        return tool_error(f"Failed to set demand calendar: {e}")


def _handle_get_demand_calendar(args: dict, **kw) -> str:
    return tool_result({"calendar": get_demand_calendar()})


def _handle_record_research_outcome(args: dict, **kw) -> str:
    try:
        return tool_result(record_research_outcome(
            approved=bool(args.get("approved", True)),
            structural_change=bool(args.get("structural_change", False)),
            lessons=args.get("lessons") or [],
        ))
    except Exception as e:  # noqa: BLE001
        return tool_error(f"Failed to record research outcome: {e}")


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

RECORD_ICP_SEGMENT_SCHEMA = {
    "name": "record_icp_segment",
    "description": (
        "Define / overwrite one YES! Celebrational Cacao ICP segment (DTC "
        "consumer, wholesale buyer, or corporate gifting): its profile, fit "
        "signals, disqualifiers, channels, and pain points. Writing a segment "
        "ALSO regenerates the enrichment ICP rubric (Job 2.1) and the content "
        "ICP digest (Job 1.3). Brand is always 'YES!'; product line "
        "'Celebrational Cacao'."
    ),
    "parameters": {"type": "object", "properties": {
        "segment": {"type": "string", "enum": ICP_SEGMENTS},
        "title": {"type": "string", "description": "Human label, e.g. 'Premium gift-giver'."},
        "description": {"type": "string", "description": "One-paragraph profile of this segment."},
        "fit_signals": {"type": "array", "items": {"type": "string"}, "description": "Signals that mark a strong-fit account/buyer."},
        "disqualifiers": {"type": "array", "items": {"type": "string"}, "description": "Signals that drop or downgrade a prospect."},
        "demographics": {"type": "object", "description": "Structured demo/firmographic hints (age, region, size, etc.)."},
        "channels": {"type": "array", "items": {"type": "string"}, "description": "Where this segment is reached."},
        "pain_points": {"type": "array", "items": {"type": "string"}, "description": "Problems YES! solves for them (used in content briefs)."},
        "sources": {"type": "array", "items": {"type": "string"}, "description": "Research sources (URLs / queries)."},
    }, "required": ["segment"]},
}

GET_ICP_SCHEMA = {
    "name": "get_icp",
    "description": "Read ICP segment definition(s). Pass a segment to get one; omit it for all defined segments.",
    "parameters": {"type": "object", "properties": {
        "segment": {"type": "string", "enum": ICP_SEGMENTS},
    }},
}

RECORD_COMPETITOR_SCHEMA = {
    "name": "record_competitor",
    "description": (
        "Store one competitor teardown for the craft-chocolate / premium-CPG "
        "competitive brief: positioning, price tier, channels, strengths, and "
        "gaps YES! can exploit. Feeds the content ICP digest."
    ),
    "parameters": {"type": "object", "properties": {
        "name": {"type": "string"},
        "positioning": {"type": "string", "description": "How they position themselves in one line."},
        "price_tier": {"type": "string", "enum": PRICE_TIERS},
        "website": {"type": "string"},
        "channels": {"type": "array", "items": {"type": "string"}},
        "strengths": {"type": "array", "items": {"type": "string"}},
        "gaps": {"type": "array", "items": {"type": "string"}, "description": "Weaknesses / white space YES! can differentiate on."},
        "notes": {"type": "string"},
        "sources": {"type": "array", "items": {"type": "string"}},
        "competitor_id": {"type": "string", "description": "Optional stable id; defaults to a slug of the name."},
    }, "required": ["name"]},
}

SET_DEMAND_CALENDAR_SCHEMA = {
    "name": "set_demand_calendar",
    "description": (
        "Set the seasonal gifting-demand calendar (Valentine's, Mother's Day, "
        "holiday, corporate Q4, etc.) that paces outbound and content. Replaces "
        "the whole calendar."
    ),
    "parameters": {"type": "object", "properties": {
        "peaks": {"type": "array", "description": "Demand peaks.", "items": {"type": "object", "properties": {
            "month": {"type": "string", "description": "Month or window, e.g. 'February' or 'Nov-Dec'."},
            "occasion": {"type": "string"},
            "segments": {"type": "array", "items": {"type": "string"}, "description": "Which ICP segments spike."},
            "intensity": {"type": "integer", "description": "1-5 relative demand hint."},
            "lead_time_weeks": {"type": "integer", "description": "Weeks of outbound lead time to hit the peak."},
            "notes": {"type": "string"},
        }, "required": ["occasion"]}},
        "notes": {"type": "string"},
    }, "required": ["peaks"]},
}

GET_DEMAND_CALENDAR_SCHEMA = {
    "name": "get_demand_calendar",
    "description": "Read the seasonal gifting-demand calendar (gifting peaks).",
    "parameters": {"type": "object", "properties": {}},
}

RECORD_RESEARCH_OUTCOME_SCHEMA = {
    "name": "record_research_outcome",
    "description": (
        "Record the human verdict on a research deliverable (ICP / competitive "
        "brief / demand calendar). Job 1.1 is judgment-heavy: clean = approved "
        "AND not structurally revised. Writes research lessons to gbrain and "
        "advances the Job 1.1 trust counter."
    ),
    "parameters": {"type": "object", "properties": {
        "approved": {"type": "boolean"},
        "structural_change": {"type": "boolean", "description": "True if the human materially revised the research (resets the streak)."},
        "lessons": {"type": "array", "description": "Generalizable research-rubric lessons (empty for clean approvals).", "items": {"type": "object", "properties": {
            "category": {"type": "string", "description": "e.g. segmentation, competitor, seasonality, sourcing"},
            "observation": {"type": "string"},
            "rule": {"type": "string"},
        }, "required": ["category", "rule"]}},
    }},
}


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------

from tools.registry import registry, tool_error, tool_result  # noqa: E402

for _name, _schema, _handler, _emoji in [
    ("record_icp_segment", RECORD_ICP_SEGMENT_SCHEMA, _handle_record_icp_segment, "🎯"),
    ("get_icp", GET_ICP_SCHEMA, _handle_get_icp, "🧭"),
    ("record_competitor", RECORD_COMPETITOR_SCHEMA, _handle_record_competitor, "🥊"),
    ("set_demand_calendar", SET_DEMAND_CALENDAR_SCHEMA, _handle_set_demand_calendar, "🗓️"),
    ("get_demand_calendar", GET_DEMAND_CALENDAR_SCHEMA, _handle_get_demand_calendar, "📅"),
    ("record_research_outcome", RECORD_RESEARCH_OUTCOME_SCHEMA, _handle_record_research_outcome, "🎓"),
]:
    registry.register(name=_name, toolset="icp_research", schema=_schema, handler=_handler, emoji=_emoji)
