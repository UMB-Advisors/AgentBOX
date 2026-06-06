"""Sales Persona — shared L0/L1/L2 trust counter (Phase 0 scaffold).

The one net-new primitive common to all ten Sales-Persona jobs. Every job starts
at **L0 (draft & approve)** and graduates one level after N consecutive "clean"
human approvals; any rejection or material edit resets the counter. The client
can freeze or downgrade any job at any time. L2 (autonomous) for any
money/reputation-touching job is gated behind explicit human authorization and
is never auto-reached.

Design (build-plan §1.2):
- **Durable, per-job state** at ``$HERMES_HOME/sales_trust/<job_id>.json`` — cron
  spawns a fresh subprocess per run, so state MUST be on disk (an in-process map
  like approval.py's would reset every run).
- **Clean detection reuses** ``blog_learning.edit_magnitude`` (the same scoring
  that drives the blog learning loop), with a critical refinement: judgment-heavy
  changes (ICP/pricing/positioning) are flagged ``structural_change=True`` by the
  caller and count as material **regardless of text magnitude** — edit_magnitude
  is an HTML-text heuristic and under-counts strategically significant small
  edits.
- **Visibility** (spec requirement): ``trust_header()`` returns the
  ``"Trust: L1, 3/5 clean toward L2"`` line jobs prepend to every draft/report,
  and ``summary_all()`` feeds a dashboard tile.

This module only owns the *counter*. Wiring it to the actual approval queue
(``approval.py``) and per-job exception rules happens in each job's build.
Pure stdlib; paths resolve from ``HERMES_HOME`` per call so tests stay isolated.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants / defaults
# ---------------------------------------------------------------------------

MAX_LEVEL = 2
LEVEL_NAMES = {0: "L0", 1: "L1", 2: "L2"}
# Material-edit threshold: at/below this normalized edit magnitude (and no
# structural change) an approval counts as clean. Matches the blog loop's
# CLEAN_APPROVAL_MAX_MAGNITUDE.
DEFAULT_MATERIAL_THRESHOLD = 0.02
_HISTORY_CAP = 20

# Graduation thresholds by job character (build-plan OQ4 recommended defaults).
# l2_requires_auth gates the L1->L2 jump behind explicit human authorization for
# money/reputation-touching work.
CATEGORY_DEFAULTS: Dict[str, Dict[str, Any]] = {
    "judgment": {"N": 5, "l2_requires_auth": True},   # strategic, keep humans close
    "content": {"N": 10, "l2_requires_auth": False},  # high-volume, low individual risk
    "sends": {"N": 20, "l2_requires_auth": True},     # reputation/money-critical
}
DEFAULT_CATEGORY = "content"

# Convenience mapping of the spec's ten jobs to a graduation character. Used only
# to seed defaults on first init; everything is overridable via set_config().
JOB_CATEGORY: Dict[str, str] = {
    "1.1": "judgment",   # Market & ICP Research
    "1.2": "content",    # Funnel & Landing Pages
    "1.3": "content",    # Content Engine
    "1.4": "judgment",   # Paid Ad Management (spend)
    "2.1": "content",    # Lead Enrichment & Scoring (data)
    "2.2": "sends",      # Outbound Sequencing
    "2.3": "sends",      # Speed-to-Lead
    "3.1": "sends",      # Quote & Line-Sheet (pricing)
    "3.2": "content",    # Pipeline & Forecasting (reporting)
    "3.3": "content",    # Reorder & Expansion
}


# ---------------------------------------------------------------------------
# Paths (HERMES_HOME-resolved per call; test-overridable)
# ---------------------------------------------------------------------------


def hermes_home() -> Path:
    return Path(os.getenv("HERMES_HOME") or (Path.home() / ".hermes"))


def trust_dir() -> Path:
    return hermes_home() / "sales_trust"


def _state_path(job_id: str) -> Path:
    return trust_dir() / f"{_safe_job_id(job_id)}.json"


def _safe_job_id(job_id: str) -> str:
    # Job ids are like "1.3"/"2.1"; keep dots, strip anything path-unsafe.
    return "".join(c for c in str(job_id) if c.isalnum() or c in "._-") or "job"


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat()


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------


def _default_state(job_id: str, category: Optional[str] = None) -> Dict[str, Any]:
    cat = category or JOB_CATEGORY.get(str(job_id), DEFAULT_CATEGORY)
    defaults = CATEGORY_DEFAULTS.get(cat, CATEGORY_DEFAULTS[DEFAULT_CATEGORY])
    return {
        "job_id": str(job_id),
        "category": cat,
        "level": 0,
        "consecutive_clean": 0,
        "N": defaults["N"],
        "material_threshold": DEFAULT_MATERIAL_THRESHOLD,
        "l2_requires_auth": defaults["l2_requires_auth"],
        "l2_authorized": False,
        "pending_l2_authorization": False,
        "frozen": False,
        "last_edit_magnitude": None,
        "history": [],
        "updated_at": _now_iso(),
    }


def get_state(job_id: str, category: Optional[str] = None) -> Dict[str, Any]:
    """Load a job's trust state, initializing (and persisting) it if absent."""
    path = _state_path(job_id)
    if path.exists():
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
            return _migrate(state, job_id)
        except (OSError, json.JSONDecodeError) as e:
            logger.warning("sales_trust: bad state %s (%s); reinitializing", path, e)
    state = _default_state(job_id, category)
    _save(state)
    return state


def _migrate(state: Dict[str, Any], job_id: str) -> Dict[str, Any]:
    """Backfill any missing keys on an older state file."""
    base = _default_state(job_id, state.get("category"))
    changed = False
    for k, v in base.items():
        if k not in state:
            state[k] = v
            changed = True
    if changed:
        _save(state)
    return state


def _save(state: Dict[str, Any]) -> None:
    trust_dir().mkdir(parents=True, exist_ok=True)
    state["updated_at"] = _now_iso()
    _state_path(state["job_id"]).write_text(
        json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8"
    )


# ---------------------------------------------------------------------------
# Outcome recording / graduation
# ---------------------------------------------------------------------------


def _edit_magnitude(ai_draft: str, human_final: str) -> float:
    # Lazy import: keep this module's import light and avoid pulling the blog
    # toolset registration just to score text.
    from tools.blog_learning import edit_magnitude

    return edit_magnitude(ai_draft, human_final)


def record_outcome(
    job_id: str,
    ai_draft: str = "",
    human_final: str = "",
    *,
    magnitude: Optional[float] = None,
    structural_change: bool = False,
    rejected: bool = False,
) -> Dict[str, Any]:
    """Record a human's verdict on one AI-produced artifact and update the counter.

    Clean = not rejected AND edit magnitude <= threshold AND not a structural
    change. Clean increments the streak (and may graduate a level); a rejection
    or material/structural edit resets the streak to 0.

    Pass ``magnitude`` directly when the caller already computed it (e.g. the
    blog loop) to skip recomputing from ``ai_draft``/``human_final``.
    """
    state = get_state(job_id)
    if rejected:
        clean = False
    else:
        if magnitude is None:
            magnitude = _edit_magnitude(ai_draft, human_final)
        clean = (magnitude <= state["material_threshold"]) and not structural_change

    state["last_edit_magnitude"] = magnitude
    leveled_up = False
    if clean:
        state["consecutive_clean"] += 1
        if state["level"] < MAX_LEVEL and state["consecutive_clean"] >= state["N"]:
            if (
                state["level"] == 1
                and state["l2_requires_auth"]
                and not state["l2_authorized"]
            ):
                # Hold at L1 until a human authorizes autonomous (L2) operation.
                state["pending_l2_authorization"] = True
            else:
                state["level"] += 1
                state["consecutive_clean"] = 0
                state["pending_l2_authorization"] = False
                leveled_up = True
    else:
        state["consecutive_clean"] = 0

    entry = {
        "at": _now_iso(),
        "clean": clean,
        "rejected": rejected,
        "structural_change": structural_change,
        "edit_magnitude": magnitude,
        "level_after": state["level"],
    }
    state["history"] = (state.get("history", []) + [entry])[-_HISTORY_CAP:]
    _save(state)
    state["_leveled_up"] = leveled_up
    return state


def can_autoact(job_id: str, *, is_exception: bool = False) -> bool:
    """Whether the job may ship this action without per-item human approval.

    L0 -> never (everything drafts for approval). L1 -> routine yes, exceptions
    no. L2 -> yes. A frozen job never auto-acts.
    """
    s = get_state(job_id)
    if s["frozen"]:
        return False
    if s["level"] <= 0:
        return False
    if s["level"] == 1:
        return not is_exception
    return True  # L2


def authorize_l2(job_id: str) -> Dict[str, Any]:
    """Grant explicit human authorization for autonomous (L2) operation.

    Applies a pending L1->L2 graduation immediately if the streak already met N.
    """
    s = get_state(job_id)
    s["l2_authorized"] = True
    if s.get("pending_l2_authorization") and s["level"] == 1:
        s["level"] = 2
        s["consecutive_clean"] = 0
        s["pending_l2_authorization"] = False
    _save(s)
    return s


def freeze(job_id: str) -> Dict[str, Any]:
    s = get_state(job_id)
    s["frozen"] = True
    _save(s)
    return s


def unfreeze(job_id: str) -> Dict[str, Any]:
    s = get_state(job_id)
    s["frozen"] = False
    _save(s)
    return s


def downgrade(job_id: str, to_level: Optional[int] = None) -> Dict[str, Any]:
    """Drop a job's level (default: one level) and reset the streak."""
    s = get_state(job_id)
    target = (s["level"] - 1) if to_level is None else int(to_level)
    s["level"] = max(0, min(MAX_LEVEL, target))
    s["consecutive_clean"] = 0
    s["pending_l2_authorization"] = False
    _save(s)
    return s


def set_config(job_id: str, **kwargs: Any) -> Dict[str, Any]:
    """Override per-job config: N, material_threshold, l2_requires_auth, category."""
    s = get_state(job_id)
    for key in ("N", "material_threshold", "l2_requires_auth", "category"):
        if key in kwargs and kwargs[key] is not None:
            s[key] = kwargs[key]
    _save(s)
    return s


# ---------------------------------------------------------------------------
# Visibility
# ---------------------------------------------------------------------------


def trust_header(job_id: str) -> str:
    """The one-line trust banner jobs prepend to every draft/report."""
    s = get_state(job_id)
    lvl = s["level"]
    name = LEVEL_NAMES.get(lvl, f"L{lvl}")
    if s["frozen"]:
        return f"Trust: {name} (frozen)"
    if lvl >= MAX_LEVEL:
        return f"Trust: {name} (autonomous)"
    extra = " — awaiting L2 authorization" if s.get("pending_l2_authorization") else ""
    return (
        f"Trust: {name}, {s['consecutive_clean']}/{s['N']} clean "
        f"toward L{lvl + 1}{extra}"
    )


def summary_all() -> List[Dict[str, Any]]:
    """Compact state of every tracked job — feeds the dashboard trust tile."""
    d = trust_dir()
    if not d.exists():
        return []
    out: List[Dict[str, Any]] = []
    for p in sorted(d.glob("*.json")):
        try:
            s = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        out.append(
            {
                "job_id": s.get("job_id"),
                "category": s.get("category"),
                "level": s.get("level"),
                "level_name": LEVEL_NAMES.get(s.get("level"), str(s.get("level"))),
                "consecutive_clean": s.get("consecutive_clean"),
                "N": s.get("N"),
                "frozen": s.get("frozen"),
                "pending_l2_authorization": s.get("pending_l2_authorization"),
                "header": trust_header(s.get("job_id")),
                "updated_at": s.get("updated_at"),
            }
        )
    return out


# ---------------------------------------------------------------------------
# Tool handler (read-only status; mutations happen via the module API in jobs)
# ---------------------------------------------------------------------------


JOB_NAMES = {
    "1.1": "Market & ICP Research", "1.2": "Funnel & Landing Pages",
    "1.3": "Content Engine", "1.4": "Paid Ad Management",
    "2.1": "Lead Enrichment", "2.2": "Outbound Sequencing",
    "2.3": "Speed-to-Lead", "3.1": "Quote & Line-Sheet",
    "3.2": "Pipeline & Forecasting", "3.3": "Reorder & Expansion",
}


def _esc(s: Any) -> str:
    return (
        str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    )


def render_board() -> Path:
    """Render a self-contained static HTML trust board from the state files and
    write it to ``$HERMES_HOME/sales_trust/board.html``. Pure stdlib — the
    dashboard can iframe/link it, or the operator can open it directly. Returns
    the path."""
    rows = summary_all()
    cards = []
    for r in rows:
        jid = r.get("job_id")
        name = JOB_NAMES.get(jid, jid)
        lvl = r.get("level") or 0
        n = r.get("N") or 1
        cc = r.get("consecutive_clean") or 0
        pct = 100 if lvl >= MAX_LEVEL else int(min(100, (cc / n) * 100)) if n else 0
        badge = "frozen" if r.get("frozen") else (
            "L2" if lvl >= MAX_LEVEL else f"L{lvl}")
        sub = ("autonomous" if lvl >= MAX_LEVEL and not r.get("frozen")
               else "frozen" if r.get("frozen")
               else f"{cc}/{n} clean &rarr; L{lvl + 1}")
        if r.get("pending_l2_authorization"):
            sub += " (awaiting L2 auth)"
        cards.append(
            f'<div class="card"><div class="hdr"><span class="jid">{_esc(jid)}</span>'
            f'<span class="badge b{lvl}">{_esc(badge)}</span></div>'
            f'<div class="name">{_esc(name)}</div>'
            f'<div class="bar"><i style="width:{pct}%"></i></div>'
            f'<div class="sub">{sub}</div></div>'
        )
    html = (
        "<!doctype html><meta charset=utf-8><title>YES! Sales Persona — Trust</title>"
        "<style>body{background:#0f1115;color:#e6e6e6;font:14px/1.4 system-ui,sans-serif;margin:24px}"
        "h1{font-size:18px;font-weight:600}.grid{display:grid;gap:12px;"
        "grid-template-columns:repeat(auto-fill,minmax(220px,1fr));margin-top:16px}"
        ".card{background:#1a1d24;border:1px solid #272b34;border-radius:10px;padding:14px}"
        ".hdr{display:flex;justify-content:space-between;align-items:center}"
        ".jid{color:#8b93a7;font-size:12px}.name{font-weight:600;margin:6px 0 10px}"
        ".badge{font-size:11px;padding:2px 8px;border-radius:999px;background:#272b34}"
        ".b1{background:#22384f;color:#7cc4ff}.b2{background:#1f4030;color:#7be0a3}"
        ".bar{height:6px;background:#272b34;border-radius:4px;overflow:hidden}"
        ".bar i{display:block;height:100%;background:linear-gradient(90deg,#5b8cff,#7be0a3)}"
        ".sub{color:#8b93a7;font-size:12px;margin-top:8px}.empty{color:#8b93a7}</style>"
        f"<h1>YES! Sales Persona — Autonomy Trust</h1>"
        f'<div class="grid">{"".join(cards) or "<p class=empty>No jobs tracked yet.</p>"}</div>'
        f"<p class=sub>Generated {_esc(_now_iso())} from $HERMES_HOME/sales_trust/</p>"
    )
    trust_dir().mkdir(parents=True, exist_ok=True)
    out = trust_dir() / "board.html"
    out.write_text(html, encoding="utf-8")
    return out


def _handle_status(args: dict, **kw) -> str:
    job_id = args.get("job_id")
    if job_id:
        return tool_result({"state": get_state(job_id), "header": trust_header(job_id)})
    return tool_result({"jobs": summary_all()})


def _handle_board(args: dict, **kw) -> str:
    return tool_result({"board_path": str(render_board()), "jobs": len(summary_all())})


STATUS_SCHEMA = {
    "name": "sales_trust_status",
    "description": (
        "Read the Sales Persona trust counter. With a job_id, returns that job's "
        "full L0/L1/L2 state and its trust header line; without one, returns a "
        "compact summary of every tracked job (for the dashboard trust tile)."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "job_id": {
                "type": "string",
                "description": "Sales job id, e.g. '1.3' or '2.3'. Omit for all jobs.",
            },
        },
    },
}


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------

BOARD_SCHEMA = {
    "name": "sales_trust_board",
    "description": (
        "Regenerate the static HTML Sales Persona trust board from the current "
        "state files (a per-job L0/L1/L2 grid) and return its path. The dashboard "
        "can iframe/link it; the operator can open it directly."
    ),
    "parameters": {"type": "object", "properties": {}},
}

from tools.registry import registry, tool_result  # noqa: E402

registry.register(
    name="sales_trust_status",
    toolset="sales",
    schema=STATUS_SCHEMA,
    handler=_handle_status,
    emoji="📈",
)

registry.register(
    name="sales_trust_board",
    toolset="sales",
    schema=BOARD_SCHEMA,
    handler=_handle_board,
    emoji="🗂️",
)
