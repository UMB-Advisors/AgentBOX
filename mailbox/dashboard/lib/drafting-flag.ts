// MBOX-288 (DR-54 / §7.11.3) — honest in-flight "drafting" flag.
//
// Pure decision logic for whether the pipeline is *genuinely* drafting a
// reply right now. Lives in /lib (not /components) so vitest's vite resolver
// picks it up without the JSX import-analysis path — same convention as
// lib/freshness.ts. No React, no DB; the DB read lives in
// lib/queries-drafting-flag.ts and feeds the rows into deriveDraftingFlag().
//
// SM-72: a wrong "drafting an email" claim on a trust-sold appliance is worse
// than none. The flag asserts "drafting" ONLY when a draft is genuinely in
// flight — never on a client-side timeout guess. The semantic that makes this
// honest is the draft lifecycle:
//
//   Insert Draft Stub (n8n) → drafts row, status='pending', draft_body=''
//      └─ LOCAL/CLOUD route runs the LLM
//           └─ POST /api/internal/draft-finalize writes draft_body
//                └─ row is now AWAITING APPROVAL, not drafting
//
// (CLOUD route additionally flips status 'pending' → 'awaiting_cloud' while
// the cloud call is in flight — see the draft status state machine in
// CLAUDE.md and the v_drafting_metrics notes in queries-status.ts.)
//
// So "genuinely drafting" === a stub that has been created but not yet
// finalized: status IN ('pending','awaiting_cloud') AND draft_body still ''.
// A finalized-but-unapproved draft has status='pending' with a NON-empty body
// — claiming "drafting" there would be a false positive. We deliberately
// exclude it.

// In-flight statuses per the draft state machine. 'pending' covers the local
// route (and the brief pre-cloud-call window); 'awaiting_cloud' covers the
// cloud route while the gpt-oss/Haiku call is outstanding. Anything past these
// (approved | rejected | edited | sent) is a disposed/awaiting-approval row
// and is never "drafting".
export const DRAFTING_IN_FLIGHT_STATUSES = ['pending', 'awaiting_cloud'] as const;

// Minimal row shape the decision needs. Intentionally narrower than DraftRow —
// the query helper selects exactly these columns. `draft_body` is the
// finalized-vs-stub discriminator; from_addr/subject name the counterparty;
// transitioned_at (from state_transitions, the §8 audit log) is the honest
// "since when" timestamp for the most recent status flip on this draft.
export interface InFlightDraftRow {
  id: number;
  status: string;
  draft_body: string | null;
  from_addr: string | null;
  subject: string | null;
  // ISO string of the most recent mailbox.state_transitions row for this
  // draft (the §8 append-only audit log). Null when the trigger hasn't logged
  // a transition yet (brand-new stub before its first status write) — we fall
  // back to the row's own created/updated time at the query layer.
  since: string | null;
}

// The honest flag the chat UI consumes. Discriminated union so a consumer can
// never read a `counterparty` off a non-drafting state.
export type DraftingFlag =
  | {
      // A draft is genuinely in flight. Show "drafting a reply to <name>…".
      drafting: true;
      draft_id: number;
      // Best-effort human name for the counterparty; null when we can't parse
      // a name (UI then falls back to a subject or a generic "drafting a
      // reply…" with no name — still honest, just unnamed).
      counterparty: string | null;
      subject: string | null;
      // ISO timestamp the in-flight draft started (most recent transition, or
      // the row's own create/update time as a fallback). Lets the UI show an
      // honest elapsed time without a client-side guess.
      since: string | null;
    }
  | {
      // No draft in flight. The stall — if any — is cold-load, retrieval, or
      // general slowness. Plain "thinking", explicitly NO drafting claim.
      drafting: false;
    };

// Parse a display name out of an RFC 5322 From header value. Mirrors the regex
// already used in components/DraftCard.tsx so the chat indicator and the queue
// row name the same sender the same way. Returns null when there's no usable
// name (caller decides how to render the unnamed case).
export function counterpartyName(fromAddr: string | null | undefined): string | null {
  if (!fromAddr) return null;
  const named = fromAddr.match(/^"?([^"<]+)"?\s*</)?.[1]?.trim();
  if (named) return named;
  const local = fromAddr.split('@')[0]?.trim();
  return local && local.length > 0 ? local : null;
}

// Decide the honest flag from the current set of in-flight draft rows.
//
// `rows` MUST already be filtered to genuinely-in-flight stubs (status in
// DRAFTING_IN_FLIGHT_STATUSES AND draft_body empty) — that filtering is the
// query helper's job so the empty-vs-whitespace `draft_body` test stays close
// to the SQL. This function picks the row to surface (oldest in-flight, i.e.
// the one the pipeline is most likely actively working) and shapes the flag.
//
// Defensive belt-and-suspenders: we re-check status and emptiness here too, so
// even if a caller hands us an unfiltered list the function cannot emit a
// false-positive drafting claim (SM-72).
export function deriveDraftingFlag(rows: ReadonlyArray<InFlightDraftRow>): DraftingFlag {
  const inFlight = rows.filter(isGenuinelyInFlight);
  if (inFlight.length === 0) return { drafting: false };

  // Surface the oldest in-flight draft (smallest id ≈ earliest created). The
  // query orders by id ASC already; re-derive here so the function is correct
  // regardless of input order.
  const target = inFlight.reduce((oldest, r) => (r.id < oldest.id ? r : oldest), inFlight[0]);

  return {
    drafting: true,
    draft_id: target.id,
    counterparty: counterpartyName(target.from_addr),
    subject: target.subject ?? null,
    since: target.since ?? null,
  };
}

// A row is genuinely "drafting" iff it's an in-flight status AND its body is
// still an empty stub. Whitespace-only bodies count as empty — a normalized
// finalized body is never whitespace-only (see normalizeDraftBody in lib/db.ts).
function isGenuinelyInFlight(r: InFlightDraftRow): boolean {
  const inFlightStatus = (DRAFTING_IN_FLIGHT_STATUSES as readonly string[]).includes(r.status);
  const emptyStub = r.draft_body == null || r.draft_body.trim().length === 0;
  return inFlightStatus && emptyStub;
}
