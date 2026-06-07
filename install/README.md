# AgentBOX

**Unified MailBOX email pipeline + Hermes agent on one 8 GB T2 Jetson — shipped as a reproducible golden image.**

AgentBOX co-locates the full **MailBOX** email assistant (inbound triage → draft → human-approved send, with counterparty RAG, urgency/VIP, digest) and the **Hermes** agent (always-on conversational surface + skill/your-voice memory via gbrain) on a single Jetson Orin Nano Super 8 GB. The operator gets the email assistant *and* a general agent that already knows their voice — on hardware they plug in.

## Validated

The memory envelope was measured on real hardware (the unified stack resident + `qwen3:4b-ctx4k` drafting + a concurrent heavy Hermes turn):

| State | Peak RAM used | Free at peak |
|---|---|---|
| S0 — idle | 1,592 MB | 6,015 MB |
| S1 — qwen3 drafting | 5,339 MB | 2,268 MB |
| **S2 — drafting ∥ heavy Hermes turn** | **5,797 MB** | **1,810 MB** |

**SM-97 PASS** — 1,810 MB free at worst case (3.6× the 500 MB bar), no OOM, no container restarts. **Hermes fits on T2.** See `docs/addendum-agentbox-solo-hermes-mailbox-v0_1-2026-05-31.md` for the full spec, decisions (DR-63..66), and security model.

## Architecture

```
Jetson Orin Nano Super 8GB
├── MailBOX stack (Docker Compose)
│   ├── postgres:17    qdrant    ollama(qwen3:4b-ctx4k + nomic-embed)  ← single ollama (DR-64)
│   ├── n8n            MailBOX{,-Classify,-Draft,-Send,-Digest} workflows
│   ├── caddy          HTTPS + basic_auth
│   └── mailbox-dashboard   approval queue + internal API
└── Hermes (host, client-mode)
    ├── hermes-agent   cloud inference (no local weights) + tools
    └── gbrain (MCP)   pglite memory, embeddings via the shared ollama
```

Exactly one local LLM runtime (ollama) holds the only heavy weights (`qwen3:4b-ctx4k` + `nomic-embed-text`). Hermes reasons via cloud (weight-free) — that's what keeps AgentBOX inside the 8 GB envelope.

## Components

AgentBOX is the **orchestration layer**. It composes:
- **MailBOX** — the email-appliance stack (vendored in this monorepo at `mailbox/`; synced into place by the installer, not cloned — UMB-105).
- **hermes-agent** + **gbrain** — the agent + memory (installed host-side, client mode).

## Install

`install/agentbox-install.sh` is the staged, idempotent bring-up (clean Jetson → green AgentBOX). It pulls secrets from 1Password (or `--prototype` for throwaway bench secrets), does the canonical DB bootstrap, builds the single ollama's models, brings up the stack, imports + activates the n8n workflows (with the hardcoded Postgres credential), wires Hermes client-mode + gbrain, and installs the boot-to-ready systemd unit.

```bash
./install/agentbox-install.sh            # production (1Password secrets, gate ON)
./install/agentbox-install.sh --prototype  # bench (throwaway secrets, non-destructive)
```

**Manual steps the installer can't do headless** (it prompts/documents them):
- Gmail OAuth consent (browser, per inbox) — see `config/` for the Funnel ingress used for the OAuth callback.
- 1Password item setup (production secrets).
- GCP: enable the Gmail API in the OAuth client's project + add the redirect URI.

## Gmail OAuth ingress (Funnel + basic_auth)

A non-public box can't receive Google's OAuth redirect directly. AgentBOX uses **Tailscale Funnel → a basic_auth Caddy → n8n** (TLS at Funnel; no bare service exposed). The callback is `https://<box>.<tailnet>.ts.net/rest/oauth2-credential/callback`. Templates in `config/`. The tailnet ACL must grant the `funnel` nodeAttr to the box's tag.

## Status

Prototype validated end-to-end on a bench Jetson (2026-05-31): clean install reproduces the box in ~2.5 min; pipeline triages real Gmail (read → classify → draft/drop); boot-to-ready; secure Funnel ingress. AgentBOX ships as this reproducible image — the prototype hardware is not anointed production (DR-66).
