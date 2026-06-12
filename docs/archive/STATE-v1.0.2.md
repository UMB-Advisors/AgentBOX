# State — hermesBOX
Source PRD: PRD-v1.0.0.md
Roadmap: ROADMAP-v1.0.0.md
Last updated: 2026-05-30 (Phase 0 delivered; Phase 1 active)

## Active phase
Phase 1: Local inference (Ollama + Hermes-3-3B) — executing (UMB-380, In Development)

## Phase status
| Phase | Status | Linear issue | State | Notes |
|-------|--------|--------------|-------|-------|
| 0 | ✅ delivered | UMB-379 | Delivered | All 11 acceptance criteria pass; reboot-resilient |
| 1 | 🔨 executing | UMB-380 | In Development | Ollama + Hermes-3-3B Q4 |
| 2 | pending | UMB-381 | Backlog | hermes-agent core, :8642 |
| 3 | pending | UMB-382 | Backlog | Hybrid routing local→portal→openrouter |
| 4 | pending | UMB-383 | Backlog | gbrain memory (NOTE: brain already exists, preserve) |
| 5 | pending | UMB-384 | Backlog | WhatsApp bridge |
| 6 | pending | UMB-385 | Backlog | Kiosk GUI cog/WPE :9119 |
| 7 | pending | UMB-386 | Backlog | Appliance hardening |

## Box facts (probed 2026-05-30)
- Host: `mailbox@mailbox2.tail377a9a.ts.net` (Tailscale), key auth, **passwordless sudo**
- Board: Jetson Orin Nano 8GB "super" devkit; JetPack 6.2 / L4T R36.5.0; kernel 5.15-tegra
- CUDA 12.6 (`/usr/local/cuda`), driver 540.5.0, power mode **MAXN_SUPER**
- Root: `/dev/nvme0n1p1` ext4, 915G (839G free), Kingston SNV3S 1TB
- Memory: 7607 MB total; idle ~1130 MB used / ~6210 MB available
- Swap: zram 6×634 MB (pri 5) + `/swapfile` 4 GB (pri 1, persisted in fstab)
- Toolchain: uv 0.11.17 (Py3.11), Node v22.22.2, Bun 1.3.14 — all on PATH via `~/.hermesbox_env.sh`

## Linear
- Workspace: staqs · Team: UMB Advisors (UMB) `95391e55-905f-45d8-bec5-c142e52eddf1`
- Project: hermesBOX `c7ee1eef-e684-4bd4-86bc-6f0fedf5041e` — https://linear.app/staqs/project/hermesbox-4dbab8147794
- Workflow states: backlog=Backlog · started=In Development/Client Approval/Ready for Production · completed=**Delivered** · (no "Done")
- Sync: one-way kickoff done; status flows back at Verify/Ship.

## Decisions locked (PRD §6)
- DR-001 Ollama · DR-002 Hermes-3-Llama-3.2-3B Q4_K_M · DR-003 local Ollama embeddings
- DR-004 hybrid routing: local default + command/heuristic escalation
- DR-005 kiosk: Xorg+matchbox+cog(WPE)→:9119, chromium fallback, GPU compositing capped
- DR-006 cloud: Both (Portal primary, OpenRouter secondary)
- DR-007 GUI = web dashboard :9119, not Electron

## Provisioning artifacts
- `provisioning/00-base.sh` (idempotent) + `provisioning/verify-phase0.sh` → deployed to box `~/hermesbox/provisioning/`

## Drift watch
- **Existing gbrain brain on box**: `~/.gbrain/brain.pglite` populated (since May 26). Phase 4 must INTEGRATE/PRESERVE, not clobber. Investigate how gbrain CLI is currently installed (bun? binary?) before Phase 4.
- **Pre-existing failed unit**: `set-maxn-power.service` (failed) causes `systemctl is-system-running` = degraded. NOT ours; power mode is correctly MAXN_SUPER anyway. Clean up in Phase 7 hardening (out of Phase 0 scope).
- Reboot returns to SSH in ~3.5–4 min (Tailscale re-association adds time). Account for this in any future reboot polling (budget >= 4 min).
- Central risk remains: steady-state memory vs §7 budget as each surface is added.
