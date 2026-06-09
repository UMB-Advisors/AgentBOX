#!/usr/bin/env python3
"""Pre-run injector for the YES! daily blog-draft cron job (Phase 3).

The cron scheduler runs this BEFORE the 09:00 draft agent and prepends its
stdout to the prompt as "## Script Output". It surfaces two deterministic things:

1. The **house-style digest** — editorial rules the 08:00 learn-from-published
   job distilled from how the human editor revised earlier AI drafts.
2. **Anti-repetition context** — the recent post titles plus a hard directive to
   rotate theme + format, so the daily job stops converging on the same
   summer/cacao-ritual angle every day.

Recent titles come from the live Shopify blog (the source of truth for what's
published), falling back to the local provenance records. Available because the
venv's editable install puts ``tools`` on the path even for a bare script run;
everything is best-effort so a failure never blocks the draft.

Deployed to ``$HERMES_HOME/scripts/``. Must ALWAYS print something — empty stdout
makes the scheduler skip the draft entirely.
"""

import os
from pathlib import Path

BLOG_HANDLE = "yes-blog"

THEMES = [
    "product education",
    "ingredient & cacao science",
    "functional benefits (focus / mood / energy)",
    "recipes & rituals",
    "sourcing & sustainability",
    "brand & founder story",
    "customer & occasion stories",
    "comparisons & buying guides",
]
FORMATS = [
    "how-to",
    "listicle",
    "deep-dive explainer",
    "myth-busting Q&A",
    "founder note",
    "comparison / buying guide",
    "customer story",
]


def _hermes_home() -> Path:
    return Path(os.getenv("HERMES_HOME") or (Path.home() / ".hermes"))


def _recent_titles(limit: int = 12):
    """Recent YES! blog post titles, newest first. Live Shopify first, then
    local provenance. Best-effort — returns [] on any failure."""
    # 1) Live Shopify (what's actually published / drafted)
    try:
        from tools.shopify_tools import resolve_blog_id, _req

        bid = resolve_blog_id(BLOG_HANDLE)
        arts = _req(
            "GET",
            f"blogs/{bid}/articles.json?limit={limit}&fields=title,created_at",
        ).get("articles", [])
        titles = [a.get("title", "").strip() for a in arts if a.get("title")]
        if titles:
            return titles[:limit]
    except Exception:
        pass
    # 2) Fallback: local provenance records (the AI's own drafts)
    try:
        import json

        d = _hermes_home() / "blog_learning" / "drafts"
        if d.exists():
            recs = []
            for p in d.glob("*.json"):
                try:
                    recs.append(json.loads(p.read_text(encoding="utf-8")))
                except Exception:
                    continue
            recs.sort(key=lambda r: r.get("created_at", ""), reverse=True)
            return [
                r.get("original_title", "").strip()
                for r in recs[:limit]
                if r.get("original_title")
            ]
    except Exception:
        pass
    return []


def main() -> int:
    home = _hermes_home()

    # --- House style ---
    print(
        "YES! HOUSE-STYLE RULES — learned from how the human editor revised "
        "earlier AI blog drafts. Apply ALL of these; where they conflict with "
        "generic guidance, these win.\n"
    )
    digest = home / "blog_learning" / "house-style.md"
    text = ""
    if digest.exists():
        try:
            text = digest.read_text(encoding="utf-8").strip()
        except OSError:
            text = ""
    print(
        text
        or "(No editorial lessons recorded yet — follow the brand skill and the "
        "YES! brand rules as usual.)"
    )
    print()

    # --- Anti-repetition + rotation (the fix for samey posts) ---
    recent = _recent_titles()
    print("## ANTI-REPETITION — do NOT repeat recent posts (critical)")
    print(
        "The recent YES! blog posts are listed below. Do NOT write another post "
        "on the same topic, angle, or seasonal hook as any of them. In "
        "particular, do NOT write yet another summer / cacao-ritual / cooler / "
        "solstice post — that ground is covered. Pick a clearly DISTINCT topic.\n"
    )
    print("Rotate the THEME — choose one NOT represented in the recent posts:")
    print("  " + "; ".join(THEMES))
    print("Vary the FORMAT — don't default to a ritual/recipe every time:")
    print("  " + "; ".join(FORMATS))
    print()
    if recent:
        print("Recently published (avoid these topics/angles):")
        for title in recent:
            print(f"  - {title}")
    else:
        print(
            "(No recent posts retrieved — still pick a varied theme + format, "
            "not a generic seasonal ritual.)"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
