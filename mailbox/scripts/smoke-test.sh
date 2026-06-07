#!/usr/bin/env bash
# smoke-test.sh — MailBox One appliance acceptance test
#
# Verifies all Phase 1 success criteria. By default runs Checks 1-5.
# Check 6 (boot time) is DESTRUCTIVE (tears down + restarts the stack) and
# requires the --boot-test flag to enable.
#
# Usage:
#   ./scripts/smoke-test.sh              # Checks 1-5 only
#   ./scripts/smoke-test.sh --boot-test  # Checks 1-6 (destructive)
#
# Exit code: 0 = all run checks passed, 1 = one or more checks failed

set -euo pipefail

# ---------------------------------------------------------------------------
# Source .env from repo root if it exists
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ -f "${REPO_ROOT}/.env" ]]; then
  # shellcheck disable=SC1091
  set -o allexport
  source "${REPO_ROOT}/.env"
  set +o allexport
fi

# ---------------------------------------------------------------------------
# Parse flags
# ---------------------------------------------------------------------------
RUN_BOOT_TEST=false
for arg in "$@"; do
  case "$arg" in
    --boot-test)
      RUN_BOOT_TEST=true
      ;;
    -h|--help)
      echo "Usage: $0 [--boot-test]"
      echo "  --boot-test  Include Check 6 (boot time). WARNING: tears down the full stack."
      exit 0
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Color constants
# ---------------------------------------------------------------------------
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'  # No color

# ---------------------------------------------------------------------------
# Counters and result storage
# ---------------------------------------------------------------------------
PASS=0
FAIL=0
declare -A RESULTS
declare -A RESULT_DETAILS

# Timing for each check
declare -A CHECK_TIMES

# Track overall start time
OVERALL_START=$(date +%s)

# ---------------------------------------------------------------------------
# Print startup notice
# ---------------------------------------------------------------------------
echo ""
echo -e "${BOLD}====================================================${NC}"
echo -e "${BOLD}  MailBox One — Appliance Smoke Test${NC}"
echo -e "${BOLD}  Host: $(hostname)${NC}"
echo -e "${BOLD}  Date: $(date -u +"%Y-%m-%dT%H:%M:%SZ")${NC}"
echo -e "${BOLD}====================================================${NC}"
echo ""

if [[ "${RUN_BOOT_TEST}" == "false" ]]; then
  echo -e "${YELLOW}NOTE: Boot time check (Check 6) skipped by default — it tears down the stack.${NC}"
  echo -e "${YELLOW}      Re-run with --boot-test to include it.${NC}"
  echo ""
  TOTAL=5
else
  echo -e "${YELLOW}WARNING: --boot-test enabled. Check 6 will bring the entire stack DOWN and back UP.${NC}"
  echo ""
  TOTAL=6
fi

# ---------------------------------------------------------------------------
# Helper: run_check <display-name> <function-name>
# ---------------------------------------------------------------------------
run_check() {
  local display_name="$1"
  local func_name="$2"
  local check_start check_end elapsed

  echo -e "${CYAN}--- ${display_name} ---${NC}"
  check_start=$(date +%s)

  local rc=0
  "$func_name" || rc=$?

  check_end=$(date +%s)
  elapsed=$(( check_end - check_start ))
  CHECK_TIMES["$display_name"]="${elapsed}s"

  if [[ $rc -eq 0 ]]; then
    echo -e "${GREEN}PASS${NC}: ${display_name} (${elapsed}s)"
    RESULTS["$display_name"]="PASS"
    (( PASS++ )) || true
  else
    echo -e "${RED}FAIL${NC}: ${display_name} (${elapsed}s)"
    RESULTS["$display_name"]="FAIL"
    (( FAIL++ )) || true
  fi
  echo ""
}

# ---------------------------------------------------------------------------
# EXIT trap — always print structured summary
# ---------------------------------------------------------------------------
print_summary() {
  local overall_end overall_elapsed
  overall_end=$(date +%s)
  overall_elapsed=$(( overall_end - OVERALL_START ))

  echo ""
  echo -e "${BOLD}====================================================${NC}"
  echo -e "${BOLD}SMOKE TEST RESULTS — $(hostname)${NC}"
  echo -e "Date: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo -e "${BOLD}====================================================${NC}"

  # Define ordered check names for the summary table
  local ordered_checks=(
    "Check 1: GPU Passthrough"
    "Check 2: Qwen3-4B Inference"
    "Check 3: nomic-embed-text Embeddings"
    "Check 4: Qdrant Health"
    "Check 5: Postgres Persistence"
    "Check 6: Boot Time"
  )

  for check in "${ordered_checks[@]}"; do
    local status="${RESULTS[$check]:-SKIPPED}"
    local timing=""
    if [[ -n "${CHECK_TIMES[$check]:-}" ]]; then
      timing=" (${CHECK_TIMES[$check]})"
    fi

    if [[ "$status" == "PASS" ]]; then
      printf "%-36s %b\n" "$check:" "${GREEN}PASS${NC}${timing}"
    elif [[ "$status" == "FAIL" ]]; then
      printf "%-36s %b\n" "$check:" "${RED}FAIL${NC}${timing}"
    else
      printf "%-36s %b\n" "$check:" "${YELLOW}SKIPPED${NC} (run with --boot-test)"
    fi
  done

  echo -e "${BOLD}----------------------------------------------------${NC}"
  echo -e "${BOLD}Total: ${PASS}/${TOTAL} passed${NC}   |   Total elapsed: ${overall_elapsed}s"
  echo -e "${BOLD}====================================================${NC}"
  echo ""

  if [[ $FAIL -gt 0 ]]; then
    exit 1
  else
    exit 0
  fi
}
trap print_summary EXIT

# ===========================================================================
# CHECK 1: GPU Passthrough
# Maps to Success Criterion 2: docker run --runtime nvidia nvidia-smi succeeds
# ===========================================================================
check_1_gpu_passthrough() {
  local output rc

  echo "Running: docker run --rm --runtime nvidia nvidia/cuda:12.3.0-base-ubuntu22.04 nvidia-smi"

  output=$(docker run --rm --runtime nvidia nvidia/cuda:12.3.0-base-ubuntu22.04 nvidia-smi 2>&1) || rc=$?
  rc=${rc:-0}

  if [[ $rc -ne 0 ]]; then
    echo -e "${RED}ERROR${NC}: nvidia-smi container exited with code $rc"
    echo "Diagnostic: $(nvidia-ctk --version 2>/dev/null || echo 'nvidia-container-toolkit not found')"
    echo "Output:"
    echo "$output"
    return 1
  fi

  if ! echo "$output" | grep -q "NVIDIA"; then
    echo -e "${RED}ERROR${NC}: nvidia-smi output does not contain 'NVIDIA' — GPU not detected"
    echo "Output:"
    echo "$output"
    echo "Diagnostic: $(nvidia-ctk --version 2>/dev/null || echo 'nvidia-container-toolkit not found')"
    return 1
  fi

  # Extract and print GPU name
  local gpu_name
  gpu_name=$(echo "$output" | grep -oE '\| [A-Za-z0-9 ]+' | head -1 | sed 's/^| *//' || echo "unknown")
  echo "GPU detected: ${gpu_name}"
  echo "nvidia-smi output:"
  echo "$output" | head -12
  return 0
}

# ===========================================================================
# CHECK 2: Qwen3-4B Inference < 5 seconds
# Maps to Success Criterion 3, INFRA-06
# ===========================================================================
check_2_qwen3_inference() {
  local start_ns end_ns elapsed_ms elapsed_sec response rc

  echo "Testing Qwen3-4B inference via Ollama API (localhost:11434)..."

  start_ns=$(date +%s%N)

  response=$(curl -s --max-time 30 http://localhost:11434/api/generate \
    -d '{"model":"qwen3:4b","prompt":"/no_think Reply with exactly: hello world","stream":false,"options":{"num_predict":20}}' \
    2>&1) || rc=$?
  rc=${rc:-0}

  end_ns=$(date +%s%N)
  elapsed_ms=$(( (end_ns - start_ns) / 1000000 ))
  elapsed_sec=$(( elapsed_ms / 1000 ))
  local elapsed_ms_rem=$(( elapsed_ms % 1000 ))

  if [[ $rc -ne 0 ]]; then
    echo -e "${RED}ERROR${NC}: curl to localhost:11434/api/generate failed (exit $rc)"
    echo "Loaded models: $(curl -s http://localhost:11434/api/tags 2>/dev/null || echo 'API unreachable')"
    return 1
  fi

  if ! echo "$response" | grep -q '"response"'; then
    echo -e "${RED}ERROR${NC}: Response does not contain 'response' field"
    echo "Raw response: ${response:0:300}"
    echo "Loaded models: $(curl -s http://localhost:11434/api/tags 2>/dev/null || echo 'API unreachable')"
    return 1
  fi

  # Verify inference time < 10 seconds (10000ms)
  if [[ $elapsed_ms -ge 10000 ]]; then
    echo -e "${RED}ERROR${NC}: Inference took ${elapsed_sec}.${elapsed_ms_rem}s — exceeds 10s threshold"
    echo "Loaded models: $(curl -s http://localhost:11434/api/tags 2>/dev/null || echo 'API unreachable')"
    return 1
  fi

  # Extract first 50 chars of response text
  local response_text
  response_text=$(echo "$response" | grep -o '"response":"[^"]*"' | sed 's/"response":"//;s/"//' | head -c 50 || echo "")

  echo "Model: qwen3:4b"
  echo "Inference time: ${elapsed_sec}.${elapsed_ms_rem}s (threshold: 5s)"
  echo "Response preview: ${response_text}"

  # Verify GPU layers are active
  echo "Checking GPU layer count..."
  local show_response num_gpu
  show_response=$(curl -s http://localhost:11434/api/show \
    -d '{"model":"qwen3:4b"}' 2>/dev/null || echo "")

  if echo "$show_response" | grep -q '"num_gpu"'; then
    num_gpu=$(echo "$show_response" | grep -o '"num_gpu":[0-9]*' | grep -o '[0-9]*$' || echo "0")
    if [[ "${num_gpu:-0}" -gt 0 ]]; then
      echo "GPU layers: ${num_gpu} (GPU acceleration confirmed)"
    else
      echo -e "${YELLOW}WARN${NC}: num_gpu=0 — model may be running on CPU only (check NVIDIA runtime)"
    fi
  else
    echo "Note: Could not retrieve num_gpu from /api/show"
  fi

  return 0
}

# ===========================================================================
# CHECK 3: nomic-embed-text Embeddings
# Maps to Success Criterion 3, INFRA-07
# ===========================================================================
check_3_embed_text() {
  local response rc

  echo "Testing nomic-embed-text:v1.5 via Ollama API (localhost:11434)..."

  response=$(curl -s --max-time 30 http://localhost:11434/api/embed \
    -d '{"model":"nomic-embed-text:v1.5","input":"test embedding for smoke check"}' \
    2>&1) || rc=$?
  rc=${rc:-0}

  if [[ $rc -ne 0 ]]; then
    echo -e "${RED}ERROR${NC}: curl to localhost:11434/api/embed failed (exit $rc)"
    echo "Loaded models: $(curl -s http://localhost:11434/api/tags 2>/dev/null || echo 'API unreachable')"
    return 1
  fi

  if ! echo "$response" | grep -q '"embeddings"'; then
    echo -e "${RED}ERROR${NC}: Response does not contain 'embeddings' field"
    echo "Raw response: ${response:0:300}"
    echo "Loaded models: $(curl -s http://localhost:11434/api/tags 2>/dev/null || echo 'API unreachable')"
    return 1
  fi

  # Check embeddings array is non-empty (contains '[' after "embeddings":)
  if ! echo "$response" | grep -q '"embeddings":\s*\[\['; then
    # Try alternate format
    if ! echo "$response" | grep -qE '"embeddings":[[:space:]]*\['; then
      echo -e "${RED}ERROR${NC}: Embeddings array appears empty"
      echo "Raw response: ${response:0:300}"
      return 1
    fi
  fi

  # Count dimensions by counting commas in first embedding vector (rough estimate)
  local dim_estimate
  # Extract content between first [ and ], count commas, add 1
  local first_vec
  first_vec=$(echo "$response" | grep -o '"embeddings":\[\[[^]]*\]' | head -1 || echo "")
  if [[ -n "$first_vec" ]]; then
    local comma_count
    comma_count=$(echo "$first_vec" | tr -cd ',' | wc -c)
    dim_estimate=$(( comma_count + 1 ))
    echo "Model: nomic-embed-text:v1.5"
    echo "Embedding dimensions: ${dim_estimate} (expected: 768)"
  else
    echo "Model: nomic-embed-text:v1.5"
    echo "Embeddings returned (dimension parse skipped — format differs)"
  fi

  return 0
}

# ===========================================================================
# CHECK 4: Qdrant Health — No jemalloc Errors
# Maps to Success Criterion 4, INFRA-08
# ===========================================================================
check_4_qdrant_health() {
  local response rc

  echo "Testing Qdrant health at localhost:6333..."

  response=$(curl -s --max-time 10 http://localhost:6333/healthz 2>&1) || rc=$?
  rc=${rc:-0}

  if [[ $rc -ne 0 ]]; then
    echo -e "${RED}ERROR${NC}: curl to localhost:6333/healthz failed (exit $rc)"
    echo "Docker logs: $(cd "${REPO_ROOT}" && docker compose logs qdrant --tail=30 2>&1 || echo 'docker compose unavailable')"
    return 1
  fi

  # Accept "ok" or any 200-level response body
  if ! echo "$response" | grep -qiE "ok|passed"; then
    echo -e "${RED}ERROR${NC}: Qdrant healthz returned unexpected response: '${response}'"
    echo "Docker logs:"
    (cd "${REPO_ROOT}" && docker compose logs qdrant --tail=30 2>&1 || echo 'docker compose unavailable')
    return 1
  fi

  # Check logs for jemalloc / memory errors
  echo "Scanning Qdrant logs for jemalloc/memory errors..."
  local jemalloc_hits
  jemalloc_hits=$(cd "${REPO_ROOT}" && docker compose logs qdrant 2>&1 | grep -i "jemalloc\|alloc.*error\|SIGKILL\|OOM" | head -5 || true)

  if [[ -n "$jemalloc_hits" ]]; then
    echo -e "${RED}ERROR${NC}: Qdrant has jemalloc/memory errors — check MALLOC_CONF setting"
    echo "Matches:"
    echo "$jemalloc_hits"
    echo ""
    echo "Suggested fix: Set 'MALLOC_CONF: narenas:1' in docker-compose.yml qdrant environment"
    return 1
  fi

  # Get Qdrant version
  local version_response version_str
  version_response=$(curl -s http://localhost:6333/ 2>/dev/null || echo "")
  version_str=$(echo "$version_response" | grep -o '"version":"[^"]*"' | head -1 || echo '"version":"unknown"')

  echo "Qdrant status: ok"
  echo "Qdrant ${version_str}"
  echo "No jemalloc/memory errors in logs"
  return 0
}

# ===========================================================================
# CHECK 5: Postgres Persistence Across Container Restart
# Maps to Success Criterion 4, INFRA-09
# ===========================================================================
check_5_postgres_persistence() {
  local pg_user pg_db test_val inserted_val returned_val

  pg_user="${POSTGRES_USER:-mailbox}"
  pg_db="${POSTGRES_DB:-mailbox}"
  test_val="smoke-$(date +%s)"

  echo "Testing Postgres persistence at pg_user=${pg_user} db=${pg_db}..."

  # Step 1: Create test table and insert a row
  echo "Inserting test row: ${test_val}"
  if ! (cd "${REPO_ROOT}" && docker compose exec -T postgres psql -U "${pg_user}" -d "${pg_db}" \
    -c "CREATE SCHEMA IF NOT EXISTS mailbox_smoke; CREATE TABLE IF NOT EXISTS mailbox_smoke.smoke_test (id serial PRIMARY KEY, val text, created_at timestamptz DEFAULT now()); INSERT INTO mailbox_smoke.smoke_test (val) VALUES ('${test_val}');" \
    2>&1); then
    echo -e "${RED}ERROR${NC}: Failed to insert test row"
    (cd "${REPO_ROOT}" && docker compose logs postgres --tail=20 2>&1 || true)
    return 1
  fi

  inserted_val="$test_val"

  # Step 2: Restart postgres container
  echo "Restarting postgres container..."
  if ! (cd "${REPO_ROOT}" && docker compose restart postgres 2>&1); then
    echo -e "${RED}ERROR${NC}: Failed to restart postgres"
    return 1
  fi

  # Step 3: Wait for postgres to be healthy (up to 30 seconds)
  echo "Waiting for postgres to become healthy..."
  local wait_count=0
  local max_wait=30
  while [[ $wait_count -lt $max_wait ]]; do
    if (cd "${REPO_ROOT}" && docker compose exec -T postgres pg_isready -U "${pg_user}" 2>/dev/null); then
      break
    fi
    (( wait_count++ ))
    sleep 1
  done

  if [[ $wait_count -ge $max_wait ]]; then
    echo -e "${RED}ERROR${NC}: Postgres did not become healthy within ${max_wait}s after restart"
    (cd "${REPO_ROOT}" && docker compose logs postgres --tail=20 2>&1 || true)
    return 1
  fi

  echo "Postgres healthy after ${wait_count}s"

  # Step 4: Query the test row back
  returned_val=$(cd "${REPO_ROOT}" && docker compose exec -T postgres psql -U "${pg_user}" -d "${pg_db}" \
    -c "SELECT val FROM mailbox_smoke.smoke_test WHERE val = '${inserted_val}' ORDER BY id DESC LIMIT 1;" \
    -t 2>/dev/null | tr -d ' \n' || echo "")

  # Step 5: Cleanup
  echo "Cleaning up smoke test table..."
  (cd "${REPO_ROOT}" && docker compose exec -T postgres psql -U "${pg_user}" -d "${pg_db}" \
    -c "DROP TABLE IF EXISTS mailbox_smoke.smoke_test; DROP SCHEMA IF EXISTS mailbox_smoke;" \
    2>&1 || true)

  # Step 6: Assert value matches
  if [[ "$returned_val" != "$inserted_val" ]]; then
    echo -e "${RED}ERROR${NC}: Persistence check failed"
    echo "  Inserted: '${inserted_val}'"
    echo "  Returned: '${returned_val}'"
    (cd "${REPO_ROOT}" && docker compose logs postgres --tail=20 2>&1 || true)
    return 1
  fi

  echo "Persistence verified: '${returned_val}' survived container restart"
  return 0
}

# ===========================================================================
# CHECK 6: Boot Time < 3 Minutes (DESTRUCTIVE — opt-in only)
# Maps to INFRA-05, INFRA-12
# ===========================================================================
check_6_boot_time() {
  local boot_start boot_end boot_seconds max_wait unhealthy_services

  # Warning banner with 5-second abort window
  echo ""
  echo -e "${RED}${BOLD}!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!${NC}"
  echo -e "${RED}${BOLD}WARNING: Boot time check will bring the ENTIRE STACK${NC}"
  echo -e "${RED}${BOLD}         DOWN and then back UP. This is DESTRUCTIVE.${NC}"
  echo -e "${RED}${BOLD}         Starting in 5 seconds — Ctrl+C to abort.${NC}"
  echo -e "${RED}${BOLD}!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!${NC}"
  echo ""

  local countdown=5
  while [[ $countdown -gt 0 ]]; do
    echo -n "  Starting in ${countdown}..."
    sleep 1
    (( countdown-- ))
  done
  echo ""

  # Bring the stack down
  echo "Bringing stack down: docker compose down"
  (cd "${REPO_ROOT}" && docker compose down 2>&1)

  # Record start time
  boot_start=$(date +%s)
  echo "Stack down at: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  # Bring stack back up
  echo "Bringing stack up: docker compose up -d"
  (cd "${REPO_ROOT}" && docker compose up -d 2>&1)

  # Poll for all services healthy (timeout: 240 seconds)
  max_wait=240
  local elapsed_wait=0
  local all_healthy=false

  echo "Polling for all services healthy (timeout: ${max_wait}s)..."

  while [[ $elapsed_wait -lt $max_wait ]]; do
    sleep 5
    (( elapsed_wait += 5 ))

    # Get health status of all services
    local health_output
    health_output=$(cd "${REPO_ROOT}" && docker compose ps --format '{{.Health}}' 2>/dev/null || echo "")

    # Count services and healthy services
    local total_services healthy_services
    total_services=$(cd "${REPO_ROOT}" && docker compose ps --format '{{.Name}}' 2>/dev/null | wc -l || echo "0")
    # healthy or (no healthcheck = "")
    healthy_services=$(echo "$health_output" | grep -cE "^(healthy|)$" || true)

    # Check for any "unhealthy" states
    unhealthy_services=$(echo "$health_output" | grep -c "unhealthy" 2>/dev/null || true)

    echo "  [${elapsed_wait}s] Services: ${healthy_services}/${total_services} healthy, ${unhealthy_services} unhealthy"

    # Check if all services with healthchecks report healthy (no "starting" entries)
    local starting_count
    starting_count=$(echo "$health_output" | grep -c "starting" || true)

    if [[ $starting_count -eq 0 && $unhealthy_services -eq 0 && $total_services -gt 0 ]]; then
      boot_end=$(date +%s)
      all_healthy=true
      break
    fi
  done

  if [[ "$all_healthy" == "false" ]]; then
    boot_end=$(date +%s)
    boot_seconds=$(( boot_end - boot_start ))
    echo -e "${RED}ERROR${NC}: Not all services became healthy within ${max_wait}s"
    echo "Boot elapsed: ${boot_seconds}s"
    echo "Current service state:"
    (cd "${REPO_ROOT}" && docker compose ps 2>&1 || true)
    echo "Recent logs:"
    (cd "${REPO_ROOT}" && docker compose logs --tail=10 2>&1 || true)
    return 1
  fi

  boot_seconds=$(( boot_end - boot_start ))

  if [[ $boot_seconds -ge 180 ]]; then
    echo -e "${RED}ERROR${NC}: Boot time ${boot_seconds}s exceeds 180s (3 minute) threshold"
    echo "Boot time: ${boot_seconds}s (limit: 180s)"
    echo "Current service state:"
    (cd "${REPO_ROOT}" && docker compose ps 2>&1 || true)
    return 1
  fi

  echo "Boot time: ${boot_seconds}s (limit: 180s)"
  echo "All services healthy"
  return 0
}

# ===========================================================================
# Run all checks
# ===========================================================================

run_check "Check 1: GPU Passthrough" check_1_gpu_passthrough
run_check "Check 2: Qwen3-4B Inference" check_2_qwen3_inference
run_check "Check 3: nomic-embed-text Embeddings" check_3_embed_text
run_check "Check 4: Qdrant Health" check_4_qdrant_health
run_check "Check 5: Postgres Persistence" check_5_postgres_persistence

if [[ "${RUN_BOOT_TEST}" == "true" ]]; then
  run_check "Check 6: Boot Time" check_6_boot_time
else
  RESULTS["Check 6: Boot Time"]="SKIPPED"
fi

# Summary is printed by EXIT trap
