// dashboard/lib/drafting/strip-quoting.ts
//
// STAQPRO-341 — strip quoted thread history and signatures from email bodies
// before the LLM sees them. Per BL-21 / DR-21 in the 02-CONTEXT-ADDENDUM:
// the qwen3:4b-ctx4k local model burns ~half its 4k ctx on the quoted prior
// thread, and the drafts come back parroting the quoted block instead of
// answering the new message.
//
// Pure function — no I/O, no DB, no env. Safe to call from any drafting path
// (assemblePrompt, n8n pre-process, exemplar mining). Idempotent: stripping
// already-stripped text is a no-op.
//
// Scope: handles the common Gmail / Outlook / Apple Mail / mobile-client
// patterns. Doesn't try to be a full RFC 3676 / RFC 5322 parser — anything
// fancier than these patterns falls through and stays in the body, which
// is the correct fail-open behavior (better to send too much context to the
// LLM than too little).

export interface StripOptions {
  // Cap the output length post-strip. Useful when the body was huge but the
  // stripper couldn't find a quote boundary — at least don't send a 20k char
  // body into a 4k ctx model. 0 or unset = no cap.
  maxChars?: number;
}

export interface StripResult {
  // The cleaned body — quoting/signature blocks removed, trailing whitespace
  // collapsed.
  body: string;
  // Did we actually find and strip a quoted block? Useful for instrumentation
  // and for the n8n pre-process node which logs the strip ratio.
  stripped_quoted: boolean;
  // Did we strip a signature?
  stripped_signature: boolean;
  // Char count of original input. Lets the caller compute the strip ratio
  // without keeping the raw input around.
  original_length: number;
}

// "On Mon, May 13, 2026 at 10:23 AM Foo Bar <foo@bar.com> wrote:"
// "On Wednesday, May 13, 2026, Foo Bar <foo@bar.com> wrote:"
// "On 2026-05-13 10:23, Foo Bar wrote:"
// "On May 13, 2026 at 10:23:11 AM, Foo Bar <foo@bar.com> wrote:"
//
// Multi-line because Gmail wraps the attribution. Matches across newlines
// up to the "wrote:" terminator. `.` doesn't match newlines by default;
// use [\s\S] inside the quantifier to allow wraps.
const ATTR_LINE_RE = /^On [\s\S]{1,400}? wrote:\s*$/m;

// Outlook English style: "From: Foo <foo@bar.com>\nSent: ...\nTo: ...\nSubject: ..."
// We only need to match the first "From: " at the start of a line that begins
// an Outlook-style header block (followed within 4 lines by Sent: or To: or
// Subject:). Anchor with multi-line flag.
const OUTLOOK_FROM_RE = /^From:\s.+(\r?\n(Sent|To|Cc|Subject):.+){1,4}/m;

// Apple Mail / some mobile clients: "Begin forwarded message:" or
// "-------- Forwarded message --------" or "-----Original Message-----"
const FWD_BLOCK_RE =
  /^(Begin forwarded message:|-{2,}\s*Forwarded message\s*-{2,}|-{2,}\s*Original Message\s*-{2,})\s*$/m;

// RFC 3676 signature delimiter: "-- " (dash dash space) on its own line.
// Some clients drop the trailing space, accept either form. Multi-line.
const SIG_DELIM_RE = /^-- ?\s*$/m;

// Leading `> ` quote lines (top-posting case where the user replied above
// and the original is below as `> `-prefixed lines). Match one or more such
// lines at end of body. Allows nested `>>>`.
const TRAILING_QUOTE_BLOCK_RE = /(\n[ \t]*>[^\n]*)+\s*$/;

/**
 * Strip quoted thread history and signatures from an email body.
 *
 * Order of operations matters: we strip the attribution line FIRST (which
 * removes everything from "On ... wrote:" to end-of-string), then signatures,
 * then any remaining `> `-prefixed quote lines. The order means a top-posted
 * reply with a quoted thread below will have the thread removed cleanly.
 *
 * Returns the cleaned body PLUS instrumentation flags so callers can log
 * whether stripping actually fired.
 */
export function stripQuotedAndSignature(input: string, opts: StripOptions = {}): StripResult {
  const original_length = input?.length ?? 0;
  if (!input || original_length === 0) {
    return { body: '', stripped_quoted: false, stripped_signature: false, original_length: 0 };
  }

  let body = input;
  let stripped_quoted = false;
  let stripped_signature = false;

  // 1. Attribution line — everything from "On ... wrote:" to end-of-body.
  //    Gmail / iOS Mail / most modern clients.
  const attrMatch = ATTR_LINE_RE.exec(body);
  if (attrMatch && attrMatch.index !== undefined) {
    body = body.slice(0, attrMatch.index);
    stripped_quoted = true;
  }

  // 2. Forwarded-message block. Checked BEFORE the Outlook header pattern
  //    because forwarded blocks frequently contain Outlook-style headers
  //    embedded inside them — we want to cut at the outer "Begin forwarded
  //    message:" marker, not the inner From:/Subject: lines.
  if (!stripped_quoted) {
    const fwdMatch = FWD_BLOCK_RE.exec(body);
    if (fwdMatch && fwdMatch.index !== undefined) {
      body = body.slice(0, fwdMatch.index);
      stripped_quoted = true;
    }
  }

  // 3. Outlook-style header block. Same logic — cut from header start to EOB.
  if (!stripped_quoted) {
    const outlookMatch = OUTLOOK_FROM_RE.exec(body);
    if (outlookMatch && outlookMatch.index !== undefined) {
      body = body.slice(0, outlookMatch.index);
      stripped_quoted = true;
    }
  }

  // 4. Signature delimiter ("-- " on its own line). Cut from delimiter to EOB.
  //    Run AFTER quote stripping so a quoted block containing a signature
  //    delimiter inside it (which was already removed in step 1-3) doesn't
  //    confuse us. But also run when no quote was stripped — a fresh message
  //    can still carry a signature.
  const sigMatch = SIG_DELIM_RE.exec(body);
  if (sigMatch && sigMatch.index !== undefined) {
    body = body.slice(0, sigMatch.index);
    stripped_signature = true;
  }

  // 5. Trailing `> `-prefixed quote lines (top-post case without an attribution
  //    line). Common in mobile-to-mobile email.
  const trailingQuote = TRAILING_QUOTE_BLOCK_RE.exec(body);
  if (trailingQuote && trailingQuote.index !== undefined) {
    body = body.slice(0, trailingQuote.index);
    stripped_quoted = true;
  }

  // Collapse trailing whitespace + leading/trailing blank lines.
  body = body.replace(/\s+$/u, '').replace(/^[\r\n]+/u, '');

  // Optional hard cap. Applied AFTER stripping so the cap measures cleaned
  // content, not raw input.
  if (opts.maxChars && opts.maxChars > 0 && body.length > opts.maxChars) {
    body = body.slice(0, opts.maxChars);
  }

  return { body, stripped_quoted, stripped_signature, original_length };
}
