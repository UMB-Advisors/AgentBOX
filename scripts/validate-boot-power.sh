#!/usr/bin/env bash
# validate-boot-power.sh — MailBox One constraint validation (boot time + power)
#
# MBOX-181 (M5). Measures the two hardware-envelope constraints from the root
# CLAUDE.md "Constraints" section against a real appliance:
#
#   - Boot time: cold boot to fully operational < 3 minutes (180s)
#   - Power:     < 25 W sustained under normal operation
#
# Both measurements require ON-DEVICE tooling (tegrastats reads the Jetson INA
# power rails; systemd-analyze + the boot poll need the appliance's own clock /
# docker). This script therefore runs ON THE APPLIANCE. Invoke it over ssh from
# the workstation, or run it directly on the box.
#
#   ssh mailbox1 'cd ~/mailbox && bash scripts/validate-boot-power.sh --power'
#   ssh mailbox1 'cd ~/mailbox && sudo bash scripts/validate-boot-power.sh --boot'   # DESTRUCTIVE
#
# MODES (pick at least one):
#   --power            Measure sustained power over --duration seconds via
#                      tegrastats (averages the VDD_IN rail in mW). NON-destructive.
#                      Best run while the pipeline is under load — e.g. start
#                      scripts/smoke-pipeline.sh in a loop in another shell, or
#                      pass --with-smoke to drive one classify cycle inline.
#   --boot             DESTRUCTIVE. Power-cycle proxy: `docker compose down`
#                      then `up -d`, timing from up to the first HTTP 200 from
#                      the dashboard health endpoint. For a TRUE cold-boot
#                      number (kernel + JetPack + docker daemon), physically
#                      power-cycle and run with --boot --since-power-on instead
#                      (uses `uptime`/systemd-analyze as the t0). See header NOTE.
#   --with-smoke       (with --power) drive one local classify cycle via
#                      scripts/smoke-pipeline.sh during the power window so the
#                      GPU is actually exercised. Requires the pipeline smoke's
#                      preconditions (active workflows).
#
# OPTIONS:
#   --duration N       Power sample window in seconds (default 300 = 5 min).
#   --interval-ms N    tegrastats sample interval in ms (default 5000).
#   --health-url URL   Boot-readiness probe (default the dashboard health route
#                      on the docker network; see DEFAULT_HEALTH_URL).
#   --since-power-on   (with --boot) compute boot time from system power-on
#                      (`systemd-analyze` / /proc/uptime) instead of compose
#                      down/up. Use after a real physical power-cycle.
#   -h | --help        Show this header.
#
# NOTE — what "cold boot" means here:
#   The CLAUDE.md target is "cold boot to fully operational < 3 min". The
#   honest, full measurement is: physically power the box on, then time until
#   the dashboard health endpoint returns 200. That spans firmware → kernel →
#   JetPack → docker daemon → all 8 compose services healthy. This script's
#   --boot (compose down/up) measures ONLY the container-stack portion and is a
#   useful fast proxy / regression guard; it will under-report vs a true cold
#   boot. For the acceptance-grade number, physically power-cycle and run
#   `--boot --since-power-on` as the FIRST thing after login. Document both in
#   docs/runbook/production-validation.md.
#
# EXIT CODES (gate-friendly):
#   0  all requested measurements within target
#   1  a measurement exceeded its target (boot ≥180s, or power ≥25W)
#   2  setup error (tooling missing, not on a Jetson, docker unavailable, etc.)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Health endpoint on the docker network. The dashboard runs under basePath
# /dashboard, so the live status route is /dashboard/api/system/status (returns
# 200 once the dashboard + Postgres are up). Reachable from the host via the
# dashboard container's published port if present, else via `docker exec`.
DEFAULT_HEALTH_URL="http://127.0.0.1:3001/dashboard/api/system/status"

# ───────────────────────── arg parse ─────────────────────────
DO_POWER=false
DO_BOOT=false
WITH_SMOKE=false
SINCE_POWER_ON=false
DURATION=300
INTERVAL_MS=5000
HEALTH_URL="$DEFAULT_HEALTH_URL"

usage() { sed -n '2,62p' "$0"; exit 2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --power)          DO_POWER=true; shift ;;
    --boot)           DO_BOOT=true; shift ;;
    --with-smoke)     WITH_SMOKE=true; shift ;;
    --since-power-on) SINCE_POWER_ON=true; shift ;;
    --duration)       DURATION="$2"; shift 2 ;;
    --interval-ms)    INTERVAL_MS="$2"; shift 2 ;;
    --health-url)     HEALTH_URL="$2"; shift 2 ;;
    -h|--help)        usage ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done

if ! $DO_POWER && ! $DO_BOOT; then
  echo "ERROR: pick at least one of --power / --boot" >&2
  usage
fi

BOOT_TARGET_S=180
POWER_TARGET_MW=25000   # 25 W

pretty() {
  local c="$1"; shift
  case "$c" in
    green)  printf '\033[32m%s\033[0m\n' "$*" ;;
    red)    printf '\033[31m%s\033[0m\n' "$*" ;;
    yellow) printf '\033[33m%s\033[0m\n' "$*" ;;
    blue)   printf '\033[34m%s\033[0m\n' "$*" ;;
    *)      echo "$*" ;;
  esac
}

OVERALL_RC=0

pretty blue "═══ MailBox One — boot + power validation ═══"
pretty blue "Host: $(hostname)   $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ───────────────────────── POWER ─────────────────────────
measure_power() {
  pretty blue ""
  pretty blue "── Power: sustained VDD_IN over ${DURATION}s (target <25W) ──"

  if ! command -v tegrastats >/dev/null 2>&1; then
    pretty red "FATAL: tegrastats not found. This must run on the Jetson appliance."
    return 2
  fi

  local logfile samples
  logfile="$(mktemp /tmp/tegrastats.XXXXXX.log)"

  # tegrastats prints a line per interval; VDD_IN reports the total board input
  # power as "VDD_IN <inst>mW/<avg>mW". We average the instantaneous field.
  tegrastats --interval "$INTERVAL_MS" --logfile "$logfile" &
  local ts_pid=$!
  # Ensure tegrastats dies even if we're killed mid-window.
  trap 'kill "$ts_pid" 2>/dev/null || true' EXIT

  if $WITH_SMOKE; then
    pretty yellow "  driving one local classify cycle via smoke-pipeline.sh (load)…"
    # local invocation; failure here doesn't fail the power measurement — we
    # just want GPU activity in the window.
    bash "${SCRIPT_DIR}/smoke-pipeline.sh" --host local --timeout "$DURATION" \
      >/tmp/smoke-during-power.log 2>&1 || \
      pretty yellow "  (smoke cycle returned non-zero; power sampling continues)"
  fi

  # Sleep out the remainder of the window (foreground sleep is fine on-device).
  sleep "$DURATION"
  kill "$ts_pid" 2>/dev/null || true
  trap - EXIT
  wait "$ts_pid" 2>/dev/null || true

  # Average the instantaneous VDD_IN mW field across all samples.
  local avg_mw
  avg_mw=$(grep -oE 'VDD_IN [0-9]+mW' "$logfile" \
    | grep -oE '[0-9]+' \
    | awk '{ sum += $1; n++ } END { if (n>0) printf "%d", sum/n; else print 0 }')
  samples=$(grep -cE 'VDD_IN [0-9]+mW' "$logfile" || echo 0)

  if [[ "${samples:-0}" -eq 0 ]]; then
    pretty red "FATAL: no VDD_IN samples captured in $logfile — tegrastats format?"
    pretty red "  first line: $(head -1 "$logfile" 2>/dev/null)"
    return 2
  fi

  local avg_w
  avg_w=$(awk -v mw="$avg_mw" 'BEGIN { printf "%.2f", mw/1000 }')
  pretty blue "  samples=$samples  avg VDD_IN=${avg_mw}mW (${avg_w}W)  log=$logfile"

  if [[ "$avg_mw" -lt "$POWER_TARGET_MW" ]]; then
    pretty green "  ✓ sustained power ${avg_w}W < 25W target"
    return 0
  else
    pretty red "  ✗ sustained power ${avg_w}W ≥ 25W target"
    return 1
  fi
}

# ───────────────────────── BOOT ─────────────────────────
poll_health() {
  # Returns 0 once HEALTH_URL returns HTTP 2xx. Tries host curl/wget first,
  # then falls back to probing inside the dashboard container.
  local code
  if command -v curl >/dev/null 2>&1; then
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH_URL" 2>/dev/null || echo 000)
  elif command -v wget >/dev/null 2>&1; then
    if wget -q -O /dev/null --timeout=5 "$HEALTH_URL" 2>/dev/null; then code=200; else code=000; fi
  else
    # No host HTTP client — probe from inside the dashboard container.
    if docker exec mailbox-dashboard wget -q -O /dev/null --timeout=5 \
        "http://127.0.0.1:3001/dashboard/api/system/status" 2>/dev/null; then
      code=200
    else
      code=000
    fi
  fi
  [[ "$code" =~ ^2 ]]
}

measure_boot() {
  pretty blue ""
  pretty blue "── Boot: time to first healthy dashboard 200 (target <3 min / 180s) ──"

  if ! docker compose version >/dev/null 2>&1; then
    pretty red "FATAL: docker compose unavailable."
    return 2
  fi

  local t0 t1 elapsed
  if $SINCE_POWER_ON; then
    # t0 = system power-on. Use /proc/uptime (seconds since boot) — the appliance
    # has been up for `uptime` seconds, so subtract that from now to get t0.
    local up_s
    up_s=$(awk '{printf "%d", $1}' /proc/uptime)
    t0=$(( $(date +%s) - up_s ))
    pretty yellow "  --since-power-on: t0 = system power-on ($(date -u -d "@$t0" +%H:%M:%SZ 2>/dev/null || echo "uptime ${up_s}s ago"))"
    pretty yellow "  systemd boot breakdown: $(systemd-analyze 2>/dev/null | head -1 || echo 'systemd-analyze unavailable')"
  else
    pretty yellow "  WARNING: compose down/up proxy — UNDER-reports vs true cold boot."
    pretty yellow "           This brings the FULL stack down then up. Ctrl+C in 5s to abort."
    sleep 5
    ( cd "$REPO_ROOT" && docker compose down ) || { pretty red "FATAL: compose down failed"; return 2; }
    t0=$(date +%s)
    ( cd "$REPO_ROOT" && docker compose up -d --remove-orphans ) || { pretty red "FATAL: compose up failed"; return 2; }
  fi

  pretty blue "  polling ${HEALTH_URL} for HTTP 200 (timeout 300s)…"
  local waited=0 max=300
  while [[ $waited -lt $max ]]; do
    if poll_health; then
      t1=$(date +%s)
      break
    fi
    sleep 5
    waited=$(( waited + 5 ))
    printf '\r  …waiting %ss' "$waited"
  done
  echo ""

  if [[ -z "${t1:-}" ]]; then
    pretty red "  ✗ dashboard health never returned 200 within ${max}s"
    ( cd "$REPO_ROOT" && docker compose ps 2>&1 || true )
    return 1
  fi

  elapsed=$(( t1 - t0 ))
  pretty blue "  boot-to-operational: ${elapsed}s"
  if [[ $elapsed -lt $BOOT_TARGET_S ]]; then
    pretty green "  ✓ ${elapsed}s < 180s target"
    return 0
  else
    pretty red "  ✗ ${elapsed}s ≥ 180s target"
    return 1
  fi
}

# ───────────────────────── run ─────────────────────────
if $DO_POWER; then
  rc=0; measure_power || rc=$?
  [[ $rc -eq 2 ]] && exit 2
  [[ $rc -ne 0 ]] && OVERALL_RC=1
fi

if $DO_BOOT; then
  rc=0; measure_boot || rc=$?
  [[ $rc -eq 2 ]] && exit 2
  [[ $rc -ne 0 ]] && OVERALL_RC=1
fi

pretty blue ""
if [[ $OVERALL_RC -eq 0 ]]; then
  pretty green "═══ All requested validations within target ═══"
else
  pretty red "═══ One or more validations exceeded target ═══"
fi
exit $OVERALL_RC
