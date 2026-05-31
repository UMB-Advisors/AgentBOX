# State — hermesBOX
Source PRD: PRD-v1.0.0.md
Roadmap: ROADMAP-v1.0.0.md
Last updated: 2026-05-30 (STATE PATCH bump: Linear kickoff push)

## Active phase
Phase 0: Base platform bring-up — ready to execute (CONTEXT written; awaiting SSH target + boot state)

## Phase status
| Phase | Status | Linear issue | Milestone | Notes |
|-------|--------|--------------|-----------|-------|
| 0 | ready | UMB-379 | Phase 0 — Base platform bring-up | Active. Headless JetPack 6, NVMe root, uv Py3.11, no DE |
| 1 | pending | UMB-380 | Phase 1 — Local inference | Ollama + Hermes-3-3B; blockedBy UMB-379 |
| 2 | pending | UMB-381 | Phase 2 — hermes-agent core | :8642; blockedBy UMB-380 |
| 3 | pending | UMB-382 | Phase 3 — Hybrid routing | local→portal→openrouter; blockedBy UMB-381 |
| 4 | pending | UMB-383 | Phase 4 — gbrain memory | arm64, local embeddings; blockedBy UMB-381, UMB-380 |
| 5 | pending | UMB-384 | Phase 5 — WhatsApp gateway | blockedBy UMB-381 |
| 6 | pending | UMB-385 | Phase 6 — Kiosk GUI (cog/WPE :9119) | blockedBy UMB-381, UMB-379 |
| 7 | pending | UMB-386 | Phase 7 — Appliance hardening | blockedBy UMB-380..385 |

## Linear
- Workspace: staqs
- Team: UMB Advisors (key UMB) — `95391e55-905f-45d8-bec5-c142e52eddf1`
- Project: hermesBOX — `c7ee1eef-e684-4bd4-86bc-6f0fedf5041e` — https://linear.app/staqs/project/hermesbox-4dbab8147794
- Milestones: P0 `a09f2c97…` · P1 `52719dd3…` · P2 `ba7b7eb5…` · P3 `8f59ed99…` · P4 `08b8689e…` · P5 `d897e7a9…` · P6 `0ba512bf…` · P7 `785989d2…`
- Sync: one-way kickoff complete. Status flows back only at Verify/Ship.

## Decisions locked (PRD §6)
- DR-001 Inference engine: Ollama
- DR-002 Local model: Hermes-3-Llama-3.2-3B Q4_K_M
- DR-003 gbrain embeddings: local via Ollama
- DR-004 Hybrid routing v1: local default + command/heuristic escalation
- DR-005 Kiosk: Xorg + matchbox + cog (WPE) → dashboard :9119, chromium --kiosk fallback, GPU compositing capped
- DR-006 Cloud tier: Both — Portal primary, OpenRouter secondary
- DR-007 GUI surface: hermes-agent web dashboard (:9119), NOT Electron; hermes-desktop = optional off-box client

## Open decisions
- (none blocking) DR-004 escalation heuristic specifics finalized at Phase 3 discuss step.

## Blocking to start Phase 0 execute
1. SSH target `user@host` + auth method (key installed? password? jump host?)
2. Boot state: NVMe-root already, or SD-flashed needing root migration?
3. Confirm `cat /etc/nv_tegra_release` = L4T r36.x (JetPack 6)

## Drift watch
- Central risk: steady-state memory vs PRD §7 budget as each surface is added (Phases 1, 4, 5, 6). Re-measure per phase.
- This is hardware bring-up over SSH — verification is on-device, not on the workstation.
