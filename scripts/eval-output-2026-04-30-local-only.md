# MailBOX Zero — drafting quality eval (LOCAL ONLY baseline)

**Generated**: 2026-05-01T02:43:07.965Z
**Test cases**: 4 (reorder, inquiry, scheduling, escalate)
**Models**: Qwen3 local (`qwen3:4b-ctx4k`) — Ollama Cloud + Anthropic deferred to tomorrow's eval (need API keys)

This is the v1 baseline. Re-run `scripts/draft-quality-eval.mjs` with `OLLAMA_CLOUD_API_KEY` and `ANTHROPIC_API_KEY` set in the n8n container env to get the 3-way comparison.

## Headline assessment

- **2/4 drafts are excellent**: reorder, scheduling — concise, picked up specifics, no fabrication
- **1/4 fabricates** (inquiry): made up "Our minimum is 5k" — operator never said that. Persona prompt's "leave a placeholder like [confirm with operator]" instruction was ignored.
- **1/4 over-commits** (escalate): "we will send a replacement shipment today" — this is a commitment without operator approval. Same prompt instruction ignored.

The hallucination risk is real on inquiry/escalate. For inquiry and escalate, the routing rule sends to **cloud** by default (`routeFor` puts both in `CLOUD_CATEGORIES`); a stronger cloud model should handle these better. Recommend keeping the production routing as-is and re-evaluating after the cloud key lands.

Latency consistent at 3-5s — comfortably in the "deliberate, not bot-instant" range Eric+Dustin want.

`/no_think` directive worked cleanly — no `<think>` blocks in any output.

---

## reorder — high signal

**From:** sarah@example-cpg-customer.com
**Subject:** Reorder request — Heron 12oz functional gummies
**Category:** reorder (conf 0.92)

### Inbound

```
Hi Heron Labs team,

We are running low on the 12oz functional gummies SKU (lemon-ginger). We would like to place a reorder for 50 cases on standard PO terms. 3-week lead time works for us.

Standard ship-to is the Otis warehouse.

Thanks,
Sarah Kim
Procurement, Bright Path Wellness
```

### Qwen3 local (qwen3:4b-ctx4k)

*3408ms · in=305 out=50 · $0.000000* — ✅ **Good**

```
Thanks for the reorder request. We’ll process the 50 cases of 12oz functional gummies for shipment to Otis warehouse. Confirm the 3-week lead time and standard PO terms. — Heron Labs
```

---

## inquiry — first-touch

**From:** mike@new-brand.example.com
**Subject:** Manufacturing partner search — chocolate functional bars
**Category:** inquiry (conf 0.88)

### Inbound

```
Hi,

We're a small CPG brand launching a functional chocolate bar (CBD-free, ashwagandha + cordyceps blend) and looking for a co-manufacturer. Targeting 12k units for an initial run, want to scale into the 50k–100k range over 6 months.

Do you take on smaller brands? Pricing range / minimums?

Mike Lin
Founder, Inner Ridge
```

### Qwen3 local (qwen3:4b-ctx4k)

*4593ms · in=315 out=74 · $0.000000* — ⚠️ **Fabricates "5k minimum"**

```
Hi Mike,

We do work with small brands and can handle runs starting at 12k. Our minimum is 5k, so we can accommodate your initial run.

Pricing varies by product and volume, but we’ll provide a quote once we have more details. Want to discuss your product specs and pricing expectations?

— Heron Labs
```

---

## scheduling — sample drop

**From:** jenny@retail-buyer.example.com
**Subject:** Sample drop next Tuesday
**Category:** scheduling (conf 0.91)

### Inbound

```
Hey,

Confirming Tuesday 11am at our Otis store for the gummy samples. Bring 6 SKUs if possible. Parking out front, ring the bell.

Jenny
```

### Qwen3 local (qwen3:4b-ctx4k)

*3145ms · in=263 out=49 · $0.000000* — ✅ **Good**

```
Confirming the sample drop next Tuesday at 11am at Otis. We’ll bring 6 SKUs as requested. Parking is out front, so please ring the bell when you arrive. — Heron Labs
```

---

## escalate — complaint

**From:** angry@customer.example.com
**Subject:** URGENT: damaged shipment, missing units
**Category:** escalate (conf 0.94)

### Inbound

```
Hi,

The PO #4471 shipment arrived this morning with severe water damage on 8 of 24 cases. Photos attached. Need a replacement shipment expedited or a credit issued — we have a major retail launch Monday and customers waiting.

Please escalate.

Mark Reyes
Operations, Lift House Foods
```

### Qwen3 local (qwen3:4b-ctx4k)

*3039ms · in=288 out=47 · $0.000000* — ⚠️ **Over-commits without [confirm with operator]**

```
We’ve reviewed the damage and will send a replacement shipment today. You’ll receive a credit for the damaged units once we confirm the replacement arrives. Let us know if you need anything else. — Heron Labs
```

---

## What to do with this

1. **Get an Ollama Cloud API key** + re-run the eval. The inquiry/escalate hallucinations should improve with gpt-oss:120b. If they don't, try `deepseek-v3.1:671b` or `kimi-k2:1t`.

2. **Optionally add Anthropic Haiku 4.5** as a third reference point — `claude-haiku-4-5` is fully wired in `cost.ts` and the eval script. Just set `ANTHROPIC_API_KEY` in the n8n container env when running.

3. **Tune the persona stub prompt** if hallucinations persist. Current "Never invent facts about products, pricing, or commitments" instruction is too easy for a 4B model to ignore. Strengthen with explicit examples or move the constraint earlier in the prompt.

4. **Routing decision**: the current `routeFor` already sends `inquiry` and `escalate` to cloud — leave that policy as-is until the cloud eval lands.
