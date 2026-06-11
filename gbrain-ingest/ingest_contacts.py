#!/usr/bin/env python3
"""Ingest CRM contacts (mailbox.crm_contacts) into gbrain entity sources.

One page per contact, written into the contact's entity source
(company -> entity via entity_map companies; unresolved -> unsorted).
Page bodies lead with plain fact sentences ("<name> works at <company>",
"Email <e> belongs to <name>") so gbrain's fact extraction has clean
input. NOTE: no visibility frontmatter is written — gbrain (<= 0.41.x)
ignores page-frontmatter visibility and facts extracted from pages
default to 'private' (only the extract_facts op param can set 'world').

Idempotent: stable slug contacts/<id>-<name>; gbrain capture routes to
put_page which upserts by slug.

Usage:
  python3 ingest_contacts.py [--limit N] [--dry-run] [--entity-map PATH]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import common
from attribution import UNSORTED, resolve_company


def fetch_contacts(limit: int | None) -> list[dict]:
    lim = f" LIMIT {int(limit)}" if limit else ""
    sql = (
        "SELECT json_agg(t) FROM ("
        "  SELECT id, name, company, phones, emails, socials, tags, notes,"
        "         source, external_id, updated_at"
        "  FROM mailbox.crm_contacts ORDER BY id" + lim +
        ") t;"
    )
    return common.psql_json(sql)


def jsonb_values(field, key_candidates=("value", "email", "phone", "url")) -> list[str]:
    """crm jsonb[] columns hold lists of objects or strings; flatten to strings."""
    out: list[str] = []
    items = field or []
    if isinstance(items, str):
        try:
            items = json.loads(items)
        except ValueError:
            return [items]
    for item in items if isinstance(items, list) else []:
        if isinstance(item, str):
            out.append(item)
        elif isinstance(item, dict):
            for k in key_candidates:
                if item.get(k):
                    out.append(str(item[k]))
                    break
    return out


def build_page(contact: dict, entity: str) -> tuple[str, str]:
    name = (contact.get("name") or "").strip() or f"contact-{contact['id']}"
    company = (contact.get("company") or "").strip()
    emails = jsonb_values(contact.get("emails"))
    phones = jsonb_values(contact.get("phones"))
    socials = jsonb_values(contact.get("socials"))
    notes = (contact.get("notes") or "").strip()

    slug = f"contacts/{contact['id']}-{common.slugify(name)}"

    facts = []
    if company:
        facts.append(f"{name} works at {company}.")
    for e in emails:
        facts.append(f"Email {e} belongs to {name}.")
    for p in phones:
        facts.append(f"Phone {p} belongs to {name}.")

    body_lines = [f"# {name}", ""]
    if facts:
        body_lines += facts + [""]
    if socials:
        body_lines += ["Social: " + ", ".join(socials), ""]
    if notes:
        body_lines += ["## Notes", "", notes, ""]

    frontmatter = {
        "title": name,
        "type": "contact",
        "entity": entity,
        "company": company or None,
        "emails": emails or None,
        "crm_id": contact["id"],
        "crm_source": contact.get("source"),
        "tags": ["contact", "crm", f"entity:{entity}"],
    }
    frontmatter = {k: v for k, v in frontmatter.items() if v is not None}
    return slug, common.render_page(frontmatter, "\n".join(body_lines))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--limit", type=int, default=None, help="max contacts to ingest")
    ap.add_argument("--dry-run", action="store_true", help="print plan, write nothing")
    ap.add_argument("--entity-map", default=None, help="path to entity_map.yaml")
    args = ap.parse_args()

    emap = common.load_entity_map(args.entity_map)
    company_map = emap["companies"]

    contacts = fetch_contacts(args.limit)
    common.log(f"fetched {len(contacts)} contacts")

    counts: dict[str, int] = {}
    written = errors = 0
    for contact in contacts:
        entity = resolve_company(contact.get("company"), company_map) or UNSORTED
        if entity not in emap["entities"]:
            entity = UNSORTED
        slug, content = build_page(contact, entity)
        counts[entity] = counts.get(entity, 0) + 1
        if args.dry_run:
            print(f"DRY {entity:10s} {slug}")
            continue
        try:
            common.gbrain_capture(entity, slug, content, page_type="contact")
            written += 1
        except RuntimeError as exc:
            errors += 1
            common.log(f"ERROR {slug}: {exc}")

    common.log(f"done: written={written} errors={errors} by_entity={counts}")
    return 1 if errors and not written else 0


if __name__ == "__main__":
    sys.exit(main())
