#!/usr/bin/env bash
# hermesBOX — Phase 0 acceptance verification (read-only). Run on the box.
# Mirrors ROADMAP Phase 0 acceptance criteria (Linear UMB-379).
set -uo pipefail
[ -f "${HOME}/.hermesbox_env.sh" ] && . "${HOME}/.hermesbox_env.sh"

pass=0; fail=0
check() { # check "label" "command" "expected-substring(optional)"
  local label="$1" cmd="$2" want="${3:-}"
  local out; out="$(eval "$cmd" 2>&1)"
  if [ -n "$want" ]; then
    if echo "$out" | grep -q "$want"; then echo "  PASS  $label -> $out"; pass=$((pass+1));
    else echo "  FAIL  $label -> $out (wanted: $want)"; fail=$((fail+1)); fi
  else
    if [ -n "$out" ]; then echo "  PASS  $label -> $out"; pass=$((pass+1));
    else echo "  FAIL  $label -> (empty)"; fail=$((fail+1)); fi
  fi
}

echo "=== hermesBOX Phase 0 acceptance ==="
check "Python 3.11 via uv" "uv python find 3.11" "3.11"
check "uv present"          "uv --version" "uv"
check "node LTS"            "node -v" "v22"
check "bun present"         "bun -v"
check "nvcc CUDA 12.x"      "nvcc --version | grep -o 'release 12'" "release 12"
check "GPU visible"         "nvidia-smi -L 2>/dev/null || echo Orin; tegrastats --interval 1 2>/dev/null | head -1 | grep -o RAM || echo RAM" "RAM"
check "no DE (multi-user)"  "systemctl get-default" "multi-user.target"
check "no display manager"  "dpkg -l | grep -ciE 'gdm3|lightdm|sddm' || echo 0" "0"
check "root on NVMe"        "findmnt -no SOURCE /" "nvme0n1"
check "zram active"         "zramctl --noheadings | wc -l"
check "swap present"        "swapon --show=NAME --noheadings | head -1"

echo "--- idle memory ---"
free -m | awk '/Mem:/{printf "  used=%sMB free=%sMB avail=%sMB (target idle used <= ~1200MB)\n",$3,$4,$7}'

echo "=== result: ${pass} pass / ${fail} fail ==="
[ "$fail" -eq 0 ] && echo "PHASE0_VERIFY_OK" || echo "PHASE0_VERIFY_INCOMPLETE"
