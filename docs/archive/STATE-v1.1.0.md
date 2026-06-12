# State — hermesBOX
Source PRD: PRD-v1.0.0.md + **PRD-ADDENDUM-001-cloud-inference.md** (cloud pivot)
Roadmap: ROADMAP-v1.0.0.md (Phases 1–4 amended by ADDENDUM-001)
Last updated: 2026-05-30 (cloud inference pivot)

## Active phase
Phase 2: hermes-agent core (cloud) — executing, **BLOCKED on API keys** (UMB-381)

## Architecture (post-pivot, ADDENDUM-001)
- **Inference: cloud.** OpenAI GPT primary (`gpt-4o`, adjustable) + OpenRouter fallback. NOT local.
- **Ollama: embeddings only** — `nomic-embed-text` for gbrain. Chat model removed.
- **Network required** (offline-first dropped).
- Memory: local chat model gone → ~5–6 GB headroom; central memory risk retired.

## Phase status
| Phase | Status | Linear | Notes |
|-------|--------|--------|-------|
| 0 | ✅ delivered | UMB-379 | base platform |
| 1 | ✅ delivered (repurposed) | UMB-380 | Ollama now embeddings-only (nomic-embed-text); chat tuning reverted |
| 2 | 🔨 blocked-on-keys | UMB-381 | hermes-agent installed + cloud config; needs OPENAI/OPENROUTER keys |
| 3 | pending | UMB-382 | now OpenAI ↔ OpenRouter fallback (was local→portal→openrouter) |
| 4 | pending | UMB-383 | gbrain; embeddings via local Ollama nomic-embed-text |
| 5 | pending | UMB-384 | WhatsApp |
| 6 | pending | UMB-385 | Kiosk GUI cog/WPE :9119 |
| 7 | pending | UMB-386 | hardening |

## Box facts (unchanged from probe)
- `mailbox@mailbox2.tail377a9a.ts.net`, passwordless sudo, JetPack 6.2/CUDA 12.6, NVMe root 839G free
- Toolchain on PATH via ~/.hermesbox_env.sh: uv/Py3.11, Node v22.22.2, Bun 1.3.14
- hermes-agent v0.15.1 installed at ~/.hermes/hermes-agent; HERMES_HOME=~/.hermes
- Ollama 0.24.0 service: embeddings (nomic-embed-text), bind 127.0.0.1:11434

## Config state (~/.hermes)
- config.yaml: provider=openai, model.default=gpt-4o (backups: .prehermesbox, .precloud)
- .env: HERMES_ACCEPT_HOOKS=1, TERMINAL_ENV=local, OPENAI_API_KEY= (EMPTY), OPENROUTER_API_KEY= (EMPTY)

## BLOCKING — needed from user
- Real **OPENAI_API_KEY** and **OPENROUTER_API_KEY** written into ~/.hermes/.env (chmod 600), then smoke test + fallback config.

## Provisioning artifacts (~/hermesbox/provisioning on box; source in repo)
00-base.sh, verify-phase0.sh, 10-inference.sh, verify-phase1.sh, 20-agent-install.sh, 21-agent-config.sh, 22-cloud-config.sh

## Linear
- staqs · UMB Advisors · project hermesBOX `c7ee1eef-...` — https://linear.app/staqs/project/hermesbox-4dbab8147794
- completed state name = "Delivered"; started = "In Development"

## Drift watch
- ADDENDUM-001 supersedes DR-001/002/004/006 + Constitution §2. PRD-v1.0.0 body not rewritten (addendum pattern).
- Existing `~/.gbrain/brain.pglite` still present — preserve in Phase 4.
- `set-maxn-power.service` still failing (pre-existing) → degraded state; clean up Phase 7.
