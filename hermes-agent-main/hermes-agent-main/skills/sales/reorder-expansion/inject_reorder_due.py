#!/usr/bin/env python3
"""Pre-run injector for the Reorder & Expansion (Job 3.3) weekly cron.

The scheduler runs this before the reorder agent and prepends its stdout to the
prompt as "## Script Output". It ingests the operator's order-history stubs,
runs the cadence model, and dumps the set of accounts currently OVERDUE for a
reorder so the agent only drafts prompts for accounts that actually need one.

Cost-aware: if NOTHING is due it prints nothing — empty stdout makes the
scheduler skip the run, so we don't spin up an agent on a quiet week.

Deployed to ``$HERMES_HOME/scripts/``. Pure stdlib.
"""

import os
import sys
from pathlib import Path


def _hermes_home() -> Path:
    return Path(os.getenv("HERMES_HOME") or (Path.home() / ".hermes"))


def main() -> int:
    # Make the agent's tools importable when run from $HERMES_HOME/scripts/.
    for cand in (Path.cwd(), Path(__file__).resolve().parents[3]):
        if (cand / "tools" / "reorder.py").exists():
            sys.path.insert(0, str(cand))
            break

    try:
        from tools import reorder
    except Exception:  # noqa: BLE001 - never block the run on import issues
        return 0

    try:
        reorder.ingest_order_history()
        due = reorder.detect_reorders()
    except Exception:  # noqa: BLE001
        return 0

    if not due:
        # Nothing overdue — print nothing so the scheduler skips this run.
        return 0

    print(
        "YES! REORDER & EXPANSION BRIEF. The wholesale accounts below are OVERDUE "
        "for a reorder per their order cadence. For each, draft (do NOT send) a "
        "reorder/expansion outreach prompt with draft_reorder_prompt(account_id, "
        "expansion_signals, draft_message, note). Use YES! Celebrational Cacao "
        "branding; keep any functional/health claims out unless human-approved. "
        "End with the trust header. Draft only — never contact anyone.\n"
    )
    print("## Accounts overdue for reorder\n")
    for d in due:
        print(
            f"- {d.get('name')} (id={d.get('account_id')}): "
            f"{d.get('days_overdue')}d overdue | "
            f"avg cadence {d.get('avg_interval_days')}d | "
            f"{d.get('days_since_last_order')}d since last order "
            f"(last {d.get('last_order_date')}, {d.get('order_count')} orders)"
        )
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
