# AgentBOX — Positioning One-Pager

> **v0.1.0 · 2026-06-07 · DRAFT for review**
> Owner: Dustin · Tracks: UMB-114
> Decision encoded: **one box (AgentBOX), everything else is a purchasable Pack.** No separate boxes.

## TL;DR

**AgentBOX is one edge-AI appliance you own.** It runs a local agent, its long-term memory, and a control surface on hardware you plug in. You buy the **box** once (in the tier that fits your workload — bigger tiers run bigger local models), then **subscribe to Packs** that turn it into exactly the assistant you need: Email, Sales, Research, Finance, Reception. The box is the platform; **Packs are the product and the upsell.**

Previously the lineup was a confusing set of separate "BOXes" (MailBOX, ResearchBOX, financeBOX, ReceptionBOX) plus an overloaded word "persona." This collapses all of it into: **AgentBOX (tiers) + Packs (add-ons).**

---

## The model in one picture

```
                         ┌─────────────────────────────┐
   You buy ONE box ───►  │          AgentBOX           │   the platform (own it)
   in the right tier     │  Hermes agent · gBrain mem  │
                         │  dashboard · local model    │
                         └──────────────┬──────────────┘
                                        │ install Packs (subscribe)
        ┌───────────────┬──────────────┼───────────────┬───────────────┐
     Email Pack     Sales Pack     Research Pack    Finance Pack    Reception Pack
     (MailBOX)     (persona)      (ResearchBOX)    (financeBOX)    (voice, premium)
        └───────────────┴──────────────┴───────────────┴───────────────┘
              all share one on-box knowledge graph (the moat)
```

## What you're actually buying

| Layer | What it is | How it's sold |
|---|---|---|
| **AgentBOX** | The appliance: Hermes agent + gBrain memory + dashboard + a local model. Sized in tiers (Core → Pro → Max) — **higher tiers run stronger local models** and more concurrent Packs. | **Hardware** (own it) + **platform subscription** (updates, support, pooled cloud inference at cost+20%). |
| **Capability Packs** | Full use-case apps that add workflows, integrations, and UI — Email, Research, Finance, Reception. Some require a higher tier (Reception needs voice-class hardware). | **Per-Pack subscription.** The upsell motion. |
| **Persona Packs** | Role overlays on the agent — Sales Agent, Customer Success, Legal Brief, Content. Voice + skills + guardrails, no new hardware. | **Per-Pack subscription** (lighter price band). The fast attach. |
| **Layers** (e.g. AudioLayer) | Cross-cutting optimizations (low-latency speech). Not sold standalone. | **Bundled** into the Packs that need them. |

> **Two grades of Pack, one catalog.** *Persona Packs* are light (role/voice/skills, any tier). *Capability Packs* are heavy (new app + sometimes a tier requirement). Both install the same way; they differ in price band and prerequisites.

## Why this wins

- **One thing to sell.** "Buy an AgentBOX, add the Packs you need." No deciding between five boxes.
- **Land-and-expand built in.** Start with one Pack (usually Email), attach more over time — each new Pack is more valuable because it reuses the **same on-box knowledge graph** (your contacts, history, voice). That shared graph is the defensibility, not any single Pack (research/email engines are commoditized).
- **Privacy + ownership stay intact.** Everything runs on the box you own; cloud is fallback, billed transparently.
- **Tiering has a real axis.** Higher tiers = bigger local model = less cloud dependence + heavier Packs (voice, deep research). Customers upgrade hardware for capability, not artificial limits.

## The lineup (initial)

| Pack | Grade | Status today | Tier needed |
|---|---|---|---|
| **Email** (MailBOX) | Capability | **Shipped** (live customers) | Core+ |
| **Sales Agent** | Persona | Spec (this milestone) | Core+ |
| **Research** (ResearchBOX) | Capability | PRD, design | Pro+ (depth scales with tier) |
| **Finance** (financeBOX) | Capability | Beta PRD | Pro+ |
| **Reception / Voice** (ReceptionBOX) | Capability (premium) | Discovery-led | Pro+ (voice-class) + discovery SOW |
| Customer Success, Legal Brief, Content | Persona | Backlog | Core+ |

*(MarketBOX stays internal/power-user — not a customer Pack in v1.)*

## What this changes

- Existing standalone-box PRDs (`ResearchBOX`, `financeBOX`, `ReceptionBOX`) get **re-framed as Packs on AgentBOX**, not separate appliances.
- The word **"persona"** now means specifically a **Persona Pack** (a sellable role overlay), not a hidden config field.
- Pricing/tier/SKU detail lives in the **[AgentBOX Business PRD](./agentbox-business-prd.v0.1.0.md)**; the first concrete Pack is specced in the **[Sales Agent Persona Pack](./persona-pack-sales-agent.v0.1.0.md)**.

> **Open for review:** tier names (Core/Pro/Max), which Packs are Persona vs Capability, and whether Email is "always included" vs "the first Pack." See Business PRD §Open Questions.
