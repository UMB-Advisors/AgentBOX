#!/usr/bin/env bash
#
# MBOX-482 P1 — materialize + import a per-account n8n IMAP/SMTP credential.
#
# n8n 2.14.2 native nodes (emailReadImap / emailSend) can't take token-as-data
# or an expression-selected credential (addendum-01 §2), so each IMAP account
# needs its OWN synced n8n credential. This script is the credential-sync
# mechanism (Model A):
#
#   1. fetch the materialized n8n credential payloads from the dashboard
#      (GET /api/internal/imap-credentials?account_email=...), which is the only
#      place the app-password is decrypted (it holds MAILBOX_OAUTH_TOKEN_KEY).
#   2. stage them as a temp JSON file and run
#      `docker exec <n8n> n8n import:credentials --input=<file>`
#      (the same transport the workflow import uses).
#   3. shred the temp file.
#
# Credential ids/names are deterministic from account_id (addendum §5), so a
# re-run on re-auth OVERWRITES rather than orphaning; --delete removes them on
# disconnect.
#
# WHY this lives in bin/ (not hermes_cli): the decrypt + the docker-exec are box
# tooling, not part of the Hermes agent. Hermes' registration bridge keeps
# mailbox.accounts in sync; THIS turns that row into a live n8n credential.
#
# USAGE:
#   bin/mbox-imap-cred-sync.sh <account_email>                 # create/update
#   bin/mbox-imap-cred-sync.sh --delete <account_email>        # remove on disconnect
#
# ENV:
#   SSH_HOST          target box ssh alias (default mailbox1; 'local' = on-box)
#   N8N_CONTAINER     n8n container name (default mailbox-n8n-1)
#   DASHBOARD_URL     dashboard internal base (default http://127.0.0.1:3001)
#                     WARNING: keep this a LOOPBACK (127.0.0.1 / on-box) address.
#                     The fetched payload carries the DECRYPTED IMAP/SMTP
#                     app-password in plaintext; pointing DASHBOARD_URL at a
#                     non-loopback host sends that credential over the wire in the
#                     clear (the internal route speaks plain http, no TLS).
#   HERMES_INTERNAL_TOKEN  shared secret for the internal route (required)
#
# AFTER: restart n8n so the new credential is live —
#   ssh <box> 'cd ~/mailbox && docker compose restart n8n'
#
set -euo pipefail

SSH_HOST="${SSH_HOST:-mailbox1}"
N8N_CONTAINER="${N8N_CONTAINER:-mailbox-n8n-1}"
DASHBOARD_URL="${DASHBOARD_URL:-http://127.0.0.1:3001}"

# Shell-injection guard (MBOX-482 security review). SSH_HOST and N8N_CONTAINER are
# both interpolated UNQUOTED-at-the-remote into `run()` / `ssh` command strings
# and `docker exec '<N8N_CONTAINER>'` below, so a value carrying shell metacharacters
# would execute on the box. Constrain both to a safe charset BEFORE first use:
# letters, digits, and `_ . @ -` only (the `@` and `.` allow an ssh `user@host`
# alias and dotted hostnames; `local` for the on-box path). Reject anything else.
SAFE_RE='^[a-zA-Z0-9_.@-]+$'
if [[ ! "${SSH_HOST}" =~ ${SAFE_RE} ]]; then
  echo "  [error] SSH_HOST '${SSH_HOST}' contains illegal characters (allowed: A-Z a-z 0-9 _ . @ -)" >&2
  exit 1
fi
if [[ ! "${N8N_CONTAINER}" =~ ${SAFE_RE} ]]; then
  echo "  [error] N8N_CONTAINER '${N8N_CONTAINER}' contains illegal characters (allowed: A-Z a-z 0-9 _ . @ -)" >&2
  exit 1
fi

DELETE=0
if [[ "${1:-}" == "--delete" ]]; then
  DELETE=1
  shift
fi
ACCOUNT_EMAIL="${1:?Usage: mbox-imap-cred-sync.sh [--delete] <account_email>}"

: "${HERMES_INTERNAL_TOKEN:?HERMES_INTERNAL_TOKEN must be set (the dashboard internal-route shared secret)}"

# Run a command either on the box (ssh) or locally.
run() {
  if [[ "${SSH_HOST}" == "local" ]]; then
    bash -c "$1"
  else
    # shellcheck disable=SC2029
    ssh "${SSH_HOST}" "$1"
  fi
}

# Derive deterministic ids the same way the dashboard route does (addendum §5).
# These are needed for --delete (no payload fetch) and for the post-run summary.
# We resolve account_id via the dashboard payload on the create path; on delete
# the caller passes the email and we resolve the ids from the same route's echo.

fetch_payload() {
  # GET the materialized credential payload from the dashboard internal route.
  curl -fsS \
    -H "X-Hermes-Internal-Token: ${HERMES_INTERNAL_TOKEN}" \
    "${DASHBOARD_URL}/dashboard/api/internal/imap-credentials?account_email=${ACCOUNT_EMAIL}"
}

if [[ "${DELETE}" -eq 1 ]]; then
  # Resolve the cred ids from the route (account_id-derived) so we delete exactly
  # this account's creds. If the account is already gone (deregistered), fall
  # back is impossible — the operator must pass ids manually; we surface that.
  echo "Resolving n8n credential ids for ${ACCOUNT_EMAIL}..."
  PAYLOAD="$(fetch_payload || true)"
  if [[ -z "${PAYLOAD}" ]]; then
    echo "  [warn] account no longer resolvable on the dashboard; cannot derive cred ids." >&2
    echo "         If the account was already deregistered, delete the n8n creds named" >&2
    echo "         'MailBox IMAP <email>' / 'MailBox SMTP <email>' in the n8n UI." >&2
    exit 2
  fi
  IMAP_ID="$(printf '%s' "${PAYLOAD}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["imap_cred_id"])')"
  SMTP_ID="$(printf '%s' "${PAYLOAD}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["smtp_cred_id"])')"
  echo "Deleting n8n credentials ${IMAP_ID} + ${SMTP_ID} on ${SSH_HOST}:${N8N_CONTAINER}..."
  run "docker exec '${N8N_CONTAINER}' n8n delete:credentials --id='${IMAP_ID}' || true"
  run "docker exec '${N8N_CONTAINER}' n8n delete:credentials --id='${SMTP_ID}' || true"
  echo "Done. Restart n8n to pick up the change: ssh ${SSH_HOST} 'cd ~/mailbox && docker compose restart n8n'"
  exit 0
fi

echo "Fetching materialized IMAP/SMTP credentials for ${ACCOUNT_EMAIL}..."
PAYLOAD="$(fetch_payload)"

# Extract the bare `credentials` array (the import:credentials input shape).
CREDS_JSON="$(printf '%s' "${PAYLOAD}" | python3 -c 'import sys,json;json.dump(json.load(sys.stdin)["credentials"],sys.stdout)')"
IMAP_ID="$(printf '%s' "${PAYLOAD}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["imap_cred_id"])')"
SMTP_ID="$(printf '%s' "${PAYLOAD}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["smtp_cred_id"])')"

# Stage to a 0600 temp file, copy into the container, import, then shred. The
# plaintext password lives only in this temp file + the container /tmp for the
# import duration; both are removed.
TMP="$(mktemp)"
chmod 600 "${TMP}"
trap 'shred -u "${TMP}" 2>/dev/null || rm -f "${TMP}"' EXIT
printf '%s' "${CREDS_JSON}" > "${TMP}"

REMOTE_TMP="/tmp/mbx-imap-cred-${IMAP_ID}.json"
echo "Importing credentials ${IMAP_ID} + ${SMTP_ID} into ${SSH_HOST}:${N8N_CONTAINER}..."
if [[ "${SSH_HOST}" == "local" ]]; then
  docker cp "${TMP}" "${N8N_CONTAINER}:${REMOTE_TMP}"
  docker exec "${N8N_CONTAINER}" n8n import:credentials --input="${REMOTE_TMP}"
  docker exec "${N8N_CONTAINER}" rm -f "${REMOTE_TMP}"
else
  scp -q "${TMP}" "${SSH_HOST}:${REMOTE_TMP}"
  # shellcheck disable=SC2029
  ssh "${SSH_HOST}" "
    docker cp '${REMOTE_TMP}' '${N8N_CONTAINER}:${REMOTE_TMP}' &&
    docker exec '${N8N_CONTAINER}' n8n import:credentials --input='${REMOTE_TMP}' &&
    docker exec '${N8N_CONTAINER}' rm -f '${REMOTE_TMP}' &&
    shred -u '${REMOTE_TMP}' 2>/dev/null || rm -f '${REMOTE_TMP}'
  "
fi

echo "Done. Credential ids: imap=${IMAP_ID} smtp=${SMTP_ID}"
echo "Next: generate the per-account workflow clones —"
echo "  bin/mbox-imap-clone.sh ${ACCOUNT_EMAIL} ${IMAP_ID} ${SMTP_ID}"
echo "Then restart n8n: ssh ${SSH_HOST} 'cd ~/mailbox && docker compose restart n8n'"
