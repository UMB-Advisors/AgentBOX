# Style Vectors vs. LoRA — Decision Memo v0.1.0

**Tracks:** MBOX-118 (M5 style-vector spike). Parent: MBOX-111 / STAQPRO-336 (M5 draft-quality roadmap). Sibling decision: STAQPRO-344 (per-customer LoRA). Blocked by STAQPRO-338 (llama.cpp on T2 — the only path with hidden-state hooks) and STAQPRO-340 (eval harness / §5.8 trace set, the measuring stick).

## TL;DR

**Recommendation: stack both, but gate LoRA behind the style-vector spike.** Run the MBOX-118 spike to completion first; if style vectors clear the bar (>=15 t/s on T2 and blind-pref win rate at parity with or above the base model), ship them as the Phase 2 personalization wedge and *defer* STAQPRO-344 LoRA to a Phase 3+ premium tier rather than building it now. The one-line reason: style vectors plausibly capture the bulk of the per-customer *voice* signal at roughly 5% of LoRA's engineering and operational cost, and the only thing standing between us and that 4-8 week reallocation is a 1-2 week feasibility test we have not yet run on-device.

## Background — the structural claim

Per-customer writing style can be represented as a **single vector** in the model's hidden-activation space. The vector is computed contrastively: generate generic model drafts on the customer's real inbound emails, capture the hidden activations, and contrast them against the activations produced by the customer's *authentic approved replies* on the same inbounds. The difference between those two activation distributions — generic-voice minus customer-voice — *is* the style direction. At inference, the vector is added to a chosen layer's activations during decoding (scaled by a steering coefficient lambda; lambda=0 disables it entirely).

The consequence is the whole point: **no fine-tuning, no per-user model weights, one vector per customer measured in kilobytes.** Onboarding a customer becomes "compute a vector from their sent folder" rather than "schedule a multi-hour training job once enough approved drafts accumulate."

Two refinements from the literature bear on implementation:

- **StyleVector** (Zhang et al., 2503.05213) — the naive contrastive approach: vector derived from contrasting all of the user's authentic outputs against generic outputs.
- **SteerX** (2510.22256) — flags that a vector trained on *all* user data underperforms one derived only from the **preference-driven tokens** in the user's history (a token-causal-effect refinement). The spike should evaluate both the naive and the SteerX-refined variant.
- **Activation Steering Field Guide** (Mitra, Feb 2026) — the authoritative map of what the technique does and does not do well (see below).

## Comparison — LoRA (STAQPRO-344) vs. Style Vectors

| Dimension | LoRA pipeline (STAQPRO-344) | Style Vectors (MBOX-118) |
|---|---|---|
| Training compute | 4-8 hours per customer per retrain | Minutes — effectively a single forward pass per training pair |
| Storage per customer | 30-50 MB adapter | A few KB per vector |
| Inference overhead | Hot-swap cost; LoRA layer added to every decode | One vector addition per decode step (negligible) |
| Onboarding latency | ~50 approved drafts before first adapter | Potentially day-1, off sent-folder ingest |
| Quality ceiling | Higher in principle (full weight space) | Lower in principle (single direction) |
| Tooling maturity | Production-ready in llama.cpp + Unsloth | Requires custom decoder hooks; not a flag — the open risk |
| Reversibility | Swap adapter out | Trivial — lambda=0, single file |

The two paths are not strictly either/or. The honest framing is a quality-vs-cost frontier: LoRA buys a higher ceiling at a large and recurring cost (compute, storage, an onboarding-latency wall, and a retrain treadmill); style vectors buy most of the *voice* lift for almost nothing, day one. If the spike shows style vectors capture 80%+ of the personalization signal at 5% of the cost, building LoRA *first* is a misallocation.

## What activation steering does well — and where it fails

The Mitra field guide is explicit, and the split maps almost perfectly onto the email-drafting use case:

| Activation steering is good at | Activation steering is bad at |
|---|---|
| Formality, register, tone | Factual recall |
| Sentiment | Complex / multi-step reasoning |
| Sign-off style, greeting conventions | Content accuracy |
| Refusal / boundary patterns | Anything requiring grounded knowledge |

This is the crux of why the technique is acceptable here despite its failure modes. **Personalization in this product is a voice problem, not a content problem.** Content accuracy is *not* the steering vector's job and never was — it stays with (a) the base model, (b) RAG context (counterparty-scoped recall per STAQPRO-191), and (c) skills. The drafter already treats RAG as augmentation that falls back to a persona stub on any non-`ok` retrieval reason; a style vector layered on top does not touch that contract. So the documented weaknesses of activation steering land precisely on the responsibilities we have already assigned elsewhere, and its strengths land precisely on the thing LoRA would otherwise be carrying.

## The blocking feasibility question

The technique is well-supported in research code. The problem is the production runtime: **llama.cpp does not expose hidden-state injection as a flag.** There is no `--add-activation-vector`. Getting the vector into the decode loop on T2 requires one of three paths, each with a different cost:

| Path | Pro | Con |
|---|---|---|
| Fork llama.cpp with the hook | Native t/s; clean inference path | Maintenance burden — we own a patched fork against upstream churn |
| Python wrapper (transformers / exllama) | Hooks are first-class; fastest to prototype | t/s cost on Jetson; diverges from the production llama.cpp path |
| Small C++ plugin into llama.cpp | Integrates cleanly; keeps native runtime | Most engineering effort; least-proven approach |

This is the single biggest unknown and the spike's first deliverable must answer it: **can we inject the vector on T2 hardware without losing 30%+ of throughput?**

**Kill criterion (hard):** inference drops **below 15 t/s** (the SM-60 floor, identical to the DR-21 throughput gate) — the approach is dead on M1-class hardware regardless of quality. Secondary kill criteria: blind-pref win rate materially below the base model alone, or llama.cpp integration infeasible without a fork whose maintenance burden exceeds the LoRA pipeline it would replace.

**In-repo prototype status.** The Python-side prototype (under `optimization/style-vectors/`) is intended to *prove the method* — that the contrastive vector exists and shifts voice on the §5.8 trace set — using a hookable runtime where injection is trivial. That is necessary but not sufficient: a green Python result does **not** clear the gate. The load-bearing open question is the **on-device T2 t/s number** through the production llama.cpp path, which the Python prototype cannot answer. Treat the prototype as method-validation and the on-device throughput probe as the actual go/no-go.

## Recommendation and follow-up shape

1. **Run MBOX-118 to a verdict before committing STAQPRO-344 engineering.** The spike is cheap (1-2 weeks) relative to what it gates (4-8 weeks of LoRA work).
2. **Sequence the spike feasibility-first:** (i) prove on-device injection clears 15 t/s on T2; only then (ii) measure blind-pref win rate (base vs. base+StyleVector vs. base+SteerX) against the §5.8 trace set; (iii) if STAQPRO-344 has progressed, add base+LoRA as a third arm.
3. **If the spike succeeds:** ship style vectors as the Phase 2 personalization wedge; reduce STAQPRO-344 to a Phase 3+ premium-tier capability rather than the Phase 2 default. Open a productization ticket scoped to: per-customer vector compute on onboarding off the sent-folder backfill; vector storage + lambda config in `mailbox.persona` (or a sibling table); the chosen llama.cpp injection path hardened from prototype to production; an operator-visible lambda override consistent with the existing persona-override fallback chain.
4. **If the spike fails the t/s gate:** style vectors are dead on current hardware — revert to STAQPRO-344 LoRA as the Phase 2 path and revisit style vectors when M5-class 16GB+ hardware lands.

## Maturity / risk profile

- **Maturity:** recent academic (2025-2026), code released, not yet productized anywhere found — first-mover position available.
- **Reversibility:** trivial. lambda=0 disables; the vector is a single file.
- **Bus-factor risk:** academic origin, single primary author per paper — typical activation-engineering project trajectory; weigh against owning a llama.cpp fork.

## References

- StyleVector — Zhang et al., "Personalized Text Generation with Contrastive Activation Steering," arXiv 2503.05213
- SteerX — "Disentangled Steering for LLM Personalization," arXiv 2510.22256
- Activation Steering Field Guide — Mitra, Feb 2026
- DLR-SC/style-vectors-for-steering-llms (reference implementation, GitHub)
