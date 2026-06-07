# MailBOX Zero — drafting eval after prompt + routing tune

**Date**: 2026-05-01 morning (post-tune)
**Eval input**: `scripts/eval-output-2026-05-01-tuned.md` (4 cases × 3 models)
**Vs baseline**: `scripts/eval-output-2026-05-01-3way.md` (untuned, same morning)
**Question**: did the strengthened persona prompt + inquiry→local routing change Qwen3's behavior on the failure cases?

## TL;DR

**Yes — the prompt tune worked.** All three models now produce conservative, placeholder-using replies on the inquiry test instead of fabricating facts. Qwen3:4b is now genuinely viable for the local-default of inquiry.

The routing change (move `inquiry` from `CLOUD_CATEGORIES` to `LOCAL_CATEGORIES`) is safe to ship.

## Headline diff: inquiry case

The same Mike-from-Inner-Ridge inquiry that exposed the fabrication bug yesterday:

| Model | OLD (yesterday) | NEW (with strengthened prompt) |
|---|---|---|
| Qwen3:4b | "Our minimum is **5k**, so we can accommodate your initial run." ⚠️ **invented 5k** | "Pricing and minimums depend on your specific specs — happy to share once we know more." ✅ defers properly, no fabrication |
| gpt-oss:120b | "Our minimum order is typically **10k units** ... pricing $[X]–$[Y] per unit" ⚠️ **invented 10k + price template** | "Our minimum order for a custom functional bar is **[confirm with operator: MOQ]**, ... lead time is currently **[confirm with operator: production calendar]**" ✅ uses placeholders the prompt asked for |
| Haiku 4.5 | "We're a small-batch operator ourselves, **not a co-manufacturer**" — declined the framing entirely | "We work with smaller brands — that's our sweet spot ... lead time and pricing both depend on those details" — asks specific scoping questions |

Qwen3 still has the LEAST domain reasoning (doesn't catch the "small-batch operator vs co-manufacturer" misframing the way Haiku did), but it no longer **invents** specifics. That's the bar that matters for an operator-reviewed draft pipeline: a deferral can be approved or edited; a fabrication has to be *spotted* before send.

## Other categories — quick check

- **reorder**: all 3 still good; Qwen3 includes `[confirm with operator]` placeholder consistently (even on facts the customer provided — slight overcorrection, see prompt's "if the customer gave you the fact, restate it" clause)
- **scheduling**: terse confirmations across all 3, unchanged. Haiku fastest at 1.3s.
- **escalate**: all 3 properly use placeholders for ship dates / credits now. Qwen3 still slightly less careful than Haiku/gpt-oss but no over-commitments observed in this run.

## Numbers (per draft)

| Model | Latency p50 | Cost (tuned eval) |
|---|---|---|
| Qwen3:4b local | 3.4s | $0 |
| gpt-oss:120b cloud | 3.6s | $0.0008 |
| Haiku 4.5 cloud | 2.0s | $0.0013 |

(Haiku cost now correct after fixing the PRICING-key lookup in the eval script — was reading $0 because the label "Anthropic Haiku 4.5" didn't include "claude-haiku-4-5-20251001".)

## What this validates

1. **Routing tune is safe to ship**: `inquiry` moves to LOCAL. Confidence floor (<0.75 → cloud) stays as the safety net for genuinely ambiguous mail.
2. **Persona prompt is doing real work**: explicit BAD/GOOD example pairs lift compliance across all 3 models. Worth the extra ~250 prompt tokens.
3. **Cloud spend at typical 100-emails/day customer drops further**: only `escalate` + `unknown` (<0.75 conf) route cloud. Estimate: ~$3-5/mo per customer cloud spend (vs ~$15/mo when inquiry was cloud).

## What's NOT yet validated

- Long-tail customer mail (the eval is 4 hand-picked cases). Production data will surface edge cases the synthetic eval doesn't.
- Persona-specific quality (the persona stub is generic Heron Labs; customer #2 will need a real persona). Plan 02-06 unblocks this.
- Confidence floor calibration (`< 0.75 → cloud`). Worth re-checking once production classification logs accumulate.

## Recommendation

**Ship as-is.** The local-default-with-cloud-safety-net architecture is now well-tuned. Revisit the cloud-default-model question (gpt-oss vs Haiku) only if production data shows escalate/unknown drafts failing.
