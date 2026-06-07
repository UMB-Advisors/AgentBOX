---
marp: true
theme: default
paginate: true
class: invert
---

<!-- Pitch deck — thUMBox seed/angel raise -->
<!-- v0.1.0 · 2026-05-31 · Dustin Powers -->
<!-- Export: `marp pitch-deck-thumbox-v0_1_0-2026-05-31.md -o thumbox-pitch.pdf` -->

## TL;DR

7-slide investor deck for thUMBox following the canonical YC compressed structure (Cover / Problem / Solution / Why Now / Traction / Business / Team+Ask). Positioning copy is anchored to the live marketing site (`thumbox-website.vercel.app`): "Own the economics. Own the data." Traction is factual to 2026-05-31 (2 live paying customers, MailBOX shipping, second hardware product in qualification). The Ask slide is left as a placeholder for Dustin to fill in (raise size + use-of-funds).

---

# thUMBox

### Local-first edge AI appliances for small business.

**Own the economics. Own the data.**

Dustin Powers — Founder
A UMB Group division
2026 · Seed round

<!-- speaker: One sentence — what we are. We sell a box that runs an AI employee for a small operator. It lives on your network, learns your business, and isn't billed by the token. -->

---

# The cloud AI deal is broken.

A small business operator loses **1–3 hours a day** to email. The cloud AI fix renting itself to them charges by the use, by the seat, by the future price hike — and trains on the conversation while it's there.

| The cloud deal | What it costs an operator |
|---|---|
| Metered by the token | Runaway bills the moment AI works |
| Every prompt may be logged | Customer data joining a training set |
| Models change under you | The agent you tuned isn't the one you wake up to |
| Access is a privilege | One policy shift away from being switched off |

**A small business can't bet operations on infrastructure it doesn't own.**

<!-- speaker: The fight is real and recent. Operators are flinching at AI bills they can't predict and at privacy posture they can't audit. The buyer we're talking to has tried Copilot/ChatGPT, hit the cost or the privacy wall, and is now actively shopping for an exit. -->

---

# thUMBox: a box that runs an AI employee.

**Plug in the box. Connect your inbox. Approve replies as they queue.**

- **One purchase, no token bill.** $599 Jetson Orin Nano Super (8 GB / 67 TOPS / <25 W). Inference runs on the box; the meter never starts.
- **Your data stays on the box.** Email content lives only on the device on the operator's network. Nothing harvested, nothing trained on.
- **MailBOX is the first personality pack.** Reads inbound, classifies, drafts replies in the operator's voice. The operator approves. The box sends.
- **More packs coming.** receptionBOX, salesBOX, financeBOX, calendarBOX, inventoryBOX. Same box, more white-collar jobs done.
- **Three ways in.** Buy a box. Bring your own hardware (free Community plan). Phones as fleet nodes (early access).

<!-- speaker: Demo line: we have a 30-second walkthrough of the live dashboard — inbox queue, draft review, voice tuning — at the URL on the cover. Two customers approve and send through this UI every day. -->

---

# Why now.

**Three lines crossed.**

1. **Edge silicon got cheap enough.** A $599 Jetson Orin Nano Super runs a 4-billion-parameter model with multi-second latency and zero marginal cost per request. That number was $10K two years ago.

2. **Open-weight models caught up for routine work.** Qwen3-4B, gpt-oss, Llama 3.x — all production-viable for classification + drafting in a business voice. The frontier-class model is no longer the only model that works.

3. **The cloud AI bill is showing up.** SaaS operators are now seeing five-figure monthly bills for OpenAI/Anthropic usage they assumed would be cheap. Privacy-conscious verticals (legal, healthcare, manufacturing, CPG) are explicitly shopping for an on-prem alternative — but won't run a homelab themselves.

**thUMBox is the productized version of "host your AI yourself."** Boxed, supported, installed, and managed — by someone other than the customer.

---

# Traction.

**Two live paying customers · MailBOX in production · second hardware product through spike.**

| Customer | Vertical | Live since | Status |
|---|---|---|---|
| **Heron Labs** | CPG / small-batch gummy mfg | 2026-04 | MailBOX live · classifying ~10–50 inbound/day · drafting in operator's voice |
| **Staqs** | B2B / dev tools | 2026-05-05 | MailBOX live · per-account voice bootstrap · multi-account ready |

**Shipped in 4 months (5 milestones, 40+ epics):**
operator dashboard · n8n classification + draft + send pipeline · OTA updates via GHCR · daily operator digest · VIP-sender + urgency engine · voice tuning UI · per-account voice bootstrap · multi-account inbox registry · account-scoped knowledge base + chat · llama.cpp T2 inference cutover

**Capital efficiency:** Phase 1 total spend = **$800** (1 unit + cloud API). Two paying customers and a full operational stack out of that.

**Second product** (OpenClaw — talk-to private assistant) spike GREEN'd 2026-05-30 → production qualification next.

<!-- speaker: The two customers are not friendly favors. Heron is where the founder is fractional COO — he uses MailBOX every workday. Staqs is a paying second customer who installed remotely. The 4-month / 40-epic / $800 line is the proof point — this isn't a vapor pitch, it's a shipped product looking for the next 50 customers. -->

---

# Business model.

**Hardware + recurring membership + cloud usage at margin.**

| Layer | Price | Margin profile |
|---|---|---|
| **MailBOX box** | $599 one-time · 1 year Base included | Near-zero — pass-through |
| **Membership ladder** | Community $0 → Base $29/mo → Plus / Pro / Enterprise | ~85% gross (software + updates + support) |
| **Cloud-route usage** | Pooled Anthropic / Ollama Cloud key, cost + 20% | 20% on infrastructure pass-through |
| **White-glove install** | Per-engagement (Staqs customer #2 = remote install) | ~50% — services |

**Anchored ARPU year 1: ~$948** (box + 12 months Base). Climbs as personality packs ship — same box, more jobs, higher tier.

**Compounding moat per customer.** The box learns the operator's voice, their accounts, their KB. Switching cost grows monthly. Every pack adds another job the box does that a competitor would have to re-tune from scratch.

**Hardware-agnostic.** Customers who bring their own hardware (BYOH path) pay $0 hardware and start on Community — same upgrade ladder. The platform is the asset, not the silicon.

---

# Team + ask.

**Dustin Powers — Founder**
Operator background: fractional COO at Heron Labs · founder of Glue Co + UMB Crew (multi-entity ops + AI advisory) · 7-entity CPG/AI portfolio including STATE, Krunchy Kids, CDE Ingredients, Future Compounds. Built thUMBox v1 to ship two live customers and 40+ epics in 4 months on a $800 budget.

**Customer-design partners**
**Heron Labs** (CPG operator · CMO) — co-architected MailBOX from his own daily inbox.
**Staqs** (B2B SaaS · CEO) — second install, paid + remote-installed, drove multi-account + per-account voice.

**Operating infrastructure**
UMB Group provides ops backbone (legal, finance, comms). Glue Co holds the pooled cloud-API economics. Both already exist and operate.

---

**Ask: [PLACEHOLDER — fill]**

- **$[X] for [Y] months runway** at the current burn rate of ~$[Z]/mo.
- **Use of funds:** hardware inventory + assembly run · production of OpenClaw (second hardware product) · 3 personality packs to LIVE (receptionBOX, financeBOX, calendarBOX) · field engineering for fleet (phones as worker nodes) · target = **10 paying customers by end of year, 25 by Q2 next year**.
- **Why this is a fit for you:** [investor-specific paragraph — operator-led, capital-efficient, multi-product platform on emerging edge-silicon substrate, sovereignty wedge].

**Contact:** Dustin Powers · dustin@umbadvisors.com · [thumbox-website.vercel.app](https://thumbox-website.vercel.app)

<!-- speaker: The ask is the slide that comes from a meeting with the investor, not from the deck. Fill it the morning of the pitch. -->
