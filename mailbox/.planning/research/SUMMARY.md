# Project Research Summary

**Project:** MailBox One — AI Email Agent Appliance
**Domain:** Edge AI appliance for B2B operational email (small CPG brands)
**Researched:** 2026-04-02
**Confidence:** MEDIUM-HIGH

## Executive Summary

MailBox One is an ARM64 edge appliance that runs a local LLM email agent on a Jetson Orin Nano Super 8GB, purpose-built for small CPG brand operators managing B2B operational email. The established pattern for this class of product is a Docker Compose stack with Ollama for local inference, Qdrant for vector retrieval, n8n for workflow orchestration, and Postgres as the unified operational store. The appliance ingests a user's sent history at first boot, builds a CPG-specific email classification pipeline, and presents a human-in-the-loop approval queue as the primary interface. The strongest architectural commitment is local-first privacy: the Anthropic Claude API is used only for complex drafts, receiving only the current email context — never the full corpus.

The recommended approach is to ship a tightly scoped v1 around a single core loop: IMAP ingestion → Qwen3-4B classification → draft generation (local + cloud hybrid) → approval queue → SMTP send. Everything else — auto-send rules, relationship graphs, multi-user access, external integrations — is explicitly deferred. The approval queue is not a compromise; it is the trust-building mechanism that makes any subsequent automation safe. Research shows that all serious B2B AI email products gate behind review, and the operators who adopt graduated auto-send are more satisfied than those who had it forced on them.

The biggest risks cluster around the Jetson hardware platform and the n8n IMAP subsystem. Docker version management on JetPack is fragile: a routine `apt upgrade` can silently break GPU passthrough. Ollama's unified-memory heuristics misfire on Tegra SOCs, causing CPU fallback with no obvious error. The n8n IMAP trigger has a documented 10% email miss rate and a known "trigger death" bug after 30-60 minutes of operation. All three of these must be addressed with explicit preventative measures in Phase 1 — they are not optional hardening steps.

---

## Key Findings

### Recommended Stack

The stack is optimized for an 8GB unified-memory ARM64 device where every megabyte is contested. The two model choices fit comfortably within a ~5.7GB peak footprint, leaving 2.3GB of headroom: Qwen3-4B Q4_K_M at ~2.7GB for classification and simple drafts, and nomic-embed-text v1.5 at 274MB for embeddings. Critically, Ollama must not have a `mem_limit` in docker-compose — the container uses `/proc/meminfo` (not NVML) to detect GPU memory on Jetson, and a cgroup memory limit causes it to underestimate available VRAM and fall back to CPU. All other services should have explicit limits.

The n8n 2.x fair-code workflow engine is the right orchestrator choice: it has native IMAP trigger, SMTP send, Ollama Model, Anthropic Chat Model, Qdrant vector store, and Postgres nodes. Building equivalent orchestration in Python would require an additional container, more memory, and 2-3x the development time. React + Vite (multi-stage build into nginx:alpine) serves the dashboard with zero runtime Node.js overhead at idle.

**Core technologies:**
- **Ollama 0.18.4:** Local LLM inference — native JetPack 6 GPU support, single-command model management, n8n native integration; do not apply `mem_limit`
- **Qwen3-4B Q4_K_M:** Classification + simple drafts — 2.7GB VRAM, 32K context, Q4_K_M confirmed on Ollama library; use `/no_think` system prompt for latency-sensitive classification
- **nomic-embed-text v1.5:** RAG embeddings — 274MB, 45M+ downloads, stays below Qwen3 VRAM budget; set `OLLAMA_KEEP_ALIVE=5m` (load on demand, not permanent)
- **Qdrant 1.17.1:** Vector store — Rust binary, low idle memory, payload filtering, official ARM64 image; watch for jemalloc ARM64 page size bug (workaround: `MALLOC_CONF=narenas:1`)
- **n8n 2.14.2:** Workflow orchestrator — native IMAP/SMTP/Ollama/Anthropic nodes, ARM64 Docker image; set `N8N_RUNNERS_ENABLED=true` and prune execution history from day one
- **Postgres 17-alpine:** Operational store for n8n state, approval queue, sent history, persona config — 80MB image, multi-arch; required (n8n 2.x drops SQLite in multi-user mode)
- **claude-haiku-4-5-20251001:** Cloud path for complex drafts — $1/1M input tokens, 200K context, supply model ID string directly in n8n node
- **Node.js 22 + Express 4 + React 18 + Vite 6:** Dashboard API + UI — multi-stage build → nginx:alpine serves static files at zero idle CPU cost
- **Docker 28.0.1+ via JetsonHacks script:** Container runtime — never use `docker-ce` from Docker Inc. repos; pin version and `apt-mark hold`
- **JetPack 6.2.2 (r36.5):** Host OS — fixes the memory fragmentation bug that causes Ollama CUDA allocation failures on r36.4.x; required, not optional

**Version constraints:**
- Docker: must be ≥28.0.1 (28.0.0 broke Jetson GPU passthrough)
- JetPack: 6.2.2 (r36.5) for memory fragmentation fix; 6.2 for Super Mode 40 TOPS
- n8n: 2.x (1.x EOL); requires Postgres 13+
- Tailwind: v4 requires Vite 6 via `@tailwindcss/vite` plugin

### Expected Features

The core value chain is linear and cannot be reordered: email connectivity must exist before classification, classification before drafting, drafting before the approval queue, approval queue before auto-send. This dependency chain defines the phase structure. Persona tuning (voice extraction from sent history) enhances draft quality significantly and should happen at first boot alongside history ingestion — not deferred.

The CPG-specific 8-category taxonomy (inquiry, reorder, scheduling, follow-up, internal, spam, escalate, unknown) is the primary differentiator versus horizontal competitors. No existing tool has vertical specificity at this level. The local-first privacy commitment is the second differentiator and should be marketed explicitly. Graduated auto-send per category (default OFF, enabled by operator after observing accuracy) is the third differentiator and a direct response to the single biggest risk of AI email agents: a wrong send that damages a buyer relationship.

**Must have (table stakes):**
- Email connectivity (Gmail OAuth2 or IMAP/SMTP app password) — nothing works without it
- 8-category CPG-specific email classification — core intelligence surface
- Hybrid local + cloud draft generation — the value proposition
- Approval queue with approve / edit / reject / escalate — minimum trust surface
- Email thread history in RAG context — drafts without context are generic
- Document upload (knowledge base) — price lists, product specs, policies
- Persona tuning from sent history at onboarding — voice profile prevents "chatbot voice" objection
- First-boot wizard (connect email, ingest history) — appliance onboarding pattern
- Sent history log + classification log — baseline accountability
- System status dashboard — appliance health visibility
- Daily digest + queue threshold alert — pull-based awareness
- Confidence score display on queue items — lets users triage review effort

**Should have (competitive differentiation):**
- Graduated auto-send per category (default OFF, unlock after N approved drafts)
- Local-first + cloud path label on each draft ("Local / Qwen3" vs "Cloud / Claude Haiku")
- Classification accuracy reporting + edit-rate trend
- OTA update management UI
- Graceful degradation: offline queue + local-only draft fallback

**Defer (v2+):**
- Relationship graph (contact/company context) — v1 vector RAG gets 80% of the value
- Multi-user / RBAC — single admin in v1
- CRM / Shopify / EDI integrations — validate email intelligence before connecting systems
- Active learning from edit corrections — model fine-tuning on 8GB VRAM is risky
- Remote access via Tailscale — LAN-only is the v1 constraint
- SMS / Slack notifications — email-only sufficient for v1

**Anti-features to explicitly not build:**
- Global auto-send (no approval) — catastrophic trust failure on first mistake
- Full email client / compose interface — scope explosion, competes with Gmail and loses
- Real-time email push — 60s poll is sufficient for operational (non-chat) email

### Architecture Approach

The system is a five-container Docker bridge network where n8n owns all business logic. n8n orchestrates the full pipeline — IMAP polling, embedding, classification, RAG retrieval, draft generation, queue writes, SMTP send. The Dashboard is a thin read/write surface on top of Postgres, calling n8n webhooks for send actions. Ollama and Qdrant are internal-only services with no host port exposure. This single-orchestrator pattern eliminates a Python microservice layer, reduces container count, and keeps failure domains small.

**Major components:**
1. **n8n (orchestrator)** — owns all pipeline logic: IMAP poll → parse → embed → classify → route → draft → queue write → SMTP send; all AI calls route through n8n workflows
2. **Ollama (inference)** — serves Qwen3-4B (permanent resident, `KEEP_ALIVE=-1`) and nomic-embed-text (on-demand, `KEEP_ALIVE=5m`); no `mem_limit` in compose; no host port binding
3. **Qdrant (vector store)** — two collections: `email_history` (RAG context) and `knowledge_base` (brand documents); explicit `mem_limit: 512m`; HNSW index kept in RAM
4. **Postgres (operational store)** — n8n execution state, approval queue, draft store, sent history, persona config; Dashboard reads via read-only user; n8n and Dashboard write via separate users
5. **Dashboard (UI)** — React/Vite SPA served by nginx:alpine; reads Postgres directly; triggers sends via n8n REST API; never calls Ollama directly

**Key patterns:**
- Ollama `mem_limit: none` — required for correct GPU detection on Jetson unified memory
- Postgres as approval queue store (not Redis) — n8n already requires Postgres; no additional container
- Single Docker bridge network — internal services (Ollama, Qdrant, Postgres) unreachable from LAN
- Model-stays-loaded strategy — Qwen3-4B `OLLAMA_KEEP_ALIVE=-1`; 30s SLA impossible with 3-5s cold load per email

### Critical Pitfalls

1. **Docker version on JetPack breaks GPU passthrough** — use JetsonHacks `install_nvidia_docker.sh` (pins 27.5.1); never use `docker-ce` from Docker Inc. repos; `apt-mark hold` after install; verify with `docker run --rm --runtime nvidia nvidia-smi` before any other work
2. **Ollama silent CPU fallback on unified memory exhaustion** — run JetPack 6.2.2 (r36.5) for memory fragmentation fix; set `OLLAMA_NUM_GPU=99`; never apply `mem_limit` to Ollama container; verify `num_gpu_layers > 0` after each deploy
3. **n8n IMAP trigger silently dies after 30-60 minutes** — enable "Force Reconnect Every Minutes" (set to 5-10 min) in IMAP node; add watchdog workflow that alerts if no processing for 15+ minutes during business hours; never trust IMAP trigger without this safety net
4. **Gmail OAuth review blocks deployment for weeks** — for dogfood, use OAuth "Testing" mode with Dustin's account as test user (bypasses review); for customers, bundle pre-reviewed OAuth client in appliance; offer App Password fallback
5. **LLM returns invalid JSON or out-of-taxonomy category** — use Ollama structured output (`format` parameter with JSON schema); set `temperature: 0` for classification; strip `<think>` block before JSON parse for Qwen3; implement category validation node with fallback to "unknown"
6. **OTA update bricks appliance with no remote recovery** — tag releases semantically (never push `latest`); pre-pull new image and run smoke test before stopping old container; keep previous image on-device until post-update health check passes; design and test recovery before first customer OTA

---

## Implications for Roadmap

Based on research, the dependency chain, platform constraints, and pitfall timing requirements suggest a 4-phase structure. The key forcing function is that infrastructure correctness (GPU passthrough, Docker pinning, power mode) must be verified before any LLM work begins — a broken hardware layer makes all subsequent testing meaningless.

### Phase 1: Infrastructure Foundation

**Rationale:** GPU passthrough, Docker version pinning, memory budgets, Jetson power mode, and Postgres volume persistence must all be correct before any application work starts. Two of the seven critical pitfalls (Docker GPU breakage, Ollama CPU fallback) are Phase 1 concerns. Getting this wrong wastes all Phase 2 time on debugging the wrong layer.

**Delivers:** A verified Docker Compose stack with all five services running, GPU inference confirmed at target latency, model pull complete, and a first-boot script that sets 25W power mode and validates GPU passthrough.

**Addresses:** System status dashboard (health visibility), appliance hardware baseline

**Avoids:** Docker 28.x GPU breakage, Ollama CPU silent fallback, Postgres data loss (named volume), Qdrant ARM64 jemalloc bug

**Actions required:**
- JetsonHacks Docker install script; `apt-mark hold`
- Verify JetPack 6.2.2 (r36.5); set power mode MAXN SUPER or 25W
- `docker compose up` all five services with correct `mem_limit` config (Ollama: none, others: explicit)
- `ollama pull qwen3:4b` and `ollama pull nomic-embed-text:v1.5`; verify `num_gpu_layers > 0`
- Qdrant jemalloc workaround if ARM64 page size error occurs
- `EXECUTIONS_DATA_PRUNE=true` in n8n from day one

### Phase 2: Email Pipeline Core

**Rationale:** This is the minimum viable loop — nothing else in the product is meaningful without it. Email connectivity (OAuth design decision must be made before writing auth code), classification with guardrails, RAG context retrieval, draft generation, and the approval queue all depend on each other and should be built as a connected pipeline, not separately. The n8n IMAP watchdog and Gmail OAuth strategy are Phase 2 decisions that must not slip.

**Delivers:** End-to-end pipeline for a single email: IMAP ingestion → Qwen3-4B classification → Qdrant RAG retrieval → local or cloud draft → Postgres approval queue → Dashboard approve → SMTP send. Persona tuning at first boot via history ingestion. Knowledge base upload.

**Addresses:** Email connectivity, 8-category classification, draft generation, approval queue, RAG context, knowledge base, persona tuning, history ingestion wizard, sent log, classification log, confidence score display

**Avoids:** IMAP trigger death (watchdog + Force Reconnect), Gmail OAuth review blocking (Testing mode + App Password fallback), LLM JSON guardrails (structured output + category validation), Qdrant mmap thrash (explicit memory limits), email credentials in workflow JSON (n8n credential store from day one)

**Actions required:**
- Gmail OAuth strategy: Testing mode OAuth client for dogfood + App Password fallback
- n8n IMAP trigger with Force Reconnect enabled + watchdog workflow
- Classification prompt with Ollama structured output, `temperature: 0`, `<think>` stripping, fallback to "unknown"
- Qdrant collections: `email_history` and `knowledge_base` with explicit `hnsw_config.on_disk: false`
- History ingest workflow (batches of 50 emails, disable HNSW indexing during bulk ingest)
- Dashboard: approval queue UI with original email + draft side-by-side, local/cloud label on each draft

### Phase 3: Reliability and Operator Trust

**Rationale:** After core pipeline is validated against real Heron Labs email, the next priority is giving the operator visibility and control. Graduated auto-send (the most important differentiator after privacy) requires classification accuracy data to gate on. OTA infrastructure must be designed before any customer update is shipped.

**Delivers:** Graduated auto-send per category with confidence gates (default OFF), classification accuracy + edit-rate reporting, OTA update management UI with atomic rollback, graceful degradation (offline queue + local-only draft flag), dashboard queue depth metrics.

**Addresses:** Graduated auto-send, accuracy reporting, OTA management, offline graceful degradation

**Avoids:** OTA update bricking appliance (atomic update with rollback; previous image retained)

**Actions required:**
- Auto-send unlock logic: per-category, requires N approved drafts with edit rate below threshold
- OTA: semantic version tags on GHCR; pre-pull + smoke test before replacing running service; rollback tag stored on device
- Graceful degradation: `draft_status='pending_cloud'` for failed cloud calls; retry on next cycle; surface to user

### Phase 4: Polish and Dogfood Hardening

**Rationale:** Security hardening, UX polish, and production readiness items that are important but don't block core function. These are discovered gaps from dogfood rather than pre-planned features.

**Delivers:** Dashboard authentication (required before any non-dogfood deployment), PII scrubbing before Claude API calls, session persistence on mobile, execution history pruning, Qdrant snapshot automation, edge case email handling (HTML-only bodies, non-English, empty subjects).

**Addresses:** Security (dashboard auth, OAuth token encryption, PII before cloud call), UX gaps discovered in dogfood

**Avoids:** All remaining security mistakes from PITFALLS.md

### Phase Ordering Rationale

- Phase 1 must precede all others because GPU passthrough validation is the foundation. Any integration work done before this is verified may be debugging the wrong layer.
- Phase 2 must be completed end-to-end before splitting into separate tracks. The RAG quality depends on history ingestion, which depends on email connectivity, which depends on OAuth strategy. Building these in parallel creates integration debt.
- Phase 3 requires real email volume data to tune auto-send thresholds. It cannot be designed before Phase 2 dogfood generates accuracy metrics.
- Phase 4 items are by definition reactive to dogfood findings; sequencing them before dogfood is premature.

### Research Flags

Phases likely needing `/gsd:research-phase` during planning:

- **Phase 1:** JetPack 6.2.2 availability and upgrade path from 6.2.0/6.2.1 needs verification; r36.5 release date and current availability should be confirmed before planning first-boot script
- **Phase 2:** n8n IMAP node behavior on 2.14.2 specifically (the IMAP trigger death bug may have changed; verify against current community reports before committing to watchdog design)
- **Phase 2:** Gmail OAuth "Testing mode" current limits (100 test users — confirm this is still accurate and sufficient for Heron Labs dogfood scope)
- **Phase 3:** OTA atomic update pattern for Docker Compose on Jetson — no single canonical reference found; implementation approach needs validation

Phases with well-documented standard patterns (skip research-phase):

- **Phase 1 (Docker Compose stack):** JetsonHacks scripts, NVIDIA container toolkit, and n8n self-hosted AI starter kit are all authoritative and current sources. No gaps.
- **Phase 2 (Qdrant RAG pipeline):** Standard chunking + embedding + vector search pattern is well-documented. Qdrant ARM64 workaround is documented.
- **Phase 4 (Dashboard auth):** Express session + password auth is well-documented standard pattern.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | MEDIUM-HIGH | All core technology choices verified against official docs and current sources (2026-03-26 to 2026-04-02). ARM64-specific Docker and Ollama behavior confirmed via GitHub issues and NVIDIA forums. Memory budget calculations have inherent uncertainty due to unified memory non-determinism. |
| Features | MEDIUM-HIGH | Table stakes and must-have features are HIGH confidence — directly derived from PROJECT.md validated requirements and clear product dependency chain. Competitor analysis is MEDIUM confidence — public documentation as of early 2026, evolves rapidly. |
| Architecture | HIGH (components), MEDIUM (memory) | Component responsibilities and communication patterns are HIGH confidence, confirmed by n8n self-hosted AI starter kit and official documentation. Memory budget figures are MEDIUM confidence — Ollama unified memory allocation is non-deterministic on Tegra; real figures may vary 10-20%. |
| Pitfalls | HIGH | All critical pitfalls verified via official NVIDIA developer forums, GitHub issues with open status, and n8n community reports with reproducible descriptions. The n8n IMAP 10% miss rate and trigger death bug are particularly well-documented with multiple independent reports. |

**Overall confidence:** MEDIUM-HIGH

### Gaps to Address

- **JetPack 6.2.2 (r36.5) availability:** PITFALLS.md recommends r36.5 for the memory fragmentation fix, but the STACK.md references JetPack 6.2 generally. The exact release version and upgrade path should be confirmed before writing the first-boot provisioning script. If r36.5 is not yet available, a workaround via memory reservation may be needed.

- **n8n IMAP trigger behavior on 2.14.2:** The documented bug (trigger death after 30-60 min) is the single highest-risk operational failure. Its status in the current n8n release (2.14.2, March 2026) is not confirmed fixed. Implementation should assume it still exists and design around it — but should verify against n8n changelog before planning the watchdog architecture.

- **Qdrant ARM64 jemalloc issue (#4298):** Open as of November 2025. Workaround (`MALLOC_CONF=narenas:1`) has MEDIUM confidence. The official multi-arch image tag (`-arm64` explicit pull) behavior needs to be tested in Phase 1 Sprint 1 before assuming it's resolved.

- **Real email volume for dogfood:** The CPG operational email corpus at Heron Labs is unknown. Memory budget, poll interval, and Qdrant collection sizing assumptions are all calibrated for 20-50 emails/day. If actual volume is higher, Phase 2 configuration will need adjustment.

- **Claude Haiku 4.5 pricing and rate limits:** Cited at $1/1M input tokens. Rate limits for a new Anthropic account are not specified in the research. Should be confirmed before designing the cloud fallback retry logic.

---

## Sources

### Primary (HIGH confidence)
- [JetsonHacks — Docker Setup on JetPack 6](https://jetsonhacks.com/2025/02/24/docker-setup-on-jetpack-6-jetson-orin/) — Docker version pinning, GPU runtime setup, install_nvidia_docker.sh
- [NVIDIA Developer Forums — Ollama CPU fallback](https://forums.developer.nvidia.com/t/jetson-orin-nano-8gb-docker-issue-ollama-falls-back-to-cpu-when-stable-diffusion-is-running/356279) — unified memory CPU fallback behavior
- [NVIDIA Developer Forums — Free up RAM for Ollama on Jetson Orin Nano Super](https://forums.developer.nvidia.com/t/free-up-more-ram-for-ollama-jetson-orin-nano-super/331663) — mem_limit + /proc/meminfo detection
- [Ollama GitHub — Option to disable CPU fallback for SOC unified memory](https://github.com/ollama/ollama/issues/10178) — OLLAMA_NUM_GPU=99 workaround
- [n8n Community — IMAP trigger skipping ~10% of emails](https://community.n8n.io/t/imap-trigger-skipping-about-10-of-the-emails/92043) — miss rate and trigger death documentation
- [n8n GitHub — IMAP trigger not working after period of time](https://community.n8n.io/t/n8n-bug-report-imap-trigger-not-working-after-a-period-of-time/47796) — trigger death bug report
- [NVIDIA JetPack 6.2 Super Mode Blog](https://developer.nvidia.com/blog/nvidia-jetpack-6-2-brings-super-mode-to-nvidia-jetson-orin-nano-and-jetson-orin-nx-modules/) — 2x inference speedup, 40 TOPS, power modes
- [Ollama GitHub Releases](https://github.com/ollama/ollama/releases) — v0.18.4 latest stable confirmed 2026-03-26
- [Qdrant GitHub Releases](https://github.com/qdrant/qdrant/releases) — v1.17.1 latest stable confirmed 2026-03-27
- [n8n Release Notes](https://docs.n8n.io/release-notes/) — 2.14.2 current stable (March 2026)
- [Qdrant ARM64 jemalloc issue #4298](https://github.com/qdrant/qdrant/issues/4298) — open issue, workaround documented
- [n8n self-hosted AI starter kit](https://github.com/n8n-io/self-hosted-ai-starter-kit) — reference architecture for n8n + Ollama + Qdrant

### Secondary (MEDIUM confidence)
- [Distil Labs — Best Base Model for Fine-Tuning Benchmark](https://www.distillabs.ai/blog/we-benchmarked-12-small-language-models-across-8-tasks-to-find-the-best-base-model-for-fine-tuning/) — Qwen3-4B classification superiority vs Llama-3.2-3B
- [Anthropic Models Overview](https://platform.claude.com/docs/en/about-claude/models/overview) — claude-haiku-4-5-20251001 model ID and pricing
- [Qdrant memory consumption guide](https://qdrant.tech/articles/memory-consumption/) — mmap behavior and collection sizing
- Competitor feature pages: Superhuman, Shortwave, Help Scout, Front, SaneBox, Fyxer, Lindy — feature landscape analysis
- B2B email automation patterns: Zapier HITL guide, StackAI HITL design, Beam.ai agent templates

### Tertiary (LOW confidence, needs validation)
- JetPack 6.2.2 (r36.5) memory fragmentation fix — referenced in NVIDIA forums; exact release and availability needs confirmation before planning first-boot script
- nomic-embed-text-v2-moe analysis — deferred for v2; current v1.5 recommendation is high confidence

---

*Research completed: 2026-04-02*
*Ready for roadmap: yes*
