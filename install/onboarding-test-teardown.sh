#!/usr/bin/env bash
# Wipe the AgentBOX onboarding install completely — units, script, sudoers, state,
# and the NetworkManager profiles we created. Run ON THE BOX. Use this to start
# fresh (e.g. after the messy hand-install from a prior session), then re-run
# onboarding-test-setup.sh.
#
# Does NOT delete the git clones (this script lives inside one). To also remove
# those, see the note printed at the end. Does NOT touch your real home WiFi
# connection — only the agentbox-* profiles.
set -uo pipefail
log(){ printf '\n\033[1;36m[teardown]\033[0m %s\n' "$*"; }

log "stopping + removing the sidecar user service"
systemctl --user disable --now agentbox-sidecar 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/agentbox-sidecar.service"
systemctl --user daemon-reload 2>/dev/null || true

log "stopping + removing the onboarding-AP unit + script"
sudo systemctl disable --now agentbox-onboarding-ap.service 2>/dev/null || true
sudo rm -f /etc/systemd/system/agentbox-onboarding-ap.service \
           /usr/local/sbin/agentbox-onboarding-ap
sudo systemctl daemon-reload

log "removing sudoers rule + state dir"
sudo rm -f /etc/sudoers.d/agentbox-onboarding-nmcli
sudo rm -rf /var/lib/agentbox

log "removing the NetworkManager profiles we created"
sudo nmcli connection delete agentbox-onboarding-ap 2>/dev/null || true
sudo nmcli connection delete agentbox-home 2>/dev/null || true

log "clearing onboarding state"
rm -f "$HOME/.hermes/onboarding.json"

cat <<EOF

Teardown complete — all onboarding artifacts removed.

To also delete the code clones and start from a clean checkout:
  rm -rf ~/AgentBOX ~/agentbox-sidecar
then re-clone both branches and run install/onboarding-test-setup.sh.

If you want WiFi autoconnect back on your normal network:
  sudo nmcli connection modify "<your-wifi>" connection.autoconnect yes
EOF
