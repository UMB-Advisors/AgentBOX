#!/usr/bin/env python3
"""Pre-run injector for the Outbound Sequencing (Job 2.2) cron.

The scheduler runs this before the outbound agent and prepends its stdout to the
prompt as "## Script Output". It surfaces the outbound playbook (cadence + voice
rubric + learned refinements) and a small worklist of approved scored accounts
that are NOT yet enrolled, so each run drafts a focused batch rather than
re-walking the whole list (cost-aware).

Deployed to ``$HERMES_HOME/scripts/``. Pure stdlib. Must always print something —
empty stdout makes the scheduler skip the run. NEVER triggers a send.
"""

import json
import os
from pathlib import Path

BATCH = 10  # cap candidate accounts per run (cost-aware)


def _hermes_home() -> Path:
    return Path(os.getenv("HERMES_HOME") or (Path.home() / ".hermes"))


def _read(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8").strip() if p.exists() else ""
    except OSError:
        return ""


def _enrolled_ids() -> set:
    d = _hermes_home() / "outbound" / "sequences"
    out = set()
    if d.exists():
        for p in d.glob("*.json"):
            out.add(p.stem)
    return out


def _candidate_accounts() -> list:
    """Approved tier-A/B accounts from Job 2.1 not yet enrolled. Best-effort over
    the enrichment JSON store (no imports — the cron subprocess may not have the
    package path)."""
    d = _hermes_home() / "enrichment" / "accounts"
    if not d.exists():
        return []
    enrolled = _enrolled_ids()
    rows = []
    for p in sorted(d.glob("*.json")):
        try:
            rec = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if rec.get("status") == "approved" and rec.get("tier") in ("A", "B") \
                and rec.get("account_id") not in enrolled:
            rows.append(rec)
    rows.sort(key=lambda r: r.get("fit_score") or 0, reverse=True)
    return rows[:BATCH]


def main() -> int:
    base = _hermes_home() / "outbound"
    print(
        "YES! OUTBOUND SEQUENCING BRIEF. Draft personalized, EMAIL-FIRST outbound "
        "cadence steps for the approved scored accounts below. SENDS ARE DISABLED — "
        "produce UNSENT draft artifacts via enroll_account + draft_sequence_step "
        "ONLY; never send, publish, or message anyone. LinkedIn is OFF. Brand: "
        "always 'YES!' and 'Celebrational Cacao'; no health/functional claims in "
        "cold copy. End with the trust header.\n"
    )
    pb = _read(base / "playbook.md")
    learned = _read(base / "playbook-learned.md")
    if pb:
        print("## Outbound playbook\n" + pb + "\n")
    if learned:
        print("## Learned cadence/voice rules\n" + learned + "\n")
    cands = _candidate_accounts()
    if cands:
        print(f"## Candidate accounts to enroll (top {len(cands)} approved, not yet enrolled)")
        for r in cands:
            print(
                f"- {r.get('account_id')}: {r.get('name')} "
                f"[{r.get('account_type')}, tier {r.get('tier')}, fit {r.get('fit_score')}]"
            )
        print()
    else:
        print(
            "## Candidate accounts\n(None approved-and-unenrolled on file. If the "
            "enrichment store is empty, flag that Job 2.1 has not delivered approved "
            "accounts yet — do not invent prospects.)\n"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
