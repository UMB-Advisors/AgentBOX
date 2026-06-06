#!/usr/bin/env python3
"""Install Content Engine (Job 1.3) per-channel draft crons on the agent box.

Run ON THE HERMES AGENT BOX (where ~/.hermes is the live runtime):

    python3 skills/social-media/content-engine/install_content_crons.py [channels...]

Default channels: x email. (blog is handled by the shopify-blog learning loop;
instagram/tiktok can be added but draft to a review folder only.)

For each channel it:
  - deploys a per-channel brief injector to $HERMES_HOME/scripts/inject_content_<channel>.py
    (the injector derives its channel from its own filename);
  - creates a draft cron whose pre-run script is that injector.

Idempotent: skips a channel whose job name already exists; re-copies the injector.
"""

import os
import shutil
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT_ROOT))

SRC_INJECTOR = Path(__file__).resolve().parent / "inject_content_brief.py"
SKILLS = ["brand", "content-engine"]

# channel -> (schedule, extra toolsets)
CHANNEL_CRONS = {
    "x": ("30 9 * * *", ["web", "x_search", "image_gen"]),
    "email": ("0 10 * * 1", ["web", "messaging"]),
    "instagram": ("0 11 * * 1", ["web", "image_gen"]),
    "tiktok": ("0 11 * * 4", ["web", "image_gen", "video_gen"]),
}


def _hermes_home() -> Path:
    return Path(os.getenv("HERMES_HOME") or (Path.home() / ".hermes"))


def _prompt(channel: str) -> str:
    return (
        f"Draft ONE timely piece of YES! content for the {channel} channel. Use "
        "the content-engine skill. First read the learned house style with "
        f"content_house_style(channel=\"{channel}\") and apply it. Ground any "
        "facts/trends with quick web research. Write in the YES! brand voice "
        "(brand is always \"YES!\"; product line always \"Celebrational Cacao\"), "
        f"native to {channel}. Then call save_content_draft(channel=\"{channel}\", "
        "content_id=<a stable slug>, body=..., title=..., topic=..., theme=...). "
        "Do NOT publish. Keep any health/functional claim flagged for human "
        "approval. End with the returned trust_header so the operator sees the "
        "trust state."
    )


def main(argv) -> int:
    from cron.jobs import create_job, list_jobs

    channels = [c.strip().lower() for c in argv if c.strip()] or ["x", "email"]
    scripts_dir = _hermes_home() / "scripts"
    scripts_dir.mkdir(parents=True, exist_ok=True)
    existing = {(j.get("name") or "").strip() for j in list_jobs(include_disabled=True)}

    for ch in channels:
        if ch not in CHANNEL_CRONS:
            print(f"skip {ch!r}: not a known content channel ({', '.join(CHANNEL_CRONS)})")
            continue
        schedule, extra = CHANNEL_CRONS[ch]
        injector_name = f"inject_content_{ch}.py"
        dest = scripts_dir / injector_name
        shutil.copyfile(SRC_INJECTOR, dest)
        os.chmod(dest, 0o755)
        name = f"YES! content draft — {ch}"
        if name in existing:
            print(f"{name!r} already exists; injector refreshed -> {dest}")
            continue
        job = create_job(
            prompt=_prompt(ch),
            schedule=schedule,
            name=name,
            skills=SKILLS,
            enabled_toolsets=["content", *extra],
            script=injector_name,
            deliver="local",
        )
        print(f"Created {job['id']}: {name}  [{job['schedule_display']}]  script={injector_name}")

    print("\nVerify with:  hermes cron list")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
