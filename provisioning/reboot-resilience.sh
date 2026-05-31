#!/usr/bin/env bash
# hermesBOX — Phase 7 reboot-resilience test. Run from the WORKSTATION (not the box).
# Reboots the appliance, waits for it to return over Tailscale SSH (~4 min budget),
# then runs the boot-to-ready check remotely with ZERO manual steps in between.
# This is the §8 Phase 7 "cold boot -> operational, zero manual steps" acceptance.
#
# MUTATING + DISRUPTIVE: it reboots the box. Do not run mid-conversation unless that
# is exactly the power-pull recovery you are testing. Idempotent in effect (a reboot),
# but obviously not safe to spam.
set -uo pipefail

HOST="${HERMESBOX_HOST:-mailbox@mailbox2.tail377a9a.ts.net}"
SSH="ssh -o BatchMode=yes -o ConnectTimeout=20 -o StrictHostKeyChecking=accept-new"
REMOTE_DIR="${HERMESBOX_REMOTE_DIR:-/home/mailbox/hermesbox/provisioning}"
WAIT_BUDGET_S="${WAIT_BUDGET_S:-360}"   # Tailscale brings SSH back in ~4 min; budget 6.
POLL_S=10
log(){ printf '\n\033[1;36m[reboot-test]\033[0m %s\n' "$*"; }

# ssh wrapper with one retry on the flaky exit-255 (per project notes)
rssh(){ $SSH "$HOST" "$@" || { sleep 3; $SSH "$HOST" "$@"; }; }

log "Pre-reboot: capture uptime + system state"
PRE_BOOT="$(rssh 'cut -d. -f1 /proc/uptime' 2>/dev/null || echo unknown)"
echo "  pre-reboot uptime(s): ${PRE_BOOT}"
rssh 'systemctl is-system-running 2>&1; echo "mem $(free -m | awk "/Mem:/{print \$3}")MB used"' || true

log "Issuing reboot (passwordless sudo)…"
# `reboot` drops the connection; tolerate the resulting non-zero exit.
$SSH "$HOST" 'sudo systemctl reboot' >/dev/null 2>&1 || true

log "Waiting for the box to go DOWN first (avoid racing the pre-reboot sshd)…"
t=0
while [ "$t" -lt 60 ]; do
  if ! $SSH -o ConnectTimeout=5 "$HOST" true >/dev/null 2>&1; then echo "  box is down"; break; fi
  t=$((t+5)); sleep 5
done

log "Waiting for SSH to return (budget ${WAIT_BUDGET_S}s)…"
t=0; back=0
while [ "$t" -lt "$WAIT_BUDGET_S" ]; do
  if $SSH -o ConnectTimeout=8 "$HOST" true >/dev/null 2>&1; then back=1; break; fi
  t=$((t+POLL_S)); printf '  …%ss\n' "$t"; sleep "$POLL_S"
done
if [ "$back" -ne 1 ]; then
  echo "  FAIL: box did not return to SSH within ${WAIT_BUDGET_S}s"
  echo "REBOOT_RESILIENCE_INCOMPLETE"; exit 1
fi

POST_BOOT="$(rssh 'cut -d. -f1 /proc/uptime' 2>/dev/null || echo unknown)"
log "Box is back. Post-reboot uptime(s): ${POST_BOOT} (lower than pre = real reboot confirmed)"

log "Time-to-ready: poll until system is no longer 'starting'"
t=0; ready=0
while [ "$t" -lt 120 ]; do
  st="$(rssh 'systemctl is-system-running' 2>/dev/null | tr -d '[:space:]' || true)"
  if [ "$st" = "running" ] || [ "$st" = "degraded" ]; then ready=1; echo "  system settled: ${st} (after ~${POST_BOOT}s uptime + ${t}s poll)"; break; fi
  t=$((t+POLL_S)); sleep "$POLL_S"
done
[ "$ready" -eq 1 ] || echo "  WARN: system never left 'starting' within 120s"

log "Running boot-to-ready check on the box (zero manual steps)…"
if rssh "test -x ${REMOTE_DIR}/verify-phase7.sh"; then
  rssh "${REMOTE_DIR}/verify-phase7.sh"
else
  echo "  verify-phase7.sh not found at ${REMOTE_DIR}; running inline core checks:"
  rssh 'systemctl is-system-running; systemctl --failed --no-pager; \
        curl -fsS 127.0.0.1:11434/api/version || echo "ollama down"; \
        systemctl is-active hermes-gateway.service 2>/dev/null || true'
fi

log "Reboot-resilience test complete. Review PASS/FAIL above + gbrain integrity (RUNBOOK §Recover)."
echo "REBOOT_RESILIENCE_DONE"
