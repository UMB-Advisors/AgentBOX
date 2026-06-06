#!/usr/bin/env python3
"""Install the daily Yes Cacao blog-draft cron job into the live Hermes runtime.

Run from the hermes-agent project root ON THE DEPLOY HOST (where ~/.hermes is
the live cron runtime):

    python3 skills/productivity/shopify-blog/install_cron.py

This calls cron.jobs.create_job(...) directly so it can set ``enabled_toolsets``
and ``skills`` — fields the ``hermes cron create`` CLI does not expose as flags.

Prerequisites (see README.md / CRON.md):
  * The ``shopify`` toolset must be deployed (tools/shopify_tools.py + toolsets.py).
  * SHOPIFY_SHOP + SHOPIFY_ACCESS_TOKEN set in the scheduler's environment.
  * Email configured in the gateway for the send_message email delivery to work.

Idempotency: refuses to create a second job if one with the same name exists.
"""

import os
import sys
from pathlib import Path

# Make the project root importable when run from anywhere.
# __file__ = skills/productivity/shopify-blog/install_cron.py
# parents: [0]=shopify-blog, [1]=productivity, [2]=skills, [3]=project-root
PROJECT_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT_ROOT))

JOB_NAME = "Yes Cacao daily blog draft"
SCHEDULE = "0 9 * * *"
ENABLED_TOOLSETS = ["web", "shopify", "messaging", "image_gen"]
SKILLS = ["brand", "shopify-blog"]
# Override per-deployment via env; default is the Yes Cacao operator.
OPERATOR_EMAIL = os.getenv("SHOPIFY_OPERATOR_EMAIL", "consultingfutures@gmail.com")
BLOG_HANDLE = "yes-blog"

PROMPT = f"""\
Pick ONE timely topic for the Yes Cacao blog from these themes: product \
education, ingredient science, functional benefits, recipes/rituals, \
sourcing/sustainability, brand story. Choose the freshest/most seasonally \
relevant angle and ground it with quick web research (web_search/web_extract) \
for any facts or trends you cite.

Write a complete blog post in the Yes Cacao brand voice (use the brand skill), \
~600-900 words, as semantic HTML in body_html (use <h2>, <p>, <ul> etc - no \
<html>/<body> wrapper). Give it a compelling title and a 1-2 sentence \
summary_html. Add 3-6 relevant tags.

Generate a featured image: call image_generate with provider="openai-codex", a \
16:9 / wide aspect ratio, and a brand-appropriate prompt based on the topic \
(warm, botanical, product-forward Yes Cacao chocolate aesthetic; photographic; \
NO text or words in the image). Note the returned image file path.

Create it as an UNPUBLISHED DRAFT on the '{BLOG_HANDLE}' blog by calling \
create_shopify_blog_post(blog="{BLOG_HANDLE}", title=..., body_html=..., \
summary_html=..., tags=..., author="Yes Cacao", \
image_path=<the file path returned by image_generate>, published=false).

Then EMAIL a summary to the operator: call send_message with \
target="{OPERATOR_EMAIL}" and a message containing the post title, the chosen \
theme, a 2-3 sentence summary, and the returned admin_url so the operator can \
review and publish. Do not publish the post yourself.
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
        deliver="local",
        # model=None -> inherit scheduler default. Set a string to override.
    )
    print(f"Created cron job {job['id']}: {job['name']}")
    print(f"  Schedule:        {job['schedule_display']}")
    print(f"  Toolsets:        {job['enabled_toolsets']}")
    print(f"  Skills:          {job['skills']}")
    print(f"  Next run:        {job['next_run_at']}")
    print()
    print("Verify with:  hermes cron list")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
