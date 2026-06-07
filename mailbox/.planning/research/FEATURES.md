# Feature Research

**Domain:** AI email agent appliance for B2B operational email (small CPG brands)
**Researched:** 2026-04-02
**Confidence:** MEDIUM-HIGH — based on current competitor analysis (Front, Help Scout, Superhuman, Shortwave, SaneBox, Lindy, Fyxer) and B2B email automation patterns. CPG-specific operational context is inference from general B2B patterns; direct user research not yet conducted.

---

## Feature Landscape

### Table Stakes (Users Expect These)

Features users assume exist. Missing these = product feels incomplete.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Email classification / triage | Every competitor does this; without it the product is just a relay | MEDIUM | 8-category taxonomy already defined in PROJECT.md. Must work well out of box — accuracy expectation is 80%+. |
| Draft generation for queue | The core value proposition. If it can't draft a decent reply, it's useless | HIGH | Hybrid local (Qwen3-4B) + cloud (Claude Haiku) path. Quality bar is "better than blank screen," not "send immediately." |
| Approval queue (human-in-the-loop) | Users will not trust auto-send on day 1. An approval queue is the minimum trust surface | LOW | This is the central UX. Every competitor with AI draft features gates behind review. Build queue-first. |
| Approve / edit / reject / escalate actions | Basic triage actions on queued drafts | LOW | Four core verbs. Missing any one feels broken. |
| Email thread history in context | Drafts without thread context are generic and embarrassing | MEDIUM | RAG over sent history + Qdrant retrieval addresses this. Recency weighting matters. |
| Daily digest notification | Users need pull-based summary even if not watching queue | LOW | Email-only for v1 is sufficient. Alert when queue threshold exceeded. |
| Knowledge base (document upload) | Users expect to give the agent their price lists, product specs, policies | MEDIUM | File ingestion into Qdrant. PDF + plain text minimum. Already in requirements. |
| First-boot / onboarding wizard | Without structured onboarding the product is inert. Competitors with appliance-like UX all do guided setup | MEDIUM | Create admin, connect email, ingest 6 months history. Already required. |
| Sent history log | "What did it send on my behalf?" is a baseline accountability expectation | LOW | Log all sent emails with classification, draft source, and timestamp. |
| Classification log / audit trail | For trust-building, users need to see why the agent categorized something a certain way | LOW | Show confidence score and classification rationale alongside each email. |
| System status visibility | Hardware appliance users need to know if the box is healthy | LOW | Dashboard: service health, queue depth, last-processed timestamp. |

### Differentiators (Competitive Advantage)

Features that set the product apart. Not expected but valued.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Local-first privacy (all data on device) | CPG operators share sensitive pricing, margin, and retailer relationship data. "Nothing leaves the box" is a meaningful trust differentiator vs cloud-only tools | HIGH | Already a core architectural commitment. Market this explicitly. Cloud path sends only current email context, never the corpus. |
| Persona tuning from sent history | Ghostwriter-style voice extraction (a la Shortwave) makes drafts sound like the operator, not a chatbot. This closes the "generic AI voice" objection | HIGH | Extract voice profile from 6 months sent history at onboarding. Few-shot examples per category. Requires Qwen3-4B + embedding analysis. |
| CPG-specific classification taxonomy | Generic email tools use "urgent/not urgent." An agent that natively understands reorder requests, broker follow-ups, co-man scheduling, and retailer escalations is immediately more useful | MEDIUM | The 8-category schema (inquiry, reorder, scheduling, follow-up, internal, spam, escalate, unknown) is the differentiator. Competitors have none of this vertical specificity. |
| Graduated auto-send (per-category opt-in) | Trust is built incrementally. Letting operators unlock auto-send for low-risk categories (e.g. "meeting scheduling confirmations") after observing accuracy builds confidence without risk | MEDIUM | Default OFF. Category-level unlock after N approved drafts in that category with low edit rate. Competitors either always require approval or allow global auto-send with no granularity. |
| Confidence threshold display on drafts | Showing "90% confident" vs "55% confident" lets users triage their own review effort. High-confidence drafts get light review, low-confidence get full attention | LOW | Surface classification confidence and draft generation confidence separately on queue items. |
| Relationship context in drafts | Knowing that "Whole Foods buyer Sarah" has a 6-week reorder pattern and last ordered 3 pallets informs a better draft than a generic reply | HIGH | Phase 2 (SQLite relationship graph). v1 uses vector similarity over history — partial benefit. Full relationship graph deferred. |
| Appliance UX (plug in, it works) | No cloud account to manage, no SaaS subscription friction, no data portability concerns. Setup is physical + wizard, not onboarding email funnels | HIGH | The hardware form factor is the differentiator. Competitors are all SaaS overlays requiring cloud trust. |
| Graceful degradation (works offline) | SaaS tools fail silently when cloud is down. The appliance queues locally and degrades to local-only drafts | MEDIUM | Already in requirements. Draft locally with Qwen3-4B if cloud API unreachable. Surface to user which drafts used which path. |
| OTA updates under operator control | Enterprise B2B operators hate surprise updates. Customer-initiated OTA via GHCR builds trust and fits a "my box, my rules" mental model | LOW | Already in requirements. Surface available update notification prominently on dashboard. |

### Anti-Features (Commonly Requested, Often Problematic)

Features that seem good but create problems.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Global auto-send (all categories, no approval) | "I just want it to handle email for me" is the dream | Auto-send errors are irreversible. A draft sent to a Whole Foods buyer with wrong pricing destroys a relationship. Trust collapses on first mistake. Low-confidence drafts sent blindly are worse than no drafts. | Graduated auto-send by category with confidence threshold gates. Always default OFF. Build trust through transparency, not automation speed. |
| CRM / Shopify / EDI integration (v1) | Operators want full automation — "update my order in Shopify when a reorder comes in" | Each integration 3x's the implementation surface area and the failure modes. A broken Shopify sync that creates phantom orders is a disaster. | Defer integrations to v2. Focus on email-only accuracy first. Log structured data (reorder amounts, SKUs) in draft metadata for future integration hooks. |
| SMS / Slack / mobile push notifications | "I want to know instantly when something urgent arrives" | Notification overload trains users to ignore the system. Multiple channels create acknowledgment confusion (did I approve this on Slack or in the queue?). | Email-only notifications for v1. Single channel, single action surface. Revisit after dogfood shows notification patterns. |
| Full email client (send/compose arbitrary email) | "Make it my primary email client" | Scope explosion. The product is an agent that handles inbound operational email — not an email client. Building compose, contacts, calendar, search, folders competes with Gmail/Outlook and loses. | Keep the dashboard as approval surface only. No compose interface — users compose in their existing client. Inbound agent only. |
| Multi-user / role-based access | "My assistant needs to approve drafts too" | RBAC adds auth complexity, audit trail branching, and "who approved this?" ambiguity. v1 has one operator. | Single admin user in v1. Multi-user is v2 after core email pipeline is validated. |
| Real-time email push (WebSocket inbox) | "Show me emails as they arrive" | IMAP polling at 60s is sufficient for operational email. Real-time push requires persistent connections and adds complexity for minimal benefit in a context where emails are not chat. | 60-second poll default. Configurable interval. Not real-time. |
| Learning from approval edits (active fine-tuning) | "It should get smarter from my corrections" | Online fine-tuning of local models is complex, resource-intensive on 8GB VRAM, and can degrade model quality if done incorrectly. | Use edits as few-shot examples added to the persona profile. No model weight updates in v1. This is a meaningful v2 capability. |
| Marketing / outbound campaigns | "While you're at it, send my newsletter" | Completely different product. SPF/DKIM/deliverability management, list segmentation, unsubscribe compliance, and campaign analytics are out of scope and dilute the inbound agent value prop. | Explicitly not this. Route these to Mailchimp or similar. |
| Voice / phone integration | "Can it handle my voicemails too?" | Different modality, different infrastructure (ASR, telephony), different regulatory surface. No overlap with email pipeline. | Defer indefinitely. Focus email. |

---

## Feature Dependencies

```
[Email Connectivity (IMAP/SMTP OAuth)]
    └──required by──> [Email Classification]
                          └──required by──> [Draft Generation]
                                                └──required by──> [Approval Queue]
                                                                      └──required by──> [Auto-Send Rules]

[Email History Ingestion]
    └──required by──> [RAG Context Retrieval]
                          └──enhances──> [Draft Generation]

[Document Upload / Knowledge Base]
    └──enhances──> [RAG Context Retrieval]

[Persona Tuning (voice profile)]
    └──enhances──> [Draft Generation]
    └──requires──> [Email History Ingestion]

[Classification Confidence Score]
    └──enables──> [Graduated Auto-Send]
    └──enhances──> [Approval Queue] (lets user prioritize review effort)

[Approval Queue]
    └──required by──> [Sent History Log]
    └──required by──> [Classification Log / Audit Trail]

[First-Boot Wizard]
    └──required by──> [Email History Ingestion]
    └──required by──> [Persona Tuning]

[System Status Dashboard]
    └──enhances──> [OTA Update Management]

[Graduated Auto-Send] ──conflicts──> [Global Auto-Send]
    (build graduated trust, not blind automation)

[Full Email Client] ──conflicts──> [Appliance UX]
    (scope expansion undermines the "plug in, it works" position)
```

### Dependency Notes

- **Email Connectivity requires OAuth2 setup**: Gmail and Outlook both use OAuth2. Credential handling is the first gate — nothing works without it. Must be in Phase 1.
- **Draft Generation requires RAG Context**: Drafts without email history context are generic and embarrassing. History ingestion must happen at or before first draft generation.
- **Persona Tuning enhances Draft Generation**: Voice extraction from sent history is optional for MVP but meaningfully improves quality. Can be done at onboarding without blocking draft generation.
- **Graduated Auto-Send requires Classification Confidence**: Auto-send unlock logic depends on knowing per-category accuracy rates, which requires tracking approval/edit/reject outcomes over time.
- **OTA Updates is independent**: Can be built at any phase without blocking the core pipeline.

---

## MVP Definition

### Launch With (v1 — Dogfood target: 2026-04-03)

Minimum viable product for the Heron Labs dogfood.

- [ ] Email connectivity (Gmail OAuth2 or IMAP/SMTP manual) — nothing works without it
- [ ] Email classification into 8 categories — core intelligence surface
- [ ] Draft generation (local + cloud hybrid) — the value proposition
- [ ] Approval queue with approve / edit / reject / escalate — minimum trust surface
- [ ] Email thread history in RAG context — drafts need context to be non-generic
- [ ] Document upload (knowledge base) — price lists, policies, product specs
- [ ] Persona tuning from sent history — voice profile at onboarding
- [ ] Daily digest + queue threshold alert (email notification) — pull-based awareness
- [ ] First-boot wizard (connect email, ingest history) — appliance onboarding
- [ ] Sent history log + classification log — audit trail for trust-building
- [ ] System status dashboard — appliance health visibility
- [ ] Confidence score display on queue items — helps user prioritize review effort

### Add After Validation (v1.x)

Features to add once core pipeline is validated against real Heron Labs email.

- [ ] Graduated auto-send per category — unlock after N approved drafts with low edit rate; trigger: user requests it after 2+ weeks of operation
- [ ] Classification accuracy reporting — per-category stats, edit rate trend; trigger: user asks "is it getting better?"
- [ ] OTA update management — surface available updates; trigger: first real update to ship
- [ ] Offline / graceful degradation UX — surface which drafts used local vs cloud path; already in requirements, needs UI surfacing

### Future Consideration (v2+)

Features to defer until product-market fit is established.

- [ ] Relationship graph (SQLite contact/company context) — richer draft context; deferred because v1 vector-only RAG gets 80% of the value
- [ ] Remote access via Tailscale — LAN-only is v1 constraint; add when operators need mobile-away-from-WiFi access
- [ ] Multi-user / RBAC — single admin in v1; add when customers have assistants or operations staff needing queue access
- [ ] Active learning from edits (fine-tuning from corrections) — meaningful capability but model update complexity is high; v2 when core pipeline stable
- [ ] CRM / Shopify / EDI integration hooks — v2 when operators validated the email intelligence is trustworthy
- [ ] SMS / Slack notifications — email-only sufficient for v1; add if dogfood shows operators missing urgent items

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Email connectivity (IMAP/SMTP/OAuth2) | HIGH | MEDIUM | P1 |
| Email classification (8 categories) | HIGH | MEDIUM | P1 |
| Draft generation (hybrid local+cloud) | HIGH | HIGH | P1 |
| Approval queue (approve/edit/reject/escalate) | HIGH | LOW | P1 |
| Email history ingestion + RAG retrieval | HIGH | HIGH | P1 |
| Document upload / knowledge base | HIGH | MEDIUM | P1 |
| Persona tuning from sent history | HIGH | HIGH | P1 |
| First-boot wizard | HIGH | MEDIUM | P1 |
| Sent history log + classification log | MEDIUM | LOW | P1 |
| System status dashboard | MEDIUM | LOW | P1 |
| Daily digest + threshold alert | MEDIUM | LOW | P1 |
| Confidence score display | MEDIUM | LOW | P1 |
| Graceful degradation (offline queue) | MEDIUM | MEDIUM | P2 |
| Graduated auto-send per category | HIGH | MEDIUM | P2 |
| OTA update management UI | MEDIUM | LOW | P2 |
| Accuracy / edit-rate reporting | MEDIUM | MEDIUM | P2 |
| Relationship graph (contact context) | HIGH | HIGH | P3 |
| Remote access (Tailscale) | MEDIUM | MEDIUM | P3 |
| Multi-user / RBAC | MEDIUM | HIGH | P3 |
| Active learning from edits | HIGH | HIGH | P3 |
| CRM / Shopify integration | MEDIUM | HIGH | P3 |

**Priority key:**
- P1: Must have for v1 dogfood launch
- P2: Should have; add after core pipeline validated
- P3: Future consideration; v2+ after product-market fit

---

## Competitor Feature Analysis

| Feature | Front / Help Scout | Superhuman / Shortwave | SaneBox / Fyxer | MailBox One Approach |
|---------|-------------------|------------------------|-----------------|----------------------|
| Email classification | AI-assisted topic routing; general categories | AI labels (priority, newsletter, etc.) — not domain-specific | Importance sorting (SaneBox); auto-label to-respond (Fyxer) | 8-category CPG-specific taxonomy (reorder, broker, co-man, etc.) — vertical depth no competitor has |
| Draft generation | AI Drafts (Help Scout), Copilot (Front); cloud-only | AI compose with tone options; cloud-only | Fyxer drafts in your style; cloud-only | Hybrid local (80%+) + cloud; privacy-first |
| Approval queue | Conversation assignment + internal notes; no draft queue concept | No structured draft queue; compose is immediate | No draft queue | Dedicated approval queue with 4 triage actions; core UX surface |
| Voice / persona | None | Shortwave Ghostwriter — best in class for voice cloning from sent history | Fyxer claims "your tone" but shallow | Persona profile from sent history at onboarding; few-shot examples per category |
| Knowledge base | Help docs / article library (customer-facing); not agent context | None | None | Document upload directly into agent RAG context — operator-specific price lists, policies, specs |
| Privacy / data residency | All data in cloud (Front: US/EU); trust their servers | All data in cloud | All data in cloud | All data on local NVMe; cloud sees only current email context |
| Auto-send | Front: rules-based auto-reply; no confidence gating | None | None | Graduated auto-send by category with confidence gate; default OFF |
| Hardware / appliance | SaaS only | SaaS only | SaaS overlay | Physical appliance; plug-in onboarding; no cloud account required |
| Vertical focus | Horizontal (any B2B team) | Horizontal (individual power user) | Horizontal (any inbox) | Vertical CPG operational email — terminology, categories, relationship types are native |
| Offline operation | Fails if cloud down | Fails if cloud down | Fails if cloud down | Queues locally; degrades to local-only drafts; fully functional on LAN |

---

## Sources

- Competitor feature pages and reviews: Superhuman blog, Shortwave docs, Help Scout features, Front pricing/features, SaneBox plans, Fyxer product, Lindy email automation
- AI email triage patterns: instantly.ai, budibase.com, n8n workflow templates, stackai.com, eesel.ai Help Scout overview
- Human-in-the-loop patterns: zapier.com HITL guide, stackai.com HITL design, uipath.com agentic automation
- AI email failure modes: galileo.ai agent failures, lakera.ai hallucinations, evidently.ai LLM hallucination examples
- CPG operational context: PROJECT.md requirements (validated by Dustin / Heron Labs context), spoileralert.com CPG buyers
- Graduated autonomy / trust-building: mymobilelyfe.com email triage playbook, virtualworkforce.ai inbox agents, beam.ai agent template

*Confidence notes: Competitor feature analysis is MEDIUM confidence — based on public documentation as of early 2026; features evolve rapidly. CPG-specific email category taxonomy is HIGH confidence — derived directly from PROJECT.md validated requirements. Auto-send trust-building patterns are MEDIUM confidence — based on multiple independent B2B automation sources agreeing on "default OFF, graduated unlock" as best practice.*

---

*Feature research for: MailBox One — AI email agent appliance, small CPG brands, B2B operational email*
*Researched: 2026-04-02*
