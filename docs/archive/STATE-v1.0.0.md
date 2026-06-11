# State — hermesBOX
Source PRD: PRD-v1.0.0.md
Roadmap: ROADMAP-v1.0.0.md
Last updated: 2026-05-30

## Active phase
Phase 0: Base platform bring-up — discussing (CONTEXT pending)

## Phase status
| Phase | Status | Linear milestone | Notes |
|-------|--------|------------------|-------|
| 0 | discussing | — | Active. Headless JetPack 6, no DE. CONTEXT next. |
| 1 | pending | — | Ollama + Hermes-3-3B |
| 2 | pending | — | hermes-agent core, :8642 |
| 3 | pending | — | Hybrid routing (local→portal→openrouter) |
| 4 | pending | — | gbrain memory, arm64, local embeddings |
| 5 | pending | — | WhatsApp bridge |
| 6 | pending | — | Kiosk GUI: web dashboard :9119 via cog/WPE (chromium fallback) |
| 7 | pending | — | Appliance hardening |

## Linear
- Project: — (not yet pushed; Track stage)
- Team: — (confirm target team on first push)

## Decisions locked (PRD §6)
- DR-001 Inference engine: Ollama
- DR-002 Local model: Hermes-3-Llama-3.2-3B Q4_K_M
- DR-003 gbrain embeddings: local via Ollama
- DR-004 Hybrid routing v1: local default + command/heuristic escalation
- DR-005 Kiosk: Xorg + matchbox + cog (WPE) → dashboard :9119, chromium --kiosk fallback, GPU compositing capped (Cage = documented alt)
- DR-006 Cloud tier: Both — Portal primary, OpenRouter secondary
- DR-007 GUI surface: hermes-agent web dashboard (:9119), NOT Electron; hermes-desktop demoted to optional off-box client

## Open decisions
- (none blocking) DR-004 escalation heuristic specifics to be finalized at Phase 3 discuss step.

## Drift watch
- Nothing observed yet. Central risk to monitor: steady-state memory vs §7 budget as each surface is added (Phases 1, 4, 5, 6).
- Hardware prerequisite: confirm a physical Orin Nano 8 GB + NVMe is on hand before Phase 0 execute (this is a hardware bring-up, not pure software).
