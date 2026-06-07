# AgentBOX — Business PRD (Pricing, Tiers, Packs, Upsell)

> **v0.1.0 · 2026-06-07 · DRAFT for review**
> Owner: Dustin · Tracks: UMB-114 · Companion to the [Positioning One-Pager](./thumbox-positioning-onepager.v0.1.0.md)
> This is the "business PRD" that every technical PRD (ResearchBOX, financeBOX, ReceptionBOX) defers to and that did not previously exist.

## TL;DR

AgentBOX is sold as **hardware (own it) + a platform subscription + per-Pack subscriptions.** One box, tiered by local-model capability (**Core / Pro / Max / Enterprise**). Packs are the recurring revenue and the upsell. Land with one Pack (usually Email), expand as the shared on-box knowledge graph makes each additional Pack more valuable.

> ⚠️ **All prices below are PROPOSED and ILLUSTRATIVE** — placeholders to anchor a pricing exercise, not validated offers. Each carries a rationale; none should ship without a COGS + margin + market-comp pass (see §9, §10).

## 1. Goals / Non-goals

**Goals**
- Define one coherent commercial model for the whole family (replaces the implicit "separate boxes" model).
- Make the upsell motion explicit: how a customer goes from one Pack to many.
- Give every technical PRD a home for pricing/tier/SKU decisions.

**Non-goals**
- Final price points (needs COGS + comps). - Channel/reseller economics (separate doc). - Multi-tenant billing internals (future).

## 2. Offer architecture

A customer purchase has three components:

| Component | What | Billing | Notes |
|---|---|---|---|
| **The box** | An AgentBOX appliance in a tier | One-time (or financed) hardware | Customer owns it; data-residency story |
| **Platform subscription** | OS/updates, support, security, **pooled cloud inference** | Recurring (per box) | Cloud inference billed **at cost + 20%** (existing Glue Co model) |
| **Packs** | Capability + Persona Packs | Recurring (per Pack, per box) | The upsell; some require a min tier |

## 3. Hardware tiers (the box)

Tiers differ by **local-model capability** and **concurrent Pack budget** — the real axis, not artificial feature locks.

| Tier | Hardware class (illustrative) | Local model class | Good for | Proposed hardware | Proposed platform/mo |
|---|---|---|---|---|---|
| **Core** | Jetson Orin Nano Super 8 GB | ~4B (qwen3:4b) | Email + 1–2 Persona Packs, single user | **$499–699** | **$99–149** |
| **Pro** | Orin NX 16 GB / Mac mini M4 24 GB | ~14B class | Research/Finance depth, voice-capable, multi-Pack | **$1,299–1,699** | **$199–299** |
| **Max** | 32–64 GB class | ~30–70B class | Heavy concurrent Packs, deeper local reasoning, less cloud | **$2,999+** | **$399+** |
| **Enterprise** | Rack / multi-node | tiered | Multi-account, reseller/advisor channel | Custom | Custom |

*Rationale:* hardware bands track BOM (Core Jetson ~$350 BOM → ~$500–700 retail; Pro Mac/NX ~$800–1k BOM; Max higher). Platform/mo covers support + updates + the cloud-inference pool overhead. **Validate against actual BOM + target gross margin (§9).**

## 4. Pack catalog

Two grades, one install mechanism (see §6). Capability Packs add a use-case app; Persona Packs add a role overlay.

| Pack | Grade | Min tier | Status | Proposed price/mo |
|---|---|---|---|---|
| **Email** (MailBOX) | Capability | Core | Shipped | **$99–149** (or bundled into platform — see Open Q) |
| **Sales Agent** | Persona | Core | Spec'd this milestone | **$39–79** |
| **Research** (ResearchBOX) | Capability | Pro (depth scales w/ tier) | PRD/design | **$149–249** |
| **Finance** (financeBOX) | Capability | Pro | Beta PRD | **$149–299** |
| **Reception / Voice** (ReceptionBOX) | Capability (premium) | Pro (voice-class) | Discovery-led | **$500–1,500 + discovery SOW $25–50k** |
| Customer Success / Legal Brief / Content | Persona | Core | Backlog | **$29–79** |

*Rationale:* Persona Packs are light (role/voice/skills) → low band, high attach. Capability Packs carry app + integration cost → mid band. Reception carries materially higher COGS (voice models, latency hardware) and a custom GTM → premium + discovery SOW (matches the existing ReceptionBOX discovery model). **MarketBOX is internal/power-user — not a customer Pack in v1.**

## 5. Bundles (proposed)

- **Starter** — AgentBOX Core + Email Pack. The default landing offer.
- **Sales Suite** — Core/Pro + Email + Sales Agent + (CRM-lite via Finance later).
- **Knowledge Worker** — Pro + Research + Email.
- **Front Office** — Pro + Email + Reception (premium; discovery-led).
- Multi-Pack discount: e.g. 2 Packs −10%, 3+ −20% (illustrative) — rewards expansion, reflects shared-graph efficiency.

## 6. How Packs are gated (commercial ↔ technical)

Packs install on the existing substrate; gating is a thin license layer on top:
- **Install:** gbrain **skillpack** (`gbrain skillpack install <pack>`, trust-scoped registry) + a **persona seed** (a `mailbox.persona`-style row / config) + any Pack workflows/integrations.
- **Entitlement:** a per-box **license key** lists entitled Pack IDs + tier; the installer/dashboard refuses to enable an un-entitled or under-tiered Pack (e.g. Reception on a Core box).
- **Metering:** cloud-routed inference is metered per box → billed cost+20% on the platform invoice; local inference is unmetered (on-box).
- **Updates:** Packs update OTA via the registry, customer-initiated (matches MailBOX OTA model).

> This means "sell a Pack" = issue/extend a license key + the box pulls it. No new hardware shipment for Persona/most Capability Packs.

## 7. Upsell / attach motion

1. **Land** — sell Starter (Core + Email). Lowest friction; immediate ROI (email hours saved).
2. **Activate the graph** — Email populates the on-box knowledge graph (contacts, threads, voice).
3. **Attach** — offer Sales Agent / Research / Finance; each is cheaper to deliver and more valuable because the graph already exists.
4. **Upgrade tier** — when a customer wants Voice or deeper local reasoning, sell the Pro/Max box upgrade (capability-driven, not paywall-driven).
5. **Expand seats/accounts** — Enterprise tier for advisors/resellers running multiple client accounts on one box.

KPI targets to define: **attach rate** (Packs per box), **time-to-second-Pack**, **tier-upgrade rate**, **net revenue retention**.

## 8. COGS drivers (to quantify)

- Hardware BOM per tier (one-time, mostly pass-through).
- Cloud inference (pooled, cost+20% — pass-through + margin).
- Support / white-glove onboarding (per box, front-loaded).
- Reception/voice: higher hardware + model COGS, custom build → premium pricing required.

## 9. Open questions (decide before pricing is real)

1. **Is Email bundled into the platform subscription, or its own Pack?** (Affects the entry price headline.)
2. **Tier names** — Core/Pro/Max/Enterprise vs current T2/T3/T4/T5.
3. **Hardware: sell, finance, or rent?** Ownership is the privacy story; rental smooths cash but muddies it.
4. **Pack price bands** — validate against COGS + willingness-to-pay; do Persona Packs anchor too low to matter?
5. **Multi-Pack discount curve** — flat % vs bundle SKUs.
6. **Reception** — keep discovery-led/custom, or productize a "Voice Pack" SKU once latency/COGS are solved?

## 10. Assumptions (explicit)

- Cloud inference remains pooled (Glue Co key) at cost+20%; local inference is "free" to the customer once the box is owned.
- The shared on-box knowledge graph is real defensibility (per ResearchBOX PRD's multi-pack thesis).
- gbrain skillpacks + persona overrides are sufficient to deliver most Packs without per-Pack hardware.
- Hardware bands are illustrative pending a real BOM sheet.

> **Next:** validate one full SKU end-to-end with the [Sales Agent Persona Pack spec](./persona-pack-sales-agent.v0.1.0.md), then run a COGS/margin pass to replace the illustrative bands.
