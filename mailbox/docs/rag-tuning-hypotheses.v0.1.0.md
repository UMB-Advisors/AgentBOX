# RAG Tuning Hypotheses — Phase D

**Version:** v0.1.0
**Date:** 2026-05-01
**Source:** STAQPRO-207 Phase B (10 outlier inspection packets) + Phase A aggregate (n=441, mean Δ=+0.0012, p≈0.67)

## TL;DR

Phase A says the live RAG path has no detectable signal, and Phase B explains why: every inspected packet has a self-retrieval at score=1.000, every retrieved snippet is `direction=inbound` (zero operator voice), and 5/10 of the original "extreme" deltas flipped sign on re-run — meaning Qwen3 sampling noise is the dominant variance source, not RAG. The fixes that the data actually supports are (1) drop the inbound's own point UUID from results, (2) bias retrieval toward operator outbound, (3) suppress same-thread refs that Qwen3 already has in the inbound body, and (4) gate retrieval on the inbound being substantive enough to embed cleanly. None of these are speculative — each traces to specific packets below. We should also stop relying on draft-vs-reply cosine as the eval primitive; it's too noisy at the per-packet scale we're tuning at.

---

## H1 — Filter the inbound's own point UUID out of results

**One-line:** Every packet wastes a top-k slot on a 1.000-cosine self-match because `pointIdFromMessageId(inbound.message_id)` is already in Qdrant from the earlier ingest fire-and-forget.

### The change

In `dashboard/lib/rag/retrieve.ts`, before the Qdrant search call, compute `selfPointId = pointIdFromMessageId(inbound.message_id)` (using the existing helper from `dashboard/lib/rag/qdrant.ts`) and pass it as a `must_not` filter on Qdrant's `id`:

```ts
const selfPointId = pointIdFromMessageId(inbound.message_id);
const result = await qdrant.search('email_messages', {
  vector,
  limit: topK,
  filter: {
    must: [{ key: 'sender', match: { value: inbound.from_addr } }],
    must_not: [{ has_id: [selfPointId] }],  // NEW
  },
  with_payload: true,
});
```

No schema change. Add a unit test in `dashboard/lib/rag/__tests__/retrieve.test.ts` that asserts the inbound's own UUID never appears in `refs[].point_id`.

### Supporting evidence

| message_id | top-ref score | self-match? |
|---|---|---|
| `19bb7fe899f609ca` | 1.000 | yes — top ref body byte-identical to inbound first 200 chars |
| `19ba502acb1edbf5` | 1.000 | yes — top ref `"All good - Dustin let us know the dosage is 25mg smokenol."` is the inbound body verbatim |
| `19be6b587e3b7d53` | 1.000 | yes — top ref body is the inbound's "Connecting you to US Raws…" verbatim |
| `19bfc435639d8fc9` | 1.000 | yes — top ref is the inbound's "Sounds good. Let us know when works for you and Will." verbatim |
| `19c813bde357dc32` | 1.000 | yes — and `refs=1`, so 100% of the context window went to a self-match |
| `19c95e5a040c7aaf` | 1.000 | yes — and `refs=1` again, same wasted-slot pathology |
| `19a5d5512b6feb1e` | 1.000 | yes — top ref is the inbound's "Hey Dustin, I was just reaching back…" verbatim |
| `19be35efc56bd858` | 1.000 | yes — top ref is the inbound's full Bert/specs body verbatim |

10/10 packets show this. It's universal, not anecdotal.

### Contradicting evidence

None in the 10 packets. The closest thing to a "what if the self-match is actually useful" argument is `19c813bde357dc32` and `19c95e5a040c7aaf`, where `refs=1` total — meaning after filtering self there'd be nothing left. But "nothing" is strictly better than "the inbound itself again," because the drafter already has the inbound in the prompt. Empty refs cleanly fall through to the persona-stub path.

### Estimated dev cost

**S** — ~6 LOC plus one test. The `pointIdFromMessageId` helper already exists; Qdrant's `must_not` + `has_id` is a documented filter primitive.

### Expected eval-Δ direction

**Up, with low magnitude.** This frees one top-k slot for a real prior message in 8/10 cases, so signal density improves. But on the 2 cases where `refs=1`, retrieval becomes empty and the draft falls back to persona-stub — which from `19c95e5a040c7aaf` we know can produce *better* drafts (no-RAG cosine 0.7753 > with-RAG 0.7019). So the mean shift is up but probably small (single-digit basis points). The bigger value of this change is methodological: every other Phase D hypothesis is contaminated by self-match noise until this is fixed.

---

## H2 — Bias retrieval toward operator outbound (`direction=outbound`)

**One-line:** All 10 packets retrieved 100% inbound refs, so Qwen3 never sees how the operator actually writes — retrieval can't prime voice if voice is filtered out.

### The change

In `dashboard/lib/rag/retrieve.ts`, run **two** Qdrant searches and merge: one filtered to `direction=outbound` (operator voice) for top-K_out, and the existing `direction=inbound` filter for top-K_in. Default split: K_out=2, K_in=1 with `RAG_RETRIEVE_TOP_K=3` total. Add env vars `RAG_RETRIEVE_TOP_K_OUTBOUND` (default 2) and `RAG_RETRIEVE_TOP_K_INBOUND` (default 1).

```ts
const [outboundRefs, inboundRefs] = await Promise.all([
  qdrant.search('email_messages', {
    vector, limit: topKOutbound,
    filter: { must: [
      { key: 'sender', match: { value: operator_email } },
      { key: 'recipient', match: { value: inbound.from_addr } },
    ], must_not: [{ has_id: [selfPointId] }] },
  }),
  qdrant.search('email_messages', {
    vector, limit: topKInbound,
    filter: { must: [
      { key: 'sender', match: { value: inbound.from_addr } },
    ], must_not: [{ has_id: [selfPointId] }] },
  }),
]);
const refs = [...outboundRefs.points, ...inboundRefs.points];
```

This requires the embed/ingest path to populate `payload.recipient` for outbound messages — the STAQPRO-190 outbound embed path already accepts `recipient` per CLAUDE.md, but spot-check it's actually written. Also requires `operator_email` to be threaded into `retrieveForDraft` — pull from env (`OPERATOR_EMAIL`) for v1, single-tenant box.

### Supporting evidence

- `19c813bde357dc32` (Unifi Farms): operator's actual reply was `"Eric, let's sesh next week on getting your shipments GMP compliant"` — a curt, terse pivot to a *new topic* (GMP compliance) that has nothing to do with the inbound's "we sent the package" content. Inbound-only retrieval cannot surface this. Operator's prior outbound replies in this thread (and in adjacent CMO threads) would have shown the "let's sesh next week" cadence — a voice signal, not a content signal.
- `19c95e5a040c7aaf` (World Tree Nutrition): operator's actual reply contains hard pricing facts (`"$3,500 for R&D"`, `"minimum order size is 2,000 pieces"`, `"30,000 pieces"` price break) — these are operator-canonical facts that live in *outbound* corpus history, not in any inbound. Top inbound ref scored 1.000 self-match; the *real* prior was an earlier outbound R&D quote that retrieval couldn't see.
- `19a5d5512b6feb1e` (Neurohack Boost): operator's actual reply was a one-liner — `"How's your schedule this weekend or Monday?"` — characteristic operator scheduling voice. With-RAG draft was 152 chars and verbose; no-RAG was 182 chars and verbose. Outbound priors would have shown the terse "how's X look" pattern.
- `19be35efc56bd858` (Bert / Protein Gummies): operator's actual reply was a *calendar-availability list* — `"Thursday, January 22, 2026, from 9:30 AM – 10:00 AM EST"` — generated by a downstream availability tool. Not RAG-retrievable from any direction. **Counter-example below.**

### Contradicting evidence

- `19be35efc56bd858` — the operator reply is calendar tooling output, not voice-driven. Outbound retrieval wouldn't help here either.
- `19ba502acb1edbf5` (Sam's Small Batch) — actual operator reply has the structure of an LLM-formatted response with `"Information not found in the reference document."` markers, suggesting it came from a different draft pipeline. Voice priming is moot when the "operator reply" is itself synthetic.
- `19b853053d10bd18` — same synthetic-reply pattern as above.

So 3 of 10 packets push back, but only because the "operator reply" target itself isn't human-written — that's a corpus-quality issue (see Methodology), not a defect in the hypothesis.

### Estimated dev cost

**M** — two Qdrant calls in parallel, env-var split, plus a verification pass that outbound payloads carry `recipient`. ~30 LOC and one integration test. No infra change.

### Expected eval-Δ direction

**Up, moderate magnitude — but uncertain.** Voice priming has stronger theoretical grounding than additional inbound context. The tradeoff: operator outbound replies will have *lower* cosine to the inbound (different speaker, different topic continuation) so individual ref scores will drop. That's fine — the goal is voice transfer to the drafter, not topical recall. Cosine-vs-reply is a poor metric for this hypothesis specifically (see Methodology); LLM-judge would tell a clearer story.

---

## H3 — Same-thread suppression: drop refs whose `thread_id` matches the inbound

**One-line:** Top-3 refs are usually all from the same conversation thread, duplicating context Qwen3 already has in the inbound body's quoted-history.

### The change

In `dashboard/lib/rag/retrieve.ts`, add a `must_not` filter on `thread_id`:

```ts
filter: {
  must: [{ key: 'sender', match: { value: inbound.from_addr } }],
  must_not: [
    { has_id: [selfPointId] },
    { key: 'thread_id', match: { value: inbound.thread_id } },  // NEW
  ],
}
```

Gate behind `RAG_RETRIEVE_EXCLUDE_SAME_THREAD` (default `1`). Reasoning: Gmail inbound bodies on Heron's corpus already include the full quoted reply chain (5320 chars, 8750 chars, 17992 chars on the packets above). The drafter sees that context for free; pulling additional same-thread refs into `rag_refs` is duplication.

### Supporting evidence

- `19bb7fe899f609ca` — refs 1 and 2 both `Re: Soursop Gummies` (same thread); inbound body is 5320 chars and contains the full reply chain. Ref 2's content (`"Hey everyone, what do you need for us to move forward..."`) is already in the inbound's quoted history.
- `19bfc435639d8fc9` — refs 1 and 2 both `Re: LBW Extracts Discussion` (same thread); inbound body is 3720 chars and quotes the prior turn that ref 2 reproduces.
- `19b853053d10bd18` — inbound body is 17992 chars (!) of quoted history. The top ref reproduces the first 200 chars of that body. Pure waste.
- `19c813bde357dc32`, `19c95e5a040c7aaf` — `refs=1` already; same-thread suppression here would empty refs entirely (overlaps with H1's edge case).

### Contradicting evidence

- `19be6b587e3b7d53` (Victor / US Raws) — refs 2 and 3 are *cross-thread* (`Reconnecting for next steps`, `Hybrid: HTC Project US Retail`) and arguably useful for understanding who Victor is. Same-thread suppression doesn't hurt this packet, but the value here is in the *different* threads, suggesting the right rule may be "prefer cross-thread when available, don't strictly forbid same-thread."
- `19a5d5512b6feb1e` (Neurohack Boost) — refs 2 and 3 are cross-thread (`Inquiring about Gummy Offerings`, `Quick Follow-Up on Quote`) and provide the customer's full history. The same-thread top ref is the self-match (caught by H1). After H1, this packet is already cross-thread by accident.

### Estimated dev cost

**S** — one filter clause plus env-var. ~5 LOC.

### Expected eval-Δ direction

**Sideways or slightly up.** Frees k slots for genuinely-novel context, but on packets where the customer has very little prior history with the operator, this can collapse to empty refs (fine — falls through to persona-stub). The directional question — "does Qwen3 produce better drafts with cross-thread customer context vs same-thread duplicates?" — is the kind of thing only an A/B can answer. Stack this with H1 + H2 in the same Phase D run rather than testing in isolation.

---

## H4 — Substantivity gate: skip retrieval when the inbound is too thin to embed meaningfully

**One-line:** When the inbound is empty or near-empty, the embedding is degenerate and retrieval just pulls noise — better to skip RAG entirely and let persona-stub drive.

### The change

In `dashboard/lib/rag/retrieve.ts`, add a length precheck before calling `embedText`:

```ts
const MIN_INBOUND_CHARS = parseInt(process.env.RAG_MIN_INBOUND_CHARS ?? '40', 10);
const stripped = stripQuotedHistory(inbound.body);  // strip "On X, Y wrote:" blocks
if (stripped.length < MIN_INBOUND_CHARS) {
  return { refs: [], reason: 'inbound_too_thin' };
}
```

Add `'inbound_too_thin'` to the `RagRetrievalReason` union. The `stripQuotedHistory` helper should be a focused regex utility (Gmail's quote markers are well-formed) — the goal is "what's the new content the operator is being asked about" not "the entire 17KB thread".

### Supporting evidence

- `19b0ed17519285b1` (Brian Pray / Zeolite COA) — **inbound body is 2 chars (literally `\n`).** Embedding 2 chars produces a noise vector. Top ref still scores 1.000 because there's a backfilled twin with the same 2-char body. With-RAG cosine 0.5284, no-RAG cosine 0.5905 — RAG made it worse on this packet.
- `19bb7fe899f609ca` — inbound body is 5320 chars but only ~95 chars are *new* content (`"No, we will ship the bags to you to be filled. what is the appropriate wording for this?"`); the rest is quoted history. The full-body embed is dominated by the quoted thread, which is why retrieval surfaced same-thread duplicates. After `stripQuotedHistory`, the embed is on the new 95 chars only — sharper signal.
- `19b853053d10bd18` — 17992-char inbound is ~99% quoted history; the new content is `"Usps 9405550105796015487384 Delivered Friday January 02, 01:53PM Saint Petersburg, FL"`. Stripping helps.

### Contradicting evidence

- `19be6b587e3b7d53` (Victor / 372 chars) — inbound is short but full of new content (no quoted history). A naive char-length gate without quote-stripping would mis-flag this. The fix is to apply `stripQuotedHistory` *before* the gate, not raw `body.length`.
- `19c95e5a040c7aaf` (World Tree / 649 chars) — full new content, no quoted history. Length gate has to be after stripping or this packet is wrongly skipped.

### Estimated dev cost

**S–M** — the threshold itself is config-only (S), but a robust `stripQuotedHistory` helper is ~30 LOC plus tests against representative Gmail formats (Apple Mail, Outlook, Gmail web — quote markers vary). Call it M.

### Expected eval-Δ direction

**Up on the tail.** Won't move mean(Δ) much because thin-inbound cases are rare in the corpus, but it eliminates a clear loss bucket (`19b0ed17519285b1` is one of the original 10 outliers — that's not nothing). More importantly, stripping quoted history from the embed input — even without the length gate — should sharpen retrieval relevance for the long-quoted-history cases (`19bb7fe899f609ca`, `19b853053d10bd18`).

---

## H5 — Score-floor cutoff: drop refs below `RAG_MIN_SCORE` after self-filter

**One-line:** Once the self-match is filtered out, the *real* top ref often scores 0.6-0.7 — borderline relevant. Below some threshold, refs hurt more than they help.

### The change

In `dashboard/lib/rag/retrieve.ts`, after the search returns, drop refs with `score < RAG_MIN_SCORE` (default `0.70`):

```ts
const minScore = parseFloat(process.env.RAG_MIN_SCORE ?? '0.70');
const filtered = result.points.filter(p => p.score >= minScore);
```

Combine with H1, H2, H3, H4 — apply the score floor *after* all filters.

### Supporting evidence

- `19ba502acb1edbf5` (Sam's Small Batch) — after H1, the next ref is score 0.690 (`"Sounds good, thanks for the heads up"`) and the one after that is 0.664 from a different product line entirely (Flightmode sleep stack). Both are weak signal. With-RAG cosine 0.6330 vs no-RAG 0.7510 — a 12-point drop, the largest in the inspection set. Suggests low-score refs are *actively misleading* the drafter.
- `19b0ed17519285b1` — refs 2 and 3 score 0.612 and 0.586 respectively, and the latter is from a totally unrelated invoice thread (`"Just to be clear - the order should be for 1,500 units, not 1,000."`). With-RAG cosine 0.5284 < no-RAG 0.5905. Low-score refs hurt.

### Contradicting evidence

- `19be6b587e3b7d53` — refs 2 and 3 score 0.725 and 0.678 and they ARE relevant (different threads with the same customer about ingredient sourcing). A 0.70 floor drops the 0.678 ref but keeps the 0.725. Probably correct, but borderline.
- `19a5d5512b6feb1e` — refs 2 and 3 score 0.816 and 0.665. The 0.665 ref (`"Quick Follow-Up on Quote"`) is genuinely useful customer history. A 0.70 floor drops it. With-RAG cosine 0.8109 was already the second-highest absolute score in the inspection set, suggesting the 0.665 ref wasn't hurting much, and might have been helping.

So the threshold itself is a tuning knob, not a settled answer. Default 0.70 is a reasonable starting point; sweep [0.60, 0.65, 0.70, 0.75] in Phase D.

### Estimated dev cost

**S** — 2 LOC.

### Expected eval-Δ direction

**Up, but heavily dependent on threshold.** The clearest evidence (H4 packet `19b0ed17519285b1`, H5 packet `19ba502acb1edbf5`) is on cases where retrieval was already broken upstream. After H1+H4 fix the upstream issues, the marginal value of the floor is smaller. Treat as a final polish, not a primary lever.

---

## Summary table

| # | Hypothesis | Cost | Expected Δ | Confidence |
|---|---|---|---|---|
| H1 | Filter inbound's own point UUID | S | Up (small, foundational) | High |
| H2 | Bias toward outbound for voice priming | M | Up (moderate) | Medium |
| H3 | Suppress same-thread refs | S | Sideways/Up | Medium-low |
| H4 | Strip quoted history + thin-inbound gate | S–M | Up on tail | Medium-high |
| H5 | Score floor (default 0.70) | S | Polish | Low — sweep needed |

Recommended Phase D order: **H1 first** (clears noise so other hypotheses can be measured), then a stacked run of H1+H2+H4 vs baseline, then sweep H5 threshold, then test H3 in isolation. H2 alone is the highest-EV single change but only tellable with LLM-judge.

---

## Methodology note — is cosine the bottleneck?

Probably yes, at least at the per-packet scale we're tuning at. The 5/10 sign-flip on Phase B re-run with identical retrieval inputs means Qwen3 sampling noise produces draft-vs-reply cosine swings of ±0.10–0.20 that are larger than any of the proposed RAG effects. Stacking this with the synthetic-operator-reply problem (`19ba502acb1edbf5`, `19b853053d10bd18`, `19be35efc56bd858` all had operator replies that were themselves LLM-generated or tool-generated, not human voice) means the eval target itself isn't always a clean signal. Phase D should keep cosine as the cheap A/B but add LLM-judge (Anthropic Haiku 4.5 or Ollama Cloud `gpt-oss:120b` since both are already wired) on the same N samples — judge for "did the draft preserve operator voice / get the right facts / hit the right length." Cosine alone gave us null; adding judge gives us interpretable wins/losses without rebuilding the harness, and lets us validate H2 (voice priming) which cosine fundamentally cannot measure.
