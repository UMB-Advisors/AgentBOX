"""Google People (Contacts) → CRM import for the dashboard Contacts tab.

Reads the operator's Google Contacts from each connected account (People API,
``contacts.readonly`` — already in the connect scope set) and upserts them into
the mailbox-dashboard CRM (``mailbox.crm_contacts``) tagged ``source='google'``
with a stable ``external_id`` so re-imports UPDATE rather than duplicate.

Why write via ``docker exec psql`` instead of the CRM HTTP API: the CRM's POST
route strips ``source``/``external_id`` and plain-inserts (no upsert), the
mailbox Postgres isn't published to the host (internal docker network only), and
mailbox-dashboard is a baked production image (editing it needs a rebuild). The
box already applies migrations via ``docker exec mailbox-postgres-1 psql`` — we
reuse that. The contact JSON is embedded as ONE standard SQL string literal
(``standard_conforming_strings`` is on by default, so only ``'`` needs doubling)
and the values come from the operator's own Google account.
"""

from __future__ import annotations

import json
import logging
import subprocess
from typing import Any, Dict, List, Optional

_log = logging.getLogger(__name__)

_PG_CONTAINER = "mailbox-postgres-1"
_PERSON_FIELDS = "names,emailAddresses,phoneNumbers,organizations,urls,metadata"


def _people_service(creds):
    try:
        from googleapiclient.discovery import build

        return build("people", "v1", credentials=creds, cache_discovery=False)
    except Exception:  # noqa: BLE001
        _log.warning("people: failed to build service", exc_info=True)
        return None


def _hint(exc: Exception) -> str:
    t = str(exc)
    low = t.lower()
    if "insufficient" in low or "ACCESS_TOKEN_SCOPE_INSUFFICIENT" in t or "insufficientpermissions" in low:
        return "Google connected, but the Contacts scope isn't granted — reconnect the account."
    if "invalid_grant" in low:
        return "Google token expired — reconnect the account."
    if "has not been used" in low or "is disabled" in low or "accessnotconfigured" in low:
        return "Enable the Google People API for the project, then retry."
    return "Couldn't reach Google Contacts."


def _map_person(person: Dict[str, Any], account: str) -> Optional[Dict[str, Any]]:
    rn = person.get("resourceName") or ""
    if not rn:
        return None
    names = person.get("names") or []
    name = ""
    if names:
        n0 = names[0]
        name = (n0.get("displayName") or "").strip()
        if not name:
            name = " ".join(
                p for p in (n0.get("givenName"), n0.get("familyName")) if p
            ).strip()
    # Skip name-less contacts (operator preference). A Google contact with no
    # real name — only a phone or email — would otherwise import with the
    # number/address as its display name, cluttering the CRM. No phone/email
    # fallback: no name → not imported.
    if not name:
        return None
    emails = [e.get("value") for e in (person.get("emailAddresses") or []) if e.get("value")]
    phones = [p.get("value") for p in (person.get("phoneNumbers") or []) if p.get("value")]
    orgs = person.get("organizations") or []
    company = (orgs[0].get("name") if orgs else "") or ""
    title = (orgs[0].get("title") if orgs else "") or ""
    socials: List[Dict[str, str]] = []
    for u in person.get("urls") or []:
        val = u.get("value")
        if val:
            socials.append({"platform": (u.get("type") or "website"), "handle": val})
    return {
        "name": name,
        "company": company,
        "phones": phones,
        "emails": emails,
        "socials": socials,
        "notes": title,
        "external_id": f"{account}:{rn}",
    }


def _people_for(creds, account: str, cap: int = 2000) -> Dict[str, Any]:
    service = _people_service(creds)
    if service is None:
        return {"contacts": [], "error": None}
    out: List[Dict[str, Any]] = []
    try:
        token = None
        while len(out) < cap:
            resp = (
                service.people()
                .connections()
                .list(
                    resourceName="people/me",
                    personFields=_PERSON_FIELDS,
                    pageSize=200,
                    pageToken=token,
                    sortOrder="LAST_MODIFIED_DESCENDING",
                )
                .execute()
            )
            for person in resp.get("connections", []):
                m = _map_person(person, account)
                if m:
                    out.append(m)
            token = resp.get("nextPageToken")
            if not token:
                break
        return {"contacts": out, "error": None}
    except Exception as exc:  # noqa: BLE001
        _log.warning("people: fetch failed for %s", account, exc_info=True)
        return {"contacts": out, "error": _hint(exc)}


def _upsert(rows: List[Dict[str, Any]]) -> Dict[str, int]:
    """Upsert rows into mailbox.crm_contacts via ``docker exec psql``. Returns
    {imported, updated} using the ``xmax = 0`` insert-vs-update idiom."""
    if not rows:
        return {"imported": 0, "updated": 0}
    payload = json.dumps(rows).replace("'", "''")
    sql = (
        "WITH data AS (SELECT * FROM jsonb_to_recordset('"
        + payload
        + "'::jsonb) AS x(name text, company text, phones jsonb, emails jsonb, "
        "socials jsonb, notes text, external_id text)), "
        "up AS (INSERT INTO mailbox.crm_contacts "
        "(name, company, phones, emails, socials, tags, notes, source, external_id, created_at, updated_at) "
        "SELECT coalesce(nullif(name,''),'(unnamed)'), coalesce(company,''), "
        "coalesce(phones,'[]'::jsonb), coalesce(emails,'[]'::jsonb), "
        "coalesce(socials,'[]'::jsonb), '[]'::jsonb, coalesce(notes,''), "
        "'google', external_id, now(), now() FROM data "
        "ON CONFLICT (source, external_id) WHERE external_id IS NOT NULL "
        "DO UPDATE SET name=EXCLUDED.name, company=EXCLUDED.company, "
        "phones=EXCLUDED.phones, emails=EXCLUDED.emails, socials=EXCLUDED.socials, "
        "notes=EXCLUDED.notes, updated_at=now() "
        "RETURNING (xmax = 0) AS inserted) "
        "SELECT count(*) FILTER (WHERE inserted), count(*) FILTER (WHERE NOT inserted) FROM up;"
    )
    proc = subprocess.run(
        [
            "docker", "exec", "-i", _PG_CONTAINER,
            "psql", "-U", "mailbox", "-d", "mailbox",
            "-v", "ON_ERROR_STOP=1", "-tA", "-F", "|",
        ],
        input=sql,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"psql upsert failed: {(proc.stderr or '').strip()[:300]}")
    lines = [ln for ln in (proc.stdout or "").splitlines() if ln.strip()]
    parts = (lines[-1] if lines else "0|0").split("|")
    return {
        "imported": int(parts[0] or 0),
        "updated": int(parts[1] or 0) if len(parts) > 1 else 0,
    }


def import_contacts(account: Optional[str] = None) -> Dict[str, Any]:
    """Pull Google Contacts from one or all connected accounts and upsert them
    into the CRM. ``account`` None/"combined"/"all" = every connected account."""
    from hermes_cli import google_accounts

    pairs = google_accounts.all_credentials()
    emails = [e for e, _ in pairs]
    if not pairs:
        return {
            "connected": False, "accounts": [], "selected": "combined",
            "imported": 0, "updated": 0, "fetched": 0, "by_account": {}, "error": None,
        }
    sel = (account or "").strip().lower()
    combined = sel in ("", "combined", "all")
    chosen = pairs if combined else [(e, c) for e, c in pairs if e.lower() == sel]
    rows: List[Dict[str, Any]] = []
    by_account: Dict[str, int] = {}
    errs: List[str] = []
    for email, creds in chosen:
        r = _people_for(creds, email)
        by_account[email] = len(r["contacts"])
        rows.extend(r["contacts"])
        if r["error"]:
            errs.append(f"{email}: {r['error']}")
    counts = _upsert(rows)
    return {
        "connected": True,
        "accounts": emails,
        "selected": "combined" if combined else account,
        "imported": counts["imported"],
        "updated": counts["updated"],
        "fetched": len(rows),
        "by_account": by_account,
        "error": "; ".join(errs) or None,
    }
