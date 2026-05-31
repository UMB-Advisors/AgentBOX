#!/usr/bin/env bash
# hermesBOX — Phase 7 acceptance / boot-to-ready check. Run on the box.
# Mirrors ROADMAP Phase 7 acceptance (Linear UMB-386). Read-only: probes, no mutation.
set -uo pipefail
. "${HOME}/.hermesbox_env.sh" 2>/dev/null || true

GATEWAY_UNIT="hermes-gateway.service"
KIOSK_UNIT="hermesbox-kiosk.service"
OLLAMA_API="127.0.0.1:11434"
pass=0; fail=0; warn=0
ok(){ echo "  PASS  $*"; pass=$((pass+1)); }
no(){ echo "  FAIL  $*"; fail=$((fail+1)); }
wn(){ echo "  WARN  $*"; warn=$((warn+1)); }
have_unit(){ systemctl cat "$1" >/dev/null 2>&1; }

echo "=== hermesBOX Phase 7 boot-to-ready ==="

# 1) system not degraded
state="$(systemctl is-system-running 2>/dev/null || true)"
if [ "$state" = "running" ]; then ok "systemctl is-system-running = running"
elif [ "$state" = "starting" ]; then wn "system still starting (re-run once boot settles)"
else
  no "systemctl is-system-running = ${state:-unknown}"
  echo "    --- failed units ---"; systemctl --failed --no-pager 2>&1 | sed 's/^/    /'
fi

# 2) set-maxn-power resolved (active oneshot OR masked) + board actually MAXN_SUPER
mx="$(systemctl is-active set-maxn-power.service 2>/dev/null || true)"
me="$(systemctl is-enabled set-maxn-power.service 2>/dev/null || true)"
if [ "$mx" = "active" ] || [ "$me" = "masked" ]; then ok "set-maxn-power.service resolved (active=${mx} enabled=${me})"
else no "set-maxn-power.service still ${mx}/${me}"; fi
pm="$(sudo nvpmodel -q 2>/dev/null | grep -i 'NV Power Mode' || true)"
[ -n "$pm" ] && echo "  INFO  ${pm}"

# 3) ollama (embeddings) up
if curl -fsS "$OLLAMA_API/api/version" >/dev/null 2>&1; then ok "ollama API up ($(curl -fsS $OLLAMA_API/api/version))"
else no "ollama API not responding"; fi

# 4) gateway (agent + WhatsApp host) installed, enabled, active
if have_unit "$GATEWAY_UNIT"; then
  ge="$(systemctl is-enabled $GATEWAY_UNIT 2>/dev/null || true)"
  ga="$(systemctl is-active  $GATEWAY_UNIT 2>/dev/null || true)"
  [ "$ge" = "enabled" ] && ok "${GATEWAY_UNIT} enabled (boots at startup)" || no "${GATEWAY_UNIT} not enabled (${ge})"
  [ "$ga" = "active"  ] && ok "${GATEWAY_UNIT} active" || no "${GATEWAY_UNIT} not active (${ga})"
  # ordering contract present
  if systemctl show -p After "$GATEWAY_UNIT" 2>/dev/null | grep -q 'ollama.service'; then
    ok "${GATEWAY_UNIT} ordered After ollama.service"
  else wn "${GATEWAY_UNIT} missing After=ollama.service (drop-in not applied?)"; fi
  if systemctl show -p After "$GATEWAY_UNIT" 2>/dev/null | grep -q 'network-online.target'; then
    ok "${GATEWAY_UNIT} ordered After network-online.target"
  else no "${GATEWAY_UNIT} missing network-online.target ordering"; fi
else
  wn "${GATEWAY_UNIT} not installed — run: sudo hermes gateway install --system --run-as-user ${USER}"
fi

# 5) network-online provider enabled (so the target is meaningful)
if systemctl is-enabled NetworkManager-wait-online.service >/dev/null 2>&1 \
   || systemctl is-enabled systemd-networkd-wait-online.service >/dev/null 2>&1; then
  ok "a network-online wait provider is enabled"
else wn "no wait-online provider enabled — network-online.target may settle early"; fi

# 6) kiosk (Phase 6) — informational until that phase lands
if have_unit "$KIOSK_UNIT"; then
  ka="$(systemctl is-active $KIOSK_UNIT 2>/dev/null || true)"
  [ "$ka" = "active" ] && ok "${KIOSK_UNIT} active" || wn "${KIOSK_UNIT} not active (${ka})"
else wn "${KIOSK_UNIT} not present (Phase 6 not landed) — kiosk ordering deferred"; fi

# 7) memory headroom (§7 budget; cloud-inference pivot target ~3GB steady)
read -r tot used <<<"$(free -m | awk '/Mem:/{print $2, $3}')"
echo "  INFO  memory: used=${used}MB / total=${tot}MB"
awk "BEGIN{exit !(${used} < 6800)}" && ok "steady-state memory within budget (${used}MB < 6800MB)" \
  || no "memory over §7 target (${used}MB)"

echo "=== result: ${pass} pass / ${fail} fail / ${warn} warn ==="
[ "$fail" -eq 0 ] && echo "PHASE7_VERIFY_OK" || echo "PHASE7_VERIFY_INCOMPLETE"
