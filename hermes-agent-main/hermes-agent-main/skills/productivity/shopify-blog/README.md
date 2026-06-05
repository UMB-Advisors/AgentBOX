# Shopify Blog toolset

A first-class Hermes agent toolset (`shopify`) for creating blog posts on a
Shopify store via the Admin API. Posts are created as **unpublished drafts** by
default so a human reviews before anything goes live.

## What it is

- **Tool module:** `tools/shopify_tools.py` (auto-discovered, self-registering)
- **Toolset:** `shopify` (declared in `toolsets.py`)
- **Tools exposed:**
  - `create_shopify_blog_post(blog, title, body_html, tags="", author=None, summary_html=None, published=false)`
  - `resolve_shopify_blog_id(blog)`
  - `delete_shopify_blog_post(blog, article_id)`
- Pure stdlib (`urllib`) — no extra Python dependency. Admin API version `2026-04`.

## Required env vars

The tools read credentials from the environment on every call. **Never** commit
the token.

| Var | Example | Purpose |
|-----|---------|---------|
| `SHOPIFY_SHOP` | `yes-cacao.myshopify.com` | Store domain |
| `SHOPIFY_ACCESS_TOKEN` | `shpat_xxxxxxxx...` | Admin API access token |

The `shopify` toolset only appears in the agent's tool schema when **both** vars
are set (gated by the toolset `check_fn`).

## Deploy

This worktree contains the toolset; deploying to a running Hermes means getting
`tools/shopify_tools.py` and the `toolsets.py` change onto the agent host and
providing the env vars.

1. Merge / copy the two changed files into the deployed `hermes-agent`:
   - `tools/shopify_tools.py`
   - `toolsets.py` (the added `"shopify"` block)
2. Provide credentials to the agent process. Put them where Hermes loads env
   (e.g. the profile's environment / `.env` used by the gateway and cron
   scheduler — managed outside the repo). For a profile, this is typically
   `~/.hermes/.env` or the gateway's environment.
   ```
   SHOPIFY_SHOP=yes-cacao.myshopify.com
   SHOPIFY_ACCESS_TOKEN=shpat_...        # do NOT commit this
   ```
3. Restart the Hermes gateway / CLI so the new tool module is imported.

## Verify after deploy

```bash
SHOPIFY_SHOP=yes-cacao.myshopify.com SHOPIFY_ACCESS_TOKEN=shpat_... \
python3 -c '
from tools.registry import registry, discover_builtin_tools
discover_builtin_tools()
import toolsets
print("toolset:", "shopify" in toolsets.get_toolset_names())
print("tools:", [d["function"]["name"]
       for d in registry.get_definitions(set(toolsets.resolve_toolset("shopify")))])
'
```

Expected: `toolset: True` and the three `*_shopify_*` tools listed.

## Enable the daily cron job

The toolset must be deployed (above) **before** enabling the cron job — the job
references the `shopify` toolset and will fail if it isn't loaded. See
[`CRON.md`](./CRON.md) for the install script and the documented JSON snippet.
