# Provisioning port: JetPack 6.2 → 7.2 (L4T r39.2 / Ubuntu 24.04 / CUDA 13)

Status: **partial — safe pins done, display/inference need on-box validation.** Do not merge until verified on a flashed 7.2 box.

## Done in this branch (high-confidence)

| File | Change |
|---|---|
| `00-base.sh` | Header → 7.2/r39.2/24.04/CUDA 13. Python pin note (24.04 default is 3.12; we keep uv-managed 3.11). Node 22 nodesource note (supports noble). CUDA env comment. **Logic unchanged — uv/bun/node/swapfile are OS-portable.** |
| `10-inference.sh` | Comment → arm64 CUDA 13 build. Ollama official installer auto-detects CUDA 13; logic unchanged. |
| `verify-phase0.sh` | `nvcc` check `release 12` → `release 13` (was a hard fail on 7.2). |
| `41-gbrain-fresh.sh` | Smoke-test string 6.2 → 7.2. |

`verify-phase0.sh` already asserts `multi-user.target` + no display manager + root-on-nvme — matches the headless build, no change needed.

## Needs on-box validation (do NOT assume)

1. **CUDA 13 toolchain present** — confirm `/usr/local/cuda` → 13 and `nvcc` exists after flash + `apt install nvidia-jetpack` (or whatever ships nvcc on r39.2). If JetPack 7.2 doesn't install the full CUDA toolkit by default, add a step.
2. **Ollama on CUDA 13 / r39.2** — verify the installer's arm64 build actually engages the GPU (`verify-phase1.sh` tegrastats GR3D). 7.2 aligns with arm64-SBSA, so the standard build *should* work, but confirm — this is the biggest inference unknown.
3. **MAXN_SUPER** — `nvpmodel -m 2` must work (forum 372151: lost if firmware stale; our flash includes the QSPI update). `70-set-maxn-power.conf` path `/usr/sbin/nvpmodel` — confirm unchanged on 7.2.
4. **Kiosk display stack (`60-kiosk*.sh`)** — **NOT ported.** Pins are jammy/arm64 (`COG_VERSION=0.12.1-1`, WPE/FDO backend, chromium snap, Xorg Tegra `60-xorg-dfp1-forced.conf`). Ubuntu 24.04 (noble) + r39.2 display stack differ; cog/WPE package versions and the Tegra X driver path must be re-derived on the box. Treat as a fresh sub-task.
5. **Python 3.11 vs 3.12** — if any component ships only 3.12 wheels for CUDA 13, bump `PY_VERSION` to 3.12.

## Suggested validation order on the booted box
`00-base.sh` → `verify-phase0.sh` → `10-inference.sh` → `verify-phase1.sh` → (agent phases 20-41) → kiosk (60-*) last, iterating on noble package names.
