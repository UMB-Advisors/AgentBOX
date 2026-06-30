#!/usr/bin/env bash
# Reset a box to the pre-onboarding state so the setup AP fires again on the next
# boot. Run ON THE BOX. Does NOT uninstall anything (use onboarding-test-teardown.sh
# for that) — it just clears state + the saved network and disables WiFi
# autoconnect, then you reboot.
#
# NOTE: this disables autoconnect on saved WiFi but does NOT disconnect now, so an
# SSH session over WiFi survives until you `sudo reboot`.
set -uo pipefail
log(){ printf '\n\033[1;36m[reset]\033[0m %s\n' "$*"; }

log "clearing onboarding state + AP artifacts"
rm -f "$HOME/.hermes/onboarding.json"
sudo rm -f /var/lib/agentbox/onboarding-complete \
           /var/lib/agentbox/onboarding.env \
           /var/lib/agentbox/wifi-scan.cache

log "deleting the saved home-WiFi profile (agentbox-home)"
sudo nmcli connection delete agentbox-home >/dev/null 2>&1 || true

log "disabling autoconnect on saved WiFi so the box boots offline (AP will fire)"
nmcli -t -f NAME,TYPE connection show | awk -F: '$2=="802-11-wireless"{print $1}' | while read -r c; do
  [ "$c" = "agentbox-onboarding-ap" ] && continue
  sudo nmcli connection modify "$c" connection.autoconnect no 2>/dev/null \
    && log "  autoconnect off: $c"
done

cat <<EOF

Reset complete. Now reboot to bring the AP up:

  sudo reboot

After ~90s: join AgentBOX-Setup-XXXX on your phone and open
http://10.42.0.1:9200/onboarding
EOF
