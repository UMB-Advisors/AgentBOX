# Addendum — AgentBOX (Unified MailBOX + Hermes) Solo Configuration

## v0.1

> **Created:** 2026-05-31
> **Author:** Dustin (UMB Group)
> **Status:** ACCUMULATING — architecture lock for the unified AgentBOX. SM-97 (memory) is **measured PASS**; NC-41 (draft value) pending Q2.
> **Relates to:**
> - `spike-hermes-on-mailbox-feasibility-v0_1-2026-05-31.md` — the spike that de-risked this config (Q1/Q2). Verdict feeds back here.
> - `prd-email-agent-appliance.md` (MailBOX PRD) — the T2 stack this builds on.
> - thUMBox SoT v1.5 — AgentBOX is the unified T2 load-out (MailBOX pipeline + Hermes agent on one box).
> - This addendum **defines** SM-97, NC-40, NC-41, NC-43 (referenced by the spike) and introduces DR-63..66.

---

## TL;DR

AgentBOX = one 8 GB Jetson Orin running the **full MailBOX email pipeline** (classify → draft → approve → send) **and** the **Hermes agent** (conversational surface + skill/voice memory via gbrain) **co-resident**. The spike measured the memory envelope on real hardware: **S2 worst-case leaves 1,810 MB free (3.6× the 500 MB bar), no OOM** — Hermes fits. AgentBOX ships as a **reproducible golden image** (DR-66); mailbox2 is the validated prototype, not a production box. This addendum locks the unified architecture, the ollama-consolidation and gbrain-storage decisions, the security model, and the reproducible-install design.

---

## 1. What AgentBOX is

A single appliance that unifies two previously-separate product lines onto one T2 box:

| Layer | Provides | Source |
|---|---|---|
| **MailBOX pipeline** | inbound email triage + draft + human-approved send; RAG over counterparty history; urgency/VIP; digest | MailBOX golden image (8-service stack) |
| **Hermes agent** | always-on conversational surface, multi-tool agentic turns, skill memory + your-voice modeling | hermesBOX (Hermes v0.15.1 client-mode + gbrain) |
| **Shared substrate** | one Postgres, one ollama (qwen3 classify/draft + nomic embeddings), one box | consolidated (DR-64) |

**Not** a second box, not a cloud service. The value: the operator gets the MailBOX email assistant *and* a general agent that already knows their voice/context — on hardware they already plug in.

---

## 2. Validated envelope (SM-97 — MEASURED PASS)

> **SM-97 (peak-RAM gate):** AgentBOX must survive worst-case load on 8 GB with the classifier resident, leaving ≥ 500 MB free.

Measured 2026-05-31 on a real Jetson Orin Nano 8 GB (mailbox2), full MailBOX stack resident + `qwen3:4b-ctx4k` drafting + concurrent heavy Hermes turn:

| State | Peak RAM used | Free at peak |
|---|---|---|
| S0 — stack idle, Hermes idle | 1,592 MB | 6,015 MB |
| S1 — qwen3 drafting alone | 5,339 MB | 2,268 MB |
| **S2 — qwen3 drafting ∥ heavy Hermes turn (gate)** | **5,797 MB** | **1,810 MB** |

**Result: PASS** — 3.6× the bar, no OOM, no container restarts (DR-25 failure mode checked). Hermes' marginal cost ≈ 460 MB. Number is **conservative** (measured with two ollama instances resident; DR-64 consolidation reclaims more). **→ SM-97 is satisfied; AgentBOX is memory-viable on T2.**

---

## 3. Architecture — unified service topology

```
Jetson Orin Nano Super 8GB
├── MailBOX stack (Docker Compose)
│   ├── postgres:17         schema `mailbox` (+ optional `gbrain` schema — DR-65)
│   ├── qdrant              email_messages vectors (counterparty RAG)
│   ├── ollama (dockerized) qwen3:4b-ctx4k (classify+draft) + nomic-embed-text  ← SINGLE ollama (DR-64)
│   ├── n8n                 MailBOX{,-Classify,-Draft,-Send,-Digest,...} workflows
│   ├── caddy               HTTPS + basic_auth (all paths)
│   └── mailbox-dashboard   approval queue + internal API
└── Hermes (host, client-mode)
    ├── hermes-agent        cloud inference (no local weights) + tools
    └── gbrain (MCP)        pglite memory, nomic embeddings via the SHARED ollama (DR-64/65)
```

**Resident-set principle:** exactly one local LLM runtime (ollama) holds the only heavy weights (qwen3 + nomic). Hermes reasons via cloud (weight-free — the §4.1 spike premise, confirmed: on the prototype ollama held only the embedder while Hermes ran). This is what keeps AgentBOX inside the 8 GB envelope.

---

## 4. Decisions

> **DR-63 — Unified AgentBOX = MailBOX golden image + Hermes client-mode + gbrain, co-resident on one T2.**
> Status: **Accepted** (memory-validated by SM-97). Hermes adds a conversational/agent surface and voice memory without a second box. The classifier stays resident; Hermes stays weight-free (cloud).

> **DR-64 — One ollama serves both stacks.** A single dockerized ollama holds `qwen3:4b-ctx4k` (classify + local draft) and `nomic-embed-text` (MailBOX RAG **and** gbrain embeddings). The standalone host-ollama from hermesBOX is **retired**; gbrain is repointed at the shared ollama.
> Status: **Accepted.** Rationale: two ollama runtimes is pure overhead on 8 GB; both need only nomic + (MailBOX) qwen3. Consolidation reclaims the headroom that made the SM-97 number conservative.

> **DR-65 — gbrain storage = PGlite for v1; shared-Postgres-17 deferred as a footprint lever.**
> Status: **Accepted (v1).** PGlite is zero-config, isolates gbrain's blast radius, and matches the prototype. gbrain *can* move to the appliance Postgres (`gbrain init --url`, isolated `gbrain` schema) — prerequisite **pgvector** (pg17-alpine lacks it → `pgvector/pgvector:pg17`). Revisit only if a future heavier load makes SM-97 marginal (consolidating to one pg process is the lever). Tracked as **NC-44**.

> **DR-66 — AgentBOX ships as a reproducible golden image; the prototype box is not anointed production.**
> Status: **Accepted** (operator decision 2026-05-31). Deliverable = an install automation + golden-image/runbook that reproduces the config on any T2 Jetson. hermesBOX-standalone and OpenClaw remain restorable on the prototype hardware (not destroyed). Closes the "factory-bootstrap never built" gap (MBOX-156 audit).

### Success metrics

| # | Metric | Status |
|---|---|---|
| **SM-97** | Peak-RAM gate (≥500 MB free at worst case) | **PASS — 1,810 MB measured** |
| **SM-100** | Boot-to-ready ≤ 5 min from cold (stack + Hermes healthy) | *new — verify in P3* |
| **SM-101** | Reproducible install: clean Jetson → green stack via one runbook, ≤ 1 documented manual step (Gmail consent) | *new — P1/P3* |

### Open questions

| # | Question | Status |
|---|---|---|
| **NC-41** | Is Hermes worth it *in the draft path* (vs direct-API draft)? | **pending Q2** — run on the hardened box; A/B is directional until the L1 control-parity fix (arm A = live `/api/internal/draft-prompt`) lands |
| **NC-40** | Is NemoClaw's sandbox redundant given Hermes' native security (PII redaction, tirith pre-exec, approval escalation)? | observational — record on the prototype; decide at the Eric/Kevin briefing |
| **NC-43** | If SM-97 were marginal: drop the resident classifier (classify→cloud)? | **moot** — SM-97 passed comfortably; keep the local classifier |
| **NC-44** | Move gbrain to shared pg17+pgvector? | deferred (DR-65) — only if footprint pressure returns |

---

## 5. Reproducible install (the shippable image — DR-66)

No canonical MailBOX install automation exists (factory-bootstrap.sh is avahi-only; the prototype was bootstrapped by applying `dashboard/test/fixtures/schema.sql` + marking migrations — a shortcut, not the path). AgentBOX needs a real one. Design:

**`agentbox-install.sh`** (host, idempotent, staged like `first-boot.sh`):
1. **Preconditions** — JetPack 6.x, Docker + nvidia runtime, ≥ 16 GB disk free, clone repo + submodule.
2. **Secrets** — pull from 1Password (`op item get`) into `.env`; generate per-box where appropriate (postgres pw, n8n key, caddy bcrypt, OAuth state/token keys). **Gate ON** (no `MAILBOX_LIVE_GATE_BYPASS`).
3. **DB bootstrap (canonical)** — bring up postgres; apply the **base schema** then run migrations to head. (Fixes the "001 extends a table nothing created" gap: ship a real `000-base-schema.sql` or an init that lays the base tables, so `--profile migrate` works on a clean box. Replaces the schema.sql shortcut.)
4. **Models** — build `qwen3:4b-ctx4k` (FROM `qwen3:4b-instruct`, num_ctx 4096) + pull `nomic-embed-text` into the single dockerized ollama (DR-64).
5. **Stack up** — `docker compose up -d --build` (8 services); qdrant bootstrap; `mailbox-n8n-verify` gate (all workflows active).
6. **n8n** — import + activate workflows + the Postgres credential (`JFX4tvrffvKnTouV` gotcha); restart n8n.
7. **Hermes** — install client-mode (no local weights); wire gbrain MCP at the **shared** ollama (DR-64); confirm weight-free (`ollama ps` shows only nomic + qwen3).
8. **Gmail** — OAuth consent (the one unavoidable manual step) or test account.
9. **Boot-to-ready** — `restart: unless-stopped` on compose + a `agentbox.target` systemd unit that brings the stack + Hermes up at boot; validate SM-100.
10. **Verify** — pipeline smoke (inject inbound → draft appears), Hermes smoke (`hermes -z`), SM-97 spot-check, n8n-verify green.

Golden-image path: snapshot a validated install to an image (`image → dd → prep-nvme`, STAQPRO-409 route) for flash-to-new-Jetson; `agentbox-install.sh` is the from-git alternative.

---

## 6. Security model (hardening — must-do for "permanent")

| Item | Requirement |
|---|---|
| **Provider keys** | **ROTATE the leaked OpenAI/OpenRouter/Firecrawl keys** (exposed 2026-05-31). Hermes provider creds + `OLLAMA_CLOUD_API_KEY` from 1Password, never in chat/repo. |
| **Onboarding gate** | `MAILBOX_LIVE_GATE_BYPASS` **unset** — real onboarding gates classify/draft. |
| **Ingress** | Caddy basic_auth on all paths incl. `/webhook/*` (STAQPRO-161); DNS-01 TLS, or tailnet-only with no public bind. |
| **docker.sock** | dashboard's `:ro` sock bind is single-tenant-trusted only (orphan-container stat). Re-evaluate before any multi-tenant AgentBOX. |
| **Hermes `--yolo`** | not in any unattended/cron path on a permanent box; agentic tool-use behind approval (NC-40 native escalation). |
| **gbrain data** | on-appliance only (matches MailBOX privacy constraint); pglite file perms 700. |

---

## 7. Plan

| Phase | Deliverable | Status |
|---|---|---|
| **P0** | This addendum + ADR | ▶ in progress |
| **P1** | `agentbox-install.sh` + canonical `000-base-schema` (the reproducible install) | next |
| **P2** | Security hardening (key rotation, real secrets, gate on, basic_auth) | next |
| **P3** | Clean reinstall on mb2 prototype → validate SM-100/SM-101, run Q2 → resolve NC-41 → final GREEN/AMBER verdict | gated on P1/P2 |

*End of AgentBOX addendum v0.1.*
