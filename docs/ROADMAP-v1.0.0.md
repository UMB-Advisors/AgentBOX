# Roadmap — hermesBOX
Source PRD: PRD-v1.0.0.md
Milestone: v1.0.0 — Edge appliance MVP (Orin Nano 8 GB, JetPack 6)

> Every phase gates on its measured acceptance criteria **and** the §7 memory budget. No calendar gates. Advance only when the prior phase passes on real hardware.

## Phase 0: Base platform bring-up (headless)
- **Depends on:** none
- **Deliverables:** JetPack 6 flashed (no DE), NVMe storage, Python 3.11 (+uv), Node LTS, Bun, CUDA verified, zram+swap, SSH.
- **Acceptance criteria (pass/fail):**
  - [ ] `python3.11 --version` ≥ 3.11 and `uv` present
  - [ ] `node -v` (LTS) and `bun -v` succeed
  - [ ] GPU visible (`nvidia-smi`/`tegrastats`) and CUDA 12.x (`nvcc --version`)
  - [ ] `systemctl get-default` = `multi-user.target` (no DE); idle `free -m` used ≤ ~1.2 GB
  - [ ] zram active (`zramctl`); unattended reboot returns to SSH
- **Execution path:** single-pass
- **Cost note:** Build = setup + NVMe (~$30–60); Operating = ~5–10 W idle; Opportunity = none

## Phase 1: Local inference (Ollama + Hermes-3-3B)
- **Depends on:** Phase 0
- **Deliverables:** Ollama (arm64+CUDA), Hermes-3-Llama-3.2-3B Q4_K_M, OpenAI-compatible endpoint `:11434`.
- **Acceptance criteria (pass/fail):**
  - [ ] `curl :11434/v1/chat/completions` returns a valid Hermes completion
  - [ ] Inference runs on GPU (tegrastats GPU load confirmed)
  - [ ] Tokens/sec recorded; first-token latency < ~3 s (short prompt)
  - [ ] Model-loaded memory delta measured, within §7 line item
- **Execution path:** single-pass
- **Cost note:** Build = ~2 GB download; Operating = GPU power under load; Opportunity = 3B quality ceiling (mitigated Phase 3)

## Phase 2: hermes-agent core
- **Depends on:** Phase 1
- **Deliverables:** hermes-agent installed (Py3.11), config → local Ollama provider, CLI working, API on `:8642`.
- **Acceptance criteria (pass/fail):**
  - [ ] `hermes` CLI completes a multi-turn conversation on the **local** model
  - [ ] ≥1 built-in tool call executes end-to-end
  - [ ] `:8642` serves an SSE chat response to a raw HTTP request
  - [ ] Core chat works with network unplugged (offline-first)
  - [ ] Combined memory (P0+1+2) measured, within budget
- **Execution path:** single-pass
- **Cost note:** Build = install+config; Operating = ~0.5–0.8 GB; Opportunity = none

## Phase 3: Hybrid routing (cloud fallback)
- **Depends on:** Phase 2
- **Deliverables:** Providers `local`→`cloud-portal`→`cloud-openrouter` (DR-006); documented escalation (command + heuristic shim).
- **Acceptance criteria (pass/fail):**
  - [ ] Switch a live session local→portal→openrouter and back; each returns a valid completion
  - [ ] Escalation trigger documented + demonstrated (local-failure or `@cloud` tag)
  - [ ] Network down → agent stays local, no hang waiting on cloud
  - [ ] Local-only operation needs no cloud key (offline-first preserved)
- **Execution path:** single-pass
- **Cost note:** Build = config+shim; Operating = per-token cloud cost when escalated (two accounts); Opportunity = provider lock

## Phase 4: gbrain memory (arm64, local embeddings, MCP)
- **Depends on:** Phase 2 (Phase 1 for local embeddings)
- **Deliverables:** gbrain built `bun-linux-arm64`, PGLite engine, embeddings via local Ollama, registered as MCP server in hermes-agent.
- **Acceptance criteria (pass/fail):**
  - [ ] `gbrain` runs on box; `gbrain doctor` passes
  - [ ] Page written → retrievable via hybrid search; auto-link creates a graph edge
  - [ ] hermes-agent lists gbrain MCP tools and does a brain-first lookup before web/tool call
  - [ ] Embedding runs locally (no outbound net during embed); embed spike absorbed by zram
  - [ ] Combined memory measured, within budget
- **Execution path:** single-pass (escalate to dynamic-workflow only if arm64 build fans across many files)
- **Cost note:** Build = arm64 target+wiring; Operating = ~0.3–0.6 GB + embed spikes; Opportunity = local-embed recall < cloud

## Phase 5: WhatsApp gateway
- **Depends on:** Phase 2
- **Deliverables:** `whatsapp-bridge` (Node+chromium-arm64), QR-paired, allowlist set, `hermes-whatsapp` toolset enabled.
- **Acceptance criteria (pass/fail):**
  - [ ] QR pairing completes; bridge reports connected
  - [ ] Allowlisted number → agent → model reply back on WhatsApp (full round-trip)
  - [ ] Non-allowlisted sender rejected
  - [ ] Bridge survives a reconnect without manual re-pair
  - [ ] Combined memory with chromium live measured, within budget
- **Execution path:** single-pass
- **Cost note:** Build = chromium arm64 + pairing; Operating = ~0.4–0.7 GB; Opportunity = web-bridge ToS/stability risk

## Phase 6: Kiosk GUI (web dashboard via cog/WPE)
- **Depends on:** Phase 2 (serves the dashboard); Phase 0 (no DE)
- **Deliverables:** `hermes dashboard` on `:9119`; Xorg + matchbox-wm session; cog (WPE) launching `:9119` fullscreen, GPU compositing capped; systemd kiosk unit; chromium `--kiosk --disable-gpu-compositing` fallback pre-wired.
- **Acceptance criteria (pass/fail):**
  - [ ] `hermes dashboard` serves `:9119`; SPA + embedded ChatPage (`hermes --tui` over WebSocket) renders
  - [ ] Verify-then-commit: dashboard renders correctly under cog/WPE; else switch unit to chromium `--kiosk` fallback and record reason. Exactly one renderer committed.
  - [ ] Boot → kiosk auto-starts, **no DE / no login shell / no WM chrome** — only the dashboard fullscreen
  - [ ] GUI holds a streaming conversation with the local agent (tool progress + markdown)
  - [ ] GUI GPU compositing disabled/limited; tegrastats confirms inference owns the GPU
  - [ ] Kiosk crash/exit auto-restarts (systemd)
  - [ ] Full-stack memory (all surfaces live) measured, within §7 target
- **Execution path:** single-pass
- **Cost note:** Build = kiosk wiring + render verification; Operating = ~0.2–0.7 GB (cog vs chromium); Opportunity = dashboard UI ceiling vs bespoke Electron (off-box client remains)

## Phase 7: Appliance hardening
- **Depends on:** Phases 1–6
- **Deliverables:** systemd units for all services (ordered deps), boot-to-ready, reboot/network-loss resilience, memory-pressure handling, operator runbook.
- **Acceptance criteria (pass/fail):**
  - [ ] Cold boot → operational (local chat answerable at screen) with zero manual steps; time-to-ready recorded
  - [ ] `systemctl status` green for all units; correct ordering (Ollama before agent, etc.)
  - [ ] Power-pull mid-conversation → reboot → state recovers, gbrain intact, kiosk returns
  - [ ] Network unplugged → local chat + memory work; cloud features degrade without hangs
  - [ ] Sustained stress run: no OOM-kill; steady-state ≤ §7 target
  - [ ] One-page operator runbook exists (setup, re-pair WhatsApp, switch model, logs)
- **Execution path:** single-pass
- **Cost note:** Build = integration+docs; Operating = final power profile; Opportunity = none
