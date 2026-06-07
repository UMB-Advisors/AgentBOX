#!/usr/bin/env bash
# CANONICAL: vendor/thumbox-common/scripts/jetson-bootstrap-ssh.sh
# (github.com/UMB-Advisors/thumbox-appliance-common, pinned v0.1.0)
#
# This file is kept here as a self-contained copy intentionally — it runs
# at FIRST BOOT on a freshly-flashed Jetson, BEFORE the operator has SSH
# access to run `git submodule update --init`. The wrapper pattern used by
# bin/rotate-basic-auth doesn't apply.
#
# To re-sync from canonical (e.g. after bumping vendor/thumbox-common):
#   cp vendor/thumbox-common/scripts/jetson-bootstrap-ssh.sh scripts/jetson-bootstrap-ssh.sh
#   # then commit with a note about which canonical version was synced.
#
# Mailbox Jetson — SSH bootstrap for a freshly-flashed appliance.
#
# Run this on the Jetson after SDK Manager's first-run wizard completes and
# you've logged in at the desktop or console. When it finishes the operator
# workstation (bob@bob-TB250-BTC) can SSH in passwordless, and the script
# prints the IP + MAC the workstation needs to find the box on the LAN.
#
# Usage on the Jetson (after copying this file off the USB stick):
#   sudo bash ./jetson-bootstrap-ssh.sh
#
# Idempotent — safe to re-run.

set -euo pipefail

# Workstation operator pubkey (bob@bob-TB250-BTC, ~/.ssh/id_ed25519.pub).
# This is the same key trusted by mailbox1.
WORKSTATION_PUBKEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKrEBRnpLLW4YPrw5pjpVaD0citJUSA3G3k0wCErDsjO bob@bob-TB250-BTC"

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: must run with sudo. Try: sudo bash $0" >&2
  exit 1
fi

USER_NAME="${SUDO_USER:-}"
if [[ -z "$USER_NAME" || "$USER_NAME" == "root" ]]; then
  echo "ERROR: \$SUDO_USER not set to a real user." >&2
  echo "       Run as: sudo bash $0   (not from inside a 'sudo su' shell)" >&2
  exit 1
fi
USER_HOME="$(getent passwd "$USER_NAME" | cut -d: -f6)"

echo "[1/4] ensuring openssh-server is installed"
if dpkg -s openssh-server >/dev/null 2>&1; then
  echo "      already installed"
else
  apt-get update -y
  apt-get install -y openssh-server
fi

echo "[2/4] enabling + starting sshd"
systemctl enable --now ssh

echo "[3/4] trusting workstation pubkey for user '$USER_NAME'"
install -d -m 700 -o "$USER_NAME" -g "$USER_NAME" "$USER_HOME/.ssh"
AK="$USER_HOME/.ssh/authorized_keys"
touch "$AK"
chmod 600 "$AK"
chown "$USER_NAME:$USER_NAME" "$AK"
if grep -qF "$WORKSTATION_PUBKEY" "$AK"; then
  echo "      key already present — no change"
else
  echo "$WORKSTATION_PUBKEY" >> "$AK"
  echo "      key added"
fi

# Open SSH on ufw if it happens to be active. JetPack defaults to ufw inactive,
# so this is normally a no-op, but covers the case where someone's locked it down.
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  echo "      ufw is active — opening OpenSSH"
  ufw allow OpenSSH >/dev/null
fi

echo "[4/4] handoff info"
echo
echo "================== JETSON HANDOFF =================="
echo "login user:  $USER_NAME"
echo "hostname:    $(hostname)"
echo "kernel:      $(uname -r) ($(uname -m))"
if [[ -f /etc/nv_tegra_release ]]; then
  echo "jetpack:     $(head -1 /etc/nv_tegra_release | sed 's/^# //')"
fi
echo "ssh:         $(systemctl is-active ssh)"
echo
echo "IPv4 addresses (workstation will SSH to one of these):"
ip -o -4 addr show scope global | awk '{printf "  %-14s %s\n", $2, $4}'
echo
echo "Network MACs (workstation looks for OUI 4c:bb:47 = NVIDIA):"
for f in /sys/class/net/*/address; do
  iface="$(basename "$(dirname "$f")")"
  [[ "$iface" == lo ]] && continue
  printf "  %-14s %s\n" "$iface" "$(cat "$f")"
done
echo "===================================================="
echo
echo "Workstation operator: connect with"
echo "  ssh ${USER_NAME}@<one-of-the-ipv4-addresses-above>"
echo "(should be passwordless on the first try)"
