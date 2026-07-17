#!/usr/bin/env bash
# demo-reset.sh — reset a PROVISIONED bench/demo box back to the pre-onboarding
# (first-boot / OOBE) state so a developer can re-demo or re-test the phone
# onboarding flow from scratch. Run ON THE BOX.
#
# THIS IS A DEVELOPER TOOL — a demo/debug/test reset, NOT a ship-grade factory
# wipe. It deliberately PRESERVES developer access + the installed stack so you
# can keep working on the box:
#   KEEPS: SSH keys/authorized_keys, BOX_PASS, the provisioning + nmcli sudoers
#          rules, Tailscale, the git remote, the Node/pnpm/uv toolchain, the
#          sidecar + MailBOX stack + pulled models, the onboarding-AP unit,
#          google_client_secret.json (the OAuth *app* credential a dev drops in),
#          and HERMES_MAIL_SECRET_KEY (the at-rest mail-secret key).
#   CLEARS (default): the OOBE state (onboarding.json + /var/lib/agentbox markers
#          + any encrypted pending mailbox creds), the saved home-WiFi + its
#          autoconnect (so the setup AP fires again on reboot), and any CONNECTED
#          mail/Gmail accounts (google_accounts/, google_token.json, mail_accounts/).
#   CLEARS (--wipe-mail-data): ALSO the MailBOX data plane (Postgres email/drafts/
#          classification + Qdrant RAG), by delegating to the stack's own
#          scripts/factory-reset.sh --keep-host-identity --no-bootstrap (Ollama
#          model weights are preserved by that script).
#
# After it runs, reboot (or pass --reboot): the box comes up broadcasting the
# setup AP and the wizard at http://10.42.0.1:9200/onboarding starts from scratch
# — exactly what an end user sees on first boot.
#
# Usage:
#   install/demo-reset.sh [--dry-run] [--wipe-mail-data] [--reboot] [--yes]
#     --dry-run         Print the blast radius and touch nothing.
#     --wipe-mail-data  Also wipe the MailBOX email/drafts/RAG data plane.
#     --reboot          `sudo reboot` at the end (into the setup AP).
#     --yes             Skip the interactive "type RESET" confirmation.
#
# Related: onboarding-test-reset.sh (ONLY re-arm the AP, keep accounts);
#          onboarding-test-teardown.sh (remove the stack/toolchain to re-test the
#          installer from scratch — a much heavier, dev-only teardown).
#
# NOT a customer-ship sanitizer: it intentionally does NOT drop the NOPASSWD
# provisioning sudoers, rotate BOX_PASS/secrets, scrub the git-remote token, or
# reset host identity — a shipped box needs all of that; a dev box needs none of it.
set -uo pipefail

DRY=0; WIPE_DATA=0; REBOOT=0; YES=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --wipe-mail-data) WIPE_DATA=1 ;;
    --reboot) REBOOT=1 ;;
    --yes|-y) YES=1 ;;
    -h|--help) sed -n '2,45p' "$0"; exit 0 ;;
    *) echo "demo-reset: unknown arg '$a' (see --help)" >&2; exit 2 ;;
  esac
done

log(){ printf '\n\033[1;36m[demo-reset]\033[0m %s\n' "$*"; }
warn(){ printf '\n\033[1;33m[demo-reset] WARN:\033[0m %s\n' "$*" >&2; }
die(){ printf '\n\033[1;31m[demo-reset] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }
# Execute a command, or just print it under --dry-run. Runs args directly (no eval),
# so paths with spaces are safe; pipelines/redirections are handled inline instead.
run(){ if [ "$DRY" = 1 ]; then printf '  DRY: %s\n' "$*"; else "$@"; fi; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
STATE_DIR="${AGENTBOX_STATE_DIR:-/var/lib/agentbox}"
STACK_DIR="${STACK_DIR:-$HOME/mailbox}"

# --- safety: refuse on a known production/customer host --------------------------
# A dev demo box is the intended target; this guard stops an accidental run against
# a real deployment. Override with DEMO_RESET_ALLOW_PROD=1.
PROD_HOSTS="${DEMO_RESET_PROD_HOSTS:-mailbox1 mailbox2}"
ALLOW_PROD="${DEMO_RESET_ALLOW_PROD:-0}"
host="$(hostname 2>/dev/null || echo unknown)"
ts_id=""
command -v tailscale >/dev/null 2>&1 && ts_id="$(tailscale status --self --json 2>/dev/null | grep -oE '"DNSName":"[^"]*"' | head -1 || true)"
if [ "$ALLOW_PROD" != 1 ]; then
  for p in $PROD_HOSTS; do
    if [ "$host" = "$p" ] || printf '%s' "$ts_id" | grep -qi "$p"; then
      die "host '$host' looks like a PRODUCTION box (matched '$p'). This is a demo/test reset. If you REALLY mean it, re-run with DEMO_RESET_ALLOW_PROD=1."
    fi
  done
fi

# --- blast radius (always printed) -----------------------------------------------
cat <<EOF

$( [ "$DRY" = 1 ] && echo '=== DRY RUN — nothing will be changed ===' )
demo-reset will reset this box ($host) to the pre-onboarding (first-boot) state.

WILL CLEAR:
  OOBE state
    - $HERMES_HOME/onboarding.json               (wizard state + pending mailbox creds)
    - $STATE_DIR/{onboarding-complete,onboarding.env,wifi-scan.cache}
  Saved WiFi (so the setup AP fires again on next boot)
    - NetworkManager 'agentbox-home' profile deleted; autoconnect disabled on other WiFi
  Connected mail/Gmail accounts
    - $HERMES_HOME/google_accounts/   $HERMES_HOME/google_token.json   $HERMES_HOME/mail_accounts/
$( [ "$WIPE_DATA" = 1 ] && echo "  MailBOX data plane (--wipe-mail-data)
    - Postgres email/drafts/classification + Qdrant RAG (via $STACK_DIR/scripts/factory-reset.sh)" )

WILL KEEP (developer access + installed stack):
  SSH access, BOX_PASS, sudoers (provisioning + nmcli), Tailscale, git remote,
  Node/pnpm/uv toolchain, sidecar + MailBOX stack + Ollama models,
  google_client_secret.json (OAuth app cred), HERMES_MAIL_SECRET_KEY, the onboarding-AP unit.
$( [ "$WIPE_DATA" != 1 ] && echo "  MailBOX email/drafts/RAG data (pass --wipe-mail-data to also clear it)" )
EOF

if [ "$DRY" = 1 ]; then
  log "dry run complete — no changes made."
  [ -x "$STACK_DIR/scripts/factory-reset.sh" ] || [ "$WIPE_DATA" != 1 ] || warn "--wipe-mail-data requested but $STACK_DIR/scripts/factory-reset.sh not found on this box"
  exit 0
fi

# --- confirm ---------------------------------------------------------------------
if [ "$YES" != 1 ]; then
  printf '\nType RESET to proceed (anything else aborts): '
  read -r ans
  [ "$ans" = "RESET" ] || die "aborted (got '$ans')."
fi

# --- 1. OOBE state: clear markers so the setup AP fires on next boot --------------
# (Same clears as onboarding-test-reset.sh, inlined so --dry-run is honored uniformly.)
log "clearing OOBE state (onboarding.json + /var/lib/agentbox markers)"
run rm -f "$HERMES_HOME/onboarding.json"
run sudo rm -f "$STATE_DIR/onboarding-complete" "$STATE_DIR/onboarding.env" "$STATE_DIR/wifi-scan.cache"

# --- 2. Saved WiFi: delete home profile + disable autoconnect (AP fires) ----------
log "deleting saved home-WiFi (agentbox-home) + disabling WiFi autoconnect"
run sudo nmcli connection delete agentbox-home >/dev/null 2>&1 || true
nmcli -t -f NAME,TYPE connection show 2>/dev/null | awk -F: '$2=="802-11-wireless"{print $1}' | while read -r c; do
  [ "$c" = "agentbox-onboarding-ap" ] && continue
  run sudo nmcli connection modify "$c" connection.autoconnect no >/dev/null 2>&1 || true
done

# --- 3. Connected accounts: clear so "connect mailbox" starts fresh ---------------
# KEEP google_client_secret.json (the OAuth app credential) so a dev needn't re-drop it.
log "clearing connected mail/Gmail accounts (keeping the OAuth app credential)"
run rm -rf "$HERMES_HOME/google_accounts"
run rm -f  "$HERMES_HOME/google_token.json"
run rm -rf "$HERMES_HOME/mail_accounts"

# --- 4. (optional) MailBOX data plane -------------------------------------------
if [ "$WIPE_DATA" = 1 ]; then
  fr="$STACK_DIR/scripts/factory-reset.sh"
  if [ -x "$fr" ]; then
    log "wiping MailBOX data plane (email/drafts/RAG) via factory-reset.sh --keep-host-identity"
    sudo RESET=YES_I_AM_SURE bash "$fr" --keep-host-identity --no-bootstrap \
      || warn "factory-reset.sh returned non-zero — inspect the stack manually (docker compose ps)"
  else
    warn "--wipe-mail-data requested but $fr not found — skipping the data-plane wipe"
  fi
fi

# --- 5. make the running sidecar reflect the cleared state ------------------------
# (A reboot would do this too; restart now so a no-reboot run is already fresh.)
if [ "$REBOOT" != 1 ]; then
  log "restarting the sidecar so the wizard reflects the reset"
  systemctl --user restart agentbox-sidecar 2>/dev/null \
    || warn "could not restart agentbox-sidecar (systemctl --user status agentbox-sidecar)"
fi

# --- 6. done ---------------------------------------------------------------------
if [ "$REBOOT" = 1 ]; then
  log "rebooting into the setup AP in 5s (Ctrl-C to cancel)..."
  sleep 5
  sudo reboot
else
  cat <<EOF

════════════════════════════════════════════════════════════
 Reset complete. Reboot to bring up the setup AP:

   sudo reboot

 After ~90s: join AgentBOX-Setup-XXXX on your phone and open
 http://10.42.0.1:9200/onboarding — the wizard starts from scratch.
════════════════════════════════════════════════════════════
EOF
fi
