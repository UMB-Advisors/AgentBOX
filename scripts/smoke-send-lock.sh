#!/usr/bin/env bash
# smoke-send-lock.sh — Verify MailBOX-Send CAS idempotency lock (STAQPRO-IDEM-2026-05-22).
#
# Scenario A (default, SAFE): pre-set drafts.send_attempt_at, fire the webhook, assert
# the response is HTTP 409 with the 'send_attempt_at already set' body, restore state.
# Does NOT send a real email — Gmail Reply is never reached.
#
# Scenario B (--live-send): clears the lock and fires the webhook with the same draft_id.
# Gmail Reply WILL fire and a real reply WILL go out. Only use with a test draft pointed
# at a safe address. Requires --i-mean-it as an additional safety latch.
#
# Run from the workstation (uses ssh) or directly on the appliance.
#
# Usage:
#   bash scripts/smoke-send-lock.sh [--host <ssh-alias>] [--draft-id N]   # default host: mailbox1
#   bash scripts/smoke-send-lock.sh --host mailbox1 --live-send --i-mean-it --draft-id 999
#
# NOTE: mailbox1 (M1, Heron Labs) is the only live MailBOX appliance. mailbox2 was
# repurposed for the OpenClaw stack (2026-05-22) — do NOT target it for MailBOX smokes.
#
# Exit codes:
#   0 = lock works as expected (Scenario A passes; or Scenario B 200 success path)
#   1 = test failed (unexpected response code / body / DB state)
#   2 = setup error (no approved draft found, ssh/docker failure, etc)

set -euo pipefail

# ───────────────────────── Arg parse ─────────────────────────
HOST="mailbox1"
DRAFT_ID=""
LIVE_SEND=false
I_MEAN_IT=false
SSH_PREFIX=""

usage() {
  sed -n '2,30p' "$0"
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --draft-id) DRAFT_ID="$2"; shift 2 ;;
    --live-send) LIVE_SEND=true; shift ;;
    --i-mean-it) I_MEAN_IT=true; shift ;;
    -h|--help) usage ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done

if $LIVE_SEND && ! $I_MEAN_IT; then
  echo "ERROR: --live-send requires --i-mean-it (a real Gmail reply will be sent)." >&2
  exit 2
fi

# If $HOST equals current hostname, run locally; otherwise ssh.
if [[ "$(hostname -s 2>/dev/null || true)" != "$HOST" ]]; then
  SSH_PREFIX="ssh $HOST"
fi

run_remote() {
  if [[ -z "$SSH_PREFIX" ]]; then
    bash -c "$1"
  else
    $SSH_PREFIX "$1"
  fi
}

# ───────────────────────── Helpers ─────────────────────────
psql_q() {
  # $1 = SQL, returns tab-stripped tuple-only output
  run_remote "docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -tAc \"$1\""
}

webhook_post() {
  # POST {draft_id: N} to the internal n8n webhook from the dashboard container's
  # network namespace. Prints "<http_status>|<body>" on one line.
  local draft_id="$1"
  run_remote "docker exec mailbox-dashboard node -e '
    (async () => {
      const u = \"http://n8n:5678/webhook/mailbox-send\";
      const r = await fetch(u, {
        method: \"POST\",
        headers: { \"content-type\": \"application/json\" },
        body: JSON.stringify({ draft_id: $draft_id }),
      });
      const text = await r.text();
      process.stdout.write(r.status + \"|\" + text);
    })();
  '"
}

pretty() {
  local color="$1"; shift
  case "$color" in
    green)  printf '\033[32m%s\033[0m\n' "$*" ;;
    red)    printf '\033[31m%s\033[0m\n' "$*" ;;
    yellow) printf '\033[33m%s\033[0m\n' "$*" ;;
    blue)   printf '\033[34m%s\033[0m\n' "$*" ;;
    *)      echo "$*" ;;
  esac
}

assert_eq() {
  local what="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pretty green "  ✓ $what = $actual"
  else
    pretty red "  ✗ $what — expected: $expected — actual: $actual"
    return 1
  fi
}

# ──────────── Static n8n expression lint pre-check (MBOX-345) ────────────
# Catch the MBOX-344 class (a node inserted upstream silently blanking a
# downstream $json.* read) BEFORE touching the appliance. Runs locally against
# the committed workflow JSON via the vitest guard. The authoritative gate is
# the same test in CI (`dashboard (typecheck + test)`); this is a convenience
# pre-deploy hook. Guarded so a missing npx / uninstalled dashboard (e.g. when
# run on the appliance) skips instead of failing the smoke.
LINT_DIR="$(cd "$(dirname "$0")/.." && pwd)/dashboard"
if command -v npx >/dev/null 2>&1 && [[ -d "$LINT_DIR/node_modules" ]]; then
  pretty blue "── Static n8n expr-lint (MBOX-345) ──"
  LINT_LOG="$(mktemp)"
  if ( cd "$LINT_DIR" && npx vitest run test/n8n-expr-lint.test.ts >"$LINT_LOG" 2>&1 ); then
    pretty green "  ✓ n8n workflow expressions lint clean"
    rm -f "$LINT_LOG"
  else
    pretty red "  ✗ n8n expr-lint FAILED — a workflow reads a \$json field its predecessor doesn't produce (MBOX-344 class):"
    cat "$LINT_LOG" >&2
    rm -f "$LINT_LOG"
    exit 1
  fi
else
  pretty yellow "Skipping static n8n expr-lint (npx/dashboard unavailable) — CI gate is authoritative."
fi

# ───────────────────────── Setup ─────────────────────────
pretty blue "═══ MailBOX-Send idempotency lock smoke ═══"
pretty blue "Host: $HOST  ($([ -z "$SSH_PREFIX" ] && echo 'local' || echo 'via ssh'))"

# Pre-check: send_attempt_at column exists
col=$(psql_q "SELECT column_name FROM information_schema.columns WHERE table_schema='mailbox' AND table_name='drafts' AND column_name='send_attempt_at';")
if [[ "$col" != "send_attempt_at" ]]; then
  pretty red "FATAL: drafts.send_attempt_at column not found on $HOST. Did migration 025 run?"
  exit 2
fi

# Pre-check: workflow active
wf_active=$(psql_q "SELECT active FROM workflow_entity WHERE name='MailBOX-Send';")
if [[ "$wf_active" != "t" ]]; then
  pretty red "FATAL: MailBOX-Send workflow is not active. Publish it in the n8n editor first."
  exit 2
fi

# Pre-check: Acquire Send Lock node present (proves the new workflow was imported)
new_node=$(psql_q "SELECT COUNT(*) FROM workflow_entity we, jsonb_array_elements(we.nodes::jsonb) n WHERE we.name='MailBOX-Send' AND n->>'name'='Acquire Send Lock';")
if [[ "$new_node" != "1" ]]; then
  pretty red "FATAL: 'Acquire Send Lock' node not found in MailBOX-Send. Did the updated JSON get imported?"
  exit 2
fi

# Pick or accept a target draft
if [[ -z "$DRAFT_ID" ]]; then
  DRAFT_ID=$(psql_q "SELECT id FROM mailbox.drafts WHERE status IN ('approved','edited') ORDER BY id DESC LIMIT 1;")
  if [[ -z "$DRAFT_ID" ]]; then
    pretty red "FATAL: no approved/edited draft found on $HOST. Pass --draft-id or create one."
    exit 2
  fi
  pretty yellow "Auto-selected draft id=$DRAFT_ID (latest approved/edited)."
else
  status=$(psql_q "SELECT status FROM mailbox.drafts WHERE id=$DRAFT_ID;")
  if [[ "$status" != "approved" && "$status" != "edited" ]]; then
    pretty red "FATAL: draft $DRAFT_ID has status=$status (not approved/edited)."
    exit 2
  fi
fi

# Snapshot initial state for restore
INITIAL_SEND_ATTEMPT=$(psql_q "SELECT COALESCE(send_attempt_at::text,'NULL') FROM mailbox.drafts WHERE id=$DRAFT_ID;")
INITIAL_STATUS=$(psql_q "SELECT status FROM mailbox.drafts WHERE id=$DRAFT_ID;")
INITIAL_SENT_GMAIL_ID=$(psql_q "SELECT COALESCE(sent_gmail_message_id,'NULL') FROM mailbox.drafts WHERE id=$DRAFT_ID;")
pretty blue "Initial: id=$DRAFT_ID status=$INITIAL_STATUS send_attempt_at=$INITIAL_SEND_ATTEMPT sent_gmail_message_id=$INITIAL_SENT_GMAIL_ID"

restore() {
  local snap_send="$1" snap_status="$2"
  if [[ "$snap_send" == "NULL" ]]; then
    psql_q "UPDATE mailbox.drafts SET send_attempt_at=NULL, status='$snap_status' WHERE id=$DRAFT_ID;" >/dev/null
  else
    psql_q "UPDATE mailbox.drafts SET send_attempt_at='$snap_send', status='$snap_status' WHERE id=$DRAFT_ID;" >/dev/null
  fi
  pretty yellow "Restored initial state for draft $DRAFT_ID."
}
trap 'restore "$INITIAL_SEND_ATTEMPT" "$INITIAL_STATUS"' EXIT

# ───────────────────────── Scenario A: lock blocks retry ─────────────────────────
pretty blue ""
pretty blue "── Scenario A: pre-lock + retry should 409 ──"

# Force the lock
psql_q "UPDATE mailbox.drafts SET send_attempt_at=NOW() WHERE id=$DRAFT_ID;" >/dev/null
pretty yellow "Set send_attempt_at=NOW() on draft $DRAFT_ID."

# Fire webhook
response=$(webhook_post "$DRAFT_ID")
status_code="${response%%|*}"
body="${response#*|}"

pretty blue "Webhook response: HTTP $status_code"
pretty blue "Body: $body"

fail=0
assert_eq "HTTP status" "409" "$status_code" || fail=1
if [[ "$body" == *"send_attempt_at"* ]]; then
  pretty green "  ✓ body mentions send_attempt_at"
else
  pretty red "  ✗ body missing 'send_attempt_at' hint"
  fail=1
fi

# Confirm draft was NOT mutated by the workflow
post_status=$(psql_q "SELECT status FROM mailbox.drafts WHERE id=$DRAFT_ID;")
post_sent_id=$(psql_q "SELECT COALESCE(sent_gmail_message_id,'NULL') FROM mailbox.drafts WHERE id=$DRAFT_ID;")
assert_eq "post-call status (unchanged)" "$INITIAL_STATUS" "$post_status" || fail=1
assert_eq "post-call sent_gmail_message_id (unchanged)" "$INITIAL_SENT_GMAIL_ID" "$post_sent_id" || fail=1

if [[ $fail -ne 0 ]]; then
  pretty red "Scenario A FAILED."
  exit 1
fi
pretty green "Scenario A PASSED — lock correctly refused the retry."

# ───────────────────────── Scenario B (optional, --live-send) ─────────────────────────
if $LIVE_SEND; then
  pretty blue ""
  pretty blue "── Scenario B (--live-send): clear lock + real send ──"
  pretty red "⚠ A REAL Gmail reply will be sent for draft $DRAFT_ID."

  psql_q "UPDATE mailbox.drafts SET send_attempt_at=NULL, status='approved' WHERE id=$DRAFT_ID;" >/dev/null
  pretty yellow "Cleared send_attempt_at and forced status='approved'."

  response=$(webhook_post "$DRAFT_ID")
  status_code="${response%%|*}"
  body="${response#*|}"

  pretty blue "Webhook response: HTTP $status_code"
  pretty blue "Body: $body"

  fail=0
  assert_eq "HTTP status" "200" "$status_code" || fail=1
  if [[ "$body" == *"\"success\":true"* ]]; then
    pretty green "  ✓ body indicates success"
  else
    pretty red "  ✗ body missing success:true"
    fail=1
  fi

  sleep 1
  post_status=$(psql_q "SELECT status FROM mailbox.drafts WHERE id=$DRAFT_ID;")
  post_send_attempt=$(psql_q "SELECT COALESCE(send_attempt_at::text,'NULL') FROM mailbox.drafts WHERE id=$DRAFT_ID;")
  post_sent_id=$(psql_q "SELECT COALESCE(sent_gmail_message_id,'NULL') FROM mailbox.drafts WHERE id=$DRAFT_ID;")

  assert_eq "post-send status" "sent" "$post_status" || fail=1
  assert_eq "post-send send_attempt_at (cleared)" "NULL" "$post_send_attempt" || fail=1
  if [[ "$post_sent_id" == "NULL" ]]; then
    pretty red "  ✗ sent_gmail_message_id is NULL — Mark Sent didn't capture Gmail's id"
    fail=1
  else
    pretty green "  ✓ sent_gmail_message_id captured: $post_sent_id"
  fi

  # Don't restore — the draft is legitimately sent now.
  trap - EXIT
  if [[ $fail -ne 0 ]]; then
    pretty red "Scenario B FAILED (NOTE: an email may have gone out)."
    exit 1
  fi
  pretty green "Scenario B PASSED. Draft $DRAFT_ID is now status=sent."
fi

pretty blue ""
pretty green "═══ All scenarios passed ═══"
