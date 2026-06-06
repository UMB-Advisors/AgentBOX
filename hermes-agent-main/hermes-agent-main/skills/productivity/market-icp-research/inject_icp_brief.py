#!/usr/bin/env python3
"""Pre-run injector for the Market & ICP Research (Job 1.1) cron.

The scheduler runs this before the research agent and prepends its stdout to the
prompt as "## Script Output". It surfaces the *current* ICP segments, the
competitive brief, and the seasonal demand calendar so each monthly run refines
prior state instead of starting cold (and re-emits the cross-wired rubric/digest
that Jobs 2.1 / 1.3 consume).

Deployed to ``$HERMES_HOME/scripts/``. Pure stdlib. Must always print something —
empty stdout makes the scheduler skip the run.
"""

import json
import os
from pathlib import Path


def _hermes_home() -> Path:
    return Path(os.getenv("HERMES_HOME") or (Path.home() / ".hermes"))


def _read_json(p: Path):
    try:
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None
    except (OSError, json.JSONDecodeError):
        return None


def main() -> int:
    base = _hermes_home() / "icp_research"
    print(
        "YES! MARKET & ICP RESEARCH BRIEF. Refine the ICP for YES! Celebrational "
        "Cacao across three segments (DTC consumer, wholesale buyer, corporate "
        "gifting), the craft-chocolate / premium-CPG competitive brief, and the "
        "seasonal gifting-demand calendar. Research via web_search / x_search. "
        "MARKET + FIRMOGRAPHIC ONLY — no contact PII, no LinkedIn. Store via "
        "record_icp_segment / record_competitor / set_demand_calendar. Do not "
        "contact anyone and do not publish; this produces reviewed research only. "
        "Brand is always 'YES!'; product line 'Celebrational Cacao'; "
        "health/functional claims are human-gated.\n"
    )

    segs = []
    icp_dir = base / "icp"
    if icp_dir.is_dir():
        for p in sorted(icp_dir.glob("*.json")):
            rec = _read_json(p)
            if rec:
                segs.append(rec)
    if segs:
        print("## Current ICP segments")
        for s in segs:
            print(f"- {s.get('title') or s.get('segment')}: {s.get('description', '')}")
        print("")
    else:
        print("## Current ICP segments\n(None defined yet — start from scratch.)\n")

    comps = []
    comp_dir = base / "competitors"
    if comp_dir.is_dir():
        for p in sorted(comp_dir.glob("*.json")):
            rec = _read_json(p)
            if rec:
                comps.append(rec)
    if comps:
        print("## Competitors on file")
        for c in comps[:20]:
            print(f"- {c.get('name')} [{c.get('price_tier', 'unknown')}]: {c.get('positioning', '')}")
        print("")
    else:
        print("## Competitors on file\n(None yet — build the competitive brief.)\n")

    cal = _read_json(base / "demand_calendar.json")
    peaks = (cal or {}).get("peaks") or []
    if peaks:
        print("## Demand calendar (gifting peaks)")
        for pk in peaks:
            print(f"- {pk.get('month', '?')}: {pk.get('occasion', '')} (intensity {pk.get('intensity')})")
        print("")
    else:
        print("## Demand calendar (gifting peaks)\n(Empty — set the seasonal calendar.)\n")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
