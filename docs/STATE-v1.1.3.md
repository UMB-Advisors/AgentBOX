# State — hermesBOX
Source PRD: PRD-v1.0.0.md + PRD-ADDENDUM-001-cloud-inference.md
Roadmap: ROADMAP-v1.0.0.md (Phases 1–4 amended by ADDENDUM-001)
Last updated: 2026-05-30 (PAUSED — user fixing DisplayPort before kiosk verify)

## PAUSE POINT
Phases 0–4 delivered + 7-partial. Phase 6 kiosk software-built but the Orin Nano
detects NO display (`/sys/class/drm/card1-DP-1: disconnected`). User is fixing the
physical DisplayPort connection. RESUME = verify kiosk render → commit → Phase 7.

## Phase status
| Phase | Status | Linear | Notes |
|-------|--------|--------|-------|
| 0 | ✅ delivered | UMB-379 | base platform |
| 1 | ✅ delivered | UMB-380 | Ollama embeddings-only |
| 2 | ✅ delivered | UMB-381 | agent on Codex gpt-5.3-codex (ChatGPT sub) |
| 3 | ✅ delivered | UMB-382 | fallback chain wired (inert until funded) |
| 4 | ✅ delivered | UMB-383 | gbrain fresh brain + Ollama embeds + MCP |
| 5 | ⏳ QR-ready (deferred) | UMB-384 | Baileys self-chat; user deferred QR pairing |
| 6 | ◐ built, blocked on display | UMB-385 | cog/matchbox/SPA built; DP-1 disconnected |
| 7 | ◐ partial | UMB-386 | set-maxn fixed (system=running); rest pending |

## WORKING NOW (headless, via SSH/CLI)
- Agent: chat+tools+multi-turn on gpt-5.3-codex (ChatGPT sub).
- Memory: gbrain fresh brain (~/.hermesbox/.gbrain), Ollama nomic-embed-text@768, MCP 30+ tools.
- Dashboard: hermes-dashboard.service ACTIVE, http://127.0.0.1:9119 HTTP 200 (binds ~1s).
- Ollama embeddings only. System state: running.

## RESUME STEPS (when display detected)
1. Fix DisplayPort: native DP cable/monitor OR active HDMI→DP adapter; reboot with it attached (Tegra EDID).
2. Confirm: `cat /sys/class/drm/card1-DP-1/status`  → must read `connected`.
3. Tell Claude "display fixed" (or run yourself):
   `systemctl --user start hermes-dashboard.service hermesbox-kiosk-cog.service`
   → look at screen: dashboard fullscreen + Chat tab streams.
4. COMMIT: if cog renders → `systemctl --user enable hermes-dashboard.service hermesbox-kiosk-cog.service`.
   If cog mis-renders (xterm/WebSocket broken) → `sudo snap install chromium` + enable hermesbox-kiosk-chromium.service instead. (NOT needed for the disconnected-display case — that was hardware.)
5. Then Phase 7: `sudo hermes gateway install --system` (optional, for :8642 API — WhatsApp deferred so gateway has no live platform yet), run provisioning/70-hardening.sh (network-wait + ordering drop-ins), then provisioning/reboot-resilience.sh.

## Config (~/.hermes)
- config.yaml: provider openai-codex/gpt-5.3-codex, max_tokens 8192, fallback_providers chain, mcp_servers.gbrain. Backups: .prehermesbox/.precloud/.prefallback/.premcp
- .env(600): Codex OAuth; OPENROUTER_API_KEY(low); OPENAI_API_KEY(unfunded); WHATSAPP_ENABLED=true MODE=self-chat (unpaired)
- kiosk: user units ~/.config/systemd/user/{hermes-dashboard,hermesbox-kiosk-cog,hermesbox-kiosk-chromium}.service (dashboard active; kiosk units installed, NOT enabled); lingering enabled

## Box / Linear
- mailbox@mailbox2.tail377a9a.ts.net (Tailscale; retry exit 255), passwordless sudo, ~4min reboot-to-SSH
- staqs · UMB Advisors · hermesBOX — https://linear.app/staqs/project/hermesbox-4dbab8147794

## Provisioning artifacts (repo + ~/hermesbox/provisioning on box; gbrain src ~/gbrain-src)
00-base, 10-inference, 20-agent-install, 21-agent-config, 22-cloud-config, 30-fallback,
41-gbrain-fresh, 50-whatsapp, 60-kiosk(+units), 70-hardening(+drop-ins), reboot-resilience,
verify-phase{0,1,3,5,6,7}, RUNBOOK.md

## Open operator items
- DisplayPort detection (blocks kiosk render).
- WhatsApp QR pairing (deferred).
- Fund OpenRouter/OpenAI to activate fallback.
- Rotate plaintext nvapi- key in ~/.gbrain/config.json (other project's brain).
- Phase 7: gateway install (only if :8642 API wanted; WhatsApp gateway has no platform until paired), reboot-resilience test.
