---
phase: 01-infrastructure-foundation
plan: 02
subsystem: infra
tags: [jetson, first-boot, jetpack, docker, gpu, luks, ollama, systemd]

# Dependency graph
requires: []
provides:
  - scripts/first-boot.sh — 7-stage checkpoint script for Jetson hardware bring-up
affects: [01-03, all subsequent phases]

# Tech tracking
tech-stack:
  added:
    - JetsonHacks install-docker (NVIDIA-compatible Docker install)
    - nvidia-container-toolkit (GPU passthrough)
    - nvpmodel MAXN mode (systemd persistence)
    - gen_luks.sh (Jetson-native LUKS encryption via OP-TEE)
    - qwen3:4b Q4_K_M (pre-pulled into Ollama named volume)
    - nomic-embed-text:v1.5 (pre-pulled into Ollama named volume)
  patterns:
    - run_stage() wrapper with single-retry and diagnostics on failure
    - pause_for_verification() between stages for operator review
    - Systemd oneshot service for persistent power mode across reboots

key-files:
  created:
    - scripts/first-boot.sh

decisions: []
deviations: []
---

## What was built

Multi-stage first-boot checkpoint script (839 lines) that takes a fresh Jetson Orin Nano Super from post-flash state to fully operational appliance. Seven stages execute in order with manual verification pauses between each:

1. **JetPack Validation** — reads /etc/nv_tegra_release, verifies R36 (JetPack 6.2+), warns on older revisions, provides SDK Manager remediation guidance
2. **Docker Install** — clones JetsonHacks install-docker repo, runs install_nvidia_docker.sh and configure_nvidia_docker.sh (never apt-get docker-ce)
3. **GPU Passthrough** — runs nvidia-smi in NVIDIA runtime container, verifies GPU detection
4. **MAXN Power Mode** — queries available modes, sets MAXN, creates systemd oneshot service for boot persistence
5. **LUKS Encryption** — installs cryptsetup/tpm2-tools, uses Jetson-native gen_luks.sh for NVMe data partition encryption
6. **Model Pre-pull** — pulls qwen3:4b and nomic-embed-text:v1.5 into Ollama named volume using Jetson container image
7. **Compose Stack Start** — copies .env from template if missing, runs docker compose up, waits for all services healthy (180s timeout)

Each stage retries once on failure with diagnostic output. Script requires root, handles Ctrl+C gracefully, and prints a final summary table.

## Self-Check: PASSED

- [x] scripts/first-boot.sh exists (839 lines, >= 200 minimum)
- [x] bash -n syntax check passes
- [x] Contains run_stage function with retry logic
- [x] Stage 1: nv_tegra_release read + SDK Manager remediation guidance
- [x] Stage 2: JetsonHacks clone, no direct docker-ce install
- [x] Stage 3: docker run --rm --runtime nvidia with nvidia-smi
- [x] Stage 4: nvpmodel query + systemd service creation
- [x] Stage 5: gen_luks.sh + cryptsetup verification
- [x] Stage 6: ollama pull for both models with named volume
- [x] Stage 7: docker compose up with health wait
- [x] Pause between stages for operator verification
- [x] Root check at script start

## Requirements covered

- INFRA-01: JetPack 6.2 validation
- INFRA-02: Docker install via JetsonHacks + GPU passthrough
- INFRA-03: MAXN power mode with systemd persistence
- INFRA-06: Qwen3-4B pre-pulled
- INFRA-07: nomic-embed-text pre-pulled
- INFRA-11: LUKS encryption via gen_luks.sh
