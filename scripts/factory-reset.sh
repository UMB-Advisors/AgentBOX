#!/usr/bin/env bash
# factory-reset.sh — MailBox appliance: scrub customer state + re-bootstrap
#
# PURPOSE: Return a deployed appliance to factory-bootstrap state. Two scenarios:
#   1. Customer churn — the unit comes back and must be redeployed to the next
#      customer WITHOUT leaking the prior customer's email corpus, drafts,
#      classification log, RAG vectors, n8n credentials, or basic_auth secrets.
#   2. OS rebuild validation — re-flash the box, replay bootstrap, and prove the
#      box returns to a known-good state (this script re-invokes
#      factory-bootstrap.sh as its final step, so it tests bootstrap as a
#      side effect).
#
# This is the MOST DESTRUCTIVE script in the repo. It tears the compose stack
# down, removes the sensitive named volumes, resets host identity, and resets
# the appliance .env to the example. It is guarded behind an explicit
# confirmation (env or typed) and refuses to run on a known-production host.
#
# Companion to scripts/factory-bootstrap.sh (MBOX-180 / STAQPRO-202). The wipe
# checklist is mirrored in docs/runbook/factory-reset.v0.1.0.md for the manual
# fallback path if this script ever breaks.
#
# ──────────────────────────────────────────────────────────────────────────────
# WARNING
#   This PERMANENTLY DELETES all customer email content, drafts, the
#   classification log, the RAG vector corpus, n8n workflow credentials, the
#   Caddy ACME account + issued cert, the appliance .env (basic_auth hash,
#   API keys), shell history, and journal logs. It also LOGS THE BOX OUT OF
#   TAILSCALE and REGENERATES SSH HOST KEYS — your current SSH session will
#   survive, but the next connection needs a fresh known_hosts entry and the
#   operator must re-auth Tailscale. There is no undo. Back up first if unsure.
#
# ──────────────────────────────────────────────────────────────────────────────
# USAGE
#   sudo bash ./scripts/factory-reset.sh --dry-run        # preview, touch nothing
#   sudo RESET=YES_I_AM_SURE bash ./scripts/factory-reset.sh   # non-interactive
#   sudo bash ./scripts/factory-reset.sh                  # interactive (type WIPE)
#
#   --dry-run        Print the full blast radius and exit 0. No container, no
#                    volume, no file, no identity is touched. Mirrors the
#                    convention in provision-customer-dns.sh. Because it wipes
#                    nothing, --dry-run does NOT require root and does NOT
#                    refuse on a production host — it previews freely and prints
#                    the prod-guard status as informational (MBOX-181). A REAL
#                    run still requires sudo AND honors the RESET_ALLOW_PROD
#                    production guard below.
#   --no-bootstrap   Skip the final re-run of factory-bootstrap.sh. Use when
#                    re-flashing and you intend to run bootstrap manually, or
#                    when bootstrap is not present on this box yet. Default is
#                    to re-bootstrap (the issue's "tests bootstrap" guarantee).
#   --keep-host-identity
#                    Skip the Tailscale logout + SSH host-key regeneration +
#                    hostname-affecting steps. Wipes only the data plane
#                    (volumes, .env, shell/journal). Use for an in-place
#                    data scrub that keeps the box on the tailnet.
#
# CONFIRMATION (one of, unless --dry-run)
#   - Set env RESET=YES_I_AM_SURE for a non-interactive run, OR
#   - Run interactively and type the literal word WIPE at the prompt.
#   There is intentionally NO --yes flag — non-interactive runs must set the
#   explicit RESET env so a stray invocation cannot destroy a box.
#
# PRODUCTION SAFETY
#   Refuses a REAL run if the hostname OR the tailscale identity matches a known
#   production appliance (default: mailbox1, mailbox2). Override the list with
#   RESET_PROD_HOSTS (space-separated). To deliberately reset a listed host
#   (e.g. retiring M1 after M2 is the live reference), set
#   RESET_ALLOW_PROD=1 in addition to the confirmation above. --dry-run is
#   exempt — it previews on any host (the guard prints as informational).
#
# REQUIRED ENV / PRE-CONDITIONS (REAL runs only — --dry-run skips all of these)
#   - Must run as root (sudo).
#   - docker + docker compose v2 plugin available.
#   - Run from inside the repo (the script locates the compose file via REPO_ROOT).
#
# EXIT CODES
#   0  success (wipe complete; bootstrap re-run unless --no-bootstrap)
#   1  bad invocation / missing root / docker unavailable
#   2  confirmation not satisfied (env unset and typed confirm wrong/declined)
#   3  safety gate tripped (production host without RESET_ALLOW_PROD)
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

PROG="$(basename "$0")"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ── defaults ───────────────────────────────────────────────────────────────────
DRY_RUN=0
RUN_BOOTSTRAP=1
RESET_HOST_IDENTITY=1

# Sensitive named volumes to remove, in runtime (project-prefixed) form. These
# are the names docker assigns at runtime (compose project "mailbox" + the
# declared volume) and match the CLAUDE.md "Service topology" + MBOX-180 scope.
# NON-sensitive volumes are intentionally NOT listed: ollama_models (model
# weights, no customer data — re-pulled on bootstrap anyway) and caddy_config
# (Caddy's runtime config snapshot, no secrets). We keep ollama_models to avoid
# re-downloading multi-GB weights on every reset.
SENSITIVE_VOLUMES=(
  mailbox_postgres_data    # all customer email + drafts + classification log
  mailbox_qdrant_data      # RAG vector corpus (sensitive per CLAUDE.md Constraints)
  mailbox_n8n_data         # n8n encrypted credentials (Gmail OAuth, Postgres creds)
  mailbox_caddy_data       # Caddy ACME account + issued cert (forces fresh cert)
  mailbox_kb_uploads       # operator-uploaded KB source bytes (STAQPRO-148)
)

# Known-production hostnames this script refuses to wipe without RESET_ALLOW_PROD.
# Space-separated; overridable via env.
RESET_PROD_HOSTS="${RESET_PROD_HOSTS:-mailbox1 mailbox2}"
RESET_ALLOW_PROD="${RESET_ALLOW_PROD:-0}"

# ── arg parsing ────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)            DRY_RUN=1; shift ;;
    --no-bootstrap)       RUN_BOOTSTRAP=0; shift ;;
    --keep-host-identity) RESET_HOST_IDENTITY=0; shift ;;
    -h|--help)
      sed -n '2,80p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument '$1'" >&2
      echo "Usage: sudo bash $PROG [--dry-run] [--no-bootstrap] [--keep-host-identity]" >&2
      exit 1
      ;;
  esac
done

# ── pre-conditions ──────────────────────────────────────────────────────────────
# --dry-run touches nothing — it only PREVIEWS the blast radius — so it does NOT
# require root and does NOT enforce the docker/compose preconditions or the
# production-host refusal. A real run keeps every guard. (MBOX-181 defect 2)
if [[ $DRY_RUN -eq 0 ]]; then
  if [[ $EUID -ne 0 ]]; then
    echo "ERROR: must run with sudo. Try: sudo bash $0" >&2
    exit 1
  fi

  if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: docker not found on PATH. Cannot tear down the stack." >&2
    exit 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    echo "ERROR: 'docker compose' (v2 plugin) not available. Standalone v1 is unsupported." >&2
    exit 1
  fi
fi

COMPOSE_FILE="${REPO_ROOT}/docker-compose.yml"
if [[ ! -f "$COMPOSE_FILE" && $DRY_RUN -eq 0 ]]; then
  echo "ERROR: compose file not found at $COMPOSE_FILE — run from inside the repo." >&2
  exit 1
fi

CURRENT_HOST="$(hostname)"

echo ""
echo "========================================"
echo "  MailBox — factory-reset.sh"
echo "  host: ${CURRENT_HOST}    $(date)"
echo "========================================"
echo ""

# ── production safety gate ──────────────────────────────────────────────────────
# Refuse on a known-production hostname OR a tailscale identity matching mailboxN,
# unless the operator explicitly opts in with RESET_ALLOW_PROD=1.
is_prod_host() {
  local h
  for h in $RESET_PROD_HOSTS; do
    if [[ "$CURRENT_HOST" == "$h" ]]; then
      return 0
    fi
  done
  # Tailscale identity check — even if /etc/hostname was changed, a mailboxN
  # tailnet identity means this is a live, enrolled appliance.
  if command -v tailscale >/dev/null 2>&1; then
    local ts_status
    ts_status="$(tailscale status 2>/dev/null || true)"
    if echo "${ts_status}" | grep -qE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+[[:space:]]+mailbox[0-9]'; then
      return 0
    fi
  fi
  return 1
}

if is_prod_host; then
  if [[ $DRY_RUN -eq 1 ]]; then
    # --dry-run wipes nothing, so the prod guard is informational only — never
    # a hard refusal. Surface the status so the preview makes clear a REAL run
    # would (or would not) need RESET_ALLOW_PROD. (MBOX-181 defect 2)
    if [[ "$RESET_ALLOW_PROD" != "1" ]]; then
      echo "ℹ DRY RUN on a known-production host ('${CURRENT_HOST}'): a REAL run would be"
      echo "ℹ          REFUSED (exit 3) unless RESET_ALLOW_PROD=1. Previewing anyway."
    else
      echo "ℹ DRY RUN on a known-production host ('${CURRENT_HOST}') with RESET_ALLOW_PROD=1:"
      echo "ℹ          a REAL run would proceed to wipe this PRODUCTION appliance."
    fi
    echo ""
  elif [[ "$RESET_ALLOW_PROD" != "1" ]]; then
    echo "ERROR: '${CURRENT_HOST}' looks like a known-production appliance." >&2
    echo "       (matched RESET_PROD_HOSTS='${RESET_PROD_HOSTS}' or a mailboxN tailnet identity)" >&2
    echo "       Refusing to wipe a live customer box." >&2
    echo "       If you really mean to reset it (e.g. retiring M1 after M2 is" >&2
    echo "       the live reference), re-run with RESET_ALLOW_PROD=1." >&2
    exit 3
  else
    echo "⚠ WARNING: '${CURRENT_HOST}' is a known-production host, but RESET_ALLOW_PROD=1 is set."
    echo "⚠          Proceeding to wipe a PRODUCTION appliance. This is irreversible."
    echo ""
  fi
fi

# ── blast-radius summary ────────────────────────────────────────────────────────
ENV_FILE="${REPO_ROOT}/.env"
ENV_EXAMPLE="${REPO_ROOT}/.env.example"
RESET_TS="$(date +%Y%m%d-%H%M%S)"
TARGET_USER="${SUDO_USER:-${USER:-root}}"
TARGET_HOME="$(getent passwd "$TARGET_USER" 2>/dev/null | cut -d: -f6)"
TARGET_HOME="${TARGET_HOME:-$HOME}"

echo "BLAST RADIUS — the following will be PERMANENTLY wiped:"
echo ""
echo "  Compose stack    : docker compose down --remove-orphans  (file: $COMPOSE_FILE)"
echo "  Named volumes    :"
for v in "${SENSITIVE_VOLUMES[@]}"; do
  echo "                     - $v"
done
echo "  Preserved volume : mailbox_ollama_models (model weights — re-pulled is slow)"
echo "                     mailbox_caddy_config  (no secrets)"
echo "  .env             : $ENV_FILE  → archived to .env.old.${RESET_TS}, replaced from .env.example"
echo "  Shell history    : ${TARGET_HOME}/.bash_history  (+ root's)"
echo "  Journal logs     : journalctl --rotate && --vacuum-time=1s"
if [[ $RESET_HOST_IDENTITY -eq 1 ]]; then
  echo "  Tailscale        : tailscale logout  (operator must re-auth post-reset)"
  echo "  SSH host keys    : ssh-keygen -A  (fingerprints change — update known_hosts)"
else
  echo "  Host identity    : SKIPPED (--keep-host-identity) — Tailscale + SSH keys untouched"
fi
if [[ $RUN_BOOTSTRAP -eq 1 ]]; then
  echo "  Re-bootstrap     : scripts/factory-bootstrap.sh  (runs after wipe)"
else
  echo "  Re-bootstrap     : SKIPPED (--no-bootstrap)"
fi
echo ""

# ── dry-run short-circuit ───────────────────────────────────────────────────────
if [[ $DRY_RUN -eq 1 ]]; then
  echo "Mode: DRY RUN — nothing above was touched."
  echo "Re-run without --dry-run (and satisfy the confirmation) to execute."
  exit 0
fi

# ── confirmation gate ───────────────────────────────────────────────────────────
# Non-interactive: RESET=YES_I_AM_SURE. Interactive: type the literal word WIPE.
if [[ "${RESET:-}" == "YES_I_AM_SURE" ]]; then
  echo "Confirmation: RESET=YES_I_AM_SURE present — proceeding non-interactively."
else
  echo "This is destructive and irreversible. To proceed, type the word: WIPE"
  read -r -p "Confirm: " confirm
  if [[ "$confirm" != "WIPE" ]]; then
    echo "Aborted — confirmation not given (expected 'WIPE')." >&2
    echo "(For non-interactive use, set RESET=YES_I_AM_SURE.)" >&2
    exit 2
  fi
fi
echo ""

# ── helper: remove a named volume idempotently ──────────────────────────────────
remove_volume() {
  local vol="$1"
  if docker volume inspect "$vol" >/dev/null 2>&1; then
    docker volume rm "$vol" >/dev/null
    echo "      removed $vol"
  else
    echo "      $vol absent — skipping"
  fi
}

# ── Step 1: tear down the compose stack ──────────────────────────────────────────
echo "[1/8] stopping compose stack (down --remove-orphans)"
# Do NOT pass -v here — we remove only the sensitive volumes surgically in
# step 2 so ollama_models (model weights) survives the reset.
docker compose -f "$COMPOSE_FILE" down --remove-orphans || {
  echo "      WARN: 'compose down' returned non-zero (stack may already be down)" >&2
}

# ── Step 2: remove sensitive named volumes ───────────────────────────────────────
echo "[2/8] removing sensitive named volumes"
for v in "${SENSITIVE_VOLUMES[@]}"; do
  remove_volume "$v"
done

# ── Step 3: reset .env ────────────────────────────────────────────────────────────
echo "[3/8] resetting .env"
if [[ -f "$ENV_FILE" ]]; then
  mv "$ENV_FILE" "${ENV_FILE}.old.${RESET_TS}"
  echo "      archived existing .env → .env.old.${RESET_TS}"
else
  echo "      no existing .env to archive"
fi
if [[ -f "$ENV_EXAMPLE" ]]; then
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  echo "      .env.example → .env (operator must re-fill secrets during onboarding)"
else
  echo "      WARN: .env.example missing — .env left absent" >&2
fi

# ── Step 4: clear shell history ──────────────────────────────────────────────────
echo "[4/8] clearing shell history"
for hist in "${TARGET_HOME}/.bash_history" "/root/.bash_history"; do
  if [[ -f "$hist" ]]; then
    : > "$hist"
    echo "      truncated $hist"
  fi
done
# Drop in-memory history of the current shell so it isn't re-flushed on exit.
history -c 2>/dev/null || true

# ── Step 5: vacuum journal logs ──────────────────────────────────────────────────
echo "[5/8] rotating + vacuuming journal logs"
if command -v journalctl >/dev/null 2>&1; then
  journalctl --rotate || true
  journalctl --vacuum-time=1s || true
  echo "      journal vacuumed"
else
  echo "      journalctl unavailable — skipping"
fi

# ── Step 6: Tailscale identity rotation ──────────────────────────────────────────
if [[ $RESET_HOST_IDENTITY -eq 1 ]]; then
  echo "[6/8] logging out of Tailscale"
  if command -v tailscale >/dev/null 2>&1; then
    tailscale logout || echo "      WARN: 'tailscale logout' returned non-zero" >&2
    echo "      logged out — operator must re-auth to issue a fresh node identity"
  else
    echo "      tailscale unavailable — skipping"
  fi
else
  echo "[6/8] Tailscale logout SKIPPED (--keep-host-identity)"
fi

# ── Step 7: regenerate SSH host keys ──────────────────────────────────────────────
if [[ $RESET_HOST_IDENTITY -eq 1 ]]; then
  echo "[7/8] regenerating SSH host keys"
  # Remove the old keys first so ssh-keygen -A regenerates a complete fresh set.
  rm -f /etc/ssh/ssh_host_*
  ssh-keygen -A
  echo "      new host keys generated — clients must update known_hosts"
  # Apply the new keys to running sshd without dropping the current session.
  if systemctl is-active --quiet ssh 2>/dev/null; then
    systemctl restart ssh || echo "      WARN: sshd restart returned non-zero" >&2
  elif systemctl is-active --quiet sshd 2>/dev/null; then
    systemctl restart sshd || echo "      WARN: sshd restart returned non-zero" >&2
  fi
else
  echo "[7/8] SSH host-key regeneration SKIPPED (--keep-host-identity)"
fi

# ── Step 8: re-run factory-bootstrap.sh ───────────────────────────────────────────
BOOTSTRAP="${SCRIPT_DIR}/factory-bootstrap.sh"
if [[ $RUN_BOOTSTRAP -eq 1 ]]; then
  echo "[8/8] re-running factory-bootstrap.sh"
  if [[ -x "$BOOTSTRAP" ]]; then
    bash "$BOOTSTRAP"
  elif [[ -f "$BOOTSTRAP" ]]; then
    bash "$BOOTSTRAP"
  else
    echo "      WARN: $BOOTSTRAP not found — skipping re-bootstrap." >&2
    echo "      Run factory-bootstrap.sh manually once it is present." >&2
  fi
else
  echo "[8/8] re-bootstrap SKIPPED (--no-bootstrap)"
fi

# ── done ────────────────────────────────────────────────────────────────────────
echo ""
echo "========================================"
echo "  factory-reset.sh complete"
echo "========================================"
echo ""
echo "Post-reset checklist (operator):"
echo "  1. Re-auth Tailscale:        sudo tailscale up   (then approve in the admin console)"
echo "  2. Refresh known_hosts:      ssh-keygen -R <host>   on each workstation that connects"
echo "  3. Re-fill .env secrets:     basic_auth hash, CLOUDFLARE_API_TOKEN, model keys, etc."
echo "  4. Bring the stack up:       docker compose up -d --build --remove-orphans"
echo "  5. Run guided onboarding to repopulate the per-appliance persona."
echo ""
echo "Manual fallback wipe checklist: docs/runbook/factory-reset.v0.1.0.md"
echo ""
