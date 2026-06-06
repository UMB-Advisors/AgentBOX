#!/usr/bin/env python3
"""Install the Speed-to-Lead (Job 2.3) backstop cron on the agent box.

Run ON THE HERMES AGENT BOX (where ~/.hermes is the live runtime):

    python3 skills/sales/speed-to-lead/install_speed_to_lead_cron.py

- writes a default qualification playbook to $HERMES_HOME/speed_to_lead/playbook.md
  (provisional rubric — refine per Yes! Cacao's real wholesale terms / OQ1);
- deploys the inbox-dump injector to $HERMES_HOME/scripts/;
- creates a 5-minute cron that drains the inquiry queue. The injector prints
  nothing when the queue is empty, so the LLM only runs when a lead is waiting.

NOTE: the inbound SOURCE adapter (what fills $HERMES_HOME/speed_to_lead/inbox/)
is not wired yet — that needs a verified inbound API (gateway hook or Gmail
poller) and a decision to touch the live gateway. Until then, enqueue via the
record_inquiry tool/API. Idempotent installer.
"""

import os
import shutil
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT_ROOT))

JOB_NAME = "YES! speed-to-lead"
SCHEDULE = "*/5 * * * *"  # every 5 minutes
SCRIPT_NAME = "inject_speed_to_lead.py"
SRC = Path(__file__).resolve().parent / SCRIPT_NAME
SKILLS = ["brand", "speed-to-lead"]
ENABLED_TOOLSETS = ["speed_to_lead", "messaging", "web"]

DEFAULT_PLAYBOOK = """\
# YES! Speed-to-Lead Qualification Playbook (provisional)

Respond to inbound wholesale / DM inquiries within minutes. Draft only — a human
approves before anything sends.

## Qualify (fit signals)
- Business type: specialty grocer, gift shop, cafe/roaster, corporate-gifting,
  distributor. Consumer DTC questions -> point to the shop, low priority.
- Volume/intent: opening order size, recurring vs one-off, timeline, region.
- Channel fit: does YES! Celebrational Cacao suit their shelf / gifting program?

## Actions
- **book_call**: qualified wholesale intent with real volume -> propose 2-3 times
  and offer to book.
- **handoff**: large/strategic/ambiguous, or pricing/terms negotiation -> route
  to a human with a summary.
- **reply**: simple info request -> draft a helpful answer + next step.
- **disqualify**: clearly out of scope -> polite redirect.

## Guardrails
- Never quote wholesale pricing or terms without human approval (that is Job 3.1).
- Always write "YES!" (with the exclamation) and "Celebrational Cacao".
- No health/functional claims without approval.
"""


def _hermes_home() -> Path:
    return Path(os.getenv("HERMES_HOME") or (Path.home() / ".hermes"))


def main() -> int:
    from cron.jobs import create_job, list_jobs

    home = _hermes_home()
    (home / "speed_to_lead").mkdir(parents=True, exist_ok=True)
    pb = home / "speed_to_lead" / "playbook.md"
    if not pb.exists():
        pb.write_text(DEFAULT_PLAYBOOK, encoding="utf-8")
        print(f"Wrote default playbook -> {pb}")
    else:
        print(f"Playbook already present -> {pb} (left as-is)")

    scripts_dir = home / "scripts"
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
        prompt=(
            "Handle the pending inbound inquiries listed above (Speed-to-Lead). "
            "If none are listed, respond with exactly [SILENT]. For each inquiry: "
            "qualify against the playbook, then draft_lead_response(...) — drafts "
            "are unsent and a human approves them. Hand off large or pricing-"
            "sensitive opportunities. End with the trust header."
        ),
        schedule=SCHEDULE,
        name=JOB_NAME,
        skills=SKILLS,
        enabled_toolsets=ENABLED_TOOLSETS,
        script=SCRIPT_NAME,
        deliver="local",
    )
    print(f"Created {job['id']}: {job['name']}  [{job['schedule_display']}]")
    print("Verify with:  hermes cron list")
    print("\nNOTE: nothing fills the inquiry inbox until a source adapter is "
          "wired. Enqueue test inquiries via the record_inquiry tool.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
