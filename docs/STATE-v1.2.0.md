# State — hermesBOX
Source PRD: PRD-v1.0.0.md + PRD-ADDENDUM-001-cloud-inference.md
Roadmap: ROADMAP-v1.0.0.md (Phases 1–4 amended by ADDENDUM-001)
Last updated: 2026-05-30 (Phases 0–6 delivered; 7 hardening applied, reboot-test pending)

## Headline
A working NousResearch Hermes agent appliance on a Jetson Orin Nano 8GB. Cloud Codex brain
(ChatGPT sub), local gbrain memory, kiosk dashboard on screen. Headless-reachable + boots to ready.

## Phase status
| Phase | Status | Linear | Notes |
|-------|--------|--------|-------|
| 0 | ✅ delivered | UMB-379 | base platform |
| 1 | ✅ delivered | UMB-380 | Ollama embeddings-only |
| 2 | ✅ delivered | UMB-381 | agent on Codex gpt-5.3-codex (ChatGPT sub) |
| 3 | ✅ delivered | UMB-382 | fallback codex→openrouter→openai (inert until funded) |
| 4 | ✅ delivered | UMB-383 | gbrain fresh brain + Ollama embeds + MCP 30+ tools |
| 5 | ⏳ QR-ready (deferred) | UMB-384 | Baileys self-chat; user deferred QR |
| 6 | ✅ delivered (chromium) | UMB-385 | dashboard on screen; cog/WPE failed on Tegra→chromium fallback |
| 7 | ◐ applied, reboot-test pending | UMB-386 | set-maxn fixed, network-wait, boot-enabled, runbook |

## Boots to ready (enabled, linger on)
- ollama (system) · hermes-dashboard.service + hermesbox-kiosk-chromium.service (user) · network-wait
- system state: running · full-stack idle ~1.7GB/5.6GB free

## Display (Phase 6 hard-won)
- cog/WPE does NOT work on this Tegra stack (FDO backend renders nothing). Committed CHROMIUM --kiosk (software render).
- DP-1 HPD flaps (marginal cable) → forced via /etc/X11/xorg.conf: ConnectedMonitor DFP-1 + UseHotplugEvents=false (provisioning/60-xorg-dfp1-forced.conf; backup xorg.conf.prehermesbox).
- Resolution = nvidia-auto-select (not confirmed 1080p; needs stable EDID or CustomEDID for native).
- NO keyboard/mouse on box → screen is display-only. Interact via SSH/WhatsApp or add USB kbd/mouse/touchscreen.

## Config (~/.hermes)
- config.yaml: provider openai-codex/gpt-5.3-codex, max_tokens 8192, fallback_providers chain, mcp_servers.gbrain
- .env(600): Codex OAuth (active); OPENROUTER_API_KEY(low bal); OPENAI_API_KEY(unfunded); WHATSAPP_ENABLED=true MODE=self-chat (unpaired)
- gbrain: GBRAIN_HOME=~/.hermesbox, ollama:nomic-embed-text@768, base_urls.ollama=:11434/v1

## REMAINING (operator)
1. Reboot-resilience test (capstone): provisioning/reboot-resilience.sh — disruptive ~4min; validates boot-to-ready + kiosk-at-boot.
2. WhatsApp QR pairing (deferred): ssh -t … hermes whatsapp → scan → hermes gateway run.
3. Display polish: stable DP cable/adapter for native 1080p (EDID); USB kbd/mouse for on-screen interaction.
4. Fund OpenRouter/OpenAI to activate fallback.
5. Security: rotate plaintext nvapi- key in ~/.gbrain/config.json (other project's brain).

## Box / Linear
- mailbox@mailbox2.tail377a9a.ts.net (Tailscale; retry exit 255; ~4min reboot-to-SSH), passwordless sudo
- staqs · UMB Advisors · hermesBOX — https://linear.app/staqs/project/hermesbox-4dbab8147794
- Workflow state names: started=In Development, completed=Delivered

## Provisioning artifacts (repo provisioning/ + box ~/hermesbox/provisioning; gbrain src ~/gbrain-src on box)
00-base,10-inference,20-agent-install,21-agent-config,22-cloud-config,30-fallback,41-gbrain-fresh,
50-whatsapp,60-kiosk(+launchers+units+xorg conf),70-hardening(+drop-ins),reboot-resilience,
verify-phase{0,1,3,5,6,7}, RUNBOOK.md, PRD-ADDENDUM-001
