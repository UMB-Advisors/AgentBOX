#!/usr/bin/env bash
# scripts/n8n-drift-check.sh — read-only live↔repo drift gate (2026-06-11)
#
# Answers one question with an exit code: do the workflows running on the
# box match n8n/workflows/*.json in this checkout? It runs the full-fleet
# export (scripts/n8n-export-workflows.sh) into the working tree, diffs,
# REVERTS every change it made, and exits:
#
#   0 — live box matches the repo (no-op export)
#   1 — drift detected (diff printed; tree restored)
#   2 — preconditions failed (dirty workflows dir, export error)
#
# The audit finding this closes: the README's "re-export = no-op diff"
# discipline had no enforcement — FeedbackDistill ran live for a day with
# no repo copy and nothing noticed. Run this from cron/CI wherever the box
# is reachable, e.g.:
#
#   SSH_HOST=UMB@100.127.2.54 ./scripts/n8n-drift-check.sh   # agentbox2
#   SSH_HOST=local ./scripts/n8n-drift-check.sh              # on the box
#
# Requires: git checkout, jq, plus whatever n8n-export-workflows.sh needs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
WF_DIR="${REPO_ROOT}/n8n/workflows"
WF_REL="$(git -C "${REPO_ROOT}" rev-parse --show-prefix 2>/dev/null || true)n8n/workflows"

# Precondition: the workflows dir must be clean, or we can't tell our
# export's changes apart from yours (and couldn't safely revert).
if [[ -n "$(git -C "${REPO_ROOT}" status --porcelain -- "n8n/workflows" 2>/dev/null)" ]]; then
  echo "[drift-check] n8n/workflows has local changes — commit or stash them first" >&2
  exit 2
fi

if ! "${SCRIPT_DIR}/n8n-export-workflows.sh" >/dev/null; then
  echo "[drift-check] export failed — cannot evaluate drift" >&2
  exit 2
fi

status="$(git -C "${REPO_ROOT}" status --porcelain -- "n8n/workflows")"
if [[ -z "${status}" ]]; then
  echo "[drift-check] OK — live workflows match ${WF_REL}/"
  exit 0
fi

echo "[drift-check] DRIFT — live box does not match the repo:"
echo "${status}" | sed 's/^/  /'
echo
echo "[drift-check] modified workflows (diffstat):"
git -C "${REPO_ROOT}" --no-pager diff --stat -- "n8n/workflows" | sed 's/^/  /'
echo
echo "[drift-check] untracked files above = live workflows with NO repo copy."
echo "[drift-check] To adopt the live state: re-run scripts/n8n-export-workflows.sh and commit."
echo "[drift-check] To push the repo state:  scripts/n8n-import-workflows.sh."

# Restore the tree exactly as we found it (precondition guaranteed clean).
git -C "${REPO_ROOT}" checkout -q -- "n8n/workflows" 2>/dev/null || true
git -C "${REPO_ROOT}" clean -fq -- "n8n/workflows"
exit 1
