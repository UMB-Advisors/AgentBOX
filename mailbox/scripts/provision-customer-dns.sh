#!/usr/bin/env bash
# provision-customer-dns.sh — NC-25 per-customer subdomain bootstrapper
#
# PURPOSE: Create the Cloudflare A record `<customer-slug>.mailbox.<staqs-domain>`
# → <appliance-LAN-IP> so the appliance's Caddy can immediately solve a DNS-01
# challenge and serve HTTPS once the unit comes online inside the customer LAN.
#
# Runs ONCE per appliance, from the provisioner's workstation (NOT on the
# Jetson). Idempotent — re-running with the same slug + IP is a no-op; re-running
# with a different IP updates the existing record in place.
#
# STAQPRO-183 / NC-25. See docs/runbook/provisioning.v0.1.0.md §5.
#
# ──────────────────────────────────────────────────────────────────────────────
# USAGE
#   ./scripts/provision-customer-dns.sh <customer-slug> <lan-ip>
#   ./scripts/provision-customer-dns.sh --dry-run <customer-slug> <lan-ip>
#
# EXAMPLES
#   # Create staqs.mailbox.staqs.io → 192.168.50.11
#   ./scripts/provision-customer-dns.sh staqs 192.168.50.11
#
#   # Preview without hitting the Cloudflare API
#   ./scripts/provision-customer-dns.sh --dry-run heronlabs 192.168.1.50
#
# REQUIRED ENV (export before running, or source from .env on the provisioner box)
#   CLOUDFLARE_API_TOKEN   Same token used by the appliance's Caddy.
#                          Scope: Zone → DNS → Edit on $CLOUDFLARE_ZONE_ID.
#                          NEVER commit this. NEVER paste into Slack/email.
#   CLOUDFLARE_ZONE_ID     Zone ID of the parent Staqs-owned domain.
#                          Cloudflare dashboard → zone overview → right sidebar.
#   MAILBOX_SHARED_DOMAIN  The Staqs-owned shared root (staqs.io).
#                          The final hostname is <slug>.mailbox.$MAILBOX_SHARED_DOMAIN.
#
# OPTIONAL ENV
#   CF_RECORD_TTL          DNS TTL in seconds (default 60 — low enough that a
#                          mistake corrects within a minute, high enough to
#                          stay off Cloudflare's "1" auto-TTL surprise path).
#   CF_RECORD_COMMENT      Free-text comment stored on the CF record.
#                          Default: "MailBOX appliance — STAQPRO-183".
#
# EXIT CODES
#   0  success (created or updated)
#   1  bad invocation / missing env
#   2  Cloudflare API error
#   3  validation failure (slug, IP, zone mismatch)
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── arg parsing ──────────────────────────────────────────────────────────────
DRY_RUN=0
DELETE_MODE=0
# Flags may appear in any order before positional args.
while [[ "${1:-}" == --* ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --delete)  DELETE_MODE=1; shift ;;
    *) echo "ERROR: unknown flag '$1'" >&2; exit 1 ;;
  esac
done

if [[ $DELETE_MODE -eq 1 ]]; then
  expected_args=1
  usage_args="<customer-slug>"
else
  expected_args=2
  usage_args="<customer-slug> <lan-ip>"
fi

if [[ $# -ne $expected_args ]]; then
  cat <<EOF >&2
Usage: $0 [--dry-run] [--delete] $usage_args

  customer-slug   lowercase letters, digits, hyphens; matches ^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$
                  (DNS label rules + a 32-char internal cap)
  lan-ip          IPv4 address inside the customer LAN (the appliance's static IP)
                  (omitted in --delete mode)

Required env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID, MAILBOX_SHARED_DOMAIN
EOF
  exit 1
fi

CUSTOMER_SLUG="$1"
LAN_IP="${2:-}"

# ── env validation ───────────────────────────────────────────────────────────
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required (Zone:DNS:Edit scope)}"
: "${CLOUDFLARE_ZONE_ID:?CLOUDFLARE_ZONE_ID is required (Cloudflare zone overview → Zone ID)}"
: "${MAILBOX_SHARED_DOMAIN:?MAILBOX_SHARED_DOMAIN is required (the Staqs-owned root, staqs.io)}"

# jq is required — audit 2026-05-22 (UMB-191) closed the silent-skip path
# where the zone-name safety check disappeared on workstations without jq.
command -v jq >/dev/null 2>&1 || {
  echo "ERROR: jq is required. Install with 'brew install jq' or 'apt-get install jq'." >&2
  exit 1
}

CF_RECORD_TTL="${CF_RECORD_TTL:-60}"
CF_RECORD_COMMENT="${CF_RECORD_COMMENT:-MailBOX appliance — STAQPRO-183}"

# ── input validation ─────────────────────────────────────────────────────────
# Slug: DNS label safe, 2-32 chars. Forbid leading/trailing hyphen (RFC 1035).
if ! [[ "$CUSTOMER_SLUG" =~ ^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$ ]]; then
  echo "ERROR: customer-slug '$CUSTOMER_SLUG' is not a valid DNS label." >&2
  echo "       Required: lowercase letters/digits/hyphens, 2-32 chars," >&2
  echo "                 no leading/trailing hyphen." >&2
  exit 3
fi

# IPv4 validation only applies in provision mode (delete mode has no IP arg).
# Good enough for static LAN IPs; we don't support IPv6 LAN provisioning yet
# (no live appliance uses it).
if [[ $DELETE_MODE -eq 0 ]]; then
  if ! [[ "$LAN_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
    echo "ERROR: lan-ip '$LAN_IP' is not a valid IPv4 address." >&2
    exit 3
  fi
  IFS='.' read -r o1 o2 o3 o4 <<< "$LAN_IP"
  for octet in "$o1" "$o2" "$o3" "$o4"; do
    if (( octet < 0 || octet > 255 )); then
      echo "ERROR: lan-ip '$LAN_IP' has an octet out of range." >&2
      exit 3
    fi
  done
fi

# Hostname assembly
RECORD_NAME="${CUSTOMER_SLUG}.mailbox.${MAILBOX_SHARED_DOMAIN}"

if [[ $DELETE_MODE -eq 1 ]]; then
  echo "→ Deleting DNS for MailBOX appliance"
  echo "  Hostname : $RECORD_NAME"
  echo "  Zone     : $CLOUDFLARE_ZONE_ID"
else
  echo "→ Provisioning DNS for MailBOX appliance"
  echo "  Hostname : $RECORD_NAME"
  echo "  Target   : $LAN_IP"
  echo "  TTL      : ${CF_RECORD_TTL}s"
  echo "  Zone     : $CLOUDFLARE_ZONE_ID"
fi
if [[ $DRY_RUN -eq 1 ]]; then
  echo "  Mode     : DRY RUN (no API calls)"
fi

# ── helper: call Cloudflare API ──────────────────────────────────────────────
# Args: METHOD PATH [JSON_BODY]
# Prints response body to stdout, http status to stderr (caller can grep).
# Sets CF_HTTP_STATUS as a global.
CF_HTTP_STATUS=0
cf_api() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local url="https://api.cloudflare.com/client/v4${path}"
  local resp
  local curl_args=(
    -sS
    -w '\n%{http_code}'
    -X "$method"
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
    -H "Content-Type: application/json"
    "$url"
  )
  if [[ -n "$body" ]]; then
    curl_args+=(--data "$body")
  fi
  resp="$(curl "${curl_args[@]}")"
  CF_HTTP_STATUS="$(printf '%s' "$resp" | tail -n1)"
  printf '%s' "$resp" | sed '$d'
}

# ── helper: pretty-print Cloudflare error body to stderr ─────────────────────
cf_explain_failure() {
  local body="$1"
  echo "  Cloudflare API error (HTTP ${CF_HTTP_STATUS}):" >&2
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$body" | jq -r '.errors[]? | "    [\(.code)] \(.message)"' >&2 || \
      printf '  %s\n' "$body" >&2
  else
    printf '  %s\n' "$body" >&2
  fi
}

# ── dry-run short-circuit ────────────────────────────────────────────────────
if [[ $DRY_RUN -eq 1 ]]; then
  echo
  echo "Would call: GET    /zones/$CLOUDFLARE_ZONE_ID/dns_records?type=A&name=$RECORD_NAME"
  if [[ $DELETE_MODE -eq 1 ]]; then
    echo "Would call: DELETE /zones/$CLOUDFLARE_ZONE_ID/dns_records/<id>   (if present)"
  else
    echo "Would call: POST   /zones/$CLOUDFLARE_ZONE_ID/dns_records   (if absent)"
    echo "       or   PUT    /zones/$CLOUDFLARE_ZONE_ID/dns_records/<id>   (if present)"
  fi
  echo
  echo "Dry run complete. No changes made."
  exit 0
fi

# ── 1. token sanity check (fail fast if token is wrong, before any zone write)
echo
echo "→ Verifying Cloudflare API token …"
token_body="$(cf_api GET /user/tokens/verify)"
if [[ "$CF_HTTP_STATUS" != "200" ]]; then
  cf_explain_failure "$token_body"
  echo "  → Check CLOUDFLARE_API_TOKEN. Scope must be Zone → DNS → Edit on the target zone." >&2
  exit 2
fi
echo "  ✓ Token active"

# Audit 2026-05-22 (UMB-191): warn if the token can see more than the target
# zone. CF doesn't let us scope below the zone, but a token issued with
# broader scope (account-wide, multi-zone) is an audit red flag — per-appliance
# tokens should resolve to exactly 1 zone.
echo "→ Checking token scope blast radius …"
scope_body="$(cf_api GET /zones)"
if [[ "$CF_HTTP_STATUS" == "200" ]]; then
  scope_count="$(printf '%s' "$scope_body" | jq -r '.result | length')"
  if (( scope_count > 1 )); then
    echo "  ⚠ WARN: token can access $scope_count zones; expected exactly 1." >&2
    echo "  ⚠       Re-issue with Zone:DNS:Edit scoped to a single zone." >&2
  else
    echo "  ✓ Token scoped to exactly 1 zone"
  fi
else
  echo "  (scope inspection unavailable — HTTP $CF_HTTP_STATUS)" >&2
fi

# ── 2. zone sanity check (token can access this specific zone) ───────────────
echo "→ Verifying zone access …"
zone_body="$(cf_api GET "/zones/${CLOUDFLARE_ZONE_ID}")"
if [[ "$CF_HTTP_STATUS" != "200" ]]; then
  cf_explain_failure "$zone_body"
  echo "  → Check CLOUDFLARE_ZONE_ID and that the token's zone scope matches." >&2
  exit 2
fi
zone_name="$(printf '%s' "$zone_body" | jq -r '.result.name // empty')"
if [[ -z "$zone_name" ]]; then
  echo "ERROR: could not parse zone name from Cloudflare response." >&2
  exit 2
fi
# Sanity-check: the hostname should be inside this zone.
if [[ "$RECORD_NAME" != *"$zone_name" ]]; then
  echo "ERROR: zone '$zone_name' does not cover '$RECORD_NAME'." >&2
  echo "       Either MAILBOX_SHARED_DOMAIN or CLOUDFLARE_ZONE_ID is wrong." >&2
  exit 3
fi
echo "  ✓ Zone $zone_name covers $RECORD_NAME"

# ── 3. look for an existing record ───────────────────────────────────────────
echo "→ Checking for existing A record …"
list_body="$(cf_api GET "/zones/${CLOUDFLARE_ZONE_ID}/dns_records?type=A&name=${RECORD_NAME}")"
if [[ "$CF_HTTP_STATUS" != "200" ]]; then
  cf_explain_failure "$list_body"
  exit 2
fi

EXISTING_ID="$(printf '%s' "$list_body" | jq -r '.result[0].id // empty')"
EXISTING_IP="$(printf '%s' "$list_body" | jq -r '.result[0].content // empty')"

# ── 4. delete mode short-circuit ─────────────────────────────────────────────
if [[ $DELETE_MODE -eq 1 ]]; then
  if [[ -z "$EXISTING_ID" ]]; then
    echo "  ✓ No A record for $RECORD_NAME — nothing to delete."
    echo
    echo "✓ Done. $RECORD_NAME (already absent)"
    exit 0
  fi
  echo "  ↻ Deleting record $EXISTING_ID ($EXISTING_IP) …"
  del_body="$(cf_api DELETE "/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${EXISTING_ID}")"
  if [[ "$CF_HTTP_STATUS" != "200" ]]; then
    cf_explain_failure "$del_body"
    exit 2
  fi
  echo "  ✓ Deleted"
  echo
  echo "✓ Done. $RECORD_NAME (removed)"
  exit 0
fi

# ── 5. payload assembly ──────────────────────────────────────────────────────
# proxied=false is essential — Cloudflare proxy would intercept the LAN-only IP
# and break the DNS-01 challenge for Caddy. NC-25 requires non-proxied DNS.
payload="$(cat <<EOF
{
  "type": "A",
  "name": "${RECORD_NAME}",
  "content": "${LAN_IP}",
  "ttl": ${CF_RECORD_TTL},
  "proxied": false,
  "comment": "${CF_RECORD_COMMENT}"
}
EOF
)"

if [[ -n "$EXISTING_ID" ]]; then
  if [[ "$EXISTING_IP" == "$LAN_IP" ]]; then
    echo "  ✓ Record already exists with correct IP — no-op."
    echo
    echo "✓ Done. $RECORD_NAME → $LAN_IP (unchanged)"
    exit 0
  fi
  echo "  ↻ Existing record found ($EXISTING_IP → $LAN_IP), updating in place …"
  upd_body="$(cf_api PUT "/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${EXISTING_ID}" "$payload")"
  if [[ "$CF_HTTP_STATUS" != "200" ]]; then
    cf_explain_failure "$upd_body"
    exit 2
  fi
  echo "  ✓ Updated"
else
  echo "  + No existing record, creating …"
  new_body="$(cf_api POST "/zones/${CLOUDFLARE_ZONE_ID}/dns_records" "$payload")"
  # Cloudflare returns HTTP 201 Created on a successful POST (PUT returns 200).
  # The previous "!= 200" check made every first-time provision exit 2 with a
  # false API error — UMB-191 audit 2026-05-22.
  if [[ "$CF_HTTP_STATUS" != "200" && "$CF_HTTP_STATUS" != "201" ]]; then
    cf_explain_failure "$new_body"
    exit 2
  fi
  echo "  ✓ Created"
fi

echo
echo "✓ Done. $RECORD_NAME → $LAN_IP (TTL ${CF_RECORD_TTL}s, proxied=false)"
echo
echo "Next steps:"
echo "  1. Set DOMAIN=$RECORD_NAME in the appliance's .env"
echo "  2. Set CLOUDFLARE_API_TOKEN in the appliance's .env (same token)"
echo "  3. docker compose up -d caddy on the appliance"
echo "  4. Watch cert acquisition: docker logs mailbox-caddy-1 -f"
echo "     (first DNS-01 cert is 60–120s; expect 'certificate obtained successfully')"
