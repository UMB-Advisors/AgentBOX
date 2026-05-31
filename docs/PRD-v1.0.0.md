# PRD — hermesBOX v1.0.0

**Project:** hermesBOX (a ThUMBox-family edge appliance)
**Owner:** Dustin Powers
**Status:** Define stage (ship-it). Canonical source of truth.
**Date:** 2026-05-30
**Source skill:** ship-it (`.skill/`) → Define owned by `project-manager`

---

## TL;DR

hermesBOX is a self-contained **edge AI appliance**: a NousResearch **Hermes agent** running on an **NVIDIA Jetson Orin Nano 8 GB (JetPack 6)**, with **on-device inference by default** (quantized Hermes via Ollama+CUDA) and **cloud escalation** (Nous Portal / OpenRouter) for hard tasks. It carries **persistent memory** (gbrain), is reachable from your phone over **WhatsApp**, and presents a **kiosk Electron GUI** (hermes-desktop) as its only on-screen surface — no desktop environment. The whole stack shares **8 GB unified memory**, so memory budget is the governing constraint and the gate on every phase.

Build proceeds in **8 phases (0–7)**, each with measurable pass/fail criteria and a hard memory-budget gate. We do not advance a phase until its predecessor's criteria pass on real hardware.

---

## 1. Vision / Problem Statement

A private, always-on AI assistant that lives on a physical box you own, runs offline for routine work, reaches the cloud only when it chooses to, remembers across sessions, and is reachable both at the box (screen) and from anywhere (WhatsApp). No dependence on a single cloud provider; no data leaving the box unless escalation is invoked.

The hard problem is **resource fit**: Hermes-class agents, a local LLM, a knowledge graph, a chromium-based messaging bridge, and an Electron GUI are each individually heavy. Running them concurrently on a single 8 GB shared-memory SoC is the central engineering challenge this PRD is organized around.

---

## 2. Constitution / Constraints

No standalone constitution file exists for this project; this section is the binding constraint set. Every later artifact (ROADMAP, STATE, CONTEXT, code) must comply or trigger a change-impact summary.

1. **Memory budget is law.** Total resident usage of all hermesBOX services must leave the system stable (no OOM-kill, no thrash) on 8 GB unified memory with zram enabled. Each phase reports a measured memory delta; a phase fails if it pushes the steady-state past the budget in §7.
2. **Offline-first.** Routine operation (chat, memory read/write, local tools) must work with the network cable unplugged. Cloud is an explicit escalation, never a hard dependency for core function.
3. **No full desktop environment.** The box boots headless to a kiosk session running only hermes-desktop. No GNOME/KDE/GDM/tracker.
4. **Exact-pin discipline.** Mirror hermes-agent's policy: pin dependency versions; no version ranges on direct deps we add. Smaller install = smaller supply-chain blast radius.
5. **Proven over novel** (project-manager Rule 7). Ollama over hand-rolled llama.cpp servers; X11 (mature on Tegra) over Wayland unless X11 fails.
6. **ARM64 reality.** Every component must build/run on `aarch64` + CUDA 12.x. Where upstream ships no arm64 artifact (gbrain Bun target, hermes-desktop electron-builder target), we add one — we do not assume it exists.
7. **SSH-first build, kiosk-only runtime.** All build/admin happens over SSH; the screen shows only the app.
8. **Stack defaults** (from global CLAUDE.md): `uv` for Python, `pnpm` for Node tooling where applicable, `bun` for gbrain (upstream requirement), systemd for service management, markdown deliverables.

---

## 3. Target Hardware & Platform (fixed)

| Attribute | Value |
|---|---|
| Board | Jetson Orin Nano 8 GB |
| OS / stack | JetPack 6 (L4T r36.x, Ubuntu 22.04 base) |
| CPU/GPU | 6-core Arm Cortex-A78AE / Ampere 1024-core, CUDA 12.x |
| Memory | 8 GB LPDDR5, **unified CPU+GPU** |
| Storage | NVMe SSD strongly recommended (model weights + gbrain + node_modules); microSD insufficient for comfort |
| Display | Attached for kiosk GUI; box otherwise headless |
| Python | 3.10 ships with JetPack 6 → **3.11 must be installed** (hermes-agent requires `>=3.11`) |

---

## 4. Component Map (the three repos + glue)

| Component | Repo (zip) | Role | Stack | ARM64 status |
|---|---|---|---|---|
| **hermes-agent** | `hermes-agent-main` | Core agent: CLI, agent loop, tools, messaging gateway, HTTP/SSE API on `127.0.0.1:8642` | Python 3.11+, exact-pinned | Pure-Python core OK; needs Py3.11 + Node for bridges |
| **Local inference** | (Ollama) | OpenAI-compatible model server, GPU-accelerated | Ollama (arm64+CUDA) | Supported on Jetson |
| **gbrain** | `gbrain-master` | Persistent memory / knowledge graph over MCP (30+ tools) | Bun, PGLite (WASM Postgres) default | Bun runs on arm64; **must add `bun-linux-arm64` build target** |
| **WhatsApp bridge** | `hermes-agent-main/scripts/whatsapp-bridge` | Local web bridge (QR pair, allowlist) exposing HTTP API hermes-agent calls | Node + chromium (whatsapp-web.js style) | Needs `chromium`/puppeteer arm64 |
| **Web dashboard (GUI surface)** | `hermes-agent-main/web` | The on-screen UI: React SPA served by `hermes dashboard` on `:9119`; ChatPage embeds `hermes --tui` over PTY+WebSocket | React/Vite + FastAPI (`web` extra) | Pure web — renders in any browser/WebKit on arm64 |
| **Kiosk session** | (new glue) | systemd → Xorg → matchbox-wm → **cog (WPE)** rendering `:9119` fullscreen; chromium `--kiosk` fallback; GPU-compositing capped | Xorg + matchbox + cog/chromium (stock arm64) | Standard on L4T |
| **hermes-desktop** (optional, off-box) | `hermes-desktop-main` | Electron client run on a workstation against the box API; **not** on the kiosk screen | Electron 39, `better-sqlite3` | Off critical path (DR-007) |

**Integration topology:** Ollama (`:11434`) ⇄ hermes-agent (provider=local; API `:8642`, dashboard `:9119`) ⇄ gbrain (MCP stdio) ; hermes-agent ⇄ WhatsApp bridge (localhost HTTP) ; **kiosk (cog/WPE) → `:9119` web dashboard** (embedded TUI over WebSocket). Optional off-box hermes-desktop → `:8642`. Cloud escalation: hermes-agent → Nous Portal / OpenRouter when routed.

---

## 5. Scope

### In scope (v1.0.0)
- Headless JetPack 6 bring-up with Python 3.11, Node, Bun, CUDA verified; zram/swap configured.
- Local Hermes inference via Ollama with a quantized model that fits the budget.
- hermes-agent installed, configured to the local provider, conversational via CLI and reachable on `:8642`.
- Hybrid model routing: local default + cloud fallback provider configured and switchable.
- gbrain built for arm64, running on PGLite with **local** embeddings, wired to hermes-agent over MCP, brain-first lookup working.
- WhatsApp reachable: QR-paired, allowlisted, send+receive a message round-trip through the agent.
- Web dashboard (`:9119`) launching in a cog/WPE kiosk (chromium fallback) at boot, connected to the local agent, GPU-compositing capped.
- Appliance hardening: systemd units, boot-to-ready, survives reboot and network loss, memory budget enforced.

### Non-goals (v1.0.0)
- Multi-user / multi-tenant operation.
- Training, fine-tuning, or running Hermes-4 14B+ **locally** (cloud-only via escalation).
- Electron `hermes-desktop` on the box / its arm64 build (DR-007: demoted to optional off-box client).
- Wayland (Cage) kiosk (documented alternative, not the v1 path).
- Other messaging platforms beyond WhatsApp (Telegram/Discord/etc. remain available upstream but unverified here).
- gbrain Postgres/pgvector multi-machine topology (PGLite single-box only in v1).
- Automatic rule-based escalation **intelligence** beyond a documented trigger mechanism (see DR-004).
- OTA update system, fleet management, enclosure/industrial design.

---

## 6. Open Decisions (Decision Records)

These are recommendations with rationale; load-bearing ones are confirmed at the per-phase discuss step before that phase executes (ship-it scaffold). None involve budget/security/legal sign-off requiring blocking user approval, except DR-006.

### DR-001 — Local inference engine: **Ollama** (recommended)
- **Options:** Ollama | llama.cpp server | vLLM.
- **Recommendation:** Ollama. OpenAI-compatible endpoint out of the box, arm64+CUDA supported, model pull/quant management built in, and it can **also serve gbrain's embeddings** (one engine, two consumers). vLLM arm64 wheels on Jetson are painful; raw llama.cpp is more wiring for no v1 benefit.
- **Trade-off:** Slightly less control over sampler/quant internals than llama.cpp. Acceptable.
- **Affects:** Phase 1, Phase 4 (embeddings).

### DR-002 — Local model: **Hermes-3-Llama-3.2-3B, Q4_K_M** (recommended)
- **Options:** Hermes-3-Llama-3.2-3B (Q4) ≈ 2 GB | Hermes-2-Pro-Llama-3-8B (Q4) ≈ 4.7 GB.
- **Recommendation:** 3B Q4_K_M. With kiosk Electron + chromium WhatsApp bridge + agent + gbrain all resident, the 8B model breaks the budget (§7). 3B leaves headroom and still drives tool-use well for an edge agent. The 8B is the *cloud* tier's job, not local.
- **Trade-off:** Lower local reasoning quality; mitigated by cloud escalation (DR-004).
- **Affects:** Phase 1, §7 budget.

### DR-003 — gbrain embeddings: **local via Ollama** (recommended)
- **Options:** Local Ollama embed model (e.g. `nomic-embed-text`) | cloud ZeroEntropy (gbrain default) | cloud OpenAI embeddings.
- **Recommendation:** Local. Preserves offline-first (Constitution §2); gbrain supports `OLLAMA_BASE_URL` for embeddings. Adds ~0.3–0.5 GB when embedding.
- **Trade-off:** Cloud rerankers/embeddings score higher on retrieval benchmarks; revisit if recall is poor.
- **Affects:** Phase 4, §7.

### DR-004 — Hybrid routing mechanism: **local default + command/heuristic escalation** (recommended for v1)
- **Finding:** hermes-agent has provider switching (`/model`, `HERMES_INFERENCE_PROVIDER`, custom `providers` in config) and a `fallback_notice` path, but **no built-in rule engine** that auto-escalates local→cloud on task difficulty.
- **Recommendation v1:** Configure two providers — `local` (Ollama, default) and `cloud` (Nous Portal or OpenRouter). Escalation is (a) explicit via `/model`, and (b) a thin documented heuristic shim (e.g., escalate on local failure / context-length overflow / explicit `@cloud` tag). Full automatic difficulty routing is a v1.1 follow-on.
- **Trade-off:** Not "magic" auto-routing in v1. Honest scope.
- **Affects:** Phase 3. **Confirm at Phase 3 discuss step.**

### DR-005 — Kiosk stack: **Xorg + matchbox-wm + cog (WPE), chromium `--kiosk` fallback** ✅ (user-directed 2026-05-30)
- **Decision:** Xorg + `matchbox-window-manager` + **cog (WPE WebKit)** rendering the Hermes **web dashboard** fullscreen. **chromium `--kiosk` is the verified fallback** if the dashboard mis-renders under WebKit (verify-then-commit: commit to cog/WPE only after confirming the embedded xterm/WebSocket ChatPage renders correctly).
- **GPU contention guard (critical on unified memory):** the GUI compositor and Ollama's CUDA context share the same memory pool. Cap the GUI's GPU use — chromium `--disable-gpu-compositing` (and/or `--disable-gpu`), or WPE's limited-GPU mode — so a browser compositor never fights inference for unified VRAM.
- **Supersedes:** the original X11+Electron-`--kiosk` recommendation. Tied to DR-007.
- **Affects:** Phase 0 (no DE), Phase 6.

### DR-007 — GUI surface: **hermes-agent web dashboard (`:9119`), not Electron** ✅ (2026-05-30)
- **Finding:** hermes-agent ships a feature-complete web dashboard (React SPA → `hermes_cli/web_dist/`, served by FastAPI via `hermes dashboard`, port **9119**). Its ChatPage embeds `hermes --tui` as a PTY child over WebSocket; Sessions/Skills/Config/plugins included. `--host 0.0.0.0` is session-token-auth safe on LAN. cog/WPE and chromium render a URL — they cannot host an Electron app — so the kiosk renders this dashboard URL.
- **Decision:** The on-screen GUI is the **web dashboard in a WPE/chromium kiosk** (DR-005). The Electron `hermes-desktop` repo is **demoted to an optional off-box client** (run on the workstation against the box's API), removed from the v1 critical path.
- **Trade-off:** Lose the polished Electron UI on-box; gain no-arm64-Electron-build, lighter memory, and a stock-package kiosk. Net win for an 8 GB appliance.
- **Affects:** §4 component map, §5 scope, §7 budget, Phase 6. Eliminates the arm64 electron-builder + `better-sqlite3` rebuild risk.

### DR-006 — Cloud provider account: **Both (Portal primary + OpenRouter secondary)** ✅ RESOLVED
- **Decision (user, 2026-05-30):** Use **both**. Nous Portal is the primary cloud tier (single sub covers model + tools, native Hermes-4); OpenRouter is the secondary fallback (per-token, model-swappable).
- **Implication for Phase 3:** Configure three providers total — `local` (Ollama, default) → `cloud-portal` (primary escalation) → `cloud-openrouter` (secondary). Provision a Nous Portal OAuth login **and** an OpenRouter API key. Escalation order: local → portal → openrouter.
- **Affects:** Phase 3 config, operating cost (two cloud accounts), key provisioning.

---

## 7. Memory Budget (the governing model)

Steady-state estimate, kiosk runtime, all surfaces live. Unified 8 GB; target ≤ ~6.8 GB resident to leave OS/headroom + zram cushion.

| Consumer | Est. resident | Notes |
|---|---|---|
| L4T kernel + base services (no DE) | ~0.8–1.2 GB | Headless saves the ~1.5–2 GB a DE would cost |
| Ollama + Hermes-3-3B Q4 (loaded) | ~2.5–3.0 GB | Model ~2 GB + KV cache + runtime; on GPU (shared) |
| hermes-agent (Python) | ~0.5–0.8 GB | Core + active tools |
| gbrain (Bun + PGLite) | ~0.3–0.6 GB | Higher transiently during embed/sync |
| WhatsApp bridge (Node + chromium) | ~0.4–0.7 GB | Chromium is the variable cost |
| Kiosk GUI: cog/WPE → `:9119` (no GPU compositing) | ~0.2–0.4 GB | WPE is lighter than Electron; chromium fallback ~0.4–0.7 GB |
| **Total steady-state** | **~4.6–6.7 GB** | Tight but feasible **only** because there is no DE and no Electron; cog/WPE + capped GPU keeps the compositor off the inference VRAM pool |
| zram swap | configured | Absorbs transient spikes (embed/sync, chromium GC) |

**Implication:** The kiosk decision (DR-005, removing the DE) is what makes the full stack fit. Phases that add a surface (1, 4, 5, 6) must each re-measure and stay within budget, or the phase fails and we cut/quantize down.

---

## 8. Phased Breakdown

Each phase lists deliverables, **measurable** pass/fail criteria, execution path (single-pass vs dynamic-workflow per ship-it routing), and cost. Phases gate on measurement, never calendar.

### Phase 0 — Base platform bring-up (headless)
- **Deliverables:** Flashed JetPack 6 (no DE), NVMe as root or model/data store, Python 3.11 (via `uv`/deadsnakes), Node LTS, Bun, CUDA toolkit verified, zram + swap configured, SSH access.
- **Acceptance:**
  - [ ] `python3.11 --version` ≥ 3.11 and `uv` present.
  - [ ] `node -v` (LTS) and `bun -v` succeed.
  - [ ] `nvidia-smi`/`tegrastats` shows GPU; a CUDA sample or `nvcc --version` confirms 12.x.
  - [ ] No display manager/DE installed (`systemctl get-default` = `multi-user.target`); `free -m` baseline ≤ ~1.2 GB used at idle.
  - [ ] zram active (`zramctl` non-empty); reboot returns to SSH unattended.
- **Execution path:** single-pass.
- **Cost:** Build: setup time + NVMe (~$30–60). Operating: idle power ~5–10 W. Opportunity: none.

### Phase 1 — Local inference (Ollama + Hermes-3-3B)
- **Deliverables:** Ollama installed (arm64+CUDA), Hermes-3-Llama-3.2-3B Q4_K_M pulled/quantized, OpenAI-compatible endpoint on `:11434`.
- **Acceptance:**
  - [ ] `curl :11434/v1/chat/completions` returns a valid completion from the Hermes model.
  - [ ] Inference uses GPU (tegrastats shows GPU load, not pure CPU).
  - [ ] Tokens/sec measured and recorded; first-token latency < ~3 s on a short prompt.
  - [ ] Model-loaded memory delta measured and within §7 line item.
- **Execution path:** single-pass.
- **Cost:** Build: model download (~2 GB). Operating: GPU power under load. Opportunity: 3B quality ceiling (mitigated by Phase 3).

### Phase 2 — hermes-agent core
- **Deliverables:** hermes-agent installed (Py3.11, `setup-hermes.sh`/`scripts/install.sh`), config pointed at local Ollama provider, CLI working, HTTP API on `:8642`.
- **Acceptance:**
  - [ ] `hermes` CLI completes a multi-turn conversation using the **local** model.
  - [ ] At least one built-in tool call executes end-to-end (e.g., shell/file tool).
  - [ ] `:8642` serves an SSE chat response to a raw HTTP request.
  - [ ] Runs with network unplugged (offline-first proof for core chat).
  - [ ] Combined memory (Phase 0+1+2) measured, within budget.
- **Execution path:** single-pass.
- **Cost:** Build: install + config. Operating: ~0.5–0.8 GB resident. Opportunity: none.

### Phase 3 — Hybrid routing (cloud fallback)
- **Deliverables:** Three providers configured per DR-006 — `local` (Ollama, default) → `cloud-portal` (Nous Portal, primary escalation) → `cloud-openrouter` (OpenRouter, secondary fallback); documented escalation mechanism (command + heuristic shim) with order local→portal→openrouter.
- **Acceptance:**
  - [ ] `/model` (or equivalent) switches a live session from local → cloud and back; both return valid completions.
  - [ ] Escalation trigger documented and demonstrated (e.g., local-failure or `@cloud` tag routes to cloud).
  - [ ] With network down, agent stays on local and does not hang waiting on cloud.
  - [ ] No cloud key is required for local-only operation (offline-first preserved).
- **Execution path:** single-pass.
- **Cost:** Build: config + shim. Operating: **per-token cloud cost when escalated** (quantify after DR-006). Opportunity: vendor lock to chosen provider.

### Phase 4 — gbrain memory (arm64, local embeddings, MCP)
- **Deliverables:** gbrain built for `bun-linux-arm64`, PGLite engine, embeddings via local Ollama, registered as an MCP server in hermes-agent.
- **Acceptance:**
  - [ ] `gbrain` CLI runs on the box (built arm64 binary or `bun run`); `gbrain doctor` passes.
  - [ ] A page written to the brain is retrievable via hybrid search; auto-link creates a graph edge.
  - [ ] hermes-agent lists gbrain MCP tools and performs a **brain-first lookup** before a web/tool call.
  - [ ] Embedding runs locally (no outbound network during embed); embed memory spike stays within zram cushion.
  - [ ] Combined memory measured, within budget.
- **Execution path:** single-pass (escalate to dynamic-workflow only if the arm64 build fights us across many files).
- **Cost:** Build: arm64 build target + wiring. Operating: ~0.3–0.6 GB + transient embed spikes. Opportunity: local-embed recall < cloud (DR-003).

### Phase 5 — WhatsApp gateway
- **Deliverables:** `whatsapp-bridge` running (Node + chromium-arm64), QR-paired to a number, allowlist configured (`WHATSAPP_ALLOWED_USERS`), `WHATSAPP_ENABLED/MODE` set, hermes-agent `hermes-whatsapp` toolset enabled.
- **Acceptance:**
  - [ ] QR pairing completes; bridge reports connected.
  - [ ] A WhatsApp message from an allowlisted number reaches the agent and gets a model-generated reply back on WhatsApp (full round-trip).
  - [ ] A non-allowlisted sender is rejected (allowlist enforced).
  - [ ] Bridge survives a reconnect (network blip) without manual re-pair.
  - [ ] Combined memory with chromium live measured, within budget.
- **Execution path:** single-pass.
- **Cost:** Build: chromium arm64 + pairing. Operating: ~0.4–0.7 GB (chromium). Opportunity: WhatsApp web-bridge ToS/stability risk (document).

### Phase 6 — Kiosk GUI (web dashboard via cog/WPE)
- **Deliverables:** `hermes dashboard` (`web` extra) serving `:9119`; Xorg + `matchbox-window-manager` minimal session; **cog (WPE)** launching `http://127.0.0.1:9119` fullscreen with GPU compositing capped (WPE limited-GPU); systemd kiosk unit; chromium `--kiosk --disable-gpu-compositing` fallback wired but inactive unless WPE verification fails.
- **Acceptance:**
  - [ ] `hermes dashboard` serves `:9119`; the SPA loads and the embedded ChatPage (`hermes --tui` over WebSocket) renders.
  - [ ] **Verify-then-commit:** confirm the dashboard (esp. xterm/WebSocket chat) renders correctly under cog/WPE. If it mis-renders, switch the kiosk unit to the chromium `--kiosk` fallback and record the reason. Exactly one renderer is committed.
  - [ ] Boot brings up the kiosk automatically with **no DE, no login shell, no WM chrome** — only the dashboard fullscreen.
  - [ ] GUI holds a streaming conversation with the **local** agent (tool progress + markdown).
  - [ ] GPU compositing is disabled/limited for the GUI (verified: no GUI CUDA/GL compositor contending with Ollama; tegrastats shows inference owns the GPU).
  - [ ] Kiosk process crash/exit auto-restarts (systemd restart).
  - [ ] Full-stack memory (all surfaces live) measured, within §7 target.
- **Execution path:** single-pass.
- **Cost:** Build: kiosk session wiring + render verification. Operating: ~0.2–0.7 GB (cog vs chromium fallback). Opportunity: dashboard UI ceiling vs a bespoke Electron app (acceptable; off-box Electron client remains available).

### Phase 7 — Appliance hardening
- **Deliverables:** systemd units for every service (Ollama, agent, gbrain, bridge, kiosk) with ordering/dependencies; boot-to-ready; resilience to reboot + network loss; memory-pressure handling; first-run/setup doc.
- **Acceptance:**
  - [ ] Cold boot → fully operational (local chat answerable at the screen) with **zero manual steps**, time-to-ready recorded.
  - [ ] `systemctl status` green for all units; correct start ordering (Ollama before agent, etc.).
  - [ ] Pull power mid-conversation → reboot → state recovers, gbrain intact, kiosk returns.
  - [ ] Unplug network → local chat + memory still work; cloud features degrade gracefully (no hangs).
  - [ ] Sustained load test: no OOM-kill over a defined stress run; steady-state ≤ §7 target.
  - [ ] One-page operator runbook exists (first-time setup, re-pair WhatsApp, switch model, logs).
- **Execution path:** single-pass.
- **Cost:** Build: integration + docs. Operating: final power profile. Opportunity: none.

---

## 9. Cross-cutting Risks

| Risk | Severity | Mitigation |
|---|---|---|
| 8 GB OOM under concurrent load | **High** | No DE (DR-005), 3B model (DR-002), zram, per-phase budget gate, ability to suspend non-active surfaces |
| arm64 build gaps (gbrain Bun target, chromium) | Medium | Phase 4 adds the Bun target; chromium/cog are stock arm64. **Electron arm64 risk eliminated by DR-007** (web dashboard kiosk instead) |
| GUI compositor stealing unified VRAM from inference | High | DR-005: cog/WPE + capped GPU compositing; Phase 6 verifies inference owns the GPU |
| Dashboard mis-renders under WPE WebKit | Low–Med | Phase 6 verify-then-commit; chromium `--kiosk` fallback pre-wired |
| Python 3.11 on JetPack 6 (ships 3.10) | Medium | Phase 0 installs 3.11 via uv/deadsnakes before any agent work |
| WhatsApp web-bridge fragility / ToS | Medium | Allowlist, reconnect handling; document risk; messaging is one surface not the only one |
| Tegra X11/EGL quirks for Electron | Medium | X11-first (DR-005); Cage documented fallback |
| Local 3B quality too low | Medium | Cloud escalation (Phase 3); revisit model choice with data |
| NVMe absent (microSD only) | Medium | Phase 0 requires/recommends NVMe; weights + node_modules need the space/speed |

---

## 10. Readiness Checklist (Define gate)

- [x] Vision / problem statement present.
- [x] Scope and explicit non-goals defined.
- [x] Every phase has measurable, non-calendar acceptance criteria.
- [x] Cost implications (build/operating/opportunity) per phase.
- [x] Decision records for open choices; load-bearing ones flagged for per-phase discuss confirmation.
- [x] **DR-006 (cloud provider/credentials) — RESOLVED:** Both (Portal primary + OpenRouter secondary).

**Gate status:** ✅ Cleared to Scaffold. No open `NEEDS_CLARIFICATION` markers remain.

---

## 11. Change Control

Per ship-it Operating Rule 1: this PRD is canonical. If execution reveals it is wrong, **stop**, bump the PRD version, produce a change-impact summary, and re-scaffold — never let ROADMAP/STATE/CONTEXT drift from this file. PATCH = wording fix; MINOR = scope/roadmap change; MAJOR = new milestone.

### Revision log
- **2026-05-30 (in-place, pre-execution draft):** DR-006 resolved (cloud tier = both Portal + OpenRouter). **GUI architecture changed** (user-directed): kiosk stack = Xorg + matchbox + cog (WPE) rendering the hermes-agent **web dashboard** (`:9119`), chromium `--kiosk` verified fallback, GPU compositing capped (DR-005); Electron `hermes-desktop` demoted to optional off-box client (DR-007). Net effect: arm64 Electron build removed from critical path, memory budget reduced (§7), Phase 6 rewritten. Edited in place because v1.0.0 is not yet baselined (no execution, no Linear push). Next change after baseline bumps to v1.1.0.
