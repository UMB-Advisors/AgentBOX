---
phase: 01-infrastructure-foundation
plan: 03
subsystem: infra
tags: [bash, smoke-test, nvidia, ollama, qdrant, postgres, gpu]

# Dependency graph
requires:
  - phase: 01-infrastructure-foundation/01-01
    provides: docker-compose.yml with all 5 services defined and port mappings
  - phase: 01-infrastructure-foundation/01-02
    provides: first-boot script that brings the stack up correctly before smoke test runs

provides:
  - scripts/smoke-test.sh — appliance acceptance gate covering all Phase 1 success criteria
  - Structured PASS/FAIL/SKIPPED output with hostname and UTC timestamp for fleet tracking
  - Optional --boot-test flag for destructive boot-time verification (Check 6)

affects:
  - Production fleet onboarding — run on each of 5 units after first-boot to confirm readiness
  - Phase 2 — must pass all 5 default checks before email pipeline work begins

# Tech tracking
tech-stack:
  added:
    - bash (smoke-test script, associative arrays, EXIT trap pattern)
  patterns:
    - run_check wrapper function with per-check timing and PASS/FAIL accumulation
    - EXIT trap for guaranteed summary output even on set -euo pipefail failures
    - Opt-in destructive checks behind explicit --boot-test flag with warning banner + sleep 5
    - .env sourcing with set -o allexport / set +o allexport pattern

key-files:
  created:
    - scripts/smoke-test.sh

key-decisions:
  - "Boot time check (Check 6) requires --boot-test flag — prints warning and sleeps 5s before tearing down stack"
  - "Script sources .env from repo root for POSTGRES_USER/POSTGRES_DB variables"
  - "Postgres persistence uses a dedicated mailbox_smoke schema to avoid polluting mailbox schema"
  - "Qdrant jemalloc check scans logs for 'jemalloc|alloc.*error|SIGKILL|OOM' patterns"
  - "Qwen3 inference uses /no_think directive to minimize latency in classification path"

patterns-established:
  - "Smoke test pattern: run_check wrapper with EXIT trap summary; reusable for fleet testing"
  - "Destructive tests pattern: --flag opt-in with warning banner and countdown sleep"

requirements-completed:
  - INFRA-12

# Metrics
duration: 5min
completed: 2026-04-03
---

# Phase 1 Plan 03: Smoke Test Script Summary

**Bash smoke test covering all 5 Phase 1 success criteria (GPU passthrough, Qwen3 inference < 5s, nomic embeddings, Qdrant jemalloc health, Postgres persistence) plus opt-in boot-time check behind --boot-test flag with structured fleet-ready output.**

## Performance

- **Duration:** 5 min
- **Started:** 2026-04-03T19:54:38Z
- **Completed:** 2026-04-03T20:00:34Z
- **Tasks:** 1 of 1
- **Files modified:** 1

## Accomplishments

- Created `scripts/smoke-test.sh` (580 lines) as the acceptance gate for each appliance unit in the 5-unit production run
- Implemented all 6 checks: GPU passthrough via nvidia-smi, Qwen3-4B inference timing with 5s threshold, nomic-embed-text embedding verification, Qdrant health + jemalloc log scan, Postgres data persistence across container restart, and boot time < 180s
- Boot time check (Check 6) is explicitly opt-in via `--boot-test` flag with a 5-second abort window — prevents accidental stack teardown

## Task Commits

1. **Task 1: Create smoke test script with all 6 verification checks** - `bed1558` (feat)

**Plan metadata:** (pending final docs commit)

## Files Created/Modified

- `scripts/smoke-test.sh` — Full appliance smoke test: 6 checks, structured summary, --boot-test flag, EXIT trap, .env sourcing

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None — script is fully functional. All 6 checks are wired to live APIs and container operations. No placeholder text or hardcoded values.

## Self-Check: PASSED

- `scripts/smoke-test.sh` exists and is 580 lines (>= 150 required)
- `bash -n scripts/smoke-test.sh` passes (syntax valid)
- Commit `bed1558` verified in git log
- All 8 plan verification checks pass (nvidia-smi ×6, qwen3:4b ×3, nomic-embed-text ×7, 6333 ×4, docker compose restart ×1, boot-test ×8, 180 ×4, 11434 ×12)
