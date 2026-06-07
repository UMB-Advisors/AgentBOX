// dashboard/lib/rag/scrub.ts
//
// STAQPRO-193 — PII scrub applied to embedding inputs before they reach
// Qdrant. Scope decision (locked in the discuss-phase comment, Locked
// Decision #4):
//
//   Scrubbed:    US phone, SSN, credit-card-ish 16-digit
//   Kept:        email addresses, URLs, names
//
// Rationale: emails + URLs are legitimate relationship-graph signal for
// retrieval; algorithmic name detection is too risky to ship without an
// allowlist. Original message bodies remain untouched in
// `mailbox.inbox_messages.body` / `mailbox.sent_history.draft_sent` —
// the operator can still see the unscrubbed text in the dashboard.
//
// Replacement is a fixed token (`[REDACTED:phone|ssn|card]`) so retrieval
// + persona extraction can detect that scrubbing happened, but never sees
// the raw value.

const PHONE_TOKEN = '[REDACTED:phone]';
const SSN_TOKEN = '[REDACTED:ssn]';
const CARD_TOKEN = '[REDACTED:card]';

// SSN: NNN-NN-NNNN. Anchored on word boundaries so we don't eat the trailing
// 4 of a longer 16-digit card pattern. Match before phone — order matters
// because the phone regex would otherwise grab the same digits.
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;

// Credit-card-ish: 16 digits with optional `-` or single-space separators.
// Intentionally narrow — we want false negatives over false positives on
// long numbers (order numbers, tracking numbers, dates can collide).
// Validates word boundary endpoints + at least 13 contiguous digits to
// approximate the Luhn-checked card range without doing the actual check.
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;

// US phone, with or without country code, with paren area code, dash, dot,
// or space separators. Anchored on lookbehind/word boundary so a longer
// number (e.g., card residue) doesn't get partially matched.
//   +1 415 555 1234
//   (415) 555-1234
//   415-555-1234
//   415.555.1234
//   4155551234
const PHONE_RE = /(?<![\d-])(?:\+?1[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-]?)\d{3}[ .-]?\d{4}(?!\d)/g;

export interface ScrubCounts {
  phone: number;
  ssn: number;
  card: number;
}

export interface ScrubResult {
  text: string;
  counts: ScrubCounts;
}

// Scrub PII from `input` and return the scrubbed text plus per-pattern hit
// counts (useful for logging aggregate counts on backfill — never log the
// values themselves).
//
// Order: SSN, then card, then phone. Card and phone overlap on long digit
// runs; matching cards first prevents the phone regex from chewing into a
// 16-digit card. SSN is a strict subset that doesn't intersect either.
export function scrubPII(input: string | null | undefined): ScrubResult {
  if (!input) return { text: '', counts: { phone: 0, ssn: 0, card: 0 } };

  let text = input;
  const counts: ScrubCounts = { phone: 0, ssn: 0, card: 0 };

  text = text.replace(SSN_RE, () => {
    counts.ssn += 1;
    return SSN_TOKEN;
  });

  text = text.replace(CARD_RE, (m) => {
    // Require the match to actually contain >=13 digits after stripping
    // separators. Pre-filters cases where the regex matches "1 2 3" runs.
    const digits = m.replace(/[ -]/g, '');
    if (digits.length < 13) return m;
    counts.card += 1;
    return CARD_TOKEN;
  });

  text = text.replace(PHONE_RE, () => {
    counts.phone += 1;
    return PHONE_TOKEN;
  });

  return { text, counts };
}
