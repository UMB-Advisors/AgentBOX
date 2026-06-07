# Phase 1: Infrastructure Foundation - Context

**Gathered:** 2026-04-02
**Updated:** 2026-04-07
**Status:** Ready for execution (hardware ready)

<domain>
## Phase Boundary

Verified Docker Compose stack with GPU inference on Jetson Orin Nano Super. All five services (Ollama, Qdrant, n8n, Postgres, Dashboard placeholder) healthy, appliance boots to fully operational in under 3 minutes, NVMe encrypted with LUKS. Deliverables: first-boot checkpoint script, docker-compose.yml, .env.example, smoke test script.

</domain>

<decisions>
## Implementation Decisions

### First-boot Automation
- **D-01:** Checkpoint script with discrete stages and manual verification between each stage. Not a single unattended script — stages allow catching hardware-specific issues during initial bring-up.
- **D-02:** Failed checkpoints auto-retry once (e.g., re-pull image, re-configure runtime), then halt with clear diagnostics and suggested fix if retry fails.
- **D-03:** Script validates JetPack version at startup — checks `/etc/nv_tegra_release` for r36.4+ and aborts with guidance if wrong version detected. Catches the r36.5 concern early.

### Docker Compose Structure
- **D-04:** Strict `depends_on` with service healthchecks. Boot order: Postgres first (pg_isready), then Qdrant + Ollama in parallel, then n8n (depends on Postgres healthy), then Dashboard. All services use `restart: unless-stopped`.
- **D-05:** Environment variables and secrets managed via single `.env` file at project root, referenced by docker-compose.yml. File is gitignored. Contains: Anthropic API key, Postgres password, n8n encryption key.
- **D-06:** Named Docker volumes for all persistent data (Postgres, Qdrant, Ollama models). No bind mounts.
- **D-07:** Images pinned to version tags (e.g., `qdrant/qdrant:v1.17.1`, `postgres:17-alpine`). Digest pinning deferred to Phase 3 when OTA update mechanism is built.
- **D-08:** Ollama must NOT have `mem_limit` in compose — breaks GPU detection on Jetson unified memory (carried from STATE.md).

### LUKS Encryption
- **D-09:** NVMe encrypted with LUKS, key bound to Jetson's TPM2 chip via `systemd-cryptenroll`. Appliance boots without passphrase entry. Data unreadable if NVMe is removed from device.
- **D-10:** LUKS encryption applied during first-boot checkpoint script, after JetPack flash but before Docker/service setup. Data partition encrypted from the start.

### Dev Workflow
- **D-11:** Primary development via SSH + local editor directly on Jetson. Git used to sync config repo. No VS Code Remote or cross-compile setup needed for Phase 1.
- **D-12:** Full smoke test script that programmatically verifies all 5 success criteria: GPU passthrough (`nvidia-smi`), Qwen3-4B inference (< 5s), nomic-embed-text embeddings, Qdrant health (no jemalloc errors), Postgres persistence across restart, boot time < 3 min. Reusable across the 5-unit production run.
- **D-13:** All infrastructure files at repo root: `docker-compose.yml`, `.env.example`, `scripts/` directory. Flat structure.

### Dashboard Architecture
- **D-14:** Phase 1 dashboard service remains a placeholder container. The unified plugin-shell architecture (Board Workstation deployment context from optimus-bu repo) is a Phase 4 concern. Phase 1 just needs a healthy container in the compose stack.

### Claude's Discretion
- Error handling specifics per checkpoint stage (which steps merit retry vs immediate halt)
- Healthcheck intervals and timeout values per service
- Exact Docker network configuration (bridge vs custom)
- Ollama model pull strategy (sequential vs parallel)
- Smoke test output format and reporting

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Product Requirements
- `prd-email-agent-appliance.md` — Comprehensive PRD with functional requirements FR-1 through FR-36, hardware spec, software architecture. Phase 1 maps to INFRA requirements.

### Stack Decisions & Compatibility
- `CLAUDE.md` §Technology Stack — Version pins, memory budget, compatibility matrix, installation patterns, and "What NOT to Use" constraints. Critical for correct image selection and configuration.
- `CLAUDE.md` §Memory Budget — 8GB unified VRAM allocation table. Governs service resource limits.
- `CLAUDE.md` §Stack Patterns by Variant — Jetson-specific patterns: `jetson-containers autotag`, Qdrant jemalloc workaround, Qwen3 think/no-think mode.

### Project State
- `.planning/STATE.md` §Accumulated Context > Decisions — Locked decisions: JetsonHacks Docker install, no mem_limit on Ollama, Gmail OAuth testing mode, n8n IMAP watchdog required.
- `.planning/STATE.md` §Blockers/Concerns — JetPack r36.5 availability, n8n IMAP trigger death bug status.

### Requirements
- `.planning/REQUIREMENTS.md` §Infrastructure — INFRA-01 through INFRA-12 (excluding INFRA-10 which is Phase 3). Specific acceptance criteria for each infrastructure requirement.

### Dashboard Architecture (Phase 4 input)
- `dashboard/prd-board-workstation-plugin-rebuild-v1.0.0-2026-04-05.md` — Board Workstation plugin-host workspace architecture PRD. Defines the unified codebase that the thUMBox appliance dashboard will deploy from in Phase 4.
- `dashboard/addendum-optimus-brain-plugin-dashboard-v0.2-2026-04-06.md` — Addendum clarifying that the thUMBox dashboard is a deployment context of the Board Workstation (Next.js plugin shell), not a separate React+Vite codebase. Key input for Phase 4 dashboard decisions.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `docker-compose.yml` — Complete 5-service stack (Ollama, Qdrant, n8n, Postgres, Dashboard). Implemented in Plan 01-01.
- `scripts/first-boot.sh` — Checkpoint-based first-boot script. Implemented in Plan 01-02.
- `scripts/smoke-test.sh` — Full success criteria verification. Implemented in Plan 01-03.
- `scripts/init-db/` — Postgres schema initialization scripts.
- `dashboard/Dockerfile` — Dashboard placeholder container.
- `dashboard/index.html` — Placeholder dashboard page.

### Established Patterns
- Checkpoint-based scripts with discrete stages and manual verification
- `.env` at repo root for all secrets, sourced by compose and scripts
- `mailbox_smoke` Postgres schema for test isolation (avoids polluting application data)
- `--boot-test` flag convention for destructive test operations (e.g., stack teardown for boot time measurement)

### Integration Points
- Docker Compose stack is the integration foundation for all subsequent phases
- Postgres schema separation (public for n8n, separate schema for mailbox data) established
- Ollama model availability is prerequisite for Phase 2 email classification

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches. User consistently selected recommended options, indicating trust in conventional infrastructure patterns.

</specifics>

<deferred>
## Deferred Ideas

- **Unified dashboard architecture** — thUMBox appliance dashboard as a deployment context of the Board Workstation (Next.js plugin shell). Deferred to Phase 4. PRD and addendum docs added to canonical refs for Phase 4 planning.

</deferred>

---

*Phase: 01-infrastructure-foundation*
*Context gathered: 2026-04-02*
*Context updated: 2026-04-07*
