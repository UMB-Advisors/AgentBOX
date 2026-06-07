---
status: partial
phase: 01-infrastructure-foundation
source: [01-VERIFICATION.md]
started: 2026-04-03T20:35:00Z
updated: 2026-04-03T20:35:00Z
---

## Current Test

[awaiting human testing]

## Tests

### 1. Run first-boot.sh on freshly-flashed Jetson Orin Nano Super
expected: All 7 stages pass — JetPack validated (R36 revision 4.0+), Docker installed via JetsonHacks, GPU passthrough confirmed via nvidia-smi, MAXN mode set with systemd service enabled, LUKS applied to NVMe data partition, qwen3:4b and nomic-embed-text:v1.5 pre-pulled, docker compose up brings all 5 services healthy within 180s
result: [pending]

### 2. Run smoke-test.sh (Checks 1-5) on live appliance after first-boot
expected: All 5 default checks pass — GPU passthrough (NVIDIA detected), Qwen3-4B inference < 5s with num_gpu > 0, nomic-embed-text returns embeddings, Qdrant /healthz ok with no jemalloc errors, Postgres row survives container restart
result: [pending]

### 3. Run smoke-test.sh --boot-test on live appliance
expected: Check 6 passes — full stack comes back to all-healthy within 180s from docker compose down
result: [pending]

## Summary

total: 3
passed: 0
issues: 0
pending: 3
skipped: 0
blocked: 0

## Gaps
