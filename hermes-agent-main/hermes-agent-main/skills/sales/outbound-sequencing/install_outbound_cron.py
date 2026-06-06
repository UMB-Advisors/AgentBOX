#!/usr/bin/env python3
"""Install the Outbound Sequencing (Job 2.2) cron on the agent box.

Run ON THE HERMES AGENT BOX (where ~/.hermes is the live runtime):

    python3 skills/sales/outbound-sequencing/install_outbound_cron.py

Deploys the outbound-brief injector to $HERMES_HOME/scripts/ and creates a daily
cron that drafts personalized, email-first outbound cadence steps for approved
scored accounts and stores them as UNSENT artifacts for human review.

SENDS ARE DISABLED: this cron only drafts. Idempotent: skips if the job already
exists; refreshes the injector.
"""

import os
import shutil
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT_ROOT))

JOB_NAME = "YES! outbound sequencing"
SCHEDULE = "0 8 * * *"  # daily 08:00
SCRIPT_NAME = "inject_outbound_brief.py"
SRC = Path(__file__).resolve().parent / SCRIPT_NAME
SKILLS = ["brand", "outbound-sequencing"]
ENABLED_TOOLSETS = ["outbound", "enrichment", "web"]

PROMPT = (
    "Draft personalized, EMAIL-FIRST outbound cadence steps for the approved "
    "scored accounts in the brief above. For each candidate, enroll_account("
    "account_id, contact_email if known) then draft_sequence_step(account_id, "
    "step, body, subject) for each step — personalize from the firmographics. "
    "SENDS ARE DISABLED: produce UNSENT draft artifacts only; never send, publish, "
    "or message anyone. LinkedIn is OFF. Brand: always 'YES!' and 'Celebrational "
    "Cacao'; no health/functional claims in cold copy. Summarize the drafted steps "
    "and end with the trust header."
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
