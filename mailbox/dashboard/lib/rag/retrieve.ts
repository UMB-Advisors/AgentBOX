// dashboard/lib/rag/retrieve.ts
//
// STAQPRO-191 — retrieval at draft time.
//
// Embed the inbound email, query Qdrant `email_messages` with a hard
// filter on `payload.sender == inbound.from_addr` for counterparty-scoped
// recall, vector similarity for topical ranking. Return top-k formatted
// snippets ready for the existing prompt.ts `rag_refs` slot.
//
// === Privacy gate (cloud route) ===
//
// Per the project Constraints section ("All email content and knowledge
// base stored only on local appliance. No bulk corpus sent to cloud.")
// and the STAQPRO-191 session call-out: retrieval payloads going into a
// cloud-route prompt count as additional cloud-bound content. The default
// is therefore PRIVACY-FIRST:
//
//   - LOCAL route (qwen3:4b-ctx4k on-device)  → retrieval ALWAYS runs
//   - CLOUD route (Ollama Cloud / Anthropic)  → retrieval runs only when
//                                                RAG_CLOUD_ROUTE_ENABLED=1
//
// This means cloud calls only carry the inbound email itself + per-call
// classification, exactly matching the existing baseline. Operators who
// explicitly opt in (`RAG_CLOUD_ROUTE_ENABLED=1` in .env) trade off some
// privacy budget for retrieval-quality on the cloud path.
//
// === Token budget (DR-18: 4096 ctx local) ===
//
// Qwen3 has 4096 tokens total. Existing system + user prompt without RAG
// is ~600-800 tokens; inbound bodies cap at MAX_BODY_CHARS=6000 chars (~1500
// tokens); completion is max_tokens=600. That leaves ~1000-1500 tokens for
// retrieved context.
//
// Conservative default: top-k=3, per-snippet excerpt cap=600 chars (~150
// tokens) — yields ~450 tokens of retrieved context, well under budget.
// Tunable via RAG_RETRIEVE_TOP_K + RAG_RETRIEVE_EXCERPT_CHARS.
//
// === Failure mode ===
//
// Returns empty refs[] (not throw) on any failure — embed unavailable,
// Qdrant unreachable, 0 hits. Drafting proceeds with persona-stub fallback
// per the issue's acceptance criterion ("RAG is augmentation, not gate").

import { embedText } from './embed';
import { buildBodyExcerpt, buildEmbeddingInput, stripQuotedHistory } from './excerpt';
import { searchKb } from './kb-qdrant';
import {
  normalizeSender,
  pointIdFromAccountMessage,
  pointIdFromMessageId,
  searchByVector,
} from './qdrant';

export interface RetrievalRef {
  point_id: string;
  source: string; // human-readable label rendered into the prompt
  excerpt: string;
  score: number;
  direction: 'inbound' | 'outbound';
  sent_at: string;
}

// STAQPRO-148 — KB retrieval ref. Distinct shape from RetrievalRef because
// KB chunks have no sender/direction/sent_at — they're corpus-wide policy
// content, not per-counterparty conversation history.
export interface KbRetrievalRef {
  point_id: string;
  source: string; // doc_title — rendered into the prompt as "[doc_title]"
  excerpt: string;
  score: number;
  doc_id: number;
  chunk_index: number;
}

export type EmailRetrievalReason =
  | 'ok'
  | 'cloud_gated'
  | 'embed_unavailable'
  | 'no_hits'
  | 'qdrant_unavailable'
  // STAQPRO-198 — set when `RAG_DISABLED=1` short-circuits retrieveForDraft
  // before any embed / Qdrant call. Used by the eval harness's no-rag pass
  // to run a baseline draft without persona-stub vs RAG noise.
  | 'disabled'
  // STAQPRO-221 (H4) — set when the inbound body, after quote-history strip,
  // is too short to produce a meaningful embedding. Phase-B inspection found
  // packets with 2-char substantive content (`19b0ed17519285b1`) whose embeds
  // degenerated and pulled noise refs. Threshold via RAG_MIN_INBOUND_CHARS,
  // default 40. App-side enum — no DB CHECK constraint per migration 013's
  // explicit "Enum stays application-side" note.
  | 'inbound_too_thin'
  // STAQPRO-222 (H5) — set when every hit returned by the merged email
  // search scored below `RAG_MIN_SCORE`. Distinct from `'no_hits'` so
  // telemetry can tell "Qdrant returned nothing" apart from "Qdrant
  // returned borderline-relevant matches we chose to drop." Threshold
  // tunable via RAG_MIN_SCORE (default 0.70). App-side enum — same
  // migration 013 rule as the other Phase-D reasons.
  | 'below_score_floor';

// Distinct from EmailRetrievalReason on the cloud-gated value
// ('kb_cloud_gated' vs 'cloud_gated') so the eval surface can tell them
// apart even though they share the same RAG_CLOUD_ROUTE_ENABLED env gate.
// 'disabled' shared with the email side — when RAG_DISABLED=1 the eval
// harness wants BOTH retrievals off (testing "does RAG help?" — KB is RAG
// too).
export type KbRetrievalReason =
  | 'ok'
  | 'kb_cloud_gated'
  | 'embed_unavailable'
  | 'no_hits'
  | 'qdrant_unavailable'
  | 'none'
  | 'disabled';

export interface RetrievalResult {
  refs: RetrievalRef[];
  reason: EmailRetrievalReason;
  // STAQPRO-148 — parallel KB retrieval. Empty kb_refs[] is interpreted via
  // kb_reason: 'kb_cloud_gated' (privacy gate), 'embed_unavailable',
  // 'qdrant_unavailable', 'no_hits' (corpus has no relevant chunks),
  // 'disabled' (RAG_DISABLED=1 eval baseline), or 'none' (KB retrieval was
  // not attempted for some other reason).
  kb_refs: KbRetrievalRef[];
  kb_reason: KbRetrievalReason;
}

export interface RetrievalInput {
  from_addr: string;
  subject: string | null;
  body_text: string | null;
  draft_source: 'local' | 'cloud';
  // STAQPRO-191 — persona scoping. Multi-mailbox appliances (one Jetson,
  // 2-5 personas) require retrieval to be filtered to the persona that
  // owns the draft. Single-persona appliances pass 'default'. Must match
  // the value written into payload.persona_key at ingestion time or the
  // search returns zero hits.
  persona_key: string;
  // MBOX-352 (MBOX-162 V2) — the mailbox.accounts id that owns this draft.
  // When set, retrieval hard-filters Qdrant on payload.account_id so a
  // multi-mailbox appliance only recalls history from the owning inbox, and
  // self-exclude additionally drops the account-scoped point id. Optional for
  // back-compat: the eval harness and legacy callers omit it and retain the
  // pre-V2 (unfiltered, message_id-keyed) behavior. The draft-prompt route
  // always supplies it (the in-flight draft's account_id).
  account_id?: number;
  // STAQPRO-219 — Gmail message_id of the inbound being drafted against.
  // Used to compute the inbound's own deterministic point UUID and exclude
  // it from search results via must_not.has_id. Without this filter, the
  // inbound's backfilled twin scores 1.000 against itself and wastes one
  // top-k slot on every query (Phase-B inspection: 10/10 outliers had a
  // self-match as their top ref). Optional only because the eval harness
  // and legacy callers may not have a message_id handy — when omitted,
  // self-filtering is skipped.
  message_id?: string | null;
  // STAQPRO-222 (H3) — Gmail thread_id of the inbound. When provided AND
  // `RAG_RETRIEVE_EXCLUDE_SAME_THREAD=1` (default on), retrieval drops
  // every point in the same conversation thread on BOTH the inbound and
  // outbound Qdrant searches. Phase-B inspection found top-3 refs were
  // routinely all from the same thread — duplicating context the drafter
  // already has via the quoted-history chain on the inbound body. Optional
  // for back-compat: legacy callers without a thread_id retain pre-222
  // behavior (no thread-suppression filter).
  thread_id?: string | null;
}

function topK(): number {
  return Number(process.env.RAG_RETRIEVE_TOP_K ?? 3);
}

// STAQPRO-221 (H2) — voice-priming split. Outbound (operator → counterparty)
// supplies "how do they write to this person"; inbound (counterparty →
// operator) supplies "what have they said historically." Tunable per-arm so
// operators can rebalance without code change. Total cap stays at topK() —
// the merge step trims to that ceiling.
function topKOutbound(): number {
  return Number(process.env.RAG_RETRIEVE_TOP_K_OUTBOUND ?? 2);
}
function topKInbound(): number {
  return Number(process.env.RAG_RETRIEVE_TOP_K_INBOUND ?? 1);
}

// STAQPRO-221 (H4) — substantivity gate. Inbound bodies under this length
// AFTER quoted-history strip produce degenerate embeddings (Phase-B outlier
// 19b0ed17519285b1 was 2 chars of fresh content under 4kb of quote chain).
function minInboundChars(): number {
  return Number(process.env.RAG_MIN_INBOUND_CHARS ?? 40);
}

// STAQPRO-222 (H5) — score-floor cutoff. After H1 self-filter, H2 outbound +
// inbound merge, H4 strip-quoted, and the existing top-K cap, drop refs
// scoring below this threshold. Below ~0.70 cosine, refs tend to surface
// borderline-relevant context that confuses tone more than it helps (Phase-B
// outlier 19ba502acb1edbf5 had refs at 0.690 + 0.664 from a different product
// line, with-RAG cosine dropped 12pp vs no-RAG). NaN parse defends against
// a malformed env value (returns 0.70 — the conservative default).
//
// Sweep range per the ticket: {0.60, 0.65, 0.70, 0.75}. Default after sweep
// is whichever threshold maximizes judge_score with non-negative cosine Δ.
function minScore(): number {
  const parsed = Number.parseFloat(process.env.RAG_MIN_SCORE ?? '0.70');
  return Number.isFinite(parsed) ? parsed : 0.7;
}

// STAQPRO-222 (H3) — same-thread suppression flag. Default '1' (on).
// Phase-B inspection found top-3 refs were routinely all from the same
// conversation thread, duplicating context the drafter already has via the
// inbound body's quoted-history chain. H4 strips quotes on the EMBED side,
// but doesn't stop the RETRIEVAL side from surfacing same-thread points
// scored against the substantive fragment. This flag adds the corresponding
// retrieval-side filter. Off-state preserves pre-222 behavior so eval can
// A/B isolate the value.
function excludeSameThread(): boolean {
  return process.env.RAG_RETRIEVE_EXCLUDE_SAME_THREAD !== '0';
}

// STAQPRO-221 (H2) — single-tenant operator email source. Read at call time
// (not module load) so an .env rotation + container restart picks up the new
// value. Returns '' when unset; retrieve.ts then falls back to inbound-only
// retrieval with a console warning rather than failing the draft path.
//
// Multi-tenant migration path: replace this with a per-persona lookup keyed
// on RetrievalInput.persona_key (today the persona is single-tenant 'default'
// per the appliance contract). Likely lands on `mailbox.persona.operator_email`
// — the column doesn't exist yet, would be added in a future migration when
// multi-persona is in scope.
function operatorEmail(): string {
  return normalizeSender(process.env.MAILBOX_OPERATOR_EMAIL ?? '');
}
function kbTopK(): number {
  return Number(process.env.KB_RETRIEVE_TOP_K ?? 3);
}
function excerptCharCap(): number {
  return Number(process.env.RAG_RETRIEVE_EXCERPT_CHARS ?? 600);
}
function kbExcerptCharCap(): number {
  // STAQPRO-148 — 600 to match ragBlock per-chunk cap and stay under the
  // Qwen3-4B 4096-token ctx ceiling when ragBlock + kbBlock both fire on
  // a long-body inbound (Linus pre-flight on commit 36d8949). Combined
  // worst case: 1500 (body) + 450 (rag) + 450 (kb) + 600 (system) = ~3000
  // tokens, leaving ~1000 for completion.
  return Number(process.env.KB_RETRIEVE_EXCERPT_CHARS ?? 600);
}

// Lazy env read so operators can flip RAG_CLOUD_ROUTE_ENABLED without a
// process restart, and tests can toggle the gate per-case.
export function isCloudRetrievalEnabled(): boolean {
  return process.env.RAG_CLOUD_ROUTE_ENABLED === '1';
}

// STAQPRO-198 — operator-controlled kill switch for the eval harness's
// no-rag baseline pass. Lazy env read so the same script invocation flips
// behavior per `RAG_DISABLED=1 npm run eval:rag` without a process restart.
// Production code never sets this; only the eval harness does, and only on
// the second of its two passes.
export function isRagDisabled(): boolean {
  return process.env.RAG_DISABLED === '1';
}

export async function retrieveForDraft(input: RetrievalInput): Promise<RetrievalResult> {
  // STAQPRO-198 — short-circuit before any embed / Qdrant call. The harness
  // baseline relies on this returning empty refs without touching infra.
  // STAQPRO-148 followup: also short-circuits KB retrieval — the eval is
  // testing "does RAG (any kind) help?" so the no-rag pass must skip BOTH
  // email AND KB collections. Otherwise the no-rag baseline would still
  // include KB hits for any operator who uploaded SOPs.
  if (isRagDisabled()) {
    return { refs: [], reason: 'disabled', kb_refs: [], kb_reason: 'disabled' };
  }

  // Privacy gate: cloud-route retrieval is opt-in. Both email and KB are
  // gated by the same RAG_CLOUD_ROUTE_ENABLED env var (KB content is just
  // as proprietary as email — pricing, policy, supplier terms). Distinct
  // reason values so the eval surface can tell them apart in audit logs.
  if (input.draft_source === 'cloud' && !isCloudRetrievalEnabled()) {
    return {
      refs: [],
      reason: 'cloud_gated',
      kb_refs: [],
      kb_reason: 'kb_cloud_gated',
    };
  }

  // STAQPRO-191 — normalize sender BEFORE filter construction. Inbound
  // from_addr can be 'Customer Name <cust@example.com>' or already-bare
  // 'cust@example.com'; ingestion paths normalize the same way (see
  // normalizeSender export). Without symmetric normalization, retrieval
  // silently returns zero hits for half of senders.
  //
  // Empty sender means a malformed inbound; both email retrieval (sender-
  // filtered) and KB retrieval (corpus-wide) skip — the draft itself is
  // unlikely to be useful.
  //
  // STAQPRO-148 — kb_reason='none' (not 'no_hits') for short-circuits:
  // 'no_hits' means "we searched and found nothing"; 'none' means "we
  // never attempted." Future KB hit-rate eval needs to disambiguate these.
  // (Linus pre-flight on commit 36d8949.)
  const normalizedSender = normalizeSender(input.from_addr);
  if (!normalizedSender) {
    return { refs: [], reason: 'no_hits', kb_refs: [], kb_reason: 'none' };
  }

  // STAQPRO-221 (H4) — strip quoted history BEFORE the substantivity gate AND
  // before embed-input construction so the embed vector reflects only the
  // substantive part. The gate guards against degenerate embeds on packets
  // that are 99% quoted-history (19b853053d10bd18) or near-empty fresh-reply
  // (19b0ed17519285b1).
  const strippedBody = stripQuotedHistory(input.body_text);
  // Whitespace-stripped length for gate eval — a body of "      \n\n   " is
  // visually empty even at 12 chars. The embed builder also collapses
  // whitespace, so this matches what would have gone into the vector.
  const substantiveLength = strippedBody.replace(/\s+/g, ' ').trim().length;
  if (substantiveLength < minInboundChars()) {
    return {
      refs: [],
      reason: 'inbound_too_thin',
      kb_refs: [],
      kb_reason: 'none',
    };
  }

  const embedInput = buildEmbeddingInput(input.subject, buildBodyExcerpt(strippedBody));
  if (!embedInput.trim()) {
    return { refs: [], reason: 'no_hits', kb_refs: [], kb_reason: 'none' };
  }

  const vector = await embedText(embedInput);
  if (!vector) {
    return {
      refs: [],
      reason: 'embed_unavailable',
      kb_refs: [],
      kb_reason: 'embed_unavailable',
    };
  }

  // STAQPRO-148 — single embed, parallel searches across both collections.
  // KB has no sender filter (corpus-wide policy content); email is sender-
  // and persona-scoped per STAQPRO-191. Promise.all keeps the wall-clock
  // overhead to max(email_search, kb_search), not the sum.
  //
  // STAQPRO-219 — drop the inbound's own backfilled twin from email search
  // via must_not.has_id. The point UUID is deterministic (sha256-derived),
  // so we can compute it locally without a Qdrant lookup. Only applies when
  // a message_id was supplied — eval harness and legacy callers without a
  // message_id retain pre-219 behavior (self-match contamination + all).
  //
  // STAQPRO-221 (H2) — voice priming. Run two email searches in parallel:
  //   - inbound: what the counterparty has historically said
  //   - outbound: what the operator has historically said TO the counterparty
  // Merge by score, cap at topK() as the absolute ceiling. Without the
  // outbound arm, retrieval surfaces 100% inbound refs (Phase-B inspection)
  // so the drafter never sees how the operator actually writes — voice
  // transfer fails. When MAILBOX_OPERATOR_EMAIL is unset, fall back to inbound-only
  // (single Qdrant call, console warning logged once-ish per process).
  // MBOX-352 — exclude the inbound's own twin under BOTH keying schemes. The
  // legacy message_id-keyed id covers points ingested before the V2 rekey; the
  // account-scoped id covers points ingested after. Both are listed so
  // self-exclusion holds across the rekey window (and is byte-identical to
  // pre-V2 for points that only ever had the legacy id).
  const selfPointIds = input.message_id
    ? [
        pointIdFromMessageId(input.message_id),
        ...(input.account_id !== undefined
          ? [pointIdFromAccountMessage(input.account_id, input.message_id)]
          : []),
      ]
    : undefined;
  const operatorAddr = operatorEmail();
  const outboundSearchEnabled = operatorAddr.length > 0;
  if (!outboundSearchEnabled) {
    // The warning is a once-ish nag — process-lifetime cooldown via the
    // module-level flag below. Drafts still work; voice priming silently
    // falls back to inbound-only.
    warnOperatorEmailMissing();
  }

  // STAQPRO-222 (H3) — same-thread suppression. Compute once and reuse on
  // both inbound and outbound searches. Only applied when a thread_id was
  // supplied AND the flag is on (default on); legacy callers without a
  // thread_id retain pre-222 behavior.
  const excludeThreadId = input.thread_id && excludeSameThread() ? input.thread_id : undefined;

  const inboundSearchP = searchByVector(vector, {
    limit: topKInbound(),
    senderFilter: normalizedSender,
    personaKey: input.persona_key,
    accountFilter: input.account_id,
    excludePointIds: selfPointIds,
    excludeThreadId,
  });
  const outboundSearchP = outboundSearchEnabled
    ? searchByVector(vector, {
        limit: topKOutbound(),
        senderFilter: operatorAddr,
        recipientFilter: normalizedSender,
        personaKey: input.persona_key,
        accountFilter: input.account_id,
        excludePointIds: selfPointIds,
        excludeThreadId,
      })
    : Promise.resolve(null);

  const [inboundSearch, outboundSearch, kbSearch] = await Promise.all([
    inboundSearchP,
    outboundSearchP,
    searchKb(vector, { limit: kbTopK() }),
  ]);

  const emailSearch = mergeEmailSearches(inboundSearch, outboundSearch, topK());

  // Email refs.
  // STAQPRO-222 (H5) — score-floor is applied AFTER:
  //   1. H1 self-filter (must_not.has_id, in searchByVector)
  //   2. H3 same-thread filter (must_not.thread_id, in searchByVector)
  //   3. H2 inbound + outbound merge + topK cap (mergeEmailSearches)
  // and BEFORE reason resolution, so an all-below-floor result becomes
  // `'below_score_floor'` (distinct from `'no_hits'`) and an all-above-
  // floor result is unaffected.
  const floor = minScore();
  let emailReason: EmailRetrievalReason;
  let refs: RetrievalRef[];
  if (!emailSearch.ok) {
    refs = [];
    emailReason = 'qdrant_unavailable';
  } else if (emailSearch.hits.length === 0) {
    refs = [];
    emailReason = 'no_hits';
  } else {
    const survivors = emailSearch.hits.filter((h) => h.score >= floor);
    if (survivors.length === 0) {
      refs = [];
      emailReason = 'below_score_floor';
    } else {
      refs = survivors.map((h) => {
        const dir = h.payload.direction === 'outbound' ? 'we wrote' : 'they wrote';
        const dateLabel = h.payload.sent_at.slice(0, 10);
        const subject = h.payload.subject ?? '(no subject)';
        return {
          point_id: h.id,
          source: `${dateLabel} · ${dir} · ${subject}`,
          excerpt: (h.payload.body_excerpt ?? '').slice(0, excerptCharCap()),
          score: h.score,
          direction: h.payload.direction,
          sent_at: h.payload.sent_at,
        };
      });
      emailReason = 'ok';
    }
  }

  // KB refs.
  let kbReason: KbRetrievalReason;
  let kb_refs: KbRetrievalRef[];
  if (!kbSearch.ok) {
    kb_refs = [];
    kbReason = 'qdrant_unavailable';
  } else if (kbSearch.hits.length === 0) {
    kb_refs = [];
    kbReason = 'no_hits';
  } else {
    kb_refs = kbSearch.hits.map((h) => ({
      point_id: h.id,
      source: h.payload.doc_title,
      excerpt: (h.payload.excerpt ?? '').slice(0, kbExcerptCharCap()),
      score: h.score,
      doc_id: h.payload.doc_id,
      chunk_index: h.payload.chunk_index,
    }));
    kbReason = 'ok';
  }

  return { refs, reason: emailReason, kb_refs, kb_reason: kbReason };
}

// STAQPRO-221 (H2) helpers.

// Merge inbound + outbound Qdrant search results into a single SearchResult-
// shaped object for the existing downstream `refs` mapping. Strategy:
//
//   1. If both succeeded — concat hits, sort by score desc, take top `cap`.
//      Deduplicate on point id (defensive: a single point should never appear
//      in both inbound and outbound, but the merge is cheap).
//   2. If only one succeeded — use that one's hits (cap-trimmed).
//   3. If outbound was skipped (Promise.resolve(null) — MAILBOX_OPERATOR_EMAIL unset)
//      — same as case 2 with outbound=null.
//   4. If both failed — return ok:false; the existing downstream qdrant_
//      unavailable path fires.
//
// We keep the SearchResult shape so the existing reason-resolution code below
// the merge stays untouched.
import type { SearchResult } from './qdrant';

function mergeEmailSearches(
  inbound: SearchResult,
  outbound: SearchResult | null,
  cap: number,
): SearchResult {
  const inboundOk = inbound.ok;
  const outboundOk = outbound?.ok === true;

  if (!inboundOk && !outboundOk) {
    // Prefer the inbound reason for the downstream message — inbound is the
    // always-on arm, so its failure is more diagnostic of the actual issue.
    return { ok: false, hits: [], reason: inbound.reason };
  }

  const all = [
    ...(inboundOk ? inbound.hits : []),
    ...(outboundOk && outbound ? outbound.hits : []),
  ];
  // Dedup on id (defensive); preserve the higher-scoring copy.
  const byId = new Map<string, (typeof all)[number]>();
  for (const h of all) {
    const prev = byId.get(h.id);
    if (!prev || h.score > prev.score) byId.set(h.id, h);
  }
  const merged = [...byId.values()].sort((a, b) => b.score - a.score).slice(0, cap);
  return { ok: true, hits: merged };
}

// Module-level so the warning isn't logged on every cycle. 30 min cooldown
// means an operator who never sets MAILBOX_OPERATOR_EMAIL sees the nag at most
// ~50/day, not 100K/day.
let lastOperatorEmailWarningAt = 0;
const OPERATOR_EMAIL_WARN_COOLDOWN_MS = 30 * 60 * 1000;
function warnOperatorEmailMissing(): void {
  const now = Date.now();
  if (now - lastOperatorEmailWarningAt < OPERATOR_EMAIL_WARN_COOLDOWN_MS) return;
  lastOperatorEmailWarningAt = now;
  console.warn(
    '[rag/retrieve] MAILBOX_OPERATOR_EMAIL unset — voice-priming (H2) disabled; falling back to inbound-only retrieval. ' +
      'Set MAILBOX_OPERATOR_EMAIL in .env to enable outbound voice-priming refs.',
  );
}
