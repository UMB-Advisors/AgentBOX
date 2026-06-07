// dashboard/lib/rag/excerpt.ts
//
// STAQPRO-190 — body excerpt builder. The Qdrant `email_messages` payload
// caps `body_excerpt` to keep retrieval responses small (Qdrant memory
// budget + 4k Qwen3 prompt context budget per DR-18).
//
// Strategy: take the first N characters after collapsing whitespace +
// stripping signatures and quoted reply blocks. Keeping this naive and
// portable rather than pulling in a full email-parsing dep — re-evaluate
// when tuning retrieval quality in STAQPRO-191/192.
//
// STAQPRO-193: PII scrub (US phone, SSN, credit-card-ish) is applied here,
// after the structural strip and before the cap, so retrieval payloads +
// embedding inputs are scrubbed in one place. Original bodies in Postgres
// are not touched.

import { scrubPII } from './scrub';

const DEFAULT_EXCERPT_CHAR_CAP = Number(process.env.EMBED_EXCERPT_CHAR_CAP ?? 800);

// STAQPRO-221 — strip quoted reply chains so embed input reflects only the
// substantive part of the inbound. Handles three real-world formats observed
// in Heron's 441-pair corpus:
//
//   1. Gmail web                 — "On <date>, <name> wrote:" then > lines
//   2. Apple Mail                — "> On <date>, at <time>, <name> wrote:"
//                                   (the leading > makes the header itself
//                                    look quoted; the body that follows is
//                                    also > prefixed)
//   3. Outlook / Exchange        — "-----Original Message-----" header block
//                                   followed by un-prefixed body lines
//
// Plus the all-formats fallback: lines starting with '>' (with optional
// leading whitespace), Gmail's standalone-quote convention.
//
// Phase-B inspection of STAQPRO-207 outliers found packets with 99% quoted
// history (e.g. 19b853053d10bd18, 17992 chars of quoted text under a 5-char
// fresh reply). The Qdrant embeds for those packets were dominated by the
// old text and surfaced same-thread duplicates as retrieval refs.
//
// Returns the substantive content as a contiguous string (no quote markers).
// On a packet that's 100% quoted (no substantive content), returns ''.
// Caller's job to gate on output length (thin-inbound gate in retrieve.ts).
export function stripQuotedHistory(body: string | null | undefined): string {
  if (!body) return '';
  let s = body;

  // Helper: cut at the first regex match, or at index 0 if the body starts
  // with the marker (real-world: pure-forward emails where the inbound IS
  // the quote chain with no fresh reply at the top).
  const cutAt = (re: RegExp): void => {
    const m = s.match(re);
    if (!m) return;
    const idx = m.index ?? -1;
    if (idx >= 0) s = s.slice(0, idx);
  };

  // (3) Outlook — cut at the marker. Everything below is quoted history.
  cutAt(/(?:^|\n+)-{2,}\s*Original Message\s*-{2,}[\s\S]*$/i);

  // (1) Gmail — "On <date>, <name> wrote:". 0,200 char wiggle keeps the
  // regex bounded — real "On..wrote:" lines are usually < 150 chars; longer
  // ones are likely false positives.
  cutAt(/(?:^|\n+)On .{0,200}wrote:[\s\S]*$/i);

  // (2) Apple Mail — leading '> ' before the header (the body lines that
  // follow get caught by the generic > strip below).
  cutAt(/(?:^|\n+)>\s*On .{0,200},\s*at\s+.{0,50},\s+.{0,200}wrote:[\s\S]*$/i);

  // Generic > prefix strip — Gmail's standalone-quote convention, also catches
  // any > lines that survived the format-specific cuts above (e.g. when the
  // Gmail/Apple header didn't match the regex but the > body did).
  s = s
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('\n');

  return s;
}

export function buildBodyExcerpt(
  body: string | null | undefined,
  cap = DEFAULT_EXCERPT_CHAR_CAP,
): string {
  if (!body) return '';

  // STAQPRO-221 — quoted-history strip moved to stripQuotedHistory so the
  // retrieve.ts thin-inbound gate can see the same stripped content this
  // function sees, and operate on the substantive length specifically.
  let s = stripQuotedHistory(body);

  // Drop common signature delimiters.
  const sigIdx = s.search(/\n--\s*\n/);
  if (sigIdx > 0) s = s.slice(0, sigIdx);

  // Collapse whitespace.
  s = s.replace(/\s+/g, ' ').trim();

  // STAQPRO-193: scrub PII before the cap so the redaction tokens are part
  // of the embedded payload (not chopped mid-token).
  s = scrubPII(s).text;

  return s.slice(0, cap);
}

// Compose embedding input from subject + body excerpt. Subject is heavily
// weighted in short emails so we prefix it; nomic-embed-text:v1.5 handles
// either form fine in our smoke tests.
export function buildEmbeddingInput(
  subject: string | null | undefined,
  bodyExcerpt: string,
): string {
  const sub = (subject ?? '').trim();
  if (!sub) return bodyExcerpt;
  if (!bodyExcerpt) return sub;
  return `Subject: ${sub}\n\n${bodyExcerpt}`;
}
