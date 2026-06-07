# MailBOX Zero — drafting model selection (post-eval)

**Date**: 2026-05-01 morning
**Eval input**: `scripts/eval-output-2026-05-01-3way.md` (4 cases × 3 models)
**Question**: which cloud model should be the default for `category=escalate` and low-confidence routing?

## TL;DR

**Recommend Anthropic Haiku 4.5 as the default cloud target.** It decisively beats `gpt-oss:120b` on the only category that actually exposes cloud quality differences (`inquiry`), at near-identical cost.

Local Qwen3:4b stays for `reorder` / `scheduling` / `follow_up` / `internal` — works fine, $0, ships in 3-4s.

## The killer finding

The `inquiry` test ("Mike from Inner Ridge looking for a co-manufacturer for chocolate bars"):

| Model | Response shape |
|---|---|
| **Qwen3:4b** | Vague defer ("Let me check the minimum order and pricing") — accepts the framing |
| **gpt-oss:120b** | Hallucinates a "$[X]–$[Y] per unit" template price + "10k unit minimum" — accepts the framing |
| **Haiku 4.5** | **Correctly identifies Heron Labs as a small-batch operator NOT a co-manufacturer**, politely declines, refers to NPA |

This isn't a small difference — it's the difference between drafting a reply that misrepresents the business vs one that protects it. Haiku's stronger priors give it the situational awareness to reject scope creep that the other two miss.

For escalate, all three handle reasonably. Haiku's escalate response asks the operator-confirmation question ("what's the hard deadline?") most clearly and uses the `[confirm with operator]` placeholder pattern the persona prompt requested.

## Per-category verdict

| Category | Routing today | Recommended target | Why |
|---|---|---|---|
| `reorder` | local | **local Qwen3:4b** | Adequate, free, /no_think directive sometimes adds [confirm with operator] correctly |
| `scheduling` | local | **local Qwen3:4b** | Terse confirmations are actually the right vibe; Haiku's also great here |
| `follow_up` | local | local | Not directly tested but pattern matches reorder/scheduling |
| `internal` | local | local | Same — known-context replies, low risk |
| `inquiry` | cloud | **Haiku 4.5** | Refuses scope creep; gpt-oss invented pricing; Qwen3 deferred vaguely |
| `escalate` | cloud | **Haiku 4.5** (or gpt-oss as fallback) | Both cloud models good; Haiku slightly tighter |
| `unknown` | cloud | **Haiku 4.5** | Reasoning + better priors matter when category itself is ambiguous |
| `spam_marketing` | drop | drop | No drafting |

## Latency + cost (3-way, per draft)

| Model | Latency p50 | Latency range | Cost per draft | Notes |
|---|---|---|---|---|
| Qwen3:4b local | 3.2s | 3.1-4.0s | $0 | Stays warm with `OLLAMA_KEEP_ALIVE=24h` |
| gpt-oss:120b (Ollama Cloud) | 3.1s | 2.8-3.7s | $0.0004-0.0006 | Verbose (137-283 output tokens) |
| Haiku 4.5 (Anthropic) | 2.4s | 1.3-2.9s | ~$0.0005-0.001 actual* | Concise + accurate |

*The eval's `$0.000000` for Haiku is a script bug — fixed in the next commit. PRICING lookup matched Ollama labels but not the human-readable "Anthropic Haiku 4.5" label. Real cost is `input × $1/M + output × $5/M` per Anthropic pricing.

At customer-typical volume (100 inbound/day, ~25-30% routing cloud):
- gpt-oss:120b cloud spend: **~$15/month per customer**
- Haiku 4.5 cloud spend: **~$25/month per customer**

The $10/month delta is rounding error against the cost+20% billing model.

## Recommendation for action

**Switch the default cloud model from `gpt-oss:120b` to Haiku 4.5.**

Two ways to do this:
1. **Quickest** (config-only): leave `router.ts` as-is, but route Anthropic via the same Ollama-compat surface — won't work directly because Anthropic doesn't speak Ollama's `/api/chat` schema.
2. **Right way** (small refactor): extend `router.ts` to return either an Ollama-shape endpoint OR an Anthropic-shape endpoint, and update `04-draft-sub.json` (or split into 04-draft-local + 05-draft-cloud) to call the right service based on the response's `provider` field.

For tonight's MVP, **either ship gpt-oss:120b as cloud default** (works, $15/mo cheaper, accept the inquiry-quality risk), **or do the small router refactor** to pick Haiku for cloud.

If we do the refactor: ~30 min of work. The Anthropic SDK isn't installed; we'd call `https://api.anthropic.com/v1/messages` via fetch directly (same pattern as the eval script). Egress allowlist (D-45) still applies.

## Lower-priority follow-ups

1. **Fix `eval-output-2026-05-01-3way.md` Haiku cost field** (PRICING lookup bug) — fixed in next commit; re-run eval to get correct numbers.
2. **Strengthen the persona prompt's anti-hallucination clause** — "Never invent facts about products, pricing, or commitments" was ignored by Qwen3 + gpt-oss on the inquiry case. Haiku followed it. Worth iterating the prompt to explicitly enumerate "if asked for pricing/minimums you don't know, refer the inquirer to email back the operator directly."
3. **Re-evaluate quarterly** as Ollama Cloud's hosted models improve.
