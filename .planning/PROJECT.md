# MailBox One — Email Agent Appliance

## What This Is

A dedicated hardware appliance (Jetson Orin Nano Super) that runs an AI email agent for small CPG brand operators. The customer plugs in a box, connects their email, completes guided onboarding, and gets an always-on assistant that triages, drafts, and (with approval) sends email responses on their behalf. Sold as a managed product with white-glove onboarding and optional support subscription.

## Core Value

Inbound operational email for small CPG brands gets triaged, drafted, and (with human approval) sent — without the founder spending 1-3 hours/day on email.

## Requirements

### Validated

- [x] Jetson Orin Nano Super flashed with JetPack 6.2 and all dependencies — Phase 1 (`01-VERIFICATION.md`, smoke test 6/6 pass 2026-04-26)
- [x] Docker Compose stack running 5 services: Ollama, Qdrant, n8n, Dashboard (Node.js/React), Postgres — Phase 1 (live deploy at https://mailbox.heronlabsinc.com/ verified 2026-04-26; Postgres NVMe-encrypted, MAXN power mode at boot)
- [x] Email classification into 8 categories (inquiry, reorder, scheduling, follow-up, internal, spam/marketing, escalate, unknown) via local Qwen3-4B model — Phase 2 plan 02-04a/b (MAIL-05 taxonomy live, MAIL-08 gate PASS 2026-04-30 at route accuracy 73.2%, F1 local 0.83 / drop 0.58 / cloud 0.68; see `02-04b-classification-corpus-scoring-SUMMARY-v2-2026-04-30.md`)

### Active

- [ ] IMAP/SMTP email connectivity via OAuth2 (Gmail, Outlook) or manual credentials
- [ ] Email polling at configurable interval (default 60s)
- [ ] Classification accuracy > 80% on Heron Labs email corpus (route-accuracy gate currently passes at 73.2% per redefined MAIL-08 — full 80% category accuracy still pending)
- [ ] Response generation via RAG: local model for simple drafts, cloud Claude Haiku for complex drafts
- [ ] RAG pipeline: email history ingestion, document upload, Qdrant vector search with nomic-embed-text
- [ ] Approval workflow: all drafts enter queue, customer can approve/edit/reject/escalate
- [ ] Configurable auto-send rules (default OFF, per-category opt-in after trust-building)
- [ ] Web dashboard served locally (LAN at http://device.local:3000): approval queue, sent history, classification log, knowledge base management, persona settings, system status
- [ ] Mobile-responsive dashboard (primary interaction surface is phone on same Wi-Fi)
- [ ] First-boot wizard: create admin account, connect email, ingest 6 months of sent history
- [ ] Persona tuning: voice profile extracted from sent emails, few-shot examples per category
- [ ] Notification system: email-only (queue threshold alert + daily digest)
- [ ] OTA updates via GHCR (customer-initiated, no auto-update)
- [ ] All data stored locally on NVMe, cloud API calls send only current email context
- [ ] Graceful degradation: complex emails queue locally if cloud API unreachable

### Out of Scope

- Remote access outside LAN (v1) — deferred to v2, Tailscale
- SMS/Slack notifications — email-only sufficient for v1
- Consumer D2C support email — product handles operational brand comms only
- Email marketing / outbound campaigns — not a marketing tool
- CRM integration — no HubSpot/Salesforce in v1
- Multi-user access control — single admin user in v1
- E-commerce integration — no Shopify/Amazon
- Voice/phone integration
- Mobile native app — dashboard is mobile-responsive web
- Custom carrier board / production hardware — v1 uses dev kit
- Relationship graph (Phase 2) — vector-only RAG for Phase 1

## Context

**Target customer:** Small CPG brand operators (1-10 person teams) receiving 20-100+ operational emails/day from retailers, brokers, distributors, co-manufacturers, and logistics partners. Primary verticals: functional food/supplement brands, natural products brands, emerging CPG in specialty retail.

**Hardware platform:** NVIDIA Jetson Orin Nano Super Developer Kit (8GB, 67 TOPS). $249 per unit. COGS per assembled unit: $344. 5-unit initial production run for beta.

**Software stack:**
- OS: Ubuntu 22.04 LTS (JetPack 6.2)
- Runtime: Docker + Docker Compose
- Services: Ollama (local LLM), Qdrant (vector DB), n8n (workflow orchestrator), custom Dashboard (Node.js/React), Postgres
- Local models: Qwen3-4B (Q4_K_M, classification + simple drafts), nomic-embed-text (embeddings)
- Cloud: Claude Haiku (complex drafts), Claude Sonnet (fallback)

**Architecture:** n8n orchestrates the email processing pipeline (IMAP poll → classify → route → draft → approval queue → send). Hybrid local+cloud inference: ~80% of email volume handled locally at zero marginal cost.

**Business model:** $699 one-time (hardware + software + onboarding + 1 month cloud API credits included), $49/mo optional support subscription, cloud API passthrough at cost + 20% markup.

**Dogfood target:** Dustin's Heron Labs inbox — customer zero starting 2026-04-03.

**PRD reference:** `prd-email-agent-appliance.md` in project root — comprehensive functional requirements (FR-1 through FR-36), non-functional requirements, hardware spec, software architecture, onboarding protocol, and phase plan.

## Constraints

- **Hardware**: 8GB unified VRAM — local models limited to ~4B params quantized. NVMe storage: 500GB.
- **Power**: < 25W sustained under normal operation.
- **Latency**: Inbound email → draft in queue: < 30s local path, < 60s cloud path.
- **Boot time**: Cold boot to fully operational < 3 minutes.
- **Privacy**: All email content and knowledge base stored only on local appliance. No bulk corpus sent to cloud.
- **API provider**: Anthropic Claude (pooled Glue Co API key, billed to customer at cost + 20%).
- **Updates**: OTA via GitHub Container Registry (GHCR), customer-initiated only.
- **Phase 1 budget**: $800 (1 unit hardware + cloud API for testing).

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| LAN-only dashboard for v1 | Simpler, more secure — add Tailscale in v2 | — Pending |
| Email-only notifications for v1 | Keep notification scope minimal, SMS/Slack deferred | — Pending |
| 5-unit initial production run | Lowest risk for beta, no volume discount needed yet | — Pending |
| Pooled Glue Co API key | Simpler for customer, Glue Co controls billing + markup | — Pending |
| 1 month cloud API credits in $699 | Covers onboarding period, then metered billing | — Pending |
| GHCR for container registry | Free/cheap, already in GitHub workflow | — Pending |
| n8n as orchestrator (vs custom Python) | Visual workflows, built-in IMAP/SMTP/LLM nodes, zero per-email cost | — Pending |
| Qdrant as vector store (vs ChromaDB, pgvector) | Rust-native, low memory, ARM64 Docker, payload filtering | — Pending |
| Jetson Orin Nano Super (vs Mac mini, RPi 5) | Best cost/perf for local LLM at $249, 67 TOPS GPU | — Pending |
| Hybrid local+cloud inference | 80%+ local at zero marginal cost, cloud for quality-sensitive drafts | — Pending |
| SQLite relationship graph for Phase 2 | Structural context retrieval alongside vector similarity — deferred | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd:transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-05-01 — Phase 1 success criteria moved to Validated; classification (Phase 2 plan 02-04) moved to Validated after MAIL-08 gate PASS. Per STAQPRO-158 AC-3.*
