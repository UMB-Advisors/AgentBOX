# Daily Yes Cacao blog-draft cron job

A daily job that researches one timely Yes Cacao topic, drafts a blog post in
brand voice, creates it as an **unpublished draft** on `yes-blog`, and emails a
summary + admin link to the operator.

> **Do NOT enable until the `shopify` toolset is deployed** (see `README.md`).
> The job references the `shopify` toolset and `SHOPIFY_*` env vars must be set
> in the cron scheduler's environment.

## Toolset name notes (as discovered in this codebase)

- **web research** → toolset `web` (tools `web_search`, `web_extract`).
- **shopify** → toolset `shopify` (this integration).
- **email** → there is **no dedicated `email` toolset**. Email is sent through
  the `send_message` tool, which lives in the `messaging` toolset. When the
  `target` is an email address, `send_message` routes via SMTP. So the job
  enables `messaging`, not `email`.
- **brand voice** → provided by the `brand` *skill* (not a toolset). Load it via
  the job's `skills` list, alongside this `shopify-blog` skill.

### Email prerequisite

`send_message` email delivery requires the gateway to be running **and** the
email platform to be configured (`EMAIL_ADDRESS`, `EMAIL_PASSWORD`,
`EMAIL_SMTP_HOST`, optional `EMAIL_SMTP_PORT`, and `EMAIL_HOME_ADDRESS` in the
Hermes gateway config). If email is not configured, the draft is still created
but the notification step fails — configure email first, or swap to Slack (see
bottom).

## Job specification

| Field | Value |
|-------|-------|
| schedule | `0 9 * * *` (daily, 09:00) |
| enabled_toolsets | `["web", "shopify", "messaging"]` |
| skills | `["brand", "shopify-blog"]` |
| model | `null` (inherit the scheduler default) — change in the script if desired |
| deliver | `local` (the email is sent by the agent itself via `send_message`) |
| prompt | see below |

### Prompt

```
Pick ONE timely topic for the Yes Cacao blog from these themes: product
education, ingredient science, functional benefits, recipes/rituals,
sourcing/sustainability, brand story. Choose the freshest/most seasonally
relevant angle and ground it with quick web research (web_search/web_extract)
for any facts or trends you cite.

Write a complete blog post in the Yes Cacao brand voice (use the brand skill),
~600-900 words, as semantic HTML in body_html (use <h2>, <p>, <ul> etc — no
<html>/<body> wrapper). Give it a compelling title and a 1-2 sentence
summary_html. Add 3-6 relevant tags.

Create it as an UNPUBLISHED DRAFT on the 'yes-blog' blog by calling
create_shopify_blog_post(blog="yes-blog", title=..., body_html=...,
summary_html=..., tags=..., author="Yes Cacao", published=false).

Then EMAIL a summary to the operator: call send_message with
target="consultingfutures@gmail.com" and a message containing the post title,
the chosen theme, a 2-3 sentence summary, and the returned admin_url so the
operator can review and publish. Do not publish the post yourself.
```

## (a) Install script — recommended

Sets `enabled_toolsets` and `skills` (which the `hermes cron create` CLI does
**not** expose as flags) by calling `create_job(...)` directly. Run it from the
hermes-agent project root **on the deploy host** (where `~/.hermes` is the live
runtime):

```bash
cd /path/to/hermes-agent          # the deployed project root
python3 skills/productivity/shopify-blog/install_cron.py
```

The script is at [`install_cron.py`](./install_cron.py). It is idempotent-ish:
it refuses to create a duplicate if a job named "Yes Cacao daily blog draft"
already exists.

## (b) Documented JSON snippet

If you prefer to hand-edit `~/.hermes/cron/jobs.json`, append an object of this
shape to the `jobs` array (the runtime fills `id`, `next_run_at`, timestamps,
etc. — easiest is to let the install script or the `cronjob` tool create it).
Minimal authoritative fields:

```json
{
  "name": "Yes Cacao daily blog draft",
  "prompt": "<the prompt above>",
  "skills": ["brand", "shopify-blog"],
  "skill": "brand",
  "model": null,
  "schedule": { "kind": "cron", "expr": "0 9 * * *", "display": "0 9 * * *" },
  "schedule_display": "0 9 * * *",
  "repeat": { "times": null, "completed": 0 },
  "enabled": true,
  "state": "scheduled",
  "deliver": "local",
  "enabled_toolsets": ["web", "shopify", "messaging"]
}
```

## (c) Via the agent `cronjob` tool (alternative)

From a Hermes chat with the `cronjob` toolset enabled:

```
cronjob(action="create",
        schedule="0 9 * * *",
        prompt="<the prompt above>",
        name="Yes Cacao daily blog draft",
        skills=["brand", "shopify-blog"],
        enabled_toolsets=["web", "shopify", "messaging"])
```

## Swapping email → Slack later

Slack is on standby. To deliver via Slack instead of email:

1. Add `slack` is **not** a separate toolset — Slack also goes through
   `send_message` (toolset `messaging`, already enabled). No toolset change needed.
2. In the prompt, change the delivery line to target a Slack channel/DM, e.g.
   `send_message(target="slack:#yes-cacao", message=...)` (or
   `target="slack"` for the home channel). Run `send_message(action="list")`
   first to see available Slack targets.
3. Ensure the Slack platform is configured in the gateway. Email and Slack can
   both be sent — add a second `send_message` call if you want both.
