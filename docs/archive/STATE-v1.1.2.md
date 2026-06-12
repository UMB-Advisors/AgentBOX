# State — hermesBOX
Source PRD: PRD-v1.0.0.md + PRD-ADDENDUM-001-cloud-inference.md
Roadmap: ROADMAP-v1.0.0.md (Phases 1–4 amended by ADDENDUM-001)
Last updated: 2026-05-30 (Phases 0–4 delivered; 5 QR-ready)

## Active / next
Phase 5 WhatsApp — QR-READY, waiting on user to pair. Then Phase 6 (kiosk, needs display) → Phase 7 (hardening).

## Phase status
| Phase | Status | Linear | Notes |
|-------|--------|--------|-------|
| 0 | ✅ delivered | UMB-379 | base platform |
| 1 | ✅ delivered (repurposed) | UMB-380 | Ollama embeddings-only |
| 2 | ✅ delivered | UMB-381 | agent live on Codex/ChatGPT sub (gpt-5.3-codex) |
| 3 | ✅ delivered | UMB-382 | fallback chain wired (inert until funded) |
| 4 | ✅ delivered | UMB-383 | gbrain fresh brain + Ollama embeds + MCP (30+ tools) |
| 5 | ⏳ QR-ready | UMB-384 | Baileys bridge installed, self-chat; USER scans QR |
| 6 | pending | UMB-385 | kiosk cog/WPE :9119 — needs SPA pre-build + display verify |
| 7 | partial | UMB-386 | set-maxn fixed (system=running); gateway install + ordering + reboot test remain |

## WORKING NOW
- Agent: chat + tools + multi-turn via OpenAI Codex gpt-5.3-codex (ChatGPT sub, no API credits).
- Memory: gbrain fresh brain ~/.hermesbox/.gbrain, Ollama nomic-embed-text @768, MCP-registered, retrieval verified (0.88).
- Fallback chain wired: codex → openrouter/gpt-4o → openai-api/gpt-4o (needs funding to engage).
- Ollama = embeddings only. System state: running (degraded cleared).

## Config (~/.hermes)
- config.yaml: provider openai-codex, gpt-5.3-codex, max_tokens 8192, reasoning medium; fallback_providers chain; mcp_servers.gbrain. Backups: .prehermesbox/.precloud/.prefallback/.premcp
- .env (600): Codex OAuth (active); OPENROUTER_API_KEY (low bal); OPENAI_API_KEY (unfunded); WHATSAPP_ENABLED=true WHATSAPP_MODE=self-chat
- gbrain brain config: ~/.hermesbox/.gbrain/config.json (pglite, ollama:nomic-embed-text@768, base_urls.ollama=:11434/v1)

## REMAINING USER ACTIONS
1. **WhatsApp pair (Phase 5):** `ssh -t mailbox@mailbox2.tail377a9a.ts.net` → `source ~/.hermesbox_env.sh && hermes whatsapp` → scan QR (Linked Devices) → `hermes gateway run`.
2. **Kiosk (Phase 6):** attach a display; then pre-build SPA + verify-then-commit cog/WPE vs chromium.
3. Optional funding: OpenRouter top-up / OpenAI billing to activate fallback.
4. Security: rotate the plaintext nvapi- key in ~/.gbrain/config.json (other project's brain).

## Box / Linear
- mailbox@mailbox2.tail377a9a.ts.net (Tailscale; retry on exit 255), passwordless sudo
- staqs · UMB Advisors · project hermesBOX — https://linear.app/staqs/project/hermesbox-4dbab8147794

## Provisioning artifacts (repo + ~/hermesbox/provisioning on box)
00-base, verify-phase0, 10-inference, verify-phase1, 20-agent-install, 21-agent-config, 22-cloud-config,
30-fallback, verify-phase3, 41-gbrain-fresh, 50-whatsapp, verify-phase5,
60-kiosk* (+ .service units), verify-phase6, 70-hardening (+ .conf drop-ins), verify-phase7, reboot-resilience, RUNBOOK.md
(gbrain source synced to ~/gbrain-src on box)

## Drift watch
- WhatsApp bridge is Baileys (WebSocket, ~50-90MB) NOT chromium — PRD §7/§8 budget was wrong; box far roomier.
- :9119 dashboard earlier didn't bind because SPA dist isn't built; `hermes dashboard` runs npm build first (minutes). Phase 6 pre-builds then --skip-build.
- 40-gbrain.sh (authored, repurpose-oriented) superseded by 41-gbrain-fresh.sh (fresh brain).
