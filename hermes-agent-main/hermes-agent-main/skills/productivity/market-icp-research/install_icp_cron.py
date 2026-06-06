#!/usr/bin/env python3
"""Install the Market & ICP Research (Job 1.1) cron on the agent box.

Run ON THE HERMES AGENT BOX (where ~/.hermes is the live runtime):

    python3 skills/productivity/market-icp-research/install_icp_cron.py

Deploys the ICP-brief injector to $HERMES_HOME/scripts/ and creates a monthly
cron that refines the YES! Celebrational Cacao ICP, competitive brief, and
seasonal demand calendar, re-emitting the cross-wired rubric/digest that Jobs
2.1 (enrichment) and 1.3 (content) consume.

Idempotent: skips if the job already exists; refreshes the injector.
"""

import os
import shutil
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT_ROOT))

JOB_NAME = "YES! market & ICP research"
SCHEDULE = "0 6 1 * *"  # 1st of the month, 06:00
SCRIPT_NAME = "inject_icp_brief.py"
SRC = Path(__file__).resolve().parent / SCRIPT_NAME
SKILLS = ["brand", "market-icp-research"]
ENABLED_TOOLSETS = ["icp_research", "web", "x_search"]

PROMPT = (
    "Refine the YES! Celebrational Cacao ICP using the brief above. Research with "
    "web_search / x_search (market + firmographic only — no contact PII, no "
    "LinkedIn). (1) Define/refine the three ICP segments (DTC consumer, wholesale "
    "buyer, corporate gifting) via record_icp_segment with fit_signals, "
    "disqualifiers, channels, and pain_points. (2) Add or update 5-10 competitors "
    "(craft-chocolate / premium-CPG) via record_competitor with positioning, "
    "price_tier, strengths, and gaps. (3) Set the seasonal gifting-demand calendar "
    "via set_demand_calendar. Then summarize the ICP, top differentiators, and the "
    "next gifting peak, and end with the trust header. Do not contact anyone and "
    "do not publish — this is reviewed research only. Brand is always 'YES!'; "
    "product line 'Celebrational Cacao'; health/functional claims are human-gated."
)


def _hermes_home() -> Path:
    return Path(os.getenv("HERMES_HOME") or (Path.home() / ".hermes"))


def main() -> int:
    from cron.jobs import create_job, list_jobs

    scripts_dir = _hermes_home() / "scripts"
    scripts_dir.mkdir(parents=True, exist_ok=True)
    dest = scripts_dir / SCRIPT_NAME
    shutil.copyfile(SRC, dest)
    os.chmod(dest, 0o755)
    print(f"Installed injector -> {dest}")

    for job in list_jobs(include_disabled=True):
        if (job.get("name") or "").strip() == JOB_NAME:
            print(f"{JOB_NAME!r} already exists (id={job.get('id')}); injector refreshed.")
            return 0

    job = create_job(
        prompt=PROMPT,
        schedule=SCHEDULE,
        name=JOB_NAME,
        skills=SKILLS,
        enabled_toolsets=ENABLED_TOOLSETS,
        script=SCRIPT_NAME,
        deliver="local",
    )
    print(f"Created {job['id']}: {job['name']}  [{job['schedule_display']}]")
    print("Verify with:  hermes cron list")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
