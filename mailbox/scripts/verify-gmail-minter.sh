#!/usr/bin/env bash
# verify-gmail-minter.sh — READ-ONLY pre-deploy verification for the MBOX-466/464
# Gmail token-minter re-point (PR #51). Answers the addendum-01 carry-over
# questions for a target box before deploying the dashboard change.
#
# It checks, on the box:
#   1. Which MailBOX ingest path is live in n8n — token-as-data (calls the
#      /api/internal/google/access-token minter) vs the legacy native gmail node.
#   2. Whether the account is connected as the `google_gmail` provider in
#      mailbox.oauth_tokens (the post-fix PRIMARY store).
#   3. Whether a legacy Hermes plaintext file exists (the deprecated FALLBACK).
#   4. HERMES_INTERNAL_TOKEN presence + parity between the dashboard and n8n
#      containers (compared by hash — the secret is NEVER printed).
#   5. inbox_messages count (the original MBOX-464 empty-inbox symptom).
#   6. A live smoke of the minter over the docker network (reports HTTP status +
#      whether an access_token came back — the token itself is NEVER printed).
#
# NOTHING here mutates state. No writes, no restarts, no token values in output.
#
# Usage:
#   REMOTE=UMB@100.127.2.54 ACCOUNT_EMAIL=consultingfutures@gmail.com \
#     mailbox/scripts/verify-gmail-minter.sh
#
# Env (override container/DB names if a box differs):
#   REMOTE          ssh target (required)        e.g. UMB@100.127.2.54
#   ACCOUNT_EMAIL   the Gmail account to check   (required)
#   PG_CTR          postgres container  (default mailbox-postgres-1)
#   N8N_CTR         n8n container       (default mailbox-n8n-1)
#   DASH_CTR        dashboard container (default mailbox-dashboard)
#   PG_DB / PG_USER postgres db/user    (default mailbox / mailbox)
#   DASH_INTERNAL_URL  in-network minter URL
#                   (default http://mailbox-dashboard:3001/dashboard/api/internal/google/access-token)
#
# Exit: 0 if no FAIL, 1 if any FAIL. WARNs do not fail the run.

set -u

REMOTE="${REMOTE:?set REMOTE=<ssh target>, e.g. UMB@100.127.2.54}"
ACCOUNT_EMAIL="${ACCOUNT_EMAIL:?set ACCOUNT_EMAIL=<gmail address to check>}"
PG_CTR="${PG_CTR:-mailbox-postgres-1}"
N8N_CTR="${N8N_CTR:-mailbox-n8n-1}"
DASH_CTR="${DASH_CTR:-mailbox-dashboard}"
PG_DB="${PG_DB:-mailbox}"
PG_USER="${PG_USER:-mailbox}"
DASH_INTERNAL_URL="${DASH_INTERNAL_URL:-http://mailbox-dashboard:3001/dashboard/api/internal/google/access-token}"

FAILED=0
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
warn() { printf '  \033[33mWARN\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAILED=1; }
hdr()  { printf '\n\033[1m%s\033[0m\n' "$1"; }

# One persistent multiplexed SSH would be nicer, but keep it dependency-free:
# each check is its own bounded, BatchMode (no-prompt) ssh call.
rsh() { ssh -o BatchMode=yes -o ConnectTimeout=8 "$REMOTE" "$@"; }

# Lowercase the email the same way the route does (EMAIL_RE + toLowerCase()).
EMAIL="$(printf '%s' "$ACCOUNT_EMAIL" | tr '[:upper:]' '[:lower:]')"

printf '\033[1mGmail minter pre-deploy verification\033[0m  (READ-ONLY)\n'
printf 'box=%s  account=%s\n' "$REMOTE" "$EMAIL"

# ── 0. reachability ──────────────────────────────────────────────────────────
hdr '0. box reachability'
if rsh 'true' 2>/dev/null; then
  pass "ssh $REMOTE reachable"
else
  fail "ssh $REMOTE NOT reachable (BatchMode) — fix access and re-run"
  printf '\nAborting: cannot reach the box.\n'; exit 1
fi

# ── 1. live ingest path in n8n ───────────────────────────────────────────────
# n8n shares the mailbox Postgres (workflow_entity in the same DB). We inspect the
# stored nodes JSON. CAVEAT (n8n 2.x): webhook workflows run from
# workflow_published_version, not workflow_entity — for the schedule-triggered
# MailBOX parent this is a strong signal, but confirm in the editor if ambiguous.
hdr '1. live MailBOX ingest path (token-as-data vs native gmail node)'
USES_MINTER="$(rsh "docker exec $PG_CTR psql -U $PG_USER -d $PG_DB -tAc \
  \"select count(*) from workflow_entity where name like 'MailBOX%' and nodes::text ilike '%access-token%'\"" 2>/dev/null | tr -d '[:space:]')"
USES_GMAIL_NODE="$(rsh "docker exec $PG_CTR psql -U $PG_USER -d $PG_DB -tAc \
  \"select count(*) from workflow_entity where name like 'MailBOX%' and nodes::text ilike '%n8n-nodes-base.gmail%'\"" 2>/dev/null | tr -d '[:space:]')"
if [ "${USES_MINTER:-0}" != "0" ] && [ -n "${USES_MINTER:-}" ]; then
  pass "MailBOX workflow calls the access-token minter (token-as-data) — the dashboard fix IS the lever"
elif [ "${USES_GMAIL_NODE:-0}" != "0" ]; then
  fail "MailBOX ingest still uses a native n8n-nodes-base.gmail node — deploy the token-as-data MailBOX.json too, the dashboard fix alone won't wire ingest"
else
  warn "could not classify the ingest path (workflow_entity query empty) — check the n8n editor / publish state manually"
fi

# ── 2. google_gmail grant in oauth_tokens (PRIMARY store) ─────────────────────
hdr '2. oauth_tokens google_gmail grant (post-fix PRIMARY store)'
GRANT="$(rsh "docker exec $PG_CTR psql -U $PG_USER -d $PG_DB -tAc \
  \"select account_id || '|' || coalesce(scope,'') || '|' || (refresh_token_enc is not null) from mailbox.oauth_tokens o join mailbox.accounts a on a.id=o.account_id where o.provider='google_gmail' and lower(a.email_address)='$EMAIL'\"" 2>/dev/null | tr -d '[:space:]')"
if [ -n "$GRANT" ]; then
  AID="${GRANT%%|*}"; rest="${GRANT#*|}"; SCOPE="${rest%%|*}"; HASTOK="${rest##*|}"
  if [ "$HASTOK" = "t" ]; then
    pass "google_gmail grant present (account_id=$AID, refresh_token stored)"
    case "$SCOPE" in
      *gmail.readonly*|*gmail.modify*|*mail.google.com*) pass "stored scope covers gmail read ($SCOPE)";;
      *) warn "stored scope may not cover gmail read: '$SCOPE' — getAccessToken scope-guard would surface needs_reconsent";;
    esac
  else
    fail "google_gmail row exists but refresh_token_enc is NULL — reconnect Gmail in the dashboard"
  fi
else
  warn "no google_gmail grant for $EMAIL in oauth_tokens — PRIMARY path will 404 and fall back to the Hermes file (check #3). Connect Gmail (google_gmail provider) in the dashboard to use the SoT path"
fi

# ── 3. legacy Hermes file (deprecated FALLBACK) ──────────────────────────────
hdr '3. Hermes plaintext file store (deprecated FALLBACK)'
HERMES_HOME_GUESS="\${HERMES_HOME:-\$HOME/.hermes}"
if rsh "test -f $HERMES_HOME_GUESS/google_accounts/$EMAIL.json" 2>/dev/null; then
  warn "Hermes file present for $EMAIL — fallback works, but this is the plaintext store slated for removal; prefer the oauth_tokens grant (#2)"
else
  pass "no Hermes plaintext file for $EMAIL (good — nothing depending on the deprecated store)"
fi

# ── 4. HERMES_INTERNAL_TOKEN presence + parity (secret never printed) ─────────
hdr '4. HERMES_INTERNAL_TOKEN presence + dashboard/n8n parity'
H_DASH="$(rsh "docker exec $DASH_CTR sh -c 'printf %s \"\${HERMES_INTERNAL_TOKEN:-}\" | sha256sum | cut -d\" \" -f1'" 2>/dev/null)"
H_N8N="$(rsh "docker exec $N8N_CTR sh -c 'printf %s \"\${HERMES_INTERNAL_TOKEN:-}\" | sha256sum | cut -d\" \" -f1'" 2>/dev/null)"
EMPTY_SHA="$(printf '' | sha256sum | cut -d' ' -f1)"
if [ -z "$H_DASH" ] || [ "$H_DASH" = "$EMPTY_SHA" ]; then
  fail "HERMES_INTERNAL_TOKEN unset in $DASH_CTR — minter fails closed (every request 401)"
elif [ -z "$H_N8N" ] || [ "$H_N8N" = "$EMPTY_SHA" ]; then
  fail "HERMES_INTERNAL_TOKEN unset in $N8N_CTR — n8n can't authenticate to the minter"
elif [ "$H_DASH" = "$H_N8N" ]; then
  pass "HERMES_INTERNAL_TOKEN set and matches across dashboard + n8n"
else
  fail "HERMES_INTERNAL_TOKEN MISMATCH between dashboard and n8n — n8n's requests 401"
fi

# ── 5. inbox_messages count (MBOX-464 symptom) ───────────────────────────────
hdr '5. inbox_messages count (the MBOX-464 symptom)'
NMSG="$(rsh "docker exec $PG_CTR psql -U $PG_USER -d $PG_DB -tAc 'select count(*) from mailbox.inbox_messages'" 2>/dev/null | tr -d '[:space:]')"
if [ -n "$NMSG" ] && [ "$NMSG" != "0" ]; then
  pass "inbox_messages = $NMSG (ingestion has produced rows)"
elif [ "$NMSG" = "0" ]; then
  warn "inbox_messages = 0 (the reported symptom) — expected until the minter serves a token and a poll cycle runs"
else
  warn "could not read inbox_messages count"
fi

# ── 6. live minter smoke over the docker network (token never printed) ───────
# Hits the CURRENTLY DEPLOYED dashboard. Pre-deploy, an oauth_tokens-only box is
# EXPECTED to 404 here (this is the bug); post-deploy it should 200.
hdr '6. live minter smoke (current deployed dashboard)'
SMOKE="$(rsh "docker exec $N8N_CTR sh -c 'curl -s -o /tmp/.mintbody -w \"%{http_code}\" -H \"X-Hermes-Internal-Token: \$HERMES_INTERNAL_TOKEN\" \"$DASH_INTERNAL_URL?account_email=$EMAIL\"; echo; grep -q access_token /tmp/.mintbody && echo HASTOK || echo NOTOK; rm -f /tmp/.mintbody'" 2>/dev/null)"
CODE="$(printf '%s\n' "$SMOKE" | sed -n '1p')"
TOK="$(printf '%s\n' "$SMOKE" | sed -n '2p')"
case "$CODE" in
  200) [ "$TOK" = "HASTOK" ] && pass "minter returned 200 with an access_token" || warn "minter 200 but no access_token field — inspect the route" ;;
  401) fail "minter 401 — HERMES_INTERNAL_TOKEN mismatch (see #4)" ;;
  404) warn "minter 404 (account connected in neither store on the CURRENT dashboard) — expected pre-deploy if oauth_tokens-only; should flip to 200 after deploying PR #51" ;;
  400) warn "minter 400 — account_email malformed (check the value)" ;;
  502) warn "minter 502 — Google token refresh failed (revoked/insufficient grant); reconnect Gmail" ;;
  "" ) warn "minter smoke produced no HTTP code — curl unavailable in n8n container or network blocked" ;;
  *  ) warn "minter returned HTTP $CODE — inspect manually" ;;
esac

hdr 'summary'
if [ "$FAILED" = "0" ]; then
  printf '  \033[32mNo FAILs.\033[0m Review WARNs above before deploying PR #51.\n'
  exit 0
else
  printf '  \033[31mFAILs present.\033[0m Resolve them before deploying PR #51.\n'
  exit 1
fi
