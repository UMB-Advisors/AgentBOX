"""Sales Persona Job 1.4 — Paid Ad Management (Track A: report + recommend + draft).

**HEAVILY DEGRADED.** The agent box has no Meta / TikTok Marketing API access, so
this module deliberately builds **Track A only**: it ingests a *pasted or CSV*
performance snapshot the operator exports from Ads Manager, turns it into a
performance report, derives **budget-pacing recommendations**, and drafts
**creative variants** for the operator to run by hand.

There are **no spend-mutation tools here and none may ever be loaded into a cron**.
Track B (live campaign creation / budget changes / spend) is deferred behind
Meta + TikTok app review and must **never** be autonomous — when it is eventually
built it lives in a separate, human-gated module. Everything this module produces
is an UNSENT review-folder artifact (a Markdown report + creative-variant drafts).

Graduation is **MEDIUM, reporting-only**: the trust counter advances on how the
operator edits the *report/recommendations*, never on spend. The job is seeded to
a content-style graduation (N=10, no L2-auth gate) because nothing it emits
touches money directly — the recommendations are advisory until a human acts.

Same loop shape as ``enrichment_tools`` / ``content_engine``: a JSON store, a
gbrain-backed lessons + digest, a human-verdict ``record_outcome`` that feeds the
shared Job 1.4 trust counter, and tool handlers returning JSON strings. Reuses
``blog_learning``'s ``gbrain_capture`` / ``edit_magnitude`` / ``strip_html``
(lazy-imported). Pure stdlib; paths resolve from ``HERMES_HOME`` per call.
"""

from __future__ import annotations

import csv
import io
import json
import logging
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

JOB_ID = "1.4"
GBRAIN_TAG = "paid-ads-feedback"
TOOLSET = "paid_ads"
CLEAN_MAX_MAGNITUDE = 0.02
DIGEST_MAX_LESSONS = 60
DIGEST_RECENT_SHOWN = 12

# Reporting-only MEDIUM graduation: nothing emitted touches spend, so seed a
# content-style counter (N=10, no L2-auth gate) rather than the "judgment"
# default the spec maps Job 1.4 to (which assumes live spend, i.e. Track B).
TRUST_N = 10
TRUST_CATEGORY = "content"

PLATFORMS = ["meta", "tiktok", "google", "other"]

# Recognized snapshot metric columns (canonical -> common aliases, lowercased).
_METRIC_ALIASES: Dict[str, List[str]] = {
    "spend": ["spend", "amount spent", "amount_spent", "cost"],
    "impressions": ["impressions", "impr"],
    "clicks": ["clicks", "link clicks", "link_clicks"],
    "conversions": ["conversions", "purchases", "results", "conv"],
    "revenue": ["revenue", "purchase value", "purchase_value", "conversion value", "conv_value"],
}

LESSON_CATEGORIES = [
    "pacing", "creative", "audience", "metric-reading",
    "budget", "claims/compliance", "platform", "structure",
]


# ---------------------------------------------------------------------------
# Paths (HERMES_HOME-resolved per call; test-overridable)
# ---------------------------------------------------------------------------


def _hermes_home() -> Path:
    return Path(os.getenv("HERMES_HOME") or (Path.home() / ".hermes"))


def base_dir() -> Path:
    return _hermes_home() / "paid_ads"


def snapshots_dir() -> Path:
    return base_dir() / "snapshots"


def review_dir() -> Path:
    return base_dir() / "review"


def lessons_dir() -> Path:
    return base_dir() / "lessons"


def index_path() -> Path:
    return lessons_dir() / "index.jsonl"


def digest_path() -> Path:
    return base_dir() / "ad-playbook.md"


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(value).lower()).strip("-") or "snapshot"


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat()


def _today() -> str:
    return datetime.now().astimezone().strftime("%Y-%m-%d")


def validate_platform(platform: str) -> Optional[str]:
    if platform not in PLATFORMS:
        return f"Unknown platform {platform!r}. Valid: {', '.join(PLATFORMS)}"
    return None


# ---------------------------------------------------------------------------
# Reused blog-loop helpers (single source of truth; lazy-imported)
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


def _seed_trust_config() -> None:
    """Seed the Job 1.4 counter to reporting-only MEDIUM graduation. Best-effort;
    only relaxes the default (never gates anything), so a failure is harmless."""
    try:
        from tools import sales_trust
        sales_trust.set_config(
            JOB_ID, N=TRUST_N, category=TRUST_CATEGORY, l2_requires_auth=False
        )
    except Exception as e:  # noqa: BLE001
        logger.debug("paid_ads trust seed skipped: %s", e)


# ---------------------------------------------------------------------------
# Snapshot parsing + metrics
# ---------------------------------------------------------------------------


def _to_float(value: Any) -> float:
    """Lenient numeric parse: strips $, %, commas, whitespace. '' -> 0.0."""
    if value is None:
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    s = re.sub(r"[,$%\s]", "", str(value))
    if not s or s in {"-", "--", "n/a", "na"}:
        return 0.0
    try:
        return float(s)
    except ValueError:
        return 0.0


def _canon_header(name: str) -> Optional[str]:
    """Map a CSV header to a canonical metric key, or None if it's a label col."""
    low = (name or "").strip().lower()
    for canon, aliases in _METRIC_ALIASES.items():
        if low in aliases:
            return canon
    return None


def parse_snapshot(text: str) -> List[Dict[str, Any]]:
    """Parse a pasted CSV (or TSV) performance snapshot into row dicts.

    The first column is treated as the line/campaign/ad-set label; recognized
    metric columns (spend/impressions/clicks/conversions/revenue) are coerced to
    numbers. Unknown columns are preserved as raw strings under ``extra``.
    """
    text = (text or "").strip()
    if not text:
        return []
    # Sniff delimiter: tab if present in the header line, else comma.
    first_line = text.splitlines()[0]
    delim = "\t" if "\t" in first_line else ","
    reader = csv.reader(io.StringIO(text), delimiter=delim)
    rows = [r for r in reader if any((c or "").strip() for c in r)]
    if not rows:
        return []
    header = rows[0]
    label_col = 0
    canon_map: Dict[int, str] = {}
    for i, col in enumerate(header):
        c = _canon_header(col)
        if c:
            canon_map[i] = c
    out: List[Dict[str, Any]] = []
    for r in rows[1:]:
        label = (r[label_col] if len(r) > label_col else "").strip()
        if not label:
            continue
        rec: Dict[str, Any] = {"label": label, "extra": {}}
        for metric in _METRIC_ALIASES:
            rec[metric] = 0.0
        for i, val in enumerate(r):
            if i in canon_map:
                rec[canon_map[i]] = _to_float(val)
            elif i != label_col and i < len(header):
                key = (header[i] or f"col{i}").strip()
                if key:
                    rec["extra"][key] = (val or "").strip()
        out.append(rec)
    return out


def _derive(row: Dict[str, Any]) -> Dict[str, Any]:
    """Add derived KPIs (CTR, CPC, CPA, ROAS, CVR) to a parsed row."""
    spend = row.get("spend", 0.0) or 0.0
    impr = row.get("impressions", 0.0) or 0.0
    clicks = row.get("clicks", 0.0) or 0.0
    conv = row.get("conversions", 0.0) or 0.0
    rev = row.get("revenue", 0.0) or 0.0
    d = dict(row)
    d["ctr"] = round((clicks / impr) * 100, 4) if impr else 0.0
    d["cpc"] = round(spend / clicks, 4) if clicks else 0.0
    d["cpa"] = round(spend / conv, 4) if conv else 0.0
    d["cvr"] = round((conv / clicks) * 100, 4) if clicks else 0.0
    d["roas"] = round(rev / spend, 4) if spend else 0.0
    return d


def summarize(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Roll up parsed rows into totals + per-line derived KPIs."""
    derived = [_derive(r) for r in rows]
    tot = {m: round(sum(r.get(m, 0.0) or 0.0 for r in rows), 4)
           for m in _METRIC_ALIASES}
    blended = _derive({**tot})
    return {
        "lines": derived,
        "totals": tot,
        "blended": {k: blended[k] for k in ("ctr", "cpc", "cpa", "cvr", "roas")},
        "line_count": len(derived),
    }


# ---------------------------------------------------------------------------
# Budget-pacing recommendations (advisory only — never executed)
# ---------------------------------------------------------------------------


def recommend(summary: Dict[str, Any], *, target_roas: float = 0.0,
              target_cpa: float = 0.0) -> List[Dict[str, Any]]:
    """Derive advisory budget-pacing actions per line. NEVER executed — these are
    suggestions for a human to apply in Ads Manager."""
    blended = summary.get("blended", {})
    bench_roas = target_roas or (blended.get("roas") or 0.0)
    bench_cpa = target_cpa or (blended.get("cpa") or 0.0)
    recs: List[Dict[str, Any]] = []
    for line in summary.get("lines", []):
        spend = line.get("spend", 0.0) or 0.0
        conv = line.get("conversions", 0.0) or 0.0
        roas = line.get("roas", 0.0) or 0.0
        cpa = line.get("cpa", 0.0) or 0.0
        action = "hold"
        reasons: List[str] = []
        if spend > 0 and conv == 0:
            action = "pause"
            reasons.append(f"spent {spend:g} with 0 conversions")
        elif bench_roas and roas >= bench_roas * 1.2 and conv > 0:
            action = "scale_up"
            reasons.append(f"ROAS {roas:g} >= 1.2x benchmark {round(bench_roas, 2)}")
        elif bench_cpa and cpa and cpa > bench_cpa * 1.5:
            action = "scale_down"
            reasons.append(f"CPA {cpa:g} > 1.5x benchmark {round(bench_cpa, 2)}")
        elif bench_roas and roas and roas < bench_roas * 0.5:
            action = "scale_down"
            reasons.append(f"ROAS {roas:g} < 0.5x benchmark {round(bench_roas, 2)}")
        recs.append({
            "label": line.get("label"),
            "action": action,
            "spend": spend,
            "roas": roas,
            "cpa": cpa,
            "conversions": conv,
            "reason": "; ".join(reasons) or "performing in line with benchmark",
        })
    return recs


# ---------------------------------------------------------------------------
# Report + creative-variant drafts (review-folder artifacts)
# ---------------------------------------------------------------------------


def _fmt_kpi(line: Dict[str, Any]) -> str:
    return (
        f"spend {line.get('spend', 0):g} | impr {int(line.get('impressions', 0) or 0)} | "
        f"clicks {int(line.get('clicks', 0) or 0)} | CTR {line.get('ctr', 0):g}% | "
        f"CPC {line.get('cpc', 0):g} | conv {int(line.get('conversions', 0) or 0)} | "
        f"CPA {line.get('cpa', 0):g} | ROAS {line.get('roas', 0):g}"
    )


def render_report(snapshot_id: str, summary: Dict[str, Any],
                  recs: List[Dict[str, Any]], *, platform: str = "",
                  period: str = "") -> str:
    """Markdown performance report — an UNSENT review artifact."""
    b = summary.get("blended", {})
    t = summary.get("totals", {})
    lines = [
        f"# Paid-ad performance report — {snapshot_id}",
        "",
        _trust_header(),
        "",
        "> Track A (reporting + advisory) only. No spend was changed. "
        "Apply any actions manually in Ads Manager — the box has no Meta/TikTok "
        "spend access (Track B is deferred behind app review).",
        "",
        f"- Platform: **{platform or 'unspecified'}**   Period: **{period or 'unspecified'}**",
        f"- Lines: **{summary.get('line_count', 0)}**",
        f"- Totals: spend **{t.get('spend', 0):g}**, conv **{int(t.get('conversions', 0) or 0)}**, "
        f"revenue **{t.get('revenue', 0):g}**",
        f"- Blended: CTR **{b.get('ctr', 0):g}%**, CPC **{b.get('cpc', 0):g}**, "
        f"CPA **{b.get('cpa', 0):g}**, ROAS **{b.get('roas', 0):g}**",
        "",
        "## Per-line KPIs",
        "",
    ]
    for line in summary.get("lines", []):
        lines.append(f"- **{line.get('label')}** — {_fmt_kpi(line)}")
    if not summary.get("lines"):
        lines.append("- _(no lines parsed)_")
    lines += ["", "## Budget-pacing recommendations (advisory)", ""]
    for r in recs:
        lines.append(f"- **{r.get('label')}** → `{r.get('action')}` — {r.get('reason')}")
    if not recs:
        lines.append("- _(no recommendations)_")
    return "\n".join(lines).rstrip() + "\n"


def write_report(snapshot_id: str, content: str) -> Path:
    review_dir().mkdir(parents=True, exist_ok=True)
    p = review_dir() / f"{_slug(snapshot_id)}-report.md"
    p.write_text(content, encoding="utf-8")
    return p


# ---------------------------------------------------------------------------
# Snapshot store
# ---------------------------------------------------------------------------


def record_performance(
    snapshot_id: str,
    raw_snapshot: str,
    *,
    platform: str = "other",
    period: str = "",
    target_roas: float = 0.0,
    target_cpa: float = 0.0,
    notes: str = "",
) -> Dict[str, Any]:
    """Parse + store a performance snapshot and write its report to the review
    folder. status=new. No spend is touched."""
    err = validate_platform(platform)
    if err:
        raise ValueError(err)
    _seed_trust_config()
    sid = _slug(snapshot_id)
    rows = parse_snapshot(raw_snapshot)
    summary = summarize(rows)
    recs = recommend(summary, target_roas=target_roas, target_cpa=target_cpa)
    report_md = render_report(sid, summary, recs, platform=platform, period=period)
    report_path = write_report(sid, report_md)

    snapshots_dir().mkdir(parents=True, exist_ok=True)
    record = {
        "snapshot_id": sid,
        "platform": platform,
        "period": period,
        "created_at": _now_iso(),
        "target_roas": target_roas,
        "target_cpa": target_cpa,
        "notes": notes,
        "summary": summary,
        "recommendations": recs,
        "report_path": str(report_path),
        "status": "new",  # new | approved | rejected
    }
    (snapshots_dir() / f"{sid}.json").write_text(
        json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    return record


def load_snapshot(snapshot_id: str) -> Optional[Dict[str, Any]]:
    p = snapshots_dir() / f"{_slug(snapshot_id)}.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _save_snapshot(record: Dict[str, Any]) -> None:
    snapshots_dir().mkdir(parents=True, exist_ok=True)
    (snapshots_dir() / f"{record['snapshot_id']}.json").write_text(
        json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def list_snapshots(status: Optional[str] = None, limit: int = 100) -> List[Dict[str, Any]]:
    d = snapshots_dir()
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
        out.append({
            "snapshot_id": rec.get("snapshot_id"),
            "platform": rec.get("platform"),
            "period": rec.get("period"),
            "status": rec.get("status"),
            "line_count": (rec.get("summary") or {}).get("line_count"),
            "report_path": rec.get("report_path"),
            "created_at": rec.get("created_at"),
        })
    return out[:limit]


# ---------------------------------------------------------------------------
# Creative-variant drafts (review-folder artifacts)
# ---------------------------------------------------------------------------


def _next_variant_index(creative_id: str) -> int:
    review_dir().mkdir(parents=True, exist_ok=True)
    prefix = f"creative-{_slug(creative_id)}-v"
    n = 0
    for p in review_dir().glob(f"{prefix}*.md"):
        m = re.search(r"-v(\d+)\.md$", p.name)
        if m:
            n = max(n, int(m.group(1)))
    return n + 1


def draft_creative(
    creative_id: str,
    variants: List[Dict[str, Any]],
    *,
    platform: str = "other",
    angle: str = "",
) -> Dict[str, Any]:
    """Write creative-variant DRAFTS to the review folder for the operator to run
    manually. No publishing — the box cannot push creatives to ad platforms."""
    err = validate_platform(platform)
    if err:
        raise ValueError(err)
    if not isinstance(variants, list) or not variants:
        raise ValueError("variants must be a non-empty list")
    cid = _slug(creative_id)
    written: List[str] = []
    for v in variants:
        if not isinstance(v, dict):
            continue
        idx = _next_variant_index(cid)
        headline = (v.get("headline") or "").strip()
        primary = (v.get("primary_text") or v.get("body") or "").strip()
        cta = (v.get("cta") or "").strip()
        hook = (v.get("hook") or "").strip()
        md = [
            f"# Ad creative draft — {cid} v{idx}",
            "",
            "_Draft for human review — not published. Brand: YES! / Celebrational "
            "Cacao. Any health/functional claim must be human-approved before use._",
            "",
            f"- Platform: {platform}",
            f"- Angle: {angle or v.get('angle') or 'unspecified'}",
            "",
        ]
        if hook:
            md += [f"**Hook:** {hook}", ""]
        if headline:
            md += [f"**Headline:** {headline}", ""]
        if primary:
            md += ["**Primary text:**", "", primary, ""]
        if cta:
            md += [f"**CTA:** {cta}", ""]
        p = review_dir() / f"creative-{cid}-v{idx}.md"
        p.write_text("\n".join(md).rstrip() + "\n", encoding="utf-8")
        written.append(p.name)
    return {
        "creative_id": cid,
        "platform": platform,
        "variants_written": len(written),
        "files": written,
        "review_dir": str(review_dir()),
        "trust_header": _trust_header(),
    }


# ---------------------------------------------------------------------------
# Lessons + ad-playbook digest
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
    lines += ["---", "", f"# Paid-ad lesson — {lesson.get('category', 'general')}", ""]
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
        "# YES! Paid-Ad Playbook (learned)",
        "",
        f"_Auto-generated from {len(lessons)} recent paid-ad lesson(s) on {_today()}. "
        "Track A (reporting/advisory) only._",
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


def get_playbook() -> str:
    p = digest_path()
    return p.read_text(encoding="utf-8") if p.exists() else ""


# ---------------------------------------------------------------------------
# Outcome — human verdict on a report; feeds the Job 1.4 counter (reporting only)
# ---------------------------------------------------------------------------


def record_outcome(
    snapshot_id: str,
    ai_report: str = "",
    human_report: str = "",
    *,
    rejected: bool = False,
    structural_change: bool = False,
    lessons: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Record the human verdict on a performance report / recommendation set.

    Clean = approved AND the human did not materially edit the report AND no
    structural change. Writes paid-ad lessons to gbrain + the playbook digest,
    marks the snapshot done, and advances the **reporting-only** Job 1.4 trust
    counter. This NEVER touches spend — graduation is about report quality."""
    rec = load_snapshot(snapshot_id)
    if rec is None:
        raise ValueError(f"No snapshot {snapshot_id!r}")
    _seed_trust_config()
    magnitude = None if rejected else edit_magnitude(ai_report, human_report)
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
        try:
            p = _write_lesson(lesson)
        except Exception as e:  # noqa: BLE001
            logger.error("paid_ads _write_lesson failed: %s", e)
            continue
        written.append(p.name)
        if gbrain_capture(p).get("ok"):
            gbrain_ok += 1
    if written:
        try:
            refresh_digest()
        except Exception as e:  # noqa: BLE001
            logger.error("paid_ads refresh_digest failed: %s", e)

    rec["status"] = "rejected" if rejected else "approved"
    rec["reviewed_at"] = _now_iso()
    rec["edit_magnitude"] = magnitude
    rec["clean"] = clean
    rec["structural_change"] = structural_change
    _save_snapshot(rec)

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
        logger.warning("paid_ads sales_trust update skipped: %s", e)

    return {
        "snapshot_id": rec["snapshot_id"],
        "status": rec["status"],
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


def _handle_record_performance(args: dict, **kw) -> str:
    snapshot_id = (args.get("snapshot_id") or "").strip()
    raw = args.get("raw_snapshot") or ""
    platform = (args.get("platform") or "other").strip()
    if not snapshot_id:
        return tool_error("Missing required parameter: snapshot_id")
    if not raw.strip():
        return tool_error("Missing required parameter: raw_snapshot (pasted CSV/TSV)")
    if validate_platform(platform):
        return tool_error(validate_platform(platform))
    try:
        rec = record_performance(
            snapshot_id, raw,
            platform=platform,
            period=args.get("period") or "",
            target_roas=_to_float(args.get("target_roas")),
            target_cpa=_to_float(args.get("target_cpa")),
            notes=args.get("notes") or "",
        )
        return tool_result({
            "snapshot_id": rec["snapshot_id"],
            "platform": rec["platform"],
            "totals": rec["summary"]["totals"],
            "blended": rec["summary"]["blended"],
            "line_count": rec["summary"]["line_count"],
            "recommendations": rec["recommendations"],
            "report_path": rec["report_path"],
            "trust_header": _trust_header(),
        })
    except Exception as e:  # noqa: BLE001
        return tool_error(f"Failed to record performance: {e}")


def _handle_draft_creative(args: dict, **kw) -> str:
    creative_id = (args.get("creative_id") or "").strip()
    variants = args.get("variants") or []
    platform = (args.get("platform") or "other").strip()
    if not creative_id:
        return tool_error("Missing required parameter: creative_id")
    if validate_platform(platform):
        return tool_error(validate_platform(platform))
    if not isinstance(variants, list) or not variants:
        return tool_error("variants must be a non-empty list")
    try:
        return tool_result(draft_creative(
            creative_id, variants,
            platform=platform, angle=args.get("angle") or "",
        ))
    except Exception as e:  # noqa: BLE001
        return tool_error(f"Failed to draft creative: {e}")


def _handle_get_recommendations(args: dict, **kw) -> str:
    snapshot_id = (args.get("snapshot_id") or "").strip()
    if snapshot_id:
        rec = load_snapshot(snapshot_id)
        if rec is None:
            return tool_error(f"No snapshot {snapshot_id!r}")
        return tool_result({
            "snapshot_id": rec["snapshot_id"],
            "recommendations": rec.get("recommendations", []),
            "blended": (rec.get("summary") or {}).get("blended", {}),
            "report_path": rec.get("report_path"),
            "playbook": get_playbook(),
            "trust_header": _trust_header(),
        })
    return tool_result({
        "snapshots": list_snapshots(
            status=args.get("status") or None,
            limit=int(args.get("limit") or 100),
        ),
        "playbook": get_playbook(),
        "trust_header": _trust_header(),
    })


def _handle_record_outcome(args: dict, **kw) -> str:
    snapshot_id = (args.get("snapshot_id") or "").strip()
    if not snapshot_id:
        return tool_error("Missing required parameter: snapshot_id")
    if load_snapshot(snapshot_id) is None:
        return tool_error(f"No snapshot {snapshot_id!r}")
    try:
        return tool_result(record_outcome(
            snapshot_id,
            ai_report=args.get("ai_report") or "",
            human_report=args.get("human_report") or "",
            rejected=bool(args.get("rejected", False)),
            structural_change=bool(args.get("structural_change", False)),
            lessons=args.get("lessons") or [],
        ))
    except Exception as e:  # noqa: BLE001
        return tool_error(f"Failed to record outcome: {e}")


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

RECORD_PERFORMANCE_SCHEMA = {
    "name": "record_ad_performance",
    "description": (
        "Track A (reporting only). Ingest a PASTED or CSV/TSV paid-ad performance "
        "snapshot the operator exported from Ads Manager (the box has no Meta/"
        "TikTok API), parse it into per-line KPIs (CTR/CPC/CPA/ROAS/CVR), derive "
        "advisory budget-pacing recommendations, and write an UNSENT Markdown "
        "report to the review folder. Changes NO spend. First column = line/"
        "campaign label; recognized metric columns: spend, impressions, clicks, "
        "conversions, revenue. Returns totals, blended KPIs, recommendations, the "
        "report path, and the trust header."
    ),
    "parameters": {"type": "object", "properties": {
        "snapshot_id": {"type": "string", "description": "Stable id for this snapshot (e.g. 'meta-2026-w23')."},
        "raw_snapshot": {"type": "string", "description": "The pasted CSV/TSV rows (header + lines)."},
        "platform": {"type": "string", "enum": PLATFORMS},
        "period": {"type": "string", "description": "Reporting window, e.g. '2026-06-01..2026-06-07'."},
        "target_roas": {"type": "number", "description": "Optional benchmark ROAS; defaults to the blended ROAS."},
        "target_cpa": {"type": "number", "description": "Optional benchmark CPA; defaults to the blended CPA."},
        "notes": {"type": "string"},
    }, "required": ["snapshot_id", "raw_snapshot"]},
}

DRAFT_CREATIVE_SCHEMA = {
    "name": "draft_ad_creative",
    "description": (
        "Track A (drafts only). Write paid-ad creative-variant DRAFTS to the "
        "review folder for the operator to run manually — the box cannot publish "
        "creatives to any ad platform. Brand voice is always 'YES!' and the "
        "product line 'Celebrational Cacao'; any health/functional claim must be "
        "human-approved before use. Returns the written file names and trust header."
    ),
    "parameters": {"type": "object", "properties": {
        "creative_id": {"type": "string", "description": "Stable id for this creative set (e.g. 'fathers-day-gift')."},
        "platform": {"type": "string", "enum": PLATFORMS},
        "angle": {"type": "string", "description": "Shared creative angle/concept for the variants."},
        "variants": {"type": "array", "description": "Creative variants to draft.", "items": {"type": "object", "properties": {
            "hook": {"type": "string"},
            "headline": {"type": "string"},
            "primary_text": {"type": "string", "description": "Body / primary text."},
            "cta": {"type": "string"},
            "angle": {"type": "string"},
        }}},
    }, "required": ["creative_id", "variants"]},
}

GET_RECOMMENDATIONS_SCHEMA = {
    "name": "get_ad_recommendations",
    "description": (
        "Read advisory budget-pacing recommendations. With a snapshot_id, returns "
        "that snapshot's recommendations + blended KPIs + report path; without "
        "one, lists stored snapshots (filterable by status) plus the learned "
        "ad-playbook digest. All advisory — nothing is or can be executed."
    ),
    "parameters": {"type": "object", "properties": {
        "snapshot_id": {"type": "string"},
        "status": {"type": "string", "enum": ["new", "approved", "rejected"]},
        "limit": {"type": "integer"},
    }},
}

RECORD_OUTCOME_SCHEMA = {
    "name": "record_ad_outcome",
    "description": (
        "Record the human verdict on a performance report / recommendation set "
        "(approved/edited/rejected). Writes paid-ad lessons to gbrain + the "
        "playbook digest and advances the REPORTING-ONLY Job 1.4 trust counter. "
        "Pass the AI's original report and the human-final report so the edit "
        "magnitude is scored. Clean = approved with no material edits. This never "
        "touches spend — graduation is about report quality, not autonomy over money."
    ),
    "parameters": {"type": "object", "properties": {
        "snapshot_id": {"type": "string"},
        "ai_report": {"type": "string", "description": "The AI's original report text."},
        "human_report": {"type": "string", "description": "The human-edited final report (omit if rejected)."},
        "rejected": {"type": "boolean", "description": "True if the human rejected the report outright."},
        "structural_change": {"type": "boolean", "description": "True for a changed pacing call / metric interpretation (material regardless of text magnitude)."},
        "lessons": {"type": "array", "description": "Generalizable paid-ad lessons (empty for clean approvals).", "items": {"type": "object", "properties": {
            "category": {"type": "string", "description": "One of: " + ", ".join(LESSON_CATEGORIES)},
            "observation": {"type": "string"},
            "rule": {"type": "string"},
            "before": {"type": "string"},
            "after": {"type": "string"},
        }, "required": ["category", "rule"]}},
    }, "required": ["snapshot_id"]},
}


# ---------------------------------------------------------------------------
# Registration
#
# NOTE: There are intentionally NO spend-mutation tools here (no create-campaign,
# set-budget, pause-ad, etc.). Track B (live campaign/spend on Meta/TikTok) is
# deferred behind app review and must NEVER be autonomous or loaded into a cron.
# ---------------------------------------------------------------------------

from tools.registry import registry, tool_error, tool_result  # noqa: E402

for _name, _schema, _handler, _emoji in [
    ("record_ad_performance", RECORD_PERFORMANCE_SCHEMA, _handle_record_performance, "📊"),
    ("draft_ad_creative", DRAFT_CREATIVE_SCHEMA, _handle_draft_creative, "✍️"),
    ("get_ad_recommendations", GET_RECOMMENDATIONS_SCHEMA, _handle_get_recommendations, "🧭"),
    ("record_ad_outcome", RECORD_OUTCOME_SCHEMA, _handle_record_outcome, "🎓"),
]:
    registry.register(name=_name, toolset=TOOLSET, schema=_schema, handler=_handler, emoji=_emoji)
