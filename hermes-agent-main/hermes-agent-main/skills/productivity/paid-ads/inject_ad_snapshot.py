#!/usr/bin/env python3
"""Pre-run injector for the Paid-Ad reporting (Job 1.4) cron — Track A only.

The scheduler runs this before the paid-ad reporting agent and prepends its
stdout to the prompt as "## Script Output". It surfaces:
  * the learned ad-playbook (recurring pacing/creative rules), and
  * any NEW performance snapshots the operator dropped into the inbox
    (``$HERMES_HOME/paid_ads/inbox/*.csv`` / ``.tsv``) for this run to report on.

Cost-aware: if there is no learned playbook AND no new snapshot files, it prints
a short standing brief telling the agent there is nothing to report this cycle
(so the run is a cheap no-op rather than the agent hunting for work). It NEVER
emits empty stdout (that makes the scheduler skip the run).

There is intentionally NO live ad-platform access here — Track B (spend) is
deferred. Deployed to ``$HERMES_HOME/scripts/``. Pure stdlib.
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
    base = _hermes_home() / "paid_ads"
    inbox = base / "inbox"
    snapshots = []
    if inbox.is_dir():
        snapshots = sorted(
            [p for p in inbox.glob("*") if p.suffix.lower() in (".csv", ".tsv", ".txt")]
        )

    print(
        "YES! PAID-AD REPORTING BRIEF (Track A — reporting only). You have NO "
        "Meta/TikTok API access and MUST NOT change any spend; produce a report, "
        "advisory budget-pacing recommendations, and creative-variant drafts only. "
        "For each new snapshot file below, read it and call "
        "record_ad_performance(snapshot_id, raw_snapshot=<file contents>, "
        "platform, period). Then summarize the pacing calls and end with the trust "
        "header. Apply nothing — the operator acts in Ads Manager.\n"
    )

    playbook = _read(base / "ad-playbook.md")
    if playbook:
        print("## Learned ad-playbook\n" + playbook + "\n")

    if snapshots:
        print("## New snapshots to report on\n")
        # Cap embedded content so a huge export can't blow up the prompt; point
        # the agent at the path to read in full when truncated.
        for p in snapshots:
            body = _read(p)
            sid = p.stem
            print(f"### {sid}  (file: {p})\n")
            if len(body) > 6000:
                print(body[:6000] + "\n… [truncated — read the full file at the path above]\n")
            else:
                print(body + "\n")
    else:
        print(
            "## No new snapshots\n(No new export files in "
            f"{inbox}. Nothing to report this cycle — the operator drops CSV/TSV "
            "exports there. Do not fabricate data.)\n"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
