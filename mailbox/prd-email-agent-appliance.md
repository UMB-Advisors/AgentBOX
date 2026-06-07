# MailBox One — Email Agent Appliance

## PRD v1.1

> **Created:** 2026-04-02
> **Last updated:** 2026-04-02
> **Author:** Dustin (Glue Co)
> **Status:** Draft — awaiting NEEDS_CLARIFICATION resolution
> **Product type:** Hardware + software appliance sold as a managed product
> **Changelog:** v1.1 — Added §7.5.1 Relationship Graph Layer, amended §7.4 context routing, amended Phase 2 deliverables
>
> **⚠ Industry-vertical note (added 2026-05-08, post-customer-#2 deploy):** This
> PRD captures the original 2026-Q1 vision targeting small CPG brand operators
> as the launch vertical. The live product is **industry-agnostic at the
> prompt layer** per the 2026-05-08 CPG-scrub — `business_description` is a
> per-appliance persona override populated during onboarding (see
> `dashboard/lib/drafting/persona.ts` `PersonaContext`), not a hardcoded
> vertical. Customer #1 (Heron Labs) is CPG; customer #2 (Staqs.io) is B2B
> tech / dev tools. Treat any "CPG" / "small CPG brand" reference below as
> historical context; the runtime classifies and drafts in whatever industry
> the operator's persona override says. CLAUDE.md "Project" section is the
> current product positioning.

---

## §1. Product Identity

MailBox One is a dedicated hardware appliance that runs an AI email agent for small CPG brand operators. The customer plugs in a box, connects their email, completes a guided onboarding session, and gets an always-on assistant that triages, drafts, and (with approval) sends email responses on their behalf. The product is a Jetson Orin Nano Super with pre-loaded software, sold with a white-glove onboarding handhold and optional ongoing support subscription.

**This product is not:** a general-purpose AI assistant, a chatbot, a CRM, an email marketing tool, or a developer platform. It handles inbound email response for operational brand communications.

---

## §2. Target Customer

Small CPG brand operators (1-10 person teams) who:

- Receive 20-100+ operational emails/day from retailers, brokers, distributors, co-manufacturers, and logistics partners
- Spend 1-3 hours/day on email triage and response
- Lack staff to delegate email to
- Are technically capable enough to use a web browser but not to configure Docker, API keys, or agent frameworks

**Primary verticals (launch):** Functional food/supplement brands, natural products brands, emerging CPG brands selling through specialty retail (Sprouts, Whole Foods, Natural Grocers, independent retailers).

**Excluded from v1:** Enterprise brands (50+ person teams), brands with existing CRM/helpdesk software (Zendesk, Front, Help Scout), brands whose email volume is primarily consumer D2C support.

---

## §3. Jobs to Be Done

| # | Job | Current Solution | Pain |
|---|-----|-----------------|------|
| J-1 | Respond to retailer inquiries (pricing, MOQs, lead times, availability) | Founder manually drafts each reply | 30-60 min/day, slow response loses orders |
| J-2 | Follow up with brokers and sales reps | Founder remembers (or forgets) | Dropped follow-ups = lost shelf placements |
| J-3 | Confirm reorders from existing accounts | Manual copy-paste of confirmation templates | Tedious, error-prone, delays shipping |
| J-4 | Coordinate scheduling (meetings, facility tours, sample shipments) | Back-and-forth email chains | 5-10 emails per scheduling event |
| J-5 | Triage and prioritize inbound email | Read everything, mentally sort | Urgent buried under noise |

---

## §4. Functional Requirements

### §4.1 Email Connectivity

| ID | Requirement |
|----|------------|
| FR-1 | Connect to customer's email via OAuth2 (Gmail, Outlook/M365) or standard IMAP/SMTP credentials |
| FR-2 | Poll for new inbound emails at configurable interval (default: 60 seconds) |
| FR-3 | Send outbound emails via customer's existing email account (replies appear from their address) |
| FR-4 | Support multiple email accounts per appliance (up to 3 accounts in v1) |
| FR-5 | Handle HTML and plain text email, extract body text for processing, preserve threading/references |

### §4.2 Email Classification

| ID | Requirement |
|----|------------|
| FR-6 | Classify every inbound email into one of: `inquiry`, `reorder`, `scheduling`, `follow-up`, `internal`, `spam/marketing`, `escalate`, `unknown` |
| FR-7 | Classification runs on local model (no cloud API call) with p95 latency < 5 seconds |
| FR-8 | Classification accuracy > 85% within first week of operation, > 92% after 30 days with feedback |
| FR-9 | Customer can view and correct classifications via dashboard to improve accuracy over time |

### §4.3 Response Generation

| ID | Requirement |
|----|------------|
| FR-10 | Generate draft responses using RAG context (customer's sent email history, product catalog, pricing sheet) |
| FR-11 | Route simple responses (reorder confirmations, scheduling replies, standard follow-ups) through local model |
| FR-12 | Route complex responses (first-time retailer inquiries, negotiation, custom requests) through cloud LLM API |
| FR-13 | All generated drafts include the source classification, confidence score, and RAG context references |
| FR-14 | Maintain consistent voice/tone across all drafts, tuned during onboarding from customer's existing sent emails |

### §4.4 Approval Workflow

| ID | Requirement |
|----|------------|
| FR-15 | All drafts enter an approval queue visible in the dashboard |
| FR-16 | Customer can approve (send as-is), edit then approve, reject (discard), or escalate (flag for manual handling) |
| FR-17 | Configurable auto-send rules: emails matching specified classification + confidence threshold bypass the queue |
| FR-18 | Auto-send thresholds default to OFF for all categories; customer enables per-category after trust-building period |
| FR-19 | Dashboard shows pending queue count, time-in-queue per draft, and daily/weekly send volume |

### §4.5 RAG Knowledge Base

| ID | Requirement |
|----|------------|
| FR-20 | Ingest customer's sent email history (last 6 months minimum) during onboarding to build voice profile and context corpus |
| FR-21 | Accept uploaded documents (PDF, DOCX, CSV) as knowledge base sources: product catalog, pricing sheets, spec sheets, broker agreements |
| FR-22 | Incrementally index new sent emails and inbound emails to keep the knowledge base current |
| FR-23 | Customer can view, add, and remove knowledge base documents via the dashboard |
| FR-24 | Vector search returns top-k relevant context chunks with configurable k (default: 5) and minimum similarity threshold |

### §4.6 Customer Dashboard

| ID | Requirement |
|----|------------|
| FR-25 | Web-based dashboard served locally from the appliance, accessible via LAN at `http://device.local:3000` |
| FR-26 | Dashboard requires local authentication (username + password, set during first-boot) |
| FR-27 | Dashboard sections: approval queue, sent history, classification log, knowledge base management, persona settings, system status |
| FR-28 | Mobile-responsive — primary interaction surface is phone browser on the same Wi-Fi network |
| FR-29 | System status page shows: uptime, email connection health, model status, disk usage, queue depth, API cost meter |

[NEEDS_CLARIFICATION: Should the dashboard be accessible remotely (outside LAN) via WireGuard tunnel or Tailscale, or is LAN-only acceptable for v1? | Affects: FR-25, security architecture, onboarding complexity, Phase 1 scope]

### §4.7 First-Boot and Onboarding

| ID | Requirement |
|----|------------|
| FR-30 | First-boot wizard: customer connects power + ethernet/Wi-Fi, navigates to local IP, creates admin account |
| FR-31 | Guided email connection flow: OAuth2 redirect for Gmail/Outlook or manual IMAP/SMTP credential entry |
| FR-32 | Automatic ingestion of last 6 months of sent emails upon email connection (background task, progress shown in dashboard) |
| FR-33 | Persona tuning interface: customer reviews 20 sample drafts generated from their email history, marks each as "good tone" / "wrong tone" / "edit and save" |
| FR-34 | Onboarding handhold session (live Zoom, 60-90 min) included with purchase — covers: email connection, persona tuning, knowledge base upload, auto-send configuration |

### §4.8 Notifications

| ID | Requirement |
|----|------------|
| FR-35 | Send push notification (email or webhook) when approval queue exceeds configurable threshold (default: 5 pending drafts) |
| FR-36 | Send daily digest email summarizing: emails received, drafts generated, auto-sent, pending approval, escalated |

[NEEDS_CLARIFICATION: Should notifications also support SMS or Slack webhook in v1, or is email-only sufficient? | Affects: FR-35, FR-36, notification service scope, external dependency count]

---

## §5. Non-Functional Requirements

| ID | Requirement | Target |
|----|------------|--------|
| NFR-1 | Uptime | 99% measured monthly (appliance is always-on, reboots < 7 min) |
| NFR-2 | Email processing latency | Inbound email → draft in queue: < 30 seconds for local-model path, < 60 seconds for cloud-API path |
| NFR-3 | Power consumption | < 25W sustained under normal operation |
| NFR-4 | Storage capacity | Minimum 12 months of email history + knowledge base at typical volume (100 emails/day) |
| NFR-5 | Boot time | Cold boot to fully operational (all services running, IMAP connected): < 3 minutes |
| NFR-6 | Update mechanism | OTA container image updates pulled on customer-initiated action via dashboard; no auto-update without consent |
| NFR-7 | Data residency | All email content and knowledge base stored only on the local appliance. Cloud API calls send only the current email context, never bulk corpus |
| NFR-8 | Graceful degradation | If cloud API is unreachable, complex emails queue locally with "awaiting cloud" status; simple emails continue via local model |

---

## §6. Hardware Specification

### §6.1 Bill of Materials (per unit)

| Component | Specification | Supplier | Unit Cost |
|-----------|--------------|----------|-----------|
| Compute module | NVIDIA Jetson Orin Nano Super Developer Kit (8GB, 67 TOPS) | NVIDIA / Arrow / Seeed | $249 |
| Storage | Samsung 980 500GB NVMe M.2 PCIe Gen3 (300 TBW) | Samsung / Amazon | $40 |
| Enclosure | KKSB Aluminum Case w/ VESA mount + ventilation | Amazon | $35 |
| Wi-Fi antennas | 2x SMA dual-band antennas | Amazon | $8 |
| Power supply | Included with Jetson dev kit | — | $0 |
| Packaging | Branded box, quick-start card, ethernet cable | Custom | $12 |
| **Total COGS** | | | **$344** |

### §6.2 Assembly

| Step | Description |
|------|------------|
| A-1 | Install NVMe SSD into M.2 Key M slot on Jetson carrier board |
| A-2 | Flash NVMe with pre-built appliance image (JetPack 6.2 + Docker Compose stack + models) |
| A-3 | Attach Wi-Fi antennas to SMA connectors |
| A-4 | Mount board in aluminum enclosure |
| A-5 | Package with quick-start card, power supply, ethernet cable |
| A-6 | QA: boot test, verify all services start, run smoke test against test email account |

Assembly time estimate: 20-30 minutes per unit (manual). Amenable to batch production.

[NEEDS_CLARIFICATION: What is the target initial production run size? Affects: volume pricing on Jetson modules (100+ quantity gets distributor pricing), enclosure customization feasibility, and whether custom PCB carrier board is justified. | Affects: §6.1 costs, Phase 1 vs Phase 2 hardware strategy]

---

## §7. Software Architecture

### §7.1 Runtime Environment

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| OS | Ubuntu 22.04 LTS (JetPack 6.2) | NVIDIA-supported, 7-year lifecycle |
| Container runtime | Docker + Docker Compose | Service isolation, reproducible deployments, OTA update path |
| Process supervisor | systemd (host) + Docker restart policies | Auto-recovery on crash |

### §7.2 Service Topology

All services run as Docker containers orchestrated by a single `docker-compose.yml`.

| Service | Image | Port | Purpose | Resource Allocation |
|---------|-------|------|---------|-------------------|
| `ollama` | `dustynv/ollama:r36` | 11434 | Local LLM inference (classification, simple drafts, embeddings) | GPU-accelerated, ~4GB VRAM |
| `qdrant` | `qdrant/qdrant:latest` | 6333, 6334 | Vector database for RAG corpus | ~512MB RAM, persistent volume |
| `n8n` | `n8nio/n8n:latest` | 5678 | Workflow orchestrator — email polling, classification routing, draft generation, approval queue | ~512MB RAM |
| `dashboard` | Custom (Node.js/React) | 3000 | Customer-facing web UI | ~256MB RAM |
| `postgres` | `postgres:16-alpine` | 5432 | Persistent storage for n8n workflows, approval queue state, classification logs, user config | ~256MB RAM, persistent volume |

### §7.3 Email Processing Pipeline

```
[IMAP Poll] → [Parse + Clean] → [Classify (Ollama)] → [Route]
                                                          │
                                    ┌─────────────────────┼─────────────────────┐
                                    ▼                     ▼                     ▼
                              [Simple Draft]        [Complex Draft]        [Escalate]
                              (Ollama + RAG)        (Cloud API + RAG)      (Queue only)
                                    │                     │                     │
                                    ▼                     ▼                     ▼
                              [Approval Queue] ◄──────────┘─────────────────────┘
                                    │
                          ┌─────────┼─────────┐
                          ▼         ▼         ▼
                    [Auto-send]  [Review]  [Reject]
                          │         │
                          ▼         ▼
                       [SMTP Send]
```

### §7.4 Classification Router Logic

| Classification | Confidence ≥ 0.85 | Confidence < 0.85 |
|---------------|--------------------|--------------------|
| `inquiry` | Cloud API draft → queue | Cloud API draft → queue |
| `reorder` | Local model draft → queue (auto-send eligible) | Local model draft → queue |
| `scheduling` | Local model draft → queue (auto-send eligible) | Local model draft → queue |
| `follow-up` | Local model draft → queue (auto-send eligible) | Cloud API draft → queue |
| `internal` | Local model draft → queue | Local model draft → queue |
| `spam/marketing` | Archive, no draft | Queue for review |
| `escalate` | Queue only, no draft | Queue only, no draft |
| `unknown` | Cloud API draft → queue | Queue only, no draft |

### §7.5 RAG Pipeline

| Stage | Technology | Details |
|-------|-----------|---------|
| Embedding model | `nomic-embed-text` via Ollama | 768-dim embeddings, runs locally on GPU |
| Vector store | Qdrant | Cosine similarity, HNSW index |
| Chunking | Recursive text splitter | 512 tokens per chunk, 50-token overlap |
| Retrieval | Top-5 chunks by cosine similarity | Minimum similarity threshold: 0.72 |
| Context assembly | n8n code node | Concatenate retrieved chunks + current email + system prompt → send to LLM |

### §7.5.1 Relationship Graph Layer

The RAG pipeline (§7.5) retrieves context via vector similarity over flat email embeddings. The relationship graph layer adds structural context — who has emailed whom about which products, what pricing has been quoted, and how threads connect — enabling precise retrieval that pure similarity search cannot provide.

**Design inspiration:** The code-review-graph project (github.com/tirth8205/code-review-graph) demonstrates a pattern where source code is parsed into an AST via Tree-sitter, stored as a graph of nodes and edges in SQLite, and queried at review time to compute a "blast radius" — the minimal context set affected by a change. This achieves 6.8-49x token reduction with improved quality. The same pattern applies to email: parse structured input → graph of entities/relationships → traversal-based context retrieval.

#### Entity Types (Graph Nodes)

| Entity | Extraction Method | Example |
|--------|------------------|---------|
| Contact | Email header parsing (From, To, CC) | "jane.smith@wholefoods.com" |
| Company | Domain extraction + NER on email body | "Whole Foods Market" |
| Product | NER on email body, matched against knowledge base catalog | "Organic Turmeric Powder 12oz" |
| SKU | Regex pattern matching on email body | "SKU-TUR-12OZ" |
| Price Point | Regex + NER (dollar amounts in pricing context) | "$24.99/case" |
| Thread | Email References/In-Reply-To header chain | "thread-abc123" |
| Order | NER + regex (PO numbers, order references) | "PO-2026-0847" |

#### Relationship Types (Graph Edges)

| Edge | From → To | Extraction |
|------|-----------|------------|
| `sent_to` | Contact → Contact | Email headers |
| `works_at` | Contact → Company | Domain matching + NER |
| `inquired_about` | Contact → Product | NER co-occurrence in inquiry-classified emails |
| `quoted_price` | Product → Price Point | NER extraction from sent emails classified as inquiry responses |
| `ordered` | Company → Product | NER extraction from reorder-classified emails |
| `part_of_thread` | Email → Thread | In-Reply-To / References headers |
| `references_order` | Email → Order | PO number regex extraction |
| `followed_up_on` | Email → Email | Thread chain + time proximity |

#### Storage

SQLite database at `/data/graph/relationships.db`. Chosen over extending Qdrant because graph traversal (multi-hop relationship queries) is natively efficient in SQL with recursive CTEs, while Qdrant excels at similarity search but not relationship traversal. SQLite adds < 10MB RAM overhead, no additional Docker container. Both stores are queried in parallel during context assembly.

#### Entity Extraction Pipeline

Runs as a post-processing step after email classification (§7.3), before draft generation:

```
[Classified email]
    │
    ▼
[Header parser]         → Contact nodes, Thread edges, Company nodes (from domain)
    │
    ▼
[NER pass]              → Product, SKU, Price, Order entities
(local model,             (lightweight — regex patterns + Qwen3-4B with
 piggybacked on            extraction prompt, batched with classification)
 classification call)
    │
    ▼
[Entity resolution]     → Match extracted entities to existing graph nodes
    │                     (fuzzy match on company names, exact match on emails/SKUs)
    ▼
[Graph upsert]          → Insert new nodes/edges, update existing edge timestamps
```

**Latency budget:** < 500ms additional per email. NER prompt is appended to the classification call. Header parsing is negligible. SQLite writes are < 1ms.

**Incremental by design:** Only new emails are processed. The graph accumulates over time. After 30 days of operation at 50 emails/day, the graph contains ~1,500 email nodes, ~50-100 contact nodes, ~20-50 company nodes, and ~200-500 product/price nodes.

#### Graph-Augmented Context Retrieval

When assembling context for draft generation, the system runs two queries in parallel:

1. **Vector similarity (§7.5):** Qdrant top-5 similar sent emails by embedding cosine similarity.
2. **Graph traversal (this section):** Given the inbound email's sender, traverse all previous emails from this contact, all previous emails from this contact's company, all pricing history for products mentioned in this email, and the full thread chain if this email is a reply.

Results are deduplicated and merged by relevance (recency-weighted for graph results, similarity-weighted for vector results). The merged context is capped at a configurable token budget (default: 2,000 tokens) before being passed to the LLM for drafting.

#### Context Source Routing

| Condition | Context Strategy |
|-----------|-----------------|
| Contact exists in graph with > 5 previous emails | **Graph-first**: pull contact history + thread chain + product pricing from graph, supplement with vector similarity |
| Contact is new (not in graph) | **Vector-first**: standard Qdrant similarity search (no graph history exists yet) |
| Thread reply (In-Reply-To header present) | **Thread-first**: full thread chain from graph, plus vector similarity for broader context |

The graph doesn't change which model handles the draft (§7.4 routing logic is unchanged) — it changes what context the model sees.

#### Privacy

The relationship graph is stored locally on the NVMe alongside all other customer data. No graph data is transmitted to MailBox/Glue Co servers. The graph is included in the NVMe encryption (LUKS) boundary.

#### Phase Activation

The relationship graph layer is a Phase 2 deliverable. The graph starts empty and populates incrementally from day one of customer operation. It reaches useful density (~50+ contact nodes, ~200+ email nodes) after approximately 2 weeks of typical email volume (50 emails/day). Phase 1 operates with vector-only context retrieval (§7.5).

### §7.6 Model Selection

| Role | Model | Size | Quantization | Why |
|------|-------|------|-------------|-----|
| Classification + simple drafts | Qwen3-4B | 4B params | Q4_K_M (~2.5GB) | Best tool-use and instruction-following at this size; fits in 8GB VRAM with room for embeddings |
| Embeddings | nomic-embed-text | 137M params | FP16 (~274MB) | High quality, small footprint, Ollama-native |
| Complex drafts | Claude Haiku (cloud API) | — | — | Best cost/quality ratio for email drafting; $0.25/1M input, $1.25/1M output |
| Fallback complex | Claude Sonnet (cloud API) | — | — | For drafts where Haiku quality is insufficient (rare) |

[NEEDS_CLARIFICATION: Should the product support customer-provided API keys (BYOK) for the cloud LLM, or should the appliance use a pooled API key managed by Glue Co with usage billed to the customer? | Affects: §7.6, pricing model, onboarding complexity, cost doctrine]

### §7.7 Persona System

The persona system ensures all generated drafts match the customer's communication style.

| Component | Storage | Description |
|-----------|---------|-------------|
| Voice profile | JSON file on NVMe | Extracted from onboarding email analysis: avg sentence length, formality level, greeting/closing patterns, vocabulary preferences, industry jargon |
| System prompt | Postgres | Base system prompt + persona overlay + category-specific instructions |
| Few-shot examples | Postgres | 3-5 approved email pairs (inbound + customer's actual response) per classification category, curated during onboarding |
| Correction feedback | Postgres | Customer edits to drafts are logged and used to refine system prompts monthly |

### §7.8 Update Mechanism

| Component | Update Method |
|-----------|--------------|
| Container images | Customer clicks "Check for updates" in dashboard → pulls new images from private registry → `docker compose up -d` |
| Local model weights | New model files pulled via Ollama; dashboard shows available model updates |
| n8n workflows | Exported as JSON, imported via n8n API; dashboard surfaces available workflow updates |
| OS / JetPack | Manual (not OTA in v1); upgrade guide provided per release |

[NEEDS_CLARIFICATION: Where should the private container registry be hosted? Options: GitHub Container Registry (free for public, $4/mo for private), self-hosted on Glue Co infrastructure, or Docker Hub. | Affects: §7.8, operating cost, update reliability]

---

## §8. Onboarding Protocol

### §8.1 Pre-Shipment

| Step | Owner | Duration |
|------|-------|----------|
| O-1 | Glue Co | Schedule onboarding call with customer (within 3 days of order) |
| O-2 | Customer | Confirm email provider (Gmail / Outlook / other IMAP) |
| O-3 | Customer | Prepare: product catalog PDF, pricing sheet, any response templates they currently use |
| O-4 | Glue Co | Assemble and QA appliance, ship |

### §8.2 First-Boot (Customer Self-Service, 10 min)

| Step | Action |
|------|--------|
| O-5 | Unbox, connect power + ethernet (or Wi-Fi via quick-start card instructions) |
| O-6 | Navigate to `http://device.local:3000` (or IP shown on quick-start card) |
| O-7 | Create admin account (username + password) |
| O-8 | Wait for system readiness indicator (all services green, ~2 min) |

### §8.3 Guided Onboarding Call (Zoom, 60-90 min)

| Step | Action | Duration |
|------|--------|----------|
| O-9 | Connect email account via OAuth2 or IMAP credentials | 5 min |
| O-10 | Initiate email history ingestion (background, ~30-60 min for 6 months) | 2 min |
| O-11 | Upload knowledge base documents (product catalog, pricing, etc.) | 10 min |
| O-12 | Review auto-generated voice profile, adjust if needed | 10 min |
| O-13 | Walk through 10 sample draft classifications and responses together | 20 min |
| O-14 | Customer marks each draft: good tone / wrong tone / edit | (included above) |
| O-15 | Configure notification preferences (queue threshold, daily digest email) | 5 min |
| O-16 | Explain approval queue workflow, demonstrate approve/edit/reject | 10 min |
| O-17 | Set expectations: 2-week human-review-everything phase, then graduated auto-send | 5 min |

### §8.4 Trust-Building Period (Weeks 1-2)

| Condition | Behavior |
|-----------|----------|
| All auto-send rules | OFF |
| All drafts | Require manual approval |
| Daily digest | ON |
| Check-in call | Day 3 and Day 7 (15 min each) |

### §8.5 Graduated Autonomy (Week 3+)

| Condition | Trigger |
|-----------|---------|
| Enable auto-send for `reorder` | Classification accuracy > 92% for category over prior 7 days AND customer approves |
| Enable auto-send for `scheduling` | Same threshold |
| Enable auto-send for `follow-up` | Same threshold |
| `inquiry` remains manual | Always — too high-stakes for auto-send in v1 |

---

## §9. Pricing Model

### §9.1 Revenue Streams

| Stream | Price | Frequency | Margin |
|--------|-------|-----------|--------|
| Appliance (hardware + software + onboarding) | $699 | One-time | ~50% ($344 COGS + $10-15 cloud costs during onboarding) |
| Support subscription (optional) | $49/mo | Monthly | ~90% (labor only — check-in calls, persona tuning, updates) |
| Cloud API passthrough | Cost + 20% markup | Monthly | 20% |

[NEEDS_CLARIFICATION: Should the $699 include a fixed amount of cloud API credits (e.g., first 3 months included), or should cloud API be billed separately from day one? | Affects: §9.1, cash flow, customer perceived value, onboarding friction]

### §9.2 Cost Model (Per Unit, Monthly Operating)

| Cost | Low | High | Notes |
|------|-----|------|-------|
| Cloud API (customer usage) | $3/mo | $20/mo | Depends on email volume and complex-draft ratio |
| Electricity (customer-paid) | $1/mo | $2/mo | 15-25W sustained |
| Container registry hosting | $0.10/mo | $0.50/mo | Amortized across fleet |
| Support labor (if subscribed) | $5/mo | $15/mo | Amortized; most months require < 30 min |

---

## §10. Success Metrics

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SM-1 | Time-to-first-draft | < 5 minutes from email connection | Dashboard timestamp |
| SM-2 | Classification accuracy (7-day rolling) | > 85% week 1, > 92% week 4 | Dashboard accuracy log (customer corrections / total classified) |
| SM-3 | Customer email time saved | > 50% reduction self-reported | Post-30-day survey |
| SM-4 | Draft approval rate (approved without edit / total drafts) | > 60% by week 4 | Dashboard approval log |
| SM-5 | Appliance uptime | > 99% monthly | System status log |
| SM-6 | Customer retention (support subscribers) | > 70% at 6 months | Subscription data |
| SM-7 | Net Promoter Score | > 40 | Post-60-day survey |
| SM-8 | Unit economics | Positive contribution margin by unit 10 | Revenue - COGS - support labor |
| SM-9 | Draft approval rate for repeat contacts (graph-augmented, Phase 2+) | > 10 percentage points higher than vector-only baseline | A/B comparison during Phase 2 beta |
| SM-10 | Entity extraction accuracy (Phase 2+) | > 85% precision, > 70% recall on 100 manually reviewed entities | Manual evaluation against ground truth |

---

## §11. Scope Boundaries

### In Scope (v1)

- Inbound email triage and response drafting for operational brand communications
- Gmail and Outlook OAuth2 + generic IMAP/SMTP
- Local + cloud hybrid inference
- Human-in-the-loop approval workflow with graduated autonomy
- RAG over customer's email history and uploaded documents
- Local web dashboard (LAN access)
- White-glove onboarding (1 Zoom session + 2 check-in calls)
- OTA container updates (customer-initiated)

### Out of Scope (v1)

- Consumer D2C support email (returns, complaints, order status)
- Email marketing or outbound campaign generation
- CRM integration (HubSpot, Salesforce, Pipedrive)
- Multi-user access control (v1 is single admin user)
- E-commerce platform integration (Shopify, Amazon)
- Voice/phone integration
- Mobile app (dashboard is mobile-responsive web only)
- Remote access outside LAN (unless NEEDS_CLARIFICATION resolved)
- Custom carrier board or production-grade hardware (v1 uses dev kit)
- Automated persona tuning without human review

### Future Consideration (v2+)

- Tailscale/WireGuard remote access
- Multi-user roles (admin, reviewer, read-only)
- CRM sync (bi-directional with HubSpot)
- Shopify order context injection into RAG
- Fleet management dashboard for Glue Co (monitor all deployed appliances)
- Custom molded enclosure with branding
- Orin NX 16GB upgrade path for higher-volume customers
- Outbound campaign drafting (follow-up sequences)
- Relationship graph dashboard view (visual map of contacts, companies, products, and deal flows)
- Graph-powered proactive follow-up suggestions (detect stale threads where a follow-up is overdue)
- Cross-account graph merge (if customer adds a second email account, unify the contact/company graph)

---

## §12. External Dependencies

| Dependency | Status | Risk | Mitigation |
|-----------|--------|------|------------|
| NVIDIA Jetson Orin Nano Super Dev Kit availability | In stock at $249, high-demand with occasional backorders | Medium | Pre-order 10+ units from Arrow/Seeed; maintain 2-unit buffer |
| Anthropic Claude API | GA, stable | Low | Fallback to OpenAI GPT-4o-mini if needed; model-agnostic API wrapper in n8n |
| Ollama ARM64 + CUDA support | Stable, NVIDIA-supported | Low | Pinned container image version |
| Qdrant Docker ARM64 | Available, Rust-native | Low | Pinned version |
| n8n self-hosted | Stable, active development | Low | Pinned version; workflow JSON is portable |
| Gmail OAuth2 | Requires Google Cloud project + OAuth consent screen | Medium | Pre-configure OAuth app; customer authorizes during onboarding |
| Outlook OAuth2 | Requires Azure AD app registration | Medium | Pre-configure Azure app; customer authorizes during onboarding |

---

## §13. Risks

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Classification accuracy below 85% for niche CPG vocabulary | Medium | High — customer loses trust, churns | Pre-load CPG industry vocabulary in system prompt; aggressive few-shot tuning during onboarding; fast-path to cloud model for uncertain classifications |
| Customer email provider blocks IMAP polling or OAuth token expires | Medium | High — appliance stops working silently | Health check daemon monitors IMAP connection every 5 min; sends alert notification on failure; dashboard shows connection status prominently |
| 8GB VRAM insufficient for future model upgrades | Low (v1) | Medium (v2) | Design model-selection layer to be swappable; Orin NX 16GB upgrade path documented |
| Customer sends embarrassing auto-approved email | Low | Very High — reputational damage, product-killing | Auto-send OFF by default; graduated autonomy requires explicit customer opt-in per category; all auto-sent emails logged with full audit trail |
| Jetson supply chain disruption | Low | High — can't ship units | Maintain 2-unit buffer inventory; evaluate Raspberry Pi 5 + cloud-only as emergency fallback |
| n8n workflow complexity exceeds maintainability | Medium | Medium | Keep workflow graph simple (< 20 nodes); use code nodes sparingly; document every workflow thoroughly |

---

## §14. Phase Plan

### Phase 1: Prototype (Internal Dogfood)

> Phase 1 of 3 | Duration estimate: 4-6 weeks
> Budget cap: $800 (1 unit hardware + cloud API for testing)
> Entry criteria: PRD approved, NEEDS_CLARIFICATION items resolved
> Depends on: Nothing

**Objective:** Prove the end-to-end email processing pipeline works on Jetson hardware with a real email account (Dustin's Heron Labs inbox).

**Deliverables:**

| # | Deliverable | Exit Criteria |
|---|------------|---------------|
| 1 | Assembled Jetson appliance running full Docker Compose stack | All 5 services start and pass health checks within 3 min of boot |
| 2 | IMAP → classify → draft → queue pipeline | 50 consecutive inbound emails processed without error |
| 3 | Local model classification | Accuracy > 80% on Heron Labs email corpus (100-email test set) |
| 4 | Cloud API draft generation | Drafts generated for 10 complex inquiry emails; 7/10 rated "sendable with minor edits" |
| 5 | RAG pipeline with email history | Retrieved context is relevant for 8/10 test queries (manual evaluation) |
| 6 | Dashboard with approval queue | Approve, edit, reject actions work end-to-end; approved email sends via SMTP |

**Kill Criteria:**
- Jetson hardware cannot run Ollama + Qdrant + n8n simultaneously without OOM or thermal throttle under sustained load
- Classification accuracy < 70% after prompt tuning (model is insufficient for the task)
- End-to-end latency > 120 seconds for local-model path

**Cost Estimate:**

| Category | Low | High |
|----------|-----|------|
| Hardware (1 unit) | $344 | $344 |
| Cloud API (testing) | $20 | $50 |
| Development time | 60 hrs | 100 hrs |
| **Total** | **$364** | **$394** + time |

---

### Phase 2: Beta (3-5 Paying Customers)

> Phase 2 of 3 | Duration estimate: 6-8 weeks
> Budget cap: $3,000
> Entry criteria: Phase 1 exit criteria met
> Depends on: Phase 1

**Objective:** Validate the product with real CPG brand operators and prove the onboarding protocol works without the builder present.

**Deliverables:**

| # | Deliverable | Exit Criteria |
|---|------------|---------------|
| 1 | 3-5 appliances shipped to beta customers | All units operational within 24 hours of receipt |
| 2 | Onboarding protocol executed | All customers complete onboarding in single 90-min session |
| 3 | 30-day operation | All units maintain > 99% uptime over 30 days |
| 4 | Customer satisfaction | NPS > 30 across beta cohort |
| 5 | Classification accuracy | > 85% average across all beta customers at day 30 |
| 6 | OTA update mechanism | At least 1 update pushed and successfully applied to all units |
| 7 | Relationship graph — entity extraction (§7.5.1) | Header parsing + NER pipeline running on every classified email with zero pipeline failures over 7-day test period |
| 8 | Relationship graph — context retrieval (§7.5.1) | Graph-augmented context rated "more relevant" than vector-only in > 70% of 50 test cases where contact has prior history (manual blind comparison by beta tester) |

**Kill Criteria:**
- 2+ customers churn within 30 days citing product quality (not pricing or fit)
- Average onboarding time exceeds 2 hours
- Classification accuracy < 80% for any customer after 30 days

**Cost Estimate:**

| Category | Low | High |
|----------|-----|------|
| Hardware (5 units) | $1,720 | $1,720 |
| Cloud API (5 customers × 2 months) | $60 | $200 |
| Support labor (onboarding + check-ins) | $500 | $1,000 |
| Relationship graph development (NER prompts, SQLite schema, n8n integration) | 8 hrs | 12 hrs |
| **Total** | **$2,280** | **$2,920** + dev time |

---

### Phase 3: Commercial Launch

> Phase 3 of 3 | Duration estimate: Ongoing
> Budget cap: $10,000 initial inventory
> Entry criteria: Phase 2 exit criteria met, positive unit economics validated
> Depends on: Phase 2

**Objective:** Sell MailBox One as a repeatable product through direct sales and Glue Co network.

**Deliverables:**

| # | Deliverable | Exit Criteria |
|---|------------|---------------|
| 1 | 20-unit initial production run | All units assembled, QA'd, and shelf-ready |
| 2 | Sales page + checkout flow | Live on Glue Co or dedicated product domain |
| 3 | Self-service onboarding documentation | Customer can complete first-boot without Zoom (Zoom still included but optional) |
| 4 | Fleet monitoring dashboard (Glue Co internal) | View status of all deployed units |
| 5 | Support runbook | Documented troubleshooting for top 10 failure modes |

**Kill Criteria:**
- Fewer than 10 units sold in first 90 days
- Support cost per customer exceeds $30/month sustained
- Product returns exceed 20%

---

## §15. Open Questions (NEEDS_CLARIFICATION Summary)

| # | Question | Section | Impact |
|---|----------|---------|--------|
| NC-1 | Remote access (WireGuard/Tailscale) in v1 or defer to v2? | §4.6 | Security architecture, onboarding complexity |
| NC-2 | SMS/Slack notifications in v1 or email-only? | §4.8 | Notification service scope |
| NC-3 | Target initial production run size? | §6.1 | Volume pricing, enclosure customization |
| NC-4 | BYOK API keys vs. pooled Glue Co API key? | §7.6 | Pricing model, onboarding flow |
| NC-5 | Cloud API credits included in $699 or billed separately? | §9.1 | Cash flow, perceived value |
| NC-6 | Container registry hosting location? | §7.8 | Operating cost, update reliability |

---

## §16. Appendix: Technology Decision Records

### DR-1: n8n as Orchestrator (vs. Custom Python)

**Decision:** Use self-hosted n8n as the workflow orchestrator.

**Rationale:** n8n provides visual workflow editing, built-in IMAP/SMTP nodes, native LLM integration (Ollama + Anthropic nodes), human-in-the-loop patterns, and a large template library. Custom Python would require building all of this from scratch. n8n's self-hosted version has unlimited executions, eliminating per-email costs at the orchestration layer.

**Trade-off:** n8n adds ~512MB RAM overhead and introduces a dependency on their release cycle. Acceptable for v1 given the 8GB total system memory and n8n's active maintenance.

### DR-2: Qdrant as Vector Store (vs. ChromaDB, pgvector)

**Decision:** Use Qdrant for vector storage.

**Rationale:** Qdrant is Rust-native (fast, low memory), has proven ARM64 Docker images, provides REST + gRPC APIs, and supports payload filtering (critical for scoping RAG queries by email account and date range). ChromaDB is Python-based and heavier. pgvector would consolidate into Postgres but lacks Qdrant's filtering and index optimization for this workload.

### DR-3: Jetson Orin Nano Super (vs. Mac mini M4, Raspberry Pi 5)

**Decision:** Use Jetson Orin Nano Super as the compute platform.

**Rationale:** 67 TOPS GPU acceleration at $249 is the best cost/performance for local LLM inference in a low-power form factor. Mac mini M4 is 2.5x the price ($599) and harder to pre-configure for headless appliance use. Raspberry Pi 5 lacks meaningful GPU acceleration (2 TOPS) and would require cloud-only inference, defeating the privacy and cost advantage.

**Trade-off:** 8GB unified memory limits local model size to ~4B parameters quantized. Acceptable for v1 email classification + simple drafting workload.

### DR-4: Hybrid Local + Cloud Inference (vs. Local-Only, Cloud-Only)

**Decision:** Route simple tasks to local Ollama, complex tasks to cloud Claude API.

**Rationale:** Local-only would limit draft quality for complex emails. Cloud-only would eliminate the privacy advantage and make operating costs unpredictable. Hybrid gives the best of both: 80%+ of email volume handled locally at zero marginal cost, with cloud fallback for quality-sensitive drafts. Estimated cloud API cost: $3-20/month per customer.

### DR-5: SQLite Relationship Graph for Structural Context (vs. Extending Qdrant, vs. Neo4j)

**Decision:** Add a SQLite-based relationship graph (§7.5.1) alongside the existing Qdrant vector store, inspired by the code-review-graph pattern (Tree-sitter AST → SQLite graph → blast-radius traversal).

**Rationale:** Pure vector similarity retrieval cannot distinguish "the specific pricing I quoted this retailer last month" from "a semantically similar quote to a different retailer." Structural traversal (contact → previous emails → product pricing history) produces precisely scoped context. SQLite was chosen over extending Qdrant because multi-hop graph traversal is natively efficient in SQL with recursive CTEs, while Qdrant lacks relationship traversal capabilities. Neo4j was rejected because it adds a Docker container, ~500MB RAM, and operational complexity disproportionate to the graph size (< 10K nodes at typical volume).

**Trade-off:** Adds ~8-12 hours of Phase 2 development and a second data store to maintain. NER entity extraction adds < 500ms latency per email. The graph is additive — if it underperforms, the system falls back to vector-only retrieval with zero degradation. SQLite adds < 10MB RAM overhead.
