#!/usr/bin/env bash
# AgentBOX — first-run onboarding WiFi access point (bring-up / teardown / status).
#
# Purpose: a freshly-flashed box that is NOT yet on a network broadcasts its own
# WiFi AP so an operator can join from a phone and drive the setup wizard
# (sidecar :9200) to pick which WiFi the box joins. See:
#   docs/onboarding-wifi-ap-provisioning.v0.1.0.md
#
# HARDWARE REALITY (probed 2026-06-25, fleet-wide): the RTL8822CE / rtl8822ce
# driver supports AP mode but NOT concurrent AP+STA ("interface combinations are
# not supported"). So a single radio is AP *xor* station. This script therefore
# implements the agreed uplink model:
#   (A) ethernet carrier present  -> bring the AP up and LEAVE it up; internet
#       rides ethernet, the wlan radio is AP-only, no disconnect ever.
#   (B) no ethernet carrier        -> bring the AP up for config only; the actual
#       WiFi join (which DROPS this AP) is performed later by the sidecar's
#       /api/network/join (P2) and triggers the "reconnect your phone" handoff.
# The chosen mode is written to the state file so the sidecar knows which UX to run.
#
# MUTATING (touches NetworkManager). Idempotent: re-running `up` reuses the
# existing hotspot connection; `down` is safe if nothing is up. Run as root (the
# systemd unit does); `nmcli` AP ops require it.
#
# Usage:  35-onboarding-ap.sh {up|down|status}
set -uo pipefail

STATE_DIR="/var/lib/agentbox"
DONE_MARKER="${STATE_DIR}/onboarding-complete"   # sidecar writes this when stage=live
PSK_FILE="${STATE_DIR}/ap.psk"                    # persisted AP passphrase (0600)
STATE_FILE="${STATE_DIR}/onboarding-ap.state"     # last bring-up facts, read by sidecar
ENV_FILE="${STATE_DIR}/onboarding.env"            # bind override sourced by agentbox-sidecar.service
SCAN_CACHE="${STATE_DIR}/wifi-scan.cache"         # nearby networks captured BEFORE the AP (single radio can't scan while hosting)
HOTSPOT_CON="agentbox-onboarding-ap"              # NM connection id we own
AP_IP="10.42.0.1"                                  # NM `shared` method gateway
SIDECAR_UNIT="agentbox-sidecar.service"           # user unit serving the wizard on :9200
SIDECAR_PORT="9200"                                # sidecar HTTP port (captive :80 redirect target)
CAPTIVE_DNS_CONF="/etc/NetworkManager/dnsmasq-shared.d/agentbox-captive.conf"  # DNS hijack drop-in (G15)
# Open AP (no passphrase) when set — simplest join, weakest security. The auth
# model is still an open product decision (design doc §6); default is WPA2.
AP_OPEN="${AGENTBOX_AP_OPEN:-0}"

log(){ printf '\n\033[1;36m[onboarding-ap]\033[0m %s\n' "$*"; }

# First wifi device NetworkManager knows about (empty if the box has no radio).
wlan_iface(){ nmcli -t -f DEVICE,TYPE device 2>/dev/null | awk -F: '$2=="wifi"{print $1; exit}'; }

# Does the box already have a working internet uplink? If so we MUST NOT bring up
# the AP: on a single-radio box that would drop the box's own WiFi (and its
# Tailscale-over-WiFi), and there is no need for a setup hotspot when the operator
# can reach the wizard over the existing network (via <hostname>.local). This is
# the core "AP only when truly offline" guard.
has_internet(){ [ "$(nmcli -t -f CONNECTIVITY general status 2>/dev/null)" = "full" ]; }

# Is any *physical* ethernet link carrying (cable plugged + up)? Skips virtual
# (veth/docker/bridge/tailscale) interfaces by only trusting /sys device-backed NICs.
eth_has_carrier(){
  local i
  for i in /sys/class/net/*; do
    [ -e "$i/device" ] || continue                       # real NIC only
    case "$(basename "$i")" in wl*|p2p*) continue;; esac  # skip wifi
    [ "$(cat "$i/carrier" 2>/dev/null || echo 0)" = "1" ] && return 0
  done
  return 1
}

# Stable, human-friendly AP suffix so multiple boxes don't collide on one SSID.
ap_ssid(){
  local id
  id="$(cat /etc/machine-id 2>/dev/null | tail -c 5 | tr -d '\n')"
  printf 'AgentBOX-Setup-%s' "${id:-0000}"
}

# Read (or generate-and-persist) the AP passphrase. 12 hex chars; printable on a label.
ap_psk(){
  if [ -s "$PSK_FILE" ]; then cat "$PSK_FILE"; return; fi
  install -d -m 0755 "$STATE_DIR"
  local psk; psk="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-12)"
  printf '%s' "$psk" > "$PSK_FILE"; chmod 0600 "$PSK_FILE"
  printf '%s' "$psk"
}

write_state(){ # $1=mode(A|B|none) $2=ssid $3=note
  install -d -m 0755 "$STATE_DIR"
  cat > "$STATE_FILE" <<EOF
mode=$1
ssid=$2
ap_ip=${AP_IP}
auth=$([ "$AP_OPEN" = "1" ] && echo open || echo wpa2)
note=$3
EOF
}

# Flip the sidecar to bind 0.0.0.0 so the wizard is reachable at AP_IP:9200.
# The sidecar is a *user* unit; agentbox-sidecar.service sources ENV_FILE via
# `EnvironmentFile=-`, so writing it is enough for a fresh boot (the system AP
# unit orders before the user manager). For the race where the sidecar already
# started bound to loopback, we additionally attempt a best-effort user-scoped
# restart; if that isn't possible we just log the manual command (G2).
flip_sidecar_bind(){
  install -d -m 0775 "$STATE_DIR"
  printf 'SIDECAR_HOST=0.0.0.0\n' > "$ENV_FILE"; chmod 0644 "$ENV_FILE"
  log "sidecar bind override written ($ENV_FILE -> 0.0.0.0)"
  local owner uid
  owner="$(stat -c %U "$STATE_DIR" 2>/dev/null)"
  uid="$(id -u "$owner" 2>/dev/null)"
  if [ -n "$owner" ] && [ -n "$uid" ] && [ -d "/run/user/$uid" ]; then
    sudo -u "$owner" XDG_RUNTIME_DIR="/run/user/$uid" \
      systemctl --user restart "$SIDECAR_UNIT" >/dev/null 2>&1 \
      && log "  restarted ${SIDECAR_UNIT} as ${owner} (rebound to 0.0.0.0)" \
      || log "  NOTE: could not auto-restart sidecar; it will rebind on next start. Manual: systemctl --user restart ${SIDECAR_UNIT}"
  else
    log "  NOTE: sidecar user session not active yet; it will pick up 0.0.0.0 when it starts."
  fi
}

# Capture nearby WiFi networks BEFORE the radio becomes an AP — a single-radio
# box can't scan while hosting the hotspot, so the wizard's picker reads this
# cache (terse SSID:SIGNAL:SECURITY, the same shape features/network.py parses).
cache_scan(){
  install -d -m 0775 "$STATE_DIR"
  if nmcli -t -f SSID,SIGNAL,SECURITY device wifi list --rescan yes >"${SCAN_CACHE}.tmp" 2>/dev/null \
     && [ -s "${SCAN_CACHE}.tmp" ]; then
    mv "${SCAN_CACHE}.tmp" "$SCAN_CACHE"; chmod 0644 "$SCAN_CACHE"
    log "cached $(grep -c . "$SCAN_CACHE") nearby network(s) for the wizard picker"
  else
    rm -f "${SCAN_CACHE}.tmp" 2>/dev/null || true
    log "WARN: pre-AP scan returned nothing; wizard will rely on manual SSID entry"
  fi
}

# Confirm the wizard actually answers locally; WARN only (non-fatal).
healthcheck(){
  local i
  for i in 1 2 3 4 5; do
    curl -fsS --max-time 3 "http://127.0.0.1:9200/healthz" >/dev/null 2>&1 && {
      log "healthcheck OK — wizard reachable on :9200"; return 0; }
    sleep 2
  done
  log "WARN: sidecar :9200 not answering yet — wizard may be briefly unreachable at ${AP_IP}:9200"
}

# Shared success path for both the reuse and create branches of cmd_up.
on_ap_up(){ # $1=mode $2=ssid $3=note
  log "AP up: SSID='$2' at http://${AP_IP}:9200 — join it and open the setup page."
  write_state "$1" "$2" "$3"
  flip_sidecar_bind
  healthcheck
}

cmd_up(){
  if [ -f "$DONE_MARKER" ]; then
    log "onboarding already complete ($DONE_MARKER present) — not starting AP."; exit 0
  fi
  local wlan; wlan="$(wlan_iface)"
  if [ -z "$wlan" ]; then
    log "no WiFi device found — cannot start AP (box must onboard via ethernet/Tailscale)."
    write_state none "" "no-wifi-radio"; exit 0
  fi

  # Already online? Then the box doesn't need a setup hotspot — and bringing one
  # up would knock a single-radio box off its current WiFi. Reach the wizard at
  # http://<hostname>.local:9200/onboarding over the existing network instead.
  if has_internet; then
    log "box already has internet — NOT starting AP. Reach setup at http://$(hostname).local:9200/onboarding"
    write_state none "" "already-online"; exit 0
  fi

  local mode note
  if eth_has_carrier; then
    mode=A; note="ethernet uplink present — AP stays up for the whole session"
  else
    mode=B; note="no ethernet — AP is config-only; sidecar join will hand off (reconnect dance)"
  fi
  log "uplink model ${mode}: ${note}"

  # Scan for the operator's networks NOW, while the radio is still free — once
  # the AP is up this radio can't scan (the wizard reads this cache).
  cache_scan

  local ssid; ssid="$(ap_ssid)"

  # Arm the captive portal BEFORE bring-up so NM's shared dnsmasq reads the DNS
  # drop-in on start (covers both the reuse and create paths below).
  captive_up "$wlan"

  # Reuse our connection if it already exists; otherwise create it.
  if nmcli -t -f NAME connection show 2>/dev/null | grep -qx "$HOTSPOT_CON"; then
    log "hotspot connection '${HOTSPOT_CON}' exists — bringing it up"
    nmcli connection up "$HOTSPOT_CON" >/dev/null 2>&1 \
      && { on_ap_up "$mode" "$ssid" "$note"; exit 0; } \
      || log "WARN: could not bring up existing '${HOTSPOT_CON}'; recreating"
    nmcli connection delete "$HOTSPOT_CON" >/dev/null 2>&1 || true
  fi

  # Create a `shared` IPv4 AP (NM auto-runs dnsmasq for DHCP/DNS on 10.42.0.0/24).
  nmcli connection add type wifi ifname "$wlan" con-name "$HOTSPOT_CON" \
      autoconnect no ssid "$ssid" >/dev/null 2>&1
  nmcli connection modify "$HOTSPOT_CON" \
      802-11-wireless.mode ap 802-11-wireless.band bg \
      ipv4.method shared ipv6.method ignore >/dev/null 2>&1
  if [ "$AP_OPEN" = "1" ]; then
    log "AP auth: OPEN (no passphrase) — AGENTBOX_AP_OPEN=1"
  else
    local psk; psk="$(ap_psk)"
    nmcli connection modify "$HOTSPOT_CON" \
        wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$psk" >/dev/null 2>&1
    log "AP auth: WPA2  passphrase='${psk}'  (also in ${PSK_FILE})"
  fi

  if nmcli connection up "$HOTSPOT_CON" >/dev/null 2>&1; then
    on_ap_up "$mode" "$ssid" "$note"
  else
    log "ERROR: failed to bring up the AP on ${wlan}. Check 'nmcli connection up ${HOTSPOT_CON}'."
    captive_down   # don't leave the DNS hijack / :80 redirect armed on a failed bring-up
    write_state none "$ssid" "ap-bringup-failed"; exit 1
  fi
}

# --- Captive portal (G15): make a joining phone's OS auto-open the wizard ------
# NM's `shared` mode runs its own dnsmasq that reads dnsmasq-shared.d/*.conf, so a
# drop-in resolving EVERY name to the AP gateway makes the phone's OS connectivity
# probe land on the box; an iptables :80 -> :SIDECAR_PORT redirect gets it to the
# sidecar, which answers probe paths with a 302 to /onboarding (features/captive.py).
# Net: the phone shows "Sign in to network" and opens the wizard — no typing an IP.
# Must run BEFORE `nmcli connection up` so the shared dnsmasq reads the drop-in.
captive_up(){
  local wlan="$1"
  mkdir -p "$(dirname "$CAPTIVE_DNS_CONF")" 2>/dev/null || true
  printf 'address=/#/%s\n' "$AP_IP" > "$CAPTIVE_DNS_CONF" 2>/dev/null \
    || log "WARN: could not write captive DNS drop-in $CAPTIVE_DNS_CONF"
  if command -v iptables >/dev/null 2>&1 && [ -n "$wlan" ]; then
    iptables -t nat -C PREROUTING -i "$wlan" -p tcp --dport 80 -j REDIRECT --to-ports "$SIDECAR_PORT" 2>/dev/null \
      || iptables -t nat -A PREROUTING -i "$wlan" -p tcp --dport 80 -j REDIRECT --to-ports "$SIDECAR_PORT" 2>/dev/null \
      || log "WARN: could not add :80->:${SIDECAR_PORT} captive redirect"
  else
    log "WARN: iptables/wlan unavailable — captive :80 redirect skipped (wizard still at ${AP_IP}:${SIDECAR_PORT})"
  fi
  log "captive portal armed (DNS->${AP_IP}, :80->:${SIDECAR_PORT})"
}

# Idempotent teardown: remove the DNS drop-in and every copy of our :80 redirect.
captive_down(){
  rm -f "$CAPTIVE_DNS_CONF" 2>/dev/null || true
  local wlan; wlan="$(wlan_iface)"
  if command -v iptables >/dev/null 2>&1 && [ -n "$wlan" ]; then
    while iptables -t nat -C PREROUTING -i "$wlan" -p tcp --dport 80 -j REDIRECT --to-ports "$SIDECAR_PORT" 2>/dev/null; do
      iptables -t nat -D PREROUTING -i "$wlan" -p tcp --dport 80 -j REDIRECT --to-ports "$SIDECAR_PORT" 2>/dev/null || break
    done
  fi
}

cmd_down(){
  nmcli connection down "$HOTSPOT_CON" >/dev/null 2>&1 || true
  nmcli connection delete "$HOTSPOT_CON" >/dev/null 2>&1 || true
  captive_down
  rm -f "$ENV_FILE" 2>/dev/null || true   # revert sidecar bind override
  write_state none "" "torn-down"
  log "AP '${HOTSPOT_CON}' torn down."
}

cmd_status(){
  echo "wlan_iface: $(wlan_iface || echo none)"
  echo "eth_carrier: $(eth_has_carrier && echo yes || echo no)"
  echo "has_internet: $(has_internet && echo yes || echo no)  (AP only comes up when no)"
  echo "mdns_name: $(hostname).local"
  echo "onboarding_complete: $([ -f "$DONE_MARKER" ] && echo yes || echo no)"
  [ -f "$STATE_FILE" ] && { echo "--- last bring-up ---"; cat "$STATE_FILE"; }
  nmcli -t -f NAME,DEVICE,STATE connection show --active 2>/dev/null | grep "$HOTSPOT_CON" \
    && echo "AP is ACTIVE" || echo "AP not active"
}

case "${1:-}" in
  up)     cmd_up ;;
  down)   cmd_down ;;
  status) cmd_status ;;
  *) echo "usage: $0 {up|down|status}" >&2; exit 2 ;;
esac
