#!/usr/bin/env python3
"""Install the Paid-Ad reporting (Job 1.4, Track A) cron on the agent box.

Run ON THE HERMES AGENT BOX (where ~/.hermes is the live runtime):

    python3 skills/productivity/paid-ads/install_ad_report_cron.py

Deploys the snapshot injector to $HERMES_HOME/scripts/ and creates a weekly
reporting cron that turns any operator-dropped performance export into a report +
budget-pacing recommendations + creative drafts. **Track A only** — this cron
loads only the `paid_ads` toolset, which has NO spend-mutation tools. Track B
(live campaign/spend) is deferred behind app review and must never be cron-driven.

Idempotent: skips if the job already exists; refreshes the injector.
"""

import os
import shutil
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT_ROOT))

JOB_NAME = "YES! paid-ad reporting"
SCHEDULE = "0 8 * * 1"  # Monday 08:00
SCRIPT_NAME = "inject_ad_snapshot.py"
SRC = Path(__file__).resolve().parent / SCRIPT_NAME
SKILLS = ["brand", "paid-ads"]
# Track A ONLY. The paid_ads toolset contains no spend-mutation tools; do not add
# any ad-platform write toolset here.
ENABLED_TOOLSETS = ["paid_ads"]

PROMPT = (
    "Produce the weekly YES! Celebrational Cacao paid-ad report (Track A — "
    "reporting only; you have NO Meta/TikTok spend access and must change "
    "nothing). For each new snapshot in the brief above, call "
    "record_ad_performance(snapshot_id, raw_snapshot, platform, period) to parse "
    "it into KPIs + advisory budget-pacing recommendations and write the report "
    "to the review folder. Optionally draft creative variants with "
    "draft_ad_creative. Summarize the pacing calls (pause/scale_up/scale_down/"
    "hold) and end with the trust header. If there are no new snapshots, say so "
    "and stop — do not fabricate data and do not attempt to access any ad platform."
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

    # Ensure the operator inbox exists so the injector has somewhere to look.
    inbox = _hermes_home() / "paid_ads" / "inbox"
    inbox.mkdir(parents=True, exist_ok=True)
    print(f"Snapshot inbox -> {inbox}")

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
