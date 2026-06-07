#!/usr/bin/env bash
# smoke-factory-slug.sh — MBOX-158 logic sanity harness
#
# WHAT: Exercises the slug-present vs slug-absent branches added by MBOX-158 to
#   factory-prep-nvme.sh (write MAILBOX_LAN_HOSTNAME=<slug>.local into the NVMe
#   .env) and factory-bootstrap.sh (resolve hostname from /etc/mailbox-customer,
#   fall back to "mailbox"). Runs entirely on a tmpdir with fixtures — no root,
#   no real NVMe, no hardware, no hostnamectl. Mirrors the exact shell idioms
#   used in the two scripts so a regression in the algorithm fails here.
# WHY: Acceptance for MBOX-158 (per the issue) can't boot real hardware in CI.
#   This proves the branch logic is correct; boot-verify on a spare Jetson is
#   still the final gate (see docs/runbook/factory-image-pipeline).
# REVERSAL: delete this file — pure test, no side effects outside its tmpdir.
#
# USAGE: ./scripts/smoke-factory-slug.sh   (exit 0 = all assertions pass)

set -euo pipefail

PROG="$(basename "$0")"
PASS=0
FAIL=0

ok()   { echo "  ok   - $*"; PASS=$((PASS + 1)); }
bad()  { echo "  FAIL - $*" >&2; FAIL=$((FAIL + 1)); }
check() { if [[ "$1" == "$2" ]]; then ok "$3"; else bad "$3 (want '$2', got '$1')"; fi; }

TMP="$(mktemp -d -t mbox158-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

SLUG_RE='^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$'

# ── factory-prep-nvme.sh: MAILBOX_LAN_HOSTNAME write/update ──────────────────
# Replicates the prep-script block: update in place if the key exists, append
# otherwise; skip when the .env is absent.
prep_set_lan_hostname() {
  local env_path="$1" slug="$2"
  local line="MAILBOX_LAN_HOSTNAME=${slug}.local"
  if [[ -f "$env_path" ]]; then
    if grep -qE '^[[:space:]]*MAILBOX_LAN_HOSTNAME=' "$env_path"; then
      sed -i -E "s|^[[:space:]]*MAILBOX_LAN_HOSTNAME=.*|${line}|" "$env_path"
    else
      printf '%s\n' "$line" >> "$env_path"
    fi
    return 0
  fi
  return 1
}

echo "[1] factory-prep-nvme.sh — .env MAILBOX_LAN_HOSTNAME"

# 1a: key present (default mailbox.local) → updated in place, no duplicate line
ENV_A="$TMP/env_present"
printf 'POSTGRES_PASSWORD=x\nMAILBOX_LAN_HOSTNAME=mailbox.local\nFOO=bar\n' > "$ENV_A"
prep_set_lan_hostname "$ENV_A" "acme"
check "$(grep -c '^MAILBOX_LAN_HOSTNAME=' "$ENV_A")" "1" "key updated in place (no duplicate)"
check "$(grep '^MAILBOX_LAN_HOSTNAME=' "$ENV_A")" "MAILBOX_LAN_HOSTNAME=acme.local" "value is acme.local"
check "$(grep -c '^FOO=bar' "$ENV_A")" "1" "unrelated keys untouched"

# 1b: key absent → appended
ENV_B="$TMP/env_nokey"
printf 'POSTGRES_PASSWORD=x\n' > "$ENV_B"
prep_set_lan_hostname "$ENV_B" "heron-labs"
check "$(grep '^MAILBOX_LAN_HOSTNAME=' "$ENV_B")" "MAILBOX_LAN_HOSTNAME=heron-labs.local" "key appended when missing"
check "$(grep -c '^MAILBOX_LAN_HOSTNAME=' "$ENV_B")" "1" "exactly one line appended"

# 1c: idempotent — re-running yields the same single line
prep_set_lan_hostname "$ENV_B" "heron-labs"
check "$(grep -c '^MAILBOX_LAN_HOSTNAME=' "$ENV_B")" "1" "second run stays idempotent"

# 1d: .env absent → returns non-zero (skip branch), no file created
if prep_set_lan_hostname "$TMP/does_not_exist" "acme"; then
  bad "absent .env should signal skip (non-zero)"
else
  ok "absent .env → skip branch (non-zero), no write"
fi
[[ ! -e "$TMP/does_not_exist" ]] && ok "no .env fabricated when absent" || bad ".env was fabricated"

# ── factory-bootstrap.sh: hostname resolution from /etc/mailbox-customer ─────
# Replicates the bootstrap-script block: first non-comment/non-blank line is the
# slug; validate against the DNS-label regex; fall back to "mailbox".
bootstrap_resolve_hostname() {
  local customer_file="$1"
  local resolved="mailbox"
  if [[ -f "$customer_file" ]]; then
    local stamped
    stamped="$(grep -vE '^[[:space:]]*(#|$)' "$customer_file" | head -1 | tr -d '[:space:]')"
    if [[ "$stamped" =~ $SLUG_RE ]]; then
      resolved="$stamped"
    fi
  fi
  printf '%s' "$resolved"
}

echo "[2] factory-bootstrap.sh — hostname from /etc/mailbox-customer"

# 2a: stamped file (prep-script format: comment line + slug) → slug wins
CUST_A="$TMP/customer_present"
printf '# Set by factory-prep-nvme.sh on 2026-05-27T00:00:00-07:00\nacme\n' > "$CUST_A"
check "$(bootstrap_resolve_hostname "$CUST_A")" "acme" "stamped slug resolves to 'acme'"

# 2b: hyphenated slug
CUST_B="$TMP/customer_hyphen"
printf '# comment\nheron-labs\n' > "$CUST_B"
check "$(bootstrap_resolve_hostname "$CUST_B")" "heron-labs" "hyphenated slug resolves"

# 2c: absent file (M1/M2 / non-prepped) → fallback "mailbox"
check "$(bootstrap_resolve_hostname "$TMP/no_customer_file")" "mailbox" "absent file → fallback 'mailbox'"

# 2d: present but invalid slug (leading hyphen) → fallback "mailbox"
CUST_C="$TMP/customer_invalid"
printf '# comment\n-bad-slug\n' > "$CUST_C"
check "$(bootstrap_resolve_hostname "$CUST_C")" "mailbox" "invalid slug → fallback 'mailbox'"

# ── static guards on the real scripts ────────────────────────────────────────
echo "[3] static checks on the shipped scripts"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash -n "$HERE/factory-prep-nvme.sh" && ok "factory-prep-nvme.sh parses (bash -n)" \
  || bad "factory-prep-nvme.sh failed bash -n"
bash -n "$HERE/factory-bootstrap.sh" && ok "factory-bootstrap.sh parses (bash -n)" \
  || bad "factory-bootstrap.sh failed bash -n"

# ── summary ──────────────────────────────────────────────────────────────────
echo
echo "$PROG: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
