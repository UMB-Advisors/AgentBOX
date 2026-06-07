# Architecture Research

**Domain:** Edge AI appliance — local LLM email agent on Jetson Orin Nano Super
**Researched:** 2026-04-02
**Confidence:** HIGH (component behavior), MEDIUM (memory budgets — unified memory makes Ollama allocation non-deterministic)

---

## Standard Architecture

### System Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                      EXTERNAL BOUNDARY                               │
│  Gmail / Outlook (IMAP/SMTP)          Anthropic Claude API           │
│         │                                      │                     │
└─────────┼──────────────────────────────────────┼─────────────────────┘
          │                                      │
┌─────────▼──────────────────────────────────────▼─────────────────────┐
│                   DOCKER BRIDGE NETWORK (mailbox-net)                │
│                                                                      │
│  ┌───────────────────────────────────────────────────────────────┐   │
│  │                      n8n  (:5678)                             │   │
│  │         Workflow orchestrator — owns the pipeline             │   │
│  │   IMAP Poll → Parse → Classify → Route → Draft → Queue        │   │
│  └──────────┬────────────┬───────────────────┬────────────────── ┘   │
│             │            │                   │                       │
│  ┌──────────▼──┐  ┌──────▼──────┐  ┌─────────▼──────────────────┐   │
│  │  Ollama     │  │  Qdrant     │  │  Postgres                  │   │
│  │  (:11434)   │  │  (:6333)    │  │  (:5432)                   │   │
│  │             │  │             │  │                            │   │
│  │  Qwen3-4B   │  │  email      │  │  n8n workflow state        │   │
│  │  nomic-     │  │  vectors    │  │  approval queue            │   │
│  │  embed-text │  │  kb chunks  │  │  draft store               │   │
│  └─────────────┘  └─────────────┘  │  sent history              │   │
│                                    │  persona config             │   │
│                                    └────────────────────────────┘   │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │               Dashboard  (:3000)                               │  │
│  │        Node.js/React — reads Postgres + calls n8n API          │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
          │
          │  LAN (Wi-Fi / Ethernet)
          ▼
    Browser on phone / laptop
    http://device.local:3000
```

---

## Component Responsibilities

| Component | Responsibility | Communicates With |
|-----------|---------------|-------------------|
| **n8n** | Pipeline orchestrator. Owns all business logic: IMAP polling, email parsing, classification calls to Ollama, RAG retrieval from Qdrant, draft generation (local or cloud), approval queue writes, SMTP send. | Ollama (HTTP), Qdrant (HTTP), Postgres (TCP), Claude API (HTTPS outbound), IMAP/SMTP (TCP outbound) |
| **Ollama** | LLM inference server. Serves Qwen3-4B (classification + simple drafts) and nomic-embed-text (embeddings). Manages GPU layer allocation on Jetson unified memory. | n8n (inbound HTTP on :11434). No outbound. |
| **Qdrant** | Vector store. Holds two collections: `email_history` (past sent emails as RAG context) and `knowledge_base` (uploaded brand documents). Rust binary — low idle memory. | n8n (inbound HTTP on :6333). No outbound. |
| **Postgres** | Relational store. Holds n8n workflow execution state, approval queue rows, draft text, sent history log, persona config, system settings. The Dashboard reads this directly. | n8n (inbound TCP), Dashboard (inbound TCP). No outbound. |
| **Dashboard** | Web UI served on LAN. Approval queue (approve/edit/reject), sent history, classification log, knowledge base upload, persona settings, system status, onboarding wizard. | Postgres (TCP reads), n8n REST API (trigger sends, queue actions). No outbound. |

---

## Email Processing Pipeline (Data Flow)

```
[IMAP Server]
    │  (poll every 60s via n8n Email Trigger node)
    ▼
[n8n: Parse]
    │  extract: from, subject, body, thread_id, timestamp
    ▼
[n8n: Embed + Classify]
    │  1. POST /api/embeddings → Ollama (nomic-embed-text)
    │  2. vector search → Qdrant (email_history, top-3 context)
    │  3. POST /api/generate → Ollama (Qwen3-4B, classify prompt)
    │     → category: inquiry | reorder | scheduling | follow-up |
    │                  internal | spam | escalate | unknown
    ▼
[n8n: Route]
    │  if spam/marketing → discard (log only)
    │  if escalate       → queue with HIGH priority flag
    │  if confidence < threshold → queue as 'unknown'
    │  otherwise         → continue to draft
    ▼
[n8n: Draft]
    │  1. vector search → Qdrant (knowledge_base, top-5 chunks)
    │  2. if simple category (reorder, scheduling, follow-up):
    │       POST /api/generate → Ollama (Qwen3-4B, draft prompt)
    │     if complex category (inquiry, unknown):
    │       POST /messages → Claude Haiku API (HTTPS outbound)
    │     if cloud unreachable:
    │       queue with draft_status='pending_cloud', retry later
    ▼
[n8n: Queue Write]
    │  INSERT into Postgres: email_id, draft_text, category,
    │  confidence, source (local|cloud), priority, timestamp
    ▼
[Dashboard: Approval Queue]
    │  customer reviews on phone browser
    │  → approve    → n8n webhook → SMTP send → mark sent
    │  → edit+send  → n8n webhook → patch draft → SMTP send
    │  → reject     → mark rejected, log reason
    │  → escalate   → mark escalated (future: forward to human)
    ▼
[SMTP Server]
    email sent from customer's address
```

### Knowledge Base Ingestion Flow (separate pipeline)

```
[Dashboard: KB Upload]
    │  customer uploads PDF/DOCX/TXT
    ▼
[n8n: Document Ingest Workflow]
    │  1. chunk document (512-token chunks, 64-token overlap)
    │  2. POST /api/embeddings → Ollama (nomic-embed-text)
    │  3. upsert vectors → Qdrant (knowledge_base collection)
    │  4. record metadata → Postgres (kb_documents table)
```

### Sent History Ingestion Flow (first-boot wizard)

```
[IMAP: 6-month sent history]
    │
[n8n: History Ingest Workflow]
    │  1. parse each sent email
    │  2. embed → Ollama
    │  3. upsert → Qdrant (email_history collection)
    │  4. extract voice samples → Postgres (persona_examples table)
    │  triggered once on first boot, resumable if interrupted
```

---

## Memory Budget (8GB Unified, Jetson Orin Nano Super)

**Constraint:** Jetson unified memory means GPU and CPU share the same 8GB pool. Ollama subtracts ~500MB overhead before allocating GPU layers. If available GPU memory drops below model requirements, Ollama silently falls back to CPU-only inference (confirmed community reports). The OS + system services consume ~1.0–1.5GB headless (no desktop environment).

| Service | Idle RAM | Peak RAM | Notes |
|---------|----------|----------|-------|
| **OS + kernel + system** | 1.0 GB | 1.5 GB | Headless Ubuntu 22.04, no desktop. Must disable GUI on first boot. |
| **Ollama** (Qwen3-4B Q4_K_M loaded) | 3.0 GB | 3.5 GB | Model weights: 2.6GB. KV cache at 4K context: ~200MB. GPU overhead: ~500MB. Stays loaded permanently. nomic-embed-text (136M, F16) shares the process at ~0.5GB additional. |
| **Qdrant** | 150 MB | 400 MB | Rust binary. Memory-mapped storage. Email history at 50K vectors (768-dim) = ~220MB in-memory. Grows with KB size. |
| **Postgres** | 100 MB | 300 MB | shared_buffers=128MB (Docker default). alpine image. n8n state + approval queue + sent log. |
| **n8n** | 300 MB | 700 MB | Node.js process. Known memory growth under active workflows — set NODE_OPTIONS=--max-old-space-size=512. |
| **Dashboard** | 80 MB | 150 MB | Express/React SSR or static. Lightest service. |
| **Docker daemon + compose overhead** | 100 MB | 200 MB | Consistent on ARM64. |
| **TOTAL** | ~4.7 GB | ~6.7 GB | **1.3GB headroom at peak.** Tight but viable. |

**Memory constraints to enforce in docker-compose.yml:**

```
n8n:       mem_limit: 768m    (prevents runaway Node.js heap)
postgres:  mem_limit: 384m    (shm_size: 128mb required)
qdrant:    mem_limit: 512m    (mmap keeps active working set small)
dashboard: mem_limit: 256m
ollama:    NO mem_limit       (must see all free memory for GPU layer
                               allocation; a hard limit confuses VRAM
                               detection and forces CPU fallback)
```

**Critical:** Ollama reads /proc/meminfo to determine available VRAM on Tegra/Jetson (NVML is not available). Any `mem_limit` on the Ollama container will cause it to see reduced available memory and may trigger CPU-only mode for the 2.6GB model. Confirmed issue in NVIDIA developer forums.

---

## Recommended Project Directory Structure

```
mailbox/
├── docker-compose.yml          # service definitions, networks, volumes
├── docker-compose.override.yml # local dev overrides (bind mounts, debug ports)
├── .env                        # secrets (never committed)
├── .env.example                # template for .env
│
├── n8n/
│   ├── workflows/              # exported n8n workflow JSON files
│   │   ├── email-pipeline.json # main IMAP → classify → draft → queue
│   │   ├── kb-ingest.json      # document ingestion workflow
│   │   ├── history-ingest.json # first-boot sent history ingestion
│   │   └── notification.json   # daily digest + queue alert emails
│   └── credentials/            # exported credential stubs (no secrets)
│
├── dashboard/
│   ├── Dockerfile
│   ├── package.json
│   ├── src/
│   │   ├── app/                # Next.js app router or Express routes
│   │   ├── components/         # React components
│   │   └── lib/                # Postgres client, n8n API client
│   └── public/
│
├── postgres/
│   └── init/
│       └── 01-schema.sql       # table definitions run on first start
│
├── qdrant/
│   └── config/
│       └── config.yaml         # storage path, collection defaults
│
├── ollama/
│   └── modelfile/              # optional Modelfile for persona system prompt
│
└── scripts/
    ├── first-boot.sh           # pull models, run history ingest, create admin
    ├── health-check.sh         # verify all services healthy post-start
    └── ota-update.sh           # pull new images from GHCR, rolling restart
```

---

## Architectural Patterns

### Pattern 1: n8n as Pipeline Orchestrator (not custom Python)

**What:** All email processing logic lives in n8n workflow JSON, not application code. n8n calls Ollama, Qdrant, and Postgres via built-in nodes. No Python microservice between n8n and the models.

**When to use:** Always for this project. n8n has native IMAP trigger, HTTP request nodes, Postgres nodes, vector store nodes for Qdrant, and LangChain-style AI agent nodes. Building the same in Python adds a 6th container, another failure mode, and more memory pressure.

**Trade-offs:** Workflows are harder to unit-test than Python code. Version control of workflow JSON is less ergonomic than code. Mitigation: export workflows to `n8n/workflows/` on every change and commit them.

### Pattern 2: Postgres as Approval Queue (not Redis, not n8n internal state)

**What:** The approval queue, draft store, and sent history all live in Postgres tables. n8n writes rows; the Dashboard reads them. The Dashboard calls n8n webhooks to trigger the send action.

**When to use:** Always. A separate Redis queue adds memory overhead. n8n's internal execution database doesn't expose the data cleanly to the Dashboard. Postgres is already required for n8n — no new container needed.

**Trade-offs:** Polling from Dashboard to Postgres requires a refresh mechanism (SSE or 5-second poll). Acceptable for a single-user approval UI on LAN.

### Pattern 3: Single Docker Bridge Network + No Host Port Exposure for Internal Services

**What:** Ollama, Qdrant, and Postgres are reachable only on the internal `mailbox-net` bridge. Only n8n (:5678) and Dashboard (:3000) bind to host ports. No service binds to 0.0.0.0 except those two.

**When to use:** Always. Follows the n8n self-hosted AI starter kit security model. Prevents LAN devices from directly querying the LLM or vector DB endpoints.

**Trade-offs:** Debugging Qdrant or Ollama from host requires `docker exec` or temporary port-forward. Add a `docker-compose.debug.yml` override for development.

### Pattern 4: Model-Stays-Loaded Strategy

**What:** Ollama keeps Qwen3-4B resident in GPU memory between inferences rather than unloading after each request. Set `OLLAMA_KEEP_ALIVE=-1` to prevent eviction.

**When to use:** Always. With 8GB unified memory and no competing GPU workloads, model loading latency (~3-5s for a 2.6GB model) would blow the 30s pipeline budget if triggered per email. The model must stay loaded.

**Trade-offs:** 3GB of the 8GB pool is permanently allocated to the model. This is the correct trade-off for an appliance with a single purpose.

---

## Build Order (Service Dependencies)

```
1. Postgres
   (health check: pg_isready -U mailbox)
        ↓
2. Qdrant
   (health check: GET :6333/readyz)
   [parallel with Postgres — no dependency]
        ↓
3. Ollama
   (health check: GET :11434/api/version)
   [parallel with Postgres and Qdrant — no dependency]
        ↓
4. n8n
   (depends_on: postgres[healthy], qdrant[healthy], ollama[healthy])
   Runs first-boot import of workflows and credentials on startup.
        ↓
5. Dashboard
   (depends_on: postgres[healthy], n8n[healthy])
```

**First-boot sequence (after all containers healthy):**

```
first-boot.sh:
  1. ollama pull qwen3:4b-q4_K_M      (2.6GB download on first run only)
  2. ollama pull nomic-embed-text      (0.5GB)
  3. trigger n8n history-ingest workflow
  4. Dashboard wizard: create admin → connect email → confirm ingest
```

**Restart behavior:** `restart: unless-stopped` on all services. On power loss, Docker auto-restarts services in dependency order. Cold boot to fully operational: ~90s (Ubuntu boot ~30s + Docker pull-from-cache ~10s + service start ~20s + model load into GPU ~30s).

---

## Anti-Patterns

### Anti-Pattern 1: Applying `mem_limit` to Ollama

**What people do:** Set `mem_limit: 4g` on the Ollama container to "protect" other services.

**Why it's wrong:** On Jetson, Ollama reads `/proc/meminfo` instead of NVML to detect available GPU memory (NVML returns error on Tegra). A container memory limit makes `/proc/meminfo` report the cgroup-scoped value (4GB), not the system total. Ollama then determines it cannot fit the 2.6GB model plus KV cache plus overhead into "GPU memory" and falls back to CPU-only inference — degrading classification from ~15 tok/s to ~2 tok/s, blowing the 30s pipeline SLA.

**Do this instead:** Leave Ollama unconstrained. Protect other services with their own `mem_limit` values. The Ollama process is stable; it won't grow unboundedly like a Node.js server.

### Anti-Pattern 2: Two Models Loaded Simultaneously

**What people do:** Keep both Qwen3-4B (2.6GB) and nomic-embed-text (0.5GB) loaded with `OLLAMA_KEEP_ALIVE=-1`, then trigger both simultaneously.

**Why it's wrong:** On the 8GB system, both models loading simultaneously with context overhead may push total GPU allocation to ~4GB+, leaving only ~4GB for OS + other services, which is under the ~4.7GB idle floor. Observed behavior: Ollama begins offloading layers to CPU mid-inference, causing variable latency.

**Do this instead:** nomic-embed-text is tiny (136M params, 0.5GB) and loads in <1s. Set `OLLAMA_KEEP_ALIVE=5m` for nomic-embed-text (short-lived, loads on demand) and `OLLAMA_KEEP_ALIVE=-1` for Qwen3-4B only. The embedding step runs before classification in the pipeline, so the embed model loads, runs, unloads within 5 seconds, then Qwen3-4B handles classification without contention.

### Anti-Pattern 3: n8n Polling Inside a Workflow Loop

**What people do:** Create an n8n workflow that polls IMAP using a manual trigger + Wait node in a loop to simulate continuous polling.

**Why it's wrong:** n8n accumulates execution history in Postgres. Long-running workflows with Wait nodes create bloated execution records. Memory usage grows steadily.

**Do this instead:** Use n8n's native **Email Trigger (IMAP)** node as the workflow start. This uses n8n's internal IMAP listener, which polls at the configured interval without creating a persistent workflow execution per cycle. Set `executions.pruneData=true` and `executions.pruneDataMaxAge=72` (hours) to prevent execution history from filling Postgres.

### Anti-Pattern 4: Dashboard Calling Ollama Directly

**What people do:** Allow the Dashboard to POST directly to `http://ollama:11434` to generate previews or explanations in the UI.

**Why it's wrong:** Dashboard is a web service potentially accessible to any LAN device (the requirement is mobile-responsive, implying phone on Wi-Fi). Direct LLM access from the frontend bypasses n8n's workflow logic, creates a second inference client competing for GPU memory, and makes it easy to trigger model swaps or prompt injection.

**Do this instead:** All LLM calls route through n8n workflows invoked via authenticated n8n webhooks. The Dashboard is read/write to Postgres and calls n8n REST API only. Ollama stays internal to `mailbox-net` with no host port binding.

---

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| Gmail / Outlook (IMAP) | n8n Email Trigger (IMAP) node, OAuth2 or app password credentials | OAuth2 token refresh handled by n8n credentials store. Store credentials in n8n, not in .env — n8n encrypts them in Postgres. |
| Gmail / Outlook (SMTP) | n8n Send Email node | Same credential object as IMAP. |
| Anthropic Claude API | n8n HTTP Request node, HTTPS outbound only | API key in n8n credentials. Send only current email + retrieved context chunks — no bulk corpus. Graceful fallback: if HTTP 5xx or timeout >10s, write draft_status='pending_cloud' to Postgres and retry on next poll cycle. |

### Internal Service Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| n8n → Ollama | HTTP REST (POST /api/generate, POST /api/embeddings) on mailbox-net | Ollama has no auth by default. Internal network only. |
| n8n → Qdrant | HTTP REST (upsert, search) on mailbox-net | Qdrant has optional API key — enable it via QDRANT_API_KEY env var even on internal network. |
| n8n → Postgres | TCP (pg protocol) on mailbox-net | n8n uses Postgres as its own database; add a second connection for custom tables (approval queue, persona config) in the `mailbox` schema, separate from `public` (n8n's schema). |
| Dashboard → Postgres | TCP read-mostly on mailbox-net | Dashboard should use a read-only Postgres user for SELECT queries. Use a privileged user only for approval queue writes (approve/reject status updates). |
| Dashboard → n8n | n8n REST API (:5678) for webhook triggers (send, cancel) | Use n8n API key auth. Dashboard never writes to n8n's internal tables directly. |

---

## Scaling Considerations

This is a single-tenant appliance. "Scaling" here means headroom for email volume growth, not horizontal scale.

| Email Volume | Architecture Adjustments |
|--------------|--------------------------|
| 20-50 emails/day (target baseline) | Default config as described. 60s poll interval. Sequential pipeline per email. |
| 50-200 emails/day | Reduce poll interval to 30s. Enable n8n workflow concurrency (2 parallel executions). Monitor Postgres execution history growth — prune aggressively. |
| 200+ emails/day | Consider poll interval 15s. Qwen3-4B at ~15 tok/s can classify in ~2s — bottleneck shifts to SMTP rate limits and Claude API rate limits, not local inference. Add classification confidence caching for exact-duplicate subject lines. |

**First bottleneck at scale:** n8n execution history in Postgres. At 100 emails/day with 72-hour retention, Postgres will hold ~7,200 execution records. Enable pruning from day one: `EXECUTIONS_DATA_PRUNE=true`, `EXECUTIONS_DATA_MAX_AGE=72`.

**Second bottleneck at scale:** GPU memory contention if model swap occurs mid-pipeline. Prevention: `OLLAMA_KEEP_ALIVE=-1` on Qwen3-4B ensures model stays resident.

---

## Sources

- [Docker Setup on JetPack 6 — JetsonHacks](https://jetsonhacks.com/2025/02/24/docker-setup-on-jetpack-6-jetson-orin/)
- [Free up more RAM for Ollama (Jetson Orin Nano Super) — NVIDIA Developer Forums](https://forums.developer.nvidia.com/t/free-up-more-ram-for-ollama-jetson-orin-nano-super/331663)
- [Jetson Orin Nano 8GB Docker issue — Ollama falls back to CPU — NVIDIA Developer Forums](https://forums.developer.nvidia.com/t/jetson-orin-nano-8gb-docker-issue-ollama-falls-back-to-cpu-when-stable-diffusion-is-running/356279)
- [n8n self-hosted AI starter kit — GitHub](https://github.com/n8n-io/self-hosted-ai-starter-kit)
- [Local AI with Docker, n8n, Qdrant, and Ollama — DataCamp](https://www.datacamp.com/tutorial/local-ai)
- [Qdrant memory consumption guide](https://qdrant.tech/articles/memory-consumption/)
- [Ollama Memory Management and GPU Allocation — DeepWiki](https://deepwiki.com/ollama/ollama/5.4-memory-management-and-gpu-allocation)
- [n8n Email Trigger (IMAP) node documentation](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.emailimap/)
- [Docker Compose health checks and startup order](https://docs.docker.com/compose/how-tos/startup-order/)
- [qwen3:4b-q4_K_M on Ollama library](https://ollama.com/library/qwen3:4b-q4_K_M)
- [nomic-embed-text on Ollama library](https://ollama.com/library/nomic-embed-text)
- [AI Models that run on Jetson Orin Nano Super 8GB — NVIDIA Forums](https://forums.developer.nvidia.com/t/ai-models-that-run-on-jetson-orin-nano-super-8gb-a-practical-guide/365412)
- [n8n memory-related errors documentation](https://docs.n8n.io/hosting/scaling/memory-errors/)

---

*Architecture research for: MailBox One — Edge AI Email Agent Appliance*
*Researched: 2026-04-02*
