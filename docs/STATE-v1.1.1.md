# State — hermesBOX
Source PRD: PRD-v1.0.0.md + PRD-ADDENDUM-001-cloud-inference.md
Roadmap: ROADMAP-v1.0.0.md (Phases 1–4 amended by ADDENDUM-001)
Last updated: 2026-05-30 (Phase 2 delivered — agent live on ChatGPT-sub Codex)

## Active phase
Phase 3: Hybrid routing / fallback — next (UMB-382). Phases 4/5 also unblocked.

## WORKING NOW
- hermes-agent v0.15.1 on the box, chatting + tool-calling via **OpenAI Codex (`gpt-5.3-codex`) on the user's ChatGPT subscription** (OAuth, zero API credits).
- Proven: chat, full-toolset tool call (`uname -m`→`aarch64`), multi-turn recall. Memory 553 MB used / 6.8 GB free.
- Ollama = embeddings only (`nomic-embed-text`).

## Phase status
| Phase | Status | Linear | Notes |
|-------|--------|--------|-------|
| 0 | ✅ delivered | UMB-379 | base platform |
| 1 | ✅ delivered (repurposed) | UMB-380 | Ollama embeddings-only |
| 2 | ✅ delivered | UMB-381 | agent live on Codex/ChatGPT sub |
| 3 | ▶ next | UMB-382 | fallback: OpenRouter / OpenAI-API (both need funding) |
| 4 | pending | UMB-383 | gbrain — **existing brain at ~/.gbrain/brain.pglite**, embeddings via Ollama |
| 5 | pending | UMB-384 | WhatsApp (user's primary interface) |
| 6 | pending | UMB-385 | Kiosk GUI cog/WPE :9119 |
| 7 | pending | UMB-386 | hardening (also fix set-maxn-power.service) |

## Final agent config (~/.hermes/config.yaml)
- provider: openai-codex · model.default: gpt-5.3-codex · max_tokens: 8192 · reasoning_effort: medium
- terminal.backend: local, sudo_password: "" · backups: config.yaml.{prehermesbox,precloud}
- Credentials (~/.hermes/.env, 600): Codex OAuth token (active); OPENROUTER_API_KEY (near-empty); OPENAI_API_KEY (sk-proj, unfunded). NOTE: OpenAI key was pasted in chat — rotate if transcript shared.

## Auth/funding notes
- Primary = Codex via ChatGPT sub (free). `hermes auth add openai-codex --type oauth --no-browser --manual-paste` (interactive, done).
- gpt-5-codex NOT allowed for ChatGPT-account Codex; use gpt-5.3-codex (or other gpt-5.x-codex).
- OpenAI API quota exceeded (no billing); OpenRouter 402 (low balance, capped max_tokens earlier).

## Box / Linear
- mailbox@mailbox2.tail377a9a.ts.net (Tailscale, flaky occasionally — retry on exit 255), passwordless sudo
- staqs · UMB Advisors · project hermesBOX `c7ee1eef-...` — https://linear.app/staqs/project/hermesbox-4dbab8147794
- completed state = "Delivered"; started = "In Development"

## Provisioning (repo + ~/hermesbox/provisioning on box)
00-base, verify-phase0, 10-inference, verify-phase1, 20-agent-install, 21-agent-config, 22-cloud-config

## Drift watch
- ADDENDUM-001 governs inference (cloud Codex). DR-008 realized as Codex-subscription (better than API-key plan).
- Existing ~/.gbrain brain — preserve in Phase 4.
- set-maxn-power.service still failing (pre-existing) → systemctl degraded; fix Phase 7.
