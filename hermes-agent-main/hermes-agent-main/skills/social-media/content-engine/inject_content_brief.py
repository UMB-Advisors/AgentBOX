#!/usr/bin/env python3
"""Pre-run brief injector for a Content Engine (Job 1.3) draft cron.

The scheduler runs this before the channel's draft agent and prepends its stdout
to the prompt as "## Script Output". It surfaces the channel's learned
house-style digest + the YES! brand brief + ICP (if present) so each draft
applies accumulated editorial corrections deterministically.

The channel is derived from this script's own filename
(``inject_content_<channel>.py``) so one source serves every channel without a
project import. Deployed to ``$HERMES_HOME/scripts/``. Pure stdlib.

IMPORTANT: must always print something — empty stdout makes the scheduler skip
the draft entirely.
"""

import os
import sys
from pathlib import Path


def _hermes_home() -> Path:
    return Path(os.getenv("HERMES_HOME") or (Path.home() / ".hermes"))


def _channel() -> str:
    stem = Path(sys.argv[0]).stem  # e.g. inject_content_x
    prefix = "inject_content_"
    if stem.startswith(prefix) and len(stem) > len(prefix):
        return stem[len(prefix):]
    return os.getenv("CONTENT_CHANNEL", "x")


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8").strip() if path.exists() else ""
    except OSError:
        return ""


def main() -> int:
    home = _hermes_home()
    channel = _channel()
    print(
        f"YES! CONTENT BRIEF — channel: {channel}. Draft in the YES! brand voice "
        "(brand is always \"YES!\" with the exclamation mark; product line is "
        "always \"Celebrational Cacao\"). Apply the learned house-style rules "
        "below; they came from real editor corrections. Draft only — do not "
        "publish. Any health/functional claim stays human-approved.\n"
    )

    brand = _read(home / "content_engine" / "brand_brief.md")
    if brand:
        print("## Brand brief\n" + brand + "\n")

    icp = _read(home / "content_engine" / "icp_digest.md")
    if icp:
        print("## ICP / audience\n" + icp + "\n")

    house = _read(home / "content_engine" / channel / "house-style.md")
    if house:
        print("## Learned house style (" + channel + ")\n" + house + "\n")
    else:
        print(
            "## Learned house style (" + channel + ")\n(No lessons recorded yet "
            "for this channel — follow the brand skill and channel norms.)"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
