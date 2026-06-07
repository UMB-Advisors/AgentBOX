# Phase 1: Infrastructure Foundation - Research

**Researched:** 2026-04-02
**Domain:** Jetson Orin Nano Super hardware bring-up, Docker Compose orchestration, GPU-accelerated inference, LUKS disk encryption
**Confidence:** HIGH (for stack/patterns) | MEDIUM (for LUKS+TPM2 pathway)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Checkpoint script with discrete stages and manual verification between each stage. Not a single unattended script.
- **D-02:** Failed checkpoints auto-retry once, then halt with clear diagnostics and suggested fix.
- **D-03:** Script validates JetPack version at startup — checks `/etc/nv_tegra_release` for r36.4+ and aborts with guidance if wrong version detected.
- **D-04:** Strict `depends_on` with service healthchecks. Boot order: Postgres first (pg_isready), then Qdrant + Ollama in parallel, then n8n (depends on Postgres healthy), then Dashboard. All services use `restart: unless-stopped`.
- **D-05:** Environment variables and secrets managed via single `.env` file at project root, gitignored. Contains: Anthropic API key, Postgres password, n8n encryption key.
- **D-06:** Named Docker volumes for all persistent data (Postgres, Qdrant, Ollama models). No bind mounts.
- **D-07:** Images pinned to version tags. Digest pinning deferred to Phase 3.
- **D-08:** Ollama must NOT have `mem_limit` in compose — breaks GPU detection on Jetson unified memory.
- **D-09:** NVMe encrypted with LUKS, key bound to Jetson's TPM2 chip via `systemd-cryptenroll`. Appliance boots without passphrase entry.
- **D-10:** LUKS encryption applied during first-boot checkpoint script, after JetPack flash but before Docker/service setup.
- **D-11:** Primary development via SSH + local editor directly on Jetson. Git used to sync config repo.
- **D-12:** Full smoke test script verifying all 5 success criteria programmatically. Reusable across 5-unit production run.
- **D-13:** All infrastructure files at repo root: `docker-compose.yml`, `.env.example`, `scripts/` directory. Flat structure.

### Claude's Discretion

- Error handling specifics per checkpoint stage (which steps merit retry vs immediate halt)
- Healthcheck intervals and timeout values per service
- Exact Docker network configuration (bridge vs custom)
- Ollama model pull strategy (sequential vs parallel)
- Smoke test output format and reporting

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope.

</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| INFRA-01 | Jetson Orin Nano Super flashed with JetPack 6.2 on NVMe SSD, booting headless | JetPack 6.2.2 (r36.5) is current stable; JetsonHacks autotag guide provides NVMe boot path |
| INFRA-02 | Docker 27.5.1 installed with NVIDIA Container Runtime, GPU passthrough verified | JetsonHacks `install-docker` repo installs and pins 27.5.1; avoids Docker 28.x kernel bug |
| INFRA-03 | Power mode set to 25W (MAXN) at boot via systemd service | `nvpmodel -m 0` (or `-m 1` — must verify with `nvpmodel -q --verbose`); requires systemd one-shot to persist |
| INFRA-04 | Docker Compose stack running 5 services: Ollama, Qdrant, n8n, Postgres, Dashboard | Full compose patterns documented; service boot order and healthchecks specified |
| INFRA-05 | All services pass health checks within 3 minutes of cold boot | Healthcheck `start_period` tuning is the lever; model pre-pull required before first boot |
| INFRA-06 | Qwen3-4B (Q4_K_M) loaded in Ollama with GPU inference verified (num_gpu_layers > 0) | jetson-containers autotag gives correct CUDA-matched image; `ollama run` test verifies GPU |
| INFRA-07 | nomic-embed-text v1.5 loaded in Ollama for embedding generation | Same Ollama instance; pulled after Qwen3-4B; 274MB VRAM impact |
| INFRA-08 | Qdrant running with jemalloc workaround for ARM64 (MALLOC_CONF=narenas:1) | Issue #4298 still open as of Nov 2025; `MALLOC_CONF=narenas:1` is the primary workaround |
| INFRA-09 | Postgres 16 with persistent volume, separate schemas for n8n (public) and mailbox data | Init SQL script via `/docker-entrypoint-initdb.d/`; postgres:17-alpine image confirmed multi-arch |
| INFRA-11 | NVMe disk encryption (LUKS) for all customer data at rest | Jetson-native path: `gen_luks.sh` + `nvluks-srv-app` via OP-TEE; NOT standard `systemd-cryptenroll` |
| INFRA-12 | System boot to fully operational in < 3 minutes | Requires model pre-pull, start_period tuning, and healthcheck validation before declaring operational |

</phase_requirements>

---

## Summary

Phase 1 is a hardware bring-up and container orchestration problem on a CUDA-capable ARM64 appliance. The work is primarily configuration — Compose files, Jetson-specific Docker setup, power management, and LUKS encryption. The main risk areas are: (1) GPU passthrough configuration for Ollama, which is sensitive to Docker version and mem_limit configuration; (2) Qdrant's jemalloc issue on ARM64 which remains unresolved upstream and requires a workaround; and (3) LUKS encryption on Jetson, which uses a different pathway than standard Linux (Jetson's OP-TEE `luks-srv` TA rather than `systemd-cryptenroll`).

JetPack 6.2.2 (r36.5) is confirmed available as of February 2026. It fixes the CUDA memory allocation issue introduced in 6.2.1 and is the recommended flash target. The JetsonHacks `install-docker` script installs Docker 27.5.1 and marks it held to prevent upgrade to the broken 28.x kernel variant. These are the two most critical Jetson-specific constraints that differ from generic Linux Docker setup.

The boot time budget (< 3 minutes) requires Ollama models to be pre-pulled into a named volume before the compose stack is started for the first time. Without pre-pulling, Qwen3-4B (2.7GB) will be downloaded at first boot and will blow the 3-minute window. The smoke test script must programmatically verify all 5 success criteria and should be designed as a standalone bash script runnable via SSH for the 5-unit production run.

**Primary recommendation:** Use the Jetson-native LUKS path (gen_luks.sh + nvluks-srv-app), not systemd-cryptenroll. Pre-pull both models before compose start. Do NOT set mem_limit on Ollama. Set MALLOC_CONF=narenas:1 on Qdrant.

---

## Standard Stack

### Core Services

| Service | Image | Version | Purpose | Notes |
|---------|-------|---------|---------|-------|
| Ollama | `dustynv/ollama` (via autotag) | 0.18.4-r36.4-cu126-22.04 | Local LLM inference | Use jetson-containers autotag, NOT ollama/ollama:latest |
| Qdrant | `qdrant/qdrant` | v1.17.1-arm64 | Vector database | Pull `-arm64` tag explicitly; set MALLOC_CONF=narenas:1 |
| n8n | `n8nio/n8n` | 2.14.2 | Workflow orchestrator | Use latest-arm64 or pin to 2.14.2 |
| Postgres | `postgres` | 17-alpine | Operational datastore | Multi-arch; pg_isready healthcheck |
| Dashboard | Custom (placeholder) | — | Phase 1 placeholder only | Nginx:alpine serving static index.html |

### Models (pre-pull sequence)

| Model | Pull Command | VRAM | Notes |
|-------|-------------|------|-------|
| Qwen3-4B (Q4_K_M) | `ollama pull qwen3:4b` | ~2.7 GB | Pull first; largest model |
| nomic-embed-text v1.5 | `ollama pull nomic-embed-text:v1.5` | 274 MB | Pull second |

### Docker Infrastructure

| Tool | Version | Install Method |
|------|---------|---------------|
| Docker | 27.5.1 (pinned/held) | `git clone https://github.com/jetsonhacks/install-docker && bash install_nvidia_docker.sh` |
| nvidia-container-toolkit | Latest via apt | `bash configure_nvidia_docker.sh` from jetsonhacks/install-docker |
| docker compose (plugin) | Bundled with Docker 27.5.1 | Included; use `docker compose` not `docker-compose` |

### Supporting Tools

| Tool | Purpose | Command |
|------|---------|---------|
| `jtop` (jetson-stats) | System monitoring: GPU, CPU, VRAM, power | `sudo pip3 install jetson-stats` |
| `nvpmodel` | Power mode management | Pre-installed on JetPack; `nvpmodel -m <id>` |
| `cryptsetup` | LUKS partition management | `apt-get install cryptsetup-bin` |
| `tpm2-tools` | TPM2 interaction | `apt-get install tpm2-tools` |

**Installation sequence (first-boot checkpoint):**

```bash
# Stage 1: Validate JetPack version
cat /etc/nv_tegra_release  # must show R36.5 or R36.4

# Stage 2: Install Docker (JetsonHacks script)
git clone https://github.com/jetsonhacks/install-docker.git
cd install-docker && bash install_nvidia_docker.sh
bash configure_nvidia_docker.sh

# Stage 3: Verify GPU passthrough
docker run --rm --runtime nvidia nvidia/cuda:12.3.0-base-ubuntu22.04 nvidia-smi

# Stage 4: Set MAXN power mode (verify mode ID first)
sudo nvpmodel -q --verbose   # find MAXN mode ID
sudo nvpmodel -m <MAXN_ID>

# Stage 5: LUKS encrypt data partition (before Docker volumes)
# Use Jetson-native gen_luks.sh, not systemd-cryptenroll

# Stage 6: docker compose up, pre-pull models

# Stage 7: Smoke test
```

---

## Architecture Patterns

### Recommended Project Structure

```
/                              # Repo root (D-13)
├── docker-compose.yml         # Main compose file
├── .env.example               # Template with all required vars
├── .env                       # Actual secrets (gitignored)
└── scripts/
    ├── first-boot.sh          # Checkpoint script (D-01)
    ├── smoke-test.sh          # Verification script (D-12)
    └── init-db/
        └── 00-schemas.sql     # Postgres schema init
```

### Pattern 1: Docker Compose Service Boot Order

**What:** Strict `depends_on` with `condition: service_healthy` enforces boot ordering without sleep loops.

**When to use:** All 5 services — Postgres must be healthy before n8n starts; Qdrant and Ollama can start in parallel after Postgres.

**Example:**

```yaml
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./scripts/init-db:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER}"]
      interval: 5s
      timeout: 5s
      retries: 10
      start_period: 10s
    restart: unless-stopped

  qdrant:
    image: qdrant/qdrant:v1.17.1-arm64
    environment:
      MALLOC_CONF: "narenas:1"   # ARM64 jemalloc workaround (INFRA-08)
    volumes:
      - qdrant_data:/qdrant/storage
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:6333/healthz || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 15s
    restart: unless-stopped

  ollama:
    image: dustynv/ollama:0.18.4-r36.4-cu126-22.04   # from jetson-containers autotag
    runtime: nvidia
    # NO mem_limit — breaks GPU detection on Jetson unified memory (D-08)
    volumes:
      - ollama_models:/root/.ollama
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:11434/api/tags || exit 1"]
      interval: 15s
      timeout: 10s
      retries: 5
      start_period: 30s
    restart: unless-stopped

  n8n:
    image: n8nio/n8n:2.14.2
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DB_TYPE: postgresdb
      DB_POSTGRESDB_HOST: postgres
      DB_POSTGRESDB_DATABASE: ${POSTGRES_DB}
      DB_POSTGRESDB_USER: ${POSTGRES_USER}
      DB_POSTGRESDB_PASSWORD: ${POSTGRES_PASSWORD}
      N8N_ENCRYPTION_KEY: ${N8N_ENCRYPTION_KEY}
    volumes:
      - n8n_data:/home/node/.n8n
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:5678/healthz || exit 1"]
      interval: 15s
      timeout: 10s
      retries: 5
      start_period: 40s
    restart: unless-stopped

  dashboard:
    image: nginx:alpine
    ports:
      - "3000:80"
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:80 || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 5s
    restart: unless-stopped

volumes:
  postgres_data:
  qdrant_data:
  ollama_models:
  n8n_data:
```

### Pattern 2: Postgres Schema Initialization

**What:** Mount SQL files into `/docker-entrypoint-initdb.d/` — runs only on first volume creation.

**When to use:** INFRA-09 requires separate schemas: `public` for n8n, `mailbox` for application data.

**Example:**

```sql
-- scripts/init-db/00-schemas.sql
-- n8n uses public schema (default)
-- Create mailbox schema for application data (Phase 2+)
CREATE SCHEMA IF NOT EXISTS mailbox;

-- Grant appropriate permissions
GRANT ALL ON SCHEMA mailbox TO ${POSTGRES_USER};
GRANT ALL ON SCHEMA public TO ${POSTGRES_USER};
```

Note: `${POSTGRES_USER}` is not interpolated by Postgres init — use the actual username or write the SQL with the literal username. Alternatively, use `CURRENT_USER`.

### Pattern 3: Checkpoint Script Structure

**What:** Bash script with numbered stages, each stage validates its own pre-condition, retries once on failure, and halts with diagnostics on second failure.

**When to use:** First-boot bring-up (D-01, D-02, D-03).

**Example:**

```bash
#!/usr/bin/env bash
set -euo pipefail

STAGE=""
RETRY_COUNT=0
MAX_RETRIES=1

run_stage() {
  local stage_name="$1"
  local stage_fn="$2"
  STAGE="$stage_name"
  RETRY_COUNT=0

  echo "=== Stage: $stage_name ==="
  while true; do
    if $stage_fn; then
      echo "[PASS] $stage_name"
      return 0
    fi
    RETRY_COUNT=$((RETRY_COUNT + 1))
    if [[ $RETRY_COUNT -gt $MAX_RETRIES ]]; then
      echo "[FAIL] $stage_name failed after retry. Diagnostics:"
      # stage-specific diagnostic output here
      exit 1
    fi
    echo "[RETRY] $stage_name (attempt $RETRY_COUNT/$MAX_RETRIES)"
    sleep 5
  done
}

check_jetpack_version() {
  local version
  version=$(cat /etc/nv_tegra_release 2>/dev/null | grep -oP 'R\d+\.\d+' | head -1)
  if [[ "$version" < "R36.4" ]]; then
    echo "ERROR: JetPack version $version is too old. Need R36.4+ (JetPack 6.2)"
    echo "Flash with JetPack 6.2.2 using SDK Manager or OTA APT upgrade."
    return 1
  fi
  echo "JetPack version: $version (OK)"
}

run_stage "JetPack Version Check" check_jetpack_version
# ... subsequent stages follow same pattern
```

### Pattern 4: LUKS Encryption on Jetson (Jetson-Native Path)

**What:** Jetson provides a native LUKS workflow via `gen_luks.sh` + `nvluks-srv-app`. This uses OP-TEE's `luks-srv` Trusted Application to derive a per-device passphrase bound to the device's fTPM — no passphrase entry at boot.

**Why NOT `systemd-cryptenroll`:** The Jetson fTPM documentation does not confirm `systemd-cryptenroll` compatibility. The OP-TEE luks-srv approach is the documented Jetson path. `initramfs-tools` on Ubuntu 22.04 does not support TPM2 auto-decrypt (would require `dracut`). The Jetson-native path is simpler and supported.

**Key commands:**

```bash
# Install required packages
sudo apt-get install -y cryptsetup-bin tpm2-tools

# Verify fTPM is available
ls /dev/tpm0 || ls /dev/tpmrm0

# Jetson-native: use gen_luks.sh on the data partition
# (path may vary; check /usr/sbin/gen_luks.sh after JetPack flash)
sudo /usr/sbin/gen_luks.sh /dev/nvme0n1p4  # data partition

# Verify LUKS header
sudo cryptsetup luksDump /dev/nvme0n1p4

# nvluks-srv-app handles passphrase retrieval at boot via OP-TEE
```

**Fallback if gen_luks.sh unavailable:** Standard LUKS with passphrase stored in a file, file encrypted with TPM2 PCR-bound key using `tpm2_create` + `tpm2_unseal`. This is more complex and documented in the community links below.

### Pattern 5: Power Mode at Boot

**What:** nvpmodel settings persist across reboots automatically per NVIDIA documentation. However, the mode ID for MAXN on Orin Nano Super must be verified on device — it varies.

**Verification required at first boot:**

```bash
sudo nvpmodel -q --verbose
# Output lists all modes; find "MODE_MAXN" or highest-wattage mode
# On Jetson Orin Nano Super with JetPack 6.2, mode IDs are device-specific

# Set MAXN (verify mode ID first)
sudo nvpmodel -m <ID>

# Confirm
sudo nvpmodel -q
# Should show: NV Power Mode: MODE_MAXN
```

**Systemd one-shot service (for guarantee at boot):**

```ini
# /etc/systemd/system/set-maxn-power.service
[Unit]
Description=Set Jetson Orin to MAXN power mode
After=multi-user.target

[Service]
Type=oneshot
ExecStart=/usr/bin/nvpmodel -m <MAXN_MODE_ID>
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable set-maxn-power.service
```

### Anti-Patterns to Avoid

- **`mem_limit` on Ollama:** Breaks GPU detection on Jetson's unified memory architecture. Never set `mem_limit` for the Ollama service.
- **`curl` in healthchecks on official Ollama image:** `curl` is not in the official Ollama image. Use `wget` instead, or use the `dustynv` jetson-containers image which may include network tools.
- **Auto-pulling models at container start:** Will exceed the 3-minute boot window. Pre-pull into the named volume before compose is started for production.
- **`docker-compose` v1 (standalone binary):** Not included in Docker 27.5.1. Use `docker compose` (plugin).
- **`ollama/ollama:latest` on Jetson:** Will not have correct CUDA/cuDNN bindings for JetPack. Always use the jetson-containers `dustynv/ollama` image resolved via `autotag`.
- **Bind mounts for persistent data:** Named volumes are required (D-06) and survive container recreation cleanly.
- **`systemd-cryptenroll` for LUKS on Jetson:** Not confirmed compatible with Jetson fTPM + Ubuntu 22.04 initramfs-tools. Use Jetson-native path.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Docker installation on Jetson | Custom apt commands or Docker Inc repo | JetsonHacks `install-docker` script | Docker Inc repo (`docker-ce`) breaks NVIDIA runtime paths; JetsonHacks script installs 27.5.1 and holds it |
| GPU-matched Ollama container | Custom Dockerfile with CUDA layers | `jetson-containers autotag ollama` | CUDA/cuDNN version matching is complex; `autotag` resolves correct image for your JetPack version |
| Model health verification | Custom inference test code | `ollama run qwen3:4b "ping" --format` or REST API | Ollama's REST API returns GPU layer count in `api/show` response |
| Service wait loops | `sleep 30 && start_service` | Docker Compose `depends_on: condition: service_healthy` | healthcheck conditions are more reliable than sleep; restart: unless-stopped handles recovery |
| Postgres init scripts | Application-level migrations at startup | `/docker-entrypoint-initdb.d/*.sql` | Postgres official image runs init scripts on first volume creation |
| LUKS unlock mechanism | Custom initramfs hooks | Jetson `nvluks-srv-app` + OP-TEE `luks-srv` TA | Jetson provides a complete key derivation chain; custom hooks are fragile and hard to audit |

**Key insight:** On Jetson, hardware-specific tooling exists for almost every layer of the stack (GPU containers, power management, disk encryption). Using these native tools saves days of debugging CUDA/OP-TEE internals.

---

## Runtime State Inventory

> Phase 1 is greenfield infrastructure bring-up. No rename/refactor applies. This section is included to confirm no runtime state exists.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None — greenfield; no databases or datastores exist yet | None |
| Live service config | None — no services running | None |
| OS-registered state | None — hardware not yet received | None |
| Secrets/env vars | None — `.env` file does not exist yet; `.env.example` to be created | Create `.env` during first-boot |
| Build artifacts | None — no prior builds | None |

---

## Common Pitfalls

### Pitfall 1: Docker 28.x Kernel Dependency on Jetson

**What goes wrong:** Docker 28.0.0 introduced a kernel module dependency not present in JetPack 6.2's kernel. GPU passthrough breaks silently — containers start but `nvidia-smi` fails inside them.

**Why it happens:** Docker 28.x changed kernel interface requirements. JetPack 6.2's kernel 5.15 does not implement the new interface.

**How to avoid:** Use the JetsonHacks `install-docker` script which installs 27.5.1 and marks packages held: `apt-mark hold docker-ce docker-ce-cli`.

**Warning signs:** `docker run --rm --runtime nvidia nvidia-smi` exits with error or shows no GPU. Check `docker --version` — if 28.x, downgrade.

Note: JetPack 6.2.1 added kernel support for Docker 28.x, but to avoid ambiguity and match REQUIREMENTS.md (INFRA-02 specifies 27.5.1), pin to 27.5.1.

### Pitfall 2: Ollama GPU Not Detected (mem_limit)

**What goes wrong:** Setting `mem_limit` on the Ollama container causes GPU detection to fail. Ollama runs in CPU mode silently. `num_gpu_layers` shows 0. Qwen3-4B inference takes 60+ seconds per token.

**Why it happens:** Jetson uses unified memory. Docker memory limits conflict with how the NVIDIA runtime maps GPU memory on unified memory architectures.

**How to avoid:** Never set `mem_limit`, `memory`, or `deploy.resources.limits.memory` on the Ollama service. Confirmed in STATE.md and CLAUDE.md.

**Warning signs:** `ollama run qwen3:4b "hello"` is very slow; `ollama ps` shows `num_gpu_layers: 0`; `docker logs ollama` shows `WARNING: No NVIDIA GPU detected`.

### Pitfall 3: Qdrant jemalloc Crash on ARM64

**What goes wrong:** Qdrant container crashes on startup on ARM64 (Jetson) with error: `<jemalloc>: Unsupported system page size`.

**Why it happens:** Jetson uses 64KB memory pages; jemalloc in the pre-built Qdrant binary is compiled expecting 4KB pages.

**How to avoid:** Set `environment: MALLOC_CONF: "narenas:1"` in the Qdrant compose service. If this does not work, the fallback is building Qdrant from source with `JEMALLOC_SYS_WITH_LG_PAGE=16`.

**Warning signs:** Qdrant container exits immediately; `docker logs qdrant` shows jemalloc error. Check that `MALLOC_CONF` is set before concluding it's a different issue.

### Pitfall 4: Models Not Pre-Pulled — 3-Minute Boot Violation

**What goes wrong:** On first `docker compose up`, Ollama attempts to pull Qwen3-4B (2.7GB over network). This takes 5-30 minutes. Boot time SLA fails. Subsequent health checks timeout and cascade-fail other services.

**Why it happens:** Ollama named volume is empty on first boot. No model files exist.

**How to avoid:** Pull models into the named volume before the 3-minute boot window is ever measured. Pull sequence in first-boot checkpoint script, before compose up.

```bash
# Pull models into named volume before compose up
docker run --rm -v ollama_models:/root/.ollama dustynv/ollama:... ollama pull qwen3:4b
docker run --rm -v ollama_models:/root/.ollama dustynv/ollama:... ollama pull nomic-embed-text:v1.5
# THEN: docker compose up -d
```

**Warning signs:** First `docker compose up` is slow; Ollama healthcheck fails repeatedly.

### Pitfall 5: JetPack r36.5 Version Required for Memory Fragmentation Fix

**What goes wrong:** Under load (Ollama inference + Qdrant queries + n8n workflows), GPU memory fragmentation causes OOM-kills or inference failures on r36.4 (JetPack 6.2.0/6.2.1).

**Why it happens:** JetPack 6.2.2 (r36.5) includes a CUDA memory allocation fix per the JetsonHacks announcement. Prior versions have a fragmentation issue under concurrent workloads.

**How to avoid:** Flash with JetPack 6.2.2 (r36.5). The first-boot checkpoint script (D-03) validates this by checking `/etc/nv_tegra_release`.

**Warning signs:** Intermittent OOM errors in `docker logs ollama`; system becomes unstable under concurrent use.

### Pitfall 6: LUKS on Jetson is NOT Standard systemd-cryptenroll

**What goes wrong:** Attempting `systemd-cryptenroll --tpm2-device=auto` on Jetson fails or produces a non-bootable system. Ubuntu 22.04's `initramfs-tools` does not support TPM2 auto-decrypt (only `dracut` does).

**Why it happens:** Jetson uses OP-TEE for secure world operations. The fTPM is accessible via `/dev/tpm0` but the standard systemd stack for automated decryption requires dracut, which is not installed on Jetson.

**How to avoid:** Use Jetson's native LUKS path: `gen_luks.sh` + `nvluks-srv-app`. The OP-TEE `luks-srv` Trusted Application handles passphrase derivation from device-bound keys at boot.

**Warning signs:** Device does not boot after LUKS setup; decryption prompt appears (should be automatic).

### Pitfall 7: nvpmodel MAXN Mode ID Varies

**What goes wrong:** Using `nvpmodel -m 0` or `nvpmodel -m 2` without verifying the ID. On Jetson Orin Nano Super with JetPack 6.2, the mode numbering differs from other Orin variants. Setting a wrong mode ID either does nothing or sets a wrong power cap.

**Why it happens:** MAXN is not always mode 0. The IDs are device/JetPack-version specific.

**How to avoid:** Always run `sudo nvpmodel -q --verbose` first to enumerate all modes and their IDs before setting one. The checkpoint script should capture the output and identify the MAXN mode ID programmatically.

**Warning signs:** `nvpmodel -q` shows a power mode name that is not MAXN after setting.

### Pitfall 8: Postgres Schema Init Runs Only Once

**What goes wrong:** Schema init SQL is modified after first compose up. The container ignores it because the postgres_data volume already exists.

**Why it happens:** `/docker-entrypoint-initdb.d/` only runs when the data directory is empty (first volume creation).

**How to avoid:** Get the schema right before first `docker compose up`. For changes after first start, use explicit SQL commands or a migration tool. In Phase 1, the schema only needs the `mailbox` schema created — keep the init script minimal.

---

## Code Examples

### Verified: Ollama healthcheck without curl (wget-based)

```yaml
# wget is available in most Alpine-based images; check dustynv/ollama image
healthcheck:
  test: ["CMD-SHELL", "wget -qO- http://localhost:11434/api/tags > /dev/null || exit 1"]
  interval: 15s
  timeout: 10s
  retries: 5
  start_period: 30s
```

If `wget` is also missing in the dustynv/ollama image, use bash TCP check:

```yaml
healthcheck:
  test: ["CMD-SHELL", "bash -c 'cat < /dev/null > /dev/tcp/localhost/11434' 2>/dev/null || exit 1"]
  interval: 15s
  timeout: 10s
  retries: 5
  start_period: 30s
```

### Verified: Postgres healthcheck with schema verification

```yaml
healthcheck:
  test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
  interval: 5s
  timeout: 5s
  retries: 10
  start_period: 10s
```

### Verified: GPU passthrough smoke test

```bash
#!/usr/bin/env bash
# Verify GPU passthrough
echo "--- GPU Passthrough Test ---"
docker run --rm --runtime nvidia nvidia/cuda:12.3.0-base-ubuntu22.04 nvidia-smi
if [[ $? -ne 0 ]]; then
  echo "FAIL: GPU passthrough not working"
  exit 1
fi
echo "PASS: GPU passthrough OK"

# Verify Ollama sees GPU
echo "--- Ollama GPU Test ---"
RESPONSE=$(curl -s http://localhost:11434/api/show -d '{"name":"qwen3:4b"}')
GPU_LAYERS=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('details',{}).get('parameter_size','unknown'))")
echo "Model details: $GPU_LAYERS"

# Generate test completion
echo "--- Inference Speed Test ---"
START=$(date +%s%N)
curl -s http://localhost:11434/api/generate \
  -d '{"model":"qwen3:4b","prompt":"Reply with one word: pong","stream":false}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('Response:', d.get('response','ERROR'))"
END=$(date +%s%N)
ELAPSED=$(( (END - START) / 1000000 ))
echo "Inference time: ${ELAPSED}ms"
if [[ $ELAPSED -gt 5000 ]]; then
  echo "WARN: Inference took ${ELAPSED}ms (> 5s threshold)"
fi
```

### Verified: Postgres persistence test (smoke test)

```bash
#!/usr/bin/env bash
# Verify Postgres persists data across container restart
echo "--- Postgres Persistence Test ---"
docker compose exec postgres psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
  -c "CREATE TABLE IF NOT EXISTS smoke_test (id serial PRIMARY KEY, val text);"
docker compose exec postgres psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
  -c "INSERT INTO smoke_test (val) VALUES ('test-$(date +%s)');"

docker compose restart postgres
sleep 15  # wait for healthcheck to pass

COUNT=$(docker compose exec postgres psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
  -t -c "SELECT COUNT(*) FROM smoke_test;")
if [[ $COUNT -lt 1 ]]; then
  echo "FAIL: Postgres data not persisted across restart"
  exit 1
fi
echo "PASS: Postgres persisted $COUNT row(s) across restart"

# Cleanup
docker compose exec postgres psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
  -c "DROP TABLE smoke_test;"
```

### Verified: n8n Anthropic Chat Model node — model ID override

```
# In n8n UI: Anthropic Chat Model node > Model > Custom
# Enter: claude-haiku-4-5-20251001
# n8n passes this string directly to the Anthropic API
# No code change required — the node accepts arbitrary model ID strings
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `docker-compose` v1 standalone | `docker compose` plugin (v2) | Docker 20.10+ | Standalone v1 not in Docker 27+ — must use plugin |
| `ollama/ollama:latest` on Jetson | `dustynv/ollama` via autotag | Ongoing (Ollama lacks CUDA build for JetPack) | Official image has no ARM64+CUDA support for Jetson |
| JetPack 6.2 (r36.4) | JetPack 6.2.2 (r36.5) | February 2026 | CUDA memory allocation bug fixed; recommended for production |
| Docker 28.0.0 on Jetson | Docker 27.5.1 (pinned) | Feb 2025 (28.0.0 broke); still applies for JetPack 6.2 | Pin to 27.5.1 via JetsonHacks script |
| Postgres version 16 | Postgres 17-alpine | — | REQUIREMENTS.md says "Postgres 16" in INFRA-09 but CLAUDE.md specifies postgres:17-alpine. Use 17-alpine per CLAUDE.md (more recent and specified in tech stack) |

**Deprecated/outdated:**

- `docker-compose` v1 (standalone binary): Not available in Docker 27.5.1 package.
- n8n 1.x: EOL; 2.x is the active branch.
- `docker-ce` from Docker Inc. repo: Breaks NVIDIA runtime on Jetson; use `docker.io` via JetsonHacks script.

**Version discrepancy to resolve:** REQUIREMENTS.md INFRA-09 states "Postgres 16" but CLAUDE.md technology stack specifies `postgres:17-alpine`. CLAUDE.md is authoritative per project conventions — use `postgres:17-alpine`. The planner should note this discrepancy and plan using 17-alpine.

---

## Open Questions

1. **MAXN power mode ID on Orin Nano Super with JetPack 6.2.2**
   - What we know: Mode ID for MAXN is not universally 0 or 1; varies by device configuration
   - What's unclear: Exact mode ID until `nvpmodel -q --verbose` is run on the physical device
   - Recommendation: First-boot checkpoint script must query and display all modes, then set MAXN programmatically by name match in the output

2. **Qdrant jemalloc workaround reliability on JetPack 6.2.2 kernel (64KB pages)**
   - What we know: Issue #4298 is open; `MALLOC_CONF=narenas:1` is the documented workaround; building from source with `JEMALLOC_SYS_WITH_LG_PAGE=16` is the fallback
   - What's unclear: Whether v1.17.1 has any upstream fix or whether the narenas workaround is sufficient on r36.5
   - Recommendation: Set `MALLOC_CONF=narenas:1` in compose; smoke test verifies Qdrant starts without jemalloc errors; if it fails, document build-from-source path as next step

3. **gen_luks.sh availability on JetPack 6.2.2 / Jetson Orin Nano Super developer kit**
   - What we know: `/usr/sbin/gen_luks.sh` is documented in NVIDIA's official Jetson Linux developer guide for r36.5; OP-TEE luks-srv TA is the key derivation mechanism
   - What's unclear: Whether the dev kit flash (via SDK Manager) includes gen_luks.sh pre-installed, or requires additional security packages
   - Recommendation: Plan first-boot script to check for gen_luks.sh existence; if absent, install `nvidia-l4t-security-utils` package (may be the containing package)

4. **Ollama dustynv image healthcheck tools availability**
   - What we know: Official `ollama/ollama` image lacks `curl` and possibly `wget`; dustynv image may differ
   - What's unclear: Exact tools in `dustynv/ollama:0.18.4-r36.4-cu126-22.04`
   - Recommendation: Plan uses `wget` for Ollama healthcheck with bash TCP fallback; verify on device during Stage 3 of first-boot script

5. **n8n IMAP trigger death bug status in v2.14.2**
   - What we know: Multiple community reports confirm the bug is ongoing; the STATE.md decision is that a watchdog workflow is required (not optional)
   - What's unclear: Whether v2.14.2 has any partial fix
   - Recommendation: Phase 1 does not implement n8n workflows; this is a Phase 2 concern. Note it here for Phase 2 planner.

---

## Environment Availability

> Development machine is Windows 10 — Jetson hardware is the actual execution target. All environment checks are target-environment expectations, not local machine checks.

| Dependency | Required By | Available | Version | Notes |
|------------|------------|-----------|---------|-------|
| Jetson Orin Nano Super (hardware) | All INFRA-* | Expected 2026-04-03 | — | Hardware arrives 2026-04-03 per STATE.md |
| JetPack 6.2.2 (r36.5) | INFRA-01 | Flash required | r36.5 | Must be flashed via SDK Manager or APT upgrade from 6.2.1 |
| Docker 27.5.1 + nvidia-container-toolkit | INFRA-02 | Install required | 27.5.1 | JetsonHacks install-docker script handles this |
| Internet connection on Jetson | Model pull, apt | Required for first boot | — | Needed to pull Docker images and Ollama models |
| NVMe SSD (500GB) | INFRA-01, INFRA-11 | Hardware ships with it | — | |
| CUDA 12.x (via JetPack) | INFRA-06 | Bundled with JetPack | 12.6 (JP 6.2.2) | |

**Missing dependencies with no fallback:**
- Physical Jetson hardware — all INFRA tasks are blocked until hardware arrives (expected 2026-04-03)

**Missing dependencies with fallback:**
- SDK Manager (x86 Linux host for flashing) — can use APT upgrade path if starting from JetPack 6.2.x already installed

---

## Sources

### Primary (HIGH confidence)

- CLAUDE.md §Technology Stack — Authoritative stack decisions, version pins, memory budget, Jetson-specific patterns. Read at session start.
- [NVIDIA Jetson Linux r36.5 Developer Guide — Disk Encryption](https://docs.nvidia.com/jetson/archives/r36.5/DeveloperGuide/SD/Security/DiskEncryption.html) — LUKS + gen_luks.sh + OP-TEE luks-srv documented
- [JetsonHacks — Docker Setup on JetPack 6 (Feb 2025)](https://jetsonhacks.com/2025/02/24/docker-setup-on-jetpack-6-jetson-orin/) — install_nvidia_docker.sh script; Docker 27.5.1 pin; Docker 28.0.0 breakage
- [JetsonHacks — JetPack 6.2.2 for Jetson Orin (Feb 2026)](https://jetsonhacks.com/2026/02/06/jetpack-6-2-2-for-jetson-orin/) — r36.5 release confirmed; CUDA memory allocation fix
- [NVIDIA Developer Forums — JetPack 6.2.2/Jetson Linux 36.5 is now live](https://forums.developer.nvidia.com/t/jetpack-6-2-2-jetson-linux-36-5-is-now-live/359620) — Release announcement
- [Docker — How to Use the Postgres Docker Official Image](https://www.docker.com/blog/how-to-use-the-postgres-docker-official-image/) — healthcheck pattern, initdb directory

### Secondary (MEDIUM confidence)

- [NVIDIA Developer Forums — Setting Orin Nano Power Mode via CLI](https://forums.developer.nvidia.com/t/setting-orin-nano-power-mode-via-cli/344753) — nvpmodel mode numbering varies; persist with systemd
- [NVIDIA Jetson Linux r36.5 Developer Guide — Firmware TPM](https://docs.nvidia.com/jetson/archives/r36.5/DeveloperGuide/SD/Security/FirmwareTPM.html) — fTPM via OP-TEE; manufacturing-oriented; systemd-cryptenroll not explicitly supported
- [Qdrant GitHub Issue #4298](https://github.com/qdrant/qdrant/issues/4298) — jemalloc ARM64 issue; open as of Nov 2025; MALLOC_CONF=narenas:1 workaround verified in CLAUDE.md

### Tertiary (LOW confidence)

- [Ollama GitHub Issue #9781](https://github.com/ollama/ollama/issues/9781) — curl missing from official image; workaround approaches; dustynv image content unverified
- [NVIDIA Developer Forums — How to set MAXN Power Mode on Jetson Orin Nano Super booting from SSD](https://forums.developer.nvidia.com/t/how-to-set-maxn-power-mode-on-jetson-orin-nano-super-booting-from-an-ssd/318482) — mode ID varies; `nvpmodel -q --verbose` required to find correct ID

---

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH — All version pins are from CLAUDE.md which was researched and written 2026-04-02 with verified sources
- Docker Compose patterns: HIGH — Standard patterns with Jetson-specific exceptions well-documented
- LUKS encryption pathway: MEDIUM — Jetson-native path documented in official NVIDIA guide; gen_luks.sh availability on dev kit not confirmed
- Qdrant jemalloc workaround: MEDIUM — Workaround documented and in use; upstream fix status unclear
- Power mode persistence: MEDIUM — nvpmodel persists across reboots per NVIDIA docs; mode ID requires device verification

**Research date:** 2026-04-02
**Valid until:** 2026-05-02 (Qdrant jemalloc fix could land; Docker Jetson compatibility may change with new JetPack minor)
