#!/usr/bin/env python3
"""Pre-run injector for the YES! daily blog-draft cron job (Phase 3).

The cron scheduler runs this BEFORE the 09:00 draft agent and prepends its
stdout to the draft prompt as context (see cron/scheduler.py, the "## Script
Output" block). It surfaces the **house-style digest** — editorial rules the
08:00 ``learn-from-published`` job distilled from how the human editor revised
earlier AI drafts — so every new draft applies accumulated corrections
deterministically, without relying on the agent to query for them.

Deployed to ``$HERMES_HOME/scripts/`` on the hermes agent box. Pure stdlib; it
reads the digest file directly so it carries no project-import dependencies and
runs identically regardless of cwd.

IMPORTANT: this must ALWAYS print something. Empty stdout makes the scheduler
treat the pre-run step as "nothing to report" and skip the draft entirely.
"""

import os
from pathlib import Path


def _hermes_home() -> Path:
    return Path(os.getenv("HERMES_HOME") or (Path.home() / ".hermes"))


def main() -> int:
    digest = _hermes_home() / "blog_learning" / "house-style.md"
    print(
        "YES! HOUSE-STYLE RULES — learned from how the human editor revised "
        "earlier AI blog drafts. Apply ALL of these to the post you are about "
        "to write; where they conflict with generic guidance, these win.\n"
    )
    text = ""
    if digest.exists():
        try:
            text = digest.read_text(encoding="utf-8").strip()
        except OSError:
            text = ""
    if text:
        print(text)
    else:
        print(
            "(No editorial lessons recorded yet — the learning loop has not "
            "processed any human-edited posts. Follow the brand skill and the "
            "YES! brand rules as usual.)"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
