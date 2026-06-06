#!/usr/bin/env python3
"""Install the daily ``learn-from-published`` cron job into the live Hermes runtime.

Runs at 08:00 — BEFORE the 09:00 ``Yes Cacao daily blog draft`` job — so the
lessons mined from yesterday's human edits are ingested into gbrain and the
house-style digest is refreshed in time for the next draft.

Run from the hermes-agent project root ON THE DEPLOY HOST (where ~/.hermes is
the live cron runtime):

    python3 skills/productivity/shopify-blog/install_learn_cron.py

Prerequisites:
  * The ``shopify`` + ``blog_learning`` toolsets deployed (tools/shopify_tools.py,
    tools/blog_learning.py).
  * SHOPIFY_SHOP + SHOPIFY_ACCESS_TOKEN set in the scheduler's environment
    (or a store connected via Settings -> Shopify).
  * The ``gbrain`` CLI on PATH (or GBRAIN_BIN set) for lesson ingest.
  * Provenance records accumulating under ~/.hermes/blog_learning/drafts/ — i.e.
    the draft job has run at least once since provenance capture shipped.

Idempotency: refuses to create a second job if one with the same name exists.
"""

import os
import sys
from pathlib import Path

# Make the project root importable when run from anywhere.
# parents: [0]=shopify-blog, [1]=productivity, [2]=skills, [3]=project-root
PROJECT_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT_ROOT))

JOB_NAME = "Yes Cacao blog learn-from-published"
SCHEDULE = "0 8 * * *"  # 08:00, one hour before the 09:00 draft job
ENABLED_TOOLSETS = ["shopify", "blog_learning"]
SKILLS = ["brand"]
# model=None -> inherit scheduler default; set BLOG_LEARN_MODEL to override
# (the spec calls for gpt-5.5 on the subscription).
MODEL = os.getenv("BLOG_LEARN_MODEL") or None

PROMPT = """\
You are the YES! blog editorial-learning agent. Your job: learn how the human \
editor turns AI blog drafts into published YES! posts, so future drafts need \
fewer edits.

STEP 1 — call list_pending_blog_drafts. It returns AI-created drafts awaiting a \
terminal human action. If the list is empty, reply "No pending drafts." and stop.

STEP 2 — for EACH pending draft (process every one; do not stop early), call \
get_blog_post_feedback(article_id=<id>). It returns one of:
  - status="pending": the human hasn't published or deleted it yet. SKIP it — \
do NOT call record_blog_lesson for pending drafts.
  - status="rejected": the human DELETED the draft. Infer 1-2 negative lessons \
(what topic/angle/style to avoid), then call record_blog_lesson(article_id, \
status="rejected", lessons=[...], outcome="rejected").
  - status="published_clean": published with no meaningful edits. Call \
record_blog_lesson(article_id, status="processed", lessons=[], \
edit_magnitude=<value>, outcome="published_clean") to record the clean approval.
  - status="published_edited": the human edited then published. Study the \
unified_diff plus the original vs published text and distill the edits into \
GENERALIZABLE editorial lessons.

STEP 3 — for published_edited, build lessons[] where each lesson is \
{category, observation, rule, confidence (0-1), before, after}. Categories: \
naming, voice, length, claims/compliance, structure/AEO, title, cta, \
links/sources, image. Phrase each rule as reusable guidance \
("editor shortens intros to <=2 sentences"), never a one-off. Skip trivial \
typo-only changes. Then call record_blog_lesson(article_id, status="processed", \
lessons=[...], edit_magnitude=<value>, outcome="published_edited").

The tools persist lessons to gbrain and refresh the house-style digest \
automatically — you do not need to do that yourself.

When every pending draft is processed, give a 2-3 line summary: counts of \
published-edited / published-clean / rejected / still-pending, and the key \
lesson themes you saw.

BRAND RULES: the brand is ALWAYS written "YES!" (capitalized, with the \
exclamation mark). The product line is ALWAYS "Celebrational Cacao". Use the \
brand skill for voice context.
"""


def main() -> int:
    from cron.jobs import create_job, list_jobs

    for job in list_jobs(include_disabled=True):
        if (job.get("name") or "").strip() == JOB_NAME:
            print(f"A job named {JOB_NAME!r} already exists (id={job.get('id')}). "
                  "Nothing to do.")
            return 0

    job = create_job(
        prompt=PROMPT,
        schedule=SCHEDULE,
        name=JOB_NAME,
        skills=SKILLS,
        enabled_toolsets=ENABLED_TOOLSETS,
        model=MODEL,
        deliver="local",
    )
    print(f"Created cron job {job['id']}: {job['name']}")
    print(f"  Schedule:        {job['schedule_display']}")
    print(f"  Toolsets:        {job['enabled_toolsets']}")
    print(f"  Skills:          {job['skills']}")
    print(f"  Model:           {job.get('model') or '(scheduler default)'}")
    print(f"  Next run:        {job['next_run_at']}")
    print()
    print("Verify with:  hermes cron list")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
