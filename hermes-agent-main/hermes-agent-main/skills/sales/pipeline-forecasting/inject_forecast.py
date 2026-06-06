#!/usr/bin/env python3
"""Pre-run injector for the Pipeline & Forecasting (Job 3.2) weekly cron.

The scheduler runs this before the pipeline agent and prepends its stdout to the
prompt as "## Script Output". It dumps the current stage-weighted forecast and
the stalled-deal list (both read-only) so the weekly run starts from the live
numbers instead of re-deriving them.

Deployed to ``$HERMES_HOME/scripts/``. Pure stdlib; resolves everything from
``HERMES_HOME``. Must always print something — empty stdout makes the scheduler
skip the run.
"""

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

# Stage probabilities mirror tools/pipeline.py (kept inline so the injector has
# no import dependency on the tools package at cron time).
STAGE_PROBABILITY = {
    "lead": 0.10,
    "qualified": 0.25,
    "sample_sent": 0.40,
    "proposal": 0.60,
    "negotiation": 0.80,
    "closed_won": 1.00,
    "closed_lost": 0.00,
}
OPEN_STAGES = [s for s in STAGE_PROBABILITY if not s.startswith("closed_")]
STALL_DAYS = 14


def _hermes_home() -> Path:
    return Path(os.getenv("HERMES_HOME") or (Path.home() / ".hermes"))


def _deals():
    d = _hermes_home() / "pipeline" / "deals"
    if not d.exists():
        return []
    out = []
    for p in sorted(d.glob("*.json")):
        try:
            out.append(json.loads(p.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            continue
    return out


def _parse_dt(value):
    if not value:
        return None
    raw = str(value).strip()
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        try:
            dt = datetime.strptime(raw[:10], "%Y-%m-%d")
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _week_key(value):
    dt = _parse_dt(value)
    if dt is None:
        return "unscheduled"
    iso = dt.isocalendar()
    return f"{iso[0]}-W{iso[1]:02d}"


def main() -> int:
    print(
        "YES! PIPELINE & FORECAST BRIEF. Review the weighted forecast and stalled "
        "deals below. Update deal records with upsert_deal as you learn new info "
        "(stage/amount/expected_close/last_touch). Reporting (list_deals, "
        "stalled_deals, forecast) is read-only. Do NOT contact prospects or quote "
        "pricing here. End with the trust header.\n"
    )
    deals = _deals()
    open_deals = [d for d in deals if d.get("stage") in OPEN_STAGES]

    total_w = 0.0
    total_raw = 0.0
    weeks = {}
    for d in open_deals:
        amt = float(d.get("amount") or 0)
        prob = STAGE_PROBABILITY.get(d.get("stage"), 0.0)
        w = round(amt * prob, 2)
        total_raw += amt
        total_w += w
        wk = _week_key(d.get("expected_close"))
        slot = weeks.setdefault(wk, {"count": 0, "weighted": 0.0})
        slot["count"] += 1
        slot["weighted"] = round(slot["weighted"] + w, 2)

    print("## Weighted forecast")
    print(f"- Open deals: {len(open_deals)}")
    print(f"- Raw pipeline: {round(total_raw, 2)}")
    print(f"- Weighted forecast: {round(total_w, 2)}")
    if weeks:
        print("- By week (weighted):")
        for wk in sorted(weeks, key=lambda k: (k == "unscheduled", k)):
            print(f"  - {wk}: {weeks[wk]['weighted']} ({weeks[wk]['count']} deal(s))")
    else:
        print("- (no open deals on file yet)")
    print("")

    now = datetime.now(timezone.utc)
    stalled = []
    for d in open_deals:
        dt = _parse_dt(d.get("last_touch"))
        days = None if dt is None else (now - dt).days
        if days is None or days >= STALL_DAYS:
            stalled.append((d.get("account") or d.get("deal_id"), days, d.get("stage")))
    print(f"## Stalled deals (no touch in {STALL_DAYS}d)")
    if stalled:
        stalled.sort(key=lambda r: (r[1] is not None, -(r[1] or 10**6)))
        for acct, days, stage in stalled:
            age = "unknown" if days is None else f"{days}d"
            print(f"- {acct} [{stage}] — {age} since touch")
    else:
        print("- (none)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
