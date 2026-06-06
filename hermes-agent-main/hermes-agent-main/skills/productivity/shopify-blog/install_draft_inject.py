#!/usr/bin/env python3
"""Attach the house-style injector to the daily blog-draft cron job (Phase 3).

Run ON THE HERMES AGENT BOX (where ~/.hermes is the live cron runtime):

    python3 skills/productivity/shopify-blog/install_draft_inject.py

It copies ``inject_house_style.py`` into ``$HERMES_HOME/scripts/`` (the only
directory the scheduler will run scripts from) and sets it as the draft job's
pre-run ``script``. The 09:00 draft agent then always sees the current
house-style digest — refreshed by the 08:00 ``learn-from-published`` job —
prepended to its prompt as context.

Prerequisite: the draft job must already exist (install_cron.py).
Idempotent: re-copies the script and re-points the job on every run.
"""

import os
import shutil
import sys
from pathlib import Path

# parents: [0]=shopify-blog, [1]=productivity, [2]=skills, [3]=project-root
PROJECT_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT_ROOT))

DRAFT_JOB_NAME = "Yes Cacao daily blog draft"
SCRIPT_NAME = "inject_house_style.py"
SRC = Path(__file__).resolve().parent / SCRIPT_NAME


def _hermes_home() -> Path:
    return Path(os.getenv("HERMES_HOME") or (Path.home() / ".hermes"))


def main() -> int:
    from cron.jobs import list_jobs, update_job

    scripts_dir = _hermes_home() / "scripts"
    scripts_dir.mkdir(parents=True, exist_ok=True)
    dest = scripts_dir / SCRIPT_NAME
    shutil.copyfile(SRC, dest)
    os.chmod(dest, 0o755)
    print(f"Installed injector script -> {dest}")

    target = None
    for job in list_jobs(include_disabled=True):
        if (job.get("name") or "").strip() == DRAFT_JOB_NAME:
            target = job
            break
    if target is None:
        print(
            f"ERROR: draft job {DRAFT_JOB_NAME!r} not found. Install it first: "
            "python3 skills/productivity/shopify-blog/install_cron.py",
            file=sys.stderr,
        )
        return 1

    updated = update_job(target["id"], {"script": SCRIPT_NAME})
    if updated is None:
        print(f"ERROR: failed to update job {target['id']}.", file=sys.stderr)
        return 1
    print(f"Draft job {target['id']} now runs pre-step script {SCRIPT_NAME!r}.")
    print("The 09:00 draft will prepend the house-style digest on every run.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
