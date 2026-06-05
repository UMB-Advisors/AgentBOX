---
name: shopify-blog
description: "Draft and publish blog posts on a Shopify store via the Admin API. Posts default to UNPUBLISHED DRAFT."
version: 1.0.0
author: AgentBOX
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Shopify, Blog, Content, Ecommerce, CPG]
prerequisites:
  env: [SHOPIFY_SHOP, SHOPIFY_ACCESS_TOKEN]
  toolsets: [shopify]
---

# Shopify Blog

Create blog posts (articles) on a Shopify store. The implementation lives in
the native `shopify` toolset (`tools/shopify_tools.py`), not in this skill —
this document tells the agent how and when to use it.

## When to use

Use the `shopify` toolset whenever the task is to draft, schedule, or publish a
blog article on the connected Shopify store.

## Tools (toolset: `shopify`)

- `create_shopify_blog_post(blog, title, body_html, tags="", author=None, summary_html=None, published=false)`
  - Creates an article. `published` defaults to **false** → an unpublished
    DRAFT (not visible on the storefront). Returns `{id, handle, published, admin_url}`.
  - Always leave `published=false` unless the operator explicitly asks to go live.
- `resolve_shopify_blog_id(blog)` — confirm a blog handle exists / get its id.
- `delete_shopify_blog_post(blog, article_id)` — remove an article.

## Configuration

Set these env vars (read at call time, never hardcoded):

- `SHOPIFY_SHOP` — e.g. `yes-cacao.myshopify.com`
- `SHOPIFY_ACCESS_TOKEN` — Admin API access token (`shpat_...`)

The tools are only exposed when both env vars are present (toolset `check_fn`).

## Yes Cacao defaults

- Store: `yes-cacao.myshopify.com`
- Blog handle: `yes-blog`
- Write in Yes Cacao brand voice (load the `brand` skill for voice guidance).

See `README.md` (deploy) and `CRON.md` (daily draft-and-email automation).
