#!/usr/bin/env python3
"""Install the Speed-to-Lead inbound IMAP poller (no_agent cron) on the agent box.

Run ON THE HERMES AGENT BOX:

    python3 skills/sales/speed-to-lead/install_inquiry_poller.py

Deploys poll_inquiries.py to $HERMES_HOME/scripts/ and creates a deterministic
5-minute no_agent cron that drains a wholesale-inquiry mailbox into the
Speed-to-Lead queue. The separate responder cron (install_speed_to_lead_cron.py)
then drafts replies.

Requires IMAP creds in the hermes runtime env (STL_IMAP_HOST/USER/PASS, optional
STL_IMAP_FOLDER/PORT). Without them the poller is a harmless no-op. Idempotent.
"""

import os
import shutil
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT_ROOT))

JOB_NAME = "YES! speed-to-lead inbox poller"
SCHEDULE = "*/5 * * * *"
SCRIPT_NAME = "poll_inquiries.py"
SRC = Path(__file__).resolve().parent / SCRIPT_NAME


def _hermes_home() -> Path:
    return Path(os.getenv("HERMES_HOME") or (Path.home() / ".hermes"))


def main() -> int:
    from cron.jobs import create_job, list_jobs

    scripts_dir = _hermes_home() / "scripts"
    scripts_dir.mkdir(parents=True, exist_ok=True)
    dest = scripts_dir / SCRIPT_NAME
    shutil.copyfile(SRC, dest)
    os.chmod(dest, 0o755)
    print(f"Installed poller -> {dest}")

    for job in list_jobs(include_disabled=True):
        if (job.get("name") or "").strip() == JOB_NAME:
            print(f"{JOB_NAME!r} already exists (id={job.get('id')}); poller refreshed.")
            return 0

    job = create_job(
        prompt=None,
        schedule=SCHEDULE,
        name=JOB_NAME,
        script=SCRIPT_NAME,
        no_agent=True,  # the script IS the job — deterministic, no LLM
        deliver="local",
    )
    print(f"Created {job['id']}: {job['name']}  [{job['schedule_display']}]  (no_agent)")
    print("Set STL_IMAP_HOST / STL_IMAP_USER / STL_IMAP_PASS in the hermes env to activate.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
