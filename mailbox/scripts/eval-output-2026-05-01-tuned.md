# MailBOX Zero — drafting quality eval
Generated: 2026-05-01T10:26:25.751Z
Test cases: 4
Models: Qwen3 local (qwen3:4b-ctx4k), Ollama Cloud (gpt-oss:120b), Anthropic Haiku 4.5

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

*3706ms · in=513 out=48 · $0.000000*

```
Hi Sarah,  

We’re happy to process the reorder for 50 cases of the 12oz functional gummies. Lead time is 3 weeks, which works for you.  

— Heron Labs
```

### Ollama Cloud (gpt-oss:120b)

*2657ms · in=565 out=222 · $0.000615*

```
Hi Sarah,

Thanks for the reorder. We’ll schedule production for 50 cases of the lemon‑ginger 12 oz functional gummies and target a 3‑week lead time to the Otis warehouse.

Please send over the purchase order (or PO number) so we can lock in the schedule. Once we have it, we’ll confirm the exact ship date.

Looking forward to getting these to you.

— Heron Labs
```

### Anthropic Haiku 4.5

*2146ms · in=580 out=84 · $0.001000*

```
Hi Sarah,

Got it — 50 cases of the 12oz lemon-ginger gummies to Otis on standard terms, 3-week window works.

I'm pulling together your PO details now. [confirm with operator: pricing and final ship date once production confirms the slot].

You'll have tracking as soon it ships.

— Heron Labs
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

*3557ms · in=523 out=55 · $0.000000*

```
Hi Mike,

We do work with small brands and can handle runs starting at 12k. Pricing and minimums depend on your specific specs — happy to share once we know more.

Looking forward to discussing your product further. — Heron Labs
```

### Ollama Cloud (gpt-oss:120b)

*4617ms · in=574 out=340 · $0.000797*

```
Hi Mike,

Thanks for reaching out. We love working with emerging brands and can handle a 12 k‑unit launch with room to scale. Our minimum order for a custom functional bar is [confirm with operator: MOQ], and pricing depends on the exact formulation, packaging, and volume—happy to share a quote once we have those details. Lead time is currently [confirm with operator: production calendar].

Could you send over the formulation sheet (ingredients, target shelf life, packaging format) and any labeling requirements? That’ll let us put together a clear proposal.

Looking forward to collaborating.

— Heron Labs
```

### Anthropic Haiku 4.5

*2635ms · in=578 out=139 · $0.001273*

```
Hey Mike,

We work with smaller brands — that's our sweet spot. Your volume trajectory (12k initial, scaling to 50–100k) is right in our wheelhouse.

For functional chocolate bars with your spec, we'd need to confirm a few things: exact format (bar size, weight, packaging), your timeline for the initial 12k run, and whether you have formulation locked or need development support. Lead time and pricing both depend on those details.

Happy to move fast here. Can you share your target launch date and whether the ashwagandha + cordyceps blend is finalized?

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

*2814ms · in=471 out=43 · $0.000000*

```
Confirming the sample drop next Tuesday at 11am at Otis store. Will bring 6 SKUs if possible. Parking out front, ring the bell. — Heron Labs
```

### Ollama Cloud (gpt-oss:120b)

*3401ms · in=524 out=192 · $0.000550*

```
Hi Jenny,

Thanks for confirming. We'll be at the Otis store Tuesday at 11 am with the six gummy SKUs. We'll park out front and ring the bell.

Looking forward to it.

— Heron Labs
```

### Anthropic Haiku 4.5

*956ms · in=526 out=47 · $0.000761*

```
Perfect — I'll be there Tuesday at 11am with 6 SKUs. Otis store, front parking, I'll ring the bell.

Looking forward to it.

— Heron Labs
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

*4705ms · in=496 out=76 · $0.000000*

```
We’ve noted the damaged shipment and the urgent need for a replacement. I’ll get a replacement shipment moving — [confirm with operator: ship date once warehouse confirms]. Also, we’ll issue a credit for the damaged units — [confirm with operator: credit amount once warehouse confirms]. Let me know if there’s anything else you need. — Heron Labs
```

### Ollama Cloud (gpt-oss:120b)

*6789ms · in=548 out=445 · $0.000941*

```
Hi Mark,

Thanks for letting us know—sorry about the water damage. We’ve escalated this and are pulling the shipment details.

We can send a replacement for the 8 affected cases on an expedited basis. I’ll confirm the earliest ship date once the warehouse checks inventory — [confirm with operator: expedited ship date]. If you’d rather receive a credit, just say the word and we’ll process it right away.

Could you confirm the shipping address you’d like the replacement sent to, and let us know if any other cases were impacted? If the photos didn’t come through, please resend them so we have the full record.

We’ll keep you updated and aim to have this resolved well before your Monday launch.

— Heron Labs
```

### Anthropic Haiku 4.5

*2767ms · in=559 out=150 · $0.001309*

```
Mark,

I'm pulling up PO #4471 now and seeing your photos — that's rough, especially with Monday's launch. Water damage on 8 cases is unacceptable.

Here's what I'm doing:

1. [confirm with operator: current status of replacement stock and ship date for expedited shipment to Mark]
2. [confirm with operator: whether to issue partial credit now or wait for return/inspection]

I'll have a concrete answer on both within the hour. In the meantime, if you can tell me which specific products were damaged, I can flag any inventory issues on our end.

We'll make this right.

— Heron Labs
```

