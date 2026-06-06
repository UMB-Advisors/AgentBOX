#!/usr/bin/env python3
"""Install the Pipeline & Forecasting (Job 3.2) weekly cron on the agent box.

Run ON THE HERMES AGENT BOX (where ~/.hermes is the live runtime):

    python3 skills/sales/pipeline-forecasting/install_pipeline_cron.py

Deploys the forecast injector to $HERMES_HOME/scripts/ and creates a weekly cron
that reviews the weighted pipeline forecast + stalled deals (read-only reporting)
and updates deal records as new information lands.

Idempotent: skips if the job already exists; refreshes the injector.
"""

import os
import shutil
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT_ROOT))

JOB_NAME = "YES! pipeline forecast"
SCHEDULE = "30 7 * * 1"  # Monday 07:30
SCRIPT_NAME = "inject_forecast.py"
SRC = Path(__file__).resolve().parent / SCRIPT_NAME
SKILLS = ["pipeline-forecasting"]
ENABLED_TOOLSETS = ["pipeline"]

PROMPT = (
    "Review the YES! Celebrational Cacao deal pipeline using the weighted forecast "
    "and stalled-deal list in the brief above. Reporting (forecast, list_deals, "
    "stalled_deals) is read-only — summarize the weighted weekly forecast and call "
    "out stalled deals that need a touch. If you have concrete new information "
    "about a deal (stage change, amount, expected_close, last activity), update it "
    "with upsert_deal. Do NOT contact prospects and do NOT quote pricing — that is "
    "Jobs 2.2/2.3 and 3.1. End with the trust header."
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
