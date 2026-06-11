"""Entity attribution ladder (pure logic, no I/O).

Resolves which entity source a piece of inbound data (email thread, contact,
drive doc) belongs to. Five rungs, first match wins:

  1. Account provenance  - the connected account is entity-owned
                           (heronlabsinc -> heron, umbadvisors -> umb).
  2. CRM contact match   - a participant email is a known CRM contact whose
                           company maps to an entity.
  3. Domain heuristics   - a participant email domain maps to an entity.
  4. LLM classifier      - local qwen3 call over subject+snippet; accepted
                           only above the configured confidence threshold.
  5. Default             - per-account default (consultingfutures -> personal),
                           otherwise unsorted.

The core function takes plain dicts and callables so it is unit-testable with
no YAML, network, or DB dependencies. I/O (CRM lookups, ollama calls) is
injected by the ingest scripts.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable, Iterable, Mapping, Optional, Sequence, Tuple

UNSORTED = "unsorted"

# Rung labels, indexed by rung number (1-based).
RUNG_NAMES = {
    1: "account",
    2: "crm",
    3: "domain",
    4: "classifier",
    5: "default",
}


@dataclass(frozen=True)
class Attribution:
    entity: str
    confidence: float
    rung: int

    @property
    def rung_name(self) -> str:
        return RUNG_NAMES.get(self.rung, "unknown")


_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
_COMPANY_STRIP_RE = re.compile(r"[^a-z0-9!& ]+")
_WS_RE = re.compile(r"\s+")


def extract_emails(text: Optional[str]) -> list[str]:
    """Pull bare lowercase email addresses out of a header-ish string."""
    if not text:
        return []
    return [m.lower() for m in _EMAIL_RE.findall(text)]


def email_domain(email: Optional[str]) -> Optional[str]:
    if not email or "@" not in email:
        return None
    return email.rsplit("@", 1)[1].lower().strip().strip(">").strip() or None


def normalize_company(name: Optional[str]) -> str:
    """Normalize a CRM company string for map lookup.

    Lowercase, collapse whitespace, strip punctuation except '!' and '&'
    (so 'YES! Cacao' survives as 'yes! cacao'), drop common suffixes.
    """
    if not name:
        return ""
    s = name.lower().strip()
    s = _COMPANY_STRIP_RE.sub(" ", s)
    s = _WS_RE.sub(" ", s).strip()
    for suffix in (" inc", " llc", " ltd", " co", " corp", " corporation", " company"):
        if s.endswith(suffix) and s != suffix.strip():
            stripped = s[: -len(suffix)].strip()
            # keep both forms resolvable: caller maps should include the
            # canonical short form; we return the stripped one only if the
            # full form isn't expected to match anyway.
            s = stripped
            break
    return s


def resolve_company(company: Optional[str], company_map: Mapping[str, str]) -> Optional[str]:
    """Map a raw CRM company string to an entity slug, or None."""
    if not company:
        return None
    raw = company.lower().strip()
    if raw in company_map:
        return company_map[raw]
    norm = normalize_company(company)
    if norm and norm in company_map:
        return company_map[norm]
    return None


def attribute(
    account_email: Optional[str],
    sender_email: Optional[str],
    participants: Sequence[str],
    subject: Optional[str],
    snippet: Optional[str],
    *,
    account_map: Mapping[str, str],
    account_defaults: Mapping[str, str],
    domain_map: Mapping[str, str],
    company_map: Mapping[str, str],
    generic_domains: Iterable[str] = (),
    valid_entities: Optional[Iterable[str]] = None,
    crm_lookup: Optional[Callable[[str], Optional[str]]] = None,
    llm_classify_fn: Optional[Callable[[str, str], Optional[Tuple[str, float]]]] = None,
    classifier_threshold: float = 0.6,
) -> Attribution:
    """Run the 5-rung attribution ladder. Pure: all I/O is injected.

    crm_lookup(email) -> raw company name or None.
    llm_classify_fn(subject, snippet) -> (entity_slug, confidence) or None.
    """
    valid = set(valid_entities) if valid_entities is not None else None

    def ok(slug: Optional[str]) -> bool:
        return bool(slug) and (valid is None or slug in valid)

    acct = (account_email or "").lower().strip()

    # Rung 1: account provenance.
    slug = account_map.get(acct)
    if ok(slug):
        return Attribution(slug, 1.0, 1)

    # Candidate emails: sender first, then other participants, deduped.
    emails: list[str] = []
    for e in [sender_email, *participants]:
        if not e:
            continue
        for addr in extract_emails(e) or ([e.lower()] if "@" in e else []):
            if addr != acct and addr not in emails:
                emails.append(addr)

    # Rung 2: CRM contact email -> company -> entity.
    if crm_lookup is not None:
        for e in emails:
            company = crm_lookup(e)
            if company:
                slug = resolve_company(company, company_map)
                if ok(slug):
                    return Attribution(slug, 0.95, 2)

    # Rung 3: domain heuristics.
    generic = {d.lower() for d in generic_domains}
    for e in emails:
        dom = email_domain(e)
        if not dom or dom in generic:
            continue
        slug = domain_map.get(dom)
        if ok(slug):
            return Attribution(slug, 0.9, 3)

    # Rung 4: LLM classifier (gated by confidence threshold).
    if llm_classify_fn is not None:
        result = llm_classify_fn(subject or "", snippet or "")
        if result:
            slug, conf = result
            if ok(slug) and slug != UNSORTED and conf >= classifier_threshold:
                return Attribution(slug, float(conf), 4)

    # Rung 5: per-account default, else unsorted.
    default = account_defaults.get(acct)
    if ok(default):
        return Attribution(default, 0.3, 5)
    return Attribution(UNSORTED, 0.0, 5)
