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

Re-attribution (--re-attribute, Phase 5): for each contact whose page sits
in 'unsorted' (company unresolved), look at the mailbox correspondence its
email addresses appear in (sender OR participant). Every matching message
is attributed through the deterministic ladder rungs (account/domain — no
LLM, no CRM rung: an unsorted contact has no resolvable company anyway);
if exactly ONE entity remains above the confidence floor, the contact page
is rewritten into that entity source (put_page upsert under the same slug)
and the old 'unsorted' page is soft-deleted (recoverable 72h). Ambiguous
(multi-entity) or signal-less contacts stay in unsorted. Inference rule:
attribution.infer_reattribution_entity (pure, unit-tested).

Durability: every successful move is recorded in a ledger
(STATE_DIR/contacts-reattributed.json, crm_id -> entity). Both paths route
through route_entity(), which consults the ledger, so:
  - the daily regular ingest re-captures a moved contact into its NEW
    entity source (page stays fresh) instead of resurrecting it in
    'unsorted';
  - --re-attribute skips already-moved contacts (idempotent re-runs, no
    re-delete of an already-soft-deleted unsorted page).
An explicit CRM company resolution always outranks the ledger. A move is
recorded only after capture AND delete both succeed; a failed delete is
retried on the next --re-attribute run (delete tolerates the page already
being absent).

Usage:
  python3 ingest_contacts.py [--limit N] [--dry-run] [--entity-map PATH]
  python3 ingest_contacts.py --re-attribute [--limit N] [--dry-run]
                             [--entity-map PATH]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import common
from attribution import (
    UNSORTED,
    attribute,
    extract_emails,
    infer_reattribution_entity,
    resolve_company,
)


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
    # CRM notes are free text — scrub credential-shaped strings before capture.
    notes = common.redact_secrets((contact.get("notes") or "").strip())

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


# ------------------------------------------------------------------ routing

# Durable ledger of contacts moved out of 'unsorted' by --re-attribute:
# {"<crm_id>": "<entity>"}. Lives in STATE_DIR next to the ingest watermarks.
REATTRIBUTED_STATE = "contacts-reattributed.json"


def load_reattributed() -> dict[str, str]:
    state = common.read_state_json(REATTRIBUTED_STATE)
    return dict(state) if isinstance(state, dict) else {}


def record_reattributed(moves: dict[str, str]) -> None:
    common.write_state_json(REATTRIBUTED_STATE, moves)


def route_entity(contact: dict, company_map: dict, entities,
                 reattributed: dict[str, str]) -> str:
    """Single routing rule shared by the regular ingest and --re-attribute.

    CRM company resolution wins. For company-unresolved contacts, a durable
    re-attribution ledger entry routes the page to its moved-to entity so
    the daily ingest cannot resurrect it in 'unsorted'. Anything else lands
    in 'unsorted'."""
    entity = resolve_company(contact.get("company"), company_map) or UNSORTED
    if entity not in entities:
        entity = UNSORTED
    if entity == UNSORTED:
        override = reattributed.get(str(contact["id"]))
        if override and override != UNSORTED and override in entities:
            return override
    return entity


# --------------------------------------------------------------- re-attribute

# Cap correspondence scanned per address — enough for a clear signal without
# dragging a whole mailbox through json_agg on the 8GB box.
MESSAGES_PER_ADDRESS = 200


def fetch_messages_for_address(email: str, limit: int = MESSAGES_PER_ADDRESS) -> list[dict]:
    """Mailbox messages where the address appears as sender or participant.

    The address is matched as an ESCAPE'd ILIKE substring (sql_quote_like
    contains=True) so a ``%`` / ``_`` in the local-part stays literal — an
    attacker-controlled email can no longer widen the scan. ``matched_role``
    tells the caller whether the address appeared as the (spoofable) sender or
    as a recipient, so re-attribution can refuse to trust the From header
    alone (see SECURITY note in correspondence_attributions)."""
    pat = common.sql_quote_like(email, contains=True)
    sql = (
        "SELECT json_agg(t) FROM ("
        "  SELECT m.from_addr, m.to_addr, m.subject, m.snippet,"
        "         a.email_address AS account_email,"
        f"         (m.from_addr ILIKE {pat}) AS is_sender,"
        f"         (m.to_addr ILIKE {pat})   AS is_recipient"
        "  FROM mailbox.inbox_messages m"
        "  JOIN mailbox.accounts a ON a.id = m.account_id"
        f"  WHERE m.from_addr ILIKE {pat} OR m.to_addr ILIKE {pat}"
        "  ORDER BY m.received_at DESC"
        f"  LIMIT {int(limit)}"
        ") t;"
    )
    return common.psql_json(sql)


def _attr_entity(a) -> str | None:
    """Entity of an Attribution, accepting objects or (entity, confidence) tuples."""
    if isinstance(a, tuple):
        return a[0] if a else None
    return getattr(a, "entity", None)


def correspondence_attributions(emails: list[str], ladder_kwargs: dict) -> tuple[list, bool]:
    """Attribute every mailbox message any of the contact's addresses appears
    in. Deterministic rungs only (account provenance / domain): no LLM and no
    CRM lookup — re-attribution targets contacts whose company did NOT
    resolve, and a low-confidence classifier guess must never move a contact
    between entity boundaries.

    Returns (attributions, had_recipient_evidence). ``had_recipient_evidence``
    is True iff the contact appeared as an actual RECIPIENT on at least one
    received message — much harder to forge than a From header, which any
    sender can spoof. Callers use it to flag sender-only (spoofable) evidence
    for human review; see SECURITY note in run_reattribute."""
    out = []
    had_recipient = False
    for email in emails:
        for m in fetch_messages_for_address(email):
            if m.get("is_recipient"):
                had_recipient = True
            sender = next(iter(extract_emails(m.get("from_addr"))), None)
            participants = extract_emails(m.get("from_addr")) + extract_emails(m.get("to_addr"))
            out.append(attribute(
                m.get("account_email"), sender, participants,
                m.get("subject"), m.get("snippet"),
                crm_lookup=None, llm_classify_fn=None, **ladder_kwargs,
            ))
    return out, had_recipient


def run_reattribute(args, emap: dict) -> int:
    """Move unsorted contact pages whose correspondence pins ONE entity.

    SECURITY: re-attribution evidence comes from received mail, whose From
    header is attacker-spoofable — anyone who can mail one of the monitored
    inboxes can fabricate a sender-only signal pinning a contact to a chosen
    entity, which then flavours any cron job bound to that entity. Two guards:
    (1) moves NEVER execute without an explicit ``--confirm`` (so the daily
    timer / any unattended run only ever reports a plan), and (2) proposed
    moves backed only by sender-role mail are flagged ``[sender-only]`` so the
    human reviewer can distinguish them from the harder-to-forge recipient
    evidence."""
    company_map = emap["companies"]
    ladder = common.ladder_kwargs(emap)
    moves = load_reattributed()

    execute = bool(getattr(args, "confirm", False)) and not args.dry_run
    if not execute:
        common.log("re-attribute: REPORT-ONLY (no moves) — pass --confirm to execute")

    contacts = fetch_contacts(args.limit)
    # route_entity consults the ledger: contacts already moved route to their
    # entity, so they are never re-processed (idempotent re-runs).
    unsorted_contacts = [
        c for c in contacts
        if route_entity(c, company_map, emap["entities"], moves) == UNSORTED
    ]
    common.log(f"contacts in unsorted: {len(unsorted_contacts)} of {len(contacts)}")

    moved = ambiguous = no_signal = errors = 0
    for contact in unsorted_contacts:
        emails = [e.lower() for e in jsonb_values(contact.get("emails"))]
        if not emails:
            no_signal += 1
            continue
        attributions, had_recipient = correspondence_attributions(emails, ladder)
        target = infer_reattribution_entity(attributions)
        if target is None or target not in emap["entities"] or target == UNSORTED:
            if any(_attr_entity(a) not in (None, UNSORTED) for a in attributions):
                ambiguous += 1
            else:
                no_signal += 1
            continue
        slug, content = build_page(contact, target)
        flag = "" if had_recipient else " [sender-only: spoofable, review]"
        if not execute:
            print(f"PROPOSE move {UNSORTED} -> {target:10s} {slug}{flag}")
            moved += 1
            continue
        try:
            # New page first, soft-delete second: a failed delete leaves a
            # recoverable duplicate, never a lost contact. missing_ok: a
            # retried move (prior run captured but failed before recording)
            # may find the unsorted page already gone.
            common.gbrain_capture(target, slug, content, page_type="contact")
            common.gbrain_delete(UNSORTED, slug, missing_ok=True)
            # Record only after BOTH ops succeed; persist per move so a
            # crash mid-run never forgets a completed move.
            moves[str(contact["id"])] = target
            record_reattributed(moves)
            moved += 1
            common.log(f"moved {slug}: {UNSORTED} -> {target}")
        except RuntimeError as exc:
            errors += 1
            common.log(f"ERROR {slug}: {exc}")

    verb = "moved" if execute else "proposed"
    common.log(
        f"re-attribute done: {verb}={moved} ambiguous={ambiguous} "
        f"no_signal={no_signal} errors={errors}"
    )
    return 1 if errors and not moved else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--limit", type=int, default=None, help="max contacts to ingest")
    ap.add_argument("--dry-run", action="store_true", help="print plan, write nothing")
    ap.add_argument("--entity-map", default=None, help="path to entity_map.yaml")
    ap.add_argument("--re-attribute", action="store_true",
                    help="report (or with --confirm, move) unsorted contact "
                         "pages whose mailbox correspondence resolves to "
                         "exactly one entity")
    ap.add_argument("--confirm", action="store_true",
                    help="actually execute --re-attribute moves; without it "
                         "re-attribution is report-only (moves rely on "
                         "spoofable From headers, so unattended runs never "
                         "mutate the brain)")
    args = ap.parse_args()

    emap = common.load_entity_map(args.entity_map)
    if args.re_attribute:
        return run_reattribute(args, emap)
    company_map = emap["companies"]
    reattributed = load_reattributed()

    contacts = fetch_contacts(args.limit)
    common.log(f"fetched {len(contacts)} contacts")

    counts: dict[str, int] = {}
    written = errors = 0
    for contact in contacts:
        entity = route_entity(contact, company_map, emap["entities"], reattributed)
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
