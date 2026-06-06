#!/usr/bin/env python3
"""Install the Lead Enrichment (Job 2.1) cron on the agent box.

Run ON THE HERMES AGENT BOX (where ~/.hermes is the live runtime):

    python3 skills/productivity/sales-enrichment/install_enrichment_cron.py

Deploys the ICP-rubric injector to $HERMES_HOME/scripts/ and creates a weekly
enrichment cron that finds + firmographically scores prospect accounts against
the ICP and stores them for human review (the scored-account spine for Outbound).

Idempotent: skips if the job already exists; refreshes the injector.
"""

import os
import shutil
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT_ROOT))

JOB_NAME = "YES! lead enrichment"
SCHEDULE = "0 7 * * 1"  # Monday 07:00
SCRIPT_NAME = "inject_icp_rubric.py"
SRC = Path(__file__).resolve().parent / SCRIPT_NAME
SKILLS = ["brand", "sales-enrichment"]
ENABLED_TOOLSETS = ["enrichment", "web", "x_search"]

PROMPT = (
    "Find and firmographically score 10-20 NEW prospect accounts for YES! "
    "Celebrational Cacao — retail buyers, specialty grocers, gift shops, and "
    "corporate-gifting accounts — against the ICP in the brief above. Use "
    "web_search / x_search to research; company-level signals ONLY (no contact "
    "names or emails). For each, call record_scored_account(name, account_type, "
    "fit_score 0-100, location, website, icp_segment, rationale, firmographics). "
    "Skip accounts already on file. When done, summarize the top tier-A accounts "
    "and end with the trust header. Do not contact anyone — this is a reviewed "
    "list only."
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
