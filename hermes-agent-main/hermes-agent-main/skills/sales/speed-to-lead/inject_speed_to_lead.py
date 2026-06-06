#!/usr/bin/env python3
"""Pre-run injector for the Speed-to-Lead (Job 2.3) backstop cron.

Dumps the pending inbound inquiries + the qualification playbook so the agent can
respond fast. Prepended to the prompt as "## Script Output".

KEY BEHAVIOR: if there are NO pending inquiries it prints **nothing**, so the
scheduler skips the LLM call entirely (cost control). It only fires the agent
when there is actually a lead waiting.

Deployed to ``$HERMES_HOME/scripts/``. Pure stdlib.
"""

import json
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
    base = _hermes_home() / "speed_to_lead"
    inbox = base / "inbox"
    pending = []
    if inbox.exists():
        for p in sorted(inbox.glob("*.json")):
            try:
                rec = json.loads(p.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if rec.get("status") in ("new", "drafted"):
                pending.append(rec)

    if not pending:
        # No leads waiting -> print nothing so the scheduler skips the run.
        return 0

    print(
        f"SPEED-TO-LEAD: {len(pending)} inbound inquiry(ies) awaiting response. "
        "Respond FAST. For each: qualify against the playbook, then call "
        "draft_lead_response(inquiry_id, reply_draft, qualification, "
        "recommended_action). Drafts are UNSENT — a human approves before "
        "sending. Route unclear/large opportunities to a human (handoff). Never "
        "send or quote pricing without approval.\n"
    )
    playbook = _read(base / "playbook.md")
    learned = _read(base / "playbook-learned.md")
    if playbook:
        print("## Qualification playbook\n" + playbook + "\n")
    if learned:
        print("## Learned refinements\n" + learned + "\n")
    print("## Pending inquiries")
    for rec in pending:
        print(
            f"\n- inquiry_id: {rec.get('inquiry_id')} | source: {rec.get('source')} "
            f"| from: {rec.get('sender')} | status: {rec.get('status')}\n"
            f"  subject: {rec.get('subject')}\n"
            f"  body: {(rec.get('body') or '')[:1200]}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
