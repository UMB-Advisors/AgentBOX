#!/usr/bin/env bash
# smoke-pipeline.sh — MailBox One end-to-end pipeline smoke (ingest → classify → draft)
#
# MBOX-181 (M5 "OTA + QA validation"). Exercises the LIVE classify→draft
# pipeline with a SYNTHETIC inbound message and asserts a draft lands in
# mailbox.drafts — WITHOUT sending any real email. This is the pipeline-level
# companion to scripts/smoke-test.sh (which is INFRA-only: GPU / Ollama /
# Qdrant / Postgres and does NOT exercise the pipeline).
#
# ── WHY THIS DRIVES THE ROUTES, NOT n8n (MBOX-181 follow-up) ─────────────────
#   The original revision triggered classify via
#   `n8n execute --id=<classify-sub> --file=<input>`. That CANNOT work on
#   n8n 2.14.2: `n8n execute` only supports `--id` / `--rawOutput` (`--file`
#   is DEPRECATED — the CLI prints "use --id instead"), and there is NO way to
#   pass input data. The classify sub's only trigger is a `passthrough`
#   executeWorkflowTrigger, so it would run with empty input and never
#   classify. (Confirmed on mailbox1.)
#
#   So instead of triggering n8n, this script DRIVES THE DASHBOARD INTERNAL
#   ROUTES + LLM PROXY DIRECTLY, replicating exactly what MailBOX-Classify and
#   MailBOX-Draft do node-for-node. This bypasses n8n orchestration but
#   exercises the REAL prompts, models, route logic, DB writes, and triggers
#   (classification_log denorm trigger, drafts state machine). The route call
#   sequence and the two Postgres INSERTs below are a faithful transcription of
#   n8n/workflows/MailBOX-Classify.json + MailBOX-Draft.json.
#
# ── WHAT IT DOES ─────────────────────────────────────────────────────────────
#   CLASSIFY (replicates MailBOX-Classify):
#     1. INSERT a synthetic row into mailbox.inbox_messages (deterministic,
#        tagged message_id so cleanup is precise and re-runs are idempotent).
#     2. POST /classification-prompt {from,subject,body} → {prompt, model}
#     3. POST /llm/api/generate {model,prompt,stream:false,format:"json",
#        think:false,options:{temperature:0,num_predict:64}} → {response,...}
#     4. POST /classification-normalize {raw,from,to} → ClassificationResult
#        ({category, confidence, route, json_parse_ok, think_stripped,
#          raw_output, preclass_applied, preclass_source, suppression_reason}).
#     5. INSERT into mailbox.classification_log (fires the inbox denorm
#        trigger). Columns mirror the "Insert Classification Log" node.
#     6. GET /onboarding/live-gate → if NOT live, NO draft is created. Recorded
#        as a gated/healthy outcome (exit 0), not a failure. If category is
#        'spam_marketing', the draft is dropped (no draft) — also healthy.
#     7. INSERT the draft stub into mailbox.drafts (mirrors "Insert Draft Stub":
#        draft_body='', model='pending', status='pending', auto_send_blocked
#        =(category=='escalate'), plus the inbound fields draft-prompt reads).
#        RETURNING the new draft id.
#
#   DRAFT (replicates MailBOX-Draft, with the draft_id from step 7):
#     8. POST /draft-prompt {draft_id} → {messages, baseUrl, apiKey, model,
#        source, display_label, temperature, max_tokens, ...}
#     9. POST {baseUrl}/api/chat {model,messages,stream:false,options:
#        {temperature,num_predict:max_tokens}} (Authorization: Bearer <apiKey>
#        only when apiKey is non-empty) → {message:{content},
#        prompt_eval_count, eval_count}
#    10. POST /draft-finalize {draft_id,body,source,model,input_tokens,
#        output_tokens} → finalizes the draft (status stays 'pending').
#
#   Then POLL/ASSERT mailbox.drafts:
#     - status ∈ {pending, awaiting_cloud}
#     - classification_category set + valid
#     - draft_body non-empty (LLM produced text)
#     - draft_source + model set
#   Finally CLEAN UP the synthetic rows via the EXIT trap.
#
# ── THE SEND SEAM (intentional) ──────────────────────────────────────────────
#   This script NEVER approves the draft and NEVER calls the mailbox-send
#   webhook, so Gmail Reply is structurally never reached. No real email can be
#   sent by this script. The draft lands at status='pending' and the
#   approve→Run-Send-Sub→Gmail-Reply path is reachable ONLY by operator
#   approval, which this script does not perform.
#
# NOTE on status value: the LIVE drafts_status_check CHECK constraint
# (dashboard/migrations/003-evolve-drafts-to-queue-shape-v1-2026-04-27.sql,
# narrowed by migration 016) is { pending | awaiting_cloud | approved |
# rejected | edited | sent } — there is NO 'pending_approval' value. A fresh
# draft lands at 'pending'; a cloud-route draft may transiently sit at
# 'awaiting_cloud'. This script accepts EITHER (configurable via
# SMOKE_ACCEPT_STATUSES) and treats 'pending' as the canonical green.
#
# ── HTTP CLIENT / REACHABILITY ───────────────────────────────────────────────
#   The dashboard internal routes are docker-network-internal (port 3001 may
#   not be host-published, esp. on M2). All route calls run from INSIDE the
#   mailbox-dashboard container (which can reach its own port) via
#   `docker exec mailbox-dashboard <client> http://127.0.0.1:3001/dashboard/...`.
#   The client (curl or wget) is probed once and reused. JSON payloads are
#   base64-encoded on the way in and decoded to a temp file inside the
#   container, so nested ssh+docker+shell quoting never mangles them.
#
# RUN LOCATION
#   Run from the workstation (uses ssh) OR directly on the appliance.
#   If --host matches the local hostname or is 'local', runs with no ssh hop.
#
# USAGE
#   bash scripts/smoke-pipeline.sh [--host mailbox1|mailbox2|local] [--keep]
#                                  [--timeout SECONDS] [--cloud]
#
#   --host HOST        Appliance ssh alias or 'local' (default: mailbox1).
#   --keep             Do NOT clean up the synthetic rows (debugging).
#   --timeout SECONDS  Max seconds to wait for the draft body to finalize
#                      (default 90; covers the <60s cloud-path SLA + headroom).
#   --cloud            Use a synthetic message engineered to route to the cloud
#                      path (category 'escalate'); default routes local.
#   -h | --help        Show this header.
#
# EXIT CODES (usable as an OTA gate — non-zero blocks the rollout)
#   0  pipeline produced a valid draft (ingest → classify → draft all OK), OR
#      the live-gate is closed / category dropped (healthy gated outcome).
#   1  assertion failed (no draft, empty body, wrong status/category, etc.)
#   2  setup/precondition error (route unreachable, schema missing, LLM proxy
#      down, ssh/docker failure)
#
# IDEMPOTENT: the synthetic message_id is deterministic per --cloud flag, and
# the script removes any pre-existing synthetic rows before seeding. A trap
# guarantees cleanup even on mid-run failure (unless --keep).

set -euo pipefail

# ───────────────────────── Defaults / arg parse ─────────────────────────
HOST="mailbox1"
KEEP=false
TIMEOUT=90
CLOUD=false

usage() { sed -n '2,118p' "$0"; exit 2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)    HOST="$2"; shift 2 ;;
    --keep)    KEEP=true; shift ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --cloud)   CLOUD=true; shift ;;
    -h|--help) usage ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done

if ! [[ "$TIMEOUT" =~ ^[0-9]+$ ]]; then
  echo "ERROR: --timeout must be an integer (seconds), got: $TIMEOUT" >&2
  exit 2
fi

# Tunable knobs (env overrides — never required).
DASH_CONTAINER="${SMOKE_DASH_CONTAINER:-mailbox-dashboard}"
PG_CONTAINER="${SMOKE_PG_CONTAINER:-mailbox-postgres-1}"
PG_USER="${SMOKE_PG_USER:-mailbox}"
PG_DB="${SMOKE_PG_DB:-mailbox}"
ACCEPT_STATUSES="${SMOKE_ACCEPT_STATUSES:-pending awaiting_cloud}"
# Internal route base, relative to the dashboard container's own port. basePath
# is /dashboard (see memory: dashboard runs under basePath /dashboard) and these
# internal routes are NOT Caddy-auth-gated — reached over the docker network.
DASH_BASE="${SMOKE_DASH_BASE:-http://127.0.0.1:3001/dashboard}"

# ───────────────────────── local-or-ssh plumbing ─────────────────────────
SSH_PREFIX=""
if [[ "$HOST" != "local" && "$(hostname -s 2>/dev/null || true)" != "$HOST" ]]; then
  SSH_PREFIX="ssh $HOST"
fi

run_remote() {
  if [[ -z "$SSH_PREFIX" ]]; then bash -c "$1"; else $SSH_PREFIX "$1"; fi
}

# tuple-only psql query against the appliance Postgres. -q suppresses the
# command tag ("INSERT 0 1" etc); -tA strips headers/alignment. Combined with
# the data-modifying-CTE pattern for inserts (WITH ins AS (INSERT...RETURNING)
# SELECT...), id captures come back as a clean numeric line. (MBOX-181 defect 1)
psql_q() {
  run_remote "docker exec ${PG_CONTAINER} psql -q -U ${PG_USER} -d ${PG_DB} -tAc \"$1\""
}

# SQL-escape single quotes for inline literals.
sql_lit() { printf "%s" "${1//\'/\'\'}"; }

# ───────────────────────── HTTP client (in dashboard container) ─────────────
# Probe once for curl or wget inside the dashboard container; pick whichever is
# present so the script is portable across M1/M2 images.
HTTP_CLIENT=""
probe_http_client() {
  if run_remote "docker exec ${DASH_CONTAINER} sh -c 'command -v curl >/dev/null 2>&1'"; then
    HTTP_CLIENT="curl"
  elif run_remote "docker exec ${DASH_CONTAINER} sh -c 'command -v wget >/dev/null 2>&1'"; then
    HTTP_CLIENT="wget"
  else
    return 1
  fi
}

# ── POST helper internals ────────────────────────────────────────────────────
# Quoting strategy: the JSON payload is base64'd on the host and PIPED (as one
# line on stdin) into `docker exec -i ... sh -c '<fixed script>' <positional
# args>`. The inner script is a FIXED single-quoted string (no host-side
# interpolation), and the URL / auth flag arrive as POSITIONAL args ($0 $1) —
# so $f, $? and the URL never pass through the ssh→bash→docker→sh quoting
# gauntlet. This is the reliable pattern for nested ssh+docker+shell.
#
# The inner script reads the b64 payload from stdin, decodes to a temp file,
# and POSTs it. curl uses --data @file; wget uses --post-file.

# _post_via <absolute-url> <b64-payload> <bearer-or-empty>  → body on stdout.
_post_via() {
  local url="$1" b64="$2" token="${3:-}"
  if [[ "$HTTP_CLIENT" == "curl" ]]; then
    # $0=url $1=token (may be empty). Auth header added only when token non-empty.
    printf '%s' "$b64" | run_remote "docker exec -i ${DASH_CONTAINER} sh -c '
      f=\$(mktemp); base64 -d > \"\$f\"
      if [ -n \"\$1\" ]; then
        curl -sS -X POST -H \"Content-Type: application/json\" -H \"Authorization: Bearer \$1\" --data @\"\$f\" \"\$0\"
      else
        curl -sS -X POST -H \"Content-Type: application/json\" --data @\"\$f\" \"\$0\"
      fi
      rc=\$?; rm -f \"\$f\"; exit \$rc
    ' '$url' '$token'"
  else
    printf '%s' "$b64" | run_remote "docker exec -i ${DASH_CONTAINER} sh -c '
      f=\$(mktemp); base64 -d > \"\$f\"
      if [ -n \"\$1\" ]; then
        wget -q -O - --header=\"Content-Type: application/json\" --header=\"Authorization: Bearer \$1\" --post-file=\"\$f\" \"\$0\"
      else
        wget -q -O - --header=\"Content-Type: application/json\" --post-file=\"\$f\" \"\$0\"
      fi
      rc=\$?; rm -f \"\$f\"; exit \$rc
    ' '$url' '$token'"
  fi
}

# http_post <path> <json-payload>  → response body on stdout (no headers).
http_post() {
  local b64
  b64="$(printf '%s' "$2" | base64 | tr -d '\n')"
  _post_via "${DASH_BASE}$1" "$b64" ""
}

# http_post_abs <absolute-url> <json> [<bearer-token>]  → body. Used for the
# {baseUrl}/api/chat call where baseUrl comes back from /draft-prompt and may
# be the local LLM proxy or an external cloud endpoint. Auth header added only
# when the token is non-empty (local route has empty key).
http_post_abs() {
  local b64
  b64="$(printf '%s' "$2" | base64 | tr -d '\n')"
  _post_via "$1" "$b64" "${3:-}"
}

# http_get <path>  → response body on stdout.
http_get() {
  local url="${DASH_BASE}$1"
  if [[ "$HTTP_CLIENT" == "curl" ]]; then
    run_remote "docker exec ${DASH_CONTAINER} curl -sS '$url'"
  else
    run_remote "docker exec ${DASH_CONTAINER} wget -q -O - '$url'"
  fi
}

# Pull a top-level string/number field out of a JSON blob using the dashboard
# container's node (always present — it's the Next.js runtime). Dotted paths
# supported (e.g. "message.content"). Empty string if missing/null.
json_field() {
  local json="$1" path="$2" b64
  b64="$(printf '%s' "$json" | base64 | tr -d '\n')"
  run_remote "docker exec -i ${DASH_CONTAINER} node -e '
    const p = process.argv[1].split(\".\");
    let v;
    try { v = JSON.parse(Buffer.from(process.argv[2], \"base64\").toString(\"utf8\")); }
    catch (e) { process.exit(0); }
    for (const k of p) { if (v == null) break; v = v[k]; }
    if (v === undefined || v === null) process.exit(0);
    if (typeof v === \"object\") { process.stdout.write(JSON.stringify(v)); }
    else process.stdout.write(String(v));
  ' '$path' '$b64'"
}

# build_json k1 v1 k2 v2 ...  → JSON object string (string values only). Built
# with the dashboard container's node so escaping (quotes, newlines, unicode in
# the email body) is bulletproof — far safer than printf-ing JSON by hand.
build_json() {
  local args=("$@") b64
  b64="$(printf '%s\0' "${args[@]}" | base64 | tr -d '\n')"
  run_remote "docker exec -i ${DASH_CONTAINER} node -e '
    const parts = Buffer.from(process.argv[1], \"base64\").toString(\"utf8\").split(\"\\u0000\");
    parts.pop();
    const o = {};
    for (let i = 0; i < parts.length; i += 2) o[parts[i]] = parts[i+1];
    process.stdout.write(JSON.stringify(o));
  ' '$b64'"
}

# ───────────────────────── pretty output ─────────────────────────
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

assert_nonempty() {
  local what="$1" val="$2"
  if [[ -n "$val" && "$val" != "NULL" ]]; then
    pretty green "  ✓ $what is set: ${val:0:60}"
  else
    pretty red "  ✗ $what is empty/NULL"
    return 1
  fi
}

# ───────────────────────── synthetic fixture ─────────────────────────
# Deterministic per route so cleanup is precise and re-runs are idempotent.
if $CLOUD; then
  MSG_ID="smoke-pipeline-cloud-fixture"
  SUBJECT="URGENT escalation: damaged pallet, need replacement before Friday"
  FROM_ADDR="smoke-cloud@example.invalid"
  BODY="Half the cases in the latest shipment arrived crushed and 30 units are missing. We need a replacement pallet before Friday or we will have to cancel the standing order. Please advise on next steps and timeline."
else
  MSG_ID="smoke-pipeline-local-fixture"
  SUBJECT="Reorder: 50 cases for next restock"
  FROM_ADDR="smoke-local@example.invalid"
  BODY="Hi — we are running low and would like to reorder 50 cases of the usual SKU for delivery the week of the 15th. Same ship-to as last time. Can you confirm pricing and lead time? Thanks."
fi
TO_ADDR="operator@example.invalid"
THREAD_ID="smoke-pipeline-thread"

pretty blue "═══ MailBox One — pipeline smoke (ingest → classify → draft) ═══"
pretty blue "Host: $HOST  ($([ -z "$SSH_PREFIX" ] && echo 'local' || echo 'via ssh'))"
pretty blue "Route: $($CLOUD && echo 'CLOUD (escalate)' || echo 'LOCAL (reorder)')   message_id=$MSG_ID"
pretty blue "Mechanism: drives dashboard internal routes + LLM proxy directly"
pretty blue "           (n8n 'execute --file' cannot feed the passthrough classify trigger)"
pretty yellow "SEND SEAM: this script never approves the draft and never calls the"
pretty yellow "           mailbox-send webhook — Gmail Reply is never reached."

# ───────────────────────── preconditions ─────────────────────────
pretty blue ""
pretty blue "── Preconditions ──"

# 0. Postgres reachable + schema present.
have_drafts=$(psql_q "SELECT to_regclass('mailbox.drafts') IS NOT NULL;") || {
  pretty red "FATAL: cannot reach Postgres in ${PG_CONTAINER} on ${HOST}."; exit 2; }
if [[ "$have_drafts" != "t" ]]; then
  pretty red "FATAL: mailbox.drafts table not found — has the migrate profile run?"; exit 2
fi
pretty green "  ✓ Postgres reachable, mailbox schema present"

# 1. Dashboard container reachable + has an HTTP client.
if ! probe_http_client; then
  pretty red "FATAL: no curl/wget inside ${DASH_CONTAINER} and/or container not running."
  pretty red "       This script drives the dashboard internal routes from inside the"
  pretty red "       dashboard container; it needs curl or wget there."
  exit 2
fi
pretty green "  ✓ dashboard container reachable, HTTP client = $HTTP_CLIENT"

# ───────────────────────── cleanup helper + trap ─────────────────────────
cleanup_synthetic() {
  # Remove draft(s) + classification_log + inbox row for the synthetic id.
  # Ordered child→parent; all keyed on the deterministic message_id so we
  # never touch real data. Errors are swallowed (best-effort teardown).
  psql_q "
    WITH ib AS (SELECT id FROM mailbox.inbox_messages WHERE message_id='$(sql_lit "$MSG_ID")')
    DELETE FROM mailbox.drafts WHERE inbox_message_id IN (SELECT id FROM ib);
  " >/dev/null 2>&1 || true
  psql_q "
    WITH ib AS (SELECT id FROM mailbox.inbox_messages WHERE message_id='$(sql_lit "$MSG_ID")')
    DELETE FROM mailbox.classification_log WHERE inbox_message_id IN (SELECT id FROM ib);
  " >/dev/null 2>&1 || true
  psql_q "DELETE FROM mailbox.inbox_messages WHERE message_id='$(sql_lit "$MSG_ID")';" \
    >/dev/null 2>&1 || true
}

# shellcheck disable=SC2329  # invoked indirectly via the EXIT trap below
teardown() {
  local rc=$?
  if $KEEP; then
    pretty yellow "── --keep set: leaving synthetic rows (message_id=$MSG_ID) in place ──"
  else
    pretty blue "── Cleanup ──"
    cleanup_synthetic
    pretty green "  ✓ synthetic rows removed (message_id=$MSG_ID)"
  fi
  exit "$rc"
}
trap teardown EXIT

# Idempotency: clear any leftover synthetic rows from a prior aborted run
# BEFORE seeding, so the message_id insert below is clean.
cleanup_synthetic

# ───────────────────────── 1. Seed synthetic inbox row ─────────────────────────
pretty blue ""
pretty blue "── 1. Seed synthetic inbound (ingest) ──"
# Data-modifying CTE so psql returns ONLY the numeric id, never the "INSERT 0 1"
# command tag (MBOX-181 defect 1). -q on psql_q belt-and-suspenders this too.
INBOX_ID=$(psql_q "
  WITH ins AS (
    INSERT INTO mailbox.inbox_messages
      (message_id, thread_id, from_addr, to_addr, subject, body, received_at)
    VALUES
      ('$(sql_lit "$MSG_ID")', '$(sql_lit "$THREAD_ID")', '$(sql_lit "$FROM_ADDR")',
       '$(sql_lit "$TO_ADDR")', '$(sql_lit "$SUBJECT")', '$(sql_lit "$BODY")', NOW())
    RETURNING id
  )
  SELECT id FROM ins;
")
if ! [[ "$INBOX_ID" =~ ^[0-9]+$ ]]; then
  pretty red "FATAL: failed to insert synthetic inbox_messages row (got: '$INBOX_ID')."; exit 2
fi
pretty green "  ✓ inbox_messages id=$INBOX_ID seeded (message_id=$MSG_ID)"

# ───────────────────────── 2. classification-prompt ─────────────────────────
pretty blue ""
pretty blue "── 2. Classify (replicating MailBOX-Classify) ──"
# n8n 'Build Prompt' node body: {from, subject, body}. body falls back to
# snippet; we always send body.
CP_BODY="$(build_json from "$FROM_ADDR" subject "$SUBJECT" body "$BODY")"
CP_RESP="$(http_post /api/internal/classification-prompt "$CP_BODY")" || {
  pretty red "FATAL: classification-prompt route call failed (transport)."; exit 2; }
CLS_PROMPT="$(json_field "$CP_RESP" prompt)"
CLS_MODEL="$(json_field "$CP_RESP" model)"
if [[ -z "$CLS_PROMPT" || -z "$CLS_MODEL" ]]; then
  pretty red "FATAL: classification-prompt returned no prompt/model. Response:"
  pretty red "       ${CP_RESP:0:300}"
  exit 2
fi
pretty green "  ✓ classification-prompt → model=$CLS_MODEL, prompt ${#CLS_PROMPT} chars"

# ───────────────────────── 3. llm/api/generate (classify call) ─────────────────────────
CLS_START_MS="$(date +%s%3N)"
# Mirrors the 'Call Ollama' node exactly: format:"json", think:false,
# options {temperature:0, num_predict:64}. The proxy forwards to ollama or
# llama.cpp per LOCAL_INFERENCE_RUNTIME and returns Ollama generate shape.
GEN_BODY="$(run_remote "docker exec -i ${DASH_CONTAINER} node -e '
  const o = {
    model: process.argv[1],
    prompt: Buffer.from(process.argv[2], \"base64\").toString(\"utf8\"),
    stream: false,
    format: \"json\",
    think: false,
    options: { temperature: 0, num_predict: 64 }
  };
  process.stdout.write(JSON.stringify(o));
' '$CLS_MODEL' '$(printf '%s' "$CLS_PROMPT" | base64 | tr -d '\n')'")"
GEN_RESP="$(http_post /api/internal/llm/api/generate "$GEN_BODY")" || {
  pretty red "FATAL: llm/api/generate route call failed (transport)."; exit 2; }
GEN_TEXT="$(json_field "$GEN_RESP" response)"
if [[ -z "$GEN_TEXT" ]]; then
  # The proxy may have surfaced an upstream error (502 body {error,...}).
  GEN_ERR="$(json_field "$GEN_RESP" error)"
  if [[ -n "$GEN_ERR" ]]; then
    pretty red "FATAL: classify LLM proxy error='$GEN_ERR'. Detail:"
    pretty red "       $(json_field "$GEN_RESP" upstream_detail | head -c 300)"
    pretty red "       (Local model down? Check: docker logs ${DASH_CONTAINER} --tail 50)"
    exit 2
  fi
  pretty red "FATAL: classify LLM returned empty 'response'. Raw: ${GEN_RESP:0:300}"
  exit 2
fi
CLS_LATENCY=$(( $(date +%s%3N) - CLS_START_MS ))
pretty green "  ✓ classify LLM → ${#GEN_TEXT} chars (~${CLS_LATENCY}ms via proxy)"

# ───────────────────────── 4. classification-normalize ─────────────────────────
NORM_BODY="$(build_json raw "$GEN_TEXT" from "$FROM_ADDR" to "$TO_ADDR")"
NORM_RESP="$(http_post /api/internal/classification-normalize "$NORM_BODY")" || {
  pretty red "FATAL: classification-normalize route call failed (transport)."; exit 2; }
CATEGORY="$(json_field "$NORM_RESP" category)"
CONFIDENCE="$(json_field "$NORM_RESP" confidence)"
ROUTE="$(json_field "$NORM_RESP" route)"
JSON_PARSE_OK="$(json_field "$NORM_RESP" json_parse_ok)"
THINK_STRIPPED="$(json_field "$NORM_RESP" think_stripped)"
NORM_RAW="$(json_field "$NORM_RESP" raw_output)"
if [[ -z "$CATEGORY" ]]; then
  pretty red "FATAL: classification-normalize returned no category. Response:"
  pretty red "       ${NORM_RESP:0:300}"
  exit 2
fi
pretty green "  ✓ normalize → category=$CATEGORY confidence=$CONFIDENCE route=$ROUTE parse_ok=$JSON_PARSE_OK think_stripped=$THINK_STRIPPED"

# ───────────────────────── 5. Insert classification_log ─────────────────────────
# Mirrors 'Shape Log Row' + 'Insert Classification Log'. Fires the inbox denorm
# trigger (trg_sync_inbox_from_classification_log). model_version = the model
# from classification-prompt; raw_output capped at 8000 like the Shape node.
RAW_CAPPED="${NORM_RAW:0:8000}"
[[ "$JSON_PARSE_OK" == "true" ]]   && JPO_SQL="true"  || JPO_SQL="false"
[[ "$THINK_STRIPPED" == "true" ]]  && TS_SQL="true"   || TS_SQL="false"
# confidence may be empty if normalize emitted 0; default to 0 for the NOT NULL real column.
CONF_SQL="${CONFIDENCE:-0}"
[[ "$CONF_SQL" =~ ^[0-9]*\.?[0-9]+$ ]] || CONF_SQL="0"
psql_q "
  INSERT INTO mailbox.classification_log
    (inbox_message_id, category, confidence, model_version, latency_ms,
     raw_output, json_parse_ok, think_stripped)
  VALUES
    ($INBOX_ID, '$(sql_lit "$CATEGORY")', $CONF_SQL, '$(sql_lit "$CLS_MODEL")',
     $CLS_LATENCY, '$(sql_lit "$RAW_CAPPED")', $JPO_SQL, $TS_SQL);
" >/dev/null || { pretty red "FATAL: classification_log insert failed."; exit 2; }
pretty green "  ✓ classification_log row inserted (fires inbox denorm trigger)"

# ───────────────────────── 6. Drop-spam + live-gate ─────────────────────────
# 'Drop Spam?' IF: category != 'spam_marketing' continues; else NO draft.
if [[ "$CATEGORY" == "spam_marketing" ]]; then
  pretty yellow "── Draft DROPPED: category='spam_marketing' (Drop Spam? gate) ──"
  pretty yellow "   This is a healthy classify-only outcome — no draft is created by"
  pretty yellow "   design. (route='$ROUTE'.) Pipeline classify path verified."
  pretty green "═══ PIPELINE SMOKE PASSED — classify OK, draft correctly dropped (spam_marketing) ═══"
  exit 0
fi

LG_RESP="$(http_get /api/onboarding/live-gate)" || {
  pretty red "FATAL: live-gate route call failed (transport)."; exit 2; }
LIVE="$(json_field "$LG_RESP" live)"
STAGE="$(json_field "$LG_RESP" stage)"
BYPASS="$(json_field "$LG_RESP" bypass)"
pretty green "  ✓ live-gate → live=$LIVE stage=$STAGE bypass=$BYPASS"
if [[ "$LIVE" != "true" ]]; then
  pretty yellow "── Draft GATED: onboarding not live (stage='$STAGE') ──"
  pretty yellow "   'Onboarding Live?' IF is false → NO draft is created by design."
  pretty yellow "   This is a healthy gated outcome (classify ran, drafting is held"
  pretty yellow "   until onboarding reaches 'live' or MAILBOX_LIVE_GATE_BYPASS=1)."
  pretty green "═══ PIPELINE SMOKE PASSED — classify OK, drafting correctly gated (stage=$STAGE) ═══"
  exit 0
fi

# ───────────────────────── 7. Insert draft stub ─────────────────────────
# Mirrors 'Insert Draft Stub': draft_body='', model='pending', status='pending',
# auto_send_blocked=(category=='escalate'). Inbound fields are the ones
# /draft-prompt reads back (from_addr/to_addr/subject/body_text/
# classification_category/classification_confidence/message_id/thread_id).
[[ "$CATEGORY" == "escalate" ]] && BLOCKED_SQL="true" || BLOCKED_SQL="false"
DRAFT_ID=$(psql_q "
  WITH ins AS (
    INSERT INTO mailbox.drafts
      (inbox_message_id, draft_body, model, status, from_addr, to_addr, subject,
       body_text, received_at, message_id, thread_id, classification_category,
       classification_confidence, auto_send_blocked)
    VALUES
      ($INBOX_ID, '', 'pending', 'pending', '$(sql_lit "$FROM_ADDR")',
       '$(sql_lit "$TO_ADDR")', '$(sql_lit "$SUBJECT")', '$(sql_lit "$BODY")',
       NOW(), '$(sql_lit "$MSG_ID")', '$(sql_lit "$THREAD_ID")',
       '$(sql_lit "$CATEGORY")', $CONF_SQL, $BLOCKED_SQL)
    RETURNING id
  )
  SELECT id FROM ins;
")
if ! [[ "$DRAFT_ID" =~ ^[0-9]+$ ]]; then
  pretty red "FATAL: failed to insert draft stub (got: '$DRAFT_ID')."; exit 2
fi
pretty green "  ✓ draft stub id=$DRAFT_ID inserted (status=pending, body empty, model=pending)"

# ───────────────────────── 8. draft-prompt ─────────────────────────
pretty blue ""
pretty blue "── 8. Draft (replicating MailBOX-Draft, draft_id=$DRAFT_ID) ──"
DP_BODY="$(run_remote "docker exec -i ${DASH_CONTAINER} node -e '
  process.stdout.write(JSON.stringify({ draft_id: Number(process.argv[1]) }));
' '$DRAFT_ID'")"
DP_RESP="$(http_post /api/internal/draft-prompt "$DP_BODY")" || {
  pretty red "FATAL: draft-prompt route call failed (transport)."; exit 2; }
D_BASEURL="$(json_field "$DP_RESP" baseUrl)"
D_APIKEY="$(json_field "$DP_RESP" apiKey)"
D_MODEL="$(json_field "$DP_RESP" model)"
D_SOURCE="$(json_field "$DP_RESP" source)"
D_LABEL="$(json_field "$DP_RESP" display_label)"
D_MESSAGES="$(json_field "$DP_RESP" messages)"
D_MAXTOK="$(json_field "$DP_RESP" max_tokens)"
D_TEMP="$(json_field "$DP_RESP" temperature)"
if [[ -z "$D_BASEURL" || -z "$D_MODEL" || -z "$D_MESSAGES" || "$D_MESSAGES" == "[]" ]]; then
  pretty red "FATAL: draft-prompt missing baseUrl/model/messages. Response:"
  pretty red "       ${DP_RESP:0:400}"
  exit 2
fi
pretty green "  ✓ draft-prompt → source=$D_SOURCE model=$D_MODEL ($D_LABEL) maxtok=$D_MAXTOK temp=$D_TEMP baseUrl=$D_BASEURL"
if $CLOUD && [[ "$D_SOURCE" != "cloud" ]]; then
  pretty yellow "  ~ note: --cloud requested but route picked source=$D_SOURCE (confidence/category dependent)"
fi
# Safety: do not retry-loop into an unexpected cost path; just report the route.
if [[ "$D_SOURCE" == "cloud" ]]; then
  pretty yellow "  ~ CLOUD route selected — this exercises the real cloud drafter (one call)."
fi

# ───────────────────────── 9. {baseUrl}/api/chat ─────────────────────────
# Mirrors 'Call LLM': options {temperature, num_predict:max_tokens}. Auth header
# only when apiKey is non-empty (local route has empty key; local Ollama/proxy
# does not require auth). max_tokens/temperature default if route omitted them.
CHAT_MAXTOK="${D_MAXTOK:-512}"; [[ "$CHAT_MAXTOK" =~ ^[0-9]+$ ]] || CHAT_MAXTOK=512
CHAT_TEMP="${D_TEMP:-0.3}";     [[ "$CHAT_TEMP" =~ ^[0-9.]+$ ]] || CHAT_TEMP="0.3"
CHAT_BODY="$(run_remote "docker exec -i ${DASH_CONTAINER} node -e '
  const o = {
    model: process.argv[1],
    messages: JSON.parse(Buffer.from(process.argv[2], \"base64\").toString(\"utf8\")),
    stream: false,
    options: { temperature: Number(process.argv[3]), num_predict: Number(process.argv[4]) }
  };
  process.stdout.write(JSON.stringify(o));
' '$D_MODEL' '$(printf '%s' "$D_MESSAGES" | base64 | tr -d '\n')' '$CHAT_TEMP' '$CHAT_MAXTOK'")"
CHAT_RESP="$(http_post_abs "${D_BASEURL}/api/chat" "$CHAT_BODY" "$D_APIKEY")" || {
  pretty red "FATAL: ${D_BASEURL}/api/chat call failed (transport)."; exit 2; }
CHAT_CONTENT="$(json_field "$CHAT_RESP" message.content)"
IN_TOK="$(json_field "$CHAT_RESP" prompt_eval_count)"; [[ "$IN_TOK" =~ ^[0-9]+$ ]] || IN_TOK=0
OUT_TOK="$(json_field "$CHAT_RESP" eval_count)";       [[ "$OUT_TOK" =~ ^[0-9]+$ ]] || OUT_TOK=0
if [[ -z "$CHAT_CONTENT" ]]; then
  CHAT_ERR="$(json_field "$CHAT_RESP" error)"
  pretty red "FATAL: draft LLM /api/chat returned empty message.content."
  [[ -n "$CHAT_ERR" ]] && pretty red "       error='$CHAT_ERR'"
  pretty red "       Raw: ${CHAT_RESP:0:300}"
  exit 1
fi
pretty green "  ✓ draft LLM /api/chat → ${#CHAT_CONTENT} chars (in_tok=$IN_TOK out_tok=$OUT_TOK)"

# ───────────────────────── 10. draft-finalize ─────────────────────────
FIN_BODY="$(run_remote "docker exec -i ${DASH_CONTAINER} node -e '
  const o = {
    draft_id: Number(process.argv[1]),
    body: Buffer.from(process.argv[2], \"base64\").toString(\"utf8\"),
    source: process.argv[3],
    model: process.argv[4],
    input_tokens: Number(process.argv[5]),
    output_tokens: Number(process.argv[6])
  };
  process.stdout.write(JSON.stringify(o));
' '$DRAFT_ID' '$(printf '%s' "$CHAT_CONTENT" | base64 | tr -d '\n')' '$D_SOURCE' '$D_MODEL' '$IN_TOK' '$OUT_TOK'")"
FIN_RESP="$(http_post /api/internal/draft-finalize "$FIN_BODY")" || {
  pretty red "FATAL: draft-finalize route call failed (transport)."; exit 2; }
FIN_OK="$(json_field "$FIN_RESP" ok)"
if [[ "$FIN_OK" != "true" ]]; then
  pretty red "FATAL: draft-finalize did not return ok:true. Response:"
  pretty red "       ${FIN_RESP:0:400}"
  exit 1
fi
pretty green "  ✓ draft-finalize ok (status=$(json_field "$FIN_RESP" status) cost_usd=$(json_field "$FIN_RESP" cost_usd))"

# ───────────────────────── Poll + assert the persisted draft ─────────────────────────
pretty blue ""
pretty blue "── Wait for draft to settle (timeout ${TIMEOUT}s) ──"
# draft-finalize is synchronous, so the row is already final; we still poll a
# few cycles to be robust to any async cloud flip from awaiting_cloud→pending.
WAITED=0
INTERVAL=3
ROW=""
while [[ $WAITED -lt $TIMEOUT ]]; do
  ROW=$(psql_q "
    SELECT status || '|' ||
           COALESCE(classification_category,'NULL') || '|' ||
           length(COALESCE(draft_body,'')) || '|' ||
           COALESCE(draft_source,'NULL') || '|' ||
           COALESCE(model,'NULL')
    FROM mailbox.drafts WHERE id=$DRAFT_ID;
  " || true)
  STATUS_PEEK="${ROW%%|*}"
  # Settle as soon as we have a row with a finalized (non-stub) source/model.
  if [[ -n "$ROW" && "$STATUS_PEEK" != "awaiting_cloud" ]]; then break; fi
  sleep "$INTERVAL"
  WAITED=$(( WAITED + INTERVAL ))
  printf '\r  …waiting %ss/%ss' "$WAITED" "$TIMEOUT"
done
echo ""

if [[ -z "$ROW" ]]; then
  pretty red "  ✗ draft row id=$DRAFT_ID disappeared unexpectedly"
  exit 1
fi
STATUS="${ROW%%|*}";              REST="${ROW#*|}"
CATEGORY="${REST%%|*}";           REST="${REST#*|}"
BODY_LEN="${REST%%|*}";           REST="${REST#*|}"
DRAFT_SOURCE="${REST%%|*}";       REST="${REST#*|}"
MODEL="${REST%%|*}"

pretty blue ""
pretty blue "── Assertions ──"
fail=0

# status ∈ ACCEPT_STATUSES
status_ok=false
for s in $ACCEPT_STATUSES; do [[ "$STATUS" == "$s" ]] && status_ok=true; done
if $status_ok; then
  pretty green "  ✓ status='$STATUS' (accepted: $ACCEPT_STATUSES)"
else
  pretty red "  ✗ status='$STATUS' not in accepted set: $ACCEPT_STATUSES"
  fail=1
fi

# classification_category set + valid
VALID_CATS="inquiry reorder scheduling follow_up internal spam_marketing escalate unknown"
if [[ -n "$CATEGORY" && "$CATEGORY" != "NULL" ]]; then
  cat_ok=false
  for c in $VALID_CATS; do [[ "$CATEGORY" == "$c" ]] && cat_ok=true; done
  if $cat_ok; then
    pretty green "  ✓ classification_category='$CATEGORY'"
  else
    pretty red "  ✗ classification_category='$CATEGORY' not a known category"
    fail=1
  fi
else
  pretty red "  ✗ classification_category is empty/NULL"
  fail=1
fi

# draft_body non-empty (the LLM produced text). awaiting_cloud is allowed a
# placeholder body while the cloud call is in flight; only enforce non-empty
# for non-awaiting states.
if [[ "$STATUS" == "awaiting_cloud" ]]; then
  pretty yellow "  ~ draft_body length=$BODY_LEN (status awaiting_cloud — body fills on finalize)"
else
  if [[ "${BODY_LEN:-0}" -gt 0 ]]; then
    pretty green "  ✓ draft_body non-empty (length=$BODY_LEN chars)"
  else
    pretty red "  ✗ draft_body is empty (length=0) — LLM produced no text"
    fail=1
  fi
fi

assert_nonempty "draft_source" "$DRAFT_SOURCE" || fail=1
assert_nonempty "model" "$MODEL" || fail=1

pretty blue ""
if [[ $fail -ne 0 ]]; then
  pretty red "═══ PIPELINE SMOKE FAILED ═══"
  exit 1
fi
pretty green "═══ PIPELINE SMOKE PASSED — ingest → classify → draft OK, no email sent ═══"
exit 0
