<!-- To use your own logo: replace the SVG files in assets/ or add a logo image to the <picture> sources -->
<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/banner-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="./assets/banner-light.svg">
    <img alt="MailBOX Zero" src="./assets/banner-light.svg" width="800">
  </picture>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/platform-Jetson_Orin_Nano-76B900?style=flat-square&logo=nvidia&logoColor=white" alt="Platform">
  <img src="https://img.shields.io/badge/AI-Claude_+_Qwen3-7C3AED?style=flat-square&logo=anthropic&logoColor=white" alt="AI">
</p>

<p align="center"><strong>A plug-and-play hardware appliance that triages, drafts, and sends email responses &mdash; so entrepreneurs running heavy inboxes stop spending hours a day on email ops.</strong></p>

---

<details>
<summary>Table of Contents</summary>

- [About](#about)
- [Who It's For](#who-its-for)
- [Features](#features)
- [Architecture](#architecture)
- [Hardware Requirements](#hardware-requirements)
- [Provisioning](#provisioning)
- [Configuration](#configuration)
- [How It Works](#how-it-works)
- [Tech Stack](#tech-stack)
- [Memory Budget](#memory-budget)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

</details>

## About

MailBOX Zero is a dedicated AI email agent that runs on an NVIDIA Jetson Orin Nano Super. The customer plugs in the appliance, connects their email account, completes guided onboarding, and gets an always-on assistant that handles inbound operational email — triage, drafting, and (with human approval) sending — entirely on-device.

All email content stays on the local appliance. Cloud API calls (Ollama Cloud `gpt-oss:120b` by default; Anthropic Haiku 4.5 wired as a config-ready alternative) are made only for cloud-routed drafts — typically `escalate` / `unknown` categories or any classification with `confidence < 0.75`. No bulk corpus ever leaves the device.

Sold as a managed product with white-glove onboarding and an optional support subscription.

## Who It's For

MailBOX Zero is built for entrepreneurs whose inbox has become the bottleneck:

- **Founders** running early-stage companies where every reply still routes through them
- **Solo operators** managing multiple businesses or product lines from a single inbox
- **Agency owners and consultants** juggling client threads, proposals, and follow-ups
- **Investors and dealmakers** drowning in pitch decks, intros, and follow-up loops
- **Anyone** who has resigned themselves to "email bankruptcy" once a quarter

If you spend two or more hours a day in your inbox and the volume keeps growing, MailBOX Zero is meant for you.

## Features

- **On-device AI triage** — Qwen3-4B (4096 ctx) classifies and prioritizes inbound email in under 30 seconds
- **Two-path draft generation** — local Qwen3-4B for routine replies (`reorder`, `scheduling`, `follow_up`, `internal`, `inquiry`); Ollama Cloud `gpt-oss:120b` for `escalate` / `unknown` / low-confidence cases (Haiku 4.5 is wired as alt-cloud, swap in `.env`)
- **Human-in-the-loop** — every outbound email requires explicit approval via the dashboard before sending
- **Privacy-first** — all email content stored exclusively on-device; only cloud-routed messages briefly leave the appliance
- **Public HTTPS + auth gate** — Caddy + Cloudflare DNS-01 cert; basic_auth on `/dashboard/*` and the n8n editor
- **On-device RAG** — Qdrant vector search over past emails for counterparty-scoped recall; snippets augment local drafts (cloud-route retrieval is privacy-gated off by default)
- **Visual workflow editor** — n8n orchestrates the full pipeline; sub-workflows for classify / draft / send
- **Mobile-ready dashboard** — Next.js 14 approval queue accessible from any device, gated behind basic_auth

## Architecture

```mermaid
---
title: MailBOX Zero System Architecture
---
flowchart TB
    A[Inbound Email<br>Gmail Get + Schedule 5 min] --> B[n8n Orchestrator]
    B --> C{Classification<br>Qwen3-4B}
    C -->|Local categories<br>reorder, scheduling, follow_up, internal, inquiry| D[Qwen3-4B<br>Local Draft]
    C -->|Cloud categories<br>escalate, unknown, low confidence| E[Ollama Cloud<br>gpt-oss:120b]
    D --> F[Approval Queue]
    E --> F
    F --> G[Dashboard UI<br>Next.js 14]
    G -->|Approved| H[Gmail Reply<br>via n8n]
    G -->|Rejected| I[Archive]
    J[Knowledge Base<br>RAG] -.-> D
    J -.-> E
    K[nomic-embed-text] -.-> J
    L[(Qdrant)] -.-> J
    M[(Postgres)] --> B
    M --> F
```

## Hardware Requirements

| Component | Specification |
|-----------|--------------|
| Board | NVIDIA Jetson Orin Nano Super (8GB unified VRAM) |
| Storage | 500GB NVMe SSD |
| Power | < 25W sustained under normal operation |
| Firmware | JetPack 6.2.2 (L4T r36.4) with Super Mode enabled |
| Network | Ethernet or Wi-Fi for email access and LAN dashboard |

## Provisioning

There are two supported ways to bring up a new appliance. **Both** assume the Jetson is already flashed with **JetPack 6.2.2** (L4T r36.4) via [NVIDIA SDK Manager](https://developer.nvidia.com/sdk-manager) — see [`docs/runbook/factory-flash.v0.1.0.md`](docs/runbook/factory-flash.v0.1.0.md).

> [!NOTE]
> **Which path?**
> - Provisioning **one** box, or iterating on the stack → **Path B (from the repo)**.
> - Building **several** boxes → bring up one seed with Path B, capture it once, then stamp blanks with **Path A (golden image)**. Path A skips the ~30-minute Docker-install and model-pull stages on every unit.
>
> The full operator walkthrough lives in [`docs/runbook/`](docs/runbook/) — **start at its [index](docs/runbook/README.md)**, which orders every step. The commands below are the map; the runbooks are the territory.

### Path A — Golden image (fleet / repeatable)

Build the image **once per JetPack version** on the workstation, then `dd` + personalize per box. Runbook: [`factory-image-pipeline.v0.1.0.md`](docs/runbook/factory-image-pipeline.v0.1.0.md).

```bash
# 1. (Workstation) Capture a fully-provisioned seed NVMe → compressed golden image.
#    The seed is a box already brought up via Path B.
sudo ./scripts/factory-image.sh --source /dev/disk/by-id/nvme-<seed> --jetpack-version 6.2.2

# 2. (Workstation) dd the image onto a blank NVMe — see runbook §3.2 for the guarded write.

# 3. (Workstation) Personalize the dd'd NVMe for ONE customer: sets hostname, regenerates
#    SSH + Tailscale identity, and stamps the customer slug into /etc/mailbox-customer.
sudo ./scripts/factory-prep-nvme.sh --slug acme --by-id /dev/disk/by-id/nvme-<blank>

# 4. Insert the NVMe into the Jetson and power on. factory-bootstrap reads the slug on
#    first boot; the box advertises https://acme.local/ on the customer LAN.
```

Finish with the per-customer credential + OAuth steps below (same as Path B, step 4).

### Path B — From the repo (single box)

Run these **on the Jetson, in order**. Each script is idempotent — a second run on a working box is a no-op.

```bash
# 1. First SSH access + workstation key trust (run once at the desktop/console).
sudo bash ./scripts/jetson-bootstrap-ssh.sh

# 2. mDNS/Avahi host identity → the box advertises https://<hostname>.local/ on the LAN.
#    Customer #3+ only; M1 is grandfathered. The script self-guards against M1/M2.
sudo bash ./scripts/factory-bootstrap.sh

# 3. Full stack bring-up (13 idempotent stages): Docker via JetsonHacks, GPU check,
#    MAXN power, LUKS-encrypt the data partition, build qwen3:4b-ctx4k + pull
#    nomic-embed-text, `docker compose up`, migrations (--profile migrate), Qdrant
#    bootstrap (--profile qdrant-bootstrap), n8n workflow + credential import, and a
#    final health check across all services.
sudo bash ./scripts/first-boot.sh
```

After `first-boot.sh` the stack is **up but inert** — no email account, no auth, no API keys.

```bash
# 4. Per-customer config + credentials (what a script can't do).
#    Walkthrough: docs/runbook/customer-onboarding.v0.1.0.md
#
#    - cp .env.example .env, then set the secrets: POSTGRES_PASSWORD, N8N_ENCRYPTION_KEY,
#      CLOUDFLARE_API_TOKEN, MAILBOX_BASIC_AUTH_HASH, OLLAMA_CLOUD_API_KEY
#    - connect Gmail via the n8n OAuth flow (no IMAP/SMTP credentials needed)
#    - set persona overrides for the classifier + drafter
#
#    Public HTTPS / DNS (run on the workstation, not the Jetson):
#      ./scripts/provision-customer-dns.sh <customer-slug> <appliance-lan-ip>
```

The dashboard is then live at `https://<hostname>.local/dashboard/queue` on the LAN, or behind Caddy at the customer's public hostname once the DNS-01 cert is issued (the canonical M1 box runs at `https://mailbox.heronlabsinc.com/dashboard/queue`).

> [!IMPORTANT]
> Two model footguns the scripts respect — preserve them in any manual step:
> - **Pin `OLLAMA_IMAGE`** in `.env` to a specific `ollama/ollama@sha256:<digest>`, never `:latest`. An upstream `:latest` bump silently broke a live box (Qwen3 thinking-mode regression).
> - **Build from `qwen3:4b-instruct`**, never the bare `qwen3:4b` alias — that alias shifted to a thinking-trained variant that emits chain-of-thought scratchwork instead of clean drafts (STAQPRO-330).

## Configuration

> [!IMPORTANT]
> Set all required environment variables in `.env` before first run. See `.env.example` for the full list. Gmail credentials are provisioned via the n8n OAuth flow on first run, not via env vars — the OAuth refresh token lives in n8n's encrypted credential store.

| Variable | Required | Description |
|----------|----------|-------------|
| `POSTGRES_PASSWORD` | Yes | Database password for the operational datastore |
| `N8N_ENCRYPTION_KEY` | Yes | Encrypts n8n's stored credentials (incl. Gmail OAuth refresh token). Generate: `openssl rand -hex 32` |
| `CLOUDFLARE_API_TOKEN` | Yes | DNS-edit-scoped token for Caddy's DNS-01 cert issuance |
| `MAILBOX_BASIC_AUTH_USER` | Yes | Caddy basic_auth username for `/dashboard/*` and the n8n editor (STAQPRO-131) |
| `MAILBOX_BASIC_AUTH_HASH` | Yes | Bcrypt hash. Generate: `docker run --rm caddy:2 caddy hash-password`. **Escape every `$` to `$$` in `.env`** — Docker Compose otherwise truncates the value |
| `OLLAMA_CLOUD_API_KEY` | Yes (for cloud-escalation drafts) | Ollama Cloud API key from `ollama.com/cloud`. Empty key disables the cloud path |
| `OLLAMA_CLOUD_MODEL` | No | Defaults to `gpt-oss:120b`; override per-deploy |
| `ANTHROPIC_API_KEY` | No | Alt-cloud fallback for drafting (Haiku 4.5). Config-ready but not the live default |

<details>
<summary>Docker Compose services</summary>

The `docker-compose.yml` runs seven long-running services plus three profile-gated one-shots used during provisioning:

| Service | Image | Purpose |
|---------|-------|---------|
| `postgres` | `postgres:17-alpine` | Operational datastore (`mailbox` schema) + n8n's `workflow_entity` table |
| `qdrant` | `qdrant/qdrant:v1.17.1` | Vector store for on-device RAG (collection `email_messages`, 768d/Cosine) |
| `ollama` | `${OLLAMA_IMAGE}` — pin to `ollama/ollama@sha256:<digest>` in `.env` | Local LLM inference with GPU passthrough (Qwen3-4B + nomic-embed-text) |
| `llama-cpp` | built on-device | Alternative local-inference runtime (DR-25; behind `MAILBOX_LOCAL_INFERENCE_PROVIDER`) |
| `n8n` | `n8nio/n8n:2.14.2` | Workflow orchestration (Schedule + Gmail Get → classify → draft → queue → Gmail Reply) |
| `caddy` | `caddy:2` | Public HTTPS via Cloudflare DNS-01; basic_auth on all paths (incl. `/webhook/*` per STAQPRO-161 — bypass removed post-DR-22) |
| `mailbox-dashboard` | Next.js 14 build | Approval queue UI + internal API routes |

Profile-gated one-shots (idempotent; invoked by `first-boot.sh`):

| Service | Profile | Purpose |
|---------|---------|---------|
| `mailbox-migrate` | `migrate` | Apply `dashboard/migrations/*.sql` via the tsx runner |
| `mailbox-qdrant-bootstrap` | `qdrant-bootstrap` | Create the Qdrant `email_messages` collection |
| `mailbox-n8n-verify` | `n8n-verify` | Gate: exit non-zero unless all four `MailBOX*` workflows are `active=true` |

</details>

## How It Works

1. **Ingest** — n8n's main `MailBOX` workflow runs on a 5-minute Schedule trigger and pulls new messages via the Gmail Get node (OAuth, no IMAP/SMTP). New emails land in `mailbox.inbox` (deduplicated by `gmail_message_id`) and are embedded with nomic-embed-text and upserted into Qdrant for later counterparty-scoped recall.
2. **Classify** — The `MailBOX-Classify` sub-workflow runs Qwen3-4B at 4096 ctx with `/no_think` for low latency, returning a category + confidence. Routes: `LOCAL_CATEGORIES` (`reorder`, `scheduling`, `follow_up`, `internal`, `inquiry`) → local; `CLOUD_CATEGORIES` (`escalate`, `unknown`) → cloud; any classification with `confidence < 0.75` → cloud safety net; `spam_marketing` → drop.
3. **Draft** — The `MailBOX-Draft` sub-workflow drafts the reply. Local route: Qwen3-4B (~2.7 GB on-device). Cloud route: Ollama Cloud `gpt-oss:120b` via the same `/api/chat` schema (Anthropic Haiku 4.5 is wired as a config-ready alt-cloud, swap in `.env`).
4. **Approve** — Every draft enters the approval queue at `https://<appliance>/dashboard/queue` (basic_auth gated). The operator reviews, edits if needed, and approves or rejects.
5. **Send** — On approve, the dashboard fires the `MailBOX-Send` sub-workflow webhook, which sends the reply via n8n's Gmail Reply node (preserving thread + references). Sent state is recorded in `mailbox.drafts.status = 'sent'`.

## Tech Stack

![NVIDIA](https://img.shields.io/badge/NVIDIA-Jetson-76B900?style=for-the-badge&logo=nvidia&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![React](https://img.shields.io/badge/React-61DAFB?style=for-the-badge&logo=react&logoColor=black)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)
![Tailwind](https://img.shields.io/badge/Tailwind_CSS-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white)

| Layer | Technology | Role |
|-------|-----------|------|
| Inference | Ollama (digest-pinned via `OLLAMA_IMAGE`) + `qwen3:4b-ctx4k` | Local classification and draft generation (~2.7 GB VRAM) |
| Embeddings | nomic-embed-text v1.5 | On-device RAG embedding (inbound auto-ingest + explicit outbound) |
| Escalation | Ollama Cloud `gpt-oss:120b` (default); Anthropic Haiku 4.5 (alt-cloud, config-ready) | Cloud-route drafting via the same `/api/chat` schema |
| Vector DB | Qdrant 1.17.1 | Semantic recall over the on-device email corpus (counterparty-scoped) |
| Orchestration | n8n 2.14.2 | Visual workflow engine; sub-workflows for classify / draft / send |
| Ingress | n8n Schedule trigger (5 min) + Gmail Get (OAuth) | DR-22 KILLED Pub/Sub push 2026-04-30; polling is the live path |
| Datastore | PostgreSQL 17-alpine | Approval queue, drafts, classification results, n8n state |
| Dashboard | Next.js 14 (App Router) + Kysely | Approval queue UI + internal API routes (`mailbox-dashboard` service, per DR-24; ORM = Kysely per the 2026-05-01 ADR) |
| Edge | Caddy 2 + Cloudflare DNS-01 | Public HTTPS, basic_auth on `/dashboard/*` and `/` (STAQPRO-131) |

## Memory Budget

Total system memory on the Jetson Orin Nano Super is 8 GB unified (shared between CPU and GPU).

| Component | Footprint | Notes |
|-----------|----------|-------|
| OS + JetPack 6.2.2 | ~1.5 GB | Baseline with Docker daemon |
| Qwen3-4B Q4_K_M | ~2.7 GB | Stays loaded during email processing |
| nomic-embed-text v1.5 | ~350 MB | May unload between RAG operations (Ollama LRU) |
| Qdrant | ~200–400 MB | Scales with vector count; 10K emails ≈ 100 MB index |
| n8n | ~300 MB | Node.js process |
| Postgres | ~100 MB | Small operational database |
| Dashboard | ~150 MB | Next.js 14 (App Router) production server |
| **Total** | **~5.7 GB** | **~2.3 GB headroom for bursts and OS cache** |

> [!WARNING]
> Do not run 7B-parameter models locally. A 7B Q4_K_M requires ~4.5 GB VRAM, leaving insufficient memory for embeddings, Qdrant, and the OS.

## Roadmap

- [x] Core architecture and Docker Compose orchestration
- [x] Tech stack validation (Ollama + Qwen3 on Jetson)
- [x] n8n workflow: Gmail Get + Schedule → classify → draft → approval queue (live at customer #1 as of 2026-05-01)
- [x] Dashboard: approval queue with approve/reject/edit actions (Next.js 14, basic_auth gated)
- [x] Cloud-escalation drafting (Ollama Cloud `gpt-oss:120b`; Haiku 4.5 alt-cloud config-ready)
- [x] Public HTTPS + auth gate (Caddy + Cloudflare DNS-01, STAQPRO-131)
- [ ] **Customer #2 sign-off** — real-Gmail E2E proof + docs sync (in flight, target 2026-05-20)
- [ ] **Pre-#2 hardening** — STAQPRO-133 (smoke tests), STAQPRO-134 (CI), STAQPRO-138 (zod input validation)
- [x] RAG pipeline: inbound/outbound email embedding + Qdrant counterparty-scoped recall
- [x] OTA update delivery via GitHub Container Registry (customer-initiated)
- [~] Multi-account / multi-provider mail (IMAP + Microsoft Graph seams landed; live transport in progress)
- [ ] Onboarding wizard — guided Gmail OAuth + persona extraction
- [ ] Fine-tuned classification model (Llama 3.2 3B or Qwen3 fine-tune)

## Contributing

Contributions are welcome. Open an issue to discuss proposed changes before submitting a pull request.

## License

[MIT](LICENSE)
