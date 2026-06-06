#!/usr/bin/env python3
"""Pre-run injector for the Lead Enrichment (Job 2.1) cron.

The scheduler runs this before the enrichment agent and prepends its stdout to
the prompt as "## Script Output". It surfaces the ICP scoring rubric (operator /
Job-1.1 input) plus the learned scoring refinements so each enrichment run scores
accounts consistently and applies prior human corrections.

Deployed to ``$HERMES_HOME/scripts/``. Pure stdlib. Must always print something —
empty stdout makes the scheduler skip the run.
"""

import os
from pathlib import Path


def _hermes_home() -> Path:
    return Path(os.getenv("HERMES_HOME") or (Path.home() / ".hermes"))


def _read(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8").strip() if p.exists() else ""
    except OSError:
        return ""


def main() -> int:
    base = _hermes_home() / "enrichment"
    print(
        "YES! LEAD-SCORING BRIEF. Find and score retail buyers, specialty "
        "grocers, gift shops, and corporate-gifting accounts against the ICP "
        "below. FIRMOGRAPHIC ONLY — company-level signals, no contact PII "
        "(names/emails). Score each 0-100 (>=70 A, 40-69 B, <40 C) and store via "
        "record_scored_account. Do not contact anyone; this produces a reviewed "
        "account list only.\n"
    )
    rubric = _read(base / "icp_rubric.md")
    if rubric:
        print("## ICP rubric\n" + rubric + "\n")
    else:
        print(
            "## ICP rubric\n(No ICP rubric on file yet — use the brand profile + "
            "DTC/wholesale/corporate-gifting segments and flag that Job 1.1 has "
            "not yet delivered a confirmed ICP.)\n"
        )
    learned = _read(base / "rubric-digest.md")
    if learned:
        print("## Learned scoring rules\n" + learned + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
