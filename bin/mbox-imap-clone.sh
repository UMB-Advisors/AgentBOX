#!/usr/bin/env bash
#
# MBOX-482 P1 — generate per-account MailBOX-Imap / MailBOX-Imap-Send clones.
#
# n8n 2.14.2 native IMAP/SMTP nodes bind a STATIC credential id + the workflow
# hardcodes the account_email (addendum-01 §2, binding option (a): per-account
# workflow clones). This script stamps the template workflows
# (mailbox/n8n/workflows/MailBOX-Imap{,-Send}.json) with:
#   - account_email      (Build Inbox Payload set node / Send From)
#   - imap cred id+name  (emailReadImap credentials)
#   - smtp cred id+name  (emailSend credentials)
#   - a deterministic per-account workflow id keyed by account_id (addendum §5)
# and writes them to an output dir for import. JSON-safe edits via python (never
# sed) so the workflow JSON stays valid.
#
# The cred ids come from bin/mbox-imap-cred-sync.sh (which derives them from
# account_id). Pass the SAME ids here so the clone binds the synced credential.
#
# USAGE:
#   bin/mbox-imap-clone.sh <account_email> <imap_cred_id> <smtp_cred_id> [out_dir]
#
# Defaults out_dir to ./.mbox-imap-clones. Import the generated files with the
# existing scripts/n8n-import-workflows.sh pattern, then restart n8n.
#
set -euo pipefail

ACCOUNT_EMAIL="${1:?Usage: mbox-imap-clone.sh <account_email> <imap_cred_id> <smtp_cred_id> [out_dir]}"
IMAP_CRED_ID="${2:?imap_cred_id required (from mbox-imap-cred-sync.sh)}"
SMTP_CRED_ID="${3:?smtp_cred_id required (from mbox-imap-cred-sync.sh)}"
OUT_DIR="${4:-./.mbox-imap-clones}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TPL_DIR="${REPO_ROOT}/mailbox/n8n/workflows"

# account_id is the numeric suffix of the deterministic cred id (mbximap<N>).
ACCOUNT_ID="${IMAP_CRED_ID#mbximap}"
if ! [[ "${ACCOUNT_ID}" =~ ^[0-9]+$ ]]; then
  echo "  [error] could not derive account_id from imap_cred_id '${IMAP_CRED_ID}' (expected mbximap<N>)" >&2
  exit 1
fi

mkdir -p "${OUT_DIR}"

INGEST_OUT="${OUT_DIR}/MailBOX-Imap-acct${ACCOUNT_ID}.json"
SEND_OUT="${OUT_DIR}/MailBOX-Imap-Send-acct${ACCOUNT_ID}.json"

python3 - "$TPL_DIR/MailBOX-Imap.json" "$INGEST_OUT" "$ACCOUNT_EMAIL" "$IMAP_CRED_ID" "$ACCOUNT_ID" <<'PY'
import json, sys
src, out, email, imap_id, account_id = sys.argv[1:6]
wf = json.load(open(src))
# Per-account workflow id + name (addendum §5 — deterministic so OTAs overwrite).
wf["id"] = f"MlbxImapIngest{int(account_id):05d}"
wf["name"] = f"MailBOX-Imap-{email}"
for node in wf["nodes"]:
    if node.get("type") == "n8n-nodes-base.emailReadImap":
        node.setdefault("credentials", {})["imap"] = {"id": imap_id, "name": f"MailBox IMAP {email}"}
    if node.get("name") == "Build Inbox Payload":
        for a in node["parameters"]["assignments"]["assignments"]:
            if a["name"] == "account_email":
                a["value"] = email
json.dump(wf, open(out, "w"), indent=2)
print(f"  [ok]  {out}")
PY

python3 - "$TPL_DIR/MailBOX-Imap-Send.json" "$SEND_OUT" "$ACCOUNT_EMAIL" "$SMTP_CRED_ID" "$ACCOUNT_ID" <<'PY'
import json, sys
src, out, email, smtp_id, account_id = sys.argv[1:6]
wf = json.load(open(src))
wf["id"] = f"MlbxImapSend{int(account_id):05d}"
wf["name"] = f"MailBOX-Imap-Send-{email}"
for node in wf["nodes"]:
    if node.get("type") == "n8n-nodes-base.emailSend":
        node.setdefault("credentials", {})["smtp"] = {"id": smtp_id, "name": f"MailBox SMTP {email}"}
json.dump(wf, open(out, "w"), indent=2)
print(f"  [ok]  {out}")
PY

echo ""
echo "Generated per-account IMAP clones for ${ACCOUNT_EMAIL} (account_id=${ACCOUNT_ID}):"
echo "  ingest: ${INGEST_OUT}"
echo "  send:   ${SEND_OUT}"
echo "Import them (mirrors scripts/n8n-import-workflows.sh), then activate + restart n8n."
echo "NOTE: the send clone's webhook path is still 'mailbox-imap-send' (shared); a"
echo "multi-IMAP-account box needs per-account webhook paths + N8N_IMAP_WEBHOOK_URL"
echo "routing — tracked as a follow-up (single-IMAP-account boxes work as-is)."
