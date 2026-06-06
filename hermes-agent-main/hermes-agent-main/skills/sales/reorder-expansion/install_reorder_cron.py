#!/usr/bin/env python3
"""Install the Reorder & Expansion (Job 3.3) weekly cron on the agent box.

Run ON THE HERMES AGENT BOX (where ~/.hermes is the live runtime):

    python3 skills/sales/reorder-expansion/install_reorder_cron.py

Deploys the due-reorder injector to $HERMES_HOME/scripts/ and creates a weekly
cron that drafts (never sends) reorder/expansion outreach prompts for wholesale
accounts that are overdue per their order cadence, for human review.

Idempotent: skips if the job already exists; refreshes the injector.
"""

import os
import shutil
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT_ROOT))

JOB_NAME = "YES! reorder & expansion"
SCHEDULE = "0 8 * * 1"  # Monday 08:00 (weekly)
SCRIPT_NAME = "inject_reorder_due.py"
SRC = Path(__file__).resolve().parent / SCRIPT_NAME
SKILLS = ["brand", "reorder-expansion"]
ENABLED_TOOLSETS = ["reorder"]

PROMPT = (
    "Draft reorder & expansion outreach prompts for the OVERDUE YES! "
    "Celebrational Cacao wholesale accounts in the brief above. For each, call "
    "draft_reorder_prompt(account_id, expansion_signals, draft_message, note) to "
    "write an UNSENT review file — a warm, specific reorder nudge plus any "
    "expansion signal (seasonal SKU fit, growing order size, new location). Use "
    "YES! Celebrational Cacao branding; keep functional/health claims out unless "
    "human-approved. When done, summarize the drafts and end with the trust "
    "header. Draft only — do not contact anyone."
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
