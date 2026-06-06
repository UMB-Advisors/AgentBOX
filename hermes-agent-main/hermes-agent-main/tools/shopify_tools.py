"""Shopify Admin API tool for creating blog posts (articles) on a store.

Registers three LLM-callable tools under the ``shopify`` toolset:
- ``create_shopify_blog_post`` -- create a blog article (draft by default)
- ``resolve_shopify_blog_id``  -- look up a blog's numeric id by handle
- ``delete_shopify_blog_post`` -- delete a blog article by id

Authentication uses a Shopify Admin API access token. Configuration is read
from env vars at call time:
- ``SHOPIFY_SHOP``          -- store domain, e.g. "yes-cacao.myshopify.com"
- ``SHOPIFY_ACCESS_TOKEN``  -- Admin API access token (shpat_...)

The token is NEVER hardcoded — it is read from the environment on every call.

Pure stdlib (urllib) — no third-party HTTP dependency. Mirrors the proven
reference client verified against the live store.
"""

import base64
import json
import logging
import os
import urllib.error
import urllib.request

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

API_VERSION = "2026-04"


def _resolve_creds():
    """Return (shop, token) or None.

    Prefers a store connected via the dashboard Settings -> Shopify flow
    (hermes_cli.shopify_accounts), falling back to the SHOPIFY_SHOP /
    SHOPIFY_ACCESS_TOKEN env vars. The import is lazy + guarded so the toolset
    still works in trees where shopify_accounts is absent.
    """
    try:
        from hermes_cli import shopify_accounts
        pair = shopify_accounts.resolve_credentials()
        if pair:
            return pair
    except Exception:  # noqa: BLE001 - degrade to env fallback
        pass
    shop = os.getenv("SHOPIFY_SHOP", "").strip()
    token = os.getenv("SHOPIFY_ACCESS_TOKEN", "").strip()
    if shop and token:
        return shop, token
    return None


def _get_config():
    """Return (shop, token) at call time. Raises if neither a connected store
    nor the env vars are available."""
    creds = _resolve_creds()
    if not creds:
        raise RuntimeError(
            "Shopify not configured: connect a store in Settings -> Shopify, or "
            "set SHOPIFY_SHOP and SHOPIFY_ACCESS_TOKEN."
        )
    return creds


# ---------------------------------------------------------------------------
# Low-level Admin API request helper (pure stdlib)
# ---------------------------------------------------------------------------


def _req(method, path, payload=None):
    """Make an authenticated Admin REST API request. Returns parsed JSON (or {})."""
    shop, token = _get_config()
    url = f"https://{shop}/admin/api/{API_VERSION}/{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "X-Shopify-Access-Token": token,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read().decode()
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        raise RuntimeError(
            f"Shopify {method} {path} -> HTTP {e.code}: {e.read().decode()[:400]}"
        )
    except urllib.error.URLError as e:
        raise RuntimeError(f"Shopify {method} {path} -> network error: {e.reason}")


# ---------------------------------------------------------------------------
# Core operations (reused proven client logic)
# ---------------------------------------------------------------------------


def resolve_blog_id(blog_handle):
    """Resolve a blog handle (e.g. 'yes-blog') to its numeric blog id."""
    for b in _req("GET", "blogs.json?limit=250").get("blogs", []):
        if b["handle"] == blog_handle:
            return b["id"]
    raise ValueError(f"No blog with handle {blog_handle!r}")


def _build_article_image(image_path=None, image_src=None, alt=None):
    """Build a Shopify article ``image`` dict.

    From a local file (e.g. a PNG produced by the ``image_generate`` tool under
    ``$HERMES_HOME/cache/images/``) -> base64 ``attachment``; or from a remote
    ``image_src`` URL. Returns None if neither is given.
    """
    img = {}
    if image_path:
        with open(image_path, "rb") as fh:
            img["attachment"] = base64.b64encode(fh.read()).decode("ascii")
        img["filename"] = os.path.basename(image_path)
    elif image_src:
        img["src"] = image_src
    else:
        return None
    if alt:
        img["alt"] = alt[:512]
    return img


def create_blog_post(blog_handle, title, body_html, tags="", author=None,
                     summary_html=None, published=False,
                     image_path=None, image_src=None, image_alt=None):
    """Create a blog article. published=False => DRAFT (not on storefront).

    A featured image can be attached from a local file (``image_path``, e.g. the
    PNG returned by ``image_generate``) or a URL (``image_src``); ``image_alt``
    defaults to the title.

    Returns {"id", "handle", "published", "admin_url", "has_image"} on success.
    """
    blog_id = resolve_blog_id(blog_handle)
    article = {"title": title, "body_html": body_html, "published": bool(published)}
    if tags:
        article["tags"] = tags
    if author:
        article["author"] = author
    if summary_html:
        article["summary_html"] = summary_html
    image = _build_article_image(image_path, image_src, image_alt or title)
    if image:
        article["image"] = image
    res = _req("POST", f"blogs/{blog_id}/articles.json", {"article": article})["article"]
    shop, _ = _get_config()
    store_slug = shop.split(".")[0]
    return {
        "id": res["id"],
        "handle": res.get("handle"),
        "published": res.get("published_at") is not None,
        "has_image": res.get("image") is not None,
        "admin_url": f"https://admin.shopify.com/store/{store_slug}/content/articles/{res['id']}",
    }


def delete_blog_post(blog_handle, article_id):
    """Delete a blog article by id. Returns True on success."""
    blog_id = resolve_blog_id(blog_handle)
    _req("DELETE", f"blogs/{blog_id}/articles/{article_id}.json")
    return True


# ---------------------------------------------------------------------------
# Tool handlers  (signature: (args, **kw) -> str  returning a JSON string)
# ---------------------------------------------------------------------------


def _handle_create_blog_post(args: dict, **kw) -> str:
    """Handler for create_shopify_blog_post tool."""
    blog = (args.get("blog") or "").strip()
    title = (args.get("title") or "").strip()
    body_html = args.get("body_html") or ""
    if not blog:
        return tool_error("Missing required parameter: blog (blog handle)")
    if not title:
        return tool_error("Missing required parameter: title")
    if not body_html:
        return tool_error("Missing required parameter: body_html")

    tags = args.get("tags", "") or ""
    author = args.get("author") or None
    summary_html = args.get("summary_html") or None
    published = bool(args.get("published", False))
    image_path = args.get("image_path") or None
    image_src = args.get("image_src") or None
    image_alt = args.get("image_alt") or None

    try:
        result = create_blog_post(
            blog,
            title,
            body_html,
            tags=tags,
            author=author,
            summary_html=summary_html,
            published=published,
            image_path=image_path,
            image_src=image_src,
            image_alt=image_alt,
        )
        return json.dumps({"result": result})
    except Exception as e:
        logger.error("create_shopify_blog_post error: %s", e)
        return tool_error(f"Failed to create blog post: {e}")


def _handle_resolve_blog_id(args: dict, **kw) -> str:
    """Handler for resolve_shopify_blog_id tool."""
    blog = (args.get("blog") or "").strip()
    if not blog:
        return tool_error("Missing required parameter: blog (blog handle)")
    try:
        blog_id = resolve_blog_id(blog)
        return json.dumps({"result": {"handle": blog, "id": blog_id}})
    except Exception as e:
        logger.error("resolve_shopify_blog_id error: %s", e)
        return tool_error(f"Failed to resolve blog id: {e}")


def _handle_delete_blog_post(args: dict, **kw) -> str:
    """Handler for delete_shopify_blog_post tool."""
    blog = (args.get("blog") or "").strip()
    article_id = args.get("article_id")
    if not blog:
        return tool_error("Missing required parameter: blog (blog handle)")
    if not article_id:
        return tool_error("Missing required parameter: article_id")
    try:
        delete_blog_post(blog, article_id)
        return json.dumps({"result": {"deleted": True, "article_id": article_id}})
    except Exception as e:
        logger.error("delete_shopify_blog_post error: %s", e)
        return tool_error(f"Failed to delete blog post: {e}")


# ---------------------------------------------------------------------------
# Availability check
# ---------------------------------------------------------------------------


def _check_shopify_available() -> bool:
    """Tools are available when a store is connected via the dashboard OR the
    SHOPIFY_SHOP + SHOPIFY_ACCESS_TOKEN env vars are set."""
    return _resolve_creds() is not None


# ---------------------------------------------------------------------------
# Tool schemas
# ---------------------------------------------------------------------------

CREATE_SHOPIFY_BLOG_POST_SCHEMA = {
    "name": "create_shopify_blog_post",
    "description": (
        "Create a blog post (article) on the connected Shopify store. "
        "By default the post is created as an UNPUBLISHED DRAFT (published=false) "
        "so it is not visible on the storefront until a human publishes it. "
        "Returns the article id and an admin_url to review/publish it."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "blog": {
                "type": "string",
                "description": (
                    "The blog handle to post to (e.g. 'yes-blog'). Use "
                    "resolve_shopify_blog_id to discover available blogs if unsure."
                ),
            },
            "title": {
                "type": "string",
                "description": "The article title (plain text).",
            },
            "body_html": {
                "type": "string",
                "description": (
                    "The article body as HTML (e.g. '<p>...</p><h2>...</h2>'). "
                    "Use semantic HTML; this is rendered directly on the blog."
                ),
            },
            "tags": {
                "type": "string",
                "description": (
                    "Optional comma-separated tags (e.g. 'cacao, rituals, sourcing'). "
                    "Omit or leave empty for no tags."
                ),
            },
            "author": {
                "type": "string",
                "description": "Optional author name to attribute the post to.",
            },
            "summary_html": {
                "type": "string",
                "description": (
                    "Optional short HTML excerpt/summary shown in blog listings."
                ),
            },
            "published": {
                "type": "boolean",
                "description": (
                    "Whether to publish immediately. Defaults to false (DRAFT). "
                    "Leave false unless explicitly instructed to publish live."
                ),
            },
            "image_path": {
                "type": "string",
                "description": (
                    "Optional local image file path to attach as the post's "
                    "featured image (e.g. the PNG path returned by the "
                    "image_generate tool). The file is read and uploaded."
                ),
            },
            "image_src": {
                "type": "string",
                "description": (
                    "Optional public image URL for the featured image "
                    "(alternative to image_path)."
                ),
            },
            "image_alt": {
                "type": "string",
                "description": "Optional alt text for the featured image; defaults to the title.",
            },
        },
        "required": ["blog", "title", "body_html"],
    },
}

RESOLVE_SHOPIFY_BLOG_ID_SCHEMA = {
    "name": "resolve_shopify_blog_id",
    "description": (
        "Resolve a Shopify blog handle (e.g. 'yes-blog') to its numeric blog id. "
        "Useful to confirm a blog exists before creating a post."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "blog": {
                "type": "string",
                "description": "The blog handle to resolve (e.g. 'yes-blog').",
            },
        },
        "required": ["blog"],
    },
}

DELETE_SHOPIFY_BLOG_POST_SCHEMA = {
    "name": "delete_shopify_blog_post",
    "description": (
        "Delete a blog post (article) from the Shopify store by its numeric "
        "article id. Use with care — this permanently removes the article."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "blog": {
                "type": "string",
                "description": "The blog handle the article belongs to (e.g. 'yes-blog').",
            },
            "article_id": {
                "type": "integer",
                "description": "The numeric id of the article to delete.",
            },
        },
        "required": ["blog", "article_id"],
    },
}


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------

from tools.registry import registry, tool_error

registry.register(
    name="create_shopify_blog_post",
    toolset="shopify",
    schema=CREATE_SHOPIFY_BLOG_POST_SCHEMA,
    handler=_handle_create_blog_post,
    check_fn=_check_shopify_available,
    requires_env=["SHOPIFY_SHOP", "SHOPIFY_ACCESS_TOKEN"],
    emoji="🛍️",
)

registry.register(
    name="resolve_shopify_blog_id",
    toolset="shopify",
    schema=RESOLVE_SHOPIFY_BLOG_ID_SCHEMA,
    handler=_handle_resolve_blog_id,
    check_fn=_check_shopify_available,
    requires_env=["SHOPIFY_SHOP", "SHOPIFY_ACCESS_TOKEN"],
    emoji="🛍️",
)

registry.register(
    name="delete_shopify_blog_post",
    toolset="shopify",
    schema=DELETE_SHOPIFY_BLOG_POST_SCHEMA,
    handler=_handle_delete_blog_post,
    check_fn=_check_shopify_available,
    requires_env=["SHOPIFY_SHOP", "SHOPIFY_ACCESS_TOKEN"],
    emoji="🛍️",
)
