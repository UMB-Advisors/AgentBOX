# Stack Research

**Domain:** AI email agent appliance (ARM64 edge hardware)
**Researched:** 2026-04-02
**Confidence:** MEDIUM-HIGH (all core choices verified against official docs and current sources; some ARM64-specific gotchas confirmed via GitHub issues)

---

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Ollama | 0.18.4 (latest stable as of 2026-04-02; 0.19.0 preview available) | Local LLM inference server | Native JetPack 6 support; official ARM64 CUDA image via `jetson-containers`; single-command model management; built-in GPU passthrough in Docker Compose via NVIDIA runtime; n8n has a first-class Ollama Model node |
| Qdrant | 1.17.1 | Vector database for RAG | Rust-native binary = low idle memory; official multi-arch Docker image (linux/arm64); payload filtering eliminates extra DB round-trips; active development with weekly releases; outperforms pgvector for pure vector workloads |
| n8n | 2.14.2 (2.x stable) | Workflow orchestrator | Native IMAP trigger + Gmail trigger nodes; built-in Ollama Model node; built-in Anthropic Chat Model node; ARM64 Docker image officially supported (`n8nio/n8n:latest-arm64`); visual debugging speeds iteration; fair-code license allows self-hosting |
| Postgres | 17-alpine | Operational datastore | Multi-arch Docker official image with zero configuration; `postgres:17-alpine` is smallest footprint (~80MB) vs standard (~350MB); stores n8n workflow state, approval queue records, sent history, persona config |
| Node.js + Express | 22 LTS (Node.js); 4.x (Express) | Dashboard API backend | Official `node:22-alpine` is multi-arch; Express is the minimal-overhead choice for a small appliance REST/WebSocket API; avoids heavyweight frameworks on 8GB unified memory |
| React + Vite | React 18.x; Vite 6.x | Dashboard UI | Vite 6 produces smallest production bundles; multi-stage Docker build → nginx:alpine serves static files, eliminating Node.js process at runtime; React 18 concurrent mode reduces perceived latency on slow LAN |

### Models

| Model | Pull Tag | Size (VRAM) | Purpose | Why Recommended |
|-------|----------|------------|---------|-----------------|
| Qwen3-4B | `qwen3:4b` (Q4_K_M default) | ~2.7 GB | Email classification + simple draft generation | Q4_K_M quantization confirmed available on Ollama library; 32K context window natively; thinking/non-thinking mode toggle; outperforms Llama-3.2-3B on classification tasks at same size; validated on Jetson-class hardware |
| nomic-embed-text | `nomic-embed-text:v1.5` | 274 MB | RAG embeddings | 274MB — leaves substantial headroom alongside Qwen3-4B; 45M+ downloads (most-used embedding model on Ollama); 2K context window appropriate for email chunks; v1.5 is current stable (v2-moe exists but 475M params adds pressure on 8GB budget) |
| claude-haiku-4-5-20251001 | API only | — (cloud) | Complex draft generation, escalation handling | Released Oct 2025; $1/1M input tokens; 200K context; matches Sonnet 4 on coding benchmarks; n8n Anthropic Chat Model node supports model ID string override |

### Supporting Libraries (Dashboard Service)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@anthropic-ai/sdk` | latest (npm) | Anthropic API calls from Node.js | Used when making direct API calls outside n8n (e.g., from dashboard backend for persona extraction during onboarding) |
| `drizzle-orm` | ^0.31 | Type-safe Postgres ORM | Dashboard backend: approval queue, sent history, config tables. Lightweight, no codegen step, works with `postgres:17` |
| `drizzle-kit` | ^0.22 | Migration management | Paired with drizzle-orm; generates SQL migrations from schema changes |
| `ws` | ^8 | WebSocket server | Dashboard backend: real-time approval queue push to browser |
| `@qdrant/js-client-rest` | ^1.11 | Qdrant REST client | Dashboard backend: knowledge base management UI queries |
| `imapflow` | ^1.0 | IMAP client | Used only if n8n IMAP polling proves insufficient (rate limits, OAuth2 edge cases) — keep as fallback |
| `nodemailer` | ^6 | SMTP sending | Same fallback role as imapflow — n8n Send Email node covers the primary path |
| `zod` | ^3 | Runtime validation | API request/response validation in Express routes |
| `react-query` | ^5 (TanStack Query) | Server state management | Dashboard: approval queue polling, optimistic updates on approve/reject actions |
| `tailwindcss` | ^4 | Utility CSS | Mobile-responsive dashboard; zero runtime overhead; v4 removes config file requirement |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| Docker 28.0.1+ | Container runtime | Pin to >=28.0.1 — Docker 28.0.0 broke GPU passthrough on Jetson (kernel module dependency). Use `docker.io` from Ubuntu repos, NOT `docker-ce` from Docker Inc. — the latter breaks NVIDIA runtime configuration paths on JetPack |
| `nvidia-container-toolkit` | GPU passthrough to containers | Install via `apt-get install -y nvidia-container-toolkit` then `nvidia-ctk runtime configure --runtime=docker`. Required for Ollama GPU access |
| `jetson-containers` (dusty-nv) | Validated container images | Use `autotag ollama` to get the correct JetPack-matched Ollama image. Eliminates CUDA/cuDNN version mismatch guesswork |
| `docker-compose` plugin | Orchestration | Use the Docker Compose v2 plugin (`docker compose`) not standalone `docker-compose` v1 (deprecated) |
| GHCR | OTA update registry | `ghcr.io` free for public images; multi-arch manifest push via `docker buildx` with `--platform linux/arm64` |
| `mkcert` | Local HTTPS | Optional: LAN HTTPS for dashboard if browser camera/mic permissions needed (not required for v1) |

---

## Installation

```bash
# --- Jetson host setup (run once after flash) ---
# Install Docker using JetsonHacks scripts (avoids broken docker-ce)
git clone https://github.com/jetsonhacks/install-docker.git
cd install-docker
bash ./install_nvidia_docker.sh
bash ./configure_nvidia_docker.sh

# Verify GPU passthrough
docker run --rm --runtime nvidia --gpus all ubuntu nvidia-smi

# --- Pull models via Ollama (after Docker Compose up) ---
docker compose exec ollama ollama pull qwen3:4b
docker compose exec ollama ollama pull nomic-embed-text:v1.5

# --- Dashboard dependencies ---
npm install express drizzle-orm @qdrant/js-client-rest ws zod nodemailer imapflow @anthropic-ai/sdk
npm install -D drizzle-kit typescript vite @vitejs/plugin-react tailwindcss

# --- React dashboard ---
npm install react react-dom @tanstack/react-query
npm install -D @types/react @types/react-dom
```

---

## Docker Compose Service Config (critical settings)

```yaml
services:
  ollama:
    image: ollama/ollama:latest         # or use: jetson-containers autotag output
    runtime: nvidia                      # REQUIRED — do not use deploy.resources on JetPack
    environment:
      - NVIDIA_VISIBLE_DEVICES=all
      - NVIDIA_DRIVER_CAPABILITIES=compute,utility
    volumes:
      - ollama_models:/root/.ollama
    restart: unless-stopped

  qdrant:
    image: qdrant/qdrant:v1.17.1        # pin version; see ARM64 note below
    environment:
      - QDRANT__SERVICE__HTTP_PORT=6333
    volumes:
      - qdrant_data:/qdrant/storage
    restart: unless-stopped

  n8n:
    image: n8nio/n8n:2.14.2
    environment:
      - N8N_BASIC_AUTH_ACTIVE=true
      - DB_TYPE=postgresdb
      - DB_POSTGRESDB_HOST=postgres
      - N8N_RUNNERS_ENABLED=true         # required in n8n 2.x
    volumes:
      - n8n_data:/home/node/.n8n
    restart: unless-stopped

  postgres:
    image: postgres:17-alpine
    environment:
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
    volumes:
      - pg_data:/var/lib/postgresql/data
    restart: unless-stopped

  dashboard:
    build: ./dashboard
    ports:
      - "3000:3000"
    environment:
      - DATABASE_URL=postgresql://postgres:${POSTGRES_PASSWORD}@postgres:5432/mailbox
      - QDRANT_URL=http://qdrant:6333
      - OLLAMA_URL=http://ollama:11434
    restart: unless-stopped
```

---

## Alternatives Considered

| Recommended | Alternative | When Alternative Makes Sense |
|-------------|-------------|------------------------------|
| Ollama 0.18.x | llama.cpp direct | Only if needing GGUF features not yet in Ollama (e.g., custom sampling); Ollama adds ~50ms overhead but saves massive integration work |
| Qdrant | pgvector (Postgres extension) | If you want single-DB simplicity and vector scale is < 100K vectors; pgvector has ARM64 Docker support but is 3-4x slower on ANN search |
| Qdrant | ChromaDB | ChromaDB is Python-only, requires separate Python runtime, higher memory overhead; Qdrant Rust binary is better for resource-constrained hardware |
| n8n 2.x | Custom Python orchestrator (FastAPI + Celery) | Only if workflow logic becomes too complex for visual editing or if n8n licensing becomes an issue; doubles development time for v1 |
| Qwen3-4B | Llama-3.2-3B | Llama-3.2-3B is better for fine-tuning (biggest improvement from fine-tuning per distil labs benchmark); Qwen3-4B wins on out-of-the-box classification quality |
| Qwen3-4B | Mistral-7B | 7B exceeds safe VRAM budget when running alongside nomic-embed-text; leaves < 1GB for Qdrant and system — do not use |
| nomic-embed-text:v1.5 | nomic-embed-text-v2-moe | v2-moe is 475M params (vs 137M for v1.5) — better accuracy but 3.5x larger; on 8GB unified RAM with Qwen3-4B loaded, v2-moe creates memory pressure; defer until v2 hardware |
| nomic-embed-text:v1.5 | mxbai-embed-large | Similar accuracy; 335MB vs 274MB; no meaningful advantage for English-only CPG email corpus |
| claude-haiku-4-5 | claude-sonnet-4-5 | Sonnet is the right escalation model when quality matters more than cost; PRD already includes it as explicit fallback — wire as second Anthropic node in complex draft path |
| Postgres 17-alpine | SQLite | SQLite is fine for config/persona; Postgres is required because n8n 2.x recommends Postgres for production (avoids SQLite concurrency issues under workflow parallelism) |
| React + Vite | Next.js | Next.js SSR is unnecessary overhead for a LAN-only dashboard; Vite SPA + Express API is simpler to containerize and debug on edge hardware |
| nginx:alpine (serve static) | Node.js `serve` package | `serve` keeps a Node.js process running at idle; nginx:alpine is < 10MB and zero CPU at idle — important for power budget |
| drizzle-orm | Prisma | Prisma has a 35-60MB native binary and background query engine process; drizzle-orm is < 1MB with no background process |

---

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `docker-ce` (Docker Inc. repo) | Breaks NVIDIA runtime configuration paths on JetPack — GPU passthrough stops working | `docker.io` from Ubuntu 22.04 repos via JetsonHacks script |
| Docker 28.0.0 (exactly) | This specific release broke Docker on Jetson due to missing kernel module dependency | Pin to 28.0.1 or install via JetsonHacks which handles version management |
| Mistral-7B or any 7B+ model locally | 7B Q4_K_M requires ~4.5GB VRAM; leaves < 3.5GB for embeddings, Qdrant, and OS — system becomes unstable under load | Qwen3-4B (Q4_K_M, ~2.7GB) |
| nomic-embed-text-v2-moe | 475M active params doubles the embedding memory footprint; on 8GB unified RAM this competes directly with Qwen3-4B | nomic-embed-text:v1.5 (137M params, 274MB) |
| n8n 1.x | EOL 3 months post 2.0.0 (Dec 2025); security/bug fixes only; 2.x is the actively developed branch | n8n 2.x (current: 2.14.2) |
| `docker-compose` v1 (standalone binary) | Deprecated upstream; not included in Docker 28.x; `docker compose` (plugin) is the current standard | Docker Compose v2 plugin (`docker compose`) |
| Auto-updating containers (`:latest` tags in production) | Silent breakage risk on OTA updates; a broken Qdrant or n8n update at a customer site is a support incident | Pin all service images to specific versions; use GHCR for controlled OTA delivery |
| ChromaDB | Python-only runtime adds 200-400MB overhead; inferior performance vs Qdrant on Rust hardware | Qdrant |
| Langchain/LlamaIndex in n8n | These Python orchestrators duplicate what n8n already does natively; adds Python runtime dependency | n8n built-in AI Agent + Ollama Model nodes |

---

## Stack Patterns by Variant

**If Ollama fails to detect GPU (common gotcha):**
- Use `jetson-containers run $(autotag ollama)` instead of `docker run ollama/ollama`
- The `autotag` command resolves the JetPack-matched image (e.g., `r36.4.0` for JetPack 6.2)
- Check logs for `Nvidia GPU detected via cudart` — absence means toolkit is misconfigured

**If Qdrant ARM64 jemalloc error occurs (`<jemalloc>: Unsupported system page size`):**
- This is a known open issue (GitHub #4298, open as of Nov 2025)
- Workaround: set `environment: - MALLOC_CONF=narenas:1` in docker-compose
- If that fails, build from source on-device: `cargo build --release` with `JEMALLOC_SYS_WITH_LG_PAGE=16`
- The official multi-arch image (`qdrant/qdrant:v1.17.1`) includes the `-arm64` tag variant; pull explicitly with `docker pull qdrant/qdrant:v1.17.1-arm64` if the manifest auto-select fails
- MEDIUM confidence on workaround reliability — test in Phase 1 sprint 1

**If n8n Anthropic node doesn't list claude-haiku-4-5 in dropdown:**
- The n8n Anthropic Chat Model node accepts any model ID string as a custom value
- Set model to `claude-haiku-4-5-20251001` manually — n8n passes it directly to the API

**If Qwen3 thinking mode causes latency spikes:**
- Qwen3 can toggle between thinking (chain-of-thought) and non-thinking mode
- For classification tasks (latency-sensitive), add `/no_think` system prompt directive
- For draft generation, thinking mode is acceptable (< 60s cloud SLA has headroom)

**If OTA update breaks a service:**
- Rollback procedure: `docker compose pull [service]@[previous-digest]`
- Pin digests not just versions: `qdrant/qdrant@sha256:...` in production compose file
- Pre-pull new image before stopping old container to minimize downtime

---

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| JetPack 6.2 (L4T r36.4) | Ollama 0.18.x+, CUDA 12.x | JetPack 6.2 introduced "Super Mode" which unlocks full 40 TOPS on Orin Nano Super — requires JetPack 6.2 specifically, not 6.0/6.1 |
| Docker 28.0.1 | nvidia-container-toolkit 1.17.x | Docker 28.0.0 was broken on Jetson; 28.0.1 fixed it. Always verify with `docker run --rm --runtime nvidia nvidia/cuda:12.3.0-base-ubuntu22.04 nvidia-smi` |
| n8n 2.x | Postgres 13+ | n8n 2.0 dropped support for SQLite in multi-user mode; use Postgres 17 |
| n8n 2.x | Node.js 20+ (inside container) | n8n's Docker image ships its own Node.js; no host Node.js needed |
| Qdrant 1.17.x | `@qdrant/js-client-rest` ^1.11 | The JS client REST version should match the server major version; 1.17 server is API-compatible with 1.11 client |
| Qwen3-4B (Q4_K_M) | Ollama 0.6.0+ | Qwen3 family requires Ollama 0.6.0+ for proper tokenizer support; 0.18.x is well above this floor |
| nomic-embed-text:v1.5 | Ollama 0.1.26+ | Requires Ollama 0.1.26 per official library page |
| React 18 | Node.js 18+ (build time) | React 18 concurrent features require Node.js 18+; build happens on dev machine or CI, not on Jetson |
| Tailwind CSS v4 | Vite 6.x | Tailwind v4 requires Vite 6+ via the `@tailwindcss/vite` plugin (replaces PostCSS config) |

---

## Memory Budget (8GB Unified VRAM)

| Component | Typical Footprint | Notes |
|-----------|------------------|-------|
| Ubuntu 22.04 + JetPack 6.2 OS | ~1.5 GB | Baseline with Docker daemon running |
| Ollama daemon (no model loaded) | ~150 MB | |
| Qwen3-4B Q4_K_M (loaded) | ~2.7 GB | Stays loaded while processing emails |
| nomic-embed-text:v1.5 (loaded) | ~350 MB | May unload between RAG operations; Ollama LRU cache |
| Qdrant | ~200-400 MB | Depends on vector count; 10K emails ≈ 100MB index |
| n8n | ~300 MB | Node.js process; 2.x is more memory efficient than 1.x |
| Postgres | ~100 MB | Small operational DB; not analytics |
| Dashboard (nginx + Express) | ~100 MB | Static files via nginx + Express API |
| **Total estimate** | **~5.7 GB** | **~2.3 GB headroom for bursts and OS cache** |

This budget is comfortable. Both models can remain loaded simultaneously. Do not attempt to run 7B+ models in v1 — headroom collapses.

---

## Sources

- [Jetson AI Lab — Ollama Tutorial](https://www.jetson-ai-lab.com/tutorials/ollama/) — GPU Docker setup for JetPack
- [JetsonHacks — Docker Setup on JetPack 6](https://jetsonhacks.com/2025/02/24/docker-setup-on-jetpack-6-jetson-orin/) — Docker 28.0.1 Jetson gotcha
- [Cytron — Docker Setup for Jetson Orin Nano Super JP6.2](https://www.cytron.io/tutorial/docker-setup-for-jetson-orin-nano-super-jp6.2) — install_nvidia_docker.sh walkthrough
- [Ollama GitHub Releases](https://github.com/ollama/ollama/releases) — v0.18.4 latest stable confirmed 2026-03-26
- [Qdrant GitHub Releases](https://github.com/qdrant/qdrant/releases) — v1.17.1 latest stable confirmed 2026-03-27
- [Qdrant ARM64 jemalloc issue #4298](https://github.com/qdrant/qdrant/issues/4298) — open as of Nov 2025; workarounds documented
- [n8n Release Notes](https://docs.n8n.io/release-notes/) — 2.14.2 current stable (March 2026)
- [n8n Docker Hub](https://hub.docker.com/r/n8nio/n8n) — `latest-arm64` tag confirmed
- [n8n Ollama Integration](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmollama/) — built-in Ollama Model node
- [n8n Anthropic Chat Model node](https://n8n.io/integrations/anthropic/) — Claude integration confirmed
- [Ollama — nomic-embed-text](https://ollama.com/library/nomic-embed-text:v1.5) — 274MB, requires Ollama 0.1.26+
- [Qwen3-4B GGUF on Hugging Face](https://huggingface.co/Qwen/Qwen3-4B-GGUF) — Q4_K_M quantization variants confirmed
- [Distil Labs — Best Base Model for Fine-Tuning Benchmark](https://www.distillabs.ai/blog/we-benchmarked-12-small-language-models-across-8-tasks-to-find-the-best-base-model-for-fine-tuning/) — Qwen3-4B classification superiority
- [Anthropic Models Overview](https://platform.claude.com/docs/en/about-claude/models/overview) — claude-haiku-4-5-20251001 model ID
- [Jeremy Morgan — Jetson Orin Nano Speed Test](https://www.jeremymorgan.com/blog/tech/nvidia-jetson-orin-nano-speed-test/) — ~20 tok/s for 3.5B models
- [NVIDIA JetPack 6.2 Super Mode Blog](https://developer.nvidia.com/blog/nvidia-jetpack-6-2-brings-super-mode-to-nvidia-jetson-orin-nano-and-jetson-orin-nx-modules/) — 2x inference boost confirmed for JetPack 6.2 vs 6.1
- [nomic-embed-text-v2-moe release](https://simonwillison.net/2025/Feb/12/nomic-embed-text-v2/) — 475M params MoE analysis
- postgres:17-alpine — [Docker Hub official image](https://hub.docker.com/_/postgres) — multi-arch ARM64 confirmed

---
*Stack research for: MailBox One — AI email agent appliance on Jetson Orin Nano Super*
*Researched: 2026-04-02*
