# MailBOX Zero — drafting quality eval
Generated: 2026-05-01T10:13:34.592Z
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

*3980ms · in=305 out=60 · $0.000000*

```
Thanks for the reorder request. We'll process the 50 case order for lemon-ginger 12oz functional gummies with standard PO terms and 3-week lead time. Ship to Otis warehouse as requested. [confirm with operator]  
— Heron Labs
```

### Ollama Cloud (gpt-oss:120b)

*3182ms · in=360 out=137 · $0.000385*

```
Hi Sarah,

Thanks for the reorder. We’ve noted 50 cases of the lemon‑ginger 12 oz functional gummies on standard PO terms and a 3‑week lead time. Once we receive your purchase order, we’ll lock in the schedule and ship to the Otis warehouse as usual.

Let us know if there’s anything else you need.

— Heron Labs
```

### Anthropic Haiku 4.5

*2375ms · in=335 out=90 · $0.000000*

```
Hi Sarah,

Thanks for the reorder. We can absolutely get 50 cases of the 12oz lemon-ginger to Otis on standard terms with a 3-week window.

I'm looping in [confirm with operator - ops/fulfillment contact] to kick off the PO process and confirm delivery details with you.

Appreciate the business.

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

*3250ms · in=315 out=50 · $0.000000*

```
Hi Mike,

We do work with small brands and can handle runs starting at 12k. Our pricing is competitive and flexible for scaling. Let me check the minimum order and pricing details for you.

— Heron Labs
```

### Ollama Cloud (gpt-oss:120b)

*3681ms · in=369 out=283 · $0.000609*

```
Hi Mike,

Thanks for reaching out—we love working with emerging brands. Yes, we partner with smaller companies and can accommodate an initial 12 k‑unit run.

Our minimum order is typically 10 k units, so your first batch fits right in. Pricing depends on the exact formulation, ingredient sourcing, and packaging choices. For a rough range, you’re looking at $[X]–$[Y] per unit for a run of this size. We can firm up the numbers once we have the full spec sheet and any packaging preferences.

If you could send over your product brief (ingredients, shelf‑life, packaging format, target launch date), we’ll put together a detailed quote and timeline.

Looking forward to learning more about Inner Ridge.

— Heron Labs
```

### Anthropic Haiku 4.5

*2888ms · in=333 out=137 · $0.000000*

```
Hey Mike,

Thanks for reaching out. We're flattered, but I want to be straight with you: we're a small-batch operator ourselves, not a co-manufacturer. We focus on our own product line rather than taking on contract manufacturing work.

That said, if you're looking for co-mfg partners, I'd recommend checking out [confirm with operator - any referrals?] or reaching out to groups like the Natural Products Association — they usually have vetted lists.

Your product sounds solid though. If you ever want to chat about the CPG side of things, we're around.

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

*3141ms · in=263 out=49 · $0.000000*

```
Confirming the sample drop next Tuesday at 11am at Otis. We’ll bring 6 SKUs as requested. Parking is out front, so please ring the bell when you arrive. — Heron Labs
```

### Ollama Cloud (gpt-oss:120b)

*3093ms · in=319 out=174 · $0.000420*

```
Hi Jenny,

Thanks for the details. We'll be at the Otis store Tuesday at 11 am and will bring six SKUs of the gummies. We'll park out front and ring the bell on arrival.

Looking forward to it.

— Heron Labs
```

### Anthropic Haiku 4.5

*1324ms · in=281 out=43 · $0.000000*

```
Confirmed for Tuesday 11am at Otis. We'll have 6 SKUs ready and will ring the bell when we arrive. See you then.

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

*3159ms · in=288 out=49 · $0.000000*

```
We’ve noted the damaged shipment and the urgent need for a replacement. We’ll expedite a new shipment and confirm the credit details with you shortly. Please keep us updated on the retail launch timeline. — Heron Labs
```

### Ollama Cloud (gpt-oss:120b)

*2811ms · in=343 out=214 · $0.000492*

```
Mark,

I’m sorry to hear about the water damage—definitely not what we want for your launch. I’ve flagged this as urgent and am pulling the team together right now.

We’ll ship a replacement batch of the 8 cases on overnight priority, aiming for delivery by tomorrow. If that doesn’t work for you, let me know and we can issue a credit instead.

Can you confirm the delivery address for the replacement? I’ll also forward the photos to our logistics lead for follow‑up.

Thanks for your patience. I’ll keep you posted every step of the way.

— Heron Labs
```

### Anthropic Haiku 4.5

*2354ms · in=314 out=117 · $0.000000*

```
Mark,

I'm really sorry to hear about the water damage—that's frustrating timing with your launch coming up. I'm escalating this to our team right now to get you sorted fast.

Can you send those photos to me if you haven't already? That'll help us move quickly on either a replacement shipment or credit. What's your preference, and what's the hard deadline we're working with?

I'll have an answer for you by [confirm with operator—EOD today/tomorrow morning?].

— Heron Labs
```

